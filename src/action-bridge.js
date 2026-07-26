import { applyControlledPatch, readLatestState } from './mvu/adapter.js';
import { buildCandidateMatchOutcomePatch, buildCharacterRegistrationPatch, buildControlledPatch, buildClearPrivateChatPatch, buildDeleteCharacterPatch, buildMeetupHandoffPatch, buildPlayerPublicProfilePatch, buildPrivateChatPatch, buildPrivateChatSummaryFailurePatch, buildPrivateChatSummaryPatch, buildRecommendationInitialCandidatePatch, buildRecommendationRefreshPatch, buildServiceOrderHandoffPatch, buildServiceOrderRepeatPatch, buildServiceOrderStartPatch, buildServiceOrderCancelPatch, buildServiceOrderCompletePatch, buildServiceOrderFinalizePatch, buildServiceOrderRebookPatch, buildServiceHistoryRolesDeletionPatch, buildServiceOrderRepairPatch, buildSoulMatchPreferencePatch } from './mvu/controlled-patch.js';
import { generateRecommendationCandidate } from './recommendation/recommendation-refresh.js';
import { generatePrivateChatReply, generatePrivateChatSummary } from './chat/private-chat-service.js';
import { DEFAULT_CHAT_SUMMARY_SETTINGS, isConversationSummaryDue, listUnsummarizedConversationMessages } from './chat/conversation-summary.js';
import { generateCandidateMatchDraft as generateCandidateMatchDraftService, generateSoulMatchDraft, generateTextMatchDraft } from './recommendation/soul-text-match-service.js';
import { materializeCandidateMatchDraft } from './recommendation/match-candidate-materializer.js';
import { generateCharacterAuthoringCandidate, generateCharacterCompletionCandidate, generateServiceProfileCandidate } from './characters/character-authoring-service.js';
import { generateGroupChatReply, generateGroupChatUpdate as generateGroupChatUpdateService } from './groups/group-chat-service.js';
import { generateForumExistingPostsUpdate as generateForumExistingPostsUpdateService, generateForumHomeRefresh as generateForumHomeRefreshService, generateForumPostConversationUpdate as generateForumPostConversationUpdateService, generateForumPostDraft as generateForumPostDraftService } from './groups/forum-service.js';
import { generateLocalConversationSummary as generateLocalConversationSummaryService } from './groups/local-conversation-summary-service.js';
import { composeImagePrompt } from './images/image-directive.js';
import { toPublicImageGenerationError } from './llm/image-generation-client.js';

const PASSIVE_KINDS = new Set([
    'open_character_creator',
    'open_character_import',
    'open_random_candidates',
    'navigate',
]);
const MVU_KINDS = new Set(['like', 'favorite', 'dislike', 'refresh', 'unfavorite', 'start_private_chat', 'advance_content_mode_gate', 'toggle_content_mode']);
const PERSONALIZATION_DELTAS = Object.freeze({ like: 3, favorite: 1, dislike: -3 });
const PERSONALIZATION_PUBLIC_TAG_FIELDS = Object.freeze(['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']);
const IMAGE_CONVERSATION_KINDS = new Set(['private', 'group', 'forum']);
const CONTENT_MODES = new Set(['SFW', 'NSFW']);
const SERVICE_MODE_WRITE_KINDS = new Set(['advance_content_mode_gate', 'toggle_content_mode']);

/**
 * 2026-07-27 控制台诊断增强：把受控管线 build/validate 失败里的可选 detail/reason
 * 原样带给调用层（仅字段路径与校验结论，绝无隐藏值、关系分或阈值数值）。
 * 两个键都只在存在时附加，只读 code 的既有消费方不受影响。
 */
function rejectedFromBuild(built) {
    const result = { ok: false, status: 'rejected', code: built.code };
    if (typeof built.detail === 'string' && built.detail) result.detail = built.detail;
    if (typeof built.reason === 'string' && built.reason) result.reason = built.reason;
    return result;
}

function makePassiveCommand(kind, payload) {
    const safePayload = {};
    for (const [key, value] of Object.entries(payload ?? {})) {
        if (/^[a-z][a-z0-9_]{0,48}$/i.test(key)) safePayload[key] = String(value ?? '').slice(0, 2000);
    }
    return Object.freeze({ kind, payload: Object.freeze(safePayload) });
}

function resolveMvu(mvu) {
    return typeof mvu === 'function' ? mvu() : mvu;
}

function actionKey(kind, npcUid) {
    return `${kind}:${typeof npcUid === 'string' ? npcUid : ''}`;
}

/** Extracts only public, visible tag text for the device-local recommender. */
function publicProfileTags(profile) {
    if (!profile || typeof profile !== 'object') return [];

    const seen = new Set();
    const tags = [];
    for (const field of PERSONALIZATION_PUBLIC_TAG_FIELDS) {
        if (!Array.isArray(profile[field])) continue;
        for (const rawTag of profile[field]) {
            if (typeof rawTag !== 'string') continue;
            const tag = rawTag.trim().slice(0, 40);
            const normalized = tag.toLocaleLowerCase('zh-CN');
            if (!tag || seen.has(normalized)) continue;
            seen.add(normalized);
            tags.push(tag);
        }
    }
    return tags;
}

function publicCandidateTags(state, npcUid) {
    if (typeof npcUid !== 'string' || !npcUid) return [];
    const recommendation = state && typeof state === 'object' ? state.推荐 : null;
    if (!recommendation || typeof recommendation !== 'object') return [];
    const candidate = recommendation.临时候选池?.[npcUid] ?? state?.角色池?.[npcUid];
    return publicProfileTags(candidate?.公开资料);
}

function syncDevicePersonalization(settingsStore, state, kind, npcUid) {
    const delta = PERSONALIZATION_DELTAS[kind];
    if (!delta || typeof settingsStore?.applyPersonalizationKeywordWeightDelta !== 'function') return false;
    try {
        settingsStore.applyPersonalizationKeywordWeightDelta(state?.软件?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW', publicCandidateTags(state, npcUid), delta);
        return true;
    } catch {
        // A local cache failure must never invalidate an already committed MVU action.
        return false;
    }
}

function seedGeneratedCandidateKeywords(settingsStore, state, candidate) {
    if (typeof settingsStore?.ensurePersonalizationKeywordWeights !== 'function') return false;
    try {
        settingsStore.ensurePersonalizationKeywordWeights(state?.软件?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW', publicProfileTags(candidate?.公开资料));
        return true;
    } catch {
        // A local cache failure must never invalidate an already committed MVU action.
        return false;
    }
}

/**
 * The sole UI-to-MVU write boundary. Browser UI can express only named actions;
 * it cannot provide a JSON Pointer, patch, state object, or arbitrary value.
 *
 * @param {{ documentRef: Document, mvu?: unknown, eventEmit?: unknown, getContext?: (() => unknown)|undefined, settingsStore?: unknown, llmClient?: unknown, imageGenerationClient?: unknown, imageMatchCoordinator?: unknown, onControlledAction?: (command: Readonly<{kind:string, payload:Readonly<Record<string,string>>}>) => void }} options
 */
export function createActionBridge({
    documentRef,
    mvu = globalThis.Mvu,
    eventEmit = globalThis.eventEmit,
    getContext = globalThis.SillyTavern?.getContext?.bind(globalThis.SillyTavern),
    settingsStore = null,
    llmClient = null,
    imageGenerationClient = null,
    imageMatchCoordinator = null,
    onControlledAction = () => {},
}) {
    const pending = new Set();
    let serviceModeWriteTail = Promise.resolve();

    // Mode switches and service-order writes share one transaction lane so their
    // read -> exact patch -> apply sequence cannot be built from the same stale snapshot.
    function serializeServiceModeWrite(task) {
        const previous = serviceModeWriteTail;
        let release;
        serviceModeWriteTail = new Promise((resolve) => { release = resolve; });
        return previous.then(task, task).finally(release);
    }

    function chatSummarySettings() {
        try {
            const saved = settingsStore?.getChatSummarySettings?.();
            return saved && typeof saved === 'object'
                ? { ...DEFAULT_CHAT_SUMMARY_SETTINGS, ...saved }
                : { ...DEFAULT_CHAT_SUMMARY_SETTINGS };
        } catch {
            return { ...DEFAULT_CHAT_SUMMARY_SETTINGS };
        }
    }

    function startImageMatch(publicProfile, contentMode, signal) {
        if (typeof imageMatchCoordinator?.match !== 'function') return;
        try {
            void Promise.resolve(imageMatchCoordinator.match(publicProfile, { contentMode, signal })).catch(() => {});
        } catch {
            // Image selection is presentation-only and must never affect role generation or MVU writes.
        }
    }

    function emit(kind, payload = {}) {
        if (!PASSIVE_KINDS.has(kind)) throw new Error(`不允许的非写入操作：${kind}`);
        const command = makePassiveCommand(kind, payload);
        onControlledAction(command);
        return command;
    }

    /**
     * Reads the fresh state, creates an exact whitelisted patch, and commits it
     * only through the MVU get -> parse -> replace -> event pipeline.
     */
    async function runMvuAction(kind, npcUid) {
        if (!MVU_KINDS.has(kind)) return { ok: false, status: 'rejected', code: 'ui_action_not_allowed' };
        const key = actionKey(kind, npcUid);
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };

        pending.add(key);
        const execute = async () => {
            const currentMvu = resolveMvu(mvu);
            const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;

            const command = SERVICE_MODE_WRITE_KINDS.has(kind) ? { kind } : { kind, npcUid };
            const built = buildControlledPatch(read.state, command);
            if (!built.ok) return { ...rejectedFromBuild(built), detail: built.detail };

            const sessionOperation = kind === 'start_private_chat'
                ? built.value.find((operation) => operation?.op === 'add' && /^\/会话\/chat_[A-Za-z0-9_-]{1,64}$/u.test(operation.path))
                : null;
            const invitationStateOperation = kind === 'start_private_chat'
                ? built.value.find((operation) => operation?.op === 'replace' && operation.path === `/角色池/${npcUid}/与玩家关系/状态`)
                : null;
            const applied = await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
            if (applied.ok) syncDevicePersonalization(settingsStore, read.state, kind, npcUid);
            if (!applied.ok || kind !== 'start_private_chat') return applied;
            return {
                ...applied,
                sessionUid: sessionOperation?.path.split('/')[2] ?? '',
                invitationOutcome: invitationStateOperation?.value === '已匹配' ? 'accepted' : 'declined',
            };
        };
        try {
            return SERVICE_MODE_WRITE_KINDS.has(kind) ? await serializeServiceModeWrite(execute) : await execute();
        } finally {
            pending.delete(key);
        }
    }

    /**
     * Refresh uses a two-phase transaction: generate and validate in memory, then
     * read the latest state again and commit one exact atomic Patch. A model error
     * therefore cannot cool/remove the current candidate or leave a half object.
     */
    async function runRecommendationRefresh(replacedNpcUid, { signal } = {}) {
        const key = actionKey('refresh', replacedNpcUid);
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const currentMvu = resolveMvu(mvu);
            const firstRead = readLatestState({ mvu: currentMvu });
            if (!firstRead.ok) return firstRead;
            const generated = await generateRecommendationCandidate({
                state: firstRead.state, settingsStore, llmClient, signal,
            });
            if (!generated.ok) return { ok: false, status: 'rejected', code: generated.code, message: generated.message };
            startImageMatch(
                generated.candidate?.公开资料,
                firstRead.state?.软件?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW',
                signal,
            );

            // The model call is asynchronous: never reuse a stale click target/state.
            const secondRead = readLatestState({ mvu: currentMvu });
            if (!secondRead.ok) return secondRead;
            const built = buildRecommendationRefreshPatch(secondRead.state, {
                replacedNpcUid,
                candidate: generated.candidate,
            });
            if (!built.ok) return rejectedFromBuild(built);
            const applied = await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
            if (applied.ok) seedGeneratedCandidateKeywords(settingsStore, secondRead.state, generated.candidate);
            return applied;
        } finally {
            pending.delete(key);
        }
    }
    /**
     * Seeds an empty recommendation queue through the same two-read fast-model
     * transaction as refresh. The model draft remains in memory until the fresh
     * state still proves there is no visible candidate to overwrite.
     */
    async function runRecommendationInitialCandidate({ signal } = {}) {
        const key = actionKey('recommendation_initial_candidate');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const currentMvu = resolveMvu(mvu);
            const firstRead = readLatestState({ mvu: currentMvu });
            if (!firstRead.ok) return firstRead;
            const generated = await generateRecommendationCandidate({
                state: firstRead.state, settingsStore, llmClient, signal,
            });
            if (!generated.ok) return { ok: false, status: 'rejected', code: generated.code, message: generated.message };
            startImageMatch(
                generated.candidate?.公开资料,
                firstRead.state?.软件?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW',
                signal,
            );

            const secondRead = readLatestState({ mvu: currentMvu });
            if (!secondRead.ok) return secondRead;
            const built = buildRecommendationInitialCandidatePatch(secondRead.state, { candidate: generated.candidate });
            if (!built.ok) return rejectedFromBuild(built);
            const applied = await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
            if (applied.ok) seedGeneratedCandidateKeywords(settingsStore, secondRead.state, generated.candidate);
            return applied;
        } finally {
            pending.delete(key);
        }
    }

    /**
     * Sends one software-layer text message through the configured fast model.
     * No state is written until the reply and all relationship deltas validate;
     * the state is deliberately re-read after the asynchronous model request.
     */
    async function runPrivateChat({ sessionUid, npcUid, playerMessage, signal } = {}) {
        const key = actionKey('private_chat', sessionUid);
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const currentMvu = resolveMvu(mvu);
            const firstRead = readLatestState({ mvu: currentMvu });
            if (!firstRead.ok) return firstRead;
            const generated = await generatePrivateChatReply({
                state: firstRead.state, sessionUid, npcUid, playerMessage, settingsStore, llmClient, signal,
            });
            if (!generated.ok) return { ok: false, status: 'rejected', code: generated.code, message: generated.message };

            const secondRead = readLatestState({ mvu: currentMvu });
            if (!secondRead.ok) return secondRead;
            const built = buildPrivateChatPatch(secondRead.state, {
                sessionUid, npcUid, playerMessage: generated.playerMessage, response: generated.response,
            });
            if (!built.ok) return rejectedFromBuild(built);
            const interactionOutcome = built.value.some((operation) => operation?.op === 'replace'
                && operation.path === '/会话/' + sessionUid + '/状态' && operation.value === '已拉黑')
                ? 'blocked'
                : built.value.some((operation) => operation?.op === 'add'
                    && operation.path === '/会话/' + sessionUid + '/最近消息/-' && operation.value?.发送者 === '角色')
                    ? 'replied'
                    : 'read_without_reply';
            const replyMessageUids = built.value.filter((operation) => operation?.op === 'add'
                && operation.path === '/会话/' + sessionUid + '/最近消息/-'
                && operation.value?.发送者 === '角色')
                .map((operation) => operation.value.消息UID);
            const imageDirectives = (generated.response.imageDirectives ?? []).flatMap((item) => {
                const messageUid = replyMessageUids[item.replyIndex];
                return messageUid ? [{ messageUid, directive: item.directive }] : [];
            });
            const applied = await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
            const summarySettings = chatSummarySettings();
            return applied.ok ? {
                ...applied,
                interactionOutcome,
                summaryCheckRequested: interactionOutcome === 'replied' && summarySettings.enabled,
                imageDirectives,
            } : applied;
        } finally {
            pending.delete(key);
        }
    }

    /**
     * Generates and commits one summary in the background. It never blocks a
     * chat reply: a late summary may only cover the exact source prefix it read,
     * so messages sent while the model is working remain pending for the next run.
     */
    async function runPrivateChatSummary({ sessionUid, npcUid, summaryUid = '', automatic = false, force = false, signal } = {}) {
        const key = actionKey('chat_summary', sessionUid);
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const settings = chatSummarySettings();
            if (automatic && !settings.enabled && !force) {
                return { ok: false, status: 'rejected', code: 'chat_summary_disabled', silent: true };
            }
            const retries = settings.retryLimit;
            let latestFailure = { code: 'chat_summary_failed', message: '总结未完成，请稍后重试。' };
            for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
                const currentMvu = resolveMvu(mvu);
                const firstRead = readLatestState({ mvu: currentMvu });
                if (!firstRead.ok) return firstRead;
                const session = firstRead.state?.会话?.[sessionUid];
                if (automatic && !force && !summaryUid && !isConversationSummaryDue(session, settings.interval)) {
                    return { ok: false, status: 'rejected', code: 'chat_summary_not_due', silent: true };
                }
                const generated = await generatePrivateChatSummary({
                    state: firstRead.state, sessionUid, npcUid, summaryUid, settingsStore, llmClient, signal,
                });
                if (generated.ok) {
                    const secondRead = readLatestState({ mvu: currentMvu });
                    if (!secondRead.ok) return secondRead;
                    const built = buildPrivateChatSummaryPatch(secondRead.state, {
                        sessionUid,
                        npcUid,
                        summary: generated.summary,
                        sourceMessageUids: generated.source.messageUids,
                        summaryUid: generated.source.summaryUid,
                        attempts: attempt,
                    });
                    if (built.ok) {
                        const applied = await applyControlledPatch({ patch: built.value.patch, mvu: currentMvu, eventEmit, getContext });
                        if (applied.ok) {
                            return {
                                ...applied,
                                summary: generated.summary,
                                summaryUid: built.value.summaryUid,
                                attempts: attempt,
                                automatic,
                                remainingMessageCount: built.value.remainingMessageCount,
                                remainingLayerCount: built.value.remainingLayerCount,
                            };
                        }
                        latestFailure = { code: applied.code || 'chat_summary_write_failed', message: '总结结果未能保存，请稍后重试。' };
                    } else {
                        latestFailure = { code: built.code, message: '聊天内容发生变化，本次总结未保存。' };
                    }
                } else {
                    latestFailure = { code: generated.code, message: generated.message || '总结未完成，请稍后重试。' };
                    if (['chat_summary_no_pending_messages', 'chat_summary_record_not_found'].includes(generated.code)) {
                        return { ok: false, status: 'rejected', ...latestFailure, silent: true };
                    }
                }
            }

            // A model/validation failure is itself a controlled, visible state:
            // only its public-safe projected reason is persisted, never raw API
            // responses, URLs, keys, or stack traces.
            const currentMvu = resolveMvu(mvu);
            const finalRead = readLatestState({ mvu: currentMvu });
            if (!finalRead.ok) return finalRead;
            const failed = buildPrivateChatSummaryFailurePatch(finalRead.state, {
                sessionUid,
                npcUid,
                reason: latestFailure.message,
                summaryUid,
                attempts: retries + 1,
            });
            if (!failed.ok) return { ok: false, status: 'rejected', code: latestFailure.code, message: latestFailure.message };
            const persisted = await applyControlledPatch({ patch: failed.value.patch, mvu: currentMvu, eventEmit, getContext });
            return {
                ok: false,
                status: 'rejected',
                code: latestFailure.code,
                message: latestFailure.message,
                attempts: retries + 1,
                failurePersisted: Boolean(persisted?.ok),
                automatic,
            };
        } finally {
            pending.delete(key);
        }
    }

    /** Clears one private-chat session through the same exact controlled MVU boundary. */
    async function clearPrivateChat(sessionUid) {
        const key = actionKey('clear_private_chat', sessionUid);
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const currentMvu = resolveMvu(mvu);
            const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;
            const built = buildClearPrivateChatPatch(read.state, { sessionUid });
            if (!built.ok) return rejectedFromBuild(built);
            return await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
        } finally {
            pending.delete(key);
        }
    }


    /** Deletes one character and all of its controlled state references. */
    async function deleteCharacter(npcUid) {
        const key = actionKey('delete_character', npcUid);
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const currentMvu = resolveMvu(mvu);
            const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;
            const built = buildDeleteCharacterPatch(read.state, { npcUid });
            if (!built.ok) return rejectedFromBuild(built);
            return await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
        } finally {
            pending.delete(key);
        }
    }
    /** Generates one in-memory public match draft; it never writes MVU state. */
    async function generateMatchDraft(kind, { signal } = {}) {
        if (!['soul', 'text'].includes(kind)) return { ok: false, status: 'rejected', code: 'match_draft_kind_invalid' };
        const key = actionKey(`${kind}_match_draft`, '');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const currentMvu = resolveMvu(mvu);
            const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;
            return await (kind === 'soul'
                ? generateSoulMatchDraft({ state: read.state, settingsStore, llmClient, signal })
                : generateTextMatchDraft({ state: read.state, settingsStore, llmClient, signal }));
        } finally {
            pending.delete(key);
        }
    }


    /**
     * Generates a brand-new candidate from either saved (soul) or transient
     * voice-derived weights, then records the locally scored accepted/declined
     * outcome. Only an accepted outcome atomically creates a chat session.
     */
    async function runCandidateMatch(mode, { voiceText, signal } = {}) {
        if (!['soul', 'voice'].includes(mode)) return { ok: false, status: 'rejected', code: 'candidate_match_mode_invalid' };
        const key = actionKey('candidate_match_' + mode, '');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const currentMvu = resolveMvu(mvu);
            const firstRead = readLatestState({ mvu: currentMvu });
            if (!firstRead.ok) return firstRead;
            const generated = await generateCandidateMatchDraftService({ mode, state: firstRead.state, settingsStore, llmClient, voiceText, signal });
            if (!generated.ok) return { ok: false, status: 'rejected', code: generated.code, message: generated.message };
            const contentMode = firstRead.state?.软件?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW';
            let materialized;
            try {
                materialized = materializeCandidateMatchDraft(generated.draft, { contentMode });
            } catch {
                return { ok: false, status: 'rejected', code: 'candidate_match_response_invalid', message: '匹配角色草稿不符合公开资料安全格式；当前状态未改变。' };
            }
            startImageMatch(materialized.candidate?.公开资料, contentMode, signal);

            const secondRead = readLatestState({ mvu: currentMvu });
            if (!secondRead.ok) return secondRead;
            const accepted = materialized.shouldEstablishSession === true;
            const built = buildCandidateMatchOutcomePatch(secondRead.state, { candidate: materialized.candidate, accepted });
            if (!built.ok) return rejectedFromBuild(built);
            const roleOperation = built.value.find((operation) => operation?.op === 'add' && /^\/角色池\/npc_match_\d+$/u.test(operation.path));
            const sessionOperation = built.value.find((operation) => operation?.op === 'add' && /^\/会话\/chat_[A-Za-z0-9_-]{1,64}$/u.test(operation.path));
            const applied = await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
            if (!applied.ok) return applied;
            return {
                ...applied,
                npcUid: roleOperation?.path.split('/')[2] ?? '',
                sessionUid: accepted ? (sessionOperation?.path.split('/')[2] ?? '') : '',
                matchOutcome: accepted ? 'accepted' : 'declined',
                explanation: materialized.explanation,
                matchScore: materialized.matchScore,
            };
        } finally {
            pending.delete(key);
        }
    }

    /** Applies a previously previewed soul-match draft only after an explicit UI confirmation. */
    async function applySoulMatchPreferenceDraft(draft) {
        const key = actionKey('apply_soul_match_preference', '');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const currentMvu = resolveMvu(mvu);
            const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;
            const built = buildSoulMatchPreferencePatch(read.state, { draft });
            if (!built.ok) return rejectedFromBuild(built);
            return await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
        } finally {
            pending.delete(key);
        }
    }

    /**
     * Private-chat entry point for desktop context menus and touch long-press
     * controls.  The UI supplies only its current chat session plus fields for
     * the agreement; the target NPC UID is re-derived from the latest MVU
     * snapshot and any caller-provided npcUid is deliberately ignored.
     */
    async function runPrivateChatMeetupHandoff(request = {}) {
        const sessionUid = typeof request?.sessionUid === 'string' ? request.sessionUid : '';
        if (!sessionUid) return { ok: false, status: 'rejected', code: 'meetup_invalid_target' };

        const currentMvu = resolveMvu(mvu);
        const read = readLatestState({ mvu: currentMvu });
        if (!read.ok) return read;
        const npcUid = read.state?.会话?.[sessionUid]?.对象UID;
        if (typeof npcUid !== 'string' || !npcUid) {
            return { ok: false, status: 'rejected', code: 'meetup_private_chat_session_not_found' };
        }

        return runMeetupHandoff({
            sessionUid,
            npcUid,
            time: request?.time,
            place: request?.place,
            mutualIntent: request?.mutualIntent,
            confirmedBoundaries: request?.confirmedBoundaries,
            pendingItems: request?.pendingItems,
            riskNotice: request?.riskNotice,
        });
    }

    /**
     * Persists an explicitly agreed, adult matched-session meetup record first,
     * then and only then appends a non-sending prose draft to the host textarea.
     */
    async function runMeetupHandoff(request = {}) {
        const key = actionKey('meetup_handoff', request?.sessionUid);
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const currentMvu = resolveMvu(mvu);
            let read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;
            let forcedSummaryCount = 0;
            while (listUnsummarizedConversationMessages(read.state?.会话?.[request?.sessionUid]).length > 0) {
                if (forcedSummaryCount >= 4) {
                    return { ok: false, status: 'rejected', code: 'meetup_summary_still_pending', message: '还有未总结聊天内容，请稍后重新尝试面基。' };
                }
                const summary = await runPrivateChatSummary({
                    sessionUid: request?.sessionUid,
                    npcUid: request?.npcUid,
                    force: true,
                });
                if (!summary?.ok) {
                    // 总结总开关关闭时所有总结入口都不可操作，不能指引用户去“聊天总结”里重试。
                    const summaryEnabled = chatSummarySettings().enabled === true;
                    return {
                        ok: false,
                        status: 'rejected',
                        code: 'meetup_summary_failed',
                        message: summaryEnabled
                            ? (summary?.message || '面基前的聊天总结未完成，请在“聊天总结”中重试后再继续。')
                            : '面基前的聊天总结未完成：请先在“我的 → 设置 → 对话总结”开启总结并配置绑定后重试面基。',
                    };
                }
                forcedSummaryCount += 1;
                read = readLatestState({ mvu: currentMvu });
                if (!read.ok) return read;
            }
            const built = buildMeetupHandoffPatch(read.state, request);
            if (!built.ok) return rejectedFromBuild(built);
            const applied = await applyControlledPatch({ patch: built.value.patch, mvu: currentMvu, eventEmit, getContext });
            if (!applied.ok) return applied;
            const handoff = appendMeetupDraft(built.value.draft);
            return { ...applied, meetupUid: built.value.meetupUid, draftApplied: handoff.ok, draftCode: handoff.ok ? '' : handoff.reason, forcedSummaryCount };
        } finally {
            pending.delete(key);
        }
    }

    /** Saves only a player-confirmed public profile through the MVU boundary. */
    async function runSavePlayerPublicProfile(profile) {
        const key = actionKey('save_player_public_profile', '');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const currentMvu = resolveMvu(mvu);
            const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;
            const built = buildPlayerPublicProfilePatch(read.state, { profile });
            if (!built.ok) return rejectedFromBuild(built);
            return await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
        } finally {
            pending.delete(key);
        }
    }
    /** Generates a non-persistent group-chat draft from a public-only group projection. */
    async function generateGroupChatDraft({ groupUid, playerMessage, signal } = {}) {
        const key = actionKey('group_chat_draft', groupUid);
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const read = readLatestState({ mvu: resolveMvu(mvu) });
            if (!read.ok) return read;
            return await generateGroupChatReply({ state: read.state, groupUid, playerMessage, settingsStore, llmClient, signal });
        } finally {
            pending.delete(key);
        }
    }

    /** Generates a non-persistent forum draft from a public-only group projection. */
    async function generateForumPostDraft({ groupUid, topic, signal } = {}) {
        const key = actionKey('forum_draft', groupUid);
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const read = readLatestState({ mvu: resolveMvu(mvu) });
            if (!read.ok) return read;
            return await generateForumPostDraftService({ state: read.state, groupUid, topic, settingsStore, llmClient, signal });
        } finally {
            pending.delete(key);
        }
    }

    /** Reads MVU only for a public projection, then generates a browser-local group update. */
    async function generateGroupConversationUpdate({ group, history, trigger = 'user', binding, signal } = {}) {
        const key = actionKey('group_chat_update', typeof group?.cacheKey === 'string' ? group.cacheKey : '');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const read = readLatestState({ mvu: resolveMvu(mvu) });
            if (!read.ok) return read;
            return await generateGroupChatUpdateService({ state: read.state, group, history, trigger, binding, settingsStore, llmClient, signal });
        } finally {
            pending.delete(key);
        }
    }

    /** The forum home is refreshed only by the UI's armed pull gesture; it remains local data. */
    async function generateForumHomeRefresh({ existingTitles, refreshMode = 'append', binding, signal } = {}) {
        const key = actionKey('forum_home_refresh', '');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const read = readLatestState({ mvu: resolveMvu(mvu) });
            if (!read.ok) return read;
            return await generateForumHomeRefreshService({ state: read.state, existingTitles, refreshMode, binding, settingsStore, llmClient, signal });
        } finally {
            pending.delete(key);
        }
    }

    /** Updates the current browser-local forum posts without creating new ones. */
    async function generateForumExistingPostsUpdate({ posts, binding, signal } = {}) {
        const key = actionKey('forum_existing_update', '');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const read = readLatestState({ mvu: resolveMvu(mvu) });
            if (!read.ok) return read;
            return await generateForumExistingPostsUpdateService({ state: read.state, posts, binding, settingsStore, llmClient, signal });
        } finally {
            pending.delete(key);
        }
    }

    /** Generates local-only comment updates for an opened forum post. */
    async function generateForumPostConversationUpdate({ postId, post, history, binding, signal } = {}) {
        const key = actionKey('forum_post_update', postId);
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const read = readLatestState({ mvu: resolveMvu(mvu) });
            if (!read.ok) return read;
            return await generateForumPostConversationUpdateService({ state: read.state, post, history, binding, settingsStore, llmClient, signal });
        } finally {
            pending.delete(key);
        }
    }

    /** Uses the shared chat_summary binding but never creates an MVU Patch for local group/forum history. */
    async function generateLocalGroupForumSummary({ target, messages, signal } = {}) {
        const targetKey = typeof target?.id === 'string' ? target.id : '';
        const key = actionKey('local_conversation_summary', targetKey);
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const read = readLatestState({ mvu: resolveMvu(mvu) });
            if (!read.ok) return read;
            return await generateLocalConversationSummaryService({
                target: { kind: target?.kind, title: target?.title },
                messages,
                contentMode: read.state?.软件?.内容模式,
                settingsStore,
                llmClient,
                signal,
            });
        } finally {
            pending.delete(key);
        }
    }

    /** Generates an AI completion from the editor's public projection only; this remains an in-memory draft. */
    async function generateCharacterCompletionDraft({ publicProfile, instruction, contentMode, signal } = {}) {
        const key = actionKey('character_completion_draft', '');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            return await generateCharacterCompletionCandidate({
                publicProfile,
                instruction,
                contentMode,
                settingsStore,
                llmClient,
                signal,
            });
        } finally {
            pending.delete(key);
        }
    }

    /** Generates a full AI candidate from a safe brief and the latest public player context; no MVU write occurs. */
    async function generateCharacterAuthoringDraft({ creativeBrief, expectedContentMode = '', signal } = {}) {
        const key = actionKey('character_authoring_draft', '');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        if (expectedContentMode && !CONTENT_MODES.has(expectedContentMode)) return { ok: false, status: 'rejected', code: 'character_authoring_mode_invalid' };
        pending.add(key);
        try {
            const currentMvu = resolveMvu(mvu);
            const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;
            const currentMode = read.state?.软件?.内容模式;
            if (expectedContentMode && currentMode !== expectedContentMode) return { ok: false, status: 'rejected', code: 'character_authoring_mode_changed', message: '内容模式已改变，请重新生成角色。' };
            const generated = await generateCharacterAuthoringCandidate({
                creativeBrief,
                contentMode: currentMode,
                playerPublicProfile: read.state?.玩家?.公开资料,
                settingsStore,
                llmClient,
                signal,
            });
            if (!expectedContentMode || !generated?.ok) return generated;
            const latest = readLatestState({ mvu: currentMvu });
            if (!latest.ok) return latest;
            if (latest.state?.软件?.内容模式 !== expectedContentMode) {
                return { ok: false, status: 'rejected', code: 'character_authoring_mode_changed', message: '内容模式已改变，请重新生成角色。' };
            }
            return generated;
        } finally {
            pending.delete(key);
        }
    }
    /** Generates exactly one local-only service candidate through the dedicated service binding. */
    async function generateServiceProfileDraft({ creativeBrief, expectedContentMode = '', signal } = {}) {
        const key = actionKey('service_profile_generation', '');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        if (expectedContentMode && !CONTENT_MODES.has(expectedContentMode)) return { ok: false, status: 'rejected', code: 'service_profile_mode_invalid' };
        pending.add(key);
        try {
            const currentMvu = resolveMvu(mvu);
            const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;
            const currentMode = read.state?.软件?.内容模式;
            if (expectedContentMode && currentMode !== expectedContentMode) return { ok: false, status: 'rejected', code: 'service_profile_mode_changed', message: '内容模式已改变，请重新生成服务角色。' };
            const generated = await generateServiceProfileCandidate({
                creativeBrief,
                contentMode: currentMode,
                playerPublicProfile: read.state?.玩家?.公开资料,
                settingsStore,
                llmClient,
                signal,
            });
            if (!expectedContentMode || !generated?.ok) return generated;
            const latest = readLatestState({ mvu: currentMvu });
            if (!latest.ok) return latest;
            if (latest.state?.软件?.内容模式 !== expectedContentMode) {
                return { ok: false, status: 'rejected', code: 'service_profile_mode_changed', message: '内容模式已改变，请重新生成服务角色。' };
            }
            return generated;
        } finally {
            pending.delete(key);
        }
    }

    /**
     * Copies one confirmed local service profile to MVU and creates its pending
     * order atomically. No textarea draft is appended until this write succeeds.
     */
    async function runServiceOrderHandoff({ candidate, candidates, categoryId, expectedContentMode = '' } = {}) {
        const key = actionKey('service_order_handoff', '');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        if (expectedContentMode && !CONTENT_MODES.has(expectedContentMode)) return { ok: false, status: 'rejected', code: 'service_order_mode_changed' };
        pending.add(key);
        const execute = async () => {
            const currentMvu = resolveMvu(mvu);
            const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;
            if (expectedContentMode && read.state?.软件?.内容模式 !== expectedContentMode) {
                return { ok: false, status: 'rejected', code: 'service_order_mode_changed' };
            }
            const built = buildServiceOrderHandoffPatch(read.state, { candidate, candidates, categoryId });
            if (!built.ok) return rejectedFromBuild(built);
            const applied = await applyControlledPatch({ patch: built.value.patch, mvu: currentMvu, eventEmit, getContext });
            return applied.ok ? { ...applied, npcUid: built.value.npcUid, npcUids: built.value.npcUids, orderUid: built.value.orderUid } : applied;
        };
        try {
            return await serializeServiceModeWrite(execute);
        } finally {
            pending.delete(key);
        }
    }

    /** Reopens a terminal service record as a new pending order. */
    async function runServiceOrderRepeat({ sourceOrderUid, expectedContentMode = '' } = {}) {
        const key = actionKey('service_order_repeat', sourceOrderUid || '');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        if (expectedContentMode && !CONTENT_MODES.has(expectedContentMode)) return { ok: false, status: 'rejected', code: 'service_order_mode_changed' };
        pending.add(key);
        const execute = async () => {
            const currentMvu = resolveMvu(mvu);
            const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;
            if (expectedContentMode && read.state?.软件?.内容模式 !== expectedContentMode) {
                return { ok: false, status: 'rejected', code: 'service_order_mode_changed' };
            }
            const built = buildServiceOrderRepeatPatch(read.state, { sourceOrderUid });
            if (!built.ok) return rejectedFromBuild(built);
            const applied = await applyControlledPatch({ patch: built.value.patch, mvu: currentMvu, eventEmit, getContext });
            return applied.ok ? { ...applied, npcUid: built.value.npcUid, orderUid: built.value.orderUid } : applied;
        };
        try {
            return await serializeServiceModeWrite(execute);
        } finally {
            pending.delete(key);
        }
    }

    /** Reopens a browser-local history record as a new pending order without restoring the old contract. */
    async function runServiceOrderRebook({ npcUid, npcUids, categoryId, expectedContentMode = '' } = {}) {
        const key = actionKey('service_order_rebook', Array.isArray(npcUids) ? npcUids.join(',') : (npcUid || ''));
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        if (expectedContentMode && !CONTENT_MODES.has(expectedContentMode)) return { ok: false, status: 'rejected', code: 'service_order_mode_changed' };
        pending.add(key);
        const execute = async () => {
            const currentMvu = resolveMvu(mvu); const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;
            if (expectedContentMode && read.state?.软件?.内容模式 !== expectedContentMode) return { ok: false, status: 'rejected', code: 'service_order_mode_changed' };
            const built = buildServiceOrderRebookPatch(read.state, { npcUid, npcUids, categoryId });
            if (!built.ok) return rejectedFromBuild(built);
            const applied = await applyControlledPatch({ patch: built.value.patch, mvu: currentMvu, eventEmit, getContext });
            return applied.ok ? { ...applied, npcUid: built.value.npcUid, npcUids: built.value.npcUids, orderUid: built.value.orderUid } : applied;
        };
        try { return await serializeServiceModeWrite(execute); }
        finally { pending.delete(key); }
    }

    /** Moves a pending service order to in-progress after the player confirms the structured contract. */
    async function runServiceOrderStart({ orderUid, boundaries, expectedContentMode = '' } = {}) {
        return runServiceOrderTransition({
            kind: 'service_order_start', orderUid, expectedContentMode,
            build: (state) => buildServiceOrderStartPatch(state, { orderUid, boundaries }),
        });
    }

    /** Cancels a pending service order; callers must archive locally before finalizing it away. */
    async function runServiceOrderCancel({ orderUid, expectedContentMode = '' } = {}) {
        return runServiceOrderTransition({
            kind: 'service_order_cancel', orderUid, expectedContentMode,
            build: (state) => buildServiceOrderCancelPatch(state, { orderUid }),
        });
    }

    /** Marks an in-progress order complete only after the body writes its complete legal end signal. */
    async function runServiceOrderComplete({ orderUid, expectedContentMode = '' } = {}) {
        return runServiceOrderTransition({
            kind: 'service_order_complete', orderUid, expectedContentMode,
            build: (state) => buildServiceOrderCompletePatch(state, { orderUid }),
        });
    }

    /** Atomically deletes all isolated service roles referenced by one local history record. */
    async function deleteServiceHistoryRoles({ npcUids } = {}) {
        const key = actionKey('service_history_delete', Array.isArray(npcUids) ? npcUids.join(',') : '');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const currentMvu = resolveMvu(mvu); const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;
            const built = buildServiceHistoryRolesDeletionPatch(read.state, { npcUids });
            if (!built.ok) return rejectedFromBuild(built);
            return await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
        } finally { pending.delete(key); }
    }

    /** Removes a malformed order record through the same guarded MVU pipeline. */
    async function repairServiceOrder({ orderUid } = {}) {
        return runServiceOrderTransition({
            kind: 'service_order_repair', orderUid, expectedContentMode: '',
            build: (state) => buildServiceOrderRepairPatch(state, { orderUid }),
        });
    }
    /** Deletes a terminal order only after its minimal browser-local archive is safely staged. */
    async function runServiceOrderFinalize({ orderUid } = {}) {
        return runServiceOrderTransition({
            kind: 'service_order_finalize', orderUid, expectedContentMode: '',
            build: (state) => buildServiceOrderFinalizePatch(state, { orderUid }),
        });
    }

    async function runServiceOrderTransition({ kind, orderUid, expectedContentMode, build }) {
        const key = actionKey(kind, orderUid || '');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        if (expectedContentMode && !CONTENT_MODES.has(expectedContentMode)) return { ok: false, status: 'rejected', code: 'service_order_mode_changed' };
        pending.add(key);
        const execute = async () => {
            const currentMvu = resolveMvu(mvu);
            const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;
            if (expectedContentMode && read.state?.软件?.内容模式 !== expectedContentMode) {
                return { ok: false, status: 'rejected', code: 'service_order_mode_changed' };
            }
            const built = build(read.state);
            if (!built.ok) return rejectedFromBuild(built);
            return applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
        };
        try { return await serializeServiceModeWrite(execute); }
        finally { pending.delete(key); }
    }

    /** Registers an already validated author/import draft through the sole MVU write boundary. */
    async function registerCharacter(candidate) {
        const key = actionKey('register_character', '');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const currentMvu = resolveMvu(mvu);
            const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;
            const built = buildCharacterRegistrationPatch(read.state, { candidate });
            if (!built.ok) return rejectedFromBuild(built);
            return await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
        } finally {
            pending.delete(key);
        }
    }

    /**
     * Generates a local conversation image without touching MVU state. The only
     * character data used is the adult role's drawing DNA; private layers and
     * relationship values never enter the prompt. Group/forum scene snapshots
     * may omit a character UID, but person-focused directives require one.
     */
    async function generateConversationImage({ kind, conversationId, messageId, characterUid = '', directive, signal } = {}) {
        if (!IMAGE_CONVERSATION_KINDS.has(kind) || typeof conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(conversationId)
            || typeof messageId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(messageId)) {
            return { ok: false, status: 'rejected', code: 'image_conversation_invalid', message: '当前对话无法生成图片。' };
        }
        const key = actionKey('conversation_image', `${kind}:${conversationId}:${messageId}`);
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending', message: '图片正在生成，请稍候。' };
        pending.add(key);
        try {
            const settings = settingsStore?.getImageGenerationSettings?.();
            if (!settings?.enabled) return { ok: false, status: 'rejected', code: 'image_generation_disabled', message: '请先在设置中启用生图接口。' };
            if (typeof imageGenerationClient?.generate !== 'function') return { ok: false, status: 'rejected', code: 'image_generation_unavailable', message: '生图服务当前不可用。' };

            let coreDna = '';
            let outfitDna = '';
            const uid = typeof characterUid === 'string' ? characterUid : '';
            if (uid) {
                const read = readLatestState({ mvu: resolveMvu(mvu) });
                if (!read.ok) return read;
                const character = read.state?.角色池?.[uid];
                if (!character || character.成人验证 !== true || Number(character.隐藏资料?.实际年龄) < 18) {
                    return { ok: false, status: 'rejected', code: 'image_character_unavailable', message: '只能为已确认的成年角色生成图片。' };
                }
                coreDna = typeof character.绘图?.core_dna === 'string' ? character.绘图.core_dna : '';
                outfitDna = typeof character.绘图?.outfit_dna === 'string' ? character.绘图.outfit_dna : '';
            }

            const prompt = composeImagePrompt({
                positivePrefix: settings.positivePrefix,
                coreDna,
                outfitDna,
                directive,
                positiveSuffix: settings.positiveSuffix,
                negativePrompt: settings.negativePrompt,
            });
            if (!uid && prompt.directive.kind !== 'scene_snapshot') {
                return { ok: false, status: 'rejected', code: 'image_character_required', message: '人物图片需要关联一位已确认的成年角色。' };
            }
            const generated = await imageGenerationClient.generate({
                settings, positivePrompt: prompt.positivePrompt, negativePrompt: prompt.negativePrompt, signal,
            });
            return {
                ok: true, status: 'generated', directive: prompt.directive,
                image: Object.freeze({ src: generated.src, dataUrl: generated.kind === 'data_url' ? generated.src : '', mimeType: generated.mimeType ?? '', kind: generated.kind }),
            };
        } catch (error) {
            const publicError = toPublicImageGenerationError(error);
            return { ok: false, status: 'failed', ...publicError };
        } finally {
            pending.delete(key);
        }
    }

    function isPending(kind, npcUid) {
        return pending.has(actionKey(kind, npcUid));
    }
    /**
     * Face-to-face handoff is intentionally draft-only. It appends to
     * #send_textarea, emits input, focuses it, and never auto-sends/clicks.
     */
    function appendMeetupDraft(draft) {
        const textarea = documentRef?.querySelector?.('#send_textarea');
        const TextareaCtor = documentRef?.defaultView?.HTMLTextAreaElement ?? globalThis.HTMLTextAreaElement;
        if (!textarea || (typeof TextareaCtor === 'function' && !(textarea instanceof TextareaCtor))) return { ok: false, reason: 'send_textarea_not_found' };

        const next = String(draft ?? '').trim();
        if (!next) return { ok: false, reason: 'empty_draft' };
        try {
            textarea.value = String(textarea.value ?? '').trim()
                ? `${String(textarea.value).replace(/\s+$/, '')}\n${next}`
                : next;
        } catch {
            return { ok: false, reason: 'send_textarea_write_failed' };
        }
        const EventCtor = documentRef?.defaultView?.Event ?? globalThis.Event;
        if (typeof EventCtor !== 'function') return { ok: false, reason: 'send_textarea_event_unavailable' };
        try {
            textarea.dispatchEvent?.(new EventCtor('input', { bubbles: true }));
        } catch {
            return { ok: false, reason: 'send_textarea_input_failed' };
        }
        try { textarea.focus?.(); } catch { /* Draft is already inserted; focus is presentation-only. */ }
        try { textarea.setSelectionRange?.(textarea.value.length, textarea.value.length); } catch { /* Selection is presentation-only. */ }
        return { ok: true };
    }

    return Object.freeze({ emit, runMvuAction, runRecommendationRefresh, runRecommendationInitialCandidate, runPrivateChat, runPrivateChatSummary, clearPrivateChat, deleteCharacter, generateMatchDraft, runCandidateMatch, applySoulMatchPreferenceDraft, runPrivateChatMeetupHandoff, runMeetupHandoff, runSavePlayerPublicProfile, generateGroupChatDraft, generateForumPostDraft, generateGroupConversationUpdate, generateForumHomeRefresh, generateForumExistingPostsUpdate, generateForumPostConversationUpdate, generateLocalGroupForumSummary, generateCharacterCompletionDraft, generateCharacterAuthoringDraft, generateServiceProfileDraft, registerCharacter, runServiceOrderHandoff, runServiceOrderRepeat, runServiceOrderRebook, runServiceOrderStart, runServiceOrderCancel, runServiceOrderComplete, runServiceOrderFinalize, deleteServiceHistoryRoles, repairServiceOrder, generateConversationImage, isPending, appendMeetupDraft });
}

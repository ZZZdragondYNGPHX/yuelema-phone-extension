import { applyControlledPatch, readLatestState } from './mvu/adapter.js';
import { buildCandidateMatchOutcomePatch, buildCharacterRegistrationPatch, buildControlledPatch, buildClearPrivateChatPatch, buildDeleteCharacterPatch, buildMeetupHandoffPatch, buildPlayerPublicProfilePatch, buildPrivateChatPatch, buildPrivateChatSummaryFailurePatch, buildPrivateChatSummaryPatch, buildRecommendationInitialCandidatePatch, buildRecommendationRefreshPatch, buildSoulMatchPreferencePatch } from './mvu/controlled-patch.js';
import { generateRecommendationCandidate } from './recommendation/recommendation-refresh.js';
import { generatePrivateChatReply, generatePrivateChatSummary } from './chat/private-chat-service.js';
import { DEFAULT_CHAT_SUMMARY_SETTINGS, isConversationSummaryDue, listUnsummarizedConversationMessages } from './chat/conversation-summary.js';
import { generateCandidateMatchDraft as generateCandidateMatchDraftService, generateSoulMatchDraft, generateTextMatchDraft } from './recommendation/soul-text-match-service.js';
import { materializeCandidateMatchDraft } from './recommendation/match-candidate-materializer.js';
import { generateCharacterAuthoringCandidate, generateCharacterCompletionCandidate } from './characters/character-authoring-service.js';
import { generateGroupChatReply, generateGroupChatUpdate as generateGroupChatUpdateService } from './groups/group-chat-service.js';
import { generateForumExistingPostsUpdate as generateForumExistingPostsUpdateService, generateForumHomeRefresh as generateForumHomeRefreshService, generateForumPostConversationUpdate as generateForumPostConversationUpdateService, generateForumPostDraft as generateForumPostDraftService } from './groups/forum-service.js';
import { generateLocalConversationSummary as generateLocalConversationSummaryService } from './groups/local-conversation-summary-service.js';

const PASSIVE_KINDS = new Set([
    'open_character_creator',
    'open_character_import',
    'open_random_candidates',
    'navigate',
]);
const MVU_KINDS = new Set(['like', 'favorite', 'dislike', 'refresh', 'unfavorite', 'start_private_chat', 'advance_content_mode_gate', 'toggle_content_mode']);
const PERSONALIZATION_DELTAS = Object.freeze({ like: 3, favorite: 1, dislike: -3 });
const PERSONALIZATION_PUBLIC_TAG_FIELDS = Object.freeze(['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']);

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
 * @param {{ documentRef: Document, mvu?: unknown, eventEmit?: unknown, getContext?: (() => unknown)|undefined, settingsStore?: unknown, llmClient?: unknown, imageMatchCoordinator?: unknown, onControlledAction?: (command: Readonly<{kind:string, payload:Readonly<Record<string,string>>}>) => void }} options
 */
export function createActionBridge({
    documentRef,
    mvu = globalThis.Mvu,
    eventEmit = globalThis.eventEmit,
    getContext = globalThis.SillyTavern?.getContext?.bind(globalThis.SillyTavern),
    settingsStore = null,
    llmClient = null,
    imageMatchCoordinator = null,
    onControlledAction = () => {},
}) {
    const pending = new Set();

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
        try {
            const currentMvu = resolveMvu(mvu);
            const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;

            const command = ['advance_content_mode_gate', 'toggle_content_mode'].includes(kind)
                ? { kind }
                : { kind, npcUid };
            const built = buildControlledPatch(read.state, command);
            if (!built.ok) return { ok: false, status: 'rejected', code: built.code, detail: built.detail };

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
            if (!built.ok) return { ok: false, status: 'rejected', code: built.code };
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
            if (!built.ok) return { ok: false, status: 'rejected', code: built.code };
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
            if (!built.ok) return { ok: false, status: 'rejected', code: built.code };
            const interactionOutcome = built.value.some((operation) => operation?.op === 'replace'
                && operation.path === '/会话/' + sessionUid + '/状态' && operation.value === '已拉黑')
                ? 'blocked'
                : built.value.some((operation) => operation?.op === 'add'
                    && operation.path === '/会话/' + sessionUid + '/最近消息/-' && operation.value?.发送者 === '角色')
                    ? 'replied'
                    : 'read_without_reply';
            const applied = await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
            const summarySettings = chatSummarySettings();
            return applied.ok ? {
                ...applied,
                interactionOutcome,
                summaryCheckRequested: interactionOutcome === 'replied' && summarySettings.enabled,
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
            if (!built.ok) return { ok: false, status: 'rejected', code: built.code };
            return await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
        } finally {
            pending.delete(key);
        }
    }

    /** Backwards-compatible bridge name; it now means clearing the chat session. */
    const deletePrivateChat = clearPrivateChat;

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
            if (!built.ok) return { ok: false, status: 'rejected', code: built.code };
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

    /** Generates one ephemeral public profile for the restored matching page; it never writes MVU state. */
    async function generateCandidateMatchDraft(mode, { voiceText, signal } = {}) {
        if (!['soul', 'voice'].includes(mode)) return { ok: false, status: 'rejected', code: 'candidate_match_mode_invalid' };
        const key = actionKey('candidate_match_' + mode, '');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const currentMvu = resolveMvu(mvu);
            const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;
            return await generateCandidateMatchDraftService({ mode, state: read.state, settingsStore, llmClient, voiceText, signal });
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
            if (!built.ok) return { ok: false, status: 'rejected', code: built.code };
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
            if (!built.ok) return { ok: false, status: 'rejected', code: built.code };
            return await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
        } finally {
            pending.delete(key);
        }
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
                    return {
                        ok: false,
                        status: 'rejected',
                        code: 'meetup_summary_failed',
                        message: summary?.message || '面基前的聊天总结未完成，请在“聊天总结”中重试后再继续。',
                    };
                }
                forcedSummaryCount += 1;
                read = readLatestState({ mvu: currentMvu });
                if (!read.ok) return read;
            }
            const built = buildMeetupHandoffPatch(read.state, request);
            if (!built.ok) return { ok: false, status: 'rejected', code: built.code };
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
            if (!built.ok) return { ok: false, status: 'rejected', code: built.code };
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
    async function generateCharacterAuthoringDraft({ creativeBrief, signal } = {}) {
        const key = actionKey('character_authoring_draft', '');
        if (pending.has(key)) return { ok: false, status: 'rejected', code: 'ui_action_pending' };
        pending.add(key);
        try {
            const currentMvu = resolveMvu(mvu);
            const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;
            return await generateCharacterAuthoringCandidate({
                creativeBrief,
                contentMode: read.state?.软件?.内容模式,
                playerPublicProfile: read.state?.玩家?.公开资料,
                settingsStore,
                llmClient,
                signal,
            });
        } finally {
            pending.delete(key);
        }
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
            if (!built.ok) return { ok: false, status: 'rejected', code: built.code };
            return await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
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
        const textarea = documentRef.querySelector('#send_textarea');
        if (!textarea || (typeof HTMLTextAreaElement !== 'undefined' && !(textarea instanceof HTMLTextAreaElement))) return { ok: false, reason: 'send_textarea_not_found' };

        const next = String(draft ?? '').trim();
        if (!next) return { ok: false, reason: 'empty_draft' };

        textarea.value = textarea.value.trim()
            ? `${textarea.value.replace(/\s+$/, '')}\n${next}`
            : next;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        return { ok: true };
    }

    return Object.freeze({ emit, runMvuAction, runRecommendationRefresh, runRecommendationInitialCandidate, runPrivateChat, runPrivateChatSummary, clearPrivateChat, deletePrivateChat, deleteCharacter, generateMatchDraft, generateCandidateMatchDraft, runCandidateMatch, applySoulMatchPreferenceDraft, runMeetupHandoff, runSavePlayerPublicProfile, generateGroupChatDraft, generateForumPostDraft, generateGroupConversationUpdate, generateForumHomeRefresh, generateForumExistingPostsUpdate, generateForumPostConversationUpdate, generateLocalGroupForumSummary, generateCharacterCompletionDraft, generateCharacterAuthoringDraft, registerCharacter, isPending, appendMeetupDraft });
}


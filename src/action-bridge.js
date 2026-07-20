import { applyControlledPatch, readLatestState } from './mvu/adapter.js';
import { buildCharacterRegistrationPatch, buildControlledPatch, buildMeetupHandoffPatch, buildPlayerPublicProfilePatch, buildPrivateChatPatch, buildRecommendationInitialCandidatePatch, buildRecommendationRefreshPatch, buildSoulMatchPreferencePatch } from './mvu/controlled-patch.js';
import { generateRecommendationCandidate } from './recommendation/recommendation-refresh.js';
import { generatePrivateChatReply } from './chat/private-chat-service.js';
import { generateCandidateMatchDraft as generateCandidateMatchDraftService, generateSoulMatchDraft, generateTextMatchDraft } from './recommendation/soul-text-match-service.js';
import { generateCharacterAuthoringCandidate, generateCharacterCompletionCandidate } from './characters/character-authoring-service.js';
import { generateGroupChatReply } from './groups/group-chat-service.js';
import { generateForumPostDraft as generateForumPostDraftService } from './groups/forum-service.js';

const PASSIVE_KINDS = new Set([
    'open_character_creator',
    'open_character_import',
    'open_random_candidates',
    'navigate',
]);
const MVU_KINDS = new Set(['like', 'favorite', 'dislike', 'refresh', 'unfavorite', 'advance_content_mode_gate', 'toggle_content_mode']);
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
function publicCandidateTags(state, npcUid) {
    if (typeof npcUid !== 'string' || !npcUid) return [];
    const recommendation = state && typeof state === 'object' ? state.推荐 : null;
    if (!recommendation || typeof recommendation !== 'object') return [];
    const candidate = recommendation.临时候选池?.[npcUid] ?? state?.角色池?.[npcUid];
    const profile = candidate && typeof candidate === 'object' ? candidate.公开资料 : null;
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

function syncDevicePersonalization(settingsStore, state, kind, npcUid) {
    const delta = PERSONALIZATION_DELTAS[kind];
    if (!delta || typeof settingsStore?.applyPersonalizationKeywordWeightDelta !== 'function') return false;
    try {
        settingsStore.applyPersonalizationKeywordWeightDelta(publicCandidateTags(state, npcUid), delta);
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
 * @param {{ documentRef: Document, mvu?: unknown, eventEmit?: unknown, getContext?: (() => unknown)|undefined, settingsStore?: unknown, llmClient?: unknown, onControlledAction?: (command: Readonly<{kind:string, payload:Readonly<Record<string,string>>}>) => void }} options
 */
export function createActionBridge({
    documentRef,
    mvu = globalThis.Mvu,
    eventEmit = globalThis.eventEmit,
    getContext = globalThis.SillyTavern?.getContext?.bind(globalThis.SillyTavern),
    settingsStore = null,
    llmClient = null,
    onControlledAction = () => {},
}) {
    const pending = new Set();

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

            const applied = await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
            if (applied.ok) syncDevicePersonalization(settingsStore, read.state, kind, npcUid);
            return applied;
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

            // The model call is asynchronous: never reuse a stale click target/state.
            const secondRead = readLatestState({ mvu: currentMvu });
            if (!secondRead.ok) return secondRead;
            const built = buildRecommendationRefreshPatch(secondRead.state, {
                replacedNpcUid,
                candidate: generated.candidate,
            });
            if (!built.ok) return { ok: false, status: 'rejected', code: built.code };
            return await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
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

            const secondRead = readLatestState({ mvu: currentMvu });
            if (!secondRead.ok) return secondRead;
            const built = buildRecommendationInitialCandidatePatch(secondRead.state, { candidate: generated.candidate });
            if (!built.ok) return { ok: false, status: 'rejected', code: built.code };
            return await applyControlledPatch({ patch: built.value, mvu: currentMvu, eventEmit, getContext });
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
            const read = readLatestState({ mvu: currentMvu });
            if (!read.ok) return read;
            const built = buildMeetupHandoffPatch(read.state, request);
            if (!built.ok) return { ok: false, status: 'rejected', code: built.code };
            const applied = await applyControlledPatch({ patch: built.value.patch, mvu: currentMvu, eventEmit, getContext });
            if (!applied.ok) return applied;
            const handoff = appendMeetupDraft(built.value.draft);
            return { ...applied, meetupUid: built.value.meetupUid, draftApplied: handoff.ok, draftCode: handoff.ok ? '' : handoff.reason };
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

    return Object.freeze({ emit, runMvuAction, runRecommendationRefresh, runRecommendationInitialCandidate, runPrivateChat, generateMatchDraft, generateCandidateMatchDraft, applySoulMatchPreferenceDraft, runMeetupHandoff, runSavePlayerPublicProfile, generateGroupChatDraft, generateForumPostDraft, generateCharacterCompletionDraft, generateCharacterAuthoringDraft, registerCharacter, isPending, appendMeetupDraft });
}






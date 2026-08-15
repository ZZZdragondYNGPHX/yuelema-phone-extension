import { decodeJsonPointer, encodeJsonPointer, getAtPointer, isPlainRecord } from './json-pointer.js';
import { normalizeGeneratedCandidate } from '../recommendation/candidate.js';
import {
    NSFW_CONSENT_ASSESSMENT_KINDS,
    NSFW_SAFETY_ASSESSMENT_KINDS,
    SFW_INSIGHT_ASSESSMENT_KINDS,
    SFW_RESOLUTION_ASSESSMENT_KINDS,
    normalizePrivateChatResponse,
    normalizeRealisticPrivateChatResponse,
} from '../chat/private-chat-response.js';
import { validatePrivateChatRequest } from '../chat/private-chat-service.js';
import { decideInteractionRhythm } from '../chat/interaction-rhythm.js';
import { BODY_EVENT_REVIEW_STATES, allowedAssessmentKinds, deriveMeetupAccess, deriveRelationshipSafetyState, meetupRouteGuidance, settleBodyRelationshipCandidate, settleRelationshipProgress } from '../chat/relationship-progress.js';
import {
    MAX_CHAT_HISTORY_MESSAGES,
    MAX_CHAT_SUMMARY_RECORDS,
    countUnsummarizedConversationLayers,
    listConversationSummaryRecords,
    listUnsummarizedConversationMessages,
    normalizeConversationSummaryFailure,
    normalizeConversationSummaryState,
    normalizeGeneratedConversationSummary,
    summaryRecordSource,
} from '../chat/conversation-summary.js';
import { MATCH_ACCEPTANCE_THRESHOLD, scoreFavoritePrivateChatInvitation } from '../recommendation/match-scoring.js';
import { normalizeSoulMatchDraft } from '../recommendation/soul-text-match-service.js';
import {
    createRelationshipNarrativeFromProfile,
    isRelationshipNarrativeContentEmpty,
    validateRelationshipNarrative,
} from './relationship-narrative.js';
import {
    createEmptyBodyRelationshipCandidate,
    selectPendingBodyRelationshipCandidate,
    validateBodyRelationshipCandidate,
} from './body-relationship-candidate.js';
import {
    closeNsfwConsent,
    consumeNsfwConsent,
    createEmptyNsfwConsent,
    grantNsfwConsent,
    isActiveNsfwConsent,
    matchesNsfwConsentReference,
    nsfwConsentReference,
    validateNsfwConsent,
} from './nsfw-consent.js';
import {
    MAX_REALISTIC_PENDING_MESSAGES,
    MAX_REALISTIC_PLAYER_BURST_COUNT,
    MAX_REALISTIC_PLAYER_BURST_LENGTH,
    REALISTIC_REPLY_QUIET_MINUTES,
    createDefaultRealisticChatState,
    latestPlayerMessageUid,
    listPendingRealisticPlayerMessages,
    validatePendingRealisticMessage,
    validateRealisticChatState,
} from './realistic-chat.js';
import { addPhoneMinutes, isPhoneTimestampDue, parsePhoneTimestamp } from '../chat/phone-clock.js';

export const LATEST_MESSAGE_SCOPE = Object.freeze({ type: 'message', message_id: 'latest' });
export const NPC_UID_PATTERN = /^npc_[a-z0-9][a-z0-9_-]{0,63}$/i;

const LIST_NAMES = new Set(['当前队列', '冷却角色UID', '收藏角色UID', '不喜欢角色UID', '拉黑角色UID']);
const TRACKED_LIST_NAMES = new Set(['冷却角色UID', '收藏角色UID', '不喜欢角色UID', '拉黑角色UID']);
const CHAT_SESSION_UID_PATTERN = /^chat_[a-z0-9][a-z0-9_-]{0,63}$/i;
const MEETUP_UID_PATTERN = /^meetup_[a-z0-9][a-z0-9_-]{0,63}$/i;
const GROUP_UID_PATTERN = /^group_[a-z0-9][a-z0-9_-]{0,63}$/i;
const SERVICE_ORDER_UID_PATTERN = /^service_[a-z0-9][a-z0-9_-]{0,63}$/i;
const SERVICE_PRODUCT_CATEGORY_LABELS_SFW = Object.freeze({
    girl_shuren: '熟人商品', girl_luren: '路人商品', random_generation: '随机商品',
});
const SERVICE_PRODUCT_CATEGORY_LABELS_NSFW = Object.freeze({
    girl_shuren: '熟人性爱幻想', girl_luren: '陌生约炮邂逅', random_generation: '随机性癖体验',
});
const LEGACY_SERVICE_CATEGORY_BY_MODE = Object.freeze({
    SFW: Object.freeze({ coffee_walk: '咖啡与散步', arts_outing: '展览与演出', city_guide: '城市向导', hobby_day: '兴趣活动' }),
    NSFW: Object.freeze({ adult_companion: '成人直白陪伴', erotic_roleplay: '情色角色扮演', explicit_chat: '露骨文爱', private_service: '私密成人服务' }),
});
// Legacy activities are retained solely to validate and preserve existing history.
const SERVICE_CATEGORY_BY_MODE = Object.freeze({
    SFW: Object.freeze({ ...SERVICE_PRODUCT_CATEGORY_LABELS_SFW, ...LEGACY_SERVICE_CATEGORY_BY_MODE.SFW }),
    NSFW: Object.freeze({ ...SERVICE_PRODUCT_CATEGORY_LABELS_NSFW, ...LEGACY_SERVICE_CATEGORY_BY_MODE.NSFW }),
});
const RELATIONSHIP_VALUE_FIELDS = Object.freeze(['好感', '信任', '戒备', '面基意愿']);
const BOND_VALUE_FIELDS = Object.freeze(['友情值', '心动值', '欲望值']);
const RELATIONSHIP_NARRATIVE_PROGRESS_BOOLEAN_FIELDS = new Set([
    'SFW细微裂缝已触发', 'SFW朋友分享已触发', 'SFW面基已解锁',
    'SFW理解已检查', 'SFW主动揭示已触发', 'SFW心动已解锁', 'SFW双轨结局已解锁',
    'NSFW爱情阶段30已触发', 'NSFW爱情阶段40已触发',
    'NSFW共识亲密阶段30已触发', 'NSFW共识亲密阶段40已触发',
    'NSFW方向确认可用',
]);
const RELATIONSHIP_NARRATIVE_TURN_ID_PATTERN = /^msg_chat_[A-Za-z0-9][A-Za-z0-9_-]{0,63}_p_[1-9]\d*$/u;
const RELATIONSHIP_NARRATIVE_EVENT_ID_PATTERN = /^(?:chat:[A-Za-z0-9][A-Za-z0-9_-]{0,63}:[1-9]\d*|body:meetup_[A-Za-z0-9][A-Za-z0-9_-]{0,63}:1)$/u;
const MAX_CHAT_MESSAGE_LENGTH = 600;
const MAX_SERVICE_ORDER_PARTICIPANTS = 3;
const EMPTY_SERVICE_COMPLETION_SIGNAL = Object.freeze({ 已满足: false, 摘要: '', 记录时间: '' });
const READ_WITHOUT_REPLY_NOTICE = '对方已读，但暂时没有回复。';
const BLOCKED_CHAT_NOTICE = '对方已将你拉黑，当前会话无法继续发送消息。';
const PLAYER_PUBLIC_TEXT_LIMITS = Object.freeze({
    昵称: 80, 头像引用: 500, 年龄段: 32, 性别: 48, 性取向: 80, 城市: 80,
    距离范围: 48, 寻找意图: 120, 简介: 500,
});
const PLAYER_PUBLIC_TAG_FIELDS = Object.freeze(['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']);

function fail(code, detail = '', reason = '') {
    // 2026-07-27 控制台诊断增强：reason 是可选的人类可读失败原因，仅在非空时附加，
    // 因此只读 code/detail 的既有消费方（含深比较测试）完全不受影响。
    // 硬线：reason 只允许字段名、JSON Pointer 路径与校验结论；绝不拼接隐藏资料层
    // 的字段值、关系分数值或阈值数值本身。
    if (typeof reason === 'string' && reason) return { ok: false, code, detail, reason };
    return { ok: false, code, detail };
}

// 成年相关校验错误码（candidate.js 的稳定错误码，仅字段路径 + 结论，不含数值）。
const ADULT_VALIDATION_CODE_PATTERN = /^(?:成人验证:|公开资料\.年龄段:underage$|隐藏资料\.实际年龄:)/u;

/** 把 normalizeGeneratedCandidate 抛出的稳定错误码翻译成不含隐藏值的失败原因。 */
function candidateValidationReason(error, label = '') {
    const code = typeof error?.code === 'string' && error.code ? error.code : 'invalid_input';
    if (ADULT_VALIDATION_CODE_PATTERN.test(code)) {
        return `${label}成年人校验未通过：字段 ${code.split(':')[0]}`;
    }
    return `${label}结构校验未通过：${code}`;
}

function success(value) {
    return { ok: true, value };
}

function isNpcUid(value) {
    return typeof value === 'string' && NPC_UID_PATTERN.test(value);
}

function validRelationshipNarrativeTurnId(value) {
    return typeof value === 'string' && value.length <= 160 && RELATIONSHIP_NARRATIVE_TURN_ID_PATTERN.test(value);
}

function validRelationshipNarrativeEventIds(value) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 64) return false;
    try {
        const names = Object.getOwnPropertyNames(value);
        if (names.length !== value.length + 1 || !names.includes('length') || Object.getOwnPropertySymbols(value).length !== 0) return false;
        const seen = new Set();
        for (let index = 0; index < value.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            const eventId = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
            if (!descriptor?.enumerable || typeof eventId !== 'string' || eventId.length > 80
                || !RELATIONSHIP_NARRATIVE_EVENT_ID_PATTERN.test(eventId) || seen.has(eventId)) return false;
            seen.add(eventId);
        }
        return names.every((name) => name === 'length' || /^(0|[1-9]\d*)$/u.test(name) && Number(name) < value.length);
    } catch {
        return false;
    }
}

function isEmptyBodyRelationshipCandidate(value) {
    const validated = validateBodyRelationshipCandidate(value);
    if (!validated.ok) return false;
    try {
        return JSON.stringify(value) === JSON.stringify(createEmptyBodyRelationshipCandidate());
    } catch {
        return false;
    }
}

function isEmptyNsfwConsent(value) {
    const validated = validateNsfwConsent(value);
    if (!validated.ok) return false;
    try { return JSON.stringify(value) === JSON.stringify(createEmptyNsfwConsent()); }
    catch { return false; }
}

function isEmptyBodyRelationshipCandidateRegistry(value) {
    if (!ownRecord(value)) return false;
    try {
        const keys = Object.keys(value);
        if (Reflect.ownKeys(value).length !== keys.length) return false;
        return keys.every((uid) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, uid);
            return isNpcUid(uid) && descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
                && isEmptyBodyRelationshipCandidate(descriptor.value);
        });
    } catch {
        return false;
    }
}

function ownRecord(value) {
    return isPlainRecord(value) ? value : null;
}

function arrayAt(state, name) {
    const result = getAtPointer(state, encodeJsonPointer(['推荐', name]));
    return Array.isArray(result.value) ? result.value : null;
}

function candidateAt(state, uid) {
    const result = getAtPointer(state, encodeJsonPointer(['推荐', '临时候选池', uid]));
    return ownRecord(result.value);
}

function roleAt(state, uid) {
    const result = getAtPointer(state, encodeJsonPointer(['角色池', uid]));
    return ownRecord(result.value);
}

function assertKnownAdult(state, uid) {
    const candidate = candidateAt(state, uid);
    const role = roleAt(state, uid);
    const profile = candidate ?? role;
    if (!profile) return fail('npc_not_found', '', '该角色既不在 /推荐/临时候选池 也不在 /角色池');

    const hidden = ownRecord(profile.隐藏资料);
    if (profile.成人验证 !== true || !hidden || !Number.isInteger(hidden.实际年龄) || hidden.实际年龄 < 18) {
        const field = profile.成人验证 !== true ? '成人验证' : '隐藏资料.实际年龄';
        return fail('npc_adult_verification_failed', '', `成年人校验未通过：字段 ${field}`);
    }
    return success({ location: candidate ? 'candidate' : 'role', profile });
}

function removeUidFromQueue(state, uid, operations) {
    const queue = arrayAt(state, '当前队列');
    if (!queue) return fail('recommendation_queue_missing');
    const index = queue.indexOf(uid);
    if (index >= 0) {
        operations.push({ op: 'remove', path: encodeJsonPointer(['推荐', '当前队列', String(index)]) });
    }
    return success(undefined);
}

function cleanPlayerText(value, maxLength) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (text.length > maxLength || /[\u0000-\u001F\u007F]/u.test(text)) return null;
    return text;
}

function cleanPlayerTags(value) {
    if (!Array.isArray(value) || value.length > 24) return null;
    const tags = [];
    for (const raw of value) {
        const tag = cleanPlayerText(raw, 32);
        if (tag === null || !tag || tags.includes(tag)) return null;
        tags.push(tag);
    }
    return tags;
}

/** Validates the player's editable public profile only; private layers remain unwritable from the UI. */
export function normalizePlayerPublicProfile(input) {
    if (!ownRecord(input)) return null;
    const unknown = Object.keys(input).filter((key) => !Object.hasOwn(PLAYER_PUBLIC_TEXT_LIMITS, key) && !PLAYER_PUBLIC_TAG_FIELDS.includes(key));
    if (unknown.length > 0) return null;
    const profile = {};
    for (const [field, maxLength] of Object.entries(PLAYER_PUBLIC_TEXT_LIMITS)) {
        const text = cleanPlayerText(input[field] ?? '', maxLength);
        if (text === null) return null;
        profile[field] = text;
    }
    for (const field of PLAYER_PUBLIC_TAG_FIELDS) {
        const tags = cleanPlayerTags(input[field] ?? []);
        if (!tags) return null;
        profile[field] = tags;
    }
    return Object.freeze(profile);
}

/** Creates a state-aware Patch for the player's confirmed public profile and nothing else. */
export function buildPlayerPublicProfilePatch(state, { profile } = {}) {
    if (!ownRecord(state)) return fail('player_profile_state_invalid');
    const player = ownRecord(state.玩家);
    const current = ownRecord(player?.公开资料);
    const switches = ownRecord(state.软件)?.功能开关;
    const normalized = normalizePlayerPublicProfile(profile);
    // "玩家已建档" is an optional bookkeeping gate, not part of the public
    // profile contract. Older chats can lack this later-added field; their
    // fully validated public profile must remain editable without attempting
    // to add or infer any unknown state shape.
    if (!player || player.成人验证 !== true || !current || !normalized) {
        return fail('player_profile_invalid');
    }
    const operations = [];
    for (const field of Object.keys(PLAYER_PUBLIC_TEXT_LIMITS)) {
        if (current[field] !== normalized[field]) operations.push({ op: 'replace', path: encodeJsonPointer(['玩家', '公开资料', field]), value: normalized[field] });
    }
    for (const field of PLAYER_PUBLIC_TAG_FIELDS) {
        if (JSON.stringify(current[field]) !== JSON.stringify(normalized[field])) operations.push({ op: 'replace', path: encodeJsonPointer(['玩家', '公开资料', field]), value: normalized[field] });
    }
    // A bare "已建档" flip is not a profile save. Requiring at least one
    // controlled public-field change prevents a forged gate-only UI patch.
    if (operations.length > 0 && switches?.玩家已建档 === false) {
        operations.push({ op: 'replace', path: encodeJsonPointer(['软件', '功能开关', '玩家已建档']), value: true });
    }
    return operations.length ? success(operations) : fail('player_profile_no_change');
}
function addUidOnce(state, listName, uid, operations) {
    const list = arrayAt(state, listName);
    if (!list) return fail('recommendation_list_missing', listName);
    if (!list.includes(uid)) {
        operations.push({ op: 'add', path: encodeJsonPointer(['推荐', listName, '-']), value: uid });
    }
    return success(undefined);
}

/** Applies only user-confirmed, public tag target weights from a validated soul-match draft. */
export function buildSoulMatchPreferencePatch(state, { draft } = {}) {
    if (!ownRecord(state)) return fail('soul_match_preference_state_invalid');
    const mode = currentContentMode(state);
    const weights = currentPreferenceWeights(state);
    if (!ownRecord(weights)) return fail('soul_match_preference_state_invalid');
    let normalized;
    try { normalized = normalizeSoulMatchDraft(draft); }
    catch { return fail('soul_match_preference_draft_invalid'); }
    const operations = [];
    for (const { tag, weight } of normalized.tagWeightDraft) {
        const exists = Object.hasOwn(weights, tag);
        const current = exists ? weights[tag] : 0;
        if (!Number.isInteger(current) || current < -5 || current > 5) return fail('soul_match_preference_state_invalid');
        if (current !== weight) operations.push({
            op: exists ? 'replace' : 'add',
            path: encodeJsonPointer(['玩家', '推荐偏好', '标签权重', mode, tag]), value: weight,
        });
    }
    return operations.length ? success(operations) : fail('soul_match_preference_no_change');
}

/** Atomically swaps the visible recommendation after a full adult candidate validates. */
export function buildRecommendationRefreshPatch(state, { replacedNpcUid, candidate } = {}) {
    if (!ownRecord(state) || !isNpcUid(replacedNpcUid)) return fail('recommendation_refresh_invalid_command');
    const current = assertKnownAdult(state, replacedNpcUid);
    if (!current.ok || current.value.location !== 'candidate') return fail('recommendation_refresh_source_invalid');
    const queue = arrayAt(state, '当前队列');
    const cooldown = arrayAt(state, '冷却角色UID');
    const roleCounter = ownRecord(state.系统)?.UID计数器?.角色;
    if (!queue || !cooldown || !Number.isInteger(roleCounter) || roleCounter < 0 || roleCounter >= 999999) return fail('recommendation_refresh_state_invalid');
    const oldIndex = queue.indexOf(replacedNpcUid);
    if (oldIndex < 0) return fail('recommendation_refresh_source_not_queued');
    let normalizedCandidate;
    try { normalizedCandidate = normalizeGeneratedCandidate(candidate, { requirePersonalName: true }); } catch { return fail('recommendation_candidate_invalid'); }
    const uid = `npc_llm_${roleCounter + 1}`;
    if (!isNpcUid(uid) || candidateAt(state, uid) || roleAt(state, uid) || queue.includes(uid)) return fail('recommendation_uid_conflict');
    const operations = [];
    if (!cooldown.includes(replacedNpcUid)) operations.push({ op: 'add', path: encodeJsonPointer(['推荐', '冷却角色UID', '-']), value: replacedNpcUid });
    operations.push({ op: 'remove', path: encodeJsonPointer(['推荐', '当前队列', String(oldIndex)]) });
    operations.push({ op: 'add', path: encodeJsonPointer(['推荐', '临时候选池', uid]), value: normalizedCandidate });
    operations.push({ op: 'add', path: encodeJsonPointer(['推荐', '当前队列', '-']), value: uid });
    operations.push({ op: 'replace', path: encodeJsonPointer(['系统', 'UID计数器', '角色']), value: roleCounter + 1 });
    return success(operations);
}

/**
 * Seeds an empty recommendation queue with one fast-model generated adult
 * candidate. This is intentionally distinct from user-authored registration:
 * it allocates an npc_llm UID and refuses to overwrite an existing queue.
 */
export function buildRecommendationInitialCandidatePatch(state, { candidate } = {}) {
    if (!ownRecord(state)) return fail('recommendation_initial_invalid_state');
    const queue = arrayAt(state, '当前队列');
    const candidatePool = ownRecord(state.推荐)?.临时候选池;
    const rolePool = ownRecord(state.角色池);
    const roleCounter = ownRecord(state.系统)?.UID计数器?.角色;
    if (!queue || !candidatePool || !rolePool || !Number.isInteger(roleCounter) || roleCounter < 0 || roleCounter >= 999999) {
        return fail('recommendation_initial_state_invalid');
    }
    if (queue.length !== 0) return fail('recommendation_initial_queue_not_empty');

    let normalizedCandidate;
    try { normalizedCandidate = normalizeGeneratedCandidate(candidate, { requirePersonalName: true }); }
    catch { return fail('recommendation_candidate_invalid'); }

    const uid = `npc_llm_${roleCounter + 1}`;
    if (!isNpcUid(uid) || candidateAt(state, uid) || roleAt(state, uid)) {
        return fail('recommendation_uid_conflict');
    }
    return success([
        { op: 'add', path: encodeJsonPointer(['推荐', '临时候选池', uid]), value: normalizedCandidate },
        { op: 'add', path: encodeJsonPointer(['推荐', '当前队列', '-']), value: uid },
        { op: 'replace', path: encodeJsonPointer(['系统', 'UID计数器', '角色']), value: roleCounter + 1 },
    ]);
}

/**
 * Creates one user-authored or imported adult character as a recommendation
 * candidate. UID allocation is always local to the controlled MVU boundary;
 * callers cannot supply a path or UID.
 */
export function buildCharacterRegistrationPatch(state, { candidate } = {}) {
    if (!ownRecord(state)) return fail('character_registration_invalid_state');
    const queue = arrayAt(state, '当前队列');
    const candidatePool = ownRecord(state.推荐)?.临时候选池;
    const rolePool = ownRecord(state.角色池);
    const roleCounter = ownRecord(state.系统)?.UID计数器?.角色;
    if (!queue || !candidatePool || !rolePool || !Number.isInteger(roleCounter) || roleCounter < 0 || roleCounter >= 999999) {
        const reason = [
            !queue ? '/推荐/当前队列 缺失或非数组' : '',
            !candidatePool ? '/推荐/临时候选池 缺失或非对象' : '',
            !rolePool ? '/角色池 缺失或非对象' : '',
            !(Number.isInteger(roleCounter) && roleCounter >= 0 && roleCounter < 999999) ? '/系统/UID计数器/角色 越界或缺失' : '',
        ].filter(Boolean).join('；');
        return fail('character_registration_state_invalid', '', reason);
    }

    let normalizedCandidate;
    try { normalizedCandidate = normalizeGeneratedCandidate(candidate); }
    catch (error) { return fail('character_registration_candidate_invalid', '', candidateValidationReason(error)); }

    const uid = `npc_custom_${roleCounter + 1}`;
    if (!isNpcUid(uid) || candidateAt(state, uid) || roleAt(state, uid) || queue.includes(uid)) {
        return fail('character_registration_uid_conflict', '', '新分配的角色 UID 与现有候选、角色或队列冲突，请刷新后重试');
    }
    return success([
        { op: 'add', path: encodeJsonPointer(['推荐', '临时候选池', uid]), value: normalizedCandidate },
        { op: 'replace', path: encodeJsonPointer(['系统', 'UID计数器', '角色']), value: roleCounter + 1 },
    ]);
}

/** Shows an existing authored candidate only after local positive-keyword selection. */
export function buildExistingCandidateRecommendationPatch(state, { candidateUid, replacedNpcUid = '' } = {}) {
    if (!ownRecord(state) || !/^npc_custom_\d+$/u.test(candidateUid)) return fail('custom_recommendation_invalid_command');
    const candidate = assertKnownAdult(state, candidateUid);
    if (!candidate.ok || candidate.value.location !== 'candidate') return fail('custom_recommendation_candidate_invalid');
    const queue = arrayAt(state, '当前队列');
    const cooldown = arrayAt(state, '冷却角色UID');
    const disliked = arrayAt(state, '不喜欢角色UID');
    const blocked = arrayAt(state, '拉黑角色UID');
    if (!queue || !cooldown || !disliked || !blocked) return fail('custom_recommendation_state_invalid');
    if (queue.includes(candidateUid) || cooldown.includes(candidateUid) || disliked.includes(candidateUid) || blocked.includes(candidateUid)) {
        return fail('custom_recommendation_candidate_unavailable');
    }
    const operations = [];
    if (replacedNpcUid) {
        const current = assertKnownAdult(state, replacedNpcUid);
        const oldIndex = queue.indexOf(replacedNpcUid);
        if (!current.ok || current.value.location !== 'candidate' || oldIndex < 0) return fail('custom_recommendation_source_invalid');
        if (!cooldown.includes(replacedNpcUid)) operations.push({ op: 'add', path: encodeJsonPointer(['推荐', '冷却角色UID', '-']), value: replacedNpcUid });
        operations.push({ op: 'remove', path: encodeJsonPointer(['推荐', '当前队列', String(oldIndex)]) });
    } else if (queue.length !== 0) {
        return fail('custom_recommendation_queue_not_empty');
    }
    operations.push({ op: 'add', path: encodeJsonPointer(['推荐', '当前队列', '-']), value: candidateUid });
    return success(operations);
}
function isChatSessionUid(value) {
    return typeof value === 'string' && CHAT_SESSION_UID_PATTERN.test(value);
}

function appendEmptyStoryMemory(state, npcUid, operations) {
    const memories = ownRecord(state.正文记忆);
    if (!memories) return fail('mvu_story_memory_schema_outdated');
    if (Object.hasOwn(memories, npcUid)) return fail('story_memory_uid_conflict');
    operations.push({ op: 'add', path: encodeJsonPointer(['正文记忆', npcUid]), value: '' });
    return success(undefined);
}

function appendRelationshipNarrative(state, npcUid, profile, operations) {
    const narratives = ownRecord(state.关系叙事);
    if (!narratives) return fail('mvu_relationship_narrative_schema_outdated');
    if (Object.hasOwn(narratives, npcUid)) return fail('relationship_narrative_uid_conflict');
    const narrative = createRelationshipNarrativeFromProfile(profile);
    if (!narrative) return fail('relationship_narrative_profile_invalid');
    operations.push({ op: 'add', path: encodeJsonPointer(['关系叙事', npcUid]), value: narrative });
    return success(undefined);
}

function appendEmptyBodyRelationshipCandidate(state, npcUid, operations) {
    const candidates = ownRecord(state.正文关系候选);
    if (!candidates) return fail('mvu_body_relationship_candidate_schema_outdated');
    if (Object.hasOwn(candidates, npcUid)) return fail('body_relationship_candidate_uid_conflict');
    operations.push({ op: 'add', path: encodeJsonPointer(['正文关系候选', npcUid]), value: createEmptyBodyRelationshipCandidate() });
    return success(undefined);
}

/**
 * Reconciles pre-v1.0.8 saves without touching any retained memory text.
 * Missing role slots are created empty and orphan slots are removed; malformed
 * live values fail closed so a repair can never silently erase a real memory.
 */
export function buildStoryMemoryBackfillPatch(state) {
    if (!ownRecord(state)) return fail('story_memory_backfill_state_invalid');
    const roles = ownRecord(state.角色池);
    const memories = ownRecord(state.正文记忆);
    if (!roles || !memories) return fail('mvu_story_memory_schema_outdated');
    const operations = [];
    for (const uid of Object.keys(roles).sort()) {
        if (!isNpcUid(uid) || !ownRecord(roles[uid])) return fail('story_memory_backfill_role_invalid', uid);
        if (!Object.hasOwn(memories, uid)) {
            operations.push({ op: 'add', path: encodeJsonPointer(['正文记忆', uid]), value: '' });
            continue;
        }
        if (typeof memories[uid] !== 'string' || memories[uid].length > 1600) {
            return fail('story_memory_backfill_value_invalid', uid);
        }
    }
    for (const uid of Object.keys(memories).sort()) {
        if (!isNpcUid(uid) || typeof memories[uid] !== 'string' || memories[uid].length > 1600) {
            return fail('story_memory_backfill_value_invalid', uid);
        }
        if (!Object.hasOwn(roles, uid)) {
            operations.push({ op: 'remove', path: encodeJsonPointer(['正文记忆', uid]) });
        }
    }
    return success(operations);
}

/**
 * Adds only missing protected narrative slots for existing roles. Non-delete
 * lifecycle operations must never erase an unrecognized or orphan record, so
 * malformed and orphan state fails closed with no Patch.
 */
export function buildRelationshipNarrativeBackfillPatch(state) {
    if (!ownRecord(state)) return fail('relationship_narrative_backfill_state_invalid');
    const roles = ownRecord(state.角色池);
    const narratives = ownRecord(state.关系叙事);
    if (!roles || !narratives) return fail('mvu_relationship_narrative_schema_outdated');

    const operations = [];
    for (const uid of Object.keys(roles).sort()) {
        if (!isNpcUid(uid) || !ownRecord(roles[uid])) return fail('relationship_narrative_backfill_state_invalid');
        if (!Object.hasOwn(narratives, uid)) {
            const seeded = createRelationshipNarrativeFromProfile(roles[uid]);
            if (!seeded) return fail('relationship_narrative_backfill_profile_invalid', uid);
            operations.push({ op: 'add', path: encodeJsonPointer(['关系叙事', uid]), value: seeded });
            continue;
        }
        if (!validateRelationshipNarrative(narratives[uid]).ok) return fail('relationship_narrative_backfill_state_invalid');
        const seeded = createRelationshipNarrativeFromProfile(roles[uid], { progress: narratives[uid].进程 });
        if (!seeded) return fail('relationship_narrative_backfill_profile_invalid', uid);
        if (isRelationshipNarrativeContentEmpty(narratives[uid])) {
            operations.push({ op: 'replace', path: encodeJsonPointer(['关系叙事', uid]), value: seeded });
            continue;
        }
        if (!Object.hasOwn(narratives[uid].进程, 'SFW主动揭示已触发')) {
            operations.push({ op: 'add', path: encodeJsonPointer(['关系叙事', uid, '进程', 'SFW主动揭示已触发']), value: false });
        }
        if (!Object.hasOwn(narratives[uid].进程, '最近关系观察')) {
            operations.push({ op: 'add', path: encodeJsonPointer(['关系叙事', uid, '进程', '最近关系观察']), value: '' });
        }
    }
    for (const uid of Object.keys(narratives).sort()) {
        if (!isNpcUid(uid) || !validateRelationshipNarrative(narratives[uid]).ok) {
            return fail('relationship_narrative_backfill_state_invalid');
        }
        if (!Object.hasOwn(roles, uid)) return fail('relationship_narrative_backfill_orphan');
    }
    return success(operations);
}

/**
 * Adds only missing, per-formal-role empty body-candidate slots.  Unlike the
 * legacy free-text story-memory migration, a malformed or orphan candidate is
 * never deleted automatically: it may be a real pending body fact, so B.2
 * stops safely and leaves the state untouched for diagnosis/retry.
 */
export function buildBodyRelationshipCandidateBackfillPatch(state) {
    if (!ownRecord(state)) return fail('body_relationship_candidate_backfill_state_invalid');
    const roles = ownRecord(state.角色池);
    if (!roles) return fail('body_relationship_candidate_backfill_state_invalid');

    const candidateRootExists = Object.hasOwn(state, '正文关系候选');
    const candidates = candidateRootExists ? ownRecord(state.正文关系候选) : null;
    if (candidateRootExists && !candidates) return fail('mvu_body_relationship_candidate_schema_outdated');

    const emptyByUid = {};
    for (const uid of Object.keys(roles).sort()) {
        if (!isNpcUid(uid) || !ownRecord(roles[uid])) return fail('body_relationship_candidate_backfill_state_invalid');
        if (!candidates) {
            emptyByUid[uid] = createEmptyBodyRelationshipCandidate();
            continue;
        }
        if (!Object.hasOwn(candidates, uid)) {
            emptyByUid[uid] = createEmptyBodyRelationshipCandidate();
            continue;
        }
        if (!validateBodyRelationshipCandidate(candidates[uid]).ok) return fail('body_relationship_candidate_backfill_state_invalid');
    }
    if (candidates) {
        for (const uid of Object.keys(candidates).sort()) {
            if (!isNpcUid(uid) || !Object.hasOwn(roles, uid) || !validateBodyRelationshipCandidate(candidates[uid]).ok) {
                return fail('body_relationship_candidate_backfill_state_invalid');
            }
        }
    }
    if (!candidateRootExists) return success([{ op: 'add', path: '/正文关系候选', value: emptyByUid }]);
    return success(Object.entries(emptyByUid).map(([uid, value]) => ({
        op: 'add', path: encodeJsonPointer(['正文关系候选', uid]), value,
    })));
}

/** Adds the C.2 consent envelope to legacy sessions without inferring consent. */
export function buildPrivateChatNsfwConsentBackfillPatch(state) {
    if (!ownRecord(state)) return fail('private_chat_nsfw_consent_backfill_state_invalid');
    const sessions = ownRecord(state.会话);
    if (!sessions) return fail('private_chat_nsfw_consent_backfill_state_invalid');
    const operations = [];
    for (const [sessionUid, session] of Object.entries(sessions).sort(([left], [right]) => left.localeCompare(right))) {
        if (!isChatSessionUid(sessionUid) || !ownRecord(session) || !isNpcUid(session.对象UID)) {
            return fail('private_chat_nsfw_consent_backfill_state_invalid');
        }
        if (!Object.hasOwn(session, 'NSFW同意')) {
            operations.push({ op: 'add', path: encodeJsonPointer(['会话', sessionUid, 'NSFW同意']), value: createEmptyNsfwConsent() });
            continue;
        }
        if (!validateNsfwConsent(session.NSFW同意).ok) return fail('private_chat_nsfw_consent_schema_outdated');
    }
    return success(operations);
}

/** Adds the v1.0.18 realistic-chat envelope without enabling it or replaying history. */
export function buildRealisticPrivateChatBackfillPatch(state) {
    if (!ownRecord(state)) return fail('private_chat_realistic_backfill_state_invalid');
    const sessions = ownRecord(state.会话);
    if (!sessions) return fail('private_chat_realistic_backfill_state_invalid');
    const operations = [];
    for (const [sessionUid, session] of Object.entries(sessions).sort(([left], [right]) => left.localeCompare(right))) {
        if (!isChatSessionUid(sessionUid) || !ownRecord(session) || !isNpcUid(session.对象UID)) {
            return fail('private_chat_realistic_backfill_state_invalid');
        }
        if (!Object.hasOwn(session, '拟真聊天')) {
            operations.push({
                op: 'add',
                path: encodeJsonPointer(['会话', sessionUid, '拟真聊天']),
                value: createDefaultRealisticChatState({ latestPlayerMessageUid: latestPlayerMessageUid(session) }),
            });
            continue;
        }
        if (!validateRealisticChatState(session.拟真聊天).ok) return fail('private_chat_realistic_schema_outdated');
    }
    return success(operations);
}

function isMeetupUid(value) {
    return typeof value === 'string' && MEETUP_UID_PATTERN.test(value);
}

function isGroupUid(value) {
    return typeof value === 'string' && GROUP_UID_PATTERN.test(value);
}

function isServiceOrderUid(value) {
    return typeof value === 'string' && SERVICE_ORDER_UID_PATTERN.test(value);
}

function serviceCategoryForMode(mode, categoryId) {
    if (!['SFW', 'NSFW'].includes(mode) || typeof categoryId !== 'string') return '';
    return SERVICE_CATEGORY_BY_MODE[mode][categoryId] ?? '';
}

function serviceCategoryForNewOrder(mode, categoryId) {
    if (!['SFW', 'NSFW'].includes(mode) || typeof categoryId !== 'string') return '';
    return (mode === 'NSFW' ? SERVICE_PRODUCT_CATEGORY_LABELS_NSFW : SERVICE_PRODUCT_CATEGORY_LABELS_SFW)[categoryId] ?? '';
}

function serviceTopicForCandidate(candidate, category) {
    return serviceTopicForCandidates([candidate], category);
}

function serviceTopicForCandidates(candidates, category) {
    const names = (Array.isArray(candidates) ? candidates : []).map((candidate) => {
        const nickname = ownRecord(candidate?.公开资料)?.昵称;
        return typeof nickname === 'string' && nickname.trim() ? nickname.trim().slice(0, 80) : '该角色';
    }).filter(Boolean).slice(0, MAX_SERVICE_ORDER_PARTICIPANTS);
    return `${category}：与${names.join('、') || '该角色'}的文字协商`;
}

/**
 * 返回 { candidates } 或 { reason }。校验语义与历史版本完全一致；reason 仅用于
 * 控制台诊断（候选序号 + 字段路径 + 结论，绝不包含隐藏资料值或阈值数值）。
 */
function normalizeServiceCandidates({ candidate, candidates } = {}) {
    const source = Array.isArray(candidates) ? candidates : (candidate ? [candidate] : []);
    if (!source.length) return { reason: '未提供任何候选' };
    if (source.length > MAX_SERVICE_ORDER_PARTICIPANTS) return { reason: `候选数量超限（${source.length} > ${MAX_SERVICE_ORDER_PARTICIPANTS}）` };
    const normalized = []; const names = new Set();
    for (let index = 0; index < source.length; index += 1) {
        let value;
        // 与本地生成闸门（generateServiceProfileCandidate）及白名单第二道防线（/角色池/npc_service_*）
        // 保持同一套校验：完整成年与结构校验必须通过，但不附加推荐流的“真人姓名”风格闸门，
        // 否则已通过生成校验的合法成年本地角色会在下单时被误判为 service_order_candidate_invalid。
        try { value = normalizeGeneratedCandidate(source[index], { contentMode: undefined }); }
        catch (error) { return { reason: candidateValidationReason(error, `候选[${index + 1}] `) }; }
        const name = ownRecord(value.公开资料)?.昵称?.trim().toLocaleLowerCase('zh-CN');
        if (!name) return { reason: `候选[${index + 1}] 公开资料.昵称：为空` };
        if (names.has(name)) return { reason: `候选[${index + 1}] 公开资料.昵称：与前面的候选重复` };
        names.add(name); normalized.push(value);
    }
    return { candidates: normalized };
}

function isBoundedText(value, maximum, { required = false } = {}) {
    return typeof value === 'string' && value.length <= maximum && (!required || value.trim().length > 0);
}
const SERVICE_BOUNDARY_TEXT_FIELDS = Object.freeze(['主题', '允许项', '排除项', '强度', '隐私处理']);
const SERVICE_INFORMATION_FIELDS = Object.freeze(['价格', '时长', '排期', '套餐', '评价', '投诉', '退款', '服务者信用']);
const SERVICE_BOUNDARIES_MAX_LENGTH = 2600;

function normalizeServiceBoundaries(value, { mode, participantCount } = {}) {
    if (!ownRecord(value) || !['SFW', 'NSFW'].includes(mode) || !Number.isInteger(participantCount) || participantCount < 1 || participantCount > MAX_SERVICE_ORDER_PARTICIPANTS) return null;
    const fields = ['内容模式', ...SERVICE_BOUNDARY_TEXT_FIELDS, '服务信息', '玩家已同意', 'NPC明确同意'];
    if (Object.keys(value).some((key) => !fields.includes(key)) || value.内容模式 !== mode || value.玩家已同意 !== true
        || !Array.isArray(value.NPC明确同意) || value.NPC明确同意.length !== participantCount || !value.NPC明确同意.every((item) => item === true)) return null;
    const result = { 内容模式: mode, 玩家已同意: true, NPC明确同意: Object.freeze([...value.NPC明确同意]) };
    for (const field of SERVICE_BOUNDARY_TEXT_FIELDS) {
        const text = value[field];
        if (typeof text !== 'string' || text.trim().length === 0 || text.length > 240) return null;
        result[field] = text.trim();
    }
    const sourceInfo = value.服务信息 === undefined ? {} : value.服务信息;
    if (!ownRecord(sourceInfo) || Object.keys(sourceInfo).some((key) => !SERVICE_INFORMATION_FIELDS.includes(key))) return null;
    const serviceInfo = {};
    for (const field of SERVICE_INFORMATION_FIELDS) {
        const text = sourceInfo[field] ?? '';
        if (typeof text !== 'string' || text.trim().length > 120) return null;
        serviceInfo[field] = text.trim();
    }
    result.服务信息 = Object.freeze(serviceInfo);
    return Object.freeze(result);
}

function serializeServiceBoundaries(value, options) {
    const normalized = normalizeServiceBoundaries(value, options);
    if (!normalized) return null;
    const serialized = JSON.stringify(normalized);
    return serialized.length <= SERVICE_BOUNDARIES_MAX_LENGTH ? serialized : null;
}

/**
 * 仅供控制台诊断：复述 normalizeServiceBoundaries 拒绝的第一处原因（字段名 + 结论，
 * 允许出现长度上限等结构性数字，绝不回显隐藏资料值、关系分或阈值数值）。
 * 本函数不参与任何校验裁决；裁决仍由 normalizeServiceBoundaries 独立完成。
 */
function serviceBoundariesReason(value, { mode, participantCount } = {}) {
    if (!ownRecord(value)) return '结构化边界必须是普通对象';
    if (!['SFW', 'NSFW'].includes(mode)) return '当前内容模式无效';
    if (!Number.isInteger(participantCount) || participantCount < 1 || participantCount > MAX_SERVICE_ORDER_PARTICIPANTS) return '订单参与者数量无效';
    const fields = ['内容模式', ...SERVICE_BOUNDARY_TEXT_FIELDS, '服务信息', '玩家已同意', 'NPC明确同意'];
    const unknown = Object.keys(value).find((key) => !fields.includes(key));
    if (unknown !== undefined) return `包含未允许的字段：${String(unknown).slice(0, 32)}`;
    if (value.内容模式 !== mode) return '字段 内容模式：与当前内容模式不一致';
    if (value.玩家已同意 !== true) return '字段 玩家已同意：玩家尚未确认';
    if (!Array.isArray(value.NPC明确同意) || value.NPC明确同意.length !== participantCount) return `字段 NPC明确同意：应为 ${participantCount} 项逐人确认`;
    if (!value.NPC明确同意.every((item) => item === true)) return '字段 NPC明确同意：尚有参与者未逐人确认';
    for (const field of SERVICE_BOUNDARY_TEXT_FIELDS) {
        const text = value[field];
        if (typeof text !== 'string' || text.trim().length === 0) return `字段 ${field}：不能为空`;
        if (text.length > 240) return `字段 ${field}：长度超限（${text.length} > 240）`;
    }
    const sourceInfo = value.服务信息 === undefined ? {} : value.服务信息;
    if (!ownRecord(sourceInfo)) return '字段 服务信息：必须是普通对象';
    const unknownInfo = Object.keys(sourceInfo).find((key) => !SERVICE_INFORMATION_FIELDS.includes(key));
    if (unknownInfo !== undefined) return `字段 服务信息.${String(unknownInfo).slice(0, 32)}：不在允许清单`;
    for (const field of SERVICE_INFORMATION_FIELDS) {
        const text = sourceInfo[field] ?? '';
        if (typeof text !== 'string') return `字段 服务信息.${field}：必须是文本`;
        if (text.trim().length > 120) return `字段 服务信息.${field}：长度超限（${text.trim().length} > 120）`;
    }
    return '序列化后的边界合同总长度超限';
}

function hasSerializedServiceBoundaries(value, options) {
    if (!isBoundedText(value, SERVICE_BOUNDARIES_MAX_LENGTH, { required: true })) return false;
    try { return normalizeServiceBoundaries(JSON.parse(value), options) !== null; } catch { return false; }
}

function isOpenServiceOrder(order) {
    return ownRecord(order) && ['待确认', '进行中'].includes(order.状态);
}

function hasAnyOpenServiceOrder(orders, exceptUid = '') {
    return Object.entries(orders).some(([uid, order]) => uid !== exceptUid && isOpenServiceOrder(order));
}
function isValidServiceCompletionSignal(value, { required = false } = {}) {
    if (value === undefined) return !required;
    if (!ownRecord(value) || Object.keys(value).some((key) => !['已满足', '摘要', '记录时间'].includes(key))
        || typeof value.已满足 !== 'boolean' || !isBoundedText(value.摘要, 600) || !isBoundedText(value.记录时间, 160)) return false;
    return value.已满足
        ? isBoundedText(value.摘要, 600, { required: true }) && isBoundedText(value.记录时间, 160, { required: true })
        : value.摘要 === '' && value.记录时间 === '';
}

function isEmptyServiceCompletionSignal(value) {
    return isValidServiceCompletionSignal(value, { required: true })
        && value.已满足 === EMPTY_SERVICE_COMPLETION_SIGNAL.已满足
        && value.摘要 === EMPTY_SERVICE_COMPLETION_SIGNAL.摘要
        && value.记录时间 === EMPTY_SERVICE_COMPLETION_SIGNAL.记录时间;
}

function isCompleteTerminalServiceOrder(source, { mode, categoryId, category, npcUid, profiles }) {
    if (!ownRecord(source) || !['已完成', '已取消'].includes(source.状态)
        || source.角色UID !== npcUid || source.内容模式 !== mode || source.服务分类 !== categoryId
        || source.服务主题 !== serviceTopicForCandidates(profiles, category)
        || !isBoundedText(source.发起时间, 160, { required: true })
        || !isBoundedText(source.结束时间, 160, { required: true })
        || !isBoundedText(source.结束摘要, 600, { required: true })
        || !isBoundedText(source.开始时间, 160)
        || !isBoundedText(source.已确认边界, SERVICE_BOUNDARIES_MAX_LENGTH)
        || !isValidServiceCompletionSignal(source.合法结束条件)) return false;
    return source.状态 !== '已完成'
        || (isBoundedText(source.开始时间, 160, { required: true })
            && isBoundedText(source.已确认边界, SERVICE_BOUNDARIES_MAX_LENGTH, { required: true }));
}

function hasActiveServiceOrderForRole(orders, { sourceOrderUid, npcUid, mode }) {
    return Object.entries(orders).some(([orderUid, order]) => orderUid !== sourceOrderUid
        && ownRecord(order) && (order.角色UID === npcUid || (Array.isArray(order.角色UID列表) && order.角色UID列表.includes(npcUid))) && order.内容模式 === mode
        && ['待确认', '进行中'].includes(order.状态));
}

function clamp(value, lower, upper) {
    return Math.min(Math.max(value, lower), upper);
}

function chatMessage(sender, uid, content, time = '') {
    return Object.freeze({ 消息UID: uid, 发送者: sender, 内容: content, 时间: time, 层数: 0 });
}

function nextChatMessageNumber(sessionUid, recentMessages, pendingMessages = []) {
    const pattern = new RegExp('^msg_' + sessionUid + '_[pns]_(\\d+)$');
    let maximum = 0;
    for (const message of [...recentMessages, ...pendingMessages]) {
        const match = pattern.exec(ownRecord(message) ? message.消息UID : '');
        if (match) maximum = Math.max(maximum, Number(match[1]));
    }
    return Math.max(maximum + 1, recentMessages.length + 1);
}

function normalizeRelationshipDedupeText(value) {
    return typeof value === 'string'
        ? value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN')
        : '';
}

function repeatsRecentPlayerMessage(recentMessages, playerMessage) {
    const normalized = normalizeRelationshipDedupeText(playerMessage);
    if (!normalized || !Array.isArray(recentMessages)) return false;
    let inspected = 0;
    for (let index = recentMessages.length - 1; index >= 0 && inspected < 6; index -= 1) {
        const message = ownRecord(recentMessages[index]);
        if (!message || message.发送者 !== '玩家') continue;
        inspected += 1;
        if (normalizeRelationshipDedupeText(message.内容) === normalized) return true;
    }
    return false;
}
/**
 * Commits one player message and then applies the role's hidden interaction
 * rhythm locally. A normal outcome appends 1..6 validated role bubbles; a
 * threshold outcome appends only a fixed system notice. Thresholds, states,
 * UIDs and paths never come from the model or UI.
 */
/**
 * Copies one device-local, adult-validated service profile into MVU and opens a
 * pending service order in the same atomic transition. The UI supplies only a
 * fixed category id; paths, UIDs, order state and displayed topic are derived
 * here, never from model text or a caller-provided patch.
 */
export function buildServiceOrderHandoffPatch(state, { candidate, candidates, categoryId } = {}) {
    if (!ownRecord(state)) return fail('service_order_invalid_state');
    const system = ownRecord(state.系统); const counters = ownRecord(system?.UID计数器);
    const rolePool = ownRecord(state.角色池); const orders = ownRecord(state.服务订单);
    const mode = ownRecord(state.软件)?.内容模式; const roleCounter = counters?.角色; const orderCounter = counters?.服务订单;
    const category = serviceCategoryForNewOrder(mode, categoryId);
    if (!rolePool || !orders || !category || !Number.isInteger(roleCounter) || roleCounter < 0 || roleCounter >= 999999
        || !Number.isInteger(orderCounter) || orderCounter < 0 || orderCounter >= 999999) {
        const missing = [
            !rolePool ? '/角色池 缺失或非对象' : '',
            !orders ? '/服务订单 缺失或非对象' : '',
            !category ? `服务分类无效或与当前内容模式不符：${typeof categoryId === 'string' ? categoryId.slice(0, 64) : String(categoryId)}` : '',
            !(Number.isInteger(roleCounter) && roleCounter >= 0 && roleCounter < 999999) ? '/系统/UID计数器/角色 越界或缺失' : '',
            !(Number.isInteger(orderCounter) && orderCounter >= 0 && orderCounter < 999999) ? '/系统/UID计数器/服务订单 越界或缺失' : '',
        ].filter(Boolean).join('；');
        return fail('service_order_state_invalid', '', missing);
    }
    if (hasAnyOpenServiceOrder(orders)) return fail('service_order_conflict', '', '已存在一笔待确认或进行中的服务订单');
    const normalizedResult = normalizeServiceCandidates({ candidate, candidates });
    const normalizedCandidates = normalizedResult.candidates ?? null;
    if (!normalizedCandidates) return fail('service_order_candidate_invalid', '', normalizedResult.reason);
    if (roleCounter + normalizedCandidates.length > 999999) return fail('service_order_candidate_invalid', '', '/系统/UID计数器/角色 已接近上限，无法为全部候选分配 UID');
    const npcUids = normalizedCandidates.map((_, index) => `npc_service_${roleCounter + index + 1}`);
    const orderUid = `service_${orderCounter + 1}`; const candidatePool = ownRecord(ownRecord(state.推荐)?.临时候选池);
    if (!isServiceOrderUid(orderUid) || Object.hasOwn(orders, orderUid) || npcUids.some((uid) => !isNpcUid(uid) || Object.hasOwn(rolePool, uid) || (candidatePool && Object.hasOwn(candidatePool, uid)))) return fail('service_order_uid_conflict', '', '新分配的订单或角色 UID 与现有状态冲突，请刷新后重试');
    const order = Object.freeze({
        角色UID: npcUids[0], 角色UID列表: npcUids, 内容模式: mode, 服务分类: categoryId,
        服务主题: serviceTopicForCandidates(normalizedCandidates, category), 状态: '待确认',
        发起时间: '待正文确认', 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '',
        合法结束条件: EMPTY_SERVICE_COMPLETION_SIGNAL,
    });
    const patch = [];
    for (let index = 0; index < normalizedCandidates.length; index += 1) {
        patch.push({ op: 'add', path: encodeJsonPointer(['角色池', npcUids[index]]), value: normalizedCandidates[index] });
        const memory = appendEmptyStoryMemory(state, npcUids[index], patch);
        if (!memory.ok) return memory;
        const narrative = appendRelationshipNarrative(state, npcUids[index], normalizedCandidates[index], patch);
        if (!narrative.ok) return narrative;
        const bodyCandidate = appendEmptyBodyRelationshipCandidate(state, npcUids[index], patch);
        if (!bodyCandidate.ok) return bodyCandidate;
    }
    patch.push(
        { op: 'add', path: encodeJsonPointer(['服务订单', orderUid]), value: order },
        { op: 'replace', path: encodeJsonPointer(['系统', 'UID计数器', '角色']), value: roleCounter + normalizedCandidates.length },
        { op: 'replace', path: encodeJsonPointer(['系统', 'UID计数器', '服务订单']), value: orderCounter + 1 },
    );
    return success({ npcUid: npcUids[0], npcUids: Object.freeze(npcUids), orderUid, patch });
}

/**
 * Creates a fresh pending order for a terminal service record without copying
 * the role again. The source order is the authority for both the role and
 * category, so the UI cannot turn a history card into an arbitrary order.
 */
export function buildServiceOrderRepeatPatch(state, { sourceOrderUid } = {}) {
    if (!ownRecord(state) || !isServiceOrderUid(sourceOrderUid)) return fail('service_order_repeat_invalid', '', '状态或来源订单标识无效');
    const system = ownRecord(state.系统); const counters = ownRecord(system?.UID计数器);
    const orders = ownRecord(state.服务订单); const rolePool = ownRecord(state.角色池);
    const mode = ownRecord(state.软件)?.内容模式; const orderCounter = counters?.服务订单;
    const source = orders?.[sourceOrderUid];
    if (!orders || !rolePool || !ownRecord(source) || !['已完成', '已取消'].includes(source.状态)
        || !Number.isInteger(orderCounter) || orderCounter < 0 || orderCounter >= 999999) {
        const reason = !orders || !rolePool ? '/服务订单 或 /角色池 缺失'
            : !ownRecord(source) ? '来源订单不存在或结构损坏'
                : !['已完成', '已取消'].includes(source.状态) ? `只能从终态订单再次下单，实际状态为 ${typeof source.状态 === 'string' ? source.状态.slice(0, 16) : '非文本'}`
                    : '/系统/UID计数器/服务订单 越界或缺失';
        return fail('service_order_repeat_state_invalid', '', reason);
    }
    const categoryId = source.服务分类; const category = serviceCategoryForNewOrder(mode, categoryId);
    const participants = Array.isArray(source.角色UID列表) && source.角色UID列表.length ? source.角色UID列表 : [source.角色UID];
    if (!category || source.内容模式 !== mode || !participants.length || participants.length > MAX_SERVICE_ORDER_PARTICIPANTS || participants[0] !== source.角色UID || new Set(participants).size !== participants.length || !participants.every(isNpcUid)) {
        const reason = !category ? '来源订单的服务分类无效或不适用于新订单'
            : source.内容模式 !== mode ? '来源订单内容模式与当前模式不一致'
                : '来源订单参与者列表无效';
        return fail('service_order_repeat_not_available', '', reason);
    }
    const adults = participants.map((npcUid) => assertKnownAdult(state, npcUid));
    const invalidAdultIndex = adults.findIndex((adult) => !adult.ok || adult.value.location !== 'role');
    if (invalidAdultIndex >= 0) {
        const adult = adults[invalidAdultIndex];
        const reason = `参与者[${invalidAdultIndex + 1}]：${!adult.ok ? (adult.reason || '角色不可用或未通过成年人校验') : '角色仍在临时候选池，未正式入池'}`;
        return fail('service_order_repeat_not_available', '', reason);
    }
    const profiles = adults.map((adult) => adult.value.profile);
    if (!isCompleteTerminalServiceOrder(source, { mode, categoryId, category, npcUid: participants[0], profiles })
        || source.服务主题 !== serviceTopicForCandidates(profiles, category)) return fail('service_order_repeat_state_invalid', '', '来源终态订单字段不完整或服务主题与参与者不再一致');
    if (hasAnyOpenServiceOrder(orders, sourceOrderUid) || participants.some((npcUid) => hasActiveServiceOrderForRole(orders, { sourceOrderUid, npcUid, mode }))) return fail('service_order_conflict', '', '已存在待确认或进行中的服务订单，或参与者已在其他开放订单中');
    const orderUid = `service_${orderCounter + 1}`;
    if (!isServiceOrderUid(orderUid) || Object.hasOwn(orders, orderUid)) return fail('service_order_uid_conflict', '', '新分配的订单 UID 与现有订单冲突，请刷新后重试');
    const order = Object.freeze({
        角色UID: participants[0], 角色UID列表: Object.freeze([...participants]), 内容模式: mode, 服务分类: categoryId,
        服务主题: serviceTopicForCandidates(profiles, category), 状态: '待确认',
        发起时间: '待正文确认', 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '',
        合法结束条件: EMPTY_SERVICE_COMPLETION_SIGNAL,
    });
    return success({ npcUid: participants[0], npcUids: Object.freeze([...participants]), orderUid, patch: [
        { op: 'add', path: encodeJsonPointer(['服务订单', orderUid]), value: order },
        { op: 'replace', path: encodeJsonPointer(['系统', 'UID计数器', '服务订单']), value: orderCounter + 1 },
    ] });
}

/** Creates a fresh pending order from a browser-local minimal history record without restoring the old contract. */
export function buildServiceOrderRebookPatch(state, { npcUid, npcUids, categoryId } = {}) {
    if (!ownRecord(state)) return fail('service_order_rebook_invalid', '', '当前状态不可用');
    const rolePool = ownRecord(state.角色池); const orders = ownRecord(state.服务订单);
    const mode = ownRecord(state.软件)?.内容模式; const counters = ownRecord(ownRecord(state.系统)?.UID计数器);
    const orderCounter = counters?.服务订单; const category = serviceCategoryForNewOrder(mode, categoryId);
    const participants = Array.isArray(npcUids) ? npcUids : (npcUid ? [npcUid] : []);
    if (!rolePool || !orders || !category || !Number.isInteger(orderCounter) || orderCounter < 0 || orderCounter >= 999999 || !participants.length || participants.length > MAX_SERVICE_ORDER_PARTICIPANTS || new Set(participants).size !== participants.length || !participants.every(isNpcUid)) {
        const reason = !rolePool || !orders ? '/角色池 或 /服务订单 缺失'
            : !category ? `历史服务分类无效或与当前内容模式不符：${typeof categoryId === 'string' ? categoryId.slice(0, 64) : String(categoryId)}`
                : !(Number.isInteger(orderCounter) && orderCounter >= 0 && orderCounter < 999999) ? '/系统/UID计数器/服务订单 越界或缺失'
                    : '历史记录的参与者 UID 列表无效（为空、重复、超员或格式错误）';
        return fail('service_order_rebook_invalid', '', reason);
    }
    const adults = participants.map((uid) => assertKnownAdult(state, uid));
    const invalidAdultIndex = adults.findIndex((adult) => !adult.ok || adult.value.location !== 'role');
    if (invalidAdultIndex >= 0) {
        const adult = adults[invalidAdultIndex];
        const reason = `参与者[${invalidAdultIndex + 1}]：${!adult.ok ? (adult.reason || '角色不可用或未通过成年人校验') : '角色仍在临时候选池，未正式入池'}`;
        return fail('service_order_rebook_invalid', '', reason);
    }
    if (hasAnyOpenServiceOrder(orders) || participants.some((uid) => hasActiveServiceOrderForRole(orders, { sourceOrderUid: '', npcUid: uid, mode }))) return fail('service_order_conflict', '', '已存在待确认或进行中的服务订单，或参与者已在其他开放订单中');
    const orderUid = `service_${orderCounter + 1}`;
    if (!isServiceOrderUid(orderUid) || Object.hasOwn(orders, orderUid)) return fail('service_order_uid_conflict', '', '新分配的订单 UID 与现有订单冲突，请刷新后重试');
    const profiles = adults.map((adult) => adult.value.profile); const order = Object.freeze({ 角色UID: participants[0], 角色UID列表: participants, 内容模式: mode, 服务分类: categoryId, 服务主题: serviceTopicForCandidates(profiles, category), 状态: '待确认', 发起时间: '待正文确认', 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '', 合法结束条件: EMPTY_SERVICE_COMPLETION_SIGNAL });
    return success({ npcUid: participants[0], npcUids: Object.freeze([...participants]), orderUid, patch: [
        { op: 'add', path: encodeJsonPointer(['服务订单', orderUid]), value: order },
        { op: 'replace', path: encodeJsonPointer(['系统', 'UID计数器', '服务订单']), value: orderCounter + 1 },
    ] });
}

/** Player confirms a pending service contract through the controlled MVU boundary. */
/** Deletes all browser-history-linked service roles in one guarded transition. */
export function buildServiceHistoryRolesDeletionPatch(state, { npcUids } = {}) {
    if (!ownRecord(state) || !Array.isArray(npcUids) || !npcUids.length || npcUids.length > MAX_SERVICE_ORDER_PARTICIPANTS
        || new Set(npcUids).size !== npcUids.length || !npcUids.every((uid) => /^npc_service_\d+$/u.test(uid))) return fail('service_history_delete_invalid', '', '历史记录的服务角色 UID 列表无效（为空、重复、超员或格式错误）');
    const orders = ownRecord(state.服务订单); const rolePool = ownRecord(state.角色池);
    if (!orders || !rolePool || !npcUids.every((uid) => Object.hasOwn(rolePool, uid))) return fail('service_history_delete_invalid', '', !orders || !rolePool ? '/服务订单 或 /角色池 缺失' : '部分服务角色已不在 /角色池 中');
    if (npcUids.some((uid) => Object.values(orders).some((order) => isOpenServiceOrder(order) && (order.角色UID === uid || (Array.isArray(order.角色UID列表) && order.角色UID列表.includes(uid)))))) return fail('service_history_delete_open_order', '', '仍有服务角色被待确认或进行中的订单引用');
    const operations = [];
    for (const npcUid of npcUids) {
        const built = buildDeleteCharacterPatch(state, { npcUid });
        if (!built.ok || built.value.length !== 4
            || built.value[0]?.op !== 'remove' || built.value[0]?.path !== encodeJsonPointer(['正文记忆', npcUid])
            || built.value[1]?.op !== 'remove' || built.value[1]?.path !== encodeJsonPointer(['正文关系候选', npcUid])
            || built.value[2]?.op !== 'remove' || built.value[2]?.path !== encodeJsonPointer(['关系叙事', npcUid])
            || built.value[3]?.op !== 'remove' || built.value[3]?.path !== encodeJsonPointer(['角色池', npcUid])) {
            return fail('service_history_delete_not_isolated', '', '服务角色仍被会话、面基或推荐列表引用，无法作为孤立角色删除');
        }
        operations.push(...built.value);
    }
    return success(operations);
}

function isStrictServiceOrderForProjection(state, orderUid, raw) {
    if (!isServiceOrderUid(orderUid) || !ownRecord(raw) || !['待确认', '进行中', '已完成', '已取消'].includes(raw.状态)
        || !['SFW', 'NSFW'].includes(raw.内容模式) || !isNpcUid(raw.角色UID)) return false;
    const participants = Array.isArray(raw.角色UID列表) && raw.角色UID列表.length ? raw.角色UID列表 : [raw.角色UID];
    if (participants.length > MAX_SERVICE_ORDER_PARTICIPANTS || participants[0] !== raw.角色UID || new Set(participants).size !== participants.length || !participants.every(isNpcUid)) return false;
    const category = serviceCategoryForMode(raw.内容模式, raw.服务分类);
    if (!category || !isBoundedText(raw.服务主题, 240, { required: true }) || !isBoundedText(raw.发起时间, 160, { required: true })
        || !isBoundedText(raw.开始时间, 160) || !isBoundedText(raw.结束时间, 160) || !isBoundedText(raw.结束摘要, 600) || !isBoundedText(raw.已确认边界, SERVICE_BOUNDARIES_MAX_LENGTH)
        || !isValidServiceCompletionSignal(raw.合法结束条件)) return false;
    const adults = participants.map((uid) => assertKnownAdult(state, uid));
    if (adults.some((adult) => !adult.ok || adult.value.location !== 'role')) return false;
    if (raw.服务主题 !== serviceTopicForCandidates(adults.map((adult) => adult.value.profile), category)) return false;
    if (raw.状态 === '待确认') return raw.开始时间 === '' && raw.结束时间 === '' && raw.结束摘要 === '' && raw.已确认边界 === '';
    if (raw.状态 === '进行中') return isBoundedText(raw.开始时间, 160, { required: true })
        && hasSerializedServiceBoundaries(raw.已确认边界, { mode: raw.内容模式, participantCount: participants.length })
        && raw.结束时间 === '' && raw.结束摘要 === '';
    return isBoundedText(raw.结束时间, 160, { required: true }) && isBoundedText(raw.结束摘要, 600, { required: true });
}

/** Removes only a malformed service-order record; valid orders can never be repaired away. */
export function buildServiceOrderRepairPatch(state, { orderUid } = {}) {
    if (!ownRecord(state) || !isServiceOrderUid(orderUid)) return fail('service_order_repair_invalid', '', '状态或订单标识无效');
    const orders = ownRecord(state.服务订单); const raw = orders?.[orderUid];
    if (!orders || !ownRecord(raw)) return fail('service_order_repair_invalid', '', '该服务订单不存在或不是对象');
    if (isStrictServiceOrderForProjection(state, orderUid, raw)) return fail('service_order_repair_not_needed', '', '该订单结构完好，拒绝以“修复”名义删除有效订单');
    return success([{ op: 'remove', path: encodeJsonPointer(['服务订单', orderUid]) }]);
}

export function buildServiceOrderStartPatch(state, { orderUid, boundaries } = {}) {
    if (!ownRecord(state) || !isServiceOrderUid(orderUid)) return fail('service_order_start_invalid', '', '状态或订单标识无效');
    const orders = ownRecord(state.服务订单);
    const mode = ownRecord(state.软件)?.内容模式;
    const order = orders?.[orderUid];
    const participants = Array.isArray(order?.角色UID列表) && order.角色UID列表.length ? order.角色UID列表 : [order?.角色UID];
    const serializedBoundaries = serializeServiceBoundaries(boundaries, { mode, participantCount: participants.length });
    if (!orders || !ownRecord(order) || order.状态 !== '待确认' || order.内容模式 !== mode || !participants.length || participants.length > MAX_SERVICE_ORDER_PARTICIPANTS || !serializedBoundaries) {
        // 与上一行同一套裁决，仅补充控制台可读的第一处原因；不改变任何校验语义。
        const reason = !orders || !ownRecord(order) ? '该服务订单不存在或结构损坏'
            : order.状态 !== '待确认' ? `订单状态应为 待确认，实际为 ${typeof order.状态 === 'string' ? order.状态.slice(0, 16) : '非文本'}`
                : order.内容模式 !== mode ? '订单内容模式与当前模式不一致'
                    : !participants.length || participants.length > MAX_SERVICE_ORDER_PARTICIPANTS ? '订单参与者列表无效'
                        : `结构化边界校验未通过：${serviceBoundariesReason(boundaries, { mode, participantCount: participants.length })}`;
        return fail('service_order_start_invalid', '', reason);
    }
    if (hasAnyOpenServiceOrder(orders, orderUid)) return fail('service_order_conflict', '', '已存在另一笔待确认或进行中的服务订单');
    return success([
        { op: 'replace', path: encodeJsonPointer(['服务订单', orderUid, '状态']), value: '进行中' },
        { op: 'replace', path: encodeJsonPointer(['服务订单', orderUid, '开始时间']), value: '玩家已确认接单' },
        { op: 'replace', path: encodeJsonPointer(['服务订单', orderUid, '已确认边界']), value: serializedBoundaries },
    ]);
}

/** Cancels a pending service order. The UI may only cancel before the order starts. */
export function buildServiceOrderCancelPatch(state, { orderUid } = {}) {
    if (!ownRecord(state) || !isServiceOrderUid(orderUid)) return fail('service_order_cancel_invalid', '', '状态或订单标识无效');
    const orders = ownRecord(state.服务订单);
    const mode = ownRecord(state.软件)?.内容模式;
    const order = orders?.[orderUid];
    if (!orders || !ownRecord(order) || order.状态 !== '待确认' || order.内容模式 !== mode) {
        const reason = !orders || !ownRecord(order) ? '该服务订单不存在或结构损坏'
            : order.状态 !== '待确认' ? `只能取消 待确认 订单，实际状态为 ${typeof order.状态 === 'string' ? order.状态.slice(0, 16) : '非文本'}`
                : '订单内容模式与当前模式不一致';
        return fail('service_order_cancel_invalid', '', reason);
    }
    return success([
        { op: 'replace', path: encodeJsonPointer(['服务订单', orderUid, '状态']), value: '已取消' },
        { op: 'replace', path: encodeJsonPointer(['服务订单', orderUid, '结束时间']), value: '玩家已取消' },
        { op: 'replace', path: encodeJsonPointer(['服务订单', orderUid, '结束摘要']), value: '玩家在正文开始前取消了本次服务。' },
    ]);
}

/** Completes an in-progress order after the player confirms the body has reached its ending condition. */
export function buildServiceOrderCompletePatch(state, { orderUid } = {}) {
    if (!ownRecord(state) || !isServiceOrderUid(orderUid)) return fail('service_order_complete_invalid', '', '状态或订单标识无效');
    const orders = ownRecord(state.服务订单);
    const mode = ownRecord(state.软件)?.内容模式;
    const order = orders?.[orderUid];
    if (!orders || !ownRecord(order) || order.状态 !== '进行中' || order.内容模式 !== mode
        || !isBoundedText(order.开始时间, 160, { required: true })
        || !hasSerializedServiceBoundaries(order.已确认边界, { mode, participantCount: (Array.isArray(order.角色UID列表) && order.角色UID列表.length ? order.角色UID列表 : [order.角色UID]).length })
        || !isValidServiceCompletionSignal(order.合法结束条件, { required: true }) || order.合法结束条件.已满足 !== true) {
        const reason = !orders || !ownRecord(order) ? '该服务订单不存在或结构损坏'
            : order.状态 !== '进行中' ? `只能完成 进行中 订单，实际状态为 ${typeof order.状态 === 'string' ? order.状态.slice(0, 16) : '非文本'}`
                : order.内容模式 !== mode ? '订单内容模式与当前模式不一致'
                    : !isBoundedText(order.开始时间, 160, { required: true }) ? '字段 开始时间：缺失或超长'
                        : !hasSerializedServiceBoundaries(order.已确认边界, { mode, participantCount: (Array.isArray(order.角色UID列表) && order.角色UID列表.length ? order.角色UID列表 : [order.角色UID]).length }) ? '字段 已确认边界：不是有效的结构化边界合同'
                            : '字段 合法结束条件：正文尚未写入完整的结束信号（已满足 / 摘要 / 记录时间）';
        return fail('service_order_complete_invalid', '', reason);
    }
    return success([
        { op: 'replace', path: encodeJsonPointer(['服务订单', orderUid, '状态']), value: '已完成' },
        { op: 'replace', path: encodeJsonPointer(['服务订单', orderUid, '结束时间']), value: '玩家已确认正文结束' },
        { op: 'replace', path: encodeJsonPointer(['服务订单', orderUid, '结束摘要']), value: '正文已由玩家确认结束；本地历史未保留详细过程。' },
    ]);
}

/** Removes an already terminal order after a local minimal archive was committed. */
export function buildServiceOrderFinalizePatch(state, { orderUid } = {}) {
    if (!ownRecord(state) || !isServiceOrderUid(orderUid)) return fail('service_order_finalize_invalid', '', '状态或订单标识无效');
    const orders = ownRecord(state.服务订单);
    const order = orders?.[orderUid];
    if (!orders || !ownRecord(order) || !['已完成', '已取消'].includes(order.状态)) {
        const reason = !orders || !ownRecord(order) ? '该服务订单不存在或结构损坏'
            : `只能归档终态订单，实际状态为 ${typeof order.状态 === 'string' ? order.状态.slice(0, 16) : '非文本'}`;
        return fail('service_order_finalize_invalid', '', reason);
    }
    if (!isBoundedText(order.结束时间, 160, { required: true }) || !isBoundedText(order.结束摘要, 600, { required: true })) {
        const reason = !isBoundedText(order.结束时间, 160, { required: true }) ? '字段 结束时间：缺失或超长' : '字段 结束摘要：缺失或超长';
        return fail('service_order_finalize_invalid', '', reason);
    }
    return success([{ op: 'remove', path: encodeJsonPointer(['服务订单', orderUid]) }]);
}
function privateChatNsfwTarget(state, sessionUid) {
    if (!ownRecord(state) || !isChatSessionUid(sessionUid)) return fail('private_chat_invalid_target');
    if (currentContentMode(state) !== 'NSFW') return fail('private_chat_nsfw_safety_mode_changed');
    const session = ownRecord(ownRecord(state.会话)?.[sessionUid]);
    const npcUid = session?.对象UID;
    if (!session || !isNpcUid(npcUid) || session.状态 !== '已匹配') return fail('private_chat_nsfw_safety_not_matched');
    if (ownRecord(state.玩家)?.成人验证 !== true) return fail('private_chat_player_adult_verification_failed');
    const profile = roleAt(state, npcUid);
    const hidden = ownRecord(profile?.隐藏资料);
    if (!profile || profile.成人验证 !== true || !Number.isInteger(hidden?.实际年龄) || hidden.实际年龄 < 18) {
        return fail('private_chat_adult_verification_failed');
    }
    const relationship = ownRecord(profile.与玩家关系);
    if (relationship?.状态 !== '已匹配') return fail('private_chat_nsfw_safety_not_matched');
    const narrative = validateRelationshipNarrative(ownRecord(ownRecord(state.关系叙事)?.[npcUid]));
    if (!narrative.ok) return fail('mvu_relationship_narrative_schema_outdated');
    const progress = narrative.value.进程;
    const safety = deriveRelationshipSafetyState(progress);
    if (safety.ended) return fail('private_chat_relationship_ended');
    if (safety.paused) return fail('private_chat_relationship_paused');
    const consent = validateNsfwConsent(session.NSFW同意);
    if (!consent.ok) return fail('private_chat_nsfw_consent_schema_outdated');
    return success({ session, npcUid, profile, relationship, narrative: narrative.value, safety, consent: consent.value });
}

export function buildPrivateChatNsfwConsentPatch(state, { sessionUid, action, scopes = [], turns = 0 } = {}) {
    if (!['grant', 'revoke'].includes(action)) return fail('private_chat_nsfw_consent_invalid_action');
    const target = privateChatNsfwTarget(state, sessionUid);
    if (!target.ok) return target;
    if (target.value.safety.onlySfw) return fail('private_chat_nsfw_consent_only_sfw');
    const current = target.value.consent;
    const next = action === 'grant'
        ? grantNsfwConsent(current, { scopes, turns })
        : isActiveNsfwConsent(current) ? closeNsfwConsent(current, '已撤回') : null;
    if (!next) return fail(action === 'grant' ? 'private_chat_nsfw_consent_invalid_selection' : 'private_chat_nsfw_consent_not_active');
    return success([{
        op: 'replace',
        path: encodeJsonPointer(['会话', sessionUid, 'NSFW同意']),
        value: next,
    }]);
}

export function buildPrivateChatNsfwDirectionPatch(state, { sessionUid, direction } = {}) {
    const directionValues = Object.freeze({ love: '爱情', consensual_intimacy: '共识亲密', defer: '暂不定义' });
    if (!Object.hasOwn(directionValues, direction)) return fail('private_chat_nsfw_direction_invalid_action');
    const target = privateChatNsfwTarget(state, sessionUid);
    if (!target.ok) return target;
    if (target.value.safety.onlySfw) return fail('private_chat_nsfw_consent_only_sfw');
    if (!isActiveNsfwConsent(target.value.consent)) return fail('private_chat_nsfw_consent_required');
    const progress = target.value.narrative.进程;
    if (progress.冻结关系值) return fail('private_chat_nsfw_direction_locked');
    if (progress.NSFW方向确认可用 !== true) return fail('private_chat_nsfw_direction_unavailable');
    const selected = directionValues[direction];
    if (selected === '爱情' && (!Number.isInteger(target.value.relationship.心动值) || target.value.relationship.心动值 < 50)) {
        return fail('private_chat_nsfw_direction_unavailable');
    }
    if (selected === '共识亲密' && (!Number.isInteger(target.value.relationship.欲望值) || target.value.relationship.欲望值 < 50)) {
        return fail('private_chat_nsfw_direction_unavailable');
    }
    if (progress.NSFW路线锁定 === selected) return fail('private_chat_nsfw_direction_no_change');
    const activeMeetup = Object.values(ownRecord(state.面基记录) ?? {}).some((record) => ownRecord(record)
        && record.对象UID === target.value.npcUid && ['恋爱', '欲望'].includes(record.关系路线)
        && !['已结束', '已取消'].includes(record.状态));
    if (activeMeetup) return fail('private_chat_nsfw_direction_meetup_active');
    return success([{
        op: 'replace',
        path: encodeJsonPointer(['关系叙事', target.value.npcUid, '进程', 'NSFW路线锁定']),
        value: selected,
    }]);
}

function privateChatRelationshipTarget(state, sessionUid) {
    if (!ownRecord(state) || !isChatSessionUid(sessionUid)) return fail('private_chat_invalid_target');
    const session = ownRecord(ownRecord(state.会话)?.[sessionUid]);
    const npcUid = session?.对象UID;
    if (!session || !isNpcUid(npcUid) || session.状态 !== '已匹配') return fail('private_chat_nsfw_safety_not_matched');
    const profile = roleAt(state, npcUid);
    const hidden = ownRecord(profile?.隐藏资料);
    if (ownRecord(state.玩家)?.成人验证 !== true || !profile || profile.成人验证 !== true
        || !Number.isInteger(hidden?.实际年龄) || hidden.实际年龄 < 18 || profile.与玩家关系?.状态 !== '已匹配') {
        return fail('private_chat_adult_verification_failed');
    }
    const narrative = validateRelationshipNarrative(ownRecord(ownRecord(state.关系叙事)?.[npcUid]));
    const consent = validateNsfwConsent(session.NSFW同意);
    if (!narrative.ok) return fail('mvu_relationship_narrative_schema_outdated');
    if (!consent.ok) return fail('private_chat_nsfw_consent_schema_outdated');
    return success({ session, npcUid, profile, narrative: narrative.value, consent: consent.value });
}

/** Explicit, non-destructive relationship pause/archive/exit actions. Scores and history are retained. */
export function buildPrivateChatNsfwRelationshipActionPatch(state, { sessionUid, action } = {}) {
    if (!['degrade_to_friends', 'pause_contact', 'resume_contact', 'archive_contact', 'end_contact'].includes(action)) return fail('private_chat_nsfw_relationship_invalid_action');
    const target = privateChatRelationshipTarget(state, sessionUid);
    if (!target.ok) return target;
    const { npcUid, narrative, consent } = target.value;
    const progress = narrative.进程;
    const operations = [];
    if (action === 'degrade_to_friends') {
        if (currentContentMode(state) !== 'NSFW') return fail('private_chat_nsfw_safety_mode_changed');
        if (!['爱情', '共识亲密'].includes(progress.NSFW路线锁定) && !progress.冻结关系值) {
            return fail('private_chat_nsfw_relationship_not_established');
        }
        if (progress.NSFW路线锁定 !== '暂不定义') {
            operations.push({
                op: 'replace', path: encodeJsonPointer(['关系叙事', npcUid, '进程', 'NSFW路线锁定']), value: '暂不定义',
            });
        }
        if (progress.冻结关系值 !== '') {
            operations.push({
                op: 'replace', path: encodeJsonPointer(['关系叙事', npcUid, '进程', '冻结关系值']), value: '',
            });
        }
        if (progress.边界暂停状态 !== '仅SFW') {
            operations.push({
                op: 'replace', path: encodeJsonPointer(['关系叙事', npcUid, '进程', '边界暂停状态']), value: '仅SFW',
            });
        }
    } else if (action === 'pause_contact') {
        if (['结束联系', '已归档', '已删除'].includes(progress.关系结束状态) || progress.边界暂停状态 !== '') {
            return fail('private_chat_nsfw_relationship_no_change');
        }
        operations.push({
            op: 'replace', path: encodeJsonPointer(['关系叙事', npcUid, '进程', '边界暂停状态']), value: '暂停',
        });
        operations.push({
            op: 'replace', path: encodeJsonPointer(['关系叙事', npcUid, '进程', '最近关系观察']), value: '安全降级',
        });
    } else if (action === 'resume_contact') {
        if (progress.边界暂停状态 !== '暂停' || ['结束联系', '已归档', '已删除'].includes(progress.关系结束状态)) {
            return fail('private_chat_nsfw_relationship_no_change');
        }
        operations.push({
            op: 'replace', path: encodeJsonPointer(['关系叙事', npcUid, '进程', '边界暂停状态']), value: '',
        });
        operations.push({
            op: 'replace', path: encodeJsonPointer(['关系叙事', npcUid, '进程', '最近关系观察']), value: '保持观望',
        });
    } else if (action === 'archive_contact') {
        if (['结束联系', '已归档', '已删除'].includes(progress.关系结束状态)) {
            return fail('private_chat_nsfw_relationship_no_change');
        }
        operations.push({
            op: 'replace', path: encodeJsonPointer(['关系叙事', npcUid, '进程', '关系结束状态']), value: '已归档',
        });
        operations.push({
            op: 'replace', path: encodeJsonPointer(['关系叙事', npcUid, '进程', '边界暂停状态']), value: '已归档',
        });
        operations.push({
            op: 'replace', path: encodeJsonPointer(['关系叙事', npcUid, '进程', '最近关系观察']), value: '结局确认',
        });
    } else {
        if (['结束联系', '已归档', '已删除'].includes(progress.关系结束状态)) {
            return fail('private_chat_nsfw_relationship_no_change');
        }
        operations.push({
            op: 'replace', path: encodeJsonPointer(['关系叙事', npcUid, '进程', '关系结束状态']), value: '结束联系',
        });
        if (progress.边界暂停状态 !== '暂停') {
            operations.push({
                op: 'replace', path: encodeJsonPointer(['关系叙事', npcUid, '进程', '边界暂停状态']), value: '暂停',
            });
        }
        operations.push({
            op: 'replace', path: encodeJsonPointer(['关系叙事', npcUid, '进程', '最近关系观察']), value: '结局确认',
        });
    }
    if (isActiveNsfwConsent(consent)) {
        const revoked = closeNsfwConsent(consent, '已撤回');
        if (!revoked) return fail('private_chat_nsfw_consent_revision_exhausted');
        operations.push({
            op: 'replace', path: encodeJsonPointer(['会话', sessionUid, 'NSFW同意']), value: revoked,
        });
    }
    return operations.length ? success(operations) : fail('private_chat_nsfw_relationship_no_change');
}

export function buildPrivateChatNsfwSafetyPatch(state, { sessionUid, action } = {}) {
    if (!['pause', 'resume'].includes(action)) return fail('private_chat_nsfw_safety_invalid_action');
    const target = privateChatNsfwTarget(state, sessionUid);
    if (!target.ok) return target;
    const { npcUid, safety, consent } = target.value;
    if (action === 'pause' && safety.onlySfw) return fail('private_chat_nsfw_safety_already_paused');
    if (action === 'resume' && !safety.onlySfw) return fail('private_chat_nsfw_safety_not_paused');
    const operations = [{
        op: 'replace',
        path: encodeJsonPointer(['关系叙事', npcUid, '进程', '边界暂停状态']),
        value: action === 'pause' ? '仅SFW' : '',
    }];
    if (action === 'pause' && isActiveNsfwConsent(consent)) {
        const revoked = closeNsfwConsent(consent, '已撤回');
        if (!revoked) return fail('private_chat_nsfw_consent_revision_exhausted');
        operations.push({
            op: 'replace',
            path: encodeJsonPointer(['会话', sessionUid, 'NSFW同意']),
            value: revoked,
        });
    }
    return success(operations);
}

export function buildPrivateChatPatch(state, {
    sessionUid,
    npcUid,
    playerMessage,
    response,
    bodyCandidateEventId = '',
    onlySfwAtRequest = null,
    turnConsentConfirmed = false,
    nsfwConsentReferenceAtRequest = null,
} = {}) {
    const request = validatePrivateChatRequest({ state, sessionUid, npcUid, playerMessage });
    if (!request.ok) return fail(request.code === 'private_chat_relationship_narrative_schema_outdated'
        ? 'mvu_relationship_narrative_schema_outdated' : request.code);
    if (!isChatSessionUid(sessionUid)) return fail('private_chat_invalid_target');

    const relationshipNarrative = validateRelationshipNarrative(ownRecord(ownRecord(state.关系叙事)?.[npcUid]));
    if (!relationshipNarrative.ok) return fail('mvu_relationship_narrative_schema_outdated');
    const onlySfwNow = deriveRelationshipSafetyState(relationshipNarrative.value.进程).onlySfw;
    if (onlySfwAtRequest !== null && typeof onlySfwAtRequest !== 'boolean') return fail('private_chat_safety_reference_invalid');
    if (typeof onlySfwAtRequest === 'boolean' && onlySfwAtRequest !== onlySfwNow) return fail('private_chat_safety_state_changed');
    if (typeof turnConsentConfirmed !== 'boolean') return fail('private_chat_nsfw_turn_consent_invalid');
    const sourceMode = currentContentMode(state);
    const requiresNsfwConsent = sourceMode === 'NSFW' && !onlySfwNow;
    const sessionConsent = requiresNsfwConsent
        ? validateNsfwConsent(request.value.session.NSFW同意)
        : success(createEmptyNsfwConsent());
    if (!sessionConsent.ok) return fail('private_chat_nsfw_consent_schema_outdated');
    if (requiresNsfwConsent && turnConsentConfirmed !== true) return fail('private_chat_nsfw_turn_consent_required');
    if (requiresNsfwConsent && !matchesNsfwConsentReference(sessionConsent.value, nsfwConsentReferenceAtRequest)) {
        return fail(isActiveNsfwConsent(sessionConsent.value)
            ? 'private_chat_nsfw_consent_state_changed' : 'private_chat_nsfw_consent_required');
    }
    let normalizedResponse;
    try { normalizedResponse = normalizePrivateChatResponse(response, { contentMode: onlySfwNow ? 'SFW' : ownRecord(state.软件)?.内容模式 }); }
    catch { return fail('private_chat_response_invalid'); }

    const { session, npc, relationship, playerMessage: normalizedMessage } = request.value;
    if (typeof bodyCandidateEventId !== 'string') return fail('private_chat_body_candidate_reference_invalid');
    const pendingBodyCandidate = selectPendingBodyRelationshipCandidate(state, npcUid);
    if (!pendingBodyCandidate.ok) return fail(pendingBodyCandidate.code ?? 'mvu_body_relationship_candidate_schema_outdated');
    // The event ID stays outside the model context and must still name the
    // exact candidate seen before the async request. A newer candidate is left
    // pending instead of being settled by an old reply.
    const bodyCandidate = bodyCandidateEventId && pendingBodyCandidate.value?.事件ID === bodyCandidateEventId
        ? pendingBodyCandidate.value
        : null;
    const recentMessages = Array.isArray(session.最近消息) ? session.最近消息 : null;
    if (!recentMessages || recentMessages.length > MAX_CHAT_HISTORY_MESSAGES) return fail('private_chat_session_messages_invalid');
    for (const field of RELATIONSHIP_VALUE_FIELDS) {
        if (!Number.isInteger(relationship[field]) || relationship[field] < 0 || relationship[field] > 100) return fail('private_chat_relationship_state_invalid');
    }
    for (const field of BOND_VALUE_FIELDS) {
        if (relationship[field] !== undefined && (!Number.isInteger(relationship[field]) || relationship[field] < 0 || relationship[field] > 100)) {
            return fail('private_chat_relationship_state_invalid');
        }
    }
    const maxStoredLayer = recentMessages.reduce((maximum, message) => {
        const layer = ownRecord(message) && Number.isInteger(message.层数) && message.层数 >= 0 ? message.层数 : 0;
        return Math.max(maximum, layer);
    }, 0);
    // Pre-summary cards have no layer field, so their retained message count is
    // the only safe legacy fallback. New cards may contain system notices that
    // intentionally share the preceding dialogue layer.
    const hasStoredLayers = recentMessages.some((message) => ownRecord(message) && Number.isInteger(message.层数) && message.层数 >= 0);
    const legacyFallbackLayerCount = hasStoredLayers ? maxStoredLayer : recentMessages.length;
    const knownLayerCount = Number.isInteger(session.对话层数) && session.对话层数 >= maxStoredLayer && session.对话层数 <= 999999
        ? session.对话层数 : legacyFallbackLayerCount;
    // dialogueLayers 让节奏裁决知道会话仍处于开局宽限（试探期）：宽限内非恶化
    // 回合必定回复，且不允许直接拉黑。层数只来自受控状态，绝不来自模型。
    const rhythm = decideInteractionRhythm({
        relationship,
        responseRelationship: normalizedResponse.relationship,
        readWithoutReplyThreshold: npc.已读不回阈值,
        blockThreshold: npc.拉黑阈值,
        dialogueLayers: knownLayerCount,
    });
    if (!rhythm) return fail('private_chat_rhythm_state_invalid');

    const nextMessageNumber = nextChatMessageNumber(sessionUid, recentMessages);
    const appendedMessageCount = rhythm.outcome === 'replied' ? normalizedResponse.replies.length + 1 : 2;
    const retainedOverflow = Math.max(0, recentMessages.length + appendedMessageCount - MAX_CHAT_HISTORY_MESSAGES);
    if (retainedOverflow > 0) {
        const marker = normalizeConversationSummaryState(session).lastMessageUid;
        const markerIndex = marker
            ? recentMessages.map((message) => ownRecord(message)?.消息UID).lastIndexOf(marker)
            : -1;
        // Only the already summarized prefix may age out of the bounded raw
        // transcript. Losing a pending message would make a later summary or
        // meetup handoff silently incomplete, so refuse the send instead.
        if (markerIndex + 1 < retainedOverflow) return fail('private_chat_history_requires_summary');
    }
    let nextLayer = knownLayerCount;
    const messageForLayer = (sender, uid, content) => {
        // “层” means a player or character utterance. A locally generated
        // delivery/read notice remains part of the transcript but must not make
        // an automatic summary fire earlier than the configured dialogue count.
        if (sender !== '系统') nextLayer += 1;
        return { ...chatMessage(sender, uid, content), 层数: nextLayer };
    };
    const operations = [];
    const playerMessageUid = 'msg_' + sessionUid + '_p_' + nextMessageNumber;
    for (let index = 0; index < retainedOverflow; index += 1) {
        operations.push({ op: 'remove', path: encodeJsonPointer(['会话', sessionUid, '最近消息', '0']) });
    }
    operations.push({ op: 'add', path: encodeJsonPointer(['会话', sessionUid, '最近消息', '-']), value: messageForLayer('玩家', playerMessageUid, normalizedMessage) });
    if (rhythm.outcome === 'replied') {
        normalizedResponse.replies.forEach((reply, index) => operations.push({ op: 'add', path: encodeJsonPointer(['会话', sessionUid, '最近消息', '-']), value: messageForLayer('角色', 'msg_' + sessionUid + '_n_' + (nextMessageNumber + index + 1), reply) }));
    } else {
        const blocked = rhythm.outcome === 'blocked';
        operations.push({ op: 'add', path: encodeJsonPointer(['会话', sessionUid, '最近消息', '-']), value: messageForLayer('系统', 'msg_' + sessionUid + '_s_' + (nextMessageNumber + 1), blocked ? BLOCKED_CHAT_NOTICE : READ_WITHOUT_REPLY_NOTICE) });
        if (blocked) {
            operations.push({ op: 'replace', path: encodeJsonPointer(['会话', sessionUid, '状态']), value: '已拉黑' });
            operations.push({ op: 'replace', path: encodeJsonPointer(['角色池', npcUid, '与玩家关系', '状态']), value: '已拉黑' });
            const listed = addUidOnce(state, '拉黑角色UID', npcUid, operations);
            if (!listed.ok) return listed;
        }
    }
    for (const field of RELATIONSHIP_VALUE_FIELDS) {
        const next = rhythm.projectedRelationship[field];
        if (next !== relationship[field]) operations.push({ op: 'replace', path: encodeJsonPointer(['角色池', npcUid, '与玩家关系', field]), value: next });
    }
    const bodySettlement = settleBodyRelationshipCandidate({
        contentMode: onlySfwNow ? 'SFW' : ownRecord(state.软件)?.内容模式,
        relationship,
        progress: relationshipNarrative.value.进程,
        wishTrajectory: relationshipNarrative.value.未竟心愿.变化轨迹,
        candidate: bodyCandidate,
        review: normalizedResponse.bodyEventReview,
        replied: rhythm.outcome === 'replied',
        turnId: playerMessageUid,
    });
    if (bodySettlement.handled && bodySettlement.delta !== 0 && BOND_VALUE_FIELDS.includes(bodySettlement.field)) {
        operations.push({
            op: Object.hasOwn(relationship, bodySettlement.field) ? 'replace' : 'add',
            path: encodeJsonPointer(['角色池', npcUid, '与玩家关系', bodySettlement.field]),
            value: bodySettlement.nextValue,
        });
    }
    if (bodySettlement.handled) {
        for (const [field, value] of Object.entries(bodySettlement.progressUpdates)) {
            operations.push({
                op: 'replace',
                path: encodeJsonPointer(['关系叙事', npcUid, '进程', field]),
                value,
            });
        }
        if (bodySettlement.wishTrajectory && bodySettlement.wishTrajectory !== relationshipNarrative.value.未竟心愿.变化轨迹) {
            operations.push({
                op: 'replace',
                path: encodeJsonPointer(['关系叙事', npcUid, '未竟心愿', '变化轨迹']),
                value: bodySettlement.wishTrajectory,
            });
        }
        if (bodySettlement.relationshipEndState && bodySettlement.relationshipEndState !== relationshipNarrative.value.进程.关系结束状态) {
            operations.push({
                op: 'replace',
                path: encodeJsonPointer(['关系叙事', npcUid, '进程', '关系结束状态']),
                value: bodySettlement.relationshipEndState,
            });
        }
    }
    if (bodySettlement.consume) {
        operations.push({
            op: 'replace',
            path: encodeJsonPointer(['正文关系候选', npcUid]),
            value: createEmptyBodyRelationshipCandidate(),
        });
    }
    if (!bodySettlement.handled) {
        const repeatedPlayerMessage = repeatsRecentPlayerMessage(recentMessages, normalizedMessage);
        const safetyAssessment = normalizedResponse.nsfwSafetyAssessment;
        const bondProgress = settleRelationshipProgress({
            contentMode: sourceMode,
            relationship,
            progress: relationshipNarrative.value.进程,
            assessment: repeatedPlayerMessage && safetyAssessment === 'none'
                ? { kind: 'none', intensity: 0, direction: 'none' }
                : normalizedResponse.bondAssessment,
            sfwInsightAssessment: repeatedPlayerMessage ? 'none' : normalizedResponse.sfwInsightAssessment,
            sfwResolutionAssessment: repeatedPlayerMessage ? 'none' : normalizedResponse.sfwResolutionAssessment,
            nsfwSafetyAssessment: safetyAssessment,
            nsfwConsentAssessment: normalizedResponse.nsfwConsentAssessment,
            // A reply may still be natural on a repeated message, but a copied or
            // recently repeated ordinary utterance is not a new positive fact.
            // Repeating a classified safety violation must still be able to set
            // the only-SFW hard gate even when no score can move.
            replied: rhythm.outcome === 'replied',
            turnId: playerMessageUid,
        });
        if (bondProgress.delta !== 0 && BOND_VALUE_FIELDS.includes(bondProgress.field)) {
            operations.push({
                op: Object.hasOwn(relationship, bondProgress.field) ? 'replace' : 'add',
                path: encodeJsonPointer(['角色池', npcUid, '与玩家关系', bondProgress.field]),
                value: bondProgress.nextValue,
            });
        }
        for (const [field, value] of Object.entries(bondProgress.progressUpdates)) {
            operations.push({
                op: 'replace',
                path: encodeJsonPointer(['关系叙事', npcUid, '进程', field]),
                value,
            });
        }
        if (bondProgress.relationshipEndState && bondProgress.relationshipEndState !== relationshipNarrative.value.进程.关系结束状态) {
            operations.push({
                op: 'replace',
                path: encodeJsonPointer(['关系叙事', npcUid, '进程', '关系结束状态']),
                value: bondProgress.relationshipEndState,
            });
        }
        if (bondProgress.safetyPause && relationshipNarrative.value.进程.边界暂停状态 === '') {
            operations.push({
                op: 'replace',
                path: encodeJsonPointer(['关系叙事', npcUid, '进程', '边界暂停状态']),
                value: '仅SFW',
            });
        }
    }
    if (requiresNsfwConsent) {
        const mustRevokeConsent = normalizedResponse.nsfwConsentAssessment === 'withdrawn'
            || normalizedResponse.nsfwSafetyAssessment !== 'none'
            || rhythm.outcome === 'blocked';
        const nextConsent = mustRevokeConsent
            ? closeNsfwConsent(sessionConsent.value, '已撤回')
            : consumeNsfwConsent(sessionConsent.value);
        if (!nextConsent) return fail('private_chat_nsfw_consent_revision_exhausted');
        operations.push({
            op: 'replace',
            path: encodeJsonPointer(['会话', sessionUid, 'NSFW同意']),
            value: nextConsent,
        });
    }
    operations.push({ op: 'add', path: encodeJsonPointer(['会话', sessionUid, '对话层数']), value: nextLayer });
    return success(operations);
}

function realisticTarget(state, sessionUid, npcUid) {
    const checked = validatePrivateChatRequest({ state, sessionUid, npcUid, playerMessage: '拟真聊天状态校验' });
    if (!checked.ok) return fail(checked.code === 'private_chat_relationship_narrative_schema_outdated'
        ? 'mvu_relationship_narrative_schema_outdated' : checked.code);
    const realistic = validateRealisticChatState(checked.value.session.拟真聊天);
    if (!realistic.ok) return fail('private_chat_realistic_schema_outdated');
    return success({ ...checked.value, realistic: realistic.value });
}

function knownConversationLayer(session, recentMessages) {
    const maxStoredLayer = recentMessages.reduce((maximum, message) => {
        const layer = ownRecord(message) && Number.isInteger(message.层数) && message.层数 >= 0 ? message.层数 : 0;
        return Math.max(maximum, layer);
    }, 0);
    const hasStoredLayers = recentMessages.some((message) => ownRecord(message) && Number.isInteger(message.层数) && message.层数 >= 0);
    const legacyFallback = hasStoredLayers ? maxStoredLayer : recentMessages.length;
    return Number.isInteger(session.对话层数) && session.对话层数 >= maxStoredLayer && session.对话层数 <= 999999
        ? session.对话层数 : legacyFallback;
}

function appendSummarySafeTrimOperations(sessionUid, session, recentMessages, appendedCount, operations) {
    const overflow = Math.max(0, recentMessages.length + appendedCount - MAX_CHAT_HISTORY_MESSAGES);
    if (!overflow) return success({ overflow: 0 });
    const marker = normalizeConversationSummaryState(session).lastMessageUid;
    const markerIndex = marker ? recentMessages.map((message) => ownRecord(message)?.消息UID).lastIndexOf(marker) : -1;
    if (markerIndex + 1 < overflow) return fail('private_chat_history_requires_summary');
    for (let index = 0; index < overflow; index += 1) {
        operations.push({ op: 'remove', path: encodeJsonPointer(['会话', sessionUid, '最近消息', '0']) });
    }
    return success({ overflow });
}

function appendRealisticMarkerRepairAfterTrim(sessionUid, recentMessages, realistic, overflow, operations) {
    const marker = realistic?.最近处理玩家消息UID;
    if (!marker || !Number.isInteger(overflow) || overflow < 1) return;
    const markerIndex = recentMessages.findIndex((message) => ownRecord(message) && message.消息UID === marker);
    if (markerIndex >= 0 && markerIndex < overflow) operations.push({
        op: 'replace', path: encodeJsonPointer(['会话', sessionUid, '拟真聊天', '最近处理玩家消息UID']), value: '',
    });
}

export function buildToggleRealisticPrivateChatPatch(state, { sessionUid, npcUid, enabled, phoneTime } = {}) {
    if (typeof enabled !== 'boolean' || parsePhoneTimestamp(phoneTime) === null) return fail('private_chat_realistic_toggle_invalid');
    let target = realisticTarget(state, sessionUid, npcUid);
    // Paused/archived/ended chats must still be able to turn the scheduler off
    // and discard unseen messages. Enabling remains subject to every ordinary
    // private-chat safety gate.
    if (!enabled && !target.ok && ['private_chat_relationship_paused', 'private_chat_relationship_ended'].includes(target.code)) {
        const inactive = privateChatRelationshipTarget(state, sessionUid);
        if (!inactive.ok) return inactive;
        if (inactive.value.npcUid !== npcUid) return fail('private_chat_session_not_found');
        const realistic = validateRealisticChatState(inactive.value.session.拟真聊天);
        if (!realistic.ok) return fail('private_chat_realistic_schema_outdated');
        target = success({ session: inactive.value.session, realistic: realistic.value });
    }
    if (!target.ok) return target;
    const { session, realistic } = target.value;
    if (realistic.启用 === enabled) return fail('private_chat_realistic_toggle_no_change');
    const next = enabled
        ? createDefaultRealisticChatState({
            enabled: true,
            latestPlayerMessageUid: latestPlayerMessageUid(session),
            proactiveAt: addPhoneMinutes(phoneTime, 60),
        })
        : createDefaultRealisticChatState({ latestPlayerMessageUid: realistic.最近处理玩家消息UID || latestPlayerMessageUid(session) });
    return success([{
        op: 'replace',
        path: encodeJsonPointer(['会话', sessionUid, '拟真聊天']),
        value: next,
    }]);
}

export function buildAppendRealisticPrivateChatPlayerMessagePatch(state, {
    sessionUid,
    npcUid,
    playerMessage,
    phoneTime,
    turnConsentConfirmed = false,
    nsfwConsentReferenceAtSend = null,
} = {}) {
    if (parsePhoneTimestamp(phoneTime) === null) return fail('private_chat_realistic_time_invalid');
    const request = validatePrivateChatRequest({ state, sessionUid, npcUid, playerMessage });
    if (!request.ok) return fail(request.code === 'private_chat_relationship_narrative_schema_outdated'
        ? 'mvu_relationship_narrative_schema_outdated' : request.code);
    const { session, playerMessage: normalizedMessage, onlySfw } = request.value;
    const realistic = validateRealisticChatState(session.拟真聊天);
    if (!realistic.ok) return fail('private_chat_realistic_schema_outdated');
    if (!realistic.value.启用) return fail('private_chat_realistic_disabled');
    const pendingPlayers = listPendingRealisticPlayerMessages(session);
    if (!pendingPlayers.ok) return fail(pendingPlayers.code);
    const nextCount = pendingPlayers.value.length + 1;
    const nextLength = pendingPlayers.value.reduce((sum, item) => sum + item.content.length, 0)
        + normalizedMessage.length + Math.max(0, nextCount - 1);
    if (nextCount > MAX_REALISTIC_PLAYER_BURST_COUNT) return fail('private_chat_realistic_player_burst_full');
    if (nextLength > MAX_REALISTIC_PLAYER_BURST_LENGTH) return fail('private_chat_realistic_player_burst_too_long');
    const sourceMode = currentContentMode(state);
    const requiresConsent = sourceMode === 'NSFW' && onlySfw !== true;
    if (requiresConsent) {
        const consent = validateNsfwConsent(session.NSFW同意);
        if (!consent.ok) return fail('private_chat_nsfw_consent_schema_outdated');
        if (!isActiveNsfwConsent(consent.value) || turnConsentConfirmed !== true) return fail('private_chat_nsfw_turn_consent_required');
        if (!matchesNsfwConsentReference(consent.value, nsfwConsentReferenceAtSend)) return fail('private_chat_nsfw_consent_state_changed');
    }
    const recentMessages = Array.isArray(session.最近消息) ? session.最近消息 : null;
    if (!recentMessages || recentMessages.length > MAX_CHAT_HISTORY_MESSAGES) return fail('private_chat_session_messages_invalid');
    const operations = [];
    const trimmed = appendSummarySafeTrimOperations(sessionUid, session, recentMessages, 1, operations);
    if (!trimmed.ok) return trimmed;
    appendRealisticMarkerRepairAfterTrim(sessionUid, recentMessages, realistic.value, trimmed.value.overflow, operations);
    const nextLayer = knownConversationLayer(session, recentMessages) + 1;
    if (nextLayer > 999999) return fail('private_chat_dialogue_layer_exhausted');
    const number = nextChatMessageNumber(sessionUid, recentMessages, realistic.value.待投递消息);
    const messageUid = `msg_${sessionUid}_p_${number}`;
    operations.push({
        op: 'add',
        path: encodeJsonPointer(['会话', sessionUid, '最近消息', '-']),
        value: { ...chatMessage('玩家', messageUid, normalizedMessage, phoneTime), 层数: nextLayer },
    });
    operations.push({
        op: 'replace',
        path: encodeJsonPointer(['会话', sessionUid, '拟真聊天', '回复触发时间']),
        value: addPhoneMinutes(phoneTime, REALISTIC_REPLY_QUIET_MINUTES),
    });
    if (requiresConsent && realistic.value.待回复同意修订号 !== nsfwConsentReferenceAtSend.revision) operations.push({
        op: 'replace',
        path: encodeJsonPointer(['会话', sessionUid, '拟真聊天', '待回复同意修订号']),
        value: nsfwConsentReferenceAtSend.revision,
    });
    if (realistic.value.主动触发时间) {
        operations.push({
            op: 'replace',
            path: encodeJsonPointer(['会话', sessionUid, '拟真聊天', '主动触发时间']),
            value: '',
        });
    }
    operations.push({ op: 'add', path: encodeJsonPointer(['会话', sessionUid, '对话层数']), value: nextLayer });
    return success({ patch: operations, messageUid, nsfwConsentReferenceAtSend: requiresConsent ? nsfwConsentReferenceAtSend : null });
}

function responseWithoutTiming(response, fallbackReply) {
    const result = {
        replies: response.replies.length ? response.replies : [fallbackReply],
        relationship: response.relationship,
        bondAssessment: response.bondAssessment,
        bodyEventReview: response.bodyEventReview,
        sfwInsightAssessment: response.sfwInsightAssessment,
        sfwResolutionAssessment: response.sfwResolutionAssessment,
        nsfwSafetyAssessment: response.nsfwSafetyAssessment,
        nsfwConsentAssessment: response.nsfwConsentAssessment,
    };
    if (response.replies.length && Array.isArray(response.imageDirectives)) result.imageDirectives = response.imageDirectives;
    return result;
}

function queuedDeliveryPlan({
    sessionUid,
    trigger,
    triggerId,
    generationTime,
    response,
    messageOperations,
    contentMode = 'SFW',
    consentRevision = 0,
}) {
    if (!['SFW', 'NSFW'].includes(contentMode) || !Number.isInteger(consentRevision)
        || consentRevision < 0 || consentRevision > 999999 || (contentMode === 'SFW' && consentRevision !== 0)) {
        return { pending: [], roleMessageUids: [], lastDeliveryTime: '', invalid: true };
    }
    const batchUid = `batch_${sessionUid}_${trigger}_${triggerId}_mode_${contentMode.toLowerCase()}_r${consentRevision}`;
    let deliveryTime = addPhoneMinutes(generationTime, response.timing.firstDelayMinutes);
    const pending = [];
    const roleMessageUids = [];
    let roleIndex = 0;
    for (const operation of messageOperations) {
        const value = operation.value;
        if (value?.发送者 === '角色' && response.replies.length === 0) continue;
        pending.push({
            消息UID: value.消息UID,
            发送者: value.发送者,
            内容: value.内容,
            时间: deliveryTime,
            批次UID: batchUid,
        });
        if (value.发送者 === '角色') {
            roleMessageUids.push(value.消息UID);
            const interval = response.timing.betweenReplyMinutes[roleIndex];
            roleIndex += 1;
            if (interval) deliveryTime = addPhoneMinutes(deliveryTime, interval);
        }
    }
    return { pending, roleMessageUids, lastDeliveryTime: pending.at(-1)?.时间 ?? generationTime };
}

export function buildRealisticPrivateChatResponsePatch(state, {
    sessionUid,
    npcUid,
    response,
    generationTime,
    playerMessageUids,
    bodyCandidateEventId = '',
    onlySfwAtRequest = null,
    turnConsentConfirmed = false,
    nsfwConsentReferenceAtRequest = null,
} = {}) {
    if (parsePhoneTimestamp(generationTime) === null || !Array.isArray(playerMessageUids)) return fail('private_chat_realistic_generation_invalid');
    const target = realisticTarget(state, sessionUid, npcUid);
    if (!target.ok) return target;
    const { session, realistic } = target.value;
    if (!realistic.启用) return fail('private_chat_realistic_disabled');
    if (!realistic.回复触发时间 || !isPhoneTimestampDue(realistic.回复触发时间, generationTime)) return fail('private_chat_realistic_reply_not_due');
    if (realistic.待投递消息.length) return fail('private_chat_realistic_delivery_pending');
    const pendingPlayers = listPendingRealisticPlayerMessages(session);
    if (!pendingPlayers.ok || !pendingPlayers.value.length) return fail(pendingPlayers.code ?? 'private_chat_realistic_no_pending_player_messages');
    const expectedUids = pendingPlayers.value.map((item) => item.messageUid);
    if (JSON.stringify(expectedUids) !== JSON.stringify(playerMessageUids)) return fail('private_chat_realistic_player_batch_changed');
    const sourceMode = currentContentMode(state);
    const requiresConsent = sourceMode === 'NSFW' && onlySfwAtRequest !== true;
    if (requiresConsent && (!nsfwConsentReferenceAtRequest
        || realistic.待回复同意修订号 !== nsfwConsentReferenceAtRequest.revision)) {
        return fail('private_chat_nsfw_consent_state_changed');
    }
    let normalized;
    try { normalized = normalizeRealisticPrivateChatResponse(response, { contentMode: onlySfwAtRequest ? 'SFW' : currentContentMode(state) }); }
    catch { return fail('private_chat_response_invalid'); }
    const lastPlayer = pendingPlayers.value.at(-1);
    const recent = session.最近消息;
    const lastIndex = recent.findIndex((message) => ownRecord(message) && message.消息UID === lastPlayer.messageUid);
    if (lastIndex < 0) return fail('private_chat_realistic_player_batch_changed');
    const currentLayer = knownConversationLayer(session, recent);
    if (currentLayer < 1) return fail('private_chat_dialogue_layer_invalid');
    const syntheticMessages = recent.filter((_, index) => index !== lastIndex).map((message) => ownRecord(message)
        ? { ...message, 层数: Number.isInteger(message.层数) ? Math.min(message.层数, currentLayer - 1) : message.层数 }
        : message);
    const syntheticState = {
        ...state,
        会话: {
            ...state.会话,
            [sessionUid]: { ...session, 最近消息: syntheticMessages, 对话层数: currentLayer - 1 },
        },
    };
    const combinedPlayerMessage = pendingPlayers.value.map((item) => item.content).join(' ');
    const legacy = buildPrivateChatPatch(syntheticState, {
        sessionUid,
        npcUid,
        playerMessage: combinedPlayerMessage,
        response: responseWithoutTiming(normalized, '拟真调度占位'),
        bodyCandidateEventId,
        onlySfwAtRequest,
        turnConsentConfirmed,
        nsfwConsentReferenceAtRequest,
    });
    if (!legacy.ok) return legacy;
    let deliveryConsentRevision = 0;
    if (requiresConsent) {
        const nextConsentOperation = legacy.value.find((operation) => operation?.op === 'replace'
            && operation.path === encodeJsonPointer(['会话', sessionUid, 'NSFW同意']));
        const nextConsent = validateNsfwConsent(nextConsentOperation?.value);
        if (!nextConsent.ok) return fail('private_chat_nsfw_consent_state_changed');
        deliveryConsentRevision = nextConsent.value.修订号;
    }
    const recentAddPattern = new RegExp(`^/会话/${sessionUid}/最近消息/-$`, 'u');
    const messageOperations = legacy.value.filter((operation) => operation?.op === 'add'
        && recentAddPattern.test(operation.path) && ['角色', '系统'].includes(operation.value?.发送者));
    const transformed = legacy.value.filter((operation) => {
        if (/^\/会话\/chat_[A-Za-z0-9_-]{1,64}\/最近消息\/(?:-|0)$/u.test(operation?.path ?? '')) return false;
        return operation?.path !== encodeJsonPointer(['会话', sessionUid, '对话层数']);
    });
    const blocked = transformed.some((operation) => operation?.path === encodeJsonPointer(['会话', sessionUid, '状态']) && operation.value === '已拉黑');
    const plan = queuedDeliveryPlan({
        sessionUid,
        trigger: 'reply',
        triggerId: lastPlayer.messageUid.split('_').at(-1),
        generationTime,
        response: normalized,
        messageOperations,
        contentMode: requiresConsent ? 'NSFW' : 'SFW',
        consentRevision: deliveryConsentRevision,
    });
    if (plan.invalid || plan.pending.length > MAX_REALISTIC_PENDING_MESSAGES) return fail('private_chat_realistic_delivery_overflow');
    transformed.push({
        op: 'replace', path: encodeJsonPointer(['会话', sessionUid, '拟真聊天', '最近处理玩家消息UID']), value: lastPlayer.messageUid,
    });
    transformed.push({
        op: 'replace', path: encodeJsonPointer(['会话', sessionUid, '拟真聊天', '回复触发时间']), value: '',
    });
    if (realistic.待回复同意修订号 !== 0) transformed.push({
        op: 'replace', path: encodeJsonPointer(['会话', sessionUid, '拟真聊天', '待回复同意修订号']), value: 0,
    });
    transformed.push({
        op: 'replace',
        path: encodeJsonPointer(['会话', sessionUid, '拟真聊天', '主动触发时间']),
        value: blocked ? '' : addPhoneMinutes(plan.lastDeliveryTime, normalized.timing.nextProactiveMinutes),
    });
    // A local safety block is not an AI reply and makes the session terminal.
    // Record its fixed system notice immediately; queuing it would make the
    // later delivery target permanently ineligible after the same transaction.
    if (blocked) {
        const systemNotice = messageOperations.find((operation) => operation.value?.发送者 === '系统')?.value;
        if (!systemNotice) return fail('private_chat_realistic_block_notice_missing');
        transformed.push({
            op: 'add', path: encodeJsonPointer(['会话', sessionUid, '最近消息', '-']),
            value: { ...systemNotice, 时间: generationTime },
        });
    }
    for (const pending of blocked ? [] : plan.pending) transformed.push({
        op: 'add', path: encodeJsonPointer(['会话', sessionUid, '拟真聊天', '待投递消息', '-']), value: pending,
    });
    const imageDirectives = (normalized.imageDirectives ?? []).flatMap((item) => {
        const messageUid = plan.roleMessageUids[item.replyIndex];
        return messageUid ? [{ messageUid, directive: item.directive }] : [];
    });
    const interactionOutcome = blocked ? 'blocked'
        : plan.pending.some((item) => item.发送者 === '系统') ? 'read_without_reply'
            : plan.roleMessageUids.length ? 'queued' : 'silent';
    return success({ patch: transformed, interactionOutcome, imageDirectives, queuedMessageUids: plan.pending.map((item) => item.消息UID) });
}

export function buildRealisticPrivateChatProactivePatch(state, {
    sessionUid,
    npcUid,
    response,
    generationTime,
    triggerTime,
    onlySfwAtRequest = null,
    nsfwConsentReferenceAtRequest = null,
} = {}) {
    if (parsePhoneTimestamp(generationTime) === null || parsePhoneTimestamp(triggerTime) === null) return fail('private_chat_realistic_generation_invalid');
    const target = realisticTarget(state, sessionUid, npcUid);
    if (!target.ok) return target;
    const { session, realistic, onlySfw } = target.value;
    if (!realistic.启用 || realistic.主动触发时间 !== triggerTime || !isPhoneTimestampDue(triggerTime, generationTime)) {
        return fail('private_chat_realistic_proactive_not_due');
    }
    if (realistic.最近主动触发时间 === triggerTime) return fail('private_chat_realistic_proactive_duplicate');
    if (realistic.待投递消息.length || realistic.回复触发时间) return fail('private_chat_realistic_delivery_pending');
    const pendingPlayers = listPendingRealisticPlayerMessages(session);
    if (!pendingPlayers.ok || pendingPlayers.value.length) return fail('private_chat_realistic_player_messages_pending');
    const effectiveOnlySfwAtRequest = onlySfwAtRequest === null ? onlySfw : onlySfwAtRequest;
    if (effectiveOnlySfwAtRequest !== onlySfw) return fail('private_chat_realistic_proactive_mode_changed');
    const sourceMode = currentContentMode(state);
    const requiresConsent = sourceMode === 'NSFW' && onlySfw !== true;
    let consentRevision = 0;
    if (requiresConsent) {
        const consent = validateNsfwConsent(session.NSFW同意);
        if (!consent.ok || !isActiveNsfwConsent(consent.value)
            || !matchesNsfwConsentReference(consent.value, nsfwConsentReferenceAtRequest)) {
            return fail('private_chat_nsfw_consent_state_changed');
        }
        consentRevision = consent.value.修订号;
    }
    let normalized;
    try { normalized = normalizeRealisticPrivateChatResponse(response, { contentMode: requiresConsent ? 'NSFW' : 'SFW' }); }
    catch { return fail('private_chat_response_invalid'); }
    if (normalized.replies.length > 3
        || RELATIONSHIP_VALUE_FIELDS.some((field) => normalized.relationship[field] !== 0)
        || normalized.bondAssessment.kind !== 'none' || normalized.sfwInsightAssessment !== 'none'
        || normalized.sfwResolutionAssessment !== 'none' || normalized.nsfwSafetyAssessment !== 'none'
        || normalized.nsfwConsentAssessment !== 'none' || normalized.bodyEventReview !== 'defer') {
        return fail('private_chat_realistic_proactive_not_neutral');
    }
    const number = nextChatMessageNumber(sessionUid, session.最近消息, realistic.待投递消息);
    const messageOperations = normalized.replies.map((reply, index) => ({
        value: chatMessage('角色', `msg_${sessionUid}_n_${number + index}`, reply),
    }));
    const triggerId = triggerTime.replace(/[^0-9]/gu, '');
    const plan = queuedDeliveryPlan({
        sessionUid,
        trigger: 'proactive',
        triggerId,
        generationTime,
        response: normalized,
        messageOperations,
        contentMode: requiresConsent ? 'NSFW' : 'SFW',
        consentRevision,
    });
    if (plan.invalid) return fail('private_chat_realistic_delivery_overflow');
    const operations = [{
        op: 'replace', path: encodeJsonPointer(['会话', sessionUid, '拟真聊天', '最近主动触发时间']), value: triggerTime,
    }, {
        op: 'replace',
        path: encodeJsonPointer(['会话', sessionUid, '拟真聊天', '主动触发时间']),
        value: addPhoneMinutes(plan.lastDeliveryTime, normalized.timing.nextProactiveMinutes),
    }];
    for (const pending of plan.pending) operations.push({
        op: 'add', path: encodeJsonPointer(['会话', sessionUid, '拟真聊天', '待投递消息', '-']), value: pending,
    });
    const imageDirectives = (normalized.imageDirectives ?? []).flatMap((item) => {
        const messageUid = plan.roleMessageUids[item.replyIndex];
        return messageUid ? [{ messageUid, directive: item.directive }] : [];
    });
    return success({ patch: operations, interactionOutcome: plan.pending.length ? 'queued' : 'silent', imageDirectives, queuedMessageUids: plan.pending.map((item) => item.消息UID) });
}

export function buildDeliverRealisticPrivateChatMessagesPatch(state, { sessionUid, npcUid, phoneTime } = {}) {
    if (parsePhoneTimestamp(phoneTime) === null) return fail('private_chat_realistic_time_invalid');
    const target = realisticTarget(state, sessionUid, npcUid);
    if (!target.ok) return target;
    const { session, realistic, onlySfw } = target.value;
    if (!realistic.启用) return fail('private_chat_realistic_disabled');
    const batchSafety = realistic.待投递消息.map((message) => /_mode_(sfw|nsfw)_r(0|[1-9]\d{0,5})$/u.exec(message.批次UID));
    if (batchSafety.some((match) => !match)
        || batchSafety.some((match) => match[1] !== batchSafety[0][1] || match[2] !== batchSafety[0][2])) {
        return fail('private_chat_realistic_delivery_context_invalid');
    }
    if (batchSafety[0]?.[1] === 'nsfw') {
        const consent = validateNsfwConsent(session.NSFW同意);
        if (currentContentMode(state) !== 'NSFW' || onlySfw === true) return fail('private_chat_realistic_delivery_mode_changed');
        if (!consent.ok || consent.value.修订号 !== Number(batchSafety[0][2])) {
            return fail('private_chat_realistic_delivery_consent_changed');
        }
        if (realistic.待投递消息[0]?.批次UID.includes('_proactive_') && !isActiveNsfwConsent(consent.value)) {
            return fail('private_chat_realistic_delivery_consent_changed');
        }
    }
    const due = realistic.待投递消息.filter((message) => isPhoneTimestampDue(message.时间, phoneTime));
    if (!due.length) return fail('private_chat_realistic_no_due_messages');
    const recent = session.最近消息;
    const operations = [];
    const trimmed = appendSummarySafeTrimOperations(sessionUid, session, recent, due.length, operations);
    if (!trimmed.ok) return trimmed;
    appendRealisticMarkerRepairAfterTrim(sessionUid, recent, realistic, trimmed.value.overflow, operations);
    for (let index = realistic.待投递消息.length - 1; index >= 0; index -= 1) {
        if (isPhoneTimestampDue(realistic.待投递消息[index].时间, phoneTime)) operations.push({
            op: 'remove', path: encodeJsonPointer(['会话', sessionUid, '拟真聊天', '待投递消息', String(index)]),
        });
    }
    let nextLayer = knownConversationLayer(session, recent);
    for (const message of due) {
        if (message.发送者 !== '系统') nextLayer += 1;
        if (nextLayer > 999999) return fail('private_chat_dialogue_layer_exhausted');
        operations.push({
            op: 'add', path: encodeJsonPointer(['会话', sessionUid, '最近消息', '-']),
            value: { ...chatMessage(message.发送者, message.消息UID, message.内容, message.时间), 层数: nextLayer },
        });
    }
    operations.push({ op: 'add', path: encodeJsonPointer(['会话', sessionUid, '对话层数']), value: nextLayer });
    return success({
        patch: operations,
        deliveredMessageUids: due.map((message) => message.消息UID),
        summaryCheckRequested: due.some((message) => message.发送者 === '角色'),
    });
}

function summarySessionTarget(state, sessionUid, npcUid) {
    if (!ownRecord(state) || !isChatSessionUid(sessionUid) || !isNpcUid(npcUid)) return fail('chat_summary_invalid_target');
    const session = ownRecord(ownRecord(state.会话)?.[sessionUid]);
    const adult = assertKnownAdult(state, npcUid);
    if (!session || !adult.ok || adult.value.location !== 'role' || session.对象UID !== npcUid) {
        return fail(adult.ok ? 'chat_summary_session_not_found' : adult.code);
    }
    if (!Array.isArray(session.最近消息) || session.最近消息.length > MAX_CHAT_HISTORY_MESSAGES) return fail('chat_summary_session_messages_invalid');
    if (session.总结 !== undefined && !ownRecord(session.总结)) return fail('chat_summary_state_invalid');
    if (session.总结?.记录 !== undefined && !Array.isArray(session.总结.记录)) return fail('chat_summary_state_invalid');
    return success({ session, role: adult.value.profile });
}

function validSummaryAttemptCount(value) {
    return Number.isInteger(value) && value >= 1 && value <= 6;
}

function validSourceMessageUids(value) {
    return Array.isArray(value) && value.length > 0 && value.length <= MAX_CHAT_HISTORY_MESSAGES
        && value.every((uid) => typeof uid === 'string' && uid.length > 0 && uid.length <= 80)
        && new Set(value).size === value.length;
}

function resolveSummarySource(session, sourceMessageUids, summaryUid) {
    if (!validSourceMessageUids(sourceMessageUids)) return fail('chat_summary_source_invalid');
    if (summaryUid) {
        const historical = summaryRecordSource(session, summaryUid);
        if (!historical.ok) return fail(historical.code);
        const expected = historical.messages.map((message) => message.uid);
        if (expected.length !== sourceMessageUids.length || expected.some((uid, index) => uid !== sourceMessageUids[index])) {
            return fail('chat_summary_source_changed');
        }
        return success({ messages: historical.messages, record: historical.record });
    }
    const pending = listUnsummarizedConversationMessages(session);
    if (pending.length < sourceMessageUids.length || sourceMessageUids.some((uid, index) => pending[index]?.uid !== uid)) {
        return fail('chat_summary_source_changed');
    }
    return success({ messages: Object.freeze(pending.slice(0, sourceMessageUids.length)), record: null });
}

function summaryStateValue({ state, records, status, failureReason = '', targetSummaryUid = '', attempts }) {
    return {
        已总结消息UID: state.lastMessageUid,
        总结序号: state.sequence,
        记录: records.map((record) => ({
            总结UID: record.uid,
            起始消息UID: record.startMessageUid,
            结束消息UID: record.endMessageUid,
            起始层数: record.startLayer,
            结束层数: record.endLayer,
            内容: record.content,
            时间: record.time,
        })),
        状态: status,
        失败原因: failureReason,
        目标总结UID: targetSummaryUid,
        尝试次数: attempts,
    };
}

function isControlledConversationSummary(value) {
    if (!ownRecord(value)) return false;
    const keys = Object.keys(value).sort();
    const expectedKeys = ['已总结消息UID', '总结序号', '记录', '状态', '失败原因', '目标总结UID', '尝试次数'].sort();
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return false;
    const normalized = normalizeConversationSummaryState({ 总结: value });
    const canonical = summaryStateValue({
        state: normalized,
        records: normalized.records,
        status: normalized.status,
        failureReason: normalized.status === '失败' ? normalized.failureReason : '',
        targetSummaryUid: normalized.status === '失败' ? normalized.targetSummaryUid : '',
        attempts: normalized.attempts,
    });
    return JSON.stringify(canonical) === JSON.stringify(value);
}

/**
 * Stores one validated LLM summary (or replaces a chosen record) through the
 * same controlled Patch boundary. The source message IDs must be the exact
 * current prefix so late model responses cannot summarize or erase new text.
 */
export function buildPrivateChatSummaryPatch(state, { sessionUid, npcUid, summary, sourceMessageUids, summaryUid = '', attempts = 1 } = {}) {
    const target = summarySessionTarget(state, sessionUid, npcUid);
    if (!target.ok) return target;
    if (!validSummaryAttemptCount(attempts)) return fail('chat_summary_attempts_invalid');
    const normalizedSummary = normalizeGeneratedConversationSummary({ summary });
    if (!normalizedSummary) return fail('chat_summary_content_invalid');
    const source = resolveSummarySource(target.value.session, sourceMessageUids, summaryUid);
    if (!source.ok) return source;

    const current = normalizeConversationSummaryState(target.value.session);
    const records = [...current.records];
    let record;
    let nextState;
    if (summaryUid) {
        const index = records.findIndex((item) => item.uid === summaryUid);
        if (index < 0) return fail('chat_summary_record_not_found');
        record = { ...records[index], content: normalizedSummary };
        records[index] = record;
        nextState = summaryStateValue({ state: current, records, status: '成功', attempts });
    } else {
        const sourceMessages = source.value.messages;
        const nextSequence = Math.max(current.sequence, records.length) + 1;
        const nextUid = `summary_${nextSequence}`;
        if (records.some((item) => item.uid === nextUid)) return fail('chat_summary_uid_conflict');
        record = {
            uid: nextUid,
            startMessageUid: sourceMessages[0].uid,
            endMessageUid: sourceMessages.at(-1).uid,
            startLayer: sourceMessages[0].layer,
            endLayer: sourceMessages.at(-1).layer,
            content: normalizedSummary,
            time: '',
        };
        const nextRecords = [...records, record].slice(-MAX_CHAT_SUMMARY_RECORDS);
        nextState = summaryStateValue({
            state: { ...current, lastMessageUid: record.endMessageUid, sequence: nextSequence },
            records: nextRecords,
            status: '成功',
            attempts,
        });
    }
    return success({
        patch: [{ op: 'add', path: encodeJsonPointer(['会话', sessionUid, '总结']), value: nextState }],
        summaryUid: record.uid,
        remainingMessageCount: summaryUid ? listUnsummarizedConversationMessages(target.value.session).length
            : listUnsummarizedConversationMessages({ ...target.value.session, 总结: nextState }).length,
        remainingLayerCount: summaryUid ? countUnsummarizedConversationLayers(target.value.session)
            : countUnsummarizedConversationLayers({ ...target.value.session, 总结: nextState }),
    });
}

/** Persists a public-safe failure state so the user can retry from chat history. */
export function buildPrivateChatSummaryFailurePatch(state, { sessionUid, npcUid, reason, summaryUid = '', attempts = 1 } = {}) {
    const target = summarySessionTarget(state, sessionUid, npcUid);
    if (!target.ok) return target;
    if (!validSummaryAttemptCount(attempts)) return fail('chat_summary_attempts_invalid');
    const current = normalizeConversationSummaryState(target.value.session);
    if (summaryUid && !current.records.some((record) => record.uid === summaryUid)) return fail('chat_summary_record_not_found');
    const nextState = summaryStateValue({
        state: current,
        records: current.records,
        status: '失败',
        failureReason: normalizeConversationSummaryFailure(reason),
        targetSummaryUid: summaryUid,
        attempts,
    });
    return success({
        patch: [{ op: 'add', path: encodeJsonPointer(['会话', sessionUid, '总结']), value: nextState }],
        summaryUid,
    });
}

/** Clears one visible chat session without deleting its character profile. */
export function buildClearPrivateChatPatch(state, { sessionUid } = {}) {
    if (!ownRecord(state) || !isChatSessionUid(sessionUid)) return fail('private_chat_delete_invalid_target');
    const session = ownRecord(ownRecord(state.会话)?.[sessionUid]);
    const npcUid = session?.对象UID;
    const role = isNpcUid(npcUid) ? roleAt(state, npcUid) : null;
    const relationship = ownRecord(role?.与玩家关系);
    if (!session || !role || !relationship) return fail('private_chat_delete_not_found');
    if (!['已匹配', '已取消', '已拉黑'].includes(session.状态) || !['已匹配', '已取消', '已拉黑'].includes(relationship.状态)) return fail('private_chat_delete_state_invalid');
    const operations = [{ op: 'remove', path: encodeJsonPointer(['会话', sessionUid]) }];
    if (session.状态 === '已匹配' && relationship.状态 === '已匹配') operations.push({ op: 'replace', path: encodeJsonPointer(['角色池', npcUid, '与玩家关系', '状态']), value: '已取消' });
    else if (session.状态 !== relationship.状态) return fail('private_chat_delete_state_invalid');
    return success(operations);
}


function validUidList(value) {
    return Array.isArray(value) && value.every(isNpcUid) && new Set(value).size === value.length;
}

function addFilteredListReplacement(state, listName, npcUid, operations) {
    const list = arrayAt(state, listName);
    if (!validUidList(list)) return fail('character_delete_recommendation_state_invalid', listName);
    if (list.includes(npcUid)) {
        operations.push({
            op: 'replace',
            path: encodeJsonPointer(['推荐', listName]),
            value: list.filter((uid) => uid !== npcUid),
        });
    }
    return success(undefined);
}

/**
 * Deletes a character and every controlled reference to that character. The
 * builder rejects malformed containers instead of emitting a partial cleanup.
 * Counters are intentionally not decremented, so stale UIDs cannot be reused.
 */
export function buildDeleteCharacterPatch(state, { npcUid } = {}) {
    if (!ownRecord(state) || !isNpcUid(npcUid)) return fail('character_delete_invalid_target');

    const rolePool = ownRecord(state.角色池);
    const recommendation = ownRecord(state.推荐);
    const candidatePool = ownRecord(recommendation?.临时候选池);
    const sessions = ownRecord(state.会话);
    const meetups = ownRecord(state.面基记录);
    const groups = ownRecord(state.群组);
    const storyMemories = ownRecord(state.正文记忆);
    const bodyCandidates = ownRecord(state.正文关系候选);
    const narratives = ownRecord(state.关系叙事);
    if (!rolePool || !recommendation || !candidatePool || !sessions || !meetups || !groups || !storyMemories || !bodyCandidates || !narratives) {
        return fail('character_delete_state_invalid');
    }
    if (!Object.hasOwn(rolePool, npcUid) && !Object.hasOwn(candidatePool, npcUid)) {
        return fail('character_delete_not_found');
    }

    const operations = [];
    for (const listName of ['当前队列', '冷却角色UID', '收藏角色UID', '不喜欢角色UID', '拉黑角色UID']) {
        const cleaned = addFilteredListReplacement(state, listName, npcUid, operations);
        if (!cleaned.ok) return cleaned;
    }

    for (const sessionUid of Object.keys(sessions).sort()) {
        const session = sessions[sessionUid];
        if (ownRecord(session) && session.对象UID === npcUid) {
            if (!isChatSessionUid(sessionUid)) return fail('character_delete_session_uid_invalid', sessionUid);
            operations.push({ op: 'remove', path: encodeJsonPointer(['会话', sessionUid]) });
        }
    }

    for (const meetupUid of Object.keys(meetups).sort()) {
        const record = meetups[meetupUid];
        if (ownRecord(record) && record.对象UID === npcUid) {
            if (!isMeetupUid(meetupUid)) return fail('character_delete_meetup_uid_invalid', meetupUid);
            operations.push({ op: 'remove', path: encodeJsonPointer(['面基记录', meetupUid]) });
        }
    }

    for (const groupUid of Object.keys(groups).sort()) {
        const group = groups[groupUid];
        if (!isGroupUid(groupUid) || !ownRecord(group)
            || !validUidList(group.成员UID) || !validUidList(group.可发现角色UID)) {
            return fail('character_delete_group_state_invalid', groupUid);
        }
        if (group.成员UID.includes(npcUid)) {
            operations.push({
                op: 'replace', path: encodeJsonPointer(['群组', groupUid, '成员UID']),
                value: group.成员UID.filter((uid) => uid !== npcUid),
            });
        }
        if (group.可发现角色UID.includes(npcUid)) {
            operations.push({
                op: 'replace', path: encodeJsonPointer(['群组', groupUid, '可发现角色UID']),
                value: group.可发现角色UID.filter((uid) => uid !== npcUid),
            });
        }
    }

    if (Object.hasOwn(candidatePool, npcUid)) {
        operations.push({ op: 'remove', path: encodeJsonPointer(['推荐', '临时候选池', npcUid]) });
    }
    if (Object.hasOwn(rolePool, npcUid)) {
        if (!Object.hasOwn(storyMemories, npcUid)) return fail('mvu_story_memory_schema_outdated');
        if (!Object.hasOwn(narratives, npcUid) || !validateRelationshipNarrative(narratives[npcUid]).ok) {
            return fail('mvu_relationship_narrative_schema_outdated');
        }
        if (!Object.hasOwn(bodyCandidates, npcUid) || !validateBodyRelationshipCandidate(bodyCandidates[npcUid]).ok) {
            return fail('mvu_body_relationship_candidate_schema_outdated');
        }
        operations.push({ op: 'remove', path: encodeJsonPointer(['正文记忆', npcUid]) });
        operations.push({ op: 'remove', path: encodeJsonPointer(['正文关系候选', npcUid]) });
        operations.push({ op: 'remove', path: encodeJsonPointer(['关系叙事', npcUid]) });
        operations.push({ op: 'remove', path: encodeJsonPointer(['角色池', npcUid]) });
    }
    if (operations.length === 0) return fail('character_delete_not_found');
    return success(operations);
}

const MEETUP_FIELDS = Object.freeze([
    ['time', '时间', 160, true],
    ['place', '地点', 160, true],
    ['mutualIntent', '双方意图', 500, true],
    ['confirmedBoundaries', '已确认边界', 1200, true],
    ['pendingItems', '待确认事项', 800, false],
    ['riskNotice', '风险提示', 800, false],
]);

function normalizeMeetupText(value, maxLength, required) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    if ((required && !normalized) || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized) || /[<>]/u.test(normalized)) return null;
    return normalized;
}

function meetupDraft({ nickname, route, time, place, mutualIntent, confirmedBoundaries, pendingItems, riskNotice }) {
    const subject = normalizeMeetupText(nickname, 80, false) || '该匹配对象';
    const details = [
        `与${subject}角色约定面基（必须查询并且遵循该角色的公开资料、已确认边界与会话总结；不得推断或泄露非公开资料）。`,
        `对象：${subject}`,
        `关系路线：${route}`,
        meetupRouteGuidance(route),
        `时间：${time}`,
        `地点：${place}`,
        `双方意图：${mutualIntent}`,
        `已确认边界：${confirmedBoundaries}`,
    ];
    if (pendingItems) details.push(`待确认事项：${pendingItems}`);
    if (riskNotice) details.push(`风险提示：${riskNotice}`);
    details.push('可选事件方向：日常验证 / 旧地重返 / 技能共作 / 社交压力 / 心愿试运行；只选择与角色已公开资料、当前意愿和已确认边界一致的一项。');
    return `【现实面基行动草稿】\n${details.join('\n')}\n请在正文中从双方抵达前的现实场景开始推进；尊重已确认边界，未确认事项须先沟通确认。`;
}

/**
 * Creates an adult-only, matched-session meetup record and the separate text
 * draft for the user to send to the host. The returned draft is not part of
 * MVU state and this function never dispatches a host send action.
 */
export function buildMeetupHandoffPatch(state, request = {}) {
    if (!ownRecord(state) || !ownRecord(request)) return fail('meetup_invalid_command');
    const { sessionUid, npcUid } = request;
    if (!isChatSessionUid(sessionUid) || !isNpcUid(npcUid)) return fail('meetup_invalid_target');
    const profile = roleAt(state, npcUid);
    const hidden = ownRecord(profile?.隐藏资料);
    if (!profile) return fail('npc_not_found');
    if (profile.成人验证 !== true || !Number.isInteger(hidden?.实际年龄) || hidden.实际年龄 < 18) {
        return fail('npc_adult_verification_failed');
    }
    const player = ownRecord(state.玩家);
    const relationship = ownRecord(roleAt(state, npcUid)?.与玩家关系);
    const session = ownRecord(ownRecord(state.会话)?.[sessionUid]);
    const narrative = validateRelationshipNarrative(ownRecord(ownRecord(state.关系叙事)?.[npcUid]));
    if (!narrative.ok) return fail('mvu_relationship_narrative_schema_outdated');
    const meetupCounter = ownRecord(state.系统)?.UID计数器?.面基;
    if (player?.成人验证 !== true || !relationship || relationship.状态 !== '已匹配'
        || !session || session.对象UID !== npcUid || session.状态 !== '已匹配'
        || !Number.isInteger(meetupCounter) || meetupCounter < 0 || meetupCounter >= 999999) {
        return fail('meetup_preconditions_not_met');
    }
    const mode = currentContentMode(state);
    const consent = mode === 'NSFW' ? validateNsfwConsent(session.NSFW同意) : success(createEmptyNsfwConsent());
    if (!consent.ok) return fail('private_chat_nsfw_consent_schema_outdated');
    const meetupAccess = deriveMeetupAccess({
        contentMode: mode,
        relationship,
        progress: narrative.value.进程,
        nsfwConsent: consent.value,
    });
    if (!meetupAccess.unlocked) {
        const codes = {
            relationship_ended: 'meetup_relationship_ended',
            relationship_paused: 'meetup_relationship_paused',
            only_sfw: 'meetup_nsfw_only_sfw',
            nsfw_consent_required: 'meetup_nsfw_consent_required',
            nsfw_direction_unconfirmed: 'meetup_nsfw_direction_unconfirmed',
        };
        return fail(codes[meetupAccess.reason] ?? 'meetup_relationship_threshold_not_met');
    }
    if (listUnsummarizedConversationMessages(session).length > 0) {
        return fail('meetup_summary_required');
    }
    const values = {};
    for (const [inputName, storedName, maxLength, required] of MEETUP_FIELDS) {
        const value = normalizeMeetupText(request[inputName] ?? '', maxLength, required);
        if (value === null) return fail(`meetup_${inputName}_invalid`);
        values[storedName] = value;
    }
    const meetupUid = `meetup_${meetupCounter + 1}`;
    if (!isMeetupUid(meetupUid) || ownRecord(state.面基记录)?.[meetupUid]) return fail('meetup_uid_conflict');
    const record = {
        对象UID: npcUid,
        关系路线: meetupAccess.route,
        时间: values.时间,
        地点: values.地点,
        双方意图: values.双方意图,
        已确认边界: values.已确认边界,
        待确认事项: values.待确认事项,
        风险提示: values.风险提示,
        状态: '待发送',
        正文结果摘要: '',
    };
    const nickname = ownRecord(profile.公开资料)?.昵称;
    return success({
        meetupUid,
        patch: [
            { op: 'add', path: encodeJsonPointer(['面基记录', meetupUid]), value: record },
            { op: 'replace', path: encodeJsonPointer(['系统', 'UID计数器', '面基']), value: meetupCounter + 1 },
        ],
        route: meetupAccess.route,
        draft: meetupDraft({ nickname, route: meetupAccess.route, time: values.时间, place: values.地点, mutualIntent: values.双方意图, confirmedBoundaries: values.已确认边界, pendingItems: values.待确认事项, riskNotice: values.风险提示 }),
    });
}

function promoteCandidateIfNeeded(state, uid, operations) {
    const candidate = candidateAt(state, uid);
    if (!candidate) return success('role');
    if (roleAt(state, uid)) return fail('duplicate_npc_uid');
    operations.push({
        op: 'move',
        from: encodeJsonPointer(['推荐', '临时候选池', uid]),
        path: encodeJsonPointer(['角色池', uid]),
    });
    const memory = appendEmptyStoryMemory(state, uid, operations);
    if (!memory.ok) return memory;
    const narrative = appendRelationshipNarrative(state, uid, candidate, operations);
    if (!narrative.ok) return narrative;
    const bodyCandidate = appendEmptyBodyRelationshipCandidate(state, uid, operations);
    if (!bodyCandidate.ok) return bodyCandidate;
    return success('candidate');
}

function hasSessionForNpc(state, npcUid) {
    const sessions = ownRecord(state.会话);
    return Boolean(sessions && Object.values(sessions).some((session) => ownRecord(session) && session.对象UID === npcUid));
}

function matchedSession(npcUid) {
    return {
        对象UID: npcUid,
        状态: '已匹配',
        最近消息: [],
        对话层数: 0,
        总结: {
            已总结消息UID: '',
            总结序号: 0,
            记录: [],
            状态: '空闲',
            失败原因: '',
            目标总结UID: '',
            尝试次数: 0,
        },
        已确认边界: '',
        已确认承诺: '',
        NSFW同意: createEmptyNsfwConsent(),
        拟真聊天: createDefaultRealisticChatState(),
    };
}

function matchCandidateForRole(candidate, contentMode, relationshipStatus = '已匹配') {
    if (!['已匹配', '已取消'].includes(relationshipStatus)) throw new TypeError('match_candidate_state_invalid');
    const normalized = normalizeGeneratedCandidate(candidate, { requirePersonalName: true, contentMode });
    return { ...normalized, 与玩家关系: { ...normalized.与玩家关系, 状态: relationshipStatus } };
}

function matchCandidateSourceFromRole(candidate) {
    if (!ownRecord(candidate) || !ownRecord(candidate.与玩家关系) || !['已匹配', '已取消'].includes(candidate.与玩家关系.状态)) throw new TypeError('match_candidate_state_invalid');
    return { ...candidate, 与玩家关系: { ...candidate.与玩家关系, 状态: '陌生' } };
}

function forumCandidateForRole(candidate, contentMode) {
    const normalized = normalizeGeneratedCandidate(candidate, {
        contentMode,
        enforceRhythmConsistency: true,
    });
    return { ...normalized, 与玩家关系: { ...normalized.与玩家关系, 状态: '已匹配' } };
}

function forumCandidateSourceFromRole(candidate) {
    if (!ownRecord(candidate) || !ownRecord(candidate.与玩家关系) || candidate.与玩家关系.状态 !== '已匹配') {
        throw new TypeError('forum_private_chat_candidate_state_invalid');
    }
    return { ...candidate, 与玩家关系: { ...candidate.与玩家关系, 状态: '陌生' } };
}

/** Commits one locally scored candidate outcome. Declines never create a chat session. */
export function buildCandidateMatchOutcomePatch(state, { candidate, accepted } = {}) {
    if (!ownRecord(state) || typeof accepted !== 'boolean') return fail('candidate_match_state_invalid');
    const rolePool = ownRecord(state.角色池);
    const sessions = ownRecord(state.会话);
    const counters = ownRecord(state.系统)?.UID计数器;
    const roleCounter = counters?.角色;
    const sessionCounter = counters?.会话;
    const contentMode = ownRecord(state.软件)?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW';
    if (!rolePool || !sessions || !Number.isInteger(roleCounter) || roleCounter < 0 || roleCounter >= 999999 || !Number.isInteger(sessionCounter) || sessionCounter < 0 || sessionCounter >= 999999) return fail('candidate_match_state_invalid');
    let materialized;
    try { materialized = matchCandidateForRole(candidate, contentMode, accepted ? '已匹配' : '已取消'); }
    catch { return fail('candidate_match_candidate_invalid'); }
    const npcUid = 'npc_match_' + (roleCounter + 1);
    if (!isNpcUid(npcUid) || roleAt(state, npcUid) || candidateAt(state, npcUid)) return fail('candidate_match_uid_conflict');
    const operations = [{ op: 'add', path: encodeJsonPointer(['角色池', npcUid]), value: materialized }];
    const memory = appendEmptyStoryMemory(state, npcUid, operations);
    if (!memory.ok) return memory;
    const narrative = appendRelationshipNarrative(state, npcUid, materialized, operations);
    if (!narrative.ok) return narrative;
    const bodyCandidate = appendEmptyBodyRelationshipCandidate(state, npcUid, operations);
    if (!bodyCandidate.ok) return bodyCandidate;
    let sessionUid = '';
    if (accepted) {
        sessionUid = 'chat_' + (sessionCounter + 1);
        if (!isChatSessionUid(sessionUid) || sessions[sessionUid]) return fail('candidate_match_uid_conflict');
        operations.push({ op: 'add', path: encodeJsonPointer(['会话', sessionUid]), value: matchedSession(npcUid) });
    }
    operations.push({ op: 'replace', path: encodeJsonPointer(['系统', 'UID计数器', '角色']), value: roleCounter + 1 });
    if (accepted) operations.push({ op: 'replace', path: encodeJsonPointer(['系统', 'UID计数器', '会话']), value: sessionCounter + 1 });
    return success(operations);
}

export function buildCandidateMatchSessionPatch(state, { candidate } = {}) {
    return buildCandidateMatchOutcomePatch(state, { candidate, accepted: true });
}

/**
 * Materializes one validated adult forum participant and establishes their first
 * private-chat session. Forum handles may be stylized, so this path deliberately
 * skips the personal-name heuristic while retaining the complete candidate,
 * hidden-profile, adult and generated-threshold validation gates.
 */
export function buildForumPrivateChatSessionPatch(state, { candidate } = {}) {
    if (!ownRecord(state)) return fail('forum_private_chat_state_invalid');
    const rolePool = ownRecord(state.角色池);
    const sessions = ownRecord(state.会话);
    const counters = ownRecord(state.系统)?.UID计数器;
    const roleCounter = counters?.角色;
    const sessionCounter = counters?.会话;
    const contentMode = ownRecord(state.软件)?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW';
    if (!rolePool || !sessions
        || !Number.isInteger(roleCounter) || roleCounter < 0 || roleCounter >= 999999
        || !Number.isInteger(sessionCounter) || sessionCounter < 0 || sessionCounter >= 999999) {
        return fail('forum_private_chat_state_invalid');
    }

    let materialized;
    try { materialized = forumCandidateForRole(candidate, contentMode); }
    catch (error) {
        return fail('forum_private_chat_candidate_invalid', '', candidateValidationReason(error, '论坛角色'));
    }

    const npcUid = `npc_forum_${roleCounter + 1}`;
    const sessionUid = `chat_${sessionCounter + 1}`;
    if (!isNpcUid(npcUid) || roleAt(state, npcUid) || candidateAt(state, npcUid)
        || !isChatSessionUid(sessionUid) || sessions[sessionUid]) {
        return fail('forum_private_chat_uid_conflict');
    }

    const operations = [{ op: 'add', path: encodeJsonPointer(['角色池', npcUid]), value: materialized }];
    const memory = appendEmptyStoryMemory(state, npcUid, operations);
    if (!memory.ok) return memory;
    const narrative = appendRelationshipNarrative(state, npcUid, materialized, operations);
    if (!narrative.ok) return narrative;
    const bodyCandidate = appendEmptyBodyRelationshipCandidate(state, npcUid, operations);
    if (!bodyCandidate.ok) return bodyCandidate;
    operations.push({ op: 'add', path: encodeJsonPointer(['会话', sessionUid]), value: matchedSession(npcUid) });
    operations.push({ op: 'replace', path: encodeJsonPointer(['系统', 'UID计数器', '角色']), value: roleCounter + 1 });
    operations.push({ op: 'replace', path: encodeJsonPointer(['系统', 'UID计数器', '会话']), value: sessionCounter + 1 });
    return success(operations);
}

/** Promotes one existing authored candidate and establishes its first matched session. */
export function buildCustomCandidateMatchPatch(state, { candidateUid, matchScore } = {}) {
    if (!ownRecord(state) || !/^npc_custom_\d+$/u.test(candidateUid)
        || !Number.isInteger(matchScore) || matchScore < MATCH_ACCEPTANCE_THRESHOLD || matchScore > 100) {
        return fail('custom_candidate_match_invalid_command');
    }
    const candidate = assertKnownAdult(state, candidateUid);
    const rolePool = ownRecord(state.角色池);
    const sessions = ownRecord(state.会话);
    const queue = arrayAt(state, '当前队列');
    const sessionCounter = ownRecord(state.系统)?.UID计数器?.会话;
    if (!candidate.ok || candidate.value.location !== 'candidate' || !rolePool || !sessions || !queue
        || !Number.isInteger(sessionCounter) || sessionCounter < 0 || sessionCounter >= 999999) {
        return fail('custom_candidate_match_state_invalid');
    }
    const sessionUid = `chat_${sessionCounter + 1}`;
    if (!isChatSessionUid(sessionUid) || sessions[sessionUid] || rolePool[candidateUid]) return fail('custom_candidate_match_uid_conflict');
    const operations = [];
    const queueIndex = queue.indexOf(candidateUid);
    if (queueIndex >= 0) operations.push({ op: 'remove', path: encodeJsonPointer(['推荐', '当前队列', String(queueIndex)]) });
    operations.push({
        op: 'move',
        from: encodeJsonPointer(['推荐', '临时候选池', candidateUid]),
        path: encodeJsonPointer(['角色池', candidateUid]),
    });
    const memory = appendEmptyStoryMemory(state, candidateUid, operations);
    if (!memory.ok) return memory;
    const narrative = appendRelationshipNarrative(state, candidateUid, candidate.value.profile, operations);
    if (!narrative.ok) return narrative;
    const bodyCandidate = appendEmptyBodyRelationshipCandidate(state, candidateUid, operations);
    if (!bodyCandidate.ok) return bodyCandidate;
    operations.push({ op: 'replace', path: encodeJsonPointer(['角色池', candidateUid, '与玩家关系', 'NPC专属匹配度']), value: matchScore });
    operations.push({ op: 'replace', path: encodeJsonPointer(['角色池', candidateUid, '与玩家关系', '状态']), value: '已匹配' });
    operations.push({ op: 'add', path: encodeJsonPointer(['会话', sessionUid]), value: matchedSession(candidateUid) });
    operations.push({ op: 'replace', path: encodeJsonPointer(['系统', 'UID计数器', '会话']), value: sessionCounter + 1 });
    return success(operations);
}

const PREFERENCE_TAG_FIELDS = Object.freeze(['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']);

function publicTagsForPreference(profile) {
    const publicProfile = ownRecord(profile?.公开资料);
    if (!publicProfile) return null;
    const tags = [];
    for (const field of PREFERENCE_TAG_FIELDS) {
        const values = publicProfile[field];
        if (!Array.isArray(values)) continue;
        for (const tag of values) {
            if (typeof tag !== 'string' || tag.length === 0 || tag.length > 64 || tag !== tag.trim() || /[\u0000-\u001f\u007f]/u.test(tag)) return null;
            if (!tags.includes(tag)) tags.push(tag);
        }
    }
    return tags;
}

function currentContentMode(state) {
    return ownRecord(state.软件)?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW';
}

function currentPreferenceWeights(state) {
    const byMode = ownRecord(ownRecord(ownRecord(state.玩家)?.推荐偏好)?.标签权重);
    return ownRecord(byMode?.[currentContentMode(state)]);
}

/** Adds only locally derived public-tag preference writes to an existing Patch. */
function appendPreferenceWeightOperations(state, profile, delta, operations) {
    const mode = currentContentMode(state);
    const weights = currentPreferenceWeights(state);
    const tags = publicTagsForPreference(profile);
    if (!ownRecord(weights) || !tags || !Number.isInteger(delta)) return fail('preference_weight_state_invalid');
    for (const tag of tags) {
        const exists = Object.hasOwn(weights, tag);
        const current = exists ? weights[tag] : 0;
        if (!Number.isInteger(current) || current < -5 || current > 5) return fail('preference_weight_state_invalid');
        const next = clamp(current + delta, -5, 5);
        if (next === current) continue;
        operations.push({
            op: exists ? 'replace' : 'add',
            path: encodeJsonPointer(['玩家', '推荐偏好', '标签权重', mode, tag]),
            value: next,
        });
    }
    return success(undefined);
}

/**
 * Records a homepage “喜欢” purely as recommendation feedback.  It does not
 * create a relationship, a matched session, or a role-pool entry; saving a
 * person is the separate 收藏 action and mutual matching belongs to the
 * dedicated AI matching tools.
 */
export function buildLikeMatchPatch(state, { npcUid } = {}) {
    if (!ownRecord(state) || !isNpcUid(npcUid)) return fail('like_preference_invalid_command');
    const adult = assertKnownAdult(state, npcUid);
    if (!adult.ok) return adult;
    const profile = adult.value.profile;
    const relation = ownRecord(profile.与玩家关系);
    const queue = arrayAt(state, '当前队列');
    if (!relation || !queue) return fail('like_preference_state_invalid');
    if (profile.成人验证 !== true || relation.状态 !== '陌生') return fail('npc_not_available_for_like');
    if (!queue.includes(npcUid)) return fail('like_preference_source_not_available');

    const operations = [];
    const cooled = addUidOnce(state, '冷却角色UID', npcUid, operations);
    if (!cooled.ok) return cooled;
    const removed = removeUidFromQueue(state, npcUid, operations);
    if (!removed.ok) return removed;
    const preference = appendPreferenceWeightOperations(state, profile, 3, operations);
    if (!preference.ok) return preference;
    return success(operations);
}

/** Moves a saved candidate into an immediately usable private-chat session. */
export function buildFavoritePrivateChatPatch(state, { npcUid } = {}) {
    if (!ownRecord(state) || !isNpcUid(npcUid)) return fail('favorite_private_chat_invalid_command');
    const adult = assertKnownAdult(state, npcUid);
    if (!adult.ok) return adult;
    if (adult.value.location !== 'role') return fail('favorite_private_chat_source_invalid');
    const favorites = arrayAt(state, '收藏角色UID');
    const relationship = ownRecord(adult.value.profile.与玩家关系);
    const playerPublic = ownRecord(ownRecord(state.玩家)?.公开资料);
    const weights = currentPreferenceWeights(state);
    const npcPublic = ownRecord(adult.value.profile.公开资料);
    const refusalThreshold = adult.value.profile.拒绝阈值;
    const sessionCounter = ownRecord(state.系统)?.UID计数器?.会话;
    if (!favorites || !relationship || !playerPublic || !weights || !npcPublic
        || !Number.isInteger(refusalThreshold) || refusalThreshold < 0 || refusalThreshold > 100
        || !Number.isInteger(sessionCounter) || sessionCounter < 0 || sessionCounter >= 999999) {
        return fail('favorite_private_chat_state_invalid');
    }
    const favoriteIndex = favorites.indexOf(npcUid);
    if (favoriteIndex < 0) return fail('favorite_private_chat_not_favorited');
    if (relationship.状态 !== '陌生' || hasSessionForNpc(state, npcUid)) return fail('favorite_private_chat_already_started');
    const invitation = scoreFavoritePrivateChatInvitation(playerPublic, npcPublic, weights);
    if (!invitation || !Number.isInteger(invitation.score) || invitation.score < 0 || invitation.score > 100) {
        return fail('favorite_private_chat_score_invalid');
    }
    // 收藏主动私聊与灵魂/描述匹配共用偏宽松的接受线；角色更低的
    // 自定义阈值仍可生效，但高挑阈值不再让普通兼容邀请几乎必拒。
    const acceptanceThreshold = Math.min(refusalThreshold, MATCH_ACCEPTANCE_THRESHOLD);
    const accepted = invitation.eligible && invitation.score >= acceptanceThreshold;
    const operations = [
        { op: 'remove', path: encodeJsonPointer(['推荐', '收藏角色UID', String(favoriteIndex)]) },
        { op: 'replace', path: encodeJsonPointer(['角色池', npcUid, '与玩家关系', 'NPC专属匹配度']), value: invitation.score },
        { op: 'replace', path: encodeJsonPointer(['角色池', npcUid, '与玩家关系', '状态']), value: accepted ? '已匹配' : '已取消' },
    ];
    if (!accepted) return success(operations);
    const sessionUid = `chat_${sessionCounter + 1}`;
    if (!isChatSessionUid(sessionUid) || ownRecord(state.会话)?.[sessionUid]) return fail('favorite_private_chat_uid_conflict');
    operations.push(
        { op: 'add', path: encodeJsonPointer(['会话', sessionUid]), value: matchedSession(npcUid) },
        { op: 'replace', path: encodeJsonPointer(['系统', 'UID计数器', '会话']), value: sessionCounter + 1 },
    );
    return success(operations);
}

/**
 * Converts model-independent UI intent to a narrow, state-aware JSONPatch list.
 * It never accepts a caller-supplied path or arbitrary value.
 *
 * @param {unknown} state stat_data only, not the outer MvuData envelope
 * @param {unknown} command
 */
export function buildControlledPatch(state, command) {
    if (!ownRecord(state) || !ownRecord(command) || typeof command.kind !== 'string') {
        return fail('invalid_command');
    }

    if (command.kind === 'advance_content_mode_gate') {
        const software = ownRecord(state.软件);
        const clicks = software?.关于软件点击数;
        const mode = software?.内容模式;
        if (!Number.isInteger(clicks) || clicks < 0 || clicks > 4 || !['SFW', 'NSFW'].includes(mode)) {
            return fail('content_mode_gate_state_invalid');
        }
        return success([
            { op: 'replace', path: '/软件/关于软件点击数', value: clicks < 4 ? clicks + 1 : 0 },
        ]);
    }

    if (command.kind === 'toggle_content_mode') {
        const software = ownRecord(state.软件);
        const mode = software?.内容模式;
        if (!['SFW', 'NSFW'].includes(mode)) {
            return fail('content_mode_gate_state_invalid');
        }
        const operations = [
            { op: 'replace', path: '/软件/内容模式', value: mode === 'SFW' ? 'NSFW' : 'SFW' },
        ];
        // Leaving NSFW is itself an explicit global safety action. Every prior
        // non-empty consent epoch is advanced, including an already expired or
        // withdrawn record, so an unseen timed reply can never survive a quick
        // SFW -> NSFW round trip on the same revision.
        if (mode === 'NSFW') {
            for (const [sessionUid, session] of Object.entries(ownRecord(state.会话) ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
                if (!isChatSessionUid(sessionUid) || !ownRecord(session) || !Object.hasOwn(session, 'NSFW同意')) continue;
                const consent = validateNsfwConsent(session.NSFW同意);
                const next = consent.ok && consent.value.状态 !== '未确认'
                    ? closeNsfwConsent(consent.value, '已撤回') ?? createEmptyNsfwConsent()
                    : consent.ok ? null : createEmptyNsfwConsent();
                if (next) operations.push({
                    op: 'replace', path: encodeJsonPointer(['会话', sessionUid, 'NSFW同意']), value: next,
                });
            }
        }
        return success(operations);
    }

    const uid = command.npcUid;
    if (!isNpcUid(uid)) return fail('invalid_npc_uid');
    const adult = assertKnownAdult(state, uid);
    if (!adult.ok) return adult;

    const operations = [];
    if (command.kind === 'like') return buildLikeMatchPatch(state, { npcUid: uid });

    if (command.kind === 'start_private_chat') return buildFavoritePrivateChatPatch(state, { npcUid: uid });

    if (command.kind === 'favorite') {
        const promotion = promoteCandidateIfNeeded(state, uid, operations);
        if (!promotion.ok) return promotion;
        const listed = addUidOnce(state, '收藏角色UID', uid, operations);
        if (!listed.ok) return listed;
        const queueRemoval = removeUidFromQueue(state, uid, operations);
        if (!queueRemoval.ok) return queueRemoval;
        const preference = appendPreferenceWeightOperations(state, adult.value.profile, 1, operations);
        if (!preference.ok) return preference;
        return success(operations);
    }

    if (command.kind === 'dislike' || command.kind === 'refresh') {
        const queue = arrayAt(state, '当前队列');
        const favorites = arrayAt(state, '收藏角色UID');
        if (!queue || !favorites) return fail('recommendation_list_missing');
        const queued = queue.includes(uid);
        const favorited = favorites.includes(uid);
        if (!queued && !(command.kind === 'dislike' && favorited)) return fail('recommendation_source_not_available');
        const listName = command.kind === 'dislike' ? '不喜欢角色UID' : '冷却角色UID';
        const listed = addUidOnce(state, listName, uid, operations);
        if (!listed.ok) return listed;
        if (command.kind === 'dislike') {
            const cooled = addUidOnce(state, '冷却角色UID', uid, operations);
            if (!cooled.ok) return cooled;
        }
        if (queued) {
            const queueRemoval = removeUidFromQueue(state, uid, operations);
            if (!queueRemoval.ok) return queueRemoval;
        }
        if (command.kind === 'dislike') {
            if (favorited) {
                operations.push({ op: 'remove', path: encodeJsonPointer(['推荐', '收藏角色UID', String(favorites.indexOf(uid))]) });
            }
            const preference = appendPreferenceWeightOperations(state, adult.value.profile, -3, operations);
            if (!preference.ok) return preference;
        }
        return success(operations);
    }

    if (command.kind === 'unfavorite') {
        const favorites = arrayAt(state, '收藏角色UID');
        if (!favorites) return fail('recommendation_list_missing', '收藏角色UID');
        const index = favorites.indexOf(uid);
        if (index < 0) return fail('favorite_not_found');
        operations.push({ op: 'remove', path: encodeJsonPointer(['推荐', '收藏角色UID', String(index)]) });
        const queueRemoval = removeUidFromQueue(state, uid, operations);
        if (!queueRemoval.ok) return queueRemoval;
        // Favouriting promotes an otherwise disposable recommendation into 角色池.
        // Cancelling that bookmark discards the unlinked candidate record as well;
        // an existing private-chat session keeps its role record intact so no
        // matched conversation can be orphaned by a bookmark toggle.
        if (!hasSessionForNpc(state, uid)) {
            if (candidateAt(state, uid)) {
                operations.push({ op: 'remove', path: encodeJsonPointer(['推荐', '临时候选池', uid]) });
            } else if (roleAt(state, uid)) {
                const memories = ownRecord(state.正文记忆);
                if (!memories || !Object.hasOwn(memories, uid)) return fail('mvu_story_memory_schema_outdated');
                const bodyCandidates = ownRecord(state.正文关系候选);
                if (!bodyCandidates || !Object.hasOwn(bodyCandidates, uid) || !validateBodyRelationshipCandidate(bodyCandidates[uid]).ok) {
                    return fail('mvu_body_relationship_candidate_schema_outdated');
                }
                const narratives = ownRecord(state.关系叙事);
                if (!narratives || !Object.hasOwn(narratives, uid) || !validateRelationshipNarrative(narratives[uid]).ok) {
                    return fail('mvu_relationship_narrative_schema_outdated');
                }
                operations.push({ op: 'remove', path: encodeJsonPointer(['正文记忆', uid]) });
                operations.push({ op: 'remove', path: encodeJsonPointer(['正文关系候选', uid]) });
                operations.push({ op: 'remove', path: encodeJsonPointer(['关系叙事', uid]) });
                operations.push({ op: 'remove', path: encodeJsonPointer(['角色池', uid]) });
            }
        }
        return success(operations);
    }

    return fail('unsupported_controlled_command');
}

/** @param {unknown} patch */
export function validateControlledPatchShape(patch) {
    if (!Array.isArray(patch) || patch.length === 0) return fail('patch_shape_invalid');
    for (const operation of patch) {
        if (!ownRecord(operation) || !['add', 'replace', 'remove', 'move'].includes(operation.op) || typeof operation.path !== 'string') {
            return fail('patch_operation_invalid');
        }
        try { decodeJsonPointer(operation.path); } catch { return fail('patch_path_invalid'); }

        if (operation.op === 'move') {
            if (typeof operation.from !== 'string') return fail('patch_move_from_invalid');
            try { decodeJsonPointer(operation.from); } catch { return fail('patch_move_from_invalid'); }
        }
    }
    return success(undefined);
}

/**
 * Permits only the patch shapes generated by buildControlledPatch. It is a second
 * line of defence before Mvu.parseMessage; arbitrary LLM/UI paths are rejected.
 */
export function validateControlledPatchWhitelist(patch) {
    const shaped = validateControlledPatchShape(patch);
    if (!shaped.ok) return shaped;

    for (const operation of patch) {
        const path = operation.path;
        if (operation.op === 'replace' && path === '/软件/关于软件点击数' && Number.isInteger(operation.value) && operation.value >= 0 && operation.value <= 5) continue;
        if (operation.op === 'replace' && path === '/软件/内容模式' && ['SFW', 'NSFW'].includes(operation.value)) continue;
        if (operation.op === 'replace' && path === '/软件/功能开关/玩家已建档' && operation.value === true) continue;
        const playerText = /^\/玩家\/公开资料\/(昵称|头像引用|年龄段|性别|性取向|城市|距离范围|寻找意图|简介)$/u.exec(path);
        if (operation.op === 'replace' && playerText && cleanPlayerText(operation.value, PLAYER_PUBLIC_TEXT_LIMITS[playerText[1]]) !== null) continue;
        const playerTags = /^\/玩家\/公开资料\/(兴趣标签|生活方式标签|性格标签|沟通风格标签)$/u.exec(path);
        if (operation.op === 'replace' && playerTags && cleanPlayerTags(operation.value)) continue;

        const generatedCandidate = /^\/推荐\/临时候选池\/(npc_[A-Za-z0-9_-]{1,64})$/u.exec(path);
        if (operation.op === 'add' && generatedCandidate && isNpcUid(generatedCandidate[1])) {
            try {
                normalizeGeneratedCandidate(operation.value, { requirePersonalName: /^npc_llm_\d+$/u.test(generatedCandidate[1]) });
                continue;
            } catch (error) { return fail('generated_candidate_invalid', '', candidateValidationReason(error)); }
        }
        const serviceRole = /^\/角色池\/(npc_service_\d+)$/u.exec(path);
        if (operation.op === 'add' && serviceRole && isNpcUid(serviceRole[1])) {
            try { normalizeGeneratedCandidate(operation.value); continue; } catch (error) { return fail('service_order_candidate_invalid', '', candidateValidationReason(error)); }
        }
        const serviceOrderField = /^\/服务订单\/(service_[A-Za-z0-9_-]{1,64})\/(状态|开始时间|结束时间|结束摘要|已确认边界)$/u.exec(path);
        if (operation.op === 'replace' && serviceOrderField && isServiceOrderUid(serviceOrderField[1])) continue;
        if (operation.op === 'remove' && /^\/服务订单\/service_[A-Za-z0-9_-]{1,64}$/u.test(path)) continue;
        const serviceOrder = /^\/服务订单\/(service_[A-Za-z0-9_-]{1,64})$/u.exec(path);
        if (operation.op === 'add' && serviceOrder && isServiceOrderUid(serviceOrder[1]) && ownRecord(operation.value)
            && isNpcUid(operation.value.角色UID) && ['SFW', 'NSFW'].includes(operation.value.内容模式)
            && typeof operation.value.服务分类 === 'string' && typeof operation.value.服务主题 === 'string'
            && operation.value.服务主题.length > 0 && operation.value.服务主题.length <= 240
            && Array.isArray(operation.value.角色UID列表) && operation.value.角色UID列表.length >= 1 && operation.value.角色UID列表.length <= MAX_SERVICE_ORDER_PARTICIPANTS
            && operation.value.角色UID列表[0] === operation.value.角色UID && operation.value.角色UID列表.every((uid) => isNpcUid(uid))
            && new Set(operation.value.角色UID列表).size === operation.value.角色UID列表.length
            && operation.value.状态 === '待确认' && operation.value.发起时间 === '待正文确认'
            && operation.value.开始时间 === '' && operation.value.结束时间 === '' && operation.value.结束摘要 === '' && operation.value.已确认边界 === ''
            && isEmptyServiceCompletionSignal(operation.value.合法结束条件)) continue;
        const generatedMatchRole = /^\/角色池\/(npc_match_\d+)$/u.exec(path);
        if (operation.op === 'add' && generatedMatchRole && isNpcUid(generatedMatchRole[1])) {
            try {
                const source = matchCandidateSourceFromRole(operation.value);
                const expected = matchCandidateForRole(source, 'NSFW', operation.value.与玩家关系.状态);
                if (JSON.stringify(expected) === JSON.stringify(operation.value)) continue;
            } catch { /* reject below */ }
            return fail('candidate_match_candidate_invalid');
        }
        const generatedForumRole = /^\/角色池\/(npc_forum_\d+)$/u.exec(path);
        if (operation.op === 'add' && generatedForumRole && isNpcUid(generatedForumRole[1])) {
            try {
                const source = forumCandidateSourceFromRole(operation.value);
                const expected = forumCandidateForRole(source, 'NSFW');
                if (JSON.stringify(expected) === JSON.stringify(operation.value)) continue;
            } catch { /* reject below */ }
            return fail('forum_private_chat_candidate_invalid');
        }
        if (operation.op === 'add' && path === '/推荐/当前队列/-' && isNpcUid(operation.value)) continue;
        if (operation.op === 'replace' && path === '/系统/UID计数器/角色' && Number.isInteger(operation.value) && operation.value >= 0 && operation.value <= 999999) continue;
        if (operation.op === 'replace' && path === '/系统/UID计数器/会话' && Number.isInteger(operation.value) && operation.value >= 0 && operation.value <= 999999) continue;
        if (operation.op === 'replace' && path === '/系统/UID计数器/面基' && Number.isInteger(operation.value) && operation.value >= 0 && operation.value <= 999999) continue;
        if (operation.op === 'replace' && path === '/系统/UID计数器/服务订单' && Number.isInteger(operation.value) && operation.value >= 0 && operation.value <= 999999) continue;
        const listAdd = /^\/推荐\/(冷却角色UID|收藏角色UID|不喜欢角色UID|拉黑角色UID)\/-$/u.exec(path);
        if (operation.op === 'add' && listAdd && isNpcUid(operation.value) && TRACKED_LIST_NAMES.has(listAdd[1])) continue;
        const listReplace = /^\/推荐\/(当前队列|冷却角色UID|收藏角色UID|不喜欢角色UID|拉黑角色UID)$/u.exec(path);
        if (operation.op === 'replace' && listReplace && LIST_NAMES.has(listReplace[1]) && validUidList(operation.value)) continue;

        const listRemove = /^\/推荐\/(当前队列|收藏角色UID)\/(0|[1-9]\d*)$/u.exec(path);
        if (operation.op === 'remove' && listRemove && LIST_NAMES.has(listRemove[1])) continue;
        const candidateRemove = /^\/推荐\/临时候选池\/(npc_[A-Za-z0-9_-]{1,64})$/u.exec(path);
        if (operation.op === 'remove' && candidateRemove && isNpcUid(candidateRemove[1])) continue;
        const roleRemove = /^\/角色池\/(npc_[A-Za-z0-9_-]{1,64})$/u.exec(path);
        if (operation.op === 'remove' && roleRemove && isNpcUid(roleRemove[1])) continue;

        const move = /^\/推荐\/临时候选池\/(npc_[A-Za-z0-9_-]{1,64})$/u.exec(operation.from ?? '');
        const moveTarget = /^\/角色池\/(npc_[A-Za-z0-9_-]{1,64})$/u.exec(path);
        if (operation.op === 'move' && move && moveTarget && move[1] === moveTarget[1] && isNpcUid(move[1])) continue;

        const relationship = /^\/角色池\/(npc_[A-Za-z0-9_-]{1,64})\/与玩家关系\/状态$/u.exec(path);
        if (operation.op === 'replace' && relationship && isNpcUid(relationship[1]) && ['喜欢已发送', '已匹配', '已取消', '已拉黑'].includes(operation.value)) continue;
        const matchScore = /^\/角色池\/(npc_[A-Za-z0-9_-]{1,64})\/与玩家关系\/NPC专属匹配度$/u.exec(path);
        if (operation.op === 'replace' && matchScore && isNpcUid(matchScore[1]) && Number.isInteger(operation.value) && operation.value >= 0 && operation.value <= 100) continue;
        const newSession = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})$/u.exec(path);
        if (operation.op === 'add' && newSession && isChatSessionUid(newSession[1]) && ownRecord(operation.value)
            && operation.value.对象UID && isNpcUid(operation.value.对象UID) && operation.value.状态 === '已匹配'
            && Array.isArray(operation.value.最近消息) && operation.value.最近消息.length === 0
            && operation.value.对话层数 === 0 && isControlledConversationSummary(operation.value.总结)
            && operation.value.已确认边界 === '' && operation.value.已确认承诺 === ''
            && isEmptyNsfwConsent(operation.value.NSFW同意)
            && validateRealisticChatState(operation.value.拟真聊天).ok) continue;

        const chatNsfwConsent = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})\/NSFW同意$/u.exec(path);
        if ((operation.op === 'add' || operation.op === 'replace') && chatNsfwConsent
            && isChatSessionUid(chatNsfwConsent[1]) && validateNsfwConsent(operation.value).ok) continue;

        const realisticChat = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})\/拟真聊天$/u.exec(path);
        if ((operation.op === 'add' || operation.op === 'replace') && realisticChat
            && isChatSessionUid(realisticChat[1]) && validateRealisticChatState(operation.value).ok) continue;
        const realisticSchedule = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})\/拟真聊天\/(回复触发时间|主动触发时间|最近主动触发时间)$/u.exec(path);
        if (operation.op === 'replace' && realisticSchedule && isChatSessionUid(realisticSchedule[1])
            && (operation.value === '' || parsePhoneTimestamp(operation.value) !== null)) continue;
        const realisticMarker = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})\/拟真聊天\/最近处理玩家消息UID$/u.exec(path);
        if (operation.op === 'replace' && realisticMarker && isChatSessionUid(realisticMarker[1])
            && (operation.value === '' || /^msg_chat_[A-Za-z0-9_-]{1,64}_p_[1-9]\d{0,8}$/u.test(operation.value))) continue;
        const realisticConsentRevision = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})\/拟真聊天\/待回复同意修订号$/u.exec(path);
        if (operation.op === 'replace' && realisticConsentRevision && isChatSessionUid(realisticConsentRevision[1])
            && Number.isInteger(operation.value) && operation.value >= 0 && operation.value <= 999999) continue;
        const realisticPendingAdd = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})\/拟真聊天\/待投递消息\/-$/u.exec(path);
        if (operation.op === 'add' && realisticPendingAdd && isChatSessionUid(realisticPendingAdd[1])
            && validatePendingRealisticMessage(operation.value).ok) continue;
        const realisticPendingRemove = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})\/拟真聊天\/待投递消息\/(0|[1-9]\d*)$/u.exec(path);
        if (operation.op === 'remove' && realisticPendingRemove && isChatSessionUid(realisticPendingRemove[1])) continue;

        const chatMessagePath = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})\/最近消息\/-$/u.exec(path);
        if (operation.op === 'add' && chatMessagePath && isChatSessionUid(chatMessagePath[1]) && ownRecord(operation.value)
            && ['玩家', '角色', '系统'].includes(operation.value.发送者) && typeof operation.value.消息UID === 'string'
            && typeof operation.value.内容 === 'string' && operation.value.内容.length > 0 && operation.value.内容.length <= MAX_CHAT_MESSAGE_LENGTH
            && (operation.value.时间 === '' || parsePhoneTimestamp(operation.value.时间) !== null)
            && Number.isInteger(operation.value.层数) && operation.value.层数 >= 1 && operation.value.层数 <= 999999) continue;
        const chatMessageTrim = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})\/最近消息\/0$/u.exec(path);
        if (operation.op === 'remove' && chatMessageTrim && isChatSessionUid(chatMessageTrim[1])) continue;
        const chatLayerCount = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})\/对话层数$/u.exec(path);
        if (operation.op === 'add' && chatLayerCount && isChatSessionUid(chatLayerCount[1]) && Number.isInteger(operation.value) && operation.value >= 0 && operation.value <= 999999) continue;
        const chatConversationSummary = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})\/总结$/u.exec(path);
        if (operation.op === 'add' && chatConversationSummary && isChatSessionUid(chatConversationSummary[1]) && isControlledConversationSummary(operation.value)) continue;
        const sessionRemove = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})$/u.exec(path);
        if (operation.op === 'remove' && sessionRemove && isChatSessionUid(sessionRemove[1])) continue;
        const sessionStatus = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})\/状态$/u.exec(path);
        if (operation.op === 'replace' && sessionStatus && isChatSessionUid(sessionStatus[1]) && ['已取消', '已拉黑'].includes(operation.value)) continue;

        const chatRelationship = /^\/角色池\/(npc_[A-Za-z0-9_-]{1,64})\/与玩家关系\/(好感|信任|戒备|面基意愿|友情值|心动值|欲望值)$/u.exec(path);
        if ((operation.op === 'add' || operation.op === 'replace') && chatRelationship && isNpcUid(chatRelationship[1]) && Number.isInteger(operation.value) && operation.value >= 0 && operation.value <= 100) continue;
        const storyMemory = /^\/正文记忆\/(npc_[A-Za-z0-9_-]{1,64})$/u.exec(path);
        if (operation.op === 'add' && storyMemory && isNpcUid(storyMemory[1]) && operation.value === '') continue;
        if (operation.op === 'remove' && storyMemory && isNpcUid(storyMemory[1])) continue;
        if (operation.op === 'add' && path === '/正文关系候选' && isEmptyBodyRelationshipCandidateRegistry(operation.value)) continue;
        const bodyRelationshipCandidate = /^\/正文关系候选\/(npc_[A-Za-z0-9_-]{1,64})$/u.exec(path);
        if ((operation.op === 'add' || operation.op === 'replace') && bodyRelationshipCandidate && isNpcUid(bodyRelationshipCandidate[1])
            && isEmptyBodyRelationshipCandidate(operation.value)) continue;
        if (operation.op === 'remove' && bodyRelationshipCandidate && isNpcUid(bodyRelationshipCandidate[1])) continue;
        const relationshipNarrativeProgress = /^\/关系叙事\/(npc_[A-Za-z0-9_-]{1,64})\/进程\/(SFW细微裂缝已触发|SFW朋友分享已触发|SFW面基已解锁|SFW理解已检查|SFW主动揭示已触发|SFW心动已解锁|SFW双轨结局已解锁|NSFW爱情阶段30已触发|NSFW爱情阶段40已触发|NSFW共识亲密阶段30已触发|NSFW共识亲密阶段40已触发|NSFW方向确认可用|最后结算回合UID|已消费事件ID|最近关系观察|边界暂停状态|关系结束状态|冻结关系值)$/u.exec(path);
        if ((operation.op === 'add' || operation.op === 'replace') && relationshipNarrativeProgress && isNpcUid(relationshipNarrativeProgress[1])) {
            const progressField = relationshipNarrativeProgress[2];
            if (RELATIONSHIP_NARRATIVE_PROGRESS_BOOLEAN_FIELDS.has(progressField)
                && (operation.value === true || operation.op === 'add' && operation.value === false)) continue;
            if (progressField === '最后结算回合UID' && validRelationshipNarrativeTurnId(operation.value)) continue;
            if (progressField === '已消费事件ID' && validRelationshipNarrativeEventIds(operation.value)) continue;
            if (progressField === '最近关系观察' && ['', '无变化', '关系靠近', '边界被尊重', '保持观望', '正文约定待兑现', '主动揭示', '理解已确认', '心愿同行', '关系受损', '安全降级', '结局确认'].includes(operation.value)) continue;
            if (progressField === '边界暂停状态' && ['', '仅SFW', '暂停', '已归档'].includes(operation.value)) continue;
            if (progressField === '关系结束状态' && ['', '深度朋友', '恋人', '各自成长', '结束联系', '已归档'].includes(operation.value)) continue;
            if (progressField === '冻结关系值' && ['', '心动值', '欲望值'].includes(operation.value)) continue;
        }
        const wishTrajectory = /^\/关系叙事\/(npc_[A-Za-z0-9_-]{1,64})\/未竟心愿\/变化轨迹$/u.exec(path);
        if (operation.op === 'replace' && wishTrajectory && isNpcUid(wishTrajectory[1])
            && ['未设置', '褪色', '压抑', '摇摆', '坚持', '重燃', '重定义', '已和解'].includes(operation.value)) continue;
        const nsfwRouteSelection = /^\/关系叙事\/(npc_[A-Za-z0-9_-]{1,64})\/进程\/NSFW路线锁定$/u.exec(path);
        if (operation.op === 'replace' && nsfwRouteSelection && isNpcUid(nsfwRouteSelection[1])
            && ['爱情', '共识亲密', '暂不定义'].includes(operation.value)) continue;
        const relationshipNarrative = /^\/关系叙事\/(npc_[A-Za-z0-9_-]{1,64})$/u.exec(path);
        if ((operation.op === 'add' || operation.op === 'replace') && relationshipNarrative && isNpcUid(relationshipNarrative[1])
            && validateRelationshipNarrative(operation.value).ok) continue;
        if (operation.op === 'remove' && relationshipNarrative && isNpcUid(relationshipNarrative[1])) continue;
        const meetupRecord = /^\/面基记录\/(meetup_[A-Za-z0-9_-]{1,64})$/u.exec(path);
        if (operation.op === 'remove' && meetupRecord && isMeetupUid(meetupRecord[1])) continue;
        if (operation.op === 'add' && meetupRecord && isMeetupUid(meetupRecord[1]) && ownRecord(operation.value)
            && isNpcUid(operation.value.对象UID) && ['友情', '恋爱', '欲望'].includes(operation.value.关系路线)
            && typeof operation.value.时间 === 'string' && operation.value.时间.length > 0 && operation.value.时间.length <= 160
            && typeof operation.value.地点 === 'string' && operation.value.地点.length > 0 && operation.value.地点.length <= 160
            && typeof operation.value.双方意图 === 'string' && operation.value.双方意图.length > 0 && operation.value.双方意图.length <= 500
            && typeof operation.value.已确认边界 === 'string' && operation.value.已确认边界.length > 0 && operation.value.已确认边界.length <= 1200
            && typeof operation.value.待确认事项 === 'string' && operation.value.待确认事项.length <= 800
            && typeof operation.value.风险提示 === 'string' && operation.value.风险提示.length <= 800
            && operation.value.状态 === '待发送' && operation.value.正文结果摘要 === '') continue;
        const groupList = /^\/群组\/(group_[A-Za-z0-9_-]{1,64})\/(成员UID|可发现角色UID)$/u.exec(path);
        if (operation.op === 'replace' && groupList && isGroupUid(groupList[1]) && validUidList(operation.value)) continue;
        const preferenceWeight = /^\/玩家\/推荐偏好\/标签权重\/(SFW|NSFW)\/([^/]+)$/u.exec(path);
        if ((operation.op === 'add' || operation.op === 'replace') && preferenceWeight && Number.isInteger(operation.value) && operation.value >= -5 && operation.value <= 5) continue;

        return fail('patch_path_not_whitelisted', path);
    }
    return success(undefined);
}

function isKnownAdultInState(state, uid) {
    return assertKnownAdult(state, uid).ok;
}

function exactPatchMatch(expected, patch) {
    return expected?.ok === true && JSON.stringify(expected.value?.patch ?? expected.value) === JSON.stringify(patch);
}

function phoneMinuteDifference(later, earlier) {
    const laterMs = parsePhoneTimestamp(later);
    const earlierMs = parsePhoneTimestamp(earlier);
    if (laterMs === null || earlierMs === null) return null;
    const difference = (laterMs - earlierMs) / 60_000;
    return Number.isInteger(difference) ? difference : null;
}

function realisticTimingCandidates(pendingOperations, nextProactiveAt, triggerDueAt, replyCount) {
    const pending = pendingOperations.map((operation) => operation.value);
    const betweenReplyMinutes = [];
    if (replyCount > 1) {
        const roleMessages = pending.filter((message) => message?.发送者 === '角色');
        if (roleMessages.length !== replyCount) return [];
        for (let index = 1; index < roleMessages.length; index += 1) {
            const difference = phoneMinuteDifference(roleMessages[index].时间, roleMessages[index - 1].时间);
            if (!Number.isInteger(difference) || difference < 5 || difference > 20 || difference % 5 !== 0) return [];
            betweenReplyMinutes.push(difference);
        }
    }
    const candidates = [];
    if (pending.length) {
        const lastDeliveryAt = pending.at(-1)?.时间;
        const nextProactiveMinutes = phoneMinuteDifference(nextProactiveAt, lastDeliveryAt);
        if (!Number.isInteger(nextProactiveMinutes) || nextProactiveMinutes < 60 || nextProactiveMinutes > 360 || nextProactiveMinutes % 5 !== 0) return [];
        for (let firstDelayMinutes = 5; firstDelayMinutes <= 30; firstDelayMinutes += 5) {
            const generationTime = addPhoneMinutes(pending[0].时间, -firstDelayMinutes);
            if (generationTime && isPhoneTimestampDue(triggerDueAt, generationTime)) candidates.push({
                generationTime,
                timing: { firstDelayMinutes, betweenReplyMinutes, nextProactiveMinutes },
            });
        }
        return candidates;
    }
    for (let nextProactiveMinutes = 60; nextProactiveMinutes <= 360; nextProactiveMinutes += 5) {
        const generationTime = addPhoneMinutes(nextProactiveAt, -nextProactiveMinutes);
        if (generationTime && isPhoneTimestampDue(triggerDueAt, generationTime)) candidates.push({
            generationTime,
            timing: { firstDelayMinutes: 5, betweenReplyMinutes: [], nextProactiveMinutes },
        });
    }
    return candidates;
}

function relationshipDeltaFromPatch(state, patch, npcUid) {
    const relationship = ownRecord(roleAt(state, npcUid)?.与玩家关系);
    const delta = {};
    for (const field of RELATIONSHIP_VALUE_FIELDS) {
        const change = patch.find((operation) => operation?.op === 'replace'
            && operation.path === encodeJsonPointer(['角色池', npcUid, '与玩家关系', field]));
        if (change) {
            if (!Number.isInteger(relationship?.[field])) return null;
            delta[field] = change.value - relationship[field];
        } else delta[field] = 0;
    }
    return delta;
}

function realisticResponseAssessmentCandidates(state, patch, npcUid, mode) {
    const assessments = [{ kind: 'none', intensity: 0, direction: 'none' }];
    for (const kind of allowedAssessmentKinds(mode)) {
        if (kind === 'none') continue;
        for (const direction of ['increase', 'decrease']) {
            for (let intensity = 1; intensity <= 3; intensity += 1) assessments.push({ kind, intensity, direction });
        }
    }
    const pendingCandidate = selectPendingBodyRelationshipCandidate(state, npcUid);
    const bodyCandidateEventIds = pendingCandidate.ok && pendingCandidate.value?.事件ID
        ? ['', pendingCandidate.value.事件ID] : [''];
    const hasSfwDecisionWrite = patch.some((operation) => /^\/关系叙事\/[^/]+\/进程\/(?:SFW理解已检查|SFW主动揭示已触发|SFW心动已解锁|SFW双轨结局已解锁)$/u.test(operation?.path ?? ''));
    const hasSfwResolutionWrite = patch.some((operation) => /^\/关系叙事\/[^/]+\/进程\/关系结束状态$/u.test(operation?.path ?? '')
        && ['深度朋友', '恋人', '各自成长'].includes(operation.value));
    const insightAssessments = mode === 'SFW' && hasSfwDecisionWrite ? SFW_INSIGHT_ASSESSMENT_KINDS : ['none'];
    const resolutionAssessments = mode === 'SFW' && hasSfwResolutionWrite ? SFW_RESOLUTION_ASSESSMENT_KINDS : ['none'];
    const safetyAssessments = mode === 'NSFW' ? NSFW_SAFETY_ASSESSMENT_KINDS : ['none'];
    const consentAssessments = mode === 'NSFW' ? NSFW_CONSENT_ASSESSMENT_KINDS : ['none'];
    const candidates = [];
    for (const bondAssessment of assessments) for (const bodyEventReview of BODY_EVENT_REVIEW_STATES) {
        for (const nsfwSafetyAssessment of safetyAssessments) for (const nsfwConsentAssessment of consentAssessments) {
            for (const bodyCandidateEventId of bodyCandidateEventIds) for (const sfwInsightAssessment of insightAssessments) {
                for (const sfwResolutionAssessment of resolutionAssessments) candidates.push({
                    bondAssessment, bodyEventReview, nsfwSafetyAssessment, nsfwConsentAssessment,
                    bodyCandidateEventId, sfwInsightAssessment, sfwResolutionAssessment,
                });
            }
        }
    }
    return candidates;
}

function validateExactRealisticPrivateChatTransition(state, patch) {
    const backfill = buildRealisticPrivateChatBackfillPatch(state);
    if (exactPatchMatch(backfill, patch)) return true;

    const wholeState = patch.length === 1
        ? /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})\/拟真聊天$/u.exec(patch[0]?.path ?? '') : null;
    if (wholeState && patch[0].op === 'replace') {
        const sessionUid = wholeState[1];
        const session = ownRecord(state.会话)?.[sessionUid];
        const npcUid = ownRecord(session)?.对象UID;
        const next = validateRealisticChatState(patch[0].value);
        if (isNpcUid(npcUid) && next.ok) {
            const phoneTime = next.value.启用 ? addPhoneMinutes(next.value.主动触发时间, -60) : '2000-01-01 00:00';
            if (exactPatchMatch(buildToggleRealisticPrivateChatPatch(state, {
                sessionUid, npcUid, enabled: next.value.启用, phoneTime,
            }), patch)) return true;
        }
    }

    const playerOperation = patch.find((operation) => operation?.op === 'add'
        && /^\/会话\/chat_[A-Za-z0-9_-]{1,64}\/最近消息\/-$/u.test(operation.path)
        && operation.value?.发送者 === '玩家' && parsePhoneTimestamp(operation.value?.时间) !== null);
    if (playerOperation) {
        const sessionUid = playerOperation.path.split('/')[2];
        const session = ownRecord(state.会话)?.[sessionUid];
        const npcUid = ownRecord(session)?.对象UID;
        const onlySfw = deriveRelationshipSafetyState(ownRecord(ownRecord(state.关系叙事)?.[npcUid])?.进程).onlySfw;
        const requiresConsent = currentContentMode(state) === 'NSFW' && !onlySfw;
        const expected = buildAppendRealisticPrivateChatPlayerMessagePatch(state, {
            sessionUid,
            npcUid,
            playerMessage: playerOperation.value.内容,
            phoneTime: playerOperation.value.时间,
            turnConsentConfirmed: requiresConsent,
            nsfwConsentReferenceAtSend: requiresConsent ? nsfwConsentReference(session?.NSFW同意) : null,
        });
        if (exactPatchMatch(expected, patch)) return true;
    }

    const pendingRemovals = patch.filter((operation) => operation?.op === 'remove'
        && /^\/会话\/chat_[A-Za-z0-9_-]{1,64}\/拟真聊天\/待投递消息\/(?:0|[1-9]\d*)$/u.test(operation.path));
    if (pendingRemovals.length) {
        const sessionUid = pendingRemovals[0].path.split('/')[2];
        const session = ownRecord(state.会话)?.[sessionUid];
        const npcUid = ownRecord(session)?.对象UID;
        const delivered = patch.filter((operation) => operation?.op === 'add'
            && operation.path === encodeJsonPointer(['会话', sessionUid, '最近消息', '-']));
        const phoneTime = delivered.at(-1)?.value?.时间;
        if (exactPatchMatch(buildDeliverRealisticPrivateChatMessagesPatch(state, { sessionUid, npcUid, phoneTime }), patch)) return true;
    }

    const processedMarker = patch.find((operation) => operation?.op === 'replace'
        && /^\/会话\/chat_[A-Za-z0-9_-]{1,64}\/拟真聊天\/最近处理玩家消息UID$/u.test(operation.path));
    if (processedMarker) {
        const sessionUid = processedMarker.path.split('/')[2];
        const session = ownRecord(state.会话)?.[sessionUid];
        const npcUid = ownRecord(session)?.对象UID;
        const pendingPlayers = listPendingRealisticPlayerMessages(session);
        const pendingOperations = patch.filter((operation) => operation?.op === 'add'
            && operation.path === encodeJsonPointer(['会话', sessionUid, '拟真聊天', '待投递消息', '-']));
        const roleMessages = pendingOperations.filter((operation) => operation.value?.发送者 === '角色');
        const systemMessages = pendingOperations.filter((operation) => operation.value?.发送者 === '系统');
        const visibleBlockedNotice = patch.find((operation) => operation?.op === 'add'
            && operation.path === encodeJsonPointer(['会话', sessionUid, '最近消息', '-'])
            && operation.value?.发送者 === '系统' && operation.value?.内容 === BLOCKED_CHAT_NOTICE
            && parsePhoneTimestamp(operation.value?.时间) !== null);
        const replies = roleMessages.length ? roleMessages.map((operation) => operation.value.内容)
            : systemMessages.length || visibleBlockedNotice ? ['拟真调度占位'] : [];
        const relationship = relationshipDeltaFromPatch(state, patch, npcUid);
        const proactiveOperation = patch.find((operation) => operation?.op === 'replace'
            && operation.path === encodeJsonPointer(['会话', sessionUid, '拟真聊天', '主动触发时间']));
        const blocked = patch.some((operation) => operation?.op === 'replace'
            && operation.path === encodeJsonPointer(['会话', sessionUid, '状态']) && operation.value === '已拉黑');
        const onlySfwAtRequest = deriveRelationshipSafetyState(ownRecord(ownRecord(state.关系叙事)?.[npcUid])?.进程).onlySfw;
        const mode = onlySfwAtRequest ? 'SFW' : currentContentMode(state);
        const timingProactiveAt = proactiveOperation?.value || (blocked && visibleBlockedNotice
            ? addPhoneMinutes(visibleBlockedNotice.value.时间, 60) : '');
        if (isNpcUid(npcUid) && pendingPlayers.ok && relationship && proactiveOperation && timingProactiveAt) {
            const timingCandidates = realisticTimingCandidates(
                pendingOperations, timingProactiveAt, session.拟真聊天.回复触发时间, replies.length,
            );
            const assessmentCandidates = realisticResponseAssessmentCandidates(state, patch, npcUid, mode);
            const requiresConsent = currentContentMode(state) === 'NSFW' && !onlySfwAtRequest;
            for (const timingCandidate of timingCandidates) for (const assessment of assessmentCandidates) {
                const expected = buildRealisticPrivateChatResponsePatch(state, {
                    sessionUid,
                    npcUid,
                    response: {
                        replies,
                        relationship,
                        timing: timingCandidate.timing,
                        bondAssessment: assessment.bondAssessment,
                        bodyEventReview: assessment.bodyEventReview,
                        sfwInsightAssessment: assessment.sfwInsightAssessment,
                        sfwResolutionAssessment: assessment.sfwResolutionAssessment,
                        nsfwSafetyAssessment: assessment.nsfwSafetyAssessment,
                        nsfwConsentAssessment: assessment.nsfwConsentAssessment,
                    },
                    generationTime: timingCandidate.generationTime,
                    playerMessageUids: pendingPlayers.value.map((item) => item.messageUid),
                    bodyCandidateEventId: assessment.bodyCandidateEventId,
                    onlySfwAtRequest,
                    turnConsentConfirmed: requiresConsent,
                    nsfwConsentReferenceAtRequest: requiresConsent ? nsfwConsentReference(session?.NSFW同意) : null,
                });
                if (exactPatchMatch(expected, patch)) return true;
            }
        }
    }

    const proactiveMarker = patch.find((operation) => operation?.op === 'replace'
        && /^\/会话\/chat_[A-Za-z0-9_-]{1,64}\/拟真聊天\/最近主动触发时间$/u.test(operation.path));
    if (proactiveMarker) {
        const sessionUid = proactiveMarker.path.split('/')[2];
        const session = ownRecord(state.会话)?.[sessionUid];
        const npcUid = ownRecord(session)?.对象UID;
        const onlySfwAtRequest = deriveRelationshipSafetyState(ownRecord(ownRecord(state.关系叙事)?.[npcUid])?.进程).onlySfw;
        const pendingOperations = patch.filter((operation) => operation?.op === 'add'
            && operation.path === encodeJsonPointer(['会话', sessionUid, '拟真聊天', '待投递消息', '-']));
        const replies = pendingOperations.map((operation) => operation.value?.内容);
        const proactiveOperation = patch.find((operation) => operation?.op === 'replace'
            && operation.path === encodeJsonPointer(['会话', sessionUid, '拟真聊天', '主动触发时间']));
        if (isNpcUid(npcUid) && replies.length <= 3 && replies.every((reply) => typeof reply === 'string') && proactiveOperation?.value) {
            for (const timingCandidate of realisticTimingCandidates(
                pendingOperations, proactiveOperation.value, proactiveMarker.value, replies.length,
            )) {
                const expected = buildRealisticPrivateChatProactivePatch(state, {
                    sessionUid,
                    npcUid,
                    response: {
                        replies,
                        relationship: Object.fromEntries(RELATIONSHIP_VALUE_FIELDS.map((field) => [field, 0])),
                        timing: timingCandidate.timing,
                        bondAssessment: { kind: 'none', intensity: 0, direction: 'none' },
                        bodyEventReview: 'defer',
                        sfwInsightAssessment: 'none',
                        sfwResolutionAssessment: 'none',
                        nsfwSafetyAssessment: 'none',
                        nsfwConsentAssessment: 'none',
                    },
                    generationTime: timingCandidate.generationTime,
                    triggerTime: proactiveMarker.value,
                    onlySfwAtRequest,
                    nsfwConsentReferenceAtRequest: currentContentMode(state) === 'NSFW' && !onlySfwAtRequest
                        ? nsfwConsentReference(session?.NSFW同意) : null,
                });
                if (exactPatchMatch(expected, patch)) return true;
            }
        }
    }
    return false;
}

/**
 * Checks that a whitelisted patch still matches the exact, current state object.
 * This prevents stale buttons or forged commands from creating references to an
 * unknown character.
 */
export function validateControlledPatchAgainstState(state, patch) {
    if (!ownRecord(state)) return fail('state_invalid');
    const allowed = validateControlledPatchWhitelist(patch);
    if (!allowed.ok) return allowed;
    if (patch.some((operation) => /\/拟真聊天(?:\/|$)/u.test(operation?.path ?? ''))) {
        return validateExactRealisticPrivateChatTransition(state, patch)
            ? success(undefined) : fail('patch_not_exact_ui_transition');
    }

    const moved = new Set();
    for (const operation of patch) {
        if (operation.op === 'move') {
            const uid = decodeJsonPointer(operation.from).at(-1);
            if (!candidateAt(state, uid) || roleAt(state, uid)) return fail('candidate_move_state_invalid');
            if (!isKnownAdultInState(state, uid)) return fail('npc_adult_verification_failed');
            moved.add(uid);
            continue;
        }

        const listAdd = /^\/推荐\/(冷却角色UID|收藏角色UID|不喜欢角色UID|拉黑角色UID)\/-$/u.exec(operation.path);
        if (listAdd) {
            if (!isKnownAdultInState(state, operation.value)) return fail('tracked_uid_not_adult');
            const list = arrayAt(state, listAdd[1]);
            if (!list || list.includes(operation.value)) return fail('list_add_state_invalid');
            continue;
        }

        const listRemove = /^\/推荐\/(当前队列|收藏角色UID)\/(0|[1-9]\d*)$/u.exec(operation.path);
        if (listRemove) {
            const list = arrayAt(state, listRemove[1]);
            const index = Number(listRemove[2]);
            if (!list || index >= list.length) return fail('list_remove_state_invalid');
            continue;
        }

        const relation = /^\/角色池\/(npc_[A-Za-z0-9_-]{1,64})\/与玩家关系\/状态$/u.exec(operation.path);
        if (relation && !(roleAt(state, relation[1]) || moved.has(relation[1]))) {
            return fail('relationship_target_missing');
        }
    }
    // Dynamic candidate creation/refreshes must equal a locally rebuilt all-or-nothing transition.
    const queueRemoval = patch.find((operation) => operation?.op === 'remove' && /^\/推荐\/当前队列\/(0|[1-9]\d*)$/u.test(operation.path));
    const queueAddition = patch.find((operation) => operation?.op === 'add' && operation.path === '/推荐/当前队列/-');
    const candidateAddition = patch.find((operation) => operation?.op === 'add' && /^\/推荐\/临时候选池\/npc_[A-Za-z0-9_-]{1,64}$/u.test(operation.path));
    if (candidateAddition && !queueAddition && /^\/推荐\/临时候选池\/npc_custom_\d+$/u.test(candidateAddition.path)) {
        const expected = buildCharacterRegistrationPatch(state, { candidate: candidateAddition.value });
        if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
    }
    if (candidateAddition && queueAddition && !queueRemoval) {
        const candidateUid = decodeJsonPointer(candidateAddition.path).at(-1);
        const expected = /^npc_llm_\d+$/u.test(candidateUid)
            ? buildRecommendationInitialCandidatePatch(state, { candidate: candidateAddition.value })
            : fail('recommendation_initial_uid_invalid');
        if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
    }
    if (queueRemoval && candidateAddition) {
        const oldIndex = Number(queueRemoval.path.split('/').at(-1));
        const queue = arrayAt(state, '当前队列');
        const expected = Array.isArray(queue) && typeof queue[oldIndex] === 'string'
            ? buildRecommendationRefreshPatch(state, { replacedNpcUid: queue[oldIndex], candidate: candidateAddition.value })
            : fail('recommendation_refresh_source_not_queued');
        if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
    }
    if (queueAddition && !candidateAddition) {
        const candidateUid = queueAddition.value;
        const oldIndex = queueRemoval ? Number(queueRemoval.path.split('/').at(-1)) : -1;
        const queue = arrayAt(state, '当前队列');
        const expected = buildExistingCandidateRecommendationPatch(state, {
            candidateUid,
            replacedNpcUid: oldIndex >= 0 && Array.isArray(queue) ? queue[oldIndex] : '',
        });
        if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
    }
    const customMove = patch.find((operation) => operation?.op === 'move'
        && /^\/推荐\/临时候选池\/npc_custom_\d+$/u.test(operation.from ?? '')
        && /^\/角色池\/npc_custom_\d+$/u.test(operation.path));
    if (customMove) {
        const candidateUid = decodeJsonPointer(customMove.path).at(-1);
        const scoreOperation = patch.find((operation) => operation?.op === 'replace'
            && operation.path === encodeJsonPointer(['角色池', candidateUid, '与玩家关系', 'NPC专属匹配度']));
        const expected = buildCustomCandidateMatchPatch(state, { candidateUid, matchScore: scoreOperation?.value });
        if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
    }
    const matchRoleAddition = patch.find((operation) => operation?.op === 'add' && /^\/角色池\/npc_match_\d+$/u.test(operation.path));
    if (matchRoleAddition && ownRecord(matchRoleAddition.value)) {
        try {
            const source = matchCandidateSourceFromRole(matchRoleAddition.value);
            const accepted = matchRoleAddition.value.与玩家关系.状态 === '已匹配';
            const expected = buildCandidateMatchOutcomePatch(state, { candidate: source, accepted });
            if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
        } catch {
            return fail('candidate_match_candidate_invalid');
        }
    }
    const forumRoleAddition = patch.find((operation) => operation?.op === 'add' && /^\/角色池\/npc_forum_\d+$/u.test(operation.path));
    if (forumRoleAddition && ownRecord(forumRoleAddition.value)) {
        try {
            const source = forumCandidateSourceFromRole(forumRoleAddition.value);
            const expected = buildForumPrivateChatSessionPatch(state, { candidate: source });
            if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
        } catch {
            return fail('forum_private_chat_candidate_invalid');
        }
    }

    if (patch.length >= 1 && patch.every((operation) => {
        const path = operation?.path ?? '';
        return (operation?.op === 'add' && operation.value === '' || operation?.op === 'remove')
            && /^\/正文记忆\/npc_[A-Za-z0-9_-]{1,64}$/u.test(path);
    })) {
        const expected = buildStoryMemoryBackfillPatch(state);
        if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
    }

    const endRelationshipOperation = patch.find((operation) => operation?.op === 'replace'
        && /^\/关系叙事\/(npc_[A-Za-z0-9_-]{1,64})\/进程\/关系结束状态$/u.test(operation.path ?? '')
        && operation.value === '结束联系');
    const degradeRouteOperation = patch.find((operation) => operation?.op === 'replace'
        && /^\/关系叙事\/(npc_[A-Za-z0-9_-]{1,64})\/进程\/NSFW路线锁定$/u.test(operation.path ?? '')
        && operation.value === '暂不定义');
    const degradeFreezeOperation = patch.find((operation) => operation?.op === 'replace'
        && /^\/关系叙事\/(npc_[A-Za-z0-9_-]{1,64})\/进程\/冻结关系值$/u.test(operation.path ?? '')
        && operation.value === '');
    const archiveRelationshipOperation = patch.find((operation) => operation?.op === 'replace'
        && /^\/关系叙事\/(npc_[A-Za-z0-9_-]{1,64})\/进程\/关系结束状态$/u.test(operation.path ?? '')
        && operation.value === '已归档');
    const pauseRelationshipOperation = patch.find((operation) => operation?.op === 'replace'
        && /^\/关系叙事\/(npc_[A-Za-z0-9_-]{1,64})\/进程\/边界暂停状态$/u.test(operation.path ?? '')
        && operation.value === '暂停');
    const resumeRelationshipOperation = patch.find((operation) => operation?.op === 'replace'
        && /^\/关系叙事\/(npc_[A-Za-z0-9_-]{1,64})\/进程\/边界暂停状态$/u.test(operation.path ?? '')
        && operation.value === ''
        && patch.some((item) => item?.path?.endsWith('/最近关系观察') && item.value === '保持观望'));
    const relationshipActionOperation = endRelationshipOperation ?? archiveRelationshipOperation
        ?? pauseRelationshipOperation ?? resumeRelationshipOperation ?? degradeRouteOperation ?? degradeFreezeOperation;
    if (relationshipActionOperation) {
        const match = /^\/关系叙事\/(npc_[A-Za-z0-9_-]{1,64})\/进程\//u.exec(relationshipActionOperation.path);
        const action = endRelationshipOperation ? 'end_contact'
            : archiveRelationshipOperation ? 'archive_contact'
                : pauseRelationshipOperation ? 'pause_contact'
                    : resumeRelationshipOperation ? 'resume_contact' : 'degrade_to_friends';
        const matchingSessions = Object.entries(ownRecord(state.会话) ?? {})
            .filter(([sessionUid, session]) => isChatSessionUid(sessionUid) && ownRecord(session)
                && session.对象UID === match?.[1] && session.状态 === '已匹配');
        for (const [sessionUid] of matchingSessions) {
            const expected = buildPrivateChatNsfwRelationshipActionPatch(state, { sessionUid, action });
            if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
        }
    }

    const nsfwSafetyOperation = /^\/关系叙事\/(npc_[A-Za-z0-9_-]{1,64})\/进程\/边界暂停状态$/u.exec(patch[0]?.path ?? '');
    if (nsfwSafetyOperation && patch[0]?.op === 'replace' && ['', '仅SFW'].includes(patch[0].value)) {
        const action = patch[0].value === '仅SFW' ? 'pause' : 'resume';
        const matchingSessions = Object.entries(ownRecord(state.会话) ?? {})
            .filter(([sessionUid, session]) => isChatSessionUid(sessionUid) && ownRecord(session)
                && session.对象UID === nsfwSafetyOperation[1] && session.状态 === '已匹配');
        for (const [sessionUid] of matchingSessions) {
            const expected = buildPrivateChatNsfwSafetyPatch(state, { sessionUid, action });
            if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
        }
    }

    if (patch.length >= 1 && patch.every((operation) => operation?.op === 'add'
        && /^\/会话\/chat_[A-Za-z0-9_-]{1,64}\/NSFW同意$/u.test(operation.path)
        && isEmptyNsfwConsent(operation.value))) {
        const expected = buildPrivateChatNsfwConsentBackfillPatch(state);
        if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
    }

    const nsfwConsentOperation = patch.length === 1
        ? /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})\/NSFW同意$/u.exec(patch[0]?.path ?? '')
        : null;
    if (nsfwConsentOperation && patch[0]?.op === 'replace' && validateNsfwConsent(patch[0].value).ok) {
        const sessionUid = nsfwConsentOperation[1];
        const next = patch[0].value;
        if (next.状态 === '有效') {
            const expected = buildPrivateChatNsfwConsentPatch(state, {
                sessionUid, action: 'grant', scopes: next.允许范围, turns: next.剩余轮数,
            });
            if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
        } else if (next.状态 === '已撤回') {
            const expected = buildPrivateChatNsfwConsentPatch(state, { sessionUid, action: 'revoke' });
            if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
        }
    }

    const nsfwDirectionOperation = patch.length === 1
        ? /^\/关系叙事\/(npc_[A-Za-z0-9_-]{1,64})\/进程\/NSFW路线锁定$/u.exec(patch[0]?.path ?? '')
        : null;
    if (nsfwDirectionOperation && patch[0]?.op === 'replace') {
        const direction = patch[0].value === '爱情' ? 'love'
            : patch[0].value === '共识亲密' ? 'consensual_intimacy'
                : patch[0].value === '暂不定义' ? 'defer' : '';
        const matchingSessions = Object.entries(ownRecord(state.会话) ?? {})
            .filter(([sessionUid, session]) => isChatSessionUid(sessionUid) && ownRecord(session)
                && session.对象UID === nsfwDirectionOperation[1] && session.状态 === '已匹配');
        for (const [sessionUid] of matchingSessions) {
            const expected = buildPrivateChatNsfwDirectionPatch(state, { sessionUid, direction });
            if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
        }
    }

    if (patch.length >= 1 && patch.every((operation) => {
        const path = operation?.path ?? '';
        return ['add', 'replace'].includes(operation?.op)
            && /^\/关系叙事\/npc_[A-Za-z0-9_-]{1,64}(?:\/进程\/(?:SFW主动揭示已触发|最近关系观察))?$/u.test(path);
    })) {
        const expected = buildRelationshipNarrativeBackfillPatch(state);
        if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
    }

    if (patch.length >= 1 && patch.every((operation) => {
        const path = operation?.path ?? '';
        return operation?.op === 'add'
            && (path === '/正文关系候选'
                ? isEmptyBodyRelationshipCandidateRegistry(operation.value)
                : /^\/正文关系候选\/npc_[A-Za-z0-9_-]{1,64}$/u.test(path) && isEmptyBodyRelationshipCandidate(operation.value));
    })) {
        const expected = buildBodyRelationshipCandidateBackfillPatch(state);
        if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
    }

    const serviceRoleRemovals = patch.filter((operation) => operation?.op === 'remove' && /^\/角色池\/npc_service_\d+$/u.test(operation.path));
    if (serviceRoleRemovals.length >= 1 && patch.length === serviceRoleRemovals.length * 4) {
        const expected = buildServiceHistoryRolesDeletionPatch(state, { npcUids: serviceRoleRemovals.map((operation) => decodeJsonPointer(operation.path).at(-1)) });
        if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
    }
    const characterRemoval = patch.find((operation) => operation?.op === 'remove'
        && (/^\/角色池\/npc_[A-Za-z0-9_-]{1,64}$/u.test(operation.path)
            || /^\/推荐\/临时候选池\/npc_[A-Za-z0-9_-]{1,64}$/u.test(operation.path)));
    if (characterRemoval) {
        const npcUid = decodeJsonPointer(characterRemoval.path).at(-1);
        const expected = buildDeleteCharacterPatch(state, { npcUid });
        if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
    }

    const sessionRemoval = patch.find((operation) => operation?.op === 'remove' && /^\/会话\/chat_[A-Za-z0-9_-]{1,64}$/u.test(operation.path));
    if (sessionRemoval) {
        const sessionUid = decodeJsonPointer(sessionRemoval.path).at(-1);
        const expected = buildClearPrivateChatPatch(state, { sessionUid });
        if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
    }

    const conversationSummaryOperation = patch.find((operation) => operation?.op === 'add' && /^\/会话\/chat_[A-Za-z0-9_-]{1,64}\/总结$/u.test(operation.path));
    if (conversationSummaryOperation && patch.length === 1) {
        const sessionUid = conversationSummaryOperation.path.split('/')[2];
        const session = ownRecord(state.会话)?.[sessionUid];
        const npcUid = ownRecord(session)?.对象UID;
        const next = normalizeConversationSummaryState({ 总结: conversationSummaryOperation.value });
        const previous = normalizeConversationSummaryState(session);
        if (isChatSessionUid(sessionUid) && isNpcUid(npcUid)) {
            if (next.status === '失败') {
                const expected = buildPrivateChatSummaryFailurePatch(state, {
                    sessionUid,
                    npcUid,
                    reason: next.failureReason,
                    summaryUid: next.targetSummaryUid,
                    attempts: next.attempts,
                });
                if (expected.ok && JSON.stringify(expected.value.patch) === JSON.stringify(patch)) return success(undefined);
            }
            if (next.status === '成功') {
                let targetSummaryUid = '';
                let summaryRecord = null;
                const added = next.records.filter((record) => !previous.records.some((item) => item.uid === record.uid));
                if (added.length === 1) {
                    summaryRecord = added[0];
                    const pending = listUnsummarizedConversationMessages(session);
                    const endIndex = pending.findIndex((message) => message.uid === summaryRecord.endMessageUid);
                    if (endIndex >= 0) {
                        const sourceMessageUids = pending.slice(0, endIndex + 1).map((message) => message.uid);
                        const expected = buildPrivateChatSummaryPatch(state, {
                            sessionUid, npcUid, summary: summaryRecord.content, sourceMessageUids, attempts: next.attempts,
                        });
                        if (expected.ok && JSON.stringify(expected.value.patch) === JSON.stringify(patch)) return success(undefined);
                    }
                } else {
                    const changed = next.records.filter((record) => {
                        const old = previous.records.find((item) => item.uid === record.uid);
                        return old && old.content !== record.content;
                    });
                    targetSummaryUid = changed.length === 1 ? changed[0].uid : previous.targetSummaryUid;
                    if (targetSummaryUid) {
                        const historical = summaryRecordSource(session, targetSummaryUid);
                        summaryRecord = next.records.find((record) => record.uid === targetSummaryUid) ?? null;
                        if (historical.ok && summaryRecord) {
                            const expected = buildPrivateChatSummaryPatch(state, {
                                sessionUid,
                                npcUid,
                                summary: summaryRecord.content,
                                sourceMessageUids: historical.messages.map((message) => message.uid),
                                summaryUid: targetSummaryUid,
                                attempts: next.attempts,
                            });
                            if (expected.ok && JSON.stringify(expected.value.patch) === JSON.stringify(patch)) return success(undefined);
                        }
                    }
                }
            }
        }
    }

    const chatMessageOperations = patch.filter((operation) => operation?.op === 'add' && /^\/会话\/chat_[A-Za-z0-9_-]{1,64}\/最近消息\/-$/u.test(operation.path));
    if (chatMessageOperations.length >= 2 && chatMessageOperations.length <= 7) {
        const [playerOperation, ...replyOperations] = chatMessageOperations;
        const sessionUid = playerOperation.path.split('/')[2];
        const session = ownRecord(state.会话)?.[sessionUid];
        const npcUid = ownRecord(session)?.对象UID;
        const sameSession = replyOperations.every((operation) => operation.path.split('/')[2] === sessionUid);
        const roleReplies = replyOperations.every((operation) => operation.value?.发送者 === '角色');
        const rhythmNotice = replyOperations.length === 1 && replyOperations[0].value?.发送者 === '系统';
        if (playerOperation.value?.发送者 === '玩家' && sameSession && (roleReplies || rhythmNotice) && isChatSessionUid(sessionUid) && isNpcUid(npcUid)) {
            const relationship = ownRecord(roleAt(state, npcUid)?.与玩家关系);
            const response = { replies: roleReplies ? replyOperations.map((operation) => operation.value.内容) : ['节奏占位'], relationship: {} };
            let validResponse = true;
            for (const field of RELATIONSHIP_VALUE_FIELDS) {
                const change = patch.find((operation) => operation?.op === 'replace' && operation.path === encodeJsonPointer(['角色池', npcUid, '与玩家关系', field]));
                if (change) {
                    if (!Number.isInteger(relationship?.[field])) { validResponse = false; break; }
                    response.relationship[field] = change.value - relationship[field];
                } else response.relationship[field] = 0;
            }
            if (validResponse) {
                const mode = currentContentMode(state);
                const assessments = [{ kind: 'none', intensity: 0, direction: 'none' }];
                for (const kind of allowedAssessmentKinds(mode)) {
                    if (kind === 'none') continue;
                    for (const direction of ['increase', 'decrease']) {
                        for (let intensity = 1; intensity <= 3; intensity += 1) assessments.push({ kind, intensity, direction });
                    }
                }
                const pendingCandidate = selectPendingBodyRelationshipCandidate(state, npcUid);
                const bodyCandidateEventIds = pendingCandidate.ok && pendingCandidate.value?.事件ID
                    ? ['', pendingCandidate.value.事件ID]
                    : [''];
                const hasSfwDecisionWrite = patch.some((operation) => /^\/关系叙事\/[^/]+\/进程\/(?:SFW理解已检查|SFW主动揭示已触发|SFW心动已解锁|SFW双轨结局已解锁)$/u.test(operation?.path ?? ''));
                const hasSfwResolutionWrite = patch.some((operation) => /^\/关系叙事\/[^/]+\/进程\/关系结束状态$/u.test(operation?.path ?? '')
                    && ['深度朋友', '恋人', '各自成长'].includes(operation.value));
                const insightAssessments = mode === 'SFW' && hasSfwDecisionWrite ? SFW_INSIGHT_ASSESSMENT_KINDS : ['none'];
                const resolutionAssessments = mode === 'SFW' && hasSfwResolutionWrite ? SFW_RESOLUTION_ASSESSMENT_KINDS : ['none'];
                for (const bondAssessment of assessments) {
                    for (const bodyEventReview of BODY_EVENT_REVIEW_STATES) {
                        const safetyAssessments = mode === 'NSFW' ? NSFW_SAFETY_ASSESSMENT_KINDS : ['none'];
                        for (const nsfwSafetyAssessment of safetyAssessments) {
                            const consentAssessments = mode === 'NSFW' ? NSFW_CONSENT_ASSESSMENT_KINDS : ['none'];
                            for (const nsfwConsentAssessment of consentAssessments) {
                              for (const bodyCandidateEventId of bodyCandidateEventIds) {
                               for (const sfwInsightAssessment of insightAssessments) {
                                for (const sfwResolutionAssessment of resolutionAssessments) {
                                const onlySfwAtRequest = deriveRelationshipSafetyState(ownRecord(ownRecord(state.关系叙事)?.[npcUid])?.进程).onlySfw;
                                const requiresConsent = mode === 'NSFW' && !onlySfwAtRequest;
                                const expected = buildPrivateChatPatch(state, {
                                    sessionUid,
                                    npcUid,
                                    playerMessage: playerOperation.value?.内容,
                                    response: { ...response, bondAssessment, bodyEventReview, sfwInsightAssessment, sfwResolutionAssessment, nsfwSafetyAssessment, nsfwConsentAssessment },
                                    bodyCandidateEventId,
                                    onlySfwAtRequest,
                                    turnConsentConfirmed: requiresConsent,
                                    nsfwConsentReferenceAtRequest: requiresConsent ? nsfwConsentReference(session?.NSFW同意) : null,
                                });
                                if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
                                }
                               }
                              }
                            }
                        }
                    }
                }
            }
        }
    }

    const standalonePreferenceOperations = patch.filter((operation) => operation?.op === 'add' || operation?.op === 'replace');
    if (patch.length >= 1 && patch.length <= 12 && standalonePreferenceOperations.length === patch.length
        && patch.every((operation) => new RegExp('^/玩家/推荐偏好/标签权重/' + currentContentMode(state) + '/[^/]+$', 'u').test(operation.path))) {
        const tagWeightDraft = patch.map((operation) => ({ tag: decodeJsonPointer(operation.path).at(-1), weight: operation.value }));
        const expected = buildSoulMatchPreferencePatch(state, { draft: { tagWeightDraft, explanation: '已由玩家确认采用。' } });
        if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
    }

    const meetupAddition = patch.find((operation) => operation?.op === 'add' && /^\/面基记录\/meetup_[A-Za-z0-9_-]{1,64}$/u.test(operation.path));
    if (meetupAddition && ownRecord(meetupAddition.value)) {
        const record = meetupAddition.value;
        const matchedSessions = Object.entries(ownRecord(state.会话) ?? {})
            .filter(([sessionUid, session]) => isChatSessionUid(sessionUid) && ownRecord(session) && session.对象UID === record.对象UID && session.状态 === '已匹配');
        if (matchedSessions.length === 1) {
            const [sessionUid] = matchedSessions[0];
            const expected = buildMeetupHandoffPatch(state, {
                sessionUid, npcUid: record.对象UID, time: record.时间, place: record.地点,
                mutualIntent: record.双方意图, confirmedBoundaries: record.已确认边界,
                pendingItems: record.待确认事项, riskNotice: record.风险提示,
            });
            if (expected.ok && JSON.stringify(expected.value.patch) === JSON.stringify(patch)) return success(undefined);
        }
    }

    const serviceOrderAddition = patch.find((operation) => operation?.op === 'add' && /^\/服务订单\/service_[A-Za-z0-9_-]{1,64}$/u.test(operation.path));
    const serviceRoleAdditions = patch.filter((operation) => operation?.op === 'add' && /^\/角色池\/npc_service_\d+$/u.test(operation.path));
    if (serviceOrderAddition && serviceRoleAdditions.length && ownRecord(serviceOrderAddition.value)) {
        const nextOrder = serviceOrderAddition.value;
        const orderedCandidates = nextOrder.角色UID列表?.map((uid) => serviceRoleAdditions.find((operation) => decodeJsonPointer(operation.path).at(-1) === uid)?.value);
        if (Array.isArray(orderedCandidates) && orderedCandidates.every(Boolean)) {
            const expected = buildServiceOrderHandoffPatch(state, { candidates: orderedCandidates, categoryId: nextOrder.服务分类 });
            if (expected.ok && JSON.stringify(expected.value.patch) === JSON.stringify(patch)) return success(undefined);
        }
    }
    if (serviceOrderAddition && !serviceRoleAdditions.length && ownRecord(serviceOrderAddition.value)) {
        const nextOrder = serviceOrderAddition.value;
        const expectedRebook = buildServiceOrderRebookPatch(state, { npcUids: nextOrder.角色UID列表, categoryId: nextOrder.服务分类 });
        if (expectedRebook.ok && JSON.stringify(expectedRebook.value.patch) === JSON.stringify(patch)) return success(undefined);
        for (const [sourceOrderUid, source] of Object.entries(ownRecord(state.服务订单) ?? {})) {
            if (!ownRecord(source) || !['已完成', '已取消'].includes(source.状态)) continue;
            if (source.角色UID !== nextOrder.角色UID || source.服务分类 !== nextOrder.服务分类 || source.内容模式 !== nextOrder.内容模式) continue;
            const expected = buildServiceOrderRepeatPatch(state, { sourceOrderUid });
            if (expected.ok && JSON.stringify(expected.value.patch) === JSON.stringify(patch)) return success(undefined);
        }
    }

    for (const [orderUid, order] of Object.entries(ownRecord(state.服务订单) ?? {})) {
        if (!ownRecord(order)) continue;
        if (!isStrictServiceOrderForProjection(state, orderUid, order)) {
            const expectedRepair = buildServiceOrderRepairPatch(state, { orderUid });
            if (expectedRepair.ok && JSON.stringify(expectedRepair.value) === JSON.stringify(patch)) return success(undefined);
        }
        if (order.状态 === '进行中') {
            const expectedComplete = buildServiceOrderCompletePatch(state, { orderUid });
            if (expectedComplete.ok && JSON.stringify(expectedComplete.value) === JSON.stringify(patch)) return success(undefined);
        }
        if (order.状态 === '待确认') {
            const paths = new Set(patch.map((operation) => operation?.path));
            if (paths.has(`/服务订单/${orderUid}/状态`) && paths.has(`/服务订单/${orderUid}/开始时间`) && paths.has(`/服务订单/${orderUid}/已确认边界`)) {
                const boundaryOperation = patch.find((operation) => operation?.path === `/服务订单/${orderUid}/已确认边界`);
                let boundaries = null;
                try { boundaries = JSON.parse(boundaryOperation?.value ?? ''); } catch { /* reject below */ }
                const expected = buildServiceOrderStartPatch(state, { orderUid, boundaries });
                if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
            }
            const expectedCancel = buildServiceOrderCancelPatch(state, { orderUid });
            if (expectedCancel.ok && JSON.stringify(expectedCancel.value) === JSON.stringify(patch)) return success(undefined);
        }
        if (['已完成', '已取消'].includes(order.状态)) {
            const expectedFinalize = buildServiceOrderFinalizePatch(state, { orderUid });
            if (expectedFinalize.ok && JSON.stringify(expectedFinalize.value) === JSON.stringify(patch)) return success(undefined);
        }
    }
    const playerProfileOperations = patch.filter((operation) => operation?.op === 'replace' && /^\/玩家\/公开资料\//u.test(operation.path));
    const playerProfileGate = patch.find((operation) => operation?.op === 'replace' && operation.path === '/软件/功能开关/玩家已建档');
    if (playerProfileOperations.length > 0 || playerProfileGate) {
        const currentProfile = ownRecord(ownRecord(state.玩家)?.公开资料);
        if (currentProfile) {
            const candidate = { ...currentProfile };
            for (const operation of playerProfileOperations) candidate[decodeJsonPointer(operation.path).at(-1)] = operation.value;
            const expected = buildPlayerPublicProfilePatch(state, { profile: candidate });
            if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
        }
    }

    const exactTransitions = [];
    const gate = buildControlledPatch(state, { kind: 'advance_content_mode_gate' });
    if (gate.ok) exactTransitions.push(gate.value);
    const contentModeToggle = buildControlledPatch(state, { kind: 'toggle_content_mode' });
    if (contentModeToggle.ok) exactTransitions.push(contentModeToggle.value);

    const candidatePool = ownRecord(state.推荐)?.临时候选池;
    const rolePool = ownRecord(state.角色池);
    const knownUids = new Set([
        ...Object.keys(ownRecord(candidatePool) ?? {}),
        ...Object.keys(ownRecord(rolePool) ?? {}),
    ].filter(isNpcUid));
    for (const uid of knownUids) {
        for (const kind of ['like', 'favorite', 'dislike', 'refresh', 'unfavorite', 'start_private_chat']) {
            const generated = buildControlledPatch(state, { kind, npcUid: uid });
            if (generated.ok) exactTransitions.push(generated.value);
        }
    }
    if (!exactTransitions.some((expected) => JSON.stringify(expected) === JSON.stringify(patch))) {
        return fail('patch_not_exact_ui_transition', '', '补丁与任何本地重建的受控 UI 转换都不一致（状态可能已在生成后发生变化）');
    }

    return success(undefined);
}

/** @param {unknown} patch */
export function buildUpdateVariable(patch) {
    const valid = validateControlledPatchWhitelist(patch);
    if (!valid.ok) return valid;
    try {
        return success(`<UpdateVariable><JSONPatch>${JSON.stringify(patch)}</JSONPatch></UpdateVariable>`);
    } catch {
        return fail('patch_not_serializable');
    }
}

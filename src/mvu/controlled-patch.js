import { decodeJsonPointer, encodeJsonPointer, getAtPointer, isPlainRecord } from './json-pointer.js';
import { normalizeGeneratedCandidate } from '../recommendation/candidate.js';
import { normalizePrivateChatResponse } from '../chat/private-chat-response.js';
import { validatePrivateChatRequest } from '../chat/private-chat-service.js';
import { decideInteractionRhythm } from '../chat/interaction-rhythm.js';
import { scoreFavoritePrivateChatInvitation } from '../recommendation/match-scoring.js';
import { normalizeSoulMatchDraft } from '../recommendation/soul-text-match-service.js';

export const LATEST_MESSAGE_SCOPE = Object.freeze({ type: 'message', message_id: 'latest' });
export const NPC_UID_PATTERN = /^npc_[a-z0-9][a-z0-9_-]{0,63}$/i;

const LIST_NAMES = new Set(['当前队列', '冷却角色UID', '收藏角色UID', '不喜欢角色UID', '拉黑角色UID']);
const TRACKED_LIST_NAMES = new Set(['冷却角色UID', '收藏角色UID', '不喜欢角色UID', '拉黑角色UID']);
const CHAT_SESSION_UID_PATTERN = /^chat_[a-z0-9][a-z0-9_-]{0,63}$/i;
const MEETUP_UID_PATTERN = /^meetup_[a-z0-9][a-z0-9_-]{0,63}$/i;
const GROUP_UID_PATTERN = /^group_[a-z0-9][a-z0-9_-]{0,63}$/i;
const RELATIONSHIP_VALUE_FIELDS = Object.freeze(['好感', '信任', '戒备', '面基意愿']);
const MAX_CHAT_MESSAGE_LENGTH = 600;
const READ_WITHOUT_REPLY_NOTICE = '对方已读，但暂时没有回复。';
const BLOCKED_CHAT_NOTICE = '对方已将你拉黑，当前会话无法继续发送消息。';
const PLAYER_PUBLIC_TEXT_LIMITS = Object.freeze({
    昵称: 80, 头像引用: 500, 年龄段: 32, 性别: 48, 性取向: 80, 城市: 80,
    距离范围: 48, 寻找意图: 120, 简介: 500,
});
const PLAYER_PUBLIC_TAG_FIELDS = Object.freeze(['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']);

function fail(code, detail = '') {
    return { ok: false, code, detail };
}

function success(value) {
    return { ok: true, value };
}

function isNpcUid(value) {
    return typeof value === 'string' && NPC_UID_PATTERN.test(value);
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
    if (!profile) return fail('npc_not_found');

    const hidden = ownRecord(profile.隐藏资料);
    if (profile.成人验证 !== true || !hidden || !Number.isInteger(hidden.实际年龄) || hidden.实际年龄 < 18) {
        return fail('npc_adult_verification_failed');
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
    if (!player || player.成人验证 !== true || !current || !switches || typeof switches.玩家已建档 !== 'boolean' || !normalized) {
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
    if (operations.length > 0 && !switches.玩家已建档) {
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
    const weights = ownRecord(ownRecord(state.玩家)?.推荐偏好)?.标签权重;
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
            path: encodeJsonPointer(['玩家', '推荐偏好', '标签权重', tag]), value: weight,
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
        return fail('character_registration_state_invalid');
    }

    let normalizedCandidate;
    try { normalizedCandidate = normalizeGeneratedCandidate(candidate); }
    catch { return fail('character_registration_candidate_invalid'); }

    const uid = `npc_custom_${roleCounter + 1}`;
    if (!isNpcUid(uid) || candidateAt(state, uid) || roleAt(state, uid) || queue.includes(uid)) {
        return fail('character_registration_uid_conflict');
    }
    return success([
        { op: 'add', path: encodeJsonPointer(['推荐', '临时候选池', uid]), value: normalizedCandidate },
        { op: 'add', path: encodeJsonPointer(['推荐', '当前队列', '-']), value: uid },
        { op: 'replace', path: encodeJsonPointer(['系统', 'UID计数器', '角色']), value: roleCounter + 1 },
    ]);
}
function isChatSessionUid(value) {
    return typeof value === 'string' && CHAT_SESSION_UID_PATTERN.test(value);
}

function isMeetupUid(value) {
    return typeof value === 'string' && MEETUP_UID_PATTERN.test(value);
}

function isGroupUid(value) {
    return typeof value === 'string' && GROUP_UID_PATTERN.test(value);
}

function clamp(value, lower, upper) {
    return Math.min(Math.max(value, lower), upper);
}

function chatMessage(sender, uid, content) {
    return Object.freeze({ 消息UID: uid, 发送者: sender, 内容: content, 时间: '' });
}

function nextChatMessageNumber(sessionUid, recentMessages) {
    const pattern = new RegExp('^msg_' + sessionUid + '_[pns]_(\\d+)$');
    let maximum = 0;
    for (const message of recentMessages) {
        const match = pattern.exec(ownRecord(message) ? message.消息UID : '');
        if (match) maximum = Math.max(maximum, Number(match[1]));
    }
    return Math.max(maximum + 1, recentMessages.length + 1);
}
/**
 * Commits one player message and then applies the role's hidden interaction
 * rhythm locally. A normal outcome appends 1..6 validated role bubbles; a
 * threshold outcome appends only a fixed system notice. Thresholds, states,
 * UIDs and paths never come from the model or UI.
 */
export function buildPrivateChatPatch(state, { sessionUid, npcUid, playerMessage, response } = {}) {
    const request = validatePrivateChatRequest({ state, sessionUid, npcUid, playerMessage });
    if (!request.ok) return fail(request.code);
    if (!isChatSessionUid(sessionUid)) return fail('private_chat_invalid_target');

    let normalizedResponse;
    try { normalizedResponse = normalizePrivateChatResponse(response); }
    catch { return fail('private_chat_response_invalid'); }

    const { session, npc, relationship, playerMessage: normalizedMessage } = request.value;
    const recentMessages = Array.isArray(session.最近消息) ? session.最近消息 : null;
    if (!recentMessages || recentMessages.length > 30) return fail('private_chat_session_messages_invalid');
    for (const field of RELATIONSHIP_VALUE_FIELDS) {
        if (!Number.isInteger(relationship[field]) || relationship[field] < 0 || relationship[field] > 100) return fail('private_chat_relationship_state_invalid');
    }
    const rhythm = decideInteractionRhythm({ relationship, responseRelationship: normalizedResponse.relationship, readWithoutReplyThreshold: npc.已读不回阈值, blockThreshold: npc.拉黑阈值 });
    if (!rhythm) return fail('private_chat_rhythm_state_invalid');

    const nextMessageNumber = nextChatMessageNumber(sessionUid, recentMessages);
    const operations = [{ op: 'add', path: encodeJsonPointer(['会话', sessionUid, '最近消息', '-']), value: chatMessage('玩家', 'msg_' + sessionUid + '_p_' + nextMessageNumber, normalizedMessage) }];
    if (rhythm.outcome === 'replied') {
        normalizedResponse.replies.forEach((reply, index) => operations.push({ op: 'add', path: encodeJsonPointer(['会话', sessionUid, '最近消息', '-']), value: chatMessage('角色', 'msg_' + sessionUid + '_n_' + (nextMessageNumber + index + 1), reply) }));
    } else {
        const blocked = rhythm.outcome === 'blocked';
        operations.push({ op: 'add', path: encodeJsonPointer(['会话', sessionUid, '最近消息', '-']), value: chatMessage('系统', 'msg_' + sessionUid + '_s_' + (nextMessageNumber + 1), blocked ? BLOCKED_CHAT_NOTICE : READ_WITHOUT_REPLY_NOTICE) });
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
    if (rhythm.outcome === 'replied' && Object.hasOwn(normalizedResponse, 'sessionSummary')) operations.push({ op: 'replace', path: encodeJsonPointer(['会话', sessionUid, '长期摘要']), value: normalizedResponse.sessionSummary });
    return success(operations);
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

/** Backwards-compatible name; the operation has always removed the session only. */
export const buildDeletePrivateChatPatch = buildClearPrivateChatPatch;

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
    if (!rolePool || !recommendation || !candidatePool || !sessions || !meetups || !groups) {
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

function meetupDraft({ nickname, time, place, mutualIntent, confirmedBoundaries, pendingItems, riskNotice }) {
    const subject = normalizeMeetupText(nickname, 80, false) || '该匹配对象';
    const details = [
        `对象：${subject}`,
        `时间：${time}`,
        `地点：${place}`,
        `双方意图：${mutualIntent}`,
        `已确认边界：${confirmedBoundaries}`,
    ];
    if (pendingItems) details.push(`待确认事项：${pendingItems}`);
    if (riskNotice) details.push(`风险提示：${riskNotice}`);
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
    const adult = assertKnownAdult(state, npcUid);
    if (!adult.ok) return adult;
    const player = ownRecord(state.玩家);
    const relationship = ownRecord(roleAt(state, npcUid)?.与玩家关系);
    const session = ownRecord(ownRecord(state.会话)?.[sessionUid]);
    const meetupCounter = ownRecord(state.系统)?.UID计数器?.面基;
    if (player?.成人验证 !== true || !relationship || relationship.状态 !== '已匹配'
        || !session || session.对象UID !== npcUid || session.状态 !== '已匹配'
        || !Number.isInteger(meetupCounter) || meetupCounter < 0 || meetupCounter >= 999999) {
        return fail('meetup_preconditions_not_met');
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
        时间: values.时间,
        地点: values.地点,
        双方意图: values.双方意图,
        已确认边界: values.已确认边界,
        待确认事项: values.待确认事项,
        风险提示: values.风险提示,
        状态: '待发送',
        正文结果摘要: '',
    };
    const nickname = ownRecord(adult.value.profile.公开资料)?.昵称;
    return success({
        meetupUid,
        patch: [
            { op: 'add', path: encodeJsonPointer(['面基记录', meetupUid]), value: record },
            { op: 'replace', path: encodeJsonPointer(['系统', 'UID计数器', '面基']), value: meetupCounter + 1 },
        ],
        draft: meetupDraft({ nickname, time: values.时间, place: values.地点, mutualIntent: values.双方意图, confirmedBoundaries: values.已确认边界, pendingItems: values.待确认事项, riskNotice: values.风险提示 }),
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
        长期摘要: '',
        已确认边界: '',
        已确认承诺: '',
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

/** Adds only locally derived public-tag preference writes to an existing Patch. */
function appendPreferenceWeightOperations(state, profile, delta, operations) {
    const weights = ownRecord(ownRecord(state.玩家)?.推荐偏好)?.标签权重;
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
            path: encodeJsonPointer(['玩家', '推荐偏好', '标签权重', tag]),
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
    const weights = ownRecord(ownRecord(state.玩家)?.推荐偏好)?.标签权重;
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
    const accepted = invitation.eligible && invitation.score >= refusalThreshold;
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
        return success([
            { op: 'replace', path: '/软件/内容模式', value: mode === 'SFW' ? 'NSFW' : 'SFW' },
        ]);
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
            } catch { return fail('generated_candidate_invalid'); }
        }
        const generatedMatchRole = /^\/角色池\/(npc_match_\d+)$/u.exec(path);
        if (operation.op === 'add' && generatedMatchRole && isNpcUid(generatedMatchRole[1])) {
            try {
                const source = matchCandidateSourceFromRole(operation.value);
                const expected = matchCandidateForRole(source, 'NSFW', operation.value.与玩家关系.状态);
                if (JSON.stringify(expected) === JSON.stringify(operation.value)) continue;
            } catch { /* reject below */ }
            return fail('candidate_match_candidate_invalid');
        }
        if (operation.op === 'add' && path === '/推荐/当前队列/-' && isNpcUid(operation.value)) continue;
        if (operation.op === 'replace' && path === '/系统/UID计数器/角色' && Number.isInteger(operation.value) && operation.value >= 0 && operation.value <= 999999) continue;
        if (operation.op === 'replace' && path === '/系统/UID计数器/会话' && Number.isInteger(operation.value) && operation.value >= 0 && operation.value <= 999999) continue;
        if (operation.op === 'replace' && path === '/系统/UID计数器/面基' && Number.isInteger(operation.value) && operation.value >= 0 && operation.value <= 999999) continue;
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
            && operation.value.长期摘要 === '' && operation.value.已确认边界 === '' && operation.value.已确认承诺 === '') continue;

        const chatMessagePath = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})\/最近消息\/-$/u.exec(path);
        if (operation.op === 'add' && chatMessagePath && isChatSessionUid(chatMessagePath[1]) && ownRecord(operation.value)
            && ['玩家', '角色', '系统'].includes(operation.value.发送者) && typeof operation.value.消息UID === 'string'
            && typeof operation.value.内容 === 'string' && operation.value.内容.length > 0 && operation.value.内容.length <= MAX_CHAT_MESSAGE_LENGTH
            && operation.value.时间 === '') continue;
        const sessionRemove = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})$/u.exec(path);
        if (operation.op === 'remove' && sessionRemove && isChatSessionUid(sessionRemove[1])) continue;
        const sessionStatus = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})\/状态$/u.exec(path);
        if (operation.op === 'replace' && sessionStatus && isChatSessionUid(sessionStatus[1]) && ['已取消', '已拉黑'].includes(operation.value)) continue;

        const chatRelationship = /^\/角色池\/(npc_[A-Za-z0-9_-]{1,64})\/与玩家关系\/(好感|信任|戒备|面基意愿)$/u.exec(path);
        if (operation.op === 'replace' && chatRelationship && isNpcUid(chatRelationship[1]) && Number.isInteger(operation.value) && operation.value >= 0 && operation.value <= 100) continue;
        const chatSummary = /^\/会话\/(chat_[A-Za-z0-9_-]{1,64})\/长期摘要$/u.exec(path);
        if (operation.op === 'replace' && chatSummary && isChatSessionUid(chatSummary[1]) && typeof operation.value === 'string' && operation.value.length > 0 && operation.value.length <= 500) continue;
        const meetupRecord = /^\/面基记录\/(meetup_[A-Za-z0-9_-]{1,64})$/u.exec(path);
        if (operation.op === 'remove' && meetupRecord && isMeetupUid(meetupRecord[1])) continue;
        if (operation.op === 'add' && meetupRecord && isMeetupUid(meetupRecord[1]) && ownRecord(operation.value)
            && isNpcUid(operation.value.对象UID) && typeof operation.value.时间 === 'string' && operation.value.时间.length > 0 && operation.value.时间.length <= 160
            && typeof operation.value.地点 === 'string' && operation.value.地点.length > 0 && operation.value.地点.length <= 160
            && typeof operation.value.双方意图 === 'string' && operation.value.双方意图.length > 0 && operation.value.双方意图.length <= 500
            && typeof operation.value.已确认边界 === 'string' && operation.value.已确认边界.length > 0 && operation.value.已确认边界.length <= 1200
            && typeof operation.value.待确认事项 === 'string' && operation.value.待确认事项.length <= 800
            && typeof operation.value.风险提示 === 'string' && operation.value.风险提示.length <= 800
            && operation.value.状态 === '待发送' && operation.value.正文结果摘要 === '') continue;
        const groupList = /^\/群组\/(group_[A-Za-z0-9_-]{1,64})\/(成员UID|可发现角色UID)$/u.exec(path);
        if (operation.op === 'replace' && groupList && isGroupUid(groupList[1]) && validUidList(operation.value)) continue;
        const preferenceWeight = /^\/玩家\/推荐偏好\/标签权重\/([^/]+)$/u.exec(path);
        if ((operation.op === 'add' || operation.op === 'replace') && preferenceWeight && Number.isInteger(operation.value) && operation.value >= -5 && operation.value <= 5) continue;

        return fail('patch_path_not_whitelisted', path);
    }
    return success(undefined);
}

function isKnownAdultInState(state, uid) {
    return assertKnownAdult(state, uid).ok;
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
    if (candidateAddition && queueAddition && !queueRemoval) {
        const candidateUid = decodeJsonPointer(candidateAddition.path).at(-1);
        const expected = /^npc_llm_\d+$/u.test(candidateUid)
            ? buildRecommendationInitialCandidatePatch(state, { candidate: candidateAddition.value })
            : buildCharacterRegistrationPatch(state, { candidate: candidateAddition.value });
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
            const summary = patch.find((operation) => operation?.op === 'replace' && operation.path === encodeJsonPointer(['会话', sessionUid, '长期摘要']));
            if (summary) response.sessionSummary = summary.value;
            const expected = validResponse ? buildPrivateChatPatch(state, { sessionUid, npcUid, playerMessage: playerOperation.value?.内容, response }) : fail('private_chat_relationship_state_invalid');
            if (expected.ok && JSON.stringify(expected.value) === JSON.stringify(patch)) return success(undefined);
        }
    }

    const standalonePreferenceOperations = patch.filter((operation) => operation?.op === 'add' || operation?.op === 'replace');
    if (patch.length >= 1 && patch.length <= 12 && standalonePreferenceOperations.length === patch.length
        && patch.every((operation) => /^\/玩家\/推荐偏好\/标签权重\/[^/]+$/u.test(operation.path))) {
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
        return fail('patch_not_exact_ui_transition');
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

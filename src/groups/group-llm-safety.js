import { buildGroupBrowseModel } from './group-discovery-service.js';

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const HTML_PATTERN = /<\s*\/?\s*[a-z][^>]*>/iu;
const GROUP_UID_PATTERN = /^group_[a-z0-9][a-z0-9_-]{0,63}$/i;
const PUBLIC_TEXT_FIELDS = Object.freeze({
    昵称: 80, 年龄段: 32, 性别: 48, 性取向: 80, 城市: 80, 距离范围: 48, 寻找意图: 120, 简介: 500,
});
const PUBLIC_TAG_FIELDS = Object.freeze(['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']);
const UNSAFE_SOFTWARE_PATTERN = /(?:<\/?UpdateVariable\b|JSONPatch|\b(?:api[ _-]?key|apikey|authorization|bearer|access[ _-]?token|password|secret)\b|(?:隐藏资料|仅好友资料|实际年龄|私人备注)|(?:\bpatch\b|["'](?:op|path)["']\s*:)|\/(?:角色池|玩家|会话|群组|软件|系统)\b|(?:性行为|性交|做爱|开房|上床|约炮|裸聊)|(?:发生|进行|描述|演绎).{0,24}(?:性行为|性交|做爱|开房|上床)|(?:性行为|性交|做爱|开房|上床).{0,24}(?:发生|进行|描述|演绎))/iu;

function ownRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/** Reads only own data properties, so untrusted getters cannot run during projection. */
function ownData(record, key) {
    if (!ownRecord(record)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined;
    return descriptor.value;
}

export function cleanGroupLlmText(value, maxLength) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (!text || text.length > maxLength || CONTROL_CHARACTER_PATTERN.test(text) || HTML_PATTERN.test(text)) return '';
    return text;
}

function cleanTags(value) {
    if (!Array.isArray(value)) return Object.freeze([]);
    const tags = [];
    for (const rawTag of value) {
        const tag = cleanGroupLlmText(rawTag, 32);
        if (tag && !tags.includes(tag)) tags.push(tag);
        if (tags.length >= 12) break;
    }
    return Object.freeze(tags);
}

/** Projects a player profile using the same public-field boundary used for group characters. */
export function projectPublicPlayerProfile(player) {
    const publicProfile = ownData(player, '公开资料');
    const result = {};
    for (const [key, maxLength] of Object.entries(PUBLIC_TEXT_FIELDS)) result[key] = cleanGroupLlmText(ownData(publicProfile, key), maxLength);
    for (const key of PUBLIC_TAG_FIELDS) result[key] = cleanTags(ownData(publicProfile, key));
    return Object.freeze(result);
}

/**
 * Produces the sole model context shared by group chat and forum services.
 * It intentionally resolves via the existing read-only group projection and does not disclose UID,
 * candidates, private profiles, relationship state, messages, or any MVU implementation detail.
 */
export function buildPublicGroupLlmContext({ state, groupUid } = {}) {
    const uid = cleanGroupLlmText(groupUid, 80);
    if (!ownRecord(state) || !GROUP_UID_PATTERN.test(uid)) return { ok: false, code: 'group_llm_target_invalid' };
    const group = buildGroupBrowseModel(state).群组.find((item) => item.UID === uid);
    if (!group) return { ok: false, code: 'group_llm_group_not_found' };

    const members = group.成员.slice(0, 16).map((person) => Object.freeze({
        profile: person.公开资料,
    }));
    return Object.freeze({
        ok: true,
        context: Object.freeze({
            contentMode: ownData(ownData(state, '软件'), '内容模式') === 'NSFW' ? 'NSFW' : 'SFW',
            playerPublicProfile: projectPublicPlayerProfile(ownData(state, '玩家')),
            group: Object.freeze({ topic: group.主题, description: group.描述, members: Object.freeze(members) }),
        }),
    });
}

export function parseGroupLlmJson(raw, maxChars = 4_000) {
    if (typeof raw !== 'string' || raw.length < 2 || raw.length > maxChars) return null;
    try {
        const parsed = JSON.parse(raw);
        return ownRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/** Rejects output that is not safe for the software layer, before it can reach UI or MVU. */
export function isSafeGroupLlmOutput(text, maxLength) {
    const clean = cleanGroupLlmText(text, maxLength);
    return Boolean(clean) && !UNSAFE_SOFTWARE_PATTERN.test(clean);
}

export function readEnabledPromptContent(promptPreset) {
    if (!ownRecord(promptPreset) || ownData(promptPreset, 'enabled') !== true) return '';
    return cleanGroupLlmText(ownData(promptPreset, 'content'), 12_000);
}


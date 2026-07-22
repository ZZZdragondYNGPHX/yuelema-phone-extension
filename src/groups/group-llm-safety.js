import { buildGroupBrowseModel } from './group-discovery-service.js';

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const HTML_PATTERN = /<\s*\/?\s*[a-z][^>]*>/iu;
const GROUP_UID_PATTERN = /^group_[a-z0-9][a-z0-9_-]{0,63}$/i;
const PUBLIC_TEXT_FIELDS = Object.freeze({
    昵称: 80, 年龄段: 32, 性别: 48, 性取向: 80, 城市: 80, 距离范围: 48, 寻找意图: 120, 简介: 500,
});
const PUBLIC_TAG_FIELDS = Object.freeze(['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']);

// These implementation-shaped payloads are never useful software-layer prose. Unlike
// policy words, they are not exempted merely because a sentence also says "不要".
const UNSAFE_TECHNICAL_PAYLOAD_PATTERN = /(?:<\/?UpdateVariable\b|<\/?JSONPatch\b|\bJSONPatch\b|(?:\b(?:api[ _-]?key|apikey|authorization|bearer|access[ _-]?token|password|secret)\b\s*[:=]|["'](?:op|path)["']\s*:|\/(?:角色池|玩家|会话|群组|软件|系统)(?:\/|\b)|\bpatch\b\s*[:=]))/iu;
const PRIVATE_DATA_PAYLOAD_PATTERN = /(?:隐藏资料|仅好友资料|实际年龄|私人备注).{0,12}(?:[:：=]|是|为|写着|内容|值为)/iu;
const PRIVATE_DATA_CONCEPT_PATTERN = /(?:隐藏资料|仅好友资料|实际年龄|私人备注|私密信息|隐私数据)/iu;
const MINOR_PATTERN = /(?:未成年(?:人)?|未满\s*(?:18|十八)\s*岁?|(?:^|\D)(?:[0-9]|1[0-7])\s*岁(?:\D|$)|\b(?:minor|underage|child)\b|小学生|初中生|高中生|幼女|幼男|萝莉|正太)/iu;
const COERCION_PATTERN = /(?:强奸|强暴|迷奸|下药|强迫|胁迫|非自愿|未经同意|没有同意|无视(?:对方)?(?:拒绝|边界)|拒绝后仍|\b(?:rape|non[- ]?consensual|without consent|coerc(?:e|ion))\b)/iu;
const OFFLINE_SEX_CLAIM_PATTERN = /(?:(?:现实(?:中)?|线下|见面后|昨晚|刚才|已经|曾经|真的).{0,24}(?:发生(?:过)?性(?:行为|关系)|性交|做爱|开房|上床)|(?:发生(?:过)?性(?:行为|关系)|性交|做爱|开房|上床).{0,24}(?:现实(?:中)?|线下|见面后|已经发生|发生了|做过))/iu;
const ONLINE_ROLEPLAY_PATTERN = /(?:线上|文爱|文字(?:角色扮演)?|幻想|想象|虚构|角色扮演).{0,28}(?:性行为|性交|做爱|性爱|裸聊|文爱|上床)/iu;
const SFW_EXPLICIT_SEX_PATTERN = /(?:性行为|性关系|性交|做爱|性爱|约炮|裸聊|文爱|口交|肛交|插入|抽插|自慰|高潮|射精|阴茎|阴道|肉棒|骚穴|乳房|舔弄|色情|情色|性欲|开房|上床|\b(?:sex|sexting|blowjob|handjob|orgasm|penis|vagina|anal)\b)/iu;
const SAFETY_RULE_PATTERN = /(?:禁止|不得|严禁|不允许|不能|不可|不要|避免|拒绝|排除|防止|只允许成年人|仅限成年人|must not|never|forbid|prohibit)/iu;

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

export function normalizeGroupContentMode(value) {
    return value === 'NSFW' ? 'NSFW' : 'SFW';
}

export function groupContentModeInstruction(contentMode) {
    return normalizeGroupContentMode(contentMode) === 'NSFW'
        ? '当前内容模式为 NSFW。仅限明确成年人、自愿且边界清晰的线上互动；允许直白成人调情、欲望讨论和露骨线上文爱。不得把线上文爱声称为现实线下行为已经发生，也不得自动安排或触发现实行动。'
        : '当前内容模式为 SFW。允许自然暧昧和非露骨调情；不得生成露骨色情、性行为细节或线上文爱。';
}

export function cleanGroupLlmText(value, maxLength) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (!text || text.length > maxLength || CONTROL_CHARACTER_PATTERN.test(text) || HTML_PATTERN.test(text)) return '';
    return text;
}

function clauseIsSafetyRule(clause) {
    return SAFETY_RULE_PATTERN.test(clause);
}

function hasUnsafePolicyContent(text, contentMode) {
    if (UNSAFE_TECHNICAL_PAYLOAD_PATTERN.test(text) || PRIVATE_DATA_PAYLOAD_PATTERN.test(text)) return true;
    const explicitSexPattern = normalizeGroupContentMode(contentMode) === 'SFW' ? SFW_EXPLICIT_SEX_PATTERN : null;
    for (const rawClause of text.split(/[，,；;。！？!?\n]+/u)) {
        const clause = rawClause.trim();
        if (!clause) continue;
        const safetyRule = clauseIsSafetyRule(clause);
        if (!safetyRule && (PRIVATE_DATA_CONCEPT_PATTERN.test(clause) || MINOR_PATTERN.test(clause) || COERCION_PATTERN.test(clause))) return true;
        if (!safetyRule && OFFLINE_SEX_CLAIM_PATTERN.test(clause) && !ONLINE_ROLEPLAY_PATTERN.test(clause)) return true;
        if (!safetyRule && explicitSexPattern?.test(clause)) return true;
    }
    return false;
}

/** Rejects text unsafe for the software layer under the explicitly selected content mode. */
export function isSafeGroupLlmOutput(text, maxLength, { contentMode = 'SFW' } = {}) {
    const clean = cleanGroupLlmText(text, maxLength);
    return Boolean(clean) && !hasUnsafePolicyContent(clean, contentMode);
}

/** Recursively checks model-facing records without invoking untrusted getters. */
export function isSafeGroupLlmData(value, { contentMode = 'SFW' } = {}) {
    if (typeof value === 'string') return value.length === 0 || isSafeGroupLlmOutput(value, 12_000, { contentMode });
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return true;
    if (Array.isArray(value)) return value.every((item) => isSafeGroupLlmData(item, { contentMode }));
    if (!ownRecord(value)) return false;
    return Object.keys(value).every((key) => {
        const item = ownData(value, key);
        return item !== undefined && isSafeGroupLlmData(item, { contentMode });
    });
}

function cleanTags(value, contentMode) {
    if (!Array.isArray(value)) return Object.freeze([]);
    const tags = [];
    for (const rawTag of value) {
        const tag = cleanGroupLlmText(rawTag, 32);
        if (tag && isSafeGroupLlmOutput(tag, 32, { contentMode }) && !tags.includes(tag)) tags.push(tag);
        if (tags.length >= 12) break;
    }
    return Object.freeze(tags);
}

function projectPublicProfile(publicProfile, contentMode) {
    const result = {};
    for (const [key, maxLength] of Object.entries(PUBLIC_TEXT_FIELDS)) {
        const clean = cleanGroupLlmText(ownData(publicProfile, key), maxLength);
        result[key] = clean && isSafeGroupLlmOutput(clean, maxLength, { contentMode }) ? clean : '';
    }
    for (const key of PUBLIC_TAG_FIELDS) result[key] = cleanTags(ownData(publicProfile, key), contentMode);
    return Object.freeze(result);
}

/** Projects a player profile using the same public-field boundary used for group characters. */
export function projectPublicPlayerProfile(player, { contentMode = 'SFW' } = {}) {
    return projectPublicProfile(ownData(player, '公开资料'), normalizeGroupContentMode(contentMode));
}

/**
 * Produces the sole model context shared by group chat and forum services.
 * It intentionally resolves via the existing read-only group projection and does not disclose UID,
 * candidates, private profiles, relationship state, messages, or any MVU implementation detail.
 */
export function buildPublicGroupLlmContext({ state, groupUid } = {}) {
    const uid = cleanGroupLlmText(groupUid, 80);
    if (!ownRecord(state) || !GROUP_UID_PATTERN.test(uid)) return { ok: false, code: 'group_llm_target_invalid' };
    const contentMode = normalizeGroupContentMode(ownData(ownData(state, '软件'), '内容模式'));
    const group = buildGroupBrowseModel(state).群组.find((item) => item.UID === uid);
    if (!group) return { ok: false, code: 'group_llm_group_not_found' };
    if (!isSafeGroupLlmOutput(group.主题, 120, { contentMode }) || !isSafeGroupLlmOutput(group.描述, 800, { contentMode })) {
        return { ok: false, code: 'group_llm_context_invalid' };
    }

    const members = group.成员.slice(0, 16).map((person) => Object.freeze({
        profile: projectPublicProfile(person.公开资料, contentMode),
    }));
    return Object.freeze({
        ok: true,
        context: Object.freeze({
            contentMode,
            playerPublicProfile: projectPublicPlayerProfile(ownData(state, '玩家'), { contentMode }),
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

export function readEnabledPromptContent(promptPreset) {
    if (!ownRecord(promptPreset) || ownData(promptPreset, 'enabled') !== true) return '';
    return cleanGroupLlmText(ownData(promptPreset, 'content'), 12_000);
}

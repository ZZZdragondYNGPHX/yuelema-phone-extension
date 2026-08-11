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
// 阶段 55: the former SFW explicit-vocabulary clause blocklist is gone. Adult
// consensual wording is never a rejection reason by itself; the SFW/NSFW tone
// difference lives only in the mode instruction copy below. Hard, mode-
// independent bans remain: minors, coercion, private data and technical payloads.
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
        ? '当前内容模式为 NSFW。仅限明确成年人、自愿且边界清晰的内容；色情尺度不设上限，可主动、完整描写裸体、器官、自慰、口交、性交、高潮、体液、性玩具、BDSM、多人幻想、性经历、情色角色扮演及其他成人玩法，不强制含蓄、转场或淡出。不得把输入中未提供的玩家现实经历伪造成事实，也不得自动安排或触发现实行动。'
        : '当前内容模式为 SFW。本模式保持日常社交尺度，以自然暧昧和轻度调情为主。';
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

function hasUnsafePolicyContent(text) {
    if (UNSAFE_TECHNICAL_PAYLOAD_PATTERN.test(text) || PRIVATE_DATA_PAYLOAD_PATTERN.test(text)) return true;
    for (const rawClause of text.split(/[，,；;。！？!?\n]+/u)) {
        const clause = rawClause.trim();
        if (!clause) continue;
        const safetyRule = clauseIsSafetyRule(clause);
        if (!safetyRule && (PRIVATE_DATA_CONCEPT_PATTERN.test(clause) || MINOR_PATTERN.test(clause) || COERCION_PATTERN.test(clause))) return true;
    }
    return false;
}

/**
 * Rejects text unsafe for the software layer. The contentMode option is kept
 * for call-site compatibility; since 阶段 55 the mode changes prompt copy only
 * and never turns adult consensual wording into a rejection reason.
 */
export function isSafeGroupLlmOutput(text, maxLength, { contentMode = 'SFW' } = {}) { // eslint-disable-line no-unused-vars
    const clean = cleanGroupLlmText(text, maxLength);
    return Boolean(clean) && !hasUnsafePolicyContent(clean);
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

// —— 控制台诊断辅助（阶段 77 安全控制台接线）——
// 群聊/论坛/本地总结服务在失败结果上附带 `diagnostic` 纯数据记录，由持有台账
// handle 的页面层经 buildErrorDetail 格式化进控制台 detail。记录只含阶段/错误码/
// HTTP 状态/字段路径/期望摘要与模型输出不合规点，绝不含隐藏资料值、关系分或凭据。
const MAX_GROUP_DIAGNOSTIC_TEXT_LENGTH = 300;

function groupDiagnosticText(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    return text.length > MAX_GROUP_DIAGNOSTIC_TEXT_LENGTH ? `${text.slice(0, MAX_GROUP_DIAGNOSTIC_TEXT_LENGTH)}…` : text;
}

/**
 * 控制台脱敏器会把 ≥32 字符的连续 [A-Za-z0-9+/=_-] token 视作疑似凭据并替换
 * 为 [已脱敏]；超长错误码改用空格分词形式呈现，信息不丢也不触发误脱敏。
 */
export function presentGroupDiagnosticCode(code) {
    const text = groupDiagnosticText(typeof code === 'string' ? code : '');
    if (!text) return '';
    return text.length >= 32 ? text.split('_').join(' ') : text;
}

/** 组装冻结的诊断记录；空字段剔除，文本统一截断。 */
export function groupDiagnostic(record = {}) {
    const normalized = {};
    for (const [key, value] of [
        ['stage', groupDiagnosticText(record.stage)],
        ['code', presentGroupDiagnosticCode(record.code)],
        ['field', groupDiagnosticText(record.field)],
        ['expected', groupDiagnosticText(record.expected)],
        ['actual', groupDiagnosticText(record.actual)],
        ['hint', groupDiagnosticText(record.hint)],
    ]) {
        if (value) normalized[key] = value;
    }
    if (record.error && typeof record.error === 'object') normalized.error = Object.freeze({ ...record.error });
    return Object.freeze(normalized);
}

/**
 * 把共享 LLM 客户端抛出的异常收敛为诊断记录：读到什么字段就带什么
 * （name/message/code/status/bodyExcerpt），字段缺失时优雅降级。
 */
export function projectGroupLlmErrorDiagnostic(error, stage = '模型请求') {
    const summary = {};
    if (error && typeof error === 'object') {
        const name = groupDiagnosticText(error.name);
        const message = groupDiagnosticText(error.message);
        if (name) summary.name = name;
        if (message) summary.message = message;
        const code = presentGroupDiagnosticCode(typeof error.code === 'string' ? error.code : '');
        if (code) summary.code = code;
        const status = [error.status, error.statusCode, error.httpStatus].find((value) => Number.isInteger(value));
        if (status !== undefined) summary.status = status;
    }
    const excerpt = groupDiagnosticText(error && typeof error === 'object' && typeof error.bodyExcerpt === 'string' ? error.bodyExcerpt : '');
    return groupDiagnostic({
        stage,
        actual: excerpt ? `响应片段：${excerpt}` : '',
        error: Object.keys(summary).length ? summary : undefined,
    });
}

/** 模型响应无法解析为受限 JSON 时的“实际”摘要：只报长度/类型，不带原文。 */
export function groupResponseParseDiagnostic(raw, maxChars = 4_000) {
    const actual = typeof raw !== 'string' ? '非文本响应' : (raw.length === 0 ? '空响应' : `响应长度 ${raw.length} 字符（非合法 JSON 对象或超出 ${maxChars} 字符上限）`);
    return groupDiagnostic({ stage: '响应解析', expected: '合法 JSON 对象', actual });
}

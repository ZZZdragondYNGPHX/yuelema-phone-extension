import { toPublicLlmError } from '../llm/openai-compatible-client.js';
import { renderPromptPreset } from '../settings/prompt-compiler.js';

const MAX_MODEL_RESPONSE_CHARS = 8_000;
const MAX_TAGS = 12;
const MAX_TAG_WEIGHTS = 64;
const MAX_EXPLANATION_LENGTH = 500;
const MAX_TEXT_FILTER_VALUES = 12;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const HTML_PATTERN = /<\s*\/?\s*[a-z][^>]*>/iu;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_KEY_PATTERN = /(?:hidden|private|friend|candidate|session|uid|patch|path|api[_ -]?key|token|authorization|secret|隐藏|仅好友|候选|会话|补丁|路径|密钥|令牌)/iu;
const FORBIDDEN_DISCLOSURE_PATTERN = /(?:隐藏资料|仅好友资料|候选(?:NPC|角色)?|会话|json\s*patch|补丁|路径|api\s*(?:key|密钥)|api[_-]?key|授权|authorization|\btoken\b|\buid\b)/iu;

const SOUL_MATCH_ERROR_MESSAGES = Object.freeze({
    soul_match_state_invalid: '当前软件状态无法用于灵魂匹配。',
    soul_match_settings_unavailable: '灵魂匹配设置暂不可用。',
    soul_match_settings_invalid: '灵魂匹配预设无效，请检查设置。',
    soul_match_connection_missing: '请先为“灵魂匹配”绑定连接预设或设置默认连接。',
    soul_match_llm_unavailable: '当前浏览器未提供灵魂匹配模型连接。',
    soul_match_invalid_json: '模型没有返回可用的灵魂匹配草稿；当前偏好未改变。',
    soul_match_response_invalid: '灵魂匹配草稿不符合安全格式；当前偏好未改变。',
});

const TEXT_MATCH_ERROR_MESSAGES = Object.freeze({
    text_match_state_invalid: '当前软件状态无法用于文字匹配。',
    text_match_settings_unavailable: '文字匹配设置暂不可用。',
    text_match_settings_invalid: '文字匹配预设无效，请检查设置。',
    text_match_connection_missing: '请先为“文字匹配”绑定连接预设或设置默认连接。',
    text_match_llm_unavailable: '当前浏览器未提供文字匹配模型连接。',
    text_match_invalid_json: '模型没有返回可用的文字匹配筛选草稿；当前筛选未改变。',
    text_match_response_invalid: '文字匹配草稿不符合安全格式；当前筛选未改变。',
});

function ownPlainRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/** Reads only an own enumerable data property, never a getter or inherited field. */
function ownData(record, key) {
    if (!ownPlainRecord(record)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined;
    return descriptor.value;
}

function cleanText(value, maxLength) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (!text || text.length > maxLength || CONTROL_CHARACTER_PATTERN.test(text) || HTML_PATTERN.test(text)) return '';
    return text;
}

function cleanPublicTags(value) {
    if (!Array.isArray(value)) return Object.freeze([]);
    const tags = [];
    for (const raw of value) {
        const tag = cleanText(raw, 32);
        if (tag && !tags.includes(tag)) tags.push(tag);
        if (tags.length >= MAX_TAGS) break;
    }
    return Object.freeze(tags);
}

function projectPublicProfile(value) {
    const profile = ownPlainRecord(value) ? value : null;
    return Object.freeze({
        昵称: cleanText(ownData(profile, '昵称'), 80),
        年龄段: cleanText(ownData(profile, '年龄段'), 32),
        性别: cleanText(ownData(profile, '性别'), 48),
        性取向: cleanText(ownData(profile, '性取向'), 80),
        城市: cleanText(ownData(profile, '城市'), 80),
        距离范围: cleanText(ownData(profile, '距离范围'), 48),
        寻找意图: cleanText(ownData(profile, '寻找意图'), 120),
        简介: cleanText(ownData(profile, '简介'), 500),
        兴趣标签: cleanPublicTags(ownData(profile, '兴趣标签')),
        生活方式标签: cleanPublicTags(ownData(profile, '生活方式标签')),
        性格标签: cleanPublicTags(ownData(profile, '性格标签')),
        沟通风格标签: cleanPublicTags(ownData(profile, '沟通风格标签')),
    });
}

function projectTagWeights(value) {
    if (!ownPlainRecord(value)) return Object.freeze({});
    const weights = {};
    for (const key of Object.keys(value)) {
        const tag = cleanText(key, 32);
        const weight = ownData(value, key);
        if (tag && Number.isInteger(weight) && weight >= -5 && weight <= 5) weights[tag] = weight;
        if (Object.keys(weights).length >= MAX_TAG_WEIGHTS) break;
    }
    return Object.freeze(weights);
}

/**
 * Projects exactly the three values allowed to reach either match-draft model.
 * It deliberately has no traversal of hidden/friend data, candidates, sessions,
 * identifiers, patch state, settings secrets, or any other state subtree.
 */
export function buildSoulTextMatchContext(state) {
    const root = ownPlainRecord(state) ? state : null;
    const player = ownData(root, '玩家');
    const software = ownData(root, '软件');
    const publicProfile = ownData(player, '公开资料');
    const recommendation = ownData(player, '推荐偏好');
    const tagWeights = ownData(recommendation, '标签权重');
    return Object.freeze({
        contentMode: ownData(software, '内容模式') === 'NSFW' ? 'NSFW' : 'SFW',
        playerPublicProfile: projectPublicProfile(publicProfile),
        tagWeights: projectTagWeights(tagWeights),
    });
}

function validationError(code) {
    const error = new TypeError(`yuelema_soul_text_match:${code}`);
    error.code = code;
    return error;
}

function failResponse(kind, suffix) {
    throw validationError(`${kind}_match_response_${suffix}`);
}

function assertSafeKey(kind, key) {
    if (DANGEROUS_KEYS.has(key)) failResponse(kind, 'dangerous_key');
    if (SENSITIVE_KEY_PATTERN.test(key)) failResponse(kind, 'sensitive_key');
}

function ownEnumerableData(kind, record, key) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        failResponse(kind, 'accessor_or_hidden_field');
    }
    return descriptor.value;
}

function assertExactRecord(kind, value, required, optional = []) {
    if (!ownPlainRecord(value)) failResponse(kind, 'required');
    const allowed = new Set([...required, ...optional]);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') failResponse(kind, 'dangerous_key');
        assertSafeKey(kind, key);
        if (!allowed.has(key)) failResponse(kind, 'unknown_field');
        ownEnumerableData(kind, value, key);
    }
    for (const key of required) {
        if (!Object.hasOwn(value, key)) failResponse(kind, 'missing_field');
        ownEnumerableData(kind, value, key);
    }
}

function normalizeDraftText(kind, value, maxLength) {
    const text = cleanText(value, maxLength);
    if (!text || FORBIDDEN_DISCLOSURE_PATTERN.test(text)) failResponse(kind, 'text_invalid');
    return text;
}

function normalizeTextArray(kind, value, maxItems, maxLength) {
    if (!Array.isArray(value) || value.length > maxItems) failResponse(kind, 'array_invalid');
    const result = [];
    for (const raw of value) {
        const text = normalizeDraftText(kind, raw, maxLength);
        if (result.includes(text)) failResponse(kind, 'array_invalid');
        result.push(text);
    }
    return Object.freeze(result);
}

/**
 * Strict model codec for a soul-match draft. The weights are intended target
 * values in the existing public -5..5 preference range; they are not a Patch
 * and this service never writes them.
 */
export function normalizeSoulMatchDraft(raw) {
    const kind = 'soul';
    assertExactRecord(kind, raw, ['tagWeightDraft', 'explanation']);
    const source = ownEnumerableData(kind, raw, 'tagWeightDraft');
    if (!Array.isArray(source) || source.length < 1 || source.length > MAX_TAGS) failResponse(kind, 'draft_invalid');
    const tagWeightDraft = [];
    for (const item of source) {
        assertExactRecord(kind, item, ['tag', 'weight']);
        const tag = normalizeDraftText(kind, ownEnumerableData(kind, item, 'tag'), 32);
        const weight = ownEnumerableData(kind, item, 'weight');
        if (!Number.isInteger(weight) || weight < -5 || weight > 5 || tagWeightDraft.some((entry) => entry.tag === tag)) {
            failResponse(kind, 'draft_invalid');
        }
        tagWeightDraft.push(Object.freeze({ tag, weight }));
    }
    return Object.freeze({
        tagWeightDraft: Object.freeze(tagWeightDraft),
        explanation: normalizeDraftText(kind, ownEnumerableData(kind, raw, 'explanation'), MAX_EXPLANATION_LENGTH),
    });
}

/**
 * Strict model codec for a one-off text-match draft. Every filter maps to a
 * public profile field; this service neither resolves candidates nor persists it.
 */
export function normalizeTextMatchDraft(raw) {
    const kind = 'text';
    assertExactRecord(kind, raw, ['filters', 'explanation']);
    const source = ownEnumerableData(kind, raw, 'filters');
    const filterKeys = ['城市', '年龄段', '距离范围', '寻找意图关键词', '包含标签', '排除标签', '简介关键词'];
    assertExactRecord(kind, source, filterKeys);
    const filters = Object.freeze({
        城市: normalizeTextArray(kind, ownEnumerableData(kind, source, '城市'), MAX_TEXT_FILTER_VALUES, 80),
        年龄段: normalizeTextArray(kind, ownEnumerableData(kind, source, '年龄段'), MAX_TEXT_FILTER_VALUES, 32),
        距离范围: normalizeTextArray(kind, ownEnumerableData(kind, source, '距离范围'), MAX_TEXT_FILTER_VALUES, 48),
        寻找意图关键词: normalizeTextArray(kind, ownEnumerableData(kind, source, '寻找意图关键词'), MAX_TEXT_FILTER_VALUES, 64),
        包含标签: normalizeTextArray(kind, ownEnumerableData(kind, source, '包含标签'), MAX_TEXT_FILTER_VALUES, 32),
        排除标签: normalizeTextArray(kind, ownEnumerableData(kind, source, '排除标签'), MAX_TEXT_FILTER_VALUES, 32),
        简介关键词: normalizeTextArray(kind, ownEnumerableData(kind, source, '简介关键词'), MAX_TEXT_FILTER_VALUES, 64),
    });
    if (!Object.values(filters).some((items) => items.length > 0)) failResponse(kind, 'filters_empty');
    return Object.freeze({
        filters,
        explanation: normalizeDraftText(kind, ownEnumerableData(kind, raw, 'explanation'), MAX_EXPLANATION_LENGTH),
    });
}

function makeSoulMessages(context, promptPreset) {
    const preset = renderPromptPreset(promptPreset);
    const system = [
        '你是现代现实都市线上约会软件的“灵魂匹配”辅助功能。仅依据提供的玩家公开资料、公开标签偏好与 SFW/NSFW 模式提出偏好草稿。',
        '不要索取、推断、复述或输出隐藏资料、仅好友资料、候选角色、会话、UID、Patch、路径、API Key 或任何密钥。不得创建角色、匹配或会话，也不得输出筛选条件。',
        '只输出合法 JSON 对象，不得使用 Markdown、代码块或解释文字。严格形状为：{"tagWeightDraft":[{"tag":"公开标签","weight":-5..5整数}],"explanation":"1-500字公开偏好说明"}。tagWeightDraft 为 1–12 个不重复的公开标签目标权重草稿，不是增量、不是 JSONPatch，也不会自动保存。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `请只基于以下受限公开上下文生成灵魂匹配草稿：\n${JSON.stringify(context)}` },
    ];
}

function makeTextMessages(context, promptPreset) {
    const preset = renderPromptPreset(promptPreset);
    const system = [
        '你是现代现实都市线上约会软件的“文字匹配”辅助功能。仅依据提供的玩家公开资料、公开标签偏好与 SFW/NSFW 模式提出一次性公开筛选草稿。',
        '不要索取、推断、复述或输出隐藏资料、仅好友资料、候选角色、会话、UID、Patch、路径、API Key 或任何密钥。不得创建角色、匹配或会话，也不得输出标签权重。',
        '只输出合法 JSON 对象，不得使用 Markdown、代码块或解释文字。严格形状为：{"filters":{"城市":["最多12项"],"年龄段":["最多12项"],"距离范围":["最多12项"],"寻找意图关键词":["最多12项"],"包含标签":["最多12项"],"排除标签":["最多12项"],"简介关键词":["最多12项"]},"explanation":"1-500字公开筛选说明"}。至少一个筛选数组必须非空。filters 只用于本次展示，不是 JSONPatch，也不会自动保存。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `请只基于以下受限公开上下文生成文字匹配草稿：\n${JSON.stringify(context)}` },
    ];
}

function parseResponseJson(raw) {
    if (typeof raw !== 'string' || raw.length < 2 || raw.length > MAX_MODEL_RESPONSE_CHARS) return null;
    try {
        const parsed = JSON.parse(raw);
        return ownPlainRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function safeModelFailure(kind) {
    return {
        ok: false,
        code: `${kind}_match_response_invalid`,
        message: kind === 'soul' ? SOUL_MATCH_ERROR_MESSAGES.soul_match_response_invalid : TEXT_MATCH_ERROR_MESSAGES.text_match_response_invalid,
    };
}

async function generateMatchDraft({ kind, state, settingsStore, llmClient, signal }) {
    const errorMessages = kind === 'soul' ? SOUL_MATCH_ERROR_MESSAGES : TEXT_MATCH_ERROR_MESSAGES;
    const functionKey = kind === 'soul' ? 'soul_match' : 'text_match';
    const prefix = `${kind}_match`;
    if (!ownPlainRecord(state)) return { ok: false, code: `${prefix}_state_invalid`, message: errorMessages[`${prefix}_state_invalid`] };
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return { ok: false, code: `${prefix}_settings_unavailable`, message: errorMessages[`${prefix}_settings_unavailable`] };
    if (!llmClient || typeof llmClient.chat !== 'function') return { ok: false, code: `${prefix}_llm_unavailable`, message: errorMessages[`${prefix}_llm_unavailable`] };

    let resolved;
    try {
        resolved = settingsStore.resolveFunction(functionKey);
    } catch {
        return { ok: false, code: `${prefix}_settings_invalid`, message: errorMessages[`${prefix}_settings_invalid`] };
    }
    if (!resolved?.connectionPreset) {
        return { ok: false, code: `${prefix}_connection_missing`, message: errorMessages[`${prefix}_connection_missing`] };
    }

    try {
        const messages = kind === 'soul' ? makeSoulMessages(buildSoulTextMatchContext(state), resolved.promptPreset) : makeTextMessages(buildSoulTextMatchContext(state), resolved.promptPreset);
        const completion = await llmClient.chat({ preset: resolved.connectionPreset, messages, signal });
        const parsed = parseResponseJson(completion?.text);
        if (!parsed) return { ok: false, code: `${prefix}_invalid_json`, message: errorMessages[`${prefix}_invalid_json`] };
        const draft = kind === 'soul' ? normalizeSoulMatchDraft(parsed) : normalizeTextMatchDraft(parsed);
        return Object.freeze({ ok: true, draft });
    } catch (error) {
        if (error instanceof TypeError && typeof error.code === 'string' && error.code.startsWith(`${kind}_match_response_`)) {
            return safeModelFailure(kind);
        }
        const publicError = toPublicLlmError(error);
        return { ok: false, code: publicError.code, message: publicError.message, retryable: publicError.retryable };
    }
}

/** Calls the soul-match binding and returns a validated public tag-weight draft only. */
export async function generateSoulMatchDraft({ state, settingsStore, llmClient, signal } = {}) {
    return generateMatchDraft({ kind: 'soul', state, settingsStore, llmClient, signal });
}

/** Calls the text-match binding and returns a validated one-off public filter draft only. */
export async function generateTextMatchDraft({ state, settingsStore, llmClient, signal } = {}) {
    return generateMatchDraft({ kind: 'text', state, settingsStore, llmClient, signal });
}




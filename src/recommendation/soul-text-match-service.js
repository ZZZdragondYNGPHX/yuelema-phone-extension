import { toPublicLlmError } from '../llm/openai-compatible-client.js';
import { renderPromptPreset } from '../settings/prompt-compiler.js';

const MAX_MODEL_RESPONSE_CHARS = 8_000;
const MAX_TAGS = 12;
const MAX_TAG_WEIGHTS = 64;
const MAX_EXPLANATION_LENGTH = 500;
const MAX_TEXT_FILTER_VALUES = 12;
const MAX_VOICE_TEXT_LENGTH = 800;
const MAX_LOCAL_KEYWORD_WEIGHTS = 64;
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

const CANDIDATE_MATCH_ERROR_MESSAGES = Object.freeze({
    candidate_match_mode_invalid: '匹配方式无效。',
    candidate_match_state_invalid: '当前软件状态无法用于生成匹配推荐。',
    candidate_match_settings_unavailable: '匹配功能设置暂不可用。',
    candidate_match_settings_invalid: '匹配功能预设无效，请检查设置。',
    candidate_match_local_preferences_unavailable: '本地个性化关键词暂不可用。',
    candidate_match_local_preferences_invalid: '本地个性化关键词格式无效。',
    candidate_match_voice_text_invalid: '请输入 1–800 个字符的匹配描述。',
    candidate_match_connection_missing: '请先为该匹配功能绑定连接预设或设置默认连接。',
    candidate_match_llm_unavailable: '当前浏览器未提供匹配模型连接。',
    candidate_match_invalid_json: '模型没有返回可用的匹配角色草稿；当前状态未改变。',
    candidate_match_response_invalid: '匹配角色草稿不符合公开资料安全格式；当前状态未改变。',
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

function freezeKeywordWeights(entries) {
    return Object.freeze(entries.map((entry) => Object.freeze({ keyword: entry.keyword, weight: entry.weight })));
}

function normalizeKeywordWeightEntries(kind, value, { minItems = 0, maxItems = MAX_LOCAL_KEYWORD_WEIGHTS } = {}) {
    if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) failResponse(kind, 'keyword_weights_invalid');
    const entries = [];
    const seen = new Set();
    for (const item of value) {
        assertExactRecord(kind, item, ['keyword', 'weight']);
        const keyword = normalizeDraftText(kind, ownEnumerableData(kind, item, 'keyword'), 40);
        const normalizedKeyword = keyword.toLocaleLowerCase('zh-Hans-CN');
        const weight = ownEnumerableData(kind, item, 'weight');
        if (!Number.isInteger(weight) || weight < -5 || weight > 5 || seen.has(normalizedKeyword)) {
            failResponse(kind, 'keyword_weights_invalid');
        }
        seen.add(normalizedKeyword);
        entries.push({ keyword, weight });
    }
    return freezeKeywordWeights(entries);
}

function readSavedLocalKeywordWeights(settingsStore) {
    if (!settingsStore || typeof settingsStore.snapshot !== 'function') {
        return { ok: false, code: 'candidate_match_local_preferences_unavailable' };
    }
    try {
        const snapshot = settingsStore.snapshot();
        const personalization = ownData(snapshot, 'personalization');
        const keywordWeights = ownData(personalization, 'keywordWeights');
        return { ok: true, keywordWeights: normalizeKeywordWeightEntries('candidate', keywordWeights) };
    } catch {
        return { ok: false, code: 'candidate_match_local_preferences_invalid' };
    }
}

/** Voice-derived weights take precedence over a same-key saved local preference. */
export function mergeMatchKeywordWeights(localKeywordWeights, voiceKeywordWeights = []) {
    const local = normalizeKeywordWeightEntries('candidate', localKeywordWeights);
    const voice = normalizeKeywordWeightEntries('candidate', voiceKeywordWeights);
    const merged = new Map();
    for (const entry of local) merged.set(entry.keyword.toLocaleLowerCase('zh-Hans-CN'), entry);
    for (const entry of voice) merged.set(entry.keyword.toLocaleLowerCase('zh-Hans-CN'), entry);
    return freezeKeywordWeights([...merged.values()]);
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

function normalizeOptionalPublicTags(kind, value) {
    if (!Array.isArray(value) || value.length > MAX_TAGS) failResponse(kind, 'candidate_profile_invalid');
    const tags = [];
    const seen = new Set();
    for (const raw of value) {
        const tag = normalizeDraftText(kind, raw, 32);
        const folded = tag.toLocaleLowerCase('zh-Hans-CN');
        if (seen.has(folded)) failResponse(kind, 'candidate_profile_invalid');
        seen.add(folded);
        tags.push(tag);
    }
    return Object.freeze(tags);
}

function assertExplicitAdult(kind, ageBand) {
    if (/成年人|成人|18\s*(?:岁)?(?:以上|\+)/u.test(ageBand)) return;
    const ages = [...ageBand.matchAll(/\d{1,3}/gu)].map((match) => Number(match[0]));
    if (ages.length > 0 && ages.every((age) => age >= 18)) return;
    failResponse(kind, 'candidate_not_adult');
}

/**
 * Strictly validates one ephemeral, public-only adult candidate profile. This
 * is deliberately not a complete MVU character: it has no UID, friend-only or
 * hidden profile, relationship metrics, threshold, session, or Patch field.
 */
export function normalizeCandidateMatchDraft(raw) {
    const kind = 'candidate';
    assertExactRecord(kind, raw, ['profile', 'explanation', 'matchScore']);
    const profile = ownEnumerableData(kind, raw, 'profile');
    const textFields = {
        昵称: 80, 年龄段: 32, 性别: 48, 性取向: 80, 城市: 80, 距离范围: 48, 寻找意图: 120, 简介: 500,
    };
    const tagFields = ['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签'];
    assertExactRecord(kind, profile, [...Object.keys(textFields), ...tagFields]);
    const publicProfile = {};
    for (const [field, maxLength] of Object.entries(textFields)) {
        publicProfile[field] = normalizeDraftText(kind, ownEnumerableData(kind, profile, field), maxLength);
    }
    assertExplicitAdult(kind, publicProfile.年龄段);
    for (const field of tagFields) publicProfile[field] = normalizeOptionalPublicTags(kind, ownEnumerableData(kind, profile, field));
    const matchScore = ownEnumerableData(kind, raw, 'matchScore');
    if (!Number.isInteger(matchScore) || matchScore < 0 || matchScore > 100) failResponse(kind, 'match_score_invalid');
    return Object.freeze({
        profile: Object.freeze(publicProfile),
        explanation: normalizeDraftText(kind, ownEnumerableData(kind, raw, 'explanation'), MAX_EXPLANATION_LENGTH),
        matchScore,
    });
}

/** Parses the transient voice-text -> keyword-weights stage; UI never receives it. */
export function normalizeVoiceKeywordWeightDraft(raw) {
    const kind = 'voice';
    assertExactRecord(kind, raw, ['keywordWeights']);
    return Object.freeze({
        keywordWeights: normalizeKeywordWeightEntries(kind, ownEnumerableData(kind, raw, 'keywordWeights'), { minItems: 1, maxItems: MAX_TAGS }),
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

function buildCandidateMatchContext(state, keywordWeights) {
    const base = buildSoulTextMatchContext(state);
    return Object.freeze({
        contentMode: base.contentMode,
        playerPublicProfile: base.playerPublicProfile,
        keywordWeights: freezeKeywordWeights(keywordWeights),
    });
}

function makeCandidateProfileMessages(context, promptPreset, mode) {
    const preset = renderPromptPreset(promptPreset);
    const matchingLabel = mode === 'soul' ? '灵魂匹配' : '语音匹配';
    const system = [
        `你是现代现实都市线上约会软件的“${matchingLabel}”候选资料生成器。仅依据提供的玩家公开资料、有效关键词权重与 SFW/NSFW 模式，生成一名虚构、明确成年且适合本次推荐的角色公开资料。`,
        '不得索取、推断、复述或输出隐藏资料、仅好友资料、会话、UID、关系分、阈值、Patch、路径、API Key、密钥或任何用户输入原文。不得创建 MVU 角色、匹配或会话。',
        '只输出合法 JSON 对象，不得使用 Markdown、代码块或解释文字。严格形状为：{"profile":{"昵称":"1-80字","年龄段":"明确成年人或18岁以上年龄段","性别":"1-48字","性取向":"1-80字","城市":"1-80字","距离范围":"1-48字","寻找意图":"1-120字","简介":"1-500字","兴趣标签":["最多12项"],"生活方式标签":["最多12项"],"性格标签":["最多12项"],"沟通风格标签":["最多12项"]},"explanation":"1-500字公开匹配说明","matchScore":0-100整数}。只允许这些公开字段；不要包含 UID、关键词权重或其他字段。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `请只基于以下受限公开上下文生成一名候选人的公开资料草稿：\n${JSON.stringify(context)}` },
    ];
}

function makeVoiceKeywordMessages(voiceText, promptPreset) {
    const preset = renderPromptPreset(promptPreset);
    const system = [
        '你是现代现实都市线上约会软件的语音匹配关键词解析器。只从用户主动提供的本次匹配描述中提取 1–12 个匹配关键词与整数权重。此结果仅供后续候选推荐使用，不会保存。',
        '不要输出、推断或复述隐藏资料、仅好友资料、会话、UID、Patch、路径、API Key、密钥或用户输入原文；不要生成角色、筛选条件、解释或其他字段。',
        '只输出合法 JSON 对象，不得使用 Markdown、代码块或解释文字。严格形状为：{"keywordWeights":[{"keyword":"1-40字关键词","weight":-5..5整数}]}。关键词不得重复。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `本次匹配描述（只用于提取关键词，勿复述）：${voiceText}` },
    ];
}

function cleanVoiceText(value) {
    const text = cleanText(value, MAX_VOICE_TEXT_LENGTH);
    return text || null;
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

    const context = buildSoulTextMatchContext(state);
    let resolved;
    try {
        resolved = settingsStore.resolveFunction(functionKey, { contentMode: context.contentMode });
    } catch {
        return { ok: false, code: `${prefix}_settings_invalid`, message: errorMessages[`${prefix}_settings_invalid`] };
    }
    if (!resolved?.connectionPreset) {
        return { ok: false, code: `${prefix}_connection_missing`, message: errorMessages[`${prefix}_connection_missing`] };
    }

    try {
        const messages = kind === 'soul' ? makeSoulMessages(context, resolved.promptPreset) : makeTextMessages(context, resolved.promptPreset);
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

function candidateFailure(code) {
    return { ok: false, code, message: CANDIDATE_MATCH_ERROR_MESSAGES[code] || CANDIDATE_MATCH_ERROR_MESSAGES.candidate_match_response_invalid };
}

function candidateResponseFailure(error) {
    return error instanceof TypeError && typeof error.code === 'string' && (error.code.startsWith('candidate_match_response_') || error.code.startsWith('voice_match_response_'));
}

/**
 * Generates exactly one ephemeral public candidate-profile draft. `mode: 'soul'`
 * uses saved local keyword weights. `mode: 'voice'` first derives transient
 * keyword weights from `voiceText`; those override same-key local weights before
 * the candidate request. Neither mode writes MVU state or persists any draft.
 */
export async function generateCandidateMatchDraft({ mode = 'soul', state, settingsStore, llmClient, voiceText, signal } = {}) {
    // `text` is a transition alias for the existing action-bridge kind. New UI
    // should use `voice`; both select the text_match function binding.
    const normalizedMode = mode === 'text' ? 'voice' : mode;
    if (!['soul', 'voice'].includes(normalizedMode)) return candidateFailure('candidate_match_mode_invalid');
    if (!ownPlainRecord(state)) return candidateFailure('candidate_match_state_invalid');
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return candidateFailure('candidate_match_settings_unavailable');
    if (!llmClient || typeof llmClient.chat !== 'function') return candidateFailure('candidate_match_llm_unavailable');
    const local = readSavedLocalKeywordWeights(settingsStore);
    if (!local.ok) return candidateFailure(local.code);
    const normalizedVoiceText = normalizedMode === 'voice' ? cleanVoiceText(voiceText) : null;
    if (normalizedMode === 'voice' && !normalizedVoiceText) return candidateFailure('candidate_match_voice_text_invalid');

    const functionKey = normalizedMode === 'soul' ? 'soul_match' : 'text_match';
    const context = buildCandidateMatchContext(state, local.keywordWeights);
    let resolved;
    try {
        resolved = settingsStore.resolveFunction(functionKey, { contentMode: context.contentMode });
    } catch {
        return candidateFailure('candidate_match_settings_invalid');
    }
    if (!resolved?.connectionPreset) return candidateFailure('candidate_match_connection_missing');

    try {
        let effectiveKeywordWeights = local.keywordWeights;
        if (normalizedMode === 'voice') {
            const voiceCompletion = await llmClient.chat({
                preset: resolved.connectionPreset,
                messages: makeVoiceKeywordMessages(normalizedVoiceText, resolved.promptPreset),
                signal,
            });
            const voiceRaw = parseResponseJson(voiceCompletion?.text);
            if (!voiceRaw) return candidateFailure('candidate_match_invalid_json');
            const voiceDraft = normalizeVoiceKeywordWeightDraft(voiceRaw);
            effectiveKeywordWeights = mergeMatchKeywordWeights(local.keywordWeights, voiceDraft.keywordWeights);
        }
        const completion = await llmClient.chat({
            preset: resolved.connectionPreset,
            messages: makeCandidateProfileMessages(buildCandidateMatchContext(state, effectiveKeywordWeights), resolved.promptPreset, mode),
            signal,
        });
        const raw = parseResponseJson(completion?.text);
        if (!raw) return candidateFailure('candidate_match_invalid_json');
        return Object.freeze({ ok: true, draft: normalizeCandidateMatchDraft(raw) });
    } catch (error) {
        if (candidateResponseFailure(error)) return candidateFailure('candidate_match_response_invalid');
        const publicError = toPublicLlmError(error);
        return { ok: false, code: publicError.code, message: publicError.message, retryable: publicError.retryable };
    }
}



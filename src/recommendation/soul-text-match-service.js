import { toPublicLlmError } from '../llm/openai-compatible-client.js';
import { BUILTIN_PROMPT_PRESET_IDS } from '../settings/default-prompt-presets.js';
import { renderPromptPreset } from '../settings/prompt-compiler.js';
import { extractExplicitAgeNumbers, normalizeDrawingDna, normalizeGeneratedPublicProfile } from './candidate.js';
import { DRAWING_DNA_RULES } from './drawing-dna-rules.js';
import { scoreHeartCardCompatibility, scoreKeywordOnlyCandidateMatch, scoreLocalCandidateMatch } from './match-scoring.js';
import {
    RECOMMENDATION_DIAGNOSTIC_SCOPES,
    clearRecommendationDiagnostics,
    describeModelResponseForDiagnostics,
    recordRecommendationDiagnostics,
    snapshotErrorForDiagnostics,
} from './recommendation-diagnostics.js';

// Real providers return the same candidate payload family as
// recommendation-refresh (full drawing DNA plus profile), so the response
// budget must match its 20k cap; 8k rejected legitimate long DNA outputs.
const MAX_MODEL_RESPONSE_CHARS = 20_000;
const MAX_TAGS = 12;
const MAX_TAG_WEIGHTS = 64;
const MAX_EXPLANATION_LENGTH = 500;
const MAX_TEXT_FILTER_VALUES = 12;
const MAX_VOICE_TEXT_LENGTH = 800;
const MAX_LOCAL_KEYWORD_WEIGHTS = 64;
// Aligned with the canonical candidate codec (candidate.js normalizeDrawingDna).
const MAX_DRAWING_DNA_LENGTH = 12_000;
// The project drawing-DNA format (DRAWING_DNA_RULES) mandates Chinese category
// names such as 发色{...} plus fullwidth punctuation like 「当前发型」, so the
// charset must accept Han characters and common fullwidth punctuation. English
// stays the tag-value language; safety is enforced by the forbidden pattern,
// the canonical codec (control characters, HTML), and the length cap.
const DRAWING_DNA_TAG_PATTERN = /^[\p{Script=Han}A-Za-z0-9][\p{Script=Han}A-Za-z0-9\s,;:(){}[\]'".+_&%!?=/、。，；：！？（）｛｝【】「」『』《》〈〉·—–…～＋－＝／％＆“”‘’-]*$/u;
const DRAWING_DNA_FORBIDDEN_PATTERN = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|cn|dev|app|co|gg|invalid|local)(?:[\/?#:][^\s,;]*)?|data:image|\b(?:url|uri|api[\s_-]*key|authorization|bearer|token|secret|password|credential|uid|uuid|json\s*patch|json\s*pointer|patch|pointer|path|private|hidden[\s_-]*(?:profile|data|info|information|field|note)|friend(?:[\s_-]*only)?|session|candidate|account|email|e-mail|phone|telephone|address|passport|bank|id[\s_-]*(?:card|number)|real[\s_-]*name|minor|underage)\b|\b(?:sk|pk|rk|sess)_[a-z0-9-]{12,}\b|\b\+?\d[\d -]{6,}\d\b|隐藏资料|仅好友资料|候选(?:NPC|UID|池)|会话(?:UID|ID|标识|指针|路径|记录)|补丁|(?:json|变量|状态|数据|文件|存储|指针)\s*路径|密钥|令牌|账号|邮箱|电话|地址|证件|银行卡|未成年)/iu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const HTML_PATTERN = /<\s*\/?\s*[a-z][^>]*>/iu;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_KEY_PATTERN = /(?:hidden|private|friend|candidate|session|uid|patch|path|api[_ -]?key|token|authorization|secret|隐藏|仅好友|候选|会话|补丁|路径|密钥|令牌)/iu;
// Bans references to internal architecture concepts in public display text.
// Generic dating-app words such as bare 候选/会话/路径 (e.g. “这位候选人”,
// “期待你们的会话”, “人生路径”) are legitimate model phrasing and are only
// rejected in an internal-identifier context; the hidden and friend-only
// layers stay structurally unreachable regardless of model wording.
const FORBIDDEN_DISCLOSURE_PATTERN = /(?:隐藏资料|仅好友资料|候选(?:NPC|UID|池)|会话(?:UID|ID|标识|指针|路径|记录)|json\s*(?:patch|pointer)|补丁|(?:json|变量|状态|数据|文件|存储|指针)\s*路径|api\s*(?:key|密钥)|api[_-]?key|授权|authorization|\btoken\b|\buid\b)/iu;
const CANDIDATE_INCOMPATIBLE_BUILTIN_PROMPT_IDS = new Set([
    BUILTIN_PROMPT_PRESET_IDS.soulMatchSfw,
    BUILTIN_PROMPT_PRESET_IDS.soulMatchNsfw,
    BUILTIN_PROMPT_PRESET_IDS.voiceMatchSfw,
    BUILTIN_PROMPT_PRESET_IDS.voiceMatchNsfw,
]);

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
    candidate_match_basic_compatibility_invalid: '模型返回的角色不符合性别或性取向硬条件；当前状态未改变。',
});

const SOUL_MATCH_OUTPUT_CONTRACT = Object.freeze([
    '灵魂匹配 JSON 结构合同：根对象必须且仅能含 tagWeightDraft、explanation。',
    'tagWeightDraft 必须是 1–12 项数组；每项必须且仅能含 tag、weight。tag 是 1–32 字公开标签，不能重复；weight 是 -5 到 5 的整数目标值，不是增量。',
    'explanation 必须是 1–500 字公开偏好说明。不得输出筛选条件、候选资料、UID、Patch 或其他字段。',
]);
const TEXT_MATCH_OUTPUT_CONTRACT = Object.freeze([
    '文字匹配 JSON 结构合同：根对象必须且仅能含 filters、explanation。',
    'filters 必须且仅能含：城市、年龄段、距离范围、寻找意图关键词、包含标签、排除标签、简介关键词；每个键都是最多 12 项的短字符串数组，且至少一个数组非空。',
    'explanation 必须是 1–500 字公开筛选说明。filters 只用于本次展示，不是 JSONPatch，也不会自动保存。',
]);
const CANDIDATE_MATCH_OUTPUT_CONTRACT = Object.freeze([
    '匹配候选公开资料 JSON 结构合同：根对象必须且仅能含 profile、drawing、explanation。不得输出 matchScore、评分、阈值或关系数值；最终分数由本地算法计算。',
    'profile 必须且仅能含：昵称、年龄段、性别、性取向、城市、距离范围、寻找意图、简介、兴趣标签、生活方式标签、性格标签、沟通风格标签。前八项均为非空字符串；年龄段必须明确表示成年人或 18 岁以上（例如「26-30」「28岁」「成年人」，不要使用「90后」「00后」这类出生年代写法）。',
    'drawing 必须且仅能含 core_dna、outfit_dna；两项都是 1–12000 字符、符合下方绘图 DNA 格式的非空标签字符串（类别名可为中文，标签值使用英文），不能含 URL、凭据、UID、JSON Patch、路径、任何私密资料、联系方式、具体地址或账号。core_dna 是稳定外貌，outfit_dna 是当前服装与配饰。',
    '昵称必须是虚构自然人的个人姓名；不得使用摄影师、设计师等职业名，兴趣或性格标签，账号名，系统、模型、助手、玩家、候选角色等概念充当昵称。',
    '四个标签字段均为最多 12 项的不重复短字符串数组；不得附带头像、仅好友资料、隐藏资料、关系分、阈值、关键词权重或其他字段。',
    '公开资料不得包含具体住址、门牌、手机号、电话号码、证件号、银行卡、真实姓名或私人账号，也不得包含未成年、胁迫、偷拍、诈骗或伪造玩家现实经历的内容。',
    'SFW 模式保持日常社交尺度，简介与标签以常规社交内容为主；NSFW 模式可在简介、寻找意图和四个标签字段按字段语义全尺度写明合规成年人的性偏好、身体与器官偏好、裸体、性行为、BDSM、多人幻想或其他露骨意图，不强制含蓄或淡出；两种模式都不会放宽隐私、成年与同意边界。',
    'explanation 必须是 1–500 字公开匹配说明。它只能解释公开资料与关键词方向，不得声称或夹带最终分数。',
]);
const VOICE_KEYWORD_OUTPUT_CONTRACT = Object.freeze([
    '描述匹配关键词 JSON 结构合同：根对象必须且仅能含 keywordWeights。',
    'keywordWeights 必须是 1–12 项数组；每项必须且仅能含 keyword、weight。keyword 是 1–40 字关键词且不能重复；weight 是 -5 到 5 的整数。',
    '不得输出角色、筛选条件、解释、用户输入原文或其他字段。',
]);

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

/**
 * Lossless-intent coercion for scalar model output: real models frequently
 * emit numbers for text fields and put newlines inside JSON strings. Values
 * that are not scalar are returned unchanged so the strict validators fail.
 */
function coerceScalarText(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (typeof value !== 'string') return value;
    return value.replace(/\s+/gu, ' ').trim();
}

/** Bounds display text without splitting a surrogate pair at the cut. */
function truncateForLimit(text, maxLength) {
    if (text.length <= maxLength) return text;
    let bounded = text.slice(0, maxLength);
    const lastCode = bounded.charCodeAt(bounded.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) bounded = bounded.slice(0, -1);
    return bounded.trimEnd();
}

/** Accepts integers, integral floats, and numeric strings; null otherwise. */
function coerceRoundedInteger(value) {
    let numeric = value;
    if (typeof numeric === 'string') {
        const text = numeric.trim();
        if (!/^[+-]?\d+(?:\.\d+)?$/u.test(text)) return null;
        numeric = Number(text);
    }
    if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return null;
    return Math.round(numeric);
}

/**
 * Coerces a model list field into a de-duplicated short-string list. A bare
 * string becomes a separator-split list; overlong and duplicate entries are
 * dropped and the list is truncated instead of rejecting the whole draft.
 * Non-list-like input is returned unchanged so the strict validators fail.
 */
function coerceStringList(value, maxItems, maxLength) {
    const source = Array.isArray(value)
        ? value
        : (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
            ? String(value).split(/[,，、;；|/]+/u)
            : value);
    if (!Array.isArray(source)) return value;
    const items = [];
    const seen = new Set();
    for (const raw of source) {
        const item = coerceScalarText(raw);
        if (typeof item !== 'string' || !item || item.length > maxLength) continue;
        const folded = item.toLocaleLowerCase('zh-Hans-CN');
        if (seen.has(folded)) continue;
        seen.add(folded);
        items.push(item);
        if (items.length >= maxItems) break;
    }
    return items;
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
    if (!Array.isArray(value) || value.length < minItems) failResponse(kind, 'keyword_weights_invalid');
    const entries = [];
    const seen = new Set();
    for (const item of value) {
        if (entries.length >= maxItems) break;
        const record = sanitizeDraftRecord(kind, item, ['keyword', 'weight']);
        const keyword = normalizeDraftText(kind, record.keyword, 40);
        const normalizedKeyword = keyword.toLocaleLowerCase('zh-Hans-CN');
        const weight = coerceRoundedInteger(record.weight);
        if (weight === null || weight < -5 || weight > 5) failResponse(kind, 'keyword_weights_invalid');
        // Tolerant duplicate handling: the first occurrence wins.
        if (seen.has(normalizedKeyword)) continue;
        seen.add(normalizedKeyword);
        entries.push({ keyword, weight });
    }
    if (entries.length < minItems) failResponse(kind, 'keyword_weights_invalid');
    return freezeKeywordWeights(entries);
}

function readSavedLocalKeywordWeights(settingsStore, contentMode) {
    if (!settingsStore || typeof settingsStore.snapshot !== 'function') {
        return { ok: false, code: 'candidate_match_local_preferences_unavailable' };
    }
    try {
        const snapshot = settingsStore.snapshot();
        const personalization = ownData(snapshot, 'personalization');
        const keywordWeightsByMode = ownData(personalization, 'keywordWeightsByMode');
        const keywordWeights = ownData(keywordWeightsByMode, contentMode === 'NSFW' ? 'NSFW' : 'SFW');
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
    const contentMode = ownData(software, '内容模式') === 'NSFW' ? 'NSFW' : 'SFW';
    return Object.freeze({
        contentMode,
        playerPublicProfile: projectPublicProfile(publicProfile),
        tagWeights: projectTagWeights(ownData(tagWeights, contentMode)),
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

/**
 * Copies only allowed own enumerable string-keyed data properties. Dangerous
 * or sensitive keys and accessor properties still reject the whole draft, but
 * unknown benign extra fields — a common real-model habit — are dropped
 * instead of failing. Missing required fields keep rejecting.
 */
function sanitizeDraftRecord(kind, value, required, optional = []) {
    if (!ownPlainRecord(value)) failResponse(kind, 'required');
    const allowed = new Set([...required, ...optional]);
    const record = {};
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') failResponse(kind, 'dangerous_key');
        assertSafeKey(kind, key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
            failResponse(kind, 'accessor_or_hidden_field');
        }
        if (allowed.has(key)) record[key] = descriptor.value;
    }
    for (const key of required) {
        if (!Object.hasOwn(record, key)) failResponse(kind, 'missing_field');
    }
    return record;
}

function normalizeDraftText(kind, value, maxLength) {
    const coerced = coerceScalarText(value);
    const bounded = typeof coerced === 'string' ? truncateForLimit(coerced, maxLength) : coerced;
    const text = cleanText(bounded, maxLength);
    if (!text || FORBIDDEN_DISCLOSURE_PATTERN.test(text)) failResponse(kind, 'text_invalid');
    return text;
}

function normalizeTextArray(kind, value, maxItems, maxLength) {
    const coerced = coerceStringList(value, maxItems, maxLength);
    if (!Array.isArray(coerced)) failResponse(kind, 'array_invalid');
    const result = [];
    for (const raw of coerced) {
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
    const record = sanitizeDraftRecord(kind, raw, ['tagWeightDraft', 'explanation']);
    const source = record.tagWeightDraft;
    if (!Array.isArray(source) || source.length < 1) failResponse(kind, 'draft_invalid');
    const tagWeightDraft = [];
    const seen = new Set();
    for (const item of source) {
        if (tagWeightDraft.length >= MAX_TAGS) break;
        const entry = sanitizeDraftRecord(kind, item, ['tag', 'weight']);
        const tag = normalizeDraftText(kind, entry.tag, 32);
        const weight = coerceRoundedInteger(entry.weight);
        if (weight === null || weight < -5 || weight > 5) failResponse(kind, 'draft_invalid');
        const folded = tag.toLocaleLowerCase('zh-Hans-CN');
        if (seen.has(folded)) continue;
        seen.add(folded);
        tagWeightDraft.push(Object.freeze({ tag, weight }));
    }
    if (tagWeightDraft.length < 1) failResponse(kind, 'draft_invalid');
    return Object.freeze({
        tagWeightDraft: Object.freeze(tagWeightDraft),
        explanation: normalizeDraftText(kind, record.explanation, MAX_EXPLANATION_LENGTH),
    });
}

/**
 * Strict model codec for a one-off text-match draft. Every filter maps to a
 * public profile field; this service neither resolves candidates nor persists it.
 */
export function normalizeTextMatchDraft(raw) {
    const kind = 'text';
    const record = sanitizeDraftRecord(kind, raw, ['filters', 'explanation']);
    const filterKeys = ['城市', '年龄段', '距离范围', '寻找意图关键词', '包含标签', '排除标签', '简介关键词'];
    // Missing filter keys are tolerated as empty lists; at least one list must
    // still end up non-empty for the draft to mean anything.
    const source = sanitizeDraftRecord(kind, record.filters, [], filterKeys);
    const filters = Object.freeze({
        城市: normalizeTextArray(kind, source.城市 ?? [], MAX_TEXT_FILTER_VALUES, 80),
        年龄段: normalizeTextArray(kind, source.年龄段 ?? [], MAX_TEXT_FILTER_VALUES, 32),
        距离范围: normalizeTextArray(kind, source.距离范围 ?? [], MAX_TEXT_FILTER_VALUES, 48),
        寻找意图关键词: normalizeTextArray(kind, source.寻找意图关键词 ?? [], MAX_TEXT_FILTER_VALUES, 64),
        包含标签: normalizeTextArray(kind, source.包含标签 ?? [], MAX_TEXT_FILTER_VALUES, 32),
        排除标签: normalizeTextArray(kind, source.排除标签 ?? [], MAX_TEXT_FILTER_VALUES, 32),
        简介关键词: normalizeTextArray(kind, source.简介关键词 ?? [], MAX_TEXT_FILTER_VALUES, 64),
    });
    if (!Object.values(filters).some((items) => items.length > 0)) failResponse(kind, 'filters_empty');
    return Object.freeze({
        filters,
        explanation: normalizeDraftText(kind, record.explanation, MAX_EXPLANATION_LENGTH),
    });
}

function normalizeCandidateDrawingDna(kind, value) {
    // Keep the canonical candidate codec as the first boundary so this staged
    // match flow and complete-character flow share the same object shape.
    const record = sanitizeDraftRecord(kind, value, ['core_dna', 'outfit_dna']);
    const cleaned = {};
    for (const key of ['core_dna', 'outfit_dna']) {
        let raw = record[key];
        // Some models return the DNA as a tag list instead of one string.
        if (Array.isArray(raw)) {
            raw = raw
                .filter((item) => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)))
                .map((item) => String(item).trim())
                .filter(Boolean)
                .join('; ');
        }
        const coerced = coerceScalarText(raw);
        cleaned[key] = typeof coerced === 'string' ? coerced : raw;
    }
    let drawing;
    try {
        drawing = normalizeDrawingDna(cleaned);
    } catch {
        failResponse(kind, 'drawing_invalid');
    }
    const normalized = {};
    for (const key of ['core_dna', 'outfit_dna']) {
        const tag = drawing[key];
        if (typeof tag !== 'string'
            || tag.length === 0
            || tag.length > MAX_DRAWING_DNA_LENGTH
            || !DRAWING_DNA_TAG_PATTERN.test(tag)
            || DRAWING_DNA_FORBIDDEN_PATTERN.test(tag)) {
            failResponse(kind, 'drawing_invalid');
        }
        normalized[key] = tag;
    }
    return Object.freeze(normalized);
}

function normalizeOptionalPublicTags(kind, value) {
    const coerced = coerceStringList(value ?? [], MAX_TAGS, 32);
    if (!Array.isArray(coerced)) failResponse(kind, 'candidate_profile_invalid');
    const tags = [];
    const seen = new Set();
    for (const raw of coerced) {
        const tag = normalizeDraftText(kind, raw, 32);
        const folded = tag.toLocaleLowerCase('zh-Hans-CN');
        if (seen.has(folded)) continue;
        seen.add(folded);
        tags.push(tag);
    }
    return Object.freeze(tags);
}

function assertExplicitAdult(kind, ageBand) {
    if (/未成年|未滿|未满/u.test(ageBand)) failResponse(kind, 'candidate_not_adult');
    // Explicit ages come from ASCII digits or common Chinese numerals; birth
    // decade shorthand such as 「90后」 is never counted as adult evidence.
    const ages = extractExplicitAgeNumbers(ageBand);
    if (ages.some((age) => age < 18)) failResponse(kind, 'candidate_not_adult');
    if (/成年|成人|满\s*18|18\s*(?:岁)?\s*(?:以上|\+)/u.test(ageBand)) return;
    if (ages.length > 0 && ages.every((age) => age >= 18)) return;
    failResponse(kind, 'candidate_not_adult');
}

/**
 * Strictly validates one ephemeral, public-only adult candidate profile. This
 * is deliberately not a complete MVU character: it has no UID, friend-only or
 * hidden profile, relationship metrics, threshold, session, or Patch field.
 */
export function normalizeCandidateMatchDraft(raw, { contentMode = 'SFW' } = {}) {
    const kind = 'candidate';
    // matchScore is accepted only as a legacy transport field. Generation
    // ignores and overwrites it with the deterministic local score below.
    const record = sanitizeDraftRecord(kind, raw, ['profile', 'drawing', 'explanation'], ['matchScore']);
    const drawing = normalizeCandidateDrawingDna(kind, record.drawing);
    const textFields = {
        昵称: 80, 年龄段: 32, 性别: 48, 性取向: 80, 城市: 80, 距离范围: 48, 寻找意图: 120, 简介: 500,
    };
    const tagFields = ['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签'];
    // Text fields stay required; missing tag lists degrade to empty lists.
    const profile = sanitizeDraftRecord(kind, record.profile, Object.keys(textFields), tagFields);
    const publicProfile = {};
    for (const [field, maxLength] of Object.entries(textFields)) {
        publicProfile[field] = normalizeDraftText(kind, profile[field], maxLength);
    }
    assertExplicitAdult(kind, publicProfile.年龄段);
    for (const field of tagFields) publicProfile[field] = normalizeOptionalPublicTags(kind, profile[field]);
    let normalizedPublicProfile;
    try {
        normalizedPublicProfile = normalizeGeneratedPublicProfile({
            ...publicProfile,
            头像引用: '',
        }, { requirePersonalName: true, contentMode });
    } catch (error) {
        if (error instanceof TypeError && typeof error.code === 'string' && error.message.startsWith('candidate_validation_failed:')) {
            failResponse(kind, 'candidate_profile_invalid');
        }
        throw error;
    }
    const draftProfile = {};
    for (const field of Object.keys(textFields)) draftProfile[field] = normalizedPublicProfile[field];
    for (const field of tagFields) draftProfile[field] = Object.freeze(normalizedPublicProfile[field]);
    const normalized = {
        profile: Object.freeze(draftProfile),
        drawing,
        explanation: normalizeDraftText(kind, record.explanation, MAX_EXPLANATION_LENGTH),
    };
    if (Object.hasOwn(record, 'matchScore')) {
        // The model was told not to report a score and any value it reports is
        // always overwritten by the deterministic local evaluation, so a
        // malformed legacy score is dropped rather than failing the draft.
        const legacyMatchScore = coerceRoundedInteger(record.matchScore);
        if (legacyMatchScore !== null && legacyMatchScore >= 0 && legacyMatchScore <= 100) {
            normalized.matchScore = legacyMatchScore;
        }
    }
    return Object.freeze(normalized);
}

const LOCAL_CANDIDATE_MATCH_EVALUATIONS = new WeakMap();

function createLocallyScoredCandidateDraft(normalizedDraft, context, { keywordOnly = false } = {}) {
    // 描述匹配 (keywordOnly) scores exclusively from the effective keyword
    // weights (transient description weights merged over saved local weights);
    // 灵魂匹配 keeps the public heart-card + keyword blend.
    const evaluation = keywordOnly
        ? scoreKeywordOnlyCandidateMatch(normalizedDraft.profile, context.keywordWeights)
        : scoreLocalCandidateMatch(
            context.playerPublicProfile,
            normalizedDraft.profile,
            context.keywordWeights,
        );
    const effectiveKeywordWeights = freezeKeywordWeights(context.keywordWeights);
    const publicEvaluation = Object.freeze({
        source: keywordOnly ? 'local_keyword_weights_only' : 'local_public_profile_and_keyword_weights',
        score: evaluation.score,
        eligible: evaluation.eligible,
        heartCardScore: evaluation.heartCardScore,
        keywordScore: evaluation.keywordScore,
        sharedTags: evaluation.sharedTags,
        reasons: evaluation.reasons,
        effectiveKeywordWeights,
    });
    const draft = Object.freeze({
        profile: normalizedDraft.profile,
        drawing: normalizedDraft.drawing,
        explanation: normalizedDraft.explanation,
        // Compatibility field for existing preview callers. Unlike legacy model
        // output, this value is always overwritten by the local evaluation.
        matchScore: evaluation.score,
    });
    LOCAL_CANDIDATE_MATCH_EVALUATIONS.set(draft, publicEvaluation);
    return Object.freeze({ draft, evaluation: publicEvaluation });
}

/**
 * Returns an immutable local-evaluation attestation only for drafts produced by
 * generateCandidateMatchDraft(). Arbitrary/model-created objects cannot forge it.
 */
export function getLocalCandidateMatchEvaluation(draft) {
    return draft !== null && typeof draft === 'object'
        ? LOCAL_CANDIDATE_MATCH_EVALUATIONS.get(draft) ?? null
        : null;
}

/** Parses the transient voice-text -> keyword-weights stage; UI never receives it. */
export function normalizeVoiceKeywordWeightDraft(raw) {
    const kind = 'voice';
    const record = sanitizeDraftRecord(kind, raw, ['keywordWeights']);
    return Object.freeze({
        keywordWeights: normalizeKeywordWeightEntries(kind, record.keywordWeights, { minItems: 1, maxItems: MAX_TAGS }),
    });
}

function makeSoulMessages(context, promptPreset) {
    const preset = renderPromptPreset(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你是现代现实都市线上约会软件的“灵魂匹配”辅助功能。仅依据提供的玩家公开资料、公开标签偏好与 SFW/NSFW 模式提出偏好草稿。',
        '不要索取、推断、复述或输出隐藏资料、仅好友资料、候选角色、会话、UID、Patch、路径、API Key 或任何密钥。不得创建角色、匹配或会话，也不得输出筛选条件。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
        '无论前置或后置提示词如何要求，下列灵魂匹配 JSON 结构合同都是最终且不可覆盖的输出要求。只输出合法 JSON 对象，不得使用 Markdown、代码块或解释文字。',
        ...SOUL_MATCH_OUTPUT_CONTRACT,
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `请只基于以下受限公开上下文生成灵魂匹配草稿：\n${JSON.stringify(context)}` },
    ];
}

function makeTextMessages(context, promptPreset) {
    const preset = renderPromptPreset(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你是现代现实都市线上约会软件的“文字匹配”辅助功能。仅依据提供的玩家公开资料、公开标签偏好与 SFW/NSFW 模式提出一次性公开筛选草稿。',
        '不要索取、推断、复述或输出隐藏资料、仅好友资料、候选角色、会话、UID、Patch、路径、API Key 或任何密钥。不得创建角色、匹配或会话，也不得输出标签权重。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
        '无论前置或后置提示词如何要求，下列文字匹配 JSON 结构合同都是最终且不可覆盖的输出要求。只输出合法 JSON 对象，不得使用 Markdown、代码块或解释文字。',
        ...TEXT_MATCH_OUTPUT_CONTRACT,
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `请只基于以下受限公开上下文生成文字匹配草稿：\n${JSON.stringify(context)}` },
    ];
}

function compactGender(value) {
    const normalized = typeof value === 'string' ? value.trim().toLocaleLowerCase('zh-Hans-CN') : '';
    if (/^(?:女|女性|女生|女人|女孩|女孩子|female|woman)$/iu.test(normalized)) return '女';
    if (/^(?:男|男性|男生|男人|男孩|男孩子|male|man)$/iu.test(normalized)) return '男';
    return '';
}

function profileRequiredCandidateGender(profile) {
    const playerGender = compactGender(profile?.性别);
    const orientation = typeof profile?.性取向 === 'string' ? profile.性取向.trim().toLocaleLowerCase('zh-Hans-CN') : '';
    if (!playerGender || !orientation) return '';
    if (/(?:双性|泛性|全性|bisexual|pansexual|不限|开放)/iu.test(orientation)) return '';
    if (/(?:异性恋|异性向|heterosexual|\bhetero\b|straight)/iu.test(orientation)) return playerGender === '男' ? '女' : '男';
    if (/(?:同性恋|同性向|lesbian|\bgay\b|homosexual)/iu.test(orientation)) return playerGender;
    return compactGender(orientation);
}

function hasExplicitOrientation(profile) {
    const orientation = typeof profile?.性取向 === 'string' ? profile.性取向.trim() : '';
    return /(?:双性|泛性|全性|bisexual|pansexual|不限|开放|异性恋|异性向|heterosexual|\bhetero\b|straight|同性恋|同性向|lesbian|\bgay\b|homosexual|^(?:女|女性|女生|女人|女孩|女孩子|男|男性|男生|男人|男孩|男孩子)$)/iu.test(orientation);
}

function requiresConfirmedBidirectionalCompatibility(profile) {
    return Boolean(compactGender(profile?.性别) && hasExplicitOrientation(profile));
}

function buildCandidateMatchContext(state, keywordWeights) {
    const base = buildSoulTextMatchContext(state);
    const candidateGender = profileRequiredCandidateGender(base.playerPublicProfile);
    return Object.freeze({
        contentMode: base.contentMode,
        playerPublicProfile: base.playerPublicProfile,
        keywordWeights: freezeKeywordWeights(keywordWeights),
        hardMatchRequirements: Object.freeze({
            玩家性别: base.playerPublicProfile.性别,
            玩家性取向: base.playerPublicProfile.性取向,
            候选人性别: candidateGender,
            最低要求: '性别与性取向是最高优先级硬条件：候选人与玩家必须双向相容；若指定候选人性别，候选公开资料的性别必须精确满足。',
        }),
    });
}

/**
 * 描述匹配 (text_match) context: the effective keyword weights are the only
 * matching basis.  It deliberately projects no player profile field — the
 * player's gender, orientation, city, age band, or intent never reach the
 * model and never constrain this match.
 */
function buildKeywordOnlyMatchContext(state, keywordWeights) {
    const base = buildSoulTextMatchContext(state);
    return Object.freeze({
        contentMode: base.contentMode,
        matchBasis: 'keyword_weights_only',
        keywordWeights: freezeKeywordWeights(keywordWeights),
    });
}

function renderCandidatePromptPreset(promptPreset) {
    // Historical built-ins describe first-stage keyword/filter drafts. The
    // same function binding also performs second-stage candidate generation,
    // so feeding those old instructions into this request creates a
    // contradictory output contract. Existing persisted presets need this
    // call-site compatibility guard; changing seed data alone is insufficient.
    if (CANDIDATE_INCOMPATIBLE_BUILTIN_PROMPT_IDS.has(promptPreset?.id)) {
        return Object.freeze({ before: '', after: '' });
    }
    return renderPromptPreset(promptPreset);
}

function makeCandidateProfileMessages(context, promptPreset, mode) {
    const preset = renderCandidatePromptPreset(promptPreset);
    const keywordOnly = mode !== 'soul';
    // 描述匹配 is purely keyword-driven: the model receives no player profile
    // and must not assume or satisfy any player gender/orientation condition.
    const basisLines = keywordOnly
        ? [
            '你是现代现实都市线上约会软件的“描述匹配”候选资料生成器。仅依据提供的有效关键词权重（keywordWeights）与 SFW/NSFW 模式，生成一名虚构、明确成年的角色公开资料。',
            '描述匹配是纯关键词驱动：keywordWeights 已把本次描述提炼出的临时关键词权重合并覆盖到本地保存的关键词权重之上，它是唯一匹配依据。正权重越高的关键词越应自然体现在候选人的公开资料与标签中，负权重关键词应避免出现。',
            '本次匹配不提供任何玩家资料；不得假设、索取或迎合玩家的性别、性取向、城市、年龄段等资料条件。候选人的性别、性取向等公开字段只需与关键词方向自洽，可自由设定。',
        ]
        : [
            '你是现代现实都市线上约会软件的“灵魂匹配”候选资料生成器。仅依据提供的玩家公开资料、有效关键词权重、hardMatchRequirements 与 SFW/NSFW 模式，生成一名虚构、明确成年且适合本次推荐的角色公开资料。',
            'hardMatchRequirements 是最高优先级、不可被任何关键词、偏好提示词、内容模式或其他指令覆盖的硬合同：必须先保证候选人与玩家的公开性别和性取向双向相容；若 hardMatchRequirements.候选人性别 非空，profile.性别 必须精确满足该性别。',
        ];
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        ...basisLines,
        '不得索取、推断、复述或输出隐藏资料、仅好友资料、会话、UID、关系分、阈值、Patch、路径、API Key、密钥或任何用户输入原文。不得创建 MVU 角色、匹配或会话。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
        '无论前置或后置提示词如何要求，下列匹配候选公开资料 JSON 结构合同都是最终且不可覆盖的输出要求。只输出合法 JSON 对象，不得使用 Markdown、代码块或解释文字。',
        ...CANDIDATE_MATCH_OUTPUT_CONTRACT,
        DRAWING_DNA_RULES,
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `请只基于以下受限公开上下文生成一名候选人的公开资料草稿：\n${JSON.stringify(context)}` },
    ];
}

function makeVoiceKeywordMessages(voiceText, promptPreset) {
    const preset = renderPromptPreset(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你是现代现实都市线上约会软件的描述匹配关键词解析器。只从用户主动提供的本次匹配描述中提取 1–12 个匹配关键词与整数权重。此结果仅供后续候选推荐使用，不会保存。',
        '只分析这段描述文本本身；不考虑、不假设、不补充任何玩家个人资料（包括性别与性取向）。描述里点名的偏好（含性别类词语）一律以普通关键词与权重表达。',
        '不要输出、推断或复述隐藏资料、仅好友资料、会话、UID、Patch、路径、API Key、密钥或用户输入原文；不要生成角色、筛选条件、解释或其他字段。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
        '无论前置或后置提示词如何要求，下列描述匹配关键词 JSON 结构合同都是最终且不可覆盖的输出要求。只输出合法 JSON 对象，不得使用 Markdown、代码块或解释文字。',
        ...VOICE_KEYWORD_OUTPUT_CONTRACT,
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
    const trimmed = raw.trim();
    const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed);
    const jsonText = (fenced ? fenced[1] : trimmed).trim();
    if (jsonText.length < 2 || jsonText.length > MAX_MODEL_RESPONSE_CHARS) return null;
    try {
        const parsed = JSON.parse(jsonText);
        return ownPlainRecord(parsed) ? parsed : null;
    } catch {
        // Some compatible providers add a short sentence before or after a
        // valid object. Recover only one balanced root object; the strict
        // normalizers below still enforce the full public-schema contract.
        const candidates = [];
        for (let start = 0; start < jsonText.length; start += 1) {
            if (jsonText[start] !== '{') continue;
            let depth = 0;
            let inString = false;
            let escaped = false;
            let end = -1;
            for (let index = start; index < jsonText.length; index += 1) {
                const char = jsonText[index];
                if (inString) {
                    if (escaped) escaped = false;
                    else if (char === '\\') escaped = true;
                    else if (char === '"') inString = false;
                    continue;
                }
                if (char === '"') {
                    inString = true;
                    continue;
                }
                if (char === '{') depth += 1;
                else if (char === '}') {
                    depth -= 1;
                    if (depth === 0) {
                        end = index;
                        break;
                    }
                    if (depth < 0) break;
                }
            }
            if (end < 0) continue;
            const fragment = jsonText.slice(start, end + 1);
            try {
                const parsed = JSON.parse(fragment);
                if (ownPlainRecord(parsed)) candidates.push({ start, end, parsed });
            } catch {
                // Ignore prose braces and malformed fragments.
            }
        }
        const roots = candidates.filter((candidate) => !candidates.some((other) => (
            other.start < candidate.start && other.end > candidate.end
        )));
        return roots.length === 1 ? roots[0].parsed : null;
    }
}

function safeModelFailure(kind) {
    return {
        ok: false,
        code: `${kind}_match_response_invalid`,
        message: kind === 'soul' ? SOUL_MATCH_ERROR_MESSAGES.soul_match_response_invalid : TEXT_MATCH_ERROR_MESSAGES.text_match_response_invalid,
    };
}

const CANDIDATE_MATCH_DIAGNOSTIC_SCOPE = RECOMMENDATION_DIAGNOSTIC_SCOPES.candidateMatch;

function draftDiagnosticScope(kind) {
    return kind === 'soul'
        ? RECOMMENDATION_DIAGNOSTIC_SCOPES.soulMatchDraft
        : RECOMMENDATION_DIAGNOSTIC_SCOPES.textMatchDraft;
}

async function generateMatchDraft({ kind, state, settingsStore, llmClient, signal }) {
    const errorMessages = kind === 'soul' ? SOUL_MATCH_ERROR_MESSAGES : TEXT_MATCH_ERROR_MESSAGES;
    const functionKey = kind === 'soul' ? 'soul_match' : 'text_match';
    const prefix = `${kind}_match`;
    const scope = draftDiagnosticScope(kind);
    const failWithDiagnostics = (code, diagnostics = {}) => {
        recordRecommendationDiagnostics(scope, { code, ...diagnostics });
        return { ok: false, code, message: errorMessages[code] ?? errorMessages[`${prefix}_response_invalid`] };
    };
    clearRecommendationDiagnostics(scope);
    if (!ownPlainRecord(state)) return failWithDiagnostics(`${prefix}_state_invalid`, { stage: '前置检查', hint: '软件状态快照不可用' });
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return failWithDiagnostics(`${prefix}_settings_unavailable`, { stage: '前置检查', hint: '设置存储未注入或不可用' });
    if (!llmClient || typeof llmClient.chat !== 'function') return failWithDiagnostics(`${prefix}_llm_unavailable`, { stage: '前置检查', hint: '未注入可用的 LLM 客户端' });

    const context = buildSoulTextMatchContext(state);
    let resolved;
    try {
        resolved = settingsStore.resolveFunction(functionKey, { contentMode: context.contentMode });
    } catch (error) {
        return failWithDiagnostics(`${prefix}_settings_invalid`, {
            stage: '解析功能绑定', error: snapshotErrorForDiagnostics(error),
            hint: `检查“${functionKey}”功能的连接与提示词绑定设置`,
        });
    }
    if (!resolved?.connectionPreset) {
        return failWithDiagnostics(`${prefix}_connection_missing`, {
            stage: '解析功能绑定', field: `${functionKey}.connectionPreset`,
            hint: '未绑定连接预设且无默认连接',
        });
    }

    let stage = '请求匹配模型';
    try {
        const messages = kind === 'soul' ? makeSoulMessages(context, resolved.promptPreset) : makeTextMessages(context, resolved.promptPreset);
        const completion = await llmClient.chat({ preset: resolved.connectionPreset, messages, signal });
        stage = '解析模型响应';
        const parsed = parseResponseJson(completion?.text);
        if (!parsed) {
            return failWithDiagnostics(`${prefix}_invalid_json`, {
                stage, expected: '单个完整的草稿 JSON 对象',
                actual: describeModelResponseForDiagnostics(completion?.text, MAX_MODEL_RESPONSE_CHARS),
            });
        }
        stage = '草稿结构校验';
        const draft = kind === 'soul' ? normalizeSoulMatchDraft(parsed) : normalizeTextMatchDraft(parsed);
        return Object.freeze({ ok: true, draft });
    } catch (error) {
        if (error instanceof TypeError && typeof error.code === 'string' && error.code.startsWith(`${kind}_match_response_`)) {
            recordRecommendationDiagnostics(scope, {
                code: `${prefix}_response_invalid`, stage: '草稿结构校验',
                actual: `草稿校验未通过（${error.code}）`,
                hint: '模型输出未满足草稿结构合同；可重试或调整提示词预设',
            });
            return safeModelFailure(kind);
        }
        const publicError = toPublicLlmError(error);
        recordRecommendationDiagnostics(scope, {
            code: publicError.code, stage,
            error: snapshotErrorForDiagnostics(error) ?? snapshotErrorForDiagnostics(publicError),
            hint: publicError.retryable ? '该错误可重试' : undefined,
        });
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

function candidateFailure(code, diagnostics) {
    if (diagnostics && typeof diagnostics === 'object') {
        recordRecommendationDiagnostics(CANDIDATE_MATCH_DIAGNOSTIC_SCOPE, { code, ...diagnostics });
    }
    return { ok: false, code, message: CANDIDATE_MATCH_ERROR_MESSAGES[code] || CANDIDATE_MATCH_ERROR_MESSAGES.candidate_match_response_invalid };
}

function candidateResponseFailure(error) {
    return error instanceof TypeError && typeof error.code === 'string' && (error.code.startsWith('candidate_match_response_') || error.code.startsWith('voice_match_response_'));
}

/**
 * Generates exactly one ephemeral public candidate-profile draft.
 *
 * `mode: 'soul'` (灵魂匹配) uses saved local keyword weights plus the public
 * player profile, and enforces player gender/orientation as a top-priority
 * bidirectional hard condition (prompt contract + local post-check).
 *
 * `mode: 'voice'` (描述匹配) is purely keyword-driven: it first derives
 * transient keyword weights from `voiceText`, merges them over same-key saved
 * local weights, and then matches on those weights alone — no player profile
 * field (gender, orientation, city, …) is sent to the model or applied as a
 * filter. Adult/structure validation still applies unchanged in both modes.
 * Neither mode writes MVU state or persists any draft.
 */
export async function generateCandidateMatchDraft({ mode = 'soul', state, settingsStore, llmClient, voiceText, signal } = {}) {
    // `text` is a transition alias for the existing action-bridge kind. New UI
    // should use `voice`; both select the text_match function binding.
    const normalizedMode = mode === 'text' ? 'voice' : mode;
    clearRecommendationDiagnostics(CANDIDATE_MATCH_DIAGNOSTIC_SCOPE);
    if (!['soul', 'voice'].includes(normalizedMode)) return candidateFailure('candidate_match_mode_invalid', { stage: '参数校验', field: 'mode', expected: 'soul 或 voice/text' });
    if (!ownPlainRecord(state)) return candidateFailure('candidate_match_state_invalid', { stage: '前置检查', hint: '软件状态快照不可用' });
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return candidateFailure('candidate_match_settings_unavailable', { stage: '前置检查', hint: '设置存储未注入或不可用' });
    if (!llmClient || typeof llmClient.chat !== 'function') return candidateFailure('candidate_match_llm_unavailable', { stage: '前置检查', hint: '未注入可用的 LLM 客户端' });
    const local = readSavedLocalKeywordWeights(settingsStore, state?.软件?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW');
    if (!local.ok) {
        return candidateFailure(local.code, {
            stage: '读取本地关键词偏好', field: 'personalization.keywordWeightsByMode',
            hint: '本地个性化关键词不可用或格式无效；仅报字段名，不含权重值明细',
        });
    }
    const keywordOnly = normalizedMode === 'voice';
    const normalizedVoiceText = keywordOnly ? cleanVoiceText(voiceText) : null;
    if (keywordOnly && !normalizedVoiceText) {
        return candidateFailure('candidate_match_voice_text_invalid', {
            stage: '参数校验', field: 'voiceText', expected: '1–800 字符、无控制字符与 HTML 的描述文本',
        });
    }

    const functionKey = normalizedMode === 'soul' ? 'soul_match' : 'text_match';
    const context = keywordOnly
        ? buildKeywordOnlyMatchContext(state, local.keywordWeights)
        : buildCandidateMatchContext(state, local.keywordWeights);
    let resolved;
    try {
        resolved = settingsStore.resolveFunction(functionKey, { contentMode: context.contentMode });
    } catch (error) {
        return candidateFailure('candidate_match_settings_invalid', {
            stage: '解析功能绑定', error: snapshotErrorForDiagnostics(error),
            hint: `检查“${functionKey}”功能的连接与提示词绑定设置`,
        });
    }
    if (!resolved?.connectionPreset) {
        return candidateFailure('candidate_match_connection_missing', {
            stage: '解析功能绑定', field: `${functionKey}.connectionPreset`,
            hint: '未绑定连接预设且无默认连接',
        });
    }

    let stage = keywordOnly ? '第一阶段：描述关键词提取' : '候选资料生成';
    try {
        let effectiveKeywordWeights = local.keywordWeights;
        if (keywordOnly) {
            const voiceCompletion = await llmClient.chat({
                preset: resolved.connectionPreset,
                messages: makeVoiceKeywordMessages(normalizedVoiceText, resolved.promptPreset),
                signal,
            });
            const voiceRaw = parseResponseJson(voiceCompletion?.text);
            if (!voiceRaw) {
                return candidateFailure('candidate_match_invalid_json', {
                    stage: `${stage}（解析响应）`, expected: '单个完整的 keywordWeights JSON 对象',
                    actual: describeModelResponseForDiagnostics(voiceCompletion?.text, MAX_MODEL_RESPONSE_CHARS),
                });
            }
            const voiceDraft = normalizeVoiceKeywordWeightDraft(voiceRaw);
            effectiveKeywordWeights = mergeMatchKeywordWeights(local.keywordWeights, voiceDraft.keywordWeights);
            stage = '第二阶段：候选资料生成';
        }
        const candidateContext = keywordOnly
            ? buildKeywordOnlyMatchContext(state, effectiveKeywordWeights)
            : context;
        const completion = await llmClient.chat({
            preset: resolved.connectionPreset,
            messages: makeCandidateProfileMessages(candidateContext, resolved.promptPreset, normalizedMode),
            signal,
        });
        const raw = parseResponseJson(completion?.text);
        if (!raw) {
            return candidateFailure('candidate_match_invalid_json', {
                stage: `${stage}（解析响应）`, expected: '单个完整的候选公开资料 JSON 对象',
                actual: describeModelResponseForDiagnostics(completion?.text, MAX_MODEL_RESPONSE_CHARS),
            });
        }
        const normalizedDraft = normalizeCandidateMatchDraft(raw, { contentMode: candidateContext.contentMode });
        if (!keywordOnly) {
            const compatibility = scoreHeartCardCompatibility(candidateContext.playerPublicProfile, normalizedDraft.profile);
            const requiredGender = candidateContext.hardMatchRequirements.候选人性别;
            const hasConfirmedCompatibility = compatibility.reasons.includes('性别与性取向相容');
            if (!compatibility.eligible
                || (requiresConfirmedBidirectionalCompatibility(candidateContext.playerPublicProfile) && !hasConfirmedCompatibility)
                || (requiredGender && compactGender(normalizedDraft.profile.性别) !== requiredGender)) {
                return candidateFailure('candidate_match_basic_compatibility_invalid', {
                    stage: '本地硬条件校验', field: 'profile.性别 / profile.性取向',
                    expected: requiredGender ? `候选公开性别精确为「${requiredGender}」且双向相容` : '与玩家公开性别/性取向双向相容',
                    hint: '模型生成的角色不满足公开硬条件，可重试',
                });
            }
        }
        const locallyScored = createLocallyScoredCandidateDraft(normalizedDraft, candidateContext, { keywordOnly });
        return Object.freeze({ ok: true, draft: locallyScored.draft, evaluation: locallyScored.evaluation });
    } catch (error) {
        if (candidateResponseFailure(error)) {
            return candidateFailure('candidate_match_response_invalid', {
                stage: `${stage}（草稿校验）`,
                actual: `草稿校验未通过（${error.code}）`,
                hint: '模型输出未满足公开资料结构合同；可重试或调整提示词预设',
            });
        }
        const publicError = toPublicLlmError(error);
        recordRecommendationDiagnostics(CANDIDATE_MATCH_DIAGNOSTIC_SCOPE, {
            code: publicError.code, stage,
            error: snapshotErrorForDiagnostics(error) ?? snapshotErrorForDiagnostics(publicError),
            hint: publicError.retryable ? '该错误可重试' : undefined,
        });
        return { ok: false, code: publicError.code, message: publicError.message, retryable: publicError.retryable };
    }
}

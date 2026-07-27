/**
 * 阶段 2a：本地非机密设置与提示词预设存储。
 *
 * 该模块只处理可持久化的公开配置；API Key 的会话内解锁由 ../llm/session-key-store.js 独立负责。
 */
import { createConnectionPreset } from '../llm/openai-compatible-client.js';
import { builtinPromptPresetIdFor, createBuiltinPromptPresets } from './default-prompt-presets.js';
import { DEFAULT_CHAT_SUMMARY_SETTINGS, normalizeChatSummarySettings } from '../chat/conversation-summary.js';

export const SETTINGS_SCHEMA_ID = 'yuelema.settings';
export const SETTINGS_SCHEMA_VERSION = 17;
// v12 rewrote the stock built-in prompt preset copy (阶段 55 内容尺度调整)，
// v13 enriched the NSFW stock copy with concrete erotic-writing guidance,
// v14 renamed the「语音匹配」stock presets to「描述匹配」(display name and
// prompt copy only; the persisted builtin_voice_match_* IDs and every user
// binding that references them stay unchanged, so no binding remap is needed),
// v15 upgraded the SFW stock copy to dating-app-quality writing guidance
// (NSFW stock copy stays byte-identical; all preset IDs and bindings keep).
// v16 separates ComfyUI connection/engine/prompt values from NAI/OpenAI values.
// v17 refreshes only the two stock service-profile presets so existing users
// receive the gender/orientation hard contract. User-created preset IDs and
// deleted stock presets remain untouched.
const UPGRADEABLE_SETTINGS_SCHEMA_VERSIONS = new Set([11, 12, 13, 14, 15, 16]);
export const SETTINGS_STORAGE_KEY = 'yuelema.settings.v1';
export const MAX_SERIALIZED_BYTES = 512 * 1024;
export const MAX_CONNECTION_PRESETS = 64;
export const MAX_PROMPT_PRESETS = 128;
export const MAX_PERSONALIZATION_KEYWORDS = 256;
export const FUNCTION_KEYS = Object.freeze([
    'chat',
    'chat_summary',
    'character_authoring',
    'character_ai_completion',
    'character_full_authoring',
    'soul_match',
    'text_match',
    'recommendation_refresh',
    'group_chat',
    'forum',
    'image_match',
    'service_profile_generation',
]);
export const CONTENT_MODES = Object.freeze(['SFW', 'NSFW']);

const SECRET_FIELD_NAMES = new Set([
    'apikey', 'api_key', 'key', 'token', 'access_token', 'authorization', 'password', 'secret',
]);
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PROMPT_POSITIONS = new Set(['before_character_definition', 'after_character_definition']);
const IMAGE_GENERATION_CONVERSATION_KINDS = new Set(['private', 'group', 'forum']);
const MAX_IMAGE_GENERATION_CONVERSATIONS = 256;

export class YueLeMaSettingsError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'YueLeMaSettingsError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new YueLeMaSettingsError(code, message);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasForbiddenOrSecretKey(value, seen = new Set()) {
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    for (const key of Object.keys(value)) {
        const lowerKey = key.toLowerCase();
        if (FORBIDDEN_OBJECT_KEYS.has(key) || SECRET_FIELD_NAMES.has(lowerKey)) return true;
        if (hasForbiddenOrSecretKey(value[key], seen)) return true;
    }
    return false;
}

function safeClone(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(safeClone);
    if (!isPlainObject(value) || hasForbiddenOrSecretKey(value)) {
        fail('UNSAFE_INPUT', '设置内容包含不允许的字段。');
    }
    const result = Object.create(null);
    for (const [key, child] of Object.entries(value)) result[key] = safeClone(child);
    return result;
}

function cleanText(value, field, minLength, maxLength) {
    if (typeof value !== 'string') fail('INVALID_SETTINGS', `${field}必须是文本。`);
    const cleaned = value.trim();
    if (cleaned.length < minLength || cleaned.length > maxLength || /[\u0000-\u001F\u007F]/.test(cleaned)) {
        fail('INVALID_SETTINGS', `${field}长度或字符不符合要求。`);
    }
    return cleaned;
}

function cleanId(value, field) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value)) {
        fail('INVALID_SETTINGS', `${field}必须是 1–96 位的字母、数字、下划线或连字符。`);
    }
    return value;
}

function cleanInteger(value, field, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) {
        fail('INVALID_SETTINGS', `${field}必须是 ${min}–${max} 范围内的整数。`);
    }
    return value;
}

function emptyBinding() {
    return { connectionPresetId: null, promptPresetId: null };
}

function modeBindingForDefault(functionKey, contentMode, promptById = null) {
    const promptPresetId = builtinPromptPresetIdFor(functionKey, contentMode);
    return {
        connectionPresetId: null,
        promptPresetId: promptPresetId && (!promptById || promptById.get(promptPresetId)?.contentMode === contentMode)
            ? promptPresetId : null,
    };
}

function makeDefaultDocument() {
    const promptPresets = createBuiltinPromptPresets();
    const promptById = new Map(promptPresets.map((preset) => [preset.id, preset]));
    return {
        schema: SETTINGS_SCHEMA_ID,
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        connectionPresets: [],
        promptPresets,
        defaults: { connectionPresetId: null, promptPresetId: null },
        functionBindings: Object.fromEntries(FUNCTION_KEYS.map((key) => [key, emptyBinding()])),
        functionModeBindings: Object.fromEntries(FUNCTION_KEYS.map((key) => [key, Object.fromEntries(
            CONTENT_MODES.map((contentMode) => [contentMode, modeBindingForDefault(key, contentMode, promptById)]),
        )])),
        chatSummary: { ...DEFAULT_CHAT_SUMMARY_SETTINGS },
        personalization: {
            enabled: true,
            keywordWeightsByMode: {
                SFW: [],
                NSFW: [],
            },
        },
        imageGeneration: defaultImageGenerationSettings(),
    };
}

function cloneDocument(document) {
    return JSON.parse(JSON.stringify(document));
}

function normalizeConnectionPreset(input) {
    const candidate = safeClone(input);
    return { ...createConnectionPreset(candidate) };
}

export function normalizePromptPreset(input) {
    const candidate = safeClone(input);
    if (!isPlainObject(candidate)) fail('INVALID_PROMPT_PRESET', '提示词预设必须是对象。');
    const unknown = Object.keys(candidate).filter((key) => ![
        'id', 'name', 'depth', 'order', 'position', 'enabled', 'content', 'contentMode',
    ].includes(key));
    if (unknown.length > 0) fail('INVALID_PROMPT_PRESET', '提示词预设包含不支持的字段。');
    if (typeof candidate.enabled !== 'boolean') fail('INVALID_PROMPT_PRESET', 'enabled 必须为布尔值。');
    const position = cleanText(candidate.position, 'position', 1, 64);
    if (!PROMPT_POSITIONS.has(position)) {
        fail('INVALID_PROMPT_PRESET', 'position 仅支持 before_character_definition 或 after_character_definition。');
    }
    const id = cleanId(candidate.id, '提示词预设 ID');
    const name = cleanText(candidate.name, '提示词预设名称', 1, 80);
    const inferredMode = /(?:^|[_-])nsfw(?:[_-]|$)/iu.test(id) || /\bNSFW\b/iu.test(name) ? 'NSFW' : 'SFW';
    const contentMode = candidate.contentMode === undefined ? inferredMode : cleanContentMode(candidate.contentMode);
    return {
        id,
        name,
        depth: cleanInteger(candidate.depth, 'depth', 0, 1000),
        order: cleanInteger(candidate.order, 'order', -1000, 1000),
        position,
        enabled: candidate.enabled,
        contentMode,
        content: cleanText(candidate.content, 'content', 1, 12_000),
    };
}

function cleanOptionalId(value, field) {
    if (value === null || value === undefined) return null;
    return cleanId(value, field);
}

function normalizeBinding(input) {
    const candidate = safeClone(input ?? {});
    if (!isPlainObject(candidate)) fail('INVALID_BINDING', '功能绑定必须是对象。');
    const unknown = Object.keys(candidate).filter((key) => !['connectionPresetId', 'promptPresetId'].includes(key));
    if (unknown.length > 0) fail('INVALID_BINDING', '功能绑定包含不支持的字段。');
    return {
        connectionPresetId: cleanOptionalId(candidate.connectionPresetId, '连接预设 ID'),
        promptPresetId: cleanOptionalId(candidate.promptPresetId, '提示词预设 ID'),
    };
}

function cleanContentMode(value) {
    if (!CONTENT_MODES.includes(value)) fail('INVALID_CONTENT_MODE', '内容模式必须是 SFW 或 NSFW。');
    return value;
}


/**
 * v11–v14 documents keep stock prompt-preset IDs whose source copy changed in
 * a later schema (v12 尺度调整、v13 NSFW 写作指导、v14 语音匹配→描述匹配 改名、
 * v15 SFW 文案全量质量升级).
 * Refresh only those stock IDs once during the schema upgrade; user-created
 * prompt IDs (and stock presets the user deleted) remain untouched.
 */
function refreshStockBuiltinPromptPresets(presets) {
    const stockById = new Map(createBuiltinPromptPresets().map((preset) => [preset.id, normalizePromptPreset(preset)]));
    return presets.map((preset) => stockById.get(preset.id) ?? preset);
}

function refreshServiceBuiltinPromptPresets(presets) {
    const serviceIds = new Set([
        builtinPromptPresetIdFor('service_profile_generation', 'SFW'),
        builtinPromptPresetIdFor('service_profile_generation', 'NSFW'),
    ]);
    const stockById = new Map(
        createBuiltinPromptPresets()
            .filter((preset) => serviceIds.has(preset.id))
            .map((preset) => [preset.id, normalizePromptPreset(preset)]),
    );
    return presets.map((preset) => stockById.get(preset.id) ?? preset);
}

function promptIdForContentMode(presetId, contentMode, promptById) {
    return presetId !== null && promptById.get(presetId)?.contentMode === contentMode ? presetId : null;
}

function fallbackModeBinding(functionKey, contentMode, genericBinding, defaults, promptById) {
    return {
        // Keep an existing generic connection fallback dynamic. A later change
        // to the default connection must keep behaving as it did before v3.
        connectionPresetId: genericBinding.connectionPresetId,
        // A legacy global prompt may seed only its own content mode. This keeps
        // a SFW preset from silently becoming an NSFW function binding.
        promptPresetId: promptIdForContentMode(genericBinding.promptPresetId, contentMode, promptById)
            ?? promptIdForContentMode(defaults.promptPresetId, contentMode, promptById)
            ?? modeBindingForDefault(functionKey, contentMode, promptById).promptPresetId,
    };
}

function validateBindingPresetReferences(binding, functionKey, connectionIds, promptById, contentMode = null) {
    if (binding.connectionPresetId !== null && !connectionIds.has(binding.connectionPresetId)) {
        fail('UNKNOWN_PRESET_ID', `${functionKey} 绑定的连接预设不存在。`);
    }
    if (binding.promptPresetId !== null && !promptById.has(binding.promptPresetId)) {
        fail('UNKNOWN_PRESET_ID', `${functionKey} 绑定的提示词预设不存在。`);
    }
    if (contentMode !== null && binding.promptPresetId !== null
        && promptById.get(binding.promptPresetId).contentMode !== contentMode) {
        fail('PROMPT_MODE_MISMATCH', `${functionKey} 只能绑定 ${contentMode} 提示词预设。`);
    }
}

function normalizeFunctionModeBindings(input, functionBindings, defaults, connectionIds, promptById) {
    const candidate = safeClone(input ?? {});
    if (!isPlainObject(candidate) || Object.keys(candidate).some((key) => !FUNCTION_KEYS.includes(key))) {
        fail('INVALID_BINDING', '模式功能绑定包含未知功能。');
    }
    const functionModeBindings = {};
    for (const functionKey of FUNCTION_KEYS) {
        const modeBindingsInput = candidate[functionKey];
        if (modeBindingsInput !== undefined && (!isPlainObject(modeBindingsInput)
            || Object.keys(modeBindingsInput).some((key) => !CONTENT_MODES.includes(key)))) {
            fail('INVALID_BINDING', '模式功能绑定包含未知内容模式。');
        }
        functionModeBindings[functionKey] = {};
        for (const contentMode of CONTENT_MODES) {
            const fallback = fallbackModeBinding(functionKey, contentMode, functionBindings[functionKey], defaults, promptById);
            let binding = modeBindingsInput && Object.hasOwn(modeBindingsInput, contentMode)
                ? normalizeBinding(modeBindingsInput[contentMode])
                : fallback;
            validateBindingPresetReferences(binding, `${functionKey}/${contentMode}`, connectionIds, promptById, contentMode);
            functionModeBindings[functionKey][contentMode] = binding;
        }
    }
    return functionModeBindings;
}


function normalizeKeywordWeights(input) {
    if (!Array.isArray(input) || input.length > MAX_PERSONALIZATION_KEYWORDS) {
        fail('INVALID_PERSONALIZATION', '个性化内容偏好数量无效。');
    }
    const seen = new Set();
    return input.map((item) => {
        const candidate = safeClone(item);
        if (!isPlainObject(candidate) || Object.keys(candidate).some((key) => !['keyword', 'weight'].includes(key))) {
            fail('INVALID_PERSONALIZATION', '关键词权重包含不支持的字段。');
        }
        const keyword = cleanText(candidate.keyword, '关键词', 1, 40);
        const folded = keyword.toLowerCase();
        if (seen.has(folded)) fail('INVALID_PERSONALIZATION', '个性化内容偏好中存在重复关键词。');
        seen.add(folded);
        return {
            keyword,
            weight: cleanInteger(candidate.weight, '关键词权重', -5, 5),
        };
    });
}

function emptyKeywordWeightsByMode() {
    return { SFW: [], NSFW: [] };
}

function normalizeKeywordWeightsByMode(input) {
    const candidate = safeClone(input);
    if (!isPlainObject(candidate)) {
        fail('INVALID_PERSONALIZATION', '分模式关键词权重必须是对象。');
    }
    const keys = Object.keys(candidate);
    if (keys.length !== CONTENT_MODES.length || CONTENT_MODES.some((contentMode) => !Object.hasOwn(candidate, contentMode))) {
        fail('INVALID_PERSONALIZATION', '分模式关键词权重必须且只能包含 SFW 与 NSFW。');
    }
    return Object.fromEntries(CONTENT_MODES.map((contentMode) => [
        contentMode,
        normalizeKeywordWeights(candidate[contentMode]),
    ]));
}

function normalizePersonalization(input) {
    if (input === undefined || input === null) {
        return { enabled: true, keywordWeightsByMode: emptyKeywordWeightsByMode() };
    }
    const candidate = safeClone(input);
    if (!isPlainObject(candidate)) {
        fail('INVALID_PERSONALIZATION', '个性化内容推荐设置必须是对象。');
    }
    if (typeof candidate.enabled !== 'boolean') {
        fail('INVALID_PERSONALIZATION', '个性化内容推荐开关必须为布尔值。');
    }


    if (Object.keys(candidate).some((key) => !['enabled', 'keywordWeightsByMode'].includes(key))
        || !Object.hasOwn(candidate, 'keywordWeightsByMode')) {
        fail('INVALID_PERSONALIZATION', '个性化内容推荐设置包含不支持或缺失的字段。');
    }
    return {
        enabled: candidate.enabled,
        keywordWeightsByMode: normalizeKeywordWeightsByMode(candidate.keywordWeightsByMode),
    };
}

function normalizeChatSummary(input) {
    if (input === undefined || input === null) return { ...DEFAULT_CHAT_SUMMARY_SETTINGS };
    const normalized = normalizeChatSummarySettings(safeClone(input));
    if (!normalized) fail('INVALID_CHAT_SUMMARY', '对话总结设置无效。');
    return { ...normalized };
}

/** The image configuration is intentionally non-secret: credentials are held only by session-key-store. */
export function defaultImageGenerationSettings() {
    return {
        enabled: false,
        presetId: 'image_generation_default',
        apiMode: 'novelai',
        baseUrl: 'https://image.novelai.net',
        endpointPath: '/ai/generate-image',
        model: 'nai-diffusion-4-5-full',
        sampler: 'k_euler',
        noiseSchedule: 'native',
        guidance: 7,
        guidanceRescale: 0,
        width: 1024,
        height: 1024,
        steps: 28,
        seed: 0,
        qualityToggle: true,
        variety: false,
        positivePrefix: '',
        positiveSuffix: '',
        negativePrompt: '',
        comfyBaseUrl: 'http://127.0.0.1:8188',
        comfyModel: '',
        comfySampler: 'euler',
        comfyScheduler: 'normal',
        comfyVae: '',
        comfyClip: '',
        comfyGuidance: 7,
        comfyWidth: 1024,
        comfyHeight: 1024,
        comfySteps: 20,
        comfySeed: 0,
        comfyPositivePrefix: '',
        comfyPositiveSuffix: '',
        comfyNegativePrompt: '',
        comfyWorkflow: '',
        conversationSettings: { private: {}, group: {}, forum: {} },
    };
}

function cleanImageText(value, field, maxLength, { allowEmpty = true, allowLineBreaks = false } = {}) {
    if (typeof value !== 'string') fail('INVALID_IMAGE_GENERATION', field + '必须是文本。');
    const cleaned = value.trim();
    const unsafeControls = allowLineBreaks
        ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
        : /[\u0000-\u001F\u007F]/u;
    if ((!allowEmpty && !cleaned) || cleaned.length > maxLength || unsafeControls.test(cleaned)) fail('INVALID_IMAGE_GENERATION', field + '长度或字符不符合要求。');
    return cleaned;
}

function cleanImageWorkflow(value) {
    if (typeof value !== 'string') fail('INVALID_IMAGE_GENERATION', 'ComfyUI 工作流必须是文本。');
    const cleaned = value.trim();
    if (cleaned.length > 200_000 || /[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(cleaned)) {
        fail('INVALID_IMAGE_GENERATION', 'ComfyUI 工作流长度或字符不符合要求。');
    }
    if (cleaned) {
        try {
            const parsed = JSON.parse(cleaned);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        } catch {
            fail('INVALID_IMAGE_GENERATION', 'ComfyUI 工作流必须是有效的 JSON 对象。');
        }
    }
    return cleaned;
}

function cleanFiniteNumber(value, field, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail('INVALID_IMAGE_GENERATION', field + '数值无效。');
    return value;
}

function normalizeImageConversationSettings(input) {
    const candidate = safeClone(input);
    if (!isPlainObject(candidate) || Object.keys(candidate).some((key) => key !== 'autoGenerate') || typeof candidate.autoGenerate !== 'boolean') {
        fail('INVALID_IMAGE_GENERATION', '对话生图设置无效。');
    }
    return { autoGenerate: candidate.autoGenerate };
}

export function normalizeImageGenerationSettings(input) {
    if (input === undefined || input === null) return defaultImageGenerationSettings();
    const candidate = safeClone(input);
    if (!isPlainObject(candidate)) fail('INVALID_IMAGE_GENERATION', '生图设置必须是对象。');
    const defaults = defaultImageGenerationSettings();
    const allowed = new Set(Object.keys(defaults));
    if (Object.keys(candidate).some((key) => !allowed.has(key))) fail('INVALID_IMAGE_GENERATION', '生图设置包含不支持或敏感字段。');
    const value = { ...defaults, ...candidate };
    if (typeof value.enabled !== 'boolean' || typeof value.qualityToggle !== 'boolean' || typeof value.variety !== 'boolean') fail('INVALID_IMAGE_GENERATION', '生图开关必须为布尔值。');
    if (!['novelai', 'openai_compatible', 'comfyui'].includes(value.apiMode)) fail('INVALID_IMAGE_GENERATION', '生图接口模式不受支持。');
    const presetId = cleanId(value.presetId, '生图密钥预设 ID');
    const normalizeImageBaseUrl = (raw, field) => {
        const baseUrl = cleanImageText(raw, field, 512, { allowEmpty: false });
        let parsedUrl;
        try { parsedUrl = new URL(baseUrl); } catch { fail('INVALID_IMAGE_GENERATION', `${field}必须是有效 URL。`); }
        if (!['https:', 'http:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
            fail('INVALID_IMAGE_GENERATION', `${field}必须使用 HTTP 或 HTTPS，且不能包含凭据、查询参数或片段。`);
        }
        return parsedUrl.toString().replace(/\/$/, '');
    };
    const baseUrl = normalizeImageBaseUrl(value.baseUrl, '生图站点');
    const comfyBaseUrl = normalizeImageBaseUrl(value.comfyBaseUrl, 'ComfyUI 地址');
    const endpointPath = cleanImageText(value.endpointPath, '生图接口路径', 256, { allowEmpty: false });
    if (!endpointPath.startsWith('/') || endpointPath.startsWith('//') || endpointPath.includes('..') || endpointPath.includes('?') || endpointPath.includes('#')) fail('INVALID_IMAGE_GENERATION', '生图接口路径必须是安全的站内绝对路径。');
    const conversationSettings = safeClone(value.conversationSettings);
    if (!isPlainObject(conversationSettings) || Object.keys(conversationSettings).some((key) => !IMAGE_GENERATION_CONVERSATION_KINDS.has(key)) || [...IMAGE_GENERATION_CONVERSATION_KINDS].some((key) => !Object.hasOwn(conversationSettings, key))) fail('INVALID_IMAGE_GENERATION', '对话生图设置结构无效。');
    let count = 0;
    const normalizedConversations = {};
    for (const kind of IMAGE_GENERATION_CONVERSATION_KINDS) {
        const records = safeClone(conversationSettings[kind]);
        if (!isPlainObject(records)) fail('INVALID_IMAGE_GENERATION', '对话生图设置必须是对象。');
        normalizedConversations[kind] = {};
        for (const [id, settings] of Object.entries(records)) {
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || ++count > MAX_IMAGE_GENERATION_CONVERSATIONS) fail('INVALID_IMAGE_GENERATION', '对话生图设置数量或标识无效。');
            normalizedConversations[kind][id] = normalizeImageConversationSettings(settings);
        }
    }
    return {
        enabled: value.enabled,
        presetId,
        apiMode: value.apiMode,
        baseUrl,
        endpointPath,
        model: cleanImageText(value.model, '生图模型', 160, { allowEmpty: false }),
        sampler: cleanImageText(value.sampler, '采样器', 80, { allowEmpty: false }),
        noiseSchedule: cleanImageText(value.noiseSchedule, '噪点表', 80, { allowEmpty: false }),
        guidance: cleanFiniteNumber(value.guidance, 'Guidance', 0, 30),
        guidanceRescale: cleanFiniteNumber(value.guidanceRescale, 'Guidance Rescale', 0, 1),
        width: cleanInteger(value.width, '图片宽度', 256, 2048),
        height: cleanInteger(value.height, '图片高度', 256, 2048),
        steps: cleanInteger(value.steps, '步数', 1, 100),
        seed: cleanInteger(value.seed, '种子', 0, 4294967295),
        qualityToggle: value.qualityToggle,
        variety: value.variety,
        positivePrefix: cleanImageText(value.positivePrefix, '前置正面提示词', 4000, { allowLineBreaks: true }),
        positiveSuffix: cleanImageText(value.positiveSuffix, '后置正面提示词', 4000, { allowLineBreaks: true }),
        negativePrompt: cleanImageText(value.negativePrompt, '固定负面提示词', 4000, { allowLineBreaks: true }),
        comfyBaseUrl,
        comfyModel: cleanImageText(value.comfyModel, 'ComfyUI 模型', 160),
        comfySampler: cleanImageText(value.comfySampler, 'ComfyUI 采样器', 80, { allowEmpty: false }),
        comfyScheduler: cleanImageText(value.comfyScheduler, 'ComfyUI 调度器', 80, { allowEmpty: false }),
        comfyVae: cleanImageText(value.comfyVae, 'ComfyUI VAE', 160),
        comfyClip: cleanImageText(value.comfyClip, 'ComfyUI CLIP', 160),
        comfyGuidance: cleanFiniteNumber(value.comfyGuidance, 'ComfyUI CFG', 0, 30),
        comfyWidth: cleanInteger(value.comfyWidth, 'ComfyUI 图片宽度', 256, 2048),
        comfyHeight: cleanInteger(value.comfyHeight, 'ComfyUI 图片高度', 256, 2048),
        comfySteps: cleanInteger(value.comfySteps, 'ComfyUI 步数', 1, 100),
        comfySeed: cleanInteger(value.comfySeed, 'ComfyUI 种子', 0, 4294967295),
        comfyPositivePrefix: cleanImageText(value.comfyPositivePrefix, 'ComfyUI 前置正面提示词', 4000, { allowLineBreaks: true }),
        comfyPositiveSuffix: cleanImageText(value.comfyPositiveSuffix, 'ComfyUI 后置正面提示词', 4000, { allowLineBreaks: true }),
        comfyNegativePrompt: cleanImageText(value.comfyNegativePrompt, 'ComfyUI 固定负面提示词', 4000, { allowLineBreaks: true }),
        comfyWorkflow: cleanImageWorkflow(value.comfyWorkflow),
        conversationSettings: normalizedConversations,
    };
}

function assertSize(document) {
    const encoded = JSON.stringify(document);
    if (new TextEncoder().encode(encoded).byteLength > MAX_SERIALIZED_BYTES) {
        fail('SETTINGS_TOO_LARGE', '设置数据超过允许的大小限制。');
    }
}

/** 严格归一化当前版本的未经信任设置文档。 */
export function normalizeSettingsDocument(input) {
    const candidate = safeClone(input);
    if (!isPlainObject(candidate)) fail('INVALID_SETTINGS', '设置文档必须是对象。');
    const allowed = new Set(['schema', 'schemaVersion', 'connectionPresets', 'promptPresets', 'defaults', 'functionBindings', 'functionModeBindings', 'chatSummary', 'personalization', 'imageGeneration']);
    if (Object.keys(candidate).some((key) => !allowed.has(key))) {
        fail('INVALID_SETTINGS', '设置文档包含不支持的字段。');
    }
    if (candidate.schema !== SETTINGS_SCHEMA_ID) {
        fail('UNSUPPORTED_SETTINGS_SCHEMA', '设置 schema 不受支持。');
    }
    if (candidate.schemaVersion !== SETTINGS_SCHEMA_VERSION
        && !UPGRADEABLE_SETTINGS_SCHEMA_VERSIONS.has(candidate.schemaVersion)) {
        fail('UNSUPPORTED_SETTINGS_VERSION', '设置版本不受支持。');
    }
    const isUpgradeableLegacySchema = candidate.schemaVersion !== SETTINGS_SCHEMA_VERSION;
    if (!Array.isArray(candidate.connectionPresets) || candidate.connectionPresets.length > MAX_CONNECTION_PRESETS) {
        fail('INVALID_SETTINGS', '连接预设数量无效。');
    }
    if (!Array.isArray(candidate.promptPresets) || candidate.promptPresets.length > MAX_PROMPT_PRESETS) {
        fail('INVALID_SETTINGS', '提示词预设数量无效。');
    }

    const connectionPresets = candidate.connectionPresets.map(normalizeConnectionPreset);
    const normalizedPromptPresets = candidate.promptPresets.map(normalizePromptPreset);
    const promptPresets = isUpgradeableLegacySchema && candidate.schemaVersion <= 14
        ? refreshStockBuiltinPromptPresets(normalizedPromptPresets)
        : (isUpgradeableLegacySchema && candidate.schemaVersion <= 16
            ? refreshServiceBuiltinPromptPresets(normalizedPromptPresets)
            : normalizedPromptPresets);
    const connectionIds = new Set(connectionPresets.map((preset) => preset.id));
    const promptIds = new Set(promptPresets.map((preset) => preset.id));
    if (connectionIds.size !== connectionPresets.length || promptIds.size !== promptPresets.length) {
        fail('DUPLICATE_PRESET_ID', '预设 ID 不可重复。');
    }
    const promptById = new Map(promptPresets.map((preset) => [preset.id, preset]));

    const defaultsInput = safeClone(candidate.defaults ?? {});
    if (!isPlainObject(defaultsInput) || Object.keys(defaultsInput).some((key) => !['connectionPresetId', 'promptPresetId'].includes(key))) {
        fail('INVALID_SETTINGS', '默认预设配置无效。');
    }
    const defaults = {
        connectionPresetId: cleanOptionalId(defaultsInput.connectionPresetId, '默认连接预设 ID'),
        promptPresetId: cleanOptionalId(defaultsInput.promptPresetId, '默认提示词预设 ID'),
    };
    if (defaults.connectionPresetId !== null && !connectionIds.has(defaults.connectionPresetId)) {
        fail('UNKNOWN_PRESET_ID', '默认连接预设不存在。');
    }
    if (defaults.promptPresetId !== null && !promptById.has(defaults.promptPresetId)) {
        fail('UNKNOWN_PRESET_ID', '默认提示词预设不存在。');
    }

    const bindingsInput = safeClone(candidate.functionBindings ?? {});
    if (!isPlainObject(bindingsInput) || Object.keys(bindingsInput).some((key) => !FUNCTION_KEYS.includes(key))) {
        fail('INVALID_BINDING', '功能绑定包含未知功能。');
    }
    const functionBindings = {};
    for (const functionKey of FUNCTION_KEYS) {
        const binding = normalizeBinding(bindingsInput[functionKey]);
        validateBindingPresetReferences(binding, functionKey, connectionIds, promptById);
        functionBindings[functionKey] = binding;
    }

    // 旧版本只有一个角色创作绑定。只在新入口未显式保存时复制，
    // 让 AI 补全和完整创作从迁移完成后始终可以独立选择预设。
    const legacyCharacterBinding = functionBindings.character_authoring;
    if (!Object.hasOwn(bindingsInput, 'character_ai_completion')) {
        functionBindings.character_ai_completion = { ...legacyCharacterBinding };
    }
    if (!Object.hasOwn(bindingsInput, 'character_full_authoring')) {
        functionBindings.character_full_authoring = { ...legacyCharacterBinding };
    }

    const functionModeBindings = normalizeFunctionModeBindings(
        candidate.functionModeBindings,
        functionBindings,
        defaults,
        connectionIds,
        promptById,
    );

    const chatSummary = normalizeChatSummary(candidate.chatSummary);
    const personalization = normalizePersonalization(candidate.personalization);
    const imageGeneration = normalizeImageGenerationSettings(candidate.imageGeneration);
    const normalized = {
        schema: SETTINGS_SCHEMA_ID,
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        connectionPresets,
        promptPresets,
        defaults,
        functionBindings,
        functionModeBindings,
        chatSummary,
        personalization,
        imageGeneration,
    };
    assertSize(normalized);
    return normalized;
}

function nextDefaultId(presets) {
    return presets.length > 0 ? presets[0].id : null;
}

function idExists(presets, id) {
    return presets.some((preset) => preset.id === id);
}

function replaceById(presets, replacement) {
    return presets.map((preset) => preset.id === replacement.id ? replacement : preset);
}

function withoutId(presets, id) {
    return presets.filter((preset) => preset.id !== id);
}

function findById(presets, id) {
    return presets.find((preset) => preset.id === id) ?? null;
}

function resolveStorage(storage) {
    const candidate = storage ?? createMemoryStorage();
    for (const method of ['getItem', 'setItem', 'removeItem']) {
        if (typeof candidate[method] !== 'function') fail('INVALID_STORAGE', 'storage 必须提供 getItem、setItem 与 removeItem。');
    }
    return candidate;
}

/** 默认内存存储。真实浏览器存储只可由后续 UI 接线显式注入。 */
export function createMemoryStorage(seed = {}) {
    const values = new Map();
    for (const [key, value] of Object.entries(seed)) values.set(key, String(value));
    return Object.freeze({
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); },
    });
}

/**
 * 非机密设置仓库。不会保存、返回或导出 API Key；对所有外来数据先做 schema 校验。
 */
export function createSettingsStore({ storage, storageKey = SETTINGS_STORAGE_KEY } = {}) {
    const targetStorage = resolveStorage(storage);
    if (typeof storageKey !== 'string' || storageKey.length < 1 || storageKey.length > 160) {
        fail('INVALID_STORAGE_KEY', 'storageKey 无效。');
    }
    let document = null;

    function persist(nextDocument) {
        const normalized = normalizeSettingsDocument(nextDocument);
        const serialized = JSON.stringify(normalized);
        if (new TextEncoder().encode(serialized).byteLength > MAX_SERIALIZED_BYTES) {
            fail('SETTINGS_TOO_LARGE', '设置数据超过允许的大小限制。');
        }
        targetStorage.setItem(storageKey, serialized);
        document = normalized;
        return cloneDocument(document);
    }

    function current() {
        if (document === null) load();
        return document;
    }

    function load() {
        const raw = targetStorage.getItem(storageKey);
        if (raw === null || raw === '') {
            // Seed editable built-in prompts into ordinary browser storage on
            // first use. This persistence path is limited to non-secret data.
            return persist(makeDefaultDocument());
        }
        if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_SERIALIZED_BYTES) {
            fail('SETTINGS_TOO_LARGE', '已保存设置无法读取。');
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            fail('INVALID_IMPORT_JSON', '设置 JSON 无法解析。');
        }
        // Persist only a normalized current v17 document; an upgradeable
        // v11–v16 document is migrated inside normalize: v11–v14 refresh all
        // stock prompt copy, while v15–v16 refresh only the service presets.
        return persist(parsed);
    }

    function snapshot() {
        return cloneDocument(current());
    }

    function addConnectionPreset(input) {
        const next = cloneDocument(current());
        const preset = normalizeConnectionPreset(input);
        if (idExists(next.connectionPresets, preset.id)) fail('DUPLICATE_PRESET_ID', '连接预设 ID 已存在。');
        if (next.connectionPresets.length >= MAX_CONNECTION_PRESETS) fail('PRESET_LIMIT_REACHED', '连接预设数量已达上限。');
        next.connectionPresets.push(preset);
        if (next.defaults.connectionPresetId === null) next.defaults.connectionPresetId = preset.id;
        return persist(next);
    }

    function editConnectionPreset(input) {
        const next = cloneDocument(current());
        const preset = normalizeConnectionPreset(input);
        if (!idExists(next.connectionPresets, preset.id)) fail('UNKNOWN_PRESET_ID', '连接预设不存在。');
        next.connectionPresets = replaceById(next.connectionPresets, preset);
        return persist(next);
    }

    function deleteConnectionPreset(id) {
        const next = cloneDocument(current());
        const presetId = cleanId(id, '连接预设 ID');
        if (!idExists(next.connectionPresets, presetId)) fail('UNKNOWN_PRESET_ID', '连接预设不存在。');
        next.connectionPresets = withoutId(next.connectionPresets, presetId);
        if (next.defaults.connectionPresetId === presetId) next.defaults.connectionPresetId = nextDefaultId(next.connectionPresets);
        for (const key of FUNCTION_KEYS) {
            if (next.functionBindings[key].connectionPresetId === presetId) next.functionBindings[key].connectionPresetId = null;
            for (const contentMode of CONTENT_MODES) {
                if (next.functionModeBindings[key][contentMode].connectionPresetId === presetId) {
                    next.functionModeBindings[key][contentMode].connectionPresetId = null;
                }
            }
        }
        return persist(next);
    }

    function addPromptPreset(input) {
        const next = cloneDocument(current());
        const preset = normalizePromptPreset(input);
        if (idExists(next.promptPresets, preset.id)) fail('DUPLICATE_PRESET_ID', '提示词预设 ID 已存在。');
        if (next.promptPresets.length >= MAX_PROMPT_PRESETS) fail('PRESET_LIMIT_REACHED', '提示词预设数量已达上限。');
        next.promptPresets.push(preset);
        if (next.defaults.promptPresetId === null) next.defaults.promptPresetId = preset.id;
        return persist(next);
    }

    function editPromptPreset(input) {
        const next = cloneDocument(current());
        const preset = normalizePromptPreset(input);
        if (!idExists(next.promptPresets, preset.id)) fail('UNKNOWN_PRESET_ID', '提示词预设不存在。');
        next.promptPresets = replaceById(next.promptPresets, preset);
        return persist(next);
    }

    function deletePromptPreset(id) {
        const next = cloneDocument(current());
        const presetId = cleanId(id, '提示词预设 ID');
        if (!idExists(next.promptPresets, presetId)) fail('UNKNOWN_PRESET_ID', '提示词预设不存在。');
        next.promptPresets = withoutId(next.promptPresets, presetId);
        if (next.defaults.promptPresetId === presetId) next.defaults.promptPresetId = nextDefaultId(next.promptPresets);
        for (const key of FUNCTION_KEYS) {
            if (next.functionBindings[key].promptPresetId === presetId) next.functionBindings[key].promptPresetId = null;
            for (const contentMode of CONTENT_MODES) {
                if (next.functionModeBindings[key][contentMode].promptPresetId === presetId) {
                    next.functionModeBindings[key][contentMode].promptPresetId = null;
                }
            }
        }
        return persist(next);
    }

    function setDefaults(input) {
        const next = cloneDocument(current());
        const defaults = normalizeBinding(input);
        if (defaults.connectionPresetId !== null && !idExists(next.connectionPresets, defaults.connectionPresetId)) {
            fail('UNKNOWN_PRESET_ID', '默认连接预设不存在。');
        }
        if (defaults.promptPresetId !== null && !idExists(next.promptPresets, defaults.promptPresetId)) {
            fail('UNKNOWN_PRESET_ID', '默认提示词预设不存在。');
        }
        next.defaults = defaults;
        return persist(next);
    }

    function bindFunction(functionKey, input) {
        if (!FUNCTION_KEYS.includes(functionKey)) fail('UNKNOWN_FUNCTION', '不支持该功能绑定。');
        const next = cloneDocument(current());
        const binding = normalizeBinding(input);
        if (binding.connectionPresetId !== null && !idExists(next.connectionPresets, binding.connectionPresetId)) {
            fail('UNKNOWN_PRESET_ID', '绑定的连接预设不存在。');
        }
        if (binding.promptPresetId !== null && !idExists(next.promptPresets, binding.promptPresetId)) {
            fail('UNKNOWN_PRESET_ID', '绑定的提示词预设不存在。');
        }
        next.functionBindings[functionKey] = binding;
        return persist(next);
    }

    function bindFunctionForContentMode(functionKey, contentMode, input) {
        if (!FUNCTION_KEYS.includes(functionKey)) fail('UNKNOWN_FUNCTION', '不支持该功能绑定。');
        const normalizedContentMode = cleanContentMode(contentMode);
        const next = cloneDocument(current());
        const binding = normalizeBinding(input);
        validateBindingPresetReferences(
            binding,
            `${functionKey}/${normalizedContentMode}`,
            new Set(next.connectionPresets.map((preset) => preset.id)),
            new Map(next.promptPresets.map((preset) => [preset.id, preset])),
            normalizedContentMode,
        );
        next.functionModeBindings[functionKey][normalizedContentMode] = binding;
        return persist(next);
    }

    /**
     * Resolves the normal settings binding, optionally overlaying a browser-local
     * group/forum binding. The overlay is never persisted in this settings
     * document, so group/forum choices cannot leak into exports or MVU state.
     */
    function resolveFunction(functionKey, { contentMode, binding: localBindingInput } = {}) {
        if (!FUNCTION_KEYS.includes(functionKey)) fail('UNKNOWN_FUNCTION', '不支持该功能绑定。');
        const source = current();
        const binding = source.functionBindings[functionKey];
        const selectedContentMode = contentMode === undefined ? null : cleanContentMode(contentMode);
        const modeBinding = selectedContentMode === null ? null : source.functionModeBindings[functionKey][selectedContentMode];
        const localBinding = localBindingInput === undefined ? null : normalizeBinding(localBindingInput);
        if (localBinding !== null) {
            validateBindingPresetReferences(
                localBinding,
                `${functionKey}/local`,
                new Set(source.connectionPresets.map((preset) => preset.id)),
                new Map(source.promptPresets.map((preset) => [preset.id, preset])),
                selectedContentMode,
            );
        }
        const connectionPresetId = localBinding?.connectionPresetId ?? modeBinding?.connectionPresetId ?? binding.connectionPresetId ?? source.defaults.connectionPresetId;
        // Live AI functions always declare a content mode. Do not fall through
        // to a global prompt here: that would make a SFW preset usable in NSFW
        // (or the reverse) merely because a mode-specific choice was cleared.
        const promptPresetId = selectedContentMode === null
            ? localBinding?.promptPresetId ?? binding.promptPresetId ?? source.defaults.promptPresetId
            : localBinding?.promptPresetId ?? modeBinding?.promptPresetId ?? null;
        return Object.freeze({
            functionKey,
            contentMode: selectedContentMode,
            connectionPreset: connectionPresetId === null ? null : cloneDocument(findById(source.connectionPresets, connectionPresetId)),
            promptPreset: promptPresetId === null ? null : cloneDocument(findById(source.promptPresets, promptPresetId)),
            usedDefaultConnectionPreset: modeBinding?.connectionPresetId == null && binding.connectionPresetId === null,
            usedDefaultPromptPreset: selectedContentMode === null && binding.promptPresetId === null,
            usedModeBinding: modeBinding !== null,
            usedLocalBinding: localBinding !== null,
        });
    }

    function getChatSummarySettings() {
        return { ...current().chatSummary };
    }

    function setChatSummarySettings(input) {
        const next = cloneDocument(current());
        next.chatSummary = normalizeChatSummary(input);
        return persist(next);
    }

    function getImageGenerationSettings() {
        return cloneDocument(current().imageGeneration);
    }

    function setImageGenerationSettings(input) {
        const next = cloneDocument(current());
        next.imageGeneration = normalizeImageGenerationSettings(input);
        return persist(next);
    }

    function getConversationImageGenerationSettings(kind, id) {
        if (!IMAGE_GENERATION_CONVERSATION_KINDS.has(kind) || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail('INVALID_IMAGE_GENERATION', '对话生图设置标识无效。');
        return { ...(current().imageGeneration.conversationSettings[kind][id] ?? { autoGenerate: false }) };
    }

    function setConversationImageGenerationSettings(kind, id, input) {
        if (!IMAGE_GENERATION_CONVERSATION_KINDS.has(kind) || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail('INVALID_IMAGE_GENERATION', '对话生图设置标识无效。');
        const normalized = normalizeImageConversationSettings(input);
        const next = cloneDocument(current());
        if (!Object.hasOwn(next.imageGeneration.conversationSettings[kind], id)
            && Object.values(next.imageGeneration.conversationSettings).reduce((count, records) => count + Object.keys(records).length, 0) >= MAX_IMAGE_GENERATION_CONVERSATIONS) fail('INVALID_IMAGE_GENERATION', '对话生图设置数量达到上限。');
        next.imageGeneration.conversationSettings[kind][id] = normalized;
        return persist(next);
    }

    function setPersonalizationEnabled(enabled) {
        if (typeof enabled !== 'boolean') fail('INVALID_PERSONALIZATION', '个性化内容推荐开关必须为布尔值。');
        const next = cloneDocument(current());
        next.personalization.enabled = enabled;
        return persist(next);
    }

    function setPersonalizationKeywordWeights(contentMode, keywordWeights) {
        const selectedContentMode = cleanContentMode(contentMode);
        const next = cloneDocument(current());
        next.personalization.keywordWeightsByMode[selectedContentMode] = normalizeKeywordWeights(keywordWeights);
        return persist(next);
    }

    /**
     * Adds newly observed public candidate tags to one mode-specific device-local
     * learning library at the neutral 0 weight. Existing manual or learned
     * weights are never overwritten; a disabled personalization feature remains
     * untouched.
     */
    function ensurePersonalizationKeywordWeights(contentMode, keywords) {
        const selectedContentMode = cleanContentMode(contentMode);
        if (!Array.isArray(keywords)) fail('INVALID_PERSONALIZATION', '关键词列表必须是数组。');
        const normalizedKeywords = normalizeKeywordWeights(keywords.map((keyword) => ({ keyword, weight: 0 })))
            .map((item) => item.keyword);
        const next = cloneDocument(current());
        if (!next.personalization.enabled || normalizedKeywords.length === 0) return cloneDocument(next);

        const modeWeights = next.personalization.keywordWeightsByMode[selectedContentMode];
        const knownKeywords = new Set(modeWeights.map((item) => item.keyword.toLowerCase()));
        let changed = false;
        for (const keyword of normalizedKeywords) {
            if (knownKeywords.has(keyword.toLowerCase()) || modeWeights.length >= MAX_PERSONALIZATION_KEYWORDS) continue;
            modeWeights.push({ keyword, weight: 0 });
            knownKeywords.add(keyword.toLowerCase());
            changed = true;
        }
        return changed ? persist(next) : cloneDocument(next);
    }

    /**
     * Applies one locally derived public-tag preference delta to exactly one
     * content mode after a successful controlled recommendation action. It
     * deliberately touches only this browser's personalization cache, never
     * connection settings or MVU data.
     */
    function applyPersonalizationKeywordWeightDelta(contentMode, keywords, delta) {
        const selectedContentMode = cleanContentMode(contentMode);
        if (!Number.isInteger(delta) || delta < -5 || delta > 5 || delta === 0) {
            fail('INVALID_PERSONALIZATION', '关键词权重增量必须是 -5–5 范围内的非零整数。');
        }
        if (!Array.isArray(keywords)) fail('INVALID_PERSONALIZATION', '关键词列表必须是数组。');
        const normalizedKeywords = normalizeKeywordWeights(keywords.map((keyword) => ({ keyword, weight: 0 })))
            .map((item) => item.keyword);
        const next = cloneDocument(current());
        if (!next.personalization.enabled || normalizedKeywords.length === 0) return cloneDocument(next);

        const modeWeights = next.personalization.keywordWeightsByMode[selectedContentMode];
        const indexByKeyword = new Map(modeWeights.map((item, index) => [item.keyword.toLowerCase(), index]));
        for (const keyword of normalizedKeywords) {
            const index = indexByKeyword.get(keyword.toLowerCase());
            if (index === undefined) {
                modeWeights.push({ keyword, weight: Math.max(-5, Math.min(5, delta)) });
                indexByKeyword.set(keyword.toLowerCase(), modeWeights.length - 1);
            } else {
                const currentWeight = modeWeights[index].weight;
                modeWeights[index].weight = Math.max(-5, Math.min(5, currentWeight + delta));
            }
        }
        return persist(next);
    }

    function exportJson() {
        const serialized = JSON.stringify(normalizeSettingsDocument(current()));
        if (new TextEncoder().encode(serialized).byteLength > MAX_SERIALIZED_BYTES) {
            fail('SETTINGS_TOO_LARGE', '设置数据超过允许的大小限制。');
        }
        return serialized;
    }

    function importJson(rawJson) {
        if (typeof rawJson !== 'string' || new TextEncoder().encode(rawJson).byteLength > MAX_SERIALIZED_BYTES) {
            fail('SETTINGS_TOO_LARGE', '导入文件超过允许的大小限制。');
        }
        let parsed;
        try {
            parsed = JSON.parse(rawJson);
        } catch {
            fail('INVALID_IMPORT_JSON', '导入文件不是有效 JSON。');
        }
        return persist(normalizeSettingsDocument(parsed));
    }

    function clear() {
        targetStorage.removeItem(storageKey);
        document = null;
        return load();
    }

    return Object.freeze({
        load,
        snapshot,
        addConnectionPreset,
        editConnectionPreset,
        deleteConnectionPreset,
        addPromptPreset,
        editPromptPreset,
        deletePromptPreset,
        setDefaults,
        bindFunction,
        bindFunctionForContentMode,
        resolveFunction,
        getChatSummarySettings,
        setChatSummarySettings,
        getImageGenerationSettings,
        setImageGenerationSettings,
        getConversationImageGenerationSettings,
        setConversationImageGenerationSettings,
        setPersonalizationEnabled,
        setPersonalizationKeywordWeights,
        ensurePersonalizationKeywordWeights,
        applyPersonalizationKeywordWeightDelta,
        exportJson,
        importJson,
        clear,
    });
}

/**
 * 阶段 2a：本地非机密设置与提示词预设存储。
 *
 * 该模块只处理可持久化的公开配置；API Key 的会话内解锁由 ../llm/session-key-store.js 独立负责。
 */
import { createConnectionPreset } from '../llm/openai-compatible-client.js';

export const SETTINGS_SCHEMA_ID = 'yuelema.settings';
export const SETTINGS_SCHEMA_VERSION = 2;
export const SETTINGS_STORAGE_KEY = 'yuelema.settings.v1';
export const MAX_SERIALIZED_BYTES = 512 * 1024;
export const MAX_CONNECTION_PRESETS = 64;
export const MAX_PROMPT_PRESETS = 128;
export const MAX_PERSONALIZATION_KEYWORDS = 64;
export const FUNCTION_KEYS = Object.freeze([
    'chat',
    'character_authoring',
    'character_ai_completion',
    'character_full_authoring',
    'soul_match',
    'text_match',
    'recommendation_refresh',
    'group_chat',
    'forum',
]);

const SECRET_FIELD_NAMES = new Set([
    'apikey', 'api_key', 'key', 'token', 'access_token', 'authorization', 'password', 'secret',
]);
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PROMPT_POSITIONS = new Set(['before_character_definition', 'after_character_definition']);
const LEGACY_SETTINGS_SCHEMA_VERSION = 1;

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

function makeDefaultDocument() {
    return {
        schema: SETTINGS_SCHEMA_ID,
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        connectionPresets: [],
        promptPresets: [],
        defaults: { connectionPresetId: null, promptPresetId: null },
        functionBindings: Object.fromEntries(FUNCTION_KEYS.map((key) => [key, {
            connectionPresetId: null,
            promptPresetId: null,
        }])),
        personalization: {
            enabled: true,
            keywordWeights: [],
        },
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
        'id', 'name', 'depth', 'order', 'position', 'enabled', 'content',
    ].includes(key));
    if (unknown.length > 0) fail('INVALID_PROMPT_PRESET', '提示词预设包含不支持的字段。');
    if (typeof candidate.enabled !== 'boolean') fail('INVALID_PROMPT_PRESET', 'enabled 必须为布尔值。');
    const position = cleanText(candidate.position, 'position', 1, 64);
    if (!PROMPT_POSITIONS.has(position)) {
        fail('INVALID_PROMPT_PRESET', 'position 仅支持 before_character_definition 或 after_character_definition。');
    }
    return {
        id: cleanId(candidate.id, '提示词预设 ID'),
        name: cleanText(candidate.name, '提示词预设名称', 1, 80),
        depth: cleanInteger(candidate.depth, 'depth', 0, 1000),
        order: cleanInteger(candidate.order, 'order', -1000, 1000),
        position,
        enabled: candidate.enabled,
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

function normalizePersonalization(input) {
    if (input === undefined || input === null) {
        return { enabled: true, keywordWeights: [] };
    }
    const candidate = safeClone(input);
    if (!isPlainObject(candidate) || Object.keys(candidate).some((key) => !['enabled', 'keywordWeights'].includes(key))) {
        fail('INVALID_PERSONALIZATION', '个性化内容推荐设置包含不支持的字段。');
    }
    if (typeof candidate.enabled !== 'boolean') {
        fail('INVALID_PERSONALIZATION', '个性化内容推荐开关必须为布尔值。');
    }
    return {
        enabled: candidate.enabled,
        keywordWeights: normalizeKeywordWeights(candidate.keywordWeights ?? []),
    };
}

function assertSize(document) {
    const encoded = JSON.stringify(document);
    if (new TextEncoder().encode(encoded).byteLength > MAX_SERIALIZED_BYTES) {
        fail('SETTINGS_TOO_LARGE', '设置数据超过允许的大小限制。');
    }
}

/** 将未经信任的对象严格迁移并归一化为当前版本的可持久化文档。 */
export function normalizeSettingsDocument(input) {
    const candidate = safeClone(input);
    if (!isPlainObject(candidate)) fail('INVALID_SETTINGS', '设置文档必须是对象。');
    const allowed = new Set(['schema', 'schemaVersion', 'connectionPresets', 'promptPresets', 'defaults', 'functionBindings', 'personalization']);
    if (Object.keys(candidate).some((key) => !allowed.has(key))) {
        fail('INVALID_SETTINGS', '设置文档包含不支持的字段。');
    }
    if (candidate.schema !== SETTINGS_SCHEMA_ID) {
        fail('UNSUPPORTED_SETTINGS_SCHEMA', '设置 schema 不受支持。');
    }
    if (![LEGACY_SETTINGS_SCHEMA_VERSION, SETTINGS_SCHEMA_VERSION].includes(candidate.schemaVersion)) {
        fail('UNSUPPORTED_SETTINGS_VERSION', '设置版本不受支持。');
    }
    if (!Array.isArray(candidate.connectionPresets) || candidate.connectionPresets.length > MAX_CONNECTION_PRESETS) {
        fail('INVALID_SETTINGS', '连接预设数量无效。');
    }
    if (!Array.isArray(candidate.promptPresets) || candidate.promptPresets.length > MAX_PROMPT_PRESETS) {
        fail('INVALID_SETTINGS', '提示词预设数量无效。');
    }

    const connectionPresets = candidate.connectionPresets.map(normalizeConnectionPreset);
    const promptPresets = candidate.promptPresets.map(normalizePromptPreset);
    const connectionIds = new Set(connectionPresets.map((preset) => preset.id));
    const promptIds = new Set(promptPresets.map((preset) => preset.id));
    if (connectionIds.size !== connectionPresets.length || promptIds.size !== promptPresets.length) {
        fail('DUPLICATE_PRESET_ID', '预设 ID 不可重复。');
    }

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
    if (defaults.promptPresetId !== null && !promptIds.has(defaults.promptPresetId)) {
        fail('UNKNOWN_PRESET_ID', '默认提示词预设不存在。');
    }

    const bindingsInput = safeClone(candidate.functionBindings ?? {});
    if (!isPlainObject(bindingsInput) || Object.keys(bindingsInput).some((key) => !FUNCTION_KEYS.includes(key))) {
        fail('INVALID_BINDING', '功能绑定包含未知功能。');
    }
    const functionBindings = {};
    for (const functionKey of FUNCTION_KEYS) {
        const binding = normalizeBinding(bindingsInput[functionKey]);
        if (binding.connectionPresetId !== null && !connectionIds.has(binding.connectionPresetId)) {
            fail('UNKNOWN_PRESET_ID', `${functionKey} 绑定的连接预设不存在。`);
        }
        if (binding.promptPresetId !== null && !promptIds.has(binding.promptPresetId)) {
            fail('UNKNOWN_PRESET_ID', `${functionKey} 绑定的提示词预设不存在。`);
        }
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

    const personalization = normalizePersonalization(candidate.personalization);
    const normalized = {
        schema: SETTINGS_SCHEMA_ID,
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        connectionPresets,
        promptPresets,
        defaults,
        functionBindings,
        personalization,
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
            document = makeDefaultDocument();
            return cloneDocument(document);
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
        document = normalizeSettingsDocument(parsed);
        return cloneDocument(document);
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

    function resolveFunction(functionKey) {
        if (!FUNCTION_KEYS.includes(functionKey)) fail('UNKNOWN_FUNCTION', '不支持该功能绑定。');
        const source = current();
        const binding = source.functionBindings[functionKey];
        const connectionPresetId = binding.connectionPresetId ?? source.defaults.connectionPresetId;
        const promptPresetId = binding.promptPresetId ?? source.defaults.promptPresetId;
        return Object.freeze({
            functionKey,
            connectionPreset: connectionPresetId === null ? null : cloneDocument(findById(source.connectionPresets, connectionPresetId)),
            promptPreset: promptPresetId === null ? null : cloneDocument(findById(source.promptPresets, promptPresetId)),
            usedDefaultConnectionPreset: binding.connectionPresetId === null,
            usedDefaultPromptPreset: binding.promptPresetId === null,
        });
    }

    function setPersonalizationEnabled(enabled) {
        if (typeof enabled !== 'boolean') fail('INVALID_PERSONALIZATION', '个性化内容推荐开关必须为布尔值。');
        const next = cloneDocument(current());
        next.personalization.enabled = enabled;
        return persist(next);
    }

    function setPersonalizationKeywordWeights(keywordWeights) {
        const next = cloneDocument(current());
        next.personalization.keywordWeights = normalizeKeywordWeights(keywordWeights);
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
        document = makeDefaultDocument();
        return cloneDocument(document);
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
        resolveFunction,
        setPersonalizationEnabled,
        setPersonalizationKeywordWeights,
        exportJson,
        importJson,
        clear,
    });
}

/**
 * Browser-local, non-secret character template library.
 *
 * Templates are normalized exclusively through character-template-codec.js.
 * This module never accepts, persists, returns, or exports connection settings
 * or credentials. Storage may be injected for testing or host integration; any
 * unavailable browser storage transparently falls back to this store instance's
 * in-memory storage.
 */
import * as defaultCharacterTemplateCodec from './character-template-codec.js';

export const CHARACTER_LIBRARY_SCHEMA_ID = 'yuelema.character-library';
export const CHARACTER_LIBRARY_SCHEMA_VERSION = 1;
export const CHARACTER_LIBRARY_STORAGE_KEY = 'yuelema.character-library.v1';
export const MAX_CHARACTER_LIBRARY_TEMPLATES = 50;
export const MAX_CHARACTER_LIBRARY_SERIALIZED_BYTES = 8 * 1024 * 1024;

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_KEY_PATTERN = /(?:api[\s_-]*key|authorization|token|secret|password|credential|private[\s_-]*key|密钥|令牌|密码|授权|凭据)/iu;
const HTML_PATTERN = /<!--|<\s*\/?\s*[a-z][^>]*>/iu;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export class CharacterLibraryError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'CharacterLibraryError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new CharacterLibraryError(code, message);
}

function safeDefaultStorage() {
    try { return globalThis.localStorage; } catch { return null; }
}

function createMemoryStorage() {
    const values = new Map();
    return Object.freeze({
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); },
    });
}

function isStorageAdapter(value) {
    return value && typeof value.getItem === 'function'
        && typeof value.setItem === 'function' && typeof value.removeItem === 'function';
}

/**
 * A per-store adapter: once the supplied browser storage fails, all later I/O
 * uses memory so a blocked/quota-limited localStorage cannot erase this session.
 */
function createResilientStorage(candidate) {
    const fallback = createMemoryStorage();
    if (!isStorageAdapter(candidate)) return fallback;

    let useFallback = false;
    return Object.freeze({
        getItem(key) {
            if (useFallback) return fallback.getItem(key);
            try { return candidate.getItem(key); } catch {
                useFallback = true;
                return fallback.getItem(key);
            }
        },
        setItem(key, value) {
            if (useFallback) return fallback.setItem(key, value);
            try { return candidate.setItem(key, value); } catch {
                useFallback = true;
                return fallback.setItem(key, value);
            }
        },
        removeItem(key) {
            if (useFallback) return fallback.removeItem(key);
            try { return candidate.removeItem(key); } catch {
                useFallback = true;
                return fallback.removeItem(key);
            }
        },
    });
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function ownData(record, key, code = 'UNSAFE_LIBRARY_DATA') {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail(code, '角色模板资料字段格式不安全。');
    }
    return descriptor.value;
}

function assertSafeKey(key) {
    if (DANGEROUS_KEYS.has(key)) fail('UNSAFE_LIBRARY_DATA', '角色模板资料包含不允许的字段。');
    if (SENSITIVE_KEY_PATTERN.test(key)) fail('SENSITIVE_DATA_FORBIDDEN', '角色模板不能包含 API Key 或其他凭据。');
}

/** Clones only JSON-like own data and refuses getters, symbols, and credential keys. */
function cloneSafeValue(value, seen = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || seen.has(value)) {
        fail('UNSAFE_LIBRARY_DATA', '角色模板资料格式不安全。');
    }
    seen.add(value);

    if (Array.isArray(value)) {
        const keys = Reflect.ownKeys(value);
        if (keys.some((key) => key !== 'length' && (!/^\d+$/u.test(String(key)) || typeof key !== 'string'))) {
            fail('UNSAFE_LIBRARY_DATA', '角色模板资料格式不安全。');
        }
        const output = [];
        for (let index = 0; index < value.length; index += 1) {
            if (!Object.hasOwn(value, index)) fail('UNSAFE_LIBRARY_DATA', '角色模板资料格式不安全。');
            output.push(cloneSafeValue(ownData(value, String(index)), seen));
        }
        seen.delete(value);
        return output;
    }

    if (!isPlainObject(value)) fail('UNSAFE_LIBRARY_DATA', '角色模板资料格式不安全。');
    const output = {};
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') fail('UNSAFE_LIBRARY_DATA', '角色模板资料包含不允许的字段。');
        assertSafeKey(key);
        output[key] = cloneSafeValue(ownData(value, key), seen);
    }
    seen.delete(value);
    return output;
}

function assertExactObject(value, allowed, code, message) {
    if (!isPlainObject(value)) fail(code, message);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !allowed.has(key)) fail(code, message);
        assertSafeKey(key);
        ownData(value, key, code);
    }
}

function normalizeId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(value)) {
        fail('INVALID_TEMPLATE_ID', '角色模板 ID 必须为 1–96 位字母、数字、下划线或连字符。');
    }
    return value;
}

function normalizeName(value) {
    if (typeof value !== 'string') fail('INVALID_TEMPLATE_METADATA', '模板名称必须为文本。');
    const name = value.trim();
    if (name.length < 1 || name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name) || HTML_PATTERN.test(name)) {
        fail('INVALID_TEMPLATE_METADATA', '模板名称格式无效。');
    }
    return name;
}

function normalizeTimestamp(value) {
    if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
        fail('INVALID_LIBRARY_DOCUMENT', '角色模板时间戳格式无效。');
    }
    return value;
}

function normalizeMetadataInput(input) {
    assertExactObject(input, new Set(['name']), 'INVALID_TEMPLATE_METADATA', '模板 metadata 包含不支持的字段。');
    if (!Object.hasOwn(input, 'name')) fail('INVALID_TEMPLATE_METADATA', '模板 metadata 缺少名称。');
    return { name: normalizeName(ownData(input, 'name', 'INVALID_TEMPLATE_METADATA')) };
}

function normalizeStoredMetadata(input) {
    assertExactObject(input, new Set(['name', 'createdAt', 'updatedAt']), 'INVALID_LIBRARY_DOCUMENT', '已保存模板 metadata 无效。');
    for (const key of ['name', 'createdAt', 'updatedAt']) {
        if (!Object.hasOwn(input, key)) fail('INVALID_LIBRARY_DOCUMENT', '已保存模板 metadata 缺少字段。');
    }
    return {
        name: normalizeName(ownData(input, 'name', 'INVALID_LIBRARY_DOCUMENT')),
        createdAt: normalizeTimestamp(ownData(input, 'createdAt', 'INVALID_LIBRARY_DOCUMENT')),
        updatedAt: normalizeTimestamp(ownData(input, 'updatedAt', 'INVALID_LIBRARY_DOCUMENT')),
    };
}

function normalizeClock(now) {
    const value = now();
    const timestamp = value instanceof Date ? value.toISOString() : value;
    return normalizeTimestamp(timestamp);
}

function validateCodec(codec) {
    if (!codec || typeof codec.importCharacterTemplate !== 'function' || typeof codec.exportCharacterTemplate !== 'function') {
        fail('INVALID_CODEC', '角色模板 codec 接口不可用。');
    }
    return codec;
}

function normalizeTemplate(codec, input) {
    try {
        // The codec is the sole authority for adult character and avatar normalization.
        return cloneSafeValue(codec.importCharacterTemplate(input));
    } catch (error) {
        if (error instanceof CharacterLibraryError) throw error;
        // Do not return provider / imported-source error text to UI callers.
        fail('TEMPLATE_INVALID', '角色模板未通过导入校验。');
    }
}

function makeDefaultDocument() {
    return {
        schema: CHARACTER_LIBRARY_SCHEMA_ID,
        schemaVersion: CHARACTER_LIBRARY_SCHEMA_VERSION,
        templates: [],
    };
}

function normalizeDocument(codec, input) {
    assertExactObject(input, new Set(['schema', 'schemaVersion', 'templates']), 'INVALID_LIBRARY_DOCUMENT', '角色模板库文档无效。');
    if (input.schema !== CHARACTER_LIBRARY_SCHEMA_ID || input.schemaVersion !== CHARACTER_LIBRARY_SCHEMA_VERSION) {
        fail('UNSUPPORTED_LIBRARY_DOCUMENT', '角色模板库版本不受支持。');
    }
    if (!Array.isArray(input.templates) || input.templates.length > MAX_CHARACTER_LIBRARY_TEMPLATES) {
        fail('TEMPLATE_LIMIT_REACHED', '角色模板数量超过上限。');
    }

    const ids = new Set();
    const templates = input.templates.map((record) => {
        assertExactObject(record, new Set(['id', 'metadata', 'template']), 'INVALID_LIBRARY_DOCUMENT', '已保存角色模板记录无效。');
        for (const key of ['id', 'metadata', 'template']) {
            if (!Object.hasOwn(record, key)) fail('INVALID_LIBRARY_DOCUMENT', '已保存角色模板记录缺少字段。');
        }
        const id = normalizeId(ownData(record, 'id', 'INVALID_LIBRARY_DOCUMENT'));
        if (ids.has(id)) fail('DUPLICATE_TEMPLATE_ID', '角色模板 ID 不可重复。');
        ids.add(id);
        return {
            id,
            metadata: normalizeStoredMetadata(ownData(record, 'metadata', 'INVALID_LIBRARY_DOCUMENT')),
            template: normalizeTemplate(codec, ownData(record, 'template', 'INVALID_LIBRARY_DOCUMENT')),
        };
    });

    return { schema: CHARACTER_LIBRARY_SCHEMA_ID, schemaVersion: CHARACTER_LIBRARY_SCHEMA_VERSION, templates };
}

function cloneDocument(document) {
    return cloneSafeValue(document);
}

function assertDocumentSize(document) {
    const serialized = JSON.stringify(document);
    if (new TextEncoder().encode(serialized).byteLength > MAX_CHARACTER_LIBRARY_SERIALIZED_BYTES) {
        fail('LIBRARY_TOO_LARGE', '角色模板库超过允许的大小限制。');
    }
    return serialized;
}

function projectRecord(record, includeTemplate = false) {
    const result = { id: record.id, metadata: { ...record.metadata } };
    if (includeTemplate) result.template = cloneSafeValue(record.template);
    return result;
}

/**
 * Creates a non-secret local character-library repository.
 *
 * `storage` is a localStorage-compatible adapter and may be injected by the
 * extension host or test. `codec` is injectable for tests, while production
 * defaults to ./character-template-codec.js.
 */
export function createCharacterLibraryStore({
    storage = safeDefaultStorage(),
    storageKey = CHARACTER_LIBRARY_STORAGE_KEY,
    codec = defaultCharacterTemplateCodec,
    now = () => new Date().toISOString(),
} = {}) {
    if (typeof storageKey !== 'string' || storageKey.length < 1 || storageKey.length > 160) {
        fail('INVALID_STORAGE_KEY', '角色模板库存储键无效。');
    }
    if (typeof now !== 'function') fail('INVALID_CLOCK', '角色模板库时钟不可用。');
    const normalizedCodec = validateCodec(codec);
    const targetStorage = createResilientStorage(storage);
    let document = null;

    function current() {
        if (document === null) load();
        return document;
    }

    function persist(nextDocument) {
        const normalized = normalizeDocument(normalizedCodec, nextDocument);
        const serialized = assertDocumentSize(normalized);
        targetStorage.setItem(storageKey, serialized);
        document = normalized;
        return cloneDocument(document);
    }

    function load() {
        const raw = targetStorage.getItem(storageKey);
        if (raw === null || raw === '') {
            document = makeDefaultDocument();
            return cloneDocument(document);
        }
        if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_CHARACTER_LIBRARY_SERIALIZED_BYTES) {
            fail('LIBRARY_TOO_LARGE', '已保存角色模板库无法读取。');
        }
        let parsed;
        try { parsed = JSON.parse(raw); } catch {
            fail('INVALID_LIBRARY_JSON', '已保存角色模板库 JSON 无法解析。');
        }
        document = normalizeDocument(normalizedCodec, parsed);
        return cloneDocument(document);
    }

    function list() {
        return current().templates.map((record) => projectRecord(record));
    }

    function getRecord(id) {
        const normalizedId = normalizeId(id);
        const record = current().templates.find((item) => item.id === normalizedId);
        if (!record) fail('TEMPLATE_NOT_FOUND', '角色模板不存在。');
        return record;
    }

    function get(id) {
        return projectRecord(getRecord(id), true);
    }

    function create(input) {
        assertExactObject(input, new Set(['id', 'metadata', 'template']), 'INVALID_TEMPLATE_INPUT', '角色模板创建资料无效。');
        for (const key of ['id', 'metadata', 'template']) {
            if (!Object.hasOwn(input, key)) fail('INVALID_TEMPLATE_INPUT', '角色模板创建资料缺少字段。');
        }
        const id = normalizeId(ownData(input, 'id', 'INVALID_TEMPLATE_INPUT'));
        const state = current();
        if (state.templates.some((item) => item.id === id)) fail('DUPLICATE_TEMPLATE_ID', '角色模板 ID 已存在。');
        if (state.templates.length >= MAX_CHARACTER_LIBRARY_TEMPLATES) fail('TEMPLATE_LIMIT_REACHED', '角色模板数量已达上限。');
        const metadata = normalizeMetadataInput(ownData(input, 'metadata', 'INVALID_TEMPLATE_INPUT'));
        const timestamp = normalizeClock(now);
        const record = {
            id,
            metadata: { ...metadata, createdAt: timestamp, updatedAt: timestamp },
            template: normalizeTemplate(normalizedCodec, ownData(input, 'template', 'INVALID_TEMPLATE_INPUT')),
        };
        const next = cloneDocument(state);
        next.templates.push(record);
        persist(next);
        return projectRecord(record, true);
    }

    function update(id, input) {
        assertExactObject(input, new Set(['metadata', 'template']), 'INVALID_TEMPLATE_INPUT', '角色模板更新资料无效。');
        if (!Object.hasOwn(input, 'metadata') && !Object.hasOwn(input, 'template')) {
            fail('INVALID_TEMPLATE_INPUT', '角色模板更新资料不能为空。');
        }
        const currentRecord = getRecord(id);
        const next = cloneDocument(current());
        const index = next.templates.findIndex((item) => item.id === currentRecord.id);
        const replacement = next.templates[index];
        if (Object.hasOwn(input, 'metadata')) replacement.metadata.name = normalizeMetadataInput(ownData(input, 'metadata', 'INVALID_TEMPLATE_INPUT')).name;
        if (Object.hasOwn(input, 'template')) replacement.template = normalizeTemplate(normalizedCodec, ownData(input, 'template', 'INVALID_TEMPLATE_INPUT'));
        replacement.metadata.updatedAt = normalizeClock(now);
        persist(next);
        return projectRecord(replacement, true);
    }

    function remove(id) {
        const record = getRecord(id);
        const next = cloneDocument(current());
        next.templates = next.templates.filter((item) => item.id !== record.id);
        persist(next);
        return projectRecord(record, true);
    }

    function nextGeneratedId() {
        const base = normalizeClock(now).replace(/[^0-9]/gu, '');
        let suffix = 1;
        while (current().templates.some((item) => item.id === `template_${base}_${suffix}`)) suffix += 1;
        return `template_${base}_${suffix}`;
    }

    function importTemplate(input, options = {}) {
        assertExactObject(options, new Set(['id', 'metadata']), 'INVALID_IMPORT_OPTIONS', '角色模板导入选项无效。');
        const template = normalizeTemplate(normalizedCodec, input);
        const id = Object.hasOwn(options, 'id') ? normalizeId(ownData(options, 'id', 'INVALID_IMPORT_OPTIONS')) : nextGeneratedId();
        const metadata = Object.hasOwn(options, 'metadata')
            ? normalizeMetadataInput(ownData(options, 'metadata', 'INVALID_IMPORT_OPTIONS'))
            : { name: normalizeName(template.character.公开资料.昵称) };
        return create({ id, metadata, template });
    }

    function exportTemplate(id, { includeAvatar = true } = {}) {
        if (typeof includeAvatar !== 'boolean') fail('INVALID_EXPORT_OPTIONS', '角色模板导出选项无效。');
        const record = getRecord(id);
        try {
            const serialized = normalizedCodec.exportCharacterTemplate(record.template, { includeAvatar });
            if (typeof serialized !== 'string') fail('TEMPLATE_EXPORT_INVALID', '角色模板导出结果无效。');
            return serialized;
        } catch (error) {
            if (error instanceof CharacterLibraryError) throw error;
            fail('TEMPLATE_EXPORT_INVALID', '角色模板无法导出。');
        }
    }

    function clear() {
        targetStorage.removeItem(storageKey);
        document = makeDefaultDocument();
        return cloneDocument(document);
    }

    return Object.freeze({
        load,
        list,
        get,
        create,
        update,
        remove,
        importTemplate,
        exportTemplate,
        clear,
    });
}

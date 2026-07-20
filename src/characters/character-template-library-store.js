/**
 * Device-local character-template library for the character authoring screen.
 *
 * Security boundary:
 * - every template is validated and cloned by character-template-codec.js;
 * - list projections never contain the character payload or hidden profile fields;
 * - only id/name/timestamps are accepted as library metadata;
 * - API keys, connection settings, accessors, symbols, and prototype-polluting keys
 *   are rejected before persistence or export.
 */
import * as defaultCodec from './character-template-codec.js';

export const CHARACTER_TEMPLATE_LIBRARY_SCHEMA = 'yuelema.character-template-library';
export const CHARACTER_TEMPLATE_LIBRARY_SCHEMA_VERSION = 2;
export const CHARACTER_TEMPLATE_LIBRARY_STORAGE_KEY = 'yuelema.character-template-library.v2';
export const LEGACY_CHARACTER_LIBRARY_STORAGE_KEY = 'yuelema.character-library.v1';
export const MAX_CHARACTER_TEMPLATE_LIBRARY_ENTRIES = 50;
export const MAX_CHARACTER_TEMPLATE_LIBRARY_JSON_BYTES = 8 * 1024 * 1024;

const LEGACY_LIBRARY_SCHEMA = 'yuelema.character-library';
const LEGACY_LIBRARY_SCHEMA_VERSION = 1;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const HTML_PATTERN = /<!--|<\s*\/?\s*[a-z][^>]*>/iu;
const SENSITIVE_KEY_PATTERN = /(?:api[\s_-]*key|authorization|bearer|access[\s_-]*token|refresh[\s_-]*token|password|credential|private[\s_-]*key|connection[\s_-]*(?:setting|preset)|密钥|令牌|密码|授权|凭据|连接预设)/iu;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const ERROR_MESSAGES = Object.freeze({
    INVALID_STORAGE: '本地角色模板库存储接口不可用。',
    INVALID_STORAGE_KEY: '本地角色模板库存储键无效。',
    STORAGE_READ_FAILED: '读取本地角色模板库失败。',
    STORAGE_WRITE_FAILED: '保存本地角色模板库失败。',
    INVALID_CLOCK: '本地角色模板库时间来源无效。',
    INVALID_CODEC: '角色模板校验器不可用。',
    INVALID_LIBRARY_JSON: '角色模板库 JSON 无法解析。',
    LIBRARY_TOO_LARGE: '本地角色模板库超过允许的容量。',
    INVALID_LIBRARY_DOCUMENT: '角色模板库文档结构无效。',
    UNSUPPORTED_LIBRARY_VERSION: '角色模板库版本不受支持。',
    LIBRARY_MIGRATION_FAILED: '旧版角色模板库迁移失败。',
    INVALID_TEMPLATE_INPUT: '角色模板保存资料无效。',
    INVALID_TEMPLATE_ID: '角色模板 ID 无效。',
    INVALID_TEMPLATE_METADATA: '角色模板名称无效。',
    TEMPLATE_INVALID_JSON: '角色模板 JSON 无法解析。',
    TEMPLATE_TOO_LARGE: '角色模板超过允许的大小限制。',
    TEMPLATE_INVALID: '角色模板未通过成年人或结构校验。',
    TEMPLATE_NOT_FOUND: '本地角色模板不存在。',
    DUPLICATE_TEMPLATE_ID: '本地角色模板 ID 重复。',
    TEMPLATE_LIMIT_REACHED: '本地角色模板已达到数量上限。',
    INVALID_IMPORT_OPTIONS: '角色模板导入选项无效。',
    INVALID_EXPORT_OPTIONS: '角色模板导出选项无效。',
    INVALID_LIBRARY_IMPORT_OPTIONS: '角色模板库导入选项无效。',
    SENSITIVE_DATA_FORBIDDEN: '角色模板库不能包含 API Key、连接设置或其他凭据。',
    UNSAFE_LIBRARY_DATA: '角色模板库包含不安全的数据结构。',
    UNKNOWN_LIBRARY_ERROR: '本地角色模板库操作失败。',
});

export class CharacterTemplateLibraryError extends Error {
    constructor(code) {
        super(ERROR_MESSAGES[code] ?? '本地角色模板库操作失败。');
        this.name = 'CharacterTemplateLibraryError';
        this.code = code;
    }
}

function fail(code) {
    throw new CharacterTemplateLibraryError(code);
}

/** Returns a stable UI-safe error without exposing imported JSON or storage details. */
export function projectCharacterTemplateLibraryError(error) {
    const code = error instanceof CharacterTemplateLibraryError ? error.code : 'UNKNOWN_LIBRARY_ERROR';
    return Object.freeze({ code, message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.UNKNOWN_LIBRARY_ERROR });
}

function safeDefaultStorage() {
    try { return globalThis.localStorage ?? null; } catch { return null; }
}

function isStorageAdapter(value) {
    return value !== null && typeof value === 'object'
        && typeof value.getItem === 'function'
        && typeof value.setItem === 'function'
        && typeof value.removeItem === 'function';
}

function isPlainRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function ownData(record, key, code = 'UNSAFE_LIBRARY_DATA') {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    return descriptor.value;
}

function assertSafeKey(key) {
    if (typeof key !== 'string' || DANGEROUS_KEYS.has(key)) fail('UNSAFE_LIBRARY_DATA');
    if (SENSITIVE_KEY_PATTERN.test(key)) fail('SENSITIVE_DATA_FORBIDDEN');
}

function assertExactRecord(value, { required = [], optional = [], code = 'INVALID_LIBRARY_DOCUMENT' } = {}) {
    if (!isPlainRecord(value)) fail(code);
    const allowed = new Set([...required, ...optional]);
    for (const key of Reflect.ownKeys(value)) {
        assertSafeKey(key);
        if (!allowed.has(key)) fail(code);
        ownData(value, key, code);
    }
    for (const key of required) {
        if (!Object.hasOwn(value, key)) fail(code);
        ownData(value, key, code);
    }
}

function assertDenseDataArray(value, code = 'INVALID_LIBRARY_DOCUMENT') {
    if (!Array.isArray(value)) fail(code);
    for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)) fail('UNSAFE_LIBRARY_DATA');
        ownData(value, key, 'UNSAFE_LIBRARY_DATA');
    }
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) fail('UNSAFE_LIBRARY_DATA');
    }
}

function byteLength(value) {
    return new TextEncoder().encode(value).byteLength;
}

function normalizeStorageKey(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 160 || CONTROL_CHARACTER_PATTERN.test(value)) {
        fail('INVALID_STORAGE_KEY');
    }
    return value;
}

function normalizeId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(value)) fail('INVALID_TEMPLATE_ID');
    return value;
}

function normalizeName(value) {
    if (typeof value !== 'string') fail('INVALID_TEMPLATE_METADATA');
    const name = value.trim();
    if (name.length < 1 || name.length > 80 || CONTROL_CHARACTER_PATTERN.test(name) || HTML_PATTERN.test(name)) {
        fail('INVALID_TEMPLATE_METADATA');
    }
    return name;
}

function normalizeTimestamp(value, code = 'INVALID_LIBRARY_DOCUMENT') {
    if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value) || Number.isNaN(Date.parse(value))) fail(code);
    return value;
}

function validateCodec(codec) {
    if (!codec || typeof codec.importCharacterTemplate !== 'function'
        || typeof codec.exportCharacterTemplate !== 'function'
        || typeof codec.CHARACTER_TEMPLATE_FORMAT !== 'string') fail('INVALID_CODEC');
    return codec;
}

function projectCodecError(error) {
    if (error?.code === 'template_invalid_json') return 'TEMPLATE_INVALID_JSON';
    if (error?.code === 'template_too_large') return 'TEMPLATE_TOO_LARGE';
    if (error?.code === 'template_sensitive_key') return 'SENSITIVE_DATA_FORBIDDEN';
    return 'TEMPLATE_INVALID';
}

/** Uses the existing codec for both validation and the clone boundary. */
function normalizeTemplate(codec, input) {
    try {
        const normalized = codec.importCharacterTemplate(input);
        const serialized = codec.exportCharacterTemplate(normalized, { includeAvatar: true });
        if (typeof serialized !== 'string') fail('TEMPLATE_INVALID');
        return codec.importCharacterTemplate(serialized);
    } catch (error) {
        if (error instanceof CharacterTemplateLibraryError) throw error;
        fail(projectCodecError(error));
    }
}

function cloneTemplate(codec, template) {
    return normalizeTemplate(codec, template);
}

function normalizeMetadataInput(input) {
    assertExactRecord(input, { required: ['name'], code: 'INVALID_TEMPLATE_METADATA' });
    return { name: normalizeName(ownData(input, 'name', 'INVALID_TEMPLATE_METADATA')) };
}

function normalizeStoredMetadata(input) {
    assertExactRecord(input, {
        required: ['name', 'createdAt', 'updatedAt'],
        code: 'INVALID_LIBRARY_DOCUMENT',
    });
    return {
        name: normalizeName(ownData(input, 'name', 'INVALID_LIBRARY_DOCUMENT')),
        createdAt: normalizeTimestamp(ownData(input, 'createdAt', 'INVALID_LIBRARY_DOCUMENT')),
        updatedAt: normalizeTimestamp(ownData(input, 'updatedAt', 'INVALID_LIBRARY_DOCUMENT')),
    };
}

function normalizeRecord(codec, input) {
    assertExactRecord(input, {
        required: ['id', 'metadata', 'template'],
        code: 'INVALID_LIBRARY_DOCUMENT',
    });
    return {
        id: normalizeId(ownData(input, 'id', 'INVALID_LIBRARY_DOCUMENT')),
        metadata: normalizeStoredMetadata(ownData(input, 'metadata', 'INVALID_LIBRARY_DOCUMENT')),
        template: normalizeTemplate(codec, ownData(input, 'template', 'INVALID_LIBRARY_DOCUMENT')),
    };
}

function makeEmptyDocument() {
    return {
        schema: CHARACTER_TEMPLATE_LIBRARY_SCHEMA,
        schemaVersion: CHARACTER_TEMPLATE_LIBRARY_SCHEMA_VERSION,
        templates: [],
    };
}

function migrateLegacyDocument(input) {
    try {
        assertExactRecord(input, {
            required: ['schema', 'schemaVersion', 'templates'],
            code: 'LIBRARY_MIGRATION_FAILED',
        });
        if (ownData(input, 'schema', 'LIBRARY_MIGRATION_FAILED') !== LEGACY_LIBRARY_SCHEMA
            || ownData(input, 'schemaVersion', 'LIBRARY_MIGRATION_FAILED') !== LEGACY_LIBRARY_SCHEMA_VERSION
            || !Array.isArray(ownData(input, 'templates', 'LIBRARY_MIGRATION_FAILED'))) {
            fail('LIBRARY_MIGRATION_FAILED');
        }
        return {
            schema: CHARACTER_TEMPLATE_LIBRARY_SCHEMA,
            schemaVersion: CHARACTER_TEMPLATE_LIBRARY_SCHEMA_VERSION,
            templates: ownData(input, 'templates', 'LIBRARY_MIGRATION_FAILED'),
        };
    } catch (error) {
        if (error instanceof CharacterTemplateLibraryError && error.code === 'SENSITIVE_DATA_FORBIDDEN') throw error;
        fail('LIBRARY_MIGRATION_FAILED');
    }
}

function normalizeDocument(codec, input) {
    if (!isPlainRecord(input)) fail('INVALID_LIBRARY_DOCUMENT');
    const schema = Object.hasOwn(input, 'schema') ? ownData(input, 'schema', 'INVALID_LIBRARY_DOCUMENT') : undefined;
    const version = Object.hasOwn(input, 'schemaVersion') ? ownData(input, 'schemaVersion', 'INVALID_LIBRARY_DOCUMENT') : undefined;
    let source = input;

    if (schema === LEGACY_LIBRARY_SCHEMA && version === LEGACY_LIBRARY_SCHEMA_VERSION) {
        source = migrateLegacyDocument(input);
    } else if (schema !== CHARACTER_TEMPLATE_LIBRARY_SCHEMA || version !== CHARACTER_TEMPLATE_LIBRARY_SCHEMA_VERSION) {
        fail('UNSUPPORTED_LIBRARY_VERSION');
    }

    assertExactRecord(source, {
        required: ['schema', 'schemaVersion', 'templates'],
        code: 'INVALID_LIBRARY_DOCUMENT',
    });
    const templatesInput = ownData(source, 'templates', 'INVALID_LIBRARY_DOCUMENT');
    assertDenseDataArray(templatesInput);
    if (templatesInput.length > MAX_CHARACTER_TEMPLATE_LIBRARY_ENTRIES) fail('TEMPLATE_LIMIT_REACHED');

    const ids = new Set();
    const templates = [];
    for (let index = 0; index < templatesInput.length; index += 1) {
        const record = normalizeRecord(codec, ownData(templatesInput, String(index), 'UNSAFE_LIBRARY_DATA'));
        if (ids.has(record.id)) fail('DUPLICATE_TEMPLATE_ID');
        ids.add(record.id);
        templates.push(record);
    }
    return {
        schema: CHARACTER_TEMPLATE_LIBRARY_SCHEMA,
        schemaVersion: CHARACTER_TEMPLATE_LIBRARY_SCHEMA_VERSION,
        templates,
    };
}

function serializeDocument(document) {
    const serialized = JSON.stringify(document);
    if (byteLength(serialized) > MAX_CHARACTER_TEMPLATE_LIBRARY_JSON_BYTES) fail('LIBRARY_TOO_LARGE');
    return serialized;
}

function parseLibraryJson(input) {
    if (typeof input !== 'string' || input.length === 0) fail('INVALID_LIBRARY_JSON');
    if (byteLength(input) > MAX_CHARACTER_TEMPLATE_LIBRARY_JSON_BYTES) fail('LIBRARY_TOO_LARGE');
    try { return JSON.parse(input); } catch { fail('INVALID_LIBRARY_JSON'); }
}

function projectListRecord(record) {
    return {
        id: record.id,
        metadata: { ...record.metadata },
    };
}

function projectFullRecord(codec, record) {
    return {
        id: record.id,
        metadata: { ...record.metadata },
        template: cloneTemplate(codec, record.template),
    };
}

function cloneDocument(codec, document) {
    return {
        schema: document.schema,
        schemaVersion: document.schemaVersion,
        templates: document.templates.map((record) => projectFullRecord(codec, record)),
    };
}

/**
 * Creates the local template repository used by the character creation screen.
 * Storage is strict: failed persistence throws instead of pretending a template
 * was saved only in memory.
 */
export function createCharacterTemplateLibraryStore({
    storage = safeDefaultStorage(),
    storageKey = CHARACTER_TEMPLATE_LIBRARY_STORAGE_KEY,
    legacyStorageKey = LEGACY_CHARACTER_LIBRARY_STORAGE_KEY,
    codec = defaultCodec,
    now = () => new Date().toISOString(),
    idFactory,
} = {}) {
    if (!isStorageAdapter(storage)) fail('INVALID_STORAGE');
    const targetStorageKey = normalizeStorageKey(storageKey);
    const targetLegacyStorageKey = normalizeStorageKey(legacyStorageKey);
    const normalizedCodec = validateCodec(codec);
    if (typeof now !== 'function') fail('INVALID_CLOCK');
    if (idFactory !== undefined && typeof idFactory !== 'function') fail('INVALID_TEMPLATE_ID');

    let document = null;
    let migrated = false;

    function readStorage(key) {
        try {
            const value = storage.getItem(key);
            if (value !== null && typeof value !== 'string') fail('STORAGE_READ_FAILED');
            return value;
        } catch (error) {
            if (error instanceof CharacterTemplateLibraryError) throw error;
            fail('STORAGE_READ_FAILED');
        }
    }

    function writeStorage(key, value) {
        try { storage.setItem(key, value); } catch { fail('STORAGE_WRITE_FAILED'); }
    }

    function removeStorage(key, { bestEffort = false } = {}) {
        try { storage.removeItem(key); } catch { if (!bestEffort) fail('STORAGE_WRITE_FAILED'); }
    }

    function clock() {
        let value;
        try { value = now(); } catch { fail('INVALID_CLOCK'); }
        if (value instanceof Date) {
            try { value = value.toISOString(); } catch { fail('INVALID_CLOCK'); }
        }
        return normalizeTimestamp(value, 'INVALID_CLOCK');
    }

    function persist(nextDocument) {
        const normalized = normalizeDocument(normalizedCodec, nextDocument);
        const serialized = serializeDocument(normalized);
        writeStorage(targetStorageKey, serialized);
        document = normalized;
        return document;
    }

    function loadInternal() {
        if (document !== null) return document;
        const currentRaw = readStorage(targetStorageKey);
        if (currentRaw !== null) {
            const parsed = parseLibraryJson(currentRaw);
            const normalized = normalizeDocument(normalizedCodec, parsed);
            // Re-persist only when a same-key legacy document was encountered.
            if (parsed?.schema === LEGACY_LIBRARY_SCHEMA) persist(normalized);
            else document = normalized;
            return document;
        }

        const legacyRaw = targetLegacyStorageKey === targetStorageKey ? null : readStorage(targetLegacyStorageKey);
        if (legacyRaw !== null) {
            const parsed = parseLibraryJson(legacyRaw);
            if (parsed?.schema !== LEGACY_LIBRARY_SCHEMA || parsed?.schemaVersion !== LEGACY_LIBRARY_SCHEMA_VERSION) {
                fail('LIBRARY_MIGRATION_FAILED');
            }
            const normalized = normalizeDocument(normalizedCodec, parsed);
            persist(normalized);
            migrated = true;
            // The new copy is already durable; stale legacy cleanup is best effort.
            removeStorage(targetLegacyStorageKey, { bestEffort: true });
            return document;
        }

        document = makeEmptyDocument();
        return document;
    }

    function current() {
        return loadInternal();
    }

    function nextId() {
        const timestamp = clock();
        for (let attempt = 1; attempt <= 100; attempt += 1) {
            const proposed = idFactory
                ? idFactory({ timestamp, attempt })
                : `template_${timestamp.replace(/[^0-9]/gu, '')}_${attempt}`;
            const id = normalizeId(proposed);
            if (!current().templates.some((record) => record.id === id)) return id;
        }
        fail('DUPLICATE_TEMPLATE_ID');
    }

    function getRecord(id) {
        const normalizedId = normalizeId(id);
        const record = current().templates.find((entry) => entry.id === normalizedId);
        if (!record) fail('TEMPLATE_NOT_FOUND');
        return record;
    }

    function saveNormalizedTemplate({ id, name, template }) {
        const state = current();
        const normalizedId = id === undefined ? nextId() : normalizeId(id);
        if (state.templates.some((record) => record.id === normalizedId)) fail('DUPLICATE_TEMPLATE_ID');
        if (state.templates.length >= MAX_CHARACTER_TEMPLATE_LIBRARY_ENTRIES) fail('TEMPLATE_LIMIT_REACHED');
        const normalizedTemplate = normalizeTemplate(normalizedCodec, template);
        const normalizedName = name === undefined
            ? normalizeName(normalizedTemplate.character.公开资料.昵称)
            : normalizeName(name);
        const timestamp = clock();
        const record = {
            id: normalizedId,
            metadata: { name: normalizedName, createdAt: timestamp, updatedAt: timestamp },
            template: normalizedTemplate,
        };
        const next = cloneDocument(normalizedCodec, state);
        next.templates.push(record);
        persist(next);
        return projectFullRecord(normalizedCodec, record);
    }

    function saveTemplate(input) {
        assertExactRecord(input, {
            required: ['template'], optional: ['id', 'name'], code: 'INVALID_TEMPLATE_INPUT',
        });
        return saveNormalizedTemplate({
            id: Object.hasOwn(input, 'id') ? ownData(input, 'id', 'INVALID_TEMPLATE_INPUT') : undefined,
            name: Object.hasOwn(input, 'name') ? ownData(input, 'name', 'INVALID_TEMPLATE_INPUT') : undefined,
            template: ownData(input, 'template', 'INVALID_TEMPLATE_INPUT'),
        });
    }

    function saveCharacter(input) {
        assertExactRecord(input, {
            required: ['character'], optional: ['avatar', 'id', 'name'], code: 'INVALID_TEMPLATE_INPUT',
        });
        const envelope = {
            format: normalizedCodec.CHARACTER_TEMPLATE_FORMAT,
            character: ownData(input, 'character', 'INVALID_TEMPLATE_INPUT'),
        };
        if (Object.hasOwn(input, 'avatar')) envelope.avatar = ownData(input, 'avatar', 'INVALID_TEMPLATE_INPUT');
        return saveNormalizedTemplate({
            id: Object.hasOwn(input, 'id') ? ownData(input, 'id', 'INVALID_TEMPLATE_INPUT') : undefined,
            name: Object.hasOwn(input, 'name') ? ownData(input, 'name', 'INVALID_TEMPLATE_INPUT') : undefined,
            template: envelope,
        });
    }

    function listTemplates() {
        return current().templates.map(projectListRecord);
    }

    function loadTemplate(id) {
        return projectFullRecord(normalizedCodec, getRecord(id));
    }

    function renameTemplate(id, name) {
        const record = getRecord(id);
        const next = cloneDocument(normalizedCodec, current());
        const replacement = next.templates.find((entry) => entry.id === record.id);
        replacement.metadata.name = normalizeName(name);
        replacement.metadata.updatedAt = clock();
        persist(next);
        return projectListRecord(replacement);
    }

    function replaceTemplate(id, template) {
        const record = getRecord(id);
        const normalizedTemplate = normalizeTemplate(normalizedCodec, template);
        const next = cloneDocument(normalizedCodec, current());
        const replacement = next.templates.find((entry) => entry.id === record.id);
        replacement.template = normalizedTemplate;
        replacement.metadata.updatedAt = clock();
        persist(next);
        return projectFullRecord(normalizedCodec, replacement);
    }

    function deleteTemplate(id) {
        const record = getRecord(id);
        const next = cloneDocument(normalizedCodec, current());
        next.templates = next.templates.filter((entry) => entry.id !== record.id);
        persist(next);
        return projectFullRecord(normalizedCodec, record);
    }

    function importTemplateJson(input, options = {}) {
        assertExactRecord(options, { optional: ['id', 'name'], code: 'INVALID_IMPORT_OPTIONS' });
        let template;
        try { template = normalizeTemplate(normalizedCodec, input); } catch (error) { throw error; }
        return saveNormalizedTemplate({
            id: Object.hasOwn(options, 'id') ? ownData(options, 'id', 'INVALID_IMPORT_OPTIONS') : undefined,
            name: Object.hasOwn(options, 'name') ? ownData(options, 'name', 'INVALID_IMPORT_OPTIONS') : undefined,
            template,
        });
    }

    function exportTemplateJson(id, options = {}) {
        assertExactRecord(options, { optional: ['includeAvatar'], code: 'INVALID_EXPORT_OPTIONS' });
        const includeAvatar = Object.hasOwn(options, 'includeAvatar')
            ? ownData(options, 'includeAvatar', 'INVALID_EXPORT_OPTIONS') : true;
        if (typeof includeAvatar !== 'boolean') fail('INVALID_EXPORT_OPTIONS');
        const record = getRecord(id);
        try {
            const serialized = normalizedCodec.exportCharacterTemplate(record.template, { includeAvatar });
            if (typeof serialized !== 'string') fail('TEMPLATE_INVALID');
            return serialized;
        } catch (error) {
            if (error instanceof CharacterTemplateLibraryError) throw error;
            fail(projectCodecError(error));
        }
    }

    function exportLibraryJson(options = {}) {
        assertExactRecord(options, { optional: ['includeAvatar'], code: 'INVALID_EXPORT_OPTIONS' });
        const includeAvatar = Object.hasOwn(options, 'includeAvatar')
            ? ownData(options, 'includeAvatar', 'INVALID_EXPORT_OPTIONS') : true;
        if (typeof includeAvatar !== 'boolean') fail('INVALID_EXPORT_OPTIONS');
        const exported = makeEmptyDocument();
        exported.templates = current().templates.map((record) => {
            let template;
            try {
                template = normalizedCodec.importCharacterTemplate(
                    normalizedCodec.exportCharacterTemplate(record.template, { includeAvatar }),
                );
            } catch (error) {
                fail(projectCodecError(error));
            }
            return { id: record.id, metadata: { ...record.metadata }, template };
        });
        return serializeDocument(normalizeDocument(normalizedCodec, exported));
    }

    function importLibraryJson(input, options = {}) {
        assertExactRecord(options, { optional: ['mode'], code: 'INVALID_LIBRARY_IMPORT_OPTIONS' });
        const mode = Object.hasOwn(options, 'mode')
            ? ownData(options, 'mode', 'INVALID_LIBRARY_IMPORT_OPTIONS') : 'merge';
        if (mode !== 'merge' && mode !== 'replace') fail('INVALID_LIBRARY_IMPORT_OPTIONS');
        const incoming = normalizeDocument(normalizedCodec, typeof input === 'string' ? parseLibraryJson(input) : input);
        const base = mode === 'replace' ? makeEmptyDocument() : cloneDocument(normalizedCodec, current());
        const ids = new Set(base.templates.map((record) => record.id));
        for (const record of incoming.templates) {
            if (ids.has(record.id)) fail('DUPLICATE_TEMPLATE_ID');
            ids.add(record.id);
            base.templates.push(projectFullRecord(normalizedCodec, record));
        }
        if (base.templates.length > MAX_CHARACTER_TEMPLATE_LIBRARY_ENTRIES) fail('TEMPLATE_LIMIT_REACHED');
        persist(base);
        return Object.freeze({ mode, importedCount: incoming.templates.length, totalCount: document.templates.length });
    }

    function clear() {
        removeStorage(targetStorageKey);
        if (targetLegacyStorageKey !== targetStorageKey) removeStorage(targetLegacyStorageKey, { bestEffort: true });
        document = makeEmptyDocument();
        migrated = false;
        return Object.freeze({ totalCount: 0 });
    }

    function status() {
        return Object.freeze({
            schema: CHARACTER_TEMPLATE_LIBRARY_SCHEMA,
            schemaVersion: CHARACTER_TEMPLATE_LIBRARY_SCHEMA_VERSION,
            totalCount: current().templates.length,
            migrated,
        });
    }

    // Compatibility shape for the existing character creator panel is kept here;
    // the richer names below are preferred for new integration.
    function create(input) {
        assertExactRecord(input, {
            required: ['id', 'metadata', 'template'], code: 'INVALID_TEMPLATE_INPUT',
        });
        const metadata = normalizeMetadataInput(ownData(input, 'metadata', 'INVALID_TEMPLATE_INPUT'));
        return saveNormalizedTemplate({
            id: ownData(input, 'id', 'INVALID_TEMPLATE_INPUT'),
            name: metadata.name,
            template: ownData(input, 'template', 'INVALID_TEMPLATE_INPUT'),
        });
    }

    function update(id, input) {
        assertExactRecord(input, {
            optional: ['metadata', 'template'], code: 'INVALID_TEMPLATE_INPUT',
        });
        if (!Object.hasOwn(input, 'metadata') && !Object.hasOwn(input, 'template')) fail('INVALID_TEMPLATE_INPUT');
        const record = getRecord(id);
        const metadata = Object.hasOwn(input, 'metadata')
            ? normalizeMetadataInput(ownData(input, 'metadata', 'INVALID_TEMPLATE_INPUT')) : null;
        const template = Object.hasOwn(input, 'template')
            ? normalizeTemplate(normalizedCodec, ownData(input, 'template', 'INVALID_TEMPLATE_INPUT')) : null;
        const next = cloneDocument(normalizedCodec, current());
        const replacement = next.templates.find((entry) => entry.id === record.id);
        if (metadata) replacement.metadata.name = metadata.name;
        if (template) replacement.template = template;
        replacement.metadata.updatedAt = clock();
        persist(next);
        return projectFullRecord(normalizedCodec, replacement);
    }

    function importTemplate(input, options = {}) {
        assertExactRecord(options, { optional: ['id', 'metadata'], code: 'INVALID_IMPORT_OPTIONS' });
        const mapped = {};
        if (Object.hasOwn(options, 'id')) mapped.id = ownData(options, 'id', 'INVALID_IMPORT_OPTIONS');
        if (Object.hasOwn(options, 'metadata')) {
            mapped.name = normalizeMetadataInput(ownData(options, 'metadata', 'INVALID_IMPORT_OPTIONS')).name;
        }
        return importTemplateJson(input, mapped);
    }

    return Object.freeze({
        load: status,
        status,
        list: listTemplates,
        listTemplates,
        get: loadTemplate,
        loadTemplate,
        saveTemplate,
        saveCharacter,
        saveDraft: saveCharacter,
        saveGenerated: saveCharacter,
        renameTemplate,
        replaceTemplate,
        remove: deleteTemplate,
        deleteTemplate,
        create,
        update,
        importTemplate,
        importTemplateJson,
        exportTemplate: exportTemplateJson,
        exportTemplateJson,
        importLibraryJson,
        exportLibraryJson,
        clear,
    });
}

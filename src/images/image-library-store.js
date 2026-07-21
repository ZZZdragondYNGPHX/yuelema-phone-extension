/**
 * Browser-local image library for candidate presentation matching.
 *
 * The store is deliberately independent from MVU and connection settings. It
 * accepts only image sources plus keyword weights, uses an injected async
 * localforage-style adapter, and never reads SillyTavern globals directly.
 */
export const IMAGE_LIBRARY_SCHEMA_ID = 'yuelema.image-library';
export const IMAGE_LIBRARY_SCHEMA_VERSION = 1;
export const IMAGE_LIBRARY_STORAGE_KEY = 'yuelema.image-library.v1';
export const MAX_IMAGE_LIBRARY_IMAGES = 50;
export const MAX_IMAGE_LIBRARY_SERIALIZED_BYTES = 24 * 1024 * 1024;
export const MAX_EMBEDDED_IMAGE_DATA_URL_LENGTH = 1_048_576;
export const MAX_IMAGE_KEYWORDS = 256;

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const HTML_PATTERN = /<!--|<\s*\/?\s*[a-z][^>]*>/iu;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SECRET_VALUE_PATTERN = /(?:\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,})/iu;
const ERROR_PREFIX = 'image_library_error:';

const USER_MESSAGES = Object.freeze({
    INVALID_STORAGE_ADAPTER: '图片库存储接口不可用。',
    STORAGE_READ_FAILED: '图片库读取失败。',
    STORAGE_WRITE_FAILED: '图片库保存失败。',
    INVALID_LIBRARY_JSON: '图片库 JSON 无法解析。',
    INVALID_LIBRARY_DOCUMENT: '图片库文档格式无效。',
    UNSUPPORTED_LIBRARY_VERSION: '图片库版本不受支持。',
    LIBRARY_LIMIT_REACHED: '图片库最多保存 50 张图片。',
    LIBRARY_TOO_LARGE: '图片库超过允许的大小限制。',
    IMAGE_NOT_FOUND: '指定图片不存在。',
    DUPLICATE_IMAGE_ID: '图片 ID 已存在。',
    INVALID_IMAGE_ID: '图片 ID 格式无效。',
    INVALID_IMAGE_INPUT: '图片资料格式无效。',
    INVALID_IMAGE_SOURCE: '图片来源必须是安全的本地图片或 HTTP/HTTPS 链接。',
    INVALID_KEYWORD_WEIGHTS: '图片关键词或权重格式无效。',
    DUPLICATE_KEYWORD: '同一张图片不能包含重复关键词。',
    DANGEROUS_FIELD_FORBIDDEN: '图片库包含不允许的危险字段。',
    SENSITIVE_FIELD_FORBIDDEN: '图片库不能包含密钥、角色 UID、Patch 或隐私关系资料。',
    UNSAFE_LIBRARY_DATA: '图片库资料结构不安全。',
    IMAGE_LIBRARY_ERROR: '图片库操作失败。',
});

export class ImageLibraryError extends Error {
    constructor(code) {
        super(`${ERROR_PREFIX}${code}`);
        this.name = 'ImageLibraryError';
        this.code = code;
    }
}

function fail(code) {
    throw new ImageLibraryError(code);
}

function isImageLibraryError(error) {
    return error instanceof ImageLibraryError
        && typeof error.code === 'string'
        && typeof error.message === 'string'
        && error.message.startsWith(ERROR_PREFIX);
}

export function projectImageLibraryError(error) {
    const code = isImageLibraryError(error) ? error.code : 'IMAGE_LIBRARY_ERROR';
    return Object.freeze({
        code,
        message: USER_MESSAGES[code] ?? USER_MESSAGES.IMAGE_LIBRARY_ERROR,
    });
}

function normalizedFieldName(key) {
    return key.normalize('NFKC').toLowerCase().replace(/[\s_.\-/]/gu, '');
}

function isSensitiveField(key) {
    const folded = normalizedFieldName(key);
    return /(?:apikey|authorization|authtoken|accesstoken|refreshtoken|token|secret|password|credential|privatekey|accesskey|sessionkey|uid$|jsonpatch|jsonpointer|updatevariable|patch|hidden|friendonly|friends?|relationship|relationscore|threshold|密钥|令牌|密码|授权|凭据|用户id|角色uid|补丁|隐藏|仅好友|好友|关系|阈值)/iu.test(folded);
}

function assertSafeKey(key) {
    if (DANGEROUS_KEYS.has(key)) fail('DANGEROUS_FIELD_FORBIDDEN');
    if (isSensitiveField(key)) fail('SENSITIVE_FIELD_FORBIDDEN');
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function ownData(record, key, code = 'UNSAFE_LIBRARY_DATA') {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    return descriptor.value;
}

/** Clone JSON-like own data while rejecting accessors, cycles, symbols, and sensitive keys. */
function cloneSafeValue(value, seen = new Set()) {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        if (SECRET_VALUE_PATTERN.test(value)) fail('SENSITIVE_FIELD_FORBIDDEN');
        return value;
    }
    if (typeof value !== 'object' || seen.has(value)) fail('UNSAFE_LIBRARY_DATA');
    seen.add(value);

    if (Array.isArray(value)) {
        const keys = Reflect.ownKeys(value);
        for (const key of keys) {
            if (key === 'length') continue;
            if (typeof key !== 'string' || !/^\d+$/u.test(key)) fail('UNSAFE_LIBRARY_DATA');
        }
        const output = [];
        for (let index = 0; index < value.length; index += 1) {
            if (!Object.hasOwn(value, index)) fail('UNSAFE_LIBRARY_DATA');
            output.push(cloneSafeValue(ownData(value, String(index)), seen));
        }
        seen.delete(value);
        return output;
    }

    if (!isPlainObject(value)) fail('UNSAFE_LIBRARY_DATA');
    const output = {};
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') fail('DANGEROUS_FIELD_FORBIDDEN');
        assertSafeKey(key);
        output[key] = cloneSafeValue(ownData(value, key), seen);
    }
    seen.delete(value);
    return output;
}

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

function project(value) {
    return deepFreeze(cloneSafeValue(value));
}

function assertExactObject(value, allowed, required, code) {
    if (!isPlainObject(value)) fail(code);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') fail('DANGEROUS_FIELD_FORBIDDEN');
        assertSafeKey(key);
        if (!allowed.has(key)) fail(code);
        ownData(value, key, code);
    }
    for (const key of required) {
        if (!Object.hasOwn(value, key)) fail(code);
        ownData(value, key, code);
    }
}

function normalizeId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(value)) fail('INVALID_IMAGE_ID');
    return value;
}

function normalizeTimestamp(value) {
    if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
        fail('INVALID_LIBRARY_DOCUMENT');
    }
    return value;
}

function normalizeClock(now) {
    let value;
    try { value = now(); } catch { fail('INVALID_LIBRARY_DOCUMENT'); }
    const timestamp = value instanceof Date ? value.toISOString() : value;
    return normalizeTimestamp(timestamp);
}

function base64PrefixBytes(encoded, byteCount = 12) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const output = [];
    let bits = 0;
    let accumulator = 0;
    for (const char of encoded) {
        if (char === '=') break;
        const value = alphabet.indexOf(char);
        if (value < 0) fail('INVALID_IMAGE_SOURCE');
        accumulator = (accumulator << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            output.push((accumulator >> bits) & 0xff);
            if (output.length >= byteCount) break;
        }
    }
    return output;
}

function normalizeEmbeddedImageDataUrl(value) {
    if (typeof value !== 'string' || value.length === 0
        || value.length > MAX_EMBEDDED_IMAGE_DATA_URL_LENGTH || value !== value.trim()) {
        fail('INVALID_IMAGE_SOURCE');
    }
    // Validate the transport envelope and a small binary signature. Decoded image
    // bytes are arbitrary binary and must not be scanned with text/HTML regular
    // expressions: valid PNG/WebP/JPEG payloads can naturally contain markup-like
    // byte sequences.
    const match = /^data:(image\/(?:png|jpeg|webp));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/iu.exec(value);
    if (!match || match[2].length === 0) fail('INVALID_IMAGE_SOURCE');
    const mediaType = match[1].toLowerCase();
    const encoded = match[2];
    const prefix = base64PrefixBytes(encoded);
    const hasPrefix = (...bytes) => bytes.every((byte, index) => prefix[index] === byte);
    if (mediaType === 'image/png' && !hasPrefix(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) fail('INVALID_IMAGE_SOURCE');
    if (mediaType === 'image/jpeg' && !hasPrefix(0xff, 0xd8, 0xff)) fail('INVALID_IMAGE_SOURCE');
    if (mediaType === 'image/webp'
        && !(hasPrefix(0x52, 0x49, 0x46, 0x46) && prefix[8] === 0x57 && prefix[9] === 0x45
            && prefix[10] === 0x42 && prefix[11] === 0x50)) {
        fail('INVALID_IMAGE_SOURCE');
    }
    return `data:${mediaType};base64,${encoded}`;
}

function normalizeRemoteImageUrl(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2_048 || value !== value.trim()
        || CONTROL_PATTERN.test(value) || HTML_PATTERN.test(value)) {
        fail('INVALID_IMAGE_SOURCE');
    }
    let parsed;
    try { parsed = new URL(value); } catch { fail('INVALID_IMAGE_SOURCE'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
        fail('INVALID_IMAGE_SOURCE');
    }
    for (const key of parsed.searchParams.keys()) assertSafeKey(key);
    for (const parameterValue of parsed.searchParams.values()) {
        if (SECRET_VALUE_PATTERN.test(parameterValue)) fail('SENSITIVE_FIELD_FORBIDDEN');
    }
    if (parsed.hash.includes('=')) {
        const fragmentParams = new URLSearchParams(parsed.hash.slice(1));
        for (const key of fragmentParams.keys()) assertSafeKey(key);
        for (const parameterValue of fragmentParams.values()) {
            if (SECRET_VALUE_PATTERN.test(parameterValue)) fail('SENSITIVE_FIELD_FORBIDDEN');
        }
    }
    return parsed.href;
}

function normalizeSource(input) {
    assertExactObject(input, new Set(['kind', 'url', 'dataUrl']), new Set(['kind']), 'INVALID_IMAGE_SOURCE');
    const kind = ownData(input, 'kind', 'INVALID_IMAGE_SOURCE');
    if (kind === 'embedded') {
        assertExactObject(input, new Set(['kind', 'dataUrl']), new Set(['kind', 'dataUrl']), 'INVALID_IMAGE_SOURCE');
        return { kind, dataUrl: normalizeEmbeddedImageDataUrl(ownData(input, 'dataUrl', 'INVALID_IMAGE_SOURCE')) };
    }
    if (kind === 'url') {
        assertExactObject(input, new Set(['kind', 'url']), new Set(['kind', 'url']), 'INVALID_IMAGE_SOURCE');
        return { kind, url: normalizeRemoteImageUrl(ownData(input, 'url', 'INVALID_IMAGE_SOURCE')) };
    }
    fail('INVALID_IMAGE_SOURCE');
}

function normalizeKeyword(value) {
    if (typeof value !== 'string') fail('INVALID_KEYWORD_WEIGHTS');
    const keyword = value.trim();
    const characterCount = [...keyword].length;
    if (characterCount < 1 || characterCount > 40 || CONTROL_PATTERN.test(keyword)
        || HTML_PATTERN.test(keyword) || SECRET_VALUE_PATTERN.test(keyword)) {
        fail('INVALID_KEYWORD_WEIGHTS');
    }
    return keyword;
}

function normalizeKeywordWeights(input) {
    if (!Array.isArray(input) || input.length > MAX_IMAGE_KEYWORDS) fail('INVALID_KEYWORD_WEIGHTS');
    const seen = new Set();
    return input.map((entry) => {
        assertExactObject(entry, new Set(['keyword', 'weight']), new Set(['keyword', 'weight']), 'INVALID_KEYWORD_WEIGHTS');
        const keyword = normalizeKeyword(ownData(entry, 'keyword', 'INVALID_KEYWORD_WEIGHTS'));
        const folded = keyword.normalize('NFKC').toLowerCase();
        if (seen.has(folded)) fail('DUPLICATE_KEYWORD');
        seen.add(folded);
        const weight = ownData(entry, 'weight', 'INVALID_KEYWORD_WEIGHTS');
        if (!Number.isInteger(weight) || weight < -5 || weight > 5) fail('INVALID_KEYWORD_WEIGHTS');
        return { keyword, weight };
    });
}

function normalizeStoredRecord(input) {
    assertExactObject(
        input,
        new Set(['id', 'source', 'keywordWeights', 'createdAt', 'updatedAt']),
        new Set(['id', 'source', 'keywordWeights', 'createdAt', 'updatedAt']),
        'INVALID_LIBRARY_DOCUMENT',
    );
    const createdAt = normalizeTimestamp(ownData(input, 'createdAt', 'INVALID_LIBRARY_DOCUMENT'));
    const updatedAt = normalizeTimestamp(ownData(input, 'updatedAt', 'INVALID_LIBRARY_DOCUMENT'));
    if (Date.parse(updatedAt) < Date.parse(createdAt)) fail('INVALID_LIBRARY_DOCUMENT');
    return {
        id: normalizeId(ownData(input, 'id', 'INVALID_LIBRARY_DOCUMENT')),
        source: normalizeSource(ownData(input, 'source', 'INVALID_LIBRARY_DOCUMENT')),
        keywordWeights: normalizeKeywordWeights(ownData(input, 'keywordWeights', 'INVALID_LIBRARY_DOCUMENT')),
        createdAt,
        updatedAt,
    };
}

function makeDefaultDocument() {
    return {
        schema: IMAGE_LIBRARY_SCHEMA_ID,
        schemaVersion: IMAGE_LIBRARY_SCHEMA_VERSION,
        images: [],
    };
}

function normalizeDocument(input) {
    const candidate = cloneSafeValue(input);
    assertExactObject(
        candidate,
        new Set(['schema', 'schemaVersion', 'images']),
        new Set(['schema', 'schemaVersion', 'images']),
        'INVALID_LIBRARY_DOCUMENT',
    );
    if (candidate.schema !== IMAGE_LIBRARY_SCHEMA_ID || candidate.schemaVersion !== IMAGE_LIBRARY_SCHEMA_VERSION) {
        fail('UNSUPPORTED_LIBRARY_VERSION');
    }
    if (!Array.isArray(candidate.images)) fail('INVALID_LIBRARY_DOCUMENT');
    if (candidate.images.length > MAX_IMAGE_LIBRARY_IMAGES) fail('LIBRARY_LIMIT_REACHED');

    const ids = new Set();
    const images = candidate.images.map((record) => {
        const normalized = normalizeStoredRecord(record);
        if (ids.has(normalized.id)) fail('DUPLICATE_IMAGE_ID');
        ids.add(normalized.id);
        return normalized;
    });
    return { schema: IMAGE_LIBRARY_SCHEMA_ID, schemaVersion: IMAGE_LIBRARY_SCHEMA_VERSION, images };
}

function utf8ByteLength(value) {
    let bytes = 0;
    for (const char of value) {
        const codePoint = char.codePointAt(0);
        if (codePoint <= 0x7f) bytes += 1;
        else if (codePoint <= 0x7ff) bytes += 2;
        else if (codePoint <= 0xffff) bytes += 3;
        else bytes += 4;
    }
    return bytes;
}

function serializeDocument(document) {
    let serialized;
    try { serialized = JSON.stringify(document); } catch { fail('UNSAFE_LIBRARY_DATA'); }
    if (utf8ByteLength(serialized) > MAX_IMAGE_LIBRARY_SERIALIZED_BYTES) fail('LIBRARY_TOO_LARGE');
    return serialized;
}

function parseImportInput(input) {
    if (typeof input !== 'string') return normalizeDocument(input);
    if (input.length === 0) fail('INVALID_LIBRARY_JSON');
    if (utf8ByteLength(input) > MAX_IMAGE_LIBRARY_SERIALIZED_BYTES) fail('LIBRARY_TOO_LARGE');
    let parsed;
    try { parsed = JSON.parse(input); } catch { fail('INVALID_LIBRARY_JSON'); }
    return normalizeDocument(parsed);
}

function isStorageAdapter(value) {
    return value && typeof value.getItem === 'function'
        && typeof value.setItem === 'function' && typeof value.removeItem === 'function';
}

export function createMemoryImageLibraryStorage(initialEntries = []) {
    const values = new Map(initialEntries);
    return Object.freeze({
        async getItem(key) { return values.has(key) ? values.get(key) : null; },
        async setItem(key, value) { values.set(key, value); },
        async removeItem(key) { values.delete(key); },
    });
}

function resolveOptions(options) {
    if (isStorageAdapter(options)) return { storage: options };
    if (options === undefined) return {};
    if (!isPlainObject(options)) fail('INVALID_STORAGE_ADAPTER');
    return options;
}

/**
 * Creates an async image library. `storage` may be a localforage instance or
 * any adapter exposing async-compatible getItem/setItem/removeItem methods.
 */
export function createImageLibraryStore(options) {
    const resolved = resolveOptions(options);
    const storage = resolved.storage ?? createMemoryImageLibraryStorage();
    const storageKey = resolved.storageKey ?? IMAGE_LIBRARY_STORAGE_KEY;
    const now = resolved.now ?? (() => new Date());
    if (!isStorageAdapter(storage) || typeof storageKey !== 'string' || storageKey.length === 0 || typeof now !== 'function') {
        fail('INVALID_STORAGE_ADAPTER');
    }

    let document = makeDefaultDocument();
    let loaded = false;
    let loadingPromise = null;
    let writeTail = Promise.resolve();

    async function ensureLoaded() {
        if (loaded) return;
        if (loadingPromise) return loadingPromise;
        loadingPromise = (async () => {
            let stored;
            try { stored = await storage.getItem(storageKey); } catch { fail('STORAGE_READ_FAILED'); }
            if (stored === null || stored === undefined) {
                document = makeDefaultDocument();
            } else if (typeof stored === 'string') {
                document = parseImportInput(stored);
            } else {
                document = normalizeDocument(stored);
                serializeDocument(document);
            }
            loaded = true;
        })();
        try { await loadingPromise; } finally { loadingPromise = null; }
    }

    function enqueueWrite(action) {
        const result = writeTail.then(action, action);
        writeTail = result.then(() => undefined, () => undefined);
        return result;
    }

    async function readDocument() {
        await writeTail;
        await ensureLoaded();
        return document;
    }

    async function commit(nextDocument) {
        const normalized = normalizeDocument(nextDocument);
        const serialized = serializeDocument(normalized);
        try { await storage.setItem(storageKey, serialized); } catch { fail('STORAGE_WRITE_FAILED'); }
        document = normalized;
        loaded = true;
        return document;
    }

    function findRecord(state, id) {
        const normalizedId = normalizeId(id);
        const record = state.images.find((item) => item.id === normalizedId);
        if (!record) fail('IMAGE_NOT_FOUND');
        return record;
    }

    function nextGeneratedId(state, timestamp) {
        const base = timestamp.replace(/[^0-9]/gu, '');
        let suffix = 1;
        let id = `image_${base}_${suffix}`;
        while (state.images.some((item) => item.id === id)) {
            suffix += 1;
            id = `image_${base}_${suffix}`;
        }
        return id;
    }

    async function snapshot() {
        return project(await readDocument());
    }

    async function list() {
        const state = await readDocument();
        return project(state.images);
    }

    async function get(id) {
        const state = await readDocument();
        return project(findRecord(state, id));
    }

    async function add(input) {
        return enqueueWrite(async () => {
            await ensureLoaded();
            const candidate = cloneSafeValue(input);
            assertExactObject(candidate, new Set(['id', 'source', 'keywordWeights']), new Set(['source']), 'INVALID_IMAGE_INPUT');
            if (document.images.length >= MAX_IMAGE_LIBRARY_IMAGES) fail('LIBRARY_LIMIT_REACHED');
            const timestamp = normalizeClock(now);
            const id = Object.hasOwn(candidate, 'id')
                ? normalizeId(ownData(candidate, 'id', 'INVALID_IMAGE_INPUT'))
                : nextGeneratedId(document, timestamp);
            if (document.images.some((item) => item.id === id)) fail('DUPLICATE_IMAGE_ID');
            const record = {
                id,
                source: normalizeSource(ownData(candidate, 'source', 'INVALID_IMAGE_INPUT')),
                keywordWeights: Object.hasOwn(candidate, 'keywordWeights')
                    ? normalizeKeywordWeights(ownData(candidate, 'keywordWeights', 'INVALID_IMAGE_INPUT'))
                    : [],
                createdAt: timestamp,
                updatedAt: timestamp,
            };
            const next = normalizeDocument({ ...document, images: [...document.images, record] });
            await commit(next);
            return project(record);
        });
    }

    async function update(id, input) {
        return enqueueWrite(async () => {
            await ensureLoaded();
            const normalizedId = normalizeId(id);
            const candidate = cloneSafeValue(input);
            assertExactObject(candidate, new Set(['source', 'keywordWeights']), new Set(), 'INVALID_IMAGE_INPUT');
            if (!Object.hasOwn(candidate, 'source') && !Object.hasOwn(candidate, 'keywordWeights')) fail('INVALID_IMAGE_INPUT');
            const current = findRecord(document, normalizedId);
            const replacement = {
                ...current,
                source: Object.hasOwn(candidate, 'source')
                    ? normalizeSource(ownData(candidate, 'source', 'INVALID_IMAGE_INPUT'))
                    : current.source,
                keywordWeights: Object.hasOwn(candidate, 'keywordWeights')
                    ? normalizeKeywordWeights(ownData(candidate, 'keywordWeights', 'INVALID_IMAGE_INPUT'))
                    : current.keywordWeights,
                updatedAt: normalizeClock(now),
            };
            const next = normalizeDocument({
                ...document,
                images: document.images.map((record) => record.id === normalizedId ? replacement : record),
            });
            await commit(next);
            return project(replacement);
        });
    }

    async function remove(id) {
        return enqueueWrite(async () => {
            await ensureLoaded();
            const current = findRecord(document, id);
            const next = normalizeDocument({
                ...document,
                images: document.images.filter((record) => record.id !== current.id),
            });
            await commit(next);
            return project(current);
        });
    }

    async function exportLibrary() {
        const state = await readDocument();
        return serializeDocument(state);
    }

    async function importLibrary(input) {
        return enqueueWrite(async () => {
            await ensureLoaded();
            // Full validation and size checking happen before storage or memory state changes.
            const next = parseImportInput(input);
            serializeDocument(next);
            await commit(next);
            return project(next);
        });
    }

    return Object.freeze({
        snapshot,
        list,
        get,
        add,
        update,
        remove,
        export: exportLibrary,
        import: importLibrary,
    });
}



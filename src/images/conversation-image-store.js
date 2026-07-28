import { normalizeImageDirective } from './image-directive.js';

export const CONVERSATION_IMAGE_STORAGE_KEY = 'yuelema.conversation-images.v1';
export const MAX_CONVERSATION_IMAGES = 48;
export const MAX_CONVERSATION_IMAGE_DATA_URL_LENGTH = 24 * 1024 * 1024;
export const MAX_CONVERSATION_IMAGE_STORE_BYTES = 48 * 1024 * 1024;

const SCHEMA = 'yuelema.conversation-images';
const VERSION = 1;
const KINDS = new Set(['private', 'group', 'forum']);

export class ConversationImageStoreError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ConversationImageStoreError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new ConversationImageStoreError(code, message);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function safeId(value, label) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
        fail('INVALID_CONVERSATION_IMAGE', `${label}无效。`);
    }
    return value;
}

function base64Prefix(encoded) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const output = [];
    let bits = 0;
    let accumulator = 0;
    for (const char of encoded) {
        if (char === '=') break;
        const value = alphabet.indexOf(char);
        if (value < 0) fail('INVALID_CONVERSATION_IMAGE', '图片数据无效。');
        accumulator = (accumulator << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            output.push((accumulator >> bits) & 0xff);
            if (output.length >= 12) break;
        }
    }
    return output;
}

function safeDataUrl(value) {
    if (typeof value !== 'string' || value.length > MAX_CONVERSATION_IMAGE_DATA_URL_LENGTH) {
        fail('INVALID_CONVERSATION_IMAGE', '图片数据无效或过大。');
    }
    const match = /^data:(image\/(?:png|jpeg|webp));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/iu.exec(value);
    if (!match || !match[2]) fail('INVALID_CONVERSATION_IMAGE', '图片数据无效。');
    const bytes = base64Prefix(match[2]);
    const starts = (...expected) => expected.every((byte, index) => bytes[index] === byte);
    const mimeType = match[1].toLowerCase();
    if (mimeType === 'image/png' && !starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) fail('INVALID_CONVERSATION_IMAGE', 'PNG 图片签名无效。');
    if (mimeType === 'image/jpeg' && !starts(0xff, 0xd8, 0xff)) fail('INVALID_CONVERSATION_IMAGE', 'JPEG 图片签名无效。');
    if (mimeType === 'image/webp' && !(starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)) {
        fail('INVALID_CONVERSATION_IMAGE', 'WebP 图片签名无效。');
    }
    return `data:${mimeType};base64,${match[2]}`;
}

function recordKey(kind, conversationId, messageId) {
    if (!KINDS.has(kind)) fail('INVALID_CONVERSATION_IMAGE', '对话类型无效。');
    return `${kind}:${safeId(conversationId, '对话 ID')}:${safeId(messageId, '消息 ID')}`;
}

function normalizeRecord(input) {
    if (!isPlainObject(input)) fail('INVALID_CONVERSATION_IMAGE', '对话图片记录无效。');
    const allowed = new Set(['kind', 'conversationId', 'messageId', 'directive', 'imageSource', 'createdAt', 'updatedAt']);
    if (Object.keys(input).some((key) => !allowed.has(key))) fail('INVALID_CONVERSATION_IMAGE', '对话图片记录包含未知字段。');
    const kind = input.kind;
    const conversationId = safeId(input.conversationId, '对话 ID');
    const messageId = safeId(input.messageId, '消息 ID');
    const createdAt = String(input.createdAt ?? '');
    const updatedAt = String(input.updatedAt ?? '');
    if (!KINDS.has(kind) || !Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) {
        fail('INVALID_CONVERSATION_IMAGE', '对话图片记录无效。');
    }
    return Object.freeze({
        kind,
        conversationId,
        messageId,
        directive: normalizeImageDirective(input.directive),
        imageSource: safeDataUrl(input.imageSource),
        createdAt,
        updatedAt,
    });
}

function normalizeDocument(input) {
    if (!isPlainObject(input) || input.schema !== SCHEMA || input.schemaVersion !== VERSION || !Array.isArray(input.records)) {
        fail('INVALID_CONVERSATION_IMAGE_STORE', '对话图片存储格式无效。');
    }
    const records = input.records.map(normalizeRecord);
    if (records.length > MAX_CONVERSATION_IMAGES) fail('INVALID_CONVERSATION_IMAGE_STORE', '对话图片数量超过上限。');
    const keys = new Set();
    for (const record of records) {
        const key = recordKey(record.kind, record.conversationId, record.messageId);
        if (keys.has(key)) fail('INVALID_CONVERSATION_IMAGE_STORE', '对话图片记录重复。');
        keys.add(key);
    }
    return { schema: SCHEMA, schemaVersion: VERSION, records };
}

function serialize(document) {
    const text = JSON.stringify(document);
    if (new TextEncoder().encode(text).length > MAX_CONVERSATION_IMAGE_STORE_BYTES) {
        fail('CONVERSATION_IMAGE_STORE_TOO_LARGE', '对话图片存储空间已满。');
    }
    return text;
}

export function createMemoryConversationImageStorage(initialEntries = []) {
    const values = new Map(initialEntries);
    return Object.freeze({
        async getItem(key) { return values.has(key) ? values.get(key) : null; },
        async setItem(key, value) { values.set(key, value); return value; },
        async removeItem(key) { values.delete(key); },
    });
}

export function createConversationImageStore({ storage = createMemoryConversationImageStorage(), storageKey = CONVERSATION_IMAGE_STORAGE_KEY, now = () => new Date() } = {}) {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
        fail('INVALID_CONVERSATION_IMAGE_STORAGE', '对话图片存储接口不可用。');
    }
    let document = { schema: SCHEMA, schemaVersion: VERSION, records: [] };
    let readyPromise = null;
    let loaded = false;
    let writeTail = Promise.resolve();

    async function ready() {
        if (loaded) return;
        if (readyPromise) return readyPromise;
        readyPromise = (async () => {
            let stored;
            try { stored = await storage.getItem(storageKey); }
            catch { fail('CONVERSATION_IMAGE_READ_FAILED', '对话图片读取失败。'); }
            if (stored !== null && stored !== undefined) {
                let parsed = stored;
                if (typeof stored === 'string') {
                    try { parsed = JSON.parse(stored); }
                    catch { fail('INVALID_CONVERSATION_IMAGE_STORE', '对话图片存储格式无效。'); }
                }
                document = normalizeDocument(parsed);
                serialize(document);
            }
            loaded = true;
        })();
        try { await readyPromise; } finally { readyPromise = null; }
    }

    function peek(kind, conversationId, messageId) {
        if (!loaded) return null;
        const key = recordKey(kind, conversationId, messageId);
        return document.records.find((record) => recordKey(record.kind, record.conversationId, record.messageId) === key) ?? null;
    }

    function list() {
        return loaded ? Object.freeze([...document.records]) : Object.freeze([]);
    }

    async function put(input) {
        const result = writeTail.then(async () => {
            await ready();
            const timestamp = now().toISOString();
            const key = recordKey(input?.kind, input?.conversationId, input?.messageId);
            const current = document.records.find((record) => recordKey(record.kind, record.conversationId, record.messageId) === key);
            const record = normalizeRecord({ ...input, createdAt: current?.createdAt ?? timestamp, updatedAt: timestamp });
            let records = document.records.filter((item) => recordKey(item.kind, item.conversationId, item.messageId) !== key);
            records.push(record);
            records.sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
            if (records.length > MAX_CONVERSATION_IMAGES) records = records.slice(-MAX_CONVERSATION_IMAGES);
            const next = normalizeDocument({ schema: SCHEMA, schemaVersion: VERSION, records });
            const serialized = serialize(next);
            try { await storage.setItem(storageKey, serialized); }
            catch { fail('CONVERSATION_IMAGE_WRITE_FAILED', '对话图片保存失败。'); }
            document = next;
            return record;
        });
        writeTail = result.then(() => undefined, () => undefined);
        return result;
    }

    async function removeConversation(kind, conversationId) {
        const result = writeTail.then(async () => {
            await ready();
            if (!KINDS.has(kind)) fail('INVALID_CONVERSATION_IMAGE', '对话类型无效。');
            const safeConversationId = safeId(conversationId, '对话 ID');
            const records = document.records.filter((record) => record.kind !== kind || record.conversationId !== safeConversationId);
            if (records.length === document.records.length) return 0;
            const next = normalizeDocument({ schema: SCHEMA, schemaVersion: VERSION, records });
            const serialized = serialize(next);
            try { await storage.setItem(storageKey, serialized); }
            catch { fail('CONVERSATION_IMAGE_WRITE_FAILED', '对话图片删除失败。'); }
            const removed = document.records.length - records.length;
            document = next;
            return removed;
        });
        writeTail = result.then(() => undefined, () => undefined);
        return result;
    }

    return Object.freeze({ ready, peek, list, put, removeConversation });
}

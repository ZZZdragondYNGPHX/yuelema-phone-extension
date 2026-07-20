/**
 * 浏览器本地 API Key 保管库。
 *
 * 用户明确选择让连接预设的 Key 留在当前浏览器缓存中，避免页面重开、扩展热
 * 重载后出现“界面显示已解锁、调用端却取不到 Key”的断层。缓存以预设 ID 为
 * 键，独立于设置文档：不会进入 MVU、角色卡、聊天、提示词、导入导出、日志或
 * 可见错误。输入框始终保持为空，也不提供读取或回显完整 Key 的 UI。
 */
export const API_KEY_CACHE_STORAGE_KEY = 'yuelema-phone-api-keys-v1';
const CACHE_SCHEMA = 'yuelema.api-key-cache';
const CACHE_VERSION = 1;
const MAX_CACHED_PRESETS = 64;
const MAX_CACHE_BYTES = 160 * 1024;
const FORBIDDEN_PRESET_IDS = new Set(['__proto__', 'prototype', 'constructor']);

const sessionKeys = new Map();
let persistentStorageOverride;

function cleanPresetId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value) || FORBIDDEN_PRESET_IDS.has(value)) {
        throw new TypeError('模型预设 ID 必须是 1–96 位的字母、数字、下划线或连字符。');
    }
    return value;
}

function cleanKey(value) {
    if (typeof value !== 'string' || value.trim().length < 1 || value.length > 2048) {
        throw new TypeError('请输入有效的 API Key。');
    }
    return value.trim();
}

function isStorageLike(value) {
    return Boolean(value)
        && typeof value.getItem === 'function'
        && typeof value.setItem === 'function'
        && typeof value.removeItem === 'function';
}

function isPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function defaultPersistentStorage() {
    try {
        return isStorageLike(globalThis.localStorage) ? globalThis.localStorage : null;
    } catch {
        return null;
    }
}

function resolvePersistentStorage() {
    if (persistentStorageOverride !== undefined) return persistentStorageOverride;
    return defaultPersistentStorage();
}

function cacheEntries(storage) {
    const entries = new Map();
    if (!isStorageLike(storage)) return entries;
    let raw;
    try {
        raw = storage.getItem(API_KEY_CACHE_STORAGE_KEY);
    } catch {
        return entries;
    }
    if (typeof raw !== 'string' || raw.length === 0 || new TextEncoder().encode(raw).byteLength > MAX_CACHE_BYTES) return entries;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return entries;
    }
    if (!isPlainRecord(parsed) || parsed.schema !== CACHE_SCHEMA || parsed.version !== CACHE_VERSION || !isPlainRecord(parsed.keys)) {
        return entries;
    }
    for (const presetId of Object.keys(parsed.keys)) {
        if (entries.size >= MAX_CACHED_PRESETS) break;
        try {
            entries.set(cleanPresetId(presetId), cleanKey(parsed.keys[presetId]));
        } catch {
            // Ignore malformed cache entries without exposing their contents.
        }
    }
    return entries;
}

function writeCacheEntries(storage, entries) {
    if (!isStorageLike(storage) || entries.size > MAX_CACHED_PRESETS) return false;
    const keys = Object.create(null);
    for (const [presetId, apiKey] of entries) keys[presetId] = apiKey;
    const serialized = JSON.stringify({ schema: CACHE_SCHEMA, version: CACHE_VERSION, keys });
    if (new TextEncoder().encode(serialized).byteLength > MAX_CACHE_BYTES) return false;
    try {
        storage.setItem(API_KEY_CACHE_STORAGE_KEY, serialized);
        return true;
    } catch {
        return false;
    }
}

function savePersistentKey(presetId, apiKey) {
    const storage = resolvePersistentStorage();
    if (!isStorageLike(storage)) return false;
    const entries = cacheEntries(storage);
    if (!entries.has(presetId) && entries.size >= MAX_CACHED_PRESETS) return false;
    entries.set(presetId, apiKey);
    return writeCacheEntries(storage, entries);
}

function persistentKey(presetId) {
    const storage = resolvePersistentStorage();
    if (!isStorageLike(storage)) return null;
    return cacheEntries(storage).get(presetId) ?? null;
}

/**
 * Saves a browser-local storage implementation for test harnesses or a host
 * integration. `null` intentionally simulates unavailable browser storage;
 * calling `resetPersistentKeyStorage()` returns to the real browser cache.
 *
 * @param {{getItem: Function, setItem: Function, removeItem: Function} | null} storage
 */
export function configurePersistentKeyStorage(storage) {
    if (storage !== null && !isStorageLike(storage)) {
        throw new TypeError('浏览器 API Key 缓存接口不可用。');
    }
    persistentStorageOverride = storage;
    clearSessionKeys();
}

/** Restores the browser-local default cache after an injected test storage. */
export function resetPersistentKeyStorage() {
    persistentStorageOverride = undefined;
    clearSessionKeys();
}

/** @returns {boolean} whether this browser exposes a writable cache interface. */
export function isPersistentKeyStorageAvailable() {
    return isStorageLike(resolvePersistentStorage());
}

/** @param {string} presetId */
export function hasPersistentKey(presetId) {
    return Boolean(persistentKey(cleanPresetId(presetId)));
}

/** @param {string} presetId */
export function hasMemorySessionKey(presetId) {
    return sessionKeys.has(cleanPresetId(presetId));
}

/**
 * Stores one Key in memory and, when the browser allows it, in the dedicated
 * browser cache. It never returns the Key itself.
 *
 * @param {string} presetId
 * @param {string} apiKey
 * @returns {{ persisted: boolean }}
 */
export function unlockSessionKey(presetId, apiKey) {
    const id = cleanPresetId(presetId);
    const key = cleanKey(apiKey);
    sessionKeys.set(id, key);
    return Object.freeze({ persisted: savePersistentKey(id, key) });
}

/**
 * Returns whether the preset can currently make an authenticated request.
 * A persisted Key counts as available because `requireSessionKey()` restores
 * it to memory on demand after an extension reload.
 *
 * @param {string} presetId
 */
export function hasSessionKey(presetId) {
    const id = cleanPresetId(presetId);
    return sessionKeys.has(id) || Boolean(persistentKey(id));
}

/**
 * Only the same LLM boundary may request the effective Key immediately before
 * a network call. The Key is never attached to a connection preset object.
 *
 * @param {string} presetId
 * @returns {string}
 */
export function requireSessionKey(presetId) {
    const id = cleanPresetId(presetId);
    const key = sessionKeys.get(id) ?? persistentKey(id);
    if (!key) throw new SessionKeyUnavailableError();
    sessionKeys.set(id, key);
    return key;
}

/** Removes a single preset's in-memory and browser-cached Key. */
export function deletePersistentKey(presetId) {
    const id = cleanPresetId(presetId);
    sessionKeys.delete(id);
    const storage = resolvePersistentStorage();
    if (!isStorageLike(storage)) return false;
    const entries = cacheEntries(storage);
    if (!entries.delete(id)) return false;
    return writeCacheEntries(storage, entries);
}

/** Removes every browser-cached Key; kept for explicit user-initiated cleanup only. */
export function clearPersistentKeys() {
    sessionKeys.clear();
    const storage = resolvePersistentStorage();
    if (!isStorageLike(storage)) return false;
    try {
        storage.removeItem(API_KEY_CACHE_STORAGE_KEY);
        return true;
    } catch {
        return false;
    }
}

/** Clears only the short-lived memory mirror; browser cache remains intact. */
export function clearSessionKeys() {
    sessionKeys.clear();
}

export class SessionKeyUnavailableError extends Error {
    constructor() {
        super('此模型预设尚未保存可用的 API Key。请在连接预设中填写并保存到此浏览器。');
        this.name = 'SessionKeyUnavailableError';
        this.code = 'SESSION_KEY_LOCKED';
    }
}

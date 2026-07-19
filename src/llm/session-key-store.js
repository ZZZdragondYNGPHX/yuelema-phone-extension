/**
 * 会话内 API Key 保管库。
 *
 * 密钥仅保留在此 ES 模块的闭包 Map 中：不写 localStorage、IndexedDB、
 * extension settings、MVU、聊天、导出或日志。页面刷新/扩展卸载会重建模块，
 * `clearSessionKeys()` 可主动立即清除全部密钥。
 */
const sessionKeys = new Map();

function cleanPresetId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value)) {
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

/**
 * 显式将某一模型预设的 Key 解锁到当前 JavaScript 会话。
 * 不返回 Key，也不记录 Key。
 *
 * @param {string} presetId
 * @param {string} apiKey
 */
export function unlockSessionKey(presetId, apiKey) {
    sessionKeys.set(cleanPresetId(presetId), cleanKey(apiKey));
}

/** @param {string} presetId */
export function hasSessionKey(presetId) {
    return sessionKeys.has(cleanPresetId(presetId));
}

/**
 * 仅供同一安全模块在发出请求前使用。调用方不得持久化返回值。
 * @param {string} presetId
 * @returns {string}
 */
export function requireSessionKey(presetId) {
    const key = sessionKeys.get(cleanPresetId(presetId));
    if (!key) throw new SessionKeyUnavailableError();
    return key;
}

/** 立即清除所有本会话已解锁密钥。 */
export function clearSessionKeys() {
    sessionKeys.clear();
}

export class SessionKeyUnavailableError extends Error {
    constructor() {
        super('此模型预设尚未在本次会话解锁 API Key。');
        this.name = 'SessionKeyUnavailableError';
        this.code = 'SESSION_KEY_LOCKED';
    }
}

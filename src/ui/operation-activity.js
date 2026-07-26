/**
 * 安全运行控制台的内存台账（用户 2026-07-27 裁决后的双轨策略）。
 *
 * 双轨文案策略：
 * - `message`（面向功能界面的粗略提示）：仍走 assertSafeText 白名单式拒绝，
 *   不允许出现任何技术细节（错误类名、URL、状态码、UID、token、原始响应等）。
 * - `detail`（控制台专用诊断详情，可选）：允许技术细节（HTTP 状态码、错误码、
 *   校验失败字段与原因、模型输出不合规点等），但必须先经 sanitizeDiagnosticDetail
 *   黑名单脱敏后才能入账；上限 2000 字符，超限截断。
 *
 * 不可动摇的硬线（脱敏后仍必须成立）：
 * 1. API Key 及任何凭据（Bearer/token/sk-…/Authorization 值/32+ 连续 base64）
 *    绝不出现——脱敏器统一替换为 [已脱敏]，URL 剥离 query 与 userinfo。
 * 2. 隐藏资料层的字段值、关系分数值、各类阈值数值不得进入 detail。
 *    脱敏器无法识别语义数值，这条由调用方合同保证：只传字段名/路径与
 *    校验结论，绝不拼接隐藏字段值、关系分或阈值本身。
 * 3. 台账仍为纯内存态、不持久化、上限 30 条；条目只能经本地 Symbol 句柄更新。
 */
const DEFAULT_MAX_ENTRIES = 30;
const MAX_MAX_ENTRIES = 30;
const MAX_NAME_LENGTH = 32;
const MAX_MESSAGE_LENGTH = 160;
const MAX_DETAIL_LENGTH = 2000;
const MAX_VALUE_SUMMARY_LENGTH = 240;
const REDACTED_MARK = '[已脱敏]';
const DETAIL_TRUNCATION_MARK = '…（详情已截断）';

const FORBIDDEN_TEXT_PATTERNS = [
    /\b(?:uid|json\s*patch|patch|stat_data|state|request\s*(?:body|payload)|api\s*key|apikey|authorization|bearer|token|secret|password)\b/iu,
    /(?:^|[_./-])uid(?:$|[_./-])/iu,
    /\b(?:npc|chat|group|session|message|msg|meet|record)_[A-Za-z0-9_-]+\b/iu,
    /\b(?:stat[-_\s]?data|state[-_\s]?tree|request[-_\s]?(?:body|payload))\b/iu,
    /\b(?:prompt|messages|body|payload)\s*[:=]/iu,
    /(?:密钥|令牌|密码|请求正文|请求体|原始错误|状态树|内部状态|变量树|补丁路径|原始响应|模型响应)/u,
    /(?:https?|wss?):\/\//iu,
    /\b(?:typeerror|referenceerror|syntaxerror|rangeerror|evalerror|urierror|aggregateerror|error)\s*:/iu,
    /(?:^|\s)at\s+[^\s]+\s*\([^\r\n]+:\d+:\d+\)/u,
    /-----BEGIN [A-Z ]+-----/u,
    /\bsk-[A-Za-z0-9_-]{8,}\b/u,
    /\b[A-Za-z0-9+/=_-]{32,}\b/u,
];

function normalizeMaxEntries(value) {
    if (value === undefined) return DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(value) || value < 1) throw new TypeError('maxEntries must be a positive integer');
    return Math.min(value, MAX_MAX_ENTRIES);
}

function assertSafeText(value, field, maxLength) {
    if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
    const text = value.trim();
    if (!text) throw new TypeError(`${field} must not be empty`);
    if (text.length > maxLength) throw new TypeError(`${field} is too long`);
    if (/[\u0000-\u001f\u007f]/u.test(text)) throw new TypeError(`${field} contains control characters`);
    if (/[{}\[\]<>`]/u.test(text)) throw new TypeError(`${field} must not contain structured data or markup`);
    if (FORBIDDEN_TEXT_PATTERNS.some((pattern) => pattern.test(text))) {
        throw new TypeError(`${field} contains unsafe technical details`);
    }
    return text;
}

function sanitizeUrlForDetail(rawUrl) {
    try {
        const url = new URL(rawUrl);
        return `${url.origin}${url.pathname}`;
    } catch {
        return rawUrl.split(/[?#]/u, 1)[0].replace(/\/\/[^/@\s]*@/u, '//');
    }
}

/**
 * 控制台诊断详情脱敏器（黑名单替换，不是整体拒绝）。
 * 保证：Key 样式 token（sk-…、Bearer …、32+ 连续 base64 字符）、Authorization/
 * api key/token/secret/password 赋值、PEM 块一律替换为 [已脱敏]；URL 只保留
 * origin + 路径（剥离 userinfo/query/fragment）；控制字符清理（保留换行与制表）；
 * 超过 2000 字符截断并追加省略标记。非字符串或脱敏后为空时返回 null。
 */
export function sanitizeDiagnosticDetail(text) {
    if (typeof text !== 'string') return null;
    let value = text.replace(/\r\n?/gu, '\n');
    value = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
    // URL 先行：整体剥离 query/fragment/userinfo，之后的凭据规则再兜住路径里残余的 token。
    value = value.replace(/(?:https?|wss?):\/\/[^\s"'<>`\\]+/giu, (match) => sanitizeUrlForDetail(match));
    value = value.replace(/\b(authorization|proxy-authorization)\b\s*[:=]\s*[^\n]+/giu, `$1: ${REDACTED_MARK}`);
    value = value.replace(/\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|credential)\b\s*[:=]\s*[^\s]+/giu, `$1: ${REDACTED_MARK}`);
    value = value.replace(/(密钥|令牌|密码)\s*[:：=]\s*[^\s]+/gu, `$1：${REDACTED_MARK}`);
    value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, REDACTED_MARK);
    value = value.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, REDACTED_MARK);
    value = value.replace(/-----BEGIN[^\n]*-----[\s\S]*?-----END[^\n]*-----/gu, REDACTED_MARK);
    value = value.replace(/-----BEGIN[^\n]*-----/gu, REDACTED_MARK);
    // 32+ 连续 token 视作凭据抹除；纯小写多段下划线标识符（snake_case 错误码，如
    // character_registration_candidate_invalid）不具备凭据熵特征，予以放行。
    value = value.replace(/[A-Za-z0-9+/=_-]{32,}/gu, (token) => (
        /^[a-z0-9]+(?:_[a-z0-9]+){2,}$/u.test(token) ? token : REDACTED_MARK
    ));
    value = value.trim();
    if (!value) return null;
    if (value.length > MAX_DETAIL_LENGTH) value = `${value.slice(0, MAX_DETAIL_LENGTH)}${DETAIL_TRUNCATION_MARK}`;
    return value;
}

function summarizeDetailValue(value) {
    if (value === undefined || value === null) return '';
    let text;
    if (typeof value === 'string') text = value;
    else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') text = String(value);
    else {
        try { text = JSON.stringify(value); }
        catch { text = String(value); }
    }
    text = String(text ?? '').trim();
    if (!text) return '';
    if (text.length > MAX_VALUE_SUMMARY_LENGTH) text = `${text.slice(0, MAX_VALUE_SUMMARY_LENGTH)}…`;
    return text;
}

/**
 * 诊断详情便捷格式化器：接受 Error / 字符串 / 普通对象，配合可选 context
 * `{ operation, stage, code, httpStatus, field, expected, actual, hint }`
 * 逐行拼接结构化文本，并自动经 sanitizeDiagnosticDetail 脱敏。
 * 没有任何可用信息时返回 null。
 */
export function buildErrorDetail(error, context = {}) {
    const lines = [];
    const push = (label, value) => {
        const text = summarizeDetailValue(value);
        if (text) lines.push(`${label}: ${text}`);
    };
    const extras = context && typeof context === 'object' ? context : {};
    push('操作', extras.operation);
    push('阶段', extras.stage);
    if (typeof error === 'string') {
        push('错误信息', error);
    } else if (error instanceof Error) {
        push('错误类型', error.name);
        push('错误信息', error.message);
        push('错误码', error.code);
        push('HTTP 状态', error.status ?? error.statusCode ?? error.httpStatus);
        if (error.cause !== undefined && error.cause !== null) {
            const cause = error.cause;
            push('起因', cause instanceof Error ? `${cause.name}: ${cause.message}` : cause);
        }
    } else if (error && typeof error === 'object') {
        push('错误类型', error.name);
        push('错误信息', error.message ?? error.reason ?? error.detail);
        push('错误码', error.code);
        push('HTTP 状态', error.status ?? error.statusCode ?? error.httpStatus);
    }
    push('错误码', extras.code);
    push('HTTP 状态', extras.httpStatus);
    push('字段', extras.field);
    push('期望', extras.expected);
    push('实际', extras.actual);
    push('提示', extras.hint);
    if (!lines.length) return null;
    return sanitizeDiagnosticDetail(lines.join('\n'));
}

/** detail 入账唯一通道：任何形态的详情都必须先转字符串、再经脱敏器。 */
function normalizeDetail(value) {
    if (value === undefined || value === null) return null;
    return sanitizeDiagnosticDetail(typeof value === 'string' ? value : String(value));
}

function safeTimestamp(now) {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError('now must return a valid date or timestamp');
    return date.toISOString();
}

function publicEntry(entry) {
    return Object.freeze({
        name: entry.name,
        message: entry.message,
        detail: entry.detail ?? null,
        status: entry.status,
        startedAt: entry.startedAt,
        updatedAt: entry.updatedAt,
    });
}

function publicSnapshot(entries) {
    const visibleEntries = Object.freeze(entries.map(publicEntry));
    return Object.freeze({
        current: Object.freeze(visibleEntries.filter((entry) => entry.status === 'running')),
        entries: visibleEntries,
    });
}

/**
 * Creates an in-memory activity feed for safe, user-facing operation progress.
 * Nothing is persisted and callers can update an item only through its local Symbol handle.
 * `start/succeed/fail/dismiss` 均接受可选第三参 `{ detail }`：提供 detail 键即替换
 * （null 表示清空），省略则保留既有 detail；旧的二参调用完全兼容。
 */
export function createOperationActivity({ maxEntries, now = Date.now } = {}) {
    const limit = normalizeMaxEntries(maxEntries);
    if (typeof now !== 'function') throw new TypeError('now must be a function');

    const entries = [];
    const entriesByHandle = new Map();
    const subscribers = new Set();

    const snapshot = () => publicSnapshot(entries);

    const notify = () => {
        if (subscribers.size === 0) return;
        const nextSnapshot = snapshot();
        for (const listener of subscribers) {
            try {
                listener(nextSnapshot);
            } catch {
                // A console view must not be able to break operation processing.
            }
        }
    };

    const trim = () => {
        while (entries.length > limit) {
            const removed = entries.pop();
            entriesByHandle.delete(removed.handle);
        }
    };

    const update = (handle, status, message, options) => {
        if (typeof handle !== 'symbol') return false;
        const entry = entriesByHandle.get(handle);
        if (!entry || entry.status !== 'running') return false;

        entry.message = assertSafeText(message, 'message', MAX_MESSAGE_LENGTH);
        if (options && typeof options === 'object' && Object.hasOwn(options, 'detail')) {
            entry.detail = normalizeDetail(options.detail);
        }
        entry.status = status;
        entry.updatedAt = safeTimestamp(now);
        entriesByHandle.delete(handle);
        notify();
        return true;
    };

    return Object.freeze({
        start(name, message, options) {
            const handle = Symbol('operation-activity');
            const timestamp = safeTimestamp(now);
            const entry = {
                handle,
                name: assertSafeText(name, 'name', MAX_NAME_LENGTH),
                message: assertSafeText(message, 'message', MAX_MESSAGE_LENGTH),
                detail: options && typeof options === 'object' ? normalizeDetail(options.detail) : null,
                status: 'running',
                startedAt: timestamp,
                updatedAt: timestamp,
            };
            entries.unshift(entry);
            entriesByHandle.set(handle, entry);
            trim();
            notify();
            return handle;
        },

        succeed(handle, message, options) {
            return update(handle, 'success', message, options);
        },

        fail(handle, message, options) {
            return update(handle, 'failure', message, options);
        },

        dismiss(handle, message, options) {
            return update(handle, 'dismissed', message, options);
        },

        clear() {
            if (entries.length === 0) return false;
            entries.length = 0;
            entriesByHandle.clear();
            notify();
            return true;
        },

        subscribe(listener, { emitCurrent = true } = {}) {
            if (typeof listener !== 'function') throw new TypeError('listener must be a function');
            subscribers.add(listener);
            if (emitCurrent) listener(snapshot());
            return () => subscribers.delete(listener);
        },

        snapshot,
    });
}

export const OPERATION_ACTIVITY_MAX_ENTRIES = MAX_MAX_ENTRIES;
export const OPERATION_ACTIVITY_MAX_DETAIL_LENGTH = MAX_DETAIL_LENGTH;

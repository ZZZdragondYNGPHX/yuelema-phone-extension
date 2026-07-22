const DEFAULT_MAX_ENTRIES = 30;
const MAX_MAX_ENTRIES = 30;
const MAX_NAME_LENGTH = 32;
const MAX_MESSAGE_LENGTH = 160;

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

    const update = (handle, status, message) => {
        if (typeof handle !== 'symbol') return false;
        const entry = entriesByHandle.get(handle);
        if (!entry || entry.status !== 'running') return false;

        entry.message = assertSafeText(message, 'message', MAX_MESSAGE_LENGTH);
        entry.status = status;
        entry.updatedAt = safeTimestamp(now);
        entriesByHandle.delete(handle);
        notify();
        return true;
    };

    return Object.freeze({
        start(name, message) {
            const handle = Symbol('operation-activity');
            const timestamp = safeTimestamp(now);
            const entry = {
                handle,
                name: assertSafeText(name, 'name', MAX_NAME_LENGTH),
                message: assertSafeText(message, 'message', MAX_MESSAGE_LENGTH),
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

        succeed(handle, message) {
            return update(handle, 'success', message);
        },

        fail(handle, message) {
            return update(handle, 'failure', message);
        },

        dismiss(handle, message) {
            return update(handle, 'dismissed', message);
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



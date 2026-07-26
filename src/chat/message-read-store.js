/**
 * 消息本地已读水位 / 置顶 / 一次性提示存储（策划书 §7.1.2、§7.1.3，裁决 D6）。
 *
 * 纯 UI 状态：只进当前浏览器的 localStorage，绝不进入 MVU、提示词、导出、
 * 网络请求或诊断日志。storage 不可用（隐私模式、配额、抛错）时自动降级为
 * 本实例内存，所有 API 行为保持一致，只是不再跨会话持久。
 *
 * 存储的内容只有：会话 UID → { 已读条数, 置顶, 隐私提示已读 } 与一个全局
 * “输入区提示已展示” 标记。不保存任何消息内容、昵称或资料字段。
 */

export const MESSAGE_READ_STORAGE_KEY = 'yuelema.message-read-state/v1';
const MESSAGE_READ_SCHEMA = 'yuelema.message-read-state';
const MAX_TRACKED_SESSIONS = 200;
const SESSION_UID_PATTERN = /^chat_[a-z0-9][a-z0-9_-]{0,63}$/i;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function defaultStorage() {
    try {
        const storage = globalThis.localStorage;
        return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' ? storage : null;
    } catch {
        return null;
    }
}

function validSessionUid(sessionUid) {
    return typeof sessionUid === 'string' && SESSION_UID_PATTERN.test(sessionUid) && !UNSAFE_KEYS.has(sessionUid);
}

function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const read = Number.isFinite(raw.read) && raw.read > 0 ? Math.min(Math.floor(raw.read), 100000) : 0;
    const at = Number.isFinite(raw.at) && raw.at > 0 ? Math.floor(raw.at) : 0;
    return { read, pinned: raw.pinned === true, introSeen: raw.introSeen === true, at };
}

function emptyState() {
    return { composerHintSeen: false, sessions: Object.create(null) };
}

function normalizeState(raw) {
    const state = emptyState();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;
    state.composerHintSeen = raw.composerHintSeen === true;
    const sessions = raw.sessions;
    if (sessions && typeof sessions === 'object' && !Array.isArray(sessions)) {
        for (const key of Object.keys(sessions)) {
            if (!validSessionUid(key)) continue;
            const entry = normalizeEntry(sessions[key]);
            if (entry) state.sessions[key] = entry;
        }
    }
    return state;
}

/**
 * @param {{ storage?: Storage|null, now?: () => number }} [options]
 *   storage 缺省取 globalThis.localStorage（try/catch 包裹）；测试可注入假实现。
 */
export function createMessageReadStore({ storage = defaultStorage(), now = () => Date.now() } = {}) {
    // storage 读写失败后的兜底：本实例内存里的最后已知状态。
    let memoryState = emptyState();

    function load() {
        if (!storage) return memoryState;
        try {
            const raw = storage.getItem(MESSAGE_READ_STORAGE_KEY);
            if (typeof raw !== 'string' || !raw) return memoryState;
            if (raw.length > 512 * 1024) return memoryState;
            const parsed = JSON.parse(raw);
            if (parsed?.schema !== MESSAGE_READ_SCHEMA) return memoryState;
            memoryState = normalizeState(parsed);
            return memoryState;
        } catch {
            return memoryState;
        }
    }

    function persist(state) {
        memoryState = state;
        if (!storage) return false;
        try {
            const uids = Object.keys(state.sessions);
            if (uids.length > MAX_TRACKED_SESSIONS) {
                // 只保留最近触碰的会话，防止本地状态无界增长。
                uids.sort((left, right) => (state.sessions[right].at ?? 0) - (state.sessions[left].at ?? 0));
                const trimmed = Object.create(null);
                for (const uid of uids.slice(0, MAX_TRACKED_SESSIONS)) trimmed[uid] = state.sessions[uid];
                state.sessions = trimmed;
            }
            storage.setItem(MESSAGE_READ_STORAGE_KEY, JSON.stringify({
                schema: MESSAGE_READ_SCHEMA,
                version: 1,
                composerHintSeen: state.composerHintSeen,
                sessions: state.sessions,
            }));
            return true;
        } catch {
            return false;
        }
    }

    function entryFor(state, sessionUid) {
        return state.sessions[sessionUid] ?? null;
    }

    function updateEntry(sessionUid, updater) {
        if (!validSessionUid(sessionUid)) return false;
        const state = load();
        const current = entryFor(state, sessionUid) ?? { read: 0, pinned: false, introSeen: false, at: 0 };
        const next = updater({ ...current });
        if (!next) return false;
        next.at = Math.floor(now()) || 0;
        state.sessions[sessionUid] = next;
        persist(state);
        return true;
    }

    return Object.freeze({
        /** 未读条数 = 会话可见消息总数 - 已读水位；未跟踪过的会话全部计为未读。 */
        unreadCount(sessionUid, totalCount) {
            if (!validSessionUid(sessionUid)) return 0;
            const total = Number.isFinite(totalCount) && totalCount > 0 ? Math.floor(totalCount) : 0;
            if (!total) return 0;
            const entry = entryFor(load(), sessionUid);
            return Math.max(0, total - (entry?.read ?? 0));
        },
        /** 把已读水位推进到当前可见消息总数（只前进，不回退）。 */
        markRead(sessionUid, totalCount) {
            const total = Number.isFinite(totalCount) && totalCount > 0 ? Math.floor(totalCount) : 0;
            return updateEntry(sessionUid, (entry) => {
                entry.read = Math.max(entry.read, total);
                return entry;
            });
        },
        isPinned(sessionUid) {
            if (!validSessionUid(sessionUid)) return false;
            return entryFor(load(), sessionUid)?.pinned === true;
        },
        setPinned(sessionUid, pinned) {
            return updateEntry(sessionUid, (entry) => {
                entry.pinned = pinned === true;
                return entry;
            });
        },
        hasSeenIntro(sessionUid) {
            if (!validSessionUid(sessionUid)) return false;
            return entryFor(load(), sessionUid)?.introSeen === true;
        },
        markIntroSeen(sessionUid) {
            return updateEntry(sessionUid, (entry) => {
                entry.introSeen = true;
                return entry;
            });
        },
        hasSeenComposerHint() {
            return load().composerHintSeen === true;
        },
        markComposerHintSeen() {
            const state = load();
            if (state.composerHintSeen === true) return true;
            state.composerHintSeen = true;
            return persist(state) || true;
        },
        /** 会话被清空 / 角色被删除后，忘掉对应的本地状态。 */
        forgetSession(sessionUid) {
            if (!validSessionUid(sessionUid)) return false;
            const state = load();
            if (!entryFor(state, sessionUid)) return false;
            delete state.sessions[sessionUid];
            persist(state);
            return true;
        },
    });
}

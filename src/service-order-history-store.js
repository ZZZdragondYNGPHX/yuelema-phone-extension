const STORAGE_PREFIX = 'yuelema.service-order-history/v1';
const STORAGE_VERSION = 3;
const MAX_RECORDS = 80;
const SAFE_ID = /^[A-Za-z0-9_:-]{1,160}$/u;
const SERVICE_ORDER_ID = /^service_[A-Za-z0-9_-]{1,64}$/u;
const SERVICE_ROLE_ID = /^npc_service_\d{1,64}$/u;
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const TERMINAL_STATUSES = new Set(['已完成', '已取消', '已中止']);
const ARCHIVE_PHASES = new Set(['staged_before_transition', 'terminal_confirmed', 'finalized']);
const SAFE_TEXT = (value, max = 600) => typeof value === 'string'
    ? value.trim().replace(/[\u0000-\u001F]/gu, ' ').slice(0, max)
    : '';

function ownRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeProfile(profile) {
    const source = ownRecord(profile) ? profile : {};
    const tags = Array.isArray(source.兴趣标签)
        ? source.兴趣标签.map((item) => SAFE_TEXT(item, 40)).filter(Boolean).slice(0, 6)
        : [];
    return Object.freeze({
        昵称: SAFE_TEXT(source.昵称, 80) || '已归档服务者',
        年龄段: SAFE_TEXT(source.年龄段, 80) || '明确成年人',
        简介: SAFE_TEXT(source.简介, 360),
        兴趣标签: Object.freeze(tags),
    });
}

function isSafeId(value) {
    return typeof value === 'string' && SAFE_ID.test(value) && !RESERVED_IDS.has(value);
}

function safeScope(value) {
    return isSafeId(value) ? value : 'default';
}

function storageKey(scope) {
    return `${STORAGE_PREFIX}:${safeScope(scope)}`;
}

function normalizeParticipants(value) {
    const roleUids = Array.isArray(value?.roleUids) ? value.roleUids : [value?.roleUid];
    const profiles = Array.isArray(value?.profiles) ? value.profiles : [value?.profile];
    if (
        !roleUids.length
        || roleUids.length > 3
        || roleUids.length !== profiles.length
        || new Set(roleUids).size !== roleUids.length
        || !roleUids.every((uid) => typeof uid === 'string' && SERVICE_ROLE_ID.test(uid))
    ) return null;
    return Object.freeze({
        roleUids: Object.freeze([...roleUids]),
        profiles: Object.freeze(profiles.map(safeProfile)),
    });
}

function archivePhaseFor(value, sourceVersion) {
    if (sourceVersion === STORAGE_VERSION) return ARCHIVE_PHASES.has(value.archivePhase) ? value.archivePhase : null;
    // v1/v2 could not distinguish a pre-transition stage from a confirmed terminal.
    // Migrate pending records to the safest phase so they can never be finalized by absence alone.
    if (value.archiveState === 'pending_archive') return 'staged_before_transition';
    if (value.archiveState === 'archived') return 'finalized';
    return null;
}

function archiveStateFor(archivePhase) {
    return archivePhase === 'finalized' ? 'archived' : 'pending_archive';
}

function normalizeRecord(value, sourceVersion = STORAGE_VERSION) {
    if (!ownRecord(value) || !isSafeId(value.localId) || !SERVICE_ORDER_ID.test(value.orderUid)) return null;
    const participants = normalizeParticipants(value);
    const archivePhase = archivePhaseFor(value, sourceVersion);
    if (!participants || !TERMINAL_STATUSES.has(value.status) || !archivePhase || !['SFW', 'NSFW'].includes(value.mode)) return null;
    return Object.freeze({
        localId: value.localId,
        orderUid: value.orderUid,
        roleUid: participants.roleUids[0],
        roleUids: participants.roleUids,
        status: value.status,
        archivePhase,
        archiveState: archiveStateFor(archivePhase),
        mode: value.mode,
        categoryId: SAFE_TEXT(value.categoryId, 64),
        category: SAFE_TEXT(value.category, 80),
        topic: SAFE_TEXT(value.topic, 240),
        initiatedAt: SAFE_TEXT(value.initiatedAt, 160),
        startedAt: SAFE_TEXT(value.startedAt, 160),
        endedAt: SAFE_TEXT(value.endedAt, 160),
        summary: SAFE_TEXT(value.summary, 600),
        profile: participants.profiles[0],
        profiles: participants.profiles,
        createdAt: SAFE_TEXT(value.createdAt, 40),
        updatedAt: SAFE_TEXT(value.updatedAt, 40),
    });
}

function read(storage, scope) {
    try {
        if (!storage || typeof storage.getItem !== 'function') return { ok: false, records: [] };
        const raw = storage.getItem(storageKey(scope));
        if (raw === null) return { ok: true, records: [] };
        if (typeof raw !== 'string' || !raw) return { ok: false, records: [] };
        const parsed = JSON.parse(raw);
        if (!ownRecord(parsed) || ![1, 2, STORAGE_VERSION].includes(parsed.version) || !Array.isArray(parsed.records)) {
            return { ok: false, records: [] };
        }
        const records = [];
        const seen = new Set();
        for (const value of parsed.records) {
            const record = normalizeRecord(value, parsed.version);
            if (!record) return { ok: false, records: [] };
            if (seen.has(record.localId)) continue;
            seen.add(record.localId);
            records.push(record);
            if (records.length >= MAX_RECORDS) break;
        }
        return { ok: true, records };
    } catch {
        return { ok: false, records: [] };
    }
}

function write(storage, scope, records) {
    try {
        if (!storage || typeof storage.setItem !== 'function' || typeof storage.getItem !== 'function') return false;
        const key = storageKey(scope);
        const serialized = JSON.stringify({ version: STORAGE_VERSION, records: records.slice(0, MAX_RECORDS) });
        storage.setItem(key, serialized);
        return storage.getItem(key) === serialized;
    } catch {
        return false;
    }
}

function fixedTerminalCopy(mode, status) {
    const sfw = mode === 'SFW';
    if (status === '已完成') return Object.freeze({
        endedAt: '正文结束条件已确认',
        summary: sfw
            ? '本次心动租约已完成；本地记录不保留具体行程与协商内容。'
            : '本次夜色邀约已结束；本地记录不保留具体过程、边界与安排。',
    });
    if (status === '已中止') return Object.freeze({
        endedAt: '本次邀约已中止',
        summary: sfw
            ? '本次心动租约已中止；本地记录不保留具体过程与协商内容。'
            : '本次夜色邀约已中止；本地记录不保留具体过程、边界与安排。',
    });
    return Object.freeze({
        endedAt: '玩家已取消',
        summary: sfw
            ? '本次心动租约已在开始前取消；本地记录不保留具体安排。'
            : '本次夜色邀约已在开始前取消；本地记录不保留具体边界与安排。',
    });
}

function publicProjection(record) {
    const { localId, orderUid, roleUid, roleUids, ...visible } = record;
    return Object.freeze(visible);
}

/**
 * Browser-local minimal history. It excludes contracts, service information,
 * raw model output, hidden profiles and credentials. Internal UIDs are exposed
 * only when includeInternal is explicitly requested by trusted extension code.
 */
export function createServiceOrderHistoryStore({ storage, getScope = () => 'default', now = () => new Date().toISOString() } = {}) {
    let activeStorage = storage;
    if (activeStorage === undefined) {
        try { activeStorage = globalThis.localStorage; } catch { activeStorage = null; }
    }

    function scope() {
        try { return safeScope(getScope()); } catch { return null; }
    }

    function currentRecords() {
        const currentScope = scope();
        if (currentScope === null) return { ok: false, scope: null, records: [] };
        return { ...read(activeStorage, currentScope), scope: currentScope };
    }

    function timestamp() {
        try { return SAFE_TEXT(now(), 40) || null; } catch { return null; }
    }

    function list({ includeInternal = false } = {}) {
        const current = currentRecords();
        if (!current.ok) return Object.freeze([]);
        return Object.freeze(current.records
            .map((record) => includeInternal ? record : publicProjection(record))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    }

    function stage(order, { status } = {}) {
        const participants = normalizeParticipants(order);
        if (
            !ownRecord(order)
            || !participants
            || !SERVICE_ORDER_ID.test(order.id)
            || !['SFW', 'NSFW'].includes(order.mode)
            || !TERMINAL_STATUSES.has(status)
        ) return null;
        const current = currentRecords();
        if (!current.ok) return null;
        const localId = `history_${order.id}`;
        const existing = current.records.find((item) => item.localId === localId);
        if (existing) {
            const sameParticipants = existing.roleUids.length === participants.roleUids.length
                && existing.roleUids.every((uid, index) => uid === participants.roleUids[index]);
            return existing.orderUid === order.id && existing.mode === order.mode && existing.status === status && sameParticipants
                ? existing
                : null;
        }
        const at = timestamp();
        if (!at) return null;
        const terminalCopy = fixedTerminalCopy(order.mode, status);
        const record = normalizeRecord({
            localId,
            orderUid: order.id,
            roleUid: participants.roleUids[0],
            roleUids: participants.roleUids,
            status,
            archivePhase: 'staged_before_transition',
            mode: order.mode,
            categoryId: order.categoryId,
            category: order.category,
            topic: order.topic,
            initiatedAt: order.initiatedAt,
            startedAt: order.startedAt,
            endedAt: terminalCopy.endedAt,
            summary: terminalCopy.summary,
            profile: participants.profiles[0],
            profiles: participants.profiles,
            createdAt: at,
            updatedAt: at,
        });
        if (!record) return null;
        const next = [record, ...current.records];
        return write(activeStorage, current.scope, next) ? record : null;
    }

    function transitionPhase(localId, from, to) {
        if (!isSafeId(localId)) return false;
        const current = currentRecords();
        if (!current.ok) return false;
        const index = current.records.findIndex((record) => record.localId === localId);
        if (index < 0) return false;
        const existing = current.records[index];
        if (existing.archivePhase === to || (to === 'terminal_confirmed' && existing.archivePhase === 'finalized')) return true;
        if (existing.archivePhase !== from) return false;
        const at = timestamp();
        if (!at) return false;
        const replacement = normalizeRecord({ ...existing, archivePhase: to, updatedAt: at });
        if (!replacement) return false;
        const next = [...current.records];
        next[index] = replacement;
        return write(activeStorage, current.scope, next);
    }

    function markTerminalConfirmed(localId) {
        return transitionPhase(localId, 'staged_before_transition', 'terminal_confirmed');
    }

    // Compatibility name retained for service.js. It is intentionally strict:
    // callers must markTerminalConfirmed after observing a successful MVU transition.
    function markArchived(localId) {
        return transitionPhase(localId, 'terminal_confirmed', 'finalized');
    }

    function finalize(localId) {
        return markArchived(localId);
    }

    function discardStage(localId) {
        if (!isSafeId(localId)) return false;
        const current = currentRecords();
        if (!current.ok) return false;
        const existing = current.records.find((record) => record.localId === localId);
        if (!existing || existing.archivePhase !== 'staged_before_transition') return false;
        return write(activeStorage, current.scope, current.records.filter((record) => record.localId !== localId));
    }

    function remove(localId) {
        if (!isSafeId(localId)) return false;
        const current = currentRecords();
        if (!current.ok || !current.records.some((record) => record.localId === localId)) return false;
        return write(activeStorage, current.scope, current.records.filter((record) => record.localId !== localId));
    }

    return Object.freeze({ list, stage, markTerminalConfirmed, markArchived, finalize, discardStage, remove });
}

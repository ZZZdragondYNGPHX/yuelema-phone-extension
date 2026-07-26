const STORAGE_PREFIX = 'yuelema.service-order-history/v1';
const MAX_RECORDS = 80;
const SAFE_ID = /^[A-Za-z0-9_:-]{1,160}$/u;
const SERVICE_ORDER_ID = /^service_[A-Za-z0-9_-]{1,64}$/u;
const SERVICE_ROLE_ID = /^npc_service_\d{1,64}$/u;
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const SAFE_TEXT = (value, max = 600) => typeof value === 'string' ? value.trim().replace(/[\u0000-\u001F]/gu, ' ').slice(0, max) : '';
function ownRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function safeProfile(profile) { const source = ownRecord(profile) ? profile : {}; return Object.freeze({ 昵称: SAFE_TEXT(source.昵称, 80) || '已归档服务者', 年龄段: SAFE_TEXT(source.年龄段, 80) || '明确成年人', 简介: SAFE_TEXT(source.简介, 360), 兴趣标签: Array.isArray(source.兴趣标签) ? source.兴趣标签.map((item) => SAFE_TEXT(item, 40)).filter(Boolean).slice(0, 6) : [] }); }
function isSafeId(value) { return typeof value === 'string' && SAFE_ID.test(value) && !RESERVED_IDS.has(value); }
function safeScope(value) { return isSafeId(value) ? value : 'default'; }
function storageKey(scope) { return STORAGE_PREFIX + ':' + safeScope(scope); }
function normalizeParticipants(value) {
    const roleUids = Array.isArray(value?.roleUids) ? value.roleUids : [value?.roleUid];
    const profiles = Array.isArray(value?.profiles) ? value.profiles : [value?.profile];
    if (!roleUids.length || roleUids.length > 3 || roleUids.length !== profiles.length || new Set(roleUids).size !== roleUids.length || !roleUids.every((uid) => typeof uid === 'string' && SERVICE_ROLE_ID.test(uid))) return null;
    return Object.freeze({ roleUids: Object.freeze([...roleUids]), profiles: Object.freeze(profiles.map(safeProfile)) });
}
function normalizeRecord(value) {
    if (!ownRecord(value) || !isSafeId(value.localId) || !SERVICE_ORDER_ID.test(value.orderUid)) return null;
    const participants = normalizeParticipants(value); if (!participants || !['已完成', '已取消'].includes(value.status) || !['pending_archive', 'archived'].includes(value.archiveState) || !['SFW', 'NSFW'].includes(value.mode)) return null;
    return Object.freeze({ localId: value.localId, orderUid: value.orderUid, roleUid: participants.roleUids[0], roleUids: participants.roleUids, status: value.status, archiveState: value.archiveState, mode: value.mode, categoryId: SAFE_TEXT(value.categoryId, 64), category: SAFE_TEXT(value.category, 80), topic: SAFE_TEXT(value.topic, 240), initiatedAt: SAFE_TEXT(value.initiatedAt, 160), startedAt: SAFE_TEXT(value.startedAt, 160), endedAt: SAFE_TEXT(value.endedAt, 160), summary: SAFE_TEXT(value.summary, 600), profile: participants.profiles[0], profiles: participants.profiles, createdAt: SAFE_TEXT(value.createdAt, 40), updatedAt: SAFE_TEXT(value.updatedAt, 40) });
}
function read(storage, scope) { try { const raw = storage?.getItem?.(storageKey(scope)); const parsed = raw ? JSON.parse(raw) : null; return Array.isArray(parsed?.records) ? parsed.records.map(normalizeRecord).filter(Boolean).slice(0, MAX_RECORDS) : []; } catch { return []; } }
function write(storage, scope, records) { try { storage?.setItem?.(storageKey(scope), JSON.stringify({ version: 2, records: records.slice(0, MAX_RECORDS) })); return true; } catch { return false; } }
/** Browser-local minimal history. It excludes boundaries, raw model output, hidden profiles and credentials. */
export function createServiceOrderHistoryStore({ storage = globalThis.localStorage, getScope = () => 'default', now = () => new Date().toISOString() } = {}) {
    function scope() { return safeScope(getScope()); }
    function list({ includeInternal = false } = {}) { const records = read(storage, scope()); return Object.freeze(records.map((record) => includeInternal ? record : Object.freeze({ ...record, localId: undefined, orderUid: undefined, roleUid: undefined, roleUids: undefined })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); }
    function stage(order, { status, summary = '' } = {}) {
        const participants = normalizeParticipants(order); if (!ownRecord(order) || !participants || !SERVICE_ORDER_ID.test(order.id) || !['SFW', 'NSFW'].includes(order.mode) || !['已完成', '已取消'].includes(status)) return null;
        const current = read(storage, scope()); const at = now(); const record = normalizeRecord({ localId: 'history_' + order.id, orderUid: order.id, roleUid: participants.roleUids[0], roleUids: participants.roleUids, status, archiveState: 'pending_archive', mode: order.mode, categoryId: order.categoryId, category: order.category, topic: order.topic, initiatedAt: order.initiatedAt, startedAt: order.startedAt, endedAt: status === '已完成' ? '正文结束条件已确认' : '玩家已取消', summary: summary || (status === '已完成' ? '正文结束已确认；本地历史未保留详细过程。' : '玩家在正文开始前取消了本次服务。'), profile: participants.profiles[0], profiles: participants.profiles, createdAt: at, updatedAt: at });
        if (!record) return null; const next = [record, ...current.filter((item) => item.localId !== record.localId)]; return write(storage, scope(), next) ? record : null;
    }
    function markArchived(localId) { const current = read(storage, scope()); const at = now(); const next = current.map((record) => record.localId === localId ? normalizeRecord({ ...record, archiveState: 'archived', updatedAt: at }) : record); return write(storage, scope(), next); }
    function remove(localId) { const current = read(storage, scope()); return write(storage, scope(), current.filter((record) => record.localId !== localId)); }
    return Object.freeze({ list, stage, markArchived, remove });
}

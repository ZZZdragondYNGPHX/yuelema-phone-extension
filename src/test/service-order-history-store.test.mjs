import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceOrderHistoryStore } from '../service-order-history-store.js';

const STORAGE_KEY = 'yuelema.service-order-history/v1:chat_a';

function memoryStorage() {
    const values = new Map();
    return {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, String(value)); },
        dump() { return [...values.entries()]; },
    };
}

function terminalOrder(overrides = {}) {
    return {
        id: 'service_1',
        roleUid: 'npc_service_1',
        mode: 'NSFW',
        categoryId: 'explicit_chat',
        category: '夜色话题',
        topic: '夜色话题：与林澈的文字协商',
        initiatedAt: '待正文确认',
        startedAt: '玩家已确认邀约',
        endedAt: '',
        summary: '模型生成的结束详情不得保存',
        profile: {
            昵称: '林澈', 年龄段: '25-29', 简介: '仅公开资料。', 兴趣标签: ['角色扮演'],
            隐藏资料: { 实际年龄: 27, 私人备注: 'PROFILE_SECRET' },
        },
        已确认边界: '{"主题":"CONTRACT_SECRET"}',
        服务信息: { 精确地址: 'SERVICE_INFO_SECRET' },
        rawModelOutput: 'RAW_MODEL_SECRET',
        ...overrides,
    };
}

function createStore(storage, overrides = {}) {
    return createServiceOrderHistoryStore({
        storage,
        getScope: () => 'chat_a',
        now: () => '2026-08-15T12:00:00.000Z',
        ...overrides,
    });
}

test('conversion failure cannot turn a pre-transition stage into a completed archive', () => {
    const storage = memoryStorage();
    const store = createStore(storage);
    const staged = store.stage(terminalOrder(), { status: '已完成', summary: 'CALLER_SUMMARY_SECRET' });
    assert.equal(staged?.archivePhase, 'staged_before_transition');
    assert.equal(staged?.archiveState, 'pending_archive');
    assert.equal(store.markArchived(staged.localId), false, 'markArchived must reject a stage whose MVU transition was not confirmed');
    assert.equal(store.list({ includeInternal: true })[0].archivePhase, 'staged_before_transition');
    assert.equal(store.discardStage(staged.localId), true, 'failed conversion can explicitly discard its local stage');
    assert.deepEqual(store.list({ includeInternal: true }), []);
});

test('terminal confirmation survives refresh and finalization is ordered and idempotent', () => {
    const storage = memoryStorage();
    const first = createStore(storage);
    const staged = first.stage(terminalOrder(), { status: '已完成' });
    assert.equal(first.markTerminalConfirmed(staged.localId), true);
    assert.equal(first.markTerminalConfirmed(staged.localId), true, 'repeated confirmation is idempotent');

    const refreshed = createStore(storage, { now: () => '2026-08-15T12:01:00.000Z' });
    const pending = refreshed.list({ includeInternal: true })[0];
    assert.equal(pending.archivePhase, 'terminal_confirmed');
    assert.equal(pending.archiveState, 'pending_archive');
    assert.equal(refreshed.markArchived(pending.localId), true);
    assert.equal(refreshed.finalize(pending.localId), true, 'finalize alias is idempotent after completion');

    const finalized = createStore(storage).list({ includeInternal: true })[0];
    assert.equal(finalized.archivePhase, 'finalized');
    assert.equal(finalized.archiveState, 'archived');
    assert.equal(refreshed.discardStage(finalized.localId), false, 'a confirmed/finalized record cannot be discarded as a failed stage');
});

test('duplicate stage calls do not duplicate or regress a record', () => {
    const storage = memoryStorage();
    const store = createStore(storage);
    const first = store.stage(terminalOrder(), { status: '已取消' });
    const duplicate = store.stage(terminalOrder(), { status: '已取消' });
    assert.deepEqual(duplicate, first, 'an identical retry returns the same normalized record without creating another row');
    assert.equal(store.list({ includeInternal: true }).length, 1);
    assert.equal(store.markTerminalConfirmed(first.localId), true);
    assert.equal(store.markArchived(first.localId), true);
    assert.equal(store.stage(terminalOrder(), { status: '已取消' })?.archivePhase, 'finalized');
    assert.equal(store.stage(terminalOrder(), { status: '已完成' }), null, 'same order UID cannot be restaged with a conflicting terminal state');
    assert.equal(store.list({ includeInternal: true }).length, 1);
});

test('new terminal records use mode-specific fixed summaries, including 已中止', () => {
    const storage = memoryStorage();
    const store = createStore(storage);
    const aborted = store.stage(terminalOrder({ id: 'service_2', roleUid: 'npc_service_2' }), {
        status: '已中止',
        summary: 'CALLER_SUMMARY_SECRET',
    });
    assert.equal(aborted?.status, '已中止');
    assert.equal(aborted?.endedAt, '本次邀约已中止');
    assert.equal(aborted?.summary, '本次夜色邀约已中止；本地记录不保留具体过程、边界与安排。');

    const cancelled = store.stage(terminalOrder({ id: 'service_3', roleUid: 'npc_service_3', mode: 'SFW' }), { status: '已取消' });
    assert.equal(cancelled?.summary, '本次心动租约已在开始前取消；本地记录不保留具体安排。');
    assert.doesNotMatch(storage.dump().map(([, value]) => value).join('\n'), /CALLER_SUMMARY_SECRET/u);
});

test('public projection hides all internal UIDs and storage keeps only ordered public participant profiles', () => {
    const storage = memoryStorage();
    const store = createStore(storage);
    const staged = store.stage(terminalOrder({
        roleUids: ['npc_service_1', 'npc_service_2', 'npc_service_3'],
        profiles: [
            { 昵称: '林澈', 年龄段: '25-29', 简介: '公开 A', 兴趣标签: ['电影'], 隐藏资料: { 实际年龄: 28 } },
            { 昵称: '顾晴', 年龄段: '30-34', 简介: '公开 B', 兴趣标签: ['展览'], secret: 'PROFILE_SECRET_B' },
            { 昵称: '周岚', 年龄段: '25-29', 简介: '公开 C', 兴趣标签: ['散步'], apiKey: 'sk-never-store' },
        ],
    }), { status: '已完成' });
    assert.deepEqual(staged?.roleUids, ['npc_service_1', 'npc_service_2', 'npc_service_3']);
    assert.deepEqual(store.list({ includeInternal: true })[0].profiles.map((profile) => profile.昵称), ['林澈', '顾晴', '周岚']);

    const visible = store.list()[0];
    for (const key of ['localId', 'orderUid', 'roleUid', 'roleUids']) assert.equal(Object.hasOwn(visible, key), false);
    assert.doesNotMatch(JSON.stringify(visible), /(?:history|npc|service)_/u);
    assert.deepEqual(visible.profiles.map((profile) => Object.keys(profile).sort()), [
        ['兴趣标签', '年龄段', '昵称', '简介'].sort(),
        ['兴趣标签', '年龄段', '昵称', '简介'].sort(),
        ['兴趣标签', '年龄段', '昵称', '简介'].sort(),
    ]);

    const serialized = storage.dump().map(([, value]) => value).join('\n');
    assert.doesNotMatch(serialized, /CONTRACT_SECRET|SERVICE_INFO_SECRET|RAW_MODEL_SECRET|PROFILE_SECRET|实际年龄|sk-never-store/u);
    assert.match(serialized, /林澈/u);
});

test('v1 and v2 records migrate deterministically without losing minimal public fields', () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, records: [{
        localId: 'history_service_1', orderUid: 'service_1', roleUid: 'npc_service_1', status: '已取消', archiveState: 'archived', mode: 'SFW',
        categoryId: 'coffee_walk', category: '咖啡与散步', topic: '咖啡与散步：与林澈的文字协商', initiatedAt: '待正文确认', startedAt: '', endedAt: '玩家已取消',
        summary: '旧版最小公开摘要。', profile: { 昵称: '林澈', 年龄段: '25-29', 简介: '公开资料', 兴趣标签: ['电影'] }, createdAt: '2026-07-26', updatedAt: '2026-07-26',
    }] }));
    let store = createStore(storage);
    const v1 = store.list({ includeInternal: true })[0];
    assert.equal(v1.archivePhase, 'finalized');
    assert.equal(v1.summary, '旧版最小公开摘要。');
    assert.equal(v1.topic, '咖啡与散步：与林澈的文字协商');
    assert.equal(v1.profiles.length, 1);

    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, records: [{
        ...v1,
        localId: 'history_service_2', orderUid: 'service_2', roleUid: 'npc_service_2', roleUids: ['npc_service_2'],
        archiveState: 'pending_archive', archivePhase: 'terminal_confirmed',
    }] }));
    store = createStore(storage);
    const v2 = store.list({ includeInternal: true })[0];
    assert.equal(v2.archivePhase, 'staged_before_transition', 'ambiguous legacy pending records migrate to the fail-closed phase');
    assert.equal(store.markArchived(v2.localId), false);
    assert.equal(store.markTerminalConfirmed(v2.localId), true);
    assert.equal(store.markArchived(v2.localId), true);
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).version, 3, 'the next successful mutation persists the migrated v3 shape');
});

test('history is scoped, rejects malformed participants, and deduplicates legacy rows', () => {
    const storage = memoryStorage();
    const first = createStore(storage);
    const second = createServiceOrderHistoryStore({ storage, getScope: () => 'chat_b', now: () => '2026-08-15T12:01:00.000Z' });
    assert.equal(first.stage(terminalOrder({ id: 'service_2', roleUid: 'npc_service_2' }), { status: '已取消' })?.status, '已取消');
    assert.equal(second.list({ includeInternal: true }).length, 0);
    assert.equal(first.stage(terminalOrder({ id: '__proto__' }), { status: '已完成' }), null);
    assert.equal(first.stage(terminalOrder({ roleUids: ['npc_service_1', 'npc_service_2', 'npc_service_3', 'npc_service_4'], profiles: [{}, {}, {}, {}] }), { status: '已完成' }), null);
    assert.equal(first.stage(terminalOrder({ roleUids: ['npc_service_1', 'npc_service_1'], profiles: [{}, {}] }), { status: '已完成' }), null);

    const persisted = JSON.parse(storage.getItem(STORAGE_KEY));
    persisted.records.push(persisted.records[0]);
    storage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    assert.equal(first.list({ includeInternal: true }).length, 1);
});

test('storage read, parse and write failures fail closed without overwriting unknown history', () => {
    let writes = 0;
    const readFailure = {
        getItem() { throw new Error('denied'); },
        setItem() { writes += 1; },
    };
    const denied = createStore(readFailure);
    assert.deepEqual(denied.list({ includeInternal: true }), []);
    assert.equal(denied.stage(terminalOrder(), { status: '已完成' }), null);
    assert.equal(denied.markTerminalConfirmed('history_service_1'), false);
    assert.equal(writes, 0, 'a failed read must never be replaced with an empty baseline');

    const malformed = memoryStorage();
    malformed.setItem(STORAGE_KEY, '{broken json');
    const original = malformed.getItem(STORAGE_KEY);
    assert.equal(createStore(malformed).stage(terminalOrder(), { status: '已完成' }), null);
    assert.equal(malformed.getItem(STORAGE_KEY), original, 'unreadable prior data remains untouched');

    const malformedRecord = memoryStorage();
    malformedRecord.setItem(STORAGE_KEY, JSON.stringify({ version: 2, records: [{ archiveState: 'archived' }] }));
    const malformedRecordRaw = malformedRecord.getItem(STORAGE_KEY);
    assert.equal(createStore(malformedRecord).stage(terminalOrder(), { status: '已完成' }), null);
    assert.equal(malformedRecord.getItem(STORAGE_KEY), malformedRecordRaw, 'an invalid record cannot be silently dropped by a later write');

    const writeFailure = {
        getItem() { return null; },
        setItem() { throw new Error('quota'); },
    };
    assert.equal(createStore(writeFailure).stage(terminalOrder(), { status: '已完成' }), null);
});

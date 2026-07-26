import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceOrderHistoryStore } from '../service-order-history-store.js';

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
        category: '露骨文爱',
        topic: '虚构成人主题：与林澈的文字协商',
        initiatedAt: '待正文确认',
        startedAt: '玩家已确认接单',
        endedAt: '',
        summary: '正文已结束。',
        profile: {
            昵称: '林澈', 年龄段: '25-29', 简介: '仅公开资料。', 兴趣标签: ['角色扮演'],
            隐藏资料: { 实际年龄: 27, 私人备注: '不得保存' },
        },
        已确认边界: '{"主题":"不得保存"}',
        rawModelOutput: '不得保存',
        ...overrides,
    };
}

test('service history stages before finalization and stores only minimal public projection', () => {
    const storage = memoryStorage();
    const store = createServiceOrderHistoryStore({ storage, getScope: () => 'chat_a', now: () => '2026-07-26T12:00:00.000Z' });
    const staged = store.stage(terminalOrder(), { status: '已完成' });
    assert.equal(staged?.archiveState, 'pending_archive');
    assert.equal(staged?.status, '已完成');
    assert.equal(store.list({ includeInternal: true }).length, 1);
    assert.equal(store.list()[0].localId, undefined, 'public history projection must hide browser-local record references');
    assert.equal(store.list()[0].orderUid, undefined, 'public history projection must hide internal order references');
    assert.equal(store.list()[0].roleUid, undefined, 'public history projection must hide internal role references');
    assert.match(store.list({ includeInternal: true })[0].localId, /^history_service_/u, 'internal callers retain the local reference required for rebook and deletion');

    const serialized = storage.dump().map(([, value]) => value).join('\n');
    assert.doesNotMatch(serialized, /已确认边界|实际年龄|私人备注|rawModelOutput|不得保存/u);
    assert.match(serialized, /林澈/u);
    assert.equal(store.markArchived(staged.localId), true);
    assert.equal(store.list({ includeInternal: true })[0].archiveState, 'archived');
});

test('service history is scoped to the current chat and rejects malformed records', () => {
    const storage = memoryStorage();
    const first = createServiceOrderHistoryStore({ storage, getScope: () => 'chat_a', now: () => '2026-07-26T12:00:00.000Z' });
    const second = createServiceOrderHistoryStore({ storage, getScope: () => 'chat_b', now: () => '2026-07-26T12:01:00.000Z' });
    assert.equal(first.stage(terminalOrder({ id: 'service_2', roleUid: 'npc_service_2' }), { status: '已取消' })?.status, '已取消');
    assert.equal(second.list({ includeInternal: true }).length, 0, 'another chat scope must not see the first history');
    assert.equal(first.stage(terminalOrder({ id: '__proto__' }), { status: '已完成' }), null);
    const record = first.list({ includeInternal: true })[0];
    assert.equal(first.remove(record.localId), true);
    assert.equal(first.list({ includeInternal: true }).length, 0);
});


test('multi-person history retains only ordered public participant projections and hides all internal references from public list', () => {
    const storage = memoryStorage();
    const store = createServiceOrderHistoryStore({ storage, getScope: () => 'chat_multi', now: () => '2026-07-26T12:02:00.000Z' });
    const staged = store.stage(terminalOrder({
        roleUids: ['npc_service_1', 'npc_service_2', 'npc_service_3'],
        profiles: [
            { 昵称: '林澈', 年龄段: '25-29', 简介: '公开 A', 兴趣标签: ['电影'], 隐藏资料: { 实际年龄: 28 } },
            { 昵称: '顾晴', 年龄段: '30-34', 简介: '公开 B', 兴趣标签: ['展览'], secret: '不得保存' },
            { 昵称: '周岚', 年龄段: '25-29', 简介: '公开 C', 兴趣标签: ['散步'], apiKey: 'sk-never-store' },
        ],
    }), { status: '已完成' });
    assert.deepEqual(staged?.roleUids, ['npc_service_1', 'npc_service_2', 'npc_service_3']);
    assert.deepEqual(store.list({ includeInternal: true })[0].profiles.map((profile) => profile.昵称), ['林澈', '顾晴', '周岚']);
    const visible = store.list()[0];
    assert.equal(visible.localId, undefined);
    assert.equal(visible.orderUid, undefined);
    assert.equal(visible.roleUid, undefined);
    assert.equal(visible.roleUids, undefined);
    assert.doesNotMatch(JSON.stringify(visible), /(?:history|npc|service)_/u, 'public list must not serialize browser-local or MVU identifiers');
    assert.deepEqual(visible.profiles.map((profile) => Object.keys(profile).sort()), [
        ['兴趣标签', '年龄段', '昵称', '简介'].sort(),
        ['兴趣标签', '年龄段', '昵称', '简介'].sort(),
        ['兴趣标签', '年龄段', '昵称', '简介'].sort(),
    ]);
    const serialized = storage.dump().map(([, value]) => value).join('\n');
    assert.doesNotMatch(serialized, /实际年龄|不得保存|sk-never-store/u);
});

test('history reader accepts a legacy single-person v1 record but rejects over-three and duplicated participants', () => {
    const storage = memoryStorage();
    storage.setItem('yuelema.service-order-history/v1:legacy', JSON.stringify({ version: 1, records: [{
        localId: 'history_service_1', orderUid: 'service_1', roleUid: 'npc_service_1', status: '已取消', archiveState: 'archived', mode: 'SFW',
        categoryId: 'coffee_walk', category: '咖啡与散步', topic: '咖啡与散步：与林澈的文字协商', initiatedAt: '待正文确认', startedAt: '', endedAt: '玩家已取消',
        summary: '玩家在正文开始前取消了本次服务。', profile: { 昵称: '林澈', 年龄段: '25-29', 简介: '公开资料', 兴趣标签: ['电影'] }, createdAt: '2026-07-26', updatedAt: '2026-07-26',
    }] }));
    const store = createServiceOrderHistoryStore({ storage, getScope: () => 'legacy' });
    assert.equal(store.list({ includeInternal: true }).length, 1);
    assert.equal(store.list({ includeInternal: true })[0].profiles.length, 1);
    assert.equal(store.stage(terminalOrder({ roleUids: ['npc_service_1', 'npc_service_2', 'npc_service_3', 'npc_service_4'], profiles: [{}, {}, {}, {}] }), { status: '已完成' }), null);
    assert.equal(store.stage(terminalOrder({ roleUids: ['npc_service_1', 'npc_service_1'], profiles: [{}, {}] }), { status: '已完成' }), null);
});

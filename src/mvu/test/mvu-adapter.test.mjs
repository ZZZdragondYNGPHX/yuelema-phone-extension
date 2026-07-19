import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeJsonPointer, getAtPointer } from '../json-pointer.js';
import {
    buildControlledPatch,
    buildUpdateVariable,
    validateControlledPatchAgainstState,
    validateControlledPatchWhitelist,
} from '../controlled-patch.js';
import { applyControlledPatch, readLatestState } from '../adapter.js';

function npc({ status = '陌生', age = 28 } = {}) {
    return {
        成人验证: true,
        公开资料: { 昵称: '测试对象' },
        仅好友资料: {},
        隐藏资料: { 实际年龄: age, 私人备注: '不得进入 UI' },
        偏好与边界: '',
        拒绝阈值: 0,
        已读不回阈值: 0,
        取消匹配阈值: 0,
        拉黑阈值: 100,
        与玩家关系: { 状态: status, 全局账号表现: 50, NPC专属匹配度: 0, 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 },
    };
}

function stateFixture() {
    return {
        软件: { 内容模式: 'SFW', 关于软件点击数: 4 },
        系统: { UID计数器: { 角色: 1, 会话: 0, 面基: 0 } },
        玩家: { 成人验证: true, 公开资料: {}, 推荐偏好: { 标签权重: {} } },
        角色池: {},
        会话: {},
        推荐: {
            当前队列: ['npc_alpha'],
            临时候选池: { npc_alpha: npc() },
            冷却角色UID: [],
            收藏角色UID: [],
            不喜欢角色UID: [],
            拉黑角色UID: [],
        },
    };
}

test('JSON Pointer only traverses own safe properties', () => {
    assert.deepEqual(decodeJsonPointer('/推荐/临时候选池/npc_alpha'), ['推荐', '临时候选池', 'npc_alpha']);
    assert.throws(() => decodeJsonPointer('/角色池/__proto__/污染'));
    assert.throws(() => decodeJsonPointer('/角色池/bad~2escape'));
    assert.equal(getAtPointer({ a: ['x'] }, '/a/0').value, 'x');
    assert.equal(getAtPointer({ a: ['x'] }, '/a/-').found, false);
});

test('favorite promotes a trusted candidate by move without serializing its hidden data', () => {
    const state = stateFixture();
    const result = buildControlledPatch(state, { kind: 'favorite', npcUid: 'npc_alpha' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, [
        { op: 'move', from: '/推荐/临时候选池/npc_alpha', path: '/角色池/npc_alpha' },
        { op: 'add', path: '/推荐/收藏角色UID/-', value: 'npc_alpha' },
        { op: 'remove', path: '/推荐/当前队列/0' },
    ]);
    const wrapped = buildUpdateVariable(result.value);
    assert.equal(wrapped.ok, true);
    assert.match(wrapped.value, /^<UpdateVariable><JSONPatch>\[/);
    assert.doesNotMatch(wrapped.value, /不得进入 UI/);
});

test('like uses the local two-layer score, then atomically creates a matched session', () => {
    const result = buildControlledPatch(stateFixture(), { kind: 'like', npcUid: 'npc_alpha' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.map((operation) => operation.op), ['move', 'replace', 'replace', 'add', 'replace', 'remove']);
    assert.equal(result.value[1].path, '/角色池/npc_alpha/与玩家关系/NPC专属匹配度');
    assert.equal(result.value[2].path, '/角色池/npc_alpha/与玩家关系/状态');
    assert.equal(result.value[2].value, '已匹配');
    assert.equal(result.value[3].path, '/会话/chat_1');
});

test('dislike and refresh do not promote a candidate or accept arbitrary paths', () => {
    const disliked = buildControlledPatch(stateFixture(), { kind: 'dislike', npcUid: 'npc_alpha' });
    assert.equal(disliked.ok, true);
    assert.equal(disliked.value.some((operation) => operation.op === 'move'), false);
    assert.deepEqual(disliked.value.map((operation) => operation.path), [
        '/推荐/不喜欢角色UID/-',
        '/推荐/冷却角色UID/-',
        '/推荐/当前队列/0',
    ]);

    const refreshed = buildControlledPatch(stateFixture(), { kind: 'refresh', npcUid: 'npc_alpha' });
    assert.equal(refreshed.ok, true);
    assert.deepEqual(refreshed.value.map((operation) => operation.path), [
        '/推荐/冷却角色UID/-',
        '/推荐/当前队列/0',
    ]);

    assert.equal(buildControlledPatch(stateFixture(), { kind: 'favorite', npcUid: '../../玩家' }).ok, false);
    assert.equal(validateControlledPatchWhitelist([
        { op: 'replace', path: '/玩家/隐藏资料/实际年龄', value: 18 },
    ]).ok, false);
});

test('five-click gate resets counter and toggles SFW/NSFW only at fifth click', () => {
    const fifth = buildControlledPatch(stateFixture(), { kind: 'advance_content_mode_gate' });
    assert.equal(fifth.ok, true);
    assert.deepEqual(fifth.value, [
        { op: 'replace', path: '/软件/关于软件点击数', value: 0 },
        { op: 'replace', path: '/软件/内容模式', value: 'NSFW' },
    ]);

    const state = stateFixture();
    state.软件.关于软件点击数 = 2;
    const third = buildControlledPatch(state, { kind: 'advance_content_mode_gate' });
    assert.deepEqual(third.value, [{ op: 'replace', path: '/软件/关于软件点击数', value: 3 }]);
});

test('state consistency rejects stale/forged list writes before parsing', () => {
    const patch = [{ op: 'add', path: '/推荐/收藏角色UID/-', value: 'npc_missing' }];
    const result = validateControlledPatchAgainstState(stateFixture(), patch);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'tracked_uid_not_adult');
});

test('state validator accepts only exact generated UI transitions', () => {
    const original = buildControlledPatch(stateFixture(), { kind: 'favorite', npcUid: 'npc_alpha' }).value;
    const reordered = [original[1], original[0], original[2]];
    const result = validateControlledPatchAgainstState(stateFixture(), reordered);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'patch_not_exact_ui_transition');
});

test('readLatestState is read-only and returns a clone', () => {
    const data = { stat_data: stateFixture() };
    const result = readLatestState({ mvu: { getMvuData: () => data } });
    assert.equal(result.ok, true);
    result.state.软件.内容模式 = 'NSFW';
    assert.equal(data.stat_data.软件.内容模式, 'SFW');
});

test('applyControlledPatch follows get -> parse -> replace -> event sequence', async () => {
    const oldData = { stat_data: stateFixture() };
    const calls = [];
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
        getMvuData(scope) {
            calls.push(['get', scope]);
            return oldData;
        },
        async parseMessage(raw, old) {
            calls.push(['parse', raw, old]);
            assert.equal(old, oldData);
            assert.match(raw, /<UpdateVariable><JSONPatch>/);
            return { stat_data: { ...old.stat_data, 已回收: true } };
        },
        async replaceMvuData(next, scope) {
            calls.push(['replace', next, scope]);
        },
    };
    const patch = buildControlledPatch(oldData.stat_data, { kind: 'favorite', npcUid: 'npc_alpha' }).value;
    const result = await applyControlledPatch({
        patch,
        mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.deepEqual(calls.map(([name]) => name), ['get', 'parse', 'replace', 'event']);
    assert.equal(calls[3][1], 'mag_variable_update_ended');
});

test('unavailable MVU and parse no-change never call replace or event', async () => {
    const unavailable = await applyControlledPatch({ patch: [] });
    assert.equal(unavailable.status, 'unavailable');

    const calls = [];
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
        getMvuData: () => ({ stat_data: stateFixture() }),
        parseMessage: async () => { calls.push('parse'); return undefined; },
        replaceMvuData: async () => { calls.push('replace'); },
    };
    const patch = buildControlledPatch(stateFixture(), { kind: 'refresh', npcUid: 'npc_alpha' }).value;
    const result = await applyControlledPatch({ patch, mvu, eventEmit: async () => calls.push('event') });
    assert.equal(result.status, 'no_change');
    assert.deepEqual(calls, ['parse']);
});




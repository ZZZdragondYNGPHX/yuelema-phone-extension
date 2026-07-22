import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { decodeJsonPointer, getAtPointer } from '../json-pointer.js';
import {
    LATEST_MESSAGE_SCOPE,
    buildClearPrivateChatPatch,
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
        玩家: { 成人验证: true, 公开资料: {}, 推荐偏好: { 标签权重: { SFW: {}, NSFW: {} } } },
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

test('like only records homepage feedback and never creates a role or matched session', () => {
    const result = buildControlledPatch(stateFixture(), { kind: 'like', npcUid: 'npc_alpha' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, [
        { op: 'add', path: '/推荐/冷却角色UID/-', value: 'npc_alpha' },
        { op: 'remove', path: '/推荐/当前队列/0' },
    ]);
    assert.equal(result.value.some((operation) => operation.path.startsWith('/角色池/')), false);
    assert.equal(result.value.some((operation) => operation.path.startsWith('/会话/')), false);
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

test('five-click gate only unlocks the slider and explicit toggle changes SFW/NSFW', () => {
    const fifth = buildControlledPatch(stateFixture(), { kind: 'advance_content_mode_gate' });
    assert.equal(fifth.ok, true);
    assert.deepEqual(fifth.value, [
        { op: 'replace', path: '/软件/关于软件点击数', value: 0 },
    ]);

    const toggled = buildControlledPatch(stateFixture(), { kind: 'toggle_content_mode' });
    assert.equal(toggled.ok, true);
    assert.deepEqual(toggled.value, [
        { op: 'replace', path: '/软件/内容模式', value: 'NSFW' },
    ]);
    assert.equal(validateControlledPatchAgainstState(stateFixture(), toggled.value).ok, true);

    const stateWithoutLegacyCounter = stateFixture();
    delete stateWithoutLegacyCounter.软件.关于软件点击数;
    const toggledWithoutLegacyCounter = buildControlledPatch(stateWithoutLegacyCounter, { kind: 'toggle_content_mode' });
    assert.equal(toggledWithoutLegacyCounter.ok, true);
    assert.deepEqual(toggledWithoutLegacyCounter.value, [
        { op: 'replace', path: '/软件/内容模式', value: 'NSFW' },
    ]);
    assert.equal(validateControlledPatchAgainstState(stateWithoutLegacyCounter, toggledWithoutLegacyCounter.value).ok, true);

    const nsfw = stateFixture();
    nsfw.软件.内容模式 = 'NSFW';
    const toggledBack = buildControlledPatch(nsfw, { kind: 'toggle_content_mode' });
    assert.deepEqual(toggledBack.value.at(-1), { op: 'replace', path: '/软件/内容模式', value: 'SFW' });
    assert.equal(validateControlledPatchAgainstState(nsfw, toggledBack.value).ok, true);

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
    let receivedScope;
    const result = readLatestState({
        mvu: {
            getMvuData(scope) {
                receivedScope = scope;
                scope.message_id = 0;
                return data;
            },
        },
    });
    assert.equal(result.ok, true);
    result.state.软件.内容模式 = 'NSFW';
    assert.equal(data['stat_data']['软件']['内容模式'], 'SFW');
    assert.equal(receivedScope.message_id, 0);
    assert.notEqual(receivedScope, LATEST_MESSAGE_SCOPE);
    assert.equal(LATEST_MESSAGE_SCOPE.message_id, 'latest');
});

test('cross-realm native MVU records are accepted while custom prototypes stay rejected', () => {
    const foreignData = runInNewContext('({ stat_data: { software: { mode: "SFW" } } })');
    const read = readLatestState({ mvu: { getMvuData: () => foreignData } });
    assert.equal(read.ok, true);
    assert.equal(read.state.software.mode, 'SFW');

    const customPrototype = { constructor: Object };
    const unsafeData = Object.create(customPrototype);
    unsafeData.stat_data = {};
    const rejected = readLatestState({ mvu: { getMvuData: () => unsafeData } });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'mvu_stat_data_unavailable');
});

test('applyControlledPatch accepts parseMessage data created in the MVU realm', async () => {
    const calls = [];
    const oldData = { stat_data: stateFixture() };
    const foreignData = runInNewContext(`({ stat_data: ${JSON.stringify(oldData.stat_data)} })`);
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
        getMvuData: () => oldData,
        parseMessage: async () => {
            calls.push('parse');
            foreignData.stat_data.软件.内容模式 = 'NSFW';
            return foreignData;
        },
        replaceMvuData: async () => { calls.push('replace'); },
    };
    const patch = buildControlledPatch(oldData.stat_data, { kind: 'toggle_content_mode' }).value;
    const result = await applyControlledPatch({ patch, mvu, eventEmit: async () => calls.push('event') });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.deepEqual(calls, ['parse', 'replace', 'event']);
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
            return { stat_data: { ...old.stat_data, 软件: { ...old.stat_data.软件, 内容模式: 'NSFW' } } };
        },
        async replaceMvuData(next, scope) {
            calls.push(['replace', next, scope]);
        },
    };
    const patch = buildControlledPatch(oldData.stat_data, { kind: 'toggle_content_mode' }).value;
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

test('applyControlledPatch gives mutable fresh scopes to an in-place MVU host', async () => {
    const oldData = { stat_data: stateFixture() };
    let readScope;
    let replaceScope;
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
        getMvuData(scope) {
            readScope = scope;
            return oldData;
        },
        parseMessage: async (_raw, data) => {
            const next = structuredClone(data);
            next.stat_data.软件.内容模式 = 'NSFW';
            return next;
        },
        replaceMvuData: async (_data, scope) => {
            replaceScope = scope;
            scope.message_id = 0;
        },
    };
    const patch = buildControlledPatch(oldData.stat_data, { kind: 'toggle_content_mode' }).value;
    const result = await applyControlledPatch({ patch, mvu, eventEmit: async () => {} });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.equal(Object.isFrozen(readScope), false);
    assert.equal(Object.isFrozen(replaceScope), false);
    assert.notEqual(readScope, LATEST_MESSAGE_SCOPE);
    assert.notEqual(replaceScope, LATEST_MESSAGE_SCOPE);
    assert.notEqual(readScope, replaceScope);
    assert.equal(replaceScope.message_id, 0);
    assert.equal(LATEST_MESSAGE_SCOPE.message_id, 'latest');
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

test('parse resolving with an unchanged stat_data is reported as rejected, not applied', async () => {
    const calls = [];
    const oldData = { stat_data: stateFixture() };
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
        getMvuData: () => oldData,
        // Mirrors real MVU builds whose schema silently drops every command.
        parseMessage: async (raw, old) => { calls.push('parse'); return structuredClone(old); },
        replaceMvuData: async () => { calls.push('replace'); },
    };
    const patch = buildControlledPatch(oldData.stat_data, { kind: 'refresh', npcUid: 'npc_alpha' }).value;
    const result = await applyControlledPatch({ patch, mvu, eventEmit: async () => calls.push('event') });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'no_change');
    assert.equal(result.code, 'mvu_parse_made_no_change');
    assert.deepEqual(calls, ['parse']);
});

test('content-mode toggle survives an in-place provider mutation and preserves the old event snapshot', async () => {
    const calls = [];
    const oldData = { stat_data: stateFixture() };
    let replacedData;
    let eventOldData;
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
        getMvuData: () => oldData,
        parseMessage: async (_raw, data) => {
            calls.push('parse');
            data.stat_data.软件.内容模式 = 'NSFW';
            return data;
        },
        replaceMvuData: async (data) => {
            calls.push('replace');
            replacedData = data;
        },
    };
    const patch = buildControlledPatch(oldData.stat_data, { kind: 'toggle_content_mode' }).value;
    const result = await applyControlledPatch({
        patch,
        mvu,
        eventEmit: async (...args) => {
            calls.push('event');
            eventOldData = args[2];
        },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.deepEqual(calls, ['parse', 'replace', 'event']);
    assert.equal(replacedData.stat_data.软件.内容模式, 'NSFW');
    assert.equal(eventOldData.stat_data.软件.内容模式, 'SFW');
    assert.equal(oldData.stat_data.软件.内容模式, 'NSFW');
});

test('content-mode toggle is persisted only when provider output satisfies the exact replace', async () => {
    const calls = [];
    const oldData = { stat_data: stateFixture() };
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
        getMvuData: () => oldData,
        parseMessage: async () => {
            calls.push('parse');
            const next = structuredClone(oldData);
            next.stat_data.软件.内容模式 = 'NSFW';
            return next;
        },
        replaceMvuData: async () => { calls.push('replace'); },
    };
    const patch = buildControlledPatch(oldData.stat_data, { kind: 'toggle_content_mode' }).value;
    const result = await applyControlledPatch({ patch, mvu, eventEmit: async () => calls.push('event') });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.deepEqual(calls, ['parse', 'replace', 'event']);
});

test('unrelated provider changes cannot disguise a dropped content-mode replace', async () => {
    const calls = [];
    const oldData = { stat_data: stateFixture() };
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
        getMvuData: () => oldData,
        parseMessage: async () => {
            calls.push('parse');
            const next = structuredClone(oldData);
            next.stat_data.软件.无关字段 = true;
            return next;
        },
        replaceMvuData: async () => { calls.push('replace'); },
    };
    const patch = buildControlledPatch(oldData.stat_data, { kind: 'toggle_content_mode' }).value;
    const result = await applyControlledPatch({ patch, mvu, eventEmit: async () => calls.push('event') });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'no_change');
    assert.equal(result.code, 'mvu_parse_postcondition_failed');
    assert.deepEqual(result.detail, { operationIndex: 0, path: '/软件/内容模式' });
    assert.deepEqual(calls, ['parse']);
});

test('provider result without stat_data is rejected before replace or event', async () => {
    const calls = [];
    const oldData = { stat_data: stateFixture() };
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
        getMvuData: () => oldData,
        parseMessage: async () => { calls.push('parse'); return {}; },
        replaceMvuData: async () => { calls.push('replace'); },
    };
    const patch = buildControlledPatch(oldData.stat_data, { kind: 'toggle_content_mode' }).value;
    const result = await applyControlledPatch({ patch, mvu, eventEmit: async () => calls.push('event') });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'no_change');
    assert.equal(result.code, 'mvu_parse_returned_no_stat_data');
    assert.deepEqual(calls, ['parse']);
});


test('applyControlledPatch rejects a provider that drops a remove operation', async () => {
    const calls = [];
    const oldData = { stat_data: stateFixture() };
    oldData.stat_data.角色池.npc_alpha = npc({ status: '已匹配' });
    oldData.stat_data.推荐.临时候选池 = {};
    oldData.stat_data.会话.chat_1 = {
        对象UID: 'npc_alpha', 状态: '已匹配', 最近消息: [], 长期摘要: '', 已确认边界: '', 已确认承诺: '',
    };
    const patch = buildClearPrivateChatPatch(oldData.stat_data, { sessionUid: 'chat_1' }).value;
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
        getMvuData: () => oldData,
        parseMessage: async () => {
            calls.push('parse');
            const next = structuredClone(oldData);
            next.stat_data.角色池.npc_alpha.与玩家关系.状态 = '已取消';
            return next;
        },
        replaceMvuData: async () => calls.push('replace'),
    };
    const result = await applyControlledPatch({ patch, mvu, eventEmit: async () => calls.push('event') });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'no_change');
    assert.equal(result.code, 'mvu_parse_postcondition_failed');
    assert.deepEqual(result.detail, { operationIndex: 0, path: '/会话/chat_1' });
    assert.deepEqual(calls, ['parse']);
});

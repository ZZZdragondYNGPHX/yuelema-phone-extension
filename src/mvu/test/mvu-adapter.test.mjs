import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { decodeJsonPointer, getAtPointer } from '../json-pointer.js';
import { createEmptyRelationshipNarrative, createRelationshipNarrativeFromProfile, validateRelationshipNarrative } from '../relationship-narrative.js';
import { createEmptyBodyRelationshipCandidate } from '../body-relationship-candidate.js';
import {
    LATEST_MESSAGE_SCOPE,
    buildClearPrivateChatPatch,
    buildBodyRelationshipCandidateBackfillPatch,
    buildControlledPatch,
    buildPrivateChatNsfwConsentBackfillPatch,
    buildPrivateChatPatch,
    buildRecommendationInitialCandidatePatch,
    buildRelationshipNarrativeBackfillPatch,
    buildServiceOrderHandoffPatch,
    buildStoryMemoryBackfillPatch,
    buildUpdateVariable,
    validateControlledPatchAgainstState,
    validateControlledPatchWhitelist,
} from '../controlled-patch.js';
import { applyControlledPatch, readLatestState } from '../adapter.js';
import { consumeNsfwConsent, createEmptyNsfwConsent, grantNsfwConsent } from '../nsfw-consent.js';

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
        正文记忆: {},
        正文关系候选: {},
        关系叙事: {},
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

function completeCandidate() {
    return {
        成人验证: true,
        公开资料: {
            昵称: '林澈', 头像引用: '', 年龄段: '25-29', 性别: '女', 性取向: '异性恋',
            城市: '上海', 距离范围: '10 km', 寻找意图: '先聊天再约会', 简介: '喜欢阅读和散步。',
            兴趣标签: ['阅读'], 生活方式标签: ['早起'], 性格标签: ['温和'], 沟通风格标签: ['直接'],
        },
        仅好友资料: { 关系状态: '单身', 边界与偏好: '尊重边界。' },
        隐藏资料: { 实际年龄: 26, 私人备注: '' },
        偏好与边界: '',
        // 已读不回阈值需满足新生成校验：≥ 开局压力（戒备 0 → 30）+ 15 边际。
        拒绝阈值: 20, 已读不回阈值: 55, 取消匹配阈值: 60, 拉黑阈值: 90,
        与玩家关系: {
            状态: '陌生', 全局账号表现: 50, NPC专属匹配度: 0, 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0,
            友情值: 0, 心动值: 0, 欲望值: 0,
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

test('favorite promotes a trusted candidate and seeds its protected narrative in the same controlled patch', () => {
    const state = stateFixture();
    const result = buildControlledPatch(state, { kind: 'favorite', npcUid: 'npc_alpha' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, [
        { op: 'move', from: '/推荐/临时候选池/npc_alpha', path: '/角色池/npc_alpha' },
        { op: 'add', path: '/正文记忆/npc_alpha', value: '' },
        { op: 'add', path: '/关系叙事/npc_alpha', value: createRelationshipNarrativeFromProfile(state.推荐.临时候选池.npc_alpha) },
        { op: 'add', path: '/正文关系候选/npc_alpha', value: createEmptyBodyRelationshipCandidate() },
        { op: 'add', path: '/推荐/收藏角色UID/-', value: 'npc_alpha' },
        { op: 'remove', path: '/推荐/当前队列/0' },
    ]);
    const wrapped = buildUpdateVariable(result.value);
    assert.equal(wrapped.ok, true);
    assert.match(wrapped.value, /^<UpdateVariable><JSONPatch>\[/);
    assert.match(wrapped.value, /关系叙事/u);
});

test('story-memory backfill creates every missing role slot and removes only orphan slots', () => {
    const current = stateFixture();
    current.角色池.npc_alpha = npc();
    current.角色池.npc_beta = npc();
    current.正文记忆 = { npc_beta: '保留已有的独立经历。', npc_orphan: '孤立旧记录' };
    const built = buildStoryMemoryBackfillPatch(current);
    assert.deepEqual(built, { ok: true, value: [
        { op: 'add', path: '/正文记忆/npc_alpha', value: '' },
        { op: 'remove', path: '/正文记忆/npc_orphan' },
    ] });
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
    const forged = structuredClone(built.value);
    forged[0].value = '伪造经历';
    assert.equal(validateControlledPatchAgainstState(current, forged).ok, false);
    assert.equal(buildStoryMemoryBackfillPatch({
        ...current,
        正文记忆: { npc_alpha: 42, npc_beta: '' },
    }).code, 'story_memory_backfill_value_invalid');
});

test('relationship narrative records are exact, bounded, and backfill never deletes orphan state', () => {
    const current = stateFixture();
    current.角色池.npc_alpha = npc();
    current.角色池.npc_beta = npc();
    const retained = createEmptyRelationshipNarrative();
    retained.人生底色.公开轮廓 = '保留的公开轮廓。';
    retained.人生底色.生活痕迹 = ['晨跑'];
    retained.未竟心愿.线索节点 = ['一封未寄出的信'];
    retained.进程.最后结算回合UID = 'turn_20260730_1';
    retained.进程.已消费事件ID = ['event_1'];
    current.关系叙事 = { npc_beta: retained };

    const built = buildRelationshipNarrativeBackfillPatch(current);
    assert.deepEqual(built, { ok: true, value: [
        { op: 'add', path: '/关系叙事/npc_alpha', value: createRelationshipNarrativeFromProfile(current.角色池.npc_alpha) },
    ] });
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
    assert.deepEqual(current.关系叙事.npc_beta, retained);

    const forged = structuredClone(built.value);
    forged[0].value.进程.NSFW路线锁定 = '伪造路线';
    assert.equal(validateControlledPatchAgainstState(current, forged).ok, false);

    const malformed = createEmptyRelationshipNarrative();
    malformed.未竟心愿.变化轨迹 = '随意改写';
    assert.equal(validateRelationshipNarrative(malformed).ok, false);
    const getterBacked = createEmptyRelationshipNarrative();
    Object.defineProperty(getterBacked, '版本', { enumerable: true, get: () => 1 });
    assert.equal(validateRelationshipNarrative(getterBacked).ok, false);
    const duplicatedIds = createEmptyRelationshipNarrative();
    duplicatedIds.进程.已消费事件ID = ['event_1', 'event_1'];
    assert.equal(validateRelationshipNarrative(duplicatedIds).ok, false);

    const orphanState = structuredClone(current);
    orphanState.关系叙事.npc_orphan = createEmptyRelationshipNarrative();
    const before = structuredClone(orphanState.关系叙事);
    assert.deepEqual(buildRelationshipNarrativeBackfillPatch(orphanState), {
        ok: false, code: 'relationship_narrative_backfill_orphan', detail: '',
    });
    assert.deepEqual(orphanState.关系叙事, before);
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
    nsfw.会话.chat_1 = { NSFW同意: grantNsfwConsent(createEmptyNsfwConsent(), { scopes: ['成人话题'], turns: 3 }) };
    nsfw.会话.chat_2 = { NSFW同意: consumeNsfwConsent(grantNsfwConsent(createEmptyNsfwConsent(), { scopes: ['成人话题'], turns: 1 })) };
    const toggledBack = buildControlledPatch(nsfw, { kind: 'toggle_content_mode' });
    assert.equal(toggledBack.value[0].path, '/软件/内容模式');
    assert.equal(toggledBack.value[0].value, 'SFW');
    assert.equal(toggledBack.value[1].path, '/会话/chat_1/NSFW同意');
    assert.equal(toggledBack.value[1].value.状态, '已撤回');
    assert.equal(toggledBack.value[2].path, '/会话/chat_2/NSFW同意');
    assert.equal(toggledBack.value[2].value.状态, '已撤回');
    assert.equal(toggledBack.value[2].value.修订号, 3, '离开 NSFW 也要推进已过期记录的修订号，使待投递消息失效');
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
    const reordered = [original[1], original[0], ...original.slice(2)];
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
            assert.notEqual(old, oldData);
            assert.deepEqual(old, oldData);
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

test('content-mode toggle isolates live state from an in-place provider mutation and preserves the old event snapshot', async () => {
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
    assert.equal(oldData.stat_data.软件.内容模式, 'SFW');
});

test('service-order handoff persists when the schema supplies its empty legal completion signal', async () => {
    const calls = [];
    const oldData = { stat_data: stateFixture() };
    oldData.stat_data.推荐.当前队列 = [];
    oldData.stat_data.推荐.临时候选池 = {};
    oldData.stat_data.服务订单 = {};
    oldData.stat_data.系统.UID计数器.服务订单 = 0;
    const built = buildServiceOrderHandoffPatch(oldData.stat_data, { candidate: completeCandidate(), categoryId: 'girl_shuren' });
    assert.equal(built.ok, true);
    let persisted;
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
        getMvuData: () => oldData,
        parseMessage: async (_raw, data) => {
            calls.push('parse');
            const next = structuredClone(data);
            const [role, memory, narrative, bodyCandidate, order, roleCounter, orderCounter] = built.value.patch;
            next.stat_data.角色池.npc_service_2 = role.value;
            next.stat_data.正文记忆.npc_service_2 = memory.value;
            next.stat_data.关系叙事.npc_service_2 = narrative.value;
            next.stat_data.正文关系候选.npc_service_2 = bodyCandidate.value;
            next.stat_data.服务订单.service_1 = { ...order.value, 合法结束条件: { 已满足: false, 摘要: '', 记录时间: '' } };
            next.stat_data.系统.UID计数器.角色 = roleCounter.value;
            next.stat_data.系统.UID计数器.服务订单 = orderCounter.value;
            return next;
        },
        replaceMvuData: async (data) => { calls.push('replace'); persisted = data; },
    };

    const result = await applyControlledPatch({ patch: built.value.patch, mvu, eventEmit: async () => calls.push('event') });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.deepEqual(calls, ['parse', 'replace', 'event']);
    assert.deepEqual(persisted.stat_data.服务订单.service_1.合法结束条件, { 已满足: false, 摘要: '', 记录时间: '' });
    assert.equal(persisted.stat_data.服务订单.service_1.状态, '待确认');
    assert.ok(persisted.stat_data.角色池.npc_service_2);
    assert.equal(persisted.stat_data.系统.UID计数器.角色, 2);
    assert.equal(persisted.stat_data.系统.UID计数器.服务订单, 1);
});

test('service-order schema omissions report the precise safe postcondition diagnostic to the console', async () => {
    const calls = [];
    const diagnosticCalls = [];
    const oldData = { stat_data: stateFixture() };
    oldData.stat_data.推荐.当前队列 = [];
    oldData.stat_data.推荐.临时候选池 = {};
    oldData.stat_data.服务订单 = {};
    oldData.stat_data.系统.UID计数器.服务订单 = 0;
    const built = buildServiceOrderHandoffPatch(oldData.stat_data, { candidate: completeCandidate(), categoryId: 'girl_shuren' });
    assert.equal(built.ok, true);
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
        getMvuData: () => oldData,
        parseMessage: async (_raw, data) => {
            calls.push('parse');
            const next = structuredClone(data);
            const [role, memory, narrative, bodyCandidate, order, roleCounter, orderCounter] = built.value.patch;
            next.stat_data.角色池.npc_service_2 = role.value;
            next.stat_data.正文记忆.npc_service_2 = memory.value;
            next.stat_data.关系叙事.npc_service_2 = narrative.value;
            next.stat_data.正文关系候选.npc_service_2 = bodyCandidate.value;
            const { 合法结束条件: _omitted, ...legacyOrder } = order.value;
            next.stat_data.服务订单.service_1 = legacyOrder;
            next.stat_data.系统.UID计数器.角色 = roleCounter.value;
            next.stat_data.系统.UID计数器.服务订单 = orderCounter.value;
            return next;
        },
        replaceMvuData: async () => calls.push('replace'),
    };

    const result = await applyControlledPatch({
        patch: built.value.patch,
        mvu,
        eventEmit: async () => calls.push('event'),
        diagnosticLogger: { error: (...args) => diagnosticCalls.push(args) },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'mvu_parse_postcondition_failed');
    assert.deepEqual(result.detail, {
        operationIndex: 4, operation: 'add', path: '/服务订单/service_1/合法结束条件',
        kind: 'missing_key', expectedType: 'object', actualType: 'missing',
    });
    assert.deepEqual(diagnosticCalls, [[
        '[约了吗][MVU 受控写入被拒绝]',
        {
            code: 'mvu_parse_postcondition_failed', phase: 'provider_postcondition',
            reason: 'MVU provider 返回结果缺少 Patch 预期字段', operationIndex: 4, operation: 'add',
            path: '/服务订单/service_1/合法结束条件', kind: 'missing_key', expectedType: 'object', actualType: 'missing',
        },
    ]]);
    assert.doesNotMatch(JSON.stringify(diagnosticCalls), /林澈|待正文确认|私人备注/);
    assert.deepEqual(calls, ['parse']);
});

test('stripped relationship routes identify an outdated schema without leaking a partial parse into live state', async () => {
    const calls = [];
    const oldData = { stat_data: stateFixture() };
    oldData.stat_data.推荐.当前队列 = [];
    oldData.stat_data.推荐.临时候选池 = {};
    const built = buildRecommendationInitialCandidatePatch(oldData.stat_data, { candidate: completeCandidate() });
    assert.equal(built.ok, true);
    const candidateOperation = built.value.find((operation) => operation.op === 'add' && operation.path.startsWith('/推荐/临时候选池/'));
    assert.ok(candidateOperation);
    const uid = candidateOperation.path.split('/').at(-1);
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
        getMvuData: () => oldData,
        parseMessage: async (_raw, data) => {
            calls.push('parse');
            const candidate = structuredClone(candidateOperation.value);
            delete candidate.与玩家关系.友情值;
            delete candidate.与玩家关系.心动值;
            delete candidate.与玩家关系.欲望值;
            data.stat_data.推荐.临时候选池[uid] = candidate;
            data.stat_data.推荐.当前队列.push(uid);
            data.stat_data.系统.UID计数器.角色 += 1;
            return data;
        },
        replaceMvuData: async () => calls.push('replace'),
    };

    const diagnosticCalls = [];
    const result = await applyControlledPatch({
        patch: built.value, mvu, eventEmit: async () => calls.push('event'),
        diagnosticLogger: { error: (...args) => diagnosticCalls.push(args) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'no_change');
    assert.equal(result.code, 'mvu_relationship_routes_schema_outdated');
    assert.deepEqual(result.detail, {
        operationIndex: 0, operation: 'add', path: `${candidateOperation.path}/与玩家关系/友情值`,
        kind: 'missing_key', expectedType: 'number', actualType: 'missing',
    });
    assert.deepEqual(diagnosticCalls, [[
        '[约了吗][MVU 受控写入被拒绝]',
        { code: 'mvu_relationship_routes_schema_outdated', phase: 'provider_postcondition', reason: 'MVU provider 返回结果缺少 Patch 预期字段', operationIndex: 0, operation: 'add', path: `${candidateOperation.path}/与玩家关系/友情值`, kind: 'missing_key', expectedType: 'number', actualType: 'missing' },
    ]]);
    assert.deepEqual(calls, ['parse']);
    assert.equal(oldData.stat_data.推荐.临时候选池[uid], undefined);
    assert.deepEqual(oldData.stat_data.推荐.当前队列, []);
    assert.equal(oldData.stat_data.系统.UID计数器.角色, 1);
});

test('stripped B.1 relationship-progress leaves fail closed as a narrative-schema mismatch', async () => {
    const calls = [];
    const oldData = { stat_data: stateFixture() };
    const role = completeCandidate();
    role.与玩家关系 = {
        ...role.与玩家关系,
        状态: '已匹配', NPC专属匹配度: 70,
        好感: 20, 信任: 10, 戒备: 15, 面基意愿: 0,
    };
    oldData.stat_data.角色池.npc_alpha = role;
    oldData.stat_data.推荐.当前队列 = [];
    oldData.stat_data.推荐.临时候选池 = {};
    oldData.stat_data.正文记忆.npc_alpha = '';
    oldData.stat_data.正文关系候选.npc_alpha = createEmptyBodyRelationshipCandidate();
    oldData.stat_data.关系叙事.npc_alpha = createEmptyRelationshipNarrative();
    oldData.stat_data.会话.chat_1 = { 对象UID: 'npc_alpha', 状态: '已匹配', 最近消息: [], 已确认边界: '', 已确认承诺: '' };
    const built = buildPrivateChatPatch(oldData.stat_data, {
        sessionUid: 'chat_1', npcUid: 'npc_alpha', playerMessage: '我会尊重你的节奏。',
        response: {
            replies: ['谢谢，这让我很安心。'],
            relationship: { 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 },
            bondAssessment: { kind: 'friendly', intensity: 1, direction: 'increase' },
        },
    });
    assert.equal(built.ok, true);

    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
        getMvuData: () => oldData,
        parseMessage: async (_raw, data) => {
            calls.push('parse');
            const next = structuredClone(data);
            for (const operation of built.value) {
                const segments = decodeJsonPointer(operation.path);
                const key = segments.pop();
                let parent = next.stat_data;
                for (const segment of segments) parent = parent[segment];
                if (operation.op === 'add' && Array.isArray(parent) && key === '-') parent.push(structuredClone(operation.value));
                else parent[key] = structuredClone(operation.value);
            }
            delete next.stat_data.关系叙事.npc_alpha.进程.已消费事件ID;
            return next;
        },
        replaceMvuData: async () => calls.push('replace'),
    };

    const result = await applyControlledPatch({ patch: built.value, mvu, eventEmit: async () => calls.push('event'), diagnosticLogger: { error() {} } });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'no_change');
    assert.equal(result.code, 'mvu_relationship_narrative_schema_outdated');
    assert.equal(result.detail.path, '/关系叙事/npc_alpha/进程/已消费事件ID');
    assert.deepEqual(calls, ['parse']);
    assert.deepEqual(oldData.stat_data.关系叙事.npc_alpha.进程.已消费事件ID, []);
});

test('stripped B.2 body-candidate slot identifies an outdated schema without committing a partial parse', async () => {
    const calls = [];
    const oldData = { stat_data: stateFixture() };
    oldData.stat_data.角色池.npc_alpha = npc({ status: '已匹配' });
    oldData.stat_data.推荐.当前队列 = [];
    oldData.stat_data.推荐.临时候选池 = {};
    const built = buildBodyRelationshipCandidateBackfillPatch(oldData.stat_data);
    assert.deepEqual(built, {
        ok: true,
        value: [{ op: 'add', path: '/正文关系候选/npc_alpha', value: createEmptyBodyRelationshipCandidate() }],
    });

    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
        getMvuData: () => oldData,
        parseMessage: async (_raw, data) => {
            calls.push('parse');
            const next = structuredClone(data);
            // Simulate an older card schema that silently discards the B.2 slot
            // while still returning a superficially changed envelope.
            next.stat_data.面基记录 = {};
            return next;
        },
        replaceMvuData: async () => calls.push('replace'),
    };
    const result = await applyControlledPatch({ patch: built.value, mvu, eventEmit: async () => calls.push('event'), diagnosticLogger: { error() {} } });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'no_change');
    assert.equal(result.code, 'mvu_body_relationship_candidate_schema_outdated');
    assert.deepEqual(calls, ['parse']);
    assert.equal(Object.hasOwn(oldData.stat_data.正文关系候选, 'npc_alpha'), false);
});

test('stripped C.2 consent envelope identifies an outdated schema without committing a partial parse', async () => {
    const calls = [];
    const oldData = { stat_data: stateFixture() };
    oldData.stat_data.角色池.npc_alpha = npc({ status: '已匹配' });
    oldData.stat_data.会话.chat_1 = { 对象UID: 'npc_alpha', 状态: '已匹配', 最近消息: [], 已确认边界: '', 已确认承诺: '' };
    const built = buildPrivateChatNsfwConsentBackfillPatch(oldData.stat_data);
    assert.deepEqual(built, {
        ok: true,
        value: [{ op: 'add', path: '/会话/chat_1/NSFW同意', value: createEmptyNsfwConsent() }],
    });
    const diagnostics = [];
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
        getMvuData: () => oldData,
        parseMessage: async (_raw, data) => {
            calls.push('parse');
            const next = structuredClone(data);
            next.stat_data.面基记录 = {};
            return next;
        },
        replaceMvuData: async () => calls.push('replace'),
    };
    const result = await applyControlledPatch({
        patch: built.value,
        mvu,
        eventEmit: async () => calls.push('event'),
        diagnosticLogger: { error(...args) { diagnostics.push(args); } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'no_change');
    assert.equal(result.code, 'mvu_nsfw_consent_schema_outdated');
    assert.equal(result.detail.path, '/会话/chat_1/NSFW同意');
    assert.deepEqual(calls, ['parse']);
    assert.equal(Object.hasOwn(oldData.stat_data.会话.chat_1, 'NSFW同意'), false);
    assert.equal(diagnostics[0][1].code, 'mvu_nsfw_consent_schema_outdated');
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
    const diagnosticCalls = [];
    const result = await applyControlledPatch({
        patch, mvu, eventEmit: async () => calls.push('event'),
        diagnosticLogger: { error: (...args) => diagnosticCalls.push(args) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'no_change');
    assert.deepEqual(result.detail, {
        operationIndex: 0, operation: 'replace', path: '/软件/内容模式',
        kind: 'value_mismatch', expectedType: 'string', actualType: 'string',
    });
    assert.deepEqual(diagnosticCalls, [[
        '[约了吗][MVU 受控写入被拒绝]',
        { code: 'mvu_parse_postcondition_failed', phase: 'provider_postcondition', reason: 'MVU provider 返回字段值未按 Patch 更新', operationIndex: 0, operation: 'replace', path: '/软件/内容模式', kind: 'value_mismatch', expectedType: 'string', actualType: 'string' },
    ]]);
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
        对象UID: 'npc_alpha', 状态: '已匹配', 最近消息: [], 已确认边界: '', 已确认承诺: '',
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
    const result = await applyControlledPatch({ patch, mvu, eventEmit: async () => calls.push('event'), diagnosticLogger: { error() {} } });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'no_change');
    assert.equal(result.code, 'mvu_parse_postcondition_failed');
    assert.deepEqual(result.detail, {
        operationIndex: 0, operation: 'remove', path: '/会话/chat_1',
        kind: 'unexpected_key', expectedType: 'missing', actualType: 'object',
    });
    assert.deepEqual(calls, ['parse']);
});

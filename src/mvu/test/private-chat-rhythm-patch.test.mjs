import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClearPrivateChatPatch, buildDeleteCharacterPatch, buildPrivateChatPatch, validateControlledPatchAgainstState } from '../controlled-patch.js';
import { createEmptyRelationshipNarrative } from '../relationship-narrative.js';

function state({ readThreshold = 55, blockThreshold = 90, relationship } = {}) {
    return {
        系统: { UID计数器: { 角色: 1, 会话: 1, 面基: 0 } },
        软件: { 内容模式: 'SFW', 关于软件点击数: 0 },
        玩家: { 成人验证: true, 公开资料: {}, 仅好友资料: {}, 推荐偏好: { 标签权重: {} } },
        角色池: {
            npc_one: {
                成人验证: true, 公开资料: { 昵称: '林澈' }, 仅好友资料: {}, 隐藏资料: { 实际年龄: 26, 私人备注: '' },
                偏好与边界: '', 拒绝阈值: 40, 已读不回阈值: readThreshold, 取消匹配阈值: 70, 拉黑阈值: blockThreshold,
                与玩家关系: relationship ?? { 状态: '已匹配', 全局账号表现: 50, NPC专属匹配度: 70, 好感: 20, 信任: 10, 戒备: 15, 面基意愿: 0 },
            },
        },
        正文记忆: { npc_one: '' },
        关系叙事: { npc_one: createEmptyRelationshipNarrative() },
        会话: { chat_1: { 对象UID: 'npc_one', 状态: '已匹配', 最近消息: [], 已确认边界: '', 已确认承诺: '' } },
        推荐: { 当前队列: [], 临时候选池: {}, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
        面基记录: {},
    };
}

function response(relationship = { 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 }) {
    return { replies: ['第一条。', '第二条。'], relationship };
}

test('normal private chat appends each validated reply as its own bubble', () => {
    const current = state();
    const built = buildPrivateChatPatch(current, { sessionUid: 'chat_1', npcUid: 'npc_one', playerMessage: '你好', response: response() });
    assert.equal(built.ok, true);
    assert.deepEqual(built.value.slice(0, 3).map((operation) => operation.value.发送者), ['玩家', '角色', '角色']);
    assert.deepEqual(built.value.slice(1, 3).map((operation) => operation.value.内容), ['第一条。', '第二条。']);
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
});

test('private chat applies the global bounded decline and its turn/event lock in one controlled patch', () => {
    const current = state({
        relationship: {
            状态: '已匹配', 全局账号表现: 50, NPC专属匹配度: 70,
            好感: 20, 信任: 10, 戒备: 15, 面基意愿: 0,
            友情值: 30, 心动值: 40, 欲望值: 80,
        },
    });
    current.软件.内容模式 = 'NSFW';
    const built = buildPrivateChatPatch(current, {
        sessionUid: 'chat_1',
        npcUid: 'npc_one',
        playerMessage: '这句话越过了已经确认的边界',
        response: {
            ...response(),
            bondAssessment: { kind: 'sexual_desire', intensity: 3, direction: 'decrease' },
        },
    });
    assert.equal(built.ok, true);
    assert.equal(built.value.some((operation) => operation.path === '/角色池/npc_one/与玩家关系/欲望值' && operation.value === 76), true);
    assert.equal(built.value.some((operation) => operation.path === '/关系叙事/npc_one/进程/最后结算回合UID' && operation.value === 'msg_chat_1_p_1'), true);
    assert.deepEqual(
        built.value.find((operation) => operation.path === '/关系叙事/npc_one/进程/已消费事件ID')?.value,
        ['chat:1:1'],
    );
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
});

test('SFW threshold settlement writes only narrow protected progress leaves in the same transaction', () => {
    const current = state({
        relationship: {
            状态: '已匹配', 全局账号表现: 50, NPC专属匹配度: 70,
            好感: 20, 信任: 10, 戒备: 15, 面基意愿: 0,
            友情值: 19, 心动值: 0, 欲望值: 0,
        },
    });
    const built = buildPrivateChatPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', playerMessage: '我会按你的节奏来。',
        response: { ...response(), bondAssessment: { kind: 'friendly', intensity: 2, direction: 'increase' } },
    });
    assert.equal(built.ok, true);
    const progressOperations = built.value.filter((operation) => operation.path.startsWith('/关系叙事/npc_one/进程/'));
    assert.deepEqual(progressOperations, [
        { op: 'replace', path: '/关系叙事/npc_one/进程/最后结算回合UID', value: 'msg_chat_1_p_1' },
        { op: 'replace', path: '/关系叙事/npc_one/进程/已消费事件ID', value: ['chat:1:1'] },
        { op: 'replace', path: '/关系叙事/npc_one/进程/SFW细微裂缝已触发', value: true },
    ]);
    assert.equal(built.value.some((operation) => operation.path === '/角色池/npc_one/与玩家关系/友情值' && operation.value === 20), true);
    assert.equal(built.value.some((operation) => operation.path === '/关系叙事/npc_one'), false, 'never serialize protected life/wish records into a chat settlement');
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);

    const forgedTurn = structuredClone(built.value);
    forgedTurn.find((operation) => operation.path.endsWith('/最后结算回合UID')).value = 'msg_chat_1_p_999';
    assert.equal(validateControlledPatchAgainstState(current, forgedTurn).ok, false, 'only the locally generated turn UID may pass exact reconstruction');
    const forgedFlag = structuredClone(built.value);
    forgedFlag.find((operation) => operation.path.endsWith('/SFW细微裂缝已触发')).value = false;
    assert.equal(validateControlledPatchAgainstState(current, forgedFlag).ok, false, 'flags may never be reset by this path');
    assert.equal(validateControlledPatchAgainstState(current, [{ op: 'replace', path: '/关系叙事/npc_one/人生底色/完整理解', value: '越权' }]).ok, false);
});

test('private chat fails closed without a complete relationship narrative registry', () => {
    const current = state();
    delete current.关系叙事.npc_one;
    assert.deepEqual(
        buildPrivateChatPatch(current, { sessionUid: 'chat_1', npcUid: 'npc_one', playerMessage: '你好', response: response() }),
        { ok: false, code: 'mvu_relationship_narrative_schema_outdated', detail: '' },
    );
});

test('a recently repeated player message may receive a reply but cannot settle another relationship change', () => {
    const current = state({
        relationship: {
            状态: '已匹配', 全局账号表现: 50, NPC专属匹配度: 70,
            好感: 20, 信任: 10, 戒备: 15, 面基意愿: 0,
            友情值: 19, 心动值: 0, 欲望值: 0,
        },
    });
    current.会话.chat_1.最近消息 = [{
        消息UID: 'msg_chat_1_p_1', 发送者: '玩家', 内容: '我会按你的节奏来。', 时间: '', 层数: 1,
    }];
    current.会话.chat_1.对话层数 = 1;
    const built = buildPrivateChatPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', playerMessage: '我会按你的节奏来。',
        response: { ...response(), bondAssessment: { kind: 'friendly', intensity: 1, direction: 'increase' } },
    });
    assert.equal(built.ok, true);
    assert.equal(built.value.some((operation) => operation.path === '/角色池/npc_one/与玩家关系/友情值'), false);
    assert.equal(built.value.some((operation) => operation.path.startsWith('/关系叙事/npc_one/进程/')), false);
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
});

test('bounded transcript only trims an already summarized prefix and never drops pending layers', () => {
    const current = state();
    current.会话.chat_1.最近消息 = Array.from({ length: 240 }, (_, index) => ({
        消息UID: `m_${index + 1}`,
        发送者: index % 2 === 0 ? '玩家' : '角色',
        内容: `第${index + 1}条消息`,
        时间: '',
        层数: index + 1,
    }));
    current.会话.chat_1.对话层数 = 240;
    current.会话.chat_1.总结 = { 已总结消息UID: 'm_3', 总结序号: 1, 记录: [], 状态: '成功', 失败原因: '', 目标总结UID: '', 尝试次数: 1 };

    const built = buildPrivateChatPatch(current, { sessionUid: 'chat_1', npcUid: 'npc_one', playerMessage: '继续聊', response: response() });
    assert.equal(built.ok, true);
    assert.deepEqual(built.value.slice(0, 3).map((operation) => [operation.op, operation.path]), [
        ['remove', '/会话/chat_1/最近消息/0'],
        ['remove', '/会话/chat_1/最近消息/0'],
        ['remove', '/会话/chat_1/最近消息/0'],
    ]);
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);

    current.会话.chat_1.总结.已总结消息UID = 'm_2';
    const unsafe = buildPrivateChatPatch(current, { sessionUid: 'chat_1', npcUid: 'npc_one', playerMessage: '不能丢失未总结消息', response: response() });
    assert.deepEqual(unsafe, { ok: false, code: 'private_chat_history_requires_summary', detail: '' });
});

test('a fresh match first message replies even when the model reports mild wariness', () => {
    // 2026-07-27 校准回归防线：物化初值 20/10/15 + 默认阈值 55/90 的新会话，
    // 首条消息即使带轻微负向增量也必须得到回复，而不是已读不回。
    const current = state();
    const built = buildPrivateChatPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', playerMessage: '你好，很高兴匹配到你',
        response: response({ 好感: 1, 信任: 0, 戒备: 2, 面基意愿: 0 }),
    });
    assert.equal(built.ok, true);
    const messages = built.value.filter((operation) => operation.path === '/会话/chat_1/最近消息/-');
    assert.deepEqual(messages.map((operation) => operation.value.发送者), ['玩家', '角色', '角色']);
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
});

test('read-without-reply stores the player message and a fixed system notice only', () => {
    const current = state({
        relationship: { 状态: '已匹配', 全局账号表现: 50, NPC专属匹配度: 70, 好感: 5, 信任: 5, 戒备: 40, 面基意愿: 0 },
    });
    current.会话.chat_1.对话层数 = 12;
    const built = buildPrivateChatPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', playerMessage: '这次说得不太合适',
        response: response({ 好感: -10, 信任: 0, 戒备: 5, 面基意愿: 0 }),
    });
    assert.equal(built.ok, true);
    const messages = built.value.filter((operation) => operation.path === '/会话/chat_1/最近消息/-');
    assert.deepEqual(messages.map((operation) => operation.value.发送者), ['玩家', '系统']);
    assert.equal(messages[1].value.内容, '对方已读，但暂时没有回复。');
    assert.deepEqual(messages.map((operation) => operation.value.层数), [13, 13], '系统送达提示属于记录，但不应额外计入玩家/角色对话层数');
    assert.equal(built.value.at(-1).value, 13);
    assert.equal(built.value.some((operation) => operation.path.startsWith('/正文记忆/')), false);
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
});

test('positive deltas walk a strained chat back out of read-without-reply', () => {
    const current = state({
        relationship: { 状态: '已匹配', 全局账号表现: 50, NPC专属匹配度: 70, 好感: 5, 信任: 5, 戒备: 60, 面基意愿: 0 },
    });
    current.会话.chat_1.对话层数 = 12;
    const built = buildPrivateChatPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', playerMessage: '前几天是我不好，想认真道个歉',
        response: response({ 好感: 6, 信任: 6, 戒备: -8, 面基意愿: 0 }),
    });
    assert.equal(built.ok, true);
    const messages = built.value.filter((operation) => operation.path === '/会话/chat_1/最近消息/-');
    assert.deepEqual(messages.map((operation) => operation.value.发送者), ['玩家', '角色', '角色']);
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
});

test('early conversation grace downgrades a first-message block to read-without-reply', () => {
    // 生成侧失准（开局压力已超过拉黑阈值）时，宽限期内绝不允许直接拉黑。
    const current = state({
        relationship: { 状态: '已匹配', 全局账号表现: 50, NPC专属匹配度: 70, 好感: 20, 信任: 10, 戒备: 60, 面基意愿: 0 },
        readThreshold: 50,
        blockThreshold: 70,
    });
    const built = buildPrivateChatPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', playerMessage: '在吗？',
        response: response({ 好感: -10, 信任: -10, 戒备: 10, 面基意愿: 0 }),
    });
    assert.equal(built.ok, true);
    assert.equal(built.value.some((operation) => operation.path === '/会话/chat_1/状态'), false);
    const messages = built.value.filter((operation) => operation.path === '/会话/chat_1/最近消息/-');
    assert.deepEqual(messages.map((operation) => operation.value.发送者), ['玩家', '系统']);
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
});

test('block outcome atomically closes the session, records the block list and suppresses model text', () => {
    const current = state({
        relationship: { 状态: '已匹配', 全局账号表现: 50, NPC专属匹配度: 70, 好感: 0, 信任: 0, 戒备: 90, 面基意愿: 0 },
        readThreshold: 50,
        blockThreshold: 80,
    });
    current.会话.chat_1.对话层数 = 12;
    const built = buildPrivateChatPatch(current, { sessionUid: 'chat_1', npcUid: 'npc_one', playerMessage: '继续发消息', response: response() });
    assert.equal(built.ok, true);
    assert.equal(built.value.some((operation) => operation.path === '/会话/chat_1/状态' && operation.value === '已拉黑'), true);
    assert.equal(built.value.some((operation) => operation.path === '/角色池/npc_one/与玩家关系/状态' && operation.value === '已拉黑'), true);
    assert.equal(built.value.some((operation) => operation.path === '/推荐/拉黑角色UID/-' && operation.value === 'npc_one'), true);
    assert.equal(JSON.stringify(built.value).includes('第一条'), false);
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
});

test('clearing a matched private chat removes only the session and cancels the relationship', () => {
    const current = state();
    const built = buildClearPrivateChatPatch(current, { sessionUid: 'chat_1' });
    assert.deepEqual(built, { ok: true, value: [
        { op: 'remove', path: '/会话/chat_1' },
        { op: 'replace', path: '/角色池/npc_one/与玩家关系/状态', value: '已取消' },
    ] });
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
    const forged = structuredClone(built.value); forged[1].value = '已拉黑';
    assert.equal(validateControlledPatchAgainstState(current, forged).ok, false);
});

test('clearing an already blocked chat preserves the block relationship', () => {
    const current = state({ relationship: { 状态: '已拉黑', 全局账号表现: 50, NPC专属匹配度: 70, 好感: 0, 信任: 0, 戒备: 100, 面基意愿: 0 } });
    current.会话.chat_1.状态 = '已拉黑';
    const built = buildClearPrivateChatPatch(current, { sessionUid: 'chat_1' });
    assert.deepEqual(built, { ok: true, value: [{ op: 'remove', path: '/会话/chat_1' }] });
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
});

test('deleteCharacter removes the complete character record and every controlled reference', () => {
    const current = state();
    const otherRole = structuredClone(current.角色池.npc_one);
    otherRole.公开资料.昵称 = '其他角色';
    current.角色池.npc_other = otherRole;
    current.正文记忆.npc_other = '其他对象自己的经历';
    current.关系叙事.npc_other = createEmptyRelationshipNarrative();
    current.推荐 = {
        当前队列: ['npc_one', 'npc_other'],
        临时候选池: { npc_one: structuredClone(current.角色池.npc_one), npc_other: structuredClone(otherRole) },
        冷却角色UID: ['npc_other', 'npc_one'],
        收藏角色UID: ['npc_one'],
        不喜欢角色UID: ['npc_other', 'npc_one'],
        拉黑角色UID: ['npc_one', 'npc_other'],
    };
    current.会话.chat_2 = { 对象UID: 'npc_one', 状态: '已取消', 最近消息: [], 已确认边界: '', 已确认承诺: '' };
    current.会话.chat_other = { 对象UID: 'npc_other', 状态: '已匹配', 最近消息: [], 已确认边界: '', 已确认承诺: '' };
    current.面基记录 = {
        meetup_1: { 对象UID: 'npc_one', 状态: '已结束' },
        meetup_other: { 对象UID: 'npc_other', 状态: '已结束' },
    };
    current.群组 = {
        group_city: { 主题: '城市', 描述: '', 成员UID: ['npc_one', 'npc_other'], 可发现角色UID: ['npc_one'] },
        group_other: { 主题: '其他', 描述: '', 成员UID: ['npc_other'], 可发现角色UID: ['npc_other'] },
    };

    const built = buildDeleteCharacterPatch(current, { npcUid: 'npc_one' });
    assert.equal(built.ok, true);
    assert.deepEqual(built.value, [
        { op: 'replace', path: '/推荐/当前队列', value: ['npc_other'] },
        { op: 'replace', path: '/推荐/冷却角色UID', value: ['npc_other'] },
        { op: 'replace', path: '/推荐/收藏角色UID', value: [] },
        { op: 'replace', path: '/推荐/不喜欢角色UID', value: ['npc_other'] },
        { op: 'replace', path: '/推荐/拉黑角色UID', value: ['npc_other'] },
        { op: 'remove', path: '/会话/chat_1' },
        { op: 'remove', path: '/会话/chat_2' },
        { op: 'remove', path: '/面基记录/meetup_1' },
        { op: 'replace', path: '/群组/group_city/成员UID', value: ['npc_other'] },
        { op: 'replace', path: '/群组/group_city/可发现角色UID', value: [] },
        { op: 'remove', path: '/推荐/临时候选池/npc_one' },
        { op: 'remove', path: '/正文记忆/npc_one' },
        { op: 'remove', path: '/关系叙事/npc_one' },
        { op: 'remove', path: '/角色池/npc_one' },
    ]);
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);

    const missingReference = built.value.filter((operation) => operation.path !== '/面基记录/meetup_1');
    assert.equal(validateControlledPatchAgainstState(current, missingReference).ok, false);
    const forgedOtherRemoval = [...built.value, { op: 'remove', path: '/会话/chat_other' }];
    assert.equal(validateControlledPatchAgainstState(current, forgedOtherRemoval).ok, false);
    assert.deepEqual(current.系统.UID计数器, { 角色: 1, 会话: 1, 面基: 0 });
});

test('deleteCharacter refuses malformed containers instead of leaving partial references', () => {
    const malformed = state();
    malformed.群组 = { group_city: { 主题: '城市', 描述: '', 成员UID: ['npc_one', 'npc_one'], 可发现角色UID: [] } };
    assert.deepEqual(buildDeleteCharacterPatch(malformed, { npcUid: 'npc_one' }), {
        ok: false, code: 'character_delete_group_state_invalid', detail: 'group_city',
    });
});


test('deleteCharacter remains atomic when a role has more than forty references', () => {
    const current = state();
    current.群组 = {};
    for (let index = 2; index <= 45; index += 1) {
        current.会话['chat_' + index] = {
            对象UID: 'npc_one', 状态: '已取消', 最近消息: [], 已确认边界: '', 已确认承诺: '',
        };
    }
    const built = buildDeleteCharacterPatch(current, { npcUid: 'npc_one' });
    assert.equal(built.ok, true);
    assert.ok(built.value.length > 40);
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
    assert.equal(built.value.filter((operation) => operation.op === 'remove' && operation.path.startsWith('/会话/chat_')).length, 45);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDeletePrivateChatPatch, buildPrivateChatPatch, validateControlledPatchAgainstState } from '../controlled-patch.js';

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
        会话: { chat_1: { 对象UID: 'npc_one', 状态: '已匹配', 最近消息: [], 长期摘要: '', 已确认边界: '', 已确认承诺: '' } },
        推荐: { 当前队列: [], 临时候选池: {}, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
        面基记录: {},
    };
}

function response(relationship = { 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 }) {
    return { replies: ['第一条。', '第二条。'], relationship, sessionSummary: '不应在节奏抑制时写入。' };
}

test('normal private chat appends each validated reply as its own bubble', () => {
    const current = state();
    const built = buildPrivateChatPatch(current, { sessionUid: 'chat_1', npcUid: 'npc_one', playerMessage: '你好', response: response() });
    assert.equal(built.ok, true);
    assert.deepEqual(built.value.slice(0, 3).map((operation) => operation.value.发送者), ['玩家', '角色', '角色']);
    assert.deepEqual(built.value.slice(1, 3).map((operation) => operation.value.内容), ['第一条。', '第二条。']);
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
});

test('read-without-reply stores the player message and a fixed system notice only', () => {
    const current = state();
    const built = buildPrivateChatPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', playerMessage: '这次说得不太合适',
        response: response({ 好感: -10, 信任: 0, 戒备: 5, 面基意愿: 0 }),
    });
    assert.equal(built.ok, true);
    const messages = built.value.filter((operation) => operation.path === '/会话/chat_1/最近消息/-');
    assert.deepEqual(messages.map((operation) => operation.value.发送者), ['玩家', '系统']);
    assert.equal(messages[1].value.内容, '对方已读，但暂时没有回复。');
    assert.equal(built.value.some((operation) => operation.path === '/会话/chat_1/长期摘要'), false);
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
});

test('block outcome atomically closes the session, records the block list and suppresses model text', () => {
    const current = state({
        relationship: { 状态: '已匹配', 全局账号表现: 50, NPC专属匹配度: 70, 好感: 0, 信任: 0, 戒备: 90, 面基意愿: 0 },
        readThreshold: 50,
        blockThreshold: 80,
    });
    const built = buildPrivateChatPatch(current, { sessionUid: 'chat_1', npcUid: 'npc_one', playerMessage: '继续发消息', response: response() });
    assert.equal(built.ok, true);
    assert.equal(built.value.some((operation) => operation.path === '/会话/chat_1/状态' && operation.value === '已拉黑'), true);
    assert.equal(built.value.some((operation) => operation.path === '/角色池/npc_one/与玩家关系/状态' && operation.value === '已拉黑'), true);
    assert.equal(built.value.some((operation) => operation.path === '/推荐/拉黑角色UID/-' && operation.value === 'npc_one'), true);
    assert.equal(JSON.stringify(built.value).includes('第一条'), false);
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
});

test('deleting a matched private chat removes only the session and cancels the relationship', () => {
    const current = state();
    const built = buildDeletePrivateChatPatch(current, { sessionUid: 'chat_1' });
    assert.deepEqual(built, { ok: true, value: [
        { op: 'remove', path: '/会话/chat_1' },
        { op: 'replace', path: '/角色池/npc_one/与玩家关系/状态', value: '已取消' },
    ] });
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
    const forged = structuredClone(built.value); forged[1].value = '已拉黑';
    assert.equal(validateControlledPatchAgainstState(current, forged).ok, false);
});

test('deleting an already blocked chat preserves the block relationship', () => {
    const current = state({ relationship: { 状态: '已拉黑', 全局账号表现: 50, NPC专属匹配度: 70, 好感: 0, 信任: 0, 戒备: 100, 面基意愿: 0 } });
    current.会话.chat_1.状态 = '已拉黑';
    assert.deepEqual(buildDeletePrivateChatPatch(current, { sessionUid: 'chat_1' }), { ok: true, value: [{ op: 'remove', path: '/会话/chat_1' }] });
});

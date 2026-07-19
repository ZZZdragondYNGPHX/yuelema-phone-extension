import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrivateChatContext, generatePrivateChatReply } from '../private-chat-service.js';
import { buildPrivateChatPatch, validateControlledPatchAgainstState } from '../../mvu/controlled-patch.js';

function state() {
    return {
        系统: { UID计数器: { 角色: 1, 会话: 1, 面基: 0 } },
        软件: { 内容模式: 'NSFW', 关于软件点击数: 0 },
        玩家: {
            成人验证: true,
            公开资料: { 昵称: '玩家', 简介: '公开简介' },
            仅好友资料: { 关系状态: '单身', 边界与偏好: '先聊天再决定。' },
            隐藏资料: { 实际年龄: 24, 私人备注: '不得发送' },
        },
        角色池: {
            npc_adult: {
                成人验证: true,
                公开资料: { 昵称: '小满', 简介: '公开资料' },
                仅好友资料: { 关系状态: '开放关系', 边界与偏好: '先确认同意。' },
                隐藏资料: { 实际年龄: 28, 私人备注: '绝不泄露' },
                偏好与边界: '角色内部字段不得发送', 拒绝阈值: 20, 已读不回阈值: 30, 取消匹配阈值: 80, 拉黑阈值: 90,
                与玩家关系: { 状态: '已匹配', 全局账号表现: 60, NPC专属匹配度: 70, 好感: 30, 信任: 40, 戒备: 20, 面基意愿: 10 },
            },
        },
        推荐: { 当前队列: [], 临时候选池: {}, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
        会话: {
            chat_1: { 对象UID: 'npc_adult', 状态: '已匹配', 最近消息: [{ 消息UID: 'old', 发送者: '角色', 内容: '嗨', 时间: '' }], 长期摘要: '', 已确认边界: '', 已确认承诺: '' },
        },
        面基记录: {},
    };
}

function response() {
    return { reply: '晚上好，先聊聊彼此的周末？', relationship: { 好感: 2, 信任: 1, 戒备: -2, 面基意愿: 0 }, sessionSummary: '双方从周末安排开始轻松聊天。' };
}

test('private chat context includes public + matched friends-only data, never hidden or internal fields', () => {
    const built = buildPrivateChatContext({ state: state(), sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好' });
    assert.equal(built.ok, true);
    const serialized = JSON.stringify(built.context);
    assert.match(serialized, /公开资料/);
    assert.match(serialized, /开放关系/);
    assert.doesNotMatch(serialized, /绝不泄露|不得发送|角色内部字段|实际年龄|私人备注/);
    assert.equal(built.context.recentMessages.length, 1);
});

test('private chat rejects unmatched, forged, underage and malformed messages before any model request', () => {
    const unmatched = state(); unmatched.会话.chat_1.状态 = '请求中';
    assert.equal(buildPrivateChatContext({ state: unmatched, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '你好' }).ok, false);
    const underage = state(); underage.角色池.npc_adult.隐藏资料.实际年龄 = 17;
    assert.equal(buildPrivateChatContext({ state: underage, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '你好' }).ok, false);
    assert.equal(buildPrivateChatContext({ state: state(), sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '<b>你好</b>' }).ok, false);
    assert.equal(buildPrivateChatContext({ state: state(), sessionUid: 'chat_1', npcUid: 'npc_other', playerMessage: '你好' }).ok, false);
});

test('private chat model reply uses chat binding and returns only validated in-memory data', async () => {
    let request;
    const result = await generatePrivateChatReply({
        state: state(), sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好',
        settingsStore: { resolveFunction(key) { assert.equal(key, 'chat'); return { connectionPreset: { id: 'fast', url: 'https://example.test/v1', model: 'model' }, promptPreset: { enabled: true, content: '保持简短。' } }; } },
        llmClient: { async chat(input) { request = input; return { text: JSON.stringify(response()) }; } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.response.reply, response().reply);
    assert.match(request.messages[0].content, /保持简短/);
    assert.doesNotMatch(JSON.stringify(request.messages), /绝不泄露|不得发送|实际年龄/);
});

test('private chat patch is exact, atomic, clamps relationship and only updates nonzero values', () => {
    const current = state();
    const before = structuredClone(current);
    const built = buildPrivateChatPatch(current, { sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', response: response() });
    assert.equal(built.ok, true);
    assert.deepEqual(built.value.map((operation) => operation.path), [
        '/会话/chat_1/最近消息/-', '/会话/chat_1/最近消息/-',
        '/角色池/npc_adult/与玩家关系/好感', '/角色池/npc_adult/与玩家关系/信任', '/角色池/npc_adult/与玩家关系/戒备',
        '/会话/chat_1/长期摘要',
    ]);
    assert.equal(built.value[2].value, 32);
    assert.equal(built.value[4].value, 18);
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
    assert.deepEqual(current, before);
});

test('private chat patch rejects unsafe or stale operations before parse', () => {
    const current = state();
    const built = buildPrivateChatPatch(current, { sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', response: response() });
    const forged = structuredClone(built.value); forged[1].path = '/会话/chat_1/隐藏资料';
    assert.equal(validateControlledPatchAgainstState(current, forged).ok, false);
    const stale = state(); stale.角色池.npc_adult.与玩家关系.状态 = '已取消';
    assert.equal(buildPrivateChatPatch(stale, { sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', response: response() }).ok, false);
});



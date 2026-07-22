import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClearPrivateChatPatch, buildDeleteCharacterPatch, buildDeletePrivateChatPatch, buildPrivateChatPatch, validateControlledPatchAgainstState } from '../controlled-patch.js';

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
    assert.deepEqual(messages.map((operation) => operation.value.层数), [1, 1], '系统送达提示属于记录，但不应额外计入玩家/角色对话层数');
    assert.equal(built.value.at(-1).value, 1);
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
    assert.deepEqual(buildDeletePrivateChatPatch(current, { sessionUid: 'chat_1' }), { ok: true, value: [{ op: 'remove', path: '/会话/chat_1' }] });
});


test('legacy private-chat deletion builder remains an alias for clearPrivateChat', () => {
    const current = state();
    assert.deepEqual(
        buildDeletePrivateChatPatch(current, { sessionUid: 'chat_1' }),
        buildClearPrivateChatPatch(current, { sessionUid: 'chat_1' }),
    );
});

test('deleteCharacter removes the complete character record and every controlled reference', () => {
    const current = state();
    const otherRole = structuredClone(current.角色池.npc_one);
    otherRole.公开资料.昵称 = '其他角色';
    current.角色池.npc_other = otherRole;
    current.推荐 = {
        当前队列: ['npc_one', 'npc_other'],
        临时候选池: { npc_one: structuredClone(current.角色池.npc_one), npc_other: structuredClone(otherRole) },
        冷却角色UID: ['npc_other', 'npc_one'],
        收藏角色UID: ['npc_one'],
        不喜欢角色UID: ['npc_other', 'npc_one'],
        拉黑角色UID: ['npc_one', 'npc_other'],
    };
    current.会话.chat_2 = { 对象UID: 'npc_one', 状态: '已取消', 最近消息: [], 长期摘要: '', 已确认边界: '', 已确认承诺: '' };
    current.会话.chat_other = { 对象UID: 'npc_other', 状态: '已匹配', 最近消息: [], 长期摘要: '', 已确认边界: '', 已确认承诺: '' };
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
            对象UID: 'npc_one', 状态: '已取消', 最近消息: [], 长期摘要: '', 已确认边界: '', 已确认承诺: '',
        };
    }
    const built = buildDeleteCharacterPatch(current, { npcUid: 'npc_one' });
    assert.equal(built.ok, true);
    assert.ok(built.value.length > 40);
    assert.equal(validateControlledPatchAgainstState(current, built.value).ok, true);
    assert.equal(built.value.filter((operation) => operation.op === 'remove' && operation.path.startsWith('/会话/chat_')).length, 45);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildPrivateChatSummaryFailurePatch,
    buildPrivateChatSummaryPatch,
    validateControlledPatchAgainstState,
} from '../controlled-patch.js';

function summaryState() {
    return {
        系统: { UID计数器: { 角色: 1, 会话: 1, 面基: 0 } },
        软件: { 内容模式: 'SFW', 关于软件点击数: 0 },
        玩家: { 成人验证: true, 公开资料: {}, 仅好友资料: {}, 推荐偏好: { 标签权重: {} } },
        角色池: {
            npc_one: {
                成人验证: true, 公开资料: { 昵称: '林澈' }, 仅好友资料: {}, 隐藏资料: { 实际年龄: 26, 私人备注: '' },
                偏好与边界: '', 拒绝阈值: 40, 已读不回阈值: 55, 取消匹配阈值: 70, 拉黑阈值: 90,
                与玩家关系: { 状态: '已匹配', 全局账号表现: 50, NPC专属匹配度: 70, 好感: 20, 信任: 10, 戒备: 15, 面基意愿: 0 },
            },
        },
        会话: {
            chat_1: {
                对象UID: 'npc_one', 状态: '已匹配', 对话层数: 3,
                最近消息: [
                    { 消息UID: 'm_1', 发送者: '玩家', 内容: '周末想去看展。', 时间: '', 层数: 1 },
                    { 消息UID: 'm_2', 发送者: '角色', 内容: '我也喜欢看展。', 时间: '', 层数: 2 },
                    { 消息UID: 'm_3', 发送者: '玩家', 内容: '那先约周六下午。', 时间: '', 层数: 3 },
                ],
                长期摘要: '', 已确认边界: '', 已确认承诺: '',
                总结: { 已总结消息UID: '', 总结序号: 0, 记录: [], 状态: '空闲', 失败原因: '', 目标总结UID: '', 尝试次数: 0 },
            },
        },
        推荐: { 当前队列: [], 临时候选池: {}, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
        面基记录: {},
    };
}

test('conversation summary writes a bounded exact message prefix through one controlled MVU patch', () => {
    const current = summaryState();
    const built = buildPrivateChatSummaryPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one',
        summary: '双方确认都喜欢看展，正在商量周六下午的安排。',
        sourceMessageUids: ['m_1', 'm_2'],
        attempts: 1,
    });

    assert.equal(built.ok, true);
    assert.equal(built.value.summaryUid, 'summary_1');
    assert.equal(built.value.remainingMessageCount, 1);
    assert.deepEqual(built.value.patch.map((operation) => [operation.op, operation.path]), [['add', '/会话/chat_1/总结']]);
    assert.deepEqual(built.value.patch[0].value.记录[0], {
        总结UID: 'summary_1', 起始消息UID: 'm_1', 结束消息UID: 'm_2',
        起始层数: 1, 结束层数: 2,
        内容: '双方确认都喜欢看展，正在商量周六下午的安排。', 时间: '',
    });
    assert.equal(validateControlledPatchAgainstState(current, built.value.patch).ok, true);

    const forged = structuredClone(built.value.patch);
    forged[0].value.记录[0].结束消息UID = 'm_3';
    assert.equal(validateControlledPatchAgainstState(current, forged).ok, false);
});

test('conversation summary re-summary is anchored to a persisted record and failures remain retry-safe', () => {
    const current = summaryState();
    const first = buildPrivateChatSummaryPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', summary: '原总结。', sourceMessageUids: ['m_1', 'm_2'], attempts: 1,
    });
    current.会话.chat_1.总结 = structuredClone(first.value.patch[0].value);

    const retry = buildPrivateChatSummaryPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', summary: '改写后的总结，保留已明确的看展安排。',
        summaryUid: 'summary_1', sourceMessageUids: ['m_1', 'm_2'], attempts: 2,
    });
    assert.equal(retry.ok, true);
    assert.equal(retry.value.patch[0].value.记录.length, 1);
    assert.equal(retry.value.patch[0].value.记录[0].内容, '改写后的总结，保留已明确的看展安排。');
    assert.equal(validateControlledPatchAgainstState(current, retry.value.patch).ok, true);

    const stale = buildPrivateChatSummaryPatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', summary: '不应写入。', summaryUid: 'summary_1', sourceMessageUids: ['m_1', 'm_3'], attempts: 2,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'chat_summary_source_changed');

    const failure = buildPrivateChatSummaryFailurePatch(current, {
        sessionUid: 'chat_1', npcUid: 'npc_one', reason: '模型响应格式无效。', attempts: 2,
    });
    assert.equal(failure.ok, true);
    assert.equal(failure.value.patch[0].value.状态, '失败');
    assert.equal(failure.value.patch[0].value.失败原因, '模型响应格式无效。');
    assert.equal(validateControlledPatchAgainstState(current, failure.value.patch).ok, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isConversationSummaryDue,
    countUnsummarizedConversationLayers,
    listConversationSummaryRecords,
    listUnsummarizedConversationMessages,
    normalizeChatSummarySettings,
    normalizeGeneratedConversationSummary,
    summaryRecordSource,
} from '../conversation-summary.js';

function session() {
    return {
        对话层数: 5,
        最近消息: [
            { 消息UID: 'm1', 发送者: '玩家', 内容: '第一层', 时间: '', 层数: 1 },
            { 消息UID: 'm2', 发送者: '角色', 内容: '第二层', 时间: '', 层数: 2 },
            { 消息UID: 'm3', 发送者: '玩家', 内容: '第三层', 时间: '', 层数: 3 },
            { 消息UID: 'm4', 发送者: '角色', 内容: '第四层', 时间: '', 层数: 4 },
            { 消息UID: 'm5', 发送者: '玩家', 内容: '第五层', 时间: '', 层数: 5 },
        ],
        总结: {
            已总结消息UID: 'm2', 总结序号: 1,
            记录: [{ 总结UID: 'summary_1', 起始消息UID: 'm1', 结束消息UID: 'm2', 起始层数: 1, 结束层数: 2, 内容: '双方完成了开场问候。', 时间: '' }],
            状态: '成功', 失败原因: '', 目标总结UID: '', 尝试次数: 1,
        },
    };
}

test('summary configuration validates a bounded toggle, message interval, and retry count', () => {
    assert.deepEqual(normalizeChatSummarySettings({ enabled: true, interval: 12, retryLimit: 3 }), { enabled: true, interval: 12, retryLimit: 3 });
    assert.equal(normalizeChatSummarySettings({ enabled: true, interval: 1, retryLimit: 3 }), null);
    assert.equal(normalizeChatSummarySettings({ enabled: true, interval: 12, retryLimit: 6 }), null);
    assert.equal(normalizeChatSummarySettings({ enabled: true, interval: 12, retryLimit: 3, extra: true }), null);
});

test('summary state keeps only unsummarized suffixes and exact historical record sources', () => {
    const current = session();
    assert.deepEqual(listConversationSummaryRecords(current).map((record) => record.uid), ['summary_1']);
    assert.deepEqual(listUnsummarizedConversationMessages(current).map((message) => message.uid), ['m3', 'm4', 'm5']);
    assert.equal(isConversationSummaryDue(current, 3), true);
    assert.equal(isConversationSummaryDue(current, 4), false);
    const historical = summaryRecordSource(current, 'summary_1');
    assert.equal(historical.ok, true);
    assert.deepEqual(historical.messages.map((message) => message.uid), ['m1', 'm2']);
});

test('fixed system notices remain in the summary source but do not count as player/character dialogue layers', () => {
    const current = session();
    current.总结.已总结消息UID = 'm5';
    current.最近消息.push(
        { 消息UID: 'm6', 发送者: '玩家', 内容: '第六层', 时间: '', 层数: 6 },
        { 消息UID: 'm7', 发送者: '系统', 内容: '对方已读，但暂时没有回复。', 时间: '', 层数: 6 },
    );
    current.对话层数 = 6;
    assert.equal(listUnsummarizedConversationMessages(current).length, 2);
    assert.equal(countUnsummarizedConversationLayers(current), 1);
    assert.equal(isConversationSummaryDue(current, 2), false);
});

test('generated summary text rejects markup and credentials before it can reach MVU or the UI', () => {
    assert.equal(normalizeGeneratedConversationSummary({ summary: '双方确认下周继续聊电影。' }), '双方确认下周继续聊电影。');
    assert.equal(normalizeGeneratedConversationSummary({ summary: '<b>不安全</b>' }), null);
    assert.equal(normalizeGeneratedConversationSummary({ summary: 'api key 是不应出现的内容。' }), null);
});

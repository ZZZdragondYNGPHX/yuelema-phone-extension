import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createDefaultRealisticChatState,
    latestPlayerMessageUid,
    listPendingRealisticPlayerMessages,
    projectRealisticChatState,
    validateRealisticChatState,
} from '../realistic-chat.js';

function message(uid, sender, content, time = '2026-08-02 12:00') {
    return { 消息UID: uid, 发送者: sender, 内容: content, 时间: time, 层数: 1 };
}

test('拟真聊天状态严格校验并只投影调度元数据', () => {
    const state = createDefaultRealisticChatState({ enabled: true, latestPlayerMessageUid: 'msg_chat_a_p_1', proactiveAt: '2026-08-02 13:00' });
    state.待投递消息.push({
        消息UID: 'msg_chat_a_n_2', 发送者: '角色', 内容: '等我一会儿', 时间: '2026-08-02 12:10',
        批次UID: 'batch_chat_a_reply_msg_chat_a_p_1',
    });
    assert.equal(validateRealisticChatState(state).ok, true);
    assert.deepEqual(projectRealisticChatState(state), {
        supported: true, enabled: true, pendingCount: 1, nextDeliveryAt: '2026-08-02 12:10',
        replyDueAt: '', proactiveDueAt: '2026-08-02 13:00',
    });
    assert.equal(JSON.stringify(projectRealisticChatState(state)).includes('等我一会儿'), false, '普通 UI 投影不得包含待投递正文');
});

test('关闭状态不得残留触发时间或待投递消息', () => {
    const state = createDefaultRealisticChatState();
    state.回复触发时间 = '2026-08-02 12:10';
    assert.equal(validateRealisticChatState(state).ok, false);
});

test('从最近处理玩家消息之后收集最多六条、合计六百字的消息簇', () => {
    const session = {
        最近消息: [
            message('msg_chat_a_p_1', '玩家', '旧消息'),
            message('msg_chat_a_n_2', '角色', '旧回复'),
            message('msg_chat_a_p_3', '玩家', '第一条'),
            message('msg_chat_a_p_4', '玩家', '第二条'),
        ],
        拟真聊天: createDefaultRealisticChatState({ enabled: true, latestPlayerMessageUid: 'msg_chat_a_p_1', proactiveAt: '2026-08-02 13:00' }),
    };
    const result = listPendingRealisticPlayerMessages(session);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.map((item) => item.content), ['第一条', '第二条']);
    assert.equal(latestPlayerMessageUid(session), 'msg_chat_a_p_4');
});

test('标记丢失、超量消息簇和危险待投递结构均失败关闭', () => {
    const session = {
        最近消息: Array.from({ length: 7 }, (_, index) => message(`msg_chat_a_p_${index + 1}`, '玩家', 'x')),
        拟真聊天: createDefaultRealisticChatState({ enabled: true, proactiveAt: '2026-08-02 13:00' }),
    };
    assert.equal(listPendingRealisticPlayerMessages(session).code, 'private_chat_realistic_player_burst_full');
    session.拟真聊天.最近处理玩家消息UID = 'msg_chat_a_p_99';
    assert.equal(listPendingRealisticPlayerMessages(session).code, 'private_chat_realistic_marker_missing');
    const unsafe = createDefaultRealisticChatState({ enabled: true, proactiveAt: '2026-08-02 13:00' });
    unsafe.待投递消息 = [{ __proto__: null }];
    assert.equal(validateRealisticChatState(unsafe).ok, false);
});

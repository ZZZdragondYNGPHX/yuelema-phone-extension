import test from 'node:test';
import assert from 'node:assert/strict';
import { YueLeMaLlmError } from '../../llm/openai-compatible-client.js';
import { buildPrivateChatContext, consumePrivateChatDiagnostics, generatePrivateChatReply, generatePrivateChatSummary } from '../private-chat-service.js';
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
                偏好与边界: '角色内部字段不得发送', 拒绝阈值: 20, 已读不回阈值: 55, 取消匹配阈值: 80, 拉黑阈值: 90,
                与玩家关系: { 状态: '已匹配', 全局账号表现: 60, NPC专属匹配度: 70, 好感: 30, 信任: 40, 戒备: 20, 面基意愿: 10 },
            },
        },
        推荐: { 当前队列: [], 临时候选池: {}, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
        会话: {
            chat_1: {
                对象UID: 'npc_adult', 状态: '已匹配',
                最近消息: [{ 消息UID: 'old', 发送者: '角色', 内容: '嗨', 时间: '', 层数: 1 }],
                长期摘要: '', 对话层数: 1,
                总结: { 已总结消息UID: '', 总结序号: 0, 记录: [], 状态: '空闲', 失败原因: '', 目标总结UID: '', 尝试次数: 0 },
                已确认边界: '', 已确认承诺: '',
            },
        },
        面基记录: {},
    };
}

function response() {
    return {
        replies: ['晚上好。', '先聊聊彼此的周末？'],
        relationship: { 好感: 2, 信任: 1, 戒备: -2, 面基意愿: 0 },
        sessionSummary: '双方从周末安排开始轻松聊天。',
    };
}


function settingsStore() {
    return {
        resolveFunction(key) {
            assert.equal(key, 'chat');
            return {
                connectionPreset: { id: 'fast', url: 'https://example.test/v1', model: 'model' },
                promptPreset: { enabled: true, content: '保持简短。' },
            };
        },
    };
}

function summarySettingsStore() {
    return {
        getChatSummarySettings() { return { enabled: true, interval: 2, retryLimit: 1 }; },
        resolveFunction(key) {
            assert.equal(key, 'chat_summary');
            return {
                connectionPreset: { id: 'summary', url: 'https://example.test/v1', model: 'model' },
                promptPreset: { enabled: true, content: '只记录已经明确说过的内容。' },
            };
        },
    };
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

test('private chat context sends full retained history when summaries are off, or records plus only pending messages when on', () => {
    const current = state();
    current.会话.chat_1.最近消息 = Array.from({ length: 30 }, (_, index) => ({
        消息UID: `m_${index + 1}`,
        发送者: index % 2 === 0 ? '玩家' : '角色',
        内容: `第${index + 1}层聊天`,
        时间: '',
        层数: index + 1,
    }));
    current.会话.chat_1.对话层数 = 30;
    current.会话.chat_1.总结 = {
        已总结消息UID: 'm_20', 总结序号: 1,
        记录: [{ 总结UID: 'summary_1', 起始消息UID: 'm_1', 结束消息UID: 'm_20', 起始层数: 1, 结束层数: 20, 内容: '前二十层已聊过周末安排。', 时间: '' }],
        状态: '成功', 失败原因: '', 目标总结UID: '', 尝试次数: 1,
    };

    const full = buildPrivateChatContext({ state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '继续聊', summaryEnabled: false });
    assert.equal(full.ok, true);
    assert.equal(full.context.contextStrategy, 'full_retained_history');
    assert.equal(full.context.recentMessages.length, 30);
    assert.equal(Object.hasOwn(full.context, 'summaryRecords'), false);

    const summarized = buildPrivateChatContext({ state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '继续聊', summaryEnabled: true });
    assert.equal(summarized.ok, true);
    assert.equal(summarized.context.contextStrategy, 'summary_records_plus_unsummarized_messages');
    assert.deepEqual(summarized.context.summaryRecords, [{ range: '第1-20层', content: '前二十层已聊过周末安排。' }]);
    assert.equal(summarized.context.unsummarizedMessages.length, 10);
    assert.equal(Object.hasOwn(summarized.context, 'recentMessages'), false);
});

test('private chat rejects unmatched, forged, underage and malformed messages before any model request', () => {
    const unmatched = state(); unmatched.会话.chat_1.状态 = '请求中';
    assert.equal(buildPrivateChatContext({ state: unmatched, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '你好' }).ok, false);
    const underage = state(); underage.角色池.npc_adult.隐藏资料.实际年龄 = 17;
    assert.equal(buildPrivateChatContext({ state: underage, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '你好' }).ok, false);
    assert.equal(buildPrivateChatContext({ state: state(), sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '<b>你好</b>' }).ok, false);
    assert.equal(buildPrivateChatContext({ state: state(), sessionUid: 'chat_1', npcUid: 'npc_other', playerMessage: '你好' }).ok, false);
});

test('private chat requests replies and returns only validated multi-bubble data in memory', async () => {
    let request;
    const current = state();
    const before = structuredClone(current);
    const result = await generatePrivateChatReply({
        state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', settingsStore: settingsStore(),
        llmClient: { async chat(input) { request = input; return { text: JSON.stringify(response()) }; } },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.response.replies, response().replies);
    assert.match(request.messages[0].content, /保持简短/);
    assert.match(request.messages[0].content, /"replies"/);
    assert.match(request.messages[0].content, /1-6/);
    assert.doesNotMatch(JSON.stringify(request.messages), /绝不泄露|不得发送|实际年龄/);
    assert.deepEqual(current, before);
});

test('NSFW core contract permits consensual adult chat without treating explicitness as local block pressure', async () => {
    let request;
    const result = await generatePrivateChatReply({
        state: state(), sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '我想和你聊些更亲密的事，可以吗？', settingsStore: settingsStore(),
        llmClient: {
            async chat(input) {
                request = input;
                return { text: JSON.stringify({
                    replies: ['可以，我们按彼此舒服的节奏来。'],
                    relationship: { 好感: 1, 信任: 1, 戒备: 0, 面基意愿: 0 },
                    bondAssessment: { kind: 'sexual_desire', intensity: 1 },
                }) };
            },
        },
    });
    assert.equal(result.ok, true);
    assert.equal(result.response.relationship.戒备, 0);
    assert.match(request.messages[0].content, /成人话题尊重已知边界/u);
    assert.match(request.messages[0].content, /直白或露骨本身不是冒犯/u);
    assert.match(request.messages[0].content, /不得仅因内容成人化降低好感或信任、提高戒备/u);
    assert.match(request.messages[0].content, /明确的拒绝或撤回同意、已知边界冲突、胁迫、非自愿、隐私侵犯/u);
    assert.match(request.messages[0].content, /同意或边界不清时应先用线上文字澄清/u);
});

test('private chat summary uses its dedicated preset and returns only validated in-memory text and anchors', async () => {
    const current = state();
    let request;
    const result = await generatePrivateChatSummary({
        state: current,
        sessionUid: 'chat_1',
        npcUid: 'npc_adult',
        settingsStore: summarySettingsStore(),
        llmClient: {
            async chat(input) {
                request = input;
                return { text: '{"summary":"双方礼貌打招呼，并准备继续聊周末安排。"}' };
            },
        },
    });
    assert.equal(result.ok, true);
    assert.equal(result.summary, '双方礼貌打招呼，并准备继续聊周末安排。');
    assert.deepEqual(result.source, { messageUids: ['old'], summaryUid: '' });
    assert.match(request.messages[0].content, /连续摘要/u);
    assert.doesNotMatch(JSON.stringify(request.messages), /绝不泄露|不得发送|实际年龄|私人备注/u);
});

test('private chat rejects unsafe multi-bubble model output without writes or source echo', async () => {
    const current = state();
    const before = structuredClone(current);
    const result = await generatePrivateChatReply({
        state: current, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', settingsStore: settingsStore(),
        llmClient: { async chat() { return { text: JSON.stringify({ ...response(), replies: ['<script>MODEL_SECRET</script>'] }) }; } },
    });
    assert.deepEqual(result, {
        ok: false,
        code: 'private_chat_response_reply_invalid',
        message: '私聊文本不符合安全格式。',
    });
    assert.equal(JSON.stringify(result).includes('MODEL_SECRET'), false);
    assert.deepEqual(current, before);
});

test('private chat patch consumes the canonical multi-bubble response', () => {
    const current = state();
    const before = structuredClone(current);
    const built = buildPrivateChatPatch(current, { sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', response: response() });
    assert.equal(built.ok, true);
    assert.deepEqual(built.value.map((operation) => operation.path), [
        '/会话/chat_1/最近消息/-', '/会话/chat_1/最近消息/-', '/会话/chat_1/最近消息/-',
        '/角色池/npc_adult/与玩家关系/好感', '/角色池/npc_adult/与玩家关系/信任', '/角色池/npc_adult/与玩家关系/戒备',
        '/会话/chat_1/对话层数',
    ]);
    assert.equal(built.value[1].value.内容, '晚上好。');
    assert.equal(built.value[2].value.内容, '先聊聊彼此的周末？');
    assert.equal(built.value[3].value, 32);
    assert.equal(built.value[5].value, 18);
    assert.equal(built.value.at(-1).value, 4);
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


// —— 阶段 77：安全控制台诊断带出通道 ——

test('llm transport failures leave a consumable diagnostic with stage, code and HTTP status', async () => {
    consumePrivateChatDiagnostics('private_chat', 'chat_1');
    const result = await generatePrivateChatReply({
        state: state(), sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', settingsStore: settingsStore(),
        llmClient: { async chat() { throw new YueLeMaLlmError('SERVER_ERROR', '模型服务暂时不可用，请稍后重试。', { status: 502, retryable: true }); } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SERVER_ERROR');
    const records = consumePrivateChatDiagnostics('private_chat', 'chat_1');
    assert.equal(records.length, 1);
    assert.equal(records[0].stage, '模型请求');
    assert.equal(records[0].code, 'SERVER_ERROR');
    assert.equal(records[0].error.status, 502);
    assert.equal(records[0].error.name, 'YueLeMaLlmError');
    // 消费即清空
    assert.equal(consumePrivateChatDiagnostics('private_chat', 'chat_1').length, 0);
});

test('relationship delta violations report only the field name and range, never the model value', async () => {
    consumePrivateChatDiagnostics('private_chat', 'chat_1');
    const result = await generatePrivateChatReply({
        state: state(), sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', settingsStore: settingsStore(),
        llmClient: { async chat() { return { text: JSON.stringify({ ...response(), relationship: { 好感: 97, 信任: 1, 戒备: 0, 面基意愿: 0 } }) }; } },
    });
    assert.equal(result.code, 'private_chat_response_relationship_invalid');
    const records = consumePrivateChatDiagnostics('private_chat', 'chat_1');
    assert.equal(records.length, 1);
    assert.equal(records[0].stage, '响应校验');
    assert.equal(records[0].field, 'relationship.好感');
    assert.match(records[0].expected, /-10\.\.10/u);
    // 硬线：模型给的越界增量数值绝不进入诊断记录
    assert.doesNotMatch(JSON.stringify(records), /97/u);
    // 超长错误码按空格分词呈现，避免控制台脱敏器把它当作凭据 token
    assert.equal(records[0].code, 'private chat response relationship invalid');
});

test('bondAssessment whitelist violations name the field and allowed kinds without conversation text', async () => {
    consumePrivateChatDiagnostics('private_chat', 'chat_1');
    const sfwState = state();
    sfwState.软件.内容模式 = 'SFW';
    const result = await generatePrivateChatReply({
        state: sfwState, sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', settingsStore: settingsStore(),
        llmClient: { async chat() { return { text: JSON.stringify({ ...response(), bondAssessment: { kind: 'sexual_desire', intensity: 2 } }) }; } },
    });
    assert.equal(result.code, 'private_chat_response_relationship_invalid');
    const records = consumePrivateChatDiagnostics('private_chat', 'chat_1');
    assert.equal(records[0].field, 'bondAssessment.kind');
    assert.match(records[0].expected, /SFW 白名单/u);
    assert.equal(records[0].actual, 'sexual_desire');
    assert.doesNotMatch(JSON.stringify(records), /晚上好/u);
});

test('unparsable model output records only response length, never the raw text', async () => {
    consumePrivateChatDiagnostics('private_chat', 'chat_1');
    const result = await generatePrivateChatReply({
        state: state(), sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好', settingsStore: settingsStore(),
        llmClient: { async chat() { return { text: 'MODEL_RAW_LEAK not json' }; } },
    });
    assert.equal(result.code, 'private_chat_invalid_json');
    const records = consumePrivateChatDiagnostics('private_chat', 'chat_1');
    assert.equal(records[0].stage, '响应解析');
    assert.match(records[0].actual, /响应长度 \d+ 字符/u);
    assert.doesNotMatch(JSON.stringify(records), /MODEL_RAW_LEAK/u);
});

test('missing chat connection preset leaves a connection-stage diagnostic', async () => {
    consumePrivateChatDiagnostics('private_chat', 'chat_1');
    const result = await generatePrivateChatReply({
        state: state(), sessionUid: 'chat_1', npcUid: 'npc_adult', playerMessage: '晚上好',
        settingsStore: { resolveFunction() { return { connectionPreset: null, promptPreset: null }; } },
        llmClient: { async chat() { throw new Error('must not be called'); } },
    });
    assert.equal(result.code, 'private_chat_connection_missing');
    const records = consumePrivateChatDiagnostics('private_chat', 'chat_1');
    assert.equal(records[0].stage, '连接检查');
    assert.equal(records[0].code, 'private_chat_connection_missing');
});

test('summary retries accumulate one diagnostic per attempt under the chat_summary scope', async () => {
    consumePrivateChatDiagnostics('chat_summary', 'chat_1');
    const runFailing = () => generatePrivateChatSummary({
        state: state(), sessionUid: 'chat_1', npcUid: 'npc_adult', settingsStore: summarySettingsStore(),
        llmClient: { async chat() { throw new YueLeMaLlmError('TIMEOUT', '模型请求超时，请稍后重试。', { retryable: true }); } },
    });
    await runFailing();
    await runFailing();
    const records = consumePrivateChatDiagnostics('chat_summary', 'chat_1');
    assert.equal(records.length, 2);
    assert.equal(records[0].code, 'TIMEOUT');
    assert.equal(records[1].stage, '模型请求');
    // 私聊与总结两个作用域互不串扰
    assert.equal(consumePrivateChatDiagnostics('private_chat', 'chat_1').length, 0);
});

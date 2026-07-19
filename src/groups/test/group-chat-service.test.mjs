import test from 'node:test';
import assert from 'node:assert/strict';
import { YueLeMaLlmError } from '../../llm/openai-compatible-client.js';
import { buildGroupChatContext, generateGroupChatReply } from '../group-chat-service.js';

function promptPreset(entries) {
    return {
        enabled: true,
        name: '聊天群规则',
        content: JSON.stringify({ schema: 'yuelema.prompt-entries', schemaVersion: 1, entries }),
    };
}

function state() {
    return {
        软件: { 内容模式: 'NSFW' },
        玩家: {
            公开资料: { 昵称: '玩家', 城市: '上海', 简介: '只分享公开兴趣', 兴趣标签: ['电影'] },
            仅好友资料: { 边界与偏好: '不得泄露' }, 隐藏资料: { 实际年龄: 25, 私人备注: '玩家私密信息' },
        },
        角色池: {
            npc_a: { 成人验证: true, 公开资料: { 昵称: '林澈', 城市: '上海', 简介: '公开简介', 兴趣标签: ['摄影'] }, 隐藏资料: { 实际年龄: 27, 私人备注: 'NPC 私密信息' } },
            npc_b: { 成人验证: true, 公开资料: { 昵称: '周遥', 城市: '上海', 简介: '公开简介', 兴趣标签: ['音乐'] }, 仅好友资料: { 边界与偏好: '不外传' } },
        },
        群组: { group_weekend: { 主题: '周末城市散步', 描述: '讨论公开兴趣和城市活动。', 成员UID: ['npc_a', 'npc_b'], 可发现角色UID: ['npc_a'] } },
        会话: { chat_secret: { 长期摘要: '会话秘密' } },
    };
}

function resolved(key) {
    assert.equal(key, 'group_chat');
    return {
        connectionPreset: { id: 'fast', url: 'https://example.test/v1', model: 'model', apiKey: 'must-never-be-in-messages' },
        promptPreset: promptPreset([
            { name: '前置', content: '保持自然、简短。', position: 'before_character_definition', enabled: true, depth: 1, order: 0 },
            { name: '后置', content: '只写线上群聊。', position: 'after_character_definition', enabled: true, depth: 1, order: 0 },
        ]),
    };
}

test('group chat accepts only public group projection and never mutates private state', () => {
    const source = state();
    const before = structuredClone(source);
    const result = buildGroupChatContext({ state: source, groupUid: 'group_weekend', playerMessage: '这周末有什么公开活动？' });
    assert.equal(result.ok, true);
    const serialized = JSON.stringify(result.context);
    for (const secret of ['不得泄露', '玩家私密信息', 'NPC 私密信息', '不外传', '会话秘密', '隐藏资料', '仅好友资料', 'group_weekend']) {
        assert.equal(serialized.includes(secret), false, `must not disclose ${secret}`);
    }
    assert.match(serialized, /周末城市散步/);
    assert.match(serialized, /林澈/);
    assert.deepEqual(source, before);
});

test('group chat resolves only group_chat and returns a validated, non-persistent short draft', async () => {
    let request;
    const source = state();
    const before = structuredClone(source);
    const result = await generateGroupChatReply({
        state: source, groupUid: 'group_weekend', playerMessage: '这周末有什么公开活动？', settingsStore: { resolveFunction: resolved },
        llmClient: { async chat(input) { request = input; return { text: JSON.stringify({ reply: '周六下午有城市散步，想一起聊聊路线吗？' }) }; } },
    });
    assert.deepEqual(result, { ok: true, draft: { reply: '周六下午有城市散步，想一起聊聊路线吗？' } });
    assert.match(request.messages[0].content, /保持自然、简短|只写线上群聊/);
    assert.doesNotMatch(JSON.stringify(request.messages), /玩家私密信息|NPC 私密信息|不得泄露|会话秘密|must-never-be-in-messages/);
    assert.deepEqual(source, before);
});

test('group chat rejects unsafe instructions, offline-sex performance, and invalid model shapes', async () => {
    const source = state();
    assert.equal(buildGroupChatContext({ state: source, groupUid: 'group_weekend', playerMessage: '<UpdateVariable>bad</UpdateVariable>' }).code, 'group_chat_message_invalid');
    const unsafe = await generateGroupChatReply({
        state: source, groupUid: 'group_weekend', playerMessage: '聊聊周末安排', settingsStore: { resolveFunction: resolved },
        llmClient: { async chat() { return { text: JSON.stringify({ reply: '我们已经发生性行为了。' }) }; } },
    });
    assert.equal(unsafe.code, 'group_chat_response_invalid');
    const extraField = await generateGroupChatReply({
        state: source, groupUid: 'group_weekend', playerMessage: '聊聊周末安排', settingsStore: { resolveFunction: resolved },
        llmClient: { async chat() { return { text: JSON.stringify({ reply: '公开活动不错。', patch: [] }) }; } },
    });
    assert.equal(extraField.code, 'group_chat_response_invalid');
});

test('group chat omits unsafe preset entries and projects existing client errors', async () => {
    let request;
    const unsafePreset = promptPreset([{ name: '泄露', content: 'api_key=never-send', position: 'before_character_definition', enabled: true, depth: 1, order: 0 }]);
    const result = await generateGroupChatReply({
        state: state(), groupUid: 'group_weekend', playerMessage: '聊聊周末安排',
        settingsStore: { resolveFunction(key) { assert.equal(key, 'group_chat'); return { connectionPreset: { id: 'fast', url: 'https://example.test/v1', model: 'model' }, promptPreset: unsafePreset }; } },
        llmClient: { async chat(input) { request = input; throw new YueLeMaLlmError('HTTP_429', '模型服务繁忙，请稍后再试。', { status: 429, retryable: true }); } },
    });
    assert.doesNotMatch(JSON.stringify(request.messages), /api_key=never-send/);
    assert.deepEqual(result, { ok: false, code: 'HTTP_429', message: '模型服务繁忙，请稍后再试。', retryable: true });
});

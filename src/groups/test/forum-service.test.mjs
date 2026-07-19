import test from 'node:test';
import assert from 'node:assert/strict';
import { buildForumContext, generateForumPostDraft } from '../forum-service.js';

function promptPreset(entries) {
    return { enabled: true, name: '论坛规则', content: JSON.stringify({ schema: 'yuelema.prompt-entries', schemaVersion: 1, entries }) };
}

function state() {
    return {
        软件: { 内容模式: 'SFW' },
        玩家: { 公开资料: { 昵称: '玩家', 城市: '杭州', 简介: '公开简介', 兴趣标签: ['书店'] }, 隐藏资料: { 私人备注: '玩家隐藏资料' } },
        角色池: {
            npc_a: { 成人验证: true, 公开资料: { 昵称: '许青', 城市: '杭州', 简介: '公开成员', 兴趣标签: ['咖啡'] }, 隐藏资料: { 私人备注: '成员隐藏资料' } },
        },
        群组: { group_coffee: { 主题: '城市咖啡地图', 描述: '交流公开店铺体验。', 成员UID: ['npc_a'], 可发现角色UID: [] } },
        会话: { chat_1: { 长期摘要: '不得进入论坛' } },
    };
}

function settings(key) {
    assert.equal(key, 'forum');
    return {
        connectionPreset: { id: 'smart', url: 'https://example.test/v1', model: 'model' },
        promptPreset: promptPreset([
            { name: '前置', content: '避免夸张营销。', position: 'before_character_definition', enabled: true, depth: 1, order: 0 },
            { name: '后置', content: '只提供可审核草稿。', position: 'after_character_definition', enabled: true, depth: 1, order: 0 },
        ]),
    };
}

test('forum context is public/group projected, contains only a public topic, and does not mutate state', () => {
    const source = state();
    const before = structuredClone(source);
    const result = buildForumContext({ state: source, groupUid: 'group_coffee', topic: '想征集安静阅读咖啡馆' });
    assert.equal(result.ok, true);
    const serialized = JSON.stringify(result.context);
    assert.match(serialized, /城市咖啡地图|许青|想征集安静阅读咖啡馆/);
    assert.doesNotMatch(serialized, /玩家隐藏资料|成员隐藏资料|隐藏资料|group_coffee|不得进入论坛/);
    assert.deepEqual(source, before);
});

test('forum uses only its dedicated binding and returns a validated non-persistent post draft', async () => {
    let request;
    const source = state();
    const before = structuredClone(source);
    const result = await generateForumPostDraft({
        state: source, groupUid: 'group_coffee', topic: '想征集安静阅读咖啡馆', settingsStore: { resolveFunction: settings },
        llmClient: { async chat(input) { request = input; return { text: JSON.stringify({ title: '征集安静阅读咖啡馆', body: '想找适合周末安静看书的咖啡馆，欢迎分享公开体验和大致区域。' }) }; } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.draft.title, '征集安静阅读咖啡馆');
    assert.match(request.messages[0].content, /避免夸张营销|只提供可审核草稿/);
    assert.doesNotMatch(JSON.stringify(request.messages), /玩家隐藏资料|成员隐藏资料|不得进入论坛/);
    assert.deepEqual(source, before);
});

test('forum rejects hidden-data, Patch, and offline-sex output before it reaches UI', async () => {
    for (const text of ['<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>', '我们已经进行性行为']) {
        const result = await generateForumPostDraft({
            state: state(), groupUid: 'group_coffee', topic: '想征集安静阅读咖啡馆', settingsStore: { resolveFunction: settings },
            llmClient: { async chat() { return { text: JSON.stringify({ title: '测试', body: text }) }; } },
        });
        assert.equal(result.code, 'forum_response_invalid');
    }
    assert.equal(buildForumContext({ state: state(), groupUid: 'group_coffee', topic: 'api_key=do-not-send' }).code, 'forum_topic_invalid');
});

test('forum omits unsafe prompt entries and does not call a model when binding is absent', async () => {
    let request;
    const unsafePreset = promptPreset([{ name: '泄露', content: 'authorization: Bearer never-send', position: 'after_character_definition', enabled: true, depth: 1, order: 0 }]);
    const generated = await generateForumPostDraft({
        state: state(), groupUid: 'group_coffee', topic: '想征集安静阅读咖啡馆',
        settingsStore: { resolveFunction(key) { assert.equal(key, 'forum'); return { connectionPreset: { id: 'smart', url: 'https://example.test/v1', model: 'model' }, promptPreset: unsafePreset }; } },
        llmClient: { async chat(input) { request = input; return { text: JSON.stringify({ title: '测试', body: '公开草稿。' }) }; } },
    });
    assert.equal(generated.ok, true);
    assert.doesNotMatch(JSON.stringify(request.messages), /never-send/);

    let called = false;
    const missing = await generateForumPostDraft({
        state: state(), groupUid: 'group_coffee', topic: '想征集安静阅读咖啡馆',
        settingsStore: { resolveFunction() { return { promptPreset: null }; } },
        llmClient: { async chat() { called = true; return { text: '{}' }; } },
    });
    assert.equal(missing.code, 'forum_connection_missing');
    assert.equal(called, false);
});

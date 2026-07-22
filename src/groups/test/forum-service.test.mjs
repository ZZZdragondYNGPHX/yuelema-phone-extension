import test from 'node:test';
import assert from 'node:assert/strict';
import { buildForumContext, buildForumHomeRefreshContext, buildForumPostUpdateContext, generateForumHomeRefresh, generateForumPostConversationUpdate, generateForumPostDraft } from '../forum-service.js';

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

function localProfile(nickname, overrides = {}) {
    return {
        nickname, ageRange: '25-29', gender: '女', city: '杭州', mbti: 'ENFP', zodiac: '双鱼座', occupation: '插画师', interests: ['咖啡'], presence: '在线', matchRate: null,
        ...overrides,
    };
}

function forumRefreshPosts(author) {
    return [
        { author, topic: '今日心情', title: '午后的一点松弛', body: '忙完手头的事情，给自己买了一杯喜欢的饮料。', tags: ['日常', '心情'] },
        { author, topic: '附近的人', title: '附近的公园散步', body: '傍晚想去公园慢走，有人也在附近吗？', tags: ['附近', '散步'] },
        { author, topic: '同城瞬间', title: '午后花店', body: '发现一家阳光很好的小花店，适合慢慢挑花。', tags: ['同城', '花店'] },
        { author, topic: '兴趣同频', title: '交换一张书单', body: '最近读到一本很喜欢的小说，想认识也爱阅读的朋友。', tags: ['阅读', '同好'] },
        { author, topic: '话题广场', title: '周末的快乐清单', body: '分享一个让你期待周末的小计划吧。', tags: ['话题', '周末'] },
    ];
}

test('forum home refresh only consumes public community context and returns local posts with temporary adults', async () => {
    let request;
    const built = buildForumHomeRefreshContext({ state: state(), existingTitles: ['上周咖啡散步'] });
    assert.equal(built.ok, true);
    assert.doesNotMatch(JSON.stringify(built.context), /玩家隐藏资料|成员隐藏资料|不得进入论坛|group_coffee/u);
    const result = await generateForumHomeRefresh({
        state: state(), existingTitles: ['上周咖啡散步'], settingsStore: { resolveFunction: settings },
        llmClient: { async chat(input) { request = input; return { text: JSON.stringify({
            participants: [localProfile('苏晴', { city: '上海', mbti: 'ISFP', occupation: '花艺师', interests: ['花店'] })],
            posts: forumRefreshPosts('苏晴'),
        }) }; } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.update.posts.length, 5);
    assert.deepEqual(result.update.posts.map((post) => post.topic), ['今日心情', '附近的人', '同城瞬间', '兴趣同频', '话题广场']);
    assert.match(request.messages[0].content, /心动社区首页更新模型/u);
    assert.match(request.messages[0].content, /今日心情、附近的人、同城瞬间、兴趣同频、话题广场各一篇/u);
    assert.doesNotMatch(JSON.stringify(request.messages), /玩家隐藏资料|成员隐藏资料|不得进入论坛/u);
});

test('forum home refresh rejects a model batch that omits or duplicates a fixed channel', async () => {
    const incomplete = await generateForumHomeRefresh({
        state: state(), existingTitles: [], settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { return { text: JSON.stringify({ participants: [], posts: forumRefreshPosts('许青').slice(0, 4) }) }; } },
    });
    assert.equal(incomplete.code, 'forum_update_response_invalid');

    const posts = forumRefreshPosts('许青');
    const duplicated = [...posts.slice(0, 4), { ...posts[0], title: '重复频道' }];
    const repeated = await generateForumHomeRefresh({
        state: state(), existingTitles: [], settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { return { text: JSON.stringify({ participants: [], posts: duplicated }) }; } },
    });
    assert.equal(repeated.code, 'forum_update_response_invalid');
});

test('opened forum posts use forum binding for local comment updates and reject non-adult participants', async () => {
    let request;
    const post = {
        id: 'local_post_1', topic: '同城瞬间', title: '午后花店', body: '阳光很好，适合慢慢挑花。', tags: ['同城'],
        author: localProfile('苏晴'), participants: [], messages: [], summaries: [],
        summaryStatus: { status: 'idle', startFloor: 0, endFloor: 0, message: '' }, createdAt: '2026-07-22T04:00:00.000Z',
    };
    const history = { summaries: [], messages: [{ sender: 'user', speaker: '我', content: '这家店周末人多吗？' }] };
    assert.equal(buildForumPostUpdateContext({ state: state(), post, history }).ok, true);
    const result = await generateForumPostConversationUpdate({
        state: state(), post, history, settingsStore: { resolveFunction: settings },
        llmClient: { async chat(input) { request = input; return { text: JSON.stringify({ participants: [], messages: [{ speaker: '苏晴', text: '上午会比较安静，欢迎早点来。' }] }) }; } },
    });
    assert.equal(result.ok, true);
    assert.match(request.messages[0].content, /论坛帖子讨论更新模型/u);

    const rejected = await generateForumPostConversationUpdate({
        state: state(), post, history, settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { return { text: JSON.stringify({ participants: [localProfile('未成年人', { ageRange: '17岁' })], messages: [{ speaker: '未成年人', text: '不应显示。' }] }) }; } },
    });
    assert.equal(rejected.code, 'forum_update_response_invalid');
});

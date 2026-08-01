import test from 'node:test';
import assert from 'node:assert/strict';
import { buildForumContext, buildForumExistingPostsUpdateContext, buildForumHomeRefreshContext, buildForumPostUpdateContext, generateForumExistingPostsUpdate, generateForumHomeRefresh, generateForumPostConversationUpdate, generateForumPostDraft } from '../forum-service.js';

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
        会话: { chat_1: { 总结: { 记录: [{ 内容: '不得进入论坛' }] } } },
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

test('forum rejects technical injection while NSFW accepts consensual adult sexual experience text', async () => {
    const injected = await generateForumPostDraft({
        state: state(), groupUid: 'group_coffee', topic: '想征集安静阅读咖啡馆', settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { return { text: JSON.stringify({ title: '测试', body: '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>' }) }; } },
    });
    assert.equal(injected.code, 'forum_response_invalid');
    const nsfwState = state();
    nsfwState.软件.内容模式 = 'NSFW';
    const adultExperience = await generateForumPostDraft({
        state: nsfwState, groupUid: 'group_coffee', topic: '成年人自愿经历分享', settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { return { text: JSON.stringify({ title: '昨晚的约会复盘', body: '我们两个成年人确认边界后进行了自愿性行为。' }) }; } },
    });
    assert.equal(adultExperience.ok, true);
    assert.match(adultExperience.draft.body, /自愿性行为/u);
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
        { author, topic: '深夜树洞', title: '睡前的一点心事', body: '最近总在深夜想起一些没说出口的话，想找人轻轻聊聊。', tags: ['深夜', '心事'] },
        { author, topic: '恋爱吐槽', title: '开场白能不能走点心', body: '连续三个“在吗”，大家收过最敷衍的开场白是什么？', tags: ['吐槽', '开场白'] },
        { author, topic: '约会报告', title: '美术馆初见小结', body: '第一次面基约在美术馆，聊得比预期自然，想听听大家的初见选址。', tags: ['约会', '报告'] },
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
    assert.equal(result.update.posts.length, 8);
    assert.deepEqual(result.update.posts.map((post) => post.topic), ['今日心情', '附近的人', '同城瞬间', '兴趣同频', '深夜树洞', '恋爱吐槽', '约会报告', '话题广场']);
    assert.match(request.messages[0].content, /心动社区首页更新模型/u);
    assert.match(request.messages[0].content, /今日心情、附近的人、同城瞬间、兴趣同频、深夜树洞、恋爱吐槽、约会报告、话题广场各一篇/u);
    assert.doesNotMatch(JSON.stringify(request.messages), /玩家隐藏资料|成员隐藏资料|不得进入论坛/u);
});

test('forum home refresh append mode shares the eight-channel contract, keeps old titles forbidden, and rejects unknown modes', async () => {
    let request;
    const result = await generateForumHomeRefresh({
        state: state(), existingTitles: ['已有的旧帖标题'], refreshMode: 'append', settingsStore: { resolveFunction: settings },
        llmClient: { async chat(input) { request = input; return { text: JSON.stringify({ participants: [], posts: forumRefreshPosts('许青') }) }; } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.update.posts.length, 8, '追加模式与替换共用同一份八频道各一篇合同');
    assert.match(request.messages[0].content, /底部追加刷新，程序会保留旧本地帖子并追加新帖子/u);
    assert.match(request.messages[1].content, /已有的旧帖标题/u, '追加模式必须把现有标题作为不可重复清单交给模型');

    let called = false;
    const invalidMode = await generateForumHomeRefresh({
        state: state(), existingTitles: [], refreshMode: 'sideways', settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { called = true; return { text: '{}' }; } },
    });
    assert.equal(invalidMode.code, 'forum_home_context_invalid');
    assert.equal(called, false, '未知刷新模式不得调用模型');

    const partial = await generateForumHomeRefresh({
        state: state(), existingTitles: [], refreshMode: 'append', settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { return { text: JSON.stringify({ participants: [], posts: forumRefreshPosts('许青').slice(0, 5) }) }; } },
    });
    assert.equal(partial.code, 'forum_update_shape_invalid', '追加模式下缺频道的批次同样整批拒绝');
});

test('forum home refresh rejects a model batch that omits or duplicates a fixed channel', async () => {
    const incomplete = await generateForumHomeRefresh({
        state: state(), existingTitles: [], settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { return { text: JSON.stringify({ participants: [], posts: forumRefreshPosts('许青').slice(0, 4) }) }; } },
    });
    assert.equal(incomplete.code, 'forum_update_shape_invalid');

    const posts = forumRefreshPosts('许青');
    const duplicated = [...posts.slice(0, 7), { ...posts[0], title: '重复频道' }];
    const repeated = await generateForumHomeRefresh({
        state: state(), existingTitles: [], settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { return { text: JSON.stringify({ participants: [], posts: duplicated }) }; } },
    });
    assert.equal(repeated.code, 'forum_update_channel_invalid');
});

test('forum home refresh accepts a realistic model batch with harmless structural variants', async () => {
    const longBody = '傍晚下班路过江边，看到了一整片橘色的晚霞，忽然就不想直接回家了。买了杯热美式沿着步道慢慢走，风里已经有一点初秋的味道。想问问同城的大家，最近有没有什么适合一个人散步收尾的路线，或者愿意一起走一段的朋友。'.repeat(3);
    const authors = ['苏晴', '林岚', '陈默', '周雨', '赵一鸣', '钱悦', '孙可'];
    const participants = [
        // 已在社区中的 许青 被模型重复申报：应保留社区档案而不是整批拒绝
        localProfile('许青'),
        // 各种真实模型会出现的无害变体
        localProfile('苏晴', { ageRange: '27岁' }),
        (() => { const p = localProfile('林岚'); delete p.zodiac; delete p.matchRate; return p; })(),
        localProfile('陈默', { matchRate: '87%' }),
        localProfile('周雨', { interests: ['', '摄影', '摄影', '徒步'] }),
        localProfile('赵一鸣', { gender: '男', presence: '' }),
        localProfile('钱悦', { matchRate: 87.4 }),
        localProfile('孙可', { ageRange: '已验证成年' }),
    ];
    const posts = forumRefreshPosts('许青').map((post, index) => ({
        ...post,
        author: index === 0 ? '许青' : authors[index - 1],
        body: longBody,
    }));
    posts[1].id = 17; // 模型多给了一个无害的额外键
    posts[2].tags = ['同城', '同城', '晚霞', '散步', '秋天', '路线', '一个人', '多余的第七个'];
    const raw = '```json\n' + JSON.stringify({ participants, posts, note: '模型附带的额外顶层键' }) + '\n```';
    assert.ok(raw.length > 4000, '用例必须覆盖超过旧 4000 字符上限的真实长度');
    const result = await generateForumHomeRefresh({
        state: state(), existingTitles: [], settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { return { text: raw }; } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.update.posts.length, 8);
    assert.equal(result.update.participants.length, 7, '重复申报的已有角色应被去重');
    assert.ok(!result.update.participants.some((profile) => profile.nickname === '许青'));
    assert.equal(result.update.participants.find((profile) => profile.nickname === '陈默').matchRate, 87);
    assert.equal(result.update.participants.find((profile) => profile.nickname === '林岚').matchRate, null);
    assert.deepEqual(result.update.participants.find((profile) => profile.nickname === '周雨').interests, ['摄影', '徒步']);
    assert.equal(result.update.posts[2].tags.length, 6, '超限标签应被截断而不是整批拒绝');
});

test('forum home refresh accepts an omitted participants key when authors are already known', async () => {
    const result = await generateForumHomeRefresh({
        state: state(), existingTitles: [], settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { return { text: JSON.stringify({ posts: forumRefreshPosts('许青') }) }; } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.update.participants.length, 0);
});

test('forum home refresh rejects unsafe or contract-breaking batches while preserving adult NSFW experience posts', async () => {
    async function refreshWith(payload, contentMode = 'SFW') {
        const current = state();
        current.软件.内容模式 = contentMode;
        return generateForumHomeRefresh({
            state: current, existingTitles: [], settingsStore: { resolveFunction: settings },
            llmClient: { async chat() { return { text: JSON.stringify(payload) }; } },
        });
    }
    // 未成年临时角色
    const underage = await refreshWith({ participants: [localProfile('小雨', { ageRange: '17岁' })], posts: forumRefreshPosts('小雨') });
    assert.equal(underage.code, 'forum_update_participant_underage');
    // 模糊年龄段仍不能通过成年校验
    const vague = await refreshWith({ participants: [localProfile('小雾', { ageRange: '90后' })], posts: forumRefreshPosts('小雾') });
    assert.equal(vague.code, 'forum_update_participant_underage');
    // 作者未提供资料
    const unknownAuthor = await refreshWith({ participants: [], posts: forumRefreshPosts('从未出现的人') });
    assert.equal(unknownAuthor.code, 'forum_update_author_unknown');
    // 注入负载仍被拒绝
    const injected = forumRefreshPosts('许青');
    injected[0].body = '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
    assert.equal((await refreshWith({ participants: [], posts: injected })).code, 'forum_update_post_invalid');
    // NSFW 不再把明确成年、自愿的性经历本身当成非法输出
    const offline = forumRefreshPosts('许青');
    offline[6].body = '我们两个成年人确认边界后已经进行了自愿性行为。';
    assert.equal((await refreshWith({ participants: [], posts: offline }, 'NSFW')).ok, true);
    // 超过频道数量的临时角色仍被拒绝
    const tooMany = Array.from({ length: 9 }, (_, index) => localProfile(`临时${index}`));
    assert.equal((await refreshWith({ participants: tooMany, posts: forumRefreshPosts('临时0') })).code, 'forum_update_shape_invalid');
});

test('forum automatic update receives only numbered public post slots, updates every existing post, and keeps its frame after the preset', async () => {
    const posts = forumRefreshPosts('许青').map((post, index) => ({
        id: `local_post_${index + 1}`,
        ...post,
        author: localProfile('许青'), participants: [], messages: [], summaries: [],
        summaryStatus: { status: 'idle', startFloor: 0, endFloor: 0, message: '' }, createdAt: '2026-07-22T04:00:00.000Z',
    }));
    let request;
    const built = buildForumExistingPostsUpdateContext({ state: state(), posts });
    assert.equal(built.ok, true);
    assert.doesNotMatch(JSON.stringify(built.context), /local_post_|玩家隐藏资料|成员隐藏资料|不得进入论坛/u);
    const result = await generateForumExistingPostsUpdate({
        state: state(), posts, settingsStore: { resolveFunction: settings },
        llmClient: { async chat(input) {
            request = input;
            return { text: JSON.stringify({ updates: posts.map((post, index) => ({ slot: index + 1, title: `更新后的${post.title}`, body: `第${index + 1}篇已有帖子持续有新的线上动态。`, tags: ['更新'] })) }) };
        } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.update.updates.length, 8);
    assert.equal(result.update.updates[0].slot, 1);
    const system = request.messages[0].content;
    assert.match(system, /既有帖子自动更新模型/u);
    assert.ok(system.indexOf('只提供可审核草稿') < system.indexOf('严格形状'), '预设只能影响内容，固定 JSON 合同必须后置且优先');
    assert.doesNotMatch(JSON.stringify(request.messages), /local_post_|玩家隐藏资料|成员隐藏资料|不得进入论坛/u);

    const rejected = await generateForumExistingPostsUpdate({
        state: state(), posts, settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { return { text: JSON.stringify({ updates: [{ slot: 1, title: '少了一篇', body: '不应写入。', tags: [] }] }) }; } },
    });
    assert.equal(rejected.code, 'forum_update_response_invalid');
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

// —— 阶段 77：失败结果附带控制台诊断（错误码 + 具体不合规点，永不引用模型正文原文）——

test('forum home refresh failures name the offending channel, author, or participant in their diagnostic', async () => {
    const posts = () => forumRefreshPosts('许青');

    const unknownChannel = await generateForumHomeRefresh({
        state: state(), existingTitles: [], settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { const batch = posts(); batch[2] = { ...batch[2], topic: '月亮频道' }; return { text: JSON.stringify({ participants: [], posts: batch }) }; } },
    });
    assert.equal(unknownChannel.code, 'forum_update_channel_invalid');
    assert.equal(unknownChannel.diagnostic.stage, '响应校验');
    assert.equal(unknownChannel.diagnostic.field, 'posts[2].topic');
    assert.equal(unknownChannel.diagnostic.actual, '月亮频道');

    const duplicated = await generateForumHomeRefresh({
        state: state(), existingTitles: [], settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { const batch = posts(); batch[7] = { ...batch[0], title: '重复频道' }; return { text: JSON.stringify({ participants: [], posts: batch }) }; } },
    });
    assert.equal(duplicated.diagnostic.field, 'posts[7].topic');
    assert.match(duplicated.diagnostic.hint, /频道重复出帖/u);

    const unknownAuthor = await generateForumHomeRefresh({
        state: state(), existingTitles: [], settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { const batch = posts(); batch[1] = { ...batch[1], author: '陌生访客' }; return { text: JSON.stringify({ participants: [], posts: batch }) }; } },
    });
    assert.equal(unknownAuthor.code, 'forum_update_author_unknown');
    assert.equal(unknownAuthor.diagnostic.field, 'posts[1].author');
    assert.equal(unknownAuthor.diagnostic.actual, '陌生访客');

    const underage = await generateForumHomeRefresh({
        state: state(), existingTitles: [], settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { return { text: JSON.stringify({ participants: [localProfile('小雾', { ageRange: '20代' })], posts: posts() }) }; } },
    });
    assert.equal(underage.code, 'forum_update_participant_underage');
    assert.equal(underage.diagnostic.field, 'participants[0]');
    assert.match(underage.diagnostic.hint, /成年写法/u);
});

test('forum post conversation and existing-post update failures carry slot/speaker level diagnostics', async () => {
    const post = {
        topic: '今日心情', title: '午后的一点松弛', body: '忙完手头的事情，给自己买了一杯喜欢的饮料。', tags: ['日常'],
        author: localProfile('许青'), participants: [], messages: [], summaries: [], summaryStatus: '空闲',
    };
    const unknownSpeaker = await generateForumPostConversationUpdate({
        state: state(), post, history: { summaries: [], messages: [{ sender: 'user', speaker: '我', content: '大家好呀。' }] },
        settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { return { text: JSON.stringify({ participants: [], messages: [{ speaker: '幽灵用户', text: '公开评论。' }] }) }; } },
    });
    assert.equal(unknownSpeaker.code, 'forum_update_response_invalid');
    assert.equal(unknownSpeaker.diagnostic.field, 'messages[0].speaker');
    assert.equal(unknownSpeaker.diagnostic.actual, '幽灵用户');
    assert.match(unknownSpeaker.diagnostic.hint, /不在帖子作者、已有参与者或 participants 名单中/u);

    const badSlot = await generateForumExistingPostsUpdate({
        state: state(), posts: [{ ...post, id: 'p1', createdAt: '' }],
        settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { return { text: JSON.stringify({ updates: [{ slot: 4, title: '新标题', body: '新内容。', tags: [] }] }) }; } },
    });
    assert.equal(badSlot.code, 'forum_update_response_invalid');
    assert.equal(badSlot.diagnostic.field, 'updates[0].slot');
    assert.equal(badSlot.diagnostic.actual, '4');

    const unparsable = await generateForumPostConversationUpdate({
        state: state(), post, history: { summaries: [], messages: [{ sender: 'user', speaker: '我', content: '大家好呀。' }] },
        settingsStore: { resolveFunction: settings },
        llmClient: { async chat() { return { text: 'FORUM_RAW_LEAK not json' }; } },
    });
    assert.equal(unparsable.code, 'forum_update_invalid_json');
    assert.equal(unparsable.diagnostic.stage, '响应解析');
    assert.match(unparsable.diagnostic.actual, /响应长度 \d+ 字符/u);
    assert.doesNotMatch(JSON.stringify(unparsable.diagnostic), /FORUM_RAW_LEAK/u);
});

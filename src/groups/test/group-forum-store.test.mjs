import test from 'node:test';
import assert from 'node:assert/strict';
import {
    GROUP_FORUM_SCHEMA_VERSION,
    GROUP_FORUM_STORAGE_KEY,
    GroupForumStoreError,
    createGroupForumStore,
    createMemoryGroupForumStorage,
    externalGroupCacheKey,
} from '../group-forum-store.js';

const CLOCK = () => new Date('2026-07-22T04:00:00.000Z');

function profile(nickname, overrides = {}) {
    return {
        nickname,
        ageRange: '25-29',
        gender: '女',
        city: '上海',
        mbti: 'INFJ',
        zodiac: '双鱼座',
        occupation: '摄影师',
        interests: ['摄影', '咖啡'],
        presence: '在线',
        matchRate: null,
        ...overrides,
    };
}

function forumRefreshPosts(author) {
    return [
        { author, topic: '今日心情', title: '傍晚的风很轻', body: '下班路上听到喜欢的歌，想把这点轻松分享给大家。', tags: ['日常', '心情'] },
        { author, topic: '附近的人', title: '浦东散步搭子', body: '傍晚想沿江散步，有同样喜欢慢走的人吗？', tags: ['附近', '散步'] },
        { author, topic: '同城瞬间', title: '雨后的书店', body: '想找一间适合安静看书的小店。', tags: ['书店', '同城'] },
        { author, topic: '兴趣同频', title: '周末胶片放映', body: '想找喜欢老电影的同好，一起挑一场放映。', tags: ['电影', '同好'] },
        { author, topic: '话题广场', title: '你最近的治愈瞬间', body: '欢迎聊聊这一周让你放松下来的小事。', tags: ['话题', '分享'] },
    ];
}

test('browser-local group/forum store persists groups, temporary people, conversations and summaries outside MVU', async () => {
    const storage = createMemoryGroupForumStorage();
    const store = createGroupForumStore({ storage, now: CLOCK });
    await store.ready();

    const group = await store.createGroup({ name: '同城周末搭子', members: [profile('林澈')] });
    await store.appendGroupUserMessage({ key: group.id, title: group.name, content: '周六下午有人想去看展吗？' });
    await store.appendGroupModelUpdate({
        key: group.id,
        title: group.name,
        members: group.members,
        update: {
            participants: [profile('周遥', { gender: '男', mbti: 'INTP', occupation: '设计师', interests: ['展览'] })],
            messages: [{ speaker: '周遥', text: '我想去，展后还可以一起喝杯咖啡。' }],
        },
    });
    await store.setGroupAuto({ key: group.id, title: group.name, settings: { enabled: true, intervalSeconds: 30 } });
    await store.saveConversationSummary({
        target: { kind: 'group', id: group.id }, startFloor: 1, endFloor: 2, content: '大家约好周六看展，周遥提议展后喝咖啡。',
    });

    const createdPosts = await store.addForumRefresh({
        communityProfiles: [profile('林澈')],
        update: {
            participants: [profile('许青', { city: '杭州', mbti: 'ENFP', occupation: '插画师', interests: ['书店'] })],
            posts: forumRefreshPosts('许青'),
        },
    });
    const post = createdPosts.find((item) => item.title === '雨后的书店');
    assert.ok(post);
    await store.appendForumUserComment({ postId: post.id, content: '这家店听起来很适合周末。' });
    await store.appendForumModelUpdate({ postId: post.id, update: { participants: [], messages: [{ speaker: '许青', text: '下午的光线很好，欢迎来坐坐。' }] } });
    await store.saveConversationSummary({
        target: { kind: 'post', id: post.id }, startFloor: 1, endFloor: 2, content: '围绕雨后书店交换了周末到访建议。',
    });

    const snapshot = await store.snapshot();
    assert.equal(snapshot.groups.length, 1);
    assert.equal(snapshot.threads[0].auto.enabled, true);
    assert.equal(snapshot.threads[0].auto.intervalSeconds, 30);
    assert.deepEqual(snapshot.threads[0].bindings.SFW, { connectionPresetId: null, promptPresetId: null });
    assert.equal(snapshot.threads[0].temporaryMembers[0].nickname, '周遥');
    assert.equal(snapshot.threads[0].messages.length, 2);
    assert.equal(snapshot.posts.length, 5);
    assert.equal(snapshot.forumAuto.enabled, false);
    const savedPost = snapshot.posts.find((item) => item.title === '雨后的书店');
    assert.equal(savedPost?.messages.length, 2);
    assert.equal(savedPost?.summaries.length, 1);
    assert.equal(Object.isFrozen(snapshot), true);

    const history = await store.getSummaryHistory();
    assert.deepEqual(history.groups[0].summary, { totalFloors: 2, completedFloor: 2, pendingFloorCount: 0, recordCount: 1, status: 'idle', failureStartFloor: 0, failureEndFloor: 0, failureMessage: '' });
    assert.equal(history.posts.find((item) => item.title === '雨后的书店')?.title, '雨后的书店');

    const serialized = await storage.getItem(GROUP_FORUM_STORAGE_KEY);
    assert.equal(typeof serialized, 'string');
    assert.doesNotMatch(serialized, /stat_data|对象UID|session-secret|UpdateVariable|JSONPatch/u);
});

test('group history can be cleared independently, leaving deletes browser-local group data, and forum auto settings migrate in place', async () => {
    const storage = createMemoryGroupForumStorage();
    await storage.setItem(GROUP_FORUM_STORAGE_KEY, JSON.stringify({
        schema: 'yuelema.group-forum', schemaVersion: 1, nextId: 1, groups: [], threads: [], posts: [],
    }));
    const store = createGroupForumStore({ storage, now: CLOCK });
    const migrated = await store.ready();
    assert.equal(migrated.schemaVersion, GROUP_FORUM_SCHEMA_VERSION);
    assert.equal(migrated.forumAuto.enabled, false);
    assert.equal(migrated.forumAuto.intervalSeconds, 30);
    assert.deepEqual(migrated.forumAuto.channelBindings.SFW, { connectionPresetId: null, promptPresetId: null });

    const group = await store.createGroup({ name: '清理测试群', members: [profile('林澈')] });
    await store.appendGroupUserMessage({ key: group.id, title: group.name, content: '这条消息会被清空。' });
    await store.setGroupAuto({ key: group.id, title: group.name, settings: { enabled: true, intervalSeconds: 45 } });
    await store.setGroupBinding({ key: group.id, title: group.name, contentMode: 'SFW', binding: { connectionPresetId: 'conn_group', promptPresetId: 'prompt_group_sfw' } });
    await store.clearGroupHistory({ key: group.id, title: group.name });
    let snapshot = await store.snapshot();
    assert.equal(snapshot.groups.length, 1);
    assert.equal(snapshot.threads[0].messages.length, 0);
    assert.equal(snapshot.threads[0].auto.intervalSeconds, 45);
    assert.deepEqual(snapshot.threads[0].bindings.SFW, { connectionPresetId: 'conn_group', promptPresetId: 'prompt_group_sfw' });

    await store.setForumAuto({ settings: {
        enabled: true, intervalSeconds: 18,
        channelBindings: { SFW: { connectionPresetId: 'conn_channel', promptPresetId: 'prompt_channel_sfw' }, NSFW: { connectionPresetId: null, promptPresetId: null } },
        postBindings: { SFW: { connectionPresetId: 'conn_post', promptPresetId: 'prompt_post_sfw' }, NSFW: { connectionPresetId: null, promptPresetId: null } },
    } });
    assert.deepEqual((await store.snapshot()).forumAuto, {
        enabled: true, intervalSeconds: 18,
        channelBindings: { SFW: { connectionPresetId: 'conn_channel', promptPresetId: 'prompt_channel_sfw' }, NSFW: { connectionPresetId: null, promptPresetId: null } },
        postBindings: { SFW: { connectionPresetId: 'conn_post', promptPresetId: 'prompt_post_sfw' }, NSFW: { connectionPresetId: null, promptPresetId: null } },
    });
    await store.exitGroup({ key: group.id });
    snapshot = await store.snapshot();
    assert.equal(snapshot.groups.length, 0);
    assert.equal(snapshot.threads.length, 0);

    await store.exitGroup({ key: 'ext_1234abcd' });
    assert.deepEqual((await store.snapshot()).exitedExternalGroupKeys, ['ext_1234abcd']);
});

test('v0.1.28 local cache migrates old forum and group settings to independent bindings', async () => {
    const storage = createMemoryGroupForumStorage();
    await storage.setItem(GROUP_FORUM_STORAGE_KEY, JSON.stringify({
        schema: 'yuelema.group-forum', schemaVersion: 2, nextId: 1,
        groups: [], threads: [], posts: [], forumAuto: { enabled: true }, exitedExternalGroupKeys: [],
    }));
    const store = createGroupForumStore({ storage, now: CLOCK });
    const migrated = await store.ready();
    assert.equal(migrated.schemaVersion, 3);
    assert.deepEqual(migrated.forumAuto, {
        enabled: true, intervalSeconds: 30,
        channelBindings: { SFW: { connectionPresetId: null, promptPresetId: null }, NSFW: { connectionPresetId: null, promptPresetId: null } },
        postBindings: { SFW: { connectionPresetId: null, promptPresetId: null }, NSFW: { connectionPresetId: null, promptPresetId: null } },
    });
});

test('forum automatic update replaces every existing post copy without creating a post or touching conversations', async () => {
    const store = createGroupForumStore({ now: CLOCK });
    await store.ready();
    await store.addForumRefresh({ communityProfiles: [profile('林澈')], update: { participants: [], posts: forumRefreshPosts('林澈') } });
    const before = await store.snapshot();
    const target = before.posts.find((post) => post.title === '雨后的书店');
    await store.appendForumUserComment({ postId: target.id, content: '评论会被保留。' });
    await store.updateExistingForumPosts({ update: {
        updates: before.posts.map((post, index) => ({ slot: index + 1, title: `自动更新 ${index + 1}`, body: `这是第 ${index + 1} 篇已经存在帖子的新文案。`, tags: ['自动更新'] })),
    } });
    const after = await store.snapshot();
    assert.equal(after.posts.length, before.posts.length);
    assert.equal(after.posts[0].title, '自动更新 1');
    assert.equal(after.posts.find((post) => post.id === target.id)?.messages.length, 1);
    await assert.rejects(
        store.updateExistingForumPosts({ update: { updates: [{ slot: 1, title: '不完整', body: '不应写入。', tags: [] }] } }),
        (error) => error instanceof GroupForumStoreError && error.code === 'INVALID_FORUM_EXISTING_UPDATE',
    );
});

test('top replacement discards old local posts and summaries while bottom append retains them', async () => {
    const store = createGroupForumStore({ now: CLOCK });
    await store.ready();
    const firstBatch = await store.addForumRefresh({ communityProfiles: [profile('林澈')], update: { participants: [], posts: forumRefreshPosts('林澈') } });
    const oldPost = firstBatch.find((post) => post.title === '雨后的书店');
    await store.appendForumUserComment({ postId: oldPost.id, content: '旧帖评论。' });
    await store.saveConversationSummary({ target: { kind: 'post', id: oldPost.id }, startFloor: 1, endFloor: 1, content: '旧帖总结。' });

    await store.replaceForumPosts({
        communityProfiles: [profile('许青')],
        update: { participants: [], posts: forumRefreshPosts('许青').map((post) => ({ ...post, title: `替换：${post.title}` })) },
    });
    let snapshot = await store.snapshot();
    assert.equal(snapshot.posts.length, 5);
    assert.equal(snapshot.posts.some((post) => post.id === oldPost.id), false, '替换必须删除旧帖子及其对话/总结');
    assert.equal((await store.getSummaryHistory()).posts.some((entry) => entry.id === oldPost.id), false);

    await store.addForumRefresh({
        communityProfiles: [profile('周遥')],
        update: { participants: [], posts: forumRefreshPosts('周遥').map((post) => ({ ...post, title: `追加：${post.title}` })) },
    });
    snapshot = await store.snapshot();
    assert.equal(snapshot.posts.length, 10);
    assert.equal(snapshot.posts.some((post) => post.title === '替换：雨后的书店'), true, '追加必须保留旧帖子');
    assert.equal(snapshot.posts.some((post) => post.title === '追加：雨后的书店'), true);
});

test('store rejects minor temporary profiles and derives existing group cache keys from public presentation only', async () => {
    const store = createGroupForumStore({ now: CLOCK });
    await store.ready();
    await assert.rejects(
        store.createGroup({ name: '不应建立', members: [profile('未成年人', { ageRange: '17岁' })] }),
        (error) => error instanceof GroupForumStoreError && error.code === 'NON_ADULT_PROFILE',
    );

    const publicGroup = { UID: 'group_alpha', 主题: '城市夜谈', 描述: '公开兴趣交流', 成员: [{ UID: 'npc_a', 公开资料: { 昵称: '林澈' } }] };
    const samePresentation = { UID: 'group_other', 主题: '城市夜谈', 描述: '公开兴趣交流', 成员: [{ UID: 'another_uid', 公开资料: { 昵称: '林澈' } }] };
    assert.equal(externalGroupCacheKey(publicGroup), externalGroupCacheKey(samePresentation));
});

test('forum refresh cache rejects partial or duplicated channel batches', async () => {
    const store = createGroupForumStore({ now: CLOCK });
    await store.ready();
    const posts = forumRefreshPosts('林澈');
    await assert.rejects(
        store.addForumRefresh({ communityProfiles: [profile('林澈')], update: { participants: [], posts: posts.slice(0, 4) } }),
        (error) => error instanceof GroupForumStoreError && error.code === 'INVALID_FORUM_REFRESH',
    );
    const repeated = [...posts.slice(0, 4), { ...posts[0], title: '重复频道不应写入' }];
    await assert.rejects(
        store.addForumRefresh({ communityProfiles: [profile('林澈')], update: { participants: [], posts: repeated } }),
        (error) => error instanceof GroupForumStoreError && error.code === 'INVALID_FORUM_REFRESH',
    );
});

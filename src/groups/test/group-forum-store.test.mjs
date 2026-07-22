import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
            posts: [{ author: '许青', topic: '同城瞬间', title: '雨后的书店', body: '想找一间适合安静看书的小店。', tags: ['书店', '同城'] }],
        },
    });
    const post = createdPosts[0];
    await store.appendForumUserComment({ postId: post.id, content: '这家店听起来很适合周末。' });
    await store.appendForumModelUpdate({ postId: post.id, update: { participants: [], messages: [{ speaker: '许青', text: '下午的光线很好，欢迎来坐坐。' }] } });
    await store.saveConversationSummary({
        target: { kind: 'post', id: post.id }, startFloor: 1, endFloor: 2, content: '围绕雨后书店交换了周末到访建议。',
    });

    const snapshot = await store.snapshot();
    assert.equal(snapshot.groups.length, 1);
    assert.equal(snapshot.threads[0].auto.enabled, true);
    assert.equal(snapshot.threads[0].auto.intervalSeconds, 30);
    assert.equal(snapshot.threads[0].temporaryMembers[0].nickname, '周遥');
    assert.equal(snapshot.threads[0].messages.length, 2);
    assert.equal(snapshot.posts.length, 1);
    assert.equal(snapshot.posts[0].messages.length, 2);
    assert.equal(snapshot.posts[0].summaries.length, 1);
    assert.equal(Object.isFrozen(snapshot), true);

    const history = await store.getSummaryHistory();
    assert.deepEqual(history.groups[0].summary, { totalFloors: 2, completedFloor: 2, pendingFloorCount: 0, recordCount: 1, status: 'idle', failureStartFloor: 0, failureEndFloor: 0, failureMessage: '' });
    assert.equal(history.posts[0].title, '雨后的书店');

    const serialized = await storage.getItem(GROUP_FORUM_STORAGE_KEY);
    assert.equal(typeof serialized, 'string');
    assert.doesNotMatch(serialized, /stat_data|对象UID|session-secret|UpdateVariable|JSONPatch/u);
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

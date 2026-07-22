import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidateMatchOutcomePatch, buildCandidateMatchSessionPatch, buildControlledPatch, buildLikeMatchPatch, validateControlledPatchAgainstState } from '../controlled-patch.js';

function candidate({ threshold = 60 } = {}) {
    return {
        成人验证: true,
        公开资料: {
            昵称: '若晴', 头像引用: '', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '约会', 简介: '热爱看展。',
            兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'],
        },
        仅好友资料: { 关系状态: '单身', 边界与偏好: '尊重拒绝。' },
        隐藏资料: { 实际年龄: 28, 私人备注: '不可见。' },
        偏好与边界: '确认边界。', 拒绝阈值: threshold, 已读不回阈值: 55, 取消匹配阈值: 75, 拉黑阈值: 90,
        与玩家关系: { 状态: '陌生', 全局账号表现: 60, NPC专属匹配度: 0, 好感: 0, 信任: 0, 戒备: 20, 面基意愿: 0, 友情值: 0, 心动值: 0, 欲望值: 0 },
    };
}

function state({ threshold = 60 } = {}) {
    return {
        系统: { UID计数器: { 角色: 1, 会话: 5, 面基: 0 } }, 软件: { 内容模式: 'SFW', 关于软件点击数: 0 },
        玩家: { 成人验证: true, 公开资料: { 城市: '上海', 寻找意图: '聊天约会', 兴趣标签: ['电影', '展览'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'] }, 推荐偏好: { 标签权重: { SFW: {}, NSFW: {} } } },
        角色池: {}, 会话: {},
        推荐: { 当前队列: ['npc_case'], 临时候选池: { npc_case: candidate({ threshold }) }, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
    };
}

test('homepage like only records recommendation feedback and never creates a match or session', () => {
    const before = state();
    const result = buildLikeMatchPatch(before, { npcUid: 'npc_case' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.map((operation) => [operation.op, operation.path]), [
        ['add', '/推荐/冷却角色UID/-'],
        ['remove', '/推荐/当前队列/0'],
        ['add', '/玩家/推荐偏好/标签权重/SFW/电影'],
        ['add', '/玩家/推荐偏好/标签权重/SFW/夜猫子'],
        ['add', '/玩家/推荐偏好/标签权重/SFW/直接'],
        ['add', '/玩家/推荐偏好/标签权重/SFW/慢热'],
    ]);
    assert.equal(result.value.some((operation) => operation.path.startsWith('/角色池/')), false);
    assert.equal(result.value.some((operation) => operation.path.startsWith('/会话/')), false);
    assert.equal(validateControlledPatchAgainstState(before, result.value).ok, true);
    assert.deepEqual(before, state());
    assert.deepEqual(buildControlledPatch(before, { kind: 'like', npcUid: 'npc_case' }), result);
});

test('homepage like ignores a refusal threshold because only the match tools establish mutual matching', () => {
    const before = state({ threshold: 90 });
    const result = buildLikeMatchPatch(before, { npcUid: 'npc_case' });
    assert.equal(result.ok, true);
    assert.equal(result.value.some((operation) => operation.path.startsWith('/会话/')), false);
    assert.equal(result.value.some((operation) => operation.path.endsWith('/状态')), false);
    assert.equal(validateControlledPatchAgainstState(before, result.value).ok, true);
});

test('a saved favourite is no longer a homepage like target but can still be disliked', () => {
    const likedState = state();
    likedState.角色池.npc_case = likedState.推荐.临时候选池.npc_case;
    delete likedState.推荐.临时候选池.npc_case;
    likedState.推荐.当前队列 = [];
    likedState.推荐.收藏角色UID = ['npc_case'];

    const liked = buildControlledPatch(likedState, { kind: 'like', npcUid: 'npc_case' });
    assert.equal(liked.ok, false);
    assert.equal(liked.code, 'like_preference_source_not_available');

    const dislikedState = state();
    dislikedState.角色池.npc_case = dislikedState.推荐.临时候选池.npc_case;
    delete dislikedState.推荐.临时候选池.npc_case;
    dislikedState.推荐.当前队列 = [];
    dislikedState.推荐.收藏角色UID = ['npc_case'];
    const disliked = buildControlledPatch(dislikedState, { kind: 'dislike', npcUid: 'npc_case' });
    assert.equal(disliked.ok, true);
    assert.equal(disliked.value.some((operation) => operation.path === '/推荐/收藏角色UID/0' && operation.op === 'remove'), true);
    assert.equal(disliked.value.some((operation) => operation.path.startsWith('/推荐/当前队列/')), false);
    assert.equal(disliked.value.some((operation) => operation.path === '/玩家/推荐偏好/标签权重/SFW/电影' && operation.value === -3), true);
    assert.equal(validateControlledPatchAgainstState(dislikedState, disliked.value).ok, true);
});

test('a favourite can become a private chat without becoming a mutual-match list item', () => {
    const favoriteState = state();
    favoriteState.角色池.npc_case = favoriteState.推荐.临时候选池.npc_case;
    delete favoriteState.推荐.临时候选池.npc_case;
    favoriteState.推荐.当前队列 = [];
    favoriteState.推荐.收藏角色UID = ['npc_case'];
    const result = buildControlledPatch(favoriteState, { kind: 'start_private_chat', npcUid: 'npc_case' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.map((operation) => [operation.op, operation.path]), [
        ['remove', '/推荐/收藏角色UID/0'],
        ['replace', '/角色池/npc_case/与玩家关系/NPC专属匹配度'],
        ['replace', '/角色池/npc_case/与玩家关系/状态'],
        ['add', '/会话/chat_6'],
        ['replace', '/系统/UID计数器/会话'],
    ]);
    assert.equal(result.value[2].value, '已匹配');
    assert.equal(result.value[3].value.对象UID, 'npc_case');
    assert.equal(validateControlledPatchAgainstState(favoriteState, result.value).ok, true);
});

test('a favourite invitation below the role refusal threshold removes the favourite and records a rejection without a session', () => {
    const favoriteState = state({ threshold: 95 });
    favoriteState.角色池.npc_case = favoriteState.推荐.临时候选池.npc_case;
    delete favoriteState.推荐.临时候选池.npc_case;
    favoriteState.推荐.当前队列 = [];
    favoriteState.推荐.收藏角色UID = ['npc_case'];
    const result = buildControlledPatch(favoriteState, { kind: 'start_private_chat', npcUid: 'npc_case' });
    assert.equal(result.ok, true);
    assert.equal(result.value.some((operation) => operation.path.startsWith('/会话/')), false);
    assert.equal(result.value.find((operation) => operation.path.endsWith('/状态')).value, '已取消');
    assert.equal(validateControlledPatchAgainstState(favoriteState, result.value).ok, true);
});

test('AI match commits a brand-new npc_match role and matched session without touching favourites', () => {
    const before = state();
    before.推荐.收藏角色UID = ['npc_case'];
    const result = buildCandidateMatchSessionPatch(before, { candidate: candidate() });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.map((operation) => [operation.op, operation.path]), [
        ['add', '/角色池/npc_match_2'],
        ['add', '/会话/chat_6'],
        ['replace', '/系统/UID计数器/角色'],
        ['replace', '/系统/UID计数器/会话'],
    ]);
    assert.equal(result.value[0].value.与玩家关系.状态, '已匹配');
    assert.equal(result.value[1].value.对象UID, 'npc_match_2');
    assert.equal(validateControlledPatchAgainstState(before, result.value).ok, true);
});

test('AI match below the local cancellation threshold records a declined role without creating a session', () => {
    const before = state();
    const result = buildCandidateMatchOutcomePatch(before, { candidate: candidate(), accepted: false });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.map((operation) => [operation.op, operation.path]), [
        ['add', '/角色池/npc_match_2'],
        ['replace', '/系统/UID计数器/角色'],
    ]);
    assert.equal(result.value[0].value.与玩家关系.状态, '已取消');
    assert.equal(result.value.some((operation) => operation.path.startsWith('/会话/')), false);
    assert.equal(result.value.some((operation) => operation.path === '/系统/UID计数器/会话'), false);
    assert.equal(validateControlledPatchAgainstState(before, result.value).ok, true);

    const forged = structuredClone(result.value);
    forged[0].value.与玩家关系.状态 = '已匹配';
    assert.equal(validateControlledPatchAgainstState(before, forged).ok, false);
});
test('clicking a saved favourite again removes its bookmark and disposable candidate record', () => {
    const savedState = state();
    savedState.角色池.npc_case = savedState.推荐.临时候选池.npc_case;
    delete savedState.推荐.临时候选池.npc_case;
    savedState.推荐.当前队列 = [];
    savedState.推荐.收藏角色UID = ['npc_case'];
    const before = structuredClone(savedState);

    const removed = buildControlledPatch(savedState, { kind: 'unfavorite', npcUid: 'npc_case' });

    assert.equal(removed.ok, true);
    assert.deepEqual(removed.value.map((operation) => [operation.op, operation.path]), [
        ['remove', '/推荐/收藏角色UID/0'],
        ['remove', '/角色池/npc_case'],
    ]);
    assert.equal(validateControlledPatchAgainstState(savedState, removed.value).ok, true);
    assert.deepEqual(savedState, before);

    const matchedState = structuredClone(before);
    matchedState.角色池.npc_case.与玩家关系.状态 = '已匹配';
    matchedState.会话.chat_6 = { 对象UID: 'npc_case', 状态: '已匹配', 最近消息: [], 长期摘要: '', 已确认边界: '', 已确认承诺: '' };
    const retained = buildControlledPatch(matchedState, { kind: 'unfavorite', npcUid: 'npc_case' });
    assert.equal(retained.ok, true);
    assert.deepEqual(retained.value.map((operation) => [operation.op, operation.path]), [
        ['remove', '/推荐/收藏角色UID/0'],
    ], '已有私聊的角色只取消收藏标记，不能留下悬空会话。');
    assert.equal(validateControlledPatchAgainstState(matchedState, retained.value).ok, true);
});

test('forged mutual-match session or relationship operation is rejected before the MVU parser', () => {
    const before = state();
    const result = buildCandidateMatchSessionPatch(before, { candidate: candidate() });
    const forged = structuredClone(result.value);
    forged[1].value.对象UID = 'npc_other';
    assert.equal(validateControlledPatchAgainstState(before, forged).ok, false);
    const nameForged = structuredClone(result.value);
    nameForged[0].value.公开资料.昵称 = '智核玩家';
    assert.equal(validateControlledPatchAgainstState(before, nameForged).ok, false);
});



test('like, favorite and dislike derive public tag preference weights locally and clamp them', () => {
    const likedState = state();
    likedState.玩家.推荐偏好.标签权重.SFW = { 电影: 4, 夜猫子: -4 };
    const liked = buildControlledPatch(likedState, { kind: 'like', npcUid: 'npc_case' });
    assert.equal(liked.ok, true);
    assert.deepEqual(liked.value.slice(-4).map(({ op, path, value }) => [op, path, value]), [
        ['replace', '/玩家/推荐偏好/标签权重/SFW/电影', 5],
        ['replace', '/玩家/推荐偏好/标签权重/SFW/夜猫子', -1],
        ['add', '/玩家/推荐偏好/标签权重/SFW/直接', 3],
        ['add', '/玩家/推荐偏好/标签权重/SFW/慢热', 3],
    ]);
    assert.equal(validateControlledPatchAgainstState(likedState, liked.value).ok, true);

    const favoriteState = state();
    favoriteState.玩家.推荐偏好.标签权重.SFW = { 电影: 5 };
    const favorite = buildControlledPatch(favoriteState, { kind: 'favorite', npcUid: 'npc_case' });
    assert.equal(favorite.ok, true);
    assert.deepEqual(favorite.value.slice(-3).map(({ op, path, value }) => [op, path, value]), [
        ['add', '/玩家/推荐偏好/标签权重/SFW/夜猫子', 1],
        ['add', '/玩家/推荐偏好/标签权重/SFW/直接', 1],
        ['add', '/玩家/推荐偏好/标签权重/SFW/慢热', 1],
    ]);

    const dislikeState = state();
    dislikeState.玩家.推荐偏好.标签权重.SFW = { 电影: -4 };
    const dislike = buildControlledPatch(dislikeState, { kind: 'dislike', npcUid: 'npc_case' });
    assert.equal(dislike.ok, true);
    assert.deepEqual(dislike.value.slice(-4).map(({ op, path, value }) => [op, path, value]), [
        ['replace', '/玩家/推荐偏好/标签权重/SFW/电影', -5],
        ['add', '/玩家/推荐偏好/标签权重/SFW/夜猫子', -3],
        ['add', '/玩家/推荐偏好/标签权重/SFW/直接', -3],
        ['add', '/玩家/推荐偏好/标签权重/SFW/慢热', -3],
    ]);
    assert.equal(validateControlledPatchAgainstState(dislikeState, dislike.value).ok, true);
});

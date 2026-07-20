import test from 'node:test';
import assert from 'node:assert/strict';
import { buildControlledPatch, buildLikeMatchPatch, validateControlledPatchAgainstState } from '../controlled-patch.js';

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
        与玩家关系: { 状态: '陌生', 全局账号表现: 60, NPC专属匹配度: 0, 好感: 0, 信任: 0, 戒备: 20, 面基意愿: 0 },
    };
}

function state({ threshold = 60 } = {}) {
    return {
        系统: { UID计数器: { 角色: 1, 会话: 5, 面基: 0 } }, 软件: { 内容模式: 'SFW', 关于软件点击数: 0 },
        玩家: { 成人验证: true, 公开资料: { 城市: '上海', 寻找意图: '聊天约会', 兴趣标签: ['电影', '展览'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'] }, 推荐偏好: { 标签权重: {} } },
        角色池: {}, 会话: {},
        推荐: { 当前队列: ['npc_case'], 临时候选池: { npc_case: candidate({ threshold }) }, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
    };
}

test('like atomically moves an adult candidate, creates a matched session, and scores it locally', () => {
    const before = state();
    const result = buildLikeMatchPatch(before, { npcUid: 'npc_case' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.map((operation) => [operation.op, operation.path]), [
        ['move', '/角色池/npc_case'],
        ['replace', '/角色池/npc_case/与玩家关系/NPC专属匹配度'],
        ['replace', '/角色池/npc_case/与玩家关系/状态'],
        ['add', '/会话/chat_6'],
        ['replace', '/系统/UID计数器/会话'],
        ['remove', '/推荐/当前队列/0'],
        ['add', '/玩家/推荐偏好/标签权重/电影'],
        ['add', '/玩家/推荐偏好/标签权重/夜猫子'],
        ['add', '/玩家/推荐偏好/标签权重/直接'],
        ['add', '/玩家/推荐偏好/标签权重/慢热'],
    ]);
    assert.equal(result.value[1].value, 100);
    assert.equal(result.value[2].value, '已匹配');
    assert.equal(result.value[3].value.对象UID, 'npc_case');
    assert.equal(validateControlledPatchAgainstState(before, result.value).ok, true);
    assert.deepEqual(before, state());
    assert.deepEqual(buildControlledPatch(before, { kind: 'like', npcUid: 'npc_case' }), result);
});

test('like records a refusal without creating a session when the configured threshold is not met', () => {
    const before = state({ threshold: 90 });
    const result = buildLikeMatchPatch(before, { npcUid: 'npc_case' });
    assert.equal(result.ok, true);
    assert.equal(result.value.some((operation) => operation.path.startsWith('/会话/')), false);
    assert.equal(result.value.find((operation) => operation.path.endsWith('/状态')).value, '已取消');
    assert.equal(validateControlledPatchAgainstState(before, result.value).ok, true);
});

test('a saved favourite can still be liked or disliked without a stale queue rejection', () => {
    const likedState = state();
    likedState.角色池.npc_case = likedState.推荐.临时候选池.npc_case;
    delete likedState.推荐.临时候选池.npc_case;
    likedState.推荐.当前队列 = [];
    likedState.推荐.收藏角色UID = ['npc_case'];

    const liked = buildControlledPatch(likedState, { kind: 'like', npcUid: 'npc_case' });
    assert.equal(liked.ok, true);
    assert.equal(liked.value.some((operation) => operation.op === 'move'), false);
    assert.equal(liked.value.some((operation) => operation.path.startsWith('/推荐/当前队列/')), false);
    assert.equal(liked.value.some((operation) => operation.path === '/玩家/推荐偏好/标签权重/电影' && operation.value === 3), true);
    assert.equal(validateControlledPatchAgainstState(likedState, liked.value).ok, true);

    const dislikedState = state();
    dislikedState.角色池.npc_case = dislikedState.推荐.临时候选池.npc_case;
    delete dislikedState.推荐.临时候选池.npc_case;
    dislikedState.推荐.当前队列 = [];
    dislikedState.推荐.收藏角色UID = ['npc_case'];
    const disliked = buildControlledPatch(dislikedState, { kind: 'dislike', npcUid: 'npc_case' });
    assert.equal(disliked.ok, true);
    assert.equal(disliked.value.some((operation) => operation.path === '/推荐/收藏角色UID/0' && operation.op === 'remove'), true);
    assert.equal(disliked.value.some((operation) => operation.path.startsWith('/推荐/当前队列/')), false);
    assert.equal(disliked.value.some((operation) => operation.path === '/玩家/推荐偏好/标签权重/电影' && operation.value === -3), true);
    assert.equal(validateControlledPatchAgainstState(dislikedState, disliked.value).ok, true);
});

test('forged session or score operation is rejected before the MVU parser', () => {
    const before = state();
    const result = buildLikeMatchPatch(before, { npcUid: 'npc_case' });
    const forged = structuredClone(result.value);
    forged[3].value.对象UID = 'npc_other';
    assert.equal(validateControlledPatchAgainstState(before, forged).ok, false);
    const scoreForged = structuredClone(result.value);
    scoreForged[1].value = 99;
    assert.equal(validateControlledPatchAgainstState(before, scoreForged).ok, false);
});



test('like, favorite and dislike derive public tag preference weights locally and clamp them', () => {
    const likedState = state();
    likedState.玩家.推荐偏好.标签权重 = { 电影: 4, 夜猫子: -4 };
    const liked = buildControlledPatch(likedState, { kind: 'like', npcUid: 'npc_case' });
    assert.equal(liked.ok, true);
    assert.deepEqual(liked.value.slice(-4).map(({ op, path, value }) => [op, path, value]), [
        ['replace', '/玩家/推荐偏好/标签权重/电影', 5],
        ['replace', '/玩家/推荐偏好/标签权重/夜猫子', -1],
        ['add', '/玩家/推荐偏好/标签权重/直接', 3],
        ['add', '/玩家/推荐偏好/标签权重/慢热', 3],
    ]);
    assert.equal(validateControlledPatchAgainstState(likedState, liked.value).ok, true);

    const favoriteState = state();
    favoriteState.玩家.推荐偏好.标签权重 = { 电影: 5 };
    const favorite = buildControlledPatch(favoriteState, { kind: 'favorite', npcUid: 'npc_case' });
    assert.equal(favorite.ok, true);
    assert.deepEqual(favorite.value.slice(-3).map(({ op, path, value }) => [op, path, value]), [
        ['add', '/玩家/推荐偏好/标签权重/夜猫子', 1],
        ['add', '/玩家/推荐偏好/标签权重/直接', 1],
        ['add', '/玩家/推荐偏好/标签权重/慢热', 1],
    ]);

    const dislikeState = state();
    dislikeState.玩家.推荐偏好.标签权重 = { 电影: -4 };
    const dislike = buildControlledPatch(dislikeState, { kind: 'dislike', npcUid: 'npc_case' });
    assert.equal(dislike.ok, true);
    assert.deepEqual(dislike.value.slice(-4).map(({ op, path, value }) => [op, path, value]), [
        ['replace', '/玩家/推荐偏好/标签权重/电影', -5],
        ['add', '/玩家/推荐偏好/标签权重/夜猫子', -3],
        ['add', '/玩家/推荐偏好/标签权重/直接', -3],
        ['add', '/玩家/推荐偏好/标签权重/慢热', -3],
    ]);
    assert.equal(validateControlledPatchAgainstState(dislikeState, dislike.value).ok, true);
});

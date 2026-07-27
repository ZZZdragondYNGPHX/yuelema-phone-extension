import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreFavoritePrivateChatInvitation, scoreKeywordOnlyCandidateMatch, scoreLocalCandidateMatch } from '../match-scoring.js';

test('favourite private-chat invitation combines local keyword taste and heart-card fields before threshold comparison', () => {
    const result = scoreFavoritePrivateChatInvitation({
        年龄段: '26-30', 性别: '男', 性取向: '异性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '认真约会',
        兴趣标签: ['电影'], 生活方式标签: [], 性格标签: [], 沟通风格标签: [],
    }, {
        年龄段: '25-29', 性别: '女', 性取向: '异性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '约会',
        兴趣标签: ['电影'], 生活方式标签: [], 性格标签: [], 沟通风格标签: [],
    }, { 电影: 5 });
    assert.equal(result.eligible, true);
    assert.equal(result.heartCardScore, 90);
    assert.equal(result.keywordScore, 100);
    assert.equal(result.score, 94);

    const declined = scoreFavoritePrivateChatInvitation({
        性别: '女', 性取向: '异性恋', 城市: '上海', 兴趣标签: ['电影'], 生活方式标签: [], 性格标签: [], 沟通风格标签: [],
    }, {
        性别: '女', 性取向: '异性恋', 城市: '上海', 兴趣标签: ['电影'], 生活方式标签: [], 性格标签: [], 沟通风格标签: [],
    }, { 电影: 5 });
    assert.equal(declined.eligible, false);
    assert.equal(declined.score, 0);
});


test('candidate matching score is local, deterministic, and uses the current effective keyword weights', () => {
    const compatiblePlayer = {
        年龄段: '26-30', 性别: '男', 性取向: '异性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '认真约会',
        兴趣标签: ['电影'], 生活方式标签: ['徒步'], 性格标签: [], 沟通风格标签: [],
    };
    const compatibleNpc = {
        年龄段: '25-29', 性别: '女', 性取向: '异性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '约会',
        兴趣标签: ['电影'], 生活方式标签: ['徒步'], 性格标签: [], 沟通风格标签: [],
    };
    const local = scoreLocalCandidateMatch(compatiblePlayer, compatibleNpc, { 电影: 5, 徒步: 5 });
    assert.deepEqual(local, {
        score: 94, eligible: true, heartCardScore: 90, keywordScore: 100, sharedTags: 2,
        reasons: ['性别与性取向相容', '同城', '寻找意图相近', '年龄段接近', '相遇距离已填写', '公开关键词重合 2 项'],
    });

    const disliked = scoreLocalCandidateMatch(compatiblePlayer, compatibleNpc, { 电影: -5, 徒步: -5 });
    assert.equal(disliked.score, 64);
    assert.equal(disliked.keywordScore, 25);
});

test('neutral keyword weights stay neutral and sparse overlap is a bounded bonus', () => {
    const player = {
        年龄段: '26-30', 性别: '男', 性取向: '异性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '认真约会',
        兴趣标签: ['电影'], 生活方式标签: [], 性格标签: [], 沟通风格标签: [],
    };
    const npc = {
        年龄段: '25-29', 性别: '女', 性取向: '异性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '约会',
        兴趣标签: ['电影', '徒步'], 生活方式标签: ['夜猫子'], 性格标签: ['慢热'], 沟通风格标签: ['长消息'],
    };
    const neutral = scoreFavoritePrivateChatInvitation(player, npc, {});
    assert.equal(neutral.heartCardScore, 90);
    assert.equal(neutral.keywordScore, 55, '五项中一项重合应从中性 50 获得有限加分，而非因未重合项跌到 30 分附近');
    assert.equal(neutral.score, 76);

    const noOverlap = scoreFavoritePrivateChatInvitation({ ...player, 兴趣标签: [] }, npc, {});
    assert.equal(noOverlap.keywordScore, 50, '零权重且无重合必须保持中性 50');
    assert.equal(noOverlap.score, 74);
});

test('描述匹配关键词评分只使用有效关键词权重，性别与其他资料字段不影响结果', () => {
    const npc = {
        年龄段: '25-29', 性别: '女', 性取向: '异性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '约会',
        兴趣标签: ['电影'], 生活方式标签: ['徒步'], 性格标签: ['慢热'], 沟通风格标签: [],
    };
    // 电影(5)=100、徒步(2)=70、慢热未命中=50 → (100+70+50)/3 = 73（四舍五入）。
    const scored = scoreKeywordOnlyCandidateMatch(npc, [{ keyword: '电影', weight: 5 }, { keyword: '徒步', weight: 2 }]);
    assert.deepEqual(scored, {
        score: 73, eligible: true, heartCardScore: null, keywordScore: 73, sharedTags: 2,
        reasons: ['关键词命中 2 项'],
    });

    // 同一 NPC 换性别/性取向/城市，关键词分数完全不变——资料字段不参与。
    const differentProfileFields = { ...npc, 性别: '男', 性取向: '同性恋', 城市: '北京', 年龄段: '48岁' };
    assert.deepEqual(scoreKeywordOnlyCandidateMatch(differentProfileFields, [{ keyword: '电影', weight: 5 }, { keyword: '徒步', weight: 2 }]), scored);

    // 负权重压低分数；无标签候选保持中性且不因资料被判不合格。
    const negative = scoreKeywordOnlyCandidateMatch(npc, [{ keyword: '电影', weight: -5 }]);
    assert.equal(negative.score, 33);
    const noTags = scoreKeywordOnlyCandidateMatch({ ...npc, 兴趣标签: [], 生活方式标签: [], 性格标签: [], 沟通风格标签: [] }, [{ keyword: '电影', weight: 5 }]);
    assert.equal(noTags.score, 50);
    assert.equal(noTags.eligible, true);
});

test('concise target-gender orientation values are hard reciprocal filters', () => {
    const player = {
        年龄段: '26-30', 性别: '男', 性取向: '女', 城市: '上海', 距离范围: '10 km', 寻找意图: '认真约会',
        兴趣标签: [], 生活方式标签: [], 性格标签: [], 沟通风格标签: [],
    };
    const incompatibleMan = {
        年龄段: '25-29', 性别: '男', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '约会',
        兴趣标签: [], 生活方式标签: [], 性格标签: [], 沟通风格标签: [],
    };
    const compatibleWoman = { ...incompatibleMan, 性别: '女', 性取向: '异性恋' };
    assert.equal(scoreLocalCandidateMatch(player, incompatibleMan, {}).eligible, false);
    assert.equal(scoreLocalCandidateMatch(player, compatibleWoman, {}).eligible, true);
});

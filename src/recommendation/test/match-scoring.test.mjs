import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreFavoritePrivateChatInvitation, scorePublicCompatibility, scoreTwoLayerMatch } from '../match-scoring.js';

const player = {
    城市: '上海', 寻找意图: '聊天约会', 兴趣标签: ['电影', '展览'],
    生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'],
};

const npc = {
    城市: '上海', 寻找意图: '约会', 兴趣标签: ['电影'],
    生活方式标签: ['夜猫子'], 性格标签: ['理性'], 沟通风格标签: ['慢热'],
};

test('public compatibility is deterministic and uses only public fields', () => {
    const result = scorePublicCompatibility(player, npc);
    assert.equal(result.npcSpecificScore, 92);
    assert.deepEqual(result.reasons, ['同城', '寻找意图相近', '公开标签重合 3 项']);
    assert.equal(scoreTwoLayerMatch(60, result.npcSpecificScore), 74);
});

test('two-layer matching rejects invalid scores instead of coercing them', () => {
    assert.equal(scoreTwoLayerMatch('60', 90), null);
    assert.equal(scoreTwoLayerMatch(60, 101), null);
});

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

import test from 'node:test';
import assert from 'node:assert/strict';
import { materializeCandidateMatchDraft } from '../match-candidate-materializer.js';

function draft() {
    return {
        profile: {
            昵称: '林舒', 年龄段: '25-30岁', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10km以内',
            寻找意图: '认真约会', 简介: '喜欢雨夜散步和独立电影。',
            兴趣标签: ['独立电影'], 生活方式标签: ['夜行散步'], 性格标签: ['温和'], 沟通风格标签: ['深度对话'],
        },
        explanation: '公开标签与本次偏好有较高重合。',
        matchScore: 91,
    };
}

test('materialized match candidate keeps AI input public-only and derives internal defaults locally', () => {
    const result = materializeCandidateMatchDraft(draft());
    assert.equal(result.candidate.成人验证, true);
    assert.equal(result.candidate.公开资料.昵称, '林舒');
    assert.equal(result.candidate.公开资料.头像引用, '');
    assert.equal(result.candidate.隐藏资料.实际年龄, 25);
    assert.equal(result.candidate.与玩家关系.状态, '陌生');
    assert.equal(result.candidate.与玩家关系.NPC专属匹配度, 91);
    assert.equal(Object.hasOwn(result.candidate.公开资料, '隐藏资料'), false);
});

test('materialized match candidate rejects role-like non-person names before any MVU write', () => {
    const invalid = draft();
    invalid.profile.昵称 = '智核玩家';
    assert.throws(() => materializeCandidateMatchDraft(invalid));
});

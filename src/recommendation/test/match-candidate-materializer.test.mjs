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

test('materialized match candidate ignores model score, derives local score, and exposes threshold comparison data', () => {
    const playerPublicProfile = {
        年龄段: '26-30岁', 性别: '男', 性取向: '异性恋', 城市: '上海', 距离范围: '10km以内',
        寻找意图: '认真约会', 简介: '喜欢雨夜散步和独立电影。',
        兴趣标签: ['独立电影'], 生活方式标签: ['夜行散步'], 性格标签: ['温和'], 沟通风格标签: ['深度对话'],
    };
    const localWeights = [
        { keyword: '独立电影', weight: 5 }, { keyword: '夜行散步', weight: 5 },
        { keyword: '温和', weight: 5 }, { keyword: '深度对话', weight: 5 },
    ];
    const untrusted = draft();
    untrusted.matchScore = 1;
    const result = materializeCandidateMatchDraft(untrusted, { playerPublicProfile, effectiveKeywordWeights: localWeights });
    assert.equal(result.candidate.成人验证, true);
    assert.equal(result.candidate.公开资料.昵称, '林舒');
    assert.equal(result.candidate.公开资料.头像引用, '');
    assert.equal(result.candidate.隐藏资料.实际年龄, 25);
    assert.equal(result.candidate.与玩家关系.状态, '陌生');
    assert.equal(result.candidate.与玩家关系.NPC专属匹配度, 94);
    assert.equal(result.matchScore, 94);
    assert.equal(result.cancellationThreshold, 75);
    assert.equal(result.meetsCancellationThreshold, true);
    assert.equal(result.shouldEstablishSession, true);
    assert.equal(result.evaluation.heartCardScore, 90);
    assert.equal(result.evaluation.keywordScore, 100);
    assert.equal(Object.hasOwn(result.candidate.公开资料, '隐藏资料'), false);
});

test('materializer never falls back to an unattested legacy model matchScore', () => {
    const untrusted = draft();
    untrusted.matchScore = 100;
    const result = materializeCandidateMatchDraft(untrusted);
    assert.equal(result.matchScore, 33);
    assert.equal(result.candidate.与玩家关系.NPC专属匹配度, 33);
    assert.equal(result.meetsCancellationThreshold, false);
    assert.equal(result.shouldEstablishSession, false);
});

test('materialized match candidate rejects occupational names and concrete addresses before any MVU write', () => {
    const occupationalName = draft();
    occupationalName.profile.昵称 = '摄影师';
    assert.throws(
        () => materializeCandidateMatchDraft(occupationalName),
        error => error instanceof TypeError && error.code === 'candidate_match_response_candidate_profile_invalid',
    );

    const concreteAddress = draft();
    concreteAddress.profile.简介 = '我住在具体住址南京西路100号。';
    assert.throws(
        () => materializeCandidateMatchDraft(concreteAddress, { contentMode: 'NSFW' }),
        error => error instanceof TypeError && error.code === 'candidate_match_response_candidate_profile_invalid',
    );
});

test('materialized match candidate preserves the shared SFW/NSFW public-tag contract', () => {
    const adultTag = draft();
    adultTag.profile.生活方式标签 = ['情趣探索'];
    assert.throws(
        () => materializeCandidateMatchDraft(adultTag, { contentMode: 'SFW' }),
        error => error instanceof TypeError && error.code === 'candidate_match_response_candidate_profile_invalid',
    );

    const normalized = materializeCandidateMatchDraft(adultTag, { contentMode: 'NSFW' });
    assert.deepEqual(normalized.candidate.公开资料.生活方式标签, ['情趣探索']);

    const adultTermOutsideTags = draft();
    adultTermOutsideTags.profile.简介 = '偏好翘臀，也喜欢独立电影。';
    assert.throws(
        () => materializeCandidateMatchDraft(adultTermOutsideTags, { contentMode: 'NSFW' }),
        error => error instanceof TypeError && error.code === 'candidate_match_response_candidate_profile_invalid',
    );
});

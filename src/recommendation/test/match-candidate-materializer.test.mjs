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
        drawing: {
            core_dna: 'hair color{dark brown hair}; eye color{brown eyes}; facial features{gentle oval face}; body type{slender adult woman}',
            outfit_dna: 'outerwear{beige trench coat}; footwear{black ankle boots}; accessories{silver earrings}',
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
    assert.deepEqual(result.candidate.绘图, draft().drawing);
    assert.equal(result.candidate.与玩家关系.状态, '陌生');
    assert.equal(result.candidate.与玩家关系.NPC专属匹配度, 94);
    assert.deepEqual(
        { 友情值: result.candidate.与玩家关系.友情值, 心动值: result.candidate.与玩家关系.心动值, 欲望值: result.candidate.与玩家关系.欲望值 },
        { 友情值: 0, 心动值: 0, 欲望值: 0 },
    );
    assert.equal(result.matchScore, 94);
    assert.equal(result.cancellationThreshold, 50);
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
    assert.equal(result.matchScore, 41);
    assert.equal(result.candidate.与玩家关系.NPC专属匹配度, 41);
    assert.equal(result.meetsCancellationThreshold, false);
    assert.equal(result.shouldEstablishSession, false);
});

test('a 57 percent compatible candidate now clears the shared loose acceptance line', () => {
    const result = materializeCandidateMatchDraft(draft(), {
        playerPublicProfile: {
            城市: '上海', 寻找意图: '认真约会',
            兴趣标签: [], 生活方式标签: [], 性格标签: [], 沟通风格标签: [],
        },
        effectiveKeywordWeights: [
            { keyword: '独立电影', weight: -1 },
            { keyword: '夜行散步', weight: -1 },
        ],
    });
    assert.equal(result.matchScore, 57);
    assert.equal(result.cancellationThreshold, 50);
    assert.equal(result.shouldEstablishSession, true);
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

test('materialized match candidate accepts adult public tags in both modes since the SFW blocklist removal', () => {
    const adultTag = draft();
    adultTag.profile.生活方式标签 = ['情趣探索'];
    assert.deepEqual(
        materializeCandidateMatchDraft(adultTag, { contentMode: 'SFW' }).candidate.公开资料.生活方式标签,
        ['情趣探索'],
        'SFW 不再把成年人成人词汇当作拒绝理由',
    );

    const normalized = materializeCandidateMatchDraft(adultTag, { contentMode: 'NSFW' });
    assert.deepEqual(normalized.candidate.公开资料.生活方式标签, ['情趣探索']);

    const adultTermOutsideTags = draft();
    adultTermOutsideTags.profile.简介 = '偏好翘臀，也喜欢独立电影。';
    assert.equal(
        materializeCandidateMatchDraft(adultTermOutsideTags, { contentMode: 'NSFW' }).candidate.公开资料.简介,
        '偏好翘臀，也喜欢独立电影。',
    );
});

test('物化器按生成人设标签三档映射压力阈值，匹配分闸门阈值保持固定', () => {
    const tolerant = draft();
    tolerant.profile.性格标签 = ['开朗'];
    const tolerantResult = materializeCandidateMatchDraft(tolerant);
    assert.equal(tolerantResult.candidate.已读不回阈值, 60);
    assert.equal(tolerantResult.candidate.拉黑阈值, 95);

    const guarded = draft();
    guarded.profile.沟通风格标签 = ['慢热'];
    const guardedResult = materializeCandidateMatchDraft(guarded);
    assert.equal(guardedResult.candidate.已读不回阈值, 50);
    assert.equal(guardedResult.candidate.拉黑阈值, 80);

    const mixed = draft();
    mixed.profile.性格标签 = ['开朗', '敏感'];
    const mixedResult = materializeCandidateMatchDraft(mixed);
    assert.equal(mixedResult.candidate.已读不回阈值, 55);
    assert.equal(mixedResult.candidate.拉黑阈值, 90);

    const neutralResult = materializeCandidateMatchDraft(draft());
    assert.equal(neutralResult.candidate.已读不回阈值, 55);
    assert.equal(neutralResult.candidate.拉黑阈值, 90);

    for (const result of [tolerantResult, guardedResult, mixedResult, neutralResult]) {
        // 拒绝/取消匹配阈值是本地匹配分闸门，人设映射不得改动它们的语义。
        assert.equal(result.candidate.拒绝阈值, 50);
        assert.equal(result.candidate.取消匹配阈值, 50);
        // 三档都必须满足生成约束：拉黑 ≥60 且高于已读不回。
        assert.ok(result.candidate.拉黑阈值 >= 60);
        assert.ok(result.candidate.拉黑阈值 > result.candidate.已读不回阈值);
    }
});

test('本地物化失败先登记控制台诊断再原样上抛', async () => {
    const { consumeRecommendationDiagnostics } = await import('../recommendation-diagnostics.js');
    consumeRecommendationDiagnostics('candidate_match');
    assert.throws(() => materializeCandidateMatchDraft({ profile: null, drawing: null, explanation: '' }));
    const diagnostics = consumeRecommendationDiagnostics('candidate_match', { code: 'candidate_match_response_invalid' });
    assert.ok(diagnostics, '物化失败必须登记诊断');
    assert.equal(diagnostics.stage, '本地物化（草稿转完整候选）');
    assert.match(diagnostics.actual, /校验未通过|本地物化失败/u);
});

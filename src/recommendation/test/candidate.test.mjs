import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPLETE_CANDIDATE_OUTPUT_CONTRACT, normalizeGeneratedCandidate } from '../candidate.js';

function completeAdultCandidate() {
    return {
        成人验证: true,
        公开资料: {
            昵称: '林澈',
            头像引用: 'https://example.invalid/avatar.png',
            年龄段: '25-29',
            性别: '女',
            性取向: '双性恋',
            城市: '上海',
            距离范围: '10 km',
            寻找意图: '先聊天再约会',
            简介: '周末会去看展，也喜欢深夜散步。',
            兴趣标签: ['电影', '夜跑'],
            生活方式标签: ['夜猫子'],
            性格标签: ['直接'],
            沟通风格标签: ['慢热'],
        },
        仅好友资料: {
            关系状态: '单身',
            边界与偏好: '先确认聊天边界，尊重拒绝。',
        },
        隐藏资料: {
            实际年龄: 28,
            私人备注: '对临时失约很敏感。',
        },
        绘图: {
            core_dna: 'adult woman, short black hair, warm brown eyes',
            outfit_dna: 'cream cardigan, dark denim skirt',
        },
        偏好与边界: '偏好坦诚交流，不接受骚扰或胁迫。',
        拒绝阈值: 35,
        已读不回阈值: 55,
        取消匹配阈值: 75,
        拉黑阈值: 90,
        与玩家关系: {
            状态: '陌生',
            全局账号表现: 68,
            NPC专属匹配度: 72,
            好感: 0,
            信任: 0,
            戒备: 10,
            面基意愿: 0,
            友情值: 0,
            心动值: 0,
            欲望值: 0,
        },
    };
}

function expectRejected(candidate, code) {
    assert.throws(
        () => normalizeGeneratedCandidate(candidate),
        error => error instanceof TypeError && error.code === code && !error.message.includes('林澈'),
    );
}

test('normalizes one complete adult candidate into a clean deep copy', () => {
    const input = completeAdultCandidate();
    const result = normalizeGeneratedCandidate(input);

    assert.deepEqual(result, input);
    assert.notStrictEqual(result, input);
    assert.notStrictEqual(result.公开资料, input.公开资料);
    assert.notStrictEqual(result.公开资料.兴趣标签, input.公开资料.兴趣标签);
    assert.notStrictEqual(result.与玩家关系, input.与玩家关系);
    assert.notStrictEqual(result.绘图, input.绘图);

    input.公开资料.兴趣标签.push('篡改');
    input.隐藏资料.私人备注 = '篡改';
    input.绘图.core_dna = 'tampered';
    assert.deepEqual(result.公开资料.兴趣标签, ['电影', '夜跑']);
    assert.equal(result.隐藏资料.私人备注, '对临时失约很敏感。');
    assert.equal(result.绘图.core_dna, 'adult woman, short black hair, warm brown eyes');
});

test('rejects system labels and role concepts where a generated personal name is required', () => {
    const conceptName = completeAdultCandidate();
    conceptName.公开资料.昵称 = '智核玩家';
    assert.throws(
        () => normalizeGeneratedCandidate(conceptName, { requirePersonalName: true }),
        error => error instanceof TypeError && error.code === '公开资料.昵称:not_personal_name',
    );

    const roleName = completeAdultCandidate();
    roleName.公开资料.昵称 = '摄影师';
    assert.throws(
        () => normalizeGeneratedCandidate(roleName, { requirePersonalName: true }),
        error => error instanceof TypeError && error.code === '公开资料.昵称:not_personal_name',
    );
});

test('rejects an underage or not-explicitly-adult candidate', () => {
    const underage = completeAdultCandidate();
    underage.隐藏资料.实际年龄 = 17;
    expectRejected(underage, '隐藏资料.实际年龄:integer_out_of_range');

    const publicUnderage = completeAdultCandidate();
    publicUnderage.公开资料.年龄段 = '16-17';
    expectRejected(publicUnderage, '公开资料.年龄段:underage');
});

test('rejects unknown and sensitive fields rather than silently stripping them', () => {
    const unknown = completeAdultCandidate();
    unknown.公开资料.额外说明 = '不应保留';
    expectRejected(unknown, '公开资料:unknown_field');

    const sensitive = completeAdultCandidate();
    sensitive.apiKey = 'do-not-store';
    expectRejected(sensitive, '候选人:sensitive_key');
});

test('rejects prototype-pollution keys and non-plain records', () => {
    const polluted = JSON.parse(JSON.stringify(completeAdultCandidate()));
    Object.defineProperty(polluted.公开资料, '__proto__', { value: 'polluted', enumerable: true });
    expectRejected(polluted, '公开资料:dangerous_key');

    const inherited = Object.create({ 成人验证: true });
    Object.assign(inherited, completeAdultCandidate());
    expectRejected(inherited, '候选人:unsafe_prototype');
});

test('rejects a missing private layer or private field', () => {
    const missingLayer = completeAdultCandidate();
    delete missingLayer.隐藏资料;
    expectRejected(missingLayer, '候选人:incomplete_or_unknown_fields');

    const missingPrivateField = completeAdultCandidate();
    delete missingPrivateField.仅好友资料.边界与偏好;
    expectRejected(missingPrivateField, '仅好友资料:incomplete_or_unknown_fields');
});

test('rejects non-new relationship states and invalid relationship numbers', () => {
    const matched = completeAdultCandidate();
    matched.与玩家关系.状态 = '已匹配';
    expectRejected(matched, '与玩家关系.状态:not_new_candidate');

    const invalidNumber = completeAdultCandidate();
    invalidNumber.与玩家关系.好感 = 12.5;
    expectRejected(invalidNumber, '与玩家关系.好感:integer_out_of_range');
});

test('rejects overlong text and HTML-like text without invoking network or DOM APIs', () => {
    const overlong = completeAdultCandidate();
    overlong.公开资料.简介 = '长'.repeat(501);
    expectRejected(overlong, '公开资料.简介:too_long');

    const html = completeAdultCandidate();
    html.仅好友资料.边界与偏好 = '<script>alert(1)</script>';
    expectRejected(html, '仅好友资料.边界与偏好:html_not_allowed');
});


test('SFW no longer blocks adult-oriented public tags; hard public-content bans stay mode-independent', () => {
    const candidate = completeAdultCandidate();
    candidate.公开资料.生活方式标签 = ['翘臀'];
    assert.deepEqual(
        normalizeGeneratedCandidate(candidate, { contentMode: 'SFW' }).公开资料.生活方式标签,
        ['翘臀'],
    );

    const coercive = completeAdultCandidate();
    coercive.公开资料.简介 = '喜欢强迫别人。';
    assert.throws(
        () => normalizeGeneratedCandidate(coercive, { contentMode: 'SFW' }),
        error => error instanceof TypeError && error.code === '公开资料.简介:prohibited_public_content',
    );
});

test('NSFW permits adult-oriented public profile text while retaining adult, consent, privacy, and software-layer boundaries', () => {
    const candidate = completeAdultCandidate();
    candidate.公开资料.生活方式标签 = ['翘臀', '情趣探索'];
    const normalized = normalizeGeneratedCandidate(candidate, { contentMode: 'NSFW' });
    assert.deepEqual(normalized.公开资料.生活方式标签, ['翘臀', '情趣探索']);

    // The in-memory mode provenance remains available to the subsequent controlled
    // candidate validation pass, but never becomes a profile field or serialized data.
    assert.deepEqual(normalizeGeneratedCandidate(normalized).公开资料.生活方式标签, ['翘臀', '情趣探索']);

    const adultTermOutsideTags = completeAdultCandidate();
    adultTermOutsideTags.公开资料.简介 = '偏好翘臀。';
    assert.equal(normalizeGeneratedCandidate(adultTermOutsideTags, { contentMode: 'NSFW' }).公开资料.简介, '偏好翘臀。');

    const inPersonAdultPreference = completeAdultCandidate();
    inPersonAdultPreference.公开资料.简介 = '想找明确成年的自愿对象线下做爱，也喜欢开房后的完整性爱体验。';
    assert.equal(
        normalizeGeneratedCandidate(inPersonAdultPreference, { contentMode: 'NSFW' }).公开资料.简介,
        '想找明确成年的自愿对象线下做爱，也喜欢开房后的完整性爱体验。',
    );

    const coerciveTag = completeAdultCandidate();
    coerciveTag.公开资料.兴趣标签 = ['非自愿'];
    assert.throws(
        () => normalizeGeneratedCandidate(coerciveTag, { contentMode: 'NSFW' }),
        error => error instanceof TypeError && error.code === '公开资料.兴趣标签[0]:prohibited_public_content',
    );

    const privateIdentifier = completeAdultCandidate();
    privateIdentifier.公开资料.简介 = '真实姓名是某某。';
    assert.throws(
        () => normalizeGeneratedCandidate(privateIdentifier, { contentMode: 'NSFW' }),
        error => error instanceof TypeError && error.code === '公开资料.简介:prohibited_public_content',
    );
});


test('generation contract requires all three bond fields with zero defaults', () => {
    const contract = COMPLETE_CANDIDATE_OUTPUT_CONTRACT.join('\n');
    assert.match(contract, /友情值、心动值、欲望值/u);
    assert.match(contract, /必须填写为 0/u);
});

test('generation contract states persona-derived threshold semantics and the hard block-threshold rules', () => {
    const contract = COMPLETE_CANDIDATE_OUTPUT_CONTRACT.join('\n');
    assert.match(contract, /性格标签、沟通风格与戒备心推导/u);
    assert.match(contract, /彻底断联的心理底线/u);
    assert.match(contract, /拉黑阈值不得低于 60/u);
    assert.match(contract, /必须大于已读不回阈值/u);
});

test('freshly generated candidates enforce rhythm-threshold sanity while legacy paths keep the plain range', () => {
    // requirePersonalName 标记“新 AI 生成”路径，默认启用阈值合理性约束。
    const lowBlock = completeAdultCandidate();
    lowBlock.已读不回阈值 = 20;
    lowBlock.拉黑阈值 = 45;
    assert.throws(
        () => normalizeGeneratedCandidate(lowBlock, { requirePersonalName: true }),
        error => error instanceof TypeError && error.code === '拉黑阈值:generated_below_minimum',
    );
    // 无标记（手动登记、模板导入、服务订单等存量路径）保持 0–100 宽范围。
    assert.equal(normalizeGeneratedCandidate(lowBlock).拉黑阈值, 45);

    const inverted = completeAdultCandidate();
    inverted.已读不回阈值 = 80;
    inverted.拉黑阈值 = 70;
    assert.throws(
        () => normalizeGeneratedCandidate(inverted, { enforceRhythmConsistency: true }),
        error => error instanceof TypeError && error.code === '拉黑阈值:generated_not_above_read_without_reply',
    );
    assert.equal(normalizeGeneratedCandidate(inverted).拉黑阈值, 70);

    const equalThresholds = completeAdultCandidate();
    equalThresholds.已读不回阈值 = 60;
    equalThresholds.拉黑阈值 = 60;
    assert.throws(
        () => normalizeGeneratedCandidate(equalThresholds, { enforceRhythmConsistency: true }),
        error => error instanceof TypeError && error.code === '拉黑阈值:generated_not_above_read_without_reply',
    );

    // 显式关闭优先于 requirePersonalName 推导的默认值。
    assert.equal(
        normalizeGeneratedCandidate(inverted, { requirePersonalName: true, enforceRhythmConsistency: false }).拉黑阈值,
        70,
    );

    // 合规组合在启用约束时原样通过。
    const compliant = completeAdultCandidate();
    assert.equal(normalizeGeneratedCandidate(compliant, { requirePersonalName: true }).拉黑阈值, 90);
});

test('freshly generated candidates enforce the guard cap and the opening-pressure margin; legacy paths stay unrestricted', () => {
    // 开局压力公式与 src/chat/interaction-rhythm.js 的 computeInteractionPressure
    // 一致（陌生基线 30）：pressure = 戒备 + max(0, 30-好感)/2 + max(0, 30-信任)/2。
    // 初始戒备 41 超过上限 40。
    const highGuard = completeAdultCandidate();
    highGuard.与玩家关系.戒备 = 41;
    highGuard.已读不回阈值 = 88;
    assert.throws(
        () => normalizeGeneratedCandidate(highGuard, { requirePersonalName: true }),
        error => error instanceof TypeError && error.code === '戒备:generated_above_maximum',
    );
    // 无标记的存量路径（手动登记、模板导入、服务订单）不受限。
    assert.equal(normalizeGeneratedCandidate(highGuard).与玩家关系.戒备, 41);

    // 戒备 30、好感/信任 0 → 开局压力 60，需要已读不回阈值 ≥ 75；70 边际不足。
    const thinMargin = completeAdultCandidate();
    thinMargin.与玩家关系.戒备 = 30;
    thinMargin.已读不回阈值 = 70;
    assert.throws(
        () => normalizeGeneratedCandidate(thinMargin, { enforceRhythmConsistency: true }),
        error => error instanceof TypeError && error.code === '已读不回阈值:generated_below_opening_pressure',
    );
    assert.equal(normalizeGeneratedCandidate(thinMargin).已读不回阈值, 70);

    // 恰好满足 pressure + 15 的组合在启用约束时通过。
    const exactMargin = completeAdultCandidate();
    exactMargin.与玩家关系.戒备 = 30;
    exactMargin.已读不回阈值 = 75;
    const normalized = normalizeGeneratedCandidate(exactMargin, { requirePersonalName: true });
    assert.equal(normalized.已读不回阈值, 75);
    assert.equal(normalized.与玩家关系.戒备, 30);
});

test('legacy seven-key relationship input is upgraded with zeroed bond fields', () => {
    const legacy = completeAdultCandidate();
    delete legacy.与玩家关系.友情值;
    delete legacy.与玩家关系.心动值;
    delete legacy.与玩家关系.欲望值;

    const normalized = normalizeGeneratedCandidate(legacy);
    assert.deepEqual(normalized.与玩家关系, {
        ...legacy.与玩家关系,
        友情值: 0,
        心动值: 0,
        欲望值: 0,
    });
});

test('relationship compatibility rejects partial, pre-grown, and unrelated unknown fields', () => {
    const preGrown = completeAdultCandidate();
    preGrown.与玩家关系.友情值 = 1;
    expectRejected(preGrown, '与玩家关系.友情值:not_zero_for_new_candidate');

    const partial = completeAdultCandidate();
    delete partial.与玩家关系.欲望值;
    expectRejected(partial, '与玩家关系:incomplete_or_unknown_fields');

    const unknown = completeAdultCandidate();
    unknown.与玩家关系.关系备注 = '不得静默保留';
    expectRejected(unknown, '与玩家关系:unknown_field');
});

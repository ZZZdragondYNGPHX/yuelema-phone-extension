import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGeneratedCandidate } from '../candidate.js';

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
            戒备: 20,
            面基意愿: 0,
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

    input.公开资料.兴趣标签.push('篡改');
    input.隐藏资料.私人备注 = '篡改';
    assert.deepEqual(result.公开资料.兴趣标签, ['电影', '夜跑']);
    assert.equal(result.隐藏资料.私人备注, '对临时失约很敏感。');
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


test('SFW rejects adult-oriented public tags instead of silently normalizing them', () => {
    const candidate = completeAdultCandidate();
    candidate.公开资料.生活方式标签 = ['翘臀'];
    assert.throws(
        () => normalizeGeneratedCandidate(candidate, { contentMode: 'SFW' }),
        error => error instanceof TypeError && error.code === '公开资料.生活方式标签[0]:adult_keyword_in_sfw',
    );
});

test('NSFW permits adult-oriented tags only while retaining adult, consent, privacy, and software-layer boundaries', () => {
    const candidate = completeAdultCandidate();
    candidate.公开资料.生活方式标签 = ['翘臀', '情趣探索'];
    const normalized = normalizeGeneratedCandidate(candidate, { contentMode: 'NSFW' });
    assert.deepEqual(normalized.公开资料.生活方式标签, ['翘臀', '情趣探索']);

    // The in-memory mode provenance remains available to the subsequent controlled
    // candidate validation pass, but never becomes a profile field or serialized data.
    assert.deepEqual(normalizeGeneratedCandidate(normalized).公开资料.生活方式标签, ['翘臀', '情趣探索']);

    const adultTermOutsideTags = completeAdultCandidate();
    adultTermOutsideTags.公开资料.简介 = '偏好翘臀。';
    assert.throws(
        () => normalizeGeneratedCandidate(adultTermOutsideTags, { contentMode: 'NSFW' }),
        error => error instanceof TypeError && error.code === '公开资料.简介:adult_keyword_must_be_tag',
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlayerPublicProfilePatch, normalizePlayerPublicProfile, validateControlledPatchAgainstState, validateControlledPatchWhitelist } from '../controlled-patch.js';

const T = {"player":"玩家","software":"软件","public":"公开资料","switches":"功能开关","built":"玩家已建档"};
const F = {"nickname":"昵称","avatar":"头像引用","ageRange":"年龄段","gender":"性别","orientation":"性取向","city":"城市","distance":"距离范围","intent":"寻找意图","bio":"简介","interests":"兴趣标签","lifestyle":"生活方式标签","personality":"性格标签","communication":"沟通风格标签"};

function profile(overrides = {}) {
    return {
        [F.nickname]: '玩家A', [F.avatar]: '', [F.ageRange]: '25-29', [F.gender]: '女', [F.orientation]: '双性恋',
        [F.city]: '上海', [F.distance]: '10 km', [F.intent]: '先聊天', [F.bio]: '公开简介',
        [F.interests]: ['电影'], [F.lifestyle]: ['夜猫子'], [F.personality]: ['直接'], [F.communication]: ['慢热'],
        ...overrides,
    };
}

function state() {
    return {
        [T.software]: { [T.switches]: { [T.built]: false } },
        [T.player]: { 成人验证: true, [T.public]: profile({ [F.nickname]: '旧名' }) },
    };
}

test('player public profile creates an exact MVU-only transition without state mutation', () => {
    const current = state();
    const before = structuredClone(current);
    const input = profile();
    const result = buildPlayerPublicProfilePatch(current, { profile: input });
    assert.equal(result.ok, true);
    assert.equal(validateControlledPatchWhitelist(result.value).ok, true);
    assert.equal(validateControlledPatchAgainstState(current, result.value).ok, true);
    assert.deepEqual(current, before);
    assert.equal(result.value.at(-1).path, '/软件/功能开关/玩家已建档');
});

test('profile validator rejects private keys, controls, oversized values, and unsafe tag lists', () => {
    assert.equal(normalizePlayerPublicProfile({ ...profile(), 隐藏资料: {} }), null);
    assert.equal(normalizePlayerPublicProfile(profile({ [F.bio]: 'x'.repeat(501) })), null);
    assert.equal(normalizePlayerPublicProfile(profile({ [F.city]: 'a\u0000b' })), null);
    assert.equal(normalizePlayerPublicProfile(profile({ [F.interests]: ['电影', '电影'] })), null);
    assert.equal(normalizePlayerPublicProfile(profile({ [F.lifestyle]: Array.from({ length: 25 }, (_, index) => 'tag' + index) })), null);
});

test('gate-only or altered public-profile patches fail exact state validation', () => {
    const current = state();
    const gateOnly = [{ op: 'replace', path: '/软件/功能开关/玩家已建档', value: true }];
    assert.equal(validateControlledPatchWhitelist(gateOnly).ok, true);
    assert.equal(validateControlledPatchAgainstState(current, gateOnly).ok, false);

    const built = buildPlayerPublicProfilePatch(current, { profile: profile() });
    const forged = structuredClone(built.value);
    forged[0].path = '/玩家/隐藏资料/私人备注';
    assert.equal(validateControlledPatchAgainstState(current, forged).ok, false);
});

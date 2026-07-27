import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCustomCandidateEncounter } from '../custom-candidate-encounter.js';

function candidate({ gender = '女', orientation = '双性恋', tags = ['电影'] } = {}) {
    return {
        成人验证: true,
        公开资料: {
            昵称: '自建角色', 年龄段: '25-29', 性别: gender, 性取向: orientation,
            城市: '上海', 距离范围: '10 km', 寻找意图: '聊天',
            兴趣标签: tags, 生活方式标签: [], 性格标签: [], 沟通风格标签: [],
        },
    };
}

function state() {
    return {
        软件: { 内容模式: 'SFW' },
        玩家: {
            公开资料: {
                性别: '男', 性取向: '异性恋', 城市: '上海', 距离范围: '10 km',
                寻找意图: '聊天', 年龄段: '28', 兴趣标签: ['电影'],
            },
            推荐偏好: { 标签权重: { SFW: { 电影: 3 }, NSFW: {} } },
        },
        推荐: {
            当前队列: [], 冷却角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [],
            临时候选池: { npc_custom_1: candidate() },
        },
    };
}

test('selects an adult custom candidate only when a positive keyword and hard compatibility both match', () => {
    const current = state();
    const selected = selectCustomCandidateEncounter(current);
    assert.equal(selected?.uid, 'npc_custom_1');
    assert.ok(selected.score >= 50);
    assert.deepEqual(selected.positiveMatches, ['电影']);

    current.玩家.推荐偏好.标签权重.SFW.电影 = 0;
    assert.equal(selectCustomCandidateEncounter(current), null, 'neutral weight must not force an authored character to appear');

    current.玩家.推荐偏好.标签权重.SFW.电影 = 5;
    current.推荐.临时候选池.npc_custom_1 = candidate({ gender: '男', orientation: '异性恋' });
    assert.equal(selectCustomCandidateEncounter(current), null, 'gender/orientation conflict remains a hard rejection');
});

test('device weights override MVU fallback and queued candidates are opt-in for the matching surface only', () => {
    const current = state();
    current.推荐.当前队列 = ['npc_custom_1'];
    const settingsStore = {
        snapshot() {
            return { personalization: { keywordWeightsByMode: { SFW: [{ keyword: '电影', weight: 4 }] } } };
        },
    };
    assert.equal(selectCustomCandidateEncounter(current, { settingsStore }), null);
    assert.equal(selectCustomCandidateEncounter(current, { settingsStore, allowQueued: true })?.uid, 'npc_custom_1');
});

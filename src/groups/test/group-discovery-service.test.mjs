import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGroupBrowseModel, listGroupDiscoverableCharacters, projectPublicGroupCharacter } from '../group-discovery-service.js';

function publicProfile(nickname) {
    return {
        昵称: nickname, 头像引用: `https://example.invalid/${nickname}.png`, 年龄段: '25-29', 性别: '女', 性取向: '双性恋',
        城市: '上海', 距离范围: '10 km', 寻找意图: '聊天与约会', 简介: `${nickname} 的公开简介`,
        兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'],
    };
}
function character(nickname, { adult = true } = {}) {
    return {
        成人验证: adult, 公开资料: publicProfile(nickname),
        仅好友资料: { 关系状态: '已婚', 边界与偏好: 'friend-secret-must-not-leak' },
        隐藏资料: { 实际年龄: 28, 私人备注: 'hidden-secret-must-not-leak' },
        偏好与边界: 'internal-boundary-must-not-leak', 拒绝阈值: 40, 已读不回阈值: 60, 取消匹配阈值: 70, 拉黑阈值: 90,
        与玩家关系: { 状态: '陌生', 全局账号表现: 55, NPC专属匹配度: 67, 好感: 0, 信任: 0, 戒备: 20, 面基意愿: 0 },
    };
}
function state() {
    return {
        角色池: { npc_1: character('林澈'), npc_2: character('周遥'), npc_3: character('未成年人错误样例', { adult: false }) },
        推荐: { 临时候选池: { npc_candidate: character('候选秘密角色') } },
        会话: { chat_1: { 长期摘要: 'session-secret-must-not-leak' } },
        群组: { group_1: {
            主题: '周末城市散步', 描述: '只聊公开兴趣并发现同城人物。',
            成员UID: ['npc_1', 'npc_2', 'npc_1', 'npc_missing'], 可发现角色UID: ['npc_2', 'npc_3', 'npc_candidate'],
        } },
    };
}

test('group browse model preserves group UID lists while resolving only public adult profiles', () => {
    const result = buildGroupBrowseModel(state());
    assert.equal(result.群组.length, 1);
    const group = result.群组[0];
    assert.deepEqual(group.成员UID, ['npc_1', 'npc_2', 'npc_missing']);
    assert.deepEqual(group.可发现角色UID, ['npc_2', 'npc_3', 'npc_candidate']);
    assert.deepEqual(group.成员.map(item => item.UID), ['npc_1', 'npc_2']);
    assert.deepEqual(group.可发现角色.map(item => item.UID), ['npc_2']);
    assert.equal(group.成员[0].公开资料.昵称, '林澈');
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(group.可发现角色[0].公开资料), true);
});

test('public group projection never exposes private, relationship, candidate, or session data', () => {
    const serialized = JSON.stringify(buildGroupBrowseModel(state()));
    for (const forbidden of ['friend-secret-must-not-leak', 'hidden-secret-must-not-leak', 'internal-boundary-must-not-leak', 'session-secret-must-not-leak', '候选秘密角色', '拒绝阈值', '仅好友资料', '隐藏资料', '与玩家关系']) {
        assert.equal(serialized.includes(forbidden), false);
    }
});

test('discoverable entry is read-only and does not mutate the supplied state', () => {
    const source = state();
    const before = structuredClone(source);
    const discovered = listGroupDiscoverableCharacters(source, 'group_1');
    assert.deepEqual(discovered.map(item => item.UID), ['npc_2']);
    assert.deepEqual(source, before);
    assert.equal(Object.isFrozen(discovered), true);
});

test('invalid groups and non-adult characters are not projected', () => {
    const source = state();
    source.群组.group_bad = { 主题: '缺少描述', 成员UID: ['npc_1'], 可发现角色UID: ['npc_1'] };
    source.群组.not_a_group = { 主题: '错误 UID', 描述: '不应显示', 成员UID: ['npc_1'], 可发现角色UID: ['npc_1'] };
    assert.deepEqual(buildGroupBrowseModel(source).群组.map(group => group.UID), ['group_1']);
    assert.equal(projectPublicGroupCharacter('npc_3', source.角色池.npc_3), null);
    assert.deepEqual(listGroupDiscoverableCharacters(source, 'group_bad'), []);
});

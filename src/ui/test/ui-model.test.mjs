import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneView, describeActionFailure, projectMatchView, projectPlayerPublicProfile, projectPublicProfile } from '../../ui-model.js';

function profile() {
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
            简介: '只公开这一句。',
            兴趣标签: ['电影', '夜跑', '电影'],
            生活方式标签: ['夜猫子'],
            性格标签: ['直接'],
            沟通风格标签: ['慢热'],
        },
        仅好友资料: { 关系状态: '机密伴侣状态', 边界与偏好: '机密边界' },
        隐藏资料: { 实际年龄: 28, 私人备注: '绝不能渲染的秘密' },
        与玩家关系: { 状态: '陌生', 数值: 0 },
    };
}

function readResult() {
    return {
        ok: true,
        state: {
            软件: { 内容模式: 'SFW' },
            角色池: {},
            推荐: { 当前队列: ['npc_lc'], 临时候选池: { npc_lc: profile() } },
        },
    };
}

test('public profile projection uses an explicit whitelist and omits private layers', () => {
    const projected = projectPublicProfile(profile(), 'npc_lc');
    assert.deepEqual(Object.keys(projected).sort(), [
        'uid', '昵称', '头像引用', '年龄段', '性别', '性取向', '城市', '距离范围', '寻找意图', '简介',
        '兴趣标签', '生活方式标签', '性格标签', '沟通风格标签',
    ].sort());
    assert.deepEqual(projected.兴趣标签, ['电影', '夜跑']);
    const renderedModel = JSON.stringify(projected);
    assert.equal(renderedModel.includes('绝不能渲染的秘密'), false);
    assert.equal(renderedModel.includes('机密伴侣状态'), false);
    assert.equal(renderedModel.includes('实际年龄'), false);
});

test('phone view chooses only a queued adult-verified public candidate', () => {
    const view = createPhoneView(readResult());
    assert.equal(view.status, 'ready');
    assert.equal(view.mode, 'SFW');
    assert.equal(view.queueCount, 1);
    assert.equal(view.candidate?.uid, 'npc_lc');
    assert.equal(JSON.stringify(view).includes('绝不能渲染的秘密'), false);
});

test('unavailable read result never returns a raw state object', () => {
    const view = createPhoneView({ ok: false, code: 'mvu_get_unavailable', state: { secret: 'x' } });
    assert.equal(view.status, 'unavailable');
    assert.equal(Object.hasOwn(view, 'state'), false);
    assert.equal(JSON.stringify(view).includes('secret'), false);
});

test('saved-card source failures stay user-facing and do not expose internal queue codes', () => {
    assert.equal(describeActionFailure({ code: 'like_match_source_not_available' }), '该资料已不在当前候选或收藏列表，请返回后刷新。');
    assert.equal(describeActionFailure({ code: 'recommendation_source_not_available' }), '该资料已不在当前候选或收藏列表，请返回后刷新。');
});

test('private chat view exposes only public profile and session-visible transcript', () => {
    const read = {
        ok: true,
        state: {
            软件: { 内容模式: 'SFW' }, 推荐: { 当前队列: [], 临时候选池: {} },
            角色池: { npc_a: { 成人验证: true, 公开资料: { 昵称: '公开名' }, 仅好友资料: { 关系状态: '隐藏' }, 隐藏资料: { 实际年龄: 29, 私人备注: '秘密' } } },
            会话: { chat_a: { 对象UID: 'npc_a', 状态: '已匹配', 最近消息: [{ 消息UID: 'm1', 发送者: '角色', 内容: '你好', 时间: '' }], 长期摘要: '公开会话摘要' } },
        },
    };
    const view = createPhoneView(read);
    assert.equal(view.messageSessions.length, 1);
    assert.equal(view.messageSessions[0].profile.昵称, '公开名');
    const serialized = JSON.stringify(view.messageSessions);
    assert.doesNotMatch(serialized, /秘密|实际年龄|关系状态/);
});

test('matched view exposes only public profile and a fixed public status', () => {
    const matched = profile();
    matched.与玩家关系 = { 状态: '已匹配', 全局账号表现: 88, NPC专属匹配度: 99 };
    const matches = projectMatchView({ 角色池: { npc_match_1: matched } });
    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0].status, '已匹配');
    const serialized = JSON.stringify(matches);
    assert.doesNotMatch(serialized, /秘密|实际年龄|关系状态|账号表现|匹配度/);
});

test('phone view exposes only the group browse projection and no private group character data', () => {
    const member = profile();
    const discoverable = profile();
    discoverable.公开资料.昵称 = '发现对象';
    const view = createPhoneView({
        ok: true,
        state: {
            软件: { 内容模式: 'SFW' }, 推荐: { 当前队列: [], 临时候选池: { npc_hidden: profile() } },
            角色池: { npc_member: member, npc_discover: discoverable },
            群组: { group_city: { 主题: '城市夜谈', 描述: '成年人公开话题群。', 成员UID: ['npc_member'], 可发现角色UID: ['npc_discover'] } },
            会话: { chat_secret: { 对象UID: 'npc_member', 状态: '已匹配', 最近消息: [{ 消息UID: 's', 发送者: '角色', 内容: '私聊秘密', 时间: '' }] } },
        },
    });
    assert.equal(view.groups.length, 1);
    assert.equal(view.groups[0].主题, '城市夜谈');
    assert.equal(view.groups[0].成员[0].公开资料.昵称, '林澈');
    assert.equal(view.groups[0].可发现角色[0].公开资料.昵称, '发现对象');
    const serialized = JSON.stringify(view.groups);
    assert.doesNotMatch(serialized, /绝不能渲染的秘密|机密伴侣状态|实际年龄|私聊秘密|账号表现|匹配度/u);
});

test('profile hub collections expose player and favourite public cards only', () => {
    const favourite = profile();
    favourite.公开资料.昵称 = '收藏对象';
    const player = profile();
    player.公开资料.昵称 = '玩家公开名';
    player.仅好友资料.关系状态 = '玩家私密关系';
    const view = createPhoneView({
        ok: true,
        state: {
            软件: { 内容模式: 'SFW' }, 玩家: player, 角色池: { npc_favorite: favourite },
            推荐: { 当前队列: [], 临时候选池: {}, 收藏角色UID: ['npc_favorite'] },
        },
    });
    assert.equal(view.playerProfile.昵称, '玩家公开名');
    assert.equal(view.favorites.length, 1);
    assert.equal(view.favorites[0].昵称, '收藏对象');
    assert.equal(view.candidates[0].uid, 'npc_favorite');
    assert.doesNotMatch(JSON.stringify(view), /玩家私密关系|绝不能渲染的秘密|机密伴侣状态/u);
    assert.equal(projectPlayerPublicProfile({ 玩家: { 成人验证: false, 公开资料: { 昵称: '未验证' } } }).昵称, '');
});


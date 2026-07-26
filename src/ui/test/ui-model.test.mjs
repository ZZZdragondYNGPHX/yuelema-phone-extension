import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneView, describeActionFailure, projectMatchView, projectPlayerPublicProfile, projectPublicProfile, projectServiceOrderView, projectServiceOrderIssues } from '../../ui-model.js';

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
    assert.equal(describeActionFailure({ code: 'mvu_relationship_routes_schema_outdated' }), '当前聊天的角色卡仍缺少关系路线字段。请导入与小手机相同版本的《约了吗》MVU 角色卡，并新开聊天后重试；本次模型结果未写入。');
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

test('private chat view projects bounded summary history and pending layer counts without exposing profile internals', () => {
    const read = {
        ok: true,
        state: {
            软件: { 内容模式: 'SFW' }, 推荐: { 当前队列: [], 临时候选池: {} },
            角色池: { npc_a: { 成人验证: true, 公开资料: { 昵称: '公开名' }, 仅好友资料: { 关系状态: '隐藏' }, 隐藏资料: { 实际年龄: 29, 私人备注: '秘密' } } },
            会话: {
                chat_a: {
                    对象UID: 'npc_a', 状态: '已匹配', 对话层数: 4,
                    最近消息: [
                        { 消息UID: 'm1', 发送者: '玩家', 内容: '第一层', 时间: '', 层数: 1 },
                        { 消息UID: 'm2', 发送者: '角色', 内容: '第二层', 时间: '', 层数: 2 },
                        { 消息UID: 'm3', 发送者: '玩家', 内容: '第三层', 时间: '', 层数: 3 },
                        { 消息UID: 'm4', 发送者: '角色', 内容: '第四层', 时间: '', 层数: 4 },
                    ],
                    总结: {
                        已总结消息UID: 'm2', 总结序号: 1,
                        记录: [{ 总结UID: 'summary_1', 起始消息UID: 'm1', 结束消息UID: 'm2', 起始层数: 1, 结束层数: 2, 内容: '双方礼貌打招呼。', 时间: '' }],
                        状态: '成功', 失败原因: '', 目标总结UID: '', 尝试次数: 1,
                    },
                },
            },
        },
    };
    const session = createPhoneView(read).messageSessions[0];
    assert.deepEqual(session.summaryInfo, {
        totalLayers: 4,
        pendingMessageCount: 2,
        records: [{ summaryUid: 'summary_1', startLayer: 1, endLayer: 2, content: '双方礼貌打招呼。', time: '' }],
        status: '成功', failureReason: '', targetSummaryUid: '', attempts: 1,
    });
    assert.doesNotMatch(JSON.stringify(session.summaryInfo), /秘密|实际年龄|关系状态/u);
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



function serviceOrder(overrides = {}) {
    return {
        角色UID: 'npc_service_1', 内容模式: 'SFW', 服务分类: 'coffee_walk', 服务主题: '咖啡与散步：与林澈的文字协商',
        状态: '已完成', 发起时间: '2026-07-25 20:00', 开始时间: '正文第 2 轮', 结束时间: '2026-07-25 22:00',
        结束摘要: '双方已在正文中结束本次文字协商。', 已确认边界: '私密边界',
        ...overrides,
    };
}

function serviceState(orders) {
    return { 角色池: { npc_service_1: profile() }, 服务订单: orders };
}

test('service order projection accepts only current adult lifecycle snapshots and derives a public topic', () => {
    const projected = projectServiceOrderView(serviceState({
        service_1: serviceOrder({ 状态: '待确认', 发起时间: '待正文确认', 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '' }),
        service_2: serviceOrder({ 状态: '进行中', 发起时间: '今天', 开始时间: '正文第 2 轮', 结束时间: '', 结束摘要: '', 已确认边界: '已确认边界' }),
        service_3: serviceOrder({ 服务主题: '微信号 wx_secret_123 与隐藏资料', 状态: '已完成' }),
        service_4: serviceOrder({ 状态: '已取消', 发起时间: '昨天', 开始时间: '', 结束时间: '今天', 结束摘要: '双方未继续正文协商。', 已确认边界: '' }),
        service_5: serviceOrder({ 状态: '已取消', 结束摘要: '双方在开始后结束本次协商。' }),
    }));
    const byId = Object.fromEntries(projected.map((order) => [order.id, order]));
    assert.equal(projected.length, 4);
    assert.equal(byId.service_1.initiatedAt, '待正文确认');
    assert.equal(byId.service_2.startedAt, '正文第 2 轮');
    assert.equal(byId.service_3, undefined, '与分类和公开角色不一致的服务主题不得投影');
    assert.equal(byId.service_4.endedAt, '今天');
    assert.doesNotMatch(JSON.stringify(projected), /微信号|隐藏资料|私密边界|实际年龄/u);
});

test('service order projection rejects malformed ongoing and terminal snapshots for an adult role', () => {
    const state = serviceState({
        service_1: serviceOrder({ 状态: '待确认', 开始时间: '正文第 1 轮' }),
        service_2: serviceOrder({ 状态: '进行中', 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '已确认边界' }),
        service_3: serviceOrder({ 状态: '进行中', 结束时间: '今天', 结束摘要: '', 已确认边界: '已确认边界' }),
        service_4: serviceOrder({ 状态: '进行中', 结束时间: '', 结束摘要: '', 已确认边界: '' }),
        service_5: serviceOrder({ 状态: '已完成', 结束时间: '' }),
        service_6: serviceOrder({ 状态: '已完成', 结束摘要: '' }),
        service_7: serviceOrder({ 状态: '已完成', 已确认边界: '' }),
        service_8: serviceOrder({ 状态: '已取消', 结束时间: '' }),
        service_9: serviceOrder({ 状态: '已取消', 已确认边界: '' }),
        service_12: serviceOrder({ 状态: '已取消', 开始时间: '', 结束摘要: '', 已确认边界: '' }),
    });
    const minor = profile();
    minor.隐藏资料.实际年龄 = 17;
    state.角色池.npc_service_2 = minor;
    state.服务订单.service_10 = serviceOrder({ 角色UID: 'npc_service_2' });
    state.服务订单.service_11 = serviceOrder({ 服务分类: 'adult_companion' });
    const projected = projectServiceOrderView(state);
    assert.deepEqual(projected, []);
});

test('service order projection supports up to three public participants and only exposes a complete body signal', () => {
    const second = profile(); second.公开资料.昵称 = '顾晴';
    const third = profile(); third.公开资料.昵称 = '周岚';
    const state = {
        角色池: { npc_service_1: profile(), npc_service_2: second, npc_service_3: third },
        服务订单: {
            service_1: serviceOrder({
                角色UID列表: ['npc_service_1', 'npc_service_2', 'npc_service_3'],
                服务主题: '咖啡与散步：与林澈、顾晴、周岚的文字协商', 状态: '进行中',
                结束时间: '', 结束摘要: '', 已确认边界: '已确认边界',
                合法结束条件: { 已满足: true, 摘要: '正文已达成结束条件。', 记录时间: '正文最新回合' },
            }),
            service_2: serviceOrder({ 角色UID列表: ['npc_service_1', 'npc_service_2', 'npc_service_3', 'npc_service_4'] }),
        },
    };
    const projected = projectServiceOrderView(state);
    assert.equal(projected.length, 1);
    assert.deepEqual(projected[0].profiles.map((item) => item.昵称), ['林澈', '顾晴', '周岚']);
    assert.equal(projected[0].completionReady, true);
    assert.doesNotMatch(JSON.stringify(projected), /实际年龄|私密边界/u, 'only public projection fields may be exposed to rendering');
    assert.equal(projectServiceOrderIssues(state).length, 1, '超过三位的记录只能作为泛化损坏项处理');
});

test('completion signal requires a non-empty summary and timestamp while active orders remain viewable', () => {
    const order = serviceOrder({ 状态: '进行中', 结束时间: '', 结束摘要: '', 已确认边界: '已确认边界' });
    const state = serviceState({ service_1: order });
    assert.equal(projectServiceOrderView(state)[0].completionReady, false);
    order.合法结束条件 = { 已满足: true, 摘要: '正文结束。', 记录时间: '' };
    assert.equal(projectServiceOrderView(state)[0].completionReady, false, 'an incomplete body signal must not schedule a bridge call that will be rejected');
    order.合法结束条件.记录时间 = '正文最新回合';
    assert.equal(projectServiceOrderView(state)[0].completionReady, true);
});

test('service order projection replaces unsafe time text with state-derived copy', () => {
    const unsafeInitiated = '上海市浦东新区张江路 88 号';
    const unsafeStarted = 'mail@example.com';
    const unsafeEnded = 'QQ号 12345678';
    const unsafeCancelledEnded = 'https://secret.example/receipt';
    const projected = projectServiceOrderView(serviceState({
        service_1: serviceOrder({ 状态: '待确认', 发起时间: unsafeInitiated, 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '' }),
        service_2: serviceOrder({ 状态: '进行中', 发起时间: '2026-07-25 20:00', 开始时间: unsafeStarted, 结束时间: '', 结束摘要: '', 已确认边界: '已确认边界' }),
        service_3: serviceOrder({ 状态: '已完成', 结束时间: unsafeEnded }),
        service_4: serviceOrder({ 状态: '已取消', 开始时间: '', 已确认边界: '', 结束时间: unsafeCancelledEnded, 结束摘要: '本次未继续。' }),
    }));
    const byId = Object.fromEntries(projected.map((order) => [order.id, order]));
    assert.equal(byId.service_1.initiatedAt, '订单已建立');
    assert.equal(byId.service_2.initiatedAt, '2026-07-25 20:00');
    assert.equal(byId.service_2.startedAt, '已在正文中确认');
    assert.equal(byId.service_3.endedAt, '订单已完成');
    assert.equal(byId.service_4.endedAt, '订单已取消');
    assert.doesNotMatch(JSON.stringify(projected), /张江路|mail@example[.]com|12345678|secret[.]example/u);
});

test('service order projection replaces an entire terminal summary when conservative sensitive checks match', () => {
    const sensitiveSummaries = [
        '联系邮箱 qa@example.com，其他内容不得展示。',
        '查看 https://private.example/order/42 后再说。',
        'QQ号 12345678 是私人联系方式。',
        'Telegram @private_handle 是私人联系方式。',
        '详细地址：上海市浦东新区张江路 88 号 2 栋 301。',
        '请通过收款码支付尾款。',
    ];
    const orders = Object.fromEntries(sensitiveSummaries.map((summary, index) => [
        'service_' + (index + 1), serviceOrder({ 结束摘要: summary }),
    ]));
    const projected = projectServiceOrderView(serviceState(orders));
    assert.equal(projected.length, sensitiveSummaries.length);
    for (const order of projected) assert.equal(order.summary, '该记录包含不适合展示的敏感内容，已隐藏。');
    assert.doesNotMatch(JSON.stringify(projected), /qa@example[.]com|private[.]example|12345678|private_handle|张江路|收款码|尾款/u);
});

test('service order summaries apply SFW-only transaction filtering while preserving shared privacy and process limits', () => {
    const state = serviceState({
        service_1: serviceOrder({ 结束摘要: '本次服务涉及尾款支付安排。' }),
        service_2: serviceOrder({
            内容模式: 'NSFW', 服务分类: 'private_service', 服务主题: '私密成人服务：与林澈的文字协商',
            结束摘要: '本次成人角色扮演已收尾，排期与支付安排由正文处理。',
        }),
        service_3: serviceOrder({
            内容模式: 'NSFW', 服务分类: 'private_service', 服务主题: '私密成人服务：与林澈的文字协商',
            结束摘要: '完整露骨过程不得进入本地历史。',
        }),
        service_4: serviceOrder({
            内容模式: 'NSFW', 服务分类: 'private_service', 服务主题: '私密成人服务：与林澈的文字协商',
            结束摘要: '联系邮箱 qa@example.com，其他内容不得展示。',
        }),
    });
    const byId = Object.fromEntries(projectServiceOrderView(state).map((order) => [order.id, order]));
    assert.equal(byId.service_1.summary, '该记录包含不适合展示的敏感内容，已隐藏。');
    assert.equal(byId.service_2.summary, '本次成人角色扮演已收尾，排期与支付安排由正文处理。');
    assert.equal(byId.service_3.summary, '该记录包含不适合展示的敏感内容，已隐藏。');
    assert.equal(byId.service_4.summary, '该记录包含不适合展示的敏感内容，已隐藏。');
    assert.doesNotMatch(JSON.stringify(byId), /qa@example[.]com|完整露骨过程/u);
});

test('service order failure messages explain mode races and invalid bridge results', () => {
    assert.equal(describeActionFailure({ code: 'service_order_mode_changed' }), '内容模式已变化，未提交服务订单更新，请刷新后重试。');
    assert.equal(describeActionFailure({ code: 'service_order_result_invalid' }), '正文返回的服务订单结果未通过校验，未写入任何数据。');
});


test('service order projection supports every unified person category in SFW and NSFW while preserving legacy activity history', () => {
    const personCategories = {
        girl_shuren: '熟人商品', girl_luren: '路人商品', random_generation: '随机商品',
    };
    const orders = {};
    for (const [categoryId, category] of Object.entries(personCategories)) {
        orders[`service_sfw_${categoryId}`] = serviceOrder({
            服务分类: categoryId, 服务主题: `${category}：与林澈的文字协商`,
        });
        orders[`service_nsfw_${categoryId}`] = serviceOrder({
            内容模式: 'NSFW', 服务分类: categoryId, 服务主题: `${category}：与林澈的文字协商`,
        });
    }
    orders.service_legacy_sfw = serviceOrder();
    orders.service_legacy_nsfw = serviceOrder({
        内容模式: 'NSFW', 服务分类: 'adult_companion', 服务主题: '成人直白陪伴：与林澈的文字协商',
    });

    const byId = Object.fromEntries(projectServiceOrderView(serviceState(orders)).map((order) => [order.id, order]));
    for (const [categoryId, category] of Object.entries(personCategories)) {
        assert.equal(byId[`service_sfw_${categoryId}`].category, category);
        assert.equal(byId[`service_nsfw_${categoryId}`].category, category);
        assert.equal(byId[`service_sfw_${categoryId}`].mode, 'SFW');
        assert.equal(byId[`service_nsfw_${categoryId}`].mode, 'NSFW');
    }
    assert.equal(byId.service_legacy_sfw.category, '咖啡与散步');
    assert.equal(byId.service_legacy_nsfw.category, '成人直白陪伴');
});

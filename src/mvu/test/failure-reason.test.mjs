// 2026-07-27 控制台诊断增强专项回归：受控管线失败返回的可选 reason 字段。
// 合同：reason 只在被增强的失败点出现；未增强的失败点保持 { ok, code, detail } 三键
// 原形；reason 只包含错误码、字段名/JSON 路径与校验结论——绝不包含隐藏资料层的
// 字段值、关系分数值或阈值数值。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildCharacterRegistrationPatch,
    buildPlayerPublicProfilePatch,
    buildServiceHistoryRolesDeletionPatch,
    buildServiceOrderCancelPatch,
    buildServiceOrderCompletePatch,
    buildServiceOrderFinalizePatch,
    buildServiceOrderHandoffPatch,
    buildServiceOrderRebookPatch,
    buildServiceOrderRepeatPatch,
    buildServiceOrderStartPatch,
    validateControlledPatchWhitelist,
} from '../controlled-patch.js';

function adultCandidate(nickname = '林澈') {
    return {
        成人验证: true,
        公开资料: { 昵称: nickname, 头像引用: '', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '先聊天再约会', 简介: '喜欢看展和散步。', 兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'] },
        仅好友资料: { 关系状态: '单身', 边界与偏好: '尊重拒绝。' },
        隐藏资料: { 实际年龄: 28, 私人备注: '仅供系统使用。' },
        偏好与边界: '先确认边界。', 拒绝阈值: 35, 已读不回阈值: 55, 取消匹配阈值: 75, 拉黑阈值: 90,
        与玩家关系: { 状态: '陌生', 全局账号表现: 68, NPC专属匹配度: 72, 好感: 0, 信任: 0, 戒备: 20, 面基意愿: 0 },
    };
}

function serviceState() {
    return {
        系统: { UID计数器: { 角色: 0, 服务订单: 0 } },
        软件: { 内容模式: 'SFW' },
        角色池: {},
        推荐: { 临时候选池: {} },
        服务订单: {},
    };
}

function pendingOrderState() {
    const state = serviceState();
    state.系统.UID计数器.角色 = 1;
    state.系统.UID计数器.服务订单 = 1;
    state.角色池.npc_service_1 = adultCandidate();
    state.服务订单.service_1 = {
        角色UID: 'npc_service_1', 角色UID列表: ['npc_service_1'], 内容模式: 'SFW', 服务分类: 'girl_shuren',
        服务主题: '熟人商品：与林澈的文字协商', 状态: '待确认',
        发起时间: '待正文确认', 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '',
        合法结束条件: { 已满足: false, 摘要: '', 记录时间: '' },
    };
    return state;
}

function validBoundaries() {
    return {
        内容模式: 'SFW', 主题: '轻松陪伴', 允许项: '正文确认内容', 排除项: '未确认内容', 强度: '轻松陪伴', 隐私处理: '仅最小摘要',
        服务信息: {}, 玩家已同意: true, NPC明确同意: [true],
    };
}

test('未增强的失败点保持三键原形，不出现 reason 键', () => {
    const result = buildPlayerPublicProfilePatch({}, { profile: null });
    assert.deepEqual(result, { ok: false, code: 'player_profile_invalid', detail: '' });
    assert.equal(Object.hasOwn(result, 'reason'), false);
});

test('下单候选未成年：code 兼容不变，reason 只报候选序号与字段路径，绝不含隐藏年龄值', () => {
    const state = serviceState();
    const minor = adultCandidate('乙女');
    minor.隐藏资料.实际年龄 = 17;
    const built = buildServiceOrderHandoffPatch(state, { candidates: [adultCandidate('甲'), minor], categoryId: 'girl_shuren' });
    assert.equal(built.ok, false);
    assert.equal(built.code, 'service_order_candidate_invalid');
    assert.equal(built.reason, '候选[2] 成年人校验未通过：字段 隐藏资料.实际年龄');
    assert.equal(built.reason.includes('17'), false, 'reason 不得包含隐藏资料的具体数值');
});

test('下单候选结构错误与昵称重复各自给出候选序号级 reason', () => {
    const state = serviceState();
    const broken = adultCandidate('乙');
    delete broken.仅好友资料;
    const structural = buildServiceOrderHandoffPatch(state, { candidates: [broken], categoryId: 'girl_shuren' });
    assert.equal(structural.code, 'service_order_candidate_invalid');
    assert.match(structural.reason, /^候选\[1\] 结构校验未通过：/u);

    const duplicated = buildServiceOrderHandoffPatch(state, { candidates: [adultCandidate('同名'), adultCandidate('同名')], categoryId: 'girl_shuren' });
    assert.equal(duplicated.code, 'service_order_candidate_invalid');
    assert.equal(duplicated.reason, '候选[2] 公开资料.昵称：与前面的候选重复');
});

test('下单状态前置失败与冲突的 reason 指出缺失路径或冲突结论', () => {
    const missingCategory = buildServiceOrderHandoffPatch(serviceState(), { candidate: adultCandidate(), categoryId: 'adult_companion' });
    assert.equal(missingCategory.code, 'service_order_state_invalid');
    assert.match(missingCategory.reason, /服务分类无效.*adult_companion/u);

    const state = pendingOrderState();
    const conflict = buildServiceOrderHandoffPatch(state, { candidate: adultCandidate('丙'), categoryId: 'girl_shuren' });
    assert.equal(conflict.code, 'service_order_conflict');
    assert.equal(conflict.reason, '已存在一笔待确认或进行中的服务订单');
});

test('确认成交失败：边界字段级 reason（含参与者逐人确认与文本字段），不改变 code', () => {
    const state = pendingOrderState();
    const noConsent = validBoundaries();
    noConsent.NPC明确同意 = [false];
    const consentFailure = buildServiceOrderStartPatch(state, { orderUid: 'service_1', boundaries: noConsent });
    assert.equal(consentFailure.code, 'service_order_start_invalid');
    assert.equal(consentFailure.reason, '结构化边界校验未通过：字段 NPC明确同意：尚有参与者未逐人确认');

    const emptyTopic = validBoundaries();
    emptyTopic.主题 = '   ';
    const topicFailure = buildServiceOrderStartPatch(state, { orderUid: 'service_1', boundaries: emptyTopic });
    assert.equal(topicFailure.code, 'service_order_start_invalid');
    assert.equal(topicFailure.reason, '结构化边界校验未通过：字段 主题：不能为空');

    const missingOrder = buildServiceOrderStartPatch(state, { orderUid: 'service_99', boundaries: validBoundaries() });
    assert.equal(missingOrder.code, 'service_order_start_invalid');
    assert.equal(missingOrder.reason, '该服务订单不存在或结构损坏');
});

test('取消/结单/归档失败的 reason 说明实际订单状态或缺失字段', () => {
    const state = pendingOrderState();
    state.服务订单.service_1.状态 = '进行中';
    const cancel = buildServiceOrderCancelPatch(state, { orderUid: 'service_1' });
    assert.equal(cancel.code, 'service_order_cancel_invalid');
    assert.equal(cancel.reason, '只能取消 待确认 订单，实际状态为 进行中');

    const pending = pendingOrderState();
    const complete = buildServiceOrderCompletePatch(pending, { orderUid: 'service_1' });
    assert.equal(complete.code, 'service_order_complete_invalid');
    assert.equal(complete.reason, '只能完成 进行中 订单，实际状态为 待确认');

    const finalize = buildServiceOrderFinalizePatch(pending, { orderUid: 'service_1' });
    assert.equal(finalize.code, 'service_order_finalize_invalid');
    assert.equal(finalize.reason, '只能归档终态订单，实际状态为 待确认');
});

test('再下单 / 历史重建 / 历史删除的失败 reason 均可读且不含隐藏数值', () => {
    const repeat = buildServiceOrderRepeatPatch(pendingOrderState(), { sourceOrderUid: 'service_1' });
    assert.equal(repeat.code, 'service_order_repeat_state_invalid');
    assert.match(repeat.reason, /只能从终态订单再次下单/u);

    const rebook = buildServiceOrderRebookPatch(serviceState(), { npcUids: ['npc_service_9'], categoryId: 'girl_shuren' });
    assert.equal(rebook.code, 'service_order_rebook_invalid');
    assert.match(rebook.reason, /^参与者\[1\]：/u);

    const historyDelete = buildServiceHistoryRolesDeletionPatch(serviceState(), { npcUids: ['npc_service_1'] });
    assert.equal(historyDelete.code, 'service_history_delete_invalid');
    assert.match(historyDelete.reason, /不在 \/角色池/u);
});

test('角色登记失败：候选校验 reason 报字段路径；成年失败只报字段不带值', () => {
    const state = {
        系统: { UID计数器: { 角色: 0 } },
        推荐: { 临时候选池: {}, 当前队列: [] },
        角色池: {},
    };
    const minor = adultCandidate();
    minor.隐藏资料.实际年龄 = 16;
    const built = buildCharacterRegistrationPatch(state, { candidate: minor });
    assert.equal(built.code, 'character_registration_candidate_invalid');
    assert.equal(built.reason, '成年人校验未通过：字段 隐藏资料.实际年龄');
    assert.equal(built.reason.includes('16'), false);

    const stateless = buildCharacterRegistrationPatch({ 推荐: {}, 角色池: {}, 系统: {} }, { candidate: adultCandidate() });
    assert.equal(stateless.code, 'character_registration_state_invalid');
    assert.match(stateless.reason, /当前队列|UID计数器/u);
});

test('白名单第二道防线拒绝候选时同样带 reason，且 code 兼容', () => {
    const minor = adultCandidate();
    minor.隐藏资料.实际年龄 = 17;
    const rejected = validateControlledPatchWhitelist([{ op: 'add', path: '/角色池/npc_service_1', value: minor }]);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'service_order_candidate_invalid');
    assert.equal(rejected.reason, '成年人校验未通过：字段 隐藏资料.实际年龄');
});

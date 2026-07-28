import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServiceOrderHandoffPatch, buildServiceOrderRepeatPatch, buildServiceOrderRebookPatch, buildServiceOrderStartPatch, buildServiceOrderCancelPatch, buildServiceOrderCompletePatch, buildServiceOrderFinalizePatch, buildServiceOrderRepairPatch, buildServiceHistoryRolesDeletionPatch, validateControlledPatchAgainstState } from '../controlled-patch.js';
import { normalizeGeneratedCandidate } from '../../recommendation/candidate.js';

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
        正文记忆: {},
        推荐: { 临时候选池: {} },
        服务订单: {},
    };
}

function terminalOrder({ nickname = '林澈', status = '已完成' } = {}) {
    return {
        角色UID: 'npc_service_1', 角色UID列表: ['npc_service_1'], 内容模式: 'SFW', 服务分类: 'girl_shuren', 服务主题: `熟人商品：与${nickname}的文字协商`, 状态: status,
        发起时间: '昨天 18:00', 开始时间: status === '已完成' ? '昨天 19:00' : '', 结束时间: '昨天 21:00',
        结束摘要: '双方确认本次文字协商已安全结束。', 已确认边界: status === '已完成' ? '仅在正文中继续协商，随时可以拒绝。' : '',
    };
}

function repeatState({ status = '已完成' } = {}) {
    const state = serviceState();
    state.系统.UID计数器.角色 = 1;
    state.系统.UID计数器.服务订单 = 1;
    state.角色池.npc_service_1 = adultCandidate();
    state.正文记忆.npc_service_1 = '';
    state.服务订单.service_1 = terminalOrder({ status });
    return state;
}

test('service handoff atomically copies an adult local draft and opens one pending SFW order', () => {
    const state = serviceState();
    const built = buildServiceOrderHandoffPatch(state, { candidate: adultCandidate(), categoryId: 'girl_shuren' });
    assert.equal(built.ok, true);
    assert.equal(built.value.npcUid, 'npc_service_1');
    assert.equal(built.value.orderUid, 'service_1');
    assert.deepEqual(built.value.patch.map(({ op, path }) => [op, path]), [
        ['add', '/角色池/npc_service_1'], ['add', '/正文记忆/npc_service_1'], ['add', '/服务订单/service_1'],
        ['replace', '/系统/UID计数器/角色'], ['replace', '/系统/UID计数器/服务订单'],
    ]);
    assert.equal(built.value.patch[2].value.状态, '待确认');
    assert.equal(built.value.patch[2].value.服务分类, 'girl_shuren');
    assert.equal(built.value.patch[2].value.已确认边界, '');
    assert.deepEqual(built.value.patch[2].value.合法结束条件, { 已满足: false, 摘要: '', 记录时间: '' });
    assert.equal(validateControlledPatchAgainstState(state, built.value.patch).ok, true);
    const forged = structuredClone(built.value.patch); forged[2].value.状态 = '进行中';
    assert.equal(validateControlledPatchAgainstState(state, forged).ok, false, 'UI may not forge confirmed/active status');
    const forgedCompletion = structuredClone(built.value.patch);
    forgedCompletion[2].value.合法结束条件 = { 已满足: true, 摘要: '伪造完成', 记录时间: '现在' };
    assert.equal(validateControlledPatchAgainstState(state, forgedCompletion).ok, false, 'UI may not forge a satisfied completion signal');
    assert.deepEqual(state, serviceState());
});

test('service handoff rejects mode/category mismatch, non-adults, and any occupied derived UID key', () => {
    const state = serviceState();
    assert.equal(buildServiceOrderHandoffPatch(state, { candidate: adultCandidate(), categoryId: 'adult_companion' }).ok, false);
    const minor = adultCandidate(); minor.隐藏资料.实际年龄 = 17;
    assert.equal(buildServiceOrderHandoffPatch(state, { candidate: minor, categoryId: 'girl_shuren' }).ok, false);
    state.角色池.npc_service_1 = null;
    assert.equal(buildServiceOrderHandoffPatch(state, { candidate: adultCandidate(), categoryId: 'girl_shuren' }).code, 'service_order_uid_conflict');
});

test('service handoff accepts every adult candidate the local generation gate accepts (no extra personal-name gate)', () => {
    // 生成闸门（generateServiceProfileCandidate）不要求“真人姓名”风格；
    // 下单闸门必须与其一致，否则合法成年本地角色会在下单时被 service_order_candidate_invalid 误拒。
    for (const nickname of ['Momo酱', '小7', '咖啡师安然']) {
        const generated = normalizeGeneratedCandidate(adultCandidate(nickname), { contentMode: 'SFW' });
        const state = serviceState();
        const built = buildServiceOrderHandoffPatch(state, { candidate: generated, categoryId: 'girl_shuren' });
        assert.equal(built.ok, true, `昵称「${nickname}」的成年本地角色必须可以下单`);
        assert.equal(built.value.patch[2].value.服务主题, `熟人商品：与${nickname}的文字协商`);
        assert.equal(validateControlledPatchAgainstState(state, built.value.patch).ok, true, `昵称「${nickname}」的受控 Patch 必须通过白名单校验`);
    }
});

test('dropping the name-style gate never weakens the adult gate on service handoff', () => {
    const unverified = adultCandidate('Momo酱'); unverified.成人验证 = false;
    assert.equal(buildServiceOrderHandoffPatch(serviceState(), { candidate: unverified, categoryId: 'girl_shuren' }).code, 'service_order_candidate_invalid');
    const underageBand = adultCandidate('Momo酱'); underageBand.公开资料.年龄段 = '16-19';
    assert.equal(buildServiceOrderHandoffPatch(serviceState(), { candidate: underageBand, categoryId: 'girl_shuren' }).code, 'service_order_candidate_invalid');
    const underageActual = adultCandidate('Momo酱'); underageActual.隐藏资料.实际年龄 = 17;
    assert.equal(buildServiceOrderHandoffPatch(serviceState(), { candidate: underageActual, categoryId: 'girl_shuren' }).code, 'service_order_candidate_invalid');
});

test('a complete terminal service order repeats exactly as a fresh pending order without stale fields or role copy', () => {
    const state = repeatState();
    const before = structuredClone(state);
    const second = buildServiceOrderRepeatPatch(state, { sourceOrderUid: 'service_1' });
    assert.equal(second.ok, true);
    assert.equal(second.value.orderUid, 'service_2');
    assert.deepEqual(second.value.patch.map(({ op, path }) => [op, path]), [
        ['add', '/服务订单/service_2'], ['replace', '/系统/UID计数器/服务订单'],
    ]);
    assert.deepEqual(second.value.patch[0].value, {
        角色UID: 'npc_service_1', 角色UID列表: ['npc_service_1'], 内容模式: 'SFW', 服务分类: 'girl_shuren', 服务主题: '熟人商品：与林澈的文字协商',
        状态: '待确认', 发起时间: '待正文确认', 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '',
        合法结束条件: { 已满足: false, 摘要: '', 记录时间: '' },
    });
    assert.equal(validateControlledPatchAgainstState(state, second.value.patch).ok, true);

    const forgedTopic = structuredClone(second.value.patch);
    forgedTopic[0].value.服务主题 = '熟人商品：伪造主题';
    assert.equal(validateControlledPatchAgainstState(state, forgedTopic).code, 'patch_not_exact_ui_transition');
    const forgedCounter = structuredClone(second.value.patch);
    forgedCounter[1].value = 3;
    assert.equal(validateControlledPatchAgainstState(state, forgedCounter).code, 'patch_not_exact_ui_transition');
    const forgedCategory = structuredClone(second.value.patch);
    forgedCategory[0].value.服务分类 = 'arts_outing';
    assert.equal(validateControlledPatchAgainstState(state, forgedCategory).code, 'patch_not_exact_ui_transition');
    const forgedRoleCopy = structuredClone(second.value.patch);
    forgedRoleCopy.unshift({ op: 'add', path: '/角色池/npc_service_2', value: adultCandidate() });
    assert.equal(validateControlledPatchAgainstState(state, forgedRoleCopy).code, 'patch_not_exact_ui_transition');
    const forgedBoundary = structuredClone(second.value.patch);
    forgedBoundary[0].value.已确认边界 = '不应继承旧边界';
    assert.equal(validateControlledPatchAgainstState(state, forgedBoundary).ok, false);
    assert.deepEqual(state, before, 'building and exact-patch validation must not mutate the source state');
});

test('repeat accepts a complete cancellation but rejects incomplete, mismatched, or no-longer-adult terminal sources', () => {
    const cancelled = repeatState({ status: '已取消' });
    const cancelledRepeat = buildServiceOrderRepeatPatch(cancelled, { sourceOrderUid: 'service_1' });
    assert.equal(cancelledRepeat.ok, true);
    assert.equal(cancelledRepeat.value.patch[0].value.开始时间, '');
    assert.equal(cancelledRepeat.value.patch[0].value.已确认边界, '');
    assert.equal(validateControlledPatchAgainstState(cancelled, cancelledRepeat.value.patch).ok, true);

    const mismatchedMode = repeatState();
    mismatchedMode.服务订单.service_1.内容模式 = 'NSFW';
    assert.equal(buildServiceOrderRepeatPatch(mismatchedMode, { sourceOrderUid: 'service_1' }).code, 'service_order_repeat_not_available');
    const adultExpired = repeatState();
    adultExpired.角色池.npc_service_1.成人验证 = false;
    assert.equal(buildServiceOrderRepeatPatch(adultExpired, { sourceOrderUid: 'service_1' }).code, 'service_order_repeat_not_available');

    const invalidRoleUid = repeatState();
    invalidRoleUid.服务订单.service_1.角色UID = '__proto__';
    assert.equal(buildServiceOrderRepeatPatch(invalidRoleUid, { sourceOrderUid: 'service_1' }).code, 'service_order_repeat_not_available');
    const candidateOnly = repeatState();
    candidateOnly.推荐.临时候选池.npc_service_1 = candidateOnly.角色池.npc_service_1;
    delete candidateOnly.角色池.npc_service_1;
    assert.equal(buildServiceOrderRepeatPatch(candidateOnly, { sourceOrderUid: 'service_1' }).code, 'service_order_repeat_not_available');

    for (const [field, value] of [['结束时间', ''], ['结束摘要', ''], ['开始时间', ''], ['已确认边界', ''], ['服务主题', '伪造历史主题']]) {
        const incomplete = repeatState();
        incomplete.服务订单.service_1[field] = value;
        assert.equal(buildServiceOrderRepeatPatch(incomplete, { sourceOrderUid: 'service_1' }).code, 'service_order_repeat_state_invalid', `completed source with invalid ${field} must not repeat`);
    }
    const nonterminal = repeatState();
    nonterminal.服务订单.service_1.状态 = '进行中';
    assert.equal(buildServiceOrderRepeatPatch(nonterminal, { sourceOrderUid: 'service_1' }).code, 'service_order_repeat_state_invalid');
});

test('repeat blocks a same-role same-mode pending or active order and rejects counter overflow and UID collisions', () => {
    for (const status of ['待确认', '进行中']) {
        const state = repeatState();
        state.服务订单.service_99 = {
            角色UID: 'npc_service_1', 内容模式: 'SFW', 服务分类: 'girl_shuren', 服务主题: '熟人商品：与林澈的文字协商', 状态: status,
            发起时间: '待正文确认', 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '',
        };
        assert.equal(buildServiceOrderRepeatPatch(state, { sourceOrderUid: 'service_1' }).code, 'service_order_conflict', `must not create any parallel ${status} order`);
    }

    for (const counter of [-1, 1.5, 999999]) {
        const state = repeatState();
        state.系统.UID计数器.服务订单 = counter;
        assert.equal(buildServiceOrderRepeatPatch(state, { sourceOrderUid: 'service_1' }).code, 'service_order_repeat_state_invalid');
    }
    const upperBoundary = repeatState();
    upperBoundary.系统.UID计数器.服务订单 = 999998;
    assert.equal(buildServiceOrderRepeatPatch(upperBoundary, { sourceOrderUid: 'service_1' }).value.orderUid, 'service_999999');
    const collision = repeatState();
    collision.服务订单.service_2 = null;
    assert.equal(buildServiceOrderRepeatPatch(collision, { sourceOrderUid: 'service_1' }).code, 'service_order_uid_conflict');
});

test('one open service order globally blocks a fresh handoff and a terminal repeat', () => {
    const handoffBlocked = serviceState();
    handoffBlocked.服务订单.service_existing = { 角色UID: 'npc_existing', 内容模式: 'SFW', 服务分类: 'girl_shuren', 服务主题: '已有订单', 状态: '待确认', 发起时间: '待正文确认', 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '' };
    assert.equal(buildServiceOrderHandoffPatch(handoffBlocked, { candidate: adultCandidate(), categoryId: 'girl_shuren' }).code, 'service_order_conflict');

    const repeatBlocked = repeatState();
    repeatBlocked.服务订单.service_existing = { 角色UID: 'npc_other', 内容模式: 'SFW', 服务分类: 'arts_outing', 服务主题: '另一笔订单', 状态: '进行中', 发起时间: '待正文确认', 开始时间: '已开始', 结束时间: '', 结束摘要: '', 已确认边界: '{"主题":"展览","允许项":"同行","排除项":"无","强度":"轻松","隐私处理":"最小留存"}' };
    assert.equal(buildServiceOrderRepeatPatch(repeatBlocked, { sourceOrderUid: 'service_1' }).code, 'service_order_conflict');
});

test('service lifecycle permits only exact start, cancel, complete, finalize, and rebook transitions', () => {
    const pending = serviceState();
    const handoff = buildServiceOrderHandoffPatch(pending, { candidate: adultCandidate(), categoryId: 'girl_shuren' });
    assert.equal(handoff.ok, true);
    pending.角色池[handoff.value.npcUid] = handoff.value.patch[0].value;
    pending.正文记忆[handoff.value.npcUid] = '';
    pending.服务订单[handoff.value.orderUid] = structuredClone(handoff.value.patch[2].value);
    pending.系统.UID计数器.角色 = 1;
    pending.系统.UID计数器.服务订单 = 1;
    const baseBoundaries = { 内容模式: 'SFW', 主题: '熟人商品', 允许项: '公开聊天与结伴散步', 排除项: '未协商事项', 强度: '轻松陪伴', 隐私处理: '仅保留最小摘要', 服务信息: { 价格: '正文协商', 时长: '两小时', 排期: '本周末', 套餐: '基础陪伴', 评价: '', 投诉: '', 退款: '', 服务者信用: '新服务者' } };
    assert.equal(buildServiceOrderStartPatch(pending, { orderUid: 'service_1', boundaries: { ...baseBoundaries, 玩家已同意: false, NPC明确同意: [true] } }).code, 'service_order_start_invalid', 'player consent must be explicit');
    assert.equal(buildServiceOrderStartPatch(pending, { orderUid: 'service_1', boundaries: { ...baseBoundaries, 玩家已同意: true, NPC明确同意: [false] } }).code, 'service_order_start_invalid', 'every NPC consent entry must be explicit');
    assert.equal(buildServiceOrderStartPatch(pending, { orderUid: 'service_1', boundaries: { ...baseBoundaries, 内容模式: 'NSFW', 玩家已同意: true, NPC明确同意: [true] } }).code, 'service_order_start_invalid', 'consent records cannot cross content modes');
    const boundaries = { ...baseBoundaries, 玩家已同意: true, NPC明确同意: [true] };

    const start = buildServiceOrderStartPatch(pending, { orderUid: 'service_1', boundaries });
    assert.deepEqual(start.value.map(({ op, path }) => [op, path]), [
        ['replace', '/服务订单/service_1/状态'], ['replace', '/服务订单/service_1/开始时间'], ['replace', '/服务订单/service_1/已确认边界'],
    ]);
    assert.equal(validateControlledPatchAgainstState(pending, start.value).ok, true);
    assert.deepEqual(JSON.parse(start.value[2].value).服务信息, baseBoundaries.服务信息, 'the controlled contract keeps bounded service information while the history store omits it');
    const forgedStart = structuredClone(start.value); forgedStart[0].value = '已完成';
    assert.equal(validateControlledPatchAgainstState(pending, forgedStart).ok, false);

    pending.服务订单.service_1.状态 = '进行中';
    pending.服务订单.service_1.开始时间 = '玩家已确认接单';
    pending.服务订单.service_1.已确认边界 = start.value[2].value;
    assert.equal(buildServiceOrderCompletePatch(pending, { orderUid: 'service_1' }).code, 'service_order_complete_invalid', '正文未标记合法结束条件时不能完成');
    pending.服务订单.service_1.合法结束条件 = { 已满足: true, 摘要: '双方正文已结束。', 记录时间: '正文最新回合' };
    const complete = buildServiceOrderCompletePatch(pending, { orderUid: 'service_1' });
    assert.deepEqual(complete.value.map(({ op, path }) => [op, path]), [
        ['replace', '/服务订单/service_1/状态'], ['replace', '/服务订单/service_1/结束时间'], ['replace', '/服务订单/service_1/结束摘要'],
    ]);
    assert.equal(validateControlledPatchAgainstState(pending, complete.value).ok, true);
    pending.服务订单.service_1.状态 = '已完成';
    pending.服务订单.service_1.结束时间 = complete.value[1].value;
    pending.服务订单.service_1.结束摘要 = complete.value[2].value;
    const finalize = buildServiceOrderFinalizePatch(pending, { orderUid: 'service_1' });
    assert.deepEqual(finalize.value, [{ op: 'remove', path: '/服务订单/service_1' }]);
    assert.equal(validateControlledPatchAgainstState(pending, finalize.value).ok, true);

    const rebookState = structuredClone(pending);
    delete rebookState.服务订单.service_1;
    const rebook = buildServiceOrderRebookPatch(rebookState, { npcUid: 'npc_service_1', categoryId: 'girl_shuren' });
    assert.equal(rebook.ok, true);
    assert.equal(rebook.value.orderUid, 'service_2');
    assert.equal(rebook.value.patch[0].value.已确认边界, '');
    assert.deepEqual(rebook.value.patch[0].value.合法结束条件, { 已满足: false, 摘要: '', 记录时间: '' });
    assert.equal(validateControlledPatchAgainstState(rebookState, rebook.value.patch).ok, true);

    const cancelled = serviceState();
    const cancelledHandoff = buildServiceOrderHandoffPatch(cancelled, { candidate: adultCandidate(), categoryId: 'girl_shuren' });
    cancelled.角色池[cancelledHandoff.value.npcUid] = cancelledHandoff.value.patch[0].value;
    cancelled.正文记忆[cancelledHandoff.value.npcUid] = '';
    cancelled.服务订单[cancelledHandoff.value.orderUid] = structuredClone(cancelledHandoff.value.patch[2].value);
    cancelled.系统.UID计数器.角色 = 1;
    cancelled.系统.UID计数器.服务订单 = 1;
    const cancel = buildServiceOrderCancelPatch(cancelled, { orderUid: 'service_1' });
    assert.equal(validateControlledPatchAgainstState(cancelled, cancel.value).ok, true);
    assert.equal(buildServiceOrderCompletePatch(cancelled, { orderUid: 'service_1' }).code, 'service_order_complete_invalid');
});

test('three-person handoff derives ordered service roles atomically and rejects a fourth or duplicated name', () => {
    const state = serviceState();
    const candidates = [adultCandidate('林澈'), adultCandidate('顾晴'), adultCandidate('周岚')];
    const built = buildServiceOrderHandoffPatch(state, { candidates, categoryId: 'girl_shuren' });
    assert.equal(built.ok, true);
    assert.deepEqual(built.value.npcUids, ['npc_service_1', 'npc_service_2', 'npc_service_3']);
    assert.equal(built.value.orderUid, 'service_1');
    assert.deepEqual(built.value.patch.map(({ op, path }) => [op, path]), [
        ['add', '/角色池/npc_service_1'], ['add', '/正文记忆/npc_service_1'],
        ['add', '/角色池/npc_service_2'], ['add', '/正文记忆/npc_service_2'],
        ['add', '/角色池/npc_service_3'], ['add', '/正文记忆/npc_service_3'],
        ['add', '/服务订单/service_1'], ['replace', '/系统/UID计数器/角色'], ['replace', '/系统/UID计数器/服务订单'],
    ]);
    assert.deepEqual(built.value.patch[6].value.角色UID列表, built.value.npcUids);
    assert.deepEqual(built.value.patch[6].value.合法结束条件, { 已满足: false, 摘要: '', 记录时间: '' });
    assert.equal(built.value.patch[7].value, 3);
    assert.equal(built.value.patch[8].value, 1);
    assert.equal(validateControlledPatchAgainstState(state, built.value.patch).ok, true);
    assert.equal(buildServiceOrderHandoffPatch(state, { candidates: [...candidates, adultCandidate('陆遥')], categoryId: 'girl_shuren' }).code, 'service_order_candidate_invalid');
    assert.equal(buildServiceOrderHandoffPatch(state, { candidates: [adultCandidate('林澈'), adultCandidate('林澈')], categoryId: 'girl_shuren' }).code, 'service_order_candidate_invalid');
});

test('multi-person terminal repeat and local rebook preserve the participant set but never stale contract fields', () => {
    const state = serviceState();
    state.系统.UID计数器.角色 = 2;
    state.系统.UID计数器.服务订单 = 1;
    state.角色池.npc_service_1 = adultCandidate('林澈');
    state.角色池.npc_service_2 = adultCandidate('顾晴');
    state.正文记忆.npc_service_1 = '';
    state.正文记忆.npc_service_2 = '';
    state.服务订单.service_1 = {
        角色UID: 'npc_service_1', 角色UID列表: ['npc_service_1', 'npc_service_2'], 内容模式: 'SFW', 服务分类: 'girl_shuren',
        服务主题: '熟人商品：与林澈、顾晴的文字协商', 状态: '已完成', 发起时间: '昨天 18:00', 开始时间: '昨天 19:00',
        结束时间: '昨天 21:00', 结束摘要: '双方确认本次文字协商已结束。', 已确认边界: '已确认的旧边界',
        合法结束条件: { 已满足: true, 摘要: '正文已结束。', 记录时间: '正文最新回合' },
    };
    const repeated = buildServiceOrderRepeatPatch(state, { sourceOrderUid: 'service_1' });
    assert.equal(repeated.ok, true);
    assert.deepEqual(repeated.value.npcUids, ['npc_service_1', 'npc_service_2']);
    assert.deepEqual(repeated.value.patch[0].value.角色UID列表, ['npc_service_1', 'npc_service_2']);
    assert.equal(repeated.value.patch[0].value.已确认边界, '');
    assert.deepEqual(repeated.value.patch[0].value.合法结束条件, { 已满足: false, 摘要: '', 记录时间: '' });
    assert.equal(repeated.value.patch[0].value.服务主题, '熟人商品：与林澈、顾晴的文字协商');
    assert.equal(validateControlledPatchAgainstState(state, repeated.value.patch).ok, true);

    delete state.服务订单.service_1;
    const rebooked = buildServiceOrderRebookPatch(state, { npcUids: ['npc_service_1', 'npc_service_2'], categoryId: 'girl_shuren' });
    assert.equal(rebooked.ok, true);
    assert.deepEqual(rebooked.value.patch[0].value.角色UID列表, ['npc_service_1', 'npc_service_2']);
    assert.deepEqual(rebooked.value.patch[0].value.合法结束条件, { 已满足: false, 摘要: '', 记录时间: '' });
    assert.equal(buildServiceOrderRebookPatch(state, { npcUids: ['npc_service_1', 'npc_service_2', 'npc_service_3', 'npc_service_4'], categoryId: 'girl_shuren' }).code, 'service_order_rebook_invalid');
});

function serviceDeletionState() {
    const state = serviceState();
    Object.assign(state.推荐, { 当前队列: [], 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] });
    state.会话 = {}; state.面基记录 = {}; state.群组 = {};
    state.角色池.npc_service_1 = adultCandidate('林澈');
    state.角色池.npc_service_2 = adultCandidate('顾晴');
    state.正文记忆.npc_service_1 = '';
    state.正文记忆.npc_service_2 = '';
    return state;
}

test('history deletion removes every isolated service role in one exact patch and refuses unsafe targets', () => {
    const state = serviceDeletionState();
    const deleted = buildServiceHistoryRolesDeletionPatch(state, { npcUids: ['npc_service_1', 'npc_service_2'] });
    assert.equal(deleted.ok, true);
    assert.deepEqual(deleted.value, [
        { op: 'remove', path: '/正文记忆/npc_service_1' }, { op: 'remove', path: '/角色池/npc_service_1' },
        { op: 'remove', path: '/正文记忆/npc_service_2' }, { op: 'remove', path: '/角色池/npc_service_2' },
    ]);
    assert.equal(validateControlledPatchAgainstState(state, deleted.value).ok, true);
    assert.equal(buildServiceHistoryRolesDeletionPatch(state, { npcUids: ['npc_service_1', 'npc_service_1'] }).code, 'service_history_delete_invalid');
    assert.equal(buildServiceHistoryRolesDeletionPatch(state, { npcUids: ['npc_service_1', 'npc_service_2', 'npc_service_3', 'npc_service_4'] }).code, 'service_history_delete_invalid');
    state.服务订单.service_1 = { 角色UID: 'npc_service_1', 角色UID列表: ['npc_service_1'], 内容模式: 'SFW', 服务分类: 'girl_shuren', 服务主题: '熟人商品：与林澈的文字协商', 状态: '待确认', 发起时间: '待正文确认', 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '' };
    assert.equal(buildServiceHistoryRolesDeletionPatch(state, { npcUids: ['npc_service_1'] }).code, 'service_history_delete_open_order');
});

test('repair removes only malformed service orders, including over-three participant records', () => {
    const state = serviceState();
    const handoff = buildServiceOrderHandoffPatch(state, { candidate: adultCandidate(), categoryId: 'girl_shuren' });
    state.角色池.npc_service_1 = handoff.value.patch[0].value;
    state.正文记忆.npc_service_1 = '';
    state.服务订单.service_1 = structuredClone(handoff.value.patch[2].value);
    state.系统.UID计数器.角色 = 1;
    state.系统.UID计数器.服务订单 = 1;
    assert.equal(buildServiceOrderRepairPatch(state, { orderUid: 'service_1' }).code, 'service_order_repair_not_needed');
    state.服务订单.service_bad = { ...structuredClone(state.服务订单.service_1), 角色UID列表: ['npc_service_1', 'npc_service_2', 'npc_service_3', 'npc_service_4'] };
    const repaired = buildServiceOrderRepairPatch(state, { orderUid: 'service_bad' });
    assert.deepEqual(repaired.value, [{ op: 'remove', path: '/服务订单/service_bad' }]);
    assert.equal(validateControlledPatchAgainstState(state, repaired.value).ok, true);
});

test('terminal rebooking accepts a bounded 2600-character service contract without treating it as malformed', () => {
    const state = repeatState();
    state.服务订单.service_1.已确认边界 = '已确认边界'.repeat(180);
    assert.ok(state.服务订单.service_1.已确认边界.length > 600);
    assert.ok(state.服务订单.service_1.已确认边界.length <= 2600);
    const repeated = buildServiceOrderRepeatPatch(state, { sourceOrderUid: 'service_1' });
    assert.equal(repeated.ok, true);
    assert.equal(validateControlledPatchAgainstState(state, repeated.value.patch).ok, true);
});


test('new controlled service patches accept every person category in either mode and reject legacy or unknown categories', () => {
    const personCategories = {
        girl_shuren: '熟人商品', girl_luren: '路人商品', random_generation: '随机商品',
    };
    for (const mode of ['SFW', 'NSFW']) {
        for (const [categoryId, category] of Object.entries(personCategories)) {
            const state = serviceState();
            state.软件.内容模式 = mode;
            const built = buildServiceOrderHandoffPatch(state, { candidate: adultCandidate(), categoryId });
            assert.equal(built.ok, true, `${mode} must accept ${categoryId}`);
            assert.equal(built.value.patch[2].value.服务主题, `${category}：与林澈的文字协商`);
            assert.equal(validateControlledPatchAgainstState(state, built.value.patch).ok, true);
        }
    }
    assert.equal(buildServiceOrderHandoffPatch(serviceState(), { candidate: adultCandidate(), categoryId: 'coffee_walk' }).ok, false);
    assert.equal(buildServiceOrderHandoffPatch(serviceState(), { candidate: adultCandidate(), categoryId: 'not_a_category' }).ok, false);
});

test('legacy activity orders remain valid historical records but cannot produce a new controlled order', () => {
    const state = serviceState();
    state.系统.UID计数器.角色 = 1;
    state.系统.UID计数器.服务订单 = 1;
    state.角色池.npc_service_1 = adultCandidate();
    state.正文记忆.npc_service_1 = '';
    state.服务订单.service_legacy = {
        角色UID: 'npc_service_1', 角色UID列表: ['npc_service_1'], 内容模式: 'NSFW', 服务分类: 'adult_companion',
        服务主题: '成人直白陪伴：与林澈的文字协商', 状态: '已完成',
        发起时间: '昨天 18:00', 开始时间: '昨天 19:00', 结束时间: '昨天 21:00',
        结束摘要: '双方确认本次文字协商已安全结束。', 已确认边界: '仅在正文中继续协商，随时可以拒绝。',
    };
    state.软件.内容模式 = 'NSFW';
    assert.equal(buildServiceOrderRepairPatch(state, { orderUid: 'service_legacy' }).code, 'service_order_repair_not_needed');
    assert.equal(buildServiceOrderRepeatPatch(state, { sourceOrderUid: 'service_legacy' }).code, 'service_order_repeat_not_available');
});

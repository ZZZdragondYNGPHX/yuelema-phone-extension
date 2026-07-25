import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServiceOrderHandoffPatch, buildServiceOrderRepeatPatch, validateControlledPatchAgainstState } from '../controlled-patch.js';

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

function terminalOrder({ nickname = '林澈', status = '已完成' } = {}) {
    return {
        角色UID: 'npc_service_1', 内容模式: 'SFW', 服务分类: 'coffee_walk', 服务主题: `咖啡与散步：与${nickname}的文字协商`, 状态: status,
        发起时间: '昨天 18:00', 开始时间: status === '已完成' ? '昨天 19:00' : '', 结束时间: '昨天 21:00',
        结束摘要: '双方确认本次文字协商已安全结束。', 已确认边界: status === '已完成' ? '仅在正文中继续协商，随时可以拒绝。' : '',
    };
}

function repeatState({ status = '已完成' } = {}) {
    const state = serviceState();
    state.系统.UID计数器.角色 = 1;
    state.系统.UID计数器.服务订单 = 1;
    state.角色池.npc_service_1 = adultCandidate();
    state.服务订单.service_1 = terminalOrder({ status });
    return state;
}

test('service handoff atomically copies an adult local draft and opens one pending SFW order', () => {
    const state = serviceState();
    const built = buildServiceOrderHandoffPatch(state, { candidate: adultCandidate(), categoryId: 'coffee_walk' });
    assert.equal(built.ok, true);
    assert.equal(built.value.npcUid, 'npc_service_1');
    assert.equal(built.value.orderUid, 'service_1');
    assert.deepEqual(built.value.patch.map(({ op, path }) => [op, path]), [
        ['add', '/角色池/npc_service_1'], ['add', '/服务订单/service_1'], ['replace', '/系统/UID计数器/角色'], ['replace', '/系统/UID计数器/服务订单'],
    ]);
    assert.equal(built.value.patch[1].value.状态, '待确认');
    assert.equal(built.value.patch[1].value.服务分类, 'coffee_walk');
    assert.equal(built.value.patch[1].value.已确认边界, '');
    assert.equal(validateControlledPatchAgainstState(state, built.value.patch).ok, true);
    const forged = structuredClone(built.value.patch); forged[1].value.状态 = '进行中';
    assert.equal(validateControlledPatchAgainstState(state, forged).ok, false, 'UI may not forge confirmed/active status');
    assert.deepEqual(state, serviceState());
});

test('service handoff rejects mode/category mismatch, non-adults, and any occupied derived UID key', () => {
    const state = serviceState();
    assert.equal(buildServiceOrderHandoffPatch(state, { candidate: adultCandidate(), categoryId: 'adult_companion' }).ok, false);
    const minor = adultCandidate(); minor.隐藏资料.实际年龄 = 17;
    assert.equal(buildServiceOrderHandoffPatch(state, { candidate: minor, categoryId: 'coffee_walk' }).ok, false);
    state.角色池.npc_service_1 = null;
    assert.equal(buildServiceOrderHandoffPatch(state, { candidate: adultCandidate(), categoryId: 'coffee_walk' }).code, 'service_order_uid_conflict');
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
        角色UID: 'npc_service_1', 内容模式: 'SFW', 服务分类: 'coffee_walk', 服务主题: '咖啡与散步：与林澈的文字协商',
        状态: '待确认', 发起时间: '待正文确认', 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '',
    });
    assert.equal(validateControlledPatchAgainstState(state, second.value.patch).ok, true);

    const forgedTopic = structuredClone(second.value.patch);
    forgedTopic[0].value.服务主题 = '咖啡与散步：伪造主题';
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
            角色UID: 'npc_service_1', 内容模式: 'SFW', 服务分类: 'coffee_walk', 服务主题: '咖啡与散步：与林澈的文字协商', 状态: status,
            发起时间: '待正文确认', 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '',
        };
        assert.equal(buildServiceOrderRepeatPatch(state, { sourceOrderUid: 'service_1' }).code, 'service_order_repeat_not_available', `must not create a parallel ${status} order`);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SERVICE_CONTRACT_VERSION,
    classifyServiceOrderLifecycle,
    createEmptyServiceSignal,
    createServiceContractDraft,
    isEmptyServiceSignal,
    isValidServiceSignal,
    nextServiceContractRevision,
    parseServiceContract,
    projectServiceContractSummary,
    serializeServiceContractDraft,
} from '../service-order-contract.js';

const PARTICIPANTS = Object.freeze(['npc_service_1', 'npc_service_2']);

function confirmedDraft({ mode = 'SFW', revision = 1 } = {}) {
    const draft = createServiceContractDraft({ mode, participantCount: PARTICIPANTS.length, topic: mode === 'SFW' ? '城市看展与晚餐' : '当次明确邀约', revision });
    draft.玩家已同意 = true;
    draft.NPC明确同意 = [true, true];
    draft.安排 = {
        时长: '两小时',
        时间窗: '周六晚上',
        场景类型: mode === 'SFW' ? '公开展馆' : '虚构私密场景',
        组合摘要: '先复述边界，再逐步推进',
        虚构价格: mode === 'SFW' ? '剧情内虚构 88 元' : '',
    };
    return draft;
}

function activeOrder(serialized, overrides = {}) {
    return {
        状态: '进行中',
        发起时间: '待正文确认',
        开始时间: '玩家已确认开始',
        结束时间: '',
        结束摘要: '',
        已确认边界: serialized,
        合法结束条件: createEmptyServiceSignal('已满足'),
        撤回候选: createEmptyServiceSignal('已提出'),
        ...overrides,
    };
}

test('v2 序列化由受控边界注入逐 UID 确认快照，不信任 UI 提供的身份', () => {
    const draft = confirmedDraft();
    assert.equal(JSON.stringify(draft).includes('npc_service_'), false, 'UI 草稿不得携带内部 UID');
    const built = serializeServiceContractDraft(draft, { mode: 'SFW', participantUids: PARTICIPANTS, expectedRevision: 1 });
    assert.equal(built.ok, true);
    const stored = JSON.parse(built.serialized);
    assert.equal(stored.协议版本, SERVICE_CONTRACT_VERSION);
    assert.equal(stored.修订号, 1);
    assert.deepEqual(stored.确认快照.角色, [
        { 角色UID: 'npc_service_1', 状态: '已同意', 修订号: 1 },
        { 角色UID: 'npc_service_2', 状态: '已同意', 修订号: 1 },
    ]);
    assert.equal(Object.isFrozen(built.contract), true);
    assert.equal(Object.isFrozen(built.contract.确认快照.角色), true);
});

test('逐人确认、修订号与参与者顺序必须完整一致', () => {
    const missingConsent = confirmedDraft();
    missingConsent.NPC明确同意[1] = false;
    assert.equal(serializeServiceContractDraft(missingConsent, { mode: 'SFW', participantUids: PARTICIPANTS, expectedRevision: 1 }).ok, false);

    const staleRevision = confirmedDraft({ revision: 1 });
    assert.match(
        serializeServiceContractDraft(staleRevision, { mode: 'SFW', participantUids: PARTICIPANTS, expectedRevision: 2 }).reason,
        /修订号/u,
    );

    const built = serializeServiceContractDraft(confirmedDraft(), { mode: 'SFW', participantUids: PARTICIPANTS, expectedRevision: 1 });
    const swapped = JSON.parse(built.serialized);
    swapped.确认快照.角色.reverse();
    assert.equal(parseServiceContract(JSON.stringify(swapped), { mode: 'SFW', participantUids: PARTICIPANTS }).status, 'invalid');
    assert.equal(nextServiceContractRevision(built.serialized, { mode: 'SFW', participantUids: PARTICIPANTS }), 2);

    const revisionTwo = confirmedDraft({ revision: 2 });
    const resumed = serializeServiceContractDraft(revisionTwo, { mode: 'SFW', participantUids: PARTICIPANTS, expectedRevision: 2 });
    assert.equal(resumed.ok, true);
    assert.equal(parseServiceContract(resumed.serialized, { mode: 'SFW', participantUids: PARTICIPANTS }).contract.修订号, 2);
});

test('NSFW 安排不存在价格或旧交易字段通道', () => {
    const draft = confirmedDraft({ mode: 'NSFW' });
    const accepted = serializeServiceContractDraft(draft, { mode: 'NSFW', participantUids: PARTICIPANTS, expectedRevision: 1 });
    assert.equal(accepted.ok, true);
    assert.equal(JSON.stringify(JSON.parse(accepted.serialized).安排).includes('价格'), true, '固定字段名仍在 schema 中，但 NSFW 值必须为空');
    assert.equal(JSON.parse(accepted.serialized).安排.虚构价格, '');

    draft.安排.虚构价格 = '100';
    const rejected = serializeServiceContractDraft(draft, { mode: 'NSFW', participantUids: PARTICIPANTS, expectedRevision: 1 });
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /NSFW.*价格|安排.*交易/u);

    const legacyTradeDraft = {
        内容模式: 'NSFW', 主题: '当次邀约', 允许项: '明确同意的内容', 排除项: '未确认内容', 强度: '当次协商', 隐私处理: '最小留存',
        服务信息: { 价格: '100', 时长: '', 排期: '', 套餐: '', 评价: '', 投诉: '', 退款: '', 服务者信用: '' },
        玩家已同意: true, NPC明确同意: [true, true],
    };
    assert.equal(serializeServiceContractDraft(legacyTradeDraft, { mode: 'NSFW', participantUids: PARTICIPANTS }).ok, false);
});

test('解析器明确区分 valid / legacy / invalid / empty 并仅输出安全摘要', () => {
    const built = serializeServiceContractDraft(confirmedDraft(), { mode: 'SFW', participantUids: PARTICIPANTS, expectedRevision: 1 });
    const valid = parseServiceContract(built.serialized, { mode: 'SFW', participantUids: PARTICIPANTS });
    assert.equal(valid.status, 'valid');
    assert.deepEqual(projectServiceContractSummary(valid), {
        health: 'valid', version: 2, revision: 1, experienceType: '租借恋人', topic: '城市看展与晚餐',
        allowed: '由双方在正文中确认的约会内容', excluded: '未明确同意、已撤回或无法确认的内容',
        intensity: '轻松、尊重且可随时调整', privacy: '仅保留最小化终态摘要，不记录完整过程',
        arrangement: { duration: '两小时', window: '周六晚上', scene: '公开展馆', combination: '先复述边界，再逐步推进', fictionalPrice: '剧情内虚构 88 元' },
    });

    const legacy = parseServiceContract('旧版已确认文本', { mode: 'SFW', participantUids: PARTICIPANTS });
    assert.equal(legacy.status, 'legacy');
    assert.equal(parseServiceContract('', { mode: 'SFW', participantUids: PARTICIPANTS }).status, 'empty');
    assert.equal(parseServiceContract('{"__proto__":{}}', { mode: 'SFW', participantUids: PARTICIPANTS }).status, 'invalid');
    assert.equal(parseServiceContract(built.serialized, { mode: 'NSFW', participantUids: PARTICIPANTS }).status, 'invalid');
});

test('生命周期将可升级旧合同与损坏订单分开，完成/撤回候选必须是完整信号', () => {
    const built = serializeServiceContractDraft(confirmedDraft(), { mode: 'SFW', participantUids: PARTICIPANTS, expectedRevision: 1 });
    const valid = classifyServiceOrderLifecycle(activeOrder(built.serialized), { mode: 'SFW', participantUids: PARTICIPANTS });
    assert.equal(valid.kind, 'valid');
    assert.equal(valid.contractStatus, 'valid');

    const recoverable = classifyServiceOrderLifecycle(activeOrder('旧版边界合同'), { mode: 'SFW', participantUids: PARTICIPANTS });
    assert.equal(recoverable.kind, 'recoverable');
    assert.equal(recoverable.contractStatus, 'legacy');

    const invalid = classifyServiceOrderLifecycle(activeOrder(''), { mode: 'SFW', participantUids: PARTICIPANTS });
    assert.equal(invalid.kind, 'invalid');

    const completion = { 已满足: true, 摘要: '正文提出完成候选。', 记录时间: '正文最新回合' };
    const withdrawal = { 已提出: true, 摘要: '一位参与者提出撤回。', 记录时间: '正文最新回合' };
    assert.equal(isValidServiceSignal(completion), true);
    assert.equal(isValidServiceSignal({ ...completion, 记录时间: '' }), false);
    assert.equal(isValidServiceSignal(withdrawal, { flagKey: '已提出' }), true);
    assert.equal(isEmptyServiceSignal(createEmptyServiceSignal('已提出'), { flagKey: '已提出' }), true);

    const withdrawalReady = classifyServiceOrderLifecycle(activeOrder(built.serialized, { 撤回候选: withdrawal }), { mode: 'SFW', participantUids: PARTICIPANTS });
    assert.equal(withdrawalReady.kind, 'valid', '候选信号不应让订单伪装成终态，仅由 UI 选择暂停');
});

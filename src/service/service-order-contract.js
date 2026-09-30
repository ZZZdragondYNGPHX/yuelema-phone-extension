/**
 * 专属服务订单合同的唯一纯函数边界。
 *
 * UI 只提交不含 UID 的草稿；受控 builder 重读订单参与者后在这里生成 v2
 * 确认快照。投影层与写入层也共用同一解析器，避免“能显示、不能结单”的
 * 合同分叉。模块不读写 DOM、MVU、存储或网络。
 */

export const SERVICE_CONTRACT_VERSION = 2;
export const SERVICE_CONTRACT_MAX_LENGTH = 4200;
export const SERVICE_CONTRACT_TEXT_FIELDS = Object.freeze(['主题', '允许项', '排除项', '强度', '隐私处理']);
export const SERVICE_CONTRACT_ARRANGEMENT_FIELDS = Object.freeze(['时长', '时间窗', '场景类型', '组合摘要', '虚构价格']);
export const LEGACY_SERVICE_INFORMATION_FIELDS = Object.freeze(['价格', '时长', '排期', '套餐', '评价', '投诉', '退款', '服务者信用']);
export const SERVICE_OPEN_STATES = Object.freeze(['待确认', '进行中', '暂停中']);
export const SERVICE_TERMINAL_STATES = Object.freeze(['已完成', '已取消', '已中止']);

const MAX_PARTICIPANTS = 3;
const MAX_REVISION = 999999;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const EXPERIENCE_BY_MODE = Object.freeze({ SFW: '租借恋人', NSFW: '约炮' });
const LIFECYCLE_TEXT_LIMITS = Object.freeze({ 发起时间: 160, 开始时间: 160, 结束时间: 160, 结束摘要: 1600 });
const STORED_CONTRACT_FIELDS = Object.freeze([
    '协议版本', '修订号', '内容模式', '体验类型', ...SERVICE_CONTRACT_TEXT_FIELDS, '安排', '确认快照',
]);
const DRAFT_V2_FIELDS = Object.freeze([
    '协议版本', '修订号', '内容模式', '体验类型', ...SERVICE_CONTRACT_TEXT_FIELDS, '安排', '玩家已同意', 'NPC明确同意',
]);
const DRAFT_V1_FIELDS = Object.freeze([
    '内容模式', ...SERVICE_CONTRACT_TEXT_FIELDS, '服务信息', '玩家已同意', 'NPC明确同意',
]);

function ownRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, allowed) {
    return ownRecord(value) && Object.keys(value).every((key) => !RESERVED_KEYS.has(key) && allowed.includes(key));
}

function boundedText(value, maximum, { required = false } = {}) {
    if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001F\u007F]/u.test(value)) return null;
    const text = value.trim().replace(/\s+/gu, ' ');
    return required && !text ? null : text;
}

function validMode(mode) {
    return mode === 'SFW' || mode === 'NSFW';
}

function validParticipantUids(participantUids) {
    return Array.isArray(participantUids) && participantUids.length >= 1 && participantUids.length <= MAX_PARTICIPANTS
        && new Set(participantUids).size === participantUids.length
        && participantUids.every((uid) => typeof uid === 'string' && /^npc_[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(uid));
}

function frozenRecord(entries) {
    return Object.freeze(Object.fromEntries(entries));
}

function normalizeArrangement(source, mode) {
    if (!hasOnlyKeys(source, SERVICE_CONTRACT_ARRANGEMENT_FIELDS)) return null;
    const entries = [];
    for (const field of SERVICE_CONTRACT_ARRANGEMENT_FIELDS) {
        const limit = field === '虚构价格' ? 80 : 120;
        const text = boundedText(source[field] ?? '', limit);
        if (text === null) return null;
        if (mode === 'NSFW' && field === '虚构价格' && text) return null;
        entries.push([field, text]);
    }
    return frozenRecord(entries);
}

function arrangementFromLegacyInfo(source, mode) {
    if (!hasOnlyKeys(source, LEGACY_SERVICE_INFORMATION_FIELDS)) return null;
    const info = {};
    for (const field of LEGACY_SERVICE_INFORMATION_FIELDS) {
        const text = boundedText(source[field] ?? '', 120);
        if (text === null) return null;
        info[field] = text;
    }
    if (mode === 'NSFW' && ['价格', '评价', '投诉', '退款', '服务者信用'].some((field) => info[field])) return null;
    return normalizeArrangement({
        时长: info.时长,
        时间窗: info.排期,
        场景类型: '',
        组合摘要: info.套餐,
        虚构价格: mode === 'SFW' ? info.价格 : '',
    }, mode);
}

function normalizeDraftTextFields(value) {
    const result = [];
    for (const field of SERVICE_CONTRACT_TEXT_FIELDS) {
        const text = boundedText(value[field], 240, { required: true });
        if (text === null) return null;
        result.push([field, text]);
    }
    return result;
}

function validateConsentDraft(value, participantCount) {
    return value.玩家已同意 === true && Array.isArray(value.NPC明确同意)
        && value.NPC明确同意.length === participantCount && value.NPC明确同意.every((item) => item === true);
}

function reasonForDraft(value, { mode, participantUids, expectedRevision } = {}) {
    if (!ownRecord(value)) return '结构化合同必须是普通对象';
    if (!validMode(mode)) return '当前内容模式无效';
    if (!validParticipantUids(participantUids)) return '订单参与者列表无效';
    const isV2 = value.协议版本 === SERVICE_CONTRACT_VERSION;
    const allowed = isV2 ? DRAFT_V2_FIELDS : DRAFT_V1_FIELDS;
    const unknown = Object.keys(value).find((key) => RESERVED_KEYS.has(key) || !allowed.includes(key));
    if (unknown !== undefined) return `包含未允许的字段：${String(unknown).slice(0, 32)}`;
    if (value.内容模式 !== mode) return '字段 内容模式：与当前内容模式不一致';
    if (!validateConsentDraft(value, participantUids.length)) return '玩家与每位参与者必须逐人确认同一份合同';
    const textFields = normalizeDraftTextFields(value);
    if (!textFields) return '主题、允许项、排除项、强度与隐私处理均须为 1–240 字纯文本';
    if (isV2) {
        if (value.体验类型 !== EXPERIENCE_BY_MODE[mode]) return '字段 体验类型：与内容模式不一致';
        if (!Number.isInteger(value.修订号) || value.修订号 < 1 || value.修订号 > MAX_REVISION
            || (Number.isInteger(expectedRevision) && value.修订号 !== expectedRevision)) return '字段 修订号：与本次受控修订不一致';
        if (!normalizeArrangement(value.安排, mode)) return mode === 'NSFW'
            ? '字段 安排：NSFW 不允许价格或交易字段'
            : '字段 安排：结构、文本或长度无效';
    } else if (!arrangementFromLegacyInfo(value.服务信息 ?? {}, mode)) {
        return mode === 'NSFW' ? 'NSFW 邀约不得包含价格、评价、投诉、退款或服务者信用' : '旧版服务信息结构无效';
    }
    return '';
}

/**
 * 将不含 UID 的 UI 草稿转换为持久 v2 合同。UID 与修订号均由受控 builder 提供。
 */
export function serializeServiceContractDraft(value, { mode, participantUids, expectedRevision = 1 } = {}) {
    const reason = reasonForDraft(value, { mode, participantUids, expectedRevision });
    if (reason) return Object.freeze({ ok: false, reason });
    const isV2 = value.协议版本 === SERVICE_CONTRACT_VERSION;
    const arrangement = isV2 ? normalizeArrangement(value.安排, mode) : arrangementFromLegacyInfo(value.服务信息 ?? {}, mode);
    const revision = Number.isInteger(expectedRevision) ? expectedRevision : 1;
    const contract = Object.freeze({
        协议版本: SERVICE_CONTRACT_VERSION,
        修订号: revision,
        内容模式: mode,
        体验类型: EXPERIENCE_BY_MODE[mode],
        ...Object.fromEntries(normalizeDraftTextFields(value)),
        安排: arrangement,
        确认快照: Object.freeze({
            玩家: Object.freeze({ 状态: '已同意', 修订号: revision }),
            角色: Object.freeze(participantUids.map((角色UID) => Object.freeze({ 角色UID, 状态: '已同意', 修订号: revision }))),
        }),
    });
    const serialized = JSON.stringify(contract);
    if (serialized.length > SERVICE_CONTRACT_MAX_LENGTH) return Object.freeze({ ok: false, reason: '序列化后的合同总长度超限' });
    return Object.freeze({ ok: true, serialized, contract });
}

function normalizeStoredV2(value, { mode, participantUids } = {}) {
    if (!hasOnlyKeys(value, STORED_CONTRACT_FIELDS) || value.协议版本 !== SERVICE_CONTRACT_VERSION
        || !Number.isInteger(value.修订号) || value.修订号 < 1 || value.修订号 > MAX_REVISION
        || value.内容模式 !== mode || value.体验类型 !== EXPERIENCE_BY_MODE[mode]) return null;
    const textFields = normalizeDraftTextFields(value);
    const arrangement = normalizeArrangement(value.安排, mode);
    const snapshot = value.确认快照;
    if (!textFields || !arrangement || !hasOnlyKeys(snapshot, ['玩家', '角色'])
        || !hasOnlyKeys(snapshot.玩家, ['状态', '修订号']) || snapshot.玩家.状态 !== '已同意'
        || snapshot.玩家.修订号 !== value.修订号 || !Array.isArray(snapshot.角色)
        || snapshot.角色.length !== participantUids.length) return null;
    for (let index = 0; index < participantUids.length; index += 1) {
        const consent = snapshot.角色[index];
        if (!hasOnlyKeys(consent, ['角色UID', '状态', '修订号']) || consent.角色UID !== participantUids[index]
            || consent.状态 !== '已同意' || consent.修订号 !== value.修订号) return null;
    }
    return Object.freeze({
        协议版本: SERVICE_CONTRACT_VERSION,
        修订号: value.修订号,
        内容模式: mode,
        体验类型: EXPERIENCE_BY_MODE[mode],
        ...Object.fromEntries(textFields),
        安排: arrangement,
        确认快照: Object.freeze({
            玩家: Object.freeze({ 状态: '已同意', 修订号: value.修订号 }),
            角色: Object.freeze(snapshot.角色.map((item) => Object.freeze({ ...item }))),
        }),
    });
}

function normalizeStoredV1(value, { mode, participantUids } = {}) {
    if (!hasOnlyKeys(value, DRAFT_V1_FIELDS) || value.内容模式 !== mode || !validateConsentDraft(value, participantUids.length)) return null;
    const textFields = normalizeDraftTextFields(value);
    const serviceInfo = arrangementFromLegacyInfo(value.服务信息 ?? {}, mode);
    if (!textFields || !serviceInfo) return null;
    return Object.freeze({
        内容模式: mode,
        ...Object.fromEntries(textFields),
        服务信息: serviceInfo,
        玩家已同意: true,
        NPC明确同意: Object.freeze(Array(participantUids.length).fill(true)),
    });
}

/**
 * 解析持久合同并给出明确健康度：valid(v2)、legacy(v1/旧文本)、invalid 或 empty。
 * 返回值只供受控逻辑和安全摘要使用；UI 不得渲染 serialized/raw。
 */
export function parseServiceContract(serialized, { mode, participantUids } = {}) {
    if (serialized === '') return Object.freeze({ status: 'empty', version: 0, contract: null, reason: '' });
    if (!validMode(mode) || !validParticipantUids(participantUids) || typeof serialized !== 'string'
        || serialized.length > SERVICE_CONTRACT_MAX_LENGTH || /[\u0000-\u001F\u007F]/u.test(serialized)) {
        return Object.freeze({ status: 'invalid', version: 0, contract: null, reason: '合同文本、模式或参与者无效' });
    }
    let parsed;
    try { parsed = JSON.parse(serialized); }
    catch {
        return Object.freeze({ status: 'legacy', version: 0, contract: null, reason: '旧版纯文本合同必须重新协商并逐人确认' });
    }
    const v2 = normalizeStoredV2(parsed, { mode, participantUids });
    if (v2) return Object.freeze({ status: 'valid', version: SERVICE_CONTRACT_VERSION, contract: v2, reason: '' });
    const v1 = normalizeStoredV1(parsed, { mode, participantUids });
    if (v1) return Object.freeze({ status: 'legacy', version: 1, contract: v1, reason: 'v1 合同须建立新修订并逐人重新确认' });
    return Object.freeze({ status: 'invalid', version: 0, contract: null, reason: '合同结构、模式、参与者或确认快照不一致' });
}

export function nextServiceContractRevision(serialized, options) {
    const parsed = parseServiceContract(serialized, options);
    if (parsed.status === 'valid') return parsed.contract.修订号 < MAX_REVISION ? parsed.contract.修订号 + 1 : null;
    return parsed.status === 'legacy' || parsed.status === 'empty' ? 1 : null;
}

/** Rebuilds the UID-free confirmation draft used only for exact patch validation. */
export function restoreServiceContractDraft(serialized, options) {
    const parsed = parseServiceContract(serialized, options);
    if (parsed.status !== 'valid' || !parsed.contract) return null;
    const contract = parsed.contract;
    return {
        协议版本: SERVICE_CONTRACT_VERSION,
        修订号: contract.修订号,
        内容模式: contract.内容模式,
        体验类型: contract.体验类型,
        ...Object.fromEntries(SERVICE_CONTRACT_TEXT_FIELDS.map((field) => [field, contract[field]])),
        安排: { ...contract.安排 },
        玩家已同意: contract.确认快照.玩家.状态 === '已同意',
        NPC明确同意: contract.确认快照.角色.map((item) => item.状态 === '已同意'),
    };
}

/** 创建不含 UID 的 UI 草稿。 */
export function createServiceContractDraft({ mode, participantCount, topic = '', revision = 1 } = {}) {
    const count = Number.isInteger(participantCount) ? Math.min(MAX_PARTICIPANTS, Math.max(1, participantCount)) : 1;
    const valid = validMode(mode) ? mode : 'SFW';
    return {
        协议版本: SERVICE_CONTRACT_VERSION,
        修订号: Number.isInteger(revision) && revision >= 1 && revision <= MAX_REVISION ? revision : 1,
        内容模式: valid,
        体验类型: EXPERIENCE_BY_MODE[valid],
        主题: boundedText(topic, 240) || '',
        允许项: valid === 'NSFW' ? '仅限本次逐人明确同意的内容' : '由双方在正文中确认的约会内容',
        排除项: '未明确同意、已撤回或无法确认的内容',
        强度: valid === 'NSFW' ? '由每位参与者当次协商' : '轻松、尊重且可随时调整',
        隐私处理: '仅保留最小化终态摘要，不记录完整过程',
        安排: { 时长: '', 时间窗: '', 场景类型: '', 组合摘要: '', 虚构价格: '' },
        玩家已同意: false,
        NPC明确同意: Array(count).fill(false),
    };
}

export function projectServiceContractSummary(parsed) {
    if (!parsed || (parsed.status !== 'valid' && parsed.status !== 'legacy') || !parsed.contract) return null;
    const contract = parsed.contract;
    const arrangement = parsed.version === SERVICE_CONTRACT_VERSION ? contract.安排 : contract.服务信息;
    return Object.freeze({
        health: parsed.status,
        version: parsed.version,
        revision: parsed.version === SERVICE_CONTRACT_VERSION ? contract.修订号 : 0,
        experienceType: parsed.version === SERVICE_CONTRACT_VERSION ? contract.体验类型 : EXPERIENCE_BY_MODE[contract.内容模式],
        topic: boundedText(contract.主题, 240) || '',
        allowed: boundedText(contract.允许项, 240) || '',
        excluded: boundedText(contract.排除项, 240) || '',
        intensity: boundedText(contract.强度, 240) || '',
        privacy: boundedText(contract.隐私处理, 240) || '',
        arrangement: Object.freeze({
            duration: boundedText(arrangement?.时长, 120) || '',
            window: boundedText(arrangement?.时间窗 ?? arrangement?.排期, 120) || '',
            scene: boundedText(arrangement?.场景类型, 120) || '',
            combination: boundedText(arrangement?.组合摘要 ?? arrangement?.套餐, 120) || '',
            fictionalPrice: contract.内容模式 === 'SFW' ? (boundedText(arrangement?.虚构价格 ?? arrangement?.价格, 80) || '') : '',
        }),
    });
}

export function createEmptyServiceSignal(flagKey = '已满足') {
    return Object.freeze({ [flagKey]: false, 摘要: '', 记录时间: '' });
}

export function isValidServiceSignal(value, { flagKey = '已满足', required = true } = {}) {
    if (value === undefined) return !required;
    if (!hasOnlyKeys(value, [flagKey, '摘要', '记录时间']) || typeof value[flagKey] !== 'boolean') return false;
    const summary = boundedText(value.摘要, 600);
    const time = boundedText(value.记录时间, 160);
    if (summary === null || time === null) return false;
    return value[flagKey] ? Boolean(summary && time) : summary === '' && time === '';
}

export function isEmptyServiceSignal(value, { flagKey = '已满足' } = {}) {
    return isValidServiceSignal(value, { flagKey, required: true }) && value[flagKey] === false;
}

/**
 * 服务订单生命周期的共享分类器。角色成年、分类和 canonical topic 仍由调用层校验。
 * recoverable 表示可以安全终止/升级，但不得当成可继续或可结单的正常订单。
 */
export function classifyServiceOrderLifecycle(raw, { mode, participantUids } = {}) {
    if (!ownRecord(raw) || !validMode(mode) || !validParticipantUids(participantUids)
        || ![...SERVICE_OPEN_STATES, ...SERVICE_TERMINAL_STATES].includes(raw.状态)) {
        return Object.freeze({ kind: 'invalid', contractStatus: 'invalid', contract: null, reason: '订单基础结构无效' });
    }
    for (const [field, maximum] of Object.entries(LIFECYCLE_TEXT_LIMITS)) {
        if (boundedText(raw[field], maximum) === null) return Object.freeze({ kind: 'invalid', contractStatus: 'invalid', contract: null, reason: `字段 ${field} 无效` });
    }
    if (typeof raw.已确认边界 !== 'string' || raw.已确认边界.length > SERVICE_CONTRACT_MAX_LENGTH) {
        return Object.freeze({ kind: 'invalid', contractStatus: 'invalid', contract: null, reason: '字段 已确认边界 无效' });
    }
    const completionMissing = raw.合法结束条件 === undefined;
    const completionValid = completionMissing || isValidServiceSignal(raw.合法结束条件, { flagKey: '已满足', required: true });
    const withdrawalValid = isValidServiceSignal(raw.撤回候选, { flagKey: '已提出', required: false });
    const initiated = Boolean(boundedText(raw.发起时间, 160, { required: true }));
    const started = Boolean(boundedText(raw.开始时间, 160, { required: true }));
    const ended = Boolean(boundedText(raw.结束时间, 160, { required: true }));
    const summary = Boolean(boundedText(raw.结束摘要, 1600, { required: true }));
    const contract = parseServiceContract(raw.已确认边界, { mode, participantUids });
    if (!initiated) return Object.freeze({ kind: 'invalid', contractStatus: contract.status, contract, reason: '缺少发起时间' });
    if (raw.状态 === '待确认') {
        return !started && !ended && !summary && contract.status === 'empty'
            && (completionMissing || isEmptyServiceSignal(raw.合法结束条件)) && withdrawalValid
            ? Object.freeze({ kind: 'valid', contractStatus: 'empty', contract, reason: '' })
            : Object.freeze({ kind: 'invalid', contractStatus: contract.status, contract, reason: '待确认订单含不应存在的开始、终态或合同数据' });
    }
    if (raw.状态 === '进行中' || raw.状态 === '暂停中') {
        if (!started || ended || summary || contract.status === 'empty') return Object.freeze({ kind: 'invalid', contractStatus: contract.status, contract, reason: '开放订单的开始、终态或合同字段不一致' });
        return contract.status === 'valid' && !completionMissing && completionValid && withdrawalValid
            ? Object.freeze({ kind: 'valid', contractStatus: 'valid', contract, reason: '' })
            : Object.freeze({
                kind: 'recoverable', contractStatus: contract.status, contract,
                reason: !completionValid || !withdrawalValid ? '正文候选信号需要安全重置'
                    : completionMissing ? '旧订单缺少正文完成候选字段' : contract.reason,
            });
    }
    if (raw.状态 === '已取消') {
        const pendingCancellation = !started && ended && summary && contract.status === 'empty';
        const legacyStartedCancellation = started && ended && summary && contract.status !== 'empty';
        if (!pendingCancellation && !legacyStartedCancellation) {
            return Object.freeze({ kind: 'invalid', contractStatus: contract.status, contract, reason: '取消终态字段不一致' });
        }
        const valid = pendingCancellation && completionValid && withdrawalValid;
        return Object.freeze({
            kind: valid ? 'valid' : 'recoverable', contractStatus: contract.status, contract,
            reason: valid ? '' : '旧版已取消记录可归档，但不可继续执行',
        });
    }
    const terminalStarted = started && ended && summary && contract.status !== 'empty';
    if (!terminalStarted) return Object.freeze({ kind: 'invalid', contractStatus: contract.status, contract, reason: '完成或中止终态字段不一致' });
    return Object.freeze({
        kind: contract.status === 'valid' && !completionMissing && completionValid && withdrawalValid ? 'valid' : 'recoverable',
        contractStatus: contract.status,
        contract,
        reason: !completionValid || !withdrawalValid ? '正文候选信号需要安全重置'
            : completionMissing ? '旧订单缺少正文完成候选字段' : (contract.status === 'valid' ? '' : contract.reason),
    });
}

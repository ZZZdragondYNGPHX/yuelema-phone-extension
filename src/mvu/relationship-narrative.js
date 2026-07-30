import { isPlainRecord } from './json-pointer.js';

export const RELATIONSHIP_NARRATIVE_VERSION = 1;

const ROOT_FIELDS = Object.freeze(['版本', '人生底色', '未竟心愿', '进程']);
const LIFE_TONE_FIELDS = Object.freeze(['公开轮廓', '生活痕迹', '关键经历', '完整理解']);
const UNFINISHED_WISH_FIELDS = Object.freeze(['表层愿望', '真实需要', '起源摘要', '防御方式', '线索节点', '变化轨迹']);
const PROGRESS_FIELDS = Object.freeze([
    'SFW细微裂缝已触发', 'SFW朋友分享已触发', 'SFW面基已解锁',
    'SFW理解已检查', 'SFW心动已解锁', 'SFW双轨结局已解锁',
    'NSFW爱情阶段30已触发', 'NSFW爱情阶段40已触发',
    'NSFW共识亲密阶段30已触发', 'NSFW共识亲密阶段40已触发',
    'NSFW方向确认可用', 'NSFW路线锁定', '冻结关系值',
    '最后结算回合UID', '已消费事件ID', '边界暂停状态', '关系结束状态',
]);
const BOOLEAN_PROGRESS_FIELDS = Object.freeze([
    'SFW细微裂缝已触发', 'SFW朋友分享已触发', 'SFW面基已解锁',
    'SFW理解已检查', 'SFW心动已解锁', 'SFW双轨结局已解锁',
    'NSFW爱情阶段30已触发', 'NSFW爱情阶段40已触发',
    'NSFW共识亲密阶段30已触发', 'NSFW共识亲密阶段40已触发',
    'NSFW方向确认可用',
]);
const WISH_TRAJECTORY_VALUES = new Set(['未设置', '褪色', '压抑', '摇摆', '坚持', '重燃', '重定义', '已和解']);
const NSFW_ROUTE_VALUES = new Set(['', '爱情', '共识亲密', '暂不定义']);
const FROZEN_RELATIONSHIP_VALUES = new Set(['', '友情值', '心动值', '欲望值']);
const BOUNDARY_PAUSE_VALUES = new Set(['', '暂停', '仅SFW', '已拉黑', '已归档']);
const RELATIONSHIP_END_VALUES = new Set(['', '深度朋友', '恋人', '共识亲密', '各自成长', '结束联系', '已归档', '已删除']);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const CONTROL_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

function exactOwnDataRecord(value, fields) {
    if (!isPlainRecord(value)) return false;
    try {
        const names = Object.getOwnPropertyNames(value);
        if (names.length !== fields.length || Object.getOwnPropertySymbols(value).length !== 0) return false;
        for (const field of fields) {
            if (!Object.hasOwn(value, field)) return false;
            const descriptor = Object.getOwnPropertyDescriptor(value, field);
            if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
        }
        return names.every((name) => fields.includes(name));
    } catch {
        return false;
    }
}

function ownDataValue(record, field) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(record, field);
        return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    } catch {
        return undefined;
    }
}

function boundedText(value, maxLength) {
    return typeof value === 'string' && value.length <= maxLength && !CONTROL_TEXT.test(value);
}

function boundedOpaqueId(value, { optional = false, maxLength = 160 } = {}) {
    return typeof value === 'string' && (optional && value === '' || value.length <= maxLength && OPAQUE_ID_PATTERN.test(value));
}

function safeStringList(value, { maxItems, maxItemLength, requireOpaqueIds = false }) {
    if (!Array.isArray(value) || value.length > maxItems) return false;
    try {
        const names = Object.getOwnPropertyNames(value);
        if (names.length !== value.length + 1 || !names.includes('length') || Object.getOwnPropertySymbols(value).length !== 0) return false;
        const seen = new Set();
        for (let index = 0; index < value.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
            const item = descriptor.value;
            if (requireOpaqueIds ? !boundedOpaqueId(item, { maxLength: maxItemLength }) : !boundedText(item, maxItemLength)) return false;
            if (seen.has(item)) return false;
            seen.add(item);
        }
        return names.every((name) => name === 'length' || /^(0|[1-9]\d*)$/u.test(name) && Number(name) < value.length);
    } catch {
        return false;
    }
}

/** Returns a fresh, minimal narrative record for exactly one formal role UID. */
export function createEmptyRelationshipNarrative() {
    return {
        版本: RELATIONSHIP_NARRATIVE_VERSION,
        人生底色: { 公开轮廓: '', 生活痕迹: [], 关键经历: '', 完整理解: '' },
        未竟心愿: { 表层愿望: '', 真实需要: '', 起源摘要: '', 防御方式: '', 线索节点: [], 变化轨迹: '未设置' },
        进程: {
            SFW细微裂缝已触发: false,
            SFW朋友分享已触发: false,
            SFW面基已解锁: false,
            SFW理解已检查: false,
            SFW心动已解锁: false,
            SFW双轨结局已解锁: false,
            NSFW爱情阶段30已触发: false,
            NSFW爱情阶段40已触发: false,
            NSFW共识亲密阶段30已触发: false,
            NSFW共识亲密阶段40已触发: false,
            NSFW方向确认可用: false,
            NSFW路线锁定: '',
            冻结关系值: '',
            最后结算回合UID: '',
            已消费事件ID: [],
            边界暂停状态: '',
            关系结束状态: '',
        },
    };
}

/**
 * Validates only the protected, per-role narrative contract. It deliberately
 * neither normalizes nor repairs values: a caller must fail closed rather than
 * erase or reinterpret narrative state it does not understand.
 */
export function validateRelationshipNarrative(value) {
    if (!exactOwnDataRecord(value, ROOT_FIELDS) || ownDataValue(value, '版本') !== RELATIONSHIP_NARRATIVE_VERSION) {
        return { ok: false, code: 'relationship_narrative_invalid' };
    }
    const lifeTone = ownDataValue(value, '人生底色');
    const wish = ownDataValue(value, '未竟心愿');
    const progress = ownDataValue(value, '进程');
    if (!exactOwnDataRecord(lifeTone, LIFE_TONE_FIELDS)
        || !boundedText(ownDataValue(lifeTone, '公开轮廓'), 240)
        || !safeStringList(ownDataValue(lifeTone, '生活痕迹'), { maxItems: 5, maxItemLength: 160 })
        || !boundedText(ownDataValue(lifeTone, '关键经历'), 600)
        || !boundedText(ownDataValue(lifeTone, '完整理解'), 800)) {
        return { ok: false, code: 'relationship_narrative_invalid' };
    }
    if (!exactOwnDataRecord(wish, UNFINISHED_WISH_FIELDS)
        || !boundedText(ownDataValue(wish, '表层愿望'), 240)
        || !boundedText(ownDataValue(wish, '真实需要'), 320)
        || !boundedText(ownDataValue(wish, '起源摘要'), 600)
        || !boundedText(ownDataValue(wish, '防御方式'), 240)
        || !safeStringList(ownDataValue(wish, '线索节点'), { maxItems: 5, maxItemLength: 160 })
        || !WISH_TRAJECTORY_VALUES.has(ownDataValue(wish, '变化轨迹'))) {
        return { ok: false, code: 'relationship_narrative_invalid' };
    }
    if (!exactOwnDataRecord(progress, PROGRESS_FIELDS)
        || BOOLEAN_PROGRESS_FIELDS.some((field) => typeof ownDataValue(progress, field) !== 'boolean')
        || !NSFW_ROUTE_VALUES.has(ownDataValue(progress, 'NSFW路线锁定'))
        || !FROZEN_RELATIONSHIP_VALUES.has(ownDataValue(progress, '冻结关系值'))
        || !boundedOpaqueId(ownDataValue(progress, '最后结算回合UID'), { optional: true })
        || !safeStringList(ownDataValue(progress, '已消费事件ID'), { maxItems: 64, maxItemLength: 80, requireOpaqueIds: true })
        || !BOUNDARY_PAUSE_VALUES.has(ownDataValue(progress, '边界暂停状态'))
        || !RELATIONSHIP_END_VALUES.has(ownDataValue(progress, '关系结束状态'))) {
        return { ok: false, code: 'relationship_narrative_invalid' };
    }
    return { ok: true, value };
}

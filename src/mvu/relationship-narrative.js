import { isPlainRecord } from './json-pointer.js';

export const RELATIONSHIP_NARRATIVE_VERSION = 1;

const ROOT_FIELDS = Object.freeze(['版本', '人生底色', '未竟心愿', '进程']);
const LIFE_TONE_FIELDS = Object.freeze(['公开轮廓', '生活痕迹', '关键经历', '完整理解']);
const UNFINISHED_WISH_FIELDS = Object.freeze(['表层愿望', '真实需要', '起源摘要', '防御方式', '线索节点', '变化轨迹']);
const PROGRESS_FIELDS = Object.freeze([
    'SFW细微裂缝已触发', 'SFW朋友分享已触发', 'SFW面基已解锁',
    'SFW理解已检查', 'SFW主动揭示已触发', 'SFW心动已解锁', 'SFW双轨结局已解锁',
    'NSFW爱情阶段30已触发', 'NSFW爱情阶段40已触发',
    'NSFW共识亲密阶段30已触发', 'NSFW共识亲密阶段40已触发',
    'NSFW方向确认可用', 'NSFW路线锁定', '冻结关系值',
    '最后结算回合UID', '已消费事件ID', '最近关系观察', '边界暂停状态', '关系结束状态',
]);
const LEGACY_PROGRESS_FIELDS = Object.freeze(PROGRESS_FIELDS.filter((field) => !['SFW主动揭示已触发', '最近关系观察'].includes(field)));
const BOOLEAN_PROGRESS_FIELDS = Object.freeze([
    'SFW细微裂缝已触发', 'SFW朋友分享已触发', 'SFW面基已解锁',
    'SFW理解已检查', 'SFW主动揭示已触发', 'SFW心动已解锁', 'SFW双轨结局已解锁',
    'NSFW爱情阶段30已触发', 'NSFW爱情阶段40已触发',
    'NSFW共识亲密阶段30已触发', 'NSFW共识亲密阶段40已触发',
    'NSFW方向确认可用',
]);
const WISH_TRAJECTORY_VALUES = new Set(['未设置', '褪色', '压抑', '摇摆', '坚持', '重燃', '重定义', '已和解']);
const NSFW_ROUTE_VALUES = new Set(['', '爱情', '共识亲密', '暂不定义']);
const FROZEN_RELATIONSHIP_VALUES = new Set(['', '友情值', '心动值', '欲望值']);
const BOUNDARY_PAUSE_VALUES = new Set(['', '暂停', '仅SFW', '已拉黑', '已归档']);
const RELATIONSHIP_END_VALUES = new Set(['', '深度朋友', '恋人', '共识亲密', '各自成长', '结束联系', '已归档', '已删除']);
export const RELATIONSHIP_OBSERVATION_VALUES = Object.freeze([
    '', '无变化', '关系靠近', '边界被尊重', '保持观望', '正文约定待兑现',
    '主动揭示', '理解已确认', '心愿同行', '关系受损', '安全降级', '结局确认',
]);
const RELATIONSHIP_OBSERVATIONS = new Set(RELATIONSHIP_OBSERVATION_VALUES);
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
            SFW主动揭示已触发: false,
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
            最近关系观察: '',
            边界暂停状态: '',
            关系结束状态: '',
        },
    };
}

function clippedText(value, maxLength) {
    if (typeof value !== 'string' || CONTROL_TEXT.test(value)) return '';
    return value.trim().slice(0, maxLength);
}

function uniqueTexts(values, maxItems = 5) {
    const result = [];
    for (const value of values) {
        const text = clippedText(value, 160);
        if (text && !result.includes(text)) result.push(text);
        if (result.length >= maxItems) break;
    }
    return result;
}

/**
 * Creates the protected SFW narrative from one already validated formal role.
 * It only rearranges authored profile facts; it never asks a model to invent a
 * secret, wish, threshold, UID, or path.
 */
export function createRelationshipNarrativeFromProfile(profile, { progress } = {}) {
    if (!isPlainRecord(profile)) return null;
    const publicProfile = isPlainRecord(ownDataValue(profile, '公开资料')) ? ownDataValue(profile, '公开资料') : {};
    const friendProfile = isPlainRecord(ownDataValue(profile, '仅好友资料')) ? ownDataValue(profile, '仅好友资料') : {};
    const hiddenProfile = isPlainRecord(ownDataValue(profile, '隐藏资料')) ? ownDataValue(profile, '隐藏资料') : {};

    const nickname = clippedText(ownDataValue(publicProfile, '昵称'), 80);
    const ageBand = clippedText(ownDataValue(publicProfile, '年龄段'), 32);
    const city = clippedText(ownDataValue(publicProfile, '城市'), 80);
    const bio = clippedText(ownDataValue(publicProfile, '简介'), 500);
    const seeking = clippedText(ownDataValue(publicProfile, '寻找意图'), 120);
    const boundary = clippedText(ownDataValue(friendProfile, '边界与偏好'), 800);
    const privateNote = clippedText(ownDataValue(hiddenProfile, '私人备注'), 1200);
    const tags = uniqueTexts([
        ...(Array.isArray(ownDataValue(publicProfile, '兴趣标签')) ? ownDataValue(publicProfile, '兴趣标签') : []),
        ...(Array.isArray(ownDataValue(publicProfile, '生活方式标签')) ? ownDataValue(publicProfile, '生活方式标签') : []),
        ...(Array.isArray(ownDataValue(publicProfile, '性格标签')) ? ownDataValue(publicProfile, '性格标签') : []),
        ...(Array.isArray(ownDataValue(publicProfile, '沟通风格标签')) ? ownDataValue(publicProfile, '沟通风格标签') : []),
    ]);
    const defensiveTags = uniqueTexts([
        ...(Array.isArray(ownDataValue(publicProfile, '沟通风格标签')) ? ownDataValue(publicProfile, '沟通风格标签') : []),
        ...(Array.isArray(ownDataValue(publicProfile, '性格标签')) ? ownDataValue(publicProfile, '性格标签') : []),
    ]);
    const base = createEmptyRelationshipNarrative();
    const suppliedProgress = progress === undefined ? base.进程 : progress;
    const normalizedProgress = exactOwnDataRecord(suppliedProgress, PROGRESS_FIELDS)
        ? { ...suppliedProgress, 已消费事件ID: [...suppliedProgress.已消费事件ID] }
        : exactOwnDataRecord(suppliedProgress, LEGACY_PROGRESS_FIELDS)
            ? { ...suppliedProgress, SFW主动揭示已触发: false, 最近关系观察: '' }
            : null;
    if (!normalizedProgress) return null;

    const narrative = {
        版本: RELATIONSHIP_NARRATIVE_VERSION,
        人生底色: {
            公开轮廓: clippedText([nickname, ageBand, city, bio].filter(Boolean).join('；'), 240),
            生活痕迹: tags,
            关键经历: clippedText(privateNote, 600),
            完整理解: clippedText([privateNote, boundary].filter(Boolean).join('；'), 800),
        },
        未竟心愿: {
            表层愿望: clippedText(seeking, 240),
            真实需要: clippedText(boundary, 320),
            起源摘要: clippedText(privateNote, 600),
            防御方式: clippedText(defensiveTags.join('、'), 240),
            线索节点: uniqueTexts([...tags, ...defensiveTags]),
            变化轨迹: privateNote ? '坚持' : '未设置',
        },
        进程: normalizedProgress,
    };
    return validateRelationshipNarrative(narrative).ok ? narrative : null;
}

export function isRelationshipNarrativeContentEmpty(value) {
    const validated = validateRelationshipNarrative(value);
    if (!validated.ok) return false;
    const life = value.人生底色;
    const wish = value.未竟心愿;
    return life.公开轮廓 === '' && life.生活痕迹.length === 0 && life.关键经历 === '' && life.完整理解 === ''
        && wish.表层愿望 === '' && wish.真实需要 === '' && wish.起源摘要 === ''
        && wish.防御方式 === '' && wish.线索节点.length === 0 && wish.变化轨迹 === '未设置';
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
    const legacyProgress = exactOwnDataRecord(progress, LEGACY_PROGRESS_FIELDS);
    if (!(legacyProgress || exactOwnDataRecord(progress, PROGRESS_FIELDS))
        || BOOLEAN_PROGRESS_FIELDS.some((field) => legacyProgress && field === 'SFW主动揭示已触发'
            ? false : typeof ownDataValue(progress, field) !== 'boolean')
        || !NSFW_ROUTE_VALUES.has(ownDataValue(progress, 'NSFW路线锁定'))
        || !FROZEN_RELATIONSHIP_VALUES.has(ownDataValue(progress, '冻结关系值'))
        || !boundedOpaqueId(ownDataValue(progress, '最后结算回合UID'), { optional: true })
        || !safeStringList(ownDataValue(progress, '已消费事件ID'), { maxItems: 64, maxItemLength: 80, requireOpaqueIds: true })
        || (!legacyProgress && !RELATIONSHIP_OBSERVATIONS.has(ownDataValue(progress, '最近关系观察')))
        || !BOUNDARY_PAUSE_VALUES.has(ownDataValue(progress, '边界暂停状态'))
        || !RELATIONSHIP_END_VALUES.has(ownDataValue(progress, '关系结束状态'))) {
        return { ok: false, code: 'relationship_narrative_invalid' };
    }
    return { ok: true, value };
}

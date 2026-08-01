import { parsePhoneTimestamp } from '../chat/phone-clock.js';

export const REALISTIC_CHAT_VERSION = 1;
export const MAX_REALISTIC_PLAYER_BURST_COUNT = 6;
export const MAX_REALISTIC_PLAYER_BURST_LENGTH = 600;
export const MAX_REALISTIC_PENDING_MESSAGES = 6;
export const REALISTIC_REPLY_QUIET_MINUTES = 10;
export const REALISTIC_FIRST_REPLY_MINUTES = Object.freeze({ min: 5, max: 30 });
export const REALISTIC_BETWEEN_REPLY_MINUTES = Object.freeze({ min: 5, max: 20 });
export const REALISTIC_PROACTIVE_MINUTES = Object.freeze({ min: 60, max: 360 });

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const HTML_PATTERN = /<!--|<\s*\/?\s*[a-z][^>]*>/iu;
const MESSAGE_UID_PATTERN = /^msg_chat_[A-Za-z0-9_-]{1,64}_[pns]_[1-9]\d{0,8}$/u;
const BATCH_UID_PATTERN = /^batch_chat_[A-Za-z0-9_-]{1,64}_(?:reply|proactive)_[A-Za-z0-9_-]{1,96}$/u;
const STATE_KEYS = Object.freeze([
    '版本', '启用', '最近处理玩家消息UID', '回复触发时间', '待回复同意修订号', '主动触发时间', '最近主动触发时间', '待投递消息',
]);
const PENDING_KEYS = Object.freeze(['消息UID', '发送者', '内容', '时间', '批次UID']);

function ownRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function exactOwnKeys(value, expected) {
    if (!ownRecord(value)) return false;
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length && keys.every((key) => typeof key === 'string' && expected.includes(key)
        && Object.prototype.propertyIsEnumerable.call(value, key)
        && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}

function safeText(value, maxLength, { allowEmpty = false } = {}) {
    return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= maxLength
        && value === value.trim() && !CONTROL_CHARACTER_PATTERN.test(value) && !HTML_PATTERN.test(value);
}

export function isPhoneScheduleTime(value, { allowEmpty = true } = {}) {
    return allowEmpty && value === '' ? true : parsePhoneTimestamp(value) !== null;
}

export function createDefaultRealisticChatState({ enabled = false, latestPlayerMessageUid = '', proactiveAt = '' } = {}) {
    return {
        版本: REALISTIC_CHAT_VERSION,
        启用: enabled === true,
        最近处理玩家消息UID: typeof latestPlayerMessageUid === 'string' && MESSAGE_UID_PATTERN.test(latestPlayerMessageUid) ? latestPlayerMessageUid : '',
        回复触发时间: '',
        待回复同意修订号: 0,
        主动触发时间: enabled === true && isPhoneScheduleTime(proactiveAt, { allowEmpty: false }) ? proactiveAt : '',
        最近主动触发时间: '',
        待投递消息: [],
    };
}

export function validatePendingRealisticMessage(value) {
    if (!exactOwnKeys(value, PENDING_KEYS)) return { ok: false, code: 'private_chat_realistic_pending_message_invalid' };
    if (!MESSAGE_UID_PATTERN.test(value.消息UID) || !['角色', '系统'].includes(value.发送者)
        || !safeText(value.内容, 1200) || !isPhoneScheduleTime(value.时间, { allowEmpty: false })
        || !BATCH_UID_PATTERN.test(value.批次UID)) {
        return { ok: false, code: 'private_chat_realistic_pending_message_invalid' };
    }
    return { ok: true, value: Object.freeze({ ...value }) };
}

export function validateRealisticChatState(value) {
    if (!exactOwnKeys(value, STATE_KEYS) || value.版本 !== REALISTIC_CHAT_VERSION || typeof value.启用 !== 'boolean'
        || !safeText(value.最近处理玩家消息UID, 80, { allowEmpty: true })
        || (value.最近处理玩家消息UID && !MESSAGE_UID_PATTERN.test(value.最近处理玩家消息UID))
        || !isPhoneScheduleTime(value.回复触发时间) || !isPhoneScheduleTime(value.主动触发时间)
        || !Number.isInteger(value.待回复同意修订号) || value.待回复同意修订号 < 0 || value.待回复同意修订号 > 999999
        || (!value.回复触发时间 && value.待回复同意修订号 !== 0)
        || !isPhoneScheduleTime(value.最近主动触发时间)
        || !Array.isArray(value.待投递消息) || Object.getPrototypeOf(value.待投递消息) !== Array.prototype
        || value.待投递消息.length > MAX_REALISTIC_PENDING_MESSAGES) {
        return { ok: false, code: 'private_chat_realistic_schema_outdated' };
    }
    const messages = [];
    const uids = new Set();
    let previousTime = '';
    for (const pending of value.待投递消息) {
        const normalized = validatePendingRealisticMessage(pending);
        if (!normalized.ok || uids.has(normalized.value.消息UID)
            || (previousTime && normalized.value.时间 < previousTime)) {
            return { ok: false, code: 'private_chat_realistic_schema_outdated' };
        }
        uids.add(normalized.value.消息UID);
        previousTime = normalized.value.时间;
        messages.push(normalized.value);
    }
    if (!value.启用 && (value.回复触发时间 || value.待回复同意修订号 !== 0 || value.主动触发时间 || messages.length)) {
        return { ok: false, code: 'private_chat_realistic_schema_outdated' };
    }
    return {
        ok: true,
        value: Object.freeze({
            版本: value.版本,
            启用: value.启用,
            最近处理玩家消息UID: value.最近处理玩家消息UID,
            回复触发时间: value.回复触发时间,
            待回复同意修订号: value.待回复同意修订号,
            主动触发时间: value.主动触发时间,
            最近主动触发时间: value.最近主动触发时间,
            待投递消息: Object.freeze(messages),
        }),
    };
}

export function latestPlayerMessageUid(session) {
    const messages = Array.isArray(session?.最近消息) ? session.最近消息 : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (ownRecord(message) && message.发送者 === '玩家' && typeof message.消息UID === 'string' && MESSAGE_UID_PATTERN.test(message.消息UID)) {
            return message.消息UID;
        }
    }
    return '';
}

export function listPendingRealisticPlayerMessages(session) {
    const realistic = validateRealisticChatState(session?.拟真聊天);
    if (!realistic.ok) return realistic;
    if (!realistic.value.启用) return { ok: false, code: 'private_chat_realistic_disabled' };
    const recent = Array.isArray(session?.最近消息) ? session.最近消息 : null;
    if (!recent) return { ok: false, code: 'private_chat_session_messages_invalid' };
    const marker = realistic.value.最近处理玩家消息UID;
    const markerIndex = marker ? recent.findIndex((message) => ownRecord(message) && message.消息UID === marker) : -1;
    if (marker && markerIndex < 0) return { ok: false, code: 'private_chat_realistic_marker_missing' };
    const pending = [];
    let totalLength = 0;
    for (const message of recent.slice(markerIndex + 1)) {
        if (!ownRecord(message) || message.发送者 !== '玩家') continue;
        if (!MESSAGE_UID_PATTERN.test(message.消息UID) || !safeText(message.内容, 600)) {
            return { ok: false, code: 'private_chat_realistic_player_message_invalid' };
        }
        pending.push(Object.freeze({
            messageUid: message.消息UID,
            content: message.内容,
            time: typeof message.时间 === 'string' && isPhoneScheduleTime(message.时间, { allowEmpty: false }) ? message.时间 : '',
        }));
        totalLength += message.内容.length;
    }
    if (pending.length > MAX_REALISTIC_PLAYER_BURST_COUNT) return { ok: false, code: 'private_chat_realistic_player_burst_full' };
    if (totalLength + Math.max(0, pending.length - 1) > MAX_REALISTIC_PLAYER_BURST_LENGTH) {
        return { ok: false, code: 'private_chat_realistic_player_burst_too_long' };
    }
    return { ok: true, value: Object.freeze(pending) };
}

export function projectRealisticChatState(value) {
    const normalized = validateRealisticChatState(value);
    if (!normalized.ok) return Object.freeze({ supported: false, enabled: false, pendingCount: 0, nextDeliveryAt: '', replyDueAt: '', proactiveDueAt: '' });
    const state = normalized.value;
    return Object.freeze({
        supported: true,
        enabled: state.启用,
        pendingCount: state.待投递消息.length,
        nextDeliveryAt: state.待投递消息[0]?.时间 ?? '',
        replyDueAt: state.回复触发时间,
        proactiveDueAt: state.主动触发时间,
    });
}

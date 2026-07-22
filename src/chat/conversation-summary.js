/**
 * Private-chat conversation-summary contract.
 *
 * This module is deliberately pure: it has no DOM, storage, network, MVU, or
 * prompt access.  Both the LLM boundary and controlled Patch boundary use the
 * same bounded projections so a summary can never move an arbitrary path or
 * retain unbounded raw transcript data.
 */

export const MAX_CHAT_HISTORY_MESSAGES = 240;
export const MAX_CHAT_SUMMARY_RECORDS = 64;
export const MAX_CHAT_SUMMARY_LENGTH = 2_400;
export const MAX_CHAT_SUMMARY_FAILURE_LENGTH = 240;
export const MIN_CHAT_SUMMARY_INTERVAL = 2;
export const MAX_CHAT_SUMMARY_INTERVAL = 60;
export const MAX_CHAT_SUMMARY_RETRIES = 5;

export const DEFAULT_CHAT_SUMMARY_SETTINGS = Object.freeze({
    enabled: false,
    interval: 20,
    retryLimit: 2,
});

const SENDERS = new Set(['玩家', '角色', '系统']);
const SUMMARY_STATES = new Set(['空闲', '成功', '失败']);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const HTML_PATTERN = /<\s*\/?\s*[a-z][^>]*>/iu;
const SENSITIVE_TEXT_PATTERN = /(?:api[\s_-]*key|authorization|bearer|token|secret|password|credential|密钥|令牌|密码|授权|凭据|https?:\/\/)/iu;

function ownRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function safeText(value, maxLength) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (!text || text.length > maxLength || CONTROL_CHARACTER_PATTERN.test(text) || HTML_PATTERN.test(text)) return '';
    return text;
}

function safeInteger(value, fallback = 0) {
    return Number.isInteger(value) && value >= 0 && value <= 999_999 ? value : fallback;
}

/** Normalizes the browser-local automatic-summary configuration. */
export function normalizeChatSummarySettings(value) {
    if (!ownRecord(value) || Object.keys(value).some((key) => !['enabled', 'interval', 'retryLimit'].includes(key))) return null;
    if (typeof value.enabled !== 'boolean') return null;
    if (!Number.isInteger(value.interval) || value.interval < MIN_CHAT_SUMMARY_INTERVAL || value.interval > MAX_CHAT_SUMMARY_INTERVAL) return null;
    if (!Number.isInteger(value.retryLimit) || value.retryLimit < 0 || value.retryLimit > MAX_CHAT_SUMMARY_RETRIES) return null;
    return Object.freeze({ enabled: value.enabled, interval: value.interval, retryLimit: value.retryLimit });
}

function normalizeMessage(raw, fallbackLayer) {
    if (!ownRecord(raw) || !SENDERS.has(raw.发送者)) return null;
    const uid = safeText(raw.消息UID, 80);
    const content = safeText(raw.内容, 600);
    if (!uid || !content) return null;
    const layer = safeInteger(raw.层数, fallbackLayer);
    return Object.freeze({ uid, sender: raw.发送者, content, layer });
}

/** Returns a bounded, chronological, UI/LLM-safe message projection. */
export function listConversationMessages(session) {
    const rawMessages = Array.isArray(session?.最近消息) ? session.最近消息.slice(-MAX_CHAT_HISTORY_MESSAGES) : [];
    const totalLayers = safeInteger(session?.对话层数, rawMessages.length);
    const layerOffset = Math.max(0, totalLayers - rawMessages.length);
    const messages = [];
    for (let index = 0; index < rawMessages.length; index += 1) {
        const normalized = normalizeMessage(rawMessages[index], layerOffset + index + 1);
        if (normalized) messages.push(normalized);
    }
    return Object.freeze(messages);
}

function normalizeSummaryRecord(raw) {
    if (!ownRecord(raw)) return null;
    const uid = safeText(raw.总结UID, 80);
    const startMessageUid = safeText(raw.起始消息UID, 80);
    const endMessageUid = safeText(raw.结束消息UID, 80);
    const content = safeText(raw.内容, MAX_CHAT_SUMMARY_LENGTH);
    const startLayer = safeInteger(raw.起始层数, 0);
    const endLayer = safeInteger(raw.结束层数, 0);
    if (!uid || !startMessageUid || !endMessageUid || !content || startLayer < 1 || endLayer < startLayer) return null;
    return Object.freeze({
        uid,
        startMessageUid,
        endMessageUid,
        startLayer,
        endLayer,
        content,
        time: safeText(raw.时间, 80),
    });
}

/** Projects only valid summary records; malformed persisted data is ignored. */
export function listConversationSummaryRecords(session) {
    const records = [];
    for (const raw of Array.isArray(session?.总结?.记录) ? session.总结.记录.slice(-MAX_CHAT_SUMMARY_RECORDS) : []) {
        const normalized = normalizeSummaryRecord(raw);
        if (normalized && !records.some((record) => record.uid === normalized.uid)) records.push(normalized);
    }
    return Object.freeze(records);
}

/** Returns a strict, bounded persisted summary state with legacy defaults. */
export function normalizeConversationSummaryState(session) {
    const source = ownRecord(session?.总结) ? session.总结 : {};
    const records = listConversationSummaryRecords(session);
    const status = SUMMARY_STATES.has(source.状态) ? source.状态 : '空闲';
    const failureReason = safeText(source.失败原因, MAX_CHAT_SUMMARY_FAILURE_LENGTH);
    return Object.freeze({
        records,
        lastMessageUid: safeText(source.已总结消息UID, 80),
        sequence: safeInteger(source.总结序号, records.length),
        status,
        failureReason: status === '失败' ? (failureReason || '总结未完成，请稍后重试。') : '',
        targetSummaryUid: safeText(source.目标总结UID, 80),
        attempts: safeInteger(source.尝试次数, 0),
    });
}

/** Messages after the last successfully summarized message are the only pending context. */
export function listUnsummarizedConversationMessages(session) {
    const messages = listConversationMessages(session);
    const marker = normalizeConversationSummaryState(session).lastMessageUid;
    if (!marker) return messages;
    const markerIndex = messages.map((message) => message.uid).lastIndexOf(marker);
    // If the visible history window has rolled past the marker, every retained
    // message is newer and still needs a summary.
    return Object.freeze(markerIndex < 0 ? [...messages] : messages.slice(markerIndex + 1));
}

/** Counts only player/character utterance layers; fixed system notices stay in the source text but do not advance the configured interval. */
export function countUnsummarizedConversationLayers(session) {
    return listUnsummarizedConversationMessages(session).filter((message) => message.sender === '玩家' || message.sender === '角色').length;
}

/** Gets the retained raw source for re-summarizing one historical record. */
export function summaryRecordSource(session, summaryUid) {
    const uid = safeText(summaryUid, 80);
    if (!uid) return { ok: false, code: 'chat_summary_record_invalid' };
    const record = listConversationSummaryRecords(session).find((item) => item.uid === uid);
    if (!record) return { ok: false, code: 'chat_summary_record_not_found' };
    const messages = listConversationMessages(session);
    const start = messages.findIndex((message) => message.uid === record.startMessageUid);
    const end = messages.findIndex((message) => message.uid === record.endMessageUid);
    if (start < 0 || end < start) return { ok: false, code: 'chat_summary_source_expired' };
    return { ok: true, record, messages: Object.freeze(messages.slice(start, end + 1)) };
}

/** A summary becomes eligible only after the configured number of message layers. */
export function isConversationSummaryDue(session, interval) {
    return Number.isInteger(interval)
        && interval >= MIN_CHAT_SUMMARY_INTERVAL
        && interval <= MAX_CHAT_SUMMARY_INTERVAL
        && countUnsummarizedConversationLayers(session) >= interval;
}

/** Prevents a model-generated summary from introducing unsafe markup or secrets into MVU/UI. */
export function normalizeGeneratedConversationSummary(raw) {
    if (!ownRecord(raw) || Object.keys(raw).some((key) => key !== 'summary')) return null;
    const summary = safeText(raw.summary, MAX_CHAT_SUMMARY_LENGTH);
    if (!summary || SENSITIVE_TEXT_PATTERN.test(summary)) return null;
    return summary;
}

/** Public, bounded failure text that is safe to persist and show in the summary UI. */
export function normalizeConversationSummaryFailure(value) {
    const message = safeText(value, MAX_CHAT_SUMMARY_FAILURE_LENGTH);
    return message && !SENSITIVE_TEXT_PATTERN.test(message)
        ? message
        : '总结未完成，请稍后重试。';
}

/** LLM context strips all internal IDs/layers while retaining chronological speaker attribution. */
export function projectConversationMessagesForLlm(messages) {
    return Object.freeze((Array.isArray(messages) ? messages : []).map((message) => Object.freeze({
        sender: message.sender,
        content: message.content,
    })));
}

/** LLM context projects records without their internal UID anchors. */
export function projectConversationSummaryRecordsForLlm(records) {
    return Object.freeze((Array.isArray(records) ? records : []).map((record) => Object.freeze({
        range: `第${record.startLayer}-${record.endLayer}层`,
        content: record.content,
    })));
}

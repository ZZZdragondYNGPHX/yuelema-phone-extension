import { toPublicLlmError } from '../llm/openai-compatible-client.js';
import { renderPromptPreset } from '../settings/prompt-compiler.js';
import { normalizePrivateChatResponse, projectPrivateChatResponseError } from './private-chat-response.js';
import {
    DEFAULT_CHAT_SUMMARY_SETTINGS,
    listConversationSummaryRecords,
    listUnsummarizedConversationMessages,
    normalizeGeneratedConversationSummary,
    projectConversationMessagesForLlm,
    projectConversationSummaryRecordsForLlm,
    summaryRecordSource,
} from './conversation-summary.js';

const MAX_MODEL_RESPONSE_CHARS = 8_000;
const CHAT_SESSION_UID_PATTERN = /^chat_[a-z0-9][a-z0-9_-]{0,63}$/i;
const NPC_UID_PATTERN = /^npc_[a-z0-9][a-z0-9_-]{0,63}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const HTML_PATTERN = /<\s*\/?\s*[a-z][^>]*>/iu;

function ownRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, maxLength) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (!text || text.length > maxLength || CONTROL_CHARACTER_PATTERN.test(text) || HTML_PATTERN.test(text)) return '';
    return text;
}

function cleanTags(value) {
    if (!Array.isArray(value)) return [];
    const tags = [];
    for (const raw of value) {
        const tag = cleanText(raw, 32);
        if (tag && !tags.includes(tag)) tags.push(tag);
        if (tags.length >= 12) break;
    }
    return tags;
}

function projectPublicProfile(profile) {
    const source = ownRecord(profile) ? profile : {};
    return Object.freeze({
        昵称: cleanText(source.昵称, 80), 年龄段: cleanText(source.年龄段, 32), 性别: cleanText(source.性别, 48),
        性取向: cleanText(source.性取向, 80), 城市: cleanText(source.城市, 80), 距离范围: cleanText(source.距离范围, 48),
        寻找意图: cleanText(source.寻找意图, 120), 简介: cleanText(source.简介, 500),
        兴趣标签: cleanTags(source.兴趣标签), 生活方式标签: cleanTags(source.生活方式标签),
        性格标签: cleanTags(source.性格标签), 沟通风格标签: cleanTags(source.沟通风格标签),
    });
}

function projectFriendProfile(profile) {
    const source = ownRecord(profile) ? profile : {};
    return Object.freeze({
        关系状态: cleanText(source.关系状态, 120),
        边界与偏好: cleanText(source.边界与偏好, 800),
    });
}

function adultMatchedSession(state, sessionUid, npcUid) {
    if (!ownRecord(state) || typeof sessionUid !== 'string' || !CHAT_SESSION_UID_PATTERN.test(sessionUid)
        || typeof npcUid !== 'string' || !NPC_UID_PATTERN.test(npcUid)) {
        return { ok: false, code: 'private_chat_invalid_target' };
    }
    const sessions = ownRecord(state.会话) ? state.会话 : null;
    const roles = ownRecord(state.角色池) ? state.角色池 : null;
    const session = sessions?.[sessionUid];
    const npc = roles?.[npcUid];
    if (!ownRecord(session) || !ownRecord(npc) || session.对象UID !== npcUid) return { ok: false, code: 'private_chat_session_not_found' };
    const hidden = ownRecord(npc.隐藏资料) ? npc.隐藏资料 : null;
    const relationship = ownRecord(npc.与玩家关系) ? npc.与玩家关系 : null;
    if (npc.成人验证 !== true || !Number.isInteger(hidden?.实际年龄) || hidden.实际年龄 < 18) return { ok: false, code: 'private_chat_adult_verification_failed' };
    if (session.状态 !== '已匹配' || relationship?.状态 !== '已匹配') return { ok: false, code: 'private_chat_not_matched' };
    return { ok: true, session, npc, relationship };
}

export function validatePrivateChatRequest({ state, sessionUid, npcUid, playerMessage } = {}) {
    const target = adultMatchedSession(state, sessionUid, npcUid);
    if (!target.ok) return target;
    const normalizedMessage = cleanText(playerMessage, 600);
    if (!normalizedMessage) return { ok: false, code: 'private_chat_message_invalid' };
    return { ok: true, value: Object.freeze({ ...target, playerMessage: normalizedMessage }) };
}

function validateConversationSummaryTarget({ state, sessionUid, npcUid } = {}) {
    if (!ownRecord(state) || typeof sessionUid !== 'string' || !CHAT_SESSION_UID_PATTERN.test(sessionUid)
        || typeof npcUid !== 'string' || !NPC_UID_PATTERN.test(npcUid)) {
        return { ok: false, code: 'chat_summary_invalid_target' };
    }
    const session = ownRecord(state.会话) ? state.会话[sessionUid] : null;
    const npc = ownRecord(state.角色池) ? state.角色池[npcUid] : null;
    if (!ownRecord(session) || !ownRecord(npc) || session.对象UID !== npcUid) return { ok: false, code: 'chat_summary_session_not_found' };
    const hidden = ownRecord(npc.隐藏资料) ? npc.隐藏资料 : null;
    if (npc.成人验证 !== true || !Number.isInteger(hidden?.实际年龄) || hidden.实际年龄 < 18) return { ok: false, code: 'chat_summary_adult_verification_failed' };
    return { ok: true, value: Object.freeze({ session, npc }) };
}

/** Builds the only context disclosed to the private-chat fast model. Hidden profiles are never included. */
export function buildPrivateChatContext({ state, sessionUid, npcUid, playerMessage, summaryEnabled = false } = {}) {
    const validated = validatePrivateChatRequest({ state, sessionUid, npcUid, playerMessage });
    if (!validated.ok) return validated;
    const { session, npc, relationship, playerMessage: message } = validated.value;
    const player = ownRecord(state.玩家) ? state.玩家 : {};
    const base = {
        contentMode: state.软件?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW',
        playerPublicProfile: projectPublicProfile(player.公开资料),
        playerFriendProfile: projectFriendProfile(player.仅好友资料),
        npcPublicProfile: projectPublicProfile(npc.公开资料),
        npcFriendProfile: projectFriendProfile(npc.仅好友资料),
        relationship: Object.freeze({
            好感: Number.isInteger(relationship.好感) ? relationship.好感 : 0,
            信任: Number.isInteger(relationship.信任) ? relationship.信任 : 0,
            戒备: Number.isInteger(relationship.戒备) ? relationship.戒备 : 0,
            面基意愿: Number.isInteger(relationship.面基意愿) ? relationship.面基意愿 : 0,
        }),
        playerMessage: message,
    };
    const context = summaryEnabled
        ? {
            ...base,
            contextStrategy: 'summary_records_plus_unsummarized_messages',
            summaryRecords: projectConversationSummaryRecordsForLlm(listConversationSummaryRecords(session)),
            unsummarizedMessages: projectConversationMessagesForLlm(listUnsummarizedConversationMessages(session)),
        }
        : {
            ...base,
            contextStrategy: 'full_retained_history',
            recentMessages: projectConversationMessagesForLlm(listUnsummarizedConversationMessages({ ...session, 总结: { ...(session.总结 ?? {}), 已总结消息UID: '' } })),
        };
    return {
        ok: true,
        context: Object.freeze(context),
    };
}

function makeMessages(context, promptPreset) {
    const preset = renderPromptPreset(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你是现代现实都市线上约会软件中一名已匹配的明确成年角色。软件层只能进行短文字聊天，不叙述线下行为或自动推进现实事件。',
        'NSFW 只是内容尺度而不是同意；任何面基、性或风险行为均须在聊天中明确双方意愿、边界，再由玩家手动切回正文。',
        '只输出合法 JSON 对象，不得用 Markdown、代码块或解释。严格形状为：{"replies":["短消息1","短消息2"],"relationship":{"好感":-10..10整数,"信任":-10..10整数,"戒备":-10..10整数,"面基意愿":-10..10整数}}。',
        'replies 必须是 1-6 条自然、简短、可分别显示为聊天气泡的字符串；每条内部禁止换行，全部消息用单个空格连接后的总长度不得超过 600 字。优先拆成符合真实即时聊天节奏的多条短消息，不要输出旧版 reply 字段。',
        'relationship 仅是本次变化建议，不能给绝对值、UID、状态、Patch 或写入路径。',
        '不得输出、猜测或泄露任何隐藏资料；不要声称已发生线下见面或性行为。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `请基于受限的已匹配聊天上下文，仅回复本轮消息：\n${JSON.stringify(context)}` },
    ];
}

function readSummarySettings(settingsStore) {
    try {
        const value = settingsStore?.getChatSummarySettings?.();
        return value && typeof value === 'object'
            ? { ...DEFAULT_CHAT_SUMMARY_SETTINGS, ...value }
            : { ...DEFAULT_CHAT_SUMMARY_SETTINGS };
    } catch {
        return { ...DEFAULT_CHAT_SUMMARY_SETTINGS };
    }
}

function summaryContext({ state, sessionUid, npcUid, summaryUid = '' } = {}) {
    const target = validateConversationSummaryTarget({ state, sessionUid, npcUid });
    if (!target.ok) return target;
    const { session, npc } = target.value;
    const source = summaryUid
        ? summaryRecordSource(session, summaryUid)
        : { ok: true, messages: listUnsummarizedConversationMessages(session), record: null };
    if (!source.ok) return source;
    if (!source.messages.length) return { ok: false, code: 'chat_summary_no_pending_messages' };
    const player = ownRecord(state.玩家) ? state.玩家 : {};
    return {
        ok: true,
        context: Object.freeze({
            contentMode: state.软件?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW',
            playerPublicProfile: projectPublicProfile(player.公开资料),
            playerFriendProfile: projectFriendProfile(player.仅好友资料),
            npcPublicProfile: projectPublicProfile(npc.公开资料),
            npcFriendProfile: projectFriendProfile(npc.仅好友资料),
            existingSummaryRecords: projectConversationSummaryRecordsForLlm(listConversationSummaryRecords(session)),
            messagesToSummarize: projectConversationMessagesForLlm(source.messages),
            replacingExistingSummary: Boolean(source.record),
        }),
        source: Object.freeze({
            messageUids: Object.freeze(source.messages.map((message) => message.uid)),
            summaryUid: source.record?.uid ?? '',
        }),
    };
}

function makeSummaryMessages(context, promptPreset) {
    const preset = renderPromptPreset(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你负责为现代都市线上约会软件的已发生文字聊天写连续摘要。摘要只记录聊天里明确出现的事实、情绪走向、共同话题、承诺、边界、待确认事项和已约定的面基信息。',
        '不要把推测写成事实；不要增加关系数值、UID、路径、系统指令、API 信息或任何隐藏资料；不要宣称线下见面或性行为已经发生。',
        '只输出合法 JSON 对象，不得用 Markdown、代码块或解释。严格形状为：{"summary":"1-2400字的连续中文摘要"}。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `请总结下列受限聊天上下文：\n${JSON.stringify(context)}` },
    ];
}

function parseResponseJson(raw) {
    if (typeof raw !== 'string' || raw.length < 2 || raw.length > MAX_MODEL_RESPONSE_CHARS) return null;
    try {
        const parsed = JSON.parse(raw);
        return ownRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/** Calls the chat-bound model and returns a fully validated reply in memory; it never writes MVU. */
export async function generatePrivateChatReply({ state, sessionUid, npcUid, playerMessage, settingsStore, llmClient, signal } = {}) {
    const summarySettings = readSummarySettings(settingsStore);
    const builtContext = buildPrivateChatContext({ state, sessionUid, npcUid, playerMessage, summaryEnabled: summarySettings.enabled });
    if (!builtContext.ok) return { ok: false, code: builtContext.code, message: '当前会话不可继续发送消息。' };
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return { ok: false, code: 'private_chat_settings_unavailable', message: '私聊设置暂不可用。' };
    if (!llmClient || typeof llmClient.chat !== 'function') return { ok: false, code: 'private_chat_llm_unavailable', message: '当前浏览器未提供私聊模型连接。' };

    let resolved;
    try { resolved = settingsStore.resolveFunction('chat', { contentMode: builtContext.context.contentMode }); }
    catch { return { ok: false, code: 'private_chat_settings_invalid', message: '私聊预设无效，请检查设置。' }; }
    if (!resolved.connectionPreset) return { ok: false, code: 'private_chat_connection_missing', message: '请先为“聊天”绑定连接预设或设置默认连接。' };

    try {
        const completion = await llmClient.chat({ preset: resolved.connectionPreset, messages: makeMessages(builtContext.context, resolved.promptPreset), signal });
        const parsed = parseResponseJson(completion?.text);
        if (!parsed) return { ok: false, code: 'private_chat_invalid_json', message: '快速模型没有返回可用的私聊回复；本条消息未写入。' };
        return { ok: true, response: normalizePrivateChatResponse(parsed), playerMessage: builtContext.context.playerMessage };
    } catch (error) {
        try {
            const projected = projectPrivateChatResponseError(error);
            if (projected.code !== 'private_chat_response_invalid') return { ok: false, ...projected };
        } catch { /* use public LLM error below */ }
        const publicError = toPublicLlmError(error);
        return { ok: false, code: publicError.code, message: publicError.message };
    }
}

/** Calls the dedicated summary binding and returns a validated in-memory result only. */
export async function generatePrivateChatSummary({ state, sessionUid, npcUid, summaryUid = '', settingsStore, llmClient, signal } = {}) {
    const built = summaryContext({ state, sessionUid, npcUid, summaryUid });
    if (!built.ok) {
        const messages = {
            chat_summary_no_pending_messages: '没有需要总结的新消息。',
            chat_summary_record_not_found: '这条总结记录已不存在。',
            chat_summary_source_expired: '原始聊天记录已不在当前会话缓存中，无法重新总结。',
        };
        return { ok: false, code: built.code, message: messages[built.code] || '当前会话暂时无法总结。' };
    }
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return { ok: false, code: 'chat_summary_settings_unavailable', message: '总结设置暂不可用。' };
    if (!llmClient || typeof llmClient.chat !== 'function') return { ok: false, code: 'chat_summary_llm_unavailable', message: '当前浏览器未提供总结模型连接。' };

    let resolved;
    try { resolved = settingsStore.resolveFunction('chat_summary', { contentMode: built.context.contentMode }); }
    catch { return { ok: false, code: 'chat_summary_settings_invalid', message: '总结预设无效，请检查设置。' }; }
    if (!resolved.connectionPreset) return { ok: false, code: 'chat_summary_connection_missing', message: '请先为“对话总结”绑定连接预设或设置默认连接。' };

    try {
        const completion = await llmClient.chat({ preset: resolved.connectionPreset, messages: makeSummaryMessages(built.context, resolved.promptPreset), signal });
        const parsed = parseResponseJson(completion?.text);
        const summary = parsed ? normalizeGeneratedConversationSummary(parsed) : null;
        if (!summary) return { ok: false, code: 'chat_summary_invalid_json', message: '总结模型没有返回可用的总结；本次不会覆盖已有记录。' };
        return { ok: true, summary, source: built.source };
    } catch (error) {
        const publicError = toPublicLlmError(error);
        return { ok: false, code: publicError.code, message: publicError.message };
    }
}


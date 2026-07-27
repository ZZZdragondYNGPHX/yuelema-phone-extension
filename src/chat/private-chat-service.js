import { toPublicLlmError } from '../llm/openai-compatible-client.js';
import { renderPromptPreset } from '../settings/prompt-compiler.js';
import { normalizePrivateChatResponse, projectPrivateChatResponseDiagnostic, projectPrivateChatResponseError } from './private-chat-response.js';
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

/**
 * 控制台诊断带出通道（阶段 77 安全控制台接线）。
 *
 * action-bridge（唯一 MVU 写入边界，禁改）会把服务失败收窄为
 * `{ ok, status, code, message }`，丢弃其余字段；因此服务层在每次失败时把
 * 纯数据诊断记录暂存在这里，由持有台账 handle 的页面层通过
 * `consumePrivateChatDiagnostics` 一次性取走并经 buildErrorDetail 格式化进
 * 控制台 detail。总结的多次重试会按发生顺序追加多条记录。
 *
 * 调用方合同硬线：记录只含阶段/错误码/HTTP 状态/字段名/期望摘要等，
 * 绝不包含关系分数值、阈值数值、隐藏资料值、对话原文、提示词或凭据。
 */
const MAX_DIAGNOSTIC_TARGETS = 32;
const MAX_DIAGNOSTIC_RECORDS_PER_TARGET = 6;
const MAX_DIAGNOSTIC_TEXT_LENGTH = 300;
const diagnosticsByTarget = new Map();

function diagnosticText(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    return text.length > MAX_DIAGNOSTIC_TEXT_LENGTH ? `${text.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH)}…` : text;
}

/**
 * 控制台脱敏器会把 ≥32 字符的连续 [A-Za-z0-9+/=_-] token 视作疑似凭据并替换
 * 为 [已脱敏]；超长错误码改用空格分词形式呈现，信息不丢也不触发误脱敏。
 */
function presentDiagnosticCode(code) {
    const text = diagnosticText(typeof code === 'string' ? code : '');
    if (!text) return '';
    return text.length >= 32 ? text.split('_').join(' ') : text;
}

/** 把任意异常收敛成 buildErrorDetail 可直接消费的纯数据错误摘要。 */
function describeDiagnosticError(error) {
    if (!error || typeof error !== 'object') return null;
    const record = {};
    const name = diagnosticText(error.name);
    const message = diagnosticText(error.message);
    if (name) record.name = name;
    if (message) record.message = message;
    const code = presentDiagnosticCode(typeof error.code === 'string' ? error.code : '');
    if (code) record.code = code;
    const status = [error.status, error.statusCode, error.httpStatus].find((value) => Number.isInteger(value));
    if (status !== undefined) record.status = status;
    return Object.keys(record).length ? record : null;
}

/** 共享 LLM 客户端若带出响应片段（bodyExcerpt），折叠为“实际”摘要；缺失时优雅降级。 */
function llmErrorActual(error) {
    const excerpt = diagnosticText(error && typeof error === 'object' && typeof error.bodyExcerpt === 'string' ? error.bodyExcerpt : '');
    return excerpt ? `响应片段：${excerpt}` : undefined;
}

function recordDiagnostic(kind, targetUid, record) {
    const key = `${String(kind)}|${String(targetUid ?? '')}`;
    if (!diagnosticsByTarget.has(key)) {
        if (diagnosticsByTarget.size >= MAX_DIAGNOSTIC_TARGETS) {
            const oldest = diagnosticsByTarget.keys().next().value;
            diagnosticsByTarget.delete(oldest);
        }
        diagnosticsByTarget.set(key, []);
    }
    const records = diagnosticsByTarget.get(key);
    if (records.length >= MAX_DIAGNOSTIC_RECORDS_PER_TARGET) records.shift();
    const normalized = {};
    for (const [field, value] of [
        ['stage', diagnosticText(record.stage)],
        ['code', presentDiagnosticCode(record.code)],
        ['field', diagnosticText(record.field)],
        ['expected', diagnosticText(record.expected)],
        ['actual', diagnosticText(record.actual)],
        ['hint', diagnosticText(record.hint)],
    ]) {
        if (value) normalized[field] = value;
    }
    normalized.error = record.error && typeof record.error === 'object' ? Object.freeze({ ...record.error }) : null;
    records.push(Object.freeze(normalized));
}

/**
 * 页面层（唯一持有台账 handle 的调用层）一次性取走并清空指定目标的诊断记录。
 * kind 为 'private_chat' 或 'chat_summary'；返回冻结数组，可能为空。
 */
export function consumePrivateChatDiagnostics(kind, targetUid) {
    const key = `${String(kind)}|${String(targetUid ?? '')}`;
    const records = diagnosticsByTarget.get(key) ?? [];
    diagnosticsByTarget.delete(key);
    return Object.freeze([...records]);
}

/** 模型响应无法按 JSON 解析时的“实际”摘要：只报长度/类型，绝不带响应原文。 */
function describeUnparsableResponse(raw) {
    if (typeof raw !== 'string') return '非文本响应';
    if (!raw.length) return '空响应';
    return `响应长度 ${raw.length} 字符（非合法 JSON 对象或超出 ${MAX_MODEL_RESPONSE_CHARS} 字符上限）`;
}
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
            友情值: Number.isInteger(relationship.友情值) ? relationship.友情值 : 0,
            心动值: Number.isInteger(relationship.心动值) ? relationship.心动值 : 0,
            欲望值: Number.isInteger(relationship.欲望值) ? relationship.欲望值 : 0,
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
        context.contentMode === 'NSFW'
            ? '当前为 NSFW：允许明确成年角色在自愿、边界清楚的前提下直白调情、讨论欲望并进行露骨线上文爱；这仍不能伪造成现实线下身体行为已经发生，也不能替代面基和现实行动的明确同意。已匹配和成人验证不是无限授权，但当玩家的成人话题尊重已知边界，或先明确征询并获得持续同意时，直白或露骨本身不是冒犯：应自然继续线上成人聊天，不得仅因内容成人化降低好感或信任、提高戒备，或推动已读不回/拉黑。只有明确的拒绝或撤回同意、已知边界冲突、胁迫、非自愿、隐私侵犯等具体安全问题才能给出负向关系变化；同意或边界不清时应先用线上文字澄清，关系变化保持为零。'
            : '当前为 SFW：本模式保持日常社交尺度，以自然亲近、甜蜜调情的线上聊天为主。',
        '只输出合法 JSON 对象，不得用 Markdown、代码块或解释。严格形状为：{"replies":["短消息1","短消息2"],"relationship":{"好感":-10..10整数,"信任":-10..10整数,"戒备":-10..10整数,"面基意愿":-10..10整数},"bondAssessment":{"kind":"模式允许的分类","intensity":0..3整数},"imageDirectives":[{"replyIndex":0,"directive":{"kind":"share_photo|selfie|scene_snapshot|private_photo","scene":"English image tags"}}]}。imageDirectives 可省略。',
        'replies 必须是 1-6 条自然、简短、可分别显示为聊天气泡的字符串；每条内部禁止换行，全部消息用单个空格连接后的总长度不得超过 600 字。优先拆成符合真实即时聊天节奏的多条短消息。',
        '把角色当成有自己生活的真人来回：TA 有正在忙的事、今天的心情、想到一半突然换的话题；可以主动分享此刻的小事（刚点的外卖、窗外的雨、循环的歌），也可以用公开资料里的兴趣自然抛出新话题引子（周末计划、最近看的剧、想去的店），而不是永远被动应答；语气、口头禅和标点习惯要贴合其性格标签与沟通风格标签。',
        'playerPublicProfile 会提供玩家已公开的城市、距离范围、寻找意图、简介、兴趣标签、生活方式标签、性格标签和沟通风格标签。字段为空字符串或空数组时，表示玩家未提供该项：不得猜测、补全或编造；仅在与本轮聊天自然相关时使用非空公开资料。',
        '仅当本次内容确实值得以照片分享，且角色性格有分享欲、当前关系与边界允许时，才输出对应 replyIndex 的 imageDirectives。私照必须更严格判断亲密度、信任与自愿边界；不得机械地为每轮或每条回复生图。不需要时省略该字段。scene 只能是描述画面的英文标签，不得包含角色 UID、URL、JSONPatch、完整正负提示词、core_dna、outfit_dna 或凭据。',
        'relationship 仅用于既有互动节奏建议。bondAssessment 必须同时判断玩家本轮消息与角色实际回复：SFW 只允许 none/friendly/romantic_flirt；NSFW 只允许 none/romantic_desire/sexual_desire。none 的 intensity 必须为 0，其余为 1-3。模型不得给友情值、心动值、欲望值的绝对值或增量，也不得给 UID、状态、阈值、Patch、JSON Pointer 或写入路径。',
        '玩家与角色的公开资料就是本轮唯一已知档案：城市、距离范围、寻找意图、简介及四类标签均可作为自然聊天线索。空字符串或空标签数组只表示该项尚未提供；不得臆测、补全或假称这些缺失资料。',
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
        '在准确的前提下保留这段聊天的温度：让人心动或破防的具体瞬间、彼此专属的称呼和玩笑、各自的语气习惯，都值得原样记下来，这些是这段关系继续时的记忆锚点；但压缩客套与重复，摘要读起来应像认真替两个人保管回忆，而不是冷冰冰的会议纪要。',
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
    if (!builtContext.ok) {
        recordDiagnostic('private_chat', sessionUid, { stage: '请求校验', code: builtContext.code, hint: '会话/角色状态或玩家消息未通过发送前校验' });
        return { ok: false, code: builtContext.code, message: '当前会话不可继续发送消息。' };
    }
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') {
        recordDiagnostic('private_chat', sessionUid, { stage: '设置读取', code: 'private_chat_settings_unavailable', hint: '设置存储不可用，无法解析“聊天”功能绑定' });
        return { ok: false, code: 'private_chat_settings_unavailable', message: '私聊设置暂不可用。' };
    }
    if (!llmClient || typeof llmClient.chat !== 'function') {
        recordDiagnostic('private_chat', sessionUid, { stage: '连接检查', code: 'private_chat_llm_unavailable', hint: '浏览器侧未注入可用的模型客户端' });
        return { ok: false, code: 'private_chat_llm_unavailable', message: '当前浏览器未提供私聊模型连接。' };
    }

    let resolved;
    try { resolved = settingsStore.resolveFunction('chat', { contentMode: builtContext.context.contentMode }); }
    catch (error) {
        recordDiagnostic('private_chat', sessionUid, { stage: '设置解析', code: 'private_chat_settings_invalid', error: describeDiagnosticError(error), hint: '“聊天”功能绑定解析抛出异常' });
        return { ok: false, code: 'private_chat_settings_invalid', message: '私聊预设无效，请检查设置。' };
    }
    if (!resolved.connectionPreset) {
        recordDiagnostic('private_chat', sessionUid, { stage: '连接检查', code: 'private_chat_connection_missing', field: 'chat', hint: '“聊天”功能未绑定连接预设，也没有默认连接' });
        return { ok: false, code: 'private_chat_connection_missing', message: '请先为“聊天”绑定连接预设或设置默认连接。' };
    }

    try {
        const completion = await llmClient.chat({ preset: resolved.connectionPreset, messages: makeMessages(builtContext.context, resolved.promptPreset), signal });
        const parsed = parseResponseJson(completion?.text);
        if (!parsed) {
            recordDiagnostic('private_chat', sessionUid, { stage: '响应解析', code: 'private_chat_invalid_json', expected: '合法 JSON 对象', actual: describeUnparsableResponse(completion?.text) });
            return { ok: false, code: 'private_chat_invalid_json', message: '快速模型没有返回可用的私聊回复；本条消息未写入。' };
        }
        return { ok: true, response: normalizePrivateChatResponse(parsed, { contentMode: builtContext.context.contentMode }), playerMessage: builtContext.context.playerMessage };
    } catch (error) {
        const codecDiagnostic = projectPrivateChatResponseDiagnostic(error);
        if (codecDiagnostic) recordDiagnostic('private_chat', sessionUid, { stage: '响应校验', ...codecDiagnostic });
        else recordDiagnostic('private_chat', sessionUid, { stage: '模型请求', code: toPublicLlmError(error).code, error: describeDiagnosticError(error), actual: llmErrorActual(error) });
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
        // 无待总结消息/记录不存在属于静默跳过路径，不产生失败诊断噪音。
        if (!['chat_summary_no_pending_messages', 'chat_summary_record_not_found'].includes(built.code)) {
            recordDiagnostic('chat_summary', sessionUid, { stage: '请求校验', code: built.code, hint: '总结目标会话/记录未通过校验' });
        }
        return { ok: false, code: built.code, message: messages[built.code] || '当前会话暂时无法总结。' };
    }
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') {
        recordDiagnostic('chat_summary', sessionUid, { stage: '设置读取', code: 'chat_summary_settings_unavailable', hint: '设置存储不可用，无法解析“对话总结”功能绑定' });
        return { ok: false, code: 'chat_summary_settings_unavailable', message: '总结设置暂不可用。' };
    }
    if (!llmClient || typeof llmClient.chat !== 'function') {
        recordDiagnostic('chat_summary', sessionUid, { stage: '连接检查', code: 'chat_summary_llm_unavailable', hint: '浏览器侧未注入可用的模型客户端' });
        return { ok: false, code: 'chat_summary_llm_unavailable', message: '当前浏览器未提供总结模型连接。' };
    }

    let resolved;
    try { resolved = settingsStore.resolveFunction('chat_summary', { contentMode: built.context.contentMode }); }
    catch (error) {
        recordDiagnostic('chat_summary', sessionUid, { stage: '设置解析', code: 'chat_summary_settings_invalid', error: describeDiagnosticError(error), hint: '“对话总结”功能绑定解析抛出异常' });
        return { ok: false, code: 'chat_summary_settings_invalid', message: '总结预设无效，请检查设置。' };
    }
    if (!resolved.connectionPreset) {
        recordDiagnostic('chat_summary', sessionUid, { stage: '连接检查', code: 'chat_summary_connection_missing', field: 'chat_summary', hint: '“对话总结”功能未绑定连接预设，也没有默认连接' });
        return { ok: false, code: 'chat_summary_connection_missing', message: '请先为“对话总结”绑定连接预设或设置默认连接。' };
    }

    try {
        const completion = await llmClient.chat({ preset: resolved.connectionPreset, messages: makeSummaryMessages(built.context, resolved.promptPreset), signal });
        const parsed = parseResponseJson(completion?.text);
        const summary = parsed ? normalizeGeneratedConversationSummary(parsed) : null;
        if (!summary) {
            recordDiagnostic('chat_summary', sessionUid, parsed
                ? { stage: '响应校验', code: 'chat_summary_invalid_json', field: 'summary', expected: '仅含 summary 单字段、1-2400 字安全纯文本' }
                : { stage: '响应解析', code: 'chat_summary_invalid_json', expected: '合法 JSON 对象', actual: describeUnparsableResponse(completion?.text) });
            return { ok: false, code: 'chat_summary_invalid_json', message: '总结模型没有返回可用的总结；本次不会覆盖已有记录。' };
        }
        return { ok: true, summary, source: built.source };
    } catch (error) {
        const publicError = toPublicLlmError(error);
        recordDiagnostic('chat_summary', sessionUid, { stage: '模型请求', code: publicError.code, error: describeDiagnosticError(error), actual: llmErrorActual(error) });
        return { ok: false, code: publicError.code, message: publicError.message };
    }
}

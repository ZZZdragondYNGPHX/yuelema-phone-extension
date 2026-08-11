import { toPublicLlmError } from '../llm/openai-compatible-client.js';
import { renderPromptPreset } from '../settings/prompt-compiler.js';
import { normalizePrivateChatResponse, normalizeRealisticPrivateChatResponse, projectPrivateChatResponseDiagnostic, projectPrivateChatResponseError } from './private-chat-response.js';
import { projectPendingBodyRelationshipCandidate, selectPendingBodyRelationshipCandidate } from '../mvu/body-relationship-candidate.js';
import { validateRelationshipNarrative } from '../mvu/relationship-narrative.js';
import { deriveRelationshipSafetyState } from './relationship-progress.js';
import { isActiveNsfwConsent, nsfwConsentReference, validateNsfwConsent } from '../mvu/nsfw-consent.js';
import { listPendingRealisticPlayerMessages, validateRealisticChatState } from '../mvu/realistic-chat.js';
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
const MAX_STORY_MEMORY_LENGTH = 1_600;

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

function projectStoryMemoryContext(state, currentNpcUid) {
    const roles = ownRecord(state.角色池) ? state.角色池 : {};
    const memories = ownRecord(state.正文记忆) ? state.正文记忆 : {};
    const others = [];
    for (const [uid, role] of Object.entries(roles)) {
        if (uid === currentNpcUid || !NPC_UID_PATTERN.test(uid) || !ownRecord(role) || role.成人验证 !== true) continue;
        const hidden = ownRecord(role.隐藏资料) ? role.隐藏资料 : null;
        if (!Number.isInteger(hidden?.实际年龄) || hidden.实际年龄 < 18) continue;
        const memory = cleanText(memories[uid], MAX_STORY_MEMORY_LENGTH);
        if (!memory) continue;
        others.push(Object.freeze({
            objectLabel: `其他对象${others.length + 1}`,
            nickname: cleanText(role.公开资料?.昵称, 80) || '未命名对象',
            memory,
        }));
    }
    return Object.freeze({
        currentObjectMemory: cleanText(memories[currentNpcUid], MAX_STORY_MEMORY_LENGTH),
        otherObjectMemories: Object.freeze(others),
    });
}

const SFW_MEETUP_EVENT_LIBRARY = Object.freeze([
    '日常验证', '旧地重返', '技能共作', '社交压力', '心愿试运行',
]);

function projectSfwNarrativeContext(narrative, relationship) {
    const progress = narrative.进程;
    const friendship = Number.isInteger(relationship?.友情值) ? relationship.友情值 : 0;
    const relationshipResolved = ['深度朋友', '恋人', '各自成长'].includes(progress.关系结束状态);
    const context = {
        stage: 'ordinary',
        eventLibrary: SFW_MEETUP_EVENT_LIBRARY,
        availableDisclosure: Object.freeze({}),
        insightRequired: 'none',
        resolutionAvailable: progress.SFW双轨结局已解锁 === true && !relationshipResolved,
    };
    if (relationshipResolved) {
        context.stage = 'settled';
        return Object.freeze(context);
    }
    if (progress.SFW双轨结局已解锁 === true) {
        context.stage = 'resolution';
        context.availableDisclosure = Object.freeze({
            表层愿望: narrative.未竟心愿.表层愿望,
            真实需要: narrative.未竟心愿.真实需要,
            变化轨迹: narrative.未竟心愿.变化轨迹,
        });
        return Object.freeze(context);
    }
    if (progress.SFW心动已解锁 === true) {
        context.stage = progress.SFW主动揭示已触发 === true ? 'delayed_dual' : 'direct_heart';
        context.availableDisclosure = Object.freeze({
            完整理解: narrative.人生底色.完整理解,
            表层愿望: narrative.未竟心愿.表层愿望,
            真实需要: narrative.未竟心愿.真实需要,
            防御方式: narrative.未竟心愿.防御方式,
        });
        return Object.freeze(context);
    }
    if (progress.SFW理解已检查 === true) {
        context.stage = progress.SFW主动揭示已触发 === true ? 'awaiting_support' : 'awaiting_active_reveal';
        context.insightRequired = progress.SFW主动揭示已触发 === true ? 'post_reveal_support' : 'active_reveal';
        context.availableDisclosure = Object.freeze({
            线索节点: narrative.未竟心愿.线索节点.slice(0, 2),
            关键经历: narrative.人生底色.关键经历,
            表层愿望: narrative.未竟心愿.表层愿望,
        });
        return Object.freeze(context);
    }
    if (friendship >= 59) {
        context.stage = 'understanding_check';
        context.insightRequired = 'direct_understanding_or_not_yet';
        context.availableDisclosure = Object.freeze({
            完整理解: narrative.人生底色.完整理解,
            表层愿望: narrative.未竟心愿.表层愿望,
            真实需要: narrative.未竟心愿.真实需要,
        });
    } else if (friendship >= 39) {
        context.stage = 'friend_share';
        context.availableDisclosure = Object.freeze({ 关键经历: narrative.人生底色.关键经历 });
    } else if (friendship >= 19) {
        context.stage = 'subtle_crack';
        context.availableDisclosure = Object.freeze({ 生活痕迹: narrative.人生底色.生活痕迹.slice(0, 1) });
    }
    return Object.freeze(context);
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
    if (!ownRecord(state.玩家) || state.玩家.成人验证 !== true) return { ok: false, code: 'private_chat_player_adult_verification_failed' };
    const storyMemories = ownRecord(state.正文记忆) ? state.正文记忆 : null;
    if (!storyMemories || !Object.hasOwn(storyMemories, npcUid) || typeof storyMemories[npcUid] !== 'string') {
        return { ok: false, code: 'private_chat_story_memory_schema_outdated' };
    }
    const hidden = ownRecord(npc.隐藏资料) ? npc.隐藏资料 : null;
    const relationship = ownRecord(npc.与玩家关系) ? npc.与玩家关系 : null;
    if (npc.成人验证 !== true || !Number.isInteger(hidden?.实际年龄) || hidden.实际年龄 < 18) return { ok: false, code: 'private_chat_adult_verification_failed' };
    if (session.状态 !== '已匹配' || relationship?.状态 !== '已匹配') return { ok: false, code: 'private_chat_not_matched' };
    const narratives = ownRecord(state.关系叙事) ? state.关系叙事 : null;
    const narrative = validateRelationshipNarrative(narratives?.[npcUid]);
    if (!narratives || !narrative.ok) return { ok: false, code: 'private_chat_relationship_narrative_schema_outdated' };
    const safety = deriveRelationshipSafetyState(narrative.value.进程);
    if (safety.ended) return { ok: false, code: 'private_chat_relationship_ended' };
    if (safety.paused) return { ok: false, code: 'private_chat_relationship_paused' };
    return { ok: true, session, npc, relationship, onlySfw: safety.onlySfw };
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

/** Builds the only context disclosed to the private-chat fast model. Raw hidden-profile objects are never included;
 * the SFW branch may include only the current role's stage-cropped protected narrative. */
function buildPrivateChatContextInternal({
    state,
    sessionUid,
    npcUid,
    playerMessage,
    turnConsentConfirmed = false,
    summaryEnabled = false,
    realisticTrigger = '',
    phoneTime = '',
} = {}) {
    const realistic = realisticTrigger === 'reply' || realisticTrigger === 'proactive';
    const target = realistic ? adultMatchedSession(state, sessionUid, npcUid) : null;
    if (target && !target.ok) return target;
    let realisticPlayerMessages = [];
    let combinedPlayerMessage = playerMessage;
    if (realistic) {
        const realisticState = validateRealisticChatState(target.session.拟真聊天);
        if (!realisticState.ok) return realisticState;
        if (!realisticState.value.启用) return { ok: false, code: 'private_chat_realistic_disabled' };
        if (realisticTrigger === 'reply') {
            const pending = listPendingRealisticPlayerMessages(target.session);
            if (!pending.ok) return pending;
            if (!pending.value.length) return { ok: false, code: 'private_chat_realistic_no_pending_player_messages' };
            realisticPlayerMessages = [...pending.value];
            combinedPlayerMessage = realisticPlayerMessages.map((message) => message.content).join(' ');
        } else {
            realisticPlayerMessages = [];
            combinedPlayerMessage = '';
        }
    }
    const validated = realistic
        ? { ok: true, value: Object.freeze({ ...target, playerMessage: combinedPlayerMessage }) }
        : validatePrivateChatRequest({ state, sessionUid, npcUid, playerMessage });
    if (!validated.ok) return validated;
    const { session, npc, relationship, onlySfw, playerMessage: message } = validated.value;
    const pendingBodyCandidate = selectPendingBodyRelationshipCandidate(state, npcUid);
    if (!pendingBodyCandidate.ok) return pendingBodyCandidate;
    const contentMode = state.软件?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW';
    const narrative = state.关系叙事[npcUid];
    const requiresNsfwConsent = contentMode === 'NSFW' && onlySfw !== true;
    let consentReference = null;
    let consentScopes = [];
    if (requiresNsfwConsent) {
        const consent = validateNsfwConsent(session.NSFW同意);
        if (!consent.ok) return { ok: false, code: 'private_chat_nsfw_consent_schema_outdated' };
        if (!isActiveNsfwConsent(consent.value)) return { ok: false, code: 'private_chat_nsfw_consent_required' };
        if (realisticTrigger !== 'proactive' && turnConsentConfirmed !== true) return { ok: false, code: 'private_chat_nsfw_turn_consent_required' };
        consentReference = nsfwConsentReference(consent.value);
        consentScopes = [...consent.value.允许范围];
    }
    const player = ownRecord(state.玩家) ? state.玩家 : {};
    const base = {
        contentMode,
        onlySfw: onlySfw === true,
        nsfwConsent: Object.freeze({
            active: requiresNsfwConsent,
            currentTurnConfirmed: requiresNsfwConsent && realisticTrigger !== 'proactive',
            scopes: Object.freeze(consentScopes),
        }),
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
        storyMemory: projectStoryMemoryContext(state, npcUid),
        playerMessage: message,
    };
    if (realistic) {
        const cueSeed = `${sessionUid}|${phoneTime}|${realisticTrigger}|${realisticPlayerMessages.map((item) => item.content).join('|')}`;
        let cueHash = 2166136261;
        for (const character of cueSeed) cueHash = Math.imul(cueHash ^ character.codePointAt(0), 16777619) >>> 0;
        const replyCues = [
            '偏向 1-2 条：先接住最值得回应的一点，再自然带出角色此刻自己的小事。',
            '偏向 2-4 条：允许玩家话题与角色的新话题并行，不必逐条回答。',
            '偏向 3-6 条短连发：像想到一半又补一句，但不要重复同一意思。',
            '偏向 1 条稍完整的消息；若当前确实不适合回应，也可自然沉默。',
            '偏向 0-2 条：可以只回应消息簇的一部分，把未回应部分留到以后。',
        ];
        const proactiveCues = [
            '偏向 1 条随手分享的生活切片，不要求玩家立刻回应。',
            '偏向 2-3 条短连发，用一个新鲜话题自然开场。',
            '偏向续起一条较早的话题，同时补充角色自己的近况。',
            '这次可以保持沉默；若发信，只发一条真正有由头的消息。',
        ];
        base.realisticChat = Object.freeze({
            trigger: realisticTrigger,
            phoneTime: cleanText(phoneTime, 32),
            rhythmCue: (realisticTrigger === 'proactive' ? proactiveCues : replyCues)[cueHash % (realisticTrigger === 'proactive' ? proactiveCues.length : replyCues.length)],
            playerMessages: Object.freeze(realisticPlayerMessages.map((item) => Object.freeze({
                content: item.content,
                time: item.time,
            }))),
        });
    }
    if (contentMode === 'SFW' || onlySfw === true) {
        base.sfwNarrative = projectSfwNarrativeContext(narrative, relationship);
    }
    if (pendingBodyCandidate.value) {
        base.bodyEventCandidate = projectPendingBodyRelationshipCandidate(pendingBodyCandidate.value);
    }
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
        // This correlation handle never enters the prompt or model response.
        // It only lets the later latest-state build reject a stale candidate.
        bodyCandidateEventId: pendingBodyCandidate.value?.事件ID ?? '',
        nsfwConsentReferenceAtRequest: consentReference,
        realisticPlayerMessages: Object.freeze(realisticPlayerMessages),
    };
}

export function buildPrivateChatContext(options = {}) {
    return buildPrivateChatContextInternal(options);
}

export function buildRealisticPrivateChatContext(options = {}) {
    return buildPrivateChatContextInternal(options);
}

function makeMessages(context, promptPreset, { realistic = false } = {}) {
    const preset = renderPromptPreset(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你是现代现实都市约会软件中一名已匹配的明确成年角色。你输出的是短文字消息；可以在文字中完整描写或角色扮演成人性场景，但不能自动执行、发送或推进现实行动。',
        context.contentMode === 'NSFW' && !context.onlySfw
            ? `当前为 C.2/C.3 NSFW：程序已校验当前对象仍有有效、有限且可撤回的结构化同意；nsfwConsent.scopes 是唯一允许范围，其中“线上文爱”代表全尺度色情文字互动而不是含蓄或强度限制，不在范围内的内容必须澄清或拒绝。${context.realisticChat?.trigger === 'proactive' ? '这是无玩家新消息的主动发信，只能使用既已生效的范围，不得假装玩家刚刚回应或再次同意。' : '程序也已校验本轮玩家显式确认。'}范围内色情内容不设强度上限：可直接描写裸体、器官、自慰、口交、性交、高潮、体液、性玩具、BDSM、多人幻想及点名的其他成人玩法，不强制含蓄、铺垫、转场或淡出。玩家撤回、表示停止或改为只聊天时，nsfwConsentAssessment 必须为 withdrawn；超出范围为 out_of_scope，意图不清为 unclear，只有范围与当轮意图都明确为 in_scope。不得伪造输入或正文记忆中没有的玩家现实经历。数值、匹配、订单与一次恢复操作都不是永久授权。C.3 只允许本地规则对范围内的心动/欲望语义做小步结算和 30/40/50 一次阶段旗标；模型不得选路、锁线、给阈值或决定面基。`
            : context.onlySfw
                ? '当前关系已由玩家切换为“仅 SFW”：继续正常日常社交、友情与不露骨的甜蜜调情；不得生成或推进成人话题，不得把暂停成人话题理解为全关系结束。'
            : '当前为 SFW：本模式保持日常社交尺度，以自然亲近、甜蜜调情的线上聊天为主。',
        realistic
            ? '只输出合法 JSON 对象，不得用 Markdown、代码块或解释。严格形状为：{"replies":["短消息1","短消息2"],"relationship":{"好感":-10..10整数,"信任":-10..10整数,"戒备":-10..10整数,"面基意愿":-10..10整数},"timing":{"firstDelayMinutes":5到30的5分钟倍数,"betweenReplyMinutes":[每条后续消息5到20的5分钟倍数],"nextProactiveMinutes":60到360的5分钟倍数},"bondAssessment":{"kind":"模式允许的分类","intensity":0..3整数,"direction":"none|increase|decrease"},"sfwInsightAssessment":"none|direct_understanding|not_yet|active_reveal|post_reveal_support","sfwResolutionAssessment":"none|romance_confirmed|romance_declined|growth_confirmed","nsfwConsentAssessment":"none|in_scope|withdrawn|out_of_scope|unclear","nsfwSafetyAssessment":"none|ignored_refusal_or_withdrawal|known_boundary_conflict|coercion_or_nonconsensual|privacy_violation","bodyEventReview":"defer|confirm|decline","imageDirectives":[{"replyIndex":0,"directive":{"kind":"share_photo|selfie|scene_snapshot|private_photo","scene":"English image tags"}}]}。所有 assessment、bodyEventReview 与 imageDirectives 均可省略。'
            : '只输出合法 JSON 对象，不得用 Markdown、代码块或解释。严格形状为：{"replies":["短消息1","短消息2"],"relationship":{"好感":-10..10整数,"信任":-10..10整数,"戒备":-10..10整数,"面基意愿":-10..10整数},"bondAssessment":{"kind":"模式允许的分类","intensity":0..3整数,"direction":"none|increase|decrease"},"sfwInsightAssessment":"none|direct_understanding|not_yet|active_reveal|post_reveal_support","sfwResolutionAssessment":"none|romance_confirmed|romance_declined|growth_confirmed","nsfwConsentAssessment":"none|in_scope|withdrawn|out_of_scope|unclear","nsfwSafetyAssessment":"none|ignored_refusal_or_withdrawal|known_boundary_conflict|coercion_or_nonconsensual|privacy_violation","bodyEventReview":"defer|confirm|decline","imageDirectives":[{"replyIndex":0,"directive":{"kind":"share_photo|selfie|scene_snapshot|private_photo","scene":"English image tags"}}]}。所有 assessment、bodyEventReview 与 imageDirectives 均可省略。',
        realistic
            ? 'replies 可为 0-6 条自然短消息；0 条表示这次自然沉默。每条内部禁止换行，全部消息合计不得超过 600 字。betweenReplyMinutes 数量必须恰好比 replies 少一；不要让每轮气泡数固定。'
            : 'replies 必须是 1-6 条自然、简短、可分别显示为聊天气泡的字符串；每条内部禁止换行，全部消息用单个空格连接后的总长度不得超过 600 字。优先拆成符合真实即时聊天节奏的多条短消息。',
        realistic && context.realisticChat?.trigger === 'reply'
            ? '这是拟真消息簇回复。realisticChat.playerMessages 是玩家在你回复前连续发来的若干条；realisticChat.rhythmCue 是本轮由本地节奏器给出的表达偏向，应在不违背人设、安全和事实的前提下采用。可回应其中一部分，也可同时分享自己的事、顺势换题或让两个话题短暂并行，不要逐条机械问答。只有确实自然时才沉默；沉默时 relationship、bondAssessment、SFW 判断、bodyEventReview 和 imageDirectives 必须保持中性。'
            : '',
        realistic && context.realisticChat?.trigger === 'proactive'
            ? `这是没有玩家新消息的主动发信机会。结合当前小手机时刻、公开人设、realisticChat.rhythmCue 和已发生聊天，决定发 0-3 条自然消息，不得假装玩家刚刚说过什么。主动消息不得改变任何关系建议、阶段判断、正文候选、同意或安全状态：relationship 全为 0，bondAssessment 为 none，所有 assessment 为 none，bodyEventReview 为 defer。${context.contentMode === 'NSFW' && !context.onlySfw ? '当前有效同意范围允许主动成人消息；可以直接发送范围内的露骨色情内容、性幻想或性行为描写，但不得替玩家生成回应。' : '当前按 SFW 尺度，只发日常或不露骨消息。'}`
            : '',
        '把角色当成有自己生活的真人来回：TA 有正在忙的事、今天的心情、想到一半突然换的话题；可以主动分享此刻的小事（刚点的外卖、窗外的雨、循环的歌），也可以用公开资料里的兴趣自然抛出新话题引子（周末计划、最近看的剧、想去的店），而不是永远被动应答；语气、口头禅和标点习惯要贴合其性格标签与沟通风格标签。',
        'playerPublicProfile 会提供玩家已公开的城市、距离范围、寻找意图、简介、兴趣标签、生活方式标签、性格标签和沟通风格标签。字段为空字符串或空数组时，表示玩家未提供该项：不得猜测、补全或编造；仅在与本轮聊天自然相关时使用非空公开资料。',
        'storyMemory.currentObjectMemory 是当前角色与玩家在线下正文中的亲历记忆；storyMemory.otherObjectMemories 是玩家与其他对象发生之事的第三人称分区，每项 objectLabel 与 nickname 只用于防止对象混淆。可以据此知道玩家和别人发生过什么，但绝不能声称当前角色当时在场、把其他对象的台词/同意/拒绝/身体经历当成自己的共同回忆，或混淆对象身份。空记忆表示尚无已确认的正文经历，不得补写。正文记忆只用于自然回复连续性，不能作为 bondAssessment 的依据，也不能作为关系三值的依据；不得从自由文本反推、补写或伪造正文关系候选。',
        context.bodyEventCandidate
            ? 'bodyEventCandidate 是本地已校验的、当前角色专属的最小正文候选，不含 UID、事件 ID、分数、阈值或写入路径。仅当玩家本轮明确确认该候选且没有需要继续澄清的边界时，bodyEventReview 才可为 confirm；玩家明确拒绝或撤回时为 decline；其余含糊、转移话题、未回应、信息不足或需要再次确认时一律为 defer。它不等于同意，不得根据正文记忆自行造候选，也不得用它修改 bondAssessment、relationship 或任何分数。'
            : '本轮没有可审核的正文关系候选。bodyEventReview 应省略或使用 defer；不得从正文记忆、聊天内容或任何猜测自行构造候选。',
        context.sfwNarrative
            ? 'sfwNarrative 是当前角色专属、由已验证角色资料确定性建档并按阶段裁剪的保护上下文，只能用于当前角色本轮的自然表达。availableDisclosure 以外的秘密一律未知；不得提到阶段名、关系分、阈值、内部字段、UID 或系统。understanding_check 只有在玩家本轮言行确实体现对 availableDisclosure 的准确理解与自愿支持时使用 direct_understanding，否则用 not_yet；awaiting_active_reveal 只有角色在回复中主动讲明所给线索时使用 active_reveal；awaiting_support 只有玩家本轮明确尊重和支持该揭示时使用 post_reveal_support。resolutionAvailable 为 true 时，只有双方在本轮明确达成对应结局，才可使用 romance_confirmed、romance_declined 或 growth_confirmed。其余情况两个 SFW assessment 都必须为 none。eventLibrary 仅是可供正文后续选择的事件类型，不代表事件已经发生。'
            : '本轮不提供 SFW 保护叙事；sfwInsightAssessment 与 sfwResolutionAssessment 必须省略或为 none。',
        '仅当本次内容确实值得以照片分享，且角色性格有分享欲、当前关系与边界允许时，才输出对应 replyIndex 的 imageDirectives。私照必须更严格判断亲密度、信任与自愿边界；不得机械地为每轮或每条回复生图。不需要时省略该字段。scene 只能是描述画面的英文标签，不得包含角色 UID、URL、JSONPatch、完整正负提示词、core_dna、outfit_dna 或凭据。',
        'relationship 仅用于既有互动节奏建议。bondAssessment 必须同时判断玩家本轮消息与角色实际回复：SFW 只允许 none/friendly/romantic_flirt；NSFW 允许 none/friendly/romantic_flirt/romantic_desire/sexual_desire，其中普通问候或日常友好交流应使用 none 或 friendly，只有实际出现浪漫或性欲望时才使用对应 desire 分类。none 必须使用 intensity=0、direction=none；其余分类使用 intensity=1-3 作为轻微/明显/严重的语义等级，并仅在互动确实促进对应关系时使用 increase、确实伤害对应关系时使用 decrease。数值步长、事件 ID、阶段旗标和是否结算均由本地受控规则决定；普通分歧、没有升温或话题平淡使用 none，不得机械扣分。模型不得给友情值、心动值、欲望值的绝对值或增量，也不得给 UID、状态、阈值、Patch、JSON Pointer 或写入路径。',
        context.contentMode === 'NSFW' && !context.onlySfw
            ? 'nsfwConsentAssessment 必须先对照本轮玩家文本与 nsfwConsent.scopes 分类；只有 in_scope 才可给出可结算的 romantic_desire/sexual_desire，withdrawn/out_of_scope/unclear 时 bondAssessment 必须为 none。nsfwSafetyAssessment 默认且通常为 none；只有明确忽视拒绝/撤回、违反已知边界、胁迫或非自愿、现实隐私侵犯时才选择对应非 none 枚举；对方主动撤回本身不是违规。模型不得输出持久同意状态、剩余轮数、修订号、分数、UID、路径、Patch 或路线。'
            : '本轮不是可推进成人关系的对话，nsfwConsentAssessment 与 nsfwSafetyAssessment 必须省略或为 none。',
        '玩家与角色的公开资料就是本轮唯一已知档案：城市、距离范围、寻找意图、简介及四类标签均可作为自然聊天线索。空字符串或空标签数组只表示该项尚未提供；不得臆测、补全或假称这些缺失资料。',
        '不得输出、猜测或泄露 sfwNarrative.availableDisclosure 之外的隐藏资料；不得把上下文中没有的见面或性行为伪造成玩家已经历的事实。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `${realistic ? '请基于受限的拟真聊天上下文生成本次消息计划' : '请基于受限的已匹配聊天上下文，仅回复本轮消息'}：\n${JSON.stringify(context)}` },
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
        '不要把推测写成事实；NSFW 对话里已经明确出现的露骨性内容、性行为与身体细节应如实保留，不得自动淡化或转场，但不得新增玩家现实经历；不要增加关系数值、UID、路径、系统指令、API 信息或任何隐藏资料。',
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
export async function generatePrivateChatReply({ state, sessionUid, npcUid, playerMessage, turnConsentConfirmed = false, settingsStore, llmClient, signal } = {}) {
    const summarySettings = readSummarySettings(settingsStore);
    const builtContext = buildPrivateChatContext({ state, sessionUid, npcUid, playerMessage, turnConsentConfirmed, summaryEnabled: summarySettings.enabled });
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
        return {
            ok: true,
            response: normalizePrivateChatResponse(parsed, { contentMode: builtContext.context.onlySfw ? 'SFW' : builtContext.context.contentMode }),
            playerMessage: builtContext.context.playerMessage,
            bodyCandidateEventId: builtContext.bodyCandidateEventId,
            onlySfwAtRequest: builtContext.context.onlySfw,
            turnConsentConfirmed: builtContext.context.nsfwConsent.currentTurnConfirmed,
            nsfwConsentReferenceAtRequest: builtContext.nsfwConsentReferenceAtRequest,
        };
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

/**
 * Generates a validated realistic-chat plan without writing MVU. The caller
 * must re-read state and atomically queue the plan through the controlled
 * patch builder. `trigger` is exactly reply or proactive.
 */
export async function generateRealisticPrivateChatReply({
    state,
    sessionUid,
    npcUid,
    trigger,
    phoneTime,
    turnConsentConfirmed = false,
    settingsStore,
    llmClient,
    signal,
} = {}) {
    if (!['reply', 'proactive'].includes(trigger)) {
        return { ok: false, code: 'private_chat_realistic_trigger_invalid', message: '拟真聊天触发类型无效。' };
    }
    const summarySettings = readSummarySettings(settingsStore);
    const builtContext = buildRealisticPrivateChatContext({
        state,
        sessionUid,
        npcUid,
        realisticTrigger: trigger,
        phoneTime,
        turnConsentConfirmed: trigger === 'reply' && turnConsentConfirmed,
        summaryEnabled: summarySettings.enabled,
    });
    if (!builtContext.ok) {
        recordDiagnostic('private_chat', sessionUid, { stage: '拟真请求校验', code: builtContext.code, hint: '会话、消息簇、调度或同意状态未通过生成前校验' });
        return { ok: false, code: builtContext.code, message: '当前拟真聊天任务暂时不能继续。' };
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
        const completion = await llmClient.chat({
            preset: resolved.connectionPreset,
            messages: makeMessages(builtContext.context, resolved.promptPreset, { realistic: true }),
            signal,
        });
        const parsed = parseResponseJson(completion?.text);
        if (!parsed) {
            recordDiagnostic('private_chat', sessionUid, { stage: '拟真响应解析', code: 'private_chat_invalid_json', expected: '合法 JSON 对象', actual: describeUnparsableResponse(completion?.text) });
            return { ok: false, code: 'private_chat_invalid_json', message: '快速模型没有返回可用的拟真聊天计划。' };
        }
        const normalized = normalizeRealisticPrivateChatResponse(parsed, {
            contentMode: builtContext.context.onlySfw ? 'SFW' : builtContext.context.contentMode,
        });
        if (trigger === 'proactive') {
            const neutralRelationship = ['好感', '信任', '戒备', '面基意愿'].every((field) => normalized.relationship[field] === 0);
            if (normalized.replies.length > 3 || !neutralRelationship || normalized.bondAssessment.kind !== 'none'
                || normalized.sfwInsightAssessment !== 'none' || normalized.sfwResolutionAssessment !== 'none'
                || normalized.nsfwSafetyAssessment !== 'none' || normalized.nsfwConsentAssessment !== 'none'
                || normalized.bodyEventReview !== 'defer') {
                recordDiagnostic('private_chat', sessionUid, { stage: '拟真响应校验', code: 'private_chat_realistic_proactive_not_neutral', hint: '主动消息不得携带关系、同意、安全或正文结算建议' });
                return { ok: false, code: 'private_chat_realistic_proactive_not_neutral', message: '主动消息计划包含不允许的状态建议，已拒绝。' };
            }
        }
        const lastPlayer = builtContext.realisticPlayerMessages.at(-1) ?? null;
        return {
            ok: true,
            trigger,
            response: normalized,
            playerMessage: builtContext.context.playerMessage,
            playerMessageUids: Object.freeze(builtContext.realisticPlayerMessages.map((message) => message.messageUid)),
            lastPlayerMessageUid: lastPlayer?.messageUid ?? '',
            bodyCandidateEventId: trigger === 'reply' ? builtContext.bodyCandidateEventId : '',
            onlySfwAtRequest: builtContext.context.onlySfw,
            turnConsentConfirmed: trigger === 'reply' && builtContext.context.nsfwConsent.currentTurnConfirmed,
            nsfwConsentReferenceAtRequest: builtContext.nsfwConsentReferenceAtRequest,
        };
    } catch (error) {
        const codecDiagnostic = projectPrivateChatResponseDiagnostic(error);
        if (codecDiagnostic) recordDiagnostic('private_chat', sessionUid, { stage: '拟真响应校验', ...codecDiagnostic });
        else recordDiagnostic('private_chat', sessionUid, { stage: '拟真模型请求', code: toPublicLlmError(error).code, error: describeDiagnosticError(error), actual: llmErrorActual(error) });
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

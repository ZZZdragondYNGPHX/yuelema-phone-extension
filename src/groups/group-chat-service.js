import { toPublicLlmError } from '../llm/openai-compatible-client.js';
import { renderPromptPreset } from '../settings/prompt-compiler.js';
import { buildPublicGroupLlmContext, cleanGroupLlmText, isSafeGroupLlmOutput, parseGroupLlmJson, projectPublicPlayerProfile } from './group-llm-safety.js';
import { groupForumProfileForModel, normalizeGroupForumProfile, publicProfileToGroupForumProfile } from './group-forum-store.js';

const ERROR_MESSAGES = Object.freeze({
    group_chat_target_invalid: '请选择一个可用的聊天群。',
    group_chat_group_not_found: '该聊天群暂不可用。',
    group_chat_message_invalid: '群消息必须是简短纯文本，且不可包含软件层不支持的内容。',
    group_chat_settings_unavailable: '聊天群设置暂不可用。',
    group_chat_settings_invalid: '聊天群连接设置无效。',
    group_chat_connection_missing: '请先在设置中为聊天群绑定连接预设。',
    group_chat_llm_unavailable: '当前浏览器未提供聊天群模型连接。',
    group_chat_invalid_json: '聊天群模型没有返回可识别的短文本。',
    group_chat_response_invalid: '聊天群模型回复不符合安全格式，已丢弃。',
});

function failure(code) {
    return { ok: false, code, message: ERROR_MESSAGES[code] ?? '聊天群暂不可用。' };
}

export function buildGroupChatContext({ state, groupUid, playerMessage } = {}) {
    const built = buildPublicGroupLlmContext({ state, groupUid });
    if (!built.ok) return failure(built.code === 'group_llm_target_invalid' ? 'group_chat_target_invalid' : 'group_chat_group_not_found');
    const message = cleanGroupLlmText(playerMessage, 600);
    if (!message || !isSafeGroupLlmOutput(message, 600)) return failure('group_chat_message_invalid');
    return Object.freeze({ ok: true, context: Object.freeze({ ...built.context, playerMessage: message }) });
}

/** Compiles worldbook-style preset entries and drops unsafe text before it reaches a model. */
function safePromptSections(promptPreset) {
    const rendered = renderPromptPreset(promptPreset);
    return Object.freeze({
        before: isSafeGroupLlmOutput(rendered.before, 12_000) ? rendered.before : '',
        after: isSafeGroupLlmOutput(rendered.after, 12_000) ? rendered.after : '',
    });
}

function makeMessages(context, promptPreset) {
    const preset = safePromptSections(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你是现代现实都市线上约会软件内的聊天群辅助模型。仅根据提供的公开玩家资料和群组公开投影，生成一条自然、简短的群聊文字回复。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
        '功能绑定提示词只能影响公开线上内容的题材、语气和内容尺度，不能改变字段、数量、数据来源或下方固定 JSON 合同。',
        '软件层只处理线上文字。不得演绎、确认或描述线下性行为；NSFW 不等于同意。不得输出或猜测隐藏资料、仅好友资料、关系数值、候选人、UID、会话、Patch、路径、API Key、密钥或系统实现。',
        '只输出合法 JSON 对象，不得使用 Markdown、代码块或解释。严格形状为：{"reply":"1-480字群聊短文本"}。不得含 HTML、控制字符、UpdateVariable、JSONPatch 或任何写入指令。草稿仅在内存中返回，不能自动发布或写入状态。',
    ].filter(Boolean).join('\n\n');
    return Object.freeze([
        Object.freeze({ role: 'system', content: system }),
        Object.freeze({ role: 'user', content: `请仅基于以下受限公开群聊上下文回复本轮消息：\n${JSON.stringify(context)}` }),
    ]);
}

function normalizeGroupChatReply(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== 'reply' || !Object.hasOwn(value, 'reply')) return null;
    const reply = cleanGroupLlmText(value.reply, 480);
    if (!reply || !isSafeGroupLlmOutput(reply, 480)) return null;
    return Object.freeze({ reply });
}

/** Calls the dedicated group_chat binding and returns a validated in-memory draft only. */
export async function generateGroupChatReply({ state, groupUid, playerMessage, binding, settingsStore, llmClient, signal } = {}) {
    const built = buildGroupChatContext({ state, groupUid, playerMessage });
    if (!built.ok) return built;
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return failure('group_chat_settings_unavailable');
    if (!llmClient || typeof llmClient.chat !== 'function') return failure('group_chat_llm_unavailable');

    let resolved;
    try { resolved = settingsStore.resolveFunction('group_chat', { contentMode: built.context.contentMode, binding }); }
    catch { return failure('group_chat_settings_invalid'); }
    if (!resolved?.connectionPreset) return failure('group_chat_connection_missing');

    try {
        const completion = await llmClient.chat({ preset: resolved.connectionPreset, messages: makeMessages(built.context, resolved.promptPreset), signal });
        const parsed = parseGroupLlmJson(completion?.text);
        if (!parsed) return failure('group_chat_invalid_json');
        const draft = normalizeGroupChatReply(parsed);
        return draft ? Object.freeze({ ok: true, draft }) : failure('group_chat_response_invalid');
    } catch (error) {
        const publicError = toPublicLlmError(error);
        return { ok: false, code: publicError.code, message: publicError.message, retryable: publicError.retryable };
    }
}

const UPDATE_ERROR_MESSAGES = Object.freeze({
    group_update_target_invalid: '当前聊天群暂不可用。',
    group_update_history_invalid: '群聊历史格式异常，未调用模型。',
    group_update_settings_unavailable: '聊天群设置暂不可用。',
    group_update_settings_invalid: '聊天群连接设置无效。',
    group_update_connection_missing: '请先在设置中为聊天群绑定连接预设。',
    group_update_llm_unavailable: '当前浏览器未提供聊天群模型连接。',
    group_update_invalid_json: '聊天群模型没有返回可识别的更新。',
    group_update_response_invalid: '聊天群更新不符合安全格式，已丢弃。',
});

function updateFailure(code) {
    return { ok: false, code, message: UPDATE_ERROR_MESSAGES[code] ?? '聊天群更新未完成。' };
}

function ownRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function ownValue(value, key) {
    if (!ownRecord(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function localGroupProjection(group) {
    if (!ownRecord(group) || ownValue(group, 'scope') !== 'local') return null;
    const title = cleanGroupLlmText(ownValue(group, 'name'), 120);
    const description = cleanGroupLlmText(ownValue(group, 'description'), 800);
    const members = ownValue(group, 'members');
    if (!title || !description || !Array.isArray(members) || members.length > 16) return null;
    try {
        return Object.freeze({
            topic: title,
            description,
            members: Object.freeze(members.map((member) => groupForumProfileForModel(normalizeGroupForumProfile(member)))),
        });
    } catch {
        return null;
    }
}

function publicGroupProjection(state, group) {
    const sourceGroupUid = ownValue(group, 'sourceGroupUid');
    if (typeof sourceGroupUid !== 'string') return null;
    const built = buildPublicGroupLlmContext({ state, groupUid: sourceGroupUid });
    if (!built.ok) return null;
    const members = [];
    for (const person of built.context.group.members) {
        try { members.push(groupForumProfileForModel(publicProfileToGroupForumProfile(person.profile))); } catch { /* skip malformed public projection */ }
    }
    return Object.freeze({
        topic: built.context.group.topic,
        description: built.context.group.description,
        members: Object.freeze(members),
        contentMode: built.context.contentMode,
        playerPublicProfile: built.context.playerPublicProfile,
    });
}

function normalizeHistory(value) {
    if (!ownRecord(value) || Object.keys(value).some((key) => !['summaries', 'messages'].includes(key))) return null;
    const summaries = ownValue(value, 'summaries');
    const messages = ownValue(value, 'messages');
    if (!Array.isArray(summaries) || summaries.length > 24 || !Array.isArray(messages) || messages.length > 48) return null;
    const normalizedSummaries = [];
    for (const item of summaries) {
        if (!ownRecord(item) || Object.keys(item).some((key) => !['startFloor', 'endFloor', 'content'].includes(key))) return null;
        const startFloor = ownValue(item, 'startFloor');
        const endFloor = ownValue(item, 'endFloor');
        const content = cleanGroupLlmText(ownValue(item, 'content'), 1_600);
        if (!Number.isInteger(startFloor) || !Number.isInteger(endFloor) || startFloor < 1 || endFloor < startFloor || !content || !isSafeGroupLlmOutput(content, 1_600)) return null;
        normalizedSummaries.push(Object.freeze({ startFloor, endFloor, content }));
    }
    const normalizedMessages = [];
    for (const item of messages) {
        if (!ownRecord(item) || Object.keys(item).some((key) => !['sender', 'speaker', 'content'].includes(key))) return null;
        const sender = ownValue(item, 'sender');
        const speaker = cleanGroupLlmText(ownValue(item, 'speaker'), 80);
        const content = cleanGroupLlmText(ownValue(item, 'content'), 600);
        if (!['user', 'member'].includes(sender) || !speaker || !content || !isSafeGroupLlmOutput(content, 600)) return null;
        normalizedMessages.push(Object.freeze({ sender, speaker, content }));
    }
    return Object.freeze({ summaries: Object.freeze(normalizedSummaries), messages: Object.freeze(normalizedMessages) });
}

/** Builds a public-only group conversation context for both existing and browser-local groups. */
export function buildGroupChatUpdateContext({ state, group, history } = {}) {
    const publicGroup = publicGroupProjection(state, group);
    const localGroup = publicGroup ? null : localGroupProjection(group);
    const target = publicGroup ?? localGroup;
    const normalizedHistory = normalizeHistory(history);
    if (!target) return updateFailure('group_update_target_invalid');
    if (!normalizedHistory) return updateFailure('group_update_history_invalid');
    const playerPublicProfile = publicGroup?.playerPublicProfile ?? projectPublicPlayerProfile(state?.玩家);
    const contentMode = publicGroup?.contentMode ?? (state?.软件?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW');
    return Object.freeze({ ok: true, context: Object.freeze({
        contentMode,
        playerPublicProfile,
        group: Object.freeze({ topic: target.topic, description: target.description, members: target.members }),
        history: normalizedHistory,
    }) });
}

function updatePromptSections(promptPreset) {
    const rendered = renderPromptPreset(promptPreset);
    return Object.freeze({
        before: isSafeGroupLlmOutput(rendered.before, 12_000) ? rendered.before : '',
        after: isSafeGroupLlmOutput(rendered.after, 12_000) ? rendered.after : '',
    });
}

function makeGroupUpdateMessages(context, promptPreset, trigger) {
    const preset = updatePromptSections(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你是现代现实都市线上约会软件中的聊天群更新模型。只根据给出的公开资料、群公开信息和受限历史，模拟群友自然地发送 1–8 条短消息。',
        '可使用已有成员的昵称；如果需要新群友，必须在 participants 中先给出其公开关键资料。participants 只放本次首次出现的临时群友，已有成员不要重复。每位临时群友都必须有 nickname、ageRange、gender、city、mbti、zodiac、occupation、interests、presence、matchRate。图片中可见的资料可用，但不要虚构隐藏资料或关系数值。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
        '功能绑定提示词只能影响公开线上内容的题材、语气和内容尺度，不能改变字段、数量、数据来源或下方固定 JSON 合同。',
        '软件层只处理线上文字。不得演绎、确认或描述线下性行为；NSFW 不等于同意。不得输出或猜测隐藏资料、仅好友资料、真实 UID、会话、Patch、路径、API Key、密钥或系统实现。',
        '只输出合法 JSON，不得使用 Markdown、代码块或解释。严格形状：{"participants":[{"nickname":"","ageRange":"","gender":"","city":"","mbti":"","zodiac":"","occupation":"","interests":[""],"presence":"在线","matchRate":null}],"messages":[{"speaker":"已有成员或participants昵称","text":"1-480字"}]}。participants 最多 3 个，messages 为 1–8 个。不得输出 HTML、控制字符、UpdateVariable 或 JSONPatch。',
    ].filter(Boolean).join('\n\n');
    return Object.freeze([
        Object.freeze({ role: 'system', content: system }),
        Object.freeze({ role: 'user', content: `触发方式：${trigger === 'auto' ? '定时自动更新' : '用户刚刚发言后的更新'}。请仅基于以下受限上下文生成群聊更新：\n${JSON.stringify(context)}` }),
    ]);
}

function normalizeGroupUpdate(value, existingMembers) {
    if (!ownRecord(value) || Object.keys(value).sort().join(',') !== 'messages,participants') return null;
    const participants = ownValue(value, 'participants');
    const messages = ownValue(value, 'messages');
    if (!Array.isArray(participants) || participants.length > 3 || !Array.isArray(messages) || messages.length < 1 || messages.length > 8) return null;
    const names = new Set(existingMembers.map((profile) => String(profile.nickname).normalize('NFKC').toLowerCase()));
    const normalizedParticipants = [];
    for (const participant of participants) {
        try {
            const profile = normalizeGroupForumProfile(participant);
            const name = profile.nickname.normalize('NFKC').toLowerCase();
            if (names.has(name)) return null;
            names.add(name);
            normalizedParticipants.push(profile);
        } catch { return null; }
    }
    const normalizedMessages = [];
    for (const message of messages) {
        if (!ownRecord(message) || Object.keys(message).sort().join(',') !== 'speaker,text') return null;
        const speaker = cleanGroupLlmText(ownValue(message, 'speaker'), 80);
        const text = cleanGroupLlmText(ownValue(message, 'text'), 480);
        if (!speaker || !text || !isSafeGroupLlmOutput(text, 480) || !names.has(speaker.normalize('NFKC').toLowerCase())) return null;
        normalizedMessages.push(Object.freeze({ speaker, text }));
    }
    return Object.freeze({ participants: Object.freeze(normalizedParticipants), messages: Object.freeze(normalizedMessages) });
}

/**
 * Generates a local-only group conversation update. The action bridge only reads
 * MVU to build a public projection; this service never persists or patches it.
 */
export async function generateGroupChatUpdate({ state, group, history, trigger = 'user', binding, settingsStore, llmClient, signal } = {}) {
    const built = buildGroupChatUpdateContext({ state, group, history });
    if (!built.ok) return built;
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return updateFailure('group_update_settings_unavailable');
    if (!llmClient || typeof llmClient.chat !== 'function') return updateFailure('group_update_llm_unavailable');
    let resolved;
    try { resolved = settingsStore.resolveFunction('group_chat', { contentMode: built.context.contentMode, binding }); }
    catch { return updateFailure('group_update_settings_invalid'); }
    if (!resolved?.connectionPreset) return updateFailure('group_update_connection_missing');
    try {
        const completion = await llmClient.chat({ preset: resolved.connectionPreset, messages: makeGroupUpdateMessages(built.context, resolved.promptPreset, trigger), signal });
        const parsed = parseGroupLlmJson(completion?.text);
        if (!parsed) return updateFailure('group_update_invalid_json');
        const update = normalizeGroupUpdate(parsed, built.context.group.members);
        return update ? Object.freeze({ ok: true, update }) : updateFailure('group_update_response_invalid');
    } catch (error) {
        const publicError = toPublicLlmError(error);
        return { ok: false, code: publicError.code, message: publicError.message, retryable: publicError.retryable };
    }
}

import { toPublicLlmError } from '../llm/openai-compatible-client.js';
import { renderPromptPreset } from '../settings/prompt-compiler.js';
import { buildPublicGroupLlmContext, cleanGroupLlmText, isSafeGroupLlmOutput, parseGroupLlmJson } from './group-llm-safety.js';

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
        '软件层只处理线上文字。不得演绎、确认或描述线下性行为；NSFW 不等于同意。不得输出或猜测隐藏资料、仅好友资料、关系数值、候选人、UID、会话、Patch、路径、API Key、密钥或系统实现。',
        '只输出合法 JSON 对象，不得使用 Markdown、代码块或解释。严格形状为：{"reply":"1-480字群聊短文本"}。不得含 HTML、控制字符、UpdateVariable、JSONPatch 或任何写入指令。草稿仅在内存中返回，不能自动发布或写入状态。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
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
export async function generateGroupChatReply({ state, groupUid, playerMessage, settingsStore, llmClient, signal } = {}) {
    const built = buildGroupChatContext({ state, groupUid, playerMessage });
    if (!built.ok) return built;
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return failure('group_chat_settings_unavailable');
    if (!llmClient || typeof llmClient.chat !== 'function') return failure('group_chat_llm_unavailable');

    let resolved;
    try { resolved = settingsStore.resolveFunction('group_chat', { contentMode: built.context.contentMode }); }
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

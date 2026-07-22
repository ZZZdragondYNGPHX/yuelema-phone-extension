/**
 * Summaries for browser-local group and forum conversations.
 *
 * Unlike private-chat summaries, these records never enter MVU: the main
 * SillyTavern narrative model must not receive simulated group/forum history.
 */
import { toPublicLlmError } from '../llm/openai-compatible-client.js';
import { renderPromptPreset } from '../settings/prompt-compiler.js';
import { cleanGroupLlmText, isSafeGroupLlmOutput, parseGroupLlmJson } from './group-llm-safety.js';

const ERROR_MESSAGES = Object.freeze({
    local_summary_target_invalid: '当前本地对话暂不可总结。',
    local_summary_source_invalid: '待总结的群聊或帖子内容格式异常。',
    local_summary_settings_unavailable: '对话总结设置暂不可用。',
    local_summary_settings_invalid: '对话总结连接设置无效。',
    local_summary_connection_missing: '请先在设置中为对话总结绑定连接预设。',
    local_summary_llm_unavailable: '当前浏览器未提供总结模型连接。',
    local_summary_invalid_json: '总结模型没有返回可识别的结果。',
    local_summary_response_invalid: '总结内容不符合安全格式，已丢弃。',
});

function failure(code) {
    return { ok: false, code, message: ERROR_MESSAGES[code] ?? '本地对话总结未完成。' };
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

export function buildLocalConversationSummaryContext({ target, messages, contentMode = 'SFW' } = {}) {
    if (!ownRecord(target) || Object.keys(target).some((key) => !['kind', 'title'].includes(key))) return failure('local_summary_target_invalid');
    const kind = ownValue(target, 'kind');
    const title = cleanGroupLlmText(ownValue(target, 'title'), 120);
    if (!['group', 'post'].includes(kind) || !title) return failure('local_summary_target_invalid');
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 80) return failure('local_summary_source_invalid');
    const normalizedMessages = [];
    for (const message of messages) {
        if (!ownRecord(message) || Object.keys(message).some((key) => !['floor', 'sender', 'speaker', 'content'].includes(key))) return failure('local_summary_source_invalid');
        const floor = ownValue(message, 'floor');
        const sender = ownValue(message, 'sender');
        const speaker = cleanGroupLlmText(ownValue(message, 'speaker'), 80);
        const content = cleanGroupLlmText(ownValue(message, 'content'), 600);
        if (!Number.isInteger(floor) || floor < 1 || !['user', 'member'].includes(sender) || !speaker || !content || !isSafeGroupLlmOutput(content, 600)) {
            return failure('local_summary_source_invalid');
        }
        normalizedMessages.push(Object.freeze({ floor, sender, speaker, content }));
    }
    return Object.freeze({ ok: true, context: Object.freeze({
        contentMode: contentMode === 'NSFW' ? 'NSFW' : 'SFW',
        target: Object.freeze({ kind, title }),
        messages: Object.freeze(normalizedMessages),
    }) });
}

function safePromptSections(promptPreset) {
    const rendered = renderPromptPreset(promptPreset);
    return Object.freeze({
        before: isSafeGroupLlmOutput(rendered.before, 12_000) ? rendered.before : '',
        after: isSafeGroupLlmOutput(rendered.after, 12_000) ? rendered.after : '',
    });
}

function makeMessages(context, promptPreset) {
    const preset = safePromptSections(promptPreset);
    const kindName = context.target.kind === 'group' ? '聊天群' : '论坛帖子';
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        `你负责整理约会软件内${kindName}的本地缓存记录。仅依据给出的公开文字，提炼已发生事实、情绪/互动氛围、明确承诺、已说出的边界和待确认事项。`,
        '不得创造新事实、不得把猜测写成确认、不得把 NSFW 视为同意、不得演绎线下性行为。不得输出或猜测隐藏资料、仅好友资料、真实 UID、会话、Patch、路径、API Key、密钥或系统实现。',
        '只输出合法 JSON，不得使用 Markdown、代码块或解释。严格形状：{"summary":"1-1600字纯文本总结"}。不得含 HTML、控制字符、UpdateVariable 或 JSONPatch。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
    ].filter(Boolean).join('\n\n');
    return Object.freeze([
        Object.freeze({ role: 'system', content: system }),
        Object.freeze({ role: 'user', content: `请总结“${context.target.title}”的以下本地对话片段：\n${JSON.stringify(context.messages)}` }),
    ]);
}

function normalizeSummary(value) {
    if (!ownRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'summary')) return null;
    const summary = cleanGroupLlmText(ownValue(value, 'summary'), 1_600);
    return summary && isSafeGroupLlmOutput(summary, 1_600) ? summary : null;
}

/** Calls the chat_summary binding but returns only an in-memory local summary draft. */
export async function generateLocalConversationSummary({ target, messages, contentMode, settingsStore, llmClient, signal } = {}) {
    const built = buildLocalConversationSummaryContext({ target, messages, contentMode });
    if (!built.ok) return built;
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return failure('local_summary_settings_unavailable');
    if (!llmClient || typeof llmClient.chat !== 'function') return failure('local_summary_llm_unavailable');
    let resolved;
    try { resolved = settingsStore.resolveFunction('chat_summary', { contentMode: built.context.contentMode }); }
    catch { return failure('local_summary_settings_invalid'); }
    if (!resolved?.connectionPreset) return failure('local_summary_connection_missing');
    try {
        const completion = await llmClient.chat({ preset: resolved.connectionPreset, messages: makeMessages(built.context, resolved.promptPreset), signal });
        const parsed = parseGroupLlmJson(completion?.text);
        if (!parsed) return failure('local_summary_invalid_json');
        const summary = normalizeSummary(parsed);
        return summary ? Object.freeze({ ok: true, summary }) : failure('local_summary_response_invalid');
    } catch (error) {
        const publicError = toPublicLlmError(error);
        return { ok: false, code: publicError.code, message: publicError.message, retryable: publicError.retryable };
    }
}

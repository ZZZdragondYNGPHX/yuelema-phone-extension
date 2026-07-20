import { toPublicLlmError } from '../llm/openai-compatible-client.js';
import { renderPromptPreset } from '../settings/prompt-compiler.js';
import { buildPublicGroupLlmContext, cleanGroupLlmText, isSafeGroupLlmOutput, parseGroupLlmJson } from './group-llm-safety.js';

const ERROR_MESSAGES = Object.freeze({
    forum_target_invalid: '请选择一个可用的论坛主题。',
    forum_group_not_found: '该论坛主题暂不可用。',
    forum_topic_invalid: '请输入简短、明确的发帖主题。',
    forum_settings_unavailable: '论坛设置暂不可用。',
    forum_settings_invalid: '论坛连接设置无效。',
    forum_connection_missing: '请先在设置中为论坛绑定连接预设。',
    forum_llm_unavailable: '当前浏览器未提供论坛模型连接。',
    forum_invalid_json: '论坛模型没有返回可识别的帖子草稿。',
    forum_response_invalid: '论坛模型草稿不符合安全格式，已丢弃。',
});

function failure(code) {
    return { ok: false, code, message: ERROR_MESSAGES[code] ?? '论坛暂不可用。' };
}

export function buildForumContext({ state, groupUid, topic } = {}) {
    const built = buildPublicGroupLlmContext({ state, groupUid });
    if (!built.ok) return failure(built.code === 'group_llm_target_invalid' ? 'forum_target_invalid' : 'forum_group_not_found');
    const requestTopic = cleanGroupLlmText(topic, 160);
    if (!requestTopic || !isSafeGroupLlmOutput(requestTopic, 160)) return failure('forum_topic_invalid');
    return Object.freeze({ ok: true, context: Object.freeze({ ...built.context, requestedTopic: requestTopic }) });
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
        '你是现代现实都市线上约会软件内的论坛辅助模型。仅根据提供的公开玩家资料和群组公开投影，生成一篇可供玩家审核的短论坛帖子草稿。',
        '软件层只处理线上文字。不得演绎、确认或描述线下性行为；NSFW 不等于同意。不得输出或猜测隐藏资料、仅好友资料、关系数值、候选人、UID、会话、Patch、路径、API Key、密钥或系统实现。',
        '只输出合法 JSON 对象，不得使用 Markdown、代码块或解释。严格形状为：{"title":"1-80字标题","body":"1-900字帖子草稿"}。不得含 HTML、控制字符、UpdateVariable、JSONPatch 或任何写入指令。草稿仅供展示和玩家确认，不能自动发布或写入状态。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
    ].filter(Boolean).join('\n\n');
    return Object.freeze([
        Object.freeze({ role: 'system', content: system }),
        Object.freeze({ role: 'user', content: `请仅基于以下受限公开论坛上下文生成帖子草稿：\n${JSON.stringify(context)}` }),
    ]);
}

function normalizeForumPostDraft(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value).sort();
    if (keys.length !== 2 || keys[0] !== 'body' || keys[1] !== 'title') return null;
    const title = cleanGroupLlmText(value.title, 80);
    const body = cleanGroupLlmText(value.body, 900);
    if (!title || !body || !isSafeGroupLlmOutput(title, 80) || !isSafeGroupLlmOutput(body, 900)) return null;
    return Object.freeze({ title, body });
}

/** Calls the dedicated forum binding and returns a validated, non-persistent post draft only. */
export async function generateForumPostDraft({ state, groupUid, topic, settingsStore, llmClient, signal } = {}) {
    const built = buildForumContext({ state, groupUid, topic });
    if (!built.ok) return built;
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return failure('forum_settings_unavailable');
    if (!llmClient || typeof llmClient.chat !== 'function') return failure('forum_llm_unavailable');

    let resolved;
    try { resolved = settingsStore.resolveFunction('forum', { contentMode: built.context.contentMode }); }
    catch { return failure('forum_settings_invalid'); }
    if (!resolved?.connectionPreset) return failure('forum_connection_missing');

    try {
        const completion = await llmClient.chat({ preset: resolved.connectionPreset, messages: makeMessages(built.context, resolved.promptPreset), signal });
        const parsed = parseGroupLlmJson(completion?.text);
        if (!parsed) return failure('forum_invalid_json');
        const draft = normalizeForumPostDraft(parsed);
        return draft ? Object.freeze({ ok: true, draft }) : failure('forum_response_invalid');
    } catch (error) {
        const publicError = toPublicLlmError(error);
        return { ok: false, code: publicError.code, message: publicError.message, retryable: publicError.retryable };
    }
}

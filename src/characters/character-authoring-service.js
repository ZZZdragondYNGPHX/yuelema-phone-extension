import { toPublicLlmError } from '../llm/openai-compatible-client.js';
import { renderPromptPreset } from '../settings/prompt-compiler.js';
import { normalizeGeneratedCandidate } from '../recommendation/candidate.js';

const MAX_MODEL_RESPONSE_CHARS = 20_000;
const MAX_INSTRUCTION_LENGTH = 1_200;
const MAX_PUBLIC_TAGS = 12;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const HTML_PATTERN = /<!--|<\s*\/?\s*[a-z][^>]*>/iu;

const COMPLETION_ERRORS = Object.freeze({
    input_invalid: '待补全的公开资料或说明无效；当前草稿未改变。',
    settings_unavailable: '角色创作设置暂不可用。',
    settings_invalid: '角色创作预设无效，请检查设置。',
    connection_missing: '请先为“角色创作”绑定连接预设或设置默认连接。',
    llm_unavailable: '当前浏览器未提供角色创作模型连接。',
    invalid_json: '模型没有返回可用的角色补全草稿；当前草稿未改变。',
    response_invalid: '模型返回的角色补全草稿未通过成年人或结构校验；当前草稿未改变。',
});

const AUTHORING_ERRORS = Object.freeze({
    input_invalid: '完整创作说明或公开上下文无效；当前草稿未改变。',
    settings_unavailable: '角色创作设置暂不可用。',
    settings_invalid: '角色创作预设无效，请检查设置。',
    connection_missing: '请先为“角色创作”绑定连接预设或设置默认连接。',
    llm_unavailable: '当前浏览器未提供角色创作模型连接。',
    invalid_json: '模型没有返回可用的完整角色草稿；当前草稿未改变。',
    response_invalid: '模型返回的完整角色草稿未通过成年人或结构校验；当前草稿未改变。',
});

const PUBLIC_TEXT_LIMITS = Object.freeze({
    昵称: 80,
    年龄段: 32,
    性别: 48,
    性取向: 80,
    城市: 80,
    距离范围: 48,
    寻找意图: 120,
    简介: 500,
});
const TAG_FIELDS = Object.freeze(['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']);
const PLAYER_MINIMUM_FIELDS = Object.freeze(['年龄段', '性别', '性取向', '城市', '距离范围', '寻找意图']);

function isPlainRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/** Reads an own enumerable data property only; getters and inherited data are ignored. */
function ownData(record, key) {
    if (!isPlainRecord(record)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined;
    return descriptor.value;
}

function cleanText(value, maxLength, { allowEmpty = true } = {}) {
    if (typeof value !== 'string') return allowEmpty ? '' : null;
    const text = value.trim();
    if ((!allowEmpty && !text) || text.length > maxLength || CONTROL_CHARACTER_PATTERN.test(text) || HTML_PATTERN.test(text)) return null;
    return text;
}

function cleanTags(value) {
    if (!Array.isArray(value)) return Object.freeze([]);
    const tags = [];
    for (const raw of value) {
        const tag = cleanText(raw, 32);
        if (tag && !tags.includes(tag)) tags.push(tag);
        if (tags.length >= MAX_PUBLIC_TAGS) break;
    }
    return Object.freeze(tags);
}

function freezePublicProfile(profile) {
    const projected = {};
    for (const [key, maxLength] of Object.entries(PUBLIC_TEXT_LIMITS)) {
        const text = cleanText(ownData(profile, key), maxLength);
        projected[key] = text ?? '';
    }
    for (const key of TAG_FIELDS) projected[key] = cleanTags(ownData(profile, key));
    return Object.freeze(projected);
}

/**
 * Returns the only editable-draft data permitted to reach the completion model.
 * Avatar references are deliberately never projected, including data URLs.
 */
export function buildCharacterCompletionContext({ publicProfile, instruction } = {}) {
    if (!isPlainRecord(publicProfile)) return null;
    const safeInstruction = cleanText(instruction, MAX_INSTRUCTION_LENGTH, { allowEmpty: false });
    if (safeInstruction === null) return null;
    return Object.freeze({
        instruction: safeInstruction,
        editingPublicProfile: freezePublicProfile(publicProfile),
    });
}

/**
 * Returns the minimum player-facing public context permitted to reach the full-authoring model.
 * It deliberately excludes player nickname, avatar, biography, all private layers, and all state.
 */
export function buildCharacterAuthoringContext({ creativeBrief, contentMode, playerPublicProfile } = {}) {
    if (!isPlainRecord(playerPublicProfile) || !['SFW', 'NSFW'].includes(contentMode)) return null;
    const safeBrief = cleanText(creativeBrief, MAX_INSTRUCTION_LENGTH, { allowEmpty: false });
    if (safeBrief === null) return null;

    const player = {};
    for (const key of PLAYER_MINIMUM_FIELDS) {
        const value = cleanText(ownData(playerPublicProfile, key), PUBLIC_TEXT_LIMITS[key]);
        player[key] = value ?? '';
    }
    for (const key of TAG_FIELDS) player[key] = cleanTags(ownData(playerPublicProfile, key));

    return Object.freeze({
        creativeBrief: safeBrief,
        contentMode,
        playerPublicMatchContext: Object.freeze(player),
    });
}

function makeCandidateContract() {
    return [
        '只输出一个合法 JSON 对象，不得使用 Markdown、代码块或解释文字。',
        '对象不得带 UID、Patch、路径、命令、模板 ID 或任何密钥，且必须严格包含：成人验证、公开资料、仅好友资料、隐藏资料、偏好与边界、拒绝阈值、已读不回阈值、取消匹配阈值、拉黑阈值、与玩家关系。',
        '候选必须明确是成年人：成人验证为 true，隐藏资料.实际年龄为 18–120 的整数，公开资料.年龄段不得表示未成年人。与玩家关系.状态必须为“陌生”。',
        '公开资料.头像引用必须为空字符串；不要输出 data URL、图片二进制或任何头像内容。软件层只用于线上文字聊天，不能演绎线下性行为；NSFW 也不表示默认同意。',
    ].join('\n');
}

function makeCompletionMessages(context, promptPreset) {
    const preset = renderPromptPreset(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你是现代现实都市线上约会软件的角色资料补全助手。仅依据下方“编辑中公开资料”和“补全说明”补全一名新角色。',
        '不得索取、复述或泄露输入中的现有私密草稿；但可以为新候选生成完整的仅好友资料、隐藏资料和其他私有层。不得输出已有候选、会话、玩家资料、API Key 或任何密钥。',
        makeCandidateContract(),
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `请只根据以下受限输入生成完整角色草稿：\n${JSON.stringify(context)}` },
    ];
}

function makeAuthoringMessages(context, promptPreset) {
    const preset = renderPromptPreset(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你是现代现实都市线上约会软件的完整角色创作助手。仅依据安全创作说明、当前 SFW/NSFW 模式和最小玩家公开匹配上下文，创作一名新的成年角色。',
        '不得索取、复述或泄露输入中未提供的玩家私密资料；但可以为新候选生成完整的仅好友资料、隐藏资料和其他私有层。不得输出玩家昵称、头像、简介、已有候选、会话、UID、Patch、路径、API Key 或任何密钥。',
        makeCandidateContract(),
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `请只根据以下受限输入生成完整角色草稿：\n${JSON.stringify(context)}` },
    ];
}

function parseCandidateJson(raw) {
    if (typeof raw !== 'string' || raw.length < 2 || raw.length > MAX_MODEL_RESPONSE_CHARS) return null;
    try {
        const parsed = JSON.parse(raw);
        return isPlainRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function invalidResult(errors, key) {
    return { ok: false, code: `character_authoring_${key}`, message: errors[key] };
}

async function generateCandidate({ errors, context, settingsStore, llmClient, signal, makeMessages }) {
    if (!context) return invalidResult(errors, 'input_invalid');
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return invalidResult(errors, 'settings_unavailable');
    if (!llmClient || typeof llmClient.chat !== 'function') return invalidResult(errors, 'llm_unavailable');

    let resolved;
    try {
        resolved = settingsStore.resolveFunction('character_authoring');
    } catch {
        return invalidResult(errors, 'settings_invalid');
    }
    if (!resolved?.connectionPreset) return invalidResult(errors, 'connection_missing');

    try {
        const completion = await llmClient.chat({
            preset: resolved.connectionPreset,
            messages: makeMessages(context, resolved.promptPreset),
            signal,
        });
        const parsed = parseCandidateJson(completion?.text);
        if (!parsed) return invalidResult(errors, 'invalid_json');
        const candidate = normalizeGeneratedCandidate(parsed);
        // Generated or supplied avatar references must never be adopted by an AI draft.
        candidate.公开资料.头像引用 = '';
        return { ok: true, candidate };
    } catch (error) {
        if (error instanceof TypeError && typeof error.code === 'string') return invalidResult(errors, 'response_invalid');
        const publicError = toPublicLlmError(error);
        return { ok: false, code: publicError.code, message: publicError.message, retryable: publicError.retryable };
    }
}

/**
 * Calls the shared character_authoring binding to fill a new candidate from an editable
 * public-profile projection only. It performs no MVU, UID, patch, storage, or template work.
 */
export async function generateCharacterCompletionCandidate({ publicProfile, instruction, settingsStore, llmClient, signal } = {}) {
    const context = buildCharacterCompletionContext({ publicProfile, instruction });
    return generateCandidate({ errors: COMPLETION_ERRORS, context, settingsStore, llmClient, signal, makeMessages: makeCompletionMessages });
}

/**
 * Calls the shared character_authoring binding to create a new candidate from a safe brief,
 * current content mode, and minimal public player match context. The result stays in memory.
 */
export async function generateCharacterAuthoringCandidate({ creativeBrief, contentMode, playerPublicProfile, settingsStore, llmClient, signal } = {}) {
    const context = buildCharacterAuthoringContext({ creativeBrief, contentMode, playerPublicProfile });
    return generateCandidate({ errors: AUTHORING_ERRORS, context, settingsStore, llmClient, signal, makeMessages: makeAuthoringMessages });
}



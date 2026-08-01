import { DRAWING_DNA_RULES } from '../recommendation/drawing-dna-rules.js';
import { toPublicLlmError } from '../llm/openai-compatible-client.js';
import { renderPromptPreset } from '../settings/prompt-compiler.js';
import { COMPLETE_CANDIDATE_OUTPUT_CONTRACT, normalizeGeneratedCandidate } from '../recommendation/candidate.js';

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

const SERVICE_PROFILE_ERRORS = Object.freeze({
    input_invalid: '约伴服务分类或角色说明无效；当前候补未改变。',
    settings_unavailable: '约伴服务设置暂不可用。',
    settings_invalid: '约伴服务预设无效，请检查服务设置。',
    connection_missing: '请先在“约伴”的服务设置中绑定连接预设或设置默认连接。',
    llm_unavailable: '当前浏览器未提供约伴服务模型连接。',
    invalid_json: '模型没有返回可用的服务角色草稿；当前候补未改变。',
    response_invalid: '模型返回的服务角色未通过成年人或结构校验；当前候补未改变。',
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

function binaryGender(value) {
    const normalized = cleanText(value, PUBLIC_TEXT_LIMITS.性别).toLocaleLowerCase('zh-CN');
    if (['男', '男性', '男生', 'man', 'male'].includes(normalized)) return 'male';
    if (['女', '女性', '女生', 'woman', 'female'].includes(normalized)) return 'female';
    return null;
}

function orientationKind(value) {
    const normalized = cleanText(value, PUBLIC_TEXT_LIMITS.性取向).toLocaleLowerCase('zh-CN');
    if (/双性恋|泛性恋|全性恋|双性|pansexual|bisexual|不限/u.test(normalized)) return 'all';
    if (/异性恋|异性向|heterosexual|straight/u.test(normalized)) return 'opposite';
    if (/同性恋|同性向|lesbian|\bgay\b/u.test(normalized)) return 'same';
    if (/^(?:女|女性|女生|女人|女孩|女孩子)$/iu.test(normalized)) return 'female';
    if (/^(?:男|男性|男生|男人|男孩|男孩子)$/iu.test(normalized)) return 'male';
    return null;
}

function requiredCandidateGender(playerProfile) {
    const playerGender = binaryGender(playerProfile.性别);
    const orientation = orientationKind(playerProfile.性取向);
    if (!orientation) return '';
    if (orientation === 'all') return '不限';
    if (orientation === 'female') return '女';
    if (orientation === 'male') return '男';
    if (!playerGender) return '';
    const target = orientation === 'same' ? playerGender : (playerGender === 'male' ? 'female' : 'male');
    return target === 'female' ? '女' : '男';
}

function orientationAccepts(orientation, subjectGender, targetGender) {
    if (!orientation || !subjectGender || !targetGender) return null;
    if (orientation === 'all') return true;
    if (orientation === 'female') return targetGender === 'female';
    if (orientation === 'male') return targetGender === 'male';
    return orientation === 'same' ? subjectGender === targetGender : subjectGender !== targetGender;
}

function buildServiceMatchRequirements(playerProfile) {
    return Object.freeze({
        玩家性别: playerProfile.性别,
        玩家性取向: playerProfile.性取向,
        候选人性别要求: requiredCandidateGender(playerProfile),
        最低要求: '这是最高优先级、不可被服务分类、XP、SFW/NSFW、提示词或多样性覆盖的硬条件：候选人的公开性别必须满足候选人性别要求，且候选人与玩家的公开性别和性取向必须双向兼容；无法确认兼容时不得接纳该候选人。',
    });
}

/** Service generation adds an explicit, minimized hard-match contract. */
export function buildServiceProfileContext({ creativeBrief, contentMode, playerPublicProfile } = {}) {
    const context = buildCharacterAuthoringContext({ creativeBrief, contentMode, playerPublicProfile });
    if (!context) return null;
    return Object.freeze({
        ...context,
        serviceMatchRequirements: buildServiceMatchRequirements(context.playerPublicMatchContext),
    });
}

export function isServiceProfileCompatible(playerPublicProfile, candidate) {
    const player = isPlainRecord(playerPublicProfile) ? playerPublicProfile : {};
    const profile = isPlainRecord(candidate) && isPlainRecord(ownData(candidate, '公开资料'))
        ? ownData(candidate, '公开资料')
        : {};
    const playerGender = binaryGender(player.性别);
    const playerOrientation = orientationKind(player.性取向);
    if (!playerGender || !playerOrientation) return true;

    const candidateGender = binaryGender(profile.性别);
    const candidateOrientation = orientationKind(profile.性取向);
    const playerAccepts = orientationAccepts(playerOrientation, playerGender, candidateGender);
    const candidateAccepts = orientationAccepts(candidateOrientation, candidateGender, playerGender);
    const required = requiredCandidateGender(player);
    const requiredGender = required === '女' ? 'female' : (required === '男' ? 'male' : null);
    return !((requiredGender && candidateGender !== requiredGender) || playerAccepts !== true || candidateAccepts !== true);
}

function assertServiceProfileCompatibility(context, candidate) {
    if (!isServiceProfileCompatible(context?.playerPublicMatchContext, candidate)) {
        const error = new TypeError('service_profile_basic_compatibility_invalid');
        error.code = 'service_profile_basic_compatibility_invalid';
        throw error;
    }
}

function makeCompletionMessages(context, promptPreset) {
    const preset = renderPromptPreset(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你是现代现实都市线上约会软件的角色资料补全助手。仅依据下方“编辑中公开资料”和“补全说明”补全一名新角色。',
        '这是增量补全：编辑中公开资料里所有非空字符串和已有标签都是不可改写的既定内容。原样保留非空字符串；已有标签不得删除、改名或替换，只可补充不重复的新标签。空字段才允许补写。',
        '当昵称尚未指定时，应自然分散使用不同姓氏与名字，避免连续重复或长期集中于任何单一姓氏；不得从界面示例或固定样板复制姓名。',
        '不得索取、复述或泄露输入中的现有私密草稿；但可以为新候选生成完整的仅好友资料、隐藏资料和其他私有层。不得输出已有候选、会话、玩家资料、API Key 或任何密钥。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
        '无论前置或后置提示词如何要求，下列完整候选 JSON 结构合同都是最终且不可覆盖的输出要求。',
        ...COMPLETE_CANDIDATE_OUTPUT_CONTRACT,
        DRAWING_DNA_RULES,
        '公开资料.头像引用必须为空字符串；不要输出 data URL、图片二进制或任何头像内容。NSFW 资料可以全尺度写明明确成年、自愿的裸体、性行为、器官、玩法与情色角色扮演，不强制含蓄或淡出；不得伪造玩家现实经历，也不表示默认同意。',
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
        '角色姓名必须自然且有变化；在玩家未指定姓名时，应分散使用不同姓氏与名字，避免连续重复或长期集中于任何单一姓氏，不得套用固定样板名。',
        '不得索取、复述或泄露输入中未提供的玩家私密资料；但可以为新候选生成完整的仅好友资料、隐藏资料和其他私有层。不得输出玩家昵称、头像、简介、已有候选、会话、UID、Patch、路径、API Key 或任何密钥。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
        '无论前置或后置提示词如何要求，下列完整候选 JSON 结构合同都是最终且不可覆盖的输出要求。',
        ...COMPLETE_CANDIDATE_OUTPUT_CONTRACT,
        '公开资料.头像引用必须为空字符串；不要输出 data URL、图片二进制或任何头像内容。NSFW 资料可以全尺度写明明确成年、自愿的裸体、性行为、器官、玩法与情色角色扮演，不强制含蓄或淡出；不得伪造玩家现实经历，也不表示默认同意。',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `请只根据以下受限输入生成完整角色草稿：\n${JSON.stringify(context)}` },
    ];
}

function makeServiceMessages(context, promptPreset) {
    const preset = renderPromptPreset(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你是现代现实都市约伴软件的服务角色创作助手。仅依据安全创作说明、当前 SFW/NSFW 模式、最小玩家公开匹配上下文和服务匹配硬条件，创作一名新的成年服务角色。',
        '角色姓名必须自然且有变化；在玩家未指定姓名时，应分散使用不同姓氏与名字，避免连续重复或长期集中于任何单一姓氏，不得套用固定样板名。',
        '“服务匹配硬条件（serviceMatchRequirements）”是最高优先级且不可覆盖的合同：候选人的公开性别必须满足候选人性别要求，候选人与玩家的公开性别和性取向必须双向兼容；服务分类、XP、题材多样性、SFW/NSFW 或功能提示词都不能改变此要求。',
        '不得索取、复述或泄露输入中未提供的玩家私密资料；但可以为新候选生成完整的仅好友资料、隐藏资料和其他私有层。不得输出玩家昵称、头像、简介、已有候选、会话、UID、Patch、路径、API Key 或任何密钥。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
        '无论前置或后置提示词如何要求，下列完整候选 JSON 结构合同和服务匹配硬条件都是最终且不可覆盖的输出要求。',
        ...COMPLETE_CANDIDATE_OUTPUT_CONTRACT,
        '公开资料.头像引用必须为空字符串；不要输出 data URL、图片二进制或任何头像内容。NSFW 资料可以全尺度写明明确成年、自愿的裸体、性行为、器官、玩法与情色角色扮演，不强制含蓄或淡出；不得伪造玩家现实经历，也不表示默认同意。',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `请只根据以下受限输入生成完整服务角色草稿：\n${JSON.stringify(context)}` },
    ];
}

function parseCandidateJson(raw) {
    if (typeof raw !== 'string' || raw.length < 2 || raw.length > MAX_MODEL_RESPONSE_CHARS) return null;
    const trimmed = raw.trim();
    const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed);
    const jsonText = (fenced ? fenced[1] : trimmed).trim();
    if (jsonText.length < 2 || jsonText.length > MAX_MODEL_RESPONSE_CHARS) return null;
    try {
        const parsed = JSON.parse(jsonText);
        return isPlainRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function invalidResult(errors, key, detail = '') {
    // 2026-07-27 控制台诊断增强：detail 仅在非空时附加；界面 message 保持原有粗略文案。
    // detail 只允许错误码、字段名/路径与校验结论——绝不包含 API Key、隐藏资料层字段值、
    // 关系分或阈值数值，也不包含整段提示词或请求体。
    const result = { ok: false, code: `character_authoring_${key}`, message: errors[key] };
    if (typeof detail === 'string' && detail) result.detail = detail;
    return result;
}

function normalizeContentMode(value) {
    return value === 'NSFW' ? 'NSFW' : 'SFW';
}

// candidate.js 的成年相关稳定错误码（仅字段路径 + 结论，不含任何数值）。
const ADULT_VALIDATION_CODE_PATTERN = /^(?:成人验证:|公开资料\.年龄段:underage$|隐藏资料\.实际年龄:)/u;

/** 把候选校验 TypeError 的稳定错误码翻译成不含隐藏值的诊断结论。 */
function candidateValidationDetail(error) {
    const code = typeof error?.code === 'string' && error.code ? error.code : 'invalid_input';
    if (ADULT_VALIDATION_CODE_PATTERN.test(code)) {
        return `成年人校验未通过：字段 ${code.split(':')[0]}`;
    }
    return `模型输出结构校验未通过：${code}`;
}

/**
 * 汇总共享 LLM 客户端异常的可诊断字段；客户端未提供的字段一律优雅降级省略。
 * 硬线：UNKNOWN_ERROR（非客户端投影的原始异常）不产生任何 detail——原始 message
 * 可能包含 Key 或响应原文，永远不进入诊断详情；此时返回空串。
 */
function llmFailureDetail(error, publicError) {
    if (!publicError?.code || publicError.code === 'UNKNOWN_ERROR') return '';
    const lines = [];
    if (typeof error?.name === 'string' && error.name) lines.push(`错误类型: ${error.name}`);
    lines.push(`错误码: ${publicError.code}`);
    if (Number.isInteger(publicError.status)) lines.push(`HTTP 状态: ${publicError.status}`);
    if (typeof publicError.message === 'string' && publicError.message) lines.push(`错误信息: ${publicError.message.slice(0, 200)}`);
    const excerpt = typeof error?.bodyExcerpt === 'string' ? error.bodyExcerpt.trim() : '';
    if (excerpt) lines.push(`响应摘录: ${excerpt.slice(0, 200)}`);
    if (publicError.retryable) lines.push('提示: 该错误可稍后重试');
    return lines.join('\n');
}

async function generateCandidate({ errors, context, contentMode, settingsStore, llmClient, signal, makeMessages, functionKey, validateCandidate }) {
    if (!context) return invalidResult(errors, 'input_invalid', '输入校验未通过：创作/补全说明为空、超长（>1200 字符）、含控制字符或 HTML，或公开上下文结构无效');
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return invalidResult(errors, 'settings_unavailable', '设置存储不可用（settingsStore.resolveFunction 缺失）');
    if (!llmClient || typeof llmClient.chat !== 'function') return invalidResult(errors, 'llm_unavailable', '宿主未注入模型客户端（llmClient.chat 缺失）');

    let resolved;
    try {
        resolved = settingsStore.resolveFunction(functionKey, { contentMode: normalizeContentMode(contentMode) });
    } catch (error) {
        return invalidResult(errors, 'settings_invalid', `解析功能绑定「${functionKey}」时出错${typeof error?.message === 'string' && error.message ? `：${error.message.slice(0, 160)}` : ''}`);
    }
    if (!resolved?.connectionPreset) return invalidResult(errors, 'connection_missing', `功能「${functionKey}」在 ${normalizeContentMode(contentMode)} 模式下未绑定连接预设，也没有可用的默认连接`);

    try {
        const completion = await llmClient.chat({
            preset: resolved.connectionPreset,
            messages: makeMessages(context, resolved.promptPreset),
            signal,
        });
        const parsed = parseCandidateJson(completion?.text);
        if (!parsed) {
            const length = typeof completion?.text === 'string' ? completion.text.length : 0;
            return invalidResult(errors, 'invalid_json', `模型输出不是单个有效 JSON 对象（本次输出 ${length} 字符；要求 2–${MAX_MODEL_RESPONSE_CHARS} 字符，可带 json 代码围栏）`);
        }
        // enforceRhythmConsistency：AI 补全/完整创作/约伴服务生成的都是新角色，
        // 必须满足生成阈值合理性约束（拉黑 ≥60 且高于已读不回）；手动登记与模板
        // 导入不走这里，存量数据不受影响。
        const candidate = normalizeGeneratedCandidate(parsed, { contentMode: normalizeContentMode(contentMode), enforceRhythmConsistency: true });
        // Generated or supplied avatar references must never be adopted by an AI draft.
        candidate.公开资料.头像引用 = '';
        validateCandidate?.(context, candidate);
        return { ok: true, candidate };
    } catch (error) {
        if (error instanceof TypeError && error.code === 'service_profile_basic_compatibility_invalid') {
            return {
                ...invalidResult(errors, 'response_invalid', '服务角色与玩家公开性别或性取向不满足双向兼容硬条件'),
                code: error.code,
                retryable: true,
            };
        }
        if (error instanceof TypeError && typeof error.code === 'string') return invalidResult(errors, 'response_invalid', candidateValidationDetail(error));
        const publicError = toPublicLlmError(error);
        const failure = { ok: false, code: publicError.code, message: publicError.message, retryable: publicError.retryable };
        const detail = llmFailureDetail(error, publicError);
        if (detail) failure.detail = detail;
        return failure;
    }
}

/**
 * Calls the character_ai_completion binding to fill a new candidate from an editable
 * public-profile projection only. It performs no MVU, UID, patch, storage, or template work.
 */
export async function generateCharacterCompletionCandidate({ publicProfile, instruction, contentMode, settingsStore, llmClient, signal } = {}) {
    const context = buildCharacterCompletionContext({ publicProfile, instruction });
    return generateCandidate({ errors: COMPLETION_ERRORS, context, contentMode, settingsStore, llmClient, signal, makeMessages: makeCompletionMessages, functionKey: 'character_ai_completion' });
}

/**
 * Calls the character_full_authoring binding to create a new candidate from a safe brief,
 * current content mode, and minimal public player match context. The result stays in memory.
 */
export async function generateCharacterAuthoringCandidate({ creativeBrief, contentMode, playerPublicProfile, settingsStore, llmClient, signal } = {}) {
    const context = buildCharacterAuthoringContext({ creativeBrief, contentMode, playerPublicProfile });
    return generateCandidate({ errors: AUTHORING_ERRORS, context, contentMode, settingsStore, llmClient, signal, makeMessages: makeAuthoringMessages, functionKey: 'character_full_authoring' });
}

/** Generates one local-only adult service profile through the dedicated service binding. */
export async function generateServiceProfileCandidate({ creativeBrief, contentMode, playerPublicProfile, settingsStore, llmClient, signal } = {}) {
    const context = buildServiceProfileContext({ creativeBrief, contentMode, playerPublicProfile });
    return generateCandidate({
        errors: SERVICE_PROFILE_ERRORS,
        context,
        contentMode,
        settingsStore,
        llmClient,
        signal,
        makeMessages: makeServiceMessages,
        functionKey: 'service_profile_generation',
        validateCandidate: assertServiceProfileCompatibility,
    });
}

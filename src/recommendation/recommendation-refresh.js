import { DRAWING_DNA_RULES } from './drawing-dna-rules.js';
import { toPublicLlmError } from '../llm/openai-compatible-client.js';
import { renderPromptPreset } from '../settings/prompt-compiler.js';
import { COMPLETE_CANDIDATE_OUTPUT_CONTRACT, normalizeGeneratedCandidate } from './candidate.js';
import {
    RECOMMENDATION_DIAGNOSTIC_SCOPES,
    clearRecommendationDiagnostics,
    describeModelResponseForDiagnostics,
    recordRecommendationDiagnostics,
    snapshotErrorForDiagnostics,
} from './recommendation-diagnostics.js';

const MAX_RESPONSE_CHARS = 20_000;
// A complete candidate contains several required nested records.  The old
// connection-panel default (800) can cut off otherwise valid JSON before its
// closing brace, so recommendation refreshes always request this minimum while
// still honoring a user preset that asks for more.
const RECOMMENDATION_MIN_MAX_TOKENS = 2_048;

const PUBLIC_TAG_CONTRACTS = Object.freeze({
    SFW: Object.freeze({
        mode: 'SFW',
        allowedTagCategories: Object.freeze(['常规兴趣', '生活方式', '性格', '沟通风格']),
        forbidden: Object.freeze(['未成年人', '非自愿或胁迫', '隐私标识', '线下性行为演绎']),
    }),
    NSFW: Object.freeze({
        mode: 'NSFW',
        allowedTagCategories: Object.freeze(['常规兴趣', '生活方式', '性格', '沟通风格', '成年人明确自愿的成人取向或身体偏好公开资料']),
        forbidden: Object.freeze(['未成年人', '非自愿或胁迫', '隐私标识', '线下性行为演绎']),
    }),
});

const PUBLIC_TAG_FIELDS = Object.freeze(['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']);
const MAX_RECENT_TAGS = 24;

function contentModeOf(state) {
    return state?.软件?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW';
}
function ownRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, maxLength = 160) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function cleanTags(value) {
    if (!Array.isArray(value)) return [];
    const tags = [];
    for (const item of value) {
        const tag = cleanText(item, 32);
        if (tag && !tags.includes(tag)) tags.push(tag);
        if (tags.length >= 12) break;
    }
    return tags;
}

function safeWeightRecord(value) {
    if (!ownRecord(value)) return {};
    const result = {};
    for (const [tag, weight] of Object.entries(value)) {
        const cleanTag = cleanText(tag, 40);
        if (cleanTag && Number.isInteger(weight) && weight >= -5 && weight <= 5) result[cleanTag] = weight;
    }
    return result;
}

function deviceKeywordWeights(personalization, contentMode) {
    if (!ownRecord(personalization)) return null;
    if (personalization.enabled !== true) return {};
    const result = {};
    const byMode = ownRecord(personalization.keywordWeightsByMode) ? personalization.keywordWeightsByMode : {};
    const selected = byMode[contentMode === 'NSFW' ? 'NSFW' : 'SFW'];
    if (!Array.isArray(selected)) return result;
    for (const item of selected) {
        if (!ownRecord(item)) continue;
        const keyword = cleanText(item.keyword, 40);
        if (keyword && Number.isInteger(item.weight) && item.weight >= -5 && item.weight <= 5) result[keyword] = item.weight;
    }
    return result;
}

function candidatePublicTags(profile) {
    const publicProfile = ownRecord(profile?.公开资料) ? profile.公开资料 : {};
    const tags = [];
    for (const field of PUBLIC_TAG_FIELDS) {
        for (const tag of cleanTags(publicProfile[field])) {
            if (!tags.includes(tag)) tags.push(tag);
        }
    }
    return tags;
}

function recentRecommendationTags(state) {
    const recommendation = ownRecord(state?.推荐) ? state.推荐 : {};
    const candidatePool = ownRecord(recommendation.临时候选池) ? recommendation.临时候选池 : {};
    const rolePool = ownRecord(state?.角色池) ? state.角色池 : {};
    const queue = Array.isArray(recommendation.当前队列) ? recommendation.当前队列 : [];
    const cooldown = Array.isArray(recommendation.冷却角色UID) ? recommendation.冷却角色UID.slice(-8) : [];
    const tags = [];
    for (const uid of [...queue, ...cooldown]) {
        if (typeof uid !== 'string') continue;
        for (const tag of candidatePublicTags(candidatePool[uid] ?? rolePool[uid])) {
            if (!tags.includes(tag)) tags.push(tag);
            if (tags.length >= MAX_RECENT_TAGS) return Object.freeze(tags);
        }
    }
    return Object.freeze(tags);
}

function recommendationOrdinal(state) {
    const counter = state?.系统?.UID计数器?.角色;
    return Number.isInteger(counter) && counter >= 0 ? counter + 1 : 1;
}

function buildRecommendationPolicy(state, weights) {
    const ordered = Object.entries(weights)
        .sort(([leftTag, leftWeight], [rightTag, rightWeight]) => rightWeight - leftWeight || leftTag.localeCompare(rightTag, 'zh-Hans-CN'));
    const ordinal = recommendationOrdinal(state);
    const positiveTags = ordered.filter(([, weight]) => weight > 0).map(([tag]) => tag);
    const suppressedTags = ordered.filter(([, weight]) => weight < 0).map(([tag]) => tag);
    return Object.freeze({
        mode: positiveTags.length ? 'adaptive_exploration' : 'open_exploration',
        ordinal,
        softPreferredTags: Object.freeze(positiveTags.slice(0, 12)),
        suppressedTags: Object.freeze(suppressedTags.slice(0, 8)),
        recentlyShownTags: recentRecommendationTags(state),
    });
}

function policyInstructions(policy) {
    const instructions = [
        `本轮系统推荐策略为“${policy.mode === 'adaptive_exploration' ? '偏好驱动的开放探索' : '开放探索'}”（第 ${policy.ordinal} 次刷新）。`,
        '关键词词库不是固定主题表。请基于角色本身自然生成天马行空、具体而安全的公开兴趣、生活方式、性格与沟通标签；可以出现任意新的短标签，绝不能只从既有词库、示例或旧候选中挑选。',
        '词库中的权重是软性相关度：正权重越高，越值得自然地提高出现概率；0 表示尚未学习、保持完全开放；负权重表示应降低出现概率。任何权重都不是硬筛选，不能让角色画像失去新鲜感或多样性。',
        '候选人的职业面要宽：白领、创作者与手艺人之外，也自然出现急诊护士、地铁调度、法医、殡葬师、宠物殡葬、飞行签派、汉服造型师、非遗手作、电竞教练、有声书主播、无人机飞手、深夜便利店店长、船员、茶艺师、消防员这类具体而少见的职业（以上仅为开阔思路的举例，不是可选清单，不要照抄）。',
        '性格与生活方式允许真实的反差与瑕疵：外冷内热、职业理性但恋爱笨拙、白天严谨晚上沙雕、社恐但话痨于文字、爱冒险却恋家；生活方式可覆盖夜班作息、独居养宠、极简或收藏癖、公路旅行、晨泳、菜市场爱好者等不同节奏，让每位候选人像有来处的具体的人，而不是完美人设模板。',
    ];
    if (policy.softPreferredTags.length) instructions.push(`当前正权重关键词：${policy.softPreferredTags.join('、')}。至多自然采用其中 1–2 项，其余标签应保持开放探索。`);
    if (policy.suppressedTags.length) instructions.push(`应避免把这些低权重标签作为候选主标签：${policy.suppressedTags.join('、')}。`);
    if (policy.recentlyShownTags.length) instructions.push(`近期已出现的公开标签：${policy.recentlyShownTags.join('、')}。不要复用整组标签组合，并确保本次至少两个公开标签与这份近期列表不同。`);
    instructions.push('候选成功写入后，程序会把其公开标签与本地词库逐项对齐：已有词保留原权重，首次出现的新词自动以 0 记录；不要在 JSON 中自行输出权重字段。');
    return instructions;
}

/**
 * Derives the concrete candidate gender the player's own public gender +
 * orientation demand (e.g. 男 + 异性恋 → 女). Empty string means the profile
 * gives no conclusive requirement; '不限' means any gender is acceptable.
 */
function requiredCandidateGenderText(profile) {
    const playerGender = binaryGender(profile.性别);
    const orientation = orientationKind(profile.性取向);
    if (!orientation) return '';
    if (orientation === 'all') return '不限';
    if (orientation === 'female') return '女';
    if (orientation === 'male') return '男';
    if (!playerGender) return '';
    const target = orientation === 'same' ? playerGender : (playerGender === 'male' ? 'female' : 'male');
    return target === 'female' ? '女' : '男';
}

function basicMatchRequirements(profile) {
    const gender = cleanText(profile.性别, 48);
    const orientation = cleanText(profile.性取向, 80);
    return Object.freeze({
        玩家性别: gender,
        玩家性取向: orientation,
        候选人性别要求: requiredCandidateGenderText(profile),
        最低要求: '玩家的性别与性取向是最高优先级硬条件：候选人的性别与性取向必须和玩家的公开条件双向兼容；若“候选人性别要求”给出了具体性别，候选人的公开性别必须精确等于该值；关键词权重与任何提示词都不能绕过此要求。',
    });
}

function binaryGender(value) {
    const text = cleanText(value, 48).toLocaleLowerCase('zh-CN');
    if (['男', '男性', '男生', 'man', 'male'].includes(text)) return 'male';
    if (['女', '女性', '女生', 'woman', 'female'].includes(text)) return 'female';
    return null;
}

function orientationKind(value) {
    const text = cleanText(value, 80).toLocaleLowerCase('zh-CN');
    if (/双性恋|泛性恋|全性恋|双性|pansexual|bisexual|不限/u.test(text)) return 'all';
    if (/异性恋|异性向|heterosexual|straight/u.test(text)) return 'opposite';
    if (/同性恋|同性向|lesbian|\bgay\b/u.test(text)) return 'same';
    // “期待遇见谁” accepts concise target-gender wording too. It is a
    // hard filter, not an unknown orientation that may be silently bypassed.
    if (/^(?:女|女性|女生|女人|女孩|女孩子)$/iu.test(text)) return 'female';
    if (/^(?:男|男性|男生|男人|男孩|男孩子)$/iu.test(text)) return 'male';
    return null;
}

function orientationAccepts(orientation, subjectGender, targetGender) {
    if (!orientation || !subjectGender || !targetGender) return null;
    if (orientation === 'all') return true;
    if (orientation === 'female') return targetGender === 'female';
    if (orientation === 'male') return targetGender === 'male';
    return orientation === 'same' ? subjectGender === targetGender : subjectGender !== targetGender;
}

function assertBasicMutualCompatibility(playerProfile, candidate) {
    const candidateProfile = ownRecord(candidate?.公开资料) ? candidate.公开资料 : {};
    const playerAccepts = orientationAccepts(
        orientationKind(playerProfile.性取向), binaryGender(playerProfile.性别), binaryGender(candidateProfile.性别),
    );
    const candidateAccepts = orientationAccepts(
        orientationKind(candidateProfile.性取向), binaryGender(candidateProfile.性别), binaryGender(playerProfile.性别),
    );
    // When the player's own public gender/orientation is a common explicit
    // value, a generated candidate must prove reciprocal compatibility. An
    // unknown candidate orientation cannot silently pass that hard contract.
    const playerHasExplicitRequirement = Boolean(binaryGender(playerProfile.性别) && orientationKind(playerProfile.性取向));
    if (playerAccepts === false || candidateAccepts === false || (playerHasExplicitRequirement && (playerAccepts !== true || candidateAccepts !== true))) {
        const error = new TypeError('recommendation_basic_compatibility_invalid');
        error.code = 'recommendation_basic_compatibility_invalid';
        throw error;
    }
}

function readDevicePersonalization(settingsStore) {
    if (!settingsStore || typeof settingsStore.snapshot !== 'function') return undefined;
    try {
        return settingsStore.snapshot()?.personalization;
    } catch {
        return undefined;
    }
}

/** Builds the only player context that may be disclosed to the fast recommender. */
export function buildRecommendationContext(state, { devicePersonalization } = {}) {
    const player = ownRecord(state?.玩家) ? state.玩家 : {};
    const profile = ownRecord(player.公开资料) ? player.公开资料 : {};
    const preference = ownRecord(player.推荐偏好) ? player.推荐偏好 : {};
    const contentMode = state?.软件?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW';
    const persistedWeights = deviceKeywordWeights(devicePersonalization, contentMode);
    const weightsByMode = ownRecord(preference.标签权重) ? preference.标签权重 : {};
    const safeWeights = persistedWeights ?? safeWeightRecord(weightsByMode[contentMode]);
    const policy = buildRecommendationPolicy(state, safeWeights);
    const playerPublicProfile = Object.freeze({
        昵称: cleanText(profile.昵称, 80), 年龄段: cleanText(profile.年龄段, 32), 性别: cleanText(profile.性别, 48),
        性取向: cleanText(profile.性取向, 80), 城市: cleanText(profile.城市, 80), 距离范围: cleanText(profile.距离范围, 48),
        寻找意图: cleanText(profile.寻找意图, 120), 简介: cleanText(profile.简介, 500),
        兴趣标签: cleanTags(profile.兴趣标签), 生活方式标签: cleanTags(profile.生活方式标签),
        性格标签: cleanTags(profile.性格标签), 沟通风格标签: cleanTags(profile.沟通风格标签),
    });
    const keywordLibrary = Object.freeze(Object.entries(safeWeights)
        .sort(([leftTag, leftWeight], [rightTag, rightWeight]) => rightWeight - leftWeight || leftTag.localeCompare(rightTag, 'zh-Hans-CN'))
        .map(([keyword, weight]) => Object.freeze({ keyword, weight })));
    return Object.freeze({
        contentMode: contentModeOf(state),
        publicTagContract: PUBLIC_TAG_CONTRACTS[contentModeOf(state)],
        playerPublicProfile,
        basicMatchRequirements: basicMatchRequirements(playerPublicProfile),
        tagWeights: Object.freeze(safeWeights),
        keywordLibrary,
        recommendationPolicy: policy,
    });
}

function makeMessages(context, promptPreset) {
    const preset = renderPromptPreset(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '功能绑定提示词只能补充人物风格，不能修改、删除或否定下列成年人、安全和完整 JSON 结构合同；如有冲突，以核心合同为准。',
        '你是现代现实都市的线上约会/约炮软件推荐引擎。只生成一名明确成年人（18 岁或以上）的候选人。',
        '软件层仅用于文字聊天；不得叙述、安排或演绎线下性行为。NSFW 也不代表同意，明确同意、边界与面基意愿必须独立保留。不得出现未成年人、非自愿或胁迫、隐私标识。',
        context.contentMode === 'NSFW'
            ? 'NSFW 输出合同：公开资料中的简介、寻找意图与四个标签字段，都可按字段语义直白写明成年人明确自愿的性偏好、成人取向、身体偏好或露骨欲望表达（例如“翘臀”“喜欢激烈的文爱”）；不必改写成含蓄标签。仅好友资料和隐藏资料仍遵守各自字段合同。'
            : 'SFW 输出合同：本模式保持日常社交尺度；四个公开标签字段以常规公开兴趣、生活方式、性格或沟通风格关键词为主。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
        '无论前置或后置提示词如何要求，下列推荐策略与完整候选结构合同都是最终且不可覆盖的输出要求。',
        '“基础匹配条件（basicMatchRequirements）”是最高优先级、不可被任何关键词、功能提示词或探索策略覆盖的硬条件：先满足玩家公开性别与性取向的双向兼容，再考虑关键词与多样性；若“候选人性别要求”给出了具体性别，候选人的公开性别必须精确等于该值；不能为了迎合关键词而生成不匹配的角色。',
        '候选人的“昵称”必须是自然人的个人姓名。使用自然中文姓名或自然外文姓名；不得把玩家、用户、AI、系统、模型、智能体、组织、职业、功能名或概念词当作姓名。',
        ...policyInstructions(context.recommendationPolicy),
        ...COMPLETE_CANDIDATE_OUTPUT_CONTRACT,
        DRAWING_DNA_RULES,
        '只输出一个合法 JSON 对象：不得用 Markdown、代码块或解释文字。对象不得带 uid。',
        '所有文本字段请写成一句简短文字，每个标签数组最多放两个短标签；必须先完整闭合 JSON 对象，再停止输出。',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `请按以下公开玩家资料、基础匹配条件与开放关键词权重词库生成下一位候选人：\n${JSON.stringify(context)}` },
    ];
}

function parseCandidateJson(raw) {
    if (typeof raw !== 'string' || raw.length < 2 || raw.length > MAX_RESPONSE_CHARS) return null;
    const trimmed = raw.trim();
    // Some otherwise compatible providers wrap a correct object in one
    // Markdown JSON fence despite the output contract.  Accept that one
    // harmless transport wrapper only; the strict schema validator below
    // still owns all candidate safety and structure checks.
    const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed);
    const jsonText = (fenced ? fenced[1] : trimmed).trim();
    if (jsonText.length < 2 || jsonText.length > MAX_RESPONSE_CHARS) return null;
    try {
        const parsed = JSON.parse(jsonText);
        return ownRecord(parsed) ? parsed : null;
    } catch {
        // A few compatible providers still prepend/append a short natural-
        // language sentence despite the strict output contract.  Recover only
        // one balanced root object; the normalizer below remains the authority
        // for the candidate schema, adult checks, privacy boundaries, and keys.
        const candidates = [];
        for (let start = 0; start < jsonText.length; start += 1) {
            if (jsonText[start] !== '{') continue;
            let depth = 0;
            let inString = false;
            let escaped = false;
            let end = -1;
            for (let index = start; index < jsonText.length; index += 1) {
                const char = jsonText[index];
                if (inString) {
                    if (escaped) escaped = false;
                    else if (char === '\\') escaped = true;
                    else if (char === '"') inString = false;
                    continue;
                }
                if (char === '"') {
                    inString = true;
                    continue;
                }
                if (char === '{') depth += 1;
                else if (char === '}') {
                    depth -= 1;
                    if (depth === 0) {
                        end = index;
                        break;
                    }
                    if (depth < 0) break;
                }
            }
            if (end < 0) continue;
            const fragment = jsonText.slice(start, end + 1);
            try {
                const parsed = JSON.parse(fragment);
                if (ownRecord(parsed)) candidates.push({ start, end, parsed });
            } catch {
                // Ignore prose braces and malformed fragments; a unique valid
                // root object can still be considered below.
            }
        }
        const roots = candidates.filter((candidate) => !candidates.some((other) => (
            other.start < candidate.start && other.end > candidate.end
        )));
        return roots.length === 1 ? roots[0].parsed : null;
    }
}

const REFRESH_DIAGNOSTIC_SCOPE = RECOMMENDATION_DIAGNOSTIC_SCOPES.recommendationRefresh;

function recordRefreshFailure(code, diagnostics = {}) {
    recordRecommendationDiagnostics(REFRESH_DIAGNOSTIC_SCOPE, { code, ...diagnostics });
}

/** 从候选校验错误码（形如 公开资料.年龄段:underage）拆出字段路径与原因。 */
function splitCandidateValidationCode(code) {
    const separator = code.indexOf(':');
    if (separator <= 0) return { field: undefined, reason: code };
    return { field: code.slice(0, separator), reason: code.slice(separator + 1) };
}

/**
 * Calls only the configured fast model, validates its JSON completely, and returns
 * a candidate in memory. This function never writes MVU state; callers commit only
 * after a successful full result through the controlled patch boundary.
 */
export async function generateRecommendationCandidate({ state, settingsStore, llmClient, signal } = {}) {
    clearRecommendationDiagnostics(REFRESH_DIAGNOSTIC_SCOPE);
    if (!ownRecord(state)) {
        recordRefreshFailure('recommendation_state_invalid', { stage: '前置检查', hint: '软件状态快照不可用，等待 MVU 就绪后重试' });
        return { ok: false, code: 'recommendation_state_invalid', message: '当前软件状态无法用于生成推荐。' };
    }
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') {
        recordRefreshFailure('recommendation_settings_unavailable', { stage: '前置检查', hint: '设置存储未注入或不可用' });
        return { ok: false, code: 'recommendation_settings_unavailable', message: '推荐刷新设置暂不可用。' };
    }
    if (!llmClient || typeof llmClient.chat !== 'function') {
        recordRefreshFailure('recommendation_llm_unavailable', { stage: '前置检查', hint: '未注入可用的 LLM 客户端' });
        return { ok: false, code: 'recommendation_llm_unavailable', message: '当前浏览器未提供快速模型连接。' };
    }

    let resolved;
    try { resolved = settingsStore.resolveFunction('recommendation_refresh', { contentMode: contentModeOf(state) }); }
    catch (error) {
        recordRefreshFailure('recommendation_settings_invalid', {
            stage: '解析功能绑定', error: snapshotErrorForDiagnostics(error),
            hint: '检查“推荐刷新”的连接预设与提示词绑定设置',
        });
        return { ok: false, code: 'recommendation_settings_invalid', message: '推荐刷新预设无效，请检查设置。' };
    }
    if (!resolved.connectionPreset) {
        recordRefreshFailure('recommendation_connection_missing', {
            stage: '解析功能绑定', field: 'recommendation_refresh.connectionPreset',
            hint: '未绑定连接预设且无默认连接；请到设置页为“推荐刷新”绑定连接',
        });
        return { ok: false, code: 'recommendation_connection_missing', message: '请先为“推荐刷新”绑定连接预设或设置默认连接。' };
    }

    let stage = '构建请求上下文';
    try {
        const context = buildRecommendationContext(state, { devicePersonalization: readDevicePersonalization(settingsStore) });
        stage = '请求快速模型';
        const completion = await llmClient.chat({
            preset: resolved.connectionPreset,
            messages: makeMessages(context, resolved.promptPreset),
            maxTokens: Math.max(RECOMMENDATION_MIN_MAX_TOKENS, resolved.connectionPreset.maxTokens),
            signal,
        });
        stage = '解析模型响应';
        const parsed = parseCandidateJson(completion?.text);
        if (!parsed) {
            recordRefreshFailure('recommendation_invalid_json', {
                stage, expected: '单个完整的候选 JSON 对象',
                actual: describeModelResponseForDiagnostics(completion?.text, MAX_RESPONSE_CHARS),
            });
            return { ok: false, code: 'recommendation_invalid_json', message: '快速模型没有返回可用的候选资料；当前推荐未改变。' };
        }
        stage = '候选结构与成年人校验';
        const candidate = normalizeGeneratedCandidate(parsed, { contentMode: context.contentMode, requirePersonalName: true });
        assertBasicMutualCompatibility(context.playerPublicProfile, candidate);
        return { ok: true, candidate };
    } catch (error) {
        if (error instanceof TypeError && typeof error.code === 'string') {
            // 校验错误码只含字段路径与原因；隐藏层与阈值字段仅报字段名，绝不带值。
            const { field, reason } = splitCandidateValidationCode(error.code);
            recordRefreshFailure(error.code, {
                stage: '候选结构与成年人校验', field,
                actual: `校验未通过（${reason}）`,
                hint: '模型输出未满足候选结构合同；可重试或调整提示词预设',
            });
            return { ok: false, code: error.code, message: '快速模型返回的候选资料未通过成年人或结构校验；当前推荐未改变。' };
        }
        const publicError = toPublicLlmError(error);
        recordRefreshFailure(publicError.code, {
            stage, error: snapshotErrorForDiagnostics(error) ?? snapshotErrorForDiagnostics(publicError),
            hint: publicError.retryable ? '该错误可重试' : undefined,
        });
        return { ok: false, code: publicError.code, message: publicError.message };
    }
}




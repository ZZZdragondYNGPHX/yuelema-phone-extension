import { toPublicLlmError } from '../llm/openai-compatible-client.js';
import { renderPromptPreset } from '../settings/prompt-compiler.js';
import { normalizeGeneratedCandidate } from './candidate.js';

const MAX_RESPONSE_CHARS = 20_000;

const PUBLIC_TAG_CONTRACTS = Object.freeze({
    SFW: Object.freeze({
        mode: 'SFW',
        allowedTagCategories: Object.freeze(['常规兴趣', '生活方式', '性格', '沟通风格']),
        forbidden: Object.freeze(['成人取向或身体性化关键词', '未成年人', '非自愿或胁迫', '隐私标识', '线下性行为演绎']),
        examples: Object.freeze(['电影', '宅家', '御姐', '慢热']),
    }),
    NSFW: Object.freeze({
        mode: 'NSFW',
        allowedTagCategories: Object.freeze(['常规兴趣', '生活方式', '性格', '沟通风格', '成年人明确自愿的成人取向或身体偏好公开标签']),
        forbidden: Object.freeze(['未成年人', '非自愿或胁迫', '隐私标识', '线下性行为演绎']),
        examples: Object.freeze(['电影', '御姐', '翘臀', '情趣探索']),
    }),
});

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

/** Builds the only player context that may be disclosed to the fast recommender. */
export function buildRecommendationContext(state) {
    const player = ownRecord(state?.玩家) ? state.玩家 : {};
    const profile = ownRecord(player.公开资料) ? player.公开资料 : {};
    const preference = ownRecord(player.推荐偏好) ? player.推荐偏好 : {};
    const weights = ownRecord(preference.标签权重) ? preference.标签权重 : {};
    const safeWeights = {};
    for (const [tag, weight] of Object.entries(weights)) {
        const cleanTag = cleanText(tag, 64);
        if (cleanTag && Number.isInteger(weight) && weight >= -5 && weight <= 5) safeWeights[cleanTag] = weight;
    }
    return Object.freeze({
        contentMode: contentModeOf(state),
        publicTagContract: PUBLIC_TAG_CONTRACTS[contentModeOf(state)],
        playerPublicProfile: Object.freeze({
            昵称: cleanText(profile.昵称, 80), 年龄段: cleanText(profile.年龄段, 32), 性别: cleanText(profile.性别, 48),
            性取向: cleanText(profile.性取向, 80), 城市: cleanText(profile.城市, 80), 距离范围: cleanText(profile.距离范围, 48),
            寻找意图: cleanText(profile.寻找意图, 120), 简介: cleanText(profile.简介, 500),
            兴趣标签: cleanTags(profile.兴趣标签), 生活方式标签: cleanTags(profile.生活方式标签),
            性格标签: cleanTags(profile.性格标签), 沟通风格标签: cleanTags(profile.沟通风格标签),
        }),
        tagWeights: Object.freeze(safeWeights),
    });
}

function makeMessages(context, promptPreset) {
    const preset = renderPromptPreset(promptPreset);
    const system = [
        preset.before ? `功能绑定提示词（前置条目）：\n${preset.before}` : '',
        '你是现代现实都市的线上约会/约炮软件推荐引擎。只生成一名明确成年人（18 岁或以上）的候选人。',
        '软件层仅用于文字聊天；不得叙述、安排或演绎线下性行为。NSFW 也不代表同意，明确同意、边界与面基意愿必须独立保留。不得出现未成年人、非自愿或胁迫、隐私标识。',
        context.contentMode === 'NSFW'
            ? 'NSFW 输出合同：四个公开标签字段可包含成年人明确自愿的成人取向或身体偏好关键词（例如“翘臀”“情趣探索”），但这类词只能作为公开标签；不得写入简介、寻找意图、好友资料或隐藏资料。'
            : 'SFW 输出合同：四个公开标签字段只允许常规公开兴趣、生活方式、性格或沟通风格关键词；不得包含成人取向、身体性化或露骨关键词。',
        '只输出一个合法 JSON 对象：不得用 Markdown、代码块或解释文字。对象不得带 uid，且必须严格包含：成人验证、公开资料、仅好友资料、隐藏资料、偏好与边界、拒绝阈值、已读不回阈值、取消匹配阈值、拉黑阈值、与玩家关系。',
        '与玩家关系.状态必须为“陌生”；隐藏资料.实际年龄必须是 18–120 的整数；公开资料不得包含私密层字段。',
        preset.after ? `功能绑定提示词（后置条目）：\n${preset.after}` : '',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: `请按以下公开玩家资料与偏好生成下一位候选人：\n${JSON.stringify(context)}` },
    ];
}

function parseCandidateJson(raw) {
    if (typeof raw !== 'string' || raw.length < 2 || raw.length > MAX_RESPONSE_CHARS) return null;
    try {
        const parsed = JSON.parse(raw);
        return ownRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Calls only the configured fast model, validates its JSON completely, and returns
 * a candidate in memory. This function never writes MVU state; callers commit only
 * after a successful full result through the controlled patch boundary.
 */
export async function generateRecommendationCandidate({ state, settingsStore, llmClient, signal } = {}) {
    if (!ownRecord(state)) return { ok: false, code: 'recommendation_state_invalid', message: '当前软件状态无法用于生成推荐。' };
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return { ok: false, code: 'recommendation_settings_unavailable', message: '推荐刷新设置暂不可用。' };
    if (!llmClient || typeof llmClient.chat !== 'function') return { ok: false, code: 'recommendation_llm_unavailable', message: '当前浏览器未提供快速模型连接。' };

    let resolved;
    try { resolved = settingsStore.resolveFunction('recommendation_refresh'); }
    catch { return { ok: false, code: 'recommendation_settings_invalid', message: '推荐刷新预设无效，请检查设置。' }; }
    if (!resolved.connectionPreset) return { ok: false, code: 'recommendation_connection_missing', message: '请先为“推荐刷新”绑定连接预设或设置默认连接。' };

    try {
        const context = buildRecommendationContext(state);
        const completion = await llmClient.chat({
            preset: resolved.connectionPreset,
            messages: makeMessages(context, resolved.promptPreset),
            signal,
        });
        const parsed = parseCandidateJson(completion?.text);
        if (!parsed) return { ok: false, code: 'recommendation_invalid_json', message: '快速模型没有返回可用的候选资料；当前推荐未改变。' };
        const candidate = normalizeGeneratedCandidate(parsed, { contentMode: context.contentMode });
        return { ok: true, candidate };
    } catch (error) {
        if (error instanceof TypeError && typeof error.code === 'string') {
            return { ok: false, code: error.code, message: '快速模型返回的候选资料未通过成年人或结构校验；当前推荐未改变。' };
        }
        const publicError = toPublicLlmError(error);
        return { ok: false, code: publicError.code, message: publicError.message };
    }
}




import {
    MATCH_ACCEPTANCE_THRESHOLD,
    scoreHeartCardCompatibility,
    scoreKeywordOnlyCandidateMatch,
    scoreLocalCandidateMatch,
} from './match-scoring.js';

const TAG_FIELDS = Object.freeze(['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']);

function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function folded(value) {
    return typeof value === 'string' ? value.trim().toLocaleLowerCase('zh-Hans-CN') : '';
}

function normalizedWeights(value) {
    const result = {};
    if (Array.isArray(value)) {
        for (const item of value) {
            const entry = record(item);
            const keyword = folded(entry.keyword);
            if (keyword && Number.isInteger(entry.weight) && entry.weight >= -5 && entry.weight <= 5) {
                result[keyword] = entry.weight;
            }
        }
        return result;
    }
    for (const [rawKeyword, weight] of Object.entries(record(value))) {
        const keyword = folded(rawKeyword);
        if (keyword && Number.isInteger(weight) && weight >= -5 && weight <= 5) result[keyword] = weight;
    }
    return result;
}

function savedWeights(state, settingsStore) {
    const mode = state?.软件?.内容模式 === 'NSFW' ? 'NSFW' : 'SFW';
    try {
        const device = settingsStore?.snapshot?.()?.personalization?.keywordWeightsByMode?.[mode];
        if (Array.isArray(device)) return normalizedWeights(device);
    } catch {
        // Browser-local personalization is optional; MVU public tag weights are the safe fallback.
    }
    return normalizedWeights(state?.玩家?.推荐偏好?.标签权重?.[mode]);
}

function positiveKeywordMatches(profile, weights) {
    const matches = [];
    for (const field of TAG_FIELDS) {
        for (const value of Array.isArray(profile?.[field]) ? profile[field] : []) {
            const keyword = folded(value);
            if (keyword && weights[keyword] > 0 && !matches.includes(keyword)) matches.push(keyword);
        }
    }
    return matches;
}

function explicitProfileRequirement(profile) {
    const gender = folded(profile?.性别);
    const orientation = folded(profile?.性取向);
    return Boolean(gender && orientation);
}

/**
 * Finds an authored `npc_custom_*` candidate entirely on-device.
 * At least one positive saved keyword must match exactly; neutral weights never
 * force a created character to appear. Adult/schema checks remain owned by the
 * controlled state boundary, and a conclusive gender/orientation conflict is
 * never eligible.
 */
export function selectCustomCandidateEncounter(state, {
    settingsStore = null,
    effectiveKeywordWeights,
    keywordOnly = false,
    allowQueued = false,
} = {}) {
    const candidatePool = record(state?.推荐?.临时候选池);
    const playerProfile = record(state?.玩家?.公开资料);
    const weights = normalizedWeights(effectiveKeywordWeights ?? savedWeights(state, settingsStore));
    const excluded = new Set([
        ...(!allowQueued && Array.isArray(state?.推荐?.当前队列) ? state.推荐.当前队列 : []),
        ...(Array.isArray(state?.推荐?.冷却角色UID) ? state.推荐.冷却角色UID : []),
        ...(Array.isArray(state?.推荐?.不喜欢角色UID) ? state.推荐.不喜欢角色UID : []),
        ...(Array.isArray(state?.推荐?.拉黑角色UID) ? state.推荐.拉黑角色UID : []),
    ]);
    const matches = [];
    for (const [uid, candidate] of Object.entries(candidatePool)) {
        if (!/^npc_custom_\d+$/u.test(uid) || excluded.has(uid) || candidate?.成人验证 !== true) continue;
        const profile = record(candidate?.公开资料);
        const positiveMatches = positiveKeywordMatches(profile, weights);
        if (!positiveMatches.length) continue;
        const heart = scoreHeartCardCompatibility(playerProfile, profile);
        if (!heart.eligible || (explicitProfileRequirement(playerProfile) && !heart.reasons.includes('性别与性取向相容'))) continue;
        const evaluation = keywordOnly
            ? scoreKeywordOnlyCandidateMatch(profile, weights)
            : scoreLocalCandidateMatch(playerProfile, profile, weights);
        if (!evaluation.eligible || evaluation.score < MATCH_ACCEPTANCE_THRESHOLD) continue;
        matches.push(Object.freeze({
            uid,
            candidate,
            score: evaluation.score,
            keywordScore: evaluation.keywordScore,
            positiveMatches: Object.freeze(positiveMatches),
        }));
    }
    matches.sort((left, right) => right.score - left.score
        || right.positiveMatches.length - left.positiveMatches.length
        || left.uid.localeCompare(right.uid, 'en'));
    return matches[0] ?? null;
}

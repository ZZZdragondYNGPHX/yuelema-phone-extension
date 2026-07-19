/**
 * Deterministic, explainable first-pass matching score.
 *
 * This module deliberately reads only public profile fields.  It does not use
 * friends-only or hidden data and never performs a network/model call.  A
 * character's configured refusal threshold decides whether the computed
 * two-layer score yields an immediate mutual match.
 */
const TAG_FIELDS = Object.freeze(['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']);

function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function comparable(value) {
    return text(value).toLocaleLowerCase('zh-Hans-CN');
}

function intentOverlaps(left, right) {
    const a = comparable(left);
    const b = comparable(right);
    return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function publicTagSet(profile) {
    const tags = new Set();
    for (const field of TAG_FIELDS) {
        for (const value of Array.isArray(profile[field]) ? profile[field] : []) {
            const normalized = comparable(value);
            if (normalized) tags.add(normalized);
        }
    }
    return tags;
}

function clampInteger(value, lower, upper) {
    return Math.min(Math.max(Math.round(value), lower), upper);
}

/**
 * Returns the NPC-exclusive compatibility score (0..100) and an explanatory,
 * non-sensitive public basis.  The basis is not stored in MVU in v1; it exists
 * for tests and later UI explanations only.
 */
export function scorePublicCompatibility(playerProfile, npcProfile) {
    const player = record(playerProfile);
    const npc = record(npcProfile);
    let score = 30;
    const reasons = [];

    const playerCity = comparable(player.城市);
    const npcCity = comparable(npc.城市);
    if (playerCity && npcCity && playerCity === npcCity) {
        score += 15;
        reasons.push('同城');
    }
    if (intentOverlaps(player.寻找意图, npc.寻找意图)) {
        score += 20;
        reasons.push('寻找意图相近');
    }

    const playerTags = publicTagSet(player);
    const npcTags = publicTagSet(npc);
    let sharedTags = 0;
    for (const tag of playerTags) if (npcTags.has(tag)) sharedTags += 1;
    if (sharedTags > 0) {
        score += Math.min(sharedTags, 4) * 9;
        reasons.push(`公开标签重合 ${Math.min(sharedTags, 4)} 项`);
    }

    return Object.freeze({
        npcSpecificScore: clampInteger(score, 0, 100),
        reasons: Object.freeze(reasons),
    });
}

/** Combines global account performance and this NPC's public compatibility. */
export function scoreTwoLayerMatch(globalAccountScore, npcSpecificScore) {
    if (!Number.isInteger(globalAccountScore) || globalAccountScore < 0 || globalAccountScore > 100) return null;
    if (!Number.isInteger(npcSpecificScore) || npcSpecificScore < 0 || npcSpecificScore > 100) return null;
    return clampInteger((globalAccountScore * 0.55) + (npcSpecificScore * 0.45), 0, 100);
}

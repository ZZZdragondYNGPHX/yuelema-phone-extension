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

function firstAge(value) {
    const match = text(value).match(/\d{1,3}/u);
    const age = match ? Number(match[0]) : NaN;
    return Number.isInteger(age) && age >= 18 && age <= 120 ? age : null;
}

function genderKind(value) {
    const normalized = comparable(value);
    if (/(?:女|female|woman)/iu.test(normalized)) return 'female';
    if (/(?:男|male|man)/iu.test(normalized)) return 'male';
    return '';
}

function orientationAllows(sourceGender, sourceOrientation, targetGender) {
    const orientation = comparable(sourceOrientation);
    if (!orientation || !sourceGender || !targetGender) return null;
    if (/(?:双性|泛性|bisexual|\bbi\b|pansexual|\bpan\b|不限|开放)/iu.test(orientation)) return true;
    if (/(?:异性恋|heterosexual|\bhetero\b|straight)/iu.test(orientation)) return sourceGender !== targetGender;
    if (/(?:同性恋|lesbian|\bgay\b|homosexual)/iu.test(orientation)) return sourceGender === targetGender;
    return null;
}

function profileTags(profile) {
    return [...publicTagSet(profile)];
}

function normalizedWeightMap(value) {
    const result = new Map();
    if (Array.isArray(value)) {
        for (const item of value) {
            const entry = record(item);
            const tag = comparable(entry.keyword);
            const weight = entry.weight;
            if (tag && Number.isInteger(weight) && weight >= -5 && weight <= 5) result.set(tag, weight);
        }
        return result;
    }
    const source = record(value);
    for (const [rawTag, rawWeight] of Object.entries(source)) {
        const tag = comparable(rawTag);
        if (tag && Number.isInteger(rawWeight) && rawWeight >= -5 && rawWeight <= 5) result.set(tag, rawWeight);
    }
    return result;
}

/**
 * Scores the creation-form “heart card” fields only.  A conclusive reciprocal
 * gender/orientation mismatch is a hard local refusal condition; unknown or
 * non-binary values remain neutral rather than being guessed.
 */
export function scoreHeartCardCompatibility(playerProfile, npcProfile) {
    const player = record(playerProfile);
    const npc = record(npcProfile);
    const playerGender = genderKind(player.性别);
    const npcGender = genderKind(npc.性别);
    const npcAllowsPlayer = orientationAllows(npcGender, npc.性取向, playerGender);
    const playerAllowsNpc = orientationAllows(playerGender, player.性取向, npcGender);
    if (npcAllowsPlayer === false || playerAllowsNpc === false) {
        return Object.freeze({ score: 0, eligible: false, reasons: Object.freeze(['性别或性取向不匹配']) });
    }

    let score = 20;
    const reasons = [];
    if (npcAllowsPlayer === true && playerAllowsNpc === true) {
        score += 30;
        reasons.push('性别与性取向相容');
    } else score += 15;
    if (comparable(player.城市) && comparable(player.城市) === comparable(npc.城市)) {
        score += 15;
        reasons.push('同城');
    }
    if (intentOverlaps(player.寻找意图, npc.寻找意图)) {
        score += 15;
        reasons.push('寻找意图相近');
    }
    const playerAge = firstAge(player.年龄段);
    const npcAge = firstAge(npc.年龄段);
    if (playerAge !== null && npcAge !== null && Math.abs(playerAge - npcAge) <= 12) {
        score += 5;
        reasons.push('年龄段接近');
    }
    if (text(player.距离范围) && text(npc.距离范围)) {
        score += 5;
        reasons.push('相遇距离已填写');
    }
    return Object.freeze({ score: clampInteger(score, 0, 100), eligible: true, reasons: Object.freeze(reasons) });
}

/**
 * Scores a candidate's four public keyword sets against both the player card
 * and the locally learned -5..5 preference weights.  Newly seen tags (weight
 * 0) stay neutral, while shared tags still contribute to a first invitation.
 */
export function scoreKeywordCompatibility(playerProfile, npcProfile, tagWeights) {
    const playerTags = publicTagSet(playerProfile);
    const npcTags = profileTags(npcProfile);
    if (!npcTags.length) return Object.freeze({ score: 50, sharedTags: 0 });
    const weights = normalizedWeightMap(tagWeights);
    let sharedTags = 0;
    let weightTotal = 0;
    for (const tag of npcTags) {
        if (playerTags.has(tag)) sharedTags += 1;
        weightTotal += 50 + ((weights.get(tag) ?? 0) * 10);
    }
    const learnedScore = weightTotal / npcTags.length;
    const overlapScore = (sharedTags / npcTags.length) * 100;
    return Object.freeze({ score: clampInteger((learnedScore * 0.6) + (overlapScore * 0.4), 0, 100), sharedTags });
}

/**
 * Scores an AI-generated match candidate entirely on-device.  The model may
 * propose only the candidate's public profile; it has no authority over this
 * result.  A conclusive public gender/orientation mismatch remains a hard
 * refusal, while public heart-card compatibility (60%) and the effective
 * keyword weights for this match run (40%) provide the final 0..100 score.
 */
export function scoreLocalCandidateMatch(playerProfile, npcProfile, effectiveKeywordWeights) {
    const heartCard = scoreHeartCardCompatibility(playerProfile, npcProfile);
    const keywords = scoreKeywordCompatibility(playerProfile, npcProfile, effectiveKeywordWeights);
    const score = heartCard.eligible
        ? clampInteger((heartCard.score * 0.6) + (keywords.score * 0.4), 0, 100)
        : 0;
    const reasons = [...heartCard.reasons];
    if (keywords.sharedTags > 0) reasons.push(`公开关键词重合 ${keywords.sharedTags} 项`);
    return Object.freeze({
        score,
        eligible: heartCard.eligible,
        heartCardScore: heartCard.score,
        keywordScore: keywords.score,
        sharedTags: keywords.sharedTags,
        reasons: Object.freeze(reasons),
    });
}

/**
 * The explicit acceptance score for a player-initiated private-chat request
 * from the favourites list.  It combines local keyword taste (40%) with the
 * complete public heart-card fields (60%); it never reads private/hidden data.
 */
export function scoreFavoritePrivateChatInvitation(playerProfile, npcProfile, tagWeights) {
    const heartCard = scoreHeartCardCompatibility(playerProfile, npcProfile);
    const keywords = scoreKeywordCompatibility(playerProfile, npcProfile, tagWeights);
    const score = heartCard.eligible
        ? clampInteger((heartCard.score * 0.6) + (keywords.score * 0.4), 0, 100)
        : 0;
    return Object.freeze({
        score,
        eligible: heartCard.eligible,
        heartCardScore: heartCard.score,
        keywordScore: keywords.score,
        reasons: heartCard.reasons,
    });
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

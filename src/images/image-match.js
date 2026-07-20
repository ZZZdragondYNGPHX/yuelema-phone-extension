const PUBLIC_SCALAR_FIELDS = Object.freeze([
    '昵称', '年龄段', '性别', '性取向', '城市', '距离范围', '寻找意图', '简介',
]);
const PUBLIC_ARRAY_FIELDS = Object.freeze([
    '兴趣标签', '生活方式标签', '性格标签', '沟通风格标签',
]);
const PUBLIC_FIELD_ORDER = Object.freeze([...PUBLIC_SCALAR_FIELDS, ...PUBLIC_ARRAY_FIELDS]);
const ARRAY_FIELD_SET = new Set(PUBLIC_ARRAY_FIELDS);
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_KEY_PATTERN = /(?:hidden|private|friend|relationship|relation|session|candidate|uid|patch|path|api[_ -]?key|token|authorization|password|secret|隐藏|仅好友|关系|会话|候选|补丁|路径|密钥|令牌)/iu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const URL_LIKE_PATTERN = /(?:^data:|https?:\/\/|blob:)/iu;
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}_]/u;
const MAX_PROFILE_TEXT_LENGTH = 800;
const MAX_PROFILE_TAGS = 32;
const MAX_KEYWORD_LENGTH = 64;
const MAX_KEYWORD_WEIGHTS = 256;
const MAX_IMAGE_RECORDS = 512;
const MAX_MODEL_RESPONSE_CHARS = 16_000;

export const IMAGE_MATCH_WEIGHT_MIN = -5;
export const IMAGE_MATCH_WEIGHT_MAX = 5;
export const IMAGE_MATCH_ALGORITHM_VERSION = 'image-match-v1';

export class ImageMatchValidationError extends TypeError {
    constructor(code, message) {
        super(message);
        this.name = 'ImageMatchValidationError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new ImageMatchValidationError(code, message);
}

function isPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function ownData(record, key) {
    if (!isPlainRecord(record) || !Object.prototype.hasOwnProperty.call(record, key)) return undefined;
    return record[key];
}

function canonicalText(value) {
    return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-Hans-CN');
}

function cleanText(value, field, maxLength = MAX_PROFILE_TEXT_LENGTH) {
    if (typeof value !== 'string') fail('public_profile_invalid', `${field}必须是文本。`);
    const cleaned = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (!cleaned || cleaned.length > maxLength || CONTROL_CHARACTER_PATTERN.test(cleaned)) {
        fail('public_profile_invalid', `${field}长度或字符不符合要求。`);
    }
    return cleaned;
}

function cleanKeyword(value, code = 'keyword_invalid') {
    if (typeof value !== 'string') fail(code, '关键词必须是文本。');
    const cleaned = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (!cleaned || cleaned.length > MAX_KEYWORD_LENGTH || CONTROL_CHARACTER_PATTERN.test(cleaned) || URL_LIKE_PATTERN.test(cleaned)) {
        fail(code, '关键词长度或字符不符合要求。');
    }
    return cleaned;
}

function cleanImageId(value) {
    if (typeof value !== 'string') fail('image_record_invalid', '图片 ID 必须是文本。');
    const cleaned = value.normalize('NFKC').trim();
    if (!cleaned || cleaned.length > 128 || CONTROL_CHARACTER_PATTERN.test(cleaned)) {
        fail('image_record_invalid', '图片 ID 长度或字符不符合要求。');
    }
    return cleaned;
}

function freezeKeywordWeights(entries) {
    return Object.freeze(entries.map((entry) => Object.freeze({ keyword: entry.keyword, weight: entry.weight })));
}

function normalizeAllowedVocabulary(value) {
    if (!Array.isArray(value) || value.length > MAX_KEYWORD_WEIGHTS) {
        fail('allowed_keywords_invalid', '允许关键词词表必须是有限数组。');
    }
    const byCanonical = new Map();
    for (const raw of value) {
        const keyword = cleanKeyword(raw, 'allowed_keywords_invalid');
        const canonical = canonicalText(keyword);
        const previous = byCanonical.get(canonical);
        if (!previous || keyword.localeCompare(previous, 'zh-Hans-CN') < 0) byCanonical.set(canonical, keyword);
    }
    return new Map([...byCanonical.entries()].sort(([left], [right]) => left.localeCompare(right, 'zh-Hans-CN')));
}

function assertExactRecord(value, allowedKeys, code) {
    if (!isPlainRecord(value)) fail(code, '模型结果必须使用普通 JSON 对象。');
    const keys = Object.keys(value);
    for (const key of keys) {
        if (FORBIDDEN_OBJECT_KEYS.has(key) || SENSITIVE_KEY_PATTERN.test(key)) {
            fail('llm_sensitive_key_forbidden', '模型结果包含不允许的敏感字段。');
        }
    }
    if (keys.length !== allowedKeys.length || allowedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
        fail(code, '模型结果包含缺失或额外字段。');
    }
}

/**
 * Reads only the known public-profile keys. Unknown keys are deliberately not
 * traversed, so callers cannot accidentally leak a full candidate/state object.
 */
export function projectImageMatchPublicProfile(candidatePublicProfile) {
    if (!isPlainRecord(candidatePublicProfile)) fail('public_profile_invalid', '候选人公开资料必须是对象。');
    const result = Object.create(null);
    for (const field of PUBLIC_FIELD_ORDER) {
        const raw = ownData(candidatePublicProfile, field);
        if (raw === undefined || raw === null || raw === '') continue;
        if (!ARRAY_FIELD_SET.has(field)) {
            result[field] = cleanText(raw, field);
            continue;
        }
        if (!Array.isArray(raw) || raw.length > MAX_PROFILE_TAGS) {
            fail('public_profile_invalid', `${field}必须是短文本数组。`);
        }
        const byCanonical = new Map();
        for (const item of raw) {
            const tag = cleanText(item, field, MAX_KEYWORD_LENGTH);
            byCanonical.set(canonicalText(tag), tag);
        }
        result[field] = Object.freeze([...byCanonical.entries()]
            .sort(([left], [right]) => left.localeCompare(right, 'zh-Hans-CN'))
            .map(([, tag]) => tag));
    }
    return Object.freeze(result);
}

export function normalizeImageKeywordWeights(value, { allowedKeywords = null, requireItems = false } = {}) {
    if (!Array.isArray(value) || value.length > MAX_KEYWORD_WEIGHTS || (requireItems && value.length < 1)) {
        fail('keyword_weights_invalid', 'keywordWeights 必须是有限数组。');
    }
    const vocabulary = allowedKeywords === null ? null : normalizeAllowedVocabulary(allowedKeywords);
    const seen = new Set();
    const entries = [];
    for (const item of value) {
        assertExactRecord(item, ['keyword', 'weight'], 'keyword_weights_invalid');
        const keyword = cleanKeyword(ownData(item, 'keyword'));
        const canonical = canonicalText(keyword);
        const weight = ownData(item, 'weight');
        if (!Number.isInteger(weight) || weight < IMAGE_MATCH_WEIGHT_MIN || weight > IMAGE_MATCH_WEIGHT_MAX) {
            fail('keyword_weights_invalid', '关键词权重必须是 -5 到 5 的整数。');
        }
        if (seen.has(canonical)) fail('keyword_weights_duplicate', '关键词不可重复。');
        if (vocabulary && !vocabulary.has(canonical)) fail('keyword_not_allowed', '模型返回了未注册关键词。');
        seen.add(canonical);
        entries.push({ keyword: vocabulary?.get(canonical) ?? keyword, weight });
    }
    entries.sort((left, right) => canonicalText(left.keyword).localeCompare(canonicalText(right.keyword), 'zh-Hans-CN'));
    return freezeKeywordWeights(entries);
}

export function normalizeImageRecord(imageRecord) {
    if (!isPlainRecord(imageRecord)) fail('image_record_invalid', '图片记录必须是对象。');
    return Object.freeze({
        id: cleanImageId(ownData(imageRecord, 'id')),
        keywordWeights: normalizeImageKeywordWeights(ownData(imageRecord, 'keywordWeights') ?? []),
    });
}

export function normalizeImageLibrary(imageRecords) {
    if (!Array.isArray(imageRecords) || imageRecords.length > MAX_IMAGE_RECORDS) {
        fail('image_library_invalid', '图片库必须是有限数组。');
    }
    const seen = new Set();
    const normalized = imageRecords.map((record) => {
        const image = normalizeImageRecord(record);
        if (seen.has(image.id)) fail('image_id_duplicate', '图片 ID 不可重复。');
        seen.add(image.id);
        return image;
    });
    normalized.sort((left, right) => left.id.localeCompare(right.id, 'en'));
    return Object.freeze(normalized);
}

function buildProfileSegments(profile) {
    const segments = [];
    for (const field of PUBLIC_FIELD_ORDER) {
        const value = ownData(profile, field);
        if (Array.isArray(value)) {
            for (const item of value) segments.push({ canonical: canonicalText(item), exactTag: true });
        } else if (typeof value === 'string') {
            segments.push({ canonical: canonicalText(value), exactTag: false });
        }
    }
    return segments;
}

function safeSubstring(text, keyword) {
    if (text === keyword) return true;
    if (keyword.length < 2) return false;
    let offset = 0;
    while (offset <= text.length - keyword.length) {
        const index = text.indexOf(keyword, offset);
        if (index < 0) return false;
        if (CJK_PATTERN.test(keyword)) return true;
        const before = index > 0 ? text[index - 1] : '';
        const afterIndex = index + keyword.length;
        const after = afterIndex < text.length ? text[afterIndex] : '';
        if ((!before || !WORD_CHARACTER_PATTERN.test(before)) && (!after || !WORD_CHARACTER_PATTERN.test(after))) return true;
        offset = index + 1;
    }
    return false;
}

function matchKeyword(segments, keyword) {
    const canonical = canonicalText(keyword);
    if (segments.some((segment) => segment.canonical === canonical)) return 'exact';
    return segments.some((segment) => safeSubstring(segment.canonical, canonical)) ? 'substring' : null;
}

function compareMatches(left, right) {
    if (right.score !== left.score) return right.score - left.score;
    return left.imageId.localeCompare(right.imageId, 'en');
}

function freezeMatch(match) {
    return Object.freeze({
        imageId: match.imageId,
        score: match.score,
        matchedKeywords: Object.freeze([...match.matchedKeywords]),
    });
}

export function scoreImageRecordAgainstPublicProfile(candidatePublicProfile, imageRecord) {
    const profile = projectImageMatchPublicProfile(candidatePublicProfile);
    const image = normalizeImageRecord(imageRecord);
    const segments = buildProfileSegments(profile);
    let score = 0;
    let hasPositiveMatch = false;
    const matchedKeywords = [];
    for (const entry of image.keywordWeights) {
        if (!matchKeyword(segments, entry.keyword)) continue;
        if (entry.weight !== 0) matchedKeywords.push(entry.keyword);
        score += entry.weight;
        if (entry.weight > 0) hasPositiveMatch = true;
    }
    return Object.freeze({ imageId: image.id, score, hasPositiveMatch, matchedKeywords: Object.freeze(matchedKeywords) });
}

/** Returns null when no image has a net-positive score backed by a positive keyword. */
export function selectBestImageMatch(candidatePublicProfile, imageRecords) {
    const profile = projectImageMatchPublicProfile(candidatePublicProfile);
    const images = normalizeImageLibrary(imageRecords);
    const candidates = images.map((image) => scoreImageRecordAgainstPublicProfile(profile, image))
        .filter((match) => match.hasPositiveMatch && match.score > 0)
        .sort(compareMatches);
    return candidates.length > 0 ? freezeMatch(candidates[0]) : null;
}

/**
 * Scores the library from a validated LLM-produced public keyword-weight vector.
 * Only positive profile weights establish presence; negative image weights can
 * penalize a present keyword, but two negative values never create a false match.
 */
export function selectBestImageMatchFromKeywordWeights(imageRecords, keywordWeights) {
    const images = normalizeImageLibrary(imageRecords);
    const allowedKeywords = collectImageMatchKeywords(images);
    const profileWeights = normalizeImageKeywordWeights(keywordWeights, { allowedKeywords, requireItems: true });
    const byCanonical = new Map(profileWeights.map((entry) => [canonicalText(entry.keyword), entry.weight]));
    const matches = images.map((image) => {
        let score = 0;
        let hasPositiveMatch = false;
        const matchedKeywords = [];
        for (const entry of image.keywordWeights) {
            const profileWeight = byCanonical.get(canonicalText(entry.keyword)) ?? 0;
            if (profileWeight <= 0 || entry.weight === 0) continue;
            const contribution = profileWeight * entry.weight;
            score += contribution;
            if (contribution > 0) hasPositiveMatch = true;
            matchedKeywords.push(entry.keyword);
        }
        return { imageId: image.id, score, hasPositiveMatch, matchedKeywords };
    }).filter((match) => match.hasPositiveMatch && match.score > 0).sort(compareMatches);
    return matches.length > 0 ? freezeMatch(matches[0]) : null;
}

export function collectImageMatchKeywords(imageRecords) {
    const images = normalizeImageLibrary(imageRecords);
    const byCanonical = new Map();
    for (const image of images) {
        for (const entry of image.keywordWeights) {
            const canonical = canonicalText(entry.keyword);
            const previous = byCanonical.get(canonical);
            if (!previous || entry.keyword.localeCompare(previous, 'zh-Hans-CN') < 0) byCanonical.set(canonical, entry.keyword);
        }
    }
    return Object.freeze([...byCanonical.entries()]
        .sort(([left], [right]) => left.localeCompare(right, 'zh-Hans-CN'))
        .map(([, keyword]) => keyword));
}

function stableHash(text) {
    let first = 0x811c9dc5;
    let second = 0x9e3779b1;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        first ^= code;
        first = Math.imul(first, 0x01000193) >>> 0;
        second ^= code + ((index + 1) * 0x45d9f3b);
        second = Math.imul(second, 0x27d4eb2d) >>> 0;
    }
    return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

function canonicalProfileDocument(profile) {
    return PUBLIC_FIELD_ORDER.map((field) => [field, ownData(profile, field) ?? null]);
}

export function createImageMatchProfileFingerprint(candidatePublicProfile) {
    const profile = projectImageMatchPublicProfile(candidatePublicProfile);
    return `profile-v1-${stableHash(JSON.stringify(canonicalProfileDocument(profile)))}`;
}

export function createImageLibraryRevision(imageRecords) {
    const images = normalizeImageLibrary(imageRecords);
    const document = images.map((image) => [
        image.id,
        image.keywordWeights.map((entry) => [canonicalText(entry.keyword), entry.weight]),
    ]);
    return `library-v1-${stableHash(JSON.stringify(document))}`;
}

export function createImageMatchCacheKey(candidatePublicProfile, imageRecords) {
    return `${IMAGE_MATCH_ALGORITHM_VERSION}:${createImageMatchProfileFingerprint(candidatePublicProfile)}:${createImageLibraryRevision(imageRecords)}`;
}

export function buildImageMatchContextText(candidatePublicProfile, allowedKeywords) {
    const profile = projectImageMatchPublicProfile(candidatePublicProfile);
    const vocabulary = normalizeAllowedVocabulary(allowedKeywords);
    const publicDocument = Object.create(null);
    for (const field of PUBLIC_FIELD_ORDER) {
        const value = ownData(profile, field);
        if (value !== undefined) publicDocument[field] = value;
    }
    return [
        'IMAGE_MATCH_CONTEXT_V1',
        `PUBLIC_PROFILE=${JSON.stringify(publicDocument)}`,
        `ALLOWED_KEYWORDS=${JSON.stringify([...vocabulary.values()])}`,
    ].join('\n');
}

export function buildImageMatchPrompt(candidatePublicProfile, allowedKeywords) {
    const contextText = buildImageMatchContextText(candidatePublicProfile, allowedKeywords);
    const systemText = [
        '你是图片关键词匹配器。只根据给定候选人的公开资料，在允许关键词词表中评估适用程度。',
        '只输出一个严格 JSON 对象，根对象必须且仅能含 keywordWeights。',
        'keywordWeights 必须是数组；每项必须且仅能含 keyword、weight。',
        'keyword 必须逐字来自允许词表且不可重复；weight 必须是 -5 到 5 的整数。',
        '不得输出图片 ID、图片地址、UID、关系数据、隐藏资料、仅好友资料、Patch、密钥、解释、Markdown 或其他文本。',
    ].join('\n');
    return Object.freeze({
        contextText,
        messages: Object.freeze([
            Object.freeze({ role: 'system', content: systemText }),
            Object.freeze({ role: 'user', content: contextText }),
        ]),
    });
}

export function parseImageMatchLlmResponse(rawText, allowedKeywords) {
    if (typeof rawText !== 'string' || rawText.length < 2 || rawText.length > MAX_MODEL_RESPONSE_CHARS) {
        fail('llm_response_invalid_json', '模型没有返回可解析的 JSON。');
    }
    let parsed;
    try {
        parsed = JSON.parse(rawText.trim());
    } catch {
        fail('llm_response_invalid_json', '模型没有返回唯一的 JSON 对象。');
    }
    assertExactRecord(parsed, ['keywordWeights'], 'llm_response_invalid_shape');
    return normalizeImageKeywordWeights(ownData(parsed, 'keywordWeights'), { allowedKeywords, requireItems: true });
}

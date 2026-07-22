/**
 * Browser-local state for the group-chat and forum mini-apps.
 *
 * This deliberately never stores MVU objects, character/session UIDs, private
 * profiles, API keys, Patch data, or host chat metadata.  Existing MVU groups
 * are addressed here only by a deterministic key derived from their public
 * topic/description; locally created groups snapshot only public profiles.
 * The asynchronous adapter is normally SillyTavern's localforage instance.
 */

export const GROUP_FORUM_SCHEMA_ID = 'yuelema.group-forum';
export const GROUP_FORUM_SCHEMA_VERSION = 1;
export const GROUP_FORUM_STORAGE_KEY = 'yuelema.group-forum.v1';
export const MAX_LOCAL_GROUPS = 24;
export const MAX_GROUP_MESSAGES = 240;
export const MAX_FORUM_POSTS = 80;
export const MAX_POST_MESSAGES = 240;
export const MAX_CONVERSATION_SUMMARIES = 64;
export const MAX_GROUP_FORUM_SERIALIZED_BYTES = 4 * 1024 * 1024;
export const DEFAULT_GROUP_AUTO_SETTINGS = Object.freeze({ enabled: false, intervalSeconds: 30 });

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const HTML_PATTERN = /<!--|<\s*\/?\s*[a-z][^>]*>/iu;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SECRET_PATTERN = /(?:\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|(?:api[ _-]?key|authorization|access[ _-]?token|password|secret)\s*[:=])/iu;
const SOFTWARE_PATTERN = /(?:<\/?UpdateVariable\b|JSONPatch|\b(?:replaceMvuData|parseMessage|replaceVariables)\b|\/(?:角色池|玩家|会话|群组|软件|系统)\b)/iu;
const LOCAL_GROUP_ID_PATTERN = /^local_group_[1-9]\d*$/u;
const LOCAL_POST_ID_PATTERN = /^local_post_[1-9]\d*$/u;
const LOCAL_RECORD_ID_PATTERN = /^local_(?:message|summary)_[1-9]\d*$/u;
const EXTERNAL_GROUP_KEY_PATTERN = /^ext_[a-f0-9]{8}$/u;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export class GroupForumStoreError extends Error {
    constructor(code) {
        super(`group_forum_store_error:${code}`);
        this.name = 'GroupForumStoreError';
        this.code = code;
    }
}

function fail(code) {
    throw new GroupForumStoreError(code);
}

function isPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function ownData(record, key, code = 'INVALID_DOCUMENT') {
    if (!isPlainRecord(record)) fail(code);
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    return descriptor.value;
}

function assertExactObject(value, allowed, required, code = 'INVALID_DOCUMENT') {
    if (!isPlainRecord(value)) fail(code);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || DANGEROUS_KEYS.has(key) || !allowed.has(key)) fail(code);
        ownData(value, key, code);
    }
    for (const key of required) {
        if (!Object.hasOwn(value, key)) fail(code);
        ownData(value, key, code);
    }
}

function safeText(value, maxLength, { allowEmpty = false } = {}) {
    if (typeof value !== 'string') fail('INVALID_TEXT');
    const text = value.trim();
    if ((!allowEmpty && !text) || text.length > maxLength || CONTROL_CHARACTER_PATTERN.test(text)
        || HTML_PATTERN.test(text) || SECRET_PATTERN.test(text) || SOFTWARE_PATTERN.test(text)) {
        fail('INVALID_TEXT');
    }
    return text;
}

function safeOptionalText(value, maxLength) {
    if (value === undefined || value === null || value === '') return '';
    return safeText(value, maxLength);
}

function safeInteger(value, min, max, code = 'INVALID_DOCUMENT') {
    if (!Number.isInteger(value) || value < min || value > max) fail(code);
    return value;
}

function isExplicitAdultAgeRange(value) {
    const normalized = value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
    if (/(?:已验证)?成年|18\+|18岁(?:以上|起)?|成人/u.test(normalized)) return true;
    const range = normalized.match(/^(\d{1,3})(?:岁)?[-~至到](\d{1,3})(?:岁)?$/u);
    if (range) return Number(range[1]) >= 18 && Number(range[2]) >= Number(range[1]);
    const age = normalized.match(/^(\d{1,3})岁?$/u);
    return Boolean(age && Number(age[1]) >= 18);
}

function normalizeTimestamp(value) {
    if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value) || Number.isNaN(Date.parse(value))) fail('INVALID_DOCUMENT');
    return value;
}

function nowTimestamp(now) {
    let candidate;
    try { candidate = now(); } catch { fail('CLOCK_INVALID'); }
    return normalizeTimestamp(candidate instanceof Date ? candidate.toISOString() : candidate);
}

function normalizeTags(value, maxCount = 12) {
    if (!Array.isArray(value) || value.length > maxCount) fail('INVALID_PROFILE');
    const seen = new Set();
    const output = [];
    for (const item of value) {
        const tag = safeText(item, 32);
        const key = tag.normalize('NFKC').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(tag);
    }
    return output;
}

const PROFILE_ALLOWED = new Set(['nickname', 'ageRange', 'gender', 'city', 'mbti', 'zodiac', 'occupation', 'interests', 'presence', 'matchRate']);
const PROFILE_REQUIRED = new Set(['nickname', 'ageRange', 'gender', 'city', 'mbti', 'zodiac', 'occupation', 'interests', 'presence', 'matchRate']);

/** Validates the compact, entirely public profile kept for local group/forum people. */
export function normalizeGroupForumProfile(value) {
    assertExactObject(value, PROFILE_ALLOWED, PROFILE_REQUIRED, 'INVALID_PROFILE');
    const matchRate = ownData(value, 'matchRate', 'INVALID_PROFILE');
    const ageRange = safeText(ownData(value, 'ageRange', 'INVALID_PROFILE'), 32);
    if (!isExplicitAdultAgeRange(ageRange)) fail('NON_ADULT_PROFILE');
    return {
        nickname: safeText(ownData(value, 'nickname', 'INVALID_PROFILE'), 80),
        ageRange,
        gender: safeText(ownData(value, 'gender', 'INVALID_PROFILE'), 48),
        city: safeText(ownData(value, 'city', 'INVALID_PROFILE'), 80),
        mbti: safeOptionalText(ownData(value, 'mbti', 'INVALID_PROFILE'), 24),
        zodiac: safeOptionalText(ownData(value, 'zodiac', 'INVALID_PROFILE'), 32),
        occupation: safeOptionalText(ownData(value, 'occupation', 'INVALID_PROFILE'), 80),
        interests: normalizeTags(ownData(value, 'interests', 'INVALID_PROFILE')),
        presence: safeOptionalText(ownData(value, 'presence', 'INVALID_PROFILE'), 24) || '在线',
        matchRate: matchRate === null ? null : safeInteger(matchRate, 0, 100, 'INVALID_PROFILE'),
    };
}

/** Converts an already whitelisted MVU public-profile projection into local-only data. */
export function publicProfileToGroupForumProfile(value) {
    if (!isPlainRecord(value)) fail('INVALID_PROFILE');
    const read = (key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    };
    const interests = [];
    for (const key of ['兴趣标签', '生活方式标签']) {
        const source = read(key);
        if (!Array.isArray(source)) continue;
        for (const tag of source) {
            if (interests.length >= 12) break;
            try {
                const cleaned = safeText(tag, 32);
                if (!interests.includes(cleaned)) interests.push(cleaned);
            } catch { /* A malformed public tag must not enter the local cache. */ }
        }
    }
    const personality = Array.isArray(read('性格标签')) ? read('性格标签') : [];
    const mbti = personality.find((tag) => typeof tag === 'string' && /^[A-Z]{4}$/u.test(tag.trim()))?.trim() ?? '';
    const visibleOrUnknown = (raw, length) => {
        try { return safeText(raw, length); } catch { return '未填写'; }
    };
    return normalizeGroupForumProfile({
        nickname: safeText(read('昵称'), 80),
        // The source projection is built only from adult-verified characters;
        // keep that public safety fact without retaining the source UID.
        ageRange: (() => {
            try {
                const candidate = safeText(read('年龄段'), 32);
                return isExplicitAdultAgeRange(candidate) ? candidate : '已验证成年';
            } catch { return '已验证成年'; }
        })(),
        gender: visibleOrUnknown(read('性别'), 48),
        city: visibleOrUnknown(read('城市'), 80),
        mbti,
        zodiac: '',
        occupation: '',
        interests,
        presence: '在线',
        matchRate: null,
    });
}

/** Produces the field names consumed by the safe avatar renderer and local UI. */
export function groupForumProfileForDisplay(profile) {
    const value = normalizeGroupForumProfile(profile);
    return Object.freeze({
        昵称: value.nickname,
        年龄段: value.ageRange,
        性别: value.gender,
        城市: value.city,
        简介: value.occupation,
        兴趣标签: Object.freeze([...value.interests]),
        性格标签: Object.freeze([value.mbti, value.zodiac].filter(Boolean)),
        生活方式标签: Object.freeze([]),
        沟通风格标签: Object.freeze([]),
    });
}

/** Keeps model input free of UI-only internal keys and character/session IDs. */
export function groupForumProfileForModel(profile) {
    const value = normalizeGroupForumProfile(profile);
    return Object.freeze({
        nickname: value.nickname,
        ageRange: value.ageRange,
        gender: value.gender,
        city: value.city,
        mbti: value.mbti,
        zodiac: value.zodiac,
        occupation: value.occupation,
        interests: Object.freeze([...value.interests]),
        presence: value.presence,
        matchRate: value.matchRate,
    });
}

export function normalizeGroupAutoSettings(value) {
    assertExactObject(value, new Set(['enabled', 'intervalSeconds']), new Set(['enabled', 'intervalSeconds']), 'INVALID_AUTO_SETTINGS');
    if (typeof value.enabled !== 'boolean') fail('INVALID_AUTO_SETTINGS');
    return { enabled: value.enabled, intervalSeconds: safeInteger(value.intervalSeconds, 5, 3600, 'INVALID_AUTO_SETTINGS') };
}

function normalizeTargetKey(value) {
    if (typeof value !== 'string' || !(LOCAL_GROUP_ID_PATTERN.test(value) || EXTERNAL_GROUP_KEY_PATTERN.test(value))) fail('INVALID_TARGET');
    return value;
}

function normalizeMessage(value) {
    assertExactObject(value, new Set(['id', 'floor', 'sender', 'author', 'content', 'createdAt']), new Set(['id', 'floor', 'sender', 'author', 'content', 'createdAt']), 'INVALID_MESSAGE');
    const sender = ownData(value, 'sender', 'INVALID_MESSAGE');
    if (sender !== 'user' && sender !== 'member') fail('INVALID_MESSAGE');
    const author = ownData(value, 'author', 'INVALID_MESSAGE');
    if (sender === 'user' && author !== null) fail('INVALID_MESSAGE');
    if (sender === 'member' && author === null) fail('INVALID_MESSAGE');
    return {
        id: (() => {
            const id = ownData(value, 'id', 'INVALID_MESSAGE');
            if (typeof id !== 'string' || !LOCAL_RECORD_ID_PATTERN.test(id)) fail('INVALID_MESSAGE');
            return id;
        })(),
        floor: safeInteger(ownData(value, 'floor', 'INVALID_MESSAGE'), 1, 1_000_000, 'INVALID_MESSAGE'),
        sender,
        author: sender === 'member' ? normalizeGroupForumProfile(author) : null,
        content: safeText(ownData(value, 'content', 'INVALID_MESSAGE'), 600),
        createdAt: normalizeTimestamp(ownData(value, 'createdAt', 'INVALID_MESSAGE')),
    };
}

function normalizeSummary(value) {
    assertExactObject(value, new Set(['id', 'startFloor', 'endFloor', 'content', 'createdAt']), new Set(['id', 'startFloor', 'endFloor', 'content', 'createdAt']), 'INVALID_SUMMARY');
    const startFloor = safeInteger(ownData(value, 'startFloor', 'INVALID_SUMMARY'), 1, 1_000_000, 'INVALID_SUMMARY');
    const endFloor = safeInteger(ownData(value, 'endFloor', 'INVALID_SUMMARY'), startFloor, 1_000_000, 'INVALID_SUMMARY');
    const id = ownData(value, 'id', 'INVALID_SUMMARY');
    if (typeof id !== 'string' || !LOCAL_RECORD_ID_PATTERN.test(id)) fail('INVALID_SUMMARY');
    return {
        id, startFloor, endFloor,
        content: safeText(ownData(value, 'content', 'INVALID_SUMMARY'), 1_600),
        createdAt: normalizeTimestamp(ownData(value, 'createdAt', 'INVALID_SUMMARY')),
    };
}

function normalizeSummaryStatus(value) {
    assertExactObject(value, new Set(['status', 'startFloor', 'endFloor', 'message']), new Set(['status', 'startFloor', 'endFloor', 'message']), 'INVALID_SUMMARY_STATUS');
    const status = ownData(value, 'status', 'INVALID_SUMMARY_STATUS');
    if (!['idle', 'failed'].includes(status)) fail('INVALID_SUMMARY_STATUS');
    const startFloor = safeInteger(ownData(value, 'startFloor', 'INVALID_SUMMARY_STATUS'), 0, 1_000_000, 'INVALID_SUMMARY_STATUS');
    const endFloor = safeInteger(ownData(value, 'endFloor', 'INVALID_SUMMARY_STATUS'), 0, 1_000_000, 'INVALID_SUMMARY_STATUS');
    if (status === 'idle' && (startFloor !== 0 || endFloor !== 0 || ownData(value, 'message', 'INVALID_SUMMARY_STATUS') !== '')) fail('INVALID_SUMMARY_STATUS');
    if (status === 'failed' && (startFloor < 1 || endFloor < startFloor)) fail('INVALID_SUMMARY_STATUS');
    return {
        status, startFloor, endFloor,
        message: status === 'failed' ? safeText(ownData(value, 'message', 'INVALID_SUMMARY_STATUS'), 160) : '',
    };
}

function normalizeThread(value) {
    assertExactObject(value, new Set(['key', 'title', 'auto', 'temporaryMembers', 'messages', 'summaries', 'summaryStatus']), new Set(['key', 'title', 'auto', 'temporaryMembers', 'messages', 'summaries', 'summaryStatus']), 'INVALID_DOCUMENT');
    const temporaryMembers = ownData(value, 'temporaryMembers', 'INVALID_DOCUMENT');
    const messages = ownData(value, 'messages', 'INVALID_DOCUMENT');
    const summaries = ownData(value, 'summaries', 'INVALID_DOCUMENT');
    if (!Array.isArray(temporaryMembers) || temporaryMembers.length > 32 || !Array.isArray(messages) || messages.length > MAX_GROUP_MESSAGES
        || !Array.isArray(summaries) || summaries.length > MAX_CONVERSATION_SUMMARIES) fail('INVALID_DOCUMENT');
    const memberNames = new Set();
    const normalizedMembers = temporaryMembers.map((profile) => {
        const normalized = normalizeGroupForumProfile(profile);
        const name = normalized.nickname.normalize('NFKC').toLowerCase();
        if (memberNames.has(name)) fail('INVALID_DOCUMENT');
        memberNames.add(name);
        return normalized;
    });
    const normalizedMessages = messages.map(normalizeMessage);
    validateMessageFloors(normalizedMessages, 'INVALID_DOCUMENT');
    const normalizedSummaries = summaries.map(normalizeSummary);
    validateSummaryRanges(normalizedSummaries, normalizedMessages.length, 'INVALID_DOCUMENT');
    return {
        key: normalizeTargetKey(ownData(value, 'key', 'INVALID_DOCUMENT')),
        title: safeText(ownData(value, 'title', 'INVALID_DOCUMENT'), 120),
        auto: normalizeGroupAutoSettings(ownData(value, 'auto', 'INVALID_DOCUMENT')),
        temporaryMembers: normalizedMembers,
        messages: normalizedMessages,
        summaries: normalizedSummaries,
        summaryStatus: normalizeSummaryStatus(ownData(value, 'summaryStatus', 'INVALID_DOCUMENT')),
    };
}

function normalizeLocalGroup(value) {
    assertExactObject(value, new Set(['id', 'name', 'members', 'createdAt']), new Set(['id', 'name', 'members', 'createdAt']), 'INVALID_GROUP');
    const id = ownData(value, 'id', 'INVALID_GROUP');
    const members = ownData(value, 'members', 'INVALID_GROUP');
    if (typeof id !== 'string' || !LOCAL_GROUP_ID_PATTERN.test(id) || !Array.isArray(members) || members.length < 1 || members.length > 16) fail('INVALID_GROUP');
    const names = new Set();
    const normalizedMembers = members.map((profile) => {
        const normalized = normalizeGroupForumProfile(profile);
        const key = normalized.nickname.normalize('NFKC').toLowerCase();
        if (names.has(key)) fail('INVALID_GROUP');
        names.add(key);
        return normalized;
    });
    return {
        id,
        name: safeText(ownData(value, 'name', 'INVALID_GROUP'), 80),
        members: normalizedMembers,
        createdAt: normalizeTimestamp(ownData(value, 'createdAt', 'INVALID_GROUP')),
    };
}

function normalizeForumPost(value) {
    assertExactObject(value, new Set(['id', 'topic', 'title', 'body', 'tags', 'author', 'participants', 'messages', 'summaries', 'summaryStatus', 'createdAt']), new Set(['id', 'topic', 'title', 'body', 'tags', 'author', 'participants', 'messages', 'summaries', 'summaryStatus', 'createdAt']), 'INVALID_POST');
    const id = ownData(value, 'id', 'INVALID_POST');
    const participants = ownData(value, 'participants', 'INVALID_POST');
    const messages = ownData(value, 'messages', 'INVALID_POST');
    const summaries = ownData(value, 'summaries', 'INVALID_POST');
    if (typeof id !== 'string' || !LOCAL_POST_ID_PATTERN.test(id) || !Array.isArray(participants) || participants.length > 32
        || !Array.isArray(messages) || messages.length > MAX_POST_MESSAGES || !Array.isArray(summaries) || summaries.length > MAX_CONVERSATION_SUMMARIES) fail('INVALID_POST');
    const author = normalizeGroupForumProfile(ownData(value, 'author', 'INVALID_POST'));
    const names = new Set([author.nickname.normalize('NFKC').toLowerCase()]);
    const normalizedParticipants = participants.map((profile) => {
        const normalized = normalizeGroupForumProfile(profile);
        const key = normalized.nickname.normalize('NFKC').toLowerCase();
        if (names.has(key)) fail('INVALID_POST');
        names.add(key);
        return normalized;
    });
    const normalizedMessages = messages.map(normalizeMessage);
    validateMessageFloors(normalizedMessages, 'INVALID_POST');
    const normalizedSummaries = summaries.map(normalizeSummary);
    validateSummaryRanges(normalizedSummaries, normalizedMessages.length, 'INVALID_POST');
    return {
        id,
        topic: safeText(ownData(value, 'topic', 'INVALID_POST'), 80),
        title: safeText(ownData(value, 'title', 'INVALID_POST'), 120),
        body: safeText(ownData(value, 'body', 'INVALID_POST'), 1_200),
        tags: normalizeTags(ownData(value, 'tags', 'INVALID_POST'), 6),
        author,
        participants: normalizedParticipants,
        messages: normalizedMessages,
        summaries: normalizedSummaries,
        summaryStatus: normalizeSummaryStatus(ownData(value, 'summaryStatus', 'INVALID_POST')),
        createdAt: normalizeTimestamp(ownData(value, 'createdAt', 'INVALID_POST')),
    };
}

function validateMessageFloors(messages, code) {
    let expected = 1;
    const ids = new Set();
    for (const message of messages) {
        if (message.floor !== expected || ids.has(message.id)) fail(code);
        ids.add(message.id);
        expected += 1;
    }
}

function validateSummaryRanges(summaries, totalFloors, code) {
    const ids = new Set();
    for (const summary of summaries) {
        if (summary.endFloor > totalFloors || ids.has(summary.id)) fail(code);
        ids.add(summary.id);
    }
}

function makeDefaultDocument() {
    return {
        schema: GROUP_FORUM_SCHEMA_ID,
        schemaVersion: GROUP_FORUM_SCHEMA_VERSION,
        nextId: 1,
        groups: [],
        threads: [],
        posts: [],
    };
}

function normalizeDocument(value) {
    assertExactObject(value, new Set(['schema', 'schemaVersion', 'nextId', 'groups', 'threads', 'posts']), new Set(['schema', 'schemaVersion', 'nextId', 'groups', 'threads', 'posts']), 'INVALID_DOCUMENT');
    if (ownData(value, 'schema', 'INVALID_DOCUMENT') !== GROUP_FORUM_SCHEMA_ID) fail('INVALID_DOCUMENT');
    if (ownData(value, 'schemaVersion', 'INVALID_DOCUMENT') !== GROUP_FORUM_SCHEMA_VERSION) fail('UNSUPPORTED_VERSION');
    const groups = ownData(value, 'groups', 'INVALID_DOCUMENT');
    const threads = ownData(value, 'threads', 'INVALID_DOCUMENT');
    const posts = ownData(value, 'posts', 'INVALID_DOCUMENT');
    if (!Array.isArray(groups) || groups.length > MAX_LOCAL_GROUPS || !Array.isArray(threads) || threads.length > MAX_LOCAL_GROUPS * 3 || !Array.isArray(posts) || posts.length > MAX_FORUM_POSTS) fail('INVALID_DOCUMENT');
    const normalizedGroups = groups.map(normalizeLocalGroup);
    const groupIds = new Set();
    for (const group of normalizedGroups) {
        if (groupIds.has(group.id)) fail('INVALID_DOCUMENT');
        groupIds.add(group.id);
    }
    const normalizedThreads = threads.map(normalizeThread);
    const keys = new Set();
    for (const thread of normalizedThreads) {
        if (keys.has(thread.key)) fail('INVALID_DOCUMENT');
        if (LOCAL_GROUP_ID_PATTERN.test(thread.key) && !groupIds.has(thread.key)) fail('INVALID_DOCUMENT');
        keys.add(thread.key);
    }
    const normalizedPosts = posts.map(normalizeForumPost);
    const postIds = new Set();
    for (const post of normalizedPosts) {
        if (postIds.has(post.id)) fail('INVALID_DOCUMENT');
        postIds.add(post.id);
    }
    return {
        schema: GROUP_FORUM_SCHEMA_ID,
        schemaVersion: GROUP_FORUM_SCHEMA_VERSION,
        nextId: safeInteger(ownData(value, 'nextId', 'INVALID_DOCUMENT'), 1, 10_000_000, 'INVALID_DOCUMENT'),
        groups: normalizedGroups,
        threads: normalizedThreads,
        posts: normalizedPosts,
    };
}

function serializeDocument(value) {
    const serialized = JSON.stringify(normalizeDocument(value));
    if (serialized.length > MAX_GROUP_FORUM_SERIALIZED_BYTES) fail('STORE_TOO_LARGE');
    return serialized;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) freeze(child);
    }
    return value;
}

function project(value) {
    return freeze(clone(value));
}

function normalizeIncomingUpdate(value) {
    assertExactObject(value, new Set(['participants', 'messages']), new Set(['participants', 'messages']), 'INVALID_MODEL_UPDATE');
    const participants = ownData(value, 'participants', 'INVALID_MODEL_UPDATE');
    const messages = ownData(value, 'messages', 'INVALID_MODEL_UPDATE');
    if (!Array.isArray(participants) || participants.length > 3 || !Array.isArray(messages) || messages.length < 1 || messages.length > 8) fail('INVALID_MODEL_UPDATE');
    const names = new Set();
    const normalizedParticipants = participants.map((profile) => {
        const normalized = normalizeGroupForumProfile(profile);
        const key = normalized.nickname.normalize('NFKC').toLowerCase();
        if (names.has(key)) fail('INVALID_MODEL_UPDATE');
        names.add(key);
        return normalized;
    });
    const normalizedMessages = messages.map((message) => {
        assertExactObject(message, new Set(['speaker', 'text']), new Set(['speaker', 'text']), 'INVALID_MODEL_UPDATE');
        return {
            speaker: safeText(ownData(message, 'speaker', 'INVALID_MODEL_UPDATE'), 80),
            text: safeText(ownData(message, 'text', 'INVALID_MODEL_UPDATE'), 480),
        };
    });
    return { participants: normalizedParticipants, messages: normalizedMessages };
}

function normalizeForumRefresh(value) {
    assertExactObject(value, new Set(['participants', 'posts']), new Set(['participants', 'posts']), 'INVALID_FORUM_REFRESH');
    const participants = ownData(value, 'participants', 'INVALID_FORUM_REFRESH');
    const posts = ownData(value, 'posts', 'INVALID_FORUM_REFRESH');
    if (!Array.isArray(participants) || participants.length > 6 || !Array.isArray(posts) || posts.length < 1 || posts.length > 6) fail('INVALID_FORUM_REFRESH');
    const names = new Set();
    const normalizedParticipants = participants.map((profile) => {
        const normalized = normalizeGroupForumProfile(profile);
        const key = normalized.nickname.normalize('NFKC').toLowerCase();
        if (names.has(key)) fail('INVALID_FORUM_REFRESH');
        names.add(key);
        return normalized;
    });
    const normalizedPosts = posts.map((post) => {
        assertExactObject(post, new Set(['author', 'topic', 'title', 'body', 'tags']), new Set(['author', 'topic', 'title', 'body', 'tags']), 'INVALID_FORUM_REFRESH');
        return {
            author: safeText(ownData(post, 'author', 'INVALID_FORUM_REFRESH'), 80),
            topic: safeText(ownData(post, 'topic', 'INVALID_FORUM_REFRESH'), 80),
            title: safeText(ownData(post, 'title', 'INVALID_FORUM_REFRESH'), 120),
            body: safeText(ownData(post, 'body', 'INVALID_FORUM_REFRESH'), 1_200),
            tags: normalizeTags(ownData(post, 'tags', 'INVALID_FORUM_REFRESH'), 6),
        };
    });
    return { participants: normalizedParticipants, posts: normalizedPosts };
}

function nextLocalId(document, type) {
    const id = `local_${type}_${document.nextId}`;
    document.nextId += 1;
    return id;
}

function summaryInfo(conversation) {
    const totalFloors = conversation.messages.length;
    const completedFloor = conversation.summaries.reduce((latest, item) => Math.max(latest, item.endFloor), 0);
    return {
        totalFloors,
        completedFloor,
        pendingFloorCount: Math.max(0, totalFloors - completedFloor),
        recordCount: conversation.summaries.length,
        status: conversation.summaryStatus.status,
        failureStartFloor: conversation.summaryStatus.startFloor,
        failureEndFloor: conversation.summaryStatus.endFloor,
        failureMessage: conversation.summaryStatus.message,
    };
}

/** A stable opaque browser-cache key based only on public group presentation. */
export function externalGroupCacheKey(group) {
    if (!group || typeof group !== 'object') fail('INVALID_TARGET');
    const topic = safeText(group.主题 ?? group.name, 120);
    const description = safeText(group.描述 ?? group.description, 800);
    const members = Array.isArray(group.成员 ?? group.members) ? (group.成员 ?? group.members) : [];
    const names = members.slice(0, 32).map((person) => {
        const profile = person?.公开资料 ?? person;
        return typeof profile?.昵称 === 'string' ? profile.昵称.trim() : (typeof profile?.nickname === 'string' ? profile.nickname.trim() : '');
    }).filter(Boolean).sort();
    let hash = 0x811c9dc5;
    const source = `${topic}\n${description}\n${names.join('\n')}`;
    for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `ext_${hash.toString(16).padStart(8, '0')}`;
}

export function createMemoryGroupForumStorage(initialEntries = []) {
    const values = new Map(initialEntries);
    return Object.freeze({
        async getItem(key) { return values.has(key) ? values.get(key) : null; },
        async setItem(key, value) { values.set(key, value); },
        async removeItem(key) { values.delete(key); },
    });
}

/**
 * Creates the local persistence boundary. Methods return immutable copies and
 * queue writes, so an automatic tick cannot race a player send or a summary.
 */
export function createGroupForumStore({ storage = createMemoryGroupForumStorage(), now = () => new Date(), storageKey = GROUP_FORUM_STORAGE_KEY } = {}) {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
        fail('INVALID_STORAGE');
    }
    let document = makeDefaultDocument();
    let loaded = false;
    let loadingPromise = null;
    let writeTail = Promise.resolve();

    async function ensureLoaded() {
        if (loaded) return;
        if (loadingPromise) return loadingPromise;
        loadingPromise = (async () => {
            let stored;
            try { stored = await storage.getItem(storageKey); } catch { fail('STORAGE_READ_FAILED'); }
            if (stored === null || stored === undefined) document = makeDefaultDocument();
            else if (typeof stored === 'string') {
                if (stored.length > MAX_GROUP_FORUM_SERIALIZED_BYTES) fail('STORE_TOO_LARGE');
                try { document = normalizeDocument(JSON.parse(stored)); } catch (error) {
                    if (error instanceof GroupForumStoreError) throw error;
                    fail('INVALID_DOCUMENT');
                }
            } else document = normalizeDocument(stored);
            loaded = true;
        })();
        try { await loadingPromise; } finally { loadingPromise = null; }
    }

    async function commit(next) {
        const normalized = normalizeDocument(next);
        const serialized = serializeDocument(normalized);
        try { await storage.setItem(storageKey, serialized); } catch { fail('STORAGE_WRITE_FAILED'); }
        document = normalized;
        loaded = true;
    }

    function enqueue(action) {
        const result = writeTail.then(action, action);
        writeTail = result.then(() => undefined, () => undefined);
        return result;
    }

    async function read() {
        await writeTail;
        await ensureLoaded();
        return document;
    }

    function threadFor(next, key, title) {
        const normalizedKey = normalizeTargetKey(key);
        const index = next.threads.findIndex((thread) => thread.key === normalizedKey);
        if (index >= 0) {
            if (title) next.threads[index].title = safeText(title, 120);
            return next.threads[index];
        }
        const thread = {
            key: normalizedKey,
            title: safeText(title, 120),
            auto: { ...DEFAULT_GROUP_AUTO_SETTINGS },
            temporaryMembers: [], messages: [], summaries: [],
            summaryStatus: { status: 'idle', startFloor: 0, endFloor: 0, message: '' },
        };
        next.threads.push(thread);
        return thread;
    }

    function appendUserMessage(conversation, next, content) {
        conversation.messages.push({
            id: nextLocalId(next, 'message'), floor: conversation.messages.length + 1,
            sender: 'user', author: null, content: safeText(content, 600), createdAt: nowTimestamp(now),
        });
        if (conversation.messages.length > (Object.hasOwn(conversation, 'key') ? MAX_GROUP_MESSAGES : MAX_POST_MESSAGES)) {
            // Never silently drop an unsummarized message. The caller gets a
            // clear storage-limit error instead and can summarize first.
            fail('CONVERSATION_LIMIT_REACHED');
        }
    }

    function appendModelUpdate(conversation, next, update, knownProfiles) {
        const normalized = normalizeIncomingUpdate(update);
        const known = new Map();
        for (const profile of [...knownProfiles, ...conversation.temporaryMembers ?? [], ...conversation.participants ?? []]) {
            const safe = normalizeGroupForumProfile(profile);
            known.set(safe.nickname.normalize('NFKC').toLowerCase(), safe);
        }
        const temporary = Object.hasOwn(conversation, 'temporaryMembers') ? conversation.temporaryMembers : conversation.participants;
        for (const profile of normalized.participants) {
            const key = profile.nickname.normalize('NFKC').toLowerCase();
            if (!known.has(key)) {
                known.set(key, profile);
                temporary.push(profile);
            }
        }
        for (const item of normalized.messages) {
            const author = known.get(item.speaker.normalize('NFKC').toLowerCase());
            if (!author) fail('MODEL_SPEAKER_UNKNOWN');
            conversation.messages.push({
                id: nextLocalId(next, 'message'), floor: conversation.messages.length + 1,
                sender: 'member', author, content: item.text, createdAt: nowTimestamp(now),
            });
        }
        const max = Object.hasOwn(conversation, 'key') ? MAX_GROUP_MESSAGES : MAX_POST_MESSAGES;
        if (conversation.messages.length > max) fail('CONVERSATION_LIMIT_REACHED');
    }

    function requirePost(next, postId) {
        if (typeof postId !== 'string' || !LOCAL_POST_ID_PATTERN.test(postId)) fail('POST_NOT_FOUND');
        const post = next.posts.find((item) => item.id === postId);
        if (!post) fail('POST_NOT_FOUND');
        return post;
    }

    async function ready() { await read(); return project(document); }
    function peek() { return project(document); }
    async function snapshot() { return project(await read()); }

    async function createGroup({ name, members } = {}) {
        return enqueue(async () => {
            await ensureLoaded();
            if (document.groups.length >= MAX_LOCAL_GROUPS) fail('GROUP_LIMIT_REACHED');
            if (!Array.isArray(members) || members.length < 1 || members.length > 16) fail('INVALID_GROUP');
            const profiles = members.map(normalizeGroupForumProfile);
            const names = new Set();
            for (const profile of profiles) {
                const key = profile.nickname.normalize('NFKC').toLowerCase();
                if (names.has(key)) fail('INVALID_GROUP');
                names.add(key);
            }
            const next = clone(document);
            const group = { id: nextLocalId(next, 'group'), name: safeText(name, 80), members: profiles, createdAt: nowTimestamp(now) };
            next.groups.push(group);
            await commit(next);
            return project(group);
        });
    }

    async function setGroupAuto({ key, title, settings } = {}) {
        return enqueue(async () => {
            await ensureLoaded();
            const next = clone(document);
            const thread = threadFor(next, key, title);
            thread.auto = normalizeGroupAutoSettings(settings);
            await commit(next);
            return project(thread);
        });
    }

    async function appendGroupUserMessage({ key, title, content } = {}) {
        return enqueue(async () => {
            await ensureLoaded();
            const next = clone(document);
            const thread = threadFor(next, key, title);
            appendUserMessage(thread, next, content);
            await commit(next);
            return project(thread);
        });
    }

    async function appendGroupModelUpdate({ key, title, update, members = [] } = {}) {
        return enqueue(async () => {
            await ensureLoaded();
            if (!Array.isArray(members)) fail('INVALID_GROUP');
            const next = clone(document);
            const thread = threadFor(next, key, title);
            appendModelUpdate(thread, next, update, members);
            await commit(next);
            return project(thread);
        });
    }

    async function addForumRefresh({ update, communityProfiles = [] } = {}) {
        return enqueue(async () => {
            await ensureLoaded();
            if (!Array.isArray(communityProfiles)) fail('INVALID_FORUM_REFRESH');
            const normalized = normalizeForumRefresh(update);
            const known = new Map();
            for (const profile of communityProfiles) {
                const safe = normalizeGroupForumProfile(profile);
                known.set(safe.nickname.normalize('NFKC').toLowerCase(), safe);
            }
            for (const profile of normalized.participants) known.set(profile.nickname.normalize('NFKC').toLowerCase(), profile);
            const next = clone(document);
            const created = [];
            for (const draft of normalized.posts) {
                if (next.posts.length >= MAX_FORUM_POSTS) fail('POST_LIMIT_REACHED');
                const author = known.get(draft.author.normalize('NFKC').toLowerCase());
                if (!author) fail('MODEL_SPEAKER_UNKNOWN');
                const participants = normalized.participants.filter((profile) => profile.nickname !== author.nickname);
                const post = {
                    id: nextLocalId(next, 'post'), topic: draft.topic, title: draft.title, body: draft.body, tags: draft.tags,
                    author, participants, messages: [], summaries: [],
                    summaryStatus: { status: 'idle', startFloor: 0, endFloor: 0, message: '' }, createdAt: nowTimestamp(now),
                };
                next.posts.unshift(post);
                created.push(post);
            }
            await commit(next);
            return project(created);
        });
    }

    async function appendForumUserComment({ postId, content } = {}) {
        return enqueue(async () => {
            await ensureLoaded();
            const next = clone(document);
            const post = requirePost(next, postId);
            appendUserMessage(post, next, content);
            await commit(next);
            return project(post);
        });
    }

    async function appendForumModelUpdate({ postId, update } = {}) {
        return enqueue(async () => {
            await ensureLoaded();
            const next = clone(document);
            const post = requirePost(next, postId);
            appendModelUpdate(post, next, update, [post.author]);
            await commit(next);
            return project(post);
        });
    }

    function locateConversation(next, target) {
        assertExactObject(target, new Set(['kind', 'id']), new Set(['kind', 'id']), 'INVALID_TARGET');
        const kind = ownData(target, 'kind', 'INVALID_TARGET');
        const id = ownData(target, 'id', 'INVALID_TARGET');
        if (kind === 'group') {
            const thread = next.threads.find((item) => item.key === normalizeTargetKey(id));
            if (!thread) fail('CONVERSATION_NOT_FOUND');
            return thread;
        }
        if (kind === 'post') return requirePost(next, id);
        fail('INVALID_TARGET');
    }

    async function saveConversationSummary({ target, summaryId = '', startFloor, endFloor, content } = {}) {
        return enqueue(async () => {
            await ensureLoaded();
            const next = clone(document);
            const conversation = locateConversation(next, target);
            const start = safeInteger(startFloor, 1, conversation.messages.length, 'INVALID_SUMMARY');
            const end = safeInteger(endFloor, start, conversation.messages.length, 'INVALID_SUMMARY');
            const normalizedContent = safeText(content, 1_600);
            const existing = summaryId ? conversation.summaries.find((item) => item.id === summaryId) : null;
            if (summaryId && !existing) fail('SUMMARY_NOT_FOUND');
            if (!existing && conversation.summaries.length >= MAX_CONVERSATION_SUMMARIES) fail('SUMMARY_LIMIT_REACHED');
            const record = { id: existing?.id ?? nextLocalId(next, 'summary'), startFloor: start, endFloor: end, content: normalizedContent, createdAt: nowTimestamp(now) };
            if (existing) conversation.summaries = conversation.summaries.map((item) => item.id === existing.id ? record : item);
            else conversation.summaries.push(record);
            conversation.summaryStatus = { status: 'idle', startFloor: 0, endFloor: 0, message: '' };
            await commit(next);
            return project(record);
        });
    }

    async function failConversationSummary({ target, startFloor, endFloor, message = '本次总结未完成，请稍后重试。' } = {}) {
        return enqueue(async () => {
            await ensureLoaded();
            const next = clone(document);
            const conversation = locateConversation(next, target);
            const start = safeInteger(startFloor, 1, conversation.messages.length, 'INVALID_SUMMARY');
            const end = safeInteger(endFloor, start, conversation.messages.length, 'INVALID_SUMMARY');
            conversation.summaryStatus = { status: 'failed', startFloor: start, endFloor: end, message: safeText(message, 160) };
            await commit(next);
            return project(conversation.summaryStatus);
        });
    }

    async function getConversation(target) {
        const state = await read();
        return project(locateConversation(clone(state), target));
    }

    async function getSummaryHistory() {
        const state = await read();
        const groups = state.threads.map((thread) => Object.freeze({
            kind: 'group', id: thread.key, title: thread.title, summary: Object.freeze(summaryInfo(thread)),
        }));
        const posts = state.posts.map((post) => Object.freeze({
            kind: 'post', id: post.id, title: post.title, summary: Object.freeze(summaryInfo(post)),
        }));
        return Object.freeze({ groups: Object.freeze(groups), posts: Object.freeze(posts) });
    }

    return Object.freeze({
        ready,
        peek,
        snapshot,
        createGroup,
        setGroupAuto,
        appendGroupUserMessage,
        appendGroupModelUpdate,
        addForumRefresh,
        appendForumUserComment,
        appendForumModelUpdate,
        getConversation,
        saveConversationSummary,
        failConversationSummary,
        getSummaryHistory,
    });
}

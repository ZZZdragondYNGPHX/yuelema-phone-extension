/**
 * Read-only group discovery data service. Groups persist only topic,
 * description, member UIDs and discoverable-character UIDs. This module maps
 * those references to public profile projections for a future UI; it never
 * opens a group chat, calls an LLM, or writes MVU state.
 */

const MAX_GROUPS = 200;
const MAX_GROUP_MEMBERS = 200;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const HTML_PATTERN = /<\s*\/?\s*[a-z][^>]*>/iu;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const GROUP_UID_PATTERN = /^group_[A-Za-z0-9_-]+$/u;
const PUBLIC_TEXT_FIELDS = Object.freeze({
    昵称: 80, 头像引用: 500, 年龄段: 32, 性别: 48, 性取向: 80,
    城市: 80, 距离范围: 48, 寻找意图: 120, 简介: 500,
});
const PUBLIC_TAG_FIELDS = Object.freeze(['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']);

function ownPlainRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/** Reads only own enumerable value properties, and therefore never evaluates getters. */
function ownData(record, key) {
    if (!ownPlainRecord(record)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined;
    return descriptor.value;
}

function cleanText(value, maxLength) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (!text || text.length > maxLength || CONTROL_CHARACTER_PATTERN.test(text) || HTML_PATTERN.test(text)) return '';
    return text;
}

function cleanUidList(value) {
    if (!Array.isArray(value)) return Object.freeze([]);
    const uids = [];
    for (const rawUid of value) {
        const uid = cleanText(rawUid, 80);
        if (uid && !uids.includes(uid)) uids.push(uid);
        if (uids.length >= MAX_GROUP_MEMBERS) break;
    }
    return Object.freeze(uids);
}

function cleanTags(value) {
    if (!Array.isArray(value)) return Object.freeze([]);
    const tags = [];
    for (const rawTag of value) {
        const tag = cleanText(rawTag, 32);
        if (tag && !tags.includes(tag)) tags.push(tag);
        if (tags.length >= 24) break;
    }
    return Object.freeze(tags);
}

/** Returns the only character shape this service may expose to a group UI. */
export function projectPublicGroupCharacter(uid, character) {
    const safeUid = cleanText(uid, 80);
    if (!safeUid || !ownPlainRecord(character) || ownData(character, '成人验证') !== true) return null;
    const sourceProfile = ownData(character, '公开资料');
    if (!ownPlainRecord(sourceProfile)) return null;

    const profile = {};
    for (const [key, maxLength] of Object.entries(PUBLIC_TEXT_FIELDS)) profile[key] = cleanText(ownData(sourceProfile, key), maxLength);
    for (const key of PUBLIC_TAG_FIELDS) profile[key] = cleanTags(ownData(sourceProfile, key));
    return Object.freeze({ UID: safeUid, 公开资料: Object.freeze(profile) });
}

function readCharacterPool(state) {
    const pool = ownData(state, '角色池');
    return ownPlainRecord(pool) ? pool : null;
}

function resolvePublicCharacters(characterPool, uids) {
    if (!characterPool) return Object.freeze([]);
    const people = [];
    for (const uid of uids) {
        if (DANGEROUS_KEYS.has(uid)) continue;
        const person = projectPublicGroupCharacter(uid, ownData(characterPool, uid));
        if (person) people.push(person);
    }
    return Object.freeze(people);
}

function projectGroup(groupUid, group, characterPool) {
    if (!GROUP_UID_PATTERN.test(groupUid) || !ownPlainRecord(group)) return null;
    const 主题 = cleanText(ownData(group, '主题'), 120);
    const 描述 = cleanText(ownData(group, '描述'), 800);
    if (!主题 || !描述) return null;
    const 成员UID = cleanUidList(ownData(group, '成员UID'));
    const 可发现角色UID = cleanUidList(ownData(group, '可发现角色UID'));
    return Object.freeze({
        UID: groupUid, 主题, 描述, 成员UID, 可发现角色UID,
        成员: resolvePublicCharacters(characterPool, 成员UID),
        可发现角色: resolvePublicCharacters(characterPool, 可发现角色UID),
    });
}

/** Creates a read-only browse model from /群组 and /角色池 only. */
export function buildGroupBrowseModel(state) {
    if (!ownPlainRecord(state)) return Object.freeze({ 群组: Object.freeze([]) });
    const groups = ownData(state, '群组');
    if (!ownPlainRecord(groups)) return Object.freeze({ 群组: Object.freeze([]) });
    const characterPool = readCharacterPool(state);
    const result = [];
    for (const groupUid of Object.keys(groups).sort()) {
        if (result.length >= MAX_GROUPS) break;
        if (DANGEROUS_KEYS.has(groupUid)) continue;
        const group = projectGroup(groupUid, ownData(groups, groupUid), characterPool);
        if (group) result.push(group);
    }
    return Object.freeze({ 群组: Object.freeze(result) });
}

/** Resolves only the public people that a specified group marks as discoverable. */
export function listGroupDiscoverableCharacters(state, groupUid) {
    const uid = cleanText(groupUid, 80);
    if (!ownPlainRecord(state) || !GROUP_UID_PATTERN.test(uid)) return Object.freeze([]);
    const groups = ownData(state, '群组');
    if (!ownPlainRecord(groups)) return Object.freeze([]);
    const group = projectGroup(uid, ownData(groups, uid), readCharacterPool(state));
    return group ? group.可发现角色 : Object.freeze([]);
}

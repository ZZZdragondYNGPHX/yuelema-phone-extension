/**
 * Strictly validates one LLM-generated recommendation candidate before it can
 * enter MVU state. This module deliberately does not assign a UID: the caller
 * owns UID allocation and JSONPatch construction.
 */

const PUBLIC_PROFILE_FIELDS = Object.freeze({
    昵称: 80,
    头像引用: 500,
    年龄段: 32,
    性别: 48,
    性取向: 80,
    城市: 80,
    距离范围: 48,
    寻找意图: 120,
    简介: 500,
});

const TAG_FIELDS = Object.freeze(['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']);
const FRIEND_PROFILE_FIELDS = Object.freeze({ 关系状态: 120, 边界与偏好: 800 });
const RELATION_STATES = new Set(['陌生', '喜欢已发送', '已匹配', '已取消', '已拉黑']);
const GENERATED_CANDIDATE_STATE = '陌生';
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_KEY_PATTERN = /(?:api[\s_-]*key|authorization|token|secret|password|credential|private[\s_-]*key|密钥|令牌|密码|授权|凭据)/iu;
const HTML_PATTERN = /<!--|<\s*\/?\s*[a-z][^>]*>/iu;
const UNDERAGE_PATTERN = /(?:未成年|未滿|未满\s*18|minor|underage|小于\s*18|小於\s*18|<\s*18)/iu;
const CONTENT_MODES = new Set(['SFW', 'NSFW']);
const PERSONAL_NAME_PATTERN = /^(?:[\p{Script=Han}]{2,12}|[\p{Script=Latin}][\p{Script=Latin}' -]{1,31}|[\p{Script=Han}]{1,12}(?:·[\p{Script=Han}\p{Script=Latin}]{1,16})+)$/u;
const NON_PERSONAL_NAME_PATTERN = /(?:玩家|用户|使用者|系统|模型|人工智能|智能体|智核|助手|机器人|候选人|角色|档案|资料|测试|官方|管理员|客服|团队|工作室|公司|平台|账号|帐号|游客|匿名|摄影师|设计师|工程师|咖啡师|医生|律师|教师|老师|作家|主播|店长|经理|教授|学生|总监|总裁|\b(?:ai|gpt|bot|npc|test|unknown|user|player|system|model|assistant)\b)/iu;

// This mirrors the exact closed candidate codec below. It belongs to the
// non-editable system layer so a local prompt preset can guide style without
// being responsible for (or able to weaken) model-output structure.
export const COMPLETE_CANDIDATE_OUTPUT_CONTRACT = Object.freeze([
    '完整候选 JSON 结构合同（以下是字段说明，不是可照抄的候选内容；所有键名必须逐字保留，不得新增、删除、改名或包一层 candidate）：',
    '根对象必须且仅能含：成人验证、公开资料、仅好友资料、隐藏资料、偏好与边界、拒绝阈值、已读不回阈值、取消匹配阈值、拉黑阈值、与玩家关系。成人验证必须是布尔值 true。',
    '公开资料必须且仅能含：昵称、头像引用、年龄段、性别、性取向、城市、距离范围、寻找意图、简介、兴趣标签、生活方式标签、性格标签、沟通风格标签。前九项是字符串（头像引用可为空字符串，其余不得为空）；后四项都是字符串数组，每个数组放 0–2 个短标签。年龄段必须明确为成年人，不能出现任何小于 18 的年龄。',
    '仅好友资料必须且仅能含：关系状态、边界与偏好；两项都是非空字符串。隐藏资料必须且仅能含：实际年龄、私人备注；实际年龄是 18–120 的整数，私人备注是可为空的字符串。',
    '偏好与边界是可为空的字符串。拒绝阈值、已读不回阈值、取消匹配阈值、拉黑阈值都必须是 0–100 的整数。',
    '与玩家关系必须且仅能含：状态、全局账号表现、NPC专属匹配度、好感、信任、戒备、面基意愿。状态固定为“陌生”；其余六项都必须是 0–100 的整数。',
    '只在对应层级填写这些内部资料：公开资料不得夹带仅好友资料、隐藏资料或关系数值；内部资料不会直接展示给玩家。',
]);
// NSFW only changes which public *tags* may describe an adult's stated orientation
// or body/style preference. It never authorizes offline sexual enactment, coercion,
// minors, or disclosure of private identifiers.
const ADULT_ORIENTATION_TAG_PATTERN = /(?:名器|翘臀|巨乳|丰胸|性感|性开放|性欲|床伴|炮友|约炮|情趣|性偏好|BDSM|支配|臣服|角色扮演)/iu;
const PROHIBITED_PUBLIC_CONTENT_PATTERN = /(?:未成年|未滿|未满\s*18|minor|underage|非自愿|非自願|强迫|強迫|胁迫|脅迫|迷奸|下药|下藥|强奸|強奸|偷拍|偷窥|偷窺|勒索|诈骗|詐騙|线下(?:性行为|性行為|做爱|做愛|开房|開房|上床)|(?:性行为|性行為|做爱|做愛|开房|開房|上床)演绎|演繹|身份证|身份證|手机号|手機號|电话号码|電話號碼|具体住址|具體住址|家庭住址|门牌|門牌|真实姓名|真實姓名|银行卡|銀行卡|私人账号|私人帳號)/iu;
// Provenance stays in memory only. It is never enumerable, serialized, persisted,
// sent to a model, or written into MVU state. This lets the controlled patch path
// retain the mode that already passed the state-aware fast recommender validator.
const CANDIDATE_MODE_BY_OBJECT = new WeakMap();
function validationError(code) {
    const error = new TypeError(`candidate_validation_failed:${code}`);
    error.code = code;
    return error;
}

function fail(code) {
    throw validationError(code);
}

function ownData(value, key, path) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`${path}.${key}:accessor_or_missing`);
    return descriptor.value;
}

function assertSafeKey(key, path) {
    if (DANGEROUS_KEYS.has(key)) fail(`${path}:dangerous_key`);
    if (SENSITIVE_KEY_PATTERN.test(key)) fail(`${path}:sensitive_key`);
}

function assertRecord(value, expectedKeys, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${path}:record_required`);

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(`${path}:unsafe_prototype`);

    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) fail(`${path}:symbol_key`);

    const expected = new Set(expectedKeys);
    for (const key of keys) {
        assertSafeKey(key, path);
        if (!expected.has(key)) fail(`${path}:unknown_field`);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail(`${path}.${key}:accessor_or_hidden_field`);
    }

    if (keys.length !== expectedKeys.length) fail(`${path}:incomplete_or_unknown_fields`);
    for (const key of expectedKeys) {
        if (!Object.hasOwn(value, key)) fail(`${path}:missing_field`);
    }
}

function assertArray(value, path, maxItems) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(`${path}:array_required`);
    if (value.length > maxItems) fail(`${path}:too_many_items`);

    const expectedKeys = new Set(['length']);
    for (let index = 0; index < value.length; index += 1) expectedKeys.add(String(index));
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') fail(`${path}:symbol_key`);
        if (!expectedKeys.has(key)) fail(`${path}:unexpected_array_property`);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`${path}:accessor`);
    }
}

function normalizeText(value, path, maxLength, { allowEmpty = false } = {}) {
    if (typeof value !== 'string') fail(`${path}:string_required`);
    if (value.length > maxLength) fail(`${path}:too_long`);
    if (value !== value.trim()) fail(`${path}:surrounding_whitespace`);
    if (!allowEmpty && value.length === 0) fail(`${path}:empty`);
    if (/[\u0000-\u001f\u007f]/u.test(value)) fail(`${path}:control_character`);
    if (HTML_PATTERN.test(value)) fail(`${path}:html_not_allowed`);
    return value;
}

function assertGeneratedPersonalName(value) {
    if (!PERSONAL_NAME_PATTERN.test(value) || NON_PERSONAL_NAME_PATTERN.test(value)) {
        fail('公开资料.昵称:not_personal_name');
    }
}

function normalizeTags(value, path) {
    assertArray(value, path, 24);
    const seen = new Set();
    const tags = [];
    for (let index = 0; index < value.length; index += 1) {
        const tag = normalizeText(ownData(value, String(index), path), `${path}[${index}]`, 32);
        if (seen.has(tag)) fail(`${path}:duplicate_tag`);
        seen.add(tag);
        tags.push(tag);
    }
    return tags;
}

function normalizeInteger(value, path, low, high) {
    if (!Number.isInteger(value) || value < low || value > high) fail(`${path}:integer_out_of_range`);
    return value;
}

function normalizeContentMode(value) {
    if (value === undefined) return 'SFW';
    if (!CONTENT_MODES.has(value)) fail('内容模式:invalid');
    return value;
}

function resolveContentMode(input, options) {
    if (options !== null && typeof options === 'object' && Object.hasOwn(options, 'contentMode')) {
        return normalizeContentMode(options.contentMode);
    }
    return CANDIDATE_MODE_BY_OBJECT.get(input) ?? 'SFW';
}

function assertPublicTextPolicy(value, path, contentMode, { tag = false } = {}) {
    if (PROHIBITED_PUBLIC_CONTENT_PATTERN.test(value)) fail(`${path}:prohibited_public_content`);
    if (!ADULT_ORIENTATION_TAG_PATTERN.test(value)) return;
    if (contentMode === 'SFW') fail(`${path}:adult_keyword_in_sfw`);
    if (!tag) fail(`${path}:adult_keyword_must_be_tag`);
}

function normalizePublicProfile(value, contentMode, { requirePersonalName = false } = {}) {
    const keys = [...Object.keys(PUBLIC_PROFILE_FIELDS), ...TAG_FIELDS];
    assertRecord(value, keys, '公开资料');
    const profile = {};
    for (const [key, maxLength] of Object.entries(PUBLIC_PROFILE_FIELDS)) {
        const path = `公开资料.${key}`;
        profile[key] = normalizeText(ownData(value, key, '公开资料'), path, maxLength, { allowEmpty: key === '头像引用' });
        if (key === '昵称' && requirePersonalName) assertGeneratedPersonalName(profile[key]);
        assertPublicTextPolicy(profile[key], path, contentMode);
    }
    for (const key of TAG_FIELDS) {
        profile[key] = normalizeTags(ownData(value, key, '公开资料'), `公开资料.${key}`);
        for (let index = 0; index < profile[key].length; index += 1) {
            assertPublicTextPolicy(profile[key][index], `公开资料.${key}[${index}]`, contentMode, { tag: true });
        }
    }
    if (UNDERAGE_PATTERN.test(profile.年龄段)) fail('公开资料.年龄段:underage');
    for (const numberText of profile.年龄段.matchAll(/\d{1,3}/gu)) {
        if (Number(numberText[0]) < 18) fail('公开资料.年龄段:underage');
    }
    return profile;
}
function normalizeFriendProfile(value) {
    const keys = Object.keys(FRIEND_PROFILE_FIELDS);
    assertRecord(value, keys, '仅好友资料');
    const profile = {};
    for (const [key, maxLength] of Object.entries(FRIEND_PROFILE_FIELDS)) {
        profile[key] = normalizeText(ownData(value, key, '仅好友资料'), `仅好友资料.${key}`, maxLength);
    }
    return profile;
}

function normalizeHiddenProfile(value) {
    assertRecord(value, ['实际年龄', '私人备注'], '隐藏资料');
    const actualAge = normalizeInteger(ownData(value, '实际年龄', '隐藏资料'), '隐藏资料.实际年龄', 18, 120);
    return {
        实际年龄: actualAge,
        私人备注: normalizeText(ownData(value, '私人备注', '隐藏资料'), '隐藏资料.私人备注', 1200, { allowEmpty: true }),
    };
}

function normalizeRelationship(value) {
    const keys = ['状态', '全局账号表现', 'NPC专属匹配度', '好感', '信任', '戒备', '面基意愿'];
    assertRecord(value, keys, '与玩家关系');
    const state = normalizeText(ownData(value, '状态', '与玩家关系'), '与玩家关系.状态', 8);
    if (!RELATION_STATES.has(state) || state !== GENERATED_CANDIDATE_STATE) fail('与玩家关系.状态:not_new_candidate');

    const relationship = { 状态: state };
    for (const key of keys.slice(1)) {
        relationship[key] = normalizeInteger(ownData(value, key, '与玩家关系'), `与玩家关系.${key}`, 0, 100);
    }
    return relationship;
}

/**
 * Returns a clean, deep-cloned candidate that is safe to place under
 * 推荐.临时候选池. Invalid input throws TypeError with a stable, non-secret code.
 *
 * @param {unknown} input one complete NPC profile, without a UID
 * @returns {object}
 */
export function normalizeGeneratedCandidate(input, options) {
    try {
        const contentMode = resolveContentMode(input, options);
        const requirePersonalName = options !== null && typeof options === 'object' && options.requirePersonalName === true;
        const rootKeys = [
            '成人验证', '公开资料', '仅好友资料', '隐藏资料', '偏好与边界',
            '拒绝阈值', '已读不回阈值', '取消匹配阈值', '拉黑阈值', '与玩家关系',
        ];
        assertRecord(input, rootKeys, '候选人');
        if (ownData(input, '成人验证', '候选人') !== true) fail('成人验证:not_verified');

        const candidate = {
            成人验证: true,
            公开资料: normalizePublicProfile(ownData(input, '公开资料', '候选人'), contentMode, { requirePersonalName }),
            仅好友资料: normalizeFriendProfile(ownData(input, '仅好友资料', '候选人')),
            隐藏资料: normalizeHiddenProfile(ownData(input, '隐藏资料', '候选人')),
            偏好与边界: normalizeText(ownData(input, '偏好与边界', '候选人'), '偏好与边界', 1200, { allowEmpty: true }),
            拒绝阈值: normalizeInteger(ownData(input, '拒绝阈值', '候选人'), '拒绝阈值', 0, 100),
            已读不回阈值: normalizeInteger(ownData(input, '已读不回阈值', '候选人'), '已读不回阈值', 0, 100),
            取消匹配阈值: normalizeInteger(ownData(input, '取消匹配阈值', '候选人'), '取消匹配阈值', 0, 100),
            拉黑阈值: normalizeInteger(ownData(input, '拉黑阈值', '候选人'), '拉黑阈值', 0, 100),
            与玩家关系: normalizeRelationship(ownData(input, '与玩家关系', '候选人')),
        };
        CANDIDATE_MODE_BY_OBJECT.set(candidate, contentMode);
        return candidate;
    } catch (error) {
        if (error?.code && typeof error.code === 'string' && error.message.startsWith('candidate_validation_failed:')) throw error;
        throw validationError('invalid_input');
    }
}

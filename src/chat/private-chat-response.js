/**
 * Pure ESM validator for one private-chat LLM response.
 *
 * This boundary accepts only a parsed JSON-object-shaped value. Parsing model
 * transport output belongs to the caller so a string, SDK response, or other
 * wrapper cannot accidentally be treated as an already validated reply.
 */

export const MAX_PRIVATE_CHAT_REPLY_LENGTH = 600;
export const MAX_PRIVATE_CHAT_SESSION_SUMMARY_LENGTH = 500;

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_KEY_PATTERN = /(?:api[\s_-]*key|authorization|token|secret|password|credential|private[\s_-]*key|密钥|令牌|密码|授权|凭据)/iu;
const HTML_PATTERN = /<!--|<\s*\/?\s*[a-z][^>]*>/iu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const ERROR_PREFIX = 'private_chat_response_validation_failed:';
const RELATIONSHIP_FIELDS = Object.freeze(['好感', '信任', '戒备', '面基意愿']);
const USER_MESSAGES = Object.freeze({
    private_chat_response_required: '私聊回复必须是 JSON 对象。',
    private_chat_response_unsafe_prototype: '私聊回复包含不安全的数据结构。',
    private_chat_response_dangerous_key: '私聊回复包含不允许的字段。',
    private_chat_response_sensitive_key: '私聊回复不能包含凭据或敏感字段。',
    private_chat_response_unknown_field: '私聊回复包含不支持的字段。',
    private_chat_response_missing_field: '私聊回复缺少必需字段。',
    private_chat_response_accessor_or_hidden_field: '私聊回复字段格式不安全。',
    private_chat_response_reply_invalid: '私聊文本不符合安全格式。',
    private_chat_response_relationship_invalid: '关系变化数据不符合安全格式。',
    private_chat_response_invalid: '私聊回复无效。',
});

function validationError(code) {
    const error = new TypeError(`${ERROR_PREFIX}${code}`);
    error.code = code;
    return error;
}

function fail(code) {
    throw validationError(code);
}

function isCodecError(error) {
    return error instanceof TypeError
        && typeof error.code === 'string'
        && typeof error.message === 'string'
        && error.message.startsWith(ERROR_PREFIX);
}

function assertSafeKey(key) {
    if (DANGEROUS_KEYS.has(key)) fail('private_chat_response_dangerous_key');
    if (SENSITIVE_KEY_PATTERN.test(key)) fail('private_chat_response_sensitive_key');
}

function ownEnumerableData(record, key) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        fail('private_chat_response_accessor_or_hidden_field');
    }
    return descriptor.value;
}

/**
 * Verifies a plain record without invoking user-controlled getters or using
 * inherited fields. `null`-prototype records are accepted because JSON.parse
 * equivalents can safely produce them; output is always a normal fresh object.
 */
function assertExactRecord(value, required, optional = []) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail('private_chat_response_required');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        fail('private_chat_response_unsafe_prototype');
    }

    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
        if (typeof key !== 'string') fail('private_chat_response_dangerous_key');
        assertSafeKey(key);
        if (!allowed.has(key)) fail('private_chat_response_unknown_field');
        ownEnumerableData(value, key);
    }
    for (const key of required) {
        if (!Object.hasOwn(value, key)) fail('private_chat_response_missing_field');
        ownEnumerableData(value, key);
    }
}

function normalizeShortText(value, maxLength, code) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) fail(code);
    if (value !== value.trim()) fail(code);
    if (CONTROL_CHARACTER_PATTERN.test(value) || HTML_PATTERN.test(value)) fail(code);
    return value;
}

function normalizeRelationship(value) {
    try {
        assertExactRecord(value, RELATIONSHIP_FIELDS);
        const normalized = {};
        for (const field of RELATIONSHIP_FIELDS) {
            const score = ownEnumerableData(value, field);
            if (!Number.isInteger(score) || score < -10 || score > 10) {
                fail('private_chat_response_relationship_invalid');
            }
            normalized[field] = score;
        }
        return normalized;
    } catch (error) {
        if (isCodecError(error)) {
            if (error.code === 'private_chat_response_unknown_field'
                || error.code === 'private_chat_response_dangerous_key'
                || error.code === 'private_chat_response_sensitive_key'
                || error.code === 'private_chat_response_accessor_or_hidden_field'
                || error.code === 'private_chat_response_unsafe_prototype') {
                throw error;
            }
        }
        fail('private_chat_response_relationship_invalid');
    }
}

/**
 * Validates a parsed model response and returns a fresh, safe data-only clone.
 * The accepted schema is exactly { reply, relationship, sessionSummary? }.
 */
export function normalizePrivateChatResponse(raw) {
    try {
        assertExactRecord(raw, ['reply', 'relationship'], ['sessionSummary']);
        const normalized = {
            reply: normalizeShortText(
                ownEnumerableData(raw, 'reply'),
                MAX_PRIVATE_CHAT_REPLY_LENGTH,
                'private_chat_response_reply_invalid',
            ),
            relationship: normalizeRelationship(ownEnumerableData(raw, 'relationship')),
        };
        if (Object.hasOwn(raw, 'sessionSummary')) {
            normalized.sessionSummary = normalizeShortText(
                ownEnumerableData(raw, 'sessionSummary'),
                MAX_PRIVATE_CHAT_SESSION_SUMMARY_LENGTH,
                'private_chat_response_reply_invalid',
            );
        }
        return normalized;
    } catch (error) {
        if (isCodecError(error)) throw error;
        fail('private_chat_response_invalid');
    }
}

/** Projects errors to stable UI-safe data without retaining model source text. */
export function projectPrivateChatResponseError(error) {
    const code = isCodecError(error) ? error.code : 'private_chat_response_invalid';
    return Object.freeze({
        code,
        message: USER_MESSAGES[code] ?? USER_MESSAGES.private_chat_response_invalid,
    });
}

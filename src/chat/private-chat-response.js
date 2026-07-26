/**
 * Pure ESM validator for one private-chat LLM response.
 *
 * This boundary accepts only a parsed JSON-object-shaped value. Parsing model
 * transport output belongs to the caller so a string, SDK response, or other
 * wrapper cannot accidentally be treated as an already validated reply.
 */
import { normalizeImageDirective } from '../images/image-directive.js';

export const MAX_PRIVATE_CHAT_REPLY_COUNT = 6;
export const MAX_PRIVATE_CHAT_REPLY_LENGTH = 600;
export const MAX_PRIVATE_CHAT_REPLIES_TOTAL_LENGTH = 600;
export const MAX_PRIVATE_CHAT_SESSION_SUMMARY_LENGTH = 500;

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_KEY_PATTERN = /(?:api[\s_-]*key|authorization|token|secret|password|credential|private[\s_-]*key|密钥|令牌|密码|授权|凭据)/iu;
const HTML_PATTERN = /<!--|<\s*\/?\s*[a-z][^>]*>/iu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9]\d*)$/u;
const ERROR_PREFIX = 'private_chat_response_validation_failed:';
const RELATIONSHIP_FIELDS = Object.freeze(['好感', '信任', '戒备', '面基意愿']);
const BOND_ASSESSMENT_KINDS = Object.freeze({
    SFW: new Set(['none', 'friendly', 'romantic_flirt']),
    NSFW: new Set(['none', 'romantic_desire', 'sexual_desire']),
});
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

/**
 * 附着在校验错误上的诊断信息（仅供安全控制台 detail 使用）。
 * 硬线：只允许字段名/JSON 路径与期望摘要；relationship 各字段的具体数值
 * （模型增量或任何关系分、阈值）绝不写入 diagnostic。
 */
function validationError(code, diagnostic) {
    const error = new TypeError(`${ERROR_PREFIX}${code}`);
    error.code = code;
    if (diagnostic && typeof diagnostic === 'object') error.diagnostic = Object.freeze({ ...diagnostic });
    return error;
}

function fail(code, diagnostic) {
    throw validationError(code, diagnostic);
}

function isCodecError(error) {
    return error instanceof TypeError
        && typeof error.code === 'string'
        && typeof error.message === 'string'
        && error.message.startsWith(ERROR_PREFIX);
}

function assertSafeKey(key) {
    if (DANGEROUS_KEYS.has(key)) fail('private_chat_response_dangerous_key', { field: key });
    // 敏感键名可能本身就是凭据线索，诊断信息刻意不回显该键。
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
        if (!allowed.has(key)) fail('private_chat_response_unknown_field', { field: key, expected: `仅允许字段：${[...allowed].join('/')}` });
        ownEnumerableData(value, key);
    }
    for (const key of required) {
        if (!Object.hasOwn(value, key)) fail('private_chat_response_missing_field', { field: key, hint: '模型输出缺少该必需字段' });
        ownEnumerableData(value, key);
    }
}

function normalizeShortText(value, maxLength, code, field = '') {
    const diagnostic = field ? { field, expected: `1-${maxLength} 字、无控制字符/HTML 的整洁纯文本` } : undefined;
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) fail(code, diagnostic);
    if (value !== value.trim()) fail(code, diagnostic);
    if (CONTROL_CHARACTER_PATTERN.test(value) || HTML_PATTERN.test(value)) fail(code, diagnostic);
    return value;
}

function normalizeReplies(value) {
    if (!Array.isArray(value)) fail('private_chat_response_reply_invalid', { field: 'replies', expected: '字符串数组' });
    if (Object.getPrototypeOf(value) !== Array.prototype) fail('private_chat_response_unsafe_prototype', { field: 'replies' });
    if (value.length < 1 || value.length > MAX_PRIVATE_CHAT_REPLY_COUNT) {
        fail('private_chat_response_reply_invalid', { field: 'replies', expected: `1-${MAX_PRIVATE_CHAT_REPLY_COUNT} 条`, actual: `${value.length} 条` });
    }

    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') fail('private_chat_response_dangerous_key');
        if (key === 'length') continue;
        assertSafeKey(key);
        if (!ARRAY_INDEX_PATTERN.test(key) || Number(key) >= value.length) {
            fail('private_chat_response_unknown_field');
        }
        ownEnumerableData(value, key);
    }

    const replies = [];
    for (let index = 0; index < value.length; index += 1) {
        replies.push(normalizeShortText(
            ownEnumerableData(value, String(index)),
            MAX_PRIVATE_CHAT_REPLY_LENGTH,
            'private_chat_response_reply_invalid',
            `replies[${index}]`,
        ));
    }
    const joinedLength = replies.join(' ').length;
    if (joinedLength > MAX_PRIVATE_CHAT_REPLIES_TOTAL_LENGTH) {
        fail('private_chat_response_reply_invalid', { field: 'replies', expected: `合并总长 ≤ ${MAX_PRIVATE_CHAT_REPLIES_TOTAL_LENGTH} 字`, actual: `${joinedLength} 字` });
    }
    return replies;
}

function normalizeImageDirectives(value, replyCount) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > replyCount) {
        fail('private_chat_response_invalid', { field: 'imageDirectives', expected: `数量 ≤ replies 条数（${replyCount}）的数组` });
    }
    const seen = new Set();
    return value.map((item, index) => {
        assertExactRecord(item, ['replyIndex', 'directive']);
        const replyIndex = ownEnumerableData(item, 'replyIndex');
        if (!Number.isInteger(replyIndex) || replyIndex < 0 || replyIndex >= replyCount || seen.has(replyIndex)) {
            fail('private_chat_response_invalid', { field: `imageDirectives[${index}].replyIndex`, expected: `0..${replyCount - 1} 且不重复的整数` });
        }
        seen.add(replyIndex);
        let directive;
        try { directive = normalizeImageDirective(ownEnumerableData(item, 'directive')); }
        catch { fail('private_chat_response_invalid', { field: `imageDirectives[${index}].directive`, hint: '生图指令不符合白名单结构' }); }
        return { replyIndex, directive };
    });
}

function normalizeRelationship(value) {
    try {
        assertExactRecord(value, RELATIONSHIP_FIELDS);
        const normalized = {};
        for (const field of RELATIONSHIP_FIELDS) {
            const score = ownEnumerableData(value, field);
            if (!Number.isInteger(score) || score < -10 || score > 10) {
                // 硬线：只报字段名与允许区间，绝不带出模型给的具体增量数值。
                fail('private_chat_response_relationship_invalid', { field: `relationship.${field}`, expected: '-10..10 整数增量', hint: '关系增量校验失败（具体数值不进入诊断详情）' });
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
        fail('private_chat_response_relationship_invalid', (isCodecError(error) && error.diagnostic)
            || { field: 'relationship', expected: '仅含好感/信任/戒备/面基意愿四个整数字段的记录' });
    }
}

function normalizeBondAssessment(value, contentMode) {
    try {
        assertExactRecord(value, ['kind', 'intensity']);
        const kind = ownEnumerableData(value, 'kind');
        const intensity = ownEnumerableData(value, 'intensity');
        const mode = contentMode === 'NSFW' ? 'NSFW' : 'SFW';
        if (typeof kind !== 'string' || !BOND_ASSESSMENT_KINDS[mode].has(kind)) {
            fail('private_chat_response_relationship_invalid', {
                field: 'bondAssessment.kind',
                expected: `${mode} 白名单：${[...BOND_ASSESSMENT_KINDS[mode]].join('/')}`,
                actual: typeof kind === 'string' ? kind.slice(0, 40) : '非字符串',
            });
        }
        if (!Number.isInteger(intensity) || intensity < 0 || intensity > 3 || (kind === 'none' && intensity !== 0) || (kind !== 'none' && intensity === 0)) {
            fail('private_chat_response_relationship_invalid', { field: 'bondAssessment.intensity', expected: '0..3 整数且与 kind 匹配（none 必须为 0，其余为 1-3）' });
        }
        return { kind, intensity };
    } catch (error) {
        if (isCodecError(error) && ['private_chat_response_unknown_field', 'private_chat_response_dangerous_key', 'private_chat_response_sensitive_key', 'private_chat_response_accessor_or_hidden_field', 'private_chat_response_unsafe_prototype'].includes(error.code)) throw error;
        fail('private_chat_response_relationship_invalid', (isCodecError(error) && error.diagnostic) || { field: 'bondAssessment' });
    }
}

/**
 * Validates the current parsed model response shape and returns a fresh,
 * safe data-only clone.
 */
export function normalizePrivateChatResponse(raw, { contentMode = '' } = {}) {
    try {
        assertExactRecord(raw, ['replies', 'relationship'], ['sessionSummary', 'bondAssessment', 'imageDirectives']);
        const replies = normalizeReplies(ownEnumerableData(raw, 'replies'));

        const normalized = {
            replies,
            relationship: normalizeRelationship(ownEnumerableData(raw, 'relationship')),
            bondAssessment: Object.hasOwn(raw, 'bondAssessment')
                ? normalizeBondAssessment(ownEnumerableData(raw, 'bondAssessment'), contentMode)
                : { kind: 'none', intensity: 0 }
        };
        if (Object.hasOwn(raw, 'imageDirectives')) normalized.imageDirectives = normalizeImageDirectives(ownEnumerableData(raw, 'imageDirectives'), replies.length);
        if (Object.hasOwn(raw, 'sessionSummary')) {
            normalized.sessionSummary = normalizeShortText(
                ownEnumerableData(raw, 'sessionSummary'),
                MAX_PRIVATE_CHAT_SESSION_SUMMARY_LENGTH,
                'private_chat_response_reply_invalid',
                'sessionSummary',
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

/**
 * 仅当 error 来自本校验器时，投影出控制台 detail 可用的纯数据诊断
 * （错误码 + 字段路径/期望摘要）；其他错误返回 null。
 * 保证不包含模型原文、对话内容或任何关系数值。
 */
export function projectPrivateChatResponseDiagnostic(error) {
    if (!isCodecError(error)) return null;
    const diagnostic = error.diagnostic && typeof error.diagnostic === 'object' ? error.diagnostic : {};
    return Object.freeze({
        code: error.code,
        field: typeof diagnostic.field === 'string' ? diagnostic.field : undefined,
        expected: typeof diagnostic.expected === 'string' ? diagnostic.expected : undefined,
        actual: typeof diagnostic.actual === 'string' ? diagnostic.actual : undefined,
        hint: typeof diagnostic.hint === 'string' ? diagnostic.hint : undefined,
    });
}

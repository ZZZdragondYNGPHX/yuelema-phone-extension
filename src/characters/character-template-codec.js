/**
 * Pure ESM codec for portable, user-authored character templates.
 *
 * The character payload is deliberately delegated to the same strict adult
 * candidate validator used by recommendation generation. A template never
 * carries a MVU UID, API key, connection preset, or other credential.
 */
import { normalizeGeneratedCandidate } from '../recommendation/candidate.js';

export const CHARACTER_TEMPLATE_FORMAT = 'yuelema.character/v1';
export const MAX_CHARACTER_TEMPLATE_JSON_LENGTH = 1_114_112;
export const MAX_EMBEDDED_AVATAR_DATA_URL_LENGTH = 1_048_576;

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_KEY_PATTERN = /(?:api[\s_-]*key|authorization|token|secret|password|credential|private[\s_-]*key|密钥|令牌|密码|授权|凭据)/iu;
const AVATAR_KINDS = new Set(['placeholder', 'embedded']);
const FIELD_NAME_TRAILING_COLON_PATTERN = /[:：]$/u;
const ERROR_PREFIX = 'character_template_validation_failed:';
const USER_MESSAGES = Object.freeze({
    template_invalid_json: '角色模板 JSON 无法解析。',
    template_too_large: '角色模板超过允许的大小限制。',
    template_record_required: '角色模板必须是对象。',
    template_unsafe_prototype: '角色模板包含不安全的数据结构。',
    template_dangerous_key: '角色模板包含不允许的字段。',
    template_sensitive_key: '角色模板不能包含 API Key 或其他凭据。',
    template_unknown_field: '角色模板包含不支持的字段。',
    template_ambiguous_field: '角色模板包含重复或含义冲突的字段。',
    template_missing_field: '角色模板缺少必需字段。',
    template_accessor_or_hidden_field: '角色模板字段格式不安全。',
    template_format_invalid: '角色模板格式版本不受支持。',
    template_character_invalid: '角色资料未通过完整成年人和结构校验。',
    template_avatar_invalid: '头像资料不符合安全格式。',
    template_options_invalid: '角色模板导出选项无效。',
    template_invalid: '角色模板无效。',
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

function ownData(record, key, code) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail(code);
    return descriptor.value;
}

function assertSafeKey(key) {
    if (DANGEROUS_KEYS.has(key)) fail('template_dangerous_key');
    if (SENSITIVE_KEY_PATTERN.test(key)) fail('template_sensitive_key');
}

/**
 * Accepts the common human-authored variants "字段:", "字段：" and "字段".
 * Only the field-name suffix is normalized; JSON syntax and field values are
 * untouched. Collisions are rejected instead of silently choosing one value.
 */
function normalizePunctuatedFieldNames(value) {
    if (value === null || typeof value !== 'object') return value;
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
        if (prototype !== Array.prototype) fail('template_unsafe_prototype');
    } else if (prototype !== Object.prototype && prototype !== null) {
        fail('template_unsafe_prototype');
    }

    const output = Array.isArray(value) ? [] : Object.create(null);
    const normalizedKeys = new Set();
    for (const key of Reflect.ownKeys(value)) {
        if (key === 'length' && Array.isArray(value)) continue;
        if (typeof key !== 'string') fail('template_dangerous_key');
        const normalizedKey = key.replace(FIELD_NAME_TRAILING_COLON_PATTERN, '');
        if (normalizedKeys.has(normalizedKey)) fail('template_ambiguous_field');
        normalizedKeys.add(normalizedKey);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
            fail('template_accessor_or_hidden_field');
        }
        Object.defineProperty(output, normalizedKey, {
            value: normalizePunctuatedFieldNames(descriptor.value),
            enumerable: true,
            configurable: true,
            writable: true,
        });
    }
    return output;
}

function assertExactRecord(value, { required, optional = [] }) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('template_record_required');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('template_unsafe_prototype');

    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
        if (typeof key !== 'string') fail('template_dangerous_key');
        assertSafeKey(key);
        if (!allowed.has(key)) fail('template_unknown_field');
        ownData(value, key, 'template_accessor_or_hidden_field');
    }
    for (const key of required) {
        if (!Object.hasOwn(value, key)) fail('template_missing_field');
        ownData(value, key, 'template_accessor_or_hidden_field');
    }
}

function base64PrefixBytes(encoded, byteCount = 12) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const output = [];
    let bits = 0;
    let accumulator = 0;
    for (const char of encoded) {
        if (char === '=') break;
        const value = alphabet.indexOf(char);
        if (value < 0) fail('template_avatar_invalid');
        accumulator = (accumulator << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            output.push((accumulator >> bits) & 0xff);
            if (output.length >= byteCount) break;
        }
    }
    return output;
}

/**
 * Normalizes the only avatar transport accepted by character templates: a bounded
 * PNG, JPEG, or WebP base64 data URL with a matching binary signature.
 */
export function normalizeEmbeddedAvatarDataUrl(value) {
    if (typeof value !== 'string' || value.length === 0
        || value.length > MAX_EMBEDDED_AVATAR_DATA_URL_LENGTH || value !== value.trim()) {
        fail('template_avatar_invalid');
    }
    const match = /^data:(image\/(?:png|jpeg|webp));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/iu.exec(value);
    if (!match || match[2].length === 0) fail('template_avatar_invalid');
    const mediaType = match[1].toLowerCase();
    const prefix = base64PrefixBytes(match[2]);
    const hasPrefix = (...bytes) => bytes.every((byte, index) => prefix[index] === byte);
    if (mediaType === 'image/png' && !hasPrefix(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
        fail('template_avatar_invalid');
    }
    if (mediaType === 'image/jpeg' && !hasPrefix(0xff, 0xd8, 0xff)) fail('template_avatar_invalid');
    if (mediaType === 'image/webp'
        && !(hasPrefix(0x52, 0x49, 0x46, 0x46) && prefix[8] === 0x57 && prefix[9] === 0x45
            && prefix[10] === 0x42 && prefix[11] === 0x50)) {
        fail('template_avatar_invalid');
    }
    return 'data:' + mediaType + ';base64,' + match[2];
}

function hasExactEnumerableDataKeys(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) return false;
    return keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
    });
}

/**
 * Returns an avatar-free copy only for an exact persisted legacy kind=url
 * envelope. New imports never call this compatibility helper and still reject URL,
 * blob, and file sources. The helper reads data descriptors only, so a stored URL
 * cannot reach rendering or trigger a network transport.
 */
export function dropLegacyUrlAvatar(input) {
    if (!hasExactEnumerableDataKeys(input, ['format', 'character', 'avatar'])) return null;
    const avatar = Object.getOwnPropertyDescriptor(input, 'avatar').value;
    if (!hasExactEnumerableDataKeys(avatar, ['kind', 'url'])
        || Object.getOwnPropertyDescriptor(avatar, 'kind').value !== 'url'
        || typeof Object.getOwnPropertyDescriptor(avatar, 'url').value !== 'string') {
        return null;
    }
    return {
        format: Object.getOwnPropertyDescriptor(input, 'format').value,
        character: Object.getOwnPropertyDescriptor(input, 'character').value,
    };
}

function normalizeAvatar(input) {
    try {
        assertExactRecord(input, { required: ['kind'], optional: ['dataUrl'] });
        const kind = ownData(input, 'kind', 'template_avatar_invalid');
        if (typeof kind !== 'string' || !AVATAR_KINDS.has(kind)) fail('template_avatar_invalid');

        if (kind === 'placeholder') {
            assertExactRecord(input, { required: ['kind'] });
            return { kind };
        }

        assertExactRecord(input, { required: ['kind', 'dataUrl'] });
        return { kind, dataUrl: normalizeEmbeddedAvatarDataUrl(ownData(input, 'dataUrl', 'template_avatar_invalid')) };
    } catch (error) {
        if (isCodecError(error)) throw error;
        fail('template_avatar_invalid');
    }
}

/** Reuses the exact embedded-avatar policy for non-template presentation stores. */
export function normalizeAvatarReference(input) {
    return Object.freeze(normalizeAvatar(input));
}

function normalizeCharacter(character) {
    try {
        return normalizeGeneratedCandidate(character);
    } catch (error) {
        // Candidate validation errors identify implementation fields. Template UI only
        // needs one stable public code and must never display imported source text.
        // 2026-07-27 控制台诊断增强：把候选校验的稳定错误码（仅字段路径 + 结论，
        // 不含任何导入文本或数值）以 detailCode 附加在模板错误上，供控制台详情使用；
        // 面向界面的 code/message 完全不变。
        const failure = validationError('template_character_invalid');
        if (typeof error?.code === 'string' && error.code) failure.detailCode = error.code;
        throw failure;
    }
}

function normalizeEnvelope(input) {
    try {
        const normalizedInput = normalizePunctuatedFieldNames(input);
        assertExactRecord(normalizedInput, { required: ['format', 'character'], optional: ['avatar'] });
        const format = ownData(normalizedInput, 'format', 'template_format_invalid');
        if (format !== CHARACTER_TEMPLATE_FORMAT) fail('template_format_invalid');

        const normalized = {
            format: CHARACTER_TEMPLATE_FORMAT,
            character: normalizeCharacter(ownData(normalizedInput, 'character', 'template_character_invalid')),
        };
        if (Object.hasOwn(normalizedInput, 'avatar')) {
            normalized.avatar = normalizeAvatar(ownData(normalizedInput, 'avatar', 'template_avatar_invalid'));
        }
        return normalized;
    } catch (error) {
        if (isCodecError(error)) throw error;
        fail('template_invalid');
    }
}

/**
 * Decodes an envelope object or JSON string into an independent, validated clone.
 * It accepts no UID, settings, credentials, or fields outside yuelema.character/v1.
 */
export function importCharacterTemplate(input) {
    if (typeof input === 'string') {
        if (input.length === 0) fail('template_invalid_json');
        if (input.length > MAX_CHARACTER_TEMPLATE_JSON_LENGTH) fail('template_too_large');
        try {
            return normalizeEnvelope(JSON.parse(input));
        } catch (error) {
            if (isCodecError(error)) throw error;
            fail('template_invalid_json');
        }
    }
    return normalizeEnvelope(input);
}

/**
 * Encodes a portable template JSON document. Avatar export is opt-in at call time;
 * no credentials are accepted by the envelope validator or emitted in the result.
 */
export function exportCharacterTemplate(input, { includeAvatar = true } = {}) {
    if (typeof includeAvatar !== 'boolean') fail('template_options_invalid');
    const normalized = importCharacterTemplate(input);
    if (!includeAvatar || !Object.hasOwn(normalized, 'avatar')) {
        return JSON.stringify({ format: CHARACTER_TEMPLATE_FORMAT, character: normalized.character });
    }
    return JSON.stringify(normalized);
}

/** Returns a UI-safe, stable projection without retaining raw imported content. */
export function projectCharacterTemplateError(error) {
    const code = isCodecError(error) ? error.code : 'template_invalid';
    const detailCode = isCodecError(error) && typeof error.detailCode === 'string' && error.detailCode ? error.detailCode : '';
    return Object.freeze({
        code,
        message: USER_MESSAGES[code] ?? USER_MESSAGES.template_invalid,
        // 控制台诊断专用：仅错误码与字段路径结论，不含导入文本；无更细信息时为空串。
        detail: detailCode ? `模板校验错误码: ${code}；字段/结论: ${detailCode}` : `模板校验错误码: ${code}`,
    });
}

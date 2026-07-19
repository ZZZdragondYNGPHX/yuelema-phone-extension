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
const HTML_PATTERN = /<!--|<\s*\/?\s*[a-z][^>]*>/iu;
const AVATAR_KINDS = new Set(['placeholder', 'url', 'embedded']);
const ERROR_PREFIX = 'character_template_validation_failed:';
const USER_MESSAGES = Object.freeze({
    template_invalid_json: '角色模板 JSON 无法解析。',
    template_too_large: '角色模板超过允许的大小限制。',
    template_record_required: '角色模板必须是对象。',
    template_unsafe_prototype: '角色模板包含不安全的数据结构。',
    template_dangerous_key: '角色模板包含不允许的字段。',
    template_sensitive_key: '角色模板不能包含 API Key 或其他凭据。',
    template_unknown_field: '角色模板包含不支持的字段。',
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

function normalizeText(value, maxLength) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) fail('template_avatar_invalid');
    if (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value) || HTML_PATTERN.test(value)) fail('template_avatar_invalid');
    return value;
}

function decodeBase64ForInspection(base64) {
    try {
        if (typeof globalThis.atob === 'function') return globalThis.atob(base64);
        // Browser-compatible fallback that does not depend on Node Buffer.
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let output = '';
        let bits = 0;
        let accumulator = 0;
        for (const char of base64.replace(/=+$/u, '')) {
            const value = alphabet.indexOf(char);
            if (value < 0) return null;
            accumulator = (accumulator << 6) | value;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                output += String.fromCharCode((accumulator >> bits) & 0xff);
            }
        }
        return output;
    } catch {
        return null;
    }
}

function normalizeAvatar(input) {
    try {
        assertExactRecord(input, { required: ['kind'], optional: ['url', 'dataUrl'] });
        const kind = ownData(input, 'kind', 'template_avatar_invalid');
        if (typeof kind !== 'string' || !AVATAR_KINDS.has(kind)) fail('template_avatar_invalid');

        if (kind === 'placeholder') {
            assertExactRecord(input, { required: ['kind'] });
            return { kind };
        }

        if (kind === 'url') {
            assertExactRecord(input, { required: ['kind', 'url'] });
            const url = normalizeText(ownData(input, 'url', 'template_avatar_invalid'), 2_048);
            let parsed;
            try { parsed = new URL(url); } catch { fail('template_avatar_invalid'); }
            if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
                fail('template_avatar_invalid');
            }
            return { kind, url: parsed.href };
        }

        assertExactRecord(input, { required: ['kind', 'dataUrl'] });
        const dataUrl = normalizeText(ownData(input, 'dataUrl', 'template_avatar_invalid'), MAX_EMBEDDED_AVATAR_DATA_URL_LENGTH);
        const match = /^data:(image\/(?:png|jpeg|webp));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/iu.exec(dataUrl);
        if (!match || match[2].length === 0) fail('template_avatar_invalid');
        const decoded = decodeBase64ForInspection(match[2]);
        if (decoded === null || decoded.length === 0 || HTML_PATTERN.test(decoded)) fail('template_avatar_invalid');
        return { kind, dataUrl: `data:${match[1].toLowerCase()};base64,${match[2]}` };
    } catch (error) {
        if (isCodecError(error)) throw error;
        fail('template_avatar_invalid');
    }
}

function normalizeCharacter(character) {
    try {
        return normalizeGeneratedCandidate(character);
    } catch {
        // Candidate validation errors identify implementation fields. Template UI only
        // needs one stable public code and must never display imported source text.
        fail('template_character_invalid');
    }
}

function normalizeEnvelope(input) {
    try {
        assertExactRecord(input, { required: ['format', 'character'], optional: ['avatar'] });
        const format = ownData(input, 'format', 'template_format_invalid');
        if (format !== CHARACTER_TEMPLATE_FORMAT) fail('template_format_invalid');

        const normalized = {
            format: CHARACTER_TEMPLATE_FORMAT,
            character: normalizeCharacter(ownData(input, 'character', 'template_character_invalid')),
        };
        if (Object.hasOwn(input, 'avatar')) {
            normalized.avatar = normalizeAvatar(ownData(input, 'avatar', 'template_avatar_invalid'));
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
    return Object.freeze({
        code,
        message: USER_MESSAGES[code] ?? USER_MESSAGES.template_invalid,
    });
}

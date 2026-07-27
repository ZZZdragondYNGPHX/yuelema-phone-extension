/**
 * Strict, model-facing drawing directive codec and program-owned prompt composer.
 * The model may describe only the scene. Character DNA and fixed prompts remain
 * owned by the extension and are never accepted from a chat response.
 */

export const IMAGE_DIRECTIVE_KINDS = Object.freeze(['share_photo', 'selfie', 'scene_snapshot', 'private_photo']);
export const MAX_IMAGE_SCENE_LENGTH = 1800;
export const MAX_DRAWING_DNA_LENGTH = 12_000;
export const MAX_FIXED_PROMPT_LENGTH = 8_000;

const KIND_SET = new Set(IMAGE_DIRECTIVE_KINDS);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_PATTERN = /(?:api[\s_-]*key|authorization|token|secret|password|credential|private[\s_-]*key|密钥|令牌|密码|授权|凭据)/iu;
const HTML_PATTERN = /<!--|<\s*\/?\s*[a-z][^>]*>/iu;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const LORA_PROMPT_TOKEN_PATTERN = /<lora:[^:<>\u0000-\u001f\u007f]{1,200}:-?(?:\d+(?:\.\d+)?|\.\d+)>/giu;

export class ImageDirectiveError extends Error {
    constructor(code, message = '绘图结构不符合安全格式。') {
        super(message);
        this.name = 'ImageDirectiveError';
        this.code = code;
    }
}

function fail(code, message) { throw new ImageDirectiveError(code, message); }
function isPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function ownValue(record, key) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('IMAGE_DIRECTIVE_FIELD_UNSAFE');
    return descriptor.value;
}
function cleanText(value, field, maxLength, { allowEmpty = false } = {}) {
    if (typeof value !== 'string') fail('IMAGE_DIRECTIVE_TEXT_INVALID', `${field}必须是文本。`);
    const text = value.trim();
    if ((!allowEmpty && !text) || text.length > maxLength || CONTROL_PATTERN.test(text) || HTML_PATTERN.test(text)) {
        fail('IMAGE_DIRECTIVE_TEXT_INVALID', `${field}包含不允许的内容。`);
    }
    return text;
}

export function normalizeImageDirective(input) {
    if (!isPlainRecord(input)) fail('IMAGE_DIRECTIVE_REQUIRED');
    const allowed = new Set(['kind', 'scene']);
    for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== 'string' || DANGEROUS_KEYS.has(key) || SENSITIVE_PATTERN.test(key) || !allowed.has(key)) {
            fail('IMAGE_DIRECTIVE_UNKNOWN_FIELD');
        }
        ownValue(input, key);
    }
    for (const key of allowed) if (!Object.hasOwn(input, key)) fail('IMAGE_DIRECTIVE_MISSING_FIELD');
    const kind = cleanText(ownValue(input, 'kind'), 'kind', 32);
    if (!KIND_SET.has(kind)) fail('IMAGE_DIRECTIVE_KIND_INVALID');
    const scene = cleanText(ownValue(input, 'scene'), 'scene', MAX_IMAGE_SCENE_LENGTH);
    return Object.freeze({ kind, scene });
}


function cleanOwnedPrompt(value, field, maxLength) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') fail('IMAGE_DIRECTIVE_TEXT_INVALID', `${field}必须是文本。`);
    const text = value.trim();
    const withoutLoraTokens = text.replace(LORA_PROMPT_TOKEN_PATTERN, '');
    if (text.length > maxLength || CONTROL_PATTERN.test(text) || HTML_PATTERN.test(withoutLoraTokens)) {
        fail('IMAGE_DIRECTIVE_TEXT_INVALID', `${field}包含不允许的内容。`);
    }
    return text;
}

/**
 * Positive order is immutable: prefix -> core DNA -> outfit DNA -> model scene -> suffix.
 * The negative prompt is returned separately and never merged with model output.
 */
export function composeImagePrompt({ positivePrefix = '', coreDna = '', outfitDna = '', directive, positiveSuffix = '', negativePrompt = '' } = {}) {
    const safeDirective = normalizeImageDirective(directive);
    const parts = [
        cleanOwnedPrompt(positivePrefix, '前置正面提示词', MAX_FIXED_PROMPT_LENGTH),
        cleanOwnedPrompt(coreDna, '绘图 core_dna', MAX_DRAWING_DNA_LENGTH),
        cleanOwnedPrompt(outfitDna, '绘图 outfit_dna', MAX_DRAWING_DNA_LENGTH),
        safeDirective.scene,
        cleanOwnedPrompt(positiveSuffix, '后置正面提示词', MAX_FIXED_PROMPT_LENGTH),
    ].filter(Boolean);
    return Object.freeze({
        positivePrompt: parts.join(', '),
        negativePrompt: cleanOwnedPrompt(negativePrompt, '固定负面提示词', MAX_FIXED_PROMPT_LENGTH),
        directive: safeDirective,
    });
}

export function formatImageDirective(directive) {
    const safe = normalizeImageDirective(directive);
    return JSON.stringify(safe, null, 2);
}

/**
 * Strict, model-facing drawing directive codec and program-owned prompt composer.
 * The model may describe only a scene (and an optional, one-image outfit override).
 * Character core DNA and fixed prompts remain owned by the extension and are never
 * accepted from a chat response.
 */

export const IMAGE_DIRECTIVE_KINDS = Object.freeze(['share_photo', 'selfie', 'scene_snapshot', 'private_photo']);
export const MAX_IMAGE_SCENE_LENGTH = 1800;
export const MAX_IMAGE_OUTFIT_LENGTH = 1800;
export const MAX_DRAWING_DNA_LENGTH = 12_000;
export const MAX_FIXED_PROMPT_LENGTH = 8_000;

const KIND_SET = new Set(IMAGE_DIRECTIVE_KINDS);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_PATTERN = /(?:api[\s_-]*key|authorization|token|secret|password|credential|private[\s_-]*key|密钥|令牌|密码|授权|凭据)/iu;
const HTML_PATTERN = /<!--|<\s*\/?\s*[a-z][^>]*>/iu;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const LORA_PROMPT_TOKEN_PATTERN = /<lora:[^:<>'\u0000-\u001f\u007f]{1,200}:-?(?:\d+(?:\.\d+)?|\.\d+)>/giu;

// Private-chat models may direct a pose and setting, but never redraw who the
// character is. These intentionally match semantic DNA vocabulary rather than
// arbitrary colour words, which remain useful for lighting and scenery.
const PRIVATE_SCENE_DNA_PATTERN = /(?:\b(?:young|old|adult|teen(?:age)?|child|minor|girl|boy|woman|man|person|people|character|subject|female|male|nonbinary|cute|beautiful|pretty|handsome|gorgeous|sexy|attractive|asian|african|caucasian|latina?|ethnic(?:ity)?|race|skin|complexion|face|facial|hair|hairstyle|bangs?|ponytail|eyes?|iris|pupil|body|figure|physique|height|weight|breast(?:s)?|bust|waist|hip(?:s)?|lips?|makeup|cosmetic(?:s)?|outfit|clothes?|clothing|costume|cosplay|dress|gown|shirt|skirt|pants?|trousers|shorts|jacket|coat|uniform|lingerie|bikini|swimsuit|kimono|wig)\b|(?:人物|角色|身份|年龄|性别|可爱|漂亮|美丽|好看|性感|女性|男性|女生|男生|女孩|男孩|少女|少年|女人|男人|亚洲(?:人)?|族裔|种族|肤色|皮肤|脸部?|五官|发型|头发|眼睛|瞳孔|身材|体型|胸部?|腰(?:部)?|臀(?:部)?|嘴唇|妆容|化妆|服装|衣服|穿着|裙子|礼服|衬衫|上衣|裤子|外套|制服|内衣|比基尼|泳装|和服|假发))/iu;
const PRIVATE_OUTFIT_DNA_PATTERN = /(?:\b(?:young|old|adult|teen(?:age)?|child|minor|girl|boy|woman|man|female|male|nonbinary|asian|african|caucasian|latina?|ethnic(?:ity)?|race|skin|complexion|face|facial|hair|hairstyle|bangs?|ponytail|eyes?|iris|pupil|body|figure|physique|height|weight|breast(?:s)?|bust|waist|hip(?:s)?|lips?|makeup|cosmetic(?:s)?|wig)\b|(?:人物|角色|身份|年龄|性别|可爱|漂亮|美丽|好看|性感|女性|男性|女生|男生|女孩|男孩|少女|少年|女人|男人|亚洲(?:人)?|族裔|种族|肤色|皮肤|脸部?|五官|发型|头发|眼睛|瞳孔|身材|体型|胸部?|腰(?:部)?|臀(?:部)?|嘴唇|妆容|化妆|假发))/iu;

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

/**
 * Generic directive codec for program-owned and non-private-chat callers.
 * It deliberately does not apply private-chat semantic limits to a manual image
 * library scene snapshot. An optional outfit is transient directive data only.
 */
export function normalizeImageDirective(input) {
    if (!isPlainRecord(input)) fail('IMAGE_DIRECTIVE_REQUIRED');
    const allowed = new Set(['kind', 'scene', 'outfit']);
    for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== 'string' || DANGEROUS_KEYS.has(key) || SENSITIVE_PATTERN.test(key) || !allowed.has(key)) {
            fail('IMAGE_DIRECTIVE_UNKNOWN_FIELD');
        }
        ownValue(input, key);
    }
    for (const key of ['kind', 'scene']) if (!Object.hasOwn(input, key)) fail('IMAGE_DIRECTIVE_MISSING_FIELD');
    const kind = cleanText(ownValue(input, 'kind'), 'kind', 32);
    if (!KIND_SET.has(kind)) fail('IMAGE_DIRECTIVE_KIND_INVALID');
    const scene = cleanText(ownValue(input, 'scene'), 'scene', MAX_IMAGE_SCENE_LENGTH);
    const hasOutfit = Object.hasOwn(input, 'outfit');
    if (kind === 'scene_snapshot' && hasOutfit) fail('IMAGE_DIRECTIVE_OUTFIT_NOT_ALLOWED');
    const outfit = hasOutfit ? cleanText(ownValue(input, 'outfit'), 'outfit', MAX_IMAGE_OUTFIT_LENGTH) : '';
    return Object.freeze({ kind, scene, ...(hasOutfit ? { outfit } : {}) });
}

/**
 * Private-chat-only directive codec. It first applies the generic structural
 * codec, then prevents the model from supplying identity DNA. `outfit` is a
 * non-persistent, one-image clothing/accessory replacement for `outfitDna`.
 */
export function normalizePrivateChatImageDirective(input) {
    const directive = normalizeImageDirective(input);
    if (PRIVATE_SCENE_DNA_PATTERN.test(directive.scene)) {
        fail('IMAGE_DIRECTIVE_PRIVATE_SCENE_DNA', '私聊 scene 只能描述动作、镜头、背景、光线或道具。');
    }
    if (Object.hasOwn(directive, 'outfit') && PRIVATE_OUTFIT_DNA_PATTERN.test(directive.outfit)) {
        fail('IMAGE_DIRECTIVE_PRIVATE_OUTFIT_DNA', '私聊 outfit 只能描述本图衣物或配饰。');
    }
    return directive;
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
 * Positive order is immutable: prefix -> core DNA -> effective outfit -> model scene -> suffix.
 * A directive outfit replaces (rather than appends to) the character outfit DNA for this image.
 * The negative prompt is returned separately and never merged with model output.
 */
export function composeImagePrompt({ positivePrefix = '', coreDna = '', outfitDna = '', directive, positiveSuffix = '', negativePrompt = '' } = {}) {
    const safeDirective = normalizeImageDirective(directive);
    const effectiveOutfit = Object.hasOwn(safeDirective, 'outfit') ? safeDirective.outfit : outfitDna;
    const parts = [
        cleanOwnedPrompt(positivePrefix, '前置正面提示词', MAX_FIXED_PROMPT_LENGTH),
        cleanOwnedPrompt(coreDna, '绘图 core_dna', MAX_DRAWING_DNA_LENGTH),
        cleanOwnedPrompt(effectiveOutfit, '绘图 outfit_dna', MAX_DRAWING_DNA_LENGTH),
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

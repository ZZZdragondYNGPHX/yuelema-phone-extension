import { requireSessionKey, SessionKeyUnavailableError } from './session-key-store.js';

const SAFE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1_048_576;
const MAX_COMFY_JSON_BYTES = 2 * 1024 * 1024;
const MAX_COMFY_OBJECT_INFO_BYTES = 32 * 1024 * 1024;
const MAX_HTTP_ERROR_DIAGNOSTIC_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_COMFY_CUSTOM_WORKFLOW_TIMEOUT_MS = 600_000;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const UNSAFE_WORKFLOW_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SAFE_PROVIDER_ERROR_FIELDS = Object.freeze(['input', 'model', 'action', 'parameters', 'v4_prompt', 'v4_negative_prompt', 'negative_prompt', 'width', 'height', 'scale', 'cfg_rescale', 'steps', 'sampler', 'noise_schedule', 'seed']);
let imageRequestSequence = 0;

function defaultRandomUint32() {
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
        const values = new Uint32Array(1);
        globalThis.crypto.getRandomValues(values);
        return values[0];
    }
    return Math.floor(Math.random() * 0x1_0000_0000);
}
function createComfyRuntimeSeedGenerator(randomUint32) {
    let previousSeed = 0;
    return () => {
        let candidate;
        try { candidate = Number(randomUint32()); } catch { candidate = defaultRandomUint32(); }
        if (!Number.isInteger(candidate) || candidate < 0 || candidate > 0xffffffff) candidate = defaultRandomUint32();
        let seed = (candidate >>> 0) || 1;
        if (seed === previousSeed) seed = seed === 0xffffffff ? 1 : seed + 1;
        previousSeed = seed;
        return seed;
    };
}

export class YueLeMaImageGenerationError extends Error {
    constructor(code, message, { retryable = false, status } = {}) {
        super(message);
        this.name = 'YueLeMaImageGenerationError';
        this.code = code;
        this.retryable = retryable;
        if (Number.isInteger(status)) this.status = status;
    }
}
function fail(code, message, details) { throw new YueLeMaImageGenerationError(code, message, details); }
function emitImageDiagnostic(logger, level, event, details) {
    const method = logger?.[level];
    if (typeof method !== 'function') return;
    try {
        method.call(logger, `[约了吗][生图] ${event}`, Object.freeze({ ...details }));
    } catch {
        // Diagnostics must never change the generation result.
    }
}
function imageErrorDetails(error) {
    if (error instanceof YueLeMaImageGenerationError || error instanceof SessionKeyUnavailableError) {
        return {
            code: error.code ?? 'SESSION_KEY_LOCKED',
            message: error.message,
            retryable: Boolean(error.retryable),
            status: Number.isInteger(error.status) ? error.status : undefined,
        };
    }
    return { code: 'IMAGE_UNKNOWN_ERROR', retryable: false, status: undefined };
}
function safeErrorType(error) { return ['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'DOMException'].includes(error?.name) ? error.name : undefined; }
function safeResponseTrace(response) {
    const header = (name, maximum = 160) => {
        const value = String(response?.headers?.get?.(name) ?? '').trim();
        return value && /^[\x20-\x7e]+$/u.test(value) ? value.slice(0, maximum) : undefined;
    };
    return {
        requestTraceId: header('x-request-id') ?? header('x-correlation-id'),
        edgeTraceId: header('cf-ray', 80),
        retryAfter: header('retry-after', 80),
        server: header('server', 80),
    };
}
function providerErrorCategory(status, message = '') {
    const text = String(message).toLowerCase();
    if (/anlas|balance|credit|quota|subscription|payment/u.test(text) || status === 402) return 'subscription_or_quota';
    if (/api.?key|access.?token|auth|unauthor/u.test(text) || status === 401) return 'authentication';
    if (/rate.?limit|too many requests/u.test(text) || status === 429) return 'rate_limit';
    if (/model/u.test(text)) return 'model_validation';
    if (status === 400 || /valid|parameter|prompt|sampler|schedule|width|height|steps|seed|cfg/u.test(text)) return 'request_validation';
    if (status >= 500) return 'provider_unavailable';
    return 'http_error';
}
function redactProviderBodyExcerpt(value, sensitiveValues = []) {
    let text = String(value ?? '');
    const secrets = sensitiveValues.map((item) => String(item ?? '').trim()).filter(Boolean);
    const fragments = secrets
        .flatMap((item) => [item, ...item.split(/[,|\r\n]+/u).map((part) => part.trim())])
        .filter((item) => item.length >= 8)
        .flatMap((item) => [item, JSON.stringify(item)])
        .sort((left, right) => right.length - left.length);
    for (const fragment of new Set(fragments)) text = text.split(fragment).join('[REDACTED]');
    for (const secret of secrets.filter((item) => item.length < 8)) {
        text = text.split(JSON.stringify(secret)).join('"[REDACTED]"');
        const escaped = secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu'), '[REDACTED]');
    }
    return text
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, 'Bearer [REDACTED]')
        .replace(/("(?:api[_-]?key|authorization|access[_-]?token|token|key)"\s*:\s*")[^"]+(")/giu, '$1[REDACTED]$2')
        .replace(/[A-Za-z0-9+/]{80,}={0,2}/gu, '[REDACTED_LONG_DATA]')
        .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
        .trim()
        .slice(0, 1200);
}
async function safeHttpErrorDiagnostic(response, sensitiveValues = []) {
    const status = Number.isInteger(response?.status) ? response.status : undefined;
    const fallback = { providerCategory: providerErrorCategory(status), bodyInspection: 'unavailable' };
    try {
        const copy = typeof response?.clone === 'function' ? response.clone() : response;
        const bytes = await readResponseBytes(copy, MAX_HTTP_ERROR_DIAGNOSTIC_BYTES);
        const text = new TextDecoder().decode(bytes);
        const providerBodyExcerpt = redactProviderBodyExcerpt(text, sensitiveValues) || undefined;
        let payload;
        try { payload = JSON.parse(text); } catch {
            return { ...fallback, bodyInspection: 'non_json', bodyBytes: bytes.length, providerBodyExcerpt };
        }
        const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
        const message = [record.message, record.detail, record.title, typeof record.error === 'string' ? record.error : ''].find((value) => typeof value === 'string') ?? '';
        const code = typeof record.code === 'string' && /^[A-Za-z0-9_.:/-]{1,120}$/u.test(record.code) ? record.code : undefined;
        const validationFields = SAFE_PROVIDER_ERROR_FIELDS.filter((field) => message.toLowerCase().includes(field.toLowerCase()));
        return {
            providerCategory: providerErrorCategory(status, message),
            bodyInspection: 'structured_json',
            bodyBytes: bytes.length,
            responseSchemaFields: ['statusCode', 'message', 'detail', 'title', 'error', 'errors', 'code', 'type'].filter((field) => Object.hasOwn(record, field)),
            providerStatusCode: Number.isInteger(record.statusCode) ? record.statusCode : undefined,
            providerErrorCode: code,
            providerMessageChars: message.length || undefined,
            providerValidationFields: validationFields.length ? validationFields : undefined,
            providerErrorCount: Array.isArray(record.errors) ? record.errors.length : undefined,
            providerBodyExcerpt,
        };
    } catch (error) { return { ...fallback, bodyInspection: error instanceof YueLeMaImageGenerationError ? 'too_large_or_invalid' : 'read_failed' }; }
}
function isNovelAIV4Model(model) { return /^nai-diffusion-4(?:-|$)/iu.test(String(model ?? '').trim()); }
function cleanText(value, field, maxLength, { allowEmpty = false } = {}) {
    if (typeof value !== 'string') fail('INVALID_IMAGE_REQUEST', `${field}必须是文本。`);
    const text = value.trim();
    if ((!allowEmpty && !text) || text.length > maxLength || CONTROL_PATTERN.test(text)) fail('INVALID_IMAGE_REQUEST', `${field}无效。`);
    return text;
}
function cleanInteger(value, field, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) fail('INVALID_IMAGE_REQUEST', `${field}无效。`);
    return value;
}
function cleanNumber(value, field, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail('INVALID_IMAGE_REQUEST', `${field}无效。`);
    return value;
}
function cleanWorkflow(value) {
    if (typeof value !== 'string') fail('INVALID_IMAGE_REQUEST', 'ComfyUI 工作流必须是文本。');
    const text = value.trim();
    if (text.length > 200_000 || /[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
        fail('INVALID_IMAGE_REQUEST', 'ComfyUI 工作流无效。');
    }
    return text;
}
function safeBaseUrl(value) {
    const text = cleanText(value, '生图接口地址', 2048).replace(/\/+$/u, '');
    let url;
    try { url = new URL(text); } catch { fail('INVALID_IMAGE_REQUEST', '生图接口地址无效。'); }
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) fail('INVALID_IMAGE_REQUEST', '生图接口地址无效。');
    return url.toString().replace(/\/$/u, '');
}
function safeEndpointPath(value) {
    const path = cleanText(value, '生图接口路径', 256);
    if (!path.startsWith('/') || path.includes('..') || path.includes('?') || path.includes('#')) fail('INVALID_IMAGE_REQUEST', '生图接口路径无效。');
    return path;
}
function bytesToBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let binary = '';
    const chunk = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    return btoa(binary);
}
function base64ToBytes(value) {
    if (typeof value !== 'string' || value.length < 8 || value.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
        fail('INVALID_IMAGE_RESPONSE', '生图接口返回了无效图片。');
    }
    try {
        if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'));
        const binary = atob(value);
        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } catch { fail('INVALID_IMAGE_RESPONSE', '生图接口返回了无效图片。'); }
}
function detectMime(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 12 || bytes.length > MAX_IMAGE_BYTES) return '';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return 'image/jpeg';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    return '';
}
function imageResultFromBytes(bytes) {
    const mimeType = detectMime(bytes);
    if (!mimeType) fail('INVALID_IMAGE_RESPONSE', '生图接口返回了不受支持的图片格式。');
    return Object.freeze({ kind: 'data_url', mimeType, src: `data:${mimeType};base64,${bytesToBase64(bytes)}` });
}
function responseTooLarge(code, message) {
    fail(code ?? 'INVALID_IMAGE_RESPONSE', message ?? '生图接口返回的图片过大。');
}
function declaredResponseLength(response, maximum, tooLarge = {}) {
    const raw = response.headers?.get?.('content-length');
    if (raw === null || raw === undefined || raw === '') return null;
    if (!/^[0-9]+$/u.test(String(raw))) fail('INVALID_IMAGE_RESPONSE', '生图接口返回了无效图片。');
    const length = Number(raw);
    if (!Number.isSafeInteger(length) || length > maximum) responseTooLarge(tooLarge.code, tooLarge.message);
    return length;
}
async function readReadableStreamBytes(stream, maximum, tooLarge = {}) {
    const reader = stream?.getReader?.();
    if (!reader) return null;
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
            total += chunk.length;
            if (total > maximum) responseTooLarge(tooLarge.code, tooLarge.message);
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock?.();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
}
async function readResponseBytes(response, maximum, tooLarge = {}) {
    declaredResponseLength(response, maximum, tooLarge);
    const streamed = await readReadableStreamBytes(response.body, maximum, tooLarge);
    if (streamed) return streamed;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maximum) responseTooLarge(tooLarge.code, tooLarge.message);
    return bytes;
}
function readU16(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8); }
function readU32(bytes, offset) { return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0; }
function findCentralZipImage(bytes) {
    const decoder = new TextDecoder();
    const minimum = Math.max(0, bytes.length - 65_557);
    let eocd = -1;
    for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
        if (readU32(bytes, offset) === 0x06054b50) { eocd = offset; break; }
    }
    if (eocd < 0) return null;
    const entries = readU16(bytes, eocd + 10);
    const directorySize = readU32(bytes, eocd + 12);
    let offset = readU32(bytes, eocd + 16);
    if (entries === 0xffff || directorySize === 0xffffffff || offset + directorySize > eocd) return null;
    let best = null;
    for (let index = 0; index < entries; index += 1) {
        if (offset + 46 > bytes.length || readU32(bytes, offset) !== 0x02014b50) return null;
        const flags = readU16(bytes, offset + 8);
        const method = readU16(bytes, offset + 10);
        const compressedSize = readU32(bytes, offset + 20);
        const uncompressedSize = readU32(bytes, offset + 24);
        const filenameLength = readU16(bytes, offset + 28);
        const extraLength = readU16(bytes, offset + 30);
        const commentLength = readU16(bytes, offset + 32);
        const localOffset = readU32(bytes, offset + 42);
        const next = offset + 46 + filenameLength + extraLength + commentLength;
        if (next > bytes.length) return null;
        const filename = decoder.decode(bytes.slice(offset + 46, offset + 46 + filenameLength));
        if ((flags & 1) === 0 && /\.(?:png|jpe?g|webp)$/iu.test(filename)
            && [0, 8].includes(method) && compressedSize > 0
            && compressedSize <= MAX_IMAGE_BYTES && uncompressedSize <= MAX_IMAGE_BYTES
            && localOffset + 30 <= bytes.length && readU32(bytes, localOffset) === 0x04034b50) {
            const start = localOffset + 30 + readU16(bytes, localOffset + 26) + readU16(bytes, localOffset + 28);
            if (start + compressedSize <= bytes.length && (!best || uncompressedSize > best.uncompressedSize)) {
                best = { method, compressedSize, uncompressedSize, start };
            }
        }
        offset = next;
    }
    return best;
}
async function extractFirstZipImage(bytes) {
    if (bytes.length < 30 || readU32(bytes, 0) !== 0x04034b50) return null;
    const central = findCentralZipImage(bytes);
    const flags = readU16(bytes, 6);
    const method = central?.method ?? readU16(bytes, 8);
    const compressedSize = central?.compressedSize ?? readU32(bytes, 18);
    const start = central?.start ?? 30 + readU16(bytes, 26) + readU16(bytes, 28);
    if ((!central && (flags & 0x08) !== 0) || compressedSize < 1 || compressedSize > MAX_IMAGE_BYTES) return null;
    const end = start + compressedSize;
    if (end > bytes.length) return null;
    const payload = bytes.slice(start, end);
    if (method === 0) return imageResultFromBytes(payload);
    if (method !== 8 || typeof DecompressionStream !== 'function') return null;
    try {
        const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const output = await readReadableStreamBytes(stream, MAX_IMAGE_BYTES);
        return output ? imageResultFromBytes(output) : null;
    } catch { return null; }
}
function buildBody(settings, positivePrompt, negativePrompt) {
    if (settings.apiMode === 'novelai') {
        const parameters = {
            width: settings.width, height: settings.height, scale: settings.guidance,
            cfg_rescale: settings.guidanceRescale, steps: settings.steps, sampler: settings.sampler,
            noise_schedule: settings.noiseSchedule, seed: settings.seed, negative_prompt: negativePrompt,
            qualityToggle: settings.qualityToggle, sm: settings.variety, sm_dyn: settings.variety,
            n_samples: 1, ucPreset: 0,
        };
        if (isNovelAIV4Model(settings.model)) {
            Object.assign(parameters, {
                params_version: 3, prefer_brownian: true, dynamic_thresholding: false,
                controlnet_strength: 1, legacy: false, add_original_image: false,
                legacy_v3_extend: false, deliberate_euler_ancestral_bug: false,
                v4_prompt: {
                    caption: { base_caption: positivePrompt, char_captions: [] },
                    use_coords: false, use_order: true, legacy_uc: false,
                },
                v4_negative_prompt: {
                    caption: { base_caption: negativePrompt, char_captions: [] },
                    use_coords: false, use_order: true, legacy_uc: false,
                },
            });
        }
        return {
            input: positivePrompt,
            model: settings.model,
            action: 'generate',
            parameters,
        };
    }
    const prompt = negativePrompt
        ? `${positivePrompt}. Avoid the following visual elements: ${negativePrompt}.`
        : positivePrompt;
    const requestedSize = `${settings.width}x${settings.height}`;
    const model = settings.model.toLowerCase();
    const size = /^gpt-image-2(?:-|$)/u.test(model)
        ? requestedSize
        : /^gpt-image-/u.test(model)
            ? (settings.width === settings.height ? '1024x1024' : settings.width > settings.height ? '1536x1024' : '1024x1536')
            : model === 'dall-e-3'
                ? (settings.width === settings.height ? '1024x1024' : settings.width > settings.height ? '1792x1024' : '1024x1792')
                : model === 'dall-e-2'
                    ? '1024x1024'
                    : requestedSize;
    return {
        model: settings.model,
        prompt,
        size,
        ...(/^gpt-image-/iu.test(settings.model) ? {} : { response_format: 'b64_json' }),
        n: 1,
    };
}
function normalizeRequest(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_IMAGE_REQUEST', '生图请求无效。');
    const settings = input.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) fail('INVALID_IMAGE_REQUEST', '生图设置无效。');
    const apiMode = settings.apiMode === 'openai_compatible'
        ? 'openai_compatible'
        : settings.apiMode === 'novelai' ? 'novelai' : settings.apiMode === 'comfyui' ? 'comfyui' : fail('INVALID_IMAGE_REQUEST', '生图接口模式无效。');
    const comfy = apiMode === 'comfyui';
    const comfyWorkflow = cleanWorkflow(settings.comfyWorkflow ?? '');
    const customComfyWorkflow = comfy && Boolean(comfyWorkflow);
    const defaultTimeoutMs = customComfyWorkflow ? DEFAULT_COMFY_CUSTOM_WORKFLOW_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    const maximumTimeoutMs = customComfyWorkflow ? 900_000 : 300_000;
    return {
        positivePrompt: cleanText(input.positivePrompt, '正面提示词', 32_000),
        negativePrompt: cleanText(input.negativePrompt ?? '', '负面提示词', 12_000, { allowEmpty: true }),
        signal: input.signal,
        timeoutMs: input.timeoutMs === undefined ? defaultTimeoutMs : cleanInteger(input.timeoutMs, '超时时间', 1_000, maximumTimeoutMs),
        settings: {
            apiMode,
            presetId: cleanText(apiMode === 'openai_compatible' ? (settings.openaiPresetId ?? settings.presetId) : settings.presetId, '生图连接 ID', 96),
            baseUrl: safeBaseUrl(comfy
                ? (settings.comfyBaseUrl ?? settings.baseUrl)
                : apiMode === 'openai_compatible' ? (settings.openaiBaseUrl ?? settings.baseUrl) : settings.baseUrl),
            endpointPath: safeEndpointPath(apiMode === 'openai_compatible' ? (settings.openaiEndpointPath ?? settings.endpointPath) : settings.endpointPath),
            model: cleanText(comfy
                ? (settings.comfyModel ?? settings.model)
                : apiMode === 'openai_compatible' ? (settings.openaiModel ?? settings.model) : settings.model, '生图模型', 160, { allowEmpty: comfy }),
            sampler: cleanText(comfy ? (settings.comfySampler ?? settings.sampler) : settings.sampler, '采样器', 80),
            noiseSchedule: cleanText(comfy ? (settings.comfyScheduler ?? settings.noiseSchedule) : settings.noiseSchedule, '噪点表', 80),
            width: cleanInteger(comfy
                ? (settings.comfyWidth ?? settings.width)
                : apiMode === 'openai_compatible' ? (settings.openaiWidth ?? settings.width) : settings.width, '宽度', 64, 4096),
            height: cleanInteger(comfy
                ? (settings.comfyHeight ?? settings.height)
                : apiMode === 'openai_compatible' ? (settings.openaiHeight ?? settings.height) : settings.height, '高度', 64, 4096),
            steps: cleanInteger(comfy ? (settings.comfySteps ?? settings.steps) : settings.steps, '步数', 1, 100),
            seed: cleanInteger(comfy ? (settings.comfySeed ?? settings.seed) : settings.seed, '种子', 0, 0xffffffff),
            guidance: cleanNumber(comfy ? (settings.comfyGuidance ?? settings.guidance) : settings.guidance, 'Prompt Guidance', 0, 30),
            guidanceRescale: cleanNumber(settings.guidanceRescale, 'Guidance Rescale', 0, 1),
            qualityToggle: settings.qualityToggle !== false, variety: settings.variety === true,
            comfyVae: cleanText(settings.comfyVae ?? '', 'ComfyUI VAE', 160, { allowEmpty: true }),
            comfyClip: cleanText(settings.comfyClip ?? '', 'ComfyUI CLIP', 160, { allowEmpty: true }),
            comfyWorkflow,
        },
    };
}
async function parseResponse(response) {
    const contentType = String(response.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (SAFE_IMAGE_MIME.has(contentType)) return imageResultFromBytes(await readResponseBytes(response, MAX_IMAGE_BYTES));
    if (contentType === 'application/zip' || contentType === 'application/x-zip-compressed' || contentType === 'application/octet-stream' || contentType === 'binary/octet-stream') {
        const bytes = await readResponseBytes(response, MAX_IMAGE_BYTES);
        const direct = detectMime(bytes) ? imageResultFromBytes(bytes) : await extractFirstZipImage(bytes);
        if (direct) return direct;
        fail('INVALID_IMAGE_RESPONSE', '生图接口返回的压缩图片无法读取。');
    }
    let payload;
    try {
        const bytes = await readResponseBytes(response, MAX_JSON_RESPONSE_BYTES);
        payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
        if (error instanceof YueLeMaImageGenerationError) throw error;
        fail('INVALID_IMAGE_RESPONSE', '生图接口没有返回可用图片。');
    }
    const first = Array.isArray(payload?.data) ? payload.data[0] : null;
    const b64 = first?.b64_json ?? payload?.b64_json ?? payload?.image;
    if (typeof b64 === 'string') return imageResultFromBytes(base64ToBytes(b64.replace(/^data:image\/(?:png|jpeg|webp);base64,/iu, '')));
    fail('INVALID_IMAGE_RESPONSE', '生图接口没有返回可用图片。');
}

function defaultComfyWorkflow() {
    return {
        3: { inputs: { seed: '%seed%', steps: '%steps%', cfg: '%cfg_scale%', sampler_name: '%sampler_name%', scheduler: '%scheduler%', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] }, class_type: 'KSampler' },
        4: { inputs: { ckpt_name: '%MODEL_NAME%' }, class_type: 'CheckpointLoaderSimple' },
        5: { inputs: { width: '%width%', height: '%height%', batch_size: 1 }, class_type: 'EmptyLatentImage' },
        6: { inputs: { text: '%prompt%', clip: ['4', 1] }, class_type: 'CLIPTextEncode' },
        7: { inputs: { text: '%negative_prompt%', clip: ['4', 1] }, class_type: 'CLIPTextEncode' },
        8: { inputs: { samples: ['3', 0], vae: ['4', 2] }, class_type: 'VAEDecode' },
        9: { inputs: { filename_prefix: 'YueLeMa', images: ['8', 0] }, class_type: 'SaveImage' },
    };
}
function parseComfyWorkflow(text) {
    if (!text) return defaultComfyWorkflow();
    let parsed;
    try { parsed = JSON.parse(text); } catch { fail('INVALID_IMAGE_REQUEST', 'ComfyUI 工作流 JSON 无法解析。'); }
    if (parsed?.nodes && Array.isArray(parsed.nodes)) {
        fail('INVALID_IMAGE_REQUEST', '请使用 ComfyUI “Save (API Format)” 导出的工作流。');
    }
    parsed = parsed?.prompt && typeof parsed.prompt === 'object'
        ? parsed.prompt
        : parsed?.workflow && typeof parsed.workflow === 'object' ? parsed.workflow : parsed;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('INVALID_IMAGE_REQUEST', 'ComfyUI 工作流必须是 API 格式 JSON 对象。');
    return parsed;
}
function replaceWorkflowPlaceholders(value, replacements, depth = 0) {
    if (depth > 32) fail('INVALID_IMAGE_REQUEST', 'ComfyUI 工作流嵌套过深。');
    if (Array.isArray(value)) return value.map((item) => replaceWorkflowPlaceholders(item, replacements, depth + 1));
    if (value && typeof value === 'object') {
        const output = Object.create(null);
        for (const [key, item] of Object.entries(value)) {
            if (UNSAFE_WORKFLOW_KEYS.has(key)) fail('INVALID_IMAGE_REQUEST', 'ComfyUI 工作流包含不安全字段。');
            output[key] = replaceWorkflowPlaceholders(item, replacements, depth + 1);
        }
        return output;
    }
    if (typeof value !== 'string') return value;
    if (Object.hasOwn(replacements, value)) return replacements[value];
    return value.replace(/%[A-Za-z0-9_]+%/gu, (token) => Object.hasOwn(replacements, token) ? String(replacements[token]) : token);
}
function buildComfyWorkflow(settings, positivePrompt, negativePrompt) {
    const replacements = {
        '%prompt%': positivePrompt, '%positive_prompt%': positivePrompt, '%negative_prompt%': negativePrompt,
        '%width%': settings.width, '%height%': settings.height, '%steps%': settings.steps,
        '%cfg_scale%': settings.guidance, '%cfg%': settings.guidance, '%cfg_rescale%': settings.guidanceRescale,
        '%seed%': settings.seed, '%sampler_name%': settings.sampler, '%scheduler%': settings.noiseSchedule,
        '%MODEL_NAME%': settings.model, '%model%': settings.model,
        '%VAE_NAME%': settings.comfyVae, '%vae_name%': settings.comfyVae, '%vae%': settings.comfyVae,
        '%CLIP_NAME%': settings.comfyClip, '%clip_name%': settings.comfyClip, '%clip%': settings.comfyClip,
    };
    return replaceWorkflowPlaceholders(parseComfyWorkflow(settings.comfyWorkflow), replacements);
}
async function readJsonResponse(response, maximum = MAX_COMFY_JSON_BYTES, tooLarge = {}) {
    try {
        const bytes = await readResponseBytes(response, maximum, tooLarge);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
        if (error instanceof YueLeMaImageGenerationError) throw error;
        fail('INVALID_IMAGE_RESPONSE', 'ComfyUI 返回了无效响应。');
    }
}
function comfyHistorySnapshot(payload, promptId) {
    const root = payload?.[promptId] ?? payload;
    let image = null;
    let outputCount = 0;
    for (const output of Object.values(root?.outputs ?? {})) {
        outputCount += 1;
        const candidate = Array.isArray(output?.images) ? output.images.find((item) => typeof item?.filename === 'string' && item.filename.trim()) : null;
        if (candidate) {
            image = {
                filename: candidate.filename.trim(),
                subfolder: typeof candidate.subfolder === 'string' ? candidate.subfolder : '',
                type: typeof candidate.type === 'string' && candidate.type ? candidate.type : 'output',
            };
            break;
        }
    }
    const status = typeof root?.status?.status_str === 'string' ? root.status.status_str.trim().toLowerCase() : '';
    return {
        image,
        outputCount,
        status,
        completed: root?.status?.completed === true || status === 'success' || status === 'error' || status === 'failed',
    };
}
async function generateWithComfyUI(fetchImpl, request, signal, {
    diagnosticLogger,
    requestId,
    startedAt,
    setPhase,
} = {}) {
    setPhase?.('workflow_prepare');
    const workflow = buildComfyWorkflow(request.settings, request.positivePrompt, request.negativePrompt);
    const body = JSON.stringify({ prompt: workflow, client_id: `yuelema-${Date.now()}-${Math.random().toString(16).slice(2)}` });
    emitImageDiagnostic(diagnosticLogger, 'info', 'ComfyUI 工作流准备完成', {
        requestId,
        customWorkflow: Boolean(request.settings.comfyWorkflow),
        nodeCount: Object.keys(workflow).length,
        requestBytes: new TextEncoder().encode(body).length,
        elapsedMs: Date.now() - startedAt,
    });
    setPhase?.('prompt_submit');
    const submitted = await fetchImpl(`${request.settings.baseUrl}/prompt`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body,
        signal,
    });
    emitImageDiagnostic(diagnosticLogger, submitted?.ok ? 'info' : 'error', 'ComfyUI 工作流提交响应', {
        requestId,
        status: Number.isInteger(submitted?.status) ? submitted.status : undefined,
        ok: Boolean(submitted?.ok),
        contentType: String(submitted?.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase() || undefined,
        contentLength: String(submitted?.headers?.get?.('content-length') ?? '') || undefined,
        elapsedMs: Date.now() - startedAt,
    });
    if (!submitted?.ok) fail('IMAGE_HTTP_ERROR', 'ComfyUI 拒绝了本次工作流，请检查设置或稍后重试。', { retryable: submitted?.status >= 500, status: Number.isInteger(submitted?.status) ? submitted.status : undefined });
    setPhase?.('prompt_response_parse');
    const submission = await readJsonResponse(submitted);
    const promptId = typeof submission?.prompt_id === 'string' ? submission.prompt_id.trim() : '';
    if (!promptId) fail('INVALID_IMAGE_RESPONSE', 'ComfyUI 未返回任务标识。');
    emitImageDiagnostic(diagnosticLogger, 'info', 'ComfyUI 任务已接受', {
        requestId,
        elapsedMs: Date.now() - startedAt,
    });

    let image;
    let pollAttempt = 0;
    while (!signal.aborted) {
        pollAttempt += 1;
        setPhase?.('history_request');
        const history = await fetchImpl(`${request.settings.baseUrl}/history/${encodeURIComponent(promptId)}`, {
            method: 'GET', headers: { Accept: 'application/json' }, signal,
        });
        emitImageDiagnostic(diagnosticLogger, history?.ok ? 'info' : 'error', 'ComfyUI 任务状态响应', {
            requestId,
            attempt: pollAttempt,
            status: Number.isInteger(history?.status) ? history.status : undefined,
            ok: Boolean(history?.ok),
            elapsedMs: Date.now() - startedAt,
        });
        if (!history?.ok) fail('IMAGE_HTTP_ERROR', '无法读取 ComfyUI 任务状态。', { retryable: history?.status >= 500, status: Number.isInteger(history?.status) ? history.status : undefined });
        setPhase?.('history_response_parse');
        const snapshot = comfyHistorySnapshot(await readJsonResponse(history), promptId);
        if (snapshot.status === 'error' || snapshot.status === 'failed') {
            emitImageDiagnostic(diagnosticLogger, 'error', 'ComfyUI 任务终态失败', {
                requestId, attempt: pollAttempt, status: snapshot.status, outputCount: snapshot.outputCount, elapsedMs: Date.now() - startedAt,
            });
            fail('COMFY_TASK_FAILED', 'ComfyUI 工作流执行失败，请检查自定义节点、模型和节点连线。');
        }
        image = snapshot.image;
        if (image) break;
        if (snapshot.completed) {
            emitImageDiagnostic(diagnosticLogger, 'error', 'ComfyUI 任务未返回图片', {
                requestId, attempt: pollAttempt, status: snapshot.status || undefined, outputCount: snapshot.outputCount, elapsedMs: Date.now() - startedAt,
            });
            fail('COMFY_TASK_NO_IMAGE', 'ComfyUI 工作流已结束但未返回图片；请确认末尾有可写入历史输出的 SaveImage 或 PreviewImage 节点。');
        }
        await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 1_000);
            signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
        });
    }
    if (!image) fail('IMAGE_REQUEST_ABORTED', '生图请求已取消。', { retryable: true });
    const query = new URLSearchParams(image);
    setPhase?.('image_fetch');
    const output = await fetchImpl(`${request.settings.baseUrl}/view?${query.toString()}`, {
        method: 'GET', headers: { Accept: 'image/png, image/jpeg, image/webp' }, signal,
    });
    emitImageDiagnostic(diagnosticLogger, output?.ok ? 'info' : 'error', 'ComfyUI 图片读取响应', {
        requestId,
        status: Number.isInteger(output?.status) ? output.status : undefined,
        ok: Boolean(output?.ok),
        contentType: String(output?.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase() || undefined,
        contentLength: String(output?.headers?.get?.('content-length') ?? '') || undefined,
        elapsedMs: Date.now() - startedAt,
    });
    if (!output?.ok) fail('IMAGE_HTTP_ERROR', '无法读取 ComfyUI 生成图片。', { retryable: output?.status >= 500, status: Number.isInteger(output?.status) ? output.status : undefined });
    setPhase?.('image_response_parse');
    return parseResponse(output);
}

function comfyObjectOptions(objectInfo, classTypes, inputNames) {
    const values = [];
    for (const classType of classTypes) {
        for (const inputName of inputNames) {
            const descriptor = objectInfo?.[classType]?.input?.required?.[inputName]
                ?? objectInfo?.[classType]?.input?.optional?.[inputName];
            const candidates = Array.isArray(descriptor) && Array.isArray(descriptor[0]) ? descriptor[0] : [];
            for (const value of candidates) {
                if (typeof value === 'string' && value.trim() && !values.includes(value.trim())) values.push(value.trim());
            }
        }
    }
    return Object.freeze(values);
}

async function fetchComfyUIResources(fetchImpl, baseUrl, signal, diagnosticLogger) {
    const requestId = `comfy-resources-${Date.now().toString(36)}-${(++imageRequestSequence).toString(36)}`;
    const startedAt = Date.now();
    let endpoint;
    let phase = 'request_validation';
    try {
        endpoint = `${safeBaseUrl(baseUrl)}/object_info`;
        phase = 'network_request';
        emitImageDiagnostic(diagnosticLogger, 'info', 'ComfyUI 资源读取开始', { requestId, endpoint });
        let response;
        try {
            response = await fetchImpl(endpoint, {
                method: 'GET',
                headers: { Accept: 'application/json' },
                signal,
            });
        } catch {
            if (signal?.aborted) fail('IMAGE_REQUEST_ABORTED', 'ComfyUI 数据读取已取消。', { retryable: true });
            fail('IMAGE_NETWORK_ERROR', '无法连接 ComfyUI，请检查地址、服务状态或跨域配置。', { retryable: true });
        }
        phase = 'http_response';
        emitImageDiagnostic(diagnosticLogger, response?.ok ? 'info' : 'error', 'ComfyUI 资源收到响应', {
            requestId,
            status: Number.isInteger(response?.status) ? response.status : undefined,
            ok: Boolean(response?.ok),
            contentType: String(response?.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase() || undefined,
            contentLength: String(response?.headers?.get?.('content-length') ?? '') || undefined,
            maximumBytes: MAX_COMFY_OBJECT_INFO_BYTES,
            elapsedMs: Date.now() - startedAt,
        });
        if (!response?.ok) {
            fail('IMAGE_HTTP_ERROR', '无法读取 ComfyUI 资源列表。', {
                retryable: response?.status >= 500,
                status: Number.isInteger(response?.status) ? response.status : undefined,
            });
        }
        phase = 'response_parse';
        const objectInfo = await readJsonResponse(response, MAX_COMFY_OBJECT_INFO_BYTES, {
            code: 'COMFY_RESOURCE_RESPONSE_TOO_LARGE',
            message: 'ComfyUI 资源列表过大；这与图片分辨率无关，请减少自定义节点后重试。',
        });
        if (!objectInfo || typeof objectInfo !== 'object' || Array.isArray(objectInfo)) {
            fail('INVALID_IMAGE_RESPONSE', 'ComfyUI object_info 响应无效。');
        }
        const resources = Object.freeze({
            models: comfyObjectOptions(objectInfo, ['CheckpointLoaderSimple', 'CheckpointLoader', 'UNETLoader'], ['ckpt_name', 'unet_name']),
            samplers: comfyObjectOptions(objectInfo, ['KSampler', 'KSamplerAdvanced'], ['sampler_name']),
            schedulers: comfyObjectOptions(objectInfo, ['KSampler', 'KSamplerAdvanced'], ['scheduler']),
            vae: comfyObjectOptions(objectInfo, ['VAELoader'], ['vae_name']),
            clips: comfyObjectOptions(objectInfo, ['CLIPLoader', 'DualCLIPLoader'], ['clip_name', 'clip_name1', 'clip_name2']),
        });
        emitImageDiagnostic(diagnosticLogger, 'info', 'ComfyUI 资源读取完成', {
            requestId,
            models: resources.models.length,
            samplers: resources.samplers.length,
            schedulers: resources.schedulers.length,
            vae: resources.vae.length,
            clips: resources.clips.length,
            elapsedMs: Date.now() - startedAt,
        });
        return resources;
    } catch (error) {
        emitImageDiagnostic(diagnosticLogger, 'error', 'ComfyUI 资源读取失败', {
            requestId,
            phase,
            ...imageErrorDetails(error),
            elapsedMs: Date.now() - startedAt,
        });
        throw error;
    }
}

export function createImageGenerationClient({ fetchImpl, diagnosticLogger = null, randomUint32 = defaultRandomUint32 } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('image generation client requires injected fetchImpl');
    if (typeof randomUint32 !== 'function') throw new TypeError('image generation client requires a randomUint32 function');
    const nextComfyRuntimeSeed = createComfyRuntimeSeedGenerator(randomUint32);
    return Object.freeze({
        fetchComfyUIResources({ baseUrl, signal } = {}) {
            return fetchComfyUIResources(fetchImpl, baseUrl, signal, diagnosticLogger);
        },
        async generate(input) {
            const requestId = `image-${Date.now().toString(36)}-${(++imageRequestSequence).toString(36)}`;
            const startedAt = Date.now();
            let request;
            let controller;
            let timer;
            let forwardAbort;
            let phase = 'request_validation';
            try {
                request = normalizeRequest(input);
                if (request.settings.apiMode === 'comfyui' && request.settings.seed === 0) {
                    request = { ...request, settings: { ...request.settings, seed: nextComfyRuntimeSeed() } };
                }
                phase = 'credential_lookup';
                const key = request.settings.apiMode === 'comfyui' ? '' : requireSessionKey(request.settings.presetId);
                controller = new AbortController();
                timer = setTimeout(() => controller.abort('timeout'), request.timeoutMs);
                forwardAbort = () => controller.abort('external');
                request.signal?.addEventListener?.('abort', forwardAbort, { once: true });
                emitImageDiagnostic(diagnosticLogger, 'info', '请求开始', {
                    requestId,
                    provider: request.settings.apiMode,
                    endpoint: request.settings.apiMode === 'comfyui'
                        ? `${request.settings.baseUrl}/prompt`
                        : request.settings.baseUrl + request.settings.endpointPath,
                    model: request.settings.model,
                    width: request.settings.width,
                    height: request.settings.height,
                    timeoutMs: request.timeoutMs,
                });
                if (request.settings.apiMode === 'comfyui') {
                    try {
                        const generated = await generateWithComfyUI(fetchImpl, request, controller.signal, {
                            diagnosticLogger,
                            requestId,
                            startedAt,
                            setPhase: (nextPhase) => { phase = nextPhase; },
                        });
                        emitImageDiagnostic(diagnosticLogger, 'info', '请求完成', {
                            requestId, provider: request.settings.apiMode, mimeType: generated.mimeType,
                            elapsedMs: Date.now() - startedAt,
                        });
                        return generated;
                    } catch (error) {
                        if (error instanceof YueLeMaImageGenerationError) throw error;
                        if (controller.signal.aborted) fail('IMAGE_REQUEST_ABORTED', request.signal?.aborted ? '生图请求已取消。' : '生图请求超时，请稍后重试。', { retryable: true });
                        fail('IMAGE_NETWORK_ERROR', '无法连接 ComfyUI，请检查地址、服务状态或跨域配置。', { retryable: true });
                    }
                }
                let response;
                phase = 'network_request';
                const requestBody = buildBody(request.settings, request.positivePrompt, request.negativePrompt);
                const serializedBody = JSON.stringify(requestBody);
                emitImageDiagnostic(diagnosticLogger, 'info', '请求体准备完成', {
                    requestId,
                    provider: request.settings.apiMode,
                    requestBytes: new TextEncoder().encode(serializedBody).length,
                    positivePromptChars: request.positivePrompt.length,
                    negativePromptChars: request.negativePrompt.length,
                    requestFields: Object.keys(requestBody),
                    parameterFields: request.settings.apiMode === 'novelai' ? Object.keys(requestBody.parameters) : undefined,
                });
                if (request.settings.apiMode === 'novelai') {
                    emitImageDiagnostic(diagnosticLogger, 'info', 'NovelAI 请求合同', {
                        requestId,
                        model: request.settings.model,
                        modelFamily: isNovelAIV4Model(request.settings.model) ? 'v4' : 'legacy',
                        paramsVersion: requestBody.parameters?.params_version,
                        hasV4PositiveCaption: Boolean(requestBody.parameters?.v4_prompt?.caption?.base_caption),
                        hasV4NegativeCaption: Boolean(requestBody.parameters?.v4_negative_prompt?.caption),
                        sampler: request.settings.sampler,
                        noiseSchedule: request.settings.noiseSchedule,
                        width: request.settings.width,
                        height: request.settings.height,
                        steps: request.settings.steps,
                        guidance: request.settings.guidance,
                        guidanceRescale: request.settings.guidanceRescale,
                        qualityToggle: request.settings.qualityToggle,
                        variety: request.settings.variety,
                        elapsedMs: Date.now() - startedAt,
                    });
                }
                try {
                    response = await fetchImpl(request.settings.baseUrl + request.settings.endpointPath, {
                        method: 'POST', headers: { Accept: 'application/json, image/png, image/jpeg, image/webp, application/zip', 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
                        body: serializedBody, signal: controller.signal,
                    });
                } catch (error) {
                    emitImageDiagnostic(diagnosticLogger, 'error', '传输失败', {
                        requestId,
                        provider: request.settings.apiMode,
                        errorType: safeErrorType(error),
                        aborted: controller.signal.aborted,
                        abortSource: controller.signal.aborted ? (request.signal?.aborted ? 'external' : 'timeout') : undefined,
                        elapsedMs: Date.now() - startedAt,
                    });
                    if (controller.signal.aborted) fail('IMAGE_REQUEST_ABORTED', request.signal?.aborted ? '生图请求已取消。' : '生图请求超时，请稍后重试。', { retryable: true });
                    fail('IMAGE_NETWORK_ERROR', '无法连接生图服务，请检查 URL、网络或跨域配置。', { retryable: true });
                }
                phase = 'http_response';
                emitImageDiagnostic(diagnosticLogger, response?.ok ? 'info' : 'error', '收到响应', {
                    requestId,
                    provider: request.settings.apiMode,
                    status: Number.isInteger(response?.status) ? response.status : undefined,
                    ok: Boolean(response?.ok),
                    contentType: String(response?.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase() || undefined,
                    contentLength: String(response?.headers?.get?.('content-length') ?? '') || undefined,
                    elapsedMs: Date.now() - startedAt,
                });
                if (!response?.ok) {
                    if (request.settings.apiMode === 'novelai') {
                        emitImageDiagnostic(diagnosticLogger, 'error', 'NovelAI 错误响应定位', {
                            requestId,
                            status: Number.isInteger(response?.status) ? response.status : undefined,
                            contentType: String(response?.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase() || undefined,
                            contentLength: String(response?.headers?.get?.('content-length') ?? '') || undefined,
                            ...safeResponseTrace(response),
                            elapsedMs: Date.now() - startedAt,
                        });
                    }
                    emitImageDiagnostic(diagnosticLogger, 'error', '错误响应摘要', {
                        requestId,
                        provider: request.settings.apiMode,
                        status: Number.isInteger(response?.status) ? response.status : undefined,
                        ...await safeHttpErrorDiagnostic(response, [key, request.positivePrompt, request.negativePrompt]),
                        elapsedMs: Date.now() - startedAt,
                    });
                    fail('IMAGE_HTTP_ERROR', '生图服务拒绝了本次请求，请检查接口设置或稍后重试。', { retryable: response?.status >= 500, status: Number.isInteger(response?.status) ? response.status : undefined });
                }
                phase = 'response_parse';
                const generated = await parseResponse(response);
                emitImageDiagnostic(diagnosticLogger, 'info', '请求完成', {
                    requestId, provider: request.settings.apiMode, mimeType: generated.mimeType,
                    elapsedMs: Date.now() - startedAt,
                });
                return generated;
            } catch (error) {
                emitImageDiagnostic(diagnosticLogger, 'error', '请求失败', {
                    requestId,
                    provider: request?.settings?.apiMode,
                    phase,
                    ...imageErrorDetails(error),
                    elapsedMs: Date.now() - startedAt,
                });
                throw error;
            } finally {
                if (timer !== undefined) clearTimeout(timer);
                if (forwardAbort) request?.signal?.removeEventListener?.('abort', forwardAbort);
            }
        },
    });
}

export function toPublicImageGenerationError(error) {
    if (error instanceof YueLeMaImageGenerationError || error instanceof SessionKeyUnavailableError) {
        return { code: error.code ?? 'SESSION_KEY_LOCKED', message: error.message, retryable: Boolean(error.retryable), status: Number.isInteger(error.status) ? error.status : undefined };
    }
    return { code: 'IMAGE_UNKNOWN_ERROR', message: '图片生成未完成，请稍后重试。', retryable: false, status: undefined };
}

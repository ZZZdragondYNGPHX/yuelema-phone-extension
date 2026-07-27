import { requireSessionKey, SessionKeyUnavailableError } from './session-key-store.js';

const SAFE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1_048_576;
const MAX_COMFY_JSON_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const UNSAFE_WORKFLOW_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

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
function isLoopback(hostname) { return ['localhost', '127.0.0.1', '::1'].includes(hostname); }
function safeBaseUrl(value) {
    const text = cleanText(value, '生图接口地址', 2048).replace(/\/+$/u, '');
    let url;
    try { url = new URL(text); } catch { fail('INVALID_IMAGE_REQUEST', '生图接口地址无效。'); }
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) fail('INVALID_IMAGE_REQUEST', '生图接口地址无效。');
    if (url.protocol === 'http:' && !isLoopback(url.hostname)) fail('INVALID_IMAGE_REQUEST', '非本机生图接口必须使用 HTTPS。');
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
function declaredResponseLength(response, maximum) {
    const raw = response.headers?.get?.('content-length');
    if (raw === null || raw === undefined || raw === '') return null;
    if (!/^[0-9]+$/u.test(String(raw))) fail('INVALID_IMAGE_RESPONSE', '生图接口返回了无效图片。');
    const length = Number(raw);
    if (!Number.isSafeInteger(length) || length > maximum) fail('INVALID_IMAGE_RESPONSE', '生图接口返回的图片过大。');
    return length;
}
async function readReadableStreamBytes(stream, maximum) {
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
            if (total > maximum) fail('INVALID_IMAGE_RESPONSE', '生图接口返回的图片过大。');
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
async function readResponseBytes(response, maximum) {
    declaredResponseLength(response, maximum);
    const streamed = await readReadableStreamBytes(response.body, maximum);
    if (streamed) return streamed;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maximum) fail('INVALID_IMAGE_RESPONSE', '生图接口返回的图片过大。');
    return bytes;
}
function readU16(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8); }
function readU32(bytes, offset) { return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0; }
async function extractFirstZipImage(bytes) {
    if (bytes.length < 30 || readU32(bytes, 0) !== 0x04034b50) return null;
    const flags = readU16(bytes, 6);
    const method = readU16(bytes, 8);
    const compressedSize = readU32(bytes, 18);
    const filenameLength = readU16(bytes, 26);
    const extraLength = readU16(bytes, 28);
    if ((flags & 0x08) !== 0 || compressedSize < 1 || compressedSize > MAX_IMAGE_BYTES) return null;
    const start = 30 + filenameLength + extraLength;
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
        return {
            input: positivePrompt,
            model: settings.model,
            action: 'generate',
            parameters: {
                width: settings.width, height: settings.height, scale: settings.guidance,
                cfg_rescale: settings.guidanceRescale, steps: settings.steps, sampler: settings.sampler,
                noise_schedule: settings.noiseSchedule, seed: settings.seed, negative_prompt: negativePrompt,
                qualityToggle: settings.qualityToggle, sm: settings.variety, sm_dyn: settings.variety, n_samples: 1,
            },
        };
    }
    return {
        model: settings.model,
        prompt: positivePrompt,
        negative_prompt: negativePrompt,
        size: `${settings.width}x${settings.height}`,
        width: settings.width, height: settings.height, steps: settings.steps,
        sampler: settings.sampler, seed: settings.seed, response_format: 'b64_json', n: 1,
    };
}
function normalizeRequest(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_IMAGE_REQUEST', '生图请求无效。');
    const settings = input.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) fail('INVALID_IMAGE_REQUEST', '生图设置无效。');
    const apiMode = settings.apiMode === 'openai_compatible'
        ? 'openai_compatible'
        : settings.apiMode === 'novelai' ? 'novelai' : settings.apiMode === 'comfyui' ? 'comfyui' : fail('INVALID_IMAGE_REQUEST', '生图接口模式无效。');
    return {
        positivePrompt: cleanText(input.positivePrompt, '正面提示词', 32_000),
        negativePrompt: cleanText(input.negativePrompt ?? '', '负面提示词', 12_000, { allowEmpty: true }),
        signal: input.signal,
        timeoutMs: input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : cleanInteger(input.timeoutMs, '超时时间', 1_000, 300_000),
        settings: {
            apiMode, presetId: cleanText(settings.presetId, '生图连接 ID', 96), baseUrl: safeBaseUrl(settings.baseUrl),
            endpointPath: safeEndpointPath(settings.endpointPath), model: cleanText(settings.model, '生图模型', 160),
            sampler: cleanText(settings.sampler, '采样器', 80), noiseSchedule: cleanText(settings.noiseSchedule, '噪点表', 80),
            width: cleanInteger(settings.width, '宽度', 64, 4096), height: cleanInteger(settings.height, '高度', 64, 4096),
            steps: cleanInteger(settings.steps, '步数', 1, 100), seed: cleanInteger(settings.seed, '种子', 0, 0xffffffff),
            guidance: cleanNumber(settings.guidance, 'Prompt Guidance', 0, 30), guidanceRescale: cleanNumber(settings.guidanceRescale, 'Guidance Rescale', 0, 1),
            qualityToggle: settings.qualityToggle !== false, variety: settings.variety === true,
            comfyWorkflow: cleanWorkflow(settings.comfyWorkflow ?? ''),
        },
    };
}
async function parseResponse(response) {
    const contentType = String(response.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (SAFE_IMAGE_MIME.has(contentType)) return imageResultFromBytes(await readResponseBytes(response, MAX_IMAGE_BYTES));
    if (contentType === 'application/zip' || contentType === 'application/x-zip-compressed' || contentType === 'application/octet-stream') {
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
    };
    return replaceWorkflowPlaceholders(parseComfyWorkflow(settings.comfyWorkflow), replacements);
}
async function readJsonResponse(response, maximum = MAX_COMFY_JSON_BYTES) {
    try {
        const bytes = await readResponseBytes(response, maximum);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
        if (error instanceof YueLeMaImageGenerationError) throw error;
        fail('INVALID_IMAGE_RESPONSE', 'ComfyUI 返回了无效响应。');
    }
}
function comfyOutputFromHistory(payload, promptId) {
    const root = payload?.[promptId] ?? payload;
    for (const output of Object.values(root?.outputs ?? {})) {
        const image = Array.isArray(output?.images) ? output.images.find((item) => typeof item?.filename === 'string' && item.filename.trim()) : null;
        if (image) return {
            filename: image.filename.trim(),
            subfolder: typeof image.subfolder === 'string' ? image.subfolder : '',
            type: typeof image.type === 'string' && image.type ? image.type : 'output',
        };
    }
    return null;
}
async function generateWithComfyUI(fetchImpl, request, signal) {
    const workflow = buildComfyWorkflow(request.settings, request.positivePrompt, request.negativePrompt);
    const submitted = await fetchImpl(`${request.settings.baseUrl}/prompt`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: `yuelema-${Date.now()}-${Math.random().toString(16).slice(2)}` }),
        signal,
    });
    if (!submitted?.ok) fail('IMAGE_HTTP_ERROR', 'ComfyUI 拒绝了本次工作流，请检查设置或稍后重试。', { retryable: submitted?.status >= 500, status: Number.isInteger(submitted?.status) ? submitted.status : undefined });
    const submission = await readJsonResponse(submitted);
    const promptId = typeof submission?.prompt_id === 'string' ? submission.prompt_id.trim() : '';
    if (!promptId) fail('INVALID_IMAGE_RESPONSE', 'ComfyUI 未返回任务标识。');

    let image;
    while (!signal.aborted) {
        const history = await fetchImpl(`${request.settings.baseUrl}/history/${encodeURIComponent(promptId)}`, {
            method: 'GET', headers: { Accept: 'application/json' }, signal,
        });
        if (!history?.ok) fail('IMAGE_HTTP_ERROR', '无法读取 ComfyUI 任务状态。', { retryable: history?.status >= 500, status: Number.isInteger(history?.status) ? history.status : undefined });
        image = comfyOutputFromHistory(await readJsonResponse(history), promptId);
        if (image) break;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 1_000);
            signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
        });
    }
    if (!image) fail('IMAGE_REQUEST_ABORTED', '生图请求已取消。', { retryable: true });
    const query = new URLSearchParams(image);
    const output = await fetchImpl(`${request.settings.baseUrl}/view?${query.toString()}`, {
        method: 'GET', headers: { Accept: 'image/png, image/jpeg, image/webp' }, signal,
    });
    if (!output?.ok) fail('IMAGE_HTTP_ERROR', '无法读取 ComfyUI 生成图片。', { retryable: output?.status >= 500, status: Number.isInteger(output?.status) ? output.status : undefined });
    return parseResponse(output);
}

export function createImageGenerationClient({ fetchImpl } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('image generation client requires injected fetchImpl');
    return Object.freeze({
        async generate(input) {
            const request = normalizeRequest(input);
            const key = request.settings.apiMode === 'comfyui' ? '' : requireSessionKey(request.settings.presetId);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort('timeout'), request.timeoutMs);
            const forwardAbort = () => controller.abort('external');
            request.signal?.addEventListener?.('abort', forwardAbort, { once: true });
            try {
                if (request.settings.apiMode === 'comfyui') {
                    try {
                        return await generateWithComfyUI(fetchImpl, request, controller.signal);
                    } catch (error) {
                        if (error instanceof YueLeMaImageGenerationError) throw error;
                        if (controller.signal.aborted) fail('IMAGE_REQUEST_ABORTED', request.signal?.aborted ? '生图请求已取消。' : '生图请求超时，请稍后重试。', { retryable: true });
                        fail('IMAGE_NETWORK_ERROR', '无法连接 ComfyUI，请检查地址、服务状态或跨域配置。', { retryable: true });
                    }
                }
                let response;
                try {
                    response = await fetchImpl(request.settings.baseUrl + request.settings.endpointPath, {
                        method: 'POST', headers: { Accept: 'application/json, image/png, image/jpeg, image/webp, application/zip', 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
                        body: JSON.stringify(buildBody(request.settings, request.positivePrompt, request.negativePrompt)), signal: controller.signal,
                    });
                } catch (error) {
                    if (controller.signal.aborted) fail('IMAGE_REQUEST_ABORTED', request.signal?.aborted ? '生图请求已取消。' : '生图请求超时，请稍后重试。', { retryable: true });
                    fail('IMAGE_NETWORK_ERROR', '无法连接生图服务，请检查 URL、网络或跨域配置。', { retryable: true });
                }
                if (!response?.ok) fail('IMAGE_HTTP_ERROR', '生图服务拒绝了本次请求，请检查接口设置或稍后重试。', { retryable: response?.status >= 500, status: Number.isInteger(response?.status) ? response.status : undefined });
                return await parseResponse(response);
            } finally {
                clearTimeout(timer);
                request.signal?.removeEventListener?.('abort', forwardAbort);
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

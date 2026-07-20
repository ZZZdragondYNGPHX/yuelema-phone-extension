import { requireSessionKey, SessionKeyUnavailableError } from './session-key-store.js';

const SECRET_FIELD_NAMES = new Set([
    'apikey', 'api_key', 'key', 'token', 'access_token', 'authorization', 'password', 'secret',
]);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_PSEUDO_STREAM_CHUNK_SIZE = 24;
const MAX_PSEUDO_STREAM_CHUNK_SIZE = 256;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const TRANSPORT_MODES = Object.freeze(['json', 'stream', 'pseudo_stream']);
const TRANSPORT_MODE_SET = new Set(TRANSPORT_MODES);

/** 可安全显示给 UI 的请求错误；永不携带 API Key、请求头、响应体或原始异常。 */
export class YueLeMaLlmError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'YueLeMaLlmError';
        this.code = code;
        this.status = Number.isInteger(details.status) ? details.status : undefined;
        this.retryable = Boolean(details.retryable);
    }
}

function fail(code, message, details) {
    throw new YueLeMaLlmError(code, message, details);
}

function ownEntries(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.entries(value);
}

function cleanText(value, label, minLength, maxLength) {
    if (typeof value !== 'string') fail('INVALID_PRESET', `${label}必须是文本。`);
    const result = value.trim();
    if (result.length < minLength || result.length > maxLength) {
        fail('INVALID_PRESET', `${label}长度必须为 ${minLength}–${maxLength} 个字符。`);
    }
    if (/[\u0000-\u001F\u007F]/.test(result)) {
        fail('INVALID_PRESET', `${label}不可包含控制字符。`);
    }
    return result;
}

function cleanNumber(value, label, min, max, fallback) {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
        fail('INVALID_PRESET', `${label}必须在 ${min}–${max} 范围内。`);
    }
    return value;
}

function normalizeTransportMode(value) {
    const mode = value ?? 'json';
    if (typeof mode !== 'string' || !TRANSPORT_MODE_SET.has(mode)) {
        fail('INVALID_PRESET', 'transportMode 仅允许 json、stream 或 pseudo_stream。');
    }
    return mode;
}

/**
 * 接受 https URL，或仅接受 localhost/loopback 的 http URL。
 * 不允许 query/hash/credentials，防止将秘密意外置入保存的 URL。
 */
export function normalizeApiUrl(value) {
    const raw = cleanText(value, 'API URL', 8, 2048);
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        fail('INVALID_URL', 'API URL 格式无效。');
    }
    const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
    const isLocal = localHosts.has(parsed.hostname.toLowerCase());
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
        fail('INVALID_URL', 'API URL 必须使用 HTTPS；仅 localhost/回环地址可使用 HTTP。');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        fail('INVALID_URL', 'API URL 不可包含账号、密码、查询参数或片段。');
    }
    return parsed.toString().replace(/\/+$/, '');
}

function cleanPresetId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value)) {
        fail('INVALID_PRESET', '模型预设 ID 必须是 1–96 位的字母、数字、下划线或连字符。');
    }
    return value;
}

function rejectSecretFields(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail('INVALID_PRESET', '模型连接预设必须是对象。');
    }
    for (const [key, fieldValue] of ownEntries(input)) {
        if (SECRET_FIELD_NAMES.has(key.toLowerCase())) {
            // The value is intentionally discarded and never included in the error.
            void fieldValue;
            fail('PRESET_SECRET_FORBIDDEN', '连接预设不可包含 API Key 或其他密钥字段；请通过独立的浏览器 Key 缓存保存。');
        }
    }
}

function normalizeConnectionInput(input, { allowEmptyModel }) {
    rejectSecretFields(input);
    const rawUrl = input.url ?? input.baseUrl;
    if (input.url !== undefined && input.baseUrl !== undefined && input.url !== input.baseUrl) {
        fail('INVALID_PRESET', 'url 与 baseUrl 不可同时使用不同的值。');
    }
    let model;
    if (allowEmptyModel && (input.model === undefined || input.model === null || (typeof input.model === 'string' && input.model.trim() === ''))) {
        model = '';
    } else {
        model = cleanText(input.model, '模型名', 1, 256);
    }
    return Object.freeze({
        id: cleanPresetId(input.id),
        name: cleanText(input.name, '预设名称', 1, 80),
        url: normalizeApiUrl(rawUrl),
        model,
        temperature: cleanNumber(input.temperature, 'temperature', 0, 2, 0.8),
        maxTokens: cleanNumber(input.maxTokens, 'maxTokens', 1, 16_384, 512),
        timeoutMs: cleanNumber(input.timeoutMs, 'timeoutMs', 10, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
        transportMode: normalizeTransportMode(input.transportMode),
    });
}

/**
 * 创建可安全持久化的连接预设。
 * 保存预设仍强制要求非空 model；仅 /models 探针可使用 normalizeConnectionProbe。
 */
export function createConnectionPreset(input) {
    return normalizeConnectionInput(input, { allowEmptyModel: false });
}

/**
 * /models 专用连接探针归一化。保持 URL、ID、名称、超时和密钥边界不变，
 * 但允许 model 缺失或为空，避免“先知道模型名才能拉取模型列表”的循环依赖。
 */
export function normalizeConnectionProbe(input) {
    return normalizeConnectionInput(input, { allowEmptyModel: true });
}

function endpointFor(baseUrl, suffix) {
    return `${baseUrl}/${suffix}`;
}

function getContentType(response) {
    try {
        return String(response?.headers?.get?.('content-type') ?? '');
    } catch {
        return '';
    }
}

function responseByteLength(value) {
    return new TextEncoder().encode(value).byteLength;
}

function assertResponseSize(byteLength) {
    if (byteLength > MAX_RESPONSE_BYTES) {
        fail('RESPONSE_TOO_LARGE', '模型响应超过安全大小限制，请缩短输出后重试。');
    }
}

function createAbortException() {
    return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

function waitForAbortable(promise, signal) {
    if (signal.aborted) return Promise.reject(createAbortException());
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener?.('abort', onAbort);
            callback(value);
        };
        const onAbort = () => finish(reject, createAbortException());
        signal.addEventListener?.('abort', onAbort, { once: true });
        Promise.resolve(promise).then(
            (value) => finish(resolve, value),
            (error) => finish(reject, error),
        );
    });
}

async function readResponseBodyText(response, abortScope) {
    const reader = response?.body?.getReader?.();
    if (!reader) return null;
    const decoder = new TextDecoder();
    let byteLength = 0;
    let text = '';
    let readerEnded = false;
    try {
        while (true) {
            const { value, done } = await waitForAbortable(reader.read(), abortScope.signal);
            if (done) {
                readerEnded = true;
                break;
            }
            if (!(value instanceof Uint8Array)) fail('INVALID_RESPONSE', '模型响应数据格式无效。');
            byteLength += value.byteLength;
            assertResponseSize(byteLength);
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        assertResponseSize(responseByteLength(text));
        return text;
    } finally {
        if (!readerEnded) {
            try { await reader.cancel?.(); } catch { /* no-op */ }
        }
        try { reader.releaseLock?.(); } catch { /* no-op */ }
    }
}

async function parseJsonResponse(response, abortScope) {
    const contentType = getContentType(response).toLowerCase();
    if (contentType && !contentType.includes('application/json') && !contentType.includes('+json')) {
        fail('NON_JSON_RESPONSE', '接口返回的不是 JSON，无法继续处理。');
    }
    const bodyText = await readResponseBodyText(response, abortScope);
    if (bodyText !== null) {
        try {
            return JSON.parse(bodyText);
        } catch {
            fail('NON_JSON_RESPONSE', '接口返回的不是有效 JSON，无法继续处理。');
        }
    }
    try {
        const payload = await waitForAbortable(response.json(), abortScope.signal);
        let serialized;
        try { serialized = JSON.stringify(payload); } catch { serialized = null; }
        if (typeof serialized !== 'string') fail('NON_JSON_RESPONSE', '接口返回的不是有效 JSON，无法继续处理。');
        assertResponseSize(responseByteLength(serialized));
        return payload;
    } catch (error) {
        if (error instanceof YueLeMaLlmError || error?.name === 'AbortError') throw error;
        fail('NON_JSON_RESPONSE', '接口返回的不是有效 JSON，无法继续处理。');
    }
}

function throwForHttpStatus(response) {
    const status = Number(response?.status);
    if (status === 401) fail('AUTH_FAILED', '接口认证失败，请检查此浏览器保存的 API Key。', { status });
    if (status === 429) fail('RATE_LIMITED', '接口请求过于频繁，请稍后重试。', { status, retryable: true });
    if (status >= 500 && status <= 599) fail('SERVER_ERROR', '模型服务暂时不可用，请稍后重试。', { status, retryable: true });
    fail('HTTP_ERROR', `接口请求失败（HTTP ${Number.isInteger(status) ? status : '未知'}）。`, { status });
}

function normalizeMessage(message) {
    if (!message || typeof message !== 'object') fail('INVALID_REQUEST', '消息必须包含 role 与 content。');
    const role = cleanText(message.role, '消息 role', 1, 32);
    if (!['system', 'user', 'assistant'].includes(role)) {
        fail('INVALID_REQUEST', '消息 role 仅允许 system、user 或 assistant。');
    }
    if (typeof message.content !== 'string' || message.content.length > 60_000) {
        fail('INVALID_REQUEST', '消息 content 必须是最多 60000 字符的文本。');
    }
    return { role, content: message.content };
}

/** 从 OpenAI Chat Completions 的 message.content 读取文本；不支持时回退到 choice.text。 */
export function extractCompletionText(payload) {
    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    if (!choice || typeof choice !== 'object') fail('INVALID_COMPLETION', '模型响应缺少 choices，无法读取回复。');
    const content = choice?.message?.content;
    if (typeof content === 'string' && content.trim()) return { text: content, source: 'message.content' };
    if (Array.isArray(content)) {
        const text = content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
        if (text.trim()) return { text, source: 'message.content_parts' };
    }
    if (typeof choice.text === 'string' && choice.text.trim()) return { text: choice.text, source: 'choice.text' };
    fail('INVALID_COMPLETION', '模型响应未包含可用文本。');
}

function createAbortScope({ signal, timeoutMs }) {
    const controller = new AbortController();
    let reason = null;
    const abort = (nextReason) => {
        if (!controller.signal.aborted) {
            reason = nextReason;
            controller.abort();
        }
    };
    const onExternalAbort = () => abort('cancelled');
    if (signal?.aborted) abort('cancelled');
    else signal?.addEventListener?.('abort', onExternalAbort, { once: true });
    const timer = setTimeout(() => abort('timeout'), timeoutMs);
    return {
        signal: controller.signal,
        get reason() { return reason; },
        dispose() {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', onExternalAbort);
        },
    };
}

function throwAbortError(reason) {
    if (reason === 'timeout') fail('TIMEOUT', '模型请求超时，请稍后重试。', { retryable: true });
    fail('CANCELLED', '模型请求已取消。');
}

function normalizeModelList(payload) {
    const candidates = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data) ? payload.data
            : Array.isArray(payload?.models) ? payload.models : [];
    const ids = candidates
        .map((item) => (typeof item === 'string' ? item : item?.id ?? item?.name))
        .filter((id) => typeof id === 'string' && id.trim().length > 0 && id.length <= 256)
        .map((id) => id.trim());
    return [...new Set(ids)];
}

function extractDeltaText(payload) {
    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    if (!choice || typeof choice !== 'object') return '';
    const content = choice?.delta?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part?.text === 'string') return part.text;
            if (typeof part?.text?.value === 'string') return part.text.value;
            return '';
        }).join('');
    }
    return typeof choice.text === 'string' ? choice.text : '';
}

async function parseSseCompletion(response, abortScope, onDelta) {
    const contentType = getContentType(response).toLowerCase();
    if (contentType && !contentType.includes('text/event-stream')) {
        fail('NON_STREAM_RESPONSE', '接口未返回兼容的流式响应。');
    }
    const reader = response?.body?.getReader?.();
    if (!reader) fail('NON_STREAM_RESPONSE', '当前接口或运行环境未提供可读取的流式响应。');
    const decoder = new TextDecoder();
    let buffer = '';
    let byteLength = 0;
    let text = '';
    let textByteLength = 0;
    let completed = false;
    let readerEnded = false;

    const consumeLine = async (line) => {
        const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (!normalizedLine.startsWith('data:')) return;
        const data = normalizedLine.slice(5).replace(/^ /, '');
        if (!data.trim()) return;
        if (data.trim() === '[DONE]') {
            completed = true;
            return;
        }
        let payload;
        try {
            payload = JSON.parse(data);
        } catch {
            fail('INVALID_STREAM_RESPONSE', '流式响应格式无效，无法继续处理。');
        }
        const delta = extractDeltaText(payload);
        if (!delta) return;
        text += delta;
        textByteLength += responseByteLength(delta);
        assertResponseSize(textByteLength);
        if (onDelta) {
            try {
                await waitForAbortable(
                    Promise.resolve(onDelta(delta, Object.freeze({ transportMode: 'stream', receivedCharacters: text.length }))),
                    abortScope.signal,
                );
            } catch {
                fail('STREAM_CONSUMER_FAILED', '流式回复显示未完成，请稍后重试。');
            }
        }
    };

    try {
        while (!completed) {
            const { value, done } = await waitForAbortable(reader.read(), abortScope.signal);
            if (done) {
                readerEnded = true;
                break;
            }
            if (!(value instanceof Uint8Array)) fail('INVALID_STREAM_RESPONSE', '流式响应数据格式无效。');
            byteLength += value.byteLength;
            assertResponseSize(byteLength);
            buffer += decoder.decode(value, { stream: true });
            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                await consumeLine(line);
                if (completed) break;
            }
        }
        if (!completed) {
            buffer += decoder.decode();
            if (buffer) {
                for (const line of buffer.split('\n')) await consumeLine(line);
            }
        }
    } finally {
        if (!readerEnded) {
            try { await reader.cancel?.(); } catch { /* no-op */ }
        }
        try { reader.releaseLock?.(); } catch { /* no-op */ }
    }

    if (!text.trim()) fail('INVALID_COMPLETION', '模型流式响应未包含可用文本。');
    return Object.freeze({
        text,
        source: 'delta.content',
        presentation: Object.freeze({ transportMode: 'stream' }),
    });
}

/** 将完整文本切成 UI 可逐段显示的安全假流式分块；不包含计时器、DOM 或网络副作用。 */
export function splitPseudoStreamText(text, { chunkSize = DEFAULT_PSEUDO_STREAM_CHUNK_SIZE } = {}) {
    if (typeof text !== 'string') fail('INVALID_REQUEST', '假流式分块内容必须是文本。');
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_PSEUDO_STREAM_CHUNK_SIZE) {
        fail('INVALID_REQUEST', `假流式 chunkSize 必须是 1–${MAX_PSEUDO_STREAM_CHUNK_SIZE} 的整数。`);
    }
    const characters = Array.from(text);
    const chunks = [];
    for (let index = 0; index < characters.length; index += chunkSize) {
        chunks.push(characters.slice(index, index + chunkSize).join(''));
    }
    return Object.freeze(chunks);
}

/**
 * 纯 OpenAI-compatible 请求客户端。
 * 必须显式注入 fetchImpl，故本模块本身不会主动发起真实网络请求。
 */
export function createOpenAICompatibleClient({ fetchImpl } = {}) {
    if (typeof fetchImpl !== 'function') {
        throw new TypeError('必须显式提供 fetchImpl；运行时适配器应传入经审计的 fetch。');
    }

    async function request({ preset, path, body, method = 'POST', signal, timeoutMs, responseParser, accept, normalizePreset }) {
        const normalizedPreset = normalizePreset(preset);
        const apiKey = requireSessionKey(normalizedPreset.id);
        const requestTimeoutMs = cleanNumber(timeoutMs, 'timeoutMs', 10, MAX_TIMEOUT_MS, normalizedPreset.timeoutMs);
        const abortScope = createAbortScope({ signal, timeoutMs: requestTimeoutMs });
        try {
            let response;
            try {
                response = await waitForAbortable(fetchImpl(endpointFor(normalizedPreset.url, path), {
                    method,
                    headers: {
                        accept,
                        'content-type': 'application/json',
                        authorization: `Bearer ${apiKey}`,
                    },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: abortScope.signal,
                }), abortScope.signal);
            } catch (error) {
                if (abortScope.reason || abortScope.signal.aborted || error?.name === 'AbortError') {
                    throwAbortError(abortScope.reason);
                }
                fail('NETWORK_ERROR', '无法连接模型服务，请检查 URL、网络或跨域配置。', { retryable: true });
            }
            if (!response?.ok) throwForHttpStatus(response);
            try {
                return await responseParser(response, abortScope);
            } catch (error) {
                if (abortScope.reason || abortScope.signal.aborted || error?.name === 'AbortError') {
                    throwAbortError(abortScope.reason);
                }
                if (error instanceof YueLeMaLlmError) throw error;
                fail('NETWORK_ERROR', '读取模型响应时连接中断，请稍后重试。', { retryable: true });
            }
        } finally {
            abortScope.dispose();
        }
    }

    return Object.freeze({
        async chat(requestInput) {
            if (!requestInput || typeof requestInput !== 'object' || !Array.isArray(requestInput.messages) || requestInput.messages.length < 1) {
                fail('INVALID_REQUEST', 'chat 请求至少需要一条消息。');
            }
            if (requestInput.onDelta !== undefined && typeof requestInput.onDelta !== 'function') {
                fail('INVALID_REQUEST', 'onDelta 必须是函数。');
            }
            const normalizedPreset = createConnectionPreset(requestInput.preset);
            const temperature = cleanNumber(requestInput.temperature, 'temperature', 0, 2, normalizedPreset.temperature);
            const maxTokens = cleanNumber(requestInput.maxTokens, 'maxTokens', 1, 16_384, normalizedPreset.maxTokens);
            const body = {
                model: normalizedPreset.model,
                messages: requestInput.messages.map(normalizeMessage),
                temperature,
                max_tokens: maxTokens,
            };
            if (normalizedPreset.transportMode === 'stream') {
                body.stream = true;
                return request({
                    preset: normalizedPreset,
                    path: 'chat/completions',
                    signal: requestInput.signal,
                    timeoutMs: requestInput.timeoutMs,
                    body,
                    accept: 'text/event-stream',
                    normalizePreset: createConnectionPreset,
                    responseParser: (response, abortScope) => parseSseCompletion(response, abortScope, requestInput.onDelta),
                });
            }
            const completion = await request({
                preset: normalizedPreset,
                path: 'chat/completions',
                signal: requestInput.signal,
                timeoutMs: requestInput.timeoutMs,
                body,
                accept: 'application/json',
                normalizePreset: createConnectionPreset,
                responseParser: parseJsonResponse,
            }).then(extractCompletionText);
            if (normalizedPreset.transportMode === 'pseudo_stream') {
                return Object.freeze({
                    ...completion,
                    presentation: Object.freeze({
                        transportMode: 'pseudo_stream',
                        chunkSize: DEFAULT_PSEUDO_STREAM_CHUNK_SIZE,
                    }),
                });
            }
            return completion;
        },

        async fetchModels(requestInput) {
            if (!requestInput || typeof requestInput !== 'object') fail('INVALID_REQUEST', 'fetchModels 需要连接预设。');
            const method = requestInput.method ?? 'GET';
            if (!['GET', 'POST'].includes(method)) fail('INVALID_REQUEST', '模型列表请求方法仅允许 GET 或 POST。');
            const payload = await request({
                preset: requestInput.preset,
                path: 'models',
                method,
                signal: requestInput.signal,
                timeoutMs: requestInput.timeoutMs,
                accept: 'application/json',
                normalizePreset: normalizeConnectionProbe,
                responseParser: parseJsonResponse,
            });
            const models = normalizeModelList(payload);
            if (models.length === 0) fail('INVALID_MODEL_LIST', '接口未返回可用的模型列表。');
            return models;
        },
    });
}

/** 将任意异常转换为可显示的安全错误对象，绝不保留 cause 或原始消息。 */
export function toPublicLlmError(error) {
    if (error instanceof YueLeMaLlmError || error instanceof SessionKeyUnavailableError) {
        return {
            code: error.code ?? 'SESSION_KEY_LOCKED',
            message: error.message,
            retryable: Boolean(error.retryable),
            status: Number.isInteger(error.status) ? error.status : undefined,
        };
    }
    return { code: 'UNKNOWN_ERROR', message: '模型请求未完成，请稍后重试。', retryable: false, status: undefined };
}




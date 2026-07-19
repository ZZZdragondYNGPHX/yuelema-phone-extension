import { requireSessionKey, SessionKeyUnavailableError } from './session-key-store.js';

const SECRET_FIELD_NAMES = new Set([
    'apikey', 'api_key', 'key', 'token', 'access_token', 'authorization', 'password', 'secret',
]);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

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

/**
 * 创建可安全持久化的连接预设。
 * 此函数只复制白名单内的非机密字段；出现任何密钥字段时直接拒绝，
 * 避免 UI 调用者误把 API Key 一并写入持久化对象。
 */
export function createConnectionPreset(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail('INVALID_PRESET', '模型连接预设必须是对象。');
    }
    for (const [key, fieldValue] of ownEntries(input)) {
        if (SECRET_FIELD_NAMES.has(key.toLowerCase())) {
            // The value is intentionally discarded and never included in the error.
            void fieldValue;
            fail('PRESET_SECRET_FORBIDDEN', '连接预设不可包含 API Key 或其他密钥字段；请仅在本次会话解锁。');
        }
    }
    const rawUrl = input.url ?? input.baseUrl;
    if (input.url !== undefined && input.baseUrl !== undefined && input.url !== input.baseUrl) {
        fail('INVALID_PRESET', 'url 与 baseUrl 不可同时使用不同的值。');
    }
    return Object.freeze({
        id: cleanPresetId(input.id),
        name: cleanText(input.name, '预设名称', 1, 80),
        url: normalizeApiUrl(rawUrl),
        model: cleanText(input.model, '模型名', 1, 256),
        temperature: cleanNumber(input.temperature, 'temperature', 0, 2, 0.8),
        maxTokens: cleanNumber(input.maxTokens, 'maxTokens', 1, 16_384, 512),
        timeoutMs: cleanNumber(input.timeoutMs, 'timeoutMs', 10, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    });
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

async function parseJsonResponse(response) {
    const contentType = getContentType(response).toLowerCase();
    if (contentType && !contentType.includes('application/json') && !contentType.includes('+json')) {
        fail('NON_JSON_RESPONSE', '接口返回的不是 JSON，无法继续处理。');
    }
    try {
        return await response.json();
    } catch {
        fail('NON_JSON_RESPONSE', '接口返回的不是有效 JSON，无法继续处理。');
    }
}

function throwForHttpStatus(response) {
    const status = Number(response?.status);
    if (status === 401) fail('AUTH_FAILED', '接口认证失败，请检查本次会话解锁的 API Key。', { status });
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

/**
 * 纯 OpenAI-compatible 请求客户端。
 * 必须显式注入 fetchImpl，故本模块本身不会主动发起真实网络请求。
 */
export function createOpenAICompatibleClient({ fetchImpl } = {}) {
    if (typeof fetchImpl !== 'function') {
        throw new TypeError('必须显式提供 fetchImpl；运行时适配器应传入经审计的 fetch。');
    }

    async function requestJson({ preset, path, body, method = 'POST', signal, timeoutMs }) {
        const normalizedPreset = createConnectionPreset(preset);
        const apiKey = requireSessionKey(normalizedPreset.id);
        const requestTimeoutMs = cleanNumber(timeoutMs, 'timeoutMs', 10, MAX_TIMEOUT_MS, normalizedPreset.timeoutMs);
        const abortScope = createAbortScope({ signal, timeoutMs: requestTimeoutMs });
        try {
            let response;
            try {
                response = await fetchImpl(endpointFor(normalizedPreset.url, path), {
                    method,
                    headers: {
                        accept: 'application/json',
                        'content-type': 'application/json',
                        authorization: `Bearer ${apiKey}`,
                    },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: abortScope.signal,
                });
            } catch (error) {
                if (abortScope.reason || abortScope.signal.aborted || error?.name === 'AbortError') {
                    throwAbortError(abortScope.reason);
                }
                fail('NETWORK_ERROR', '无法连接模型服务，请检查 URL、网络或跨域配置。', { retryable: true });
            }
            if (!response?.ok) throwForHttpStatus(response);
            return await parseJsonResponse(response);
        } finally {
            abortScope.dispose();
        }
    }

    return Object.freeze({
        async chat(request) {
            if (!request || typeof request !== 'object' || !Array.isArray(request.messages) || request.messages.length < 1) {
                fail('INVALID_REQUEST', 'chat 请求至少需要一条消息。');
            }
            const normalizedPreset = createConnectionPreset(request.preset);
            const temperature = cleanNumber(request.temperature, 'temperature', 0, 2, normalizedPreset.temperature);
            const maxTokens = cleanNumber(request.maxTokens, 'maxTokens', 1, 16_384, normalizedPreset.maxTokens);
            const payload = await requestJson({
                preset: normalizedPreset,
                path: 'chat/completions',
                signal: request.signal,
                timeoutMs: request.timeoutMs,
                body: {
                    model: normalizedPreset.model,
                    messages: request.messages.map(normalizeMessage),
                    temperature,
                    max_tokens: maxTokens,
                },
            });
            return extractCompletionText(payload);
        },

        async fetchModels(request) {
            if (!request || typeof request !== 'object') fail('INVALID_REQUEST', 'fetchModels 需要连接预设。');
            const method = request.method ?? 'GET';
            if (!['GET', 'POST'].includes(method)) fail('INVALID_REQUEST', '模型列表请求方法仅允许 GET 或 POST。');
            const payload = await requestJson({
                preset: request.preset,
                path: 'models',
                method,
                signal: request.signal,
                timeoutMs: request.timeoutMs,
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




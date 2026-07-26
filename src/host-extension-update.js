/**
 * Host-side extension updater for the local SillyTavern installation.
 *
 * The caller must inject both the host request transport and the host's
 * request-header factory. This module never reaches for browser globals, so
 * tests and unsupported hosts safely remain offline.
 *
 * 诊断透明化（2026-07-27 真机反馈修复）：宿主的 /api/extensions/version 与
 * /update 在失败时返回 4xx/5xx + 说明性纯文本（见 SillyTavern
 * src/endpoints/extensions.js，例如 git pull 因本地改动失败时的 500 文本）。
 * 非 2xx 响应会读取响应体，经 sanitizeHostMessage 脱敏截断后随错误对象携带
 * （error.hostMessage / error.status / error.phase），供关于页弹窗与运行控制台
 * 展示；固定的 error.message 仍绝不包含宿主原文。
 */
export const HOST_EXTENSION_DIRECTORY = 'yuelema-phone-extension';
export const HOST_EXTENSION_IS_GLOBAL = false;
export const VERSION_ENDPOINT = '/api/extensions/version';
export const UPDATE_ENDPOINT = '/api/extensions/update';
export const HOST_MESSAGE_MAX_LENGTH = 240;

const REQUEST_BODY = Object.freeze({
    extensionName: HOST_EXTENSION_DIRECTORY,
    global: HOST_EXTENSION_IS_GLOBAL,
});

const SAFE_MESSAGES = Object.freeze({
    transport_unavailable: '宿主更新服务暂不可用，无法检查扩展更新。',
    request_headers_unavailable: '无法取得宿主请求凭据，暂不能检查扩展更新。',
    request_failed: '检查扩展更新时无法连接宿主服务。',
    request_failed_http: '宿主扩展更新请求失败。',
    invalid_json: '宿主扩展更新响应无法解析。',
    invalid_response: '宿主扩展更新响应格式无效。',
    not_git_installation: '此扩展不是 Git 安装，无法应用内更新。',
    unknown_error: '检查扩展更新时发生未知错误。',
});

const REDACTED_MARK = '[已脱敏]';

/**
 * 宿主说明文字只用于诊断展示：剥离控制字符、脱敏凭据样式片段（Bearer/sk-/
 * 长随机串/键值对形式的 key、token、secret 等）并截断到固定上限。
 * 输出绝不用于任何写入路径。
 */
export function sanitizeHostMessage(text) {
    if (typeof text !== 'string') return '';
    let value = text
        .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, REDACTED_MARK)
        .replace(/\b(authorization|proxy-authorization|api[_-]?key|apikey|access[_-]?token|token|secret|password|credential)\b\s*[:=]\s*\S+/giu, `$1: ${REDACTED_MARK}`)
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, REDACTED_MARK)
        .replace(/[A-Za-z0-9+/=_-]{40,}/gu, REDACTED_MARK)
        .replace(/\s{2,}/gu, ' ')
        .trim();
    if (value.length > HOST_MESSAGE_MAX_LENGTH) value = `${value.slice(0, HOST_MESSAGE_MAX_LENGTH)}…`;
    return value;
}

/**
 * A failure safe to surface in the settings UI. `message` 恒为固定文案；
 * 宿主原文只以 `hostMessage`（已脱敏截断）单独携带，由调用方决定展示位置。
 */
export class HostExtensionUpdateError extends Error {
    constructor(code, details = {}) {
        super(SAFE_MESSAGES[code] ?? SAFE_MESSAGES.unknown_error);
        this.name = 'HostExtensionUpdateError';
        this.code = code;
        this.status = Number.isInteger(details.status) ? details.status : undefined;
        this.hostMessage = typeof details.hostMessage === 'string' && details.hostMessage ? details.hostMessage : undefined;
        this.phase = details.phase === 'version' || details.phase === 'update' ? details.phase : undefined;
    }
}

function fail(code, details) {
    throw new HostExtensionUpdateError(code, details);
}

function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeStatus(response) {
    return Number.isInteger(response?.status) ? response.status : undefined;
}

function normalizeHeaders(getRequestHeaders) {
    if (typeof getRequestHeaders !== 'function') fail('request_headers_unavailable');
    let headers;
    try {
        headers = getRequestHeaders();
    } catch {
        fail('request_headers_unavailable');
    }
    if (!headers || typeof headers !== 'object') fail('request_headers_unavailable');
    return headers;
}

function assertVersionResponse(data) {
    if (!isRecord(data) || typeof data.isUpToDate !== 'boolean') {
        fail('invalid_response', { phase: 'version' });
    }
    for (const key of ['currentBranchName', 'currentCommitHash', 'remoteUrl']) {
        if (key in data && typeof data[key] !== 'string') fail('invalid_response', { phase: 'version' });
    }
}

function assertUpdateResponse(data) {
    if (!isRecord(data) || typeof data.isUpToDate !== 'boolean') {
        fail('invalid_response', { phase: 'update' });
    }
    for (const key of ['shortCommitHash', 'extensionPath', 'remoteUrl']) {
        if (key in data && typeof data[key] !== 'string') fail('invalid_response', { phase: 'update' });
    }
}

/** 非 2xx 时读取宿主纯文本说明（读取失败只保留状态码，绝不让读取错误覆盖原失败）。 */
async function readHostFailureMessage(response) {
    try {
        if (typeof response.text === 'function') return sanitizeHostMessage(await response.text());
        if (typeof response.json === 'function') return sanitizeHostMessage(JSON.stringify(await response.json()));
    } catch {
        // 响应体不可读时静默降级为仅状态码。
    }
    return '';
}

async function postHostJson({ transport, getRequestHeaders, endpoint, phase }) {
    if (typeof transport !== 'function') fail('transport_unavailable');

    let response;
    try {
        response = await transport(endpoint, {
            method: 'POST',
            headers: normalizeHeaders(getRequestHeaders),
            body: JSON.stringify(REQUEST_BODY),
        });
    } catch (error) {
        if (error instanceof HostExtensionUpdateError) throw error;
        fail('request_failed', { phase });
    }

    if (!isRecord(response) || typeof response.ok !== 'boolean') fail('invalid_response', { phase });
    if (!response.ok) {
        fail('request_failed_http', {
            status: safeStatus(response),
            hostMessage: await readHostFailureMessage(response),
            phase,
        });
    }
    if (typeof response.json !== 'function') fail('invalid_response', { phase });

    try {
        return await response.json();
    } catch {
        fail('invalid_json', { phase });
    }
}

/**
 * Checks the fixed user-scoped extension and, when necessary, asks the host to
 * pull its configured Git remote. Resolves only with a deliberately small
 * outcome object so local paths, remotes and raw server text never reach UI.
 */
export async function checkAndUpdateHostExtension({ transport, getRequestHeaders } = {}) {
    const version = await postHostJson({ transport, getRequestHeaders, endpoint: VERSION_ENDPOINT, phase: 'version' });
    assertVersionResponse(version);

    if (version.isUpToDate) {
        // 宿主对非 Git 目录返回 200 + 全空字段（isUpToDate 恒 true），必须与真最新区分。
        const branch = String(version.currentBranchName ?? '').trim();
        const commit = String(version.currentCommitHash ?? '').trim();
        if (!branch && !commit) fail('not_git_installation', { phase: 'version' });
        return Object.freeze({ outcome: 'up_to_date' });
    }

    const updated = await postHostJson({ transport, getRequestHeaders, endpoint: UPDATE_ENDPOINT, phase: 'update' });
    assertUpdateResponse(updated);
    return Object.freeze({ outcome: 'updated' });
}

/** Convenience wrapper for UI composition without exposing mutable dependencies. */
export function createHostExtensionUpdater(dependencies = {}) {
    return Object.freeze({
        checkAndUpdate: () => checkAndUpdateHostExtension(dependencies),
    });
}

/**
 * Projects any failure to a non-sensitive UI payload：固定 message + 可选的
 * status / phase / hostMessage（后者已在入错时脱敏截断）。未知错误只给固定文案。
 */
export function projectHostExtensionUpdateError(error) {
    const code = error instanceof HostExtensionUpdateError && SAFE_MESSAGES[error.code]
        ? error.code
        : 'unknown_error';
    const projected = { code, message: SAFE_MESSAGES[code] };
    if (error instanceof HostExtensionUpdateError) {
        if (Number.isInteger(error.status)) projected.status = error.status;
        if (typeof error.hostMessage === 'string' && error.hostMessage) projected.hostMessage = error.hostMessage;
        if (error.phase === 'version' || error.phase === 'update') projected.phase = error.phase;
    }
    return projected;
}

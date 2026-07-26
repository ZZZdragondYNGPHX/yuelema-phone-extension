/**
 * Host-side extension updater for the local SillyTavern installation.
 *
 * The caller must inject both the host request transport and the host's
 * request-header factory. This module never reaches for browser globals, so
 * tests and unsupported hosts safely remain offline.
 */
export const HOST_EXTENSION_DIRECTORY = 'yuelema-phone-extension';
export const HOST_EXTENSION_IS_GLOBAL = false;
export const VERSION_ENDPOINT = '/api/extensions/version';
export const UPDATE_ENDPOINT = '/api/extensions/update';

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

/** A failure safe to surface in the settings UI; it never contains host text. */
export class HostExtensionUpdateError extends Error {
    constructor(code, details = {}) {
        super(SAFE_MESSAGES[code] ?? SAFE_MESSAGES.unknown_error);
        this.name = 'HostExtensionUpdateError';
        this.code = code;
        this.status = Number.isInteger(details.status) ? details.status : undefined;
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
        fail('invalid_response');
    }
    for (const key of ['currentBranchName', 'currentCommitHash', 'remoteUrl']) {
        if (key in data && typeof data[key] !== 'string') fail('invalid_response');
    }
}

function assertUpdateResponse(data) {
    if (!isRecord(data) || typeof data.isUpToDate !== 'boolean') {
        fail('invalid_response');
    }
    for (const key of ['shortCommitHash', 'extensionPath', 'remoteUrl']) {
        if (key in data && typeof data[key] !== 'string') fail('invalid_response');
    }
}

async function postHostJson({ transport, getRequestHeaders, endpoint }) {
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
        fail('request_failed');
    }

    if (!isRecord(response) || typeof response.ok !== 'boolean') fail('invalid_response');
    if (!response.ok) fail('request_failed_http', { status: safeStatus(response) });
    if (typeof response.json !== 'function') fail('invalid_response');

    try {
        return await response.json();
    } catch {
        fail('invalid_json');
    }
}

/**
 * Checks the fixed user-scoped extension and, when necessary, asks the host to
 * pull its configured Git remote. Resolves only with a deliberately small
 * outcome object so local paths, remotes and raw server text never reach UI.
 */
export async function checkAndUpdateHostExtension({ transport, getRequestHeaders } = {}) {
    const version = await postHostJson({ transport, getRequestHeaders, endpoint: VERSION_ENDPOINT });
    assertVersionResponse(version);

    if (version.isUpToDate) {
        const branch = String(version.currentBranchName ?? '').trim();
        const commit = String(version.currentCommitHash ?? '').trim();
        if (!branch && !commit) fail('not_git_installation');
        return Object.freeze({ outcome: 'up_to_date' });
    }

    const updated = await postHostJson({ transport, getRequestHeaders, endpoint: UPDATE_ENDPOINT });
    assertUpdateResponse(updated);
    return Object.freeze({ outcome: 'updated' });
}

/** Convenience wrapper for UI composition without exposing mutable dependencies. */
export function createHostExtensionUpdater(dependencies = {}) {
    return Object.freeze({
        checkAndUpdate: () => checkAndUpdateHostExtension(dependencies),
    });
}

/** Projects any failure to a fixed, non-sensitive UI payload. */
export function projectHostExtensionUpdateError(error) {
    const code = error instanceof HostExtensionUpdateError && SAFE_MESSAGES[error.code]
        ? error.code
        : 'unknown_error';
    const projected = { code, message: SAFE_MESSAGES[code] };
    if (error instanceof HostExtensionUpdateError && Number.isInteger(error.status)) {
        projected.status = error.status;
    }
    return projected;
}

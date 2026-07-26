/**
 * 一次性远程图片导入（阶段 70.2 用户裁决）。
 *
 * 安全合同：
 * - 仅接受显式注入的 fetchImpl；模块自身没有任何默认网络能力。
 * - 链接只在用户主动点击导入时请求一次；URL 不落库、不进 MVU、不作为渲染来源，
 *   下载得到的字节仍必须经过既有本地压缩/签名校验链才能变成 embedded data URL。
 * - 请求省略凭据、不带 referrer、不写缓存；错误信息不回显 URL、不透出宿主异常原文。
 */

const DEFAULT_MAX_REMOTE_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const ACCEPTED_REMOTE_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);

const ERROR_MESSAGES = Object.freeze({
    REMOTE_IMPORT_UNAVAILABLE: '当前环境不支持从链接导入图片。',
    REMOTE_URL_INVALID: '图片链接无效；仅支持 http(s) 地址。',
    REMOTE_FETCH_FAILED: '图片链接下载失败；请确认链接可公开访问后重试。',
    REMOTE_IMAGE_TOO_LARGE: '链接图片过大；请使用 8MB 以内的图片。',
    REMOTE_IMAGE_TYPE_UNSUPPORTED: '链接内容不是支持的图片格式（PNG / JPEG / WebP）。',
    REMOTE_IMPORT_TIMEOUT: '图片链接下载超时；请稍后重试。',
});

function remoteImportError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
}

/** Maps a remote-import failure to a safe user-facing message; unknown errors return null. */
export function projectRemoteImportError(error) {
    const code = typeof error?.code === 'string' ? error.code : '';
    return ERROR_MESSAGES[code] ? { code, message: ERROR_MESSAGES[code] } : null;
}

function parseHttpUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
    let parsed;
    try {
        parsed = new URL(rawUrl.trim());
    } catch {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed;
}

/**
 * Creates a one-shot remote image importer bound to an injected transport.
 * `importImageFile(url)` resolves to a Blob that still has to pass the local
 * avatar/image compression + signature pipeline; it is never a render source.
 */
export function createRemoteImageImporter({
    fetchImpl,
    maxBytes = DEFAULT_MAX_REMOTE_IMAGE_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    if (typeof fetchImpl !== 'function') throw remoteImportError('REMOTE_IMPORT_UNAVAILABLE');
    if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 32 * 1024 * 1024) throw remoteImportError('REMOTE_IMPORT_UNAVAILABLE');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw remoteImportError('REMOTE_IMPORT_UNAVAILABLE');

    async function importImageFile(rawUrl) {
        const parsed = parseHttpUrl(rawUrl);
        if (!parsed) throw remoteImportError('REMOTE_URL_INVALID');

        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller && typeof setTimeout === 'function'
            ? setTimeout(() => controller.abort(), timeoutMs)
            : null;

        let response;
        try {
            response = await fetchImpl(parsed.toString(), {
                method: 'GET',
                credentials: 'omit',
                cache: 'no-store',
                redirect: 'follow',
                referrerPolicy: 'no-referrer',
                signal: controller?.signal,
            });
        } catch (error) {
            throw remoteImportError(error?.name === 'AbortError' ? 'REMOTE_IMPORT_TIMEOUT' : 'REMOTE_FETCH_FAILED');
        } finally {
            if (timer !== null) clearTimeout(timer);
        }

        if (!response || response.ok !== true) throw remoteImportError('REMOTE_FETCH_FAILED');

        const declaredLength = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw remoteImportError('REMOTE_IMAGE_TOO_LARGE');

        let blob;
        try {
            blob = await response.blob();
        } catch {
            throw remoteImportError('REMOTE_FETCH_FAILED');
        }
        if (!blob || typeof blob.size !== 'number' || typeof blob.type !== 'string') throw remoteImportError('REMOTE_FETCH_FAILED');
        if (blob.size > maxBytes) throw remoteImportError('REMOTE_IMAGE_TOO_LARGE');
        if (!ACCEPTED_REMOTE_IMAGE_TYPES.includes(blob.type)) throw remoteImportError('REMOTE_IMAGE_TYPE_UNSUPPORTED');
        return blob;
    }

    return Object.freeze({ importImageFile });
}

import { buildErrorDetail } from '../ui/operation-activity.js';

/**
 * 推荐/匹配域的内存诊断寄存器（安全控制台 detail 的服务层信道）。
 *
 * 背景：action-bridge 对服务层失败只回传 { ok, status, code, message }，
 * HTTP 状态码、错误类名、校验字段路径、响应摘要等诊断细节会在桥接处丢失。
 * 本模块提供纯内存、一次性消费的寄存器：服务层在失败点按 scope 登记诊断，
 * 页面层拿到失败结果后按 scope + 结果码消费，并经 buildErrorDetail 格式化
 * 进入安全运行控制台的 detail（入账时仍会整体过 sanitizeDiagnosticDetail）。
 *
 * 调用方合同（硬线）：只允许登记字段名/JSON 路径、错误码、HTTP 状态、
 * 已粗脱敏的响应摘要与重试提示；绝不登记 API Key/凭据、隐藏层字段值、
 * 关系分数值或阈值数值（字段名可以，值不行）。寄存器不持久化、不出网。
 */

const EXCERPT_MAX_LENGTH = 200;
// C0 控制字符（0x00–0x1F）与 DEL（0x7F）；用 fromCharCode 构造避免源码内嵌控制字符或易被工具链误改写的转义序列。
const NON_PRINTABLE_PATTERN = new RegExp(
    `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]+`,
    'gu',
);
const registers = new Map();

export const RECOMMENDATION_DIAGNOSTIC_SCOPES = Object.freeze({
    recommendationRefresh: 'recommendation_refresh',
    candidateMatch: 'candidate_match',
    soulMatchDraft: 'soul_match_draft',
    textMatchDraft: 'text_match_draft',
});

/** 摘要粗脱敏：控制字符压平、凭据样式 token 先行替换、截断到 ~200 字符。 */
export function excerptForDiagnostics(text, maxLength = EXCERPT_MAX_LENGTH) {
    if (typeof text !== 'string') return '';
    let value = text.replace(NON_PRINTABLE_PATTERN, ' ').replace(/\s+/gu, ' ').trim();
    value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, '[已脱敏]');
    value = value.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[已脱敏]');
    value = value.replace(/\b(api[_-]?key|apikey|authorization|access[_-]?token|token|secret|password|credential)\b\s*["']?\s*[:=]\s*[^\s,;"']+/giu, '$1: [已脱敏]');
    value = value.replace(/[A-Za-z0-9+/=_-]{32,}/gu, '[已脱敏]');
    if (value.length > maxLength) value = `${value.slice(0, maxLength)}…`;
    return value;
}

/** 从任意错误对象提取可诊断字段的安全快照；无可用信息时返回 null。 */
export function snapshotErrorForDiagnostics(error) {
    if (typeof error === 'string') {
        const message = excerptForDiagnostics(error);
        return message ? { message } : null;
    }
    if (!error || typeof error !== 'object') return null;
    const snapshot = {};
    if (typeof error.name === 'string' && error.name) snapshot.name = error.name;
    if (typeof error.message === 'string' && error.message) snapshot.message = excerptForDiagnostics(error.message);
    if (typeof error.code === 'string' || Number.isInteger(error.code)) snapshot.code = error.code;
    const status = error.status ?? error.statusCode ?? error.httpStatus;
    if (Number.isInteger(status)) snapshot.status = status;
    if (typeof error.bodyExcerpt === 'string' && error.bodyExcerpt) snapshot.bodyExcerpt = excerptForDiagnostics(error.bodyExcerpt);
    if (typeof error.contentType === 'string' && error.contentType) snapshot.contentType = excerptForDiagnostics(error.contentType, 80);
    if (Number.isInteger(error.streamCharacters)) snapshot.streamCharacters = error.streamCharacters;
    if (Number.isInteger(error.receivedBytes)) snapshot.receivedBytes = error.receivedBytes;
    if (error.retryable === true) snapshot.retryable = true;
    return Object.keys(snapshot).length ? snapshot : null;
}

/** 只描述模型响应形态（长度/超限/围栏/开头摘要），供 detail 定位不合规点。 */
export function describeModelResponseForDiagnostics(raw, maxChars) {
    if (typeof raw !== 'string') return '模型未返回文本';
    if (!raw.trim()) return '模型返回空文本';
    if (Number.isInteger(maxChars) && raw.length > maxChars) {
        return `响应共 ${raw.length} 字符，超过 ${maxChars} 字符解析上限`;
    }
    const fenceNote = raw.trim().startsWith('```') ? '带 Markdown 代码围栏；' : '';
    return `${fenceNote}响应共 ${raw.length} 字符，开头：${excerptForDiagnostics(raw, 120)}`;
}

export function clearRecommendationDiagnostics(scope) {
    registers.delete(scope);
}

/**
 * 登记一次失败诊断。diagnostics 形如
 * { code, stage, error, field, expected, actual, hint, httpStatus }；
 * code 必须与服务层最终返回给调用方的结果码一致，供消费端配对。
 */
export function recordRecommendationDiagnostics(scope, diagnostics) {
    if (typeof scope !== 'string' || !scope) return;
    if (!diagnostics || typeof diagnostics !== 'object') return;
    registers.set(scope, Object.freeze({ ...diagnostics }));
}

/** 一次性消费：读取即清空；提供 code 时要求与登记的结果码一致，避免错配。 */
export function consumeRecommendationDiagnostics(scope, { code } = {}) {
    const diagnostics = registers.get(scope) ?? null;
    registers.delete(scope);
    if (!diagnostics) return null;
    if (code !== undefined && diagnostics.code !== undefined && diagnostics.code !== code) return null;
    return diagnostics;
}

/**
 * 页面层唯一的失败 detail 组装入口：优先采用服务层寄存的诊断
 * （其 stage/字段/摘要更准确），退化时也能仅凭结果码 + 粗略 message 组装。
 * 输出永远只是文本，最终入账仍由台账脱敏器兜底。
 */
export function formatRecommendationFailureDetail({ scope, result, error, operation, stage } = {}) {
    const code = typeof result?.code === 'string' && result.code ? result.code : undefined;
    const diagnostics = scope ? consumeRecommendationDiagnostics(scope, { code }) : null;
    const errorLike = snapshotErrorForDiagnostics(error)
        ?? diagnostics?.error
        ?? (code || typeof result?.message === 'string' ? { code, message: result?.message } : null);
    const context = {
        operation,
        stage: diagnostics?.stage ?? stage,
        field: diagnostics?.field,
        expected: diagnostics?.expected,
        actual: diagnostics?.actual ?? diagnostics?.error?.bodyExcerpt,
        hint: diagnostics?.hint,
    };
    if (code && errorLike?.code !== code) context.code = code;
    const httpStatus = diagnostics?.httpStatus ?? diagnostics?.error?.status;
    if (Number.isInteger(httpStatus) && !Number.isInteger(errorLike?.status)) context.httpStatus = httpStatus;
    return buildErrorDetail(errorLike, context);
}

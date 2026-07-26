/**
 * 设计系统 2.0 基础组件：徽章与 chip（策划书 §3.5-3）。
 *
 * 纯 DOM 工厂：不发网络、不持久化、无 innerHTML、无 console。
 * class 合同见 src/ui/COMPONENTS.md。
 */

export const STATUS_CHIP_TONES = Object.freeze(['success', 'warning', 'danger', 'info', 'brand', 'neutral']);

function requireDocument(documentRef) {
    if (!documentRef || typeof documentRef.createElement !== 'function') {
        throw new TypeError('yl_badge_document_required');
    }
    return documentRef;
}

/**
 * 未读数字徽章。count <= 0 或非有限数字时返回 null（调用方据此不渲染）。
 * 超过 99 显示「99+」。
 *
 * @param {number} count
 * @param {{ documentRef?: Document }} [options]
 * @returns {HTMLSpanElement|null}
 */
export function createUnreadBadge(count, { documentRef = globalThis.document } = {}) {
    const doc = requireDocument(documentRef);
    const value = Number(count);
    if (!Number.isFinite(value) || value < 1) return null;
    const whole = Math.floor(value);
    const display = whole > 99 ? '99+' : String(whole);
    const badge = doc.createElement('span');
    badge.className = 'yl-badge yl-badge--unread';
    badge.textContent = display;
    badge.setAttribute('aria-label', `${display} 条未读`);
    return badge;
}

/**
 * 状态 chip（语义色）。
 *
 * @param {{ documentRef?: Document, text: string, tone?: 'success'|'warning'|'danger'|'info'|'brand'|'neutral' }} options
 * @returns {HTMLSpanElement}
 */
export function createStatusChip({ documentRef = globalThis.document, text, tone = 'neutral' } = {}) {
    const doc = requireDocument(documentRef);
    const value = String(text ?? '').trim();
    if (!value) throw new TypeError('yl_chip_text_required');
    if (!STATUS_CHIP_TONES.includes(tone)) throw new TypeError('yl_chip_tone_invalid');
    const chip = doc.createElement('span');
    chip.className = `yl-chip yl-chip--status yl-chip--${tone}`;
    chip.textContent = value;
    return chip;
}

/**
 * 标签 chip（中性小标签，如兴趣关键词、同频理由）。
 *
 * @param {string} text
 * @param {{ documentRef?: Document }} [options]
 * @returns {HTMLSpanElement}
 */
export function createTagChip(text, { documentRef = globalThis.document } = {}) {
    const doc = requireDocument(documentRef);
    const value = String(text ?? '').trim();
    if (!value) throw new TypeError('yl_chip_text_required');
    const chip = doc.createElement('span');
    chip.className = 'yl-chip yl-chip--tag';
    chip.textContent = value;
    return chip;
}

/**
 * 设计系统 2.0 基础组件：按钮工厂（策划书 §3.5-1）。
 *
 * 纯 DOM 工厂：不发网络、不持久化、无 innerHTML、无 console；
 * 样式完全由 style.css 按 class 合同提供，本模块只定结构与行为。
 * class 合同见 src/ui/COMPONENTS.md。
 */

import { createUiIcon } from './icon.js';

export const BUTTON_VARIANTS = Object.freeze(['primary', 'tonal', 'ghost', 'icon', 'danger']);

function requireDocument(documentRef) {
    if (!documentRef || typeof documentRef.createElement !== 'function') {
        throw new TypeError('yl_button_document_required');
    }
    return documentRef;
}

/**
 * 创建统一按钮。
 *
 * @param {{
 *   documentRef?: Document,
 *   variant?: 'primary'|'tonal'|'ghost'|'icon'|'danger',
 *   label?: string,
 *   icon?: string|null,
 *   onClick?: (() => void)|null,
 *   disabled?: boolean,
 *   ariaLabel?: string,
 * }} [options]
 * @returns {HTMLButtonElement} 真实 <button type="button">；调用方可直接读写 .disabled。
 *
 * 约定：
 * - variant='icon' 为纯图标按钮（44px 热区语义交给 CSS 的 yl-btn--icon），
 *   必须提供 ariaLabel，label 不渲染。
 * - 其余变体必须提供非空 label；icon 可选，渲染在 label 左侧。
 */
export function createButton({
    documentRef = globalThis.document,
    variant = 'primary',
    label = '',
    icon = null,
    onClick = null,
    disabled = false,
    ariaLabel = '',
} = {}) {
    const doc = requireDocument(documentRef);
    if (!BUTTON_VARIANTS.includes(variant)) throw new TypeError('yl_button_variant_invalid');

    const text = String(label ?? '');
    const iconOnly = variant === 'icon';
    if (iconOnly && !String(ariaLabel ?? '').trim()) throw new TypeError('yl_button_icon_aria_label_required');
    if (!iconOnly && !text.trim()) throw new TypeError('yl_button_label_required');
    if (iconOnly && !icon) throw new TypeError('yl_button_icon_name_required');

    const button = doc.createElement('button');
    button.setAttribute('type', 'button');
    button.className = `yl-btn yl-btn--${variant}`;
    if (icon) {
        button.appendChild(createUiIcon(doc, String(icon), { className: 'yl-ui-icon yl-btn__icon' }));
    }
    if (!iconOnly) {
        const labelNode = doc.createElement('span');
        labelNode.className = 'yl-btn__label';
        labelNode.textContent = text;
        button.appendChild(labelNode);
    }
    if (String(ariaLabel ?? '').trim()) button.setAttribute('aria-label', String(ariaLabel));
    button.disabled = Boolean(disabled);

    if (typeof onClick === 'function') {
        button.addEventListener('click', (event) => {
            // 真实浏览器 disabled 按钮不派发 click；MiniDOM 会，这里显式守卫使合同一致。
            if (button.disabled) return;
            try {
                onClick(event);
            } catch {
                // 宿主回调异常不得破坏按钮本身。
            }
        });
    }
    return button;
}

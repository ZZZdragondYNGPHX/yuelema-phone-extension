/**
 * 设计系统 2.0 基础组件：空状态（策划书 §3.5-7）。
 *
 * 内置 3 款本地 SVG 插画（inbox / search / heart），替代 ✧◌ 等字符装饰；
 * 插画为内联本地路径，无网络、无外链。
 *
 * 纯 DOM 工厂：不发网络、不持久化、无 innerHTML、无 console。
 * class 合同见 src/ui/COMPONENTS.md。
 */

import { createButton } from './button.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export const EMPTY_STATE_VARIANTS = Object.freeze(['inbox', 'search', 'heart']);

// 96 viewBox、stroke 3（视觉密度等价 24 viewBox / 0.75，比图标更轻的插画线宽）。
const ILLUSTRATION_PATHS = Object.freeze({
    inbox: Object.freeze([
        'M24 26h48l8 26v20a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4V52z',
        'M16 52h20l4 8h16l4-8h20',
        'M48 14v6M34 17l2.5 5M62 17l-2.5 5',
    ]),
    search: Object.freeze([
        'M43 62a21 21 0 1 0 0-42 21 21 0 0 0 0 42Z',
        'm58.5 57.5 19 19',
        'm72 20 2 5 5 2-5 2-2 5-2-5-5-2 5-2z',
    ]),
    heart: Object.freeze([
        'M48 76S20 60.5 20 41a13.5 13.5 0 0 1 25-7.1A13.5 13.5 0 0 1 76 41c0 19.5-28 35-28 35Z',
        'm76 16 1.6 4 4 1.6-4 1.6-1.6 4-1.6-4-4-1.6 4-1.6z',
        'M16 62l1.3 3.2 3.2 1.3-3.2 1.3L16 71l-1.3-3.2-3.2-1.3 3.2-1.3z',
    ]),
});

function requireDocument(documentRef) {
    if (!documentRef || typeof documentRef.createElement !== 'function') {
        throw new TypeError('yl_empty_document_required');
    }
    return documentRef;
}

function svgElement(doc, tag) {
    return doc.createElementNS?.(SVG_NS, tag) ?? doc.createElement(tag);
}

function createIllustration(doc, variant) {
    const svg = svgElement(doc, 'svg');
    svg.setAttribute('class', 'yl-empty__svg');
    svg.setAttribute('viewBox', '0 0 96 96');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '3');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.dataset.illustration = variant;
    for (const d of ILLUSTRATION_PATHS[variant]) {
        const path = svgElement(doc, 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    }
    return svg;
}

/**
 * @param {{
 *   documentRef?: Document,
 *   variant?: 'inbox'|'search'|'heart',
 *   title: string,
 *   hint?: string,
 *   action?: { label: string, onClick?: Function, variant?: string, icon?: string|null, ariaLabel?: string }|null,
 * }} options
 * @returns {HTMLDivElement} .yl-empty 根节点。
 */
export function createEmptyState({
    documentRef = globalThis.document,
    variant = 'inbox',
    title,
    hint = '',
    action = null,
} = {}) {
    const doc = requireDocument(documentRef);
    if (!EMPTY_STATE_VARIANTS.includes(variant)) throw new TypeError('yl_empty_variant_invalid');
    const titleText = String(title ?? '').trim();
    if (!titleText) throw new TypeError('yl_empty_title_required');

    const root = doc.createElement('div');
    root.className = `yl-empty yl-empty--${variant}`;

    const art = doc.createElement('div');
    art.className = 'yl-empty__art';
    art.appendChild(createIllustration(doc, variant));
    root.appendChild(art);

    const titleNode = doc.createElement('h3');
    titleNode.className = 'yl-empty__title';
    titleNode.textContent = titleText;
    root.appendChild(titleNode);

    const hintText = String(hint ?? '').trim();
    if (hintText) {
        const hintNode = doc.createElement('p');
        hintNode.className = 'yl-empty__hint';
        hintNode.textContent = hintText;
        root.appendChild(hintNode);
    }

    if (action && typeof action === 'object') {
        const button = createButton({
            documentRef: doc,
            variant: action.variant ?? 'tonal',
            label: action.label,
            icon: action.icon ?? null,
            onClick: typeof action.onClick === 'function' ? action.onClick : null,
            ariaLabel: action.ariaLabel ?? '',
        });
        button.className = `${button.className} yl-empty__action`;
        root.appendChild(button);
    }

    return root;
}

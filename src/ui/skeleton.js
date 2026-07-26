/**
 * 设计系统 2.0 基础组件：骨架屏占位（策划书 §3.5-8）。
 *
 * AI 生成等待时的占位（候选卡 / 帖子流 / 列表行），头像圆 + 文本条结构；
 * 闪烁动画与配色全部交给 style.css。整块 aria-hidden，屏幕阅读器不朗读占位。
 *
 * 纯 DOM 工厂：不发网络、不持久化、无 innerHTML、无 console。
 * class 合同见 src/ui/COMPONENTS.md。
 */

export const SKELETON_VARIANTS = Object.freeze(['candidate-card', 'post', 'list-row']);

const MAX_SKELETON_COUNT = 12;

function requireDocument(documentRef) {
    if (!documentRef || typeof documentRef.createElement !== 'function') {
        throw new TypeError('yl_skeleton_document_required');
    }
    return documentRef;
}

function block(doc, className) {
    const node = doc.createElement('div');
    node.className = className;
    return node;
}

function lines(doc, modifiers) {
    const box = block(doc, 'yl-skeleton__lines');
    for (const modifier of modifiers) {
        box.appendChild(block(doc, modifier ? `yl-skeleton__line yl-skeleton__line--${modifier}` : 'yl-skeleton__line'));
    }
    return box;
}

function buildItem(doc, variant) {
    const item = block(doc, `yl-skeleton__item yl-skeleton__item--${variant}`);
    if (variant === 'candidate-card') {
        item.appendChild(block(doc, 'yl-skeleton__media'));
        item.appendChild(block(doc, 'yl-skeleton__avatar'));
        item.appendChild(lines(doc, ['', '', 'short']));
    } else if (variant === 'post') {
        item.appendChild(block(doc, 'yl-skeleton__avatar'));
        item.appendChild(lines(doc, ['half', '', '', 'short']));
        item.appendChild(block(doc, 'yl-skeleton__media'));
    } else {
        item.appendChild(block(doc, 'yl-skeleton__avatar'));
        item.appendChild(lines(doc, ['', 'short']));
    }
    return item;
}

/**
 * @param {{
 *   documentRef?: Document,
 *   variant?: 'candidate-card'|'post'|'list-row',
 *   count?: number,
 * }} options
 * @returns {HTMLDivElement} .yl-skeleton 根节点（aria-hidden="true"）。
 *
 * count 必须为 >=1 的整数，超过 12 时收敛为 12（占位无必要更多）。
 */
export function createSkeleton({
    documentRef = globalThis.document,
    variant = 'list-row',
    count = 1,
} = {}) {
    const doc = requireDocument(documentRef);
    if (!SKELETON_VARIANTS.includes(variant)) throw new TypeError('yl_skeleton_variant_invalid');
    const requested = Number(count);
    if (!Number.isInteger(requested) || requested < 1) throw new TypeError('yl_skeleton_count_invalid');
    const total = Math.min(requested, MAX_SKELETON_COUNT);

    const root = block(doc, `yl-skeleton yl-skeleton--${variant}`);
    root.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < total; index += 1) {
        root.appendChild(buildItem(doc, variant));
    }
    return root;
}

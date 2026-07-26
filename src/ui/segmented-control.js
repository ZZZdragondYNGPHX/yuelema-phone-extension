/**
 * 设计系统 2.0 基础组件：胶囊分段切换（策划书 §3.5-5）。
 *
 * 语义选型：radiogroup（而非 tablist）。理由：本工厂只知道「N 选 1」的选中值，
 * 不拥有它所控制的内容面板——tablist 语义要求每个 tab 通过 aria-controls 指向
 * 真实存在的 role=tabpanel 节点，而面板由各页面自行渲染，工厂无法保证该配对；
 * radio 模式无此外部依赖，且「方向键漫游即选中 + roving tabindex」正是原生
 * radio 组的标准键盘模型，与本组件行为完全一致。
 *
 * 纯 DOM 工厂：不发网络、不持久化、无 innerHTML、无 console。
 * class 合同见 src/ui/COMPONENTS.md。
 */

function requireDocument(documentRef) {
    if (!documentRef || typeof documentRef.createElement !== 'function') {
        throw new TypeError('yl_seg_document_required');
    }
    return documentRef;
}

/**
 * @param {{
 *   documentRef?: Document,
 *   segments: Array<{ id: string, label: string }>,
 *   activeId?: string|null,
 *   onChange?: ((id: string) => void)|null,
 *   ariaLabel?: string,
 * }} options
 * @returns {{
 *   root: HTMLDivElement,
 *   element: HTMLDivElement,
 *   getActiveId: () => string,
 *   setActive: (id: string) => boolean,  // 程序式切换，不触发 onChange；未知 id 返回 false
 * }}
 */
export function createSegmentedControl({
    documentRef = globalThis.document,
    segments,
    activeId = null,
    onChange = null,
    ariaLabel = '',
} = {}) {
    const doc = requireDocument(documentRef);
    if (!Array.isArray(segments) || segments.length === 0) throw new TypeError('yl_seg_segments_required');
    const entries = segments.map((segment) => ({
        id: String(segment?.id ?? '').trim(),
        label: String(segment?.label ?? '').trim(),
    }));
    if (entries.some((entry) => !entry.id || !entry.label)) throw new TypeError('yl_seg_segment_invalid');
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new TypeError('yl_seg_segment_duplicate');

    const root = doc.createElement('div');
    root.className = 'yl-seg';
    root.setAttribute('role', 'radiogroup');
    if (String(ariaLabel ?? '').trim()) root.setAttribute('aria-label', String(ariaLabel));

    let currentId = entries.some((entry) => entry.id === activeId) ? activeId : entries[0].id;
    /** @type {Map<string, HTMLButtonElement>} */
    const items = new Map();

    function sync() {
        for (const entry of entries) {
            const item = items.get(entry.id);
            const active = entry.id === currentId;
            item.setAttribute('aria-checked', active ? 'true' : 'false');
            item.setAttribute('tabindex', active ? '0' : '-1');
            item.classList.toggle('is-active', active);
        }
    }

    function select(id, { focus = false } = {}) {
        if (!items.has(id)) return false;
        const changed = id !== currentId;
        currentId = id;
        sync();
        if (focus) {
            const item = items.get(id);
            if (typeof item.focus === 'function') item.focus();
        }
        if (changed && typeof onChange === 'function') {
            try {
                onChange(id);
            } catch {
                // 宿主回调异常不得破坏分段控件本身。
            }
        }
        return true;
    }

    function moveBy(offset) {
        const index = entries.findIndex((entry) => entry.id === currentId);
        const next = entries[(index + offset + entries.length) % entries.length];
        select(next.id, { focus: true });
    }

    for (const entry of entries) {
        const item = doc.createElement('button');
        item.setAttribute('type', 'button');
        item.setAttribute('role', 'radio');
        item.className = 'yl-seg__item';
        item.dataset.segmentId = entry.id;
        const label = doc.createElement('span');
        label.className = 'yl-seg__label';
        label.textContent = entry.label;
        item.appendChild(label);
        item.addEventListener('click', () => select(entry.id));
        // MiniDOM 事件不冒泡，键盘监听逐项挂载（真实 DOM 下行为等价）。
        item.addEventListener('keydown', (event) => {
            const key = event.key;
            let handled = true;
            if (key === 'ArrowRight' || key === 'ArrowDown') moveBy(1);
            else if (key === 'ArrowLeft' || key === 'ArrowUp') moveBy(-1);
            else if (key === 'Home') select(entries[0].id, { focus: true });
            else if (key === 'End') select(entries[entries.length - 1].id, { focus: true });
            else handled = false;
            if (handled && typeof event.preventDefault === 'function') event.preventDefault();
        });
        items.set(entry.id, item);
        root.appendChild(item);
    }
    sync();

    return Object.freeze({
        root,
        element: root,
        getActiveId: () => currentId,
        setActive: (id) => {
            if (!items.has(id)) return false;
            currentId = id;
            sync();
            return true;
        },
    });
}

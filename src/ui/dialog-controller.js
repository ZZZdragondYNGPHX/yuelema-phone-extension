/**
 * 弹窗焦点控制器：统一管理手工弹窗的打开聚焦、Tab 焦点环、Escape 关栈顶与关闭回 opener。
 *
 * 纯 DOM 模块：不发网络、不持久化、不引入业务模块；所有 DOM 访问都经由注入的 documentRef。
 * 可聚焦元素通过手动递归遍历收集，以兼容测试环境 MiniDOM 的有限选择器能力。
 */

const FOCUSABLE_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);

function requireDocument(documentRef) {
    if (!documentRef || typeof documentRef.createElement !== 'function') {
        throw new TypeError('dialog_controller_document_required');
    }
    return documentRef;
}

function tagNameOf(node) {
    return typeof node?.tagName === 'string' ? node.tagName.toUpperCase() : '';
}

function isElementLike(node) {
    return Boolean(node) && typeof node.getAttribute === 'function';
}

function isDisabled(node) {
    if (node.disabled === true) return true;
    const attr = node.getAttribute('disabled');
    return typeof attr === 'string' && attr !== '';
}

function isFocusCandidate(node) {
    if (FOCUSABLE_TAGS.has(tagNameOf(node))) return true;
    const tabindex = node.getAttribute('tabindex');
    return tabindex !== null && tabindex !== undefined && tabindex !== '-1';
}

/** 手动递归收集子树内可聚焦元素；disabled/hidden 节点连同其子树一并排除。 */
function collectFocusable(root) {
    const found = [];
    const visit = (node) => {
        const children = node?.childNodes ?? node?.children ?? [];
        for (const child of children) {
            if (isElementLike(child)) {
                if (child.hidden === true || isDisabled(child)) continue;
                if (isFocusCandidate(child)) found.push(child);
            }
            visit(child);
        }
    };
    visit(root);
    return found;
}

/** 沿 parentNode 父链判断 node 是否位于 ancestor 内（MiniDOM 无 contains）。 */
function isWithin(node, ancestor) {
    let current = node;
    while (current) {
        if (current === ancestor) return true;
        current = current.parentNode ?? null;
    }
    return false;
}

function tryFocus(node) {
    if (!node || typeof node.focus !== 'function') return false;
    try {
        node.focus();
        return true;
    } catch {
        return false;
    }
}

/**
 * 创建弹窗控制器。
 *
 * @param {{ documentRef?: Document }} [options]
 * @returns {{
 *   open: (dialog: Element, options?: { opener?: Element|null, initialFocus?: Element|null, onRequestClose?: (() => void)|null }) => void,
 *   close: (dialog: Element, options?: { restoreFocus?: boolean }) => void,
 *   handleKeydown: (event: KeyboardEvent) => boolean,
 *   hasOpenDialog: () => boolean,
 *   isTopDialog: (dialog: Element) => boolean,
 *   dispose: () => void,
 * }}
 */
export function createDialogController({ documentRef = globalThis.document } = {}) {
    const document = requireDocument(documentRef);
    /** @type {Array<{ dialog: Element, opener: Element|null, onRequestClose: (() => void)|null }>} */
    const stack = [];

    function open(dialog, { opener = null, initialFocus = null, onRequestClose = null } = {}) {
        if (!dialog) return;
        const resolvedOpener = opener ?? document.activeElement ?? null;
        const existingIndex = stack.findIndex((entry) => entry.dialog === dialog);
        if (existingIndex >= 0) stack.splice(existingIndex, 1);
        stack.push({ dialog, opener: resolvedOpener, onRequestClose: typeof onRequestClose === 'function' ? onRequestClose : null });

        dialog.hidden = false;
        dialog.setAttribute('aria-modal', 'true');

        if (initialFocus && tryFocus(initialFocus)) return;
        const focusables = collectFocusable(dialog);
        if (focusables.length > 0 && tryFocus(focusables[0])) return;
        dialog.setAttribute('tabindex', '-1');
        tryFocus(dialog);
    }

    function close(dialog, { restoreFocus = true } = {}) {
        if (!dialog) return;
        const index = stack.findIndex((entry) => entry.dialog === dialog);
        const entry = index >= 0 ? stack.splice(index, 1)[0] : null;
        dialog.hidden = true;
        if (!entry || !restoreFocus) return;

        const active = document.activeElement ?? null;
        const focusStillOurs = active === null || active === document.body || isWithin(active, dialog);
        if (!focusStillOurs) return;

        const opener = entry.opener;
        if (!opener || typeof opener.focus !== 'function') return;
        if (opener.disabled === true) return;
        if (!isWithin(opener, document)) return;
        try {
            opener.focus();
        } catch {
            // 恢复焦点失败保持静默，不打断关闭流程。
        }
    }

    function handleKeydown(event) {
        if (!event || stack.length === 0) return false;
        const top = stack[stack.length - 1];

        if (event.key === 'Escape') {
            if (top.onRequestClose) top.onRequestClose();
            else close(top.dialog);
            return true;
        }

        if (event.key !== 'Tab') return false;
        if (typeof event.preventDefault === 'function') event.preventDefault();

        const focusables = collectFocusable(top.dialog);
        if (focusables.length === 0) {
            tryFocus(top.dialog);
            return true;
        }

        const active = document.activeElement ?? null;
        const index = active && isWithin(active, top.dialog) ? focusables.indexOf(active) : -1;
        let target;
        if (index < 0) {
            target = focusables[0];
        } else if (event.shiftKey) {
            target = focusables[(index - 1 + focusables.length) % focusables.length];
        } else {
            target = focusables[(index + 1) % focusables.length];
        }
        tryFocus(target);
        return true;
    }

    function hasOpenDialog() {
        return stack.length > 0;
    }

    function isTopDialog(dialog) {
        return stack.length > 0 && stack[stack.length - 1].dialog === dialog;
    }

    function dispose() {
        stack.length = 0;
    }

    return Object.freeze({ open, close, handleKeydown, hasOpenDialog, isTopDialog, dispose });
}

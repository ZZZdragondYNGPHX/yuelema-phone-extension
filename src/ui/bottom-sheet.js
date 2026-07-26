/**
 * 设计系统 2.0 基础组件：BottomSheet（策划书 §3.5-6、§4.5）。
 *
 * 结构固定为 遮罩 + 面板 + titlebar(标题 + 关闭钮) + 内容区。
 * 手机端呈现为底部滑出、电脑端呈现为居中 Dialog —— 完全由 style.css 按
 * data-ui-layout 门禁决定，本模块不感知布局（铁律：布局切换只翻 data 属性不重渲）。
 *
 * 有 dialogController（src/ui/dialog-controller.js 单例）时，open/close 走其
 * 压栈/出栈获得焦点环、Escape 关栈顶与关闭回焦（接线范式同
 * src/images/image-manager-panel.js）；无控制器时降级为 hidden 切换。
 *
 * 纯 DOM 工厂：不发网络、不持久化、无 innerHTML、无 console。
 * class 合同见 src/ui/COMPONENTS.md。
 */

import { createButton } from './button.js';

function requireDocument(documentRef) {
    if (!documentRef || typeof documentRef.createElement !== 'function') {
        throw new TypeError('yl_sheet_document_required');
    }
    return documentRef;
}

/**
 * @param {{
 *   documentRef?: Document,
 *   title: string,
 *   content?: Node|null,
 *   onRequestClose?: (() => void)|null,
 *   dialogController?: { open: Function, close: Function }|null,
 * }} options
 * @returns {{
 *   root: HTMLDivElement,        // .yl-sheet（含遮罩），由调用方挂载
 *   element: HTMLDivElement,     // 同 root
 *   open: (options?: { opener?: Element|null }) => void,
 *   close: (options?: { restoreFocus?: boolean }) => void,
 *   isOpen: () => boolean,
 * }}
 *
 * 关闭路由：关闭钮 / 遮罩点击 /（有控制器时）Escape 统一走「请求关闭」——
 * 提供了 onRequestClose 则只通知调用方（由其决定何时真正 close()，可拦截做
 * 二次确认）；未提供则直接 close()。controller.close 不回调 onRequestClose，
 * 与 close() 无递归。
 */
export function createBottomSheet({
    documentRef = globalThis.document,
    title,
    content = null,
    onRequestClose = null,
    dialogController = null,
} = {}) {
    const doc = requireDocument(documentRef);
    const titleText = String(title ?? '').trim();
    if (!titleText) throw new TypeError('yl_sheet_title_required');

    const root = doc.createElement('div');
    root.className = 'yl-sheet';
    root.hidden = true;

    const scrim = doc.createElement('div');
    scrim.className = 'yl-sheet__scrim';

    const panel = doc.createElement('section');
    panel.className = 'yl-sheet__panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', titleText);

    const titlebar = doc.createElement('header');
    titlebar.className = 'yl-sheet__titlebar';
    const titleNode = doc.createElement('h2');
    titleNode.className = 'yl-sheet__title';
    titleNode.textContent = titleText;
    const closeButton = createButton({
        documentRef: doc,
        variant: 'icon',
        icon: 'close',
        ariaLabel: '关闭',
        onClick: () => requestClose(),
    });
    closeButton.className = `${closeButton.className} yl-sheet__close`;
    titlebar.appendChild(titleNode);
    titlebar.appendChild(closeButton);

    const body = doc.createElement('div');
    body.className = 'yl-sheet__body';
    if (content && typeof content === 'object' && typeof content.parentNode !== 'undefined') {
        body.appendChild(content);
    }

    panel.appendChild(titlebar);
    panel.appendChild(body);
    root.appendChild(scrim);
    root.appendChild(panel);

    let openState = false;

    function requestClose() {
        if (!openState) return;
        if (typeof onRequestClose === 'function') {
            try {
                onRequestClose();
            } catch {
                // 宿主回调异常不得卡死面板。
            }
            return;
        }
        close();
    }

    function open({ opener = null } = {}) {
        if (openState) return;
        openState = true;
        root.hidden = false;
        root.classList.toggle('is-open', true);
        panel.hidden = false;
        if (dialogController) {
            // 控制器负责 aria-modal、Tab 焦点环、首个可聚焦元素（即关闭钮）聚焦与 Escape。
            dialogController.open(panel, { opener, onRequestClose: requestClose });
        }
    }

    function close({ restoreFocus = true } = {}) {
        if (!openState) return;
        openState = false;
        if (dialogController) dialogController.close(panel, { restoreFocus });
        root.hidden = true;
        root.classList.toggle('is-open', false);
    }

    scrim.addEventListener('click', () => requestClose());

    return Object.freeze({ root, element: root, open, close, isOpen: () => openState });
}

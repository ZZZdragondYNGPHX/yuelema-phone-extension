/**
 * 设计系统 2.0 基础组件：通用列表行（策划书 §3.5-2）。
 *
 * 头像 + 双行文案 + 右侧 meta 区（时间 / 未读徽章 / chips / 箭头），
 * 供消息、群组、设置、我的等页面统一复用。
 *
 * 语义采用 div[role="button"] + tabindex=0 + 自管 Enter/Space 激活，而非原生
 * <button>：行内可承载任意块级头像/徽章子树（原生 button 仅限 phrasing content），
 * 且避免原生 Enter→click 与自管 keydown 的双通道重复激活。
 *
 * 纯 DOM 工厂：不发网络、不持久化、无 innerHTML、无 console。
 * class 合同见 src/ui/COMPONENTS.md。
 */

import { createUiIcon } from './icon.js';
import { createUnreadBadge, createTagChip } from './badge.js';

function requireDocument(documentRef) {
    if (!documentRef || typeof documentRef.createElement !== 'function') {
        throw new TypeError('yl_list_row_document_required');
    }
    return documentRef;
}

function isNodeLike(value) {
    return Boolean(value) && typeof value === 'object' && typeof value.parentNode !== 'undefined';
}

/**
 * @param {{
 *   documentRef?: Document,
 *   avatar?: Node|null,
 *   title: string,
 *   subtitle?: string,
 *   meta?: { time?: string, badge?: number, chevron?: boolean, chips?: Array<string|Node> }|null,
 *   onClick?: ((event: Event) => void)|null,
 *   onContextMenu?: ((event: Event) => void)|null,
 * }} options
 * @returns {HTMLDivElement} 根节点 .yl-row（role=button，可聚焦，Enter/Space 激活）。
 */
export function createListRow({
    documentRef = globalThis.document,
    avatar = null,
    title,
    subtitle = '',
    meta = null,
    onClick = null,
    onContextMenu = null,
} = {}) {
    const doc = requireDocument(documentRef);
    const titleText = String(title ?? '').trim();
    if (!titleText) throw new TypeError('yl_list_row_title_required');

    const root = doc.createElement('div');
    root.className = 'yl-row';
    root.setAttribute('role', 'button');
    root.setAttribute('tabindex', '0');

    if (isNodeLike(avatar)) {
        const avatarBox = doc.createElement('div');
        avatarBox.className = 'yl-row__avatar';
        avatarBox.appendChild(avatar);
        root.appendChild(avatarBox);
    }

    const main = doc.createElement('div');
    main.className = 'yl-row__main';
    const titleNode = doc.createElement('div');
    titleNode.className = 'yl-row__title';
    titleNode.textContent = titleText;
    main.appendChild(titleNode);
    const subtitleText = String(subtitle ?? '').trim();
    if (subtitleText) {
        const subtitleNode = doc.createElement('div');
        subtitleNode.className = 'yl-row__subtitle';
        subtitleNode.textContent = subtitleText;
        main.appendChild(subtitleNode);
    }
    root.appendChild(main);

    const { time = '', badge = 0, chevron = false, chips = [] } = meta && typeof meta === 'object' ? meta : {};
    const timeText = String(time ?? '').trim();
    const chipList = Array.isArray(chips) ? chips : [];
    const badgeNode = createUnreadBadge(badge, { documentRef: doc });
    const hasMeta = Boolean(timeText) || chipList.length > 0 || Boolean(badgeNode) || Boolean(chevron);

    if (hasMeta) {
        const metaBox = doc.createElement('div');
        metaBox.className = 'yl-row__meta';
        if (timeText) {
            const timeNode = doc.createElement('span');
            timeNode.className = 'yl-row__time';
            timeNode.textContent = timeText;
            metaBox.appendChild(timeNode);
        }
        if (chipList.length > 0) {
            const chipsBox = doc.createElement('span');
            chipsBox.className = 'yl-row__chips';
            for (const chip of chipList) {
                if (isNodeLike(chip)) chipsBox.appendChild(chip);
                else chipsBox.appendChild(createTagChip(String(chip), { documentRef: doc }));
            }
            metaBox.appendChild(chipsBox);
        }
        if (badgeNode) {
            metaBox.appendChild(badgeNode);
            root.classList.toggle('is-unread', true);
        }
        if (chevron) {
            metaBox.appendChild(createUiIcon(doc, 'chevron_right', { className: 'yl-ui-icon yl-row__chevron', size: 18 }));
        }
        root.appendChild(metaBox);
    }

    function activate(event) {
        if (typeof onClick !== 'function') return;
        try {
            onClick(event);
        } catch {
            // 宿主回调异常不得破坏列表行本身。
        }
    }

    root.addEventListener('click', activate);
    root.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        activate(event);
    });
    if (typeof onContextMenu === 'function') {
        root.addEventListener('contextmenu', (event) => {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            try {
                onContextMenu(event);
            } catch {
                // 宿主回调异常不得破坏列表行本身。
            }
        });
    }

    return root;
}

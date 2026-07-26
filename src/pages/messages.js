// 消息列表页（设计系统 2.0 · 策划书 §7.1，裁决 D6）：
// 时间倒序 + 本地已读水位/置顶 + 新牵手 rail + 页头展开式搜索。
// 未读/置顶是纯 UI 状态：只进浏览器本地存储，绝不进 MVU、提示词或导出。
import { append, element, listen } from '../dom.js';
import { createMessageReadStore } from '../chat/message-read-store.js';
import { createStatusChip, createUnreadBadge } from '../ui/badge.js';
import { createEmptyState } from '../ui/empty-state.js';
import { createUiIcon } from '../ui/icon.js';

const SESSION_MENU_LONG_PRESS_MS = 460;

export function createMessagesPage(ctx) {
    const messageReadStore = createMessageReadStore();
    // 搜索条展开态与会话菜单目标：本挂载实例内的界面状态，不进任何存储。
    let messageSearchOpen = false;
    let sessionMenuUid = '';
    let sessionLongPressTimer = null;
    let suppressSessionContextMenuUid = '';
    let suppressSessionContextMenuTimer = null;

    function clearSessionLongPress() {
        if (sessionLongPressTimer !== null) clearTimeout(sessionLongPressTimer);
        sessionLongPressTimer = null;
    }
    function clearSessionContextMenuSuppression() {
        if (suppressSessionContextMenuTimer !== null) clearTimeout(suppressSessionContextMenuTimer);
        suppressSessionContextMenuTimer = null;
        suppressSessionContextMenuUid = '';
    }
    /** 视图会话已由 ui-model 按最后消息时间倒序；这里只把本地置顶提到最前。 */
    function sortedMessageSessions() {
        const pinned = [];
        const rest = [];
        for (const session of ctx.messageSessions()) {
            (messageReadStore.isPinned(session.sessionUid) ? pinned : rest).push(session);
        }
        return [...pinned, ...rest];
    }
    /** 底部导航消息 tab 徽章的总未读数（壳层经 ctx 调用）。 */
    function messageUnreadTotal() {
        let total = 0;
        for (const session of ctx.messageSessions()) {
            total += messageReadStore.unreadCount(session.sessionUid, session.messages.length);
        }
        return total;
    }
    /** 列表行右上角时间：完整日期今天只显时分、跨天显“M月D日”，其他文本原样截断。 */
    function formatSessionTime(raw) {
        const text = String(raw ?? '').trim();
        if (!text) return '';
        const full = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2}))?/u.exec(text);
        if (full) {
            const nowDate = new Date();
            const sameDay = nowDate.getFullYear() === Number(full[1]) && nowDate.getMonth() + 1 === Number(full[2]) && nowDate.getDate() === Number(full[3]);
            if (sameDay && full[4]) return `${full[4].padStart(2, '0')}:${full[5]}`;
            return `${Number(full[2])}月${Number(full[3])}日`;
        }
        return text.slice(0, 12);
    }
    function openSessionMenu(sessionUid) {
        sessionMenuUid = sessionMenuUid === sessionUid ? '' : sessionUid;
        ctx.renderPage();
    }
    /** 长按（触屏）/ 右键（桌面）唤出置顶与已读菜单；两通道对同一次长按去重。 */
    function attachSessionMenuTriggers(button, session) {
        listen(button, button, 'contextmenu', (event) => {
            event.preventDefault?.();
            if (suppressSessionContextMenuUid === session.sessionUid) {
                clearSessionContextMenuSuppression();
                return;
            }
            openSessionMenu(session.sessionUid);
        }, ctx.abortController.signal);
        const begin = (event) => {
            if (event?.pointerType === 'mouse') return;
            clearSessionLongPress();
            sessionLongPressTimer = setTimeout(() => {
                sessionLongPressTimer = null;
                clearSessionContextMenuSuppression();
                suppressSessionContextMenuUid = session.sessionUid;
                suppressSessionContextMenuTimer = setTimeout(() => clearSessionContextMenuSuppression(), 900);
                openSessionMenu(session.sessionUid);
            }, SESSION_MENU_LONG_PRESS_MS);
        };
        const end = () => clearSessionLongPress();
        listen(button, button, 'pointerdown', begin, ctx.abortController.signal);
        listen(button, button, 'pointerup', end, ctx.abortController.signal);
        listen(button, button, 'pointercancel', end, ctx.abortController.signal);
        listen(button, button, 'pointerleave', end, ctx.abortController.signal);
    }
    function buildSessionMenuItem({ text, iconName, disabled = false, onSelect }) {
        const item = element('button', { className: 'yl-message-session-menu-item', type: 'button', disabled, ariaLabel: text });
        if (iconName) item.appendChild(createUiIcon(ctx.documentRef, iconName, { className: 'yl-message-menu-svg', size: 16 }));
        item.appendChild(element('span', { text }));
        listen(item, item, 'click', () => {
            sessionMenuUid = '';
            onSelect?.();
            ctx.renderPage();
        }, ctx.abortController.signal);
        return item;
    }
    function buildSessionMenu(session) {
        const nickname = ctx.chatNickname(session);
        const pinned = messageReadStore.isPinned(session.sessionUid);
        const unread = messageReadStore.unreadCount(session.sessionUid, session.messages.length);
        const menu = element('div', { className: 'yl-message-session-menu', ariaLabel: `${nickname}的会话操作` });
        append(menu, [
            buildSessionMenuItem({
                text: pinned ? '取消置顶' : '置顶会话', iconName: 'pin',
                onSelect: () => messageReadStore.setPinned(session.sessionUid, !pinned),
            }),
            buildSessionMenuItem({
                text: '标为已读', iconName: 'messages', disabled: unread < 1,
                onSelect: () => messageReadStore.markRead(session.sessionUid, session.messages.length),
            }),
            buildSessionMenuItem({ text: '关闭菜单', iconName: 'close' }),
        ]);
        return menu;
    }
    function buildMessageSessionButton(session) {
        const nickname = ctx.chatNickname(session);
        const lastMessage = session.messages.at(-1);
        const unread = messageReadStore.unreadCount(session.sessionUid, session.messages.length);
        const pinned = messageReadStore.isPinned(session.sessionUid);
        const button = element('button', { className: 'yl-chat-session yl-message-session', type: 'button', ariaLabel: `打开与${nickname}的私聊` });
        button.classList.toggle('is-unread', unread > 0);
        button.classList.toggle('is-pinned', pinned);
        const avatarWrap = element('span', { className: 'yl-session-avatar-wrap' });
        avatarWrap.appendChild(ctx.chatAvatar(session));
        const presence = element('span', { className: 'yl-session-presence' });
        presence.dataset.status = session.status;
        presence.setAttribute('aria-hidden', 'true');
        avatarWrap.appendChild(presence);
        const copy = element('span', { className: 'yl-session-copy' });
        const titleLine = element('span', { className: 'yl-session-title-line' });
        if (pinned) {
            const pinMark = element('span', { className: 'yl-session-pin' });
            pinMark.setAttribute('aria-hidden', 'true');
            pinMark.appendChild(createUiIcon(ctx.documentRef, 'pin', { className: 'yl-session-pin-svg', size: 13 }));
            titleLine.appendChild(pinMark);
        }
        titleLine.appendChild(element('span', { className: 'yl-session-name', text: nickname }));
        // §7.1.4：关系 chip 只在非“已匹配”的异常状态出现。
        if (session.status !== '已匹配') {
            titleLine.appendChild(createStatusChip({
                documentRef: ctx.documentRef,
                text: session.status,
                tone: session.status === '已拉黑' ? 'danger' : session.status === '请求中' ? 'warning' : 'neutral',
            }));
        }
        append(copy, [titleLine, element('span', { className: 'yl-session-preview', text: lastMessage ? lastMessage.content : '还没有消息，打个招呼吧。' })]);
        const meta = element('span', { className: 'yl-session-meta' });
        const timeText = formatSessionTime(lastMessage?.time);
        if (timeText) meta.appendChild(element('span', { className: 'yl-session-time', text: timeText }));
        const badge = createUnreadBadge(unread, { documentRef: ctx.documentRef });
        if (badge) meta.appendChild(badge);
        append(button, [avatarWrap, copy, meta]);
        listen(button, button, 'click', () => ctx.openPrivateChat(session.sessionUid), ctx.abortController.signal);
        attachSessionMenuTriggers(button, session);
        return button;
    }
    /** 新牵手 rail（§7.1.4）：已匹配但玩家还没说过话的会话，点击直达私聊。 */
    function buildNewMatchRail(sessions) {
        const fresh = sessions.filter((session) => session.status === '已匹配' && !session.messages.some((message) => message.sender === '玩家'));
        if (!fresh.length) return null;
        const rail = element('section', { className: 'yl-new-match-rail', ariaLabel: '新牵手对象' });
        rail.appendChild(element('span', { className: 'yl-new-match-rail-title', text: '新牵手' }));
        const strip = element('div', { className: 'yl-new-match-strip' });
        for (const session of fresh) {
            const nickname = ctx.chatNickname(session);
            const item = element('button', { className: 'yl-new-match-item', type: 'button', ariaLabel: `和${nickname}开始聊天` });
            const ring = element('span', { className: 'yl-new-match-ring' });
            ring.appendChild(ctx.chatAvatar(session));
            append(item, [ring, element('span', { className: 'yl-new-match-name', text: nickname })]);
            listen(item, item, 'click', () => ctx.openPrivateChat(session.sessionUid), ctx.abortController.signal);
            strip.appendChild(item);
        }
        rail.appendChild(strip);
        return rail;
    }
    function messageSessionsMatchingQuery(sessions, query) {
        const normalizedQuery = String(query ?? '').trim().toLocaleLowerCase();
        if (!normalizedQuery) return sessions;
        return sessions.filter((session) => {
            const nickname = ctx.chatNickname(session).toLocaleLowerCase();
            const latestVisibleMessage = String(session.messages.at(-1)?.content ?? '').toLocaleLowerCase();
            return nickname.includes(normalizedQuery) || latestVisibleMessage.includes(normalizedQuery);
        });
    }
    function buildMessagesPage() {
        const sessions = sortedMessageSessions();
        const section = element('section', { className: 'yl-chat-page yl-message-list-page yl-message-list-workbench' });
        if (!sessions.length) {
            section.appendChild(createEmptyState({
                documentRef: ctx.documentRef,
                variant: 'inbox',
                title: '还没有私聊',
                hint: '去匹配页遇见一位公开可见的成年人，牵手成功后就能在这里继续聊。',
                action: { label: '去匹配', variant: 'tonal', onClick: () => ctx.setActivePage('matches') },
            }));
            return section;
        }
        // 页头工具行：结果计数（aria 状态行）+ 搜索 icon（点开展开搜索条，§7.1.4）。
        const toolbar = element('div', { className: 'yl-message-toolbar' });
        const resultSummary = element('p', { className: 'yl-message-search-status', text: '' });
        resultSummary.setAttribute('role', 'status');
        resultSummary.setAttribute('aria-live', 'polite');
        toolbar.appendChild(resultSummary);
        const searchToggle = element('button', { className: 'yl-message-search-toggle', type: 'button', ariaLabel: messageSearchOpen ? '收起搜索' : '搜索私聊会话' });
        searchToggle.setAttribute('aria-expanded', String(messageSearchOpen));
        searchToggle.appendChild(createUiIcon(ctx.documentRef, 'search', { className: 'yl-message-search-svg', size: 18 }));
        listen(searchToggle, searchToggle, 'click', () => {
            messageSearchOpen = !messageSearchOpen;
            if (!messageSearchOpen) ctx.messageSearchQuery = '';
            ctx.renderPage();
            if (messageSearchOpen) ctx.content.querySelector('.yl-message-search-input')?.focus?.();
        }, ctx.abortController.signal);
        toolbar.appendChild(searchToggle);
        section.appendChild(toolbar);
        const rail = buildNewMatchRail(sessions);
        if (rail) section.appendChild(rail);
        const sessionList = element('div', { className: 'yl-chat-session-list' });
        // P3-G：首屏交错入场只在本次构建的第一次渲染出现；搜索键入的局部重渲不重复播放。
        let firstSessionResultsRender = true;
        const renderMessageSessionResults = () => {
            sessionList.classList.toggle('yl-stagger-in', firstSessionResultsRender);
            firstSessionResultsRender = false;
            const visibleSessions = messageSessionsMatchingQuery(sortedMessageSessions(), ctx.messageSearchQuery);
            const hasQuery = Boolean(String(ctx.messageSearchQuery ?? '').trim());
            resultSummary.textContent = hasQuery ? `找到 ${visibleSessions.length} 个私聊` : `共 ${sessions.length} 个私聊`;
            const items = [];
            for (const session of visibleSessions) {
                items.push(buildMessageSessionButton(session));
                if (sessionMenuUid === session.sessionUid) items.push(buildSessionMenu(session));
            }
            if (!items.length) {
                items.push(createEmptyState({
                    documentRef: ctx.documentRef,
                    variant: 'search',
                    title: '没有找到符合条件的私聊',
                    hint: '换个昵称或最近消息里的词试试。',
                }));
            }
            sessionList.replaceChildren(...items);
        };
        renderMessageSessionResults();
        if (messageSearchOpen) {
            const search = element('label', { className: 'yl-message-search' });
            const searchInput = element('input', { className: 'yl-message-search-input yl-settings-control', type: 'search', value: ctx.messageSearchQuery, placeholder: '搜索昵称或最近消息', ariaLabel: '搜索私聊' });
            search.appendChild(searchInput);
            listen(searchInput, searchInput, 'input', () => {
                ctx.messageSearchQuery = String(searchInput.value ?? '');
                // Keep the input node, focus and IME composition alive; only the result region changes.
                renderMessageSessionResults();
            }, ctx.abortController.signal);
            section.appendChild(search);
        }
        section.appendChild(sessionList);
        return section;
    }
    return {
        messageReadStore,
        messageUnreadTotal,
        buildMessageSessionButton,
        messageSessionsMatchingQuery,
        buildMessagesPage,
    };
}

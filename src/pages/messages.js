// 消息列表页：从 src/app-shell.js 纯搬移而来，函数体逐行未改，仅将跨模块引用改为 ctx.*。
import { append, element, listen } from '../dom.js';

export function createMessagesPage(ctx) {
    function buildMessageSessionButton(session) {
        const nickname = ctx.chatNickname(session);
        const lastMessage = session.messages.at(-1);
        const button = element('button', { className: 'yl-chat-session yl-message-session', type: 'button', ariaLabel: `打开与${nickname}的私聊` });
        const avatarWrap = element('span', { className: 'yl-session-avatar-wrap' });
        avatarWrap.appendChild(ctx.chatAvatar(session));
        const presence = element('span', { className: 'yl-session-presence' });
        presence.dataset.status = session.status;
        presence.setAttribute('aria-hidden', 'true');
        avatarWrap.appendChild(presence);
        const copy = element('span', { className: 'yl-session-copy' });
        const titleLine = element('span', { className: 'yl-session-title-line' });
        titleLine.appendChild(element('span', { className: 'yl-session-name', text: nickname }));
        titleLine.appendChild(element('span', { className: 'yl-session-status', text: session.status }));
        append(copy, [titleLine, element('span', { className: 'yl-session-preview', text: lastMessage ? lastMessage.content : '还没有消息，打个招呼吧。' })]);
        const meta = element('span', { className: 'yl-session-meta' });
        if (lastMessage?.time) meta.appendChild(element('span', { className: 'yl-session-time', text: lastMessage.time }));
        meta.appendChild(ctx.openMark());
        append(button, [avatarWrap, copy, meta]);
        listen(button, button, 'click', () => ctx.openPrivateChat(session.sessionUid), ctx.abortController.signal);
        return button;
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
        const sessions = ctx.messageSessions();
        if (!sessions.length) return ctx.buildEmptyPlaceholder('暂无已建立的私聊会话。去匹配页遇见一位公开可见的成年人吧。', { icon: '✉' });
        const section = element('section', { className: 'yl-chat-page yl-message-list-page yl-message-list-workbench' });
        const intro = element('section', { className: 'yl-message-list-intro' });
        const introCopy = element('div', { className: 'yl-message-list-copy' });
        append(introCopy, [
            element('span', { className: 'yl-message-list-eyebrow', text: '心动消息' }),
            element('h2', { text: '和已匹配的人继续聊聊' }),
            element('p', { text: '每个会话只显示已保存的短消息。' }),
        ]);
        intro.appendChild(introCopy);
        intro.appendChild(element('span', { className: 'yl-message-list-count', text: String(sessions.length) }));
        section.appendChild(intro);
        const search = element('label', { className: 'yl-message-search' });
        const searchInput = element('input', { className: 'yl-message-search-input yl-settings-control', type: 'search', value: ctx.messageSearchQuery, placeholder: '搜索昵称或最近消息', ariaLabel: '搜索私聊' });
        search.appendChild(searchInput);
        section.appendChild(search);
        const resultSummary = element('p', { className: 'yl-message-search-status', text: '' });
        resultSummary.setAttribute('role', 'status');
        resultSummary.setAttribute('aria-live', 'polite');
        const sessionList = element('div', { className: 'yl-chat-session-list' });
        const renderMessageSessionResults = () => {
            const visibleSessions = messageSessionsMatchingQuery(sessions, ctx.messageSearchQuery);
            const hasQuery = Boolean(String(ctx.messageSearchQuery ?? '').trim());
            resultSummary.textContent = hasQuery ? `找到 ${visibleSessions.length} 个私聊` : `共 ${sessions.length} 个私聊`;
            const items = visibleSessions.length
                ? visibleSessions.map((session) => buildMessageSessionButton(session))
                : [ctx.buildEmptyPlaceholder('没有找到符合条件的私聊。', { icon: '⌕' })];
            sessionList.replaceChildren(...items);
        };
        renderMessageSessionResults();
        listen(searchInput, searchInput, 'input', () => {
            ctx.messageSearchQuery = String(searchInput.value ?? '');
            // Keep the input node, focus and IME composition alive; only the result region changes.
            renderMessageSessionResults();
        }, ctx.abortController.signal);
        append(section, [resultSummary, sessionList]);
        return section;
    }
    return {
        buildMessageSessionButton,
        messageSessionsMatchingQuery,
        buildMessagesPage,
    };
}

// 私聊会话页（含面基面板、聊天总结、聊天工具栏）：从 src/app-shell.js 纯搬移而来，函数体逐行未改，仅将跨模块引用改为 ctx.*。
import { append, element, listen } from '../dom.js';
import { describeActionFailure } from '../ui-model.js';
import { createUiIcon } from '../ui/icon.js';

const CHAT_TOOL_LONG_PRESS_MS = 460;

export function createChatPage(ctx) {
    function cancelChatToolLongPress() {
        if (ctx.chatToolLongPressTimer !== null) clearTimeout(ctx.chatToolLongPressTimer);
        ctx.chatToolLongPressTimer = null;
        ctx.chatToolLongPressSessionUid = '';
        ctx.chatToolLongPressInputType = '';
    }
    function clearChatToolClickSuppression() {
        if (ctx.chatToolClickSuppressionTimer !== null) clearTimeout(ctx.chatToolClickSuppressionTimer);
        ctx.chatToolClickSuppressionTimer = null;
        ctx.suppressChatToolClickForSessionUid = '';
    }
    function buildPrivateChatPage() {
        const session = ctx.messageSessionByUid(ctx.activeMessageSessionUid);
        if (!session) return ctx.buildEmptyPlaceholder('这个私聊会话暂时不可见。请返回消息列表后重试。', { icon: '✉' });
        const conversation = buildConversationPanel(session);
        if (ctx.uiLayoutMode !== 'desktop') return conversation;
        // desktop 工作台第二层：同一份公开会话投影获得右侧上下文栏；不建第二数据源。
        const workbench = element('section', { className: 'yl-private-chat-workbench' });
        append(workbench, [conversation, buildChatContextPanel(session)]);
        return workbench;
    }
    /** desktop 私聊上下文栏：只渲染对方公开投影与会话状态，绝不触碰隐藏/仅好友层、关系数据或内部 UID。 */
    function buildChatContextPanel(session) {
        const aside = element('aside', { className: 'yl-chat-context-panel', ariaLabel: `${ctx.chatNickname(session)}的公开资料` });
        const head = element('div', { className: 'yl-chat-context-head' });
        head.appendChild(ctx.chatAvatar(session, 'yl-chat-context-avatar'));
        const headCopy = element('div', { className: 'yl-chat-context-head-copy' });
        headCopy.appendChild(element('strong', { text: ctx.chatNickname(session) }));
        headCopy.appendChild(element('span', { className: 'yl-chat-context-status', text: session.status }));
        head.appendChild(headCopy);
        aside.appendChild(head);
        const profile = session.profile ?? {};
        const facts = element('div', { className: 'yl-chat-context-facts' });
        for (const [label, value] of [['年龄段', profile.年龄段], ['城市', profile.城市], ['性别', profile.性别], ['性取向', profile.性取向], ['距离范围', profile.距离范围], ['寻找意图', profile.寻找意图]]) {
            if (!value) continue;
            const fact = element('div', { className: 'yl-chat-context-fact' });
            append(fact, [element('span', { className: 'yl-chat-context-fact-label', text: label }), element('span', { className: 'yl-chat-context-fact-value', text: value })]);
            facts.appendChild(fact);
        }
        if (facts.childNodes.length) aside.appendChild(facts);
        if (profile.简介) {
            const bio = element('div', { className: 'yl-chat-context-bio' });
            append(bio, [element('span', { className: 'yl-chat-context-fact-label', text: '简介' }), element('p', { text: profile.简介 })]);
            aside.appendChild(bio);
        }
        const tags = [];
        for (const field of ['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']) {
            for (const tag of profile[field] ?? []) {
                if (!tags.includes(tag)) tags.push(tag);
                if (tags.length >= 10) break;
            }
            if (tags.length >= 10) break;
        }
        if (tags.length) {
            const tagRow = element('div', { className: 'yl-chat-context-tags', ariaLabel: '对方公开标签' });
            for (const tag of tags) tagRow.appendChild(element('span', { className: 'yl-chat-context-tag', text: tag }));
            aside.appendChild(tagRow);
        }
        aside.appendChild(element('p', { className: 'yl-chat-context-note', text: '这里只显示对方的公开资料。' }));
        return aside;
    }
    function closeChatMoreMenu() {
        if (!ctx.chatMoreMenuSessionUid) return false;
        ctx.chatMoreMenuSessionUid = '';
        ctx.renderPage();
        return true;
    }
    function buildConversationHeader(session) {
        const header = element('section', { className: 'yl-private-chat-contact' });
        header.appendChild(ctx.chatAvatar(session, 'yl-chat-contact-avatar', { interactive: true }));
        const copy = element('div', { className: 'yl-private-chat-contact-copy' });
        copy.appendChild(element('h2', { text: ctx.chatNickname(session) }));
        const subline = element('span', { className: 'yl-private-chat-subline' });
        const dot = element('span', { className: 'yl-private-chat-status-dot' });
        dot.dataset.status = session.status;
        dot.setAttribute('aria-hidden', 'true');
        append(subline, [dot, element('span', { text: session.status === '已匹配' ? '已匹配 · 文字私聊' : session.status })]);
        copy.appendChild(subline);
        header.appendChild(copy);
        const actions = element('div', { className: 'yl-private-chat-actions' });
        const moreOpen = ctx.chatMoreMenuSessionUid === session.sessionUid;
        const more = element('button', {
            className: 'yl-private-chat-more', type: 'button', text: '…',
            ariaLabel: '打开与' + ctx.chatNickname(session) + '的更多操作',
            disabled: ctx.destructiveChatSessionUid === session.sessionUid,
        });
        // Disclosure 按钮列表：不宣称 role=menu（无完整菜单键盘模型），aria-expanded 表达展开状态。
        more.setAttribute('aria-expanded', String(moreOpen));
        listen(more, more, 'click', (event) => {
            event.stopPropagation?.();
            ctx.chatMoreMenuSessionUid = moreOpen ? '' : session.sessionUid;
            ctx.renderPage();
        }, ctx.abortController.signal);
        actions.appendChild(ctx.buildConversationImageControls({ kind: 'private', conversationId: session.sessionUid }));
        actions.appendChild(more);
        if (moreOpen) {
            const menu = element('div', { className: 'yl-private-chat-more-menu', ariaLabel: '私聊更多操作' });
            const summary = element('button', { className: 'yl-private-chat-menu-item', type: 'button', text: '聊天总结', ariaLabel: '查看聊天总结', disabled: !ctx.chatSummaryEnabled() });
            const clear = element('button', { className: 'yl-private-chat-menu-item', type: 'button', text: '清空聊天记录', ariaLabel: '清空聊天记录' });
            const removeCharacter = element('button', { className: 'yl-private-chat-menu-item is-danger', type: 'button', text: '删除角色', ariaLabel: '删除角色完整数据' });
            listen(summary, summary, 'click', () => {
                ctx.chatMoreMenuSessionUid = '';
                ctx.setActivePage('private_chat_summary');
            }, ctx.abortController.signal);
            listen(clear, clear, 'click', () => {
                ctx.chatMoreMenuSessionUid = '';
                ctx.chatConfirmationSessionUid = session.sessionUid;
                ctx.chatConfirmationKind = 'clear';
                ctx.renderPage();
            }, ctx.abortController.signal);
            listen(removeCharacter, removeCharacter, 'click', () => {
                ctx.chatMoreMenuSessionUid = '';
                ctx.chatConfirmationSessionUid = session.sessionUid;
                ctx.chatConfirmationKind = 'delete_character';
                ctx.renderPage();
            }, ctx.abortController.signal);
            append(menu, [summary, clear, removeCharacter]);
            actions.appendChild(menu);
        }
        actions.appendChild(element('span', { className: 'yl-private-chat-spark', text: '♥' }));
        header.appendChild(actions);
        return header;
    }
    function buildPrivateChatConfirmation(session) {
        const deletingCharacter = ctx.chatConfirmationKind === 'delete_character';
        const pending = ctx.destructiveChatSessionUid === session.sessionUid;
        const confirmation = element('section', { className: deletingCharacter ? 'yl-chat-delete-confirmation is-character-delete' : 'yl-chat-delete-confirmation is-chat-clear' });
        if (deletingCharacter) {
            append(confirmation, [
                element('strong', { text: '删除' + ctx.chatNickname(session) + '的完整角色数据？' }),
                element('p', { text: '这会一次性删除角色资料、相关私聊、面基记录、推荐列表与群组引用，且无法在此界面恢复。' }),
            ]);
        } else {
            append(confirmation, [
                element('strong', { text: '清空这段聊天记录？' }),
                element('p', { text: '清空后会话会从消息列表移除；若当前为已匹配，关系状态会恢复为已取消。' }),
            ]);
        }
        const actions = element('div', { className: 'yl-chat-delete-actions' });
        const cancel = element('button', { className: 'yl-settings-button', type: 'button', text: '取消', disabled: pending });
        const label = deletingCharacter ? '确认删除角色完整数据' : '确认清空聊天记录';
        const confirm = element('button', {
            className: 'yl-settings-button yl-chat-delete-confirm', type: 'button',
            text: pending ? '正在处理…' : (deletingCharacter ? '确认删除角色' : '确认清空'),
            ariaLabel: label, disabled: pending,
        });
        listen(cancel, cancel, 'click', () => {
            ctx.chatConfirmationSessionUid = '';
            ctx.chatConfirmationKind = '';
            ctx.renderPage();
        }, ctx.abortController.signal);
        listen(confirm, confirm, 'click', () => { void runPrivateChatDestructiveAction(session, ctx.chatConfirmationKind); }, ctx.abortController.signal);
        append(actions, [cancel, confirm]);
        confirmation.appendChild(actions);
        return confirmation;
    }
    async function runPrivateChatDestructiveAction(session, kind) {
        if (ctx.destructiveChatSessionUid) return;
        const deletingCharacter = kind === 'delete_character';
        const action = deletingCharacter ? ctx.actionBridge.deleteCharacter : ctx.actionBridge.clearPrivateChat;
        if (typeof action !== 'function') {
            ctx.setFeedback(deletingCharacter ? '删除角色功能尚未就绪。' : '清空聊天记录功能尚未就绪。');
            return;
        }
        ctx.destructiveChatSessionUid = session.sessionUid;
        ctx.destructiveChatKind = kind;
        const relatedSessionUids = ctx.messageSessions().filter((item) => item.npcUid === session.npcUid).map((item) => item.sessionUid);
        ctx.renderPage();
        let result;
        try { result = await action(deletingCharacter ? session.npcUid : session.sessionUid); }
        catch { result = { ok: false }; }
        if (!result?.ok) {
            ctx.destructiveChatSessionUid = '';
            ctx.destructiveChatKind = '';
            ctx.setFeedback(result?.message || describeActionFailure(result) || (deletingCharacter ? '角色删除失败，请稍后重试。' : '聊天记录清空失败，请稍后重试。'));
            ctx.renderPage();
            return;
        }
        const sessionsToClear = deletingCharacter ? relatedSessionUids : [session.sessionUid];
        for (const sessionUid of sessionsToClear) {
            ctx.chatDrafts.delete(sessionUid);
            ctx.meetupDrafts.delete(sessionUid);
        }
        if (deletingCharacter) {
            ctx.selectedCandidateUid = ctx.selectedCandidateUid === session.npcUid ? '' : ctx.selectedCandidateUid;
            ctx.clearMatchedImageState();
        }
        ctx.activeMessageSessionUid = '';
        ctx.activeChatToolsSessionUid = '';
        ctx.activeMeetupSessionUid = '';
        ctx.chatMoreMenuSessionUid = '';
        ctx.chatConfirmationSessionUid = '';
        ctx.chatConfirmationKind = '';
        ctx.destructiveChatSessionUid = '';
        ctx.destructiveChatKind = '';
        ctx.refreshState();
        ctx.setActivePage('messages');
        ctx.setFeedback(deletingCharacter ? '角色完整数据及其关联记录已删除。' : '聊天记录已清空，会话已从消息列表移除。');
    }
    function buildMessageBubble(session, message) {
        if (message.sender === '系统') {
            const note = element('p', { className: 'yl-chat-system-note', text: message.content });
            if (message.time) note.appendChild(element('span', { text: message.time }));
            return note;
        }
        const isPlayer = message.sender === '玩家';
        const row = element('article', { className: isPlayer ? 'yl-chat-bubble is-player' : 'yl-chat-bubble is-contact' });
        if (!isPlayer) row.appendChild(ctx.chatAvatar(session, 'yl-chat-message-avatar'));
        const bubbleContent = element('div', { className: 'yl-bubble-content' });
        const label = isPlayer ? '我' : ctx.chatNickname(session);
        bubbleContent.appendChild(element('strong', { text: label }));
        bubbleContent.appendChild(element('p', { text: message.content }));
        if (!isPlayer) {
            const directive = ctx.privateImageDirectives.get(message.messageUid);
            const imageCard = directive ? ctx.buildImageDirectiveCard({
                kind: 'private', conversationId: session.sessionUid, messageId: message.messageUid, characterUid: session.npcUid, directive,
            }) : null;
            if (imageCard) bubbleContent.appendChild(imageCard);
        }
        if (message.time) bubbleContent.appendChild(element('span', { className: 'yl-bubble-time', text: message.time }));
        row.appendChild(bubbleContent);
        if (isPlayer) {
            row.appendChild(ctx.publicAvatar({ 昵称: '我' }, {
                className: 'yl-chat-message-avatar yl-chat-self-avatar',
                imageEnabled: false,
                interactive: false,
                fallback: '我',
                imageSource: ctx.playerAvatarStore?.snapshot?.() ?? '',
            }));
        }
        return row;
    }
    function isPrivateChatVisible(sessionUid) {
        return ctx.open && ctx.activePage === 'private_chat' && ctx.activeMessageSessionUid === sessionUid;
    }
    function clearSummaryToast() {
        if (ctx.summaryToastTimer !== null) clearTimeout(ctx.summaryToastTimer);
        ctx.summaryToastTimer = null;
        ctx.summaryToast = null;
    }
    function showSummaryToast(sessionUid, { success, message, summaryUid = '' } = {}) {
        clearSummaryToast();
        ctx.summaryToast = {
            sessionUid,
            success: Boolean(success),
            message: String(message ?? '').slice(0, 240),
            summaryUid: String(summaryUid ?? '').slice(0, 80),
        };
        ctx.summaryToastTimer = setTimeout(() => {
            const activeToast = ctx.summaryToast;
            ctx.summaryToast = null;
            ctx.summaryToastTimer = null;
            if (activeToast && isPrivateChatVisible(activeToast.sessionUid)) ctx.renderPage();
        }, 5_500);
        if (isPrivateChatVisible(sessionUid)) ctx.renderPage();
    }
    function buildSummaryToast(session) {
        if (!ctx.summaryToast || ctx.summaryToast.sessionUid !== session.sessionUid) return null;
        const toast = element('section', { className: ctx.summaryToast.success ? 'yl-chat-summary-toast is-success' : 'yl-chat-summary-toast is-failure' });
        toast.setAttribute('role', 'status');
        const copy = element('div', { className: 'yl-chat-summary-toast-copy' });
        append(copy, [
            element('strong', { text: ctx.summaryToast.success ? '聊天总结已完成' : '聊天总结未完成' }),
            element('span', { text: ctx.summaryToast.message || (ctx.summaryToast.success ? '已写入会话总结记录。' : '请稍后重新总结。') }),
        ]);
        toast.appendChild(copy);
        if (!ctx.summaryToast.success) {
            const retry = element('button', { className: 'yl-settings-button yl-chat-summary-toast-retry', type: 'button', text: '重新总结', ariaLabel: '重新总结当前聊天' });
            const targetSummaryUid = ctx.summaryToast.summaryUid;
            listen(retry, retry, 'click', () => { clearSummaryToast(); void runChatSummaryForSession(session, { summaryUid: targetSummaryUid }); }, ctx.abortController.signal);
            toast.appendChild(retry);
        }
        return toast;
    }
    function summaryStatusText(info) {
        if (info.status === '失败') return `上次总结未完成：${info.failureReason}`;
        if (info.status === '成功') return info.records.length ? `已保存 ${info.records.length} 条总结记录。` : '最近一次总结已完成。';
        return info.pendingMessageCount ? `有 ${info.pendingMessageCount} 条消息待整理。` : '暂时没有需要整理的新消息。';
    }
    async function runChatSummaryForSession(session, { summaryUid = '', automatic = false } = {}) {
        if (typeof ctx.actionBridge.runPrivateChatSummary !== 'function') {
            if (!automatic) ctx.setFeedback('聊天总结功能尚未就绪。');
            return;
        }
        if (ctx.actionBridge.isPending?.('chat_summary', session.sessionUid)) return;
        let request;
        try {
            request = ctx.actionBridge.runPrivateChatSummary({ sessionUid: session.sessionUid, npcUid: session.npcUid, summaryUid, automatic });
        } catch {
            request = Promise.resolve({ ok: false, code: 'chat_summary_failed', message: '聊天总结未完成，请稍后重试。' });
        }
        if (!automatic) ctx.renderPage();
        let result;
        try { result = await request; } catch { result = { ok: false, code: 'chat_summary_failed', message: '聊天总结未完成，请稍后重试。' }; }
        ctx.refreshState();
        if (automatic) {
            if (result?.silent || result?.code === 'ui_action_pending') return;
            if (isPrivateChatVisible(session.sessionUid)) {
                showSummaryToast(session.sessionUid, {
                    success: Boolean(result?.ok),
                    summaryUid: result?.ok ? '' : (summaryUid || ctx.currentView.messageSessions.find((item) => item.sessionUid === session.sessionUid)?.summaryInfo?.targetSummaryUid || ''),
                    message: result?.ok ? '已自动整理本次私聊，并同步到会话摘要。' : (result?.message || '总结未完成，可在右上角“…”的聊天总结中重试。'),
                });
            }
            if (result?.ok && Number(result.remainingLayerCount) >= ctx.chatSummarySettings().interval && ctx.chatSummaryEnabled()) {
                void runChatSummaryForSession(session, { automatic: true });
            }
            return;
        }
        ctx.setFeedback(result?.ok ? '聊天总结已保存。' : (result?.message || '聊天总结未完成，请稍后重试。'));
    }
    function buildConversationSummaryDetail(session, { actionsEnabled = true, historyMode = false } = {}) {
        const info = session.summaryInfo;
        const section = element('section', { className: 'yl-chat-summary-detail' });
        const overview = element('section', { className: 'yl-chat-summary-overview' });
        append(overview, [
            element('strong', { text: `${ctx.chatNickname(session)} · 已对话 ${info.totalLayers} 层` }),
            element('p', { text: summaryStatusText(info) }),
        ]);
        const summaryPending = Boolean(ctx.actionBridge.isPending?.('chat_summary', session.sessionUid));
        if (actionsEnabled && info.pendingMessageCount > 0) {
            const summarize = element('button', { className: 'yl-settings-button', type: 'button', text: summaryPending ? '正在总结…' : '立即总结未整理消息', disabled: summaryPending });
            listen(summarize, summarize, 'click', () => { void runChatSummaryForSession(session); }, ctx.abortController.signal);
            overview.appendChild(summarize);
        }
        if (actionsEnabled && info.status === '失败') {
            const retry = element('button', { className: 'yl-settings-button yl-settings-button-secondary', type: 'button', text: summaryPending ? '正在重新总结…' : '重新总结', disabled: summaryPending });
            listen(retry, retry, 'click', () => { void runChatSummaryForSession(session, { summaryUid: info.targetSummaryUid }); }, ctx.abortController.signal);
            overview.appendChild(retry);
        }
        section.appendChild(overview);
        if (!info.records.length) {
            section.appendChild(ctx.buildEmptyPlaceholder(historyMode ? '这个角色还没有已完成的总结记录。' : '还没有已完成的总结记录；达到设定层数后会静默自动整理。', { icon: '⌁' }));
            return section;
        }
        const list = element('div', { className: 'yl-chat-summary-record-list' });
        for (const record of [...info.records].reverse()) {
            const card = element('article', { className: 'yl-chat-summary-record' });
            const heading = element('div', { className: 'yl-chat-summary-record-heading' });
            append(heading, [
                element('strong', { text: `第 ${record.startLayer}–${record.endLayer} 层总结` }),
                record.time ? element('span', { text: record.time }) : element('span', { text: '已保存' }),
            ]);
            card.appendChild(heading);
            card.appendChild(element('p', { text: record.content }));
            if (actionsEnabled) {
                const retry = element('button', { className: 'yl-settings-button yl-settings-button-secondary yl-chat-summary-record-retry', type: 'button', text: summaryPending ? '正在处理…' : '重新总结这一段', disabled: summaryPending });
                listen(retry, retry, 'click', () => { void runChatSummaryForSession(session, { summaryUid: record.summaryUid }); }, ctx.abortController.signal);
                card.appendChild(retry);
            }
            list.appendChild(card);
        }
        section.appendChild(list);
        return section;
    }
    function buildPrivateChatSummaryPage() {
        const session = ctx.messageSessionByUid(ctx.activeMessageSessionUid);
        if (!session) return ctx.buildEmptyPlaceholder('这个私聊会话暂时不可见。请返回消息列表后重试。', { icon: '✉' });
        return buildConversationSummaryDetail(session, { actionsEnabled: ctx.chatSummaryEnabled() });
    }
    function buildConversationPanel(session) {
        const panel = element('section', { className: 'yl-private-chat-screen' });
        panel.appendChild(buildConversationHeader(session));
        if (ctx.chatConfirmationSessionUid === session.sessionUid) panel.appendChild(buildPrivateChatConfirmation(session));
        const summaryToastElement = buildSummaryToast(session);
        if (summaryToastElement) panel.appendChild(summaryToastElement);
        const privacyNote = element('p', { className: 'yl-chat-privacy-note', text: '线上短消息会通过当前“私聊”功能绑定处理；重要面基安排请单独确认。' });
        panel.appendChild(privacyNote);
        const transcript = element('div', { className: 'yl-chat-transcript', ariaLabel: `${ctx.chatNickname(session)}的私聊记录` });
        // Do not make a full transcript a live region: only concise reply state is announced.
        transcript.setAttribute('aria-live', 'off');
        if (!session.messages.length) transcript.appendChild(ctx.buildEmptyPlaceholder('还没有消息。用一句简单的问候开始吧。', { tag: 'p', icon: '✦' }));
        else {
            transcript.appendChild(element('p', { className: 'yl-chat-transcript-label', text: '最近消息' }));
            for (const message of session.messages) transcript.appendChild(buildMessageBubble(session, message));
        }
        const pending = Boolean(ctx.actionBridge.isPending?.('private_chat', session.sessionUid));
        if (pending) {
            const replying = element('div', { className: 'yl-chat-replying', text: `${ctx.chatNickname(session)}正在生成回复` });
            replying.setAttribute('role', 'status');
            const dots = element('span', { className: 'yl-chat-replying-dots', text: '···' });
            dots.setAttribute('aria-hidden', 'true');
            replying.appendChild(dots);
            transcript.appendChild(replying);
        }
        panel.appendChild(transcript);
        if (!session.canSend) {
            const composer = element('div', { className: 'yl-chat-composer is-readonly' });
            const input = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 2, placeholder: session.status === '已拉黑' ? '对方已将你拉黑，无法继续发送消息。' : '该会话当前为只读状态。', ariaLabel: '私聊消息输入已禁用', disabled: true });
            const send = element('button', { className: 'yl-chat-send-button', type: 'button', text: '不可发送', ariaLabel: '发送消息已禁用', disabled: true });
            append(composer, [input, send]); panel.appendChild(composer);
            return panel;
        }
        if (typeof ctx.actionBridge.runPrivateChat !== 'function') {
            panel.appendChild(element('div', { className: 'yl-phone-placeholder', text: '私聊发送尚未就绪。' }));
            return panel;
        }
        const composer = element('div', { className: pending ? 'yl-chat-composer is-pending' : 'yl-chat-composer' });
        const input = element('textarea', {
            className: 'yl-settings-control yl-settings-textarea', rows: 2, maxLength: 600,
            placeholder: '输入消息…', value: ctx.chatDrafts.get(session.sessionUid) ?? '', disabled: pending,
            ariaLabel: '输入私聊消息',
        });
        const send = element('button', {
            className: 'yl-chat-send-button', type: 'button', disabled: pending,
            ariaLabel: pending ? '正在生成私聊回复' : '发送消息',
        });
        const sendGlyph = pending
            ? element('span', { className: 'yl-chat-send-pending', text: '···' })
            : createUiIcon(ctx.documentRef, 'send', { className: 'yl-chat-send-icon', size: 21, strokeWidth: 2 });
        sendGlyph.setAttribute('aria-hidden', 'true');
        send.appendChild(sendGlyph);
        const meetupSupported = typeof ctx.actionBridge.runPrivateChatMeetupHandoff === 'function' || typeof ctx.actionBridge.runMeetupHandoff === 'function';
        const meetupUnlocked = meetupSupported && session.meetupAccess?.unlocked === true;
        const meetupAvailable = meetupSupported;
        const toolsOpen = meetupAvailable && ctx.activeChatToolsSessionUid === session.sessionUid;
        // Disclosure：右键 / 长按展开工具列表，不宣称 role=menu。
        send.setAttribute('aria-expanded', String(toolsOpen));
        send.setAttribute('title', meetupSupported ? '左键发送，右键打开工具栏' : '发送消息');
        const updateSendState = () => {
            const empty = !String(input.value ?? '').trim();
            send.disabled = pending || empty;
            send.classList.toggle('is-empty', empty && !pending);
            send.setAttribute('aria-disabled', String(pending || empty));
        };
        updateSendState();
        listen(input, input, 'input', () => { ctx.chatDrafts.set(session.sessionUid, input.value); updateSendState(); }, ctx.abortController.signal);
        listen(input, input, 'keydown', (event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing || pending) return;
            event.preventDefault?.();
            ctx.activeChatToolsSessionUid = '';
            void runPrivateChat(session);
        }, ctx.abortController.signal);
        listen(send, send, 'click', () => {
            if (ctx.suppressChatToolClickForSessionUid === session.sessionUid) {
                clearChatToolClickSuppression();
                return;
            }
            ctx.activeChatToolsSessionUid = '';
            void runPrivateChat(session);
        }, ctx.abortController.signal);
        if (meetupSupported) {
            const openToolsFromLongPress = () => {
                if (pending || ctx.activePage !== 'private_chat' || ctx.activeMessageSessionUid !== session.sessionUid) return;
                ctx.chatToolLongPressTimer = null;
                ctx.chatToolLongPressSessionUid = '';
                clearChatToolClickSuppression();
                ctx.suppressChatToolClickForSessionUid = session.sessionUid;
                ctx.chatToolClickSuppressionTimer = setTimeout(() => {
                    if (ctx.suppressChatToolClickForSessionUid === session.sessionUid) clearChatToolClickSuppression();
                }, 900);
                ctx.activeChatToolsSessionUid = session.sessionUid;
                ctx.renderPage();
            };
            const beginLongPress = (event, inputType) => {
                if (pending || event?.pointerType === 'mouse') return;
                // Current browsers dispatch Pointer Events and compatibility Touch Events
                // for one finger. Keep the original timer instead of restarting it.
                if (ctx.chatToolLongPressSessionUid === session.sessionUid) {
                    if (ctx.chatToolLongPressInputType === 'pointer' && inputType === 'touch') return;
                    cancelChatToolLongPress();
                }
                ctx.chatToolLongPressSessionUid = session.sessionUid;
                ctx.chatToolLongPressInputType = inputType;
                ctx.chatToolLongPressTimer = setTimeout(openToolsFromLongPress, CHAT_TOOL_LONG_PRESS_MS);
            };
            const endLongPress = (inputType) => {
                if (ctx.chatToolLongPressSessionUid === session.sessionUid && ctx.chatToolLongPressInputType === inputType) cancelChatToolLongPress();
            };
            // Pointer Events cover current mobile browsers; touch events retain support for older WebViews.
            listen(send, send, 'pointerdown', (event) => beginLongPress(event, 'pointer'), ctx.abortController.signal);
            listen(send, send, 'pointerup', () => endLongPress('pointer'), ctx.abortController.signal);
            listen(send, send, 'pointercancel', () => endLongPress('pointer'), ctx.abortController.signal);
            listen(send, send, 'touchstart', (event) => beginLongPress(event, 'touch'), ctx.abortController.signal);
            listen(send, send, 'touchend', () => endLongPress('touch'), ctx.abortController.signal);
            listen(send, send, 'touchcancel', () => endLongPress('touch'), ctx.abortController.signal);
            listen(send, send, 'contextmenu', (event) => {
                event.preventDefault?.();
                if (pending) return;
                ctx.activeChatToolsSessionUid = toolsOpen ? '' : session.sessionUid;
                ctx.renderPage();
            }, ctx.abortController.signal);
        }
        const controls = element('div', { className: 'yl-chat-composer-controls' });
        controls.appendChild(send);
        if (toolsOpen) {
            const toolMenu = element('div', { className: 'yl-chat-tool-menu', ariaLabel: '私聊发送工具栏' });
            const meetupTool = element('button', {
                className: 'yl-chat-tool-button', type: 'button', disabled: !meetupUnlocked,
                text: meetupUnlocked ? `约定面基 · ${session.meetupAccess.route}路线` : '关系未达面基条件',
                ariaLabel: meetupUnlocked ? `打开约定面基，${session.meetupAccess.route}路线` : '关系未达面基条件',
            });
            meetupTool.setAttribute('aria-disabled', String(!meetupUnlocked));
            listen(meetupTool, meetupTool, 'click', () => {
                if (!meetupUnlocked) return;
                ctx.activeChatToolsSessionUid = '';
                ctx.activeMeetupSessionUid = session.sessionUid;
                ctx.renderPage();
            }, ctx.abortController.signal);
            toolMenu.appendChild(meetupTool);
            controls.appendChild(toolMenu);
        }
        append(composer, [input, controls, element('span', { className: 'yl-chat-composer-hint', text: meetupSupported ? '左键发送 · 右键工具栏 · Shift+Enter 换行' : 'Enter 发送 · Shift+Enter 换行' })]);
        panel.appendChild(composer);
        if (meetupUnlocked && ctx.activeMeetupSessionUid === session.sessionUid) panel.appendChild(buildMeetupHandoffPanel(session));
        return panel;
    }
    async function runPrivateChat(session) {
        const playerMessage = String(ctx.chatDrafts.get(session.sessionUid) ?? '');
        if (!playerMessage.trim()) {
            ctx.setFeedback('请先输入想说的话。');
            return;
        }
        if (typeof ctx.actionBridge.runPrivateChat !== 'function' || ctx.actionBridge.isPending?.('private_chat', session.sessionUid)) return;
        const requestGeneration = ++ctx.privateChatRequestGeneration;
        const isStillVisible = () => ctx.open
            && ctx.activePage === 'private_chat'
            && ctx.activeMessageSessionUid === session.sessionUid
            && ctx.privateChatRequestGeneration === requestGeneration;
        let request;
        try { request = ctx.actionBridge.runPrivateChat({ sessionUid: session.sessionUid, npcUid: session.npcUid, playerMessage }); }
        catch { request = Promise.resolve({ ok: false }); }
        // The bridge marks the exact session pending synchronously before its first await.
        // Re-rendering now gives the composer an inline, non-blocking reply state.
        ctx.renderPage();
        let result;
        try { result = await request; }
        catch { result = { ok: false }; }
        if (result?.ok) {
            ctx.chatDrafts.delete(session.sessionUid);
            for (const item of Array.isArray(result.imageDirectives) ? result.imageDirectives : []) {
                if (typeof item?.messageUid === 'string' && item.messageUid && ctx.formatDirectiveForDisplay(item.directive)) {
                    ctx.privateImageDirectives.set(item.messageUid, item.directive);
                }
            }
        } else if (isStillVisible()) {
            const message = result?.message || describeActionFailure(result);
            ctx.setFeedback(message || '私聊回复未生成，请稍后重试。');
        }
        ctx.refreshState();
        if (result?.ok && result.summaryCheckRequested) {
            void runChatSummaryForSession(session, { automatic: true });
        }
    }
    function meetupFieldsFor(sessionUid) {
        if (!ctx.meetupDrafts.has(sessionUid)) ctx.meetupDrafts.set(sessionUid, { time: '', place: '', mutualIntent: '', confirmedBoundaries: '', pendingItems: '', riskNotice: '' });
        return ctx.meetupDrafts.get(sessionUid);
    }
    function buildMeetupHandoffPanel(session) {
        const wrapper = element('section', { className: 'yl-meetup-panel' });
        const pending = ctx.actionBridge.isPending('meetup_handoff', session.sessionUid);
        wrapper.appendChild(element('h2', { text: '约定面基' }));
        const openButton = element('button', { className: 'yl-settings-button', type: 'button', disabled: pending, text: pending ? '处理中…' : ctx.activeMeetupSessionUid === session.sessionUid ? '收起' : '填写约定' });
        listen(openButton, openButton, 'click', () => { ctx.activeMeetupSessionUid = ctx.activeMeetupSessionUid === session.sessionUid ? '' : session.sessionUid; ctx.renderPage(); }, ctx.abortController.signal);
        wrapper.appendChild(openButton);
        if (ctx.activeMeetupSessionUid !== session.sessionUid) return wrapper;
        const values = meetupFieldsFor(session.sessionUid);
        const fields = [['time', '时间', '本周六 19:30', 160, true], ['place', '地点', '静安寺地铁站 2 号口', 160, true], ['mutualIntent', '双方意图', '一起吃饭，确认是否继续约会', 500, true], ['confirmedBoundaries', '已确认边界', '公共场所见面；任何亲密行为需当场确认', 1200, true], ['pendingItems', '待确认事项', '散场时间', 800, false], ['riskNotice', '风险提示', '各自独立到场，可随时离开', 800, false]];
        for (const [key, label, placeholder, maxLength, required] of fields) {
            const block = element('label', { className: 'yl-settings-field' }); block.appendChild(element('span', { text: label }));
            const input = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: key === 'confirmedBoundaries' ? 4 : 2, maxLength, placeholder, value: values[key], disabled: pending });
            if (required) input.required = true;
            listen(input, input, 'input', () => { values[key] = input.value; }, ctx.abortController.signal); block.appendChild(input); wrapper.appendChild(block);
        }
        const commit = element('button', { className: 'yl-settings-button', type: 'button', disabled: pending, text: pending ? '正在保存…' : '填入正文草稿' });
        listen(commit, commit, 'click', () => { void runMeetupHandoff(session); }, ctx.abortController.signal); wrapper.appendChild(commit);
        return wrapper;
    }
    async function runMeetupHandoff(session) {
        const operationToken = ctx.setFeedback('正在校验面基约定…'); ctx.renderPage();
        const request = { sessionUid: session.sessionUid, ...meetupFieldsFor(session.sessionUid) };
        const result = typeof ctx.actionBridge.runPrivateChatMeetupHandoff === 'function'
            ? await ctx.actionBridge.runPrivateChatMeetupHandoff(request)
            : await ctx.actionBridge.runMeetupHandoff({ ...request, npcUid: session.npcUid });
        if (result.ok && result.draftApplied) { ctx.meetupDrafts.delete(session.sessionUid); ctx.activeMeetupSessionUid = ''; ctx.setFeedback('正文草稿已填入，未自动发送。', operationToken); }
        else if (result.ok) ctx.setFeedback('已保存约定，但没有找到正文输入框。', operationToken);
        else ctx.setFeedback(describeActionFailure(result), operationToken);
        ctx.refreshState();
    }
    return {
        cancelChatToolLongPress,
        clearChatToolClickSuppression,
        buildPrivateChatPage,
        buildChatContextPanel,
        closeChatMoreMenu,
        buildConversationHeader,
        buildPrivateChatConfirmation,
        runPrivateChatDestructiveAction,
        buildMessageBubble,
        isPrivateChatVisible,
        clearSummaryToast,
        showSummaryToast,
        buildSummaryToast,
        summaryStatusText,
        runChatSummaryForSession,
        buildConversationSummaryDetail,
        buildPrivateChatSummaryPage,
        buildConversationPanel,
        runPrivateChat,
        meetupFieldsFor,
        buildMeetupHandoffPanel,
        runMeetupHandoff,
    };
}

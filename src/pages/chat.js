// 私聊会话页（设计系统 2.0 · 策划书 §7.2，裁决 D4）：
// 时间分组 + 连续气泡合并 + 「…」收纳菜单 + 可见「+」工具入口 + BottomSheet 面基两步。
// 气泡 class 家族（yl-chat-timeline / yl-time-divider / yl-system-pill /
// yl-msg-group--self|--peer / yl-bubble / yl-bubble-time / yl-bubble-name）为跨代理合同，
// 社区群聊室将逐字复用；CSS 定义在 style.css 的 chat 子区。
import { consumePrivateChatDiagnostics } from '../chat/private-chat-service.js';
import { append, element, listen } from '../dom.js';
import { describeActionFailure, parseChatMessageTime } from '../ui-model.js';
import { createBottomSheet } from '../ui/bottom-sheet.js';
import { createEmptyState } from '../ui/empty-state.js';
import { createUiIcon } from '../ui/icon.js';
import { buildErrorDetail } from '../ui/operation-activity.js';

const CHAT_TOOL_LONG_PRESS_MS = 460;
const CHAT_TIME_DIVIDER_GAP_MS = 10 * 60 * 1000;
// desktop 上下文栏折叠偏好：纯 UI 状态，只进浏览器本地存储，绝不进 MVU/提示词/导出。
const CHAT_CONTEXT_COLLAPSED_STORAGE_KEY = 'yuelema.chat-context-collapsed/v1';

function chatContextStorageOrNull() {
    try {
        const storage = globalThis.localStorage;
        return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' ? storage : null;
    } catch { return null; }
}
function readChatContextCollapsed() {
    try { return chatContextStorageOrNull()?.getItem(CHAT_CONTEXT_COLLAPSED_STORAGE_KEY) === '1'; }
    catch { return false; }
}
function persistChatContextCollapsed(collapsed) {
    try { chatContextStorageOrNull()?.setItem(CHAT_CONTEXT_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0'); }
    catch { /* 本地偏好写入失败时静默降级为本次会话内存行为 */ }
}

// 控制台脱敏器会把 ≥32 字符的连续 token 视作疑似凭据并替换为 [已脱敏]；
// 超长错误码改用空格分词呈现，避免误脱敏（与服务层 presentDiagnosticCode 同规则）。
function presentActivityCode(code) {
    const text = String(code ?? '').trim().slice(0, 120);
    if (!text) return '';
    return text.length >= 32 ? text.split('_').join(' ') : text;
}

/**
 * 汇总一次私聊域失败的控制台 detail：取走服务层带出的逐次尝试诊断记录并
 * 逐条经 buildErrorDetail 格式化（自动脱敏）；服务层没有记录（例如受控
 * Patch/状态读取失败只回错误码）时退化为“结果错误码 + 尝试次数”摘要。
 * 界面 message 不受影响，仍是粗略友好文案。
 */
function buildChatFailureDetail({ operation, kind, sessionUid, result }) {
    const records = consumePrivateChatDiagnostics(kind, sessionUid);
    const sections = [];
    for (const record of records) {
        const text = buildErrorDetail(record.error ?? null, {
            operation, stage: record.stage, code: record.code, field: record.field,
            expected: record.expected, actual: record.actual, hint: record.hint,
        });
        if (text) sections.push(text);
    }
    const numbered = sections.length > 1 ? sections.map((text, index) => `第 ${index + 1} 次尝试\n${text}`) : sections;
    const resultCode = presentActivityCode(result?.code);
    if (!numbered.length) {
        const fallback = buildErrorDetail(null, { operation, code: resultCode, hint: '服务层未提供更细的诊断记录' });
        if (fallback) numbered.push(fallback);
    } else if (resultCode && !records.some((record) => record.code === resultCode)) {
        // 例如受控 Patch 校验/写入失败：错误码来自桥接层，没有对应的服务端诊断。
        const bridgeLine = buildErrorDetail(null, { operation, stage: '受控写入或状态读取', code: resultCode });
        if (bridgeLine) numbered.push(bridgeLine);
    }
    const header = Number.isInteger(result?.attempts) && result.attempts > 1 ? [`共尝试 ${result.attempts} 次后仍未完成`] : [];
    const detail = [...header, ...numbered].join('\n\n');
    return detail || null;
}

export function createChatPage(ctx) {
    // 本次挂载内已经展示过一次性隐私 pill / 输入提示的会话（配合本地存储的“只出现一次”）。
    const introVisibleThisVisit = new Set();
    let composerHintVisibleThisVisit = false;
    const meetupStepBySession = new Map();
    // P3-G：气泡入场动画只给“新增”消息——记录每个会话上次渲染时的消息数；
    // 首次进入会话按当前长度打底（历史消息不动画）。纯动画标记，不进任何存储与提示词。
    const animatedMessageFloorBySession = new Map();

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
        if (!session) return ctx.buildEmptyPlaceholder('这个私聊会话暂时不可见。请返回消息列表后重试。');
        const conversation = buildConversationPanel(session);
        if (ctx.uiLayoutMode !== 'desktop') return conversation;
        // desktop 工作台：最左会话列（复用消息页行组件）+ 会话主列 + 公开资料上下文栏；不建第二数据源。
        const workbench = element('section', { className: 'yl-private-chat-workbench' });
        append(workbench, [buildChatSessionRail(session), conversation, buildChatContextPanel(session)]);
        return workbench;
    }
    /** desktop 三列工作台最左列：全部私聊会话行逐 session 复用消息页行组件；点击行即切换会话。 */
    function buildChatSessionRail(activeSession) {
        const rail = element('nav', { className: 'yl-chat-session-rail', ariaLabel: '私聊会话列表' });
        for (const session of ctx.messageSessions()) {
            const row = ctx.buildMessageSessionButton(session);
            if (session.sessionUid === activeSession.sessionUid) {
                row.classList.add('is-active');
                row.setAttribute('aria-current', 'true');
            }
            rail.appendChild(row);
        }
        return rail;
    }
    /** desktop 私聊上下文栏：只渲染对方公开投影与会话状态，绝不触碰非公开层、关系数据或内部 UID。 */
    function buildChatContextPanel(session) {
        const collapsed = readChatContextCollapsed();
        const aside = element('aside', { className: collapsed ? 'yl-chat-context-panel is-collapsed' : 'yl-chat-context-panel', ariaLabel: `${ctx.chatNickname(session)}的公开资料` });
        const head = element('div', { className: 'yl-chat-context-head' });
        head.appendChild(ctx.chatAvatar(session, 'yl-chat-context-avatar'));
        const headCopy = element('div', { className: 'yl-chat-context-head-copy' });
        headCopy.appendChild(element('strong', { text: ctx.chatNickname(session) }));
        headCopy.appendChild(element('span', { className: 'yl-chat-context-status', text: session.status }));
        head.appendChild(headCopy);
        // 折叠钮（disclosure）：折叠偏好持久化到浏览器本地，折叠后只保留头部一行。
        const toggle = element('button', { className: 'yl-chat-context-toggle', type: 'button', ariaLabel: collapsed ? '展开对方公开资料栏' : '收起对方公开资料栏' });
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.appendChild(createUiIcon(ctx.documentRef, 'chevron_right', { className: 'yl-chat-context-toggle-svg', size: 18 }));
        listen(toggle, toggle, 'click', () => {
            persistChatContextCollapsed(!collapsed);
            ctx.renderPage();
        }, ctx.abortController.signal);
        head.appendChild(toggle);
        aside.appendChild(head);
        if (collapsed) return aside;
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
    /**
     * 头部（§7.2.6）：返回键在壳层页头；这里是 头像40 + 昵称 + presence 副行 + 「…」菜单。
     * 生图设置 / 自动生图开关 / 聊天总结 / 清空记录 / 删除角色 全部收进菜单。
     * 菜单节点常驻 DOM（hidden 切换），保证生图开关等受控控件在会话期内可被稳定引用。
     */
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
            className: 'yl-private-chat-more', type: 'button',
            ariaLabel: '打开与' + ctx.chatNickname(session) + '的更多操作',
            disabled: ctx.destructiveChatSessionUid === session.sessionUid,
        });
        more.appendChild(createUiIcon(ctx.documentRef, 'more_vertical', { className: 'yl-private-chat-more-svg', size: 18 }));
        // Disclosure 按钮列表：不宣称 role=menu（无完整菜单键盘模型），aria-expanded 表达展开状态。
        more.setAttribute('aria-expanded', String(moreOpen));
        listen(more, more, 'click', (event) => {
            event.stopPropagation?.();
            ctx.chatMoreMenuSessionUid = moreOpen ? '' : session.sessionUid;
            ctx.renderPage();
        }, ctx.abortController.signal);
        actions.appendChild(more);
        const menu = element('div', { className: 'yl-private-chat-more-menu', ariaLabel: '私聊更多操作', hidden: !moreOpen });
        // 生图设置钮 + 自动生图开关沿用壳层受控控件（aria 与持久化行为不变），仅改挂载位置。
        menu.appendChild(ctx.buildConversationImageControls({ kind: 'private', conversationId: session.sessionUid }));
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
        let imageCleanupFailed = false;
        for (const sessionUid of sessionsToClear) {
            ctx.chatDrafts.delete(sessionUid);
            ctx.meetupDrafts.delete(sessionUid);
            meetupStepBySession.delete(sessionUid);
            introVisibleThisVisit.delete(sessionUid);
            ctx.messageReadStore?.forgetSession?.(sessionUid);
            try {
                await ctx.conversationImageStore?.removeConversation?.('private', sessionUid);
            } catch {
                imageCleanupFailed = true;
            }
        }
        if (deletingCharacter) {
            ctx.selectedCandidateUid = ctx.selectedCandidateUid === session.npcUid ? '' : ctx.selectedCandidateUid;
            ctx.clearMatchedImageState();
            try { await ctx.characterAvatarStore?.removeAvatar?.(session.npcUid); }
            catch { /* MVU deletion already succeeded; browser-local avatar cleanup is best effort. */ }
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
        ctx.setFeedback(imageCleanupFailed
            ? '聊天已删除，但对应的本地生图缓存清理失败。'
            : deletingCharacter ? '角色完整数据及其关联记录已删除。' : '聊天记录已清空，会话已从消息列表移除。');
    }
    /** 时间分隔 pill 文案：今天只显时分、跨天显“M月D日”，纯时分文本原样展示。 */
    function buildTimeDividerLabel(raw) {
        const text = String(raw ?? '').trim();
        const full = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2}))?/u.exec(text);
        if (full) {
            const nowDate = new Date();
            const sameDay = nowDate.getFullYear() === Number(full[1]) && nowDate.getMonth() + 1 === Number(full[2]) && nowDate.getDate() === Number(full[3]);
            const clock = full[4] ? `${full[4].padStart(2, '0')}:${full[5]}` : '';
            if (sameDay) return clock ? `今天 ${clock}` : '今天';
            return `${Number(full[2])}月${Number(full[3])}日${clock ? ' ' + clock : ''}`;
        }
        return text.slice(0, 20);
    }
    function buildSystemPill(text, time = '') {
        const pill = element('p', { className: 'yl-system-pill' });
        pill.appendChild(element('span', { text }));
        if (time) pill.appendChild(element('span', { className: 'yl-system-pill-time', text: time }));
        return pill;
    }
    /**
     * 面基进展 pill：只消费 ui-model 投影出的最新面基记录（状态/路线/正文结果摘要），
     * 正文回写状态或摘要后经 VARIABLE_UPDATE_ENDED → refreshState 自动刷新；绝不回写任何状态。
     */
    function appendMeetupProgressPills(timeline, session) {
        const meetups = Array.isArray(session.meetups) ? session.meetups : [];
        const meetup = meetups.length ? meetups[meetups.length - 1] : null;
        if (!meetup || meetup.status === '提议') return;
        const statusText = meetup.status === '待发送' ? '行动草稿已生成，等待你在正文亲自发送'
            : meetup.status === '正文进行中' ? '见面正在正文中进行'
                : meetup.status === '已结束' ? '见面已结束' : '见面已取消';
        timeline.appendChild(buildSystemPill(`面基（${meetup.route}路线）：${statusText}`, meetup.time));
        if ((meetup.status === '已结束' || meetup.status === '已取消') && meetup.resultSummary) {
            timeline.appendChild(buildSystemPill(`见面小结：${meetup.resultSummary}`));
        }
    }
    /**
     * 消息时间线（§7.2.3–7.2.5）：>10 分钟插时间分隔 pill；同发送者连续气泡合并成组，
     * 组内仅首条显示头像+昵称、时间只作组尾角标；对方=卡面色、自己=品牌渐变白字。
     */
    function buildMessageTimeline(session) {
        const timeline = element('div', { className: 'yl-chat-transcript yl-chat-timeline', ariaLabel: `${ctx.chatNickname(session)}的私聊记录` });
        // Do not make a full transcript a live region: only concise reply state is announced.
        timeline.setAttribute('aria-live', 'off');
        // §7.2.1：常驻隐私横幅移除，改为首次进入会话时流内一条一次性系统 pill。
        const readStore = ctx.messageReadStore ?? null;
        if (introVisibleThisVisit.has(session.sessionUid) || !readStore || !readStore.hasSeenIntro(session.sessionUid)) {
            introVisibleThisVisit.add(session.sessionUid);
            readStore?.markIntroSeen?.(session.sessionUid);
            timeline.appendChild(buildSystemPill('线上短消息只保存在当前设备的这份聊天里；重要面基安排请在正文中再次确认。'));
        }
        appendMeetupProgressPills(timeline, session);
        if (!session.messages.length) {
            timeline.appendChild(createEmptyState({
                documentRef: ctx.documentRef,
                variant: 'heart',
                title: '还没有消息',
                hint: '用一句简单的问候开始吧。',
            }));
            return timeline;
        }
        const totalMessages = session.messages.length;
        const animatedFloor = animatedMessageFloorBySession.has(session.sessionUid)
            ? animatedMessageFloorBySession.get(session.sessionUid)
            : totalMessages;
        animatedMessageFloorBySession.set(session.sessionUid, totalMessages);
        let messageIndex = -1;
        let groupStack = null;
        let groupSender = '';
        let lastBubble = null;
        let lastBubbleTime = '';
        let previousStamp = null;
        const closeGroup = () => {
            if (lastBubble && lastBubbleTime) lastBubble.appendChild(element('span', { className: 'yl-bubble-time', text: lastBubbleTime }));
            groupStack = null;
            groupSender = '';
            lastBubble = null;
            lastBubbleTime = '';
        };
        for (const message of session.messages) {
            messageIndex += 1;
            const isNewMessage = messageIndex >= animatedFloor;
            if (message.sender === '系统') {
                closeGroup();
                const systemPill = buildSystemPill(message.content, message.time);
                if (isNewMessage) systemPill.classList.add('is-new');
                timeline.appendChild(systemPill);
                previousStamp = parseChatMessageTime(message.time) ?? previousStamp;
                continue;
            }
            const stamp = parseChatMessageTime(message.time);
            if (stamp !== null && (previousStamp === null || stamp - previousStamp > CHAT_TIME_DIVIDER_GAP_MS || stamp < previousStamp)) {
                closeGroup();
                timeline.appendChild(element('p', { className: 'yl-time-divider', text: buildTimeDividerLabel(message.time) }));
            }
            if (stamp !== null) previousStamp = stamp;
            const isPlayer = message.sender === '玩家';
            if (!groupStack || groupSender !== message.sender) {
                closeGroup();
                groupSender = message.sender;
                const group = element('article', { className: isPlayer ? 'yl-msg-group yl-msg-group--self' : 'yl-msg-group yl-msg-group--peer' });
                groupStack = element('div', { className: 'yl-msg-group-stack' });
                if (isPlayer) {
                    group.appendChild(groupStack);
                    group.appendChild(ctx.publicAvatar({ 昵称: '我' }, {
                        className: 'yl-chat-message-avatar yl-chat-self-avatar',
                        imageEnabled: false,
                        interactive: false,
                        fallback: '我',
                        imageSource: ctx.playerAvatarStore?.snapshot?.() ?? '',
                    }));
                } else {
                    group.appendChild(ctx.chatAvatar(session, 'yl-chat-message-avatar'));
                    group.appendChild(groupStack);
                }
                groupStack.appendChild(element('span', { className: 'yl-bubble-name', text: isPlayer ? '我' : ctx.chatNickname(session) }));
                timeline.appendChild(group);
            }
            const bubble = element('article', { className: isPlayer ? 'yl-bubble yl-bubble--self' : 'yl-bubble yl-bubble--peer' });
            if (isNewMessage) bubble.classList.add('is-new');
            bubble.appendChild(element('p', { text: message.content }));
            if (!isPlayer) {
                const directive = ctx.privateImageDirectives.get(`${session.sessionUid}:${message.messageUid}`);
                const imageCard = directive ? ctx.buildImageDirectiveCard({
                    kind: 'private', conversationId: session.sessionUid, messageId: message.messageUid, characterUid: session.npcUid, directive,
                }) : null;
                if (imageCard) bubble.appendChild(imageCard);
            }
            groupStack.appendChild(bubble);
            lastBubble = bubble;
            lastBubbleTime = String(message.time ?? '');
        }
        closeGroup();
        return timeline;
    }
    function buildMessageTimelineShell(session, timeline) {
        const shell = element('div', { className: 'yl-chat-transcript-shell' });
        const jump = element('button', {
            className: 'yl-chat-jump-latest',
            type: 'button',
            text: '跳到最新',
            ariaLabel: `跳到与${ctx.chatNickname(session)}聊天的最新消息`,
        });
        jump.appendChild(createUiIcon(ctx.documentRef, 'chevron_down', { className: 'yl-chat-jump-latest-icon', size: 17 }));
        listen(jump, jump, 'click', () => {
            const scrollToLatest = () => {
                timeline.scrollTop = Math.max(0, (Number(timeline.scrollHeight) || 0) - (Number(timeline.clientHeight) || 0));
            };
            scrollToLatest();
            const requestFrame = globalThis.requestAnimationFrame;
            if (typeof requestFrame === 'function') requestFrame(() => requestFrame(scrollToLatest));
        }, ctx.abortController.signal);
        append(shell, [timeline, jump]);
        return shell;
    }
    /** 等待反馈（§7.2.10）：对方头像 + 三点打字气泡，替代文字“正在生成回复”。 */
    function buildTypingIndicator(session) {
        const replying = element('div', { className: 'yl-chat-replying' });
        replying.setAttribute('role', 'status');
        replying.appendChild(ctx.chatAvatar(session, 'yl-chat-message-avatar'));
        const bubble = element('span', { className: 'yl-typing-bubble' });
        bubble.setAttribute('aria-hidden', 'true');
        for (let index = 0; index < 3; index += 1) bubble.appendChild(element('span', { className: 'yl-typing-dot' }));
        replying.appendChild(bubble);
        replying.appendChild(element('span', { className: 'yl-chat-replying-sr', text: `${ctx.chatNickname(session)}正在输入…` }));
        return replying;
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
        const activityHandle = ctx.operationActivity.start('聊天总结', automatic ? '正在自动整理本次私聊……' : '正在总结当前私聊……');
        let bridgeError = null;
        let request;
        try {
            request = ctx.actionBridge.runPrivateChatSummary({ sessionUid: session.sessionUid, npcUid: session.npcUid, summaryUid, automatic });
        } catch (error) {
            bridgeError = error;
            request = Promise.resolve({ ok: false, code: 'chat_summary_failed', message: '聊天总结未完成，请稍后重试。' });
        }
        if (!automatic) ctx.renderPage();
        let result;
        try { result = await request; } catch (error) { bridgeError = error; result = { ok: false, code: 'chat_summary_failed', message: '聊天总结未完成，请稍后重试。' }; }
        ctx.refreshState();
        const settleSummaryActivity = () => {
            if (result?.ok) {
                consumePrivateChatDiagnostics('chat_summary', session.sessionUid);
                ctx.operationActivity.succeed(activityHandle, '聊天总结已保存。');
                return;
            }
            if (result?.silent || result?.code === 'ui_action_pending') {
                consumePrivateChatDiagnostics('chat_summary', session.sessionUid);
                ctx.operationActivity.dismiss(activityHandle, '总结条件未满足，本次已静默跳过。');
                return;
            }
            let detail = buildChatFailureDetail({ operation: '聊天总结', kind: 'chat_summary', sessionUid: session.sessionUid, result });
            if (bridgeError) {
                const bridgeDetail = buildErrorDetail(bridgeError, { operation: '聊天总结', stage: '桥接调用' });
                if (bridgeDetail) detail = detail ? `${detail}\n\n${bridgeDetail}` : bridgeDetail;
            }
            ctx.operationActivity.fail(activityHandle, '聊天总结未完成。', { detail });
        };
        settleSummaryActivity();
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
            section.appendChild(ctx.buildEmptyPlaceholder(historyMode ? '这个角色还没有已完成的总结记录。' : '还没有已完成的总结记录；达到设定层数后会静默自动整理。'));
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
        if (!session) return ctx.buildEmptyPlaceholder('这个私聊会话暂时不可见。请返回消息列表后重试。');
        return buildConversationSummaryDetail(session, { actionsEnabled: ctx.chatSummaryEnabled() });
    }
    /** 工具面板内容（§7.2.8）：图标网格，约定面基未达条件置灰并注明。 */
    function buildChatToolMenu(session, { meetupSupported, meetupUnlocked }) {
        const menu = element('div', { className: 'yl-chat-tool-menu', ariaLabel: '私聊发送工具栏' });
        const meetupLabel = !meetupSupported ? '面基功能未就绪' : meetupUnlocked ? `约定面基 · ${session.meetupAccess.route}路线` : '关系未达面基条件';
        const meetupTool = element('button', {
            className: 'yl-chat-tool-button', type: 'button', disabled: !meetupUnlocked,
            ariaLabel: meetupUnlocked ? `打开约定面基，${session.meetupAccess.route}路线` : meetupLabel,
        });
        meetupTool.appendChild(createUiIcon(ctx.documentRef, 'hearts', { className: 'yl-chat-tool-svg', size: 22 }));
        meetupTool.appendChild(element('span', { text: meetupLabel }));
        meetupTool.setAttribute('aria-disabled', String(!meetupUnlocked));
        listen(meetupTool, meetupTool, 'click', () => {
            if (!meetupUnlocked) return;
            ctx.activeChatToolsSessionUid = '';
            ctx.activeMeetupSessionUid = session.sessionUid;
            ctx.renderPage();
        }, ctx.abortController.signal);
        const summaryEnabled = ctx.chatSummaryEnabled();
        const summaryTool = element('button', {
            className: 'yl-chat-tool-button', type: 'button', disabled: !summaryEnabled,
            ariaLabel: summaryEnabled ? '打开聊天总结' : '聊天总结未开启',
        });
        summaryTool.appendChild(createUiIcon(ctx.documentRef, 'summary', { className: 'yl-chat-tool-svg', size: 22 }));
        summaryTool.appendChild(element('span', { text: summaryEnabled ? '聊天总结' : '总结未开启' }));
        listen(summaryTool, summaryTool, 'click', () => {
            if (!summaryEnabled) return;
            ctx.activeChatToolsSessionUid = '';
            ctx.setActivePage('private_chat_summary');
        }, ctx.abortController.signal);
        const imageTool = element('button', { className: 'yl-chat-tool-button', type: 'button', ariaLabel: '打开生图设置页' });
        imageTool.appendChild(createUiIcon(ctx.documentRef, 'image', { className: 'yl-chat-tool-svg', size: 22 }));
        imageTool.appendChild(element('span', { text: '生图设置' }));
        listen(imageTool, imageTool, 'click', () => {
            ctx.activeChatToolsSessionUid = '';
            ctx.setActivePage('settings_image_generation');
        }, ctx.abortController.signal);
        append(menu, [meetupTool, summaryTool, imageTool]);
        return menu;
    }
    function buildConversationPanel(session) {
        const panel = element('section', { className: 'yl-private-chat-screen' });
        panel.appendChild(buildConversationHeader(session));
        if (ctx.chatConfirmationSessionUid === session.sessionUid) panel.appendChild(buildPrivateChatConfirmation(session));
        const summaryToastElement = buildSummaryToast(session);
        if (summaryToastElement) panel.appendChild(summaryToastElement);
        const transcript = buildMessageTimeline(session);
        // 本地已读水位推进：进入/停留在会话即视为读到当前全部可见消息（纯 UI 状态）。
        ctx.messageReadStore?.markRead?.(session.sessionUid, session.messages.length);
        const pending = Boolean(ctx.actionBridge.isPending?.('private_chat', session.sessionUid));
        if (pending) transcript.appendChild(buildTypingIndicator(session));
        panel.appendChild(buildMessageTimelineShell(session, transcript));
        if (!session.canSend) {
            // §7.2.11 只读态：禁用输入条 + 状态说明 pill。
            panel.appendChild(buildSystemPill(session.status === '已拉黑' ? '对方已将你拉黑，无法继续发送消息。' : '该会话当前为只读状态。'));
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
        const toolsOpen = ctx.activeChatToolsSessionUid === session.sessionUid;
        // Disclosure：+ 按钮 / 右键 / 长按展开同一工具面板，不宣称 role=menu。
        send.setAttribute('aria-expanded', String(toolsOpen));
        send.setAttribute('title', '左键发送，右键打开工具栏');
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
        const toggleTools = () => {
            ctx.activeChatToolsSessionUid = toolsOpen ? '' : session.sessionUid;
            ctx.renderPage();
        };
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
            toggleTools();
        }, ctx.abortController.signal);
        // §7.2.7 / 裁决 D4：可见「+」按钮与右键/长按并存，打开同一工具面板。
        const plusButton = element('button', { className: 'yl-chat-composer-plus', type: 'button', disabled: pending, ariaLabel: '打开聊天工具' });
        plusButton.setAttribute('aria-expanded', String(toolsOpen));
        plusButton.appendChild(createUiIcon(ctx.documentRef, 'plus', { className: 'yl-chat-composer-plus-svg', size: 20 }));
        listen(plusButton, plusButton, 'click', () => {
            if (pending) return;
            toggleTools();
        }, ctx.abortController.signal);
        const controls = element('div', { className: 'yl-chat-composer-controls' });
        controls.appendChild(send);
        append(composer, [plusButton, input, controls]);
        // 提示行只在首次使用出现，3 秒后 CSS 淡出，不常驻（§7.2.7）。
        const readStore = ctx.messageReadStore ?? null;
        if (composerHintVisibleThisVisit || !readStore || !readStore.hasSeenComposerHint()) {
            composerHintVisibleThisVisit = true;
            readStore?.markComposerHintSeen?.();
            composer.appendChild(element('span', { className: 'yl-chat-composer-hint', text: '左键发送 · 右键或「+」开工具栏 · Shift+Enter 换行' }));
        }
        panel.appendChild(composer);
        if (toolsOpen) {
            const toolSheet = createBottomSheet({
                documentRef: ctx.documentRef,
                title: '聊天工具',
                content: buildChatToolMenu(session, { meetupSupported, meetupUnlocked }),
                onRequestClose: () => { ctx.activeChatToolsSessionUid = ''; ctx.renderPage(); },
            });
            panel.appendChild(toolSheet.root);
            toolSheet.open();
        }
        if (meetupUnlocked && ctx.activeMeetupSessionUid === session.sessionUid) {
            const meetupSheet = createBottomSheet({
                documentRef: ctx.documentRef,
                title: '约定面基',
                content: buildMeetupHandoffPanel(session),
                onRequestClose: () => { ctx.activeMeetupSessionUid = ''; ctx.renderPage(); },
            });
            panel.appendChild(meetupSheet.root);
            meetupSheet.open();
        }
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
        const activityHandle = ctx.operationActivity.start('私聊回复', '正在生成私聊回复……');
        // 发送与回复完成都是明确的“跟随最新消息”意图，不依赖旧容器恰好在
        // 布局采样时仍报告接近底部；真实 WebView 即使先塌缩到 0 也会被拉回末尾。
        ctx.requestPrivateChatScrollToBottom?.(session.sessionUid);
        let bridgeError = null;
        let request;
        try { request = ctx.actionBridge.runPrivateChat({ sessionUid: session.sessionUid, npcUid: session.npcUid, playerMessage }); }
        catch (error) { bridgeError = error; request = Promise.resolve({ ok: false }); }
        // The bridge marks the exact session pending synchronously before its first await.
        // Re-rendering now gives the composer an inline, non-blocking reply state.
        ctx.renderPage();
        let result;
        try { result = await request; }
        catch (error) { bridgeError = error; result = { ok: false }; }
        if (result?.ok) {
            consumePrivateChatDiagnostics('private_chat', session.sessionUid);
            ctx.operationActivity.succeed(activityHandle, '私聊回复已完成。');
        } else if (result?.code === 'ui_action_pending') {
            ctx.operationActivity.dismiss(activityHandle, '相同会话的发送正在进行，本次请求已忽略。');
        } else {
            let detail = buildChatFailureDetail({ operation: '私聊回复', kind: 'private_chat', sessionUid: session.sessionUid, result });
            if (bridgeError) {
                const bridgeDetail = buildErrorDetail(bridgeError, { operation: '私聊回复', stage: '桥接调用' });
                if (bridgeDetail) detail = detail ? `${detail}\n\n${bridgeDetail}` : bridgeDetail;
            }
            ctx.operationActivity.fail(activityHandle, '私聊回复未完成。', { detail });
        }
        if (result?.ok) {
            ctx.chatDrafts.delete(session.sessionUid);
            for (const item of Array.isArray(result.imageDirectives) ? result.imageDirectives : []) {
                if (typeof item?.messageUid === 'string' && item.messageUid && ctx.formatDirectiveForDisplay(item.directive)) {
                    ctx.privateImageDirectives.set(`${session.sessionUid}:${item.messageUid}`, item.directive);
                }
            }
        } else if (isStillVisible()) {
            const message = result?.message || describeActionFailure(result);
            ctx.setFeedback(message || '私聊回复未生成，请稍后重试。');
        }
        if (result?.ok) ctx.requestPrivateChatScrollToBottom?.(session.sessionUid);
        ctx.refreshState();
        if (result?.ok && result.summaryCheckRequested) {
            void runChatSummaryForSession(session, { automatic: true });
        }
    }
    function meetupFieldsFor(sessionUid) {
        if (!ctx.meetupDrafts.has(sessionUid)) ctx.meetupDrafts.set(sessionUid, { time: '', place: '', mutualIntent: '', confirmedBoundaries: '', pendingItems: '', riskNotice: '' });
        return ctx.meetupDrafts.get(sessionUid);
    }
    /**
     * 面基面板（§7.2.9）：BottomSheet 内两步表单——①时间/地点/双方意图 ②边界/待确认/风险。
     * 桥接逻辑零改动：提交仍只把行动提示词填入正文输入框，绝不自动发送。
     */
    function buildMeetupHandoffPanel(session) {
        const wrapper = element('section', { className: 'yl-meetup-panel' });
        const pending = ctx.actionBridge.isPending('meetup_handoff', session.sessionUid);
        const step = meetupStepBySession.get(session.sessionUid) === 2 ? 2 : 1;
        const values = meetupFieldsFor(session.sessionUid);
        wrapper.appendChild(element('p', {
            className: 'yl-meetup-step-indicator',
            text: step === 1 ? '第 1 / 2 步 · 时间、地点与双方意图' : '第 2 / 2 步 · 边界、待确认与风险',
        }));
        const stepOneFields = [['time', '时间', '本周六 19:30', 160, true], ['place', '地点', '静安寺地铁站 2 号口', 160, true], ['mutualIntent', '双方意图', '一起吃饭，确认是否继续约会', 500, true]];
        const stepTwoFields = [['confirmedBoundaries', '已确认边界', '公共场所见面；任何亲密行为需当场确认', 1200, true], ['pendingItems', '待确认事项', '散场时间', 800, false], ['riskNotice', '风险提示', '各自独立到场，可随时离开', 800, false]];
        for (const [key, label, placeholder, maxLength, required] of (step === 1 ? stepOneFields : stepTwoFields)) {
            const block = element('label', { className: 'yl-settings-field' }); block.appendChild(element('span', { text: label }));
            const input = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: key === 'confirmedBoundaries' ? 4 : 2, maxLength, placeholder, value: values[key], disabled: pending });
            if (required) input.required = true;
            listen(input, input, 'input', () => { values[key] = input.value; }, ctx.abortController.signal); block.appendChild(input); wrapper.appendChild(block);
        }
        const actions = element('div', { className: 'yl-meetup-actions' });
        if (step === 1) {
            const next = element('button', { className: 'yl-settings-button', type: 'button', disabled: pending, text: '下一步' });
            listen(next, next, 'click', () => { meetupStepBySession.set(session.sessionUid, 2); ctx.renderPage(); }, ctx.abortController.signal);
            actions.appendChild(next);
        } else {
            const back = element('button', { className: 'yl-settings-button yl-settings-button-secondary', type: 'button', disabled: pending, text: '上一步' });
            listen(back, back, 'click', () => { meetupStepBySession.set(session.sessionUid, 1); ctx.renderPage(); }, ctx.abortController.signal);
            const commit = element('button', { className: 'yl-settings-button', type: 'button', disabled: pending, text: pending ? '正在保存…' : '填入正文草稿' });
            listen(commit, commit, 'click', () => { void runMeetupHandoff(session); }, ctx.abortController.signal);
            append(actions, [back, commit]);
        }
        wrapper.appendChild(actions);
        wrapper.appendChild(element('p', { className: 'yl-meetup-note', text: '提交只会把行动提示词填入正文输入框，不会自动发送。' }));
        return wrapper;
    }
    async function runMeetupHandoff(session) {
        const operationToken = ctx.setFeedback('正在校验面基约定…'); ctx.renderPage();
        const request = { sessionUid: session.sessionUid, ...meetupFieldsFor(session.sessionUid) };
        const result = typeof ctx.actionBridge.runPrivateChatMeetupHandoff === 'function'
            ? await ctx.actionBridge.runPrivateChatMeetupHandoff(request)
            : await ctx.actionBridge.runMeetupHandoff({ ...request, npcUid: session.npcUid });
        if (result.ok && result.draftApplied) {
            ctx.meetupDrafts.delete(session.sessionUid);
            meetupStepBySession.delete(session.sessionUid);
            ctx.activeMeetupSessionUid = '';
            ctx.setFeedback('正文草稿已填入，未自动发送。', operationToken);
        }
        else if (result.ok) ctx.setFeedback('已保存约定，但没有找到正文输入框。', operationToken);
        else ctx.setFeedback(describeActionFailure(result), operationToken);
        ctx.refreshState();
    }
    return {
        cancelChatToolLongPress,
        clearChatToolClickSuppression,
        buildPrivateChatPage,
        buildChatSessionRail,
        buildChatContextPanel,
        closeChatMoreMenu,
        buildConversationHeader,
        buildPrivateChatConfirmation,
        runPrivateChatDestructiveAction,
        buildMessageTimeline,
        buildTypingIndicator,
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

// 社区页（P2-C 现代化改造，策划书 §8）：砍掉二选一 Hub，顶部 SegmentedControl「广场｜群聊」直达内容；
// 广场=频道 chip 条 + 现代帖子卡 + 骨架屏；群聊=ListRow 列表 + 顶部 tonal 按钮 + 复用私聊气泡体系的群聊室。
// 跨代理合同：气泡 class（yl-chat-timeline/yl-time-divider/yl-system-pill/yl-msg-group--self|--peer/yl-bubble/
// yl-bubble-time/yl-bubble-name）逐字复用 P2-A 定义；本页额外定义 yl-name-tone-0..5（发言人昵称按稳定哈希取 6 色）。
import { append, element, listen } from '../dom.js';
import { DEFAULT_FORUM_AUTO_SETTINGS, DEFAULT_GROUP_AUTO_SETTINGS, FORUM_CHANNELS, externalGroupCacheKey, forumChannelForTopic, groupForumProfileForDisplay, publicProfileToGroupForumProfile } from '../groups/group-forum-store.js';
import { createUiIcon } from '../ui/icon.js';
import { createButton } from '../ui/button.js';
import { createListRow } from '../ui/list-row.js';
import { createSegmentedControl } from '../ui/segmented-control.js';
import { createEmptyState } from '../ui/empty-state.js';
import { createSkeleton } from '../ui/skeleton.js';
import { createTagChip } from '../ui/badge.js';
import { createBottomSheet } from '../ui/bottom-sheet.js';
import { buildErrorDetail } from '../ui/operation-activity.js';
import { buildWaitCaptions } from './shared.js';

const FORUM_PULL_THRESHOLD = 88;
// 停靠点合同（用户 2026-08-16 规格）：指示器行进到阈值时正好停在「1/4 窗口」——
// 顶部下拉向下 1/4、底部上拉向上 1/4；越过阈值只留一点阻尼余量，不会被拖到屏幕中间。
// 1/4 必须按可视窗口（ctx.content 的 clientHeight）算，不能按帖子流 section 算：
// 长列表的 25% 会落到屏幕外，旧实现的 CSS `top: 25%` 就是这么失效的。
const FORUM_PULL_PARK_RATIO = 0.25;
const FORUM_PULL_PARK_MIN = 56;
const FORUM_PULL_PARK_MAX = 220;
const FORUM_PULL_PARK_FALLBACK = 120;
const FORUM_PULL_OVERSHOOT = 24;
// 横向优先判定：频道 chip 条要能左右滑，别被下拉刷新吞掉。
const FORUM_PULL_AXIS_SLACK = 6;
// 反向滚轮的退回倍率：按规格「快速移动直到消失」，比前进快一些。
const FORUM_WHEEL_RETREAT_RATIO = 1.6;
// P3-G 等待期趣味文案（纯 CSS 轮播）：广场整刷等待时替代干等。
const FORUM_WAIT_CAPTIONS = Object.freeze(['正在刷新广场风向…', '收集大家的新鲜事…', '八个频道的热帖正在赶来…', '整理今天值得看的动态…']);
const FORUM_WAIT_SHIFT_TEXT = '内容有点多，再等一小会…';
const FORUM_WHEEL_RELEASE_DELAY = 180;
const FORUM_WHEEL_MAX_DISTANCE = 288;
// 论坛频道结构图标：本地 SVG 白名单映射；未知频道回退到店内文字符号（内容而非系统控制）。
const FORUM_CHANNEL_ICON_NAMES = Object.freeze({
    daily_mood: 'channel_mood',
    nearby_people: 'channel_nearby',
    city_moments: 'channel_moments',
    shared_interests: 'channel_interests',
    late_night_whisper: 'channel_night',
    love_complaints: 'channel_banter',
    date_reports: 'channel_dates',
    topic_square: 'channel_topics',
});
// 「记住上次停留 tab」是纯 UI 偏好：只进浏览器本地，绝不进 MVU/提示词/导出/网络（策划书 §1 边界 2）。
const COMMUNITY_TAB_STORAGE_KEY = 'yuelema.community-tab/v1';
const COMMUNITY_TABS = Object.freeze([
    Object.freeze({ id: 'square', label: '广场' }),
    Object.freeze({ id: 'chat', label: '群聊' }),
]);
const GROUP_TIME_DIVIDER_GAP_MS = 10 * 60 * 1000;
const NAME_TONE_COUNT = 6;
const POST_EXPAND_THRESHOLD = 120;
const FORUM_PARTICIPANT_LONG_PRESS_MS = 460;
const FORUM_PARTICIPANT_MOVE_TOLERANCE = 8;

// 控制台脱敏器会把 ≥32 字符的连续 token 视作疑似凭据并替换为 [已脱敏]；
// 超长错误码改用空格分词呈现，避免误脱敏（与服务层 presentGroupDiagnosticCode 同规则）。
function presentConsoleCode(code) {
    const text = String(code ?? '').trim().slice(0, 120);
    if (!text) return '';
    return text.length >= 32 ? text.split('_').join(' ') : text;
}

/**
 * 群聊/论坛/本地总结失败的控制台 detail：优先使用服务层带出的 `diagnostic`
 * 纯数据记录（阶段/字段路径/期望/实际/HTTP 状态），桥接调用本身抛异常时
 * 直接格式化该异常；两者都没有时退化为“结果错误码”摘要。
 * 界面 message 不变，仍是粗略友好文案。
 */
function communityFailureDetail(operation, result, caughtError = null) {
    const diagnostic = result && typeof result === 'object' && result.diagnostic && typeof result.diagnostic === 'object' ? result.diagnostic : null;
    const errorSource = caughtError ?? diagnostic?.error ?? null;
    // buildErrorDetail 已从 errorSource 打印其自带错误码；context 只补充不同的结果错误码，避免重复行。
    let contextCode = presentConsoleCode(result?.code) || presentConsoleCode(diagnostic?.code);
    if (contextCode && errorSource && presentConsoleCode(errorSource.code) === contextCode) contextCode = '';
    return buildErrorDetail(errorSource, {
        operation,
        stage: caughtError ? '桥接调用' : diagnostic?.stage,
        code: contextCode || undefined,
        field: diagnostic?.field,
        expected: diagnostic?.expected,
        actual: diagnostic?.actual,
        hint: diagnostic?.hint,
    });
}

/** 本地缓存写入失败（groupForumStore 抛异常）的控制台 detail。 */
function localCacheFailureDetail(operation, error) {
    return buildErrorDetail(error, { operation, stage: '本地缓存写入' });
}

function communityTabStorageOrNull() {
    try {
        const storage = globalThis.localStorage;
        return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' ? storage : null;
    } catch { return null; }
}
function readCommunityTabPreference() {
    try { return communityTabStorageOrNull()?.getItem(COMMUNITY_TAB_STORAGE_KEY) === 'chat' ? 'chat' : 'square'; }
    catch { return 'square'; }
}
function persistCommunityTabPreference(tab) {
    try {
        const storage = communityTabStorageOrNull();
        if (!storage) return false;
        storage.setItem(COMMUNITY_TAB_STORAGE_KEY, tab === 'chat' ? 'chat' : 'square');
        return true;
    } catch { return false; }
}
function parseMessageTimestamp(value) {
    const time = Date.parse(String(value ?? ''));
    return Number.isFinite(time) ? time : null;
}
function pad2(value) { return String(value).padStart(2, '0'); }
function formatClockTime(timestamp) {
    const date = new Date(timestamp);
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
function isSameCalendarDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function timeDividerLabel(timestamp, nowMs = Date.now()) {
    const date = new Date(timestamp);
    const now = new Date(nowMs);
    const clock = formatClockTime(timestamp);
    if (isSameCalendarDay(date, now)) return `今天 ${clock}`;
    if (isSameCalendarDay(date, new Date(nowMs - 24 * 60 * 60 * 1000))) return `昨天 ${clock}`;
    return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}
function relativeTimeLabel(value, nowMs = Date.now()) {
    const timestamp = parseMessageTimestamp(value);
    if (timestamp === null) return '';
    const diff = Math.max(0, nowMs - timestamp);
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    const date = new Date(timestamp);
    const now = new Date(nowMs);
    if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
// 发言人昵称稳定取色：同一 key（优先 UID，本地群资料无 UID 时用昵称）在任何会话里映射到同一 tone。
function nameToneIndex(key) {
    const text = String(key ?? '');
    let hash = 0;
    for (const char of text) hash = (hash * 31 + char.codePointAt(0)) % 9973;
    return hash % NAME_TONE_COUNT;
}
function nameToneClass(key) { return `yl-name-tone-${nameToneIndex(key)}`; }
// 连续消息合并 + >10 分钟时间分隔（§7.2 规则在群聊室的复用）。纯函数，便于单测。
function groupMessageRuns(messages) {
    const runs = [];
    let lastTs = null;
    for (const message of Array.isArray(messages) ? messages : []) {
        const timestamp = parseMessageTimestamp(message?.createdAt);
        const isUser = message?.sender === 'user';
        const key = isUser ? 'user' : `member:${String(message?.author?.nickname ?? '')}`;
        const needsDivider = timestamp !== null && (lastTs === null || timestamp - lastTs > GROUP_TIME_DIVIDER_GAP_MS);
        const current = runs.at(-1);
        if (!current || needsDivider || current.key !== key) runs.push({ key, isUser, dividerTs: needsDivider ? timestamp : null, lastTs: timestamp, messages: [message] });
        else { current.messages.push(message); if (timestamp !== null) current.lastTs = timestamp; }
        if (timestamp !== null) lastTs = timestamp;
    }
    return runs;
}

export function createCommunityPage(ctx) {
    let forumDeleteConfirmationId = '';
    let forumDeletePendingId = '';
    let forumParticipantActionSheet = null;
    let forumParticipantActionOpener = null;
    let forumParticipantDetail = null;
    let forumParticipantMountGeneration = 0;

    function removeNode(node) {
        if (!node) return;
        if (typeof node.remove === 'function') node.remove();
        else node.parentNode?.removeChild?.(node);
    }
    function closeForumParticipantActionSheet({ restoreFocus = true } = {}) {
        if (!forumParticipantActionSheet) return;
        forumParticipantActionOpener?.setAttribute?.('aria-expanded', 'false');
        const sheet = forumParticipantActionSheet;
        forumParticipantActionSheet = null;
        forumParticipantActionOpener = null;
        sheet.close({ restoreFocus });
        removeNode(sheet.root);
    }
    function resetForumParticipantActions() {
        forumParticipantMountGeneration += 1;
        closeForumParticipantActionSheet({ restoreFocus: false });
    }

    function resetForumPostDeletion() {
        forumDeleteConfirmationId = '';
    }
    function communityLandingPage() { return readCommunityTabPreference() === 'chat' ? 'group_chat' : 'group_forum'; }
    function buildGroupsPage() {
        // §8.1 砍掉二选一 Hub：进社区直接跳到上次停留的 tab；本页只渲染一帧过渡骨架。
        // 用微任务跳转避免 renderPage 重入（setActivePage 会再次触发 renderPage）。
        const target = communityLandingPage();
        queueMicrotask(() => {
            if (ctx.isDestroyed || !ctx.open || ctx.activePage !== 'groups') return;
            ctx.setActivePage(target);
        });
        const section = element('section', { className: 'yl-community-redirect' });
        section.appendChild(createSkeleton({ documentRef: ctx.documentRef, variant: 'post', count: 2 }));
        return section;
    }
    function selectCommunityTab(tabId) {
        resetForumPostDeletion();
        persistCommunityTabPreference(tabId);
        ctx.setActivePage(tabId === 'chat' ? 'group_chat' : 'group_forum');
    }
    // 两个 tab 页共用的页头：标题「社区」+ SegmentedControl；广场侧提供明确可见的设置入口（§8.2-3）。
    function buildCommunityTopbar(activeTabId) {
        const bar = element('div', { className: 'yl-community-topbar' });
        bar.appendChild(element('h2', { className: 'yl-community-title', text: '社区' }));
        const segmented = createSegmentedControl({
            documentRef: ctx.documentRef,
            segments: COMMUNITY_TABS.map((tab) => ({ id: tab.id, label: tab.label })),
            activeId: activeTabId,
            onChange: (tabId) => selectCommunityTab(tabId),
            ariaLabel: '社区内容切换',
        });
        bar.appendChild(segmented.element);
        if (activeTabId === 'square') {
            const settingsButton = createButton({
                documentRef: ctx.documentRef, variant: 'tonal', label: '设置', icon: 'settings', ariaLabel: '社区设置',
                onClick: () => openForumSettingsDialog(),
            });
            settingsButton.classList.add('yl-community-settings-button');
            bar.appendChild(settingsButton);
        }
        return bar;
    }
    function socialGroups() { return Array.isArray(ctx.groupForumSnapshot?.groups) ? ctx.groupForumSnapshot.groups : []; }
    function socialThreads() { return Array.isArray(ctx.groupForumSnapshot?.threads) ? ctx.groupForumSnapshot.threads : []; }
    function socialPosts() { return Array.isArray(ctx.groupForumSnapshot?.posts) ? ctx.groupForumSnapshot.posts : []; }
    function socialThreadFor(key) { return socialThreads().find((thread) => thread.key === key) ?? null; }
    function socialPostFor(id) { return socialPosts().find((post) => post.id === id) ?? null; }
    function activeForumChannel() { return FORUM_CHANNELS.find((channel) => channel.id === ctx.activeForumChannelId) ?? null; }
    function forumChannelForPost(post) { return forumChannelForTopic(post?.topic); }
    function forumPostsForActiveChannel() {
        const channel = activeForumChannel();
        return channel ? socialPosts().filter((post) => forumChannelForPost(post).id === channel.id) : socialPosts();
    }
    function selectForumChannel(channelId) {
        if (!FORUM_CHANNELS.some((channel) => channel.id === channelId)) return;
        ctx.activeForumChannelId = ctx.activeForumChannelId === channelId ? '' : channelId;
        cancelForumPullInteractions();
        ctx.content.scrollTop = 0;
        ctx.renderPage();
    }
    function defaultLocalConversation() {
        return {
            auto: { ...DEFAULT_GROUP_AUTO_SETTINGS },
            bindings: { SFW: { connectionPresetId: null, promptPresetId: null }, NSFW: { connectionPresetId: null, promptPresetId: null } },
            messages: [], summaries: [], summaryStatus: { status: 'idle', startFloor: 0, endFloor: 0, message: '' },
        };
    }
    function currentContentMode() { return ctx.currentView.mode === 'NSFW' ? 'NSFW' : 'SFW'; }
    function blankLocalBinding() { return { connectionPresetId: null, promptPresetId: null }; }
    function localBindingForMode(bindings, contentMode = currentContentMode()) {
        const candidate = bindings?.[contentMode];
        return candidate && typeof candidate === 'object'
            ? { connectionPresetId: candidate.connectionPresetId ?? null, promptPresetId: candidate.promptPresetId ?? null }
            : blankLocalBinding();
    }
    function localModeBindings(bindings) {
        return { SFW: localBindingForMode(bindings, 'SFW'), NSFW: localBindingForMode(bindings, 'NSFW') };
    }
    function withLocalBinding(bindings, binding, contentMode = currentContentMode()) {
        const next = localModeBindings(bindings);
        next[contentMode] = { connectionPresetId: binding?.connectionPresetId ?? null, promptPresetId: binding?.promptPresetId ?? null };
        return next;
    }
    function forumAutoSettings() {
        const saved = ctx.groupForumSnapshot?.forumAuto;
        return {
            enabled: saved?.enabled === true,
            intervalSeconds: Number.isInteger(saved?.intervalSeconds) ? saved.intervalSeconds : DEFAULT_FORUM_AUTO_SETTINGS.intervalSeconds,
            channelBindings: localModeBindings(saved?.channelBindings),
            postBindings: localModeBindings(saved?.postBindings),
        };
    }
    function localSummaryInfo(conversation) {
        const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
        const summaries = Array.isArray(conversation?.summaries) ? conversation.summaries : [];
        const completedFloor = summaries.reduce((floor, record) => Math.max(floor, Number(record.endFloor) || 0), 0);
        const status = conversation?.summaryStatus ?? { status: 'idle', startFloor: 0, endFloor: 0, message: '' };
        return {
            totalFloors: messages.length,
            completedFloor,
            pendingFloorCount: Math.max(0, messages.length - completedFloor),
            records: summaries,
            status: status.status === 'failed' ? 'failed' : 'idle',
            failureStartFloor: Number(status.startFloor) || 0,
            failureEndFloor: Number(status.endFloor) || 0,
            failureMessage: String(status.message ?? ''),
        };
    }
    function safeLocalDisplayProfile(profile) {
        try { return groupForumProfileForDisplay(profile); }
        catch { return { 昵称: '未命名成年人', 年龄段: '未知', 性别: '未知', 城市: '', 简介: '', 兴趣标签: [], 性格标签: [], 生活方式标签: [], 沟通风格标签: [] }; }
    }
    function playerDisplayName({ forModel = false } = {}) {
        const nickname = typeof ctx.currentView?.playerProfile?.昵称 === 'string'
            ? ctx.currentView.playerProfile.昵称.trim().slice(0, 80)
            : '';
        return nickname || (forModel ? '玩家本人' : '我');
    }
    function playerDisplayProfile() {
        const source = ctx.currentView?.playerProfile;
        return source && typeof source === 'object'
            ? { ...source, 昵称: playerDisplayName() }
            : { 昵称: playerDisplayName(), 头像引用: '' };
    }
    function playerAvatarSource() {
        try { return ctx.playerAvatarStore?.snapshot?.() ?? ''; }
        catch { return ''; }
    }
    function currentGroupCards() {
        const cards = [];
        const seen = new Set();
        const exitedExternalGroups = new Set(Array.isArray(ctx.groupForumSnapshot?.exitedExternalGroupKeys) ? ctx.groupForumSnapshot.exitedExternalGroupKeys : []);
        for (const group of Array.isArray(ctx.currentView.groups) ? ctx.currentView.groups : []) {
            const members = [];
            for (const person of Array.isArray(group.成员) ? group.成员 : []) {
                try { members.push(publicProfileToGroupForumProfile(person.公开资料)); } catch { /* invalid public projection is hidden */ }
            }
            if (!group?.主题 || !group?.描述) continue;
            let cacheKey;
            try { cacheKey = externalGroupCacheKey(group); } catch { continue; }
            if (exitedExternalGroups.has(cacheKey)) continue;
            if (seen.has(cacheKey)) continue;
            seen.add(cacheKey);
            cards.push(Object.freeze({
                cacheKey, scope: 'mvu', sourceGroupUid: group.UID, name: group.主题, description: group.描述,
                members: Object.freeze(members),
            }));
        }
        for (const group of socialGroups()) {
            if (seen.has(group.id)) continue;
            seen.add(group.id);
            cards.push(Object.freeze({
                cacheKey: group.id, scope: 'local', name: group.name,
                description: group.members.length ? `与 ${group.members.slice(0, 3).map((profile) => profile.nickname).join('、')} 的聊天群` : '本地聊天群',
                members: Object.freeze([...group.members]),
            }));
        }
        return cards;
    }
    function activeGroupCard() { return currentGroupCards().find((group) => group.cacheKey === ctx.activeGroupCacheKey) ?? null; }
    function groupConversation(group) { return socialThreadFor(group?.cacheKey) ?? defaultLocalConversation(); }
    function groupParticipants(group) {
        const temporary = Array.isArray(groupConversation(group).temporaryMembers) ? groupConversation(group).temporaryMembers : [];
        const seen = new Set();
        const result = [];
        for (const profile of [...(group?.members ?? []), ...temporary]) {
            const name = String(profile?.nickname ?? '').normalize('NFKC').toLowerCase();
            if (!name || seen.has(name)) continue;
            seen.add(name); result.push(profile);
        }
        return result;
    }
    function localHistoryForModel(conversation) {
        const info = localSummaryInfo(conversation);
        const summaries = (conversation?.summaries ?? []).slice(-24).map((record) => ({ startFloor: record.startFloor, endFloor: record.endFloor, content: record.content }));
        const messages = (conversation?.messages ?? []).filter((message) => Number(message.floor) > info.completedFloor).slice(-48).map((message) => ({
            sender: message.sender,
            speaker: message.sender === 'user' ? playerDisplayName({ forModel: true }) : (message.author?.nickname || '群友'),
            content: message.content,
        }));
        return { summaries, messages };
    }
    async function syncGroupForumSnapshot({ rerender = true } = {}) {
        if (!ctx.groupForumStore || typeof ctx.groupForumStore.snapshot !== 'function') return ctx.groupForumSnapshot;
        try { ctx.groupForumSnapshot = await ctx.groupForumStore.snapshot(); }
        catch {
            if (!ctx.isDestroyed && ctx.open) ctx.setFeedback('本地群组/论坛缓存暂时不可用。');
        }
        if (rerender && !ctx.isDestroyed && ctx.open) ctx.renderPage();
        return ctx.groupForumSnapshot;
    }
    function privateChatMemberCandidates() {
        const candidates = [];
        const names = new Set();
        for (const session of ctx.messageSessions()) {
            try {
                const profile = publicProfileToGroupForumProfile(session.profile);
                const name = profile.nickname.normalize('NFKC').toLowerCase();
                if (names.has(name)) continue;
                names.add(name);
                candidates.push(Object.freeze({ sessionUid: session.sessionUid, profile }));
            } catch { /* incomplete or malformed public profiles cannot be added */ }
        }
        return candidates;
    }
    function closeGroupMemberPicker() {
        ctx.groupMemberPickerOpen = false;
        ctx.closeManagedDialog(ctx.groupMemberPickerDialog);
        ctx.groupMemberPickerContent.replaceChildren();
    }
    function openGroupMemberPicker() {
        const candidates = privateChatMemberCandidates();
        const selectedNames = new Set(ctx.groupCreateMembers.map((profile) => profile.nickname.normalize('NFKC').toLowerCase()));
        ctx.groupMemberPickerContent.replaceChildren();
        ctx.groupMemberPickerContent.appendChild(element('p', { className: 'yl-phone-page-description', text: '勾选已经建立私聊的成年人。这里只复制公开资料到本地群，不会改动私聊或 MVU。' }));
        if (!candidates.length) {
            ctx.groupMemberPickerContent.appendChild(createEmptyState({
                documentRef: ctx.documentRef, variant: 'inbox',
                title: '还没有可添加的私聊角色',
                hint: '请先在「消息」中建立至少一段私聊。',
            }));
        } else {
            const list = element('div', { className: 'yl-group-picker-list' });
            const selectedSessionUids = new Set(candidates.filter((candidate) => selectedNames.has(candidate.profile.nickname.normalize('NFKC').toLowerCase())).map((candidate) => candidate.sessionUid));
            for (const [index, candidate] of candidates.entries()) {
                const row = element('label', { className: 'yl-group-picker-row', htmlFor: `yl-group-member-${index}` });
                const checkbox = element('input', { type: 'checkbox', id: `yl-group-member-${index}`, checked: selectedSessionUids.has(candidate.sessionUid), ariaLabel: `选择${candidate.profile.nickname}` });
                const copy = element('span', { className: 'yl-group-picker-copy' });
                const display = safeLocalDisplayProfile(candidate.profile);
                append(copy, [element('strong', { text: display.昵称 }), element('span', { text: [display.年龄段, display.性别, display.城市].filter(Boolean).join(' · ') })]);
                row.appendChild(checkbox); row.appendChild(ctx.publicAvatar(display, { className: 'yl-group-member-avatar', imageEnabled: true, interactive: false })); row.appendChild(copy);
                listen(checkbox, checkbox, 'change', () => {
                    if (checkbox.checked) selectedSessionUids.add(candidate.sessionUid);
                    else selectedSessionUids.delete(candidate.sessionUid);
                }, ctx.abortController.signal);
                list.appendChild(row);
            }
            ctx.groupMemberPickerContent.appendChild(list);
            const actions = element('div', { className: 'yl-settings-actions' });
            const cancel = element('button', { className: 'yl-settings-button yl-settings-button-secondary', type: 'button', text: '取消' });
            const confirm = element('button', { className: 'yl-settings-button', type: 'button', text: '确认添加' });
            listen(cancel, cancel, 'click', closeGroupMemberPicker, ctx.abortController.signal);
            listen(confirm, confirm, 'click', () => {
                ctx.groupCreateMembers = candidates.filter((candidate) => selectedSessionUids.has(candidate.sessionUid)).map((candidate) => candidate.profile);
                closeGroupMemberPicker(); ctx.renderPage();
            }, ctx.abortController.signal);
            append(actions, [cancel, confirm]); ctx.groupMemberPickerContent.appendChild(actions);
        }
        ctx.groupMemberPickerOpen = true;
        ctx.openManagedDialog(ctx.groupMemberPickerDialog, { onRequestClose: closeGroupMemberPicker });
    }
    function closeGroupAutoDialog() {
        ctx.groupAutoDialogKey = '';
        ctx.closeManagedDialog(ctx.groupAutoDialog);
        ctx.groupAutoContent.replaceChildren();
    }
    /**
     * 群设置对话框（仅在群聊房间内可达）：预设绑定（连接 + 提示词）与自动更新并列呈现，
     * 风格与社区设置（openForumSettingsDialog）一致。绑定按当前 SFW/NSFW 分开保存，
     * 只写入浏览器本地群缓存（groupForumStore），绝不写回可导出的设置仓库、MVU 或酒馆正文。
     */
    function openGroupSettingsDialog(group) {
        const thread = groupConversation(group);
        const current = thread.auto ?? DEFAULT_GROUP_AUTO_SETTINGS;
        const contentMode = currentContentMode();
        ctx.groupAutoDialogKey = group.cacheKey;
        ctx.groupAutoTitle.textContent = `${group.name} · 群设置`;
        ctx.groupAutoDialog.setAttribute('aria-label', `${group.name}群设置`);
        ctx.groupAutoDialog.querySelector?.('.yl-dialog-close')?.setAttribute?.('aria-label', '关闭群设置');
        ctx.groupAutoContent.replaceChildren();
        ctx.groupAutoContent.appendChild(element('p', { className: 'yl-phone-page-description', text: '以下设置只影响当前聊天群，保存在浏览器本地缓存，不写入设置导出、MVU 或酒馆正文。' }));
        const bindingZone = buildLocalBindingZone({
            title: '聊天群预设',
            description: `绑定只影响本群公开聊天的内容风格；成员、消息结构与数据框架由代码固定。此处仅保存当前 ${contentMode} 模式的绑定，另一模式独立保存、互不影响。`,
            binding: localBindingForMode(thread.bindings, contentMode),
            namePrefix: 'group-chat',
        });
        ctx.groupAutoContent.appendChild(bindingZone.zone);
        const autoZone = element('section', { className: 'yl-forum-settings-zone' });
        append(autoZone, [element('h3', { text: '自动更新' }), element('p', { className: 'yl-settings-summary', text: '开启后，只会每隔设定秒数调用当前“聊天群”AI 预设；玩家发言不会触发额外调用。关闭时则在玩家发言后更新。' })]);
        const enabledField = element('label', { className: 'yl-switch yl-group-auto-switch' });
        const enabled = element('input', { type: 'checkbox', checked: current.enabled === true, ariaLabel: '开启聊天群自动更新' });
        enabledField.appendChild(enabled);
        const enabledLabel = element('label', { className: 'yl-settings-field' }); append(enabledLabel, [element('span', { text: '开启自动更新' }), enabledField]);
        const interval = element('input', { className: 'yl-settings-control', type: 'number', min: 5, max: 3600, value: String(Number.isInteger(current.intervalSeconds) ? current.intervalSeconds : DEFAULT_GROUP_AUTO_SETTINGS.intervalSeconds), inputMode: 'numeric', ariaLabel: '自动更新时间秒数', disabled: current.enabled !== true });
        const intervalField = element('label', { className: 'yl-settings-field' }); append(intervalField, [element('span', { text: '更新时间（s）' }), interval, element('span', { className: 'yl-settings-summary', text: '关闭时不可编辑；开启后可设为 5–3600 秒。仅在当前聊天群界面打开时运行。' })]);
        listen(enabled, enabled, 'change', () => { interval.disabled = !enabled.checked; }, ctx.abortController.signal);
        const autoRow = element('div', { className: 'yl-forum-auto-settings-row' }); append(autoRow, [enabledLabel, intervalField]);
        autoZone.appendChild(autoRow); ctx.groupAutoContent.appendChild(autoZone);
        const actions = element('div', { className: 'yl-settings-actions' });
        const cancel = element('button', { className: 'yl-settings-button yl-settings-button-secondary', type: 'button', text: '取消' });
        const confirm = element('button', { className: 'yl-settings-button', type: 'button', text: '确定' });
        listen(cancel, cancel, 'click', closeGroupAutoDialog, ctx.abortController.signal);
        listen(confirm, confirm, 'click', () => {
            const seconds = Number(interval.value);
            if (enabled.checked && (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600)) { ctx.setFeedback('更新时间请填写 5–3600 秒之间的整数。'); return; }
            const intervalSeconds = Number.isInteger(seconds) && seconds >= 5 && seconds <= 3600 ? seconds : DEFAULT_GROUP_AUTO_SETTINGS.intervalSeconds;
            if (!ctx.groupForumStore?.setGroupAuto) { ctx.setFeedback('本地聊天群缓存尚未就绪。'); return; }
            let presetSnapshot = null;
            try { presetSnapshot = ctx.settingsStore?.snapshot?.() ?? null; } catch { presetSnapshot = null; }
            // 预设列表不可用（快照缺失）时不写绑定，避免把已保存的绑定覆盖成空。
            const bindingAvailable = Boolean(presetSnapshot && Array.isArray(presetSnapshot.connectionPresets) && Array.isArray(presetSnapshot.promptPresets) && ctx.groupForumStore?.setGroupBinding);
            void (async () => {
                try {
                    await ctx.groupForumStore.setGroupAuto({ key: group.cacheKey, title: group.name, settings: { enabled: Boolean(enabled.checked), intervalSeconds } });
                    if (bindingAvailable) await ctx.groupForumStore.setGroupBinding({ key: group.cacheKey, title: group.name, contentMode, binding: bindingZone.getBinding() });
                    await syncGroupForumSnapshot({ rerender: false });
                    closeGroupAutoDialog();
                    ctx.setFeedback(enabled.checked ? `群设置已保存：预设绑定仅影响本群，自动更新每 ${intervalSeconds}s。` : '群设置已保存：预设绑定仅影响本群；自动更新已关闭，之后会在你发言后更新。');
                    ctx.renderPage(); syncGroupAutoTimer();
                } catch { ctx.setFeedback('群设置没有保存，请稍后重试。'); }
            })();
        }, ctx.abortController.signal);
        append(actions, [cancel, confirm]); ctx.groupAutoContent.appendChild(actions);
        ctx.openManagedDialog(ctx.groupAutoDialog, { onRequestClose: closeGroupAutoDialog });
    }
    function stopGroupAutoTimer() {
        if (ctx.groupAutoTimer !== null) clearInterval(ctx.groupAutoTimer);
        ctx.groupAutoTimer = null; ctx.groupAutoTimerKey = ''; ctx.groupAutoGeneration += 1;
    }
    function syncGroupAutoTimer() {
        const group = activeGroupCard();
        const auto = group ? (groupConversation(group).auto ?? DEFAULT_GROUP_AUTO_SETTINGS) : DEFAULT_GROUP_AUTO_SETTINGS;
        if (!ctx.open || ctx.activePage !== 'group_chat_room' || !group || auto.enabled !== true) { stopGroupAutoTimer(); return; }
        if (ctx.groupAutoTimer !== null && ctx.groupAutoTimerKey === group.cacheKey) return;
        stopGroupAutoTimer();
        const generation = ++ctx.groupAutoGeneration;
        ctx.groupAutoTimerKey = group.cacheKey;
        ctx.groupAutoTimer = setInterval(() => { void runGroupAutoUpdate(group.cacheKey, generation); }, auto.intervalSeconds * 1000);
    }
    async function runGroupAutoUpdate(cacheKey, generation) {
        if (ctx.isDestroyed || !ctx.open || ctx.activePage !== 'group_chat_room' || ctx.activeGroupCacheKey !== cacheKey || generation !== ctx.groupAutoGeneration) return;
        const group = activeGroupCard();
        if (!group || !ctx.actionBridge.generateGroupConversationUpdate || ctx.actionBridge.isPending?.('group_chat_update', cacheKey)) return;
        const activity = ctx.operationActivity.start('聊天群自动更新', '正在按设定时间更新当前聊天群。');
        let result;
        let bridgeError = null;
        try {
            result = await ctx.actionBridge.generateGroupConversationUpdate({
                group,
                history: localHistoryForModel(groupConversation(group)),
                trigger: 'auto',
                binding: localBindingForMode(groupConversation(group).bindings),
            });
        }
        catch (error) { bridgeError = error; result = { ok: false }; }
        if (ctx.isDestroyed || generation !== ctx.groupAutoGeneration || ctx.activeGroupCacheKey !== cacheKey) {
            ctx.operationActivity.dismiss(activity, '聊天群已离开，自动更新结果未展示。');
            return;
        }
        if (!result?.ok || !result.update) {
            ctx.operationActivity.fail(activity, '聊天群自动更新未完成。', { detail: communityFailureDetail('聊天群自动更新', result, bridgeError) });
            return;
        }
        try {
            await ctx.groupForumStore?.appendGroupModelUpdate?.({ key: group.cacheKey, title: group.name, update: result.update, members: group.members, reservedPlayerNickname: playerDisplayName({ forModel: true }) });
            await syncGroupForumSnapshot({ rerender: false });
            ctx.operationActivity.succeed(activity, '聊天群已按设定时间自动更新。');
            if (ctx.open && ctx.activePage === 'group_chat_room' && ctx.activeGroupCacheKey === cacheKey) ctx.renderPage();
            void maybeRunLocalAutomaticSummary({ kind: 'group', id: cacheKey, title: group.name });
        } catch (error) {
            ctx.operationActivity.fail(activity, '聊天群自动更新未保存到本地缓存。', { detail: localCacheFailureDetail('聊天群自动更新', error) });
        }
    }
    function closeForumSettingsDialog() {
        ctx.closeManagedDialog(ctx.forumSettingsDialog);
        ctx.forumSettingsContent.replaceChildren();
    }
    function buildLocalBindingZone({ title, description, binding, namePrefix } = {}) {
        const contentMode = currentContentMode();
        const zone = element('section', { className: 'yl-forum-settings-zone' });
        append(zone, [element('h3', { text: `${title} · ${contentMode}` }), element('p', { className: 'yl-settings-summary', text: description })]);
        let snapshot = null;
        try { snapshot = ctx.settingsStore?.snapshot?.() ?? null; } catch { snapshot = null; }
        const current = binding ?? blankLocalBinding();
        if (!snapshot || !Array.isArray(snapshot.connectionPresets) || !Array.isArray(snapshot.promptPresets)) {
            zone.appendChild(element('p', { className: 'yl-settings-summary', text: '预设列表暂不可用；保存后会保留空绑定并继续使用既有默认设置。' }));
            return { zone, getBinding: () => blankLocalBinding() };
        }
        const modePrompts = snapshot.promptPresets.filter((preset) => preset.contentMode === contentMode);
        const connection = element('select', { className: 'yl-settings-control', name: `${namePrefix}-connection`, ariaLabel: `${title}连接预设` });
        const prompt = element('select', { className: 'yl-settings-control', name: `${namePrefix}-prompt`, ariaLabel: `${title}提示词预设` });
        for (const [value, label] of [['', '使用默认连接'], ...snapshot.connectionPresets.map((preset) => [preset.id, preset.name])]) {
            const option = element('option', { value, text: label }); option.selected = value === (current.connectionPresetId ?? ''); connection.appendChild(option);
        }
        for (const [value, label] of [['', '不附加提示词预设'], ...modePrompts.map((preset) => [preset.id, preset.name])]) {
            const option = element('option', { value, text: label }); option.selected = value === (current.promptPresetId ?? ''); prompt.appendChild(option);
        }
        const fields = element('div', { className: 'yl-settings-fields' });
        const connectionField = element('label', { className: 'yl-settings-field' }); append(connectionField, [element('span', { text: '连接预设' }), connection]);
        const promptField = element('label', { className: 'yl-settings-field' }); append(promptField, [element('span', { text: '提示词预设' }), prompt]);
        append(fields, [connectionField, promptField]); zone.appendChild(fields);
        return { zone, getBinding: () => ({ connectionPresetId: connection.value || null, promptPresetId: prompt.value || null }) };
    }
    function openForumSettingsDialog() {
        const current = forumAutoSettings();
        ctx.forumSettingsTitle.textContent = '社区设置';
        ctx.forumSettingsContent.replaceChildren();
        ctx.forumSettingsContent.appendChild(element('p', {
            className: 'yl-phone-page-description',
            text: '频道更新只生成固定八频道的新帖子；帖子更新只改写已存在本地帖子的可见内容。两套连接与提示词预设互不影响，模型不能改变程序固定的数据框架。',
        }));
        const channelFields = buildLocalBindingZone({
            title: '频道更新区',
            description: '用于顶部替换刷新或底部追加刷新时生成新帖子。每次仍由代码强制生成八个固定频道各一篇。',
            binding: localBindingForMode(current.channelBindings),
            namePrefix: 'forum-channel',
        });
        ctx.forumSettingsContent.appendChild(channelFields.zone);
        const postZone = element('section', { className: 'yl-forum-settings-zone' });
        append(postZone, [element('h3', { text: '帖子更新区' }), element('p', { className: 'yl-settings-summary', text: '自动更新只改写所有已经存在的本地帖子；用户在帖子内发表评论后，也使用此处绑定来更新讨论。' })]);
        const enabledField = element('label', { className: 'yl-switch yl-group-auto-switch' });
        const enabled = element('input', { type: 'checkbox', checked: current.enabled === true, ariaLabel: '开启帖子自动更新' });
        enabledField.appendChild(enabled);
        const enabledLabel = element('label', { className: 'yl-settings-field' }); append(enabledLabel, [element('span', { text: '开启自动更新' }), enabledField]);
        const interval = element('input', { className: 'yl-settings-control', type: 'number', min: 5, max: 3600, inputMode: 'numeric', value: String(current.intervalSeconds), disabled: current.enabled !== true, ariaLabel: '帖子自动更新时间秒数' });
        const intervalField = element('label', { className: 'yl-settings-field' }); append(intervalField, [element('span', { text: '更新时间（s）' }), interval, element('span', { className: 'yl-settings-summary', text: '关闭时不可编辑；开启后可设为 5–3600 秒，仅在社区广场打开时运行。' })]);
        listen(enabled, enabled, 'change', () => { interval.disabled = !enabled.checked; }, ctx.abortController.signal);
        const autoRow = element('div', { className: 'yl-forum-auto-settings-row' }); append(autoRow, [enabledLabel, intervalField]);
        postZone.appendChild(autoRow);
        const postFields = buildLocalBindingZone({
            title: '帖子更新预设',
            description: '只影响帖子与评论的公开内容风格；帖子数量、频道、作者、临时角色、评论和 JSON 结构均由代码固定。',
            binding: localBindingForMode(current.postBindings),
            namePrefix: 'forum-post',
        });
        postZone.appendChild(postFields.zone); ctx.forumSettingsContent.appendChild(postZone);
        const actions = element('div', { className: 'yl-settings-actions' });
        const cancel = element('button', { className: 'yl-settings-button yl-settings-button-secondary', type: 'button', text: '取消' });
        const save = element('button', { className: 'yl-settings-button', type: 'button', text: '确定' });
        listen(cancel, cancel, 'click', closeForumSettingsDialog, ctx.abortController.signal);
        listen(save, save, 'click', () => {
            const seconds = Number(interval.value);
            if (enabled.checked && (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600)) { ctx.setFeedback('更新时间请填写 5–3600 秒之间的整数。'); return; }
            const intervalSeconds = Number.isInteger(seconds) && seconds >= 5 && seconds <= 3600 ? seconds : DEFAULT_FORUM_AUTO_SETTINGS.intervalSeconds;
            if (!ctx.groupForumStore?.setForumAuto) { ctx.setFeedback('社区广场自动更新设置暂不可用。'); return; }
            void (async () => {
                try {
                    await ctx.groupForumStore.setForumAuto({ settings: {
                        enabled: Boolean(enabled.checked), intervalSeconds,
                        channelBindings: withLocalBinding(current.channelBindings, channelFields.getBinding()),
                        postBindings: withLocalBinding(current.postBindings, postFields.getBinding()),
                    } });
                    await syncGroupForumSnapshot({ rerender: false });
                    closeForumSettingsDialog();
                    ctx.setFeedback(enabled.checked ? `帖子自动更新已开启：每 ${intervalSeconds}s 更新已有帖子。` : '帖子自动更新已关闭；频道刷新仍可创建新帖子。');
                    ctx.renderPage(); syncForumAutoTimer();
                } catch { ctx.setFeedback('社区广场自动更新设置没有保存，请稍后重试。'); }
            })();
        }, ctx.abortController.signal);
        append(actions, [cancel, save]); ctx.forumSettingsContent.appendChild(actions);
        ctx.openManagedDialog(ctx.forumSettingsDialog, { onRequestClose: closeForumSettingsDialog });
    }
    function stopForumAutoTimer() {
        if (ctx.forumAutoTimer !== null) clearInterval(ctx.forumAutoTimer);
        ctx.forumAutoTimer = null;
        ctx.forumAutoGeneration += 1;
    }
    function syncForumAutoTimer() {
        const auto = forumAutoSettings();
        if (forumDeletePendingId || !ctx.open || ctx.activePage !== 'group_forum' || auto.enabled !== true || !socialPosts().length) { stopForumAutoTimer(); return; }
        if (ctx.forumAutoTimer !== null) return;
        const generation = ++ctx.forumAutoGeneration;
        ctx.forumAutoTimer = setInterval(() => { void runForumExistingPostsAutoUpdate(generation); }, auto.intervalSeconds * 1000);
    }
    async function runForumExistingPostsAutoUpdate(generation) {
        if (forumDeletePendingId || ctx.isDestroyed || !ctx.open || ctx.activePage !== 'group_forum' || generation !== ctx.forumAutoGeneration || forumAutoSettings().enabled !== true) return;
        const posts = socialPosts();
        if (!posts.length || !ctx.actionBridge.generateForumExistingPostsUpdate || ctx.actionBridge.isPending?.('forum_existing_update', '')) return;
        const activity = ctx.operationActivity.start('社区广场自动更新', '正在更新所有已存在的本地帖子，不会生成新帖子。');
        let result;
        let bridgeError = null;
        try { result = await ctx.actionBridge.generateForumExistingPostsUpdate({ posts, binding: localBindingForMode(forumAutoSettings().postBindings) }); }
        catch (error) { bridgeError = error; result = { ok: false }; }
        if (ctx.isDestroyed || generation !== ctx.forumAutoGeneration || ctx.activePage !== 'group_forum') {
            ctx.operationActivity.dismiss(activity, '社区广场已离开，自动更新结果未展示。');
            return;
        }
        if (!result?.ok || !result.update) {
            ctx.operationActivity.fail(activity, '社区广场自动更新未完成。', { detail: communityFailureDetail('社区广场自动更新', result, bridgeError) });
            return;
        }
        try {
            await ctx.groupForumStore?.updateExistingForumPosts?.({ update: result.update });
            await syncGroupForumSnapshot({ rerender: false });
            ctx.operationActivity.succeed(activity, '已更新所有现有本地帖子；没有生成新帖子。');
            if (ctx.open && ctx.activePage === 'group_forum' && generation === ctx.forumAutoGeneration) ctx.renderPage();
        } catch (error) {
            ctx.operationActivity.fail(activity, '社区广场自动更新没有保存到本地缓存。', { detail: localCacheFailureDetail('社区广场自动更新', error) });
        }
    }
    function buildGroupListActionButton() {
        // §8.3-2：「创建群聊 / 查找群组」已提升为群聊列表顶部的 tonal 按钮，页头 ⋮ 菜单取消。
        return null;
    }
    function resetGroupRoomMenu() {
        ctx.groupRoomMenuOpen = false;
        ctx.groupRoomConfirmation = '';
        ctx.groupRoomConfirmationKey = '';
    }
    function buildGroupRoomActionButton(pageId) {
        if (pageId !== 'group_chat_room') return null;
        const group = activeGroupCard();
        if (!group) return null;
        const wrapper = element('div', { className: 'yl-private-chat-more-wrap yl-group-room-more-wrap' });
        const expanded = ctx.groupRoomMenuOpen && ctx.activeGroupCacheKey === group.cacheKey;
        const more = element('button', {
            className: 'yl-private-chat-more yl-group-room-more', type: 'button', text: '…',
            ariaLabel: `打开${group.name}的更多操作`, disabled: ctx.groupRoomDestructiveKey === group.cacheKey,
        });
        // Disclosure 按钮列表：同私聊更多操作，不宣称 role=menu。
        more.setAttribute('aria-expanded', String(expanded));
        listen(more, more, 'click', () => {
            ctx.groupRoomMenuOpen = !expanded;
            if (!ctx.groupRoomMenuOpen) { ctx.groupRoomConfirmation = ''; ctx.groupRoomConfirmationKey = ''; }
            ctx.renderPage();
        }, ctx.abortController.signal);
        wrapper.appendChild(more);
        if (expanded) {
            const menu = element('div', { className: 'yl-private-chat-more-menu yl-group-room-more-menu', ariaLabel: `${group.name}更多操作` });
            const exit = element('button', { className: 'yl-private-chat-menu-item is-danger', type: 'button', text: '退出群聊', ariaLabel: '退出群聊并删除本地群数据' });
            const clear = element('button', { className: 'yl-private-chat-menu-item', type: 'button', text: '清空群历史', ariaLabel: '仅清空当前聊天群历史' });
            // 群设置合并入口：预设绑定（连接+提示词）与自动更新在同一对话框内并列呈现，只在本群房间内可达。
            const settings = element('button', { className: 'yl-private-chat-menu-item', type: 'button', text: '群设置', ariaLabel: `打开${group.name}的群设置（预设绑定与自动更新）` });
            listen(exit, exit, 'click', () => { ctx.groupRoomMenuOpen = false; ctx.groupRoomConfirmation = 'exit'; ctx.groupRoomConfirmationKey = group.cacheKey; ctx.renderPage(); }, ctx.abortController.signal);
            listen(clear, clear, 'click', () => { ctx.groupRoomMenuOpen = false; ctx.groupRoomConfirmation = 'clear'; ctx.groupRoomConfirmationKey = group.cacheKey; ctx.renderPage(); }, ctx.abortController.signal);
            listen(settings, settings, 'click', () => { ctx.groupRoomMenuOpen = false; ctx.renderPage(); openGroupSettingsDialog(group); }, ctx.abortController.signal);
            append(menu, [exit, clear, settings]); wrapper.appendChild(menu);
        }
        return wrapper;
    }
    /** P3-G：群聊室/帖子讨论等待指示——与私聊同款三点打字气泡 + 说明文案（原纯文字指示升级，语义不变）。 */
    function buildLocalReplyingIndicator(text) {
        const replying = element('div', { className: 'yl-chat-replying yl-local-replying' });
        replying.setAttribute('role', 'status');
        const bubble = element('span', { className: 'yl-typing-bubble' });
        bubble.setAttribute('aria-hidden', 'true');
        for (let dotIndex = 0; dotIndex < 3; dotIndex += 1) bubble.appendChild(element('span', { className: 'yl-typing-dot' }));
        replying.appendChild(bubble);
        replying.appendChild(element('span', { className: 'yl-local-replying-text', text }));
        return replying;
    }
    function buildGroupChatPage() {
        persistCommunityTabPreference('chat');
        const section = element('section', { className: 'yl-group-list-page' });
        section.appendChild(buildCommunityTopbar('chat'));
        // §8.3-2：创建/查找从 ⋮ 菜单提升为列表顶部两个 tonal 按钮。
        const actions = element('div', { className: 'yl-community-actions' });
        actions.appendChild(createButton({
            documentRef: ctx.documentRef, variant: 'tonal', label: '创建群聊', icon: 'plus',
            onClick: () => ctx.setActivePage('group_chat_create'),
        }));
        actions.appendChild(createButton({
            documentRef: ctx.documentRef, variant: 'tonal', label: ctx.groupSearchOpen ? '收起查找' : '查找群组', icon: 'search',
            onClick: () => { ctx.groupSearchOpen = !ctx.groupSearchOpen; ctx.renderPage(); },
        }));
        section.appendChild(actions);
        const results = element('div', { className: 'yl-group-room-results' });
        // P3-G：列表首屏交错入场只在本次构建的第一次渲染出现；查找输入的局部重渲不重复播放。
        let firstGroupResultsRender = true;
        const renderGroupResults = () => {
            results.classList.toggle('yl-stagger-in', firstGroupResultsRender);
            firstGroupResultsRender = false;
            const query = ctx.groupSearchQuery.trim().toLocaleLowerCase('zh-CN');
            const groups = currentGroupCards().filter((group) => !query || `${group.name} ${group.description} ${groupParticipants(group).map((profile) => profile.nickname).join(' ')}`.toLocaleLowerCase('zh-CN').includes(query));
            if (!groups.length) {
                results.replaceChildren(createEmptyState({
                    documentRef: ctx.documentRef, variant: query ? 'search' : 'inbox',
                    title: query ? '没有找到匹配的聊天群。' : '还没有聊天群。',
                    hint: query ? '换个群名或成员昵称再试试。' : '点上方「创建群聊」开始，或等待卡片提供公开群组。',
                }));
                return;
            }
            const list = element('div', { className: 'yl-group-room-list' });
            for (const group of groups) {
                const thread = groupConversation(group);
                const participants = groupParticipants(group);
                const last = thread.messages?.at?.(-1);
                const auto = thread.auto?.enabled === true ? ` · 自动 ${thread.auto.intervalSeconds}s` : '';
                // §8.3-1：叠放成员头像组（最多 3 个 + “+N”）。
                const stack = element('span', { className: 'yl-group-avatar-stack' });
                for (const profile of participants.slice(0, 3)) stack.appendChild(ctx.publicAvatar(safeLocalDisplayProfile(profile), { className: 'yl-group-room-avatar yl-group-stack-avatar', imageEnabled: true, interactive: false }));
                if (participants.length > 3) stack.appendChild(element('span', { className: 'yl-group-stack-more', text: `+${participants.length - 3}` }));
                const row = createListRow({
                    documentRef: ctx.documentRef,
                    avatar: stack,
                    title: group.name,
                    subtitle: last ? `${last.sender === 'user' ? '我' : (last.author?.nickname || '群友')}：${last.content}` : `${participants.length} 位成员${auto}`,
                    meta: { time: (last && relativeTimeLabel(last.createdAt)) || undefined, chevron: true },
                    onClick: () => { ctx.activeGroupCacheKey = group.cacheKey; ctx.setActivePage('group_chat_room'); },
                });
                row.setAttribute('aria-label', `打开${group.name}`);
                list.appendChild(row);
            }
            results.replaceChildren(list);
        };
        if (ctx.groupSearchOpen) {
            const input = element('input', { className: 'yl-settings-control yl-group-search-input', type: 'search', maxLength: 120, value: ctx.groupSearchQuery, placeholder: '查找群名或成员昵称', ariaLabel: '查找聊天群' });
            // 输入节点保持稳定，只替换结果列表：整页重建会丢失焦点、光标与中文 IME 组合输入。
            listen(input, input, 'input', () => { ctx.groupSearchQuery = input.value; renderGroupResults(); }, ctx.abortController.signal);
            section.appendChild(input);
        }
        renderGroupResults();
        section.appendChild(results);
        return section;
    }
    function buildGroupChatCreatePage() {
        const section = element('section', { className: 'yl-settings-panel yl-group-create-page' });
        const name = element('input', { className: 'yl-settings-control', type: 'text', maxLength: 80, value: ctx.groupCreateName, placeholder: '例如：同城周末搭子', ariaLabel: '编辑群名' });
        listen(name, name, 'input', () => { ctx.groupCreateName = name.value; }, ctx.abortController.signal);
        const nameField = element('label', { className: 'yl-settings-field' }); append(nameField, [element('span', { text: '编辑群名' }), name]); section.appendChild(nameField);
        const memberField = element('section', { className: 'yl-group-create-members' });
        memberField.appendChild(element('strong', { text: '添加私聊角色' }));
        memberField.appendChild(element('p', { className: 'yl-settings-summary', text: '只会复制角色公开资料到当前浏览器的本地群聊。' }));
        memberField.appendChild(createButton({
            documentRef: ctx.documentRef, variant: 'tonal', label: '选择私聊角色', icon: 'plus',
            onClick: () => openGroupMemberPicker(),
        }));
        if (!ctx.groupCreateMembers.length) memberField.appendChild(element('p', { className: 'yl-phone-page-description', text: '尚未选择角色。' }));
        else {
            const members = element('div', { className: 'yl-group-create-selected-list' });
            for (const profile of ctx.groupCreateMembers) {
                const row = element('div', { className: 'yl-group-create-selected' });
                const display = safeLocalDisplayProfile(profile);
                row.appendChild(ctx.publicAvatar(display, { className: 'yl-group-member-avatar', imageEnabled: true, interactive: false }));
                row.appendChild(element('span', { text: display.昵称 }));
                const remove = ctx.applyCloseIcon(element('button', { className: 'yl-dialog-close', type: 'button', ariaLabel: `移除${display.昵称}` }));
                listen(remove, remove, 'click', () => { ctx.groupCreateMembers = ctx.groupCreateMembers.filter((item) => item.nickname !== profile.nickname); ctx.renderPage(); }, ctx.abortController.signal);
                row.appendChild(remove); members.appendChild(row);
            }
            memberField.appendChild(members);
        }
        section.appendChild(memberField);
        const actions = element('div', { className: 'yl-settings-actions' });
        actions.appendChild(createButton({
            documentRef: ctx.documentRef, variant: 'ghost', label: '取消',
            onClick: () => { ctx.groupCreateName = ''; ctx.groupCreateMembers = []; ctx.setActivePage('group_chat'); },
        }));
        actions.appendChild(createButton({
            documentRef: ctx.documentRef, variant: 'primary', label: '确认创建',
            onClick: () => {
                const title = ctx.groupCreateName.trim();
                if (!title || !ctx.groupCreateMembers.length) { ctx.setFeedback('请填写群名，并至少添加一位私聊角色。'); return; }
                if (!ctx.groupForumStore?.createGroup) { ctx.setFeedback('本地聊天群缓存尚未就绪。'); return; }
                void (async () => {
                    try {
                        const created = await ctx.groupForumStore.createGroup({ name: title, members: ctx.groupCreateMembers });
                        await syncGroupForumSnapshot({ rerender: false });
                        ctx.activeGroupCacheKey = created.id; ctx.groupCreateName = ''; ctx.groupCreateMembers = [];
                        ctx.setFeedback('聊天群已创建，仅保存在当前浏览器。'); ctx.setActivePage('group_chat_room');
                    } catch { ctx.setFeedback('聊天群没有创建成功，请检查名称和成员后重试。'); }
                })();
            },
        }));
        section.appendChild(actions);
        return section;
    }
    function buildParticipantMeta(profile) {
        const meta = element('span', { className: 'yl-local-profile-meta' });
        const parts = [profile.gender, profile.ageRange, profile.city, profile.mbti, profile.zodiac].filter(Boolean);
        meta.textContent = parts.join(' · ');
        return meta;
    }
    function buildGroupRoomConfirmation(group) {
        if (ctx.groupRoomConfirmationKey !== group.cacheKey || !['exit', 'clear'].includes(ctx.groupRoomConfirmation)) return null;
        const exiting = ctx.groupRoomConfirmation === 'exit';
        const pending = ctx.groupRoomDestructiveKey === group.cacheKey;
        const confirmation = element('section', { className: exiting ? 'yl-chat-delete-confirmation yl-group-room-confirmation is-group-exit' : 'yl-chat-clear-confirmation yl-group-room-confirmation is-group-clear' });
        if (exiting) {
            append(confirmation, [
                element('strong', { text: `退出${group.name}？` }),
                element('p', { text: group.scope === 'local' ? '这会删除该本地群、聊天历史、自动更新设置、临时群友和群聊总结，无法在此界面恢复。' : '这只会删除本小手机中该群的本地缓存并从本地列表隐藏，不会修改 MVU 群组或酒馆正文。' }),
            ]);
        } else {
            append(confirmation, [
                element('strong', { text: '清空当前群历史？' }),
                element('p', { text: '只会删除聊天消息、临时群友和群聊总结；群名、原成员与该群独立的自动更新设置会保留。' }),
            ]);
        }
        const actions = element('div', { className: 'yl-chat-delete-actions' });
        const cancel = element('button', { className: 'yl-settings-button yl-settings-button-secondary', type: 'button', text: '取消', disabled: pending });
        const confirm = element('button', { className: exiting ? 'yl-settings-button yl-chat-delete-confirm' : 'yl-settings-button yl-chat-clear-confirm', type: 'button', text: pending ? '正在处理…' : (exiting ? '确认退出' : '确认清空'), disabled: pending, ariaLabel: exiting ? '确认退出群聊' : '确认清空群历史' });
        listen(cancel, cancel, 'click', () => { resetGroupRoomMenu(); ctx.renderPage(); }, ctx.abortController.signal);
        listen(confirm, confirm, 'click', () => { void runGroupRoomDataAction(group, ctx.groupRoomConfirmation); }, ctx.abortController.signal);
        append(actions, [cancel, confirm]); confirmation.appendChild(actions);
        return confirmation;
    }
    async function runGroupRoomDataAction(group, kind) {
        if (!group || ctx.groupRoomDestructiveKey || !['exit', 'clear'].includes(kind)) return;
        const action = kind === 'exit' ? ctx.groupForumStore?.exitGroup : ctx.groupForumStore?.clearGroupHistory;
        if (typeof action !== 'function') { ctx.setFeedback(kind === 'exit' ? '退出群聊功能暂不可用。' : '清空群历史功能暂不可用。'); return; }
        ctx.groupRoomDestructiveKey = group.cacheKey;
        stopGroupAutoTimer();
        ctx.renderPage();
        try {
            if (kind === 'exit') await action({ key: group.cacheKey });
            else await action({ key: group.cacheKey, title: group.name });
            await syncGroupForumSnapshot({ rerender: false });
            ctx.groupRoomDestructiveKey = '';
            resetGroupRoomMenu();
            if (kind === 'exit') {
                ctx.activeGroupCacheKey = '';
                ctx.setFeedback('已退出群聊并删除本地群数据。');
                ctx.setActivePage('group_chat');
            } else {
                ctx.setFeedback('群历史已清空；该群自动更新设置已保留。');
                ctx.renderPage(); syncGroupAutoTimer();
            }
        } catch {
            ctx.groupRoomDestructiveKey = '';
            ctx.setFeedback(kind === 'exit' ? '退出群聊未完成，请稍后重试。' : '群历史没有清空，请稍后重试。');
            ctx.renderPage(); syncGroupAutoTimer();
        }
    }
    // §8.3-3：群聊室复用私聊新气泡体系（时间分组、连续合并、字号规格由 chat 子区 CSS 统一），
    // 差异仅是发言人昵称按稳定哈希追加 yl-name-tone-0..5。
    function buildGroupTimeline(group, conversation) {
        const timeline = element('div', { className: 'yl-chat-timeline yl-group-timeline', ariaLabel: `${group.name}的聊天记录` });
        const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
        if (!messages.length) {
            timeline.appendChild(element('div', { className: 'yl-system-pill', text: '还没有群消息。说句话开始吧；关闭自动更新时，群友会在你发言后回应。' }));
            return timeline;
        }
        timeline.appendChild(element('div', { className: 'yl-system-pill', text: '群聊只保存在当前浏览器，仅展示公开资料。' }));
        for (const run of groupMessageRuns(messages)) {
            if (run.dividerTs !== null) timeline.appendChild(element('div', { className: 'yl-time-divider', text: timeDividerLabel(run.dividerTs) }));
            const groupNode = element('section', { className: run.isUser ? 'yl-msg-group yl-msg-group--self yl-group-msg' : 'yl-msg-group yl-msg-group--peer yl-group-msg' });
            const body = element('div', { className: 'yl-group-msg-body' });
            if (!run.isUser) {
                const display = safeLocalDisplayProfile(run.messages[0]?.author);
                groupNode.appendChild(ctx.publicAvatar(display, { className: 'yl-local-message-avatar yl-group-msg-avatar', imageEnabled: true, interactive: false }));
                body.appendChild(element('span', { className: `yl-bubble-name ${nameToneClass(display.昵称)}`, text: display.昵称 }));
            }
            for (const message of run.messages) {
                const bubble = element('article', { className: 'yl-bubble' });
                bubble.appendChild(element('p', { text: message.content }));
                if (!run.isUser && message.imageDirective) {
                    const imageCard = ctx.buildImageDirectiveCard({
                        kind: 'group', conversationId: group.cacheKey, messageId: message.id, characterUid: ctx.localProfileCharacterUid(message.author), directive: message.imageDirective,
                    });
                    if (imageCard) bubble.appendChild(imageCard);
                }
                body.appendChild(bubble);
            }
            if (run.lastTs !== null) body.appendChild(element('span', { className: 'yl-bubble-time', text: formatClockTime(run.lastTs) }));
            groupNode.appendChild(body);
            timeline.appendChild(groupNode);
        }
        return timeline;
    }
    function buildGroupChatRoomPage() {
        const group = activeGroupCard();
        if (!group) return createEmptyState({ documentRef: ctx.documentRef, variant: 'search', title: '当前聊天群已变化', hint: '请返回列表重新选择。' });
        const conversation = groupConversation(group);
        const section = element('section', { className: 'yl-local-conversation yl-group-chat-room' });
        const hero = element('section', { className: 'yl-local-conversation-hero' });
        const copy = element('div', { className: 'yl-local-conversation-hero-copy' });
        append(copy, [element('h2', { text: group.name }), element('p', { text: group.description })]);
        const auto = conversation.auto ?? DEFAULT_GROUP_AUTO_SETTINGS;
        const actions = element('div', { className: 'yl-local-conversation-actions' });
        const summary = element('button', { className: 'yl-settings-button yl-settings-button-secondary', type: 'button', text: '聊天总结', disabled: !ctx.chatSummaryEnabled(), ariaLabel: '查看聊天群总结' });
        listen(summary, summary, 'click', () => { ctx.localSummaryTarget = { kind: 'group', id: group.cacheKey, title: group.name }; ctx.setActivePage('group_chat_summary'); }, ctx.abortController.signal);
        append(actions, [summary, ctx.buildConversationImageControls({ kind: 'group', conversationId: group.cacheKey })]); append(hero, [copy, actions]); section.appendChild(hero);
        const confirmation = buildGroupRoomConfirmation(group);
        if (confirmation) section.appendChild(confirmation);
        const participants = groupParticipants(group);
        const people = element('div', { className: 'yl-local-participant-strip', ariaLabel: '群成员' });
        for (const profile of participants.slice(0, 20)) {
            const member = element('span', { className: 'yl-local-participant' });
            member.appendChild(ctx.publicAvatar(safeLocalDisplayProfile(profile), { className: 'yl-group-member-avatar', imageEnabled: true, interactive: false }));
            const memberCopy = element('span', { className: 'yl-local-participant-copy' });
            memberCopy.appendChild(element('strong', { text: profile.nickname })); memberCopy.appendChild(buildParticipantMeta(profile));
            member.appendChild(memberCopy); people.appendChild(member);
        }
        section.appendChild(people);
        section.appendChild(buildGroupTimeline(group, conversation));
        if (ctx.actionBridge.isPending?.('group_chat_update', group.cacheKey)) section.appendChild(buildLocalReplyingIndicator('群友正在更新···'));
        const composer = element('section', { className: 'yl-chat-composer yl-local-composer' });
        const pending = Boolean(ctx.actionBridge.isPending?.('group_chat_update', group.cacheKey));
        const input = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 2, maxLength: 600, value: ctx.groupMessageDrafts.get(group.cacheKey) ?? '', placeholder: '说点什么…', ariaLabel: '输入群消息', disabled: pending });
        const send = element('button', { className: 'yl-chat-send-button', type: 'button', text: pending ? '···' : '发送', disabled: pending, ariaLabel: pending ? '群聊正在更新' : '发送群消息' });
        listen(input, input, 'input', () => { ctx.groupMessageDrafts.set(group.cacheKey, input.value); }, ctx.abortController.signal);
        listen(input, input, 'keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault?.(); void sendGroupMessage(group); } }, ctx.abortController.signal);
        listen(send, send, 'click', () => { void sendGroupMessage(group); }, ctx.abortController.signal);
        append(composer, [input, send, element('span', { className: 'yl-chat-composer-hint', text: auto.enabled ? `自动更新已开启，每 ${auto.intervalSeconds}s 更新 · Shift+Enter 换行` : '发送后群友会更新 · Shift+Enter 换行' })]); section.appendChild(composer);
        return section;
    }
    async function sendGroupMessage(group) {
        const content = String(ctx.groupMessageDrafts.get(group.cacheKey) ?? '').trim();
        if (!content) { ctx.setFeedback('请先输入群消息。'); return; }
        if (!ctx.groupForumStore?.appendGroupUserMessage) { ctx.setFeedback('本地聊天群缓存尚未就绪。'); return; }
        try {
            await ctx.groupForumStore.appendGroupUserMessage({ key: group.cacheKey, title: group.name, content });
            ctx.groupMessageDrafts.delete(group.cacheKey); await syncGroupForumSnapshot({ rerender: false }); ctx.renderPage();
        } catch { ctx.setFeedback('群消息没有保存到本地缓存。'); return; }
        const auto = groupConversation(group).auto ?? DEFAULT_GROUP_AUTO_SETTINGS;
        if (auto.enabled) {
            ctx.setFeedback(`消息已发送；自动更新将在 ${auto.intervalSeconds}s 后运行。`);
            void maybeRunLocalAutomaticSummary({ kind: 'group', id: group.cacheKey, title: group.name });
            return;
        }
        await runGroupConversationUpdate(group, 'user');
    }
    async function runGroupConversationUpdate(group, trigger) {
        if (!ctx.actionBridge.generateGroupConversationUpdate || ctx.actionBridge.isPending?.('group_chat_update', group.cacheKey)) return;
        const activity = ctx.operationActivity.start('聊天群更新', '正在生成群友的本地更新。');
        ctx.renderPage();
        let result;
        let bridgeError = null;
        try {
            result = await ctx.actionBridge.generateGroupConversationUpdate({
                group,
                history: localHistoryForModel(groupConversation(group)),
                trigger,
                binding: localBindingForMode(groupConversation(group).bindings),
            });
        }
        catch (error) { bridgeError = error; result = { ok: false }; }
        if (ctx.isDestroyed || ctx.activeGroupCacheKey !== group.cacheKey) { ctx.operationActivity.dismiss(activity, '聊天群已离开，更新结果未展示。'); return; }
        if (!result?.ok || !result.update) {
            ctx.operationActivity.fail(activity, '聊天群更新未完成。', { detail: communityFailureDetail('聊天群更新', result, bridgeError) });
            ctx.setFeedback(result?.message || '聊天群更新未完成，请稍后重试。'); ctx.renderPage(); return;
        }
        try {
            await ctx.groupForumStore?.appendGroupModelUpdate?.({ key: group.cacheKey, title: group.name, update: result.update, members: group.members, reservedPlayerNickname: playerDisplayName({ forModel: true }) });
            await syncGroupForumSnapshot({ rerender: false });
            ctx.operationActivity.succeed(activity, '聊天群已更新到本地缓存。'); ctx.renderPage();
            void maybeRunLocalAutomaticSummary({ kind: 'group', id: group.cacheKey, title: group.name });
        } catch (error) {
            ctx.operationActivity.fail(activity, '聊天群更新没有保存到本地缓存。', { detail: localCacheFailureDetail('聊天群更新', error) });
            ctx.setFeedback('聊天群更新没有保存到本地缓存。');
        }
    }
    function forumIsAtTop(surface) {
        const contentTop = Number(ctx.content?.scrollTop);
        const surfaceTop = Number(surface?.scrollTop);
        return !(Number.isFinite(contentTop) && contentTop > 0) && !(Number.isFinite(surfaceTop) && surfaceTop > 0);
    }
    function forumIsAtBottom(surface) {
        const measurements = [ctx.content, surface].map((node) => ({
            scrollTop: Number(node?.scrollTop),
            scrollHeight: Number(node?.scrollHeight),
            clientHeight: Number(node?.clientHeight),
        })).filter((item) => Number.isFinite(item.scrollHeight) && Number.isFinite(item.clientHeight) && item.clientHeight > 0);
        const overflowing = measurements.filter((item) => item.scrollHeight > item.clientHeight);
        if (overflowing.length) {
            return overflowing.some((item) => Math.max(0, item.scrollTop || 0) >= item.scrollHeight - item.clientHeight - 2);
        }
        // A filtered channel may contain only one post and therefore have no
        // scroll range. It is already both the top and the bottom: allow a
        // downward wheel / upward touch pull to request the next local batch.
        return measurements.some((item) => item.scrollHeight > 0 && item.scrollHeight <= item.clientHeight);
    }
    // 指示器视觉现代化（§8.2-3）：字符箭头 ↻/↓ 换本地 refresh SVG + 文案，品牌色旋转由 community 子区 CSS 承担。
    function setForumPullIndicatorContent(indicator, text) {
        if (!indicator || typeof indicator.replaceChildren !== 'function') return;
        indicator.replaceChildren(
            createUiIcon(ctx.documentRef, 'refresh', { className: 'yl-forum-pull-svg', size: 14 }),
            element('span', { text }),
        );
    }
    function resetForumPullIndicator(indicator, kind = 'replace') {
        if (!indicator) return;
        indicator.classList.toggle('is-visible', false); indicator.classList.toggle('is-armed', false); indicator.classList.toggle('is-refreshing', false); indicator.classList.toggle('is-append', kind === 'append');
        indicator.style?.setProperty?.('--yl-forum-pull-offset', '0px');
        setForumPullIndicatorContent(indicator, kind === 'append' ? '上拉加载更多' : '下拉刷新');
    }
    function forumPullParkOffset() {
        const height = Number(ctx.content?.clientHeight);
        const base = Number.isFinite(height) && height > 0 ? height * FORUM_PULL_PARK_RATIO : FORUM_PULL_PARK_FALLBACK;
        return Math.round(Math.min(FORUM_PULL_PARK_MAX, Math.max(FORUM_PULL_PARK_MIN, base)));
    }
    // 实测停靠行程：徽标静止位置由 CSS 决定（顶部徽标藏在可视区上方、追加徽标贴在帖子流末尾），
    // 所以「停在 1/4 窗口」= 1/4 窗口高 − 静止位置到该侧边缘的既有距离。一次手势只量一次。
    function measureForumPullPark(indicator, kind) {
        const box = ctx.content?.getBoundingClientRect?.();
        const rect = indicator?.getBoundingClientRect?.();
        if (!box || !rect || !(box.height > 0)) return forumPullParkOffset();
        const rest = kind === 'append' ? box.bottom - rect.bottom : rect.top - box.top;
        // .yl-phone-panel 常态带 scale(0.97)，getBoundingClientRect 给的是缩放后的屏幕像素，
        // 而 --yl-forum-pull-offset 写进去的是 CSS 像素；不除以缩放比，停靠点会短 3%。
        const height = Number(ctx.content?.clientHeight);
        const scale = Number.isFinite(height) && height > 0 ? box.height / height : 1;
        const park = (box.height * FORUM_PULL_PARK_RATIO - rest) / (scale > 0 ? scale : 1);
        return Math.round(Math.min(FORUM_PULL_PARK_MAX, Math.max(FORUM_PULL_PARK_MIN, park)));
    }
    // 手指/滚轮行进距离 → 指示器位移：到达阈值正好停在 1/4 窗口，之后只有阻尼余量。
    function forumPullTravel(distance, park = forumPullParkOffset()) {
        const reach = Math.max(0, Number(distance) || 0);
        if (reach <= 0) return 0;
        if (reach < FORUM_PULL_THRESHOLD) return Math.round((park * reach) / FORUM_PULL_THRESHOLD);
        return park + Math.min(FORUM_PULL_OVERSHOOT, Math.round((reach - FORUM_PULL_THRESHOLD) * 0.18));
    }
    // 追加指示器挂在帖子流末尾，位移必须朝「上」：正位移会把它推出可视区，而且被 transform
    // 撑大的滚动范围会让 forumIsAtBottom() 立刻变假，把上拉手势自己掐断（真机上就是「上拉没反应」）。
    function applyForumPullOffset(indicator, kind, travel) {
        const signed = kind === 'append' ? -travel : travel;
        indicator?.style?.setProperty?.('--yl-forum-pull-offset', `${signed}px`);
    }
    // 刷新进行中：把指示器钉在 1/4 窗口停靠点，和手势松手那一刻的位置一致。
    function parkForumPullIndicator(indicator, kind = 'replace') {
        if (!indicator) return;
        applyForumPullOffset(indicator, kind, forumPullParkOffset());
    }
    // renderPage 之后指示器已经挂载，可以按实测几何把「正在刷新」的徽标精确对到 1/4 窗口。
    function parkMountedForumIndicator(kind) {
        const indicator = ctx.content?.querySelector?.('.yl-forum-pull-indicator.is-refreshing');
        if (!indicator) return;
        applyForumPullOffset(indicator, kind, measureForumPullPark(indicator, kind));
    }
    function updateForumPullIndicator(indicator, distance, armed, { source = 'touch', kind = 'replace', park = undefined } = {}) {
        if (!indicator) return;
        applyForumPullOffset(indicator, kind, forumPullTravel(distance, park ?? forumPullParkOffset()));
        indicator.classList.toggle('is-visible', distance > 0); indicator.classList.toggle('is-armed', armed); indicator.classList.toggle('is-append', kind === 'append');
        if (kind === 'append') {
            setForumPullIndicatorContent(indicator, armed ? (source === 'wheel' ? '停止滚轮以加载' : '松开加载更多') : (source === 'wheel' ? '向下滚动加载' : '继续上拉加载'));
        } else {
            setForumPullIndicatorContent(indicator, armed ? (source === 'wheel' ? '停止滚轮以刷新' : '松开刷新') : (source === 'wheel' ? '向上滚动刷新' : '继续下拉'));
        }
    }
    function cancelForumWheelPull() {
        const state = ctx.forumWheelPullState;
        if (!state) return;
        if (state.releaseTimer !== null) clearTimeout(state.releaseTimer);
        ctx.forumWheelPullState = null;
        resetForumPullIndicator(state.indicator, state.kind);
    }
    function cancelForumPullInteractions() {
        const pointer = ctx.forumPullState;
        ctx.forumPullState = null;
        if (pointer?.indicator) resetForumPullIndicator(pointer.indicator, pointer.kind);
        cancelForumWheelPull();
        const controller = ctx.forumInteractionAbortController;
        ctx.forumInteractionAbortController = null;
        controller?.abort?.();
    }
    function normalizedWheelDelta(event) {
        const raw = Number(event?.deltaY);
        if (!Number.isFinite(raw) || raw === 0) return 0;
        const mode = Number(event?.deltaMode);
        if (mode === 1) return raw * 16;
        if (mode === 2) return raw * Math.max(120, Number(ctx.content?.clientHeight) || 480);
        return raw;
    }
    function bindForumPullToRefresh(surface, replacementIndicator, appendIndicator) {
        const controller = new AbortController();
        ctx.forumInteractionAbortController = controller;
        // 触摸手势必须由 Touch Events 主导：只有非 passive 的 touchmove 能 preventDefault，
        // 把竖向手势从浏览器原生滚动 / overscroll 手里接过来。Chrome 的真实派发顺序是
        // pointerdown → touchstart，旧实现让 pointer 分支先占住状态（PointerEvent 根本没有
        // inputType，判断永远落到 'pointer'），于是 touchMove 整段跳过、preventDefault 永不执行，
        // 真机上只会把页面拽出橡皮筋然后收到 pointercancel——这就是「下拉失效」的根因。
        const view = ctx.documentRef?.defaultView ?? null;
        const touchEventsAvailable = typeof view?.TouchEvent === 'function' || typeof globalThis.TouchEvent === 'function';
        const clearPull = (state) => {
            if (ctx.forumPullState === state) ctx.forumPullState = null;
            if (state.inputType === 'pointer') {
                try { surface.releasePointerCapture?.(state.pointerId); } catch { /* 捕获可能已随手势结束释放。 */ }
            }
            resetForumPullIndicator(state.indicator, state.kind);
        };
        const ensurePark = (state) => {
            if (state.park === null) state.park = measureForumPullPark(state.indicator, state.kind);
            return state.park;
        };
        const start = (event) => {
            if (ctx.forumRefreshing || event?.isPrimary === false || event?.pointerType === 'mouse') return;
            if (event?.pointerType === 'touch' && event?.inputType !== 'touch' && touchEventsAvailable) return;
            if (ctx.forumPullState) return;
            const atTop = forumIsAtTop(surface);
            const atBottom = forumIsAtBottom(surface);
            const kind = atTop && atBottom ? 'pending' : (atTop ? 'replace' : (atBottom ? 'append' : ''));
            if (!kind) return;
            cancelForumWheelPull();
            ctx.forumPullState = {
                pointerId: event?.pointerId,
                startX: Number(event?.clientX) || 0,
                startY: Number(event?.clientY) || 0,
                distance: 0,
                origin: kind,
                kind,
                park: null,
                direction: kind === 'append' ? -1 : (kind === 'replace' ? 1 : 0),
                indicator: kind === 'append' ? appendIndicator : (kind === 'replace' ? replacementIndicator : null),
                inputType: event?.inputType === 'touch' ? 'touch' : 'pointer',
                owned: false,
            };
            if (ctx.forumPullState.inputType === 'pointer') surface.setPointerCapture?.(event?.pointerId);
        };
        const move = (event) => {
            const state = ctx.forumPullState;
            if (!state || (state.pointerId !== undefined && event?.pointerId !== undefined && state.pointerId !== event.pointerId)) return;
            // 触摸手势只认 touchmove；同一根手指的 pointermove 是重复播报，跳过以免双写。
            if (state.inputType === 'touch' && event?.inputType !== 'touch') return;
            const movement = (Number(event?.clientY) || 0) - state.startY;
            const drift = (Number(event?.clientX) || 0) - state.startX;
            if (!state.owned && Math.abs(drift) > Math.abs(movement) + FORUM_PULL_AXIS_SLACK) { clearPull(state); return; }
            if (state.kind === 'pending') {
                if (movement === 0) return;
                state.kind = movement < 0 ? 'append' : 'replace';
                state.direction = state.kind === 'append' ? -1 : 1;
                state.indicator = state.kind === 'append' ? appendIndicator : replacementIndicator;
                state.park = null;
            }
            // 边界只在手势尚未接管前复测：接管之后我们每一帧都 preventDefault，滚动位置不可能再变，
            // 重复测量只会被指示器自身的布局变化误伤（追加指示器一动就撑大 scrollHeight）。
            if (!state.owned && !(state.kind === 'replace' ? forumIsAtTop(surface) : forumIsAtBottom(surface))) { clearPull(state); return; }
            const distance = movement * state.direction;
            if (distance <= 0) {
                // 反向：按钮快速回到起点并消失，本轮不提交，滚动交还浏览器；
                // 手指再拉回来可以重新蓄力——不再有「抖动 4px 就永久作废」的闩锁。
                state.distance = 0; state.owned = false;
                resetForumPullIndicator(state.indicator, state.kind);
                if (state.origin === 'pending') { state.kind = 'pending'; state.direction = 0; state.indicator = null; state.park = null; }
                return;
            }
            state.owned = true;
            state.distance = distance;
            updateForumPullIndicator(state.indicator, distance, distance >= FORUM_PULL_THRESHOLD, { source: 'touch', kind: state.kind, park: ensurePark(state) });
            event?.preventDefault?.();
        };
        const end = (event) => {
            const state = ctx.forumPullState;
            if (!state || (state.pointerId !== undefined && event?.pointerId !== undefined && state.pointerId !== event.pointerId)) return;
            if (state.inputType === 'touch' && event?.inputType !== 'touch') return;
            // 松手当下的实时距离决定提交：停在 1/4 窗口停靠点（阈值）以上才刷新。
            const shouldRefresh = state.kind !== 'pending' && state.distance >= FORUM_PULL_THRESHOLD;
            clearPull(state);
            if (shouldRefresh) void runForumHomeRefresh({ mode: state.kind });
        };
        // 中断（浏览器接管手势、系统打断、多指干扰）一律作废，绝不能当成「松手确认」去刷新。
        const cancelGesture = () => {
            const state = ctx.forumPullState;
            if (state) clearPull(state);
        };
        const touchPoint = (event, pointerId = undefined) => {
            const points = [...(event?.touches ?? []), ...(event?.changedTouches ?? [])];
            if (pointerId === undefined) return points[0] ?? null;
            return points.find((point) => point?.identifier === pointerId) ?? null;
        };
        const touchStart = (event) => {
            const point = touchPoint(event);
            if (!point) return;
            start({ pointerId: point.identifier, clientX: point.clientX, clientY: point.clientY, isPrimary: true, inputType: 'touch' });
        };
        const touchMove = (event) => {
            const state = ctx.forumPullState;
            if (!state || state.inputType !== 'touch') return;
            const point = touchPoint(event, state.pointerId);
            if (!point) return;
            move({ pointerId: point.identifier, clientX: point.clientX, clientY: point.clientY, inputType: 'touch', preventDefault: () => event.preventDefault?.() });
        };
        const touchEnd = (event) => {
            const state = ctx.forumPullState;
            if (!state || state.inputType !== 'touch') return;
            const point = touchPoint(event, state.pointerId);
            end({ pointerId: point?.identifier ?? state.pointerId, inputType: 'touch' });
        };
        const settleWheelPull = (state) => {
            if (state.releaseTimer !== null) clearTimeout(state.releaseTimer);
            state.releaseTimer = setTimeout(() => {
                if (ctx.forumWheelPullState !== state) return;
                ctx.forumWheelPullState = null;
                const stillAtBoundary = state.kind === 'replace' ? forumIsAtTop(surface) : forumIsAtBottom(surface);
                const shouldRefresh = stillAtBoundary && state.distance >= FORUM_PULL_THRESHOLD;
                resetForumPullIndicator(state.indicator, state.kind);
                if (shouldRefresh) void runForumHomeRefresh({ mode: state.kind });
            }, FORUM_WHEEL_RELEASE_DELAY);
        };
        // 电脑端与手机端同一套逻辑，只是驱动源换成滚轮：继续滚 = 继续拉，
        // 停止滚轮 = 松手（提交），反向滚 = 手指反向（按钮快速退回直到消失）。
        const wheel = (event) => {
            if (ctx.forumRefreshing || event?.ctrlKey || ctx.forumPullState) return;
            const delta = normalizedWheelDelta(event);
            if (!delta) return;
            if (Math.abs(Number(event?.deltaX) || 0) > Math.abs(delta)) return;
            const step = Math.min(72, Math.max(8, Math.abs(delta) * 0.55));
            const active = ctx.forumWheelPullState;
            if (active) {
                if (active.kind === 'append' ? delta > 0 : delta < 0) {
                    active.distance = Math.min(FORUM_WHEEL_MAX_DISTANCE, active.distance + step);
                    updateForumPullIndicator(active.indicator, active.distance, active.distance >= FORUM_PULL_THRESHOLD, { source: 'wheel', kind: active.kind, park: active.park });
                    event?.preventDefault?.();
                    settleWheelPull(active);
                    return;
                }
                active.distance = Math.max(0, active.distance - step * FORUM_WHEEL_RETREAT_RATIO);
                const stillAtBoundary = active.kind === 'replace' ? forumIsAtTop(surface) : forumIsAtBottom(surface);
                // 反向不 preventDefault：把滚动交还浏览器，用户改主意就正常往回滚。
                if (active.distance <= 0 || !stillAtBoundary) { cancelForumWheelPull(); return; }
                updateForumPullIndicator(active.indicator, active.distance, active.distance >= FORUM_PULL_THRESHOLD, { source: 'wheel', kind: active.kind, park: active.park });
                settleWheelPull(active);
                return;
            }
            const requestedKind = delta < 0 && forumIsAtTop(surface)
                ? 'replace'
                : (delta > 0 && forumIsAtBottom(surface) ? 'append' : '');
            if (!requestedKind) return;
            const indicator = requestedKind === 'append' ? appendIndicator : replacementIndicator;
            const state = {
                kind: requestedKind,
                distance: Math.min(FORUM_WHEEL_MAX_DISTANCE, step),
                indicator,
                park: measureForumPullPark(indicator, requestedKind),
                releaseTimer: null,
            };
            ctx.forumWheelPullState = state;
            updateForumPullIndicator(state.indicator, state.distance, state.distance >= FORUM_PULL_THRESHOLD, { source: 'wheel', kind: state.kind, park: state.park });
            event?.preventDefault?.();
            settleWheelPull(state);
        };
        listen(surface, surface, 'pointerdown', start, controller.signal);
        listen(surface, surface, 'pointermove', move, controller.signal);
        listen(surface, surface, 'pointerup', end, controller.signal);
        listen(surface, surface, 'pointercancel', cancelGesture, controller.signal);
        // Older embedded WebViews may expose Touch Events without Pointer Events.
        surface.addEventListener('touchstart', touchStart, { passive: true, signal: controller.signal });
        surface.addEventListener('touchmove', touchMove, { passive: false, signal: controller.signal });
        surface.addEventListener('touchend', touchEnd, { passive: true, signal: controller.signal });
        surface.addEventListener('touchcancel', cancelGesture, { passive: true, signal: controller.signal });
        // The persistent phone content area is the browser's actual scroll container.
        // Listening there makes a wheel over the forum heading and feed behave alike.
        listen(surface, ctx.content, 'wheel', wheel, controller.signal);
    }
    function forumPostDeleteBlocked(post) {
        return Boolean(
            forumDeletePendingId
            || ctx.forumRefreshing
            || ctx.localSummaryBusy
            || ctx.actionBridge.isPending?.('forum_home_refresh', '')
            || ctx.actionBridge.isPending?.('forum_existing_update', '')
            || ctx.actionBridge.isPending?.('forum_post_update', post.id)
        );
    }
    function focusForumPostDeleteControl(postId, className) {
        queueMicrotask(() => {
            if (ctx.isDestroyed) return;
            const nodes = Array.from(ctx.content?.querySelectorAll?.(`.${className}`) ?? []);
            const node = nodes.find((candidate) => candidate.getAttribute('data-forum-post-id') === postId);
            try { node?.focus?.({ preventScroll: true }); }
            catch { node?.focus?.(); }
        });
    }
    function openForumPostDeleteConfirmation(post) {
        if (!post || forumPostDeleteBlocked(post)) return;
        if (typeof ctx.groupForumStore?.deleteForumPost !== 'function') {
            ctx.setFeedback('单帖删除功能暂不可用。');
            return;
        }
        forumDeleteConfirmationId = post.id;
        ctx.renderPage();
        focusForumPostDeleteControl(post.id, 'yl-forum-post-delete-cancel');
    }
    function cancelForumPostDelete(post) {
        if (!post || forumDeletePendingId) return;
        forumDeleteConfirmationId = '';
        ctx.renderPage();
        focusForumPostDeleteControl(post.id, 'yl-forum-post-delete');
    }
    function buildForumPostDeleteConfirmation(post) {
        if (forumDeleteConfirmationId !== post.id) return null;
        const pending = forumDeletePendingId === post.id;
        const titleId = `yl-forum-post-delete-title-${post.id}`;
        const descriptionId = `yl-forum-post-delete-description-${post.id}`;
        const confirmation = element('section', { className: 'yl-chat-delete-confirmation yl-forum-post-delete-confirmation' });
        confirmation.setAttribute('role', 'group');
        confirmation.setAttribute('aria-labelledby', titleId);
        confirmation.setAttribute('aria-describedby', descriptionId);
        confirmation.setAttribute('aria-live', 'polite');
        confirmation.setAttribute('aria-busy', String(pending));
        confirmation.setAttribute('data-forum-post-id', post.id);
        if (pending) confirmation.setAttribute('tabindex', '-1');
        append(confirmation, [
            element('strong', { id: titleId, text: `删除《${post.title}》？` }),
            element('p', { id: descriptionId, text: '只会删除这篇本地帖子、其中的评论与总结；其他帖子和广场设置保持不变。对应的本地生图缓存也会一并清理，删除后无法在此界面恢复。' }),
        ]);
        const actions = element('div', { className: 'yl-chat-delete-actions' });
        const cancel = element('button', {
            className: 'yl-settings-button yl-settings-button-secondary yl-chat-delete-cancel yl-forum-post-delete-cancel',
            type: 'button', text: '取消', disabled: pending, ariaLabel: `取消删除帖子：${post.title}`,
        });
        const confirm = element('button', {
            className: 'yl-settings-button yl-chat-delete-confirm yl-forum-post-delete-confirm',
            type: 'button', text: pending ? '正在删除…' : '确认删除', disabled: pending || forumPostDeleteBlocked(post),
            ariaLabel: `确认删除帖子：${post.title}`,
        });
        for (const control of [cancel, confirm]) control.setAttribute('data-forum-post-id', post.id);
        listen(confirmation, confirmation, 'keydown', (event) => {
            if (event.key !== 'Escape' || pending) return;
            event.preventDefault?.(); event.stopPropagation?.(); cancelForumPostDelete(post);
        }, ctx.abortController.signal);
        listen(cancel, cancel, 'click', () => cancelForumPostDelete(post), ctx.abortController.signal);
        listen(confirm, confirm, 'click', () => { void runForumPostDelete(post); }, ctx.abortController.signal);
        append(actions, [cancel, confirm]); confirmation.appendChild(actions);
        return confirmation;
    }
    async function runForumPostDelete(post) {
        if (!post || forumDeleteConfirmationId !== post.id || forumPostDeleteBlocked(post)) return;
        const remove = ctx.groupForumStore?.deleteForumPost;
        if (typeof remove !== 'function') { ctx.setFeedback('单帖删除功能暂不可用。'); return; }
        const startedFromDetail = ['forum_post', 'forum_post_summary'].includes(ctx.activePage) && ctx.activeForumPostId === post.id;
        forumDeletePendingId = post.id;
        stopForumAutoTimer();
        ctx.renderPage();
        focusForumPostDeleteControl(post.id, 'yl-forum-post-delete-confirmation');
        try {
            await remove({ postId: post.id });
            let artifactCleanupFailed = false;
            try {
                const cleanup = await ctx.removeForumConversationArtifacts?.(post.id);
                artifactCleanupFailed = cleanup?.ok === false;
            } catch { artifactCleanupFailed = true; }
            await syncGroupForumSnapshot({ rerender: false });
            ctx.forumCommentDrafts.delete(post.id);
            if (ctx.localSummaryTarget?.kind === 'post' && ctx.localSummaryTarget.id === post.id) ctx.localSummaryTarget = null;
            if (ctx.activeForumPostId === post.id) ctx.activeForumPostId = '';
            forumDeleteConfirmationId = '';
            forumDeletePendingId = '';
            if (ctx.isDestroyed) return;
            if (startedFromDetail && ['forum_post', 'forum_post_summary'].includes(ctx.activePage)) {
                ctx.setActivePage('group_forum');
            } else if (ctx.activePage === 'group_forum') {
                ctx.renderPage();
                syncForumAutoTimer();
            }
            ctx.setFeedback(artifactCleanupFailed
                ? '帖子已删除，其他帖子保持不变；对应的本地生图缓存或自动生图设置清理失败。'
                : '帖子已删除，其他帖子保持不变。');
        } catch {
            forumDeletePendingId = '';
            if (ctx.isDestroyed) return;
            if (['group_forum', 'forum_post', 'forum_post_summary'].includes(ctx.activePage)) ctx.renderPage();
            syncForumAutoTimer();
            ctx.setFeedback('帖子没有删除，请稍后重试。');
        }
    }
    // §8.2-2：帖子卡现代化——头像 40 + 昵称 + 频道小 chip + 相对时间 / 正文 6 行截断「展开」/ 底部操作行。
    function buildForumPostCard(post) {
        const card = element('article', { className: 'yl-post-card' });
        const author = safeLocalDisplayProfile(post.author);
        const head = element('div', { className: 'yl-post-head' });
        head.appendChild(ctx.publicAvatar(author, { className: 'yl-forum-post-avatar yl-post-avatar', imageEnabled: true, interactive: false }));
        const headCopy = element('div', { className: 'yl-post-head-copy' });
        headCopy.appendChild(element('strong', { text: author.昵称 }));
        const metaRow = element('span', { className: 'yl-post-meta' });
        metaRow.appendChild(createTagChip(forumChannelForPost(post).title, { documentRef: ctx.documentRef }));
        metaRow.appendChild(element('span', { className: 'yl-post-time', text: relativeTimeLabel(post.createdAt) || '刚刚' }));
        headCopy.appendChild(metaRow);
        head.appendChild(headCopy);
        card.appendChild(head);
        card.appendChild(element('h3', { className: 'yl-post-title', text: post.title }));
        const body = element('p', { className: 'yl-post-body', text: post.body });
        card.appendChild(body);
        if (post.body.length > POST_EXPAND_THRESHOLD) {
            const expand = element('button', { className: 'yl-post-expand', type: 'button', text: '展开', ariaLabel: `展开帖子全文：${post.title}` });
            listen(expand, expand, 'click', () => {
                const expanded = body.classList.toggle('is-expanded');
                expand.textContent = expanded ? '收起' : '展开';
            }, ctx.abortController.signal);
            card.appendChild(expand);
        }
        const footer = element('div', { className: 'yl-post-footer' });
        const comments = element('span', { className: 'yl-post-comments' });
        comments.appendChild(createUiIcon(ctx.documentRef, 'messages', { className: 'yl-post-comments-svg', size: 16 }));
        comments.appendChild(element('span', { text: `${post.messages.length} 条评论` }));
        footer.appendChild(comments);
        if (post.tags.length) footer.appendChild(element('span', { className: 'yl-post-tags', text: post.tags.slice(0, 3).map((tag) => '#' + tag).join(' ') }));
        const open = element('button', { className: 'yl-post-open', type: 'button', ariaLabel: `打开帖子：${post.title}` });
        open.appendChild(element('span', { text: '进入详情' }));
        open.appendChild(createUiIcon(ctx.documentRef, 'chevron_right', { className: 'yl-post-open-svg', size: 16 }));
        listen(open, open, 'click', () => { resetForumPostDeletion(); ctx.activeForumPostId = post.id; ctx.setActivePage('forum_post'); }, ctx.abortController.signal);
        footer.appendChild(open);
        card.appendChild(footer);
        return card;
    }
    function buildForumPage() {
        persistCommunityTabPreference('square');
        const section = element('section', { className: 'yl-forum-home' });
        const replacing = ctx.forumRefreshing && ctx.forumRefreshMode === 'replace';
        const appending = ctx.forumRefreshing && ctx.forumRefreshMode === 'append';
        const pull = element('div', { className: replacing ? 'yl-forum-pull-indicator is-visible is-refreshing' : 'yl-forum-pull-indicator' });
        setForumPullIndicatorContent(pull, replacing ? '正在替换广场帖子…' : '下拉刷新');
        const appendPull = element('div', { className: appending ? 'yl-forum-append-indicator yl-forum-pull-indicator is-visible is-refreshing is-append' : 'yl-forum-append-indicator yl-forum-pull-indicator is-append' });
        setForumPullIndicatorContent(appendPull, appending ? '正在追加广场帖子…' : '上拉加载更多');
        // 刷新进行中的指示器停在与松手那一刻相同的 1/4 窗口位置（由位移变量驱动，不靠 CSS 百分比）。
        if (replacing) parkForumPullIndicator(pull, 'replace');
        if (appending) parkForumPullIndicator(appendPull, 'append');
        const selectedChannel = activeForumChannel();
        section.appendChild(pull); bindForumPullToRefresh(section, pull, appendPull);
        section.appendChild(buildCommunityTopbar('square'));
        // §8.2-1：5 频道横滑 chip 条（激活 chip 渐变底），sticky 于 Segmented 下。
        const channels = element('div', { className: 'yl-forum-channel-strip', ariaLabel: '广场频道' });
        for (const channel of FORUM_CHANNELS) {
            const selected = selectedChannel?.id === channel.id;
            const chip = element('button', { className: selected ? 'yl-channel-chip is-active' : 'yl-channel-chip', type: 'button', pressed: selected, ariaLabel: selected ? `返回社区全部动态（当前${channel.title}）` : `进入${channel.title}频道` });
            chip.setAttribute('data-forum-channel', channel.id);
            // P3-D：频道图标只走本地 SVG 白名单；未知频道兜底 forum 图标，不再渲染字符字形。
            chip.appendChild(createUiIcon(ctx.documentRef, FORUM_CHANNEL_ICON_NAMES[channel.id] ?? 'forum', { className: 'yl-channel-chip-svg', size: 16 }));
            chip.appendChild(element('span', { text: channel.title }));
            listen(chip, chip, 'click', () => selectForumChannel(channel.id), ctx.abortController.signal);
            channels.appendChild(chip);
        }
        section.appendChild(channels);
        const posts = forumPostsForActiveChannel();
        if (replacing) {
            // §8.2-5：帖子流加载骨架屏（头像圆 + 文本条 ×3）+ P3-G 等待文案轮播。
            section.appendChild(buildWaitCaptions(ctx.documentRef, FORUM_WAIT_CAPTIONS, { shiftText: FORUM_WAIT_SHIFT_TEXT }));
            section.appendChild(createSkeleton({ documentRef: ctx.documentRef, variant: 'post', count: 3 }));
        } else if (!posts.length) {
            const channelName = selectedChannel?.title ?? '广场';
            section.appendChild(createEmptyState({
                documentRef: ctx.documentRef, variant: 'inbox',
                title: `${channelName}还没有本地帖子`,
                hint: '顶部下拉（或电脑滚轮上滚后停顿），会新增八个频道各一篇帖子。',
                action: { label: '刷新帖子', variant: 'tonal', icon: 'refresh', onClick: () => { void runForumHomeRefresh({ mode: 'replace' }); } },
            }));
        } else {
            const feed = element('div', { className: 'yl-forum-feed' });
            feed.appendChild(element('h3', { className: 'yl-forum-feed-heading', text: selectedChannel ? `${selectedChannel.title} · ${posts.length} 条本地帖子` : `社区动态 · ${posts.length} 条本地帖子` }));
            for (const post of posts) feed.appendChild(buildForumPostCard(post));
            section.appendChild(feed);
            if (appending) section.appendChild(createSkeleton({ documentRef: ctx.documentRef, variant: 'post', count: 1 }));
        }
        section.appendChild(appendPull);
        return section;
    }
    async function runForumHomeRefresh({ mode = 'replace' } = {}) {
        if (forumDeletePendingId || ctx.forumRefreshing || !ctx.actionBridge.generateForumHomeRefresh || ctx.actionBridge.isPending?.('forum_home_refresh', '')) return;
        if (!['replace', 'append'].includes(mode)) return;
        const replacing = mode === 'replace';
        // 追加模式滚动合同：renderPage 会重建滚动容器（content.replaceChildren 后浏览器把
        // scrollTop 归零）。这里记住手势发生时的位置：进行中把底部“正在追加”指示与骨架屏
        // 滚入视野；完成或失败后回到原位置——新帖子固定追加在列表末尾，正好从原底部继续向下排。
        const appendAnchorTop = replacing ? 0 : Math.max(0, Number(ctx.content?.scrollTop) || 0);
        const restoreAppendScroll = ({ toAppendZone = false } = {}) => {
            if (replacing || !ctx.content) return;
            const bottom = (Number(ctx.content.scrollHeight) || 0) - (Number(ctx.content.clientHeight) || 0);
            ctx.content.scrollTop = toAppendZone ? Math.max(appendAnchorTop, bottom) : appendAnchorTop;
        };
        ctx.forumRefreshing = true; ctx.forumRefreshMode = mode; ctx.renderPage(); restoreAppendScroll({ toAppendZone: true }); parkMountedForumIndicator(mode);
        const activity = ctx.operationActivity.start('广场刷新', replacing ? '正在替换旧帖子并刷新全部八个频道。' : '正在保留旧帖子并追加全部八个频道。');
        let result;
        let bridgeError = null;
        try {
            result = await ctx.actionBridge.generateForumHomeRefresh({
                existingTitles: replacing ? [] : socialPosts().slice(0, 24).map((post) => post.title),
                refreshMode: mode,
                binding: localBindingForMode(forumAutoSettings().channelBindings),
            });
        }
        catch (error) { bridgeError = error; result = { ok: false }; }
        ctx.forumRefreshing = false; ctx.forumRefreshMode = '';
        if (ctx.isDestroyed || ctx.activePage !== 'group_forum') { ctx.operationActivity.dismiss(activity, '社区广场已离开，刷新结果未展示。'); return; }
        if (!result?.ok || !result.update) {
            ctx.operationActivity.fail(activity, '广场未刷新。', { detail: communityFailureDetail('广场刷新', result, bridgeError) });
            ctx.setFeedback(result?.message || '广场刷新未完成，请稍后重试。'); ctx.renderPage(); restoreAppendScroll(); return;
        }
        try {
            const saveRefresh = replacing ? ctx.groupForumStore?.replaceForumPosts : ctx.groupForumStore?.addForumRefresh;
            await saveRefresh?.({ update: result.update, communityProfiles: result.communityProfiles ?? [], reservedPlayerNickname: playerDisplayName({ forModel: true }) });
            await syncGroupForumSnapshot({ rerender: false });
            ctx.operationActivity.succeed(activity, replacing ? '旧帖子已替换为八个频道的新帖子。' : '新帖子已追加到广场底部。');
            if (!replacing) ctx.setFeedback('已保留旧帖子，并在广场底部追加八个频道的新帖子。');
            ctx.renderPage(); restoreAppendScroll(); syncForumAutoTimer();
        } catch (error) {
            ctx.operationActivity.fail(activity, '广场更新没有保存到本地缓存。', { detail: localCacheFailureDetail('广场刷新', error) });
            ctx.setFeedback('广场更新没有保存到本地缓存。'); ctx.renderPage(); restoreAppendScroll();
        }
    }
    function generatedForumPublicProfile(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const text = (key, maxLength = 160) => typeof value[key] === 'string' ? value[key].trim().slice(0, maxLength) : '';
        const tags = (key) => {
            if (!Array.isArray(value[key])) return Object.freeze([]);
            const output = [];
            for (const raw of value[key]) {
                const tag = typeof raw === 'string' ? raw.trim().slice(0, 32) : '';
                if (tag && !output.includes(tag)) output.push(tag);
                if (output.length >= 12) break;
            }
            return Object.freeze(output);
        };
        const nickname = text('昵称', 80);
        const ageRange = text('年龄段', 32);
        if (!nickname || !ageRange) return null;
        return Object.freeze({
            昵称: nickname,
            头像引用: '',
            年龄段: ageRange,
            性别: text('性别', 48),
            性取向: text('性取向', 80),
            城市: text('城市', 80),
            距离范围: text('距离范围', 80),
            寻找意图: text('寻找意图', 120),
            简介: text('简介', 600),
            兴趣标签: tags('兴趣标签'),
            生活方式标签: tags('生活方式标签'),
            性格标签: tags('性格标签'),
            沟通风格标签: tags('沟通风格标签'),
        });
    }
    function forumParticipantRequestIsCurrent(requestId, postId) {
        return !ctx.isDestroyed
            && requestId === ctx.interactionGeneration
            && ctx.activeForumPostId === postId
            && (ctx.activePage === 'forum_post' || ctx.activePage === 'forum_participant_detail');
    }
    async function requestForumParticipantDetails(post, participant) {
        closeForumParticipantActionSheet({ restoreFocus: false });
        if (typeof ctx.actionBridge.generateForumParticipantDetails !== 'function') {
            ctx.setFeedback('论坛角色详情生成尚未就绪。');
            return;
        }
        const nickname = safeLocalDisplayProfile(participant).昵称;
        const requestId = ++ctx.interactionGeneration;
        const activity = ctx.operationActivity.start('论坛角色详情', '正在等待对方回应查看请求……');
        const operationToken = ctx.showRomanceLoading('请求查看详情', `已向${nickname}发出请求，正在等待 TA 考虑是否愿意分享更多资料……`);
        let result;
        let caughtError = null;
        try { result = await ctx.actionBridge.generateForumParticipantDetails({ post, participant }); }
        catch (error) { caughtError = error; result = { ok: false }; }
        if (!forumParticipantRequestIsCurrent(requestId, post.id)) {
            ctx.operationActivity.dismiss(activity, '页面已离开，查看请求的返回结果未展示。');
            return;
        }
        const profile = result?.ok ? generatedForumPublicProfile(result.profile) : null;
        if (!result?.ok || !profile) {
            ctx.operationActivity.fail(activity, '详情请求未完成。', {
                detail: communityFailureDetail('论坛角色详情', result, caughtError),
            });
            ctx.showRomanceResult({ title: '这次没能看到详情', message: result?.message || '详情生成未完成，请稍后再试。' }, operationToken);
            return;
        }
        forumParticipantDetail = Object.freeze({
            postId: post.id,
            post,
            participant,
            profile,
            contextKey: typeof result.contextKey === 'string' ? result.contextKey : '',
        });
        ctx.operationActivity.succeed(activity, '对方已同意分享公开详情。');
        ctx.setActivePage('forum_participant_detail', { preserveOperation: true });
        ctx.showRomanceResult({ accepted: true, title: '对方同意了', message: `${nickname}已愿意向你展示更完整的公开资料。` }, operationToken);
    }
    async function requestForumParticipantPrivateChat(post, participant) {
        closeForumParticipantActionSheet({ restoreFocus: false });
        if (typeof ctx.actionBridge.runForumParticipantPrivateChat !== 'function') {
            ctx.setFeedback('论坛私聊邀请尚未就绪。');
            return;
        }
        const nickname = safeLocalDisplayProfile(participant).昵称;
        const requestId = ++ctx.interactionGeneration;
        const activity = ctx.operationActivity.start('论坛私聊邀请', '正在等待对方回应私聊邀请……');
        const operationToken = ctx.showRomanceLoading('请求私聊', `邀请已送达${nickname}，正在等待 TA 考虑是否接受……`);
        let result;
        let caughtError = null;
        try { result = await ctx.actionBridge.runForumParticipantPrivateChat({ post, participant }); }
        catch (error) { caughtError = error; result = { ok: false }; }
        if (!forumParticipantRequestIsCurrent(requestId, post.id)) {
            ctx.operationActivity.dismiss(activity, '页面已离开，私聊邀请的返回结果未展示。');
            return;
        }
        const sessionUid = typeof result?.sessionUid === 'string' ? result.sessionUid : '';
        if (!result?.ok || !sessionUid) {
            ctx.operationActivity.fail(activity, '私聊邀请未完成。', {
                detail: communityFailureDetail('论坛私聊邀请', result, caughtError),
            });
            ctx.showRomanceResult({ title: '邀请暂未送达', message: result?.message || '角色生成或私聊建立未完成，当前状态没有改变。' }, operationToken);
            return;
        }
        ctx.refreshState();
        if (!forumParticipantRequestIsCurrent(requestId, post.id)) {
            ctx.operationActivity.dismiss(activity, '页面已离开，已建立的私聊未自动打开。');
            return;
        }
        ctx.openPrivateChat(sessionUid, { preserveOperation: true });
        ctx.operationActivity.succeed(activity, '对方已接受邀请，私聊已打开。');
        ctx.showRomanceResult({ accepted: true, title: '邀请被接受了', message: `${nickname}已进入你的私聊列表，去打个招呼吧。` }, operationToken);
    }
    function openForumParticipantActionSheet(post, participant, opener, mountGeneration) {
        if (ctx.activePage !== 'forum_post' || ctx.activeForumPostId !== post.id || mountGeneration !== forumParticipantMountGeneration) return;
        if (typeof ctx.content?.contains === 'function' && !ctx.content.contains(opener)) return;
        closeForumParticipantActionSheet({ restoreFocus: false });
        const nickname = safeLocalDisplayProfile(participant).昵称;
        const body = element('div', { className: 'yl-forum-participant-actions' });
        body.appendChild(element('p', { className: 'yl-forum-participant-actions-note', text: `你想对${nickname}做什么？只会使用 TA 在当前帖子中的公开发言。` }));
        const details = element('button', { className: 'yl-settings-button', type: 'button', text: '查看详情' });
        const privateChat = element('button', { className: 'yl-settings-button yl-settings-button-secondary', type: 'button', text: '请求私聊' });
        listen(details, details, 'click', () => { void requestForumParticipantDetails(post, participant); }, ctx.abortController.signal);
        listen(privateChat, privateChat, 'click', () => { void requestForumParticipantPrivateChat(post, participant); }, ctx.abortController.signal);
        append(body, [details, privateChat]);
        let sheet = null;
        const managedController = typeof ctx.openManagedDialog === 'function' && typeof ctx.closeManagedDialog === 'function'
            ? {
                open(dialog, options = {}) {
                    ctx.openManagedDialog(dialog, { ...options, geometryTarget: sheet?.root ?? dialog, placement: 'viewport-cover' });
                },
                close(dialog, options = {}) { ctx.closeManagedDialog(dialog, options); },
            }
            : null;
        sheet = createBottomSheet({
            documentRef: ctx.documentRef,
            title: `${nickname}的楼层操作`,
            content: body,
            onRequestClose: () => closeForumParticipantActionSheet(),
            dialogController: managedController,
        });
        forumParticipantActionSheet = sheet;
        forumParticipantActionOpener = opener;
        opener.setAttribute('aria-expanded', 'true');
        ctx.content.appendChild(sheet.root);
        sheet.open({ opener });
    }
    function forumParticipantAvatarTrigger(post, participant, display, { className, mountGeneration }) {
        const nickname = display.昵称 || '该用户';
        const button = element('button', {
            className: 'yl-forum-participant-trigger',
            type: 'button',
            ariaLabel: `打开${nickname}的楼层操作`,
        });
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-expanded', 'false');
        button.title = '点击、右键或长按查看楼层操作';
        button.appendChild(ctx.publicAvatar(display, { className, imageEnabled: true, interactive: false }));
        let holdTimer = null;
        let holdInput = '';
        let startX = 0;
        let startY = 0;
        let suppressClick = false;
        const point = (event) => {
            const touch = event?.touches?.[0] ?? event?.changedTouches?.[0] ?? null;
            return {
                x: Number(touch?.clientX ?? event?.clientX ?? 0),
                y: Number(touch?.clientY ?? event?.clientY ?? 0),
            };
        };
        const clearHold = (input = '') => {
            if (input && holdInput !== input) return;
            if (holdTimer !== null) globalThis.clearTimeout(holdTimer);
            holdTimer = null;
            holdInput = '';
        };
        const beginHold = (event, input) => {
            if (event?.pointerType === 'mouse') return;
            if (holdTimer !== null) {
                if (holdInput === 'pointer' && input === 'touch') return;
                clearHold();
            }
            const start = point(event);
            startX = start.x;
            startY = start.y;
            holdInput = input;
            holdTimer = globalThis.setTimeout(() => {
                holdTimer = null;
                holdInput = '';
                suppressClick = true;
                openForumParticipantActionSheet(post, participant, button, mountGeneration);
                const release = globalThis.setTimeout(() => { suppressClick = false; }, 900);
                release?.unref?.();
            }, FORUM_PARTICIPANT_LONG_PRESS_MS);
            holdTimer?.unref?.();
        };
        const moveHold = (event, input) => {
            if (holdTimer === null || holdInput !== input) return;
            const current = point(event);
            if (Math.hypot(current.x - startX, current.y - startY) > FORUM_PARTICIPANT_MOVE_TOLERANCE) clearHold(input);
        };
        listen(button, button, 'pointerdown', (event) => beginHold(event, 'pointer'), ctx.abortController.signal);
        listen(button, button, 'pointermove', (event) => moveHold(event, 'pointer'), ctx.abortController.signal);
        listen(button, button, 'pointerup', () => clearHold('pointer'), ctx.abortController.signal);
        listen(button, button, 'pointercancel', () => clearHold('pointer'), ctx.abortController.signal);
        listen(button, button, 'pointerleave', () => clearHold('pointer'), ctx.abortController.signal);
        listen(button, button, 'touchstart', (event) => beginHold(event, 'touch'), ctx.abortController.signal);
        listen(button, button, 'touchmove', (event) => moveHold(event, 'touch'), ctx.abortController.signal);
        listen(button, button, 'touchend', () => clearHold('touch'), ctx.abortController.signal);
        listen(button, button, 'touchcancel', () => clearHold('touch'), ctx.abortController.signal);
        listen(button, button, 'contextmenu', (event) => {
            event.preventDefault?.();
            clearHold();
            openForumParticipantActionSheet(post, participant, button, mountGeneration);
        }, ctx.abortController.signal);
        listen(button, button, 'click', () => {
            if (suppressClick) { suppressClick = false; return; }
            openForumParticipantActionSheet(post, participant, button, mountGeneration);
        }, ctx.abortController.signal);
        return button;
    }
    function buildForumParticipantDetailPage() {
        const detail = forumParticipantDetail;
        const currentPost = detail ? socialPostFor(detail.postId) : null;
        if (!detail || !currentPost) return createEmptyState({ documentRef: ctx.documentRef, variant: 'search', title: '该公开资料已不可用', hint: '请返回帖子后重新发起查看请求。' });
        const profile = detail.profile;
        const section = element('section', { className: 'yl-public-profile yl-forum-participant-detail' });
        section.appendChild(ctx.publicAvatar(profile, { className: 'yl-candidate-avatar', imageEnabled: true, interactive: false }));
        section.appendChild(element('h2', { text: profile.昵称 || '未命名对象' }));
        section.appendChild(element('p', { className: 'yl-forum-participant-detail-note', text: '这份公开资料根据 TA 在当前帖子中的发言生成，只保留在本次小手机内存中。' }));
        for (const [label, value] of [['年龄段', profile.年龄段], ['性别', profile.性别], ['性取向', profile.性取向], ['城市', profile.城市], ['距离范围', profile.距离范围], ['寻找意图', profile.寻找意图], ['简介', profile.简介]]) {
            if (value) section.appendChild(element('p', { className: 'yl-phone-page-description', text: `${label}：${value}` }));
        }
        const visibleTags = ctx.displayTags(profile);
        if (visibleTags.length) {
            const tagList = element('div', { className: 'yl-tag-list yl-forum-participant-detail-tags' });
            for (const tag of visibleTags) tagList.appendChild(createTagChip(tag, { documentRef: ctx.documentRef }));
            section.appendChild(tagList);
        }
        const invite = element('button', { className: 'yl-settings-button yl-forum-participant-invite', type: 'button', text: '请求私聊' });
        // Reuse the exact sanitized speech fingerprint that produced the visible profile,
        // even if an automatic forum update appends newer floors while this detail is open.
        listen(invite, invite, 'click', () => { void requestForumParticipantPrivateChat(detail.post, detail.participant); }, ctx.abortController.signal);
        section.appendChild(invite);
        return section;
    }
    // §8.2-4：评论列表 ListRow 变体——头像 + 昵称/相对时间 + 文本（替代旧论坛气泡）。
    function buildForumCommentRow(post, message) {
        const isUser = message.sender === 'user';
        const row = element('div', { className: 'yl-comment-row' });
        const display = isUser ? playerDisplayProfile() : safeLocalDisplayProfile(message.author);
        row.appendChild(isUser
            ? ctx.publicAvatar(display, { className: 'yl-local-message-avatar yl-comment-avatar', imageEnabled: false, interactive: false, imageSource: playerAvatarSource() })
            : forumParticipantAvatarTrigger(post, message.author, display, { className: 'yl-local-message-avatar yl-comment-avatar', mountGeneration: forumParticipantMountGeneration }));
        const body = element('div', { className: 'yl-comment-body' });
        const head = element('div', { className: 'yl-comment-head' });
        head.appendChild(element('strong', { text: display.昵称 }));
        const time = relativeTimeLabel(message.createdAt);
        if (time) head.appendChild(element('span', { className: 'yl-comment-time', text: time }));
        body.appendChild(head);
        body.appendChild(element('p', { className: 'yl-comment-text', text: message.content }));
        if (!isUser && message.imageDirective) {
            const imageCard = ctx.buildImageDirectiveCard({
                kind: 'forum', conversationId: post.id, messageId: message.id, characterUid: ctx.localProfileCharacterUid(message.author), directive: message.imageDirective,
            });
            if (imageCard) body.appendChild(imageCard);
        }
        row.appendChild(body);
        return row;
    }
    function buildForumPostPage() {
        const mountGeneration = ++forumParticipantMountGeneration;
        const post = socialPostFor(ctx.activeForumPostId);
        if (!post) return createEmptyState({ documentRef: ctx.documentRef, variant: 'search', title: '当前帖子已不可用', hint: '请返回广场后刷新。' });
        const deleting = forumDeletePendingId === post.id;
        const section = element('section', { className: 'yl-forum-post-page' });
        const layout = element('div', { className: 'yl-forum-post-layout' });
        const main = element('article', { className: 'yl-forum-post-main' });
        const author = safeLocalDisplayProfile(post.author);
        const authorRow = element('div', { className: 'yl-forum-post-author' });
        authorRow.appendChild(forumParticipantAvatarTrigger(post, post.author, author, { className: 'yl-forum-post-avatar', mountGeneration }));
        const authorCopy = element('div'); append(authorCopy, [element('strong', { text: author.昵称 }), element('span', { text: [author.gender, author.ageRange, author.city].filter(Boolean).join(' · ') }), element('small', { text: `${forumChannelForPost(post).title} · ${relativeTimeLabel(post.createdAt) || '刚刚'}` })]); authorRow.appendChild(authorCopy);
        const actionRow = element('div', { className: 'yl-forum-post-actions' });
        const summary = element('button', { className: 'yl-settings-button yl-settings-button-secondary', type: 'button', text: '聊天总结', disabled: deleting || !ctx.chatSummaryEnabled(), ariaLabel: '查看帖子总结' });
        listen(summary, summary, 'click', () => { ctx.localSummaryTarget = { kind: 'post', id: post.id, title: post.title }; ctx.setActivePage('forum_post_summary'); }, ctx.abortController.signal);
        const remove = element('button', {
            className: 'yl-settings-button yl-button-danger yl-forum-post-delete', type: 'button', text: '删除帖子',
            disabled: forumPostDeleteBlocked(post), ariaLabel: `删除帖子：${post.title}`,
        });
        remove.setAttribute('data-forum-post-id', post.id);
        listen(remove, remove, 'click', () => openForumPostDeleteConfirmation(post), ctx.abortController.signal);
        const imageControls = ctx.buildConversationImageControls({ kind: 'forum', conversationId: post.id });
        if (deleting) {
            imageControls.setAttribute('aria-disabled', 'true');
            imageControls.setAttribute('inert', '');
            for (const control of [...imageControls.querySelectorAll('button'), ...imageControls.querySelectorAll('input')]) control.disabled = true;
        }
        append(actionRow, [summary, imageControls, remove]);
        append(main, [authorRow, actionRow]);
        const deleteConfirmation = buildForumPostDeleteConfirmation(post);
        if (deleteConfirmation) main.appendChild(deleteConfirmation);
        append(main, [element('h2', { text: post.title }), element('p', { className: 'yl-forum-post-body', text: post.body })]);
        const tags = element('div', { className: 'yl-tag-list yl-forum-post-tags' });
        for (const tag of post.tags) tags.appendChild(element('span', { className: 'yl-tag-chip', text: '#' + tag }));
        main.appendChild(tags);
        main.appendChild(element('h3', { text: `评论（${post.messages.length}）` }));
        const comments = element('div', { className: 'yl-forum-comment-list' });
        if (!post.messages.length) comments.appendChild(element('p', { className: 'yl-comment-empty', text: '还没有评论。留下第一句公开想法吧。' }));
        else for (const message of post.messages) comments.appendChild(buildForumCommentRow(post, message));
        if (ctx.actionBridge.isPending?.('forum_post_update', post.id)) comments.appendChild(buildLocalReplyingIndicator('讨论正在更新···'));
        main.appendChild(comments); layout.appendChild(main);
        const side = element('aside', { className: 'yl-forum-post-author-card' });
        side.appendChild(ctx.publicAvatar(author, { className: 'yl-forum-post-avatar', imageEnabled: true, interactive: false })); side.appendChild(element('strong', { text: author.昵称 })); side.appendChild(buildParticipantMeta(post.author));
        if (post.author.occupation) side.appendChild(element('span', { text: post.author.occupation }));
        if (post.author.interests.length) side.appendChild(element('span', { text: post.author.interests.join(' / ') }));
        layout.appendChild(side); section.appendChild(layout);
        const pending = deleting || Boolean(ctx.actionBridge.isPending?.('forum_post_update', post.id));
        const composer = element('section', { className: 'yl-chat-composer yl-local-composer yl-forum-comment-composer' });
        const input = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 2, maxLength: 600, value: ctx.forumCommentDrafts.get(post.id) ?? '', placeholder: '说点什么…', ariaLabel: '输入论坛评论', disabled: pending });
        const send = element('button', { className: 'yl-chat-send-button', type: 'button', text: pending ? '···' : '发送', disabled: pending, ariaLabel: pending ? '帖子正在更新' : '发送论坛评论' });
        listen(input, input, 'input', () => { ctx.forumCommentDrafts.set(post.id, input.value); }, ctx.abortController.signal);
        listen(input, input, 'keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault?.(); void sendForumComment(post); } }, ctx.abortController.signal);
        listen(send, send, 'click', () => { void sendForumComment(post); }, ctx.abortController.signal);
        append(composer, [input, send, element('span', { className: 'yl-chat-composer-hint', text: '发送后由论坛 AI 更新讨论 · Shift+Enter 换行' })]); section.appendChild(composer);
        return section;
    }
    async function sendForumComment(post) {
        if (forumDeletePendingId === post.id) return;
        const content = String(ctx.forumCommentDrafts.get(post.id) ?? '').trim();
        if (!content) { ctx.setFeedback('请先输入评论。'); return; }
        if (!ctx.groupForumStore?.appendForumUserComment) { ctx.setFeedback('本地论坛缓存尚未就绪。'); return; }
        try {
            await ctx.groupForumStore.appendForumUserComment({ postId: post.id, content }); ctx.forumCommentDrafts.delete(post.id);
            await syncGroupForumSnapshot({ rerender: false }); ctx.renderPage();
        } catch { ctx.setFeedback('评论没有保存到本地缓存。'); return; }
        await runForumPostConversationUpdate(socialPostFor(post.id) ?? post);
    }
    async function runForumPostConversationUpdate(post) {
        if (forumDeletePendingId === post.id || !ctx.actionBridge.generateForumPostConversationUpdate || ctx.actionBridge.isPending?.('forum_post_update', post.id)) return;
        const activity = ctx.operationActivity.start('论坛帖子更新', '正在生成帖子下的本地讨论。'); ctx.renderPage();
        let result;
        let bridgeError = null;
        try {
            result = await ctx.actionBridge.generateForumPostConversationUpdate({
                postId: post.id,
                post,
                history: localHistoryForModel(post),
                binding: localBindingForMode(forumAutoSettings().postBindings),
            });
        }
        catch (error) { bridgeError = error; result = { ok: false }; }
        if (ctx.isDestroyed || ctx.activeForumPostId !== post.id) { ctx.operationActivity.dismiss(activity, '帖子已离开，更新结果未展示。'); return; }
        if (!result?.ok || !result.update) {
            ctx.operationActivity.fail(activity, '论坛帖子更新未完成。', { detail: communityFailureDetail('论坛帖子更新', result, bridgeError) });
            ctx.setFeedback(result?.message || '论坛帖子更新未完成，请稍后重试。'); ctx.renderPage(); return;
        }
        try {
            await ctx.groupForumStore?.appendForumModelUpdate?.({ postId: post.id, update: result.update, reservedPlayerNickname: playerDisplayName({ forModel: true }) });
            await syncGroupForumSnapshot({ rerender: false }); ctx.operationActivity.succeed(activity, '论坛帖子已更新到本地缓存。'); ctx.renderPage();
            void maybeRunLocalAutomaticSummary({ kind: 'post', id: post.id, title: post.title });
        } catch (error) {
            ctx.operationActivity.fail(activity, '论坛帖子更新没有保存到本地缓存。', { detail: localCacheFailureDetail('论坛帖子更新', error) });
            ctx.setFeedback('论坛帖子更新没有保存到本地缓存。');
        }
    }
    function localConversationForTarget(target) {
        if (!target) return null;
        if (target.kind === 'group') return socialThreadFor(target.id) ?? defaultLocalConversation();
        if (target.kind === 'post') return socialPostFor(target.id) ?? null;
        return null;
    }
    function localSummarySource(conversation, summaryId = '') {
        const info = localSummaryInfo(conversation);
        const record = summaryId ? info.records.find((item) => item.id === summaryId) : null;
        const startFloor = record ? record.startFloor : info.completedFloor + 1;
        const endFloor = record ? record.endFloor : info.totalFloors;
        const messages = (conversation?.messages ?? []).filter((message) => message.floor >= startFloor && message.floor <= endFloor).map((message) => ({
            floor: message.floor,
            sender: message.sender,
            speaker: message.sender === 'user' ? playerDisplayName({ forModel: true }) : (message.author?.nickname || '群友'),
            content: message.content,
        }));
        return { startFloor, endFloor, messages };
    }
    async function maybeRunLocalAutomaticSummary(target) {
        if (!ctx.chatSummaryEnabled() || ctx.localSummaryBusy) return;
        const conversation = localConversationForTarget(target);
        if (!conversation) return;
        const info = localSummaryInfo(conversation);
        if (info.pendingFloorCount < ctx.chatSummarySettings().interval) return;
        await runLocalConversationSummary(target, { automatic: true });
    }
    async function runLocalConversationSummary(target, { summaryId = '', automatic = false } = {}) {
        if (ctx.localSummaryBusy || !ctx.groupForumStore?.saveConversationSummary || typeof ctx.actionBridge.generateLocalGroupForumSummary !== 'function') return;
        const conversation = localConversationForTarget(target);
        const source = localSummarySource(conversation, summaryId);
        if (!source.messages.length) { if (!automatic) ctx.setFeedback('当前没有可整理的群聊或帖子消息。'); return; }
        ctx.localSummaryBusy = true;
        const activity = ctx.operationActivity.start('本地对话总结', automatic ? '正在自动整理本地群聊或帖子记录。' : '正在总结本地群聊或帖子记录。');
        // 与私聊手动总结语义一致：手动触发同样按设置的 retryLimit 重试。
        const retryLimit = ctx.chatSummarySettings().retryLimit;
        const attemptDetails = [];
        let result = null;
        for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
            let bridgeError = null;
            try { result = await ctx.actionBridge.generateLocalGroupForumSummary({ target, messages: source.messages }); }
            catch (error) { bridgeError = error; result = { ok: false }; }
            if (result?.ok && result.summary) break;
            const attemptDetail = communityFailureDetail('本地对话总结', result, bridgeError);
            if (attemptDetail) attemptDetails.push(attemptDetail);
        }
        const failureDetail = () => (attemptDetails.length > 1
            ? attemptDetails.map((text, index) => `第 ${index + 1} 次尝试\n${text}`).join('\n\n')
            : (attemptDetails[0] ?? null));
        try {
            if (result?.ok && result.summary) {
                await ctx.groupForumStore.saveConversationSummary({ target: { kind: target.kind, id: target.id }, summaryId, startFloor: source.startFloor, endFloor: source.endFloor, content: result.summary });
                await syncGroupForumSnapshot({ rerender: false });
                ctx.operationActivity.succeed(activity, '本地对话总结已保存。');
                if (!automatic) ctx.setFeedback('本地聊天总结已保存。');
            } else {
                const message = result?.message || '本次总结未完成，请稍后重试。';
                await ctx.groupForumStore.failConversationSummary({ target: { kind: target.kind, id: target.id }, startFloor: source.startFloor, endFloor: source.endFloor, message });
                await syncGroupForumSnapshot({ rerender: false });
                ctx.operationActivity.fail(activity, '本地对话总结未完成。', { detail: failureDetail() });
                if (!automatic) ctx.setFeedback(message);
            }
        } catch (error) {
            const writeDetail = localCacheFailureDetail('本地对话总结', error);
            const combined = [failureDetail(), writeDetail].filter(Boolean).join('\n\n') || null;
            ctx.operationActivity.fail(activity, '本地对话总结没有保存到本地缓存。', { detail: combined });
            if (!automatic) ctx.setFeedback('本地聊天总结没有保存。');
        }
        finally {
            ctx.localSummaryBusy = false;
            if (!ctx.isDestroyed && ctx.open && ((target.kind === 'group' && ctx.activeGroupCacheKey === target.id) || (target.kind === 'post' && ctx.activeForumPostId === target.id) || ctx.activePage === 'settings_chat_summary_history')) ctx.renderPage();
        }
        if (automatic && result?.ok) void maybeRunLocalAutomaticSummary(target);
    }
    function buildLocalConversationSummaryPage(kind) {
        const fallback = kind === 'group' ? activeGroupCard() : socialPostFor(ctx.activeForumPostId);
        const target = ctx.localSummaryTarget?.kind === kind ? ctx.localSummaryTarget : (fallback ? { kind, id: kind === 'group' ? fallback.cacheKey : fallback.id, title: kind === 'group' ? fallback.name : fallback.title } : null);
        if (!target) return createEmptyState({ documentRef: ctx.documentRef, variant: 'search', title: '当前对话暂不可查看总结', hint: '请返回上一页后重试。' });
        const conversation = localConversationForTarget(target) ?? defaultLocalConversation();
        const info = localSummaryInfo(conversation);
        const section = element('section', { className: 'yl-chat-summary-detail yl-local-summary-detail' });
        const overview = element('section', { className: 'yl-chat-summary-overview' });
        append(overview, [element('strong', { text: `${target.title} · 已对话 ${info.totalFloors} 楼` }), element('p', { text: info.status === 'failed' ? `上次总结未完成：${info.failureMessage}` : (info.pendingFloorCount ? `有 ${info.pendingFloorCount} 楼待整理。` : '暂时没有待整理的新消息。') })]);
        const pending = ctx.localSummaryBusy || Boolean(ctx.actionBridge.isPending?.('local_conversation_summary', target.id));
        if (ctx.chatSummaryEnabled() && info.pendingFloorCount > 0) {
            const summarize = element('button', { className: 'yl-settings-button', type: 'button', text: pending ? '正在总结…' : '立即总结未整理消息', disabled: pending });
            listen(summarize, summarize, 'click', () => { void runLocalConversationSummary(target); }, ctx.abortController.signal); overview.appendChild(summarize);
        }
        if (ctx.chatSummaryEnabled() && info.status === 'failed') {
            const retry = element('button', { className: 'yl-settings-button yl-settings-button-secondary', type: 'button', text: pending ? '正在重新总结…' : '重新总结', disabled: pending });
            listen(retry, retry, 'click', () => { void runLocalConversationSummary(target); }, ctx.abortController.signal); overview.appendChild(retry);
        }
        section.appendChild(overview);
        if (!info.records.length) {
            section.appendChild(createEmptyState({
                documentRef: ctx.documentRef, variant: 'inbox',
                title: ctx.chatSummaryEnabled() ? '还没有完成的总结记录' : '自动对话总结当前已关闭',
                hint: ctx.chatSummaryEnabled() ? '达到设定楼数后会自动整理。' : '请在设置中开启后再整理。',
            }));
        }
        else {
            const list = element('div', { className: 'yl-chat-summary-record-list' });
            for (const record of [...info.records].reverse()) {
                const card = element('article', { className: 'yl-chat-summary-record' });
                append(card, [element('strong', { text: `第 ${record.startFloor}–${record.endFloor} 楼总结` }), element('p', { text: record.content })]);
                if (ctx.chatSummaryEnabled()) {
                    const retry = element('button', { className: 'yl-settings-button yl-settings-button-secondary yl-chat-summary-record-retry', type: 'button', text: pending ? '正在处理…' : '重新总结这一段', disabled: pending });
                    listen(retry, retry, 'click', () => { void runLocalConversationSummary(target, { summaryId: record.id }); }, ctx.abortController.signal); card.appendChild(retry);
                }
                list.appendChild(card);
            }
            section.appendChild(list);
        }
        return section;
    }
    return {
        buildGroupsPage,
        socialGroups,
        socialThreads,
        socialPosts,
        socialThreadFor,
        socialPostFor,
        activeForumChannel,
        forumChannelForPost,
        forumPostsForActiveChannel,
        selectForumChannel,
        defaultLocalConversation,
        currentContentMode,
        blankLocalBinding,
        localBindingForMode,
        localModeBindings,
        withLocalBinding,
        forumAutoSettings,
        localSummaryInfo,
        safeLocalDisplayProfile,
        currentGroupCards,
        activeGroupCard,
        groupConversation,
        groupParticipants,
        localHistoryForModel,
        syncGroupForumSnapshot,
        privateChatMemberCandidates,
        closeGroupMemberPicker,
        openGroupMemberPicker,
        closeGroupAutoDialog,
        openGroupSettingsDialog,
        stopGroupAutoTimer,
        syncGroupAutoTimer,
        runGroupAutoUpdate,
        closeForumSettingsDialog,
        buildLocalBindingZone,
        openForumSettingsDialog,
        stopForumAutoTimer,
        syncForumAutoTimer,
        runForumExistingPostsAutoUpdate,
        buildGroupListActionButton,
        resetGroupRoomMenu,
        buildGroupRoomActionButton,
        buildGroupChatPage,
        buildGroupChatCreatePage,
        buildParticipantMeta,
        buildGroupRoomConfirmation,
        runGroupRoomDataAction,
        buildGroupChatRoomPage,
        sendGroupMessage,
        runGroupConversationUpdate,
        forumIsAtTop,
        forumIsAtBottom,
        forumPullParkOffset,
        forumPullTravel,
        resetForumPullIndicator,
        parkForumPullIndicator,
        updateForumPullIndicator,
        cancelForumWheelPull,
        cancelForumPullInteractions,
        normalizedWheelDelta,
        bindForumPullToRefresh,
        buildForumPage,
        runForumHomeRefresh,
        resetForumPostDeletion,
        resetForumParticipantActions,
        buildForumPostPage,
        buildForumParticipantDetailPage,
        sendForumComment,
        runForumPostConversationUpdate,
        localConversationForTarget,
        localSummarySource,
        maybeRunLocalAutomaticSummary,
        runLocalConversationSummary,
        buildLocalConversationSummaryPage,
    };
}

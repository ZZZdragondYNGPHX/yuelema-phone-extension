import { append, element, listen } from './dom.js';
import { readLatestState } from './mvu/adapter.js';
import { NAV_ITEMS, PAGE_COPY, createPhoneView, describeActionFailure } from './ui-model.js';
import { buildSettingsPanel } from './settings-panel.js';
import { buildCharacterCreatorPanel } from './characters/character-creator-panel.js';
import { avatarAcceptAttribute, compressLocalAvatar, projectAvatarError } from './characters/avatar-codec.js';
import { avatarImageSource } from './player-avatar-store.js';
import { createLauncherDragController } from './launcher-drag.js';
import { createImageManagerPanel } from './images/image-manager-panel.js';
import { formatImageDirective } from './images/image-directive.js';
import { createAvatarView, safeAvatarImageSource } from './ui/avatar-view.js';
import { createUnreadBadge } from './ui/badge.js';
import { buildErrorDetail, createOperationActivity } from './ui/operation-activity.js';
import { projectHostExtensionUpdateError } from './host-extension-update.js';
import { createUiIcon } from './ui/icon.js';
import { createRomanceHearts } from './ui/romance-hearts.js';
import { createMediaState } from './ui/media-state.js';
import { createEmptyState } from './ui/empty-state.js';
import { createDialogController } from './ui/dialog-controller.js';
import { DEFAULT_FORUM_AUTO_SETTINGS, DEFAULT_GROUP_AUTO_SETTINGS, FORUM_CHANNELS, externalGroupCacheKey, forumChannelForTopic, groupForumProfileForDisplay, publicProfileToGroupForumProfile } from './groups/group-forum-store.js';
import { SERVICE_UNLOCK_STORAGE_KEY, createSharedHelpers } from './pages/shared.js';
import { createDiscoverPage } from './pages/discover.js';
import { createMatchPage } from './pages/match.js';
import { createMessagesPage } from './pages/messages.js';
import { createChatPage } from './pages/chat.js';
import { createCommunityPage } from './pages/community.js';
import { createServicePage } from './pages/service.js';
import { createProfilePage } from './pages/profile.js';

const UI_VERSION = '1.0.0';
const UI_LAYOUT_STORAGE_KEY = 'yuelema.ui-layout/v1';
const LAUNCHER_POSITION_STORAGE_KEY = 'yuelema.launcher-position/v1';
const PHONE_PANEL_POSITION_STORAGE_KEY = 'yuelema.phone-panel-position/v1';
const PANEL_DRAG_THRESHOLD = 8;
/** 悬浮球兜底回右下角时距可视视口边缘的安全间距（与 launcher-drag 的 edgeGap 一致）。 */
const LAUNCHER_VIEWPORT_GAP = 12;
const PHONE_NAV_DRAG_HOLD_MS = 360;
const LOCAL_PAGE_COPY = Object.freeze({
    settings_image_generation: Object.freeze({ title: '生图设置' }),
    about: Object.freeze({ title: '关于软件' }),
    service_hub: Object.freeze({ title: '专属服务' }),
});
function pageCopy(pageId) { return PAGE_COPY[pageId] ?? LOCAL_PAGE_COPY[pageId] ?? null; }
const PRIMARY_PAGE_FOR = Object.freeze({
    group_chat: 'groups', group_chat_room: 'groups', group_chat_create: 'groups', group_chat_summary: 'groups', group_forum: 'groups', forum_post: 'groups', forum_post_summary: 'groups', private_chat: 'messages', profile_editor: 'profile', character_creator: 'profile', favorites: 'profile',
    settings_connections: 'profile', settings_prompts: 'profile', settings_privacy: 'profile', settings_personalization: 'profile', settings_personalization_preference: 'profile', settings_images: 'profile', settings_image_generation: 'profile', settings_preferences: 'profile', settings_console: 'profile', settings_chat_summary: 'profile', settings_chat_summary_config: 'profile', settings_chat_summary_history: 'profile', settings_chat_summary_history_detail: 'profile', private_chat_summary: 'messages', about: 'profile', service_hub: 'service_hub', candidate_detail: 'home',
});
// E1 裁平（裁决 D7）：settings 目录页已删除，全部设置二级页与“关于软件”直接挂在「我的」下。
const PAGE_PARENT_FOR = Object.freeze({
    group_chat: 'groups', group_chat_room: 'group_chat', group_chat_create: 'group_chat', group_chat_summary: 'group_chat_room', group_forum: 'groups', forum_post: 'group_forum', forum_post_summary: 'forum_post', private_chat: 'messages', profile_editor: 'profile', character_creator: 'profile', favorites: 'profile',
    settings_connections: 'profile', settings_prompts: 'profile', settings_privacy: 'profile', settings_personalization: 'settings_privacy', settings_personalization_preference: 'settings_personalization', settings_images: 'profile', settings_image_generation: 'profile', settings_preferences: 'profile', settings_console: 'profile', settings_chat_summary: 'profile', settings_chat_summary_config: 'settings_chat_summary', settings_chat_summary_history: 'settings_chat_summary', settings_chat_summary_history_detail: 'settings_chat_summary_history', private_chat_summary: 'private_chat', about: 'profile', candidate_detail: 'home',
});
const FEATURE_BINDING_FOR_PAGE = Object.freeze({
    home: Object.freeze([{ key: 'recommendation_refresh', title: '首页推荐刷新' }]),
    matches: Object.freeze([{ key: 'soul_match', title: '灵魂匹配' }, { key: 'text_match', title: '描述匹配' }]),
    messages: Object.freeze([{ key: 'chat', title: '私聊' }]),
    // group_forum 不再出现：社区广场的「社区设置」入口由 community.js 自建 topbar「⋯」承担（P2-C）。
    character_creator: Object.freeze([{ key: 'character_ai_completion', title: 'AI 完善补全' }, { key: 'character_full_authoring', title: 'AI 完整创作' }]),
    service_hub: Object.freeze([{ key: 'service_profile_generation', title: '约伴服务角色生成' }]),
});

function uiLayoutStorageOrNull(injectedStorage) {
    if (injectedStorage !== undefined) return injectedStorage && typeof injectedStorage.getItem === 'function' && typeof injectedStorage.setItem === 'function' ? injectedStorage : null;
    try {
        const storage = globalThis.localStorage;
        return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' ? storage : null;
    } catch { return null; }
}
function readUiLayoutPreference(storage) {
    try { return storage?.getItem(UI_LAYOUT_STORAGE_KEY) === 'desktop' ? 'desktop' : 'phone'; }
    catch { return 'phone'; }
}
function persistUiLayoutPreference(storage, mode) {
    try {
        if (!storage) return false;
        storage.setItem(UI_LAYOUT_STORAGE_KEY, mode === 'desktop' ? 'desktop' : 'phone');
        return true;
    } catch { return false; }
}

/** @param {unknown} value */
function isFiniteCoordinate(value) {
    return Number.isFinite(Number(value));
}
function readLauncherPosition(storage) {
    try {
        const raw = storage?.getItem(LAUNCHER_POSITION_STORAGE_KEY);
        const value = raw ? JSON.parse(raw) : null;
        return value && isFiniteCoordinate(value.left) && isFiniteCoordinate(value.top)
            ? { left: Number(value.left), top: Number(value.top) }
            : null;
    } catch { return null; }
}
function persistLauncherPosition(storage, position) {
    try {
        if (!storage || !position || !isFiniteCoordinate(position.left) || !isFiniteCoordinate(position.top)) return false;
        storage.setItem(LAUNCHER_POSITION_STORAGE_KEY, JSON.stringify({
            left: Math.round(Number(position.left)),
            top: Math.round(Number(position.top)),
        }));
        return true;
    } catch { return false; }
}

function readPhonePanelPosition(storage) {
    try {
        const raw = storage?.getItem(PHONE_PANEL_POSITION_STORAGE_KEY);
        const value = raw ? JSON.parse(raw) : null;
        return value && isFiniteCoordinate(value.left) && isFiniteCoordinate(value.top)
            ? { left: Number(value.left), top: Number(value.top) }
            : null;
    } catch { return null; }
}
function persistPhonePanelPosition(storage, position) {
    try {
        if (!storage || !position || !isFiniteCoordinate(position.left) || !isFiniteCoordinate(position.top)) return false;
        storage.setItem(PHONE_PANEL_POSITION_STORAGE_KEY, JSON.stringify({ left: Math.round(Number(position.left)), top: Math.round(Number(position.top)) }));
        return true;
    } catch { return false; }
}

/** @param {{ documentRef: Document, rootId: string, actionBridge: ReturnType<import('./action-bridge.js').createActionBridge>, readState?: () => unknown }} options */
export function mountPhoneApp({ documentRef, rootId, actionBridge, settingsStore, llmClient, characterLibrary, playerAvatarStore = null, imageLibrary = null, imageMatchCoordinator = null, remoteImageImporter = null, extensionUpdater = null, groupForumStore = null, serviceOrderHistoryStore = null, uiLayoutStorage = undefined, readState = () => readLatestState() }) {
    const abortController = new AbortController();
    // 弹窗焦点统一由控制器管理：打开聚焦、Tab 焦点环、Escape 关栈顶、关闭礼貌回 opener。
    const dialogController = createDialogController({ documentRef });
    const root = documentRef.createElement('section');
    root.id = rootId;
    root.className = 'yl-phone-extension';
    root.setAttribute('aria-label', '约了吗小手机');
    root.dataset.contentMode = 'SFW';

    // The layout is a browser-only preference. It deliberately never flows into MVU,
    // prompts, network payloads, exported data, or action-bridge commands.
    const layoutStorage = uiLayoutStorageOrNull(uiLayoutStorage);
    let uiLayoutMode = readUiLayoutPreference(layoutStorage);
    root.dataset.uiLayout = uiLayoutMode;

    let open = false;
    let activePage = 'home';
    let refreshing = false;
    let extensionUpdatePending = false;
    let activeMessageSessionUid = '';
    let messageSearchQuery = '';
    let chatMoreMenuSessionUid = '';
    let chatConfirmationSessionUid = '';
    let chatConfirmationKind = '';
    let destructiveChatSessionUid = '';
    let destructiveChatKind = '';
    let activeMeetupSessionUid = '';
    let summaryHistorySessionUid = '';
    let activeChatToolsSessionUid = '';
    let chatToolLongPressTimer = null;
    let chatToolLongPressSessionUid = '';
    let chatToolLongPressInputType = '';
    let suppressChatToolClickForSessionUid = '';
    let chatToolClickSuppressionTimer = null;
    let selectedCandidateUid = '';
    let voiceMatchText = '';
    let aboutClickStreak = 0;
    let aboutUnlocked = false;
    let aboutModeControlOpen = false;
    let releaseNotesClickStreak = 0;
    let serviceEntryUnlocked = false;
    let serviceHubUnlocked = (() => { try { return globalThis.localStorage?.getItem(SERVICE_UNLOCK_STORAGE_KEY) === '1'; } catch { return false; } })();
    let activeServiceHubTab = 'featured';
    let activeServiceCategoryId = '';
    // XP search stays only in this mounted UI instance. It never enters MVU, history, or diagnostics.
    let serviceXpSearchDraft = '';
    let serviceXpSearchApplied = '';
    let serviceProfileSequence = 0;
    let serviceGenerationBatchSequence = 0;
    let serviceProfileGenerationPending = false;
    let serviceProfileGenerationAbortController = null;
    let serviceProfileHandoffPendingId = '';
    let serviceOrderRepeatPendingId = '';
    let serviceOrderMutationPendingId = '';
    // Separate from generic UI interaction generations: an order write may finish after the phone closes,
    // but its late result must never refill the host textarea or navigate the UI.
    let serviceOrderOperationEpoch = 0;
    const serviceBoundaryDrafts = new Map();
    const serviceLocalProfiles = [];
    const serviceGenerationBatches = new Map();
    const selectedServiceProfileIds = new Set();
    let scheduledServiceCompletionOrderId = '';
    let playerProfileDraft = null;
    const chatDrafts = new Map();
    const meetupDrafts = new Map();
    const groupMessageDrafts = new Map();
    const forumCommentDrafts = new Map();
    let activeGroupCacheKey = '';
    let activeForumPostId = '';
    let activeForumChannelId = '';
    let groupListMenuOpen = false;
    let groupRoomMenuOpen = false;
    let groupRoomConfirmation = '';
    let groupRoomConfirmationKey = '';
    let groupRoomDestructiveKey = '';
    let groupSearchOpen = false;
    let groupSearchQuery = '';
    let groupCreateName = '';
    let groupCreateMembers = [];
    let groupMemberPickerOpen = false;
    let groupAutoDialogKey = '';
    let groupAutoTimer = null;
    let groupAutoTimerKey = '';
    let groupAutoGeneration = 0;
    let forumPullState = null;
    let forumWheelPullState = null;
    let forumInteractionAbortController = null;
    let forumRefreshing = false;
    let forumRefreshMode = '';
    let forumAutoTimer = null;
    let forumAutoGeneration = 0;
    let localSummaryTarget = null;
    let localSummaryBusy = false;
    let groupForumSnapshot = (() => {
        try { return groupForumStore?.peek?.() ?? Object.freeze({ groups: [], threads: [], posts: [] }); }
        catch { return Object.freeze({ groups: [], threads: [], posts: [] }); }
    })();
    let currentView = createPhoneView(readState());
    let operationGeneration = 0;
    let activeOperation = null;
    let operationAutoCloseTimer = null;
    let privateChatRequestGeneration = 0;
    let summaryToast = null;
    let summaryToastTimer = null;
    let featureBindingDialogState = null;
    let avatarUploadPending = false;
    let imageManagerPanel = null;
    const matchedImageByProfile = new Map();
    const imageMatchPending = new Map();
    // Image presentation state stays in this mounted UI only. It never enters MVU,
    // prompts, storage, diagnostics, or image-library records.
    const imageMatchFailures = new Set();
    const imageAssetFailures = new Set();
    const imageAssetsReady = new Set();
    const privateImageDirectives = new Map();
    const conversationImageStates = new Map();
    const imageDirectiveLongPressTimers = new Set();
    const operationActivity = createOperationActivity();
    let unsubscribeOperationActivity = null;
    let interactionGeneration = 0;
    let isDestroyed = false;
    let panelHasCustomPosition = false;

    /** 弹窗关闭兜底：opener 已被页面重渲替换时，焦点不得滞留在隐藏弹窗内，落到当前页标题。 */
    function settleFocusAfterDialogClose(dialog) {
        const active = documentRef.activeElement ?? null;
        let node = active;
        let inside = false;
        while (node) {
            if (node === dialog) { inside = true; break; }
            node = node.parentNode ?? null;
        }
        if (!inside) return;
        const heading = content.querySelector?.('.yl-page-heading')?.querySelector?.('h1') ?? null;
        if (!heading || typeof heading.focus !== 'function') return;
        heading.setAttribute('tabindex', '-1');
        try { heading.focus(); } catch { /* 焦点兜底失败保持静默 */ }
    }
    function closeManagedDialog(dialog) {
        dialogController.close(dialog);
        settleFocusAfterDialogClose(dialog);
    }
    /** 结构性关闭图标：本地 SVG 白名单，不再依赖 Unicode “×” 字符渲染。 */
    function applyCloseIcon(button) {
        button.appendChild(createUiIcon(documentRef, 'close', { className: 'yl-dialog-close-svg', size: 18 }));
        return button;
    }
    /** 列表/入口右侧的“进入”指示：同一 chevron SVG 家族，替代文字 “›”。 */
    function openMark(className = 'yl-session-open-mark') {
        const mark = element('span', { className });
        mark.setAttribute('aria-hidden', 'true');
        mark.appendChild(createUiIcon(documentRef, 'chevron_right', { className: 'yl-open-mark-svg', size: 16 }));
        return mark;
    }
    /** 悬浮球品牌位：设计系统 2.0 心形气泡 logo SVG，替代文字「约」。 */
    const launcher = element('button', { className: 'yl-phone-launcher', type: 'button', ariaLabel: '打开约了吗小手机', pressed: false });
    launcher.appendChild(createUiIcon(documentRef, 'logo', { className: 'yl-launcher-logo-svg', size: 26 }));
    launcher.appendChild(element('span', { className: 'yl-phone-launcher-label', text: '约了吗' }));
    const panel = element('aside', { className: 'yl-phone-panel', ariaLabel: '约了吗小手机窗口', hidden: true });
    panel.dataset.uiLayout = uiLayoutMode;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    const header = element('header', { className: 'yl-phone-header', ariaLabel: '拖动约了吗小手机窗口' });
    header.setAttribute('title', '按住此处拖动小手机');
    const brand = element('div', { className: 'yl-phone-brand' });
    const statusDot = element('span', { className: 'yl-status-dot' });
    statusDot.setAttribute('aria-hidden', 'true');
    const statusLine = element('span', { className: 'yl-phone-status' });
    append(brand, [element('strong', { text: '约了吗' }), statusDot, statusLine]);
    const closeButton = applyCloseIcon(element('button', { className: 'yl-phone-close', type: 'button', ariaLabel: '关闭约了吗小手机' }));
    const headerActions = element('div', { className: 'yl-phone-header-actions' });
    /** 拖动柄：grip SVG 替代盲文字符「⠿」。 */
    const dragHint = element('span', { className: 'yl-phone-drag-hint' });
    dragHint.appendChild(createUiIcon(documentRef, 'grip', { className: 'yl-drag-grip-svg', size: 14 }));
    dragHint.appendChild(element('span', { text: '拖动' }));
    dragHint.setAttribute('aria-hidden', 'true');
    append(headerActions, [dragHint, closeButton]);
    append(header, [brand, headerActions]);
    const content = element('main', { className: 'yl-phone-content' });
    const uiLayoutStatus = element('p', { className: 'yl-ui-layout-status' });
    uiLayoutStatus.setAttribute('role', 'status');
    uiLayoutStatus.setAttribute('aria-live', 'polite');
    uiLayoutStatus.setAttribute('aria-atomic', 'true');
    const nav = element('nav', { className: 'yl-phone-nav', ariaLabel: '约了吗主导航' });
    const navButtons = new Map();
    function createPrimaryNavButton(item) {
        const button = element('button', { className: 'yl-phone-nav-item', type: 'button', ariaLabel: item.label });
        const iconWrap = element('span', { className: 'yl-nav-icon' });
        iconWrap.appendChild(createUiIcon(documentRef, item.iconName ?? item.id, { className: 'yl-nav-icon-svg', size: 22 }));
        append(button, [
            iconWrap,
            element('span', { className: 'yl-nav-label', text: item.label }),
        ]);
        button.dataset.page = item.id;
        navButtons.set(item.id, button);
        listen(button, button, 'click', () => setActivePage(item.id), abortController.signal);
        return button;
    }
    const serviceNavButton = createPrimaryNavButton({ id: 'service_hub', label: '约伴', iconName: 'service_hub' });
    serviceNavButton.classList.toggle('yl-service-nav', true);
    serviceNavButton.hidden = true;
    for (const item of NAV_ITEMS) {
        if (item.id === 'profile') nav.appendChild(serviceNavButton);
        nav.appendChild(createPrimaryNavButton(item));
    }
    append(panel, [header, content, nav, uiLayoutStatus]);

    const operationDialog = element('section', { className: 'yl-phone-placeholder yl-operation-dialog', hidden: true });
    operationDialog.setAttribute('role', 'dialog');
    operationDialog.setAttribute('aria-modal', 'false');
    operationDialog.setAttribute('aria-live', 'polite');
    const operationDismiss = applyCloseIcon(element('button', {
        className: 'yl-dialog-close', type: 'button', name: 'operation-dialog-close',
        ariaLabel: '关闭操作弹窗',
    }));
    const operationTitle = element('h2', { text: '' });
    // 恋爱四态动画与匹配页共用同一 SVG 双心构建器（src/ui/romance-hearts.js），不再渲染字符动画。
    const romanceVisual = element('div', { className: 'yl-romance-visual', hidden: true, ariaLabel: '恋爱互动状态动画' });
    romanceVisual.setAttribute('aria-hidden', 'true');
    const operationMessage = element('p', { className: 'yl-phone-page-description', text: '' });
    const operationActions = element('div', { className: 'yl-settings-actions' });
    const operationClose = element('button', {
        className: 'yl-settings-button', type: 'button', name: 'operation-dialog-action',
        ariaLabel: '关闭操作提示', text: '关闭',
    });
    append(operationActions, [operationClose]);
    append(operationDialog, [operationDismiss, operationTitle, romanceVisual, operationMessage, operationActions]);

    const bindingDialog = element('section', { className: 'yl-settings-section yl-settings-modal yl-feature-binding-modal', hidden: true });
    bindingDialog.setAttribute('role', 'dialog');
    bindingDialog.setAttribute('aria-modal', 'false');
    bindingDialog.setAttribute('aria-label', '功能预设选项');
    const bindingDialogTitlebar = element('div', { className: 'yl-dialog-titlebar' });
    const bindingDialogTitle = element('h2', { text: '功能预设选项' });
    const bindingDialogClose = applyCloseIcon(element('button', { className: 'yl-dialog-close', type: 'button', ariaLabel: '关闭功能预设选项' }));
    const bindingDialogContent = element('div', { className: 'yl-settings-panel' });
    append(bindingDialogTitlebar, [bindingDialogTitle, bindingDialogClose]);
    append(bindingDialog, [bindingDialogTitlebar, bindingDialogContent]);
    const avatarDialog = element('section', { className: 'yl-settings-section yl-settings-modal yl-avatar-modal', hidden: true });
    avatarDialog.setAttribute('role', 'dialog');
    avatarDialog.setAttribute('aria-modal', 'false');
    avatarDialog.setAttribute('aria-label', '更换个人头像');
    const avatarDialogTitlebar = element('div', { className: 'yl-dialog-titlebar' });
    const avatarDialogTitle = element('h2', { text: '更换头像' });
    const avatarDialogClose = applyCloseIcon(element('button', { className: 'yl-dialog-close', type: 'button', ariaLabel: '关闭头像菜单' }));
    append(avatarDialogTitlebar, [avatarDialogTitle, avatarDialogClose]);
    const avatarDialogSummary = element('p', { className: 'yl-settings-summary', text: '头像仅保存到当前浏览器，不会写入公开资料、MVU 或提示词。' });
    const avatarFileInput = element('input', { type: 'file', accept: avatarAcceptAttribute(), ariaLabel: '选择本地头像文件' });
    avatarFileInput.hidden = true;
    const avatarFileButton = element('button', { className: 'yl-settings-button', type: 'button', text: '从本地导入图片' });
    const avatarDialogHint = element('p', { className: 'yl-avatar-source-hint', text: '仅支持从本地导入 PNG、JPEG 或 WebP；不加载网络图片链接。' });
    const avatarRemoveButton = element('button', { className: 'yl-settings-button yl-avatar-remove', type: 'button', text: '移除头像' });
    append(avatarDialog, [avatarDialogTitlebar, avatarDialogSummary, avatarFileInput, avatarFileButton, avatarDialogHint, avatarRemoveButton]);
    const groupMemberPickerDialog = element('section', { className: 'yl-settings-section yl-settings-modal yl-group-member-picker', hidden: true });
    groupMemberPickerDialog.setAttribute('role', 'dialog');
    groupMemberPickerDialog.setAttribute('aria-modal', 'false');
    groupMemberPickerDialog.setAttribute('aria-label', '添加私聊角色');
    const groupMemberPickerTitlebar = element('div', { className: 'yl-dialog-titlebar' });
    const groupMemberPickerTitle = element('h2', { text: '添加私聊角色' });
    const groupMemberPickerClose = applyCloseIcon(element('button', { className: 'yl-dialog-close', type: 'button', ariaLabel: '关闭私聊角色选择' }));
    const groupMemberPickerContent = element('div', { className: 'yl-settings-panel yl-group-member-picker-content' });
    append(groupMemberPickerTitlebar, [groupMemberPickerTitle, groupMemberPickerClose]);
    append(groupMemberPickerDialog, [groupMemberPickerTitlebar, groupMemberPickerContent]);

    const groupAutoDialog = element('section', { className: 'yl-settings-section yl-settings-modal yl-group-auto-dialog', hidden: true });
    groupAutoDialog.setAttribute('role', 'dialog');
    groupAutoDialog.setAttribute('aria-modal', 'false');
    groupAutoDialog.setAttribute('aria-label', '聊天群自动更新');
    const groupAutoTitlebar = element('div', { className: 'yl-dialog-titlebar' });
    const groupAutoTitle = element('h2', { text: '自动更新' });
    const groupAutoClose = applyCloseIcon(element('button', { className: 'yl-dialog-close', type: 'button', ariaLabel: '关闭自动更新设置' }));
    const groupAutoContent = element('div', { className: 'yl-settings-panel yl-group-auto-content' });
    append(groupAutoTitlebar, [groupAutoTitle, groupAutoClose]);
    append(groupAutoDialog, [groupAutoTitlebar, groupAutoContent]);

    const forumSettingsDialog = element('section', { className: 'yl-settings-section yl-settings-modal yl-forum-settings-dialog', hidden: true });
    forumSettingsDialog.setAttribute('role', 'dialog');
    forumSettingsDialog.setAttribute('aria-modal', 'false');
    forumSettingsDialog.setAttribute('aria-label', '社区设置');
    const forumSettingsTitlebar = element('div', { className: 'yl-dialog-titlebar' });
    const forumSettingsTitle = element('h2', { text: '社区设置' });
    const forumSettingsClose = applyCloseIcon(element('button', { className: 'yl-dialog-close', type: 'button', ariaLabel: '关闭社区设置' }));
    const forumSettingsContent = element('div', { className: 'yl-settings-panel yl-forum-settings-content' });
    append(forumSettingsTitlebar, [forumSettingsTitle, forumSettingsClose]);
    append(forumSettingsDialog, [forumSettingsTitlebar, forumSettingsContent]);

    const imageDirectiveDialog = element('section', { className: 'yl-settings-section yl-settings-modal yl-image-directive-dialog', hidden: true });
    imageDirectiveDialog.setAttribute('role', 'dialog');
    imageDirectiveDialog.setAttribute('aria-modal', 'false');
    imageDirectiveDialog.setAttribute('aria-label', '生图结构化语句');
    const imageDirectiveTitlebar = element('div', { className: 'yl-dialog-titlebar' });
    const imageDirectiveClose = applyCloseIcon(element('button', { className: 'yl-dialog-close', type: 'button', ariaLabel: '关闭生图结构化语句' }));
    append(imageDirectiveTitlebar, [element('h2', { text: '生图结构化语句' }), imageDirectiveClose]);
    const imageDirectiveDialogText = element('textarea', { className: 'yl-settings-control yl-settings-textarea yl-image-directive-dialog-text', rows: 8, ariaLabel: '当前图片结构化语句' });
    imageDirectiveDialogText.readOnly = true;
    append(imageDirectiveDialog, [imageDirectiveTitlebar, element('p', { className: 'yl-settings-summary', text: '这里只展示 AI 本次返回的场景结构，不包含角色绘图 DNA、固定提示词或 API Key。' }), imageDirectiveDialogText]);

    append(root, [launcher, panel, operationDialog, bindingDialog, avatarDialog, groupMemberPickerDialog, groupAutoDialog, forumSettingsDialog, imageDirectiveDialog]);

    function formatDirectiveForDisplay(directive) {
        try { return formatImageDirective(directive); }
        catch { return ''; }
    }
    function closeImageDirectiveDialog() {
        closeManagedDialog(imageDirectiveDialog);
        imageDirectiveDialogText.value = '';
    }
    function openImageDirectiveDialog(directive) {
        imageDirectiveDialogText.value = formatDirectiveForDisplay(directive) || '结构化语句当前不可用。';
        dialogController.open(imageDirectiveDialog, { onRequestClose: closeImageDirectiveDialog });
    }
    function clearImageDirectiveLongPressTimers() {
        for (const timer of imageDirectiveLongPressTimers) clearTimeout(timer);
        imageDirectiveLongPressTimers.clear();
    }
    function safeConversationImageSource(value) {
        const source = typeof value === 'string' ? value : '';
        if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/iu.test(source)) return source;
        return '';
    }
    function imageDirectiveStateKey(kind, conversationId, messageId) {
        return String(kind) + ':' + String(conversationId) + ':' + String(messageId);
    }
    function imageDirectiveKindLabel(kind) {
        return ({ share_photo: '分享照片', selfie: '自拍', scene_snapshot: '场景快照', private_photo: '私照' })[kind] || '图片';
    }
    function conversationImageSettings(kind, conversationId) {
        try {
            return settingsStore?.getConversationImageGenerationSettings?.(kind, conversationId) ?? { autoGenerate: false };
        } catch {
            return { autoGenerate: false };
        }
    }
    function imageGenerationEnabled() {
        try { return settingsStore?.getImageGenerationSettings?.().enabled === true; }
        catch { return false; }
    }
    function buildConversationImageControls({ kind, conversationId }) {
        const controls = element('div', { className: 'yl-conversation-image-controls' });
        const settingsButton = element('button', { className: 'yl-settings-button yl-settings-button-secondary yl-conversation-image-settings-button', type: 'button', text: '生图', ariaLabel: '打开生图设置' });
        listen(settingsButton, settingsButton, 'click', () => setActivePage('settings_image_generation'), abortController.signal);
        const available = Boolean(settingsStore
            && typeof settingsStore.getConversationImageGenerationSettings === 'function'
            && typeof settingsStore.setConversationImageGenerationSettings === 'function');
        const toggleLabel = element('label', { className: 'yl-conversation-image-toggle' });
        toggleLabel.appendChild(element('span', { text: '自动生图' }));
        const switchWrap = element('span', { className: 'yl-switch' });
        const toggle = element('input', { type: 'checkbox', checked: conversationImageSettings(kind, conversationId).autoGenerate, disabled: !available, ariaLabel: kind === 'private' ? '私聊自动生图' : kind === 'group' ? '群聊自动生图' : '论坛自动生图' });
        switchWrap.appendChild(toggle);
        toggleLabel.appendChild(switchWrap);
        listen(toggle, toggle, 'change', () => {
            if (!available) return;
            try {
                settingsStore.setConversationImageGenerationSettings(kind, conversationId, { autoGenerate: Boolean(toggle.checked) });
                setFeedback(toggle.checked ? '当前会话已开启自动生图。' : '当前会话已关闭自动生图。');
            } catch {
                toggle.checked = !toggle.checked;
                setFeedback('当前会话的自动生图设置未保存。');
            }
        }, abortController.signal);
        append(controls, [settingsButton, toggleLabel]);
        return controls;
    }
    function attachImageDirectiveLongPress(image, directive) {
        let timer = null;
        const cancel = () => {
            if (timer === null) return;
            clearTimeout(timer);
            imageDirectiveLongPressTimers.delete(timer);
            timer = null;
        };
        const start = () => {
            cancel();
            timer = setTimeout(() => {
                imageDirectiveLongPressTimers.delete(timer);
                timer = null;
                openImageDirectiveDialog(directive);
            }, 560);
            imageDirectiveLongPressTimers.add(timer);
        };
        listen(image, image, 'pointerdown', start, abortController.signal);
        listen(image, image, 'pointerup', cancel, abortController.signal);
        listen(image, image, 'pointercancel', cancel, abortController.signal);
        listen(image, image, 'pointerleave', cancel, abortController.signal);
        listen(image, image, 'touchstart', start, abortController.signal);
        listen(image, image, 'touchend', cancel, abortController.signal);
        listen(image, image, 'touchcancel', cancel, abortController.signal);
        listen(image, image, 'contextmenu', (event) => { event.preventDefault?.(); cancel(); openImageDirectiveDialog(directive); }, abortController.signal);
    }
    function localProfileCharacterUid(profile) {
        const nickname = String(profile?.nickname ?? profile?.昵称 ?? '').trim();
        if (!nickname) return '';
        return ctx.messageSessions().find((session) => ctx.chatNickname(session) === nickname)?.npcUid ?? '';
    }
    function publicImageFailureMessage(result) {
        if (result?.code === 'image_generation_disabled') return '请先在生图设置中启用接口。';
        if (result?.code === 'image_character_required' || result?.code === 'image_character_unavailable') return '这张人物图片暂时没有可用的成年角色绘图资料。';
        if (result?.code === 'ui_action_pending') return '当前会话已有图片正在生成，请稍候。';
        return '图片未生成，请稍后重试或检查生图设置。';
    }
    async function generateConversationImage({ kind, conversationId, messageId, characterUid = '', directive, automatic = false }) {
        const key = imageDirectiveStateKey(kind, conversationId, messageId);
        if (typeof actionBridge.generateConversationImage !== 'function') {
            conversationImageStates.set(key, { status: 'failed', directive, message: '生图服务当前未接入。' });
            if (!automatic) setFeedback('生图服务当前未接入。');
            renderPage();
            return;
        }
        conversationImageStates.set(key, { status: 'pending', directive, message: automatic ? '检测到生图结构，正在自动生成…' : '正在生成图片…' });
        renderPage();
        let result;
        try { result = await actionBridge.generateConversationImage({ kind, conversationId, messageId, characterUid, directive, signal: abortController.signal }); }
        catch { result = { ok: false }; }
        if (isDestroyed) return;
        const source = safeConversationImageSource(result?.image?.src ?? result?.image?.dataUrl ?? result?.dataUrl);
        if (result?.ok && source) {
            conversationImageStates.set(key, { status: 'ready', directive, imageSource: source, message: '' });
        } else {
            const message = publicImageFailureMessage(result);
            conversationImageStates.set(key, { status: 'failed', directive, message });
            if (!automatic) setFeedback(message);
        }
        renderPage();
    }
    function buildImageDirectiveCard({ kind, conversationId, messageId, characterUid = '', directive }) {
        const formatted = formatDirectiveForDisplay(directive);
        if (!formatted || !messageId || !conversationId) return null;
        const key = imageDirectiveStateKey(kind, conversationId, messageId);
        let state = conversationImageStates.get(key) ?? null;
        if (!state && imageGenerationEnabled() && conversationImageSettings(kind, conversationId).autoGenerate) {
            state = { status: 'queued', directive, message: '已识别生图结构，等待自动生成…' };
            conversationImageStates.set(key, state);
            queueMicrotask(() => {
                if (isDestroyed || conversationImageStates.get(key)?.status !== 'queued') return;
                void generateConversationImage({ kind, conversationId, messageId, characterUid, directive, automatic: true });
            });
        }
        const card = element('section', { className: 'yl-image-directive-card' });
        card.dataset.status = state?.status ?? 'idle';
        const headerRow = element('div', { className: 'yl-image-directive-header' });
        const toggle = element('button', { className: 'yl-image-directive-toggle', type: 'button', text: '本次生图结构 · ' + imageDirectiveKindLabel(directive.kind), ariaLabel: '展开或收起本次生图结构' });
        const preview = element('div', { className: 'yl-image-directive-preview', hidden: !state });
        toggle.setAttribute('aria-expanded', String(!preview.hidden));
        listen(toggle, toggle, 'click', () => { preview.hidden = !preview.hidden; toggle.setAttribute('aria-expanded', String(!preview.hidden)); }, abortController.signal);
        const action = element('button', { className: 'yl-settings-button yl-image-directive-action', type: 'button', text: state?.status === 'ready' || state?.status === 'failed' ? '重新生成' : state?.status === 'pending' ? '生成中…' : state?.status === 'queued' ? '等待自动生图…' : '生图', disabled: state?.status === 'pending' || state?.status === 'queued', ariaLabel: state?.status === 'ready' || state?.status === 'failed' ? '重新生成图片' : '生成图片' });
        listen(action, action, 'click', () => { void generateConversationImage({ kind, conversationId, messageId, characterUid, directive }); }, abortController.signal);
        append(headerRow, [toggle, action]);
        card.appendChild(headerRow);
        if (state?.status === 'ready') {
            const image = element('img', { className: 'yl-image-directive-image', src: state.imageSource, alt: 'AI 根据本次结构生成的图片', loading: 'lazy', referrerPolicy: 'no-referrer' });
            attachImageDirectiveLongPress(image, directive);
            preview.appendChild(image);
            preview.appendChild(element('p', { className: 'yl-image-directive-hint', text: '长按图片可查看本次结构化语句。' }));
        } else {
            if (state?.message) preview.appendChild(element('p', { className: 'yl-image-directive-status', text: state.message }));
            preview.appendChild(element('p', { className: 'yl-image-directive-structure', text: formatted }));
        }
        card.appendChild(preview);
        return card;
    }
    documentRef.body.appendChild(root);

    // Launcher placement is local browser UI state only. It deliberately never enters
    // MVU, prompts, settings export, or network requests.
    const launcherDrag = createLauncherDragController({
        launcher,
        documentRef,
        threshold: 8,
        edgeGap: 12,
        onDragEnd(result) {
            if (result.dragged && !result.cancelled && result.position) {
                persistLauncherPosition(layoutStorage, result.position);
            }
        },
    });
    if (!launcherDrag.restore(readLauncherPosition(layoutStorage))) ensureLauncherWithinViewport();
    let panelDrag = null;
    function viewportSize() {
        const view = documentRef.defaultView;
        return {
            width: Math.max(1, Number(view?.innerWidth || documentRef.documentElement?.clientWidth || 360)),
            height: Math.max(1, Number(view?.innerHeight || documentRef.documentElement?.clientHeight || 640)),
        };
    }
    function phoneVisualViewport() {
        const visualViewport = documentRef.defaultView?.visualViewport;
        const width = Number(visualViewport?.width);
        const height = Number(visualViewport?.height);
        if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
            return {
                left: Number.isFinite(Number(visualViewport.offsetLeft)) ? Number(visualViewport.offsetLeft) : 0,
                top: Number.isFinite(Number(visualViewport.offsetTop)) ? Number(visualViewport.offsetTop) : 0,
                width,
                height,
            };
        }
        return { left: 0, top: 0, ...viewportSize() };
    }
    function syncPhonePanelViewport() {
        if (uiLayoutMode !== 'phone' || !panel.style?.setProperty) return;
        const viewport = phoneVisualViewport();
        panel.style.setProperty('--yl-phone-viewport-left', Math.round(viewport.left) + 'px');
        panel.style.setProperty('--yl-phone-viewport-top', Math.round(viewport.top) + 'px');
        panel.style.setProperty('--yl-phone-viewport-width', Math.max(1, Math.round(viewport.width)) + 'px');
        panel.style.setProperty('--yl-phone-viewport-height', Math.max(1, Math.round(viewport.height)) + 'px');
    }
    function clampPanelPosition(left, top, width, height) {
        // 移动端地址栏/软键盘会让可视视口偏离布局视口；钳制一律以 visualViewport 为准
        // （无该 API 时 phoneVisualViewport 自带 window 尺寸回退，offset 为 0，行为不变）。
        const viewport = phoneVisualViewport();
        const minLeft = viewport.left;
        const minTop = viewport.top;
        return {
            left: Math.max(minLeft, Math.min(left, Math.max(minLeft, viewport.left + viewport.width - width))),
            top: Math.max(minTop, Math.min(top, Math.max(minTop, viewport.top + viewport.height - height))),
        };
    }
    /** 面板在当前可视视口内的居中坐标（视口比面板小则贴视口原点，保证头部可见）。 */
    function centeredPanelPosition(width, height) {
        const viewport = phoneVisualViewport();
        return {
            left: viewport.left + Math.max(0, (viewport.width - width) / 2),
            top: viewport.top + Math.max(0, (viewport.height - height) / 2),
        };
    }
    /**
     * 按可视视口坐标写入面板位置，并实测一次补偿宿主 transform 祖先（SillyTavern 的
     * `html { -webkit-transform: translateZ(0) }` 会把 fixed 的包含块从视口改成宿主盒）
     * 造成的坐标系偏移。无法实测时保留首写值。
     */
    function writePanelViewportPosition(left, top) {
        setPanelPosition(left, top);
        const check = panel.getBoundingClientRect?.();
        const measuredLeft = Number(check?.left);
        const measuredTop = Number(check?.top);
        if (!Number.isFinite(measuredLeft) || !Number.isFinite(measuredTop)) return;
        const originX = measuredLeft - left;
        const originY = measuredTop - top;
        if (originX || originY) setPanelPosition(left - originX, top - originY);
    }
    /**
     * 悬浮球兜底定位：CSS 的 right/bottom 锚点在带 transform 的宿主上解析到宿主盒而非
     * 可视视口，移动端可能整体跑到屏幕外。只在实测越界时介入：优先恢复持久化坐标
     * （restore 内部会按当前视口重新钳制并补偿 transform），否则落到可视视口右下角默认位。
     */
    function ensureLauncherWithinViewport() {
        if (launcherDrag.dragging) return;
        const rect = launcher.getBoundingClientRect?.();
        const width = Number(rect?.width);
        const height = Number(rect?.height);
        if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return;
        const viewport = phoneVisualViewport();
        const tolerance = 1;
        const left = Number(rect.left) || 0;
        const top = Number(rect.top) || 0;
        const inside = left >= viewport.left - tolerance
            && top >= viewport.top - tolerance
            && left + width <= viewport.left + viewport.width + tolerance
            && top + height <= viewport.top + viewport.height + tolerance;
        if (inside) return;
        launcherDrag.restore(readLauncherPosition(layoutStorage) ?? {
            left: viewport.left + viewport.width - width - LAUNCHER_VIEWPORT_GAP,
            top: viewport.top + viewport.height - height - LAUNCHER_VIEWPORT_GAP,
        });
    }
    function clampCustomPanelPosition() {
        // Preserve the CSS right/bottom anchor until the user has deliberately dragged.
        if (!panelHasCustomPosition) return;
        const rawLeft = typeof panel.style?.getPropertyValue === 'function' ? panel.style.getPropertyValue('left') : (panel.style?.left ?? '');
        const rawTop = typeof panel.style?.getPropertyValue === 'function' ? panel.style.getPropertyValue('top') : (panel.style?.top ?? '');
        const left = Number.parseFloat(rawLeft);
        const top = Number.parseFloat(rawTop);
        if (!Number.isFinite(left) || !Number.isFinite(top)) return;
        const rect = panel.getBoundingClientRect?.();
        const width = Number(rect?.width);
        const height = Number(rect?.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
        // Inline left/top can be relative to a transformed host ancestor; clamp in viewport
        // coordinates then write the compensated local coordinates back to that ancestor.
        const originX = (Number(rect?.left) || 0) - left;
        const originY = (Number(rect?.top) || 0) - top;
        const next = clampPanelPosition(Number(rect?.left) || left, Number(rect?.top) || top, width, height);
        setPanelPosition(next.left - originX, next.top - originY);
    }
    function applyUiLayoutMode(mode) {
        const next = mode === 'desktop' ? 'desktop' : 'phone';
        uiLayoutMode = next;
        root.dataset.uiLayout = next;
        panel.dataset.uiLayout = next;
        if (next === 'phone') {
            clearPanelCustomPosition();
            syncPhonePanelViewport();
        }
    }
    function announceUiLayout(message) {
        uiLayoutStatus.textContent = '';
        const publish = () => {
            if (!isDestroyed) uiLayoutStatus.textContent = message;
        };
        if (typeof globalThis.queueMicrotask === 'function') globalThis.queueMicrotask(publish);
        else Promise.resolve().then(publish);
    }
    function setUiLayoutMode(mode, toggleButton = null) {
        if (panelDrag) return;
        const requested = mode === 'desktop' ? 'desktop' : 'phone';
        if (requested === uiLayoutMode) return;
        // A layout preference is deliberately storage-only. Failure is a silent safe fallback
        // to phone mode rather than a partially applied, non-restorable desktop mode.
        const next = persistUiLayoutPreference(layoutStorage, requested) ? requested : 'phone';
        applyUiLayoutMode(next);
        updateUiLayoutToggle(toggleButton);
        announceUiLayout(next === requested
            ? (next === 'desktop' ? '已切换到电脑端界面。' : '已切换到手机端界面。')
            : '已保留手机端界面。');
        clampCustomPanelPosition();
    }
    function clearPanelCustomPosition() {
        panelHasCustomPosition = false;
        if (!panel.style?.removeProperty) return;
        for (const property of ['left', 'top', 'right', 'bottom']) panel.style.removeProperty(property);
    }
    function setPanelPosition(left, top) {
        if (!panel.style?.setProperty) return;
        panelHasCustomPosition = true;
        panel.style.setProperty('left', Math.round(left) + 'px');
        panel.style.setProperty('top', Math.round(top) + 'px');
        panel.style.setProperty('right', 'auto');
        panel.style.setProperty('bottom', 'auto');
    }
    function isHeaderControl(target) {
        let node = target;
        while (node && node !== header) {
            if (String(node.tagName || '').toLowerCase() === 'button') return true;
            node = node.parentNode;
        }
        return false;
    }
    let phoneNavHold = null;
    let suppressPhoneNavClick = false;
    let phoneNavClickSuppressionTimer = null;
    /**
     * 手机布局面板显示定位：
     * - 持久化坐标仍完整落在当前可视视口内 → 继续生效；
     * - 无持久化坐标，或坐标已越出当前视口（旋转/换屏/桌面遗留）→ 居中于可视视口。
     * 两条路径都经 writePanelViewportPosition 补偿 transform 宿主，绝不再依赖
     * CSS right/bottom 锚点在移动宿主上的解析结果。
     */
    function applyPhonePanelPlacement() {
        if (uiLayoutMode !== 'phone') return false;
        const rect = panel.getBoundingClientRect?.();
        const width = Number(rect?.width); const height = Number(rect?.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
        const saved = readPhonePanelPosition(layoutStorage);
        if (saved) {
            const clamped = clampPanelPosition(saved.left, saved.top, width, height);
            if (Math.abs(clamped.left - saved.left) <= 1 && Math.abs(clamped.top - saved.top) <= 1) {
                writePanelViewportPosition(clamped.left, clamped.top);
                return true;
            }
        }
        const centered = centeredPanelPosition(width, height);
        writePanelViewportPosition(centered.left, centered.top);
        return true;
    }
    function beginPanelDrag(event, { dragHandle = header, allowPhone = false, rejectHeaderControls = false } = {}) {
        if ((!allowPhone && uiLayoutMode === 'phone') || !open || event?.isPrimary === false || (event?.pointerType === 'mouse' && Number(event.button) !== 0) || (rejectHeaderControls && isHeaderControl(event?.target))) return;
        const rect = panel.getBoundingClientRect?.();
        const width = Number(rect?.width); const height = Number(rect?.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
        panelDrag = { pointerId: event?.pointerId, pointerType: event?.pointerType ?? 'mouse', startX: Number(event?.clientX) || 0, startY: Number(event?.clientY) || 0, left: Number(rect?.left) || 0, top: Number(rect?.top) || 0, width, height, engaged: false, originX: 0, originY: 0, dragHandle, phone: uiLayoutMode === 'phone' };
        try { dragHandle.setPointerCapture?.(event?.pointerId); } catch { /* optional capture */ }
    }
    function beginHeaderPanelDrag(event) { beginPanelDrag(event, { rejectHeaderControls: true }); }
    function movePanelDrag(event) {
        if (!panelDrag || (panelDrag.pointerId !== undefined && event?.pointerId !== undefined && event.pointerId !== panelDrag.pointerId)) return;
        const deltaX = (Number(event?.clientX) || 0) - panelDrag.startX; const deltaY = (Number(event?.clientY) || 0) - panelDrag.startY;
        if (!panelDrag.engaged) {
            if (Math.hypot(deltaX, deltaY) < PANEL_DRAG_THRESHOLD) return;
            panelDrag.engaged = true; panel.classList.toggle('is-dragging', true); setPanelPosition(panelDrag.left, panelDrag.top);
            const check = panel.getBoundingClientRect?.();
            panelDrag.originX = (Number(check?.left) || 0) - panelDrag.left; panelDrag.originY = (Number(check?.top) || 0) - panelDrag.top;
            if (panelDrag.originX || panelDrag.originY) setPanelPosition(panelDrag.left - panelDrag.originX, panelDrag.top - panelDrag.originY);
        }
        const next = clampPanelPosition(panelDrag.left + deltaX, panelDrag.top + deltaY, panelDrag.width, panelDrag.height);
        setPanelPosition(next.left - panelDrag.originX, next.top - panelDrag.originY); event?.preventDefault?.();
    }
    function endPanelDrag(event) {
        if (!panelDrag || (panelDrag.pointerId !== undefined && event?.pointerId !== undefined && event.pointerId !== panelDrag.pointerId)) return;
        const completed = panelDrag;
        try { completed.dragHandle?.releasePointerCapture?.(completed.pointerId); } catch { /* optional capture */ }
        panelDrag = null;
        panel.classList.toggle('is-dragging', false);
        if (completed.phone && completed.engaged) {
            const rect = panel.getBoundingClientRect?.();
            persistPhonePanelPosition(layoutStorage, { left: Number(rect?.left) || 0, top: Number(rect?.top) || 0 });
        }
    }
    function touchByIdentifier(list, identifier) {
        if (!list || typeof list.length !== 'number') return null;
        for (let index = 0; index < list.length; index += 1) {
            const touch = list[index];
            if (touch && (identifier === undefined || touch.identifier === identifier)) return touch;
        }
        return null;
    }
    function touchPointerEvent(event, touch) {
        return {
            pointerId: touch?.identifier, pointerType: 'touch', isPrimary: true, button: 0,
            clientX: Number(touch?.clientX) || 0, clientY: Number(touch?.clientY) || 0, target: event?.target,
            preventDefault() { event?.preventDefault?.(); },
        };
    }
    function cancelPhoneNavHold(inputType = '') {
        if (inputType && phoneNavHold?.inputType !== inputType) return;
        if (phoneNavHold?.timer) clearTimeout(phoneNavHold.timer);
        phoneNavHold = null;
    }
    function clearPhoneNavClickSuppression() {
        suppressPhoneNavClick = false;
        if (phoneNavClickSuppressionTimer) clearTimeout(phoneNavClickSuppressionTimer);
        phoneNavClickSuppressionTimer = null;
    }
    function armPhoneNavClickSuppression() {
        clearPhoneNavClickSuppression();
        suppressPhoneNavClick = true;
        phoneNavClickSuppressionTimer = setTimeout(clearPhoneNavClickSuppression, 1000);
    }
    function beginPhoneNavHold(event, inputType = 'pointer') {
        if (uiLayoutMode !== 'phone' || !open || event?.isPrimary === false || phoneNavHold || panelDrag) return;
        const snapshot = {
            pointerId: event?.pointerId, pointerType: event?.pointerType ?? 'touch', isPrimary: true, button: 0,
            clientX: Number(event?.clientX) || 0, clientY: Number(event?.clientY) || 0, target: event?.target, inputType,
        };
        phoneNavHold = {
            ...snapshot,
            timer: setTimeout(() => {
                if (!phoneNavHold || phoneNavHold.inputType !== inputType) return;
                beginPanelDrag(snapshot, { dragHandle: nav, allowPhone: true });
                if (panelDrag) armPhoneNavClickSuppression();
            }, PHONE_NAV_DRAG_HOLD_MS),
        };
    }
    function movePhoneNavHold(event, inputType = 'pointer') {
        if (!phoneNavHold || phoneNavHold.inputType !== inputType
            || (phoneNavHold.pointerId !== undefined && event?.pointerId !== undefined && event.pointerId !== phoneNavHold.pointerId)) return;
        if (!panelDrag && Math.hypot((Number(event?.clientX) || 0) - phoneNavHold.clientX, (Number(event?.clientY) || 0) - phoneNavHold.clientY) >= PANEL_DRAG_THRESHOLD) {
            cancelPhoneNavHold(inputType);
        }
    }
    function beginPhoneNavTouchHold(event) {
        if (phoneNavHold || panelDrag) return;
        const touch = touchByIdentifier(event?.changedTouches) ?? touchByIdentifier(event?.touches);
        if (touch) beginPhoneNavHold(touchPointerEvent(event, touch), 'touch');
    }
    function movePhoneNavTouchHold(event) {
        if (!phoneNavHold || phoneNavHold.inputType !== 'touch') return;
        const touch = touchByIdentifier(event?.changedTouches, phoneNavHold.pointerId)
            ?? touchByIdentifier(event?.touches, phoneNavHold.pointerId);
        if (touch) movePhoneNavHold(touchPointerEvent(event, touch), 'touch');
    }
    function movePhonePanelTouch(event) {
        if (!panelDrag || panelDrag.pointerType !== 'touch') return;
        const touch = touchByIdentifier(event?.changedTouches, panelDrag.pointerId)
            ?? touchByIdentifier(event?.touches, panelDrag.pointerId);
        if (touch) movePanelDrag(touchPointerEvent(event, touch));
    }
    function endPhoneNavTouch(event, cancelled = false) {
        const pointerId = panelDrag?.pointerType === 'touch'
            ? panelDrag.pointerId
            : phoneNavHold?.inputType === 'touch' ? phoneNavHold.pointerId : undefined;
        const touch = touchByIdentifier(event?.changedTouches, pointerId);
        cancelPhoneNavHold('touch');
        if (touch && panelDrag?.pointerType === 'touch') endPanelDrag(touchPointerEvent(event, touch));
        else if (cancelled && panelDrag?.pointerType === 'touch') endPanelDrag({ pointerId });
    }
    function suppressPhoneNavActivation(event) {
        if (!suppressPhoneNavClick) return;
        clearPhoneNavClickSuppression();
        event?.preventDefault?.();
        event?.stopImmediatePropagation?.();
    }

    function invalidateServiceProfileGeneration() {
        interactionGeneration += 1;
        serviceProfileGenerationAbortController?.abort?.();
        serviceProfileGenerationAbortController = null;
        serviceProfileGenerationPending = false;
    }
    function invalidateServiceOrderOperations() { serviceOrderOperationEpoch += 1; }
    function canAppendServiceExperienceDraft(mode, operationEpoch) {
        return !isDestroyed && open && activePage === 'service_hub' && currentView?.mode === mode && operationEpoch === serviceOrderOperationEpoch;
    }
    function clearLocalServiceDrafts() {
        selectedServiceProfileIds.clear();
        serviceBoundaryDrafts.clear();
        serviceLocalProfiles.splice(0, serviceLocalProfiles.length);
        serviceGenerationBatches.clear();
        serviceXpSearchDraft = '';
        serviceXpSearchApplied = '';
        activeServiceCategoryId = ctx.serviceHubModeCopy(currentView?.mode).categories[0]?.id ?? '';
        activeServiceHubTab = 'featured';
    }
    function disableServiceHub() {
        serviceHubUnlocked = false;
        try { globalThis.localStorage?.removeItem(SERVICE_UNLOCK_STORAGE_KEY); } catch { /* browser storage is optional */ }
        invalidateServiceProfileGeneration();
        invalidateServiceOrderOperations();
        clearLocalServiceDrafts();
        serviceNavButton.hidden = true;
        nav.classList.toggle('has-service-entry', false);
        setActivePage('profile');
    }
    function setOpen(nextOpen) {
        open = Boolean(nextOpen);
        panel.hidden = !open;
        root.classList.toggle('is-open', open);
        launcher.setAttribute('aria-pressed', String(open));
        launcher.setAttribute('aria-label', open ? '关闭约了吗小手机' : '打开约了吗小手机');
        if (open) {
            syncPhonePanelViewport();
            applyPhonePanelPlacement();
            ensureLauncherWithinViewport();
            refreshState();
        }
        else {
            ctx.stopGroupAutoTimer();
            ctx.stopForumAutoTimer();
            ctx.cancelForumPullInteractions();
            ctx.closeGroupAutoDialog();
            ctx.resetGroupRoomMenu();
            ctx.closeForumSettingsDialog();
            privateChatRequestGeneration += 1;
            activeChatToolsSessionUid = '';
            activeMeetupSessionUid = '';
            ctx.clearSummaryToast();
            hideOperationDialog();
            releaseNotesClickStreak = 0;
            aboutClickStreak = 0;
            invalidateServiceProfileGeneration();
            invalidateServiceOrderOperations();
            serviceXpSearchDraft = ''; serviceXpSearchApplied = '';
        }
    }
    function setActivePage(pageId, { preserveOperation = false } = {}) {
        if (!pageCopy(pageId)) return;
        const privateChatRoute = (page) => page === 'private_chat' || page === 'private_chat_summary';
        if (privateChatRoute(activePage) && !privateChatRoute(pageId)) {
            privateChatRequestGeneration += 1;
            activeChatToolsSessionUid = '';
            activeMeetupSessionUid = '';
            chatMoreMenuSessionUid = '';
            chatConfirmationSessionUid = '';
            chatConfirmationKind = '';
            destructiveChatSessionUid = '';
            destructiveChatKind = '';
            ctx.clearSummaryToast();
        }
        if (!preserveOperation) hideOperationDialog();
        if (activePage === 'about' && pageId !== 'about') { aboutClickStreak = 0; releaseNotesClickStreak = 0; }
        if (activePage === 'group_chat_room' && pageId !== 'group_chat_room') { ctx.stopGroupAutoTimer(); ctx.closeGroupAutoDialog(); ctx.resetGroupRoomMenu(); }
        if (activePage === 'group_forum' && pageId !== 'group_forum') { ctx.cancelForumPullInteractions(); ctx.stopForumAutoTimer(); ctx.closeForumSettingsDialog(); }
        if (activePage === 'service_hub' && pageId !== 'service_hub') invalidateServiceOrderOperations();
        activePage = pageId;
        actionBridge.emit('navigate', { page: pageId });
        renderPage();
        ctx.syncGroupAutoTimer();
        ctx.syncForumAutoTimer();
    }
    function scheduleServiceOrderCompletion() {
        const orders = Array.isArray(currentView?.serviceOrders) ? currentView.serviceOrders : [];
        const isTerminal = (item) => item?.status === '已完成' || item?.status === '已取消';
        // 主链：正文写满合法结束条件的进行中订单 → 受控完成+归档+终态删除。
        // 兜底：活动表中的终态订单（正文违规直写终态或此前 finalize 失败）→ 补记本地历史后移除。
        const order = orders.find((item) => item?.mode === currentView.mode && item?.completionReady === true && item.status === '进行中')
            ?? orders.find((item) => item?.mode === currentView.mode && isTerminal(item)) ?? null;
        if (!order || serviceOrderMutationPendingId || scheduledServiceCompletionOrderId === order.id) return;
        scheduledServiceCompletionOrderId = order.id;
        queueMicrotask(async () => {
            try {
                const latest = Array.isArray(currentView?.serviceOrders) ? currentView.serviceOrders.find((item) => item?.id === order.id && item?.mode === currentView.mode) : null;
                if (isDestroyed || !latest || latest.mode !== currentView.mode || serviceOrderMutationPendingId) return;
                if (latest.completionReady === true && latest.status === '进行中') await ctx.archiveAndFinalizeServiceOrder(latest, '已完成');
                else if (isTerminal(latest)) await ctx.recoverTerminalServiceOrder(latest);
            } finally { if (scheduledServiceCompletionOrderId === order.id) scheduledServiceCompletionOrderId = ''; }
        });
    }
    function refreshState() {
        const previousMode = currentView?.mode;
        currentView = createPhoneView(readState());
        root.dataset.contentMode = currentView.mode === 'NSFW' ? 'NSFW' : 'SFW';
        if (previousMode && previousMode !== currentView.mode) {
            // Local discovery data is mode-scoped and never crosses SFW/NSFW.
            invalidateServiceProfileGeneration();
            invalidateServiceOrderOperations();
            // Candidate pools are explicitly mode-scoped. Keep the other mode's
            // local candidates, but abort the unfinished request and reset the view.
            activeServiceCategoryId = ctx.serviceHubModeCopy(currentView.mode).categories[0]?.id ?? ''; selectedServiceProfileIds.clear();
            serviceXpSearchDraft = ''; serviceXpSearchApplied = '';
        }
        scheduleServiceOrderCompletion();
        if (open) { renderPage(); ctx.syncGroupAutoTimer(); ctx.syncForumAutoTimer(); }
        return currentView;
    }
    async function runExtensionUpdate() {
        if (extensionUpdatePending) return;
        if (!extensionUpdater || typeof extensionUpdater.checkAndUpdate !== 'function') {
            beginOperationDialog({
                state: 'failure',
                visual: 'failure',
                title: '无法检查更新',
                message: '当前酒馆未提供可用的扩展更新服务。',
            });
            return;
        }
        extensionUpdatePending = true;
        renderPage();
        // 运行控制台台账：界面提示保持粗略，完整脱敏详情落在「我的 → 运行记录」。
        const activityHandle = operationActivity.start('扩展更新', '正在检查扩展新版本。');
        const operationToken = beginOperationDialog({
            state: 'loading',
            visual: 'connecting',
            title: '正在检查扩展更新',
            message: `当前版本 v${UI_VERSION}。正在通过酒馆更新服务检查并应用可用更新…`,
        });
        try {
            const result = await extensionUpdater.checkAndUpdate();
            const outcome = result?.outcome;
            if (outcome === 'up_to_date') operationActivity.succeed(activityHandle, '扩展已是最新版本。');
            else if (outcome === 'updated') operationActivity.succeed(activityHandle, '扩展已更新，等待重新载入酒馆页面。');
            else operationActivity.fail(activityHandle, '酒馆更新服务返回了无法识别的结果。');
            if (isDestroyed || !open || activePage !== 'about') return;
            if (outcome === 'up_to_date') {
                updateOperationDialog(operationToken, {
                    state: 'success',
                    visual: 'accepted',
                    title: '当前已是最新版本',
                    message: `v${UI_VERSION} 已是最新版本，无需更新。`,
                });
            } else if (outcome === 'updated') {
                updateOperationDialog(operationToken, {
                    state: 'success',
                    visual: 'accepted',
                    title: '更新已完成',
                    message: '扩展已更新。请重新载入酒馆页面以启用新版本。',
                });
            } else {
                updateOperationDialog(operationToken, {
                    state: 'failure',
                    visual: 'failure',
                    title: '更新未完成',
                    message: '酒馆更新服务返回了无法识别的结果。',
                });
            }
        } catch (error) {
            // 错误透明化（2026-07-27 真机反馈）：弹窗展示固定安全文案 + HTTP 状态
            // 与脱敏后的宿主说明，完整诊断（含阶段与错误码）落运行控制台。
            const projected = projectHostExtensionUpdateError(error);
            const stageLabel = projected.phase === 'update' ? '应用更新阶段' : projected.phase === 'version' ? '检查版本阶段' : '';
            operationActivity.fail(activityHandle, '检查或更新扩展未完成。', {
                detail: buildErrorDetail(error, {
                    operation: '检查并更新扩展',
                    stage: stageLabel || undefined,
                    hint: projected.hostMessage ? `宿主说明 ${projected.hostMessage}` : undefined,
                }),
            });
            if (!isDestroyed && open && activePage === 'about') {
                let message;
                if (projected.code === 'not_git_installation') {
                    message = '此扩展不是 Git 安装，无法应用内更新；请在酒馆原生扩展管理中以 Git 方式重新安装。';
                } else {
                    const hostMessage = projected.hostMessage && projected.hostMessage.length > 160
                        ? `${projected.hostMessage.slice(0, 160)}…`
                        : projected.hostMessage;
                    const lines = [projected.message];
                    if (projected.status) lines.push(`宿主返回 HTTP ${projected.status}${stageLabel ? `（${stageLabel}）` : ''}。`);
                    else if (stageLabel) lines.push(`失败发生在${stageLabel}。`);
                    if (hostMessage) lines.push(`宿主说明：${hostMessage}`);
                    lines.push('完整诊断见「我的 → 运行记录」。');
                    message = lines.join(' ');
                }
                updateOperationDialog(operationToken, {
                    state: 'failure',
                    visual: 'failure',
                    title: '更新未完成',
                    message,
                });
            }
        } finally {
            extensionUpdatePending = false;
            if (!isDestroyed && open && activePage === 'about') renderPage();
        }
    }
    function feedbackPresentation(message) {
        const text = String(message ?? '').slice(0, 320);
        if (/正在|处理中|加载|请求/u.test(text)) return { state: 'loading', title: '操作处理中', message: text };
        if (/失败|错误|出错|异常|不可用|无法|未完成|未生成|未登记|未保存|未就绪|未接受|拒绝|无效|超限/u.test(text)) return { state: 'failure', title: '操作未完成', message: text };
        if (/已|成功|通过|完成|保存|载入|导入|导出|删除|切换/u.test(text)) return { state: 'success', title: '操作完成', message: text };
        return { state: 'info', title: '操作提示', message: text };
    }
    function setFeedback(message, operationToken = null) {
        const presentation = feedbackPresentation(message);
        if (!presentation.message) return operationToken;
        if (operationToken !== null) {
            if (presentation.state === 'loading' && activeOperation?.token === operationToken && activeOperation.state === 'loading') {
                operationMessage.textContent = presentation.message;
            } else updateOperationDialog(operationToken, presentation);
            return operationToken;
        }
        if (presentation.state === 'loading' && activeOperation?.state === 'loading') {
            operationMessage.textContent = presentation.message;
            return activeOperation.token;
        }
        if (presentation.state !== 'loading' && activeOperation?.state === 'loading') {
            updateOperationDialog(activeOperation.token, presentation);
            return activeOperation.token;
        }
        return beginOperationDialog(presentation);
    }
    function primaryPage(pageId) {
        if (PRIMARY_PAGE_FOR[pageId]) return PRIMARY_PAGE_FOR[pageId];
        if (String(pageId).startsWith("settings_")) return "profile";
        if (String(pageId).startsWith("group_")) return "groups";
        if (String(pageId).startsWith("profile_")) return "profile";
        return pageId;
    }
    const IMAGE_MATCH_PUBLIC_FIELDS = Object.freeze(['昵称', '年龄段', '性别', '性取向', '城市', '距离范围', '寻找意图', '简介', '兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']);
    function imageMatchProfile(candidate) {
        if (!candidate || typeof candidate !== 'object') return null;
        const profile = {};
        for (const field of IMAGE_MATCH_PUBLIC_FIELDS) {
            const value = candidate[field];
            if (Array.isArray(value)) profile[field] = value.slice();
            else if (typeof value === 'string') profile[field] = value;
        }
        return profile;
    }
    function imageProfileKey(candidate) {
        const profile = imageMatchProfile(candidate);
        if (!profile) return '';
        // 选图缓存按内容模式隔离：SFW/NSFW 各自绑定不同提示词预设，
        // 模式切换后旧模式的匹配结果不得复用（切回时各自缓存仍有效）。
        const mode = currentView?.mode === 'NSFW' ? 'NSFW' : 'SFW';
        try { return `${mode} ${JSON.stringify(profile)}`; } catch { return ''; }
    }
    function imageSourceUrl(record) {
        // Coordinators may be injected by the host. Re-normalize at the final DOM
        // boundary so only validated embedded image data can become an <img src>.
        return safeAvatarImageSource(record);
    }
    function clearMatchedImageState() {
        matchedImageByProfile.clear();
        imageMatchPending.clear();
        imageMatchFailures.clear();
        imageAssetFailures.clear();
        imageAssetsReady.clear();
        try { imageMatchCoordinator?.clearCache?.(); } catch { /* best effort */ }
    }
    function scheduleImageMatch(candidate, { force = false } = {}) {
        if (!imageMatchCoordinator || typeof imageMatchCoordinator.resolveImage !== 'function') return;
        const key = imageProfileKey(candidate);
        if (!key || imageMatchPending.has(key)) return;
        if (!force && (matchedImageByProfile.has(key) || imageMatchFailures.has(key))) return;
        if (force) {
            matchedImageByProfile.delete(key);
            imageMatchFailures.delete(key);
            imageAssetFailures.delete(key);
            imageAssetsReady.delete(key);
        }
        const profile = imageMatchProfile(candidate);
        const task = Promise.resolve().then(() => imageMatchCoordinator.resolveImage(profile, { contentMode: currentView.mode }))
            .then((record) => {
                imageMatchFailures.delete(key);
                imageAssetFailures.delete(key);
                imageAssetsReady.delete(key);
                matchedImageByProfile.set(key, record ?? null);
            })
            .catch(() => {
                matchedImageByProfile.delete(key);
                imageMatchFailures.add(key);
                imageAssetsReady.delete(key);
            })
            .finally(() => {
                imageMatchPending.delete(key);
                if (open) renderPage();
            });
        imageMatchPending.set(key, task);
    }
    function retryCandidateImage(candidate) {
        const key = imageProfileKey(candidate);
        if (!key || imageMatchPending.has(key)) return;
        matchedImageByProfile.delete(key);
        imageMatchFailures.delete(key);
        imageAssetFailures.delete(key);
        imageAssetsReady.delete(key);
        try { imageMatchCoordinator?.clearCache?.(); } catch { /* best effort */ }
        scheduleImageMatch(candidate, { force: true });
        if (open) renderPage();
    }
    function candidateImageState(candidate) {
        const key = imageProfileKey(candidate);
        if (!candidate || !key) return 'empty';
        if (imageMatchPending.has(key)) return 'loading';
        if (imageMatchFailures.has(key) || imageAssetFailures.has(key)) return 'error';
        if (matchedImageByProfile.has(key)) {
            const record = matchedImageByProfile.get(key);
            if (!record || !imageSourceUrl(record)) return 'empty';
            return imageAssetsReady.has(key) ? 'ready' : 'loading';
        }
        if (imageMatchCoordinator && typeof imageMatchCoordinator.resolveImage === 'function') {
            scheduleImageMatch(candidate);
            return 'loading';
        }
        return 'empty';
    }
    function matchedImageFor(candidate) {
        const key = imageProfileKey(candidate);
        if (!key) return null;
        if (!matchedImageByProfile.has(key) && !imageMatchFailures.has(key)) scheduleImageMatch(candidate);
        return matchedImageByProfile.get(key) ?? null;
    }
    function appendImagePreview(parent, record, className, alt, { onLoad, onFailure } = {}) {
        const source = imageSourceUrl(record);
        if (!source) return false;
        const image = element('img', { className, src: source, alt, loading: 'lazy', referrerPolicy: 'no-referrer' });
        listen(image, image, 'load', () => { onLoad?.(); }, abortController.signal);
        listen(image, image, 'error', () => { image.hidden = true; onFailure?.(); }, abortController.signal);
        parent.appendChild(image);
        return true;
    }

    function clearOperationAutoClose() {
        if (operationAutoCloseTimer === null) return;
        globalThis.clearTimeout(operationAutoCloseTimer);
        operationAutoCloseTimer = null;
    }
    function renderOperationDialog({ state = 'info', title, message, visual = '', autoCloseMs = 0 }, token) {
        if (!activeOperation || activeOperation.token !== token) return false;
        clearOperationAutoClose();
        activeOperation.state = state;
        activeOperation.visual = visual;
        operationDialog.dataset.state = state;
        if (visual) operationDialog.dataset.visual = visual;
        else delete operationDialog.dataset.visual;
        romanceVisual.hidden = !visual;
        romanceVisual.replaceChildren();
        if (visual) {
            romanceVisual.dataset.visual = visual;
            romanceVisual.appendChild(createRomanceHearts(documentRef, visual));
        } else delete romanceVisual.dataset.visual;
        const wasHidden = operationDialog.hidden;
        operationDialog.hidden = false;
        operationDialog.setAttribute('role', state === 'failure' ? 'alertdialog' : 'dialog');
        operationDialog.setAttribute('aria-live', state === 'failure' ? 'assertive' : 'polite');
        operationDialog.setAttribute('aria-busy', String(state === 'loading'));
        operationTitle.textContent = String(title ?? '操作提示');
        operationMessage.textContent = String(message ?? '').slice(0, 320);
        operationDismiss.hidden = false;
        operationClose.hidden = false;
        operationClose.textContent = state === 'loading' ? '关闭提示' : '关闭';
        // 仅在“关闭 → 打开”过渡时接管焦点；状态更新（loading → success 等）不反复抢焦点。
        if (wasHidden) dialogController.open(operationDialog, { initialFocus: operationClose, onRequestClose: hideOperationDialog });
        if (Number.isFinite(autoCloseMs) && autoCloseMs > 0) {
            const delay = Math.max(1000, Math.min(10000, Math.round(autoCloseMs)));
            operationAutoCloseTimer = globalThis.setTimeout(() => {
                if (activeOperation?.token === token) hideOperationDialog();
            }, delay);
            operationAutoCloseTimer?.unref?.();
        } else if (state === 'success' || state === 'failure') {
            const delay = state === 'success' ? 4000 : 6000;
            operationAutoCloseTimer = globalThis.setTimeout(() => {
                if (activeOperation?.token === token) hideOperationDialog();
            }, delay);
            operationAutoCloseTimer?.unref?.();
        }
        return true;
    }
    function beginOperationDialog(presentation) {
        const token = ++operationGeneration;
        activeOperation = { token, state: presentation.state ?? 'info' };
        renderOperationDialog(presentation, token);
        return token;
    }
    function updateOperationDialog(token, presentation) {
        if (!activeOperation || activeOperation.token !== token) return false;
        return renderOperationDialog(presentation, token);
    }
    function hideOperationDialog() {
        interactionGeneration += 1;
        clearOperationAutoClose();
        activeOperation = null;
        closeManagedDialog(operationDialog);
        operationDialog.setAttribute('aria-busy', 'false');
    }
    function visibleOperationMessage(message, fallback) {
        const text = String(message ?? '').trim();
        if (!text || text.length > 320 || /(?:api[_ -]?key|authorization|bearer|stat_data|jsonpatch|prompt|stack|http(?:s)?:\/\/|\buid\b|原始响应|技术错误|\b(?:npc|chat|meetup|group)_[a-z0-9_-]+\b)/iu.test(text)) return fallback;
        return text;
    }
    function showAiLoading(message, operationToken = null) {
        const presentation = { state: 'loading', visual: 'connecting', title: 'AI 调用中', message: visibleOperationMessage(message, 'AI 正在为你寻找合适的回应……') };
        if (operationToken !== null) {
            updateOperationDialog(operationToken, presentation);
            return operationToken;
        }
        return beginOperationDialog(presentation);
    }
    function showAiResult(ok, message, operationToken = null) {
        const presentation = {
            state: ok ? 'success' : 'failure',
            visual: ok ? 'accepted' : 'failure',
            title: ok ? 'AI 调用成功' : 'AI 调用失败',
            message: visibleOperationMessage(message, ok ? 'AI 已完成这次回应。' : '这次 AI 操作未完成，请稍后再试。'),
        };
        if (operationToken !== null) {
            updateOperationDialog(operationToken, presentation);
            return operationToken;
        }
        return beginOperationDialog(presentation);
    }
    function showRomanceLoading(title, message) {
        return beginOperationDialog({ state: 'loading', visual: 'connecting', title, message });
    }
    function showRomanceResult({ accepted = false, declined = false, title, message }, operationToken = null) {
        const presentation = {
            state: accepted ? 'success' : 'failure',
            visual: accepted ? 'accepted' : declined ? 'declined' : 'failure',
            title,
            message: visibleOperationMessage(message, accepted ? '两颗心已经靠近。' : declined ? '这次没有形成匹配，可以稍后再试。' : '这次连接未完成，请稍后再试。'),
        };
        if (operationToken !== null) {
            updateOperationDialog(operationToken, presentation);
            return operationToken;
        }
        return beginOperationDialog(presentation);
    }
    // logActivity=false 供自带细粒度台账接线的面板使用（如角色创作面板），避免同一操作在控制台出现粗细两条。
    function createOperationFeedbackHandler({ ai = false, logActivity = ai } = {}) {
        let operationToken = null;
        let activityHandle = null;
        return (message) => {
            const text = String(message ?? '');
            const presentation = feedbackPresentation(text);
            if (!presentation.message) return;
            if (presentation.state === 'loading') {
                if (operationToken === null) {
                    if (ai) {
                        operationToken = showAiLoading(text);
                        if (logActivity) activityHandle = operationActivity.start('AI 操作', 'AI 处理中……');
                    } else operationToken = setFeedback(text);
                } else setFeedback(text, operationToken);
                return;
            }
            const token = operationToken;
            operationToken = null;
            const failed = ai && /AI.*(未|失败|无法|错误)|未完成/u.test(text);
            const succeeded = ai && /AI.*(已|成功)|草稿已载入/u.test(text);
            if (ai && activityHandle) {
                if (failed) operationActivity.fail(activityHandle, 'AI 操作未完成，请稍后再试。');
                else if (succeeded) operationActivity.succeed(activityHandle, 'AI 操作已完成。');
                activityHandle = null;
            }
            if (token === null) {
                if (failed) showAiResult(false, text);
                else if (succeeded) showAiResult(true, text);
                else setFeedback(text);
                return;
            }
            if (failed) showAiResult(false, text, token);
            else if (succeeded) showAiResult(true, text, token);
            else setFeedback(text, token);
        };
    }
    function backPage(pageId) {
        if (PAGE_PARENT_FOR[pageId]) return PAGE_PARENT_FOR[pageId];
        if (String(pageId).startsWith("settings_")) return "profile";
        if (String(pageId).startsWith("group_")) return "groups";
        if (String(pageId).startsWith("profile_")) return "profile";
        return "";
    }
    function navigateBack(pageId, back) {
        setActivePage(back);
    }
    function closeFeatureBindingDialog() {
        closeManagedDialog(bindingDialog);
        bindingDialogContent.replaceChildren();
        featureBindingDialogState = null;
    }
    function openFeatureBinding(features, dialogTitle = '功能预设选项', options = {}) {
        if (!settingsStore || typeof settingsStore.snapshot !== 'function') {
            setFeedback('本地预设尚未就绪。');
            return;
        }
        let snapshot;
        try { snapshot = settingsStore.snapshot(); } catch { setFeedback('无法读取已保存的预设。'); return; }
        const contentMode = currentView.mode === 'NSFW' ? 'NSFW' : 'SFW';
        const modePromptPresets = snapshot.promptPresets.filter((preset) => preset.contentMode === contentMode);
        const readBinding = typeof options.readBinding === 'function' ? options.readBinding : null;
        const saveBinding = typeof options.saveBinding === 'function' ? options.saveBinding : null;
        featureBindingDialogState = { features, dialogTitle, options };
        bindingDialogTitle.textContent = `${dialogTitle} · ${contentMode}`;
        bindingDialogContent.replaceChildren();
        if (!snapshot.connectionPresets.length && !modePromptPresets.length) {
            bindingDialogContent.appendChild(element('p', { className: 'yl-phone-page-description', text: '当前模式还没有可绑定的连接或提示词预设。请先在“我的 → 设置 → 连接设置 / 提示词预设”中创建，并为提示词标记对应模式。' }));
        }
        for (const feature of features) {
            const binding = readBinding?.(feature, contentMode, snapshot)
                ?? snapshot.functionModeBindings?.[feature.key]?.[contentMode]
                ?? snapshot.functionBindings?.[feature.key]
                ?? { connectionPresetId: null, promptPresetId: null };
            const row = element('section', { className: 'yl-settings-binding yl-feature-binding-row' });
            row.appendChild(element('strong', { text: feature.title + ' · ' + contentMode }));
            row.appendChild(element('p', { className: 'yl-settings-summary', text: '单独保存后只影响当前 ' + contentMode + ' 模式；提示词列表只显示该模式的预设。' }));
            const connection = element('select', { className: 'yl-settings-control', name: feature.key + '-quick-connection', ariaLabel: feature.title + '连接预设' });
            const prompt = element('select', { className: 'yl-settings-control', name: feature.key + '-quick-prompt', ariaLabel: feature.title + '提示词预设' });
            for (const [value, label] of [['', '使用默认连接'], ...snapshot.connectionPresets.map((preset) => [preset.id, preset.name])]) {
                const option = element('option', { value, text: label }); option.selected = value === (binding.connectionPresetId ?? ''); connection.appendChild(option);
            }
            for (const [value, label] of [['', '不附加提示词预设'], ...modePromptPresets.map((preset) => [preset.id, preset.name])]) {
                const option = element('option', { value, text: label }); option.selected = value === (binding.promptPresetId ?? ''); prompt.appendChild(option);
            }
            const fields = element('div', { className: 'yl-settings-fields' });
            const connectionField = element('label', { className: 'yl-settings-field' }); append(connectionField, [element('span', { text: '连接预设' }), connection]);
            const promptField = element('label', { className: 'yl-settings-field' }); append(promptField, [element('span', { text: '提示词预设' }), prompt]);
            append(fields, [connectionField, promptField]); row.appendChild(fields);
            const save = element('button', { className: 'yl-settings-button', type: 'button', text: '保存此功能绑定' });
            listen(save, save, 'click', () => {
                void (async () => {
                    try {
                        const next = { connectionPresetId: connection.value || null, promptPresetId: prompt.value || null };
                        if (saveBinding) await saveBinding(feature, contentMode, next, snapshot);
                        else if (typeof settingsStore.bindFunctionForContentMode === 'function') settingsStore.bindFunctionForContentMode(feature.key, contentMode, next);
                        else if (typeof settingsStore.bindFunction === 'function') settingsStore.bindFunction(feature.key, next);
                        else throw new Error('binding unavailable');
                        setFeedback(feature.title + '的 ' + contentMode + ' 预设绑定已保存。');
                    } catch { setFeedback('预设绑定未保存，请确认选择的预设仍存在。'); }
                })();
            }, abortController.signal);
            row.appendChild(save); bindingDialogContent.appendChild(row);
        }
        dialogController.open(bindingDialog, { onRequestClose: closeFeatureBindingDialog });
    }
    function buildFeatureOptionsButton(pageId) {
        // group_forum 已无壳层「设置」钮：社区广场的设置入口由 community.js topbar「⋯」自建。
        const features = FEATURE_BINDING_FOR_PAGE[pageId];
        if (!features) return null;
        const button = element('button', { className: 'yl-feature-options', type: 'button', text: '设置', ariaLabel: '配置' + (pageCopy(pageId)?.title || '此功能') + '预设' });
        listen(button, button, 'click', () => {
            openFeatureBinding(features, (pageCopy(pageId)?.title || '功能') + '选项');
        }, abortController.signal);
        return button;
    }
    function createLayoutSvgIcon(mode) {
        const current = mode === 'desktop' ? 'desktop' : 'phone';
        const svg = createUiIcon(documentRef, current, { className: 'yl-ui-layout-icon' });
        svg.dataset.layoutIcon = current;
        return svg;
    }
    function updateUiLayoutToggle(button) {
        if (!button) return;
        const currentLabel = uiLayoutMode === 'desktop' ? '电脑端界面' : '手机端界面';
        const targetLabel = uiLayoutMode === 'desktop' ? '手机端界面' : '电脑端界面';
        const description = `当前为${currentLabel}，切换到${targetLabel}`;
        button.dataset.uiLayout = uiLayoutMode;
        button.setAttribute('aria-label', description);
        button.setAttribute('title', description);
        button.replaceChildren(createLayoutSvgIcon(uiLayoutMode));
    }
    function buildUiLayoutToggle() {
        const button = element('button', { className: 'yl-ui-layout-toggle', type: 'button' });
        updateUiLayoutToggle(button);
        listen(button, button, 'click', () => setUiLayoutMode(uiLayoutMode === 'desktop' ? 'phone' : 'desktop', button), abortController.signal);
        return button;
    }
    function buildPageHeading(copy, pageId) {
        const row = element("div", { className: "yl-page-heading" });
        const back = backPage(pageId);
        if (back) {
            const button = element("button", { className: "yl-page-back", type: "button", ariaLabel: "返回" });
            button.appendChild(createUiIcon(documentRef, 'chevron_left', { className: 'yl-page-back-svg', size: 20 }));
            listen(button, button, "click", () => navigateBack(pageId, back), abortController.signal); row.appendChild(button);
        }
        row.appendChild(element("h1", { text: copy.title }));
        if (pageId === 'profile') row.appendChild(buildUiLayoutToggle());
        const featureOptions = buildFeatureOptionsButton(pageId);
        if (featureOptions) row.appendChild(featureOptions);
        const groupListAction = ctx.buildGroupListActionButton(pageId);
        if (groupListAction) row.appendChild(groupListAction);
        const groupRoomAction = ctx.buildGroupRoomActionButton(pageId);
        if (groupRoomAction) row.appendChild(groupRoomAction);
        return row;
    }
    /* —— 控制台诊断详情（2026-07-27 裁决：界面提示保持粗略，控制台完整显示脱敏后的具体报错）——
     * detail 在 operation-activity.js 入账时已经过 sanitizeDiagnosticDetail 脱敏；
     * 这里只负责展示：textContent 渲染 + CSS pre-wrap，绝不使用 innerHTML。 */
    const expandedConsoleDetailKeys = new Set();
    function copyDiagnosticDetail(detailText) {
        const payload = String(detailText ?? '');
        try {
            const clipboard = globalThis.navigator?.clipboard;
            if (clipboard && typeof clipboard.writeText === 'function') {
                const pending = clipboard.writeText(payload);
                if (pending && typeof pending.catch === 'function') pending.catch(() => { /* 剪贴板权限被拒时静默 */ });
                return;
            }
        } catch { /* 剪贴板 API 不可用时走 execCommand 降级 */ }
        try {
            const fallback = element('textarea', { value: payload, ariaLabel: '诊断详情复制缓冲区' });
            documentRef.body?.appendChild?.(fallback);
            fallback.select?.();
            documentRef.execCommand?.('copy');
            fallback.remove?.();
        } catch { /* execCommand 复制失败同样静默 */ }
    }
    function decorateOperationConsoleDetails(section) {
        const snapshot = operationActivity.snapshot();
        const cards = Array.from(section.querySelectorAll?.('.yl-operation-console-entry') ?? []);
        if (!snapshot.entries.length || cards.length !== snapshot.entries.length) return section;
        const liveKeys = new Set();
        snapshot.entries.forEach((entry, index) => {
            const detailText = typeof entry.detail === 'string' && entry.detail ? entry.detail : '';
            if (!detailText) return;
            const key = `${entry.startedAt}|${entry.name}|${index}`;
            liveKeys.add(key);
            const expanded = expandedConsoleDetailKeys.has(key);
            const card = cards[index];
            const controls = element('div', { className: 'yl-operation-console-detail-controls' });
            const toggle = element('button', {
                className: 'yl-operation-console-detail-toggle', type: 'button',
                text: expanded ? '收起详情' : '详情', ariaLabel: expanded ? '收起诊断详情' : '展开诊断详情',
            });
            toggle.setAttribute('aria-expanded', String(expanded));
            const copyButton = element('button', { className: 'yl-operation-console-detail-copy', type: 'button', text: '复制详情', ariaLabel: '复制诊断详情' });
            const detailBlock = element('div', { className: 'yl-operation-console-detail', text: detailText, hidden: !expanded });
            listen(toggle, toggle, 'click', () => {
                const nextExpanded = detailBlock.hidden;
                detailBlock.hidden = !nextExpanded;
                toggle.textContent = nextExpanded ? '收起详情' : '详情';
                toggle.setAttribute('aria-label', nextExpanded ? '收起诊断详情' : '展开诊断详情');
                toggle.setAttribute('aria-expanded', String(nextExpanded));
                if (nextExpanded) expandedConsoleDetailKeys.add(key);
                else expandedConsoleDetailKeys.delete(key);
            }, abortController.signal);
            listen(copyButton, copyButton, 'click', () => copyDiagnosticDetail(detailText), abortController.signal);
            append(controls, [toggle, copyButton]);
            card.appendChild(controls);
            card.appendChild(detailBlock);
        });
        for (const key of expandedConsoleDetailKeys) {
            if (!liveKeys.has(key)) expandedConsoleDetailKeys.delete(key);
        }
        return section;
    }
    function renderPage() {
        ctx.cancelForumPullInteractions();
        imageManagerPanel?.dispose?.();
        imageManagerPanel = null;
        const copy = pageCopy(activePage);
        serviceNavButton.hidden = !serviceHubUnlocked;
        nav.classList.toggle('has-service-entry', serviceHubUnlocked);
        root.dataset.contentMode = currentView.mode === 'NSFW' ? 'NSFW' : 'SFW';
        root.dataset.uiLayout = uiLayoutMode;
        panel.dataset.uiLayout = uiLayoutMode;
        statusLine.textContent = currentView.status === 'ready' ? '已连接' : 'MVU 未就绪';
        content.replaceChildren();
        const page = element('article', { className: `yl-phone-page yl-page-${activePage}` });
        page.appendChild(buildPageHeading(copy, activePage));
        if (currentView.status !== 'ready') page.appendChild(buildEmptyPlaceholder('暂时无法读取当前聊天的软件状态。', { variant: 'search' }));
        else if (activePage === 'home') page.appendChild(currentView.candidate ? ctx.buildCandidateCard(currentView.candidate) : ctx.buildEmptyCandidateCard());
        else if (activePage === 'matches') page.appendChild(ctx.buildMatchesPage());
        else if (activePage === 'messages') page.appendChild(ctx.buildMessagesPage());
        else if (activePage === 'private_chat') page.appendChild(ctx.buildPrivateChatPage());
        else if (activePage === 'private_chat_summary') page.appendChild(ctx.buildPrivateChatSummaryPage());
        else if (activePage === 'groups') page.appendChild(ctx.buildGroupsPage());
        else if (activePage === 'group_chat') page.appendChild(ctx.buildGroupChatPage());
        else if (activePage === 'group_chat_room') page.appendChild(ctx.buildGroupChatRoomPage());
        else if (activePage === 'group_chat_create') page.appendChild(ctx.buildGroupChatCreatePage());
        else if (activePage === 'group_chat_summary') page.appendChild(ctx.buildLocalConversationSummaryPage('group'));
        else if (activePage === 'group_forum') page.appendChild(ctx.buildForumPage());
        else if (activePage === 'forum_post') page.appendChild(ctx.buildForumPostPage());
        else if (activePage === 'forum_post_summary') page.appendChild(ctx.buildLocalConversationSummaryPage('post'));
        else if (activePage === 'profile') page.appendChild(ctx.buildProfileHub());
        else if (activePage === 'profile_editor') page.appendChild(ctx.buildProfileEditor());
        else if (activePage === 'character_creator') page.appendChild(buildCharacterCreator());
        else if (activePage === 'favorites') page.appendChild(ctx.buildFavoritesPage());
        else if (activePage === 'about') page.appendChild(ctx.buildAboutSoftwarePage());
        else if (activePage === 'service_hub') page.appendChild(ctx.buildServiceHubPage());
        else if (['settings_connections', 'settings_prompts', 'settings_personalization', 'settings_personalization_preference', 'settings_images', 'settings_image_generation'].includes(activePage)) page.appendChild(buildSettingsDetail());
        else if (activePage === 'settings_preferences') page.appendChild(ctx.buildPreferenceSettingsPage());
        else if (activePage === 'settings_console') page.appendChild(decorateOperationConsoleDetails(ctx.buildOperationConsole()));
        else if (activePage === 'settings_chat_summary') page.appendChild(ctx.buildChatSummarySettingsHome());
        else if (activePage === 'settings_chat_summary_config') page.appendChild(ctx.buildChatSummaryConfigPage());
        else if (activePage === 'settings_chat_summary_history') page.appendChild(ctx.buildChatSummaryHistoryPage());
        else if (activePage === 'settings_chat_summary_history_detail') page.appendChild(ctx.buildChatSummaryHistoryDetailPage());
        else if (activePage === 'settings_privacy') page.appendChild(ctx.buildPrivacySettings());
        else if (activePage === 'candidate_detail') page.appendChild(ctx.buildCandidateDetail());
        content.appendChild(page);
        for (const [id, button] of navButtons) {
            const selected = id === primaryPage(activePage);
            button.classList.toggle('is-active', selected);
            button.setAttribute('aria-current', selected ? 'page' : 'false');
        }
        // 消息 tab 未读总数徽章（策划书 §4.1/§7.1.2，裁决 D6）：数字来自消息页的本地已读水位，
        // 纯 UI 状态；页面模块未挂载时静默跳过。
        const messagesNavButton = navButtons.get('messages');
        if (messagesNavButton) {
            const navIconWrap = messagesNavButton.querySelector('.yl-nav-icon');
            navIconWrap?.querySelector('.yl-nav-unread-badge')?.remove();
            const unreadTotal = Number(ctx.messageUnreadTotal?.() ?? 0);
            const navUnreadBadge = unreadTotal > 0 ? createUnreadBadge(unreadTotal, { documentRef }) : null;
            if (navUnreadBadge && navIconWrap) {
                navUnreadBadge.classList.toggle('yl-nav-unread-badge', true);
                navIconWrap.appendChild(navUnreadBadge);
            }
        }
    }

    function buildCharacterCreator() {
        if (!characterLibrary || typeof actionBridge.registerCharacter !== 'function') return element('div', { className: 'yl-phone-placeholder', text: '角色创作尚未就绪。' });
        return buildCharacterCreatorPanel({
            documentRef, actionBridge, characterLibrary, signal: abortController.signal,
            contentMode: currentView.mode,
            operationActivity,
            onFeedback: createOperationFeedbackHandler({ ai: true, logActivity: false }),
            onConfigureFeature: (feature) => openFeatureBinding([feature], feature.title + '设置'),
            onRegistered: () => { refreshState(); setActivePage('profile'); },
            // 链接导入 = 一次性下载字节 → 既有本地压缩/签名链 → embedded data URL；URL 本身不保存。
            importAvatarFromUrl: remoteImageImporter
                ? async (url) => compressLocalAvatar(await remoteImageImporter.importImageFile(url))
                : null,
        });
    }
    /** P3-D：占位空态统一走 EmptyState 的本地 SVG 插画，字符图标清零；旧 icon 字符参数仅兼容忽略。 */
    function buildEmptyPlaceholder(text, { variant = 'inbox' } = {}) {
        const placeholder = createEmptyState({ documentRef, variant, title: text });
        placeholder.classList.add('yl-phone-placeholder');
        return placeholder;
    }


    function closeAvatarDialog() {
        closeManagedDialog(avatarDialog);
        try { avatarFileInput.value = ''; } catch { /* file inputs may be immutable in host DOMs */ }
    }
    function openAvatarDialog() {
        if (!playerAvatarStore || typeof playerAvatarStore.snapshot !== 'function') {
            setFeedback('本地头像存储尚未就绪。');
            return;
        }
        dialogController.open(avatarDialog, { onRequestClose: closeAvatarDialog });
    }
    async function saveLocalAvatarFile(file) {
        if (!file || avatarUploadPending || !playerAvatarStore || typeof playerAvatarStore.setAvatar !== 'function') return;
        avatarUploadPending = true;
        avatarFileButton.disabled = true;
        try {
            const compressed = await compressLocalAvatar(file);
            playerAvatarStore.setAvatar({ kind: 'embedded', dataUrl: compressed.dataUrl });
            closeAvatarDialog();
            setFeedback('本地头像已保存到当前浏览器。');
            renderPage();
        } catch (error) {
            setFeedback(projectAvatarError(error).message);
        } finally {
            avatarUploadPending = false;
            avatarFileButton.disabled = false;
            avatarFileInput.value = '';
        }
    }
    function removePlayerAvatar() {
        if (!playerAvatarStore || typeof playerAvatarStore.removeAvatar !== 'function') return;
        try { playerAvatarStore.removeAvatar(); } catch { /* menu remains usable even if storage clearing fails */ }
        closeAvatarDialog();
        setFeedback('本地头像已移除。');
        renderPage();
    }
                    function buildSettingsDetail() {
        if (activePage === 'settings_images') {
            const section = element('section', { className: 'yl-settings-detail yl-image-manager-page' });
            imageManagerPanel = createImageManagerPanel({
                documentRef,
                imageLibrary,
                dialogController,
                // 链接导入 = 一次性下载字节，随后仍走同一条本地压缩链；URL 不落库。
                importRemoteImageFile: remoteImageImporter ? (url) => remoteImageImporter.importImageFile(url) : null,
                compressImageFile: async (file) => (await compressLocalAvatar(file)).dataUrl,
                onFeedback: (message) => setFeedback(message),
                onChange: () => { clearMatchedImageState(); renderPage(); },
                onConfigure: () => openFeatureBinding([{ key: 'image_match', title: '图片匹配' }], '图片匹配设置'),
            });
            section.appendChild(imageManagerPanel.element);
            return section;
        }
        if (!settingsStore) return element('div', { className: 'yl-phone-placeholder', text: '本地设置尚未就绪。' });
        const view = activePage === 'settings_connections' ? 'connection'
            : activePage === 'settings_prompts' ? 'prompt'
                : activePage === 'settings_image_generation' ? 'image_generation'
                    : activePage === 'settings_personalization_preference' ? 'preference' : 'personalization';
        const section = element('section', { className: 'yl-settings-detail' });
        section.appendChild(buildSettingsPanel({
            settingsStore, llmClient, signal: abortController.signal, view,
            contentMode: currentView.mode, dialogController,
            onFeedback: createOperationFeedbackHandler(), onRerender: renderPage, onNavigate: setActivePage,
        }));
        return section;
    }

    async function toggleContentModeFromSlider() {
        const operationToken = setFeedback('正在切换内容模式…'); renderPage();
        const result = await actionBridge.runMvuAction('toggle_content_mode');
        if (!result?.ok) { setFeedback(describeActionFailure(result), operationToken); refreshState(); return; }
        aboutClickStreak = 0;
        aboutUnlocked = true;
        interactionGeneration += 1;
        setFeedback(`已切换为 ${currentView.mode === 'SFW' ? 'NSFW' : 'SFW'}。`, operationToken);
        refreshState();
        if (!bindingDialog.hidden && featureBindingDialogState) {
            openFeatureBinding(featureBindingDialogState.features, featureBindingDialogState.dialogTitle, featureBindingDialogState.options);
        }
    }


    // ---- 页面模块接线（拆页重构）----
    // ctx 是页面模块与壳层之间唯一的共享通道：会被重新赋值的壳层状态以
    // getter/setter 暴露，页面写 ctx.xxx 时直接回写壳层闭包变量，避免拷贝失联；
    // 常量引用（依赖、DOM 节点、Map/Set 状态、壳层函数）以普通属性暴露。
    const ctx = {};
    Object.defineProperties(ctx, {
        aboutClickStreak: { get: () => aboutClickStreak, set: (value) => { aboutClickStreak = value; }, enumerable: true },
        aboutModeControlOpen: { get: () => aboutModeControlOpen, set: (value) => { aboutModeControlOpen = value; }, enumerable: true },
        aboutUnlocked: { get: () => aboutUnlocked, set: (value) => { aboutUnlocked = value; }, enumerable: true },
        activeChatToolsSessionUid: { get: () => activeChatToolsSessionUid, set: (value) => { activeChatToolsSessionUid = value; }, enumerable: true },
        activeForumChannelId: { get: () => activeForumChannelId, set: (value) => { activeForumChannelId = value; }, enumerable: true },
        activeForumPostId: { get: () => activeForumPostId, set: (value) => { activeForumPostId = value; }, enumerable: true },
        activeGroupCacheKey: { get: () => activeGroupCacheKey, set: (value) => { activeGroupCacheKey = value; }, enumerable: true },
        activeMeetupSessionUid: { get: () => activeMeetupSessionUid, set: (value) => { activeMeetupSessionUid = value; }, enumerable: true },
        activeMessageSessionUid: { get: () => activeMessageSessionUid, set: (value) => { activeMessageSessionUid = value; }, enumerable: true },
        activePage: { get: () => activePage, set: (value) => { activePage = value; }, enumerable: true },
        activeServiceCategoryId: { get: () => activeServiceCategoryId, set: (value) => { activeServiceCategoryId = value; }, enumerable: true },
        activeServiceHubTab: { get: () => activeServiceHubTab, set: (value) => { activeServiceHubTab = value; }, enumerable: true },
        chatConfirmationKind: { get: () => chatConfirmationKind, set: (value) => { chatConfirmationKind = value; }, enumerable: true },
        chatConfirmationSessionUid: { get: () => chatConfirmationSessionUid, set: (value) => { chatConfirmationSessionUid = value; }, enumerable: true },
        chatMoreMenuSessionUid: { get: () => chatMoreMenuSessionUid, set: (value) => { chatMoreMenuSessionUid = value; }, enumerable: true },
        chatToolClickSuppressionTimer: { get: () => chatToolClickSuppressionTimer, set: (value) => { chatToolClickSuppressionTimer = value; }, enumerable: true },
        chatToolLongPressInputType: { get: () => chatToolLongPressInputType, set: (value) => { chatToolLongPressInputType = value; }, enumerable: true },
        chatToolLongPressSessionUid: { get: () => chatToolLongPressSessionUid, set: (value) => { chatToolLongPressSessionUid = value; }, enumerable: true },
        chatToolLongPressTimer: { get: () => chatToolLongPressTimer, set: (value) => { chatToolLongPressTimer = value; }, enumerable: true },
        currentView: { get: () => currentView, set: (value) => { currentView = value; }, enumerable: true },
        destructiveChatKind: { get: () => destructiveChatKind, set: (value) => { destructiveChatKind = value; }, enumerable: true },
        extensionUpdatePending: { get: () => extensionUpdatePending, enumerable: true },
        destructiveChatSessionUid: { get: () => destructiveChatSessionUid, set: (value) => { destructiveChatSessionUid = value; }, enumerable: true },
        forumAutoGeneration: { get: () => forumAutoGeneration, set: (value) => { forumAutoGeneration = value; }, enumerable: true },
        forumAutoTimer: { get: () => forumAutoTimer, set: (value) => { forumAutoTimer = value; }, enumerable: true },
        forumInteractionAbortController: { get: () => forumInteractionAbortController, set: (value) => { forumInteractionAbortController = value; }, enumerable: true },
        forumPullState: { get: () => forumPullState, set: (value) => { forumPullState = value; }, enumerable: true },
        forumRefreshMode: { get: () => forumRefreshMode, set: (value) => { forumRefreshMode = value; }, enumerable: true },
        forumRefreshing: { get: () => forumRefreshing, set: (value) => { forumRefreshing = value; }, enumerable: true },
        forumWheelPullState: { get: () => forumWheelPullState, set: (value) => { forumWheelPullState = value; }, enumerable: true },
        groupAutoDialogKey: { get: () => groupAutoDialogKey, set: (value) => { groupAutoDialogKey = value; }, enumerable: true },
        groupAutoGeneration: { get: () => groupAutoGeneration, set: (value) => { groupAutoGeneration = value; }, enumerable: true },
        groupAutoTimer: { get: () => groupAutoTimer, set: (value) => { groupAutoTimer = value; }, enumerable: true },
        groupAutoTimerKey: { get: () => groupAutoTimerKey, set: (value) => { groupAutoTimerKey = value; }, enumerable: true },
        groupCreateMembers: { get: () => groupCreateMembers, set: (value) => { groupCreateMembers = value; }, enumerable: true },
        groupCreateName: { get: () => groupCreateName, set: (value) => { groupCreateName = value; }, enumerable: true },
        groupForumSnapshot: { get: () => groupForumSnapshot, set: (value) => { groupForumSnapshot = value; }, enumerable: true },
        groupListMenuOpen: { get: () => groupListMenuOpen, set: (value) => { groupListMenuOpen = value; }, enumerable: true },
        groupMemberPickerOpen: { get: () => groupMemberPickerOpen, set: (value) => { groupMemberPickerOpen = value; }, enumerable: true },
        groupRoomConfirmation: { get: () => groupRoomConfirmation, set: (value) => { groupRoomConfirmation = value; }, enumerable: true },
        groupRoomConfirmationKey: { get: () => groupRoomConfirmationKey, set: (value) => { groupRoomConfirmationKey = value; }, enumerable: true },
        groupRoomDestructiveKey: { get: () => groupRoomDestructiveKey, set: (value) => { groupRoomDestructiveKey = value; }, enumerable: true },
        groupRoomMenuOpen: { get: () => groupRoomMenuOpen, set: (value) => { groupRoomMenuOpen = value; }, enumerable: true },
        groupSearchOpen: { get: () => groupSearchOpen, set: (value) => { groupSearchOpen = value; }, enumerable: true },
        groupSearchQuery: { get: () => groupSearchQuery, set: (value) => { groupSearchQuery = value; }, enumerable: true },
        interactionGeneration: { get: () => interactionGeneration, set: (value) => { interactionGeneration = value; }, enumerable: true },
        isDestroyed: { get: () => isDestroyed, set: (value) => { isDestroyed = value; }, enumerable: true },
        localSummaryBusy: { get: () => localSummaryBusy, set: (value) => { localSummaryBusy = value; }, enumerable: true },
        localSummaryTarget: { get: () => localSummaryTarget, set: (value) => { localSummaryTarget = value; }, enumerable: true },
        messageSearchQuery: { get: () => messageSearchQuery, set: (value) => { messageSearchQuery = value; }, enumerable: true },
        open: { get: () => open, set: (value) => { open = value; }, enumerable: true },
        playerProfileDraft: { get: () => playerProfileDraft, set: (value) => { playerProfileDraft = value; }, enumerable: true },
        privateChatRequestGeneration: { get: () => privateChatRequestGeneration, set: (value) => { privateChatRequestGeneration = value; }, enumerable: true },
        refreshing: { get: () => refreshing, set: (value) => { refreshing = value; }, enumerable: true },
        releaseNotesClickStreak: { get: () => releaseNotesClickStreak, set: (value) => { releaseNotesClickStreak = value; }, enumerable: true },
        selectedCandidateUid: { get: () => selectedCandidateUid, set: (value) => { selectedCandidateUid = value; }, enumerable: true },
        serviceEntryUnlocked: { get: () => serviceEntryUnlocked, set: (value) => { serviceEntryUnlocked = value; }, enumerable: true },
        serviceGenerationBatchSequence: { get: () => serviceGenerationBatchSequence, set: (value) => { serviceGenerationBatchSequence = value; }, enumerable: true },
        serviceHubUnlocked: { get: () => serviceHubUnlocked, set: (value) => { serviceHubUnlocked = value; }, enumerable: true },
        serviceOrderMutationPendingId: { get: () => serviceOrderMutationPendingId, set: (value) => { serviceOrderMutationPendingId = value; }, enumerable: true },
        serviceOrderOperationEpoch: { get: () => serviceOrderOperationEpoch, set: (value) => { serviceOrderOperationEpoch = value; }, enumerable: true },
        serviceOrderRepeatPendingId: { get: () => serviceOrderRepeatPendingId, set: (value) => { serviceOrderRepeatPendingId = value; }, enumerable: true },
        serviceProfileGenerationAbortController: { get: () => serviceProfileGenerationAbortController, set: (value) => { serviceProfileGenerationAbortController = value; }, enumerable: true },
        serviceProfileGenerationPending: { get: () => serviceProfileGenerationPending, set: (value) => { serviceProfileGenerationPending = value; }, enumerable: true },
        serviceProfileHandoffPendingId: { get: () => serviceProfileHandoffPendingId, set: (value) => { serviceProfileHandoffPendingId = value; }, enumerable: true },
        serviceProfileSequence: { get: () => serviceProfileSequence, set: (value) => { serviceProfileSequence = value; }, enumerable: true },
        serviceXpSearchApplied: { get: () => serviceXpSearchApplied, set: (value) => { serviceXpSearchApplied = value; }, enumerable: true },
        serviceXpSearchDraft: { get: () => serviceXpSearchDraft, set: (value) => { serviceXpSearchDraft = value; }, enumerable: true },
        summaryHistorySessionUid: { get: () => summaryHistorySessionUid, set: (value) => { summaryHistorySessionUid = value; }, enumerable: true },
        summaryToast: { get: () => summaryToast, set: (value) => { summaryToast = value; }, enumerable: true },
        summaryToastTimer: { get: () => summaryToastTimer, set: (value) => { summaryToastTimer = value; }, enumerable: true },
        suppressChatToolClickForSessionUid: { get: () => suppressChatToolClickForSessionUid, set: (value) => { suppressChatToolClickForSessionUid = value; }, enumerable: true },
        uiLayoutMode: { get: () => uiLayoutMode, set: (value) => { uiLayoutMode = value; }, enumerable: true },
        voiceMatchText: { get: () => voiceMatchText, set: (value) => { voiceMatchText = value; }, enumerable: true },
    });
    Object.assign(ctx, {
        UI_VERSION, abortController, actionBridge, appendImagePreview, applyCloseIcon, beginOperationDialog, buildConversationImageControls, buildEmptyPlaceholder,
        extensionUpdater, runExtensionUpdate,
        buildImageDirectiveCard, canAppendServiceExperienceDraft, candidateImageState, characterLibrary, chatDrafts, clearMatchedImageState, closeManagedDialog, content,
        dialogController, disableServiceHub, documentRef, formatDirectiveForDisplay, forumCommentDrafts, forumSettingsContent, forumSettingsDialog, forumSettingsTitle,
        groupAutoContent, groupAutoDialog, groupAutoTitle, groupForumStore, groupMemberPickerContent, groupMemberPickerDialog, groupMessageDrafts, imageAssetFailures,
        imageAssetsReady, imageMatchPending, imageProfileKey, localProfileCharacterUid, matchedImageFor, meetupDrafts, nav, openAvatarDialog,
        openFeatureBinding, openMark, operationActivity, playerAvatarStore, privateImageDirectives, refreshState, renderPage, retryCandidateImage,
        root, selectedServiceProfileIds, serviceBoundaryDrafts, serviceGenerationBatches, serviceLocalProfiles, serviceNavButton, serviceOrderHistoryStore, setActivePage,
        setFeedback, setUiLayoutMode, settingsStore, showAiLoading, showAiResult, showRomanceLoading, showRomanceResult, toggleContentModeFromSlider,
    });
    Object.assign(ctx, createSharedHelpers(ctx));
    Object.assign(ctx, createDiscoverPage(ctx), createMatchPage(ctx), createMessagesPage(ctx), createChatPage(ctx), createCommunityPage(ctx), createServicePage(ctx), createProfilePage(ctx));

    listen(launcher, launcher, 'click', () => setOpen(!open), abortController.signal);
    listen(closeButton, closeButton, "click", () => setOpen(false), abortController.signal);
    listen(header, header, 'pointerdown', beginHeaderPanelDrag, abortController.signal);
    listen(nav, nav, 'pointerdown', (event) => beginPhoneNavHold(event, 'pointer'), abortController.signal);
    listen(nav, nav, 'pointermove', (event) => movePhoneNavHold(event, 'pointer'), abortController.signal);
    listen(nav, nav, 'pointerup', () => cancelPhoneNavHold('pointer'), abortController.signal);
    listen(nav, nav, 'pointercancel', () => cancelPhoneNavHold('pointer'), abortController.signal);
    listen(nav, nav, 'touchstart', beginPhoneNavTouchHold, abortController.signal);
    listen(nav, nav, 'touchmove', movePhoneNavTouchHold, abortController.signal);
    listen(nav, nav, 'touchend', (event) => endPhoneNavTouch(event, false), abortController.signal);
    listen(nav, nav, 'touchcancel', (event) => endPhoneNavTouch(event, true), abortController.signal);
    nav.addEventListener('click', suppressPhoneNavActivation, { capture: true, signal: abortController.signal });
    listen(header, header, 'pointermove', movePanelDrag, abortController.signal);
    listen(header, header, 'pointerup', endPanelDrag, abortController.signal);
    listen(header, header, 'pointercancel', endPanelDrag, abortController.signal);
    listen(root, documentRef, 'pointermove', movePanelDrag, abortController.signal);
    listen(root, documentRef, 'pointerup', endPanelDrag, abortController.signal);
    listen(root, documentRef, 'pointercancel', endPanelDrag, abortController.signal);
    listen(root, documentRef, 'touchmove', movePhonePanelTouch, abortController.signal);
    listen(root, documentRef, 'touchend', (event) => endPhoneNavTouch(event, false), abortController.signal);
    listen(root, documentRef, 'touchcancel', (event) => endPhoneNavTouch(event, true), abortController.signal);
    const windowRef = documentRef.defaultView;
    const handleViewportChange = () => {
        if (uiLayoutMode === 'phone') {
            syncPhonePanelViewport();
            // 打开状态下视口变化（旋转/地址栏伸缩/软键盘）时把面板拉回可视范围；
            // 尚未定过位（如打开时尺寸不可测）则重试一次默认居中。拖动中不干预。
            if (open && !panelDrag) {
                if (panelHasCustomPosition) clampCustomPanelPosition();
                else applyPhonePanelPlacement();
            }
        } else {
            clampCustomPanelPosition();
        }
        ensureLauncherWithinViewport();
    };
    if (windowRef?.addEventListener) listen(root, windowRef, 'resize', handleViewportChange, abortController.signal);
    if (windowRef?.visualViewport?.addEventListener) {
        listen(root, windowRef.visualViewport, 'resize', handleViewportChange, abortController.signal);
        listen(root, windowRef.visualViewport, 'scroll', handleViewportChange, abortController.signal);
    }
    listen(operationDismiss, operationDismiss, 'click', hideOperationDialog, abortController.signal);
    listen(operationClose, operationClose, 'click', hideOperationDialog, abortController.signal);
    listen(bindingDialogClose, bindingDialogClose, 'click', closeFeatureBindingDialog, abortController.signal);
    listen(avatarDialogClose, avatarDialogClose, 'click', closeAvatarDialog, abortController.signal);
    listen(groupMemberPickerClose, groupMemberPickerClose, 'click', ctx.closeGroupMemberPicker, abortController.signal);
    listen(groupAutoClose, groupAutoClose, 'click', ctx.closeGroupAutoDialog, abortController.signal);
    listen(forumSettingsClose, forumSettingsClose, 'click', ctx.closeForumSettingsDialog, abortController.signal);
    listen(imageDirectiveClose, imageDirectiveClose, 'click', closeImageDirectiveDialog, abortController.signal);
    listen(avatarFileButton, avatarFileButton, 'click', () => { avatarFileInput.click?.(); }, abortController.signal);
    listen(avatarFileInput, avatarFileInput, 'change', () => { void saveLocalAvatarFile(avatarFileInput.files?.[0]); }, abortController.signal);
    listen(avatarRemoveButton, avatarRemoveButton, 'click', removePlayerAvatar, abortController.signal);
    listen(root, documentRef, "click", (event) => {
        if (chatMoreMenuSessionUid && !event.target?.closest?.('.yl-private-chat-actions')) ctx.closeChatMoreMenu();
    }, abortController.signal);
    listen(root, documentRef, "keydown", (event) => {
        // 弹窗打开时 Tab / Escape 交由控制器：焦点环留在栈顶弹窗内，Escape 走各弹窗自己的关闭函数。
        if (event.key === "Tab") {
            if (dialogController.hasOpenDialog()) dialogController.handleKeydown(event);
            return;
        }
        if (event.key !== "Escape") return;
        if (dialogController.handleKeydown(event)) return;
        if (imageManagerPanel?.handleEscape?.()) return;
        if (chatMoreMenuSessionUid) { ctx.closeChatMoreMenu(); return; }
        if (activeChatToolsSessionUid) { activeChatToolsSessionUid = ''; renderPage(); return; }
        if (groupRoomMenuOpen) { ctx.resetGroupRoomMenu(); renderPage(); return; }
        if (open) setOpen(false);
    }, abortController.signal);
    unsubscribeOperationActivity = operationActivity.subscribe(() => {
        if (open && activePage === 'settings_console') renderPage();
    });
    renderPage();
    return Object.freeze({
        refreshState,
        // 诊断接缝：安全控制台的内存台账（不持久化）。宿主与测试可注入条目，detail 已在台账层脱敏。
        operationActivity,
        destroy() { cancelPhoneNavHold(); clearPhoneNavClickSuppression(); ctx.cancelChatToolLongPress(); ctx.clearChatToolClickSuppression(); clearImageDirectiveLongPressTimers(); isDestroyed = true; invalidateServiceProfileGeneration(); invalidateServiceOrderOperations(); ctx.stopGroupAutoTimer(); ctx.stopForumAutoTimer(); ctx.cancelForumPullInteractions(); ctx.clearSummaryToast(); hideOperationDialog(); ctx.closeGroupMemberPicker(); ctx.closeGroupAutoDialog(); ctx.closeForumSettingsDialog(); ctx.resetGroupRoomMenu(); unsubscribeOperationActivity?.(); imageManagerPanel?.dispose?.(); dialogController.dispose(); clearMatchedImageState(); launcherDrag.dispose(); abortController.abort(); root.remove(); },
    });
}

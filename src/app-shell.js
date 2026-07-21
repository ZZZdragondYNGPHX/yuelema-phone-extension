import { append, element, listen } from './dom.js';
import { readLatestState } from './mvu/adapter.js';
import { NAV_ITEMS, PAGE_COPY, createPhoneView, describeActionFailure } from './ui-model.js';
import { buildSettingsPanel } from './settings-panel.js';
import { buildCharacterCreatorPanel } from './characters/character-creator-panel.js';
import { avatarAcceptAttribute, compressLocalAvatar, projectAvatarError } from './characters/avatar-codec.js';
import { avatarImageSource } from './player-avatar-store.js';
import { createLauncherDragController } from './launcher-drag.js';
import { createImageManagerPanel } from './images/image-manager-panel.js';
import { createAvatarView, safeAvatarImageSource } from './ui/avatar-view.js';
import { createOperationActivity } from './ui/operation-activity.js';

const UI_VERSION = '0.1.22';
const PANEL_DRAG_THRESHOLD = 8;
const ACTION_LABELS = Object.freeze({ like: '喜欢', refresh: '刷新', favorite: '收藏', unfavorite: '取消收藏', start_private_chat: '发起私聊', dislike: '不喜欢' });
const ACTION_ICONS = Object.freeze({ like: '♥', refresh: '↻', favorite: '★', unfavorite: '★', start_private_chat: '✉', dislike: '✕' });
const PRIMARY_PAGE_FOR = Object.freeze({
    group_chat: 'groups', group_forum: 'groups', private_chat: 'messages', profile_editor: 'profile', character_creator: 'profile', favorites: 'profile', settings: 'profile',
    settings_connections: 'profile', settings_prompts: 'profile', settings_privacy: 'profile', settings_personalization: 'profile', settings_personalization_preference: 'profile', settings_images: 'profile', settings_console: 'profile', about: 'profile', candidate_detail: 'home', match_profile: 'matches',
});
const PAGE_PARENT_FOR = Object.freeze({
    group_chat: 'groups', group_forum: 'groups', private_chat: 'messages', profile_editor: 'profile', character_creator: 'profile', favorites: 'profile', settings: 'profile',
    settings_connections: 'settings', settings_prompts: 'settings', settings_privacy: 'settings', settings_personalization: 'settings_privacy', settings_personalization_preference: 'settings_personalization', settings_images: 'settings', settings_console: 'settings', candidate_detail: 'home', match_profile: 'matches',
});
const FEATURE_BINDING_FOR_PAGE = Object.freeze({
    home: Object.freeze([{ key: 'recommendation_refresh', title: '首页推荐刷新' }]),
    matches: Object.freeze([{ key: 'soul_match', title: '灵魂匹配' }, { key: 'text_match', title: '语音匹配' }]),
    messages: Object.freeze([{ key: 'chat', title: '私聊' }]),
    groups: Object.freeze([{ key: 'group_chat', title: '聊天群' }, { key: 'forum', title: '论坛' }]),
    group_chat: Object.freeze([{ key: 'group_chat', title: '聊天群' }]),
    group_forum: Object.freeze([{ key: 'forum', title: '论坛' }]),
    character_creator: Object.freeze([{ key: 'character_ai_completion', title: 'AI 完善补全' }, { key: 'character_full_authoring', title: 'AI 完整创作' }]),
});

/** @param {{ documentRef: Document, rootId: string, actionBridge: ReturnType<import('./action-bridge.js').createActionBridge>, readState?: () => unknown }} options */
export function mountPhoneApp({ documentRef, rootId, actionBridge, settingsStore, llmClient, characterLibrary, playerAvatarStore = null, imageLibrary = null, imageMatchCoordinator = null, readState = () => readLatestState() }) {
    const abortController = new AbortController();
    const root = documentRef.createElement('section');
    root.id = rootId;
    root.className = 'yl-phone-extension';
    root.setAttribute('aria-label', '约了吗小手机');

    let open = false;
    let activePage = 'home';
    let refreshing = false;
    let activeMessageSessionUid = '';
    let messageSearchQuery = '';
    let chatMoreMenuSessionUid = '';
    let chatConfirmationSessionUid = '';
    let chatConfirmationKind = '';
    let destructiveChatSessionUid = '';
    let destructiveChatKind = '';
    let activeMeetupSessionUid = '';
    let activeChatToolsSessionUid = '';
    let selectedCandidateUid = '';
    let matchedProfileDraft = null;
    let voiceMatchText = '';
    let aboutClickStreak = 0;
    let aboutUnlocked = false;
    let activeHelpAnchor = null;
    let playerProfileDraft = null;
    const chatDrafts = new Map();
    const meetupDrafts = new Map();
    const groupChatInputDrafts = new Map();
    const groupChatGeneratedDrafts = new Map();
    const forumTopicDrafts = new Map();
    const forumGeneratedDrafts = new Map();
    let currentView = createPhoneView(readState());
    let operationGeneration = 0;
    let activeOperation = null;
    let operationAutoCloseTimer = null;
    let privateChatRequestGeneration = 0;
    let featureBindingDialogState = null;
    let avatarUploadPending = false;
    let imageManagerPanel = null;
    const matchedImageByProfile = new Map();
    const imageMatchPending = new Map();
    const operationActivity = createOperationActivity();
    let unsubscribeOperationActivity = null;
    let interactionGeneration = 0;
    let isDestroyed = false;

    const launcher = element('button', { className: 'yl-phone-launcher', type: 'button', ariaLabel: '打开约了吗小手机', pressed: false, text: '约' });
    launcher.appendChild(element('span', { className: 'yl-phone-launcher-label', text: '约了吗' }));
    const panel = element('aside', { className: 'yl-phone-panel', ariaLabel: '约了吗小手机窗口', hidden: true });
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    const header = element('header', { className: 'yl-phone-header', ariaLabel: '拖动约了吗小手机窗口' });
    header.setAttribute('title', '按住此处拖动小手机');
    const brand = element('div', { className: 'yl-phone-brand' });
    const statusDot = element('span', { className: 'yl-status-dot' });
    statusDot.setAttribute('aria-hidden', 'true');
    const statusLine = element('span', { className: 'yl-phone-status' });
    append(brand, [element('strong', { text: '约了吗' }), statusDot, statusLine]);
    const closeButton = element('button', { className: 'yl-phone-close', type: 'button', ariaLabel: '关闭约了吗小手机', text: '×' });
    append(header, [brand, closeButton]);
    const content = element('main', { className: 'yl-phone-content' });
    const nav = element('nav', { className: 'yl-phone-nav', ariaLabel: '约了吗主导航' });
    const navButtons = new Map();
    for (const item of NAV_ITEMS) {
        const button = element('button', { className: 'yl-phone-nav-item', type: 'button', ariaLabel: item.label });
        append(button, [
            element('span', { className: 'yl-nav-icon', text: item.icon }),
            element('span', { className: 'yl-nav-label', text: item.label }),
        ]);
        button.dataset.page = item.id;
        navButtons.set(item.id, button);
        listen(button, button, 'click', () => setActivePage(item.id), abortController.signal);
        nav.appendChild(button);
    }
    append(panel, [header, content, nav]);

    const helpPopover = element('div', { className: 'yl-phone-feedback yl-help-popover', hidden: true });
    helpPopover.setAttribute('role', 'tooltip');
    helpPopover.setAttribute('aria-live', 'polite');

    const operationDialog = element('section', { className: 'yl-phone-placeholder yl-operation-dialog', hidden: true });
    operationDialog.setAttribute('role', 'dialog');
    operationDialog.setAttribute('aria-modal', 'false');
    operationDialog.setAttribute('aria-live', 'polite');
    const operationDismiss = element('button', {
        className: 'yl-dialog-close', type: 'button', name: 'operation-dialog-close',
        ariaLabel: '关闭操作弹窗', text: '×',
    });
    const operationTitle = element('h2', { text: '' });
    const romanceVisual = element('div', { className: 'yl-romance-visual', hidden: true, ariaLabel: '恋爱互动状态动画' });
    romanceVisual.setAttribute('aria-hidden', 'true');
    const romanceLeft = element('span', { className: 'yl-romance-heart yl-romance-heart-left', text: '♥' });
    const romanceSignal = element('span', { className: 'yl-romance-signal', text: '∿∿∿' });
    const romanceRight = element('span', { className: 'yl-romance-heart yl-romance-heart-right', text: '♥' });
    append(romanceVisual, [romanceLeft, romanceSignal, romanceRight]);
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
    const bindingDialogClose = element('button', { className: 'yl-dialog-close', type: 'button', text: '×', ariaLabel: '关闭功能预设选项' });
    const bindingDialogContent = element('div', { className: 'yl-settings-panel' });
    append(bindingDialogTitlebar, [bindingDialogTitle, bindingDialogClose]);
    append(bindingDialog, [bindingDialogTitlebar, bindingDialogContent]);
    const avatarDialog = element('section', { className: 'yl-settings-section yl-settings-modal yl-avatar-modal', hidden: true });
    avatarDialog.setAttribute('role', 'dialog');
    avatarDialog.setAttribute('aria-modal', 'false');
    avatarDialog.setAttribute('aria-label', '更换个人头像');
    const avatarDialogTitlebar = element('div', { className: 'yl-dialog-titlebar' });
    const avatarDialogTitle = element('h2', { text: '更换头像' });
    const avatarDialogClose = element('button', { className: 'yl-dialog-close', type: 'button', text: '×', ariaLabel: '关闭头像菜单' });
    append(avatarDialogTitlebar, [avatarDialogTitle, avatarDialogClose]);
    const avatarDialogSummary = element('p', { className: 'yl-settings-summary', text: '头像仅保存到当前浏览器，不会写入公开资料、MVU 或提示词。' });
    const avatarFileInput = element('input', { type: 'file', accept: avatarAcceptAttribute(), ariaLabel: '选择本地头像文件' });
    avatarFileInput.hidden = true;
    const avatarFileButton = element('button', { className: 'yl-settings-button', type: 'button', text: '从本地导入图片' });
    const avatarLinkField = element('label', { className: 'yl-settings-field' });
    avatarLinkField.appendChild(element('span', { text: '引用图片链接' }));
    const avatarLinkInput = element('input', { className: 'yl-settings-control', type: 'url', maxLength: 2048, placeholder: 'https://example.com/avatar.webp', ariaLabel: '头像图片链接' });
    avatarLinkField.appendChild(avatarLinkInput);
    const avatarLinkButton = element('button', { className: 'yl-settings-button', type: 'button', text: '保存图片链接' });
    const avatarRemoveButton = element('button', { className: 'yl-settings-button yl-avatar-remove', type: 'button', text: '移除头像' });
    append(avatarDialog, [avatarDialogTitlebar, avatarDialogSummary, avatarFileInput, avatarFileButton, avatarLinkField, avatarLinkButton, avatarRemoveButton]);
    append(root, [launcher, panel, helpPopover, operationDialog, bindingDialog, avatarDialog]);
    documentRef.body.appendChild(root);

    const launcherDrag = createLauncherDragController({ launcher, documentRef, threshold: 8, edgeGap: 0 });
    let panelDrag = null;
    function viewportSize() {
        const view = documentRef.defaultView;
        return {
            width: Math.max(1, Number(view?.innerWidth || documentRef.documentElement?.clientWidth || 360)),
            height: Math.max(1, Number(view?.innerHeight || documentRef.documentElement?.clientHeight || 640)),
        };
    }
    function clampPanelPosition(left, top, width, height) {
        const viewport = viewportSize();
        const margin = 0;
        return {
            left: Math.max(margin, Math.min(left, Math.max(margin, viewport.width - width - margin))),
            top: Math.max(margin, Math.min(top, Math.max(margin, viewport.height - height - margin))),
        };
    }
    function setPanelPosition(left, top) {
        if (!panel.style?.setProperty) return;
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
    function beginPanelDrag(event) {
        if (!open || event?.isPrimary === false || (event?.pointerType === 'mouse' && Number(event.button) !== 0) || isHeaderControl(event?.target)) return;
        const rect = typeof panel.getBoundingClientRect === 'function' ? panel.getBoundingClientRect() : null;
        const width = Number(rect?.width);
        const height = Number(rect?.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
        panelDrag = {
            pointerId: event?.pointerId,
            startX: Number(event?.clientX) || 0,
            startY: Number(event?.clientY) || 0,
            left: Number(rect?.left) || 0,
            top: Number(rect?.top) || 0,
            width,
            height,
            engaged: false,
            originX: 0,
            originY: 0,
        };
        header.setPointerCapture?.(event?.pointerId);
    }
    function movePanelDrag(event) {
        if (!panelDrag || (panelDrag.pointerId !== undefined && event?.pointerId !== undefined && event.pointerId !== panelDrag.pointerId)) return;
        const deltaX = (Number(event?.clientX) || 0) - panelDrag.startX;
        const deltaY = (Number(event?.clientY) || 0) - panelDrag.startY;
        if (!panelDrag.engaged) {
            // 8px threshold keeps plain header taps from hijacking clicks or scroll gestures.
            if (Math.hypot(deltaX, deltaY) < PANEL_DRAG_THRESHOLD) return;
            panelDrag.engaged = true;
            panel.classList.toggle('is-dragging', true);
            setPanelPosition(panelDrag.left, panelDrag.top);
            // A transformed host ancestor shifts the fixed containing block away from
            // the viewport; measure the offset once and compensate all writes.
            const check = typeof panel.getBoundingClientRect === 'function' ? panel.getBoundingClientRect() : null;
            panelDrag.originX = (Number(check?.left) || 0) - panelDrag.left;
            panelDrag.originY = (Number(check?.top) || 0) - panelDrag.top;
            if (panelDrag.originX || panelDrag.originY) setPanelPosition(panelDrag.left - panelDrag.originX, panelDrag.top - panelDrag.originY);
        }
        const next = clampPanelPosition(
            panelDrag.left + deltaX,
            panelDrag.top + deltaY,
            panelDrag.width,
            panelDrag.height,
        );
        setPanelPosition(next.left - panelDrag.originX, next.top - panelDrag.originY);
        event?.preventDefault?.();
    }
    function endPanelDrag(event) {
        if (!panelDrag || (panelDrag.pointerId !== undefined && event?.pointerId !== undefined && event.pointerId !== panelDrag.pointerId)) return;
        try { header.releasePointerCapture?.(panelDrag.pointerId); } catch { /* pointer capture may already be released */ }
        panelDrag = null;
        panel.classList.toggle('is-dragging', false);
    }

    function setOpen(nextOpen) {
        open = Boolean(nextOpen);
        panel.hidden = !open;
        root.classList.toggle('is-open', open);
        launcher.setAttribute('aria-pressed', String(open));
        launcher.setAttribute('aria-label', open ? '关闭约了吗小手机' : '打开约了吗小手机');
        if (open) refreshState();
        else {
            privateChatRequestGeneration += 1;
            activeChatToolsSessionUid = '';
            activeMeetupSessionUid = '';
            hideOperationDialog();
        }
    }
    function setActivePage(pageId) {
        if (pageId === 'about') { showAboutSoftware(); return; }
        if (!PAGE_COPY[pageId]) return;
        if (activePage === 'private_chat' && pageId !== 'private_chat') {
            privateChatRequestGeneration += 1;
            activeChatToolsSessionUid = '';
            activeMeetupSessionUid = '';
            chatMoreMenuSessionUid = '';
            chatConfirmationSessionUid = '';
            chatConfirmationKind = '';
            destructiveChatSessionUid = '';
            destructiveChatKind = '';
        }
        hideOperationDialog();
        activePage = pageId;
        actionBridge.emit('navigate', { page: pageId });
        renderPage();
    }
    function refreshState() {
        currentView = createPhoneView(readState());
        if (open) renderPage();
        return currentView;
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
        try { return JSON.stringify(profile); } catch { return ''; }
    }
    function imageSourceUrl(record) {
        if (record?.source?.kind === 'embedded' && typeof record.source.dataUrl === 'string') return record.source.dataUrl;
        if (record?.source?.kind === 'url' && typeof record.source.url === 'string') return record.source.url;
        return '';
    }
    function clearMatchedImageState() {
        matchedImageByProfile.clear();
        imageMatchPending.clear();
        try { imageMatchCoordinator?.clearCache?.(); } catch { /* best effort */ }
    }
    function scheduleImageMatch(candidate) {
        if (!imageMatchCoordinator || typeof imageMatchCoordinator.resolveImage !== 'function') return;
        const key = imageProfileKey(candidate);
        if (!key || matchedImageByProfile.has(key) || imageMatchPending.has(key)) return;
        const profile = imageMatchProfile(candidate);
        const task = Promise.resolve().then(() => imageMatchCoordinator.resolveImage(profile, { contentMode: currentView.mode }))
            .then((record) => { matchedImageByProfile.set(key, record ?? null); if (open) renderPage(); })
            .catch(() => { matchedImageByProfile.set(key, null); })
            .finally(() => { imageMatchPending.delete(key); });
        imageMatchPending.set(key, task);
    }
    function matchedImageFor(candidate) {
        const key = imageProfileKey(candidate);
        if (!key) return null;
        if (!matchedImageByProfile.has(key)) scheduleImageMatch(candidate);
        return matchedImageByProfile.get(key) ?? null;
    }
    function appendImagePreview(parent, record, className, alt, onFailure) {
        const source = imageSourceUrl(record);
        if (!source) return false;
        const image = element('img', { className, src: source, alt, loading: 'lazy', referrerPolicy: 'no-referrer' });
        listen(image, image, 'error', () => { image.hidden = true; onFailure?.(); }, abortController.signal);
        parent.appendChild(image);
        return true;
    }

    function clearOperationAutoClose() {
        if (operationAutoCloseTimer === null) return;
        globalThis.clearTimeout(operationAutoCloseTimer);
        operationAutoCloseTimer = null;
    }
    function renderOperationDialog({ state = 'info', title, message, visual = '' }, token) {
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
            append(romanceVisual, [romanceLeft, romanceSignal, romanceRight]);
        } else delete romanceVisual.dataset.visual;
        romanceSignal.textContent = visual === 'accepted' ? '♥' : visual === 'declined' || visual === 'failure' ? '╳' : '∿∿∿';
        romanceRight.textContent = visual === 'declined' || visual === 'failure' ? '♡' : '♥';
        operationDialog.hidden = false;
        operationDialog.setAttribute('role', state === 'failure' ? 'alertdialog' : 'dialog');
        operationDialog.setAttribute('aria-live', state === 'failure' ? 'assertive' : 'polite');
        operationDialog.setAttribute('aria-busy', String(state === 'loading'));
        operationTitle.textContent = String(title ?? '操作提示');
        operationMessage.textContent = String(message ?? '').slice(0, 320);
        operationDismiss.hidden = false;
        operationClose.hidden = false;
        operationClose.textContent = state === 'loading' ? '关闭提示' : '关闭';
        if (state === 'success' || state === 'failure') {
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
        clearOperationAutoClose();
        activeOperation = null;
        operationDialog.hidden = true;
        operationDialog.setAttribute('aria-busy', 'false');
    }
    function visibleOperationMessage(message, fallback) {
        const text = String(message ?? '').trim();
        if (!text || text.length > 320 || /(?:api[_ -]?key|authorization|bearer|stat_data|jsonpatch|prompt|stack|http(?:s)?:\/\/|\buid\b|原始响应|技术错误|\b(?:npc|chat|meetup|group)_[a-z0-9_-]+\b)/iu.test(text)) return fallback;
        return text;
    }
    function showAiLoading(message) {
        return beginOperationDialog({ state: 'loading', visual: 'connecting', title: 'AI 调用中', message: visibleOperationMessage(message, 'AI 正在为你寻找合适的回应……') });
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
    function createOperationFeedbackHandler({ ai = false } = {}) {
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
                        activityHandle = operationActivity.start('AI 操作', 'AI 处理中……');
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
    function showAboutSoftware() {
        beginOperationDialog({ state: 'info', title: '关于软件', message: `约了吗 ${UI_VERSION}。现代都市线上文字社交模拟器。` });
        aboutClickStreak += 1;
        if (aboutClickStreak >= 5) {
            aboutUnlocked = true;
            operationMessage.textContent = '约了吗 ' + UI_VERSION + '。现代都市线上文字社交模拟器。内容模式开关已解锁。';
        }
        renderPage();
    }
    function positionHelpPopover(anchor) {
        if (!anchor || typeof anchor.getBoundingClientRect !== "function") return;
        const anchorRect = anchor.getBoundingClientRect();
        const view = documentRef.defaultView;
        const viewportWidth = Number(view?.innerWidth || documentRef.documentElement?.clientWidth || 360);
        const viewportHeight = Number(view?.innerHeight || documentRef.documentElement?.clientHeight || 640);
        helpPopover.hidden = false;
        const popoverRect = typeof helpPopover.getBoundingClientRect === 'function' ? helpPopover.getBoundingClientRect() : { width: 260, height: 100 };
        const width = Number(popoverRect.width) || 260;
        const height = Number(popoverRect.height) || 100;
        const left = Math.max(8, Math.min(Number(anchorRect.left) || 8, viewportWidth - width - 8));
        const preferredTop = (Number(anchorRect.bottom) || 0) + 8;
        const top = Math.max(8, Math.min(preferredTop, viewportHeight - Math.min(height, viewportHeight - 16) - 8));
        if (helpPopover.style?.setProperty) { helpPopover.style.setProperty('left', left + 'px'); helpPopover.style.setProperty('top', top + 'px'); helpPopover.style.setProperty('max-height', Math.max(64, viewportHeight - top - 8) + 'px'); }
    }
    function toggleHelp(anchor, text) {
        if (activeHelpAnchor === anchor && !helpPopover.hidden) { helpPopover.hidden = true; activeHelpAnchor = null; return; }
        activeHelpAnchor = anchor; helpPopover.textContent = String(text ?? "");
        helpPopover.setAttribute("aria-label", "说明：" + text); positionHelpPopover(anchor);
    }
    function backPage(pageId) {
        if (PAGE_PARENT_FOR[pageId]) return PAGE_PARENT_FOR[pageId];
        if (String(pageId).startsWith("settings_")) return "settings";
        if (String(pageId).startsWith("group_")) return "groups";
        if (String(pageId).startsWith("profile_")) return "profile";
        return "";
    }
    function navigateBack(pageId, back) {
        setActivePage(back);
    }
    function buildHelp(text) {
        const trigger = element("span", { className: "yl-help-tooltip yl-help-trigger", ariaLabel: "说明：" + text, text: "?" });
        trigger.setAttribute("role", "button"); trigger.setAttribute("tabindex", "0");
        listen(trigger, trigger, "click", () => toggleHelp(trigger, text), abortController.signal);
        listen(trigger, trigger, "keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault?.(); toggleHelp(trigger, text); } }, abortController.signal);
        return trigger;
    }
    function closeFeatureBindingDialog() {
        bindingDialog.hidden = true;
        bindingDialogContent.replaceChildren();
        featureBindingDialogState = null;
    }
    function openFeatureBinding(features, dialogTitle = '功能预设选项') {
        if (!settingsStore || typeof settingsStore.snapshot !== 'function' || typeof settingsStore.bindFunction !== 'function') {
            setFeedback('本地预设尚未就绪。');
            return;
        }
        let snapshot;
        try { snapshot = settingsStore.snapshot(); } catch { setFeedback('无法读取已保存的预设。'); return; }
        const contentMode = currentView.mode === 'NSFW' ? 'NSFW' : 'SFW';
        const modePromptPresets = snapshot.promptPresets.filter((preset) => preset.contentMode === contentMode);
        featureBindingDialogState = { features, dialogTitle };
        bindingDialogTitle.textContent = `${dialogTitle} · ${contentMode}`;
        bindingDialogContent.replaceChildren();
        if (!snapshot.connectionPresets.length && !modePromptPresets.length) {
            bindingDialogContent.appendChild(element('p', { className: 'yl-phone-page-description', text: '当前模式还没有可绑定的连接或提示词预设。请先在“我的 → 设置 → 连接设置 / 提示词预设”中创建，并为提示词标记对应模式。' }));
        }
        for (const feature of features) {
            const binding = snapshot.functionModeBindings?.[feature.key]?.[contentMode]
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
                try {
                    const next = { connectionPresetId: connection.value || null, promptPresetId: prompt.value || null };
                    if (typeof settingsStore.bindFunctionForContentMode === 'function') settingsStore.bindFunctionForContentMode(feature.key, contentMode, next);
                    else settingsStore.bindFunction(feature.key, next);
                    setFeedback(feature.title + '的 ' + contentMode + ' 预设绑定已保存。');
                } catch { setFeedback('预设绑定未保存，请确认选择的预设仍存在。'); }
            }, abortController.signal);
            row.appendChild(save); bindingDialogContent.appendChild(row);
        }
        bindingDialog.hidden = false;
    }
    function buildFeatureOptionsButton(pageId) {
        const features = FEATURE_BINDING_FOR_PAGE[pageId];
        if (!features) return null;
        const button = element('button', { className: 'yl-feature-options', type: 'button', text: '设置', ariaLabel: '配置' + (PAGE_COPY[pageId]?.title || '此功能') + '预设' });
        listen(button, button, 'click', () => openFeatureBinding(features, (PAGE_COPY[pageId]?.title || '功能') + '选项'), abortController.signal);
        return button;
    }
    function buildPageHeading(copy, pageId) {
        const row = element("div", { className: "yl-page-heading" });
        const back = backPage(pageId);
        if (back) {
            const button = element("button", { className: "yl-page-back", type: "button", ariaLabel: "返回", text: "‹" });
            listen(button, button, "click", () => navigateBack(pageId, back), abortController.signal); row.appendChild(button);
        }
        row.appendChild(element("h1", { text: copy.title }));
        if (copy.help) row.appendChild(buildHelp(copy.help));
        const featureOptions = buildFeatureOptionsButton(pageId);
        if (featureOptions) row.appendChild(featureOptions);
        return row;
    }
    function renderPage() {
        helpPopover.hidden = true; activeHelpAnchor = null;
        imageManagerPanel?.dispose?.();
        imageManagerPanel = null;
        const copy = PAGE_COPY[activePage];
        statusLine.textContent = currentView.status === 'ready' ? '已连接' : 'MVU 未就绪';
        content.replaceChildren();
        const page = element('article', { className: `yl-phone-page yl-page-${activePage}` });
        page.appendChild(buildPageHeading(copy, activePage));
        if (copy.description) page.appendChild(element('p', { className: 'yl-phone-page-description', text: copy.description }));
        if (currentView.status !== 'ready') page.appendChild(buildEmptyPlaceholder('暂时无法读取当前聊天的软件状态。', { icon: '◌' }));
        else if (activePage === 'home') page.appendChild(currentView.candidate ? buildCandidateCard(currentView.candidate) : buildEmptyCandidateCard());
        else if (activePage === 'matches') page.appendChild(buildMatchesPage());
        else if (activePage === 'match_profile') page.appendChild(buildMatchProfilePage());
        else if (activePage === 'messages') page.appendChild(buildMessagesPage());
        else if (activePage === 'private_chat') page.appendChild(buildPrivateChatPage());
        else if (activePage === 'groups') page.appendChild(buildGroupsPage());
        else if (activePage === 'group_chat') page.appendChild(buildGroupChatPage());
        else if (activePage === 'group_forum') page.appendChild(buildForumPage());
        else if (activePage === 'profile') page.appendChild(buildProfileHub());
        else if (activePage === 'profile_editor') page.appendChild(buildProfileEditor());
        else if (activePage === 'character_creator') page.appendChild(buildCharacterCreator());
        else if (activePage === 'favorites') page.appendChild(buildFavoritesPage());
        else if (activePage === 'settings') page.appendChild(buildSettingsHome());
        else if (['settings_connections', 'settings_prompts', 'settings_personalization', 'settings_personalization_preference', 'settings_images'].includes(activePage)) page.appendChild(buildSettingsDetail());
        else if (activePage === 'settings_console') page.appendChild(buildOperationConsole());
        else if (activePage === 'settings_privacy') page.appendChild(buildPrivacySettings());
        else if (activePage === 'candidate_detail') page.appendChild(buildCandidateDetail());
        content.appendChild(page);
        for (const [id, button] of navButtons) {
            const selected = id === primaryPage(activePage);
            button.classList.toggle('is-active', selected);
            button.setAttribute('aria-current', selected ? 'page' : 'false');
        }
    }

    function buildCharacterCreator() {
        if (!characterLibrary || typeof actionBridge.registerCharacter !== 'function') return element('div', { className: 'yl-phone-placeholder', text: '角色创作尚未就绪。' });
        return buildCharacterCreatorPanel({
            documentRef, actionBridge, characterLibrary, signal: abortController.signal,
            contentMode: currentView.mode,
            onFeedback: createOperationFeedbackHandler({ ai: true }),
            onConfigureFeature: (feature) => openFeatureBinding([feature], feature.title + '设置'),
            onRegistered: () => { refreshState(); setActivePage('profile'); },
        });
    }
    function displayTags(candidate) { return [...(candidate.兴趣标签 ?? []), ...(candidate.生活方式标签 ?? []), ...(candidate.性格标签 ?? []), ...(candidate.沟通风格标签 ?? [])]; }
    function buildEmptyPlaceholder(text, { tag = 'div', icon = '✧' } = {}) {
        const placeholder = element(tag, { className: 'yl-phone-placeholder' });
        const glyph = element('span', { className: 'yl-empty-icon', text: icon });
        glyph.setAttribute('aria-hidden', 'true');
        append(placeholder, [glyph, element('span', { className: 'yl-empty-text', text })]);
        return placeholder;
    }
    function buildMetaBadges(candidate) {
        const badges = element('span', { className: 'yl-candidate-meta-badges' });
        for (const value of [candidate.年龄段, candidate.城市]) {
            if (value) badges.appendChild(element('span', { className: 'yl-chip yl-chip-meta', text: value }));
        }
        return badges;
    }
    function buildTagChips(tags, emptyText) {
        const wrapper = element('div', { className: 'yl-candidate-tags yl-candidate-tag-chips' });
        if (!tags.length) {
            wrapper.appendChild(element('span', { className: 'yl-chip yl-chip-tag yl-chip-empty', text: emptyText }));
            return wrapper;
        }
        for (const tag of tags) wrapper.appendChild(element('span', { className: 'yl-chip yl-chip-tag', text: tag }));
        return wrapper;
    }
    function publicAvatar(profile, {
        uid = '',
        className = 'yl-candidate-avatar',
        imageEnabled = true,
        interactive = false,
        fallback = '人',
        imageSource = null,
    } = {}) {
        const nickname = profile?.昵称 || '未命名对象';
        const matched = imageSource === null && imageEnabled ? matchedImageFor(profile) : null;
        const profileSource = imageSource === null ? safeAvatarImageSource(profile?.头像引用) : safeAvatarImageSource(imageSource);
        const avatar = createAvatarView({
            documentRef,
            nickname,
            imageSource: matched || profileSource,
            className,
            imageClassName: className + '-image',
            alt: nickname + '的头像',
            fallback,
        });
        if (imageSource === null && imageEnabled && !matched && !profileSource && imageMatchPending.has(imageProfileKey(profile))) {
            avatar.dataset.imageStatus = 'loading';
        }
        if (!interactive || !uid) {
            avatar.setAttribute('aria-hidden', 'true');
            return avatar;
        }
        const openProfile = () => { selectedCandidateUid = uid; setActivePage('candidate_detail'); };
        avatar.setAttribute('role', 'button');
        avatar.setAttribute('tabindex', '0');
        avatar.setAttribute('aria-label', '查看' + nickname + '的公开资料');
        listen(avatar, avatar, 'click', openProfile, abortController.signal);
        listen(avatar, avatar, 'keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault?.(); openProfile(); }
        }, abortController.signal);
        return avatar;
    }
    function candidateAvatar(candidate, { imageEnabled = true, interactive = true, className = 'yl-candidate-avatar' } = {}) {
        return publicAvatar(candidate, { uid: candidate?.uid, className, imageEnabled, interactive });
    }
    function buildActionButton(kind, { pending = false, disabled = false } = {}) {
        const actionStyle = kind === 'unfavorite' ? 'favorite' : kind;
        const button = element('button', { className: `yl-phone-action-card yl-action-${actionStyle} yl-action-circle`, type: 'button', ariaLabel: ACTION_LABELS[kind], disabled });
        const icon = element('span', { className: 'yl-action-icon', text: ACTION_ICONS[kind] });
        icon.setAttribute('aria-hidden', 'true');
        const label = element('span', { className: 'yl-action-label', text: pending ? '处理中…' : ACTION_LABELS[kind] });
        append(button, [icon, label]);
        return button;
    }
    function isFavoriteCandidate(candidate) {
        return Boolean(candidate?.uid && (currentView.favorites ?? []).some((favorite) => favorite.uid === candidate.uid));
    }
    function buildActionRow(candidate, { tooltips = true } = {}) {
        const actions = element('div', { className: 'yl-candidate-actions' });
        const favoriteAction = isFavoriteCandidate(candidate) ? 'unfavorite' : 'favorite';
        const helpText = {
            like: '提高这位对象公开标签的偏好权重，不会创建匹配或私聊。',
            dislike: '降低相似公开标签的推荐权重。',
            favorite: '保存到收藏夹。',
            unfavorite: '取消收藏，并移除尚未建立私聊的候选资料。',
            refresh: '请求快速模型生成下一位候选人。',
        };
        for (const kind of ['like', 'dislike', favoriteAction, 'refresh']) {
            const pending = actionBridge.isPending(kind, candidate.uid);
            const button = buildActionButton(kind, { pending, disabled: pending });
            if (tooltips) button.appendChild(buildHelp(helpText[kind]));
            listen(button, button, 'click', () => { void runCandidateAction(kind, candidate.uid); }, abortController.signal);
            actions.appendChild(button);
        }
        return actions;
    }
    function buildCandidateCard(candidate) {
        const card = element('section', { className: refreshing ? 'yl-candidate-card is-refreshing' : 'yl-candidate-card' });
        const tags = displayTags(candidate);
        card.appendChild(buildCandidateBackgroundSlot(candidate, tags));
        const top = element('div', { className: 'yl-candidate-topline' });
        top.appendChild(candidateAvatar(candidate, { imageEnabled: true }));
        const copy = element('div', { className: 'yl-candidate-copy' });
        const nameRow = element('div', { className: 'yl-candidate-name-row' });
        nameRow.appendChild(element('h2', { text: candidate.昵称 || '未命名候选人' }));
        nameRow.appendChild(buildMetaBadges(candidate));
        copy.appendChild(nameRow);
        copy.appendChild(element('p', { className: 'yl-phone-page-description yl-candidate-subline', text: [candidate.年龄段, candidate.城市, candidate.寻找意图].filter(Boolean).join(' · ') || '仅公开资料' }));
        top.appendChild(copy); card.appendChild(top);
        card.appendChild(buildTagChips(tags, '暂无关键词'));
        card.appendChild(buildActionRow(candidate, { tooltips: false }));
        return card;
    }
    function buildCandidateBackgroundSlot(candidate, tags) {
        const slot = element('div', { className: 'yl-candidate-background-slot yl-candidate-image-slot' });
        slot.setAttribute('aria-hidden', 'true');
        slot.dataset.imageSlot = 'candidate-background';
        slot.dataset.candidateUid = String(candidate?.uid ?? '');
        slot.dataset.keywords = tags.join('|');
        const record = candidate ? matchedImageFor(candidate) : null;
        if (record) {
            slot.dataset.imageStatus = 'matched';
            appendImagePreview(slot, record, 'yl-candidate-background-image', '', () => { slot.dataset.imageStatus = 'failed'; });
        } else slot.dataset.imageStatus = candidate && imageMatchPending.has(imageProfileKey(candidate)) ? 'loading' : 'fallback';
        return slot;
    }
    function buildEmptyCandidateCard() {
        const card = element('section', { className: refreshing ? 'yl-candidate-card yl-candidate-card-empty is-refreshing' : 'yl-candidate-card yl-candidate-card-empty' });
        card.appendChild(buildCandidateBackgroundSlot(null, []));
        const top = element('div', { className: 'yl-candidate-topline' });
        top.appendChild(element('span', { className: 'yl-candidate-avatar yl-candidate-avatar-placeholder', text: '？' }));
        const copy = element('div', { className: 'yl-candidate-copy' });
        const nameRow = element('div', { className: 'yl-candidate-name-row' });
        nameRow.appendChild(element('h2', { text: '等待下一次相遇' }));
        nameRow.appendChild(element('span', { className: 'yl-candidate-meta-badges' }));
        copy.appendChild(nameRow);
        copy.appendChild(element('p', { className: 'yl-phone-page-description yl-candidate-subline', text: '点击刷新，由快速模型生成一位明确成年的候选人。' }));
        top.appendChild(copy);
        card.appendChild(top);
        card.appendChild(buildTagChips([], '等待生成关键词'));
        const actions = element('div', { className: 'yl-candidate-actions' });
        for (const kind of ['like', 'refresh', 'favorite', 'dislike']) {
            const enabled = kind === 'refresh' && typeof actionBridge.runRecommendationInitialCandidate === 'function';
            const button = buildActionButton(kind, { pending: refreshing && kind === 'refresh', disabled: !enabled || refreshing });
            if (enabled) listen(button, button, 'click', () => { actionBridge.emit('open_random_candidates'); void runInitialRecommendationCandidate(); }, abortController.signal);
            actions.appendChild(button);
        }
        card.appendChild(actions);
        return card;
    }
    function buildCandidateDetail() {
        const candidate = [
            ...(currentView.candidates ?? []),
            ...(currentView.matches ?? []).map((match) => match.profile),
            ...(currentView.messageSessions ?? []).map((session) => session.profile),
        ].find((entry) => entry?.uid === selectedCandidateUid) ?? currentView.candidate;
        if (!candidate) return element('div', { className: 'yl-phone-placeholder', text: '该公开资料已不在当前可见列表。' });
        const section = element('section', { className: 'yl-public-profile' });
        section.appendChild(candidateAvatar(candidate, { imageEnabled: true }));
        section.appendChild(element('h2', { text: candidate.昵称 || '未命名对象' }));
        for (const [label, value] of [['年龄段', candidate.年龄段], ['性别', candidate.性别], ['性取向', candidate.性取向], ['城市', candidate.城市], ['距离范围', candidate.距离范围], ['寻找意图', candidate.寻找意图], ['简介', candidate.简介]]) if (value) section.appendChild(element('p', { className: 'yl-phone-page-description', text: `${label}：${value}` }));
        const tags = displayTags(candidate);
        if (tags.length) section.appendChild(buildTagChips(tags, '暂无关键词'));
        if (currentView.candidate?.uid === candidate.uid) section.appendChild(buildActionRow(candidate, { tooltips: false }));
        return section;
    }

    function buildMatchesPage() {
        const section = element('section', { className: 'yl-phone-empty-actions yl-match-list' });
        const tools = element('section', { className: 'yl-match-tools', ariaLabel: 'AI 匹配工具' });
        const soul = element('article', { className: 'yl-soul-match-card' });
        append(soul, [
            element('span', { className: 'yl-soul-match-orbit', text: '✦' }),
            element('strong', { text: '灵魂匹配' }),
            element('span', { text: '从已保存的个性化关键词权重里，寻找更同频的公开档案。' }),
        ]);
        const soulButton = element('button', { className: 'yl-settings-button yl-soul-match-button', type: 'button', text: actionBridge.isPending('candidate_match_soul', '') ? '匹配中…' : '开始匹配', disabled: actionBridge.isPending('candidate_match_soul', '') || typeof actionBridge.runCandidateMatch !== 'function' });
        listen(soulButton, soulButton, 'click', () => { void runCandidateMatch('soul'); }, abortController.signal); soul.appendChild(soulButton); tools.appendChild(soul);

        const voice = element('article', { className: 'yl-voice-match-card' });
        append(voice, [element('strong', { text: '语音匹配' }), element('span', { text: '用一段文字说说此刻想遇见怎样的人；这次提取的关键词会优先于本地偏好。' })]);
        const voiceInput = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 3, maxLength: 800, placeholder: '例如：想找一个周末愿意逛展、也能认真听我说话的人。', value: voiceMatchText, ariaLabel: '语音匹配文字描述' });
        listen(voiceInput, voiceInput, 'input', () => { voiceMatchText = voiceInput.value; }, abortController.signal);
        const voiceButton = element('button', { className: 'yl-settings-button', type: 'button', text: actionBridge.isPending('candidate_match_voice', '') ? '匹配中…' : '开始匹配', disabled: actionBridge.isPending('candidate_match_voice', '') || typeof actionBridge.runCandidateMatch !== 'function' });
        listen(voiceButton, voiceButton, 'click', () => { void runCandidateMatch('voice'); }, abortController.signal); append(voice, [voiceInput, voiceButton]); tools.appendChild(voice);
        section.appendChild(tools);

        const matches = currentView.matches ?? [];
        const historyTitle = element('h2', { className: 'yl-match-history-title', text: '已互相喜欢' }); section.appendChild(historyTitle);
        if (!matches.length) section.appendChild(buildEmptyPlaceholder('还没有互相匹配的对象。先试试上面的 AI 匹配吧。', { tag: 'p', icon: '♥' }));
        for (const match of matches) {
            const card = element('article', { className: 'yl-chat-session yl-match-row' });
            const ring = element('span', { className: 'yl-match-avatar-ring' }); ring.appendChild(candidateAvatar(match.profile, { imageEnabled: true })); card.appendChild(ring);
            const info = element('div', { className: 'yl-candidate-copy' }); info.appendChild(element('strong', { text: match.profile.昵称 || '未命名对象' }));
            const detail = [match.profile.年龄段, match.profile.城市, match.profile.寻找意图].filter(Boolean).join(' · '); if (detail) info.appendChild(element('span', { text: detail })); card.appendChild(info);
            const session = (currentView.messageSessions ?? []).find((item) => item.npcUid === match.uid);
            const openMessages = element('button', { className: 'yl-settings-button', type: 'button', text: '聊天' });
            listen(openMessages, openMessages, 'click', () => {
                if (session) openPrivateChat(session.sessionUid);
                else setActivePage('messages');
            }, abortController.signal);
            card.appendChild(openMessages); section.appendChild(card);
        }
        return section;
    }
    async function runCandidateMatch(mode) {
        if (typeof actionBridge.runCandidateMatch !== 'function') { setFeedback('AI 匹配服务尚未就绪。'); return; }
        const requestId = ++interactionGeneration;
        const pageAtStart = activePage;
        const modeLabel = mode === 'soul' ? '灵魂匹配' : '语音匹配';
        const runningMessage = modeLabel + '中……';
        const activityHandle = operationActivity.start(modeLabel, runningMessage);
        const operationToken = showRomanceLoading(modeLabel, runningMessage);
        renderPage();
        let result;
        try { result = await actionBridge.runCandidateMatch(mode, { voiceText: voiceMatchText }); }
        catch { result = { ok: false }; }
        if (isDestroyed || requestId !== interactionGeneration) return;
        if (!result?.ok) {
            const message = result?.message || describeActionFailure(result) || modeLabel + '未生成可用结果，请稍后再试。';
            operationActivity.fail(activityHandle, modeLabel + '未完成，请稍后再试。');
            showRomanceResult({ title: modeLabel + '未完成', message }, operationToken);
            renderPage();
            return;
        }
        if (result.matchOutcome === 'declined') {
            refreshState();
            if (activePage === pageAtStart) setActivePage('matches');
            const message = '这次没有达到彼此的互动节奏，对方已婉拒，先把心意留在这里吧。';
            operationActivity.fail(activityHandle, modeLabel + '未匹配成功。');
            showRomanceResult({ declined: true, title: '这次暂未牵手', message });
            return;
        }
        const accepted = result.matchOutcome === 'accepted'
            || (!result.matchOutcome && Boolean(result.npcUid && result.sessionUid));
        if (!accepted || !result.npcUid || !result.sessionUid) {
            refreshState();
            if (activePage === pageAtStart) setActivePage('matches');
            operationActivity.fail(activityHandle, modeLabel + '结果缺少可用会话。');
            showRomanceResult({ title: modeLabel + '未完成', message: '匹配结果缺少可用会话，本次没有进入消息。' });
            return;
        }
        refreshState();
        if (activePage === pageAtStart) openPrivateChat(result.sessionUid);
        const successMessage = modeLabel + '成功，两颗心已经靠近。';
        operationActivity.succeed(activityHandle, modeLabel + '成功，已打开私聊。');
        showRomanceResult({ accepted: true, title: '心动连接成功', message: successMessage });
    }
    function buildMatchProfilePage() {
        const profile = matchedProfileDraft?.profile;
        if (!profile) return buildEmptyPlaceholder('本次匹配档案已失效，请返回匹配页重新开始。', { icon: '✦' });
        const section = element('section', { className: 'yl-match-profile' });
        const hero = element('article', { className: 'yl-match-profile-hero' });
        const avatar = publicAvatar(profile, { className: 'yl-match-profile-avatar', imageEnabled: true, interactive: false, fallback: '心' });
        const copy = element('div', { className: 'yl-match-profile-copy' });
        copy.appendChild(element('span', { className: 'yl-match-profile-mode', text: matchedProfileDraft.mode === 'voice' ? 'VOICE MATCH' : 'SOUL MATCH' }));
        copy.appendChild(element('h2', { text: profile.昵称 || '未命名对象' }));
        copy.appendChild(element('p', { text: [profile.年龄段, profile.性别, profile.性取向].filter(Boolean).join(' · ') }));
        const score = Number.isInteger(matchedProfileDraft?.matchScore) ? matchedProfileDraft.matchScore : null;
        const scoreBadge = score === null ? null : element('span', { className: 'yl-match-profile-score', text: score + '% 同频' });
        append(hero, scoreBadge ? [avatar, copy, scoreBadge] : [avatar, copy]); section.appendChild(hero);
        const grid = element('div', { className: 'yl-match-profile-grid' });
        for (const [title, value] of [['相遇坐标', [profile.城市, profile.距离范围].filter(Boolean).join(' · ')], ['这次想寻找什么', profile.寻找意图], ['关于 TA', profile.简介], ['缘分说明', matchedProfileDraft?.explanation]]) {
            const card = element('article', { className: 'yl-match-profile-info' }); append(card, [element('strong', { text: title }), element('p', { text: value || '未提供' })]); grid.appendChild(card);
        }
        section.appendChild(grid); section.appendChild(element('h3', { text: '心动关键词' })); section.appendChild(buildTagChips(displayTags(profile), '暂无公开关键词'));
        section.appendChild(element('p', { className: 'yl-match-profile-note', text: '这是一份仅本次展示的 AI 公开资料草稿，没有写入角色池、会话或匹配状态。' }));
        const actions = element('div', { className: 'yl-match-profile-actions' });
        const cancel = element('button', { className: 'yl-settings-button', type: 'button', text: '返回匹配' }); listen(cancel, cancel, 'click', () => setActivePage('matches'), abortController.signal);
        const retry = element('button', { className: 'yl-settings-button', type: 'button', text: '再匹配一次' }); listen(retry, retry, 'click', () => { setActivePage('matches'); }, abortController.signal);
        append(actions, [cancel, retry]); section.appendChild(actions); return section;
    }
    function buildGroupsPage() { return buildGroupHub(); }
    function buildGroupHub() {
        const section = element('section', { className: 'yl-miniapp-grid' });
        for (const [page, icon, title, note] of [['group_chat', '◌', '聊天群', '浏览公开群成员与话题。'], ['group_forum', '▤', '论坛', '浏览主题和公开讨论对象。']]) {
            const button = element('button', { className: 'yl-miniapp-card', type: 'button', ariaLabel: title });
            append(button, [element('span', { className: 'yl-miniapp-icon', text: icon }), element('strong', { text: title }), element('span', { text: note })]);
            listen(button, button, 'click', () => setActivePage(page), abortController.signal); section.appendChild(button);
        }
        return section;
    }
    function buildGroupChatComposer(group) {
        const wrapper = element('section', { className: 'yl-chat-composer yl-group-draft-composer' });
        const pending = actionBridge.isPending('group_chat_draft', group.UID);
        const available = typeof actionBridge.generateGroupChatDraft === 'function';
        const input = element('textarea', {
            className: 'yl-settings-control yl-settings-textarea', rows: 2, maxLength: 480,
            placeholder: '输入一条公开群聊消息…', value: groupChatInputDrafts.get(group.UID) ?? '', disabled: pending || !available,
        });
        listen(input, input, 'input', () => { groupChatInputDrafts.set(group.UID, input.value); }, abortController.signal);
        const generate = element('button', { className: 'yl-settings-button', type: 'button', disabled: pending || !available, text: pending ? '生成中…' : '生成群聊草稿' });
        listen(generate, generate, 'click', () => { void runGroupChatDraft(group); }, abortController.signal);
        append(wrapper, [input, generate]);
        if (!available) wrapper.appendChild(element('p', { className: 'yl-phone-placeholder', text: '群聊草稿服务尚未就绪。' }));
        const draft = groupChatGeneratedDrafts.get(group.UID);
        if (draft?.reply) {
            const output = element('div', { className: 'yl-group-generated-draft' });
            append(output, [element('strong', { text: '群聊回复草稿' }), element('p', { text: draft.reply }), element('span', { className: 'yl-group-draft-note', text: '未发布，不会写入软件状态。' })]);
            wrapper.appendChild(output);
        }
        return wrapper;
    }
    async function runGroupChatDraft(group) {
        const playerMessage = String(groupChatInputDrafts.get(group.UID) ?? '').trim();
        const operationToken = showAiLoading('正在生成群聊草稿，请稍候…');
        setFeedback('正在生成群聊草稿…', operationToken); renderPage();
        let result;
        try { result = await actionBridge.generateGroupChatDraft({ groupUid: group.UID, playerMessage }); }
        catch { result = { ok: false }; }
        if (result?.ok && result.draft?.reply) {
            groupChatGeneratedDrafts.set(group.UID, { reply: result.draft.reply });
            setFeedback('群聊草稿已生成，尚未发布。', operationToken);
            showAiResult(true, '群聊草稿已生成，尚未发布。', operationToken);
        } else {
            const message = result?.message || describeActionFailure(result);
            setFeedback(message, operationToken);
            showAiResult(false, message || '群聊草稿未生成，请稍后重试。', operationToken);
        }
        renderPage();
    }
    function buildForumComposer(group) {
        const wrapper = element('section', { className: 'yl-chat-composer yl-group-draft-composer' });
        const pending = actionBridge.isPending('forum_draft', group.UID);
        const available = typeof actionBridge.generateForumPostDraft === 'function';
        const input = element('textarea', {
            className: 'yl-settings-control yl-settings-textarea', rows: 2, maxLength: 160,
            placeholder: '输入一个公开发帖主题…', value: forumTopicDrafts.get(group.UID) ?? '', disabled: pending || !available,
        });
        listen(input, input, 'input', () => { forumTopicDrafts.set(group.UID, input.value); }, abortController.signal);
        const generate = element('button', { className: 'yl-settings-button', type: 'button', disabled: pending || !available, text: pending ? '生成中…' : '生成帖子草稿' });
        listen(generate, generate, 'click', () => { void runForumDraft(group); }, abortController.signal);
        append(wrapper, [input, generate]);
        if (!available) wrapper.appendChild(element('p', { className: 'yl-phone-placeholder', text: '论坛草稿服务尚未就绪。' }));
        const draft = forumGeneratedDrafts.get(group.UID);
        if (draft?.title && draft?.body) {
            const output = element('div', { className: 'yl-group-generated-draft' });
            append(output, [element('strong', { text: draft.title }), element('p', { text: draft.body }), element('span', { className: 'yl-group-draft-note', text: '待审核草稿，未发布且不会写入软件状态。' })]);
            wrapper.appendChild(output);
        }
        return wrapper;
    }
    async function runForumDraft(group) {
        const topic = String(forumTopicDrafts.get(group.UID) ?? '').trim();
        const operationToken = showAiLoading('正在生成论坛帖子草稿，请稍候…');
        setFeedback('正在生成论坛帖子草稿…', operationToken); renderPage();
        let result;
        try { result = await actionBridge.generateForumPostDraft({ groupUid: group.UID, topic }); }
        catch { result = { ok: false }; }
        if (result?.ok && result.draft?.title && result.draft?.body) {
            forumGeneratedDrafts.set(group.UID, { title: result.draft.title, body: result.draft.body });
            setFeedback('论坛帖子草稿已生成，尚未发布。', operationToken);
            showAiResult(true, '论坛帖子草稿已生成，尚未发布。', operationToken);
        } else {
            const message = result?.message || describeActionFailure(result);
            setFeedback(message, operationToken);
            showAiResult(false, message || '论坛帖子草稿未生成，请稍后重试。', operationToken);
        }
        renderPage();
    }
    function groupCards({ forum = false } = {}) {
        const groups = Array.isArray(currentView.groups) ? currentView.groups : [];
        const section = element('section', { className: 'yl-phone-empty-actions yl-group-list' });
        if (!groups.length) {
            section.appendChild(buildEmptyPlaceholder(forum ? '暂无可浏览论坛主题。' : '暂无可浏览聊天群。', { tag: 'p', icon: forum ? '▤' : '◌' }));
            return section;
        }
        for (const group of groups) {
            const card = element('article', { className: 'yl-chat-session yl-group-card' });
            card.appendChild(element('h2', { text: group.主题 }));
            if (group.描述) card.appendChild(element('p', { className: 'yl-phone-page-description', text: group.描述 }));
            const members = Array.isArray(group.成员) ? group.成员 : [];
            if (members.length) {
                const memberList = element('div', { className: 'yl-group-member-list', ariaLabel: '群聊成员' });
                for (const person of members) {
                    const profile = person.公开资料 ?? {};
                    const member = element('span', { className: 'yl-group-member' });
                    member.appendChild(publicAvatar(profile, { className: 'yl-group-member-avatar', imageEnabled: true, interactive: false }));
                    member.appendChild(element('span', { text: profile.昵称 || '未命名成年人' }));
                    memberList.appendChild(member);
                }
                card.appendChild(memberList);
            } else card.appendChild(element('p', { className: 'yl-phone-page-description', text: '成员资料暂不可见' }));
            const discoverable = Array.isArray(group.可发现角色) ? group.可发现角色 : [];
            if (forum) {
                card.appendChild(element('span', { className: 'yl-group-forum-state', text: discoverable.length ? `可参与讨论对象 ${discoverable.length} 位` : '暂无公开讨论对象' }));
                card.appendChild(buildForumComposer(group));
            } else {
                for (const person of discoverable) {
                    const profile = person.公开资料 ?? {};
                    const row = element('div', { className: 'yl-character-library-row yl-group-character-row' });
                    row.appendChild(publicAvatar(profile, { className: 'yl-group-member-avatar', imageEnabled: true, interactive: false }));
                    row.appendChild(element('strong', { text: profile.昵称 || '未命名成年人' }));
                    const session = (currentView.messageSessions ?? []).find((item) => item.npcUid === person.UID);
                    if (session) {
                        const openChat = element('button', { className: 'yl-settings-button', type: 'button', text: '进入已有私聊' });
                        listen(openChat, openChat, 'click', () => openPrivateChat(session.sessionUid), abortController.signal);
                        row.appendChild(openChat);
                    } else row.appendChild(element('span', { text: '尚无私聊' }));
                    card.appendChild(row);
                }
                card.appendChild(buildGroupChatComposer(group));
            }
            section.appendChild(card);
        }
        return section;
    }
    function buildGroupChatPage() { return groupCards(); }
    function buildForumPage() { return groupCards({ forum: true }); }
    function messageSessions() {
        return Array.isArray(currentView.messageSessions) ? currentView.messageSessions : [];
    }
    function messageSessionByUid(sessionUid) {
        return messageSessions().find((session) => session.sessionUid === sessionUid) ?? null;
    }
    function chatNickname(session) {
        return session?.profile?.昵称 || '未命名对象';
    }
    function chatAvatar(session, className = 'yl-session-avatar', { interactive = false } = {}) {
        return publicAvatar(session?.profile, {
            uid: session?.npcUid,
            className,
            imageEnabled: true,
            interactive,
        });
    }
    function openPrivateChat(sessionUid) {
        const session = messageSessionByUid(sessionUid);
        if (!session) {
            activeMessageSessionUid = '';
            setActivePage('messages');
            return;
        }
        if (activeMessageSessionUid !== session.sessionUid) {
            if (activePage === 'private_chat') privateChatRequestGeneration += 1;
            activeChatToolsSessionUid = '';
            activeMeetupSessionUid = '';
        }
        activeMessageSessionUid = session.sessionUid;
        setActivePage('private_chat');
    }
    function buildMessagesPage() {
        const sessions = messageSessions();
        if (!sessions.length) return buildEmptyPlaceholder('暂无已建立的私聊会话。去匹配页遇见一位公开可见的成年人吧。', { icon: '✉' });
        const section = element('section', { className: 'yl-chat-page yl-message-list-page' });
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
        const searchInput = element('input', { className: 'yl-message-search-input yl-settings-control', type: 'search', value: messageSearchQuery, placeholder: '搜索昵称或最近消息', ariaLabel: '搜索私聊' });
        search.appendChild(searchInput);
        listen(searchInput, searchInput, 'input', () => { messageSearchQuery = String(searchInput.value ?? ''); renderPage(); }, abortController.signal);
        section.appendChild(search);
        const query = messageSearchQuery.trim().toLocaleLowerCase();
        const visibleSessions = query ? sessions.filter((session) => {
            const nickname = chatNickname(session).toLocaleLowerCase();
            const latestVisibleMessage = String(session.messages.at(-1)?.content ?? '').toLocaleLowerCase();
            return nickname.includes(query) || latestVisibleMessage.includes(query);
        }) : sessions;
        if (!visibleSessions.length) {
            section.appendChild(buildEmptyPlaceholder('没有找到符合条件的私聊。', { icon: '⌕' }));
            return section;
        }
        const sessionList = element('div', { className: 'yl-chat-session-list' });
        for (const session of visibleSessions) {
            const nickname = chatNickname(session);
            const lastMessage = session.messages.at(-1);
            const button = element('button', { className: 'yl-chat-session yl-message-session', type: 'button', ariaLabel: `打开与${nickname}的私聊` });
            const avatarWrap = element('span', { className: 'yl-session-avatar-wrap' });
            avatarWrap.appendChild(chatAvatar(session));
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
            meta.appendChild(element('span', { className: 'yl-session-open-mark', text: '›' }));
            append(button, [avatarWrap, copy, meta]);
            listen(button, button, 'click', () => openPrivateChat(session.sessionUid), abortController.signal);
            sessionList.appendChild(button);
        }
        section.appendChild(sessionList);
        return section;
    }
    function buildPrivateChatPage() {
        const session = messageSessionByUid(activeMessageSessionUid);
        if (!session) return buildEmptyPlaceholder('这个私聊会话暂时不可见。请返回消息列表后重试。', { icon: '✉' });
        return buildConversationPanel(session);
    }
    function closeChatMoreMenu() {
        if (!chatMoreMenuSessionUid) return false;
        chatMoreMenuSessionUid = '';
        renderPage();
        return true;
    }
    function buildConversationHeader(session) {
        const header = element('section', { className: 'yl-private-chat-contact' });
        header.appendChild(chatAvatar(session, 'yl-chat-contact-avatar', { interactive: true }));
        const copy = element('div', { className: 'yl-private-chat-contact-copy' });
        copy.appendChild(element('h2', { text: chatNickname(session) }));
        const subline = element('span', { className: 'yl-private-chat-subline' });
        const dot = element('span', { className: 'yl-private-chat-status-dot' });
        dot.dataset.status = session.status;
        dot.setAttribute('aria-hidden', 'true');
        append(subline, [dot, element('span', { text: session.status === '已匹配' ? '已匹配 · 文字私聊' : session.status })]);
        copy.appendChild(subline);
        header.appendChild(copy);
        const actions = element('div', { className: 'yl-private-chat-actions' });
        const moreOpen = chatMoreMenuSessionUid === session.sessionUid;
        const more = element('button', {
            className: 'yl-private-chat-more', type: 'button', text: '…',
            ariaLabel: '打开与' + chatNickname(session) + '的更多操作',
            disabled: destructiveChatSessionUid === session.sessionUid,
        });
        more.setAttribute('aria-haspopup', 'menu');
        more.setAttribute('aria-expanded', String(moreOpen));
        listen(more, more, 'click', (event) => {
            event.stopPropagation?.();
            chatMoreMenuSessionUid = moreOpen ? '' : session.sessionUid;
            renderPage();
        }, abortController.signal);
        actions.appendChild(more);
        if (moreOpen) {
            const menu = element('div', { className: 'yl-private-chat-more-menu', ariaLabel: '私聊更多操作' });
            menu.setAttribute('role', 'menu');
            const clear = element('button', { className: 'yl-private-chat-menu-item', type: 'button', text: '清空聊天记录', ariaLabel: '清空聊天记录' });
            const removeCharacter = element('button', { className: 'yl-private-chat-menu-item is-danger', type: 'button', text: '删除角色', ariaLabel: '删除角色完整数据' });
            clear.setAttribute('role', 'menuitem');
            removeCharacter.setAttribute('role', 'menuitem');
            listen(clear, clear, 'click', () => {
                chatMoreMenuSessionUid = '';
                chatConfirmationSessionUid = session.sessionUid;
                chatConfirmationKind = 'clear';
                renderPage();
            }, abortController.signal);
            listen(removeCharacter, removeCharacter, 'click', () => {
                chatMoreMenuSessionUid = '';
                chatConfirmationSessionUid = session.sessionUid;
                chatConfirmationKind = 'delete_character';
                renderPage();
            }, abortController.signal);
            append(menu, [clear, removeCharacter]);
            actions.appendChild(menu);
        }
        actions.appendChild(element('span', { className: 'yl-private-chat-spark', text: '♥' }));
        header.appendChild(actions);
        return header;
    }
    function buildPrivateChatConfirmation(session) {
        const deletingCharacter = chatConfirmationKind === 'delete_character';
        const pending = destructiveChatSessionUid === session.sessionUid;
        const confirmation = element('section', { className: deletingCharacter ? 'yl-chat-delete-confirmation is-character-delete' : 'yl-chat-delete-confirmation is-chat-clear' });
        if (deletingCharacter) {
            append(confirmation, [
                element('strong', { text: '删除' + chatNickname(session) + '的完整角色数据？' }),
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
            chatConfirmationSessionUid = '';
            chatConfirmationKind = '';
            renderPage();
        }, abortController.signal);
        listen(confirm, confirm, 'click', () => { void runPrivateChatDestructiveAction(session, chatConfirmationKind); }, abortController.signal);
        append(actions, [cancel, confirm]);
        confirmation.appendChild(actions);
        return confirmation;
    }
    async function runPrivateChatDestructiveAction(session, kind) {
        if (destructiveChatSessionUid) return;
        const deletingCharacter = kind === 'delete_character';
        const action = deletingCharacter ? actionBridge.deleteCharacter : actionBridge.clearPrivateChat;
        if (typeof action !== 'function') {
            setFeedback(deletingCharacter ? '删除角色功能尚未就绪。' : '清空聊天记录功能尚未就绪。');
            return;
        }
        destructiveChatSessionUid = session.sessionUid;
        destructiveChatKind = kind;
        const relatedSessionUids = messageSessions().filter((item) => item.npcUid === session.npcUid).map((item) => item.sessionUid);
        renderPage();
        let result;
        try { result = await action(deletingCharacter ? session.npcUid : session.sessionUid); }
        catch { result = { ok: false }; }
        if (!result?.ok) {
            destructiveChatSessionUid = '';
            destructiveChatKind = '';
            setFeedback(result?.message || describeActionFailure(result) || (deletingCharacter ? '角色删除失败，请稍后重试。' : '聊天记录清空失败，请稍后重试。'));
            renderPage();
            return;
        }
        const sessionsToClear = deletingCharacter ? relatedSessionUids : [session.sessionUid];
        for (const sessionUid of sessionsToClear) {
            chatDrafts.delete(sessionUid);
            meetupDrafts.delete(sessionUid);
        }
        if (deletingCharacter) {
            selectedCandidateUid = selectedCandidateUid === session.npcUid ? '' : selectedCandidateUid;
            clearMatchedImageState();
        }
        activeMessageSessionUid = '';
        activeChatToolsSessionUid = '';
        activeMeetupSessionUid = '';
        chatMoreMenuSessionUid = '';
        chatConfirmationSessionUid = '';
        chatConfirmationKind = '';
        destructiveChatSessionUid = '';
        destructiveChatKind = '';
        refreshState();
        setActivePage('messages');
        setFeedback(deletingCharacter ? '角色完整数据及其关联记录已删除。' : '聊天记录已清空，会话已从消息列表移除。');
    }
    function buildMessageBubble(session, message) {
        if (message.sender === '系统') {
            const note = element('p', { className: 'yl-chat-system-note', text: message.content });
            if (message.time) note.appendChild(element('span', { text: message.time }));
            return note;
        }
        const isPlayer = message.sender === '玩家';
        const row = element('article', { className: isPlayer ? 'yl-chat-bubble is-player' : 'yl-chat-bubble is-contact' });
        if (!isPlayer) row.appendChild(chatAvatar(session, 'yl-chat-message-avatar'));
        const bubbleContent = element('div', { className: 'yl-bubble-content' });
        const label = isPlayer ? '我' : chatNickname(session);
        bubbleContent.appendChild(element('strong', { text: label }));
        bubbleContent.appendChild(element('p', { text: message.content }));
        if (message.time) bubbleContent.appendChild(element('span', { className: 'yl-bubble-time', text: message.time }));
        row.appendChild(bubbleContent);
        if (isPlayer) {
            row.appendChild(publicAvatar({ 昵称: '我' }, {
                className: 'yl-chat-message-avatar yl-chat-self-avatar',
                imageEnabled: false,
                interactive: false,
                fallback: '我',
                imageSource: playerAvatarStore?.snapshot?.() ?? '',
            }));
        }
        return row;
    }
    function buildConversationPanel(session) {
        const panel = element('section', { className: 'yl-private-chat-screen' });
        panel.appendChild(buildConversationHeader(session));
        if (chatConfirmationSessionUid === session.sessionUid) panel.appendChild(buildPrivateChatConfirmation(session));
        const privacyNote = element('p', { className: 'yl-chat-privacy-note', text: '线上短消息会通过当前“私聊”功能绑定处理；重要面基安排请单独确认。' });
        panel.appendChild(privacyNote);
        const transcript = element('div', { className: 'yl-chat-transcript', ariaLabel: `${chatNickname(session)}的私聊记录` });
        transcript.setAttribute('aria-live', 'polite');
        if (!session.messages.length) transcript.appendChild(buildEmptyPlaceholder('还没有消息。用一句简单的问候开始吧。', { tag: 'p', icon: '✦' }));
        else {
            transcript.appendChild(element('p', { className: 'yl-chat-transcript-label', text: '最近消息' }));
            for (const message of session.messages) transcript.appendChild(buildMessageBubble(session, message));
        }
        const pending = Boolean(actionBridge.isPending?.('private_chat', session.sessionUid));
        if (pending) {
            const replying = element('div', { className: 'yl-chat-replying', text: `${chatNickname(session)}正在生成回复` });
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
        if (typeof actionBridge.runPrivateChat !== 'function') {
            panel.appendChild(element('div', { className: 'yl-phone-placeholder', text: '私聊发送尚未就绪。' }));
            return panel;
        }
        const composer = element('div', { className: pending ? 'yl-chat-composer is-pending' : 'yl-chat-composer' });
        const input = element('textarea', {
            className: 'yl-settings-control yl-settings-textarea', rows: 2, maxLength: 600,
            placeholder: '输入消息…', value: chatDrafts.get(session.sessionUid) ?? '', disabled: pending,
            ariaLabel: '输入私聊消息',
        });
        const send = element('button', {
            className: 'yl-chat-send-button', type: 'button', disabled: pending,
            ariaLabel: pending ? '正在生成私聊回复' : '发送消息',
        });
        const sendGlyph = element('span', { className: pending ? 'yl-chat-send-pending' : 'yl-chat-send-icon', text: pending ? '···' : '' });
        sendGlyph.setAttribute('aria-hidden', 'true');
        send.appendChild(sendGlyph);
        const meetupAvailable = typeof actionBridge.runMeetupHandoff === 'function';
        const toolsOpen = meetupAvailable && activeChatToolsSessionUid === session.sessionUid;
        send.setAttribute('aria-haspopup', meetupAvailable ? 'menu' : 'false');
        send.setAttribute('aria-expanded', String(toolsOpen));
        send.setAttribute('title', meetupAvailable ? '左键发送，右键打开工具栏' : '发送消息');
        const updateSendState = () => {
            const empty = !String(input.value ?? '').trim();
            send.disabled = pending;
            send.classList.toggle('is-empty', empty && !pending);
            send.setAttribute('aria-disabled', String(pending || empty));
        };
        updateSendState();
        listen(input, input, 'input', () => { chatDrafts.set(session.sessionUid, input.value); updateSendState(); }, abortController.signal);
        listen(input, input, 'keydown', (event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing || pending) return;
            event.preventDefault?.();
            activeChatToolsSessionUid = '';
            void runPrivateChat(session);
        }, abortController.signal);
        listen(send, send, 'click', () => { activeChatToolsSessionUid = ''; void runPrivateChat(session); }, abortController.signal);
        if (meetupAvailable) listen(send, send, 'contextmenu', (event) => {
            event.preventDefault?.();
            if (pending) return;
            activeChatToolsSessionUid = toolsOpen ? '' : session.sessionUid;
            renderPage();
        }, abortController.signal);
        const controls = element('div', { className: 'yl-chat-composer-controls' });
        controls.appendChild(send);
        if (toolsOpen) {
            const toolMenu = element('div', { className: 'yl-chat-tool-menu', ariaLabel: '私聊发送工具栏' });
            toolMenu.setAttribute('role', 'menu');
            const meetupTool = element('button', { className: 'yl-chat-tool-button', type: 'button', text: '约定面基', ariaLabel: '打开约定面基' });
            meetupTool.setAttribute('role', 'menuitem');
            listen(meetupTool, meetupTool, 'click', () => {
                activeChatToolsSessionUid = '';
                activeMeetupSessionUid = session.sessionUid;
                renderPage();
            }, abortController.signal);
            toolMenu.appendChild(meetupTool);
            controls.appendChild(toolMenu);
        }
        append(composer, [input, controls, element('span', { className: 'yl-chat-composer-hint', text: meetupAvailable ? '左键发送 · 右键工具栏 · Shift+Enter 换行' : 'Enter 发送 · Shift+Enter 换行' })]);
        panel.appendChild(composer);
        if (meetupAvailable && activeMeetupSessionUid === session.sessionUid) panel.appendChild(buildMeetupHandoffPanel(session));
        return panel;
    }
    async function runPrivateChat(session) {
        const playerMessage = String(chatDrafts.get(session.sessionUid) ?? '');
        if (!playerMessage.trim()) {
            setFeedback('请先输入想说的话。');
            return;
        }
        if (typeof actionBridge.runPrivateChat !== 'function' || actionBridge.isPending?.('private_chat', session.sessionUid)) return;
        const requestGeneration = ++privateChatRequestGeneration;
        const isStillVisible = () => open
            && activePage === 'private_chat'
            && activeMessageSessionUid === session.sessionUid
            && privateChatRequestGeneration === requestGeneration;
        let request;
        try { request = actionBridge.runPrivateChat({ sessionUid: session.sessionUid, npcUid: session.npcUid, playerMessage }); }
        catch { request = Promise.resolve({ ok: false }); }
        // The bridge marks the exact session pending synchronously before its first await.
        // Re-rendering now gives the composer an inline, non-blocking reply state.
        renderPage();
        let result;
        try { result = await request; }
        catch { result = { ok: false }; }
        if (result?.ok) chatDrafts.delete(session.sessionUid);
        else if (isStillVisible()) {
            const message = result?.message || describeActionFailure(result);
            setFeedback(message || '私聊回复未生成，请稍后重试。');
        }
        refreshState();
    }
    function meetupFieldsFor(sessionUid) {
        if (!meetupDrafts.has(sessionUid)) meetupDrafts.set(sessionUid, { time: '', place: '', mutualIntent: '', confirmedBoundaries: '', pendingItems: '', riskNotice: '' });
        return meetupDrafts.get(sessionUid);
    }
    function buildMeetupHandoffPanel(session) {
        const wrapper = element('section', { className: 'yl-meetup-panel' });
        const pending = actionBridge.isPending('meetup_handoff', session.sessionUid);
        const heading = element('div', { className: 'yl-heading-with-help' });
        heading.appendChild(element('h2', { text: '约定面基' })); heading.appendChild(buildHelp('只会把确认后的现实行动草稿填入酒馆输入框，不会自动发送。'));
        wrapper.appendChild(heading);
        const openButton = element('button', { className: 'yl-settings-button', type: 'button', disabled: pending, text: pending ? '处理中…' : activeMeetupSessionUid === session.sessionUid ? '收起' : '填写约定' });
        listen(openButton, openButton, 'click', () => { activeMeetupSessionUid = activeMeetupSessionUid === session.sessionUid ? '' : session.sessionUid; renderPage(); }, abortController.signal);
        wrapper.appendChild(openButton);
        if (activeMeetupSessionUid !== session.sessionUid) return wrapper;
        const values = meetupFieldsFor(session.sessionUid);
        const fields = [['time', '时间', '本周六 19:30', 160, true], ['place', '地点', '静安寺地铁站 2 号口', 160, true], ['mutualIntent', '双方意图', '一起吃饭，确认是否继续约会', 500, true], ['confirmedBoundaries', '已确认边界', '公共场所见面；任何亲密行为需当场确认', 1200, true], ['pendingItems', '待确认事项', '散场时间', 800, false], ['riskNotice', '风险提示', '各自独立到场，可随时离开', 800, false]];
        for (const [key, label, placeholder, maxLength, required] of fields) {
            const block = element('label', { className: 'yl-settings-field' }); block.appendChild(element('span', { text: label }));
            const input = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: key === 'confirmedBoundaries' ? 4 : 2, maxLength, placeholder, value: values[key], disabled: pending });
            if (required) input.required = true;
            listen(input, input, 'input', () => { values[key] = input.value; }, abortController.signal); block.appendChild(input); wrapper.appendChild(block);
        }
        const commit = element('button', { className: 'yl-settings-button', type: 'button', disabled: pending, text: pending ? '正在保存…' : '填入正文草稿' });
        listen(commit, commit, 'click', () => { void runMeetupHandoff(session); }, abortController.signal); wrapper.appendChild(commit);
        return wrapper;
    }
    async function runMeetupHandoff(session) {
        const operationToken = setFeedback('正在校验面基约定…'); renderPage();
        const result = await actionBridge.runMeetupHandoff({ sessionUid: session.sessionUid, npcUid: session.npcUid, ...meetupFieldsFor(session.sessionUid) });
        if (result.ok && result.draftApplied) { meetupDrafts.delete(session.sessionUid); activeMeetupSessionUid = ''; setFeedback('正文草稿已填入，未自动发送。', operationToken); }
        else if (result.ok) setFeedback('已保存约定，但没有找到正文输入框。', operationToken);
        else setFeedback(describeActionFailure(result), operationToken);
        refreshState();
    }

    function closeAvatarDialog() {
        avatarDialog.hidden = true;
        avatarLinkInput.value = '';
    }
    function openAvatarDialog() {
        if (!playerAvatarStore || typeof playerAvatarStore.snapshot !== 'function') {
            setFeedback('本地头像存储尚未就绪。');
            return;
        }
        avatarDialog.hidden = false;
    }
    function playerAvatarButton(nickname) {
        let avatar = null;
        try { avatar = playerAvatarStore?.snapshot?.() ?? null; } catch { avatar = null; }
        const source = avatarImageSource(avatar);
        const button = element('button', {
            className: 'yl-person-avatar yl-person-avatar-button', type: 'button',
            ariaLabel: '更换个人头像', text: source ? '' : (nickname.slice(0, 1) || '我'),
        });
        if (source) {
            button.appendChild(element('img', {
                src: source, alt: '当前个人头像', loading: 'lazy', referrerPolicy: 'no-referrer',
            }));
        }
        listen(button, button, 'click', openAvatarDialog, abortController.signal);
        return button;
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
    function saveLinkedAvatar() {
        if (!playerAvatarStore || typeof playerAvatarStore.setAvatar !== 'function') return;
        try {
            playerAvatarStore.setAvatar({ kind: 'url', url: String(avatarLinkInput.value ?? '').trim() });
            closeAvatarDialog();
            setFeedback('头像链接已保存到当前浏览器。');
            renderPage();
        } catch {
            setFeedback('头像链接仅支持有效的 http 或 https 图片地址。');
        }
    }
    function removePlayerAvatar() {
        if (!playerAvatarStore || typeof playerAvatarStore.removeAvatar !== 'function') return;
        try { playerAvatarStore.removeAvatar(); } catch { /* menu remains usable even if storage clearing fails */ }
        closeAvatarDialog();
        setFeedback('本地头像已移除。');
        renderPage();
    }
    function buildProfileHub() {
        const section = element('section', { className: 'yl-person-center' });
        const nickname = currentView.playerProfile.昵称 || '未填写个人资料';
        const headerCard = element('article', { className: 'yl-person-summary' });
        const hero = element('div', { className: 'yl-person-hero' });
        hero.appendChild(playerAvatarButton(nickname));
        headerCard.appendChild(hero);
        const copy = element('div');
        copy.appendChild(element('strong', { text: nickname }));
        copy.appendChild(element('span', { text: currentView.playerProfile.城市 || '建立公开资料后开启更准确的匹配。' }));
        headerCard.appendChild(copy); section.appendChild(headerCard);
        const entries = [['profile_editor', '◉', '个人资料', '填写公开资料。'], ['character_creator', '＋', '创建角色', '创建、导入并管理成年人角色模板。'], ['favorites', '☆', `收藏夹${currentView.favorites.length ? ` · ${currentView.favorites.length}` : ''}`, '查看保存的候选人。'], ['settings', '⚙', '设置', '匹配、连接、提示词与关于软件。']];
        for (const [page, icon, title, note] of entries) {
            const button = element('button', { className: 'yl-center-entry', type: 'button', ariaLabel: title });
            append(button, [element('span', { text: icon }), element('strong', { text: title }), element('span', { text: note }), element('span', { text: '›' })]);
            listen(button, button, 'click', () => setActivePage(page), abortController.signal); section.appendChild(button);
        }
        return section;
    }
    function seedPlayerDraft() {
        if (playerProfileDraft) return playerProfileDraft;
        const source = currentView.playerProfile;
        playerProfileDraft = { ...source, 兴趣标签: [...source.兴趣标签], 生活方式标签: [...source.生活方式标签], 性格标签: [...source.性格标签], 沟通风格标签: [...source.沟通风格标签] };
        return playerProfileDraft;
    }
    function buildProfileEditor() {
        const draft = seedPlayerDraft();
        const section = element('section', { className: 'yl-profile-editor' });
        section.appendChild(element('p', { className: 'yl-phone-page-description', text: '只编辑公开资料；头像请在“我的”页点击头像单独管理，本页不会读取或显示私密层。' }));
        const fields = [['昵称', 'text'], ['年龄段', 'text'], ['性别', 'text'], ['性取向', 'text'], ['城市', 'text'], ['距离范围', 'text'], ['寻找意图', 'text'], ['简介', 'textarea'], ['兴趣标签', 'tags'], ['生活方式标签', 'tags'], ['性格标签', 'tags'], ['沟通风格标签', 'tags']];
        for (const [key, type] of fields) {
            const block = element('label', { className: 'yl-settings-field' }); block.appendChild(element('span', { text: key }));
            const value = type === 'tags' ? draft[key].join('，') : draft[key];
            const input = type === 'textarea'
                ? element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 3, maxLength: 600, value })
                : element('input', { className: 'yl-settings-control', type: type === 'url' ? 'url' : 'text', maxLength: type === 'tags' ? 240 : 160, value });
            listen(input, input, 'input', () => { draft[key] = type === 'tags' ? input.value.split(/[，,]/u).map((tag) => tag.trim()).filter(Boolean).slice(0, 12) : input.value.trim(); }, abortController.signal);
            block.appendChild(input); section.appendChild(block);
        }
        const canSave = typeof actionBridge.runSavePlayerPublicProfile === 'function';
        const save = element('button', { className: 'yl-settings-button', type: 'button', text: canSave ? '保存公开资料' : '保存本次草稿' });
        save.appendChild(buildHelp(canSave
            ? '只提交这一页的公开字段，成功后才会参与双层评分与匹配。'
            : '当前宿主尚未提供玩家资料的受控 MVU 写入接口；草稿只保留在本次界面。'));
        listen(save, save, 'click', () => { void savePlayerProfile(); }, abortController.signal);
        section.appendChild(save);
        return section;
    }
    function playerProfilePayload() {
        const draft = seedPlayerDraft();
        return Object.freeze({
            昵称: draft.昵称, 头像引用: '', 年龄段: draft.年龄段, 性别: draft.性别, 性取向: draft.性取向,
            城市: draft.城市, 距离范围: draft.距离范围, 寻找意图: draft.寻找意图, 简介: draft.简介,
            兴趣标签: [...draft.兴趣标签], 生活方式标签: [...draft.生活方式标签], 性格标签: [...draft.性格标签], 沟通风格标签: [...draft.沟通风格标签],
        });
    }
    async function savePlayerProfile() {
        if (typeof actionBridge.runSavePlayerPublicProfile !== 'function') {
            setFeedback('个人资料草稿已保留在当前界面；当前宿主尚未提供受控 MVU 写入接口。');
            renderPage();
            return;
        }
        const operationToken = setFeedback('正在保存公开资料…');
        renderPage();
        const result = await actionBridge.runSavePlayerPublicProfile(playerProfilePayload());
        if (result?.ok) {
            playerProfileDraft = null;
            setFeedback('公开资料已保存，可参与后续评分与匹配。', operationToken);
            refreshState();
        } else {
            setFeedback(result?.message || describeActionFailure(result), operationToken);
            renderPage();
        }
    }
    function buildFavoritesPage() {
        if (!currentView.favorites.length) return buildEmptyPlaceholder('收藏夹还是空的。', { icon: '★' });
        const section = element('section', { className: 'yl-favorite-list' });
        for (const candidate of currentView.favorites) {
            const card = element('article', { className: 'yl-favorite-card' });
            card.appendChild(candidateAvatar(candidate, { imageEnabled: true }));
            const copy = element('div', { className: 'yl-candidate-copy' });
            copy.appendChild(element('strong', { text: candidate.昵称 || '未命名对象' }));
            const tags = displayTags(candidate); if (tags.length) copy.appendChild(element('span', { text: tags.join(' · ') }));
            card.appendChild(copy);
            const actions = element('div', { className: 'yl-favorite-actions' });
            const removing = actionBridge.isPending('unfavorite', candidate.uid);
            const cancel = element('button', { className: 'yl-settings-button yl-favorite-cancel', type: 'button', ariaLabel: '取消收藏', disabled: removing, text: removing ? '处理中…' : '取消收藏' });
            listen(cancel, cancel, 'click', () => { void runCandidateAction('unfavorite', candidate.uid); }, abortController.signal);
            const starting = actionBridge.isPending('start_private_chat', candidate.uid);
            const start = element('button', { className: 'yl-settings-button yl-favorite-chat', type: 'button', ariaLabel: '发起私聊', disabled: starting || typeof actionBridge.runMvuAction !== 'function', text: starting ? '正在发起…' : '发起私聊' });
            listen(start, start, 'click', () => { void startFavoritePrivateChat(candidate); }, abortController.signal);
            append(actions, [cancel, start]); card.appendChild(actions); section.appendChild(card);
        }
        return section;
    }
    function buildSettingsHome() {
        const section = element('section', { className: 'yl-settings-home' });
        const entries = [
            ['settings_connections', '连接预设', '按名称选择和维护连接。'],
            ['settings_prompts', '提示词预设', '只维护提示词条目与导入导出。'],
            ['settings_privacy', '隐私权限设置', '管理个性化内容推荐与当前设备偏好。'],
            ['settings_images', '图片管理', '上传或导入角色展示图，并编辑匹配关键词与权重。'],
            ['settings_console', '控制台', '查看本次会话中的安全运行进度，不显示技术密钥或原始数据。'],
            ['about', '关于软件', '点击查看版本；连续点击五次可显示内容模式开关。'],
        ];
        for (const [page, title, note] of entries) {
            const row = element('div', { className: 'yl-settings-home-row' });
            const button = element('button', { className: 'yl-center-entry', type: 'button', ariaLabel: title });
            append(button, [element('strong', { text: title }), element('span', { text: note }), element('span', { text: '›' })]);
            listen(button, button, 'click', () => setActivePage(page), abortController.signal);
            row.appendChild(button);
            if (page === 'about' && aboutUnlocked) row.appendChild(buildContentModeSlider());
            section.appendChild(row);
        }
        return section;
    }
    function buildOperationConsole() {
        const section = element('section', { className: 'yl-operation-console' });
        const toolbar = element('div', { className: 'yl-operation-console-toolbar' });
        toolbar.appendChild(element('p', { text: '只保留本次小手机会话的公开状态，不持久化，也不显示密钥、内部标识、补丁或原始模型内容。' }));
        const clear = element('button', { className: 'yl-settings-button', type: 'button', text: '清空显示记录', ariaLabel: '清空控制台显示记录' });
        listen(clear, clear, 'click', () => { operationActivity.clear(); renderPage(); }, abortController.signal);
        toolbar.appendChild(clear);
        section.appendChild(toolbar);
        const snapshot = operationActivity.snapshot();
        if (!snapshot.entries.length) {
            section.appendChild(buildEmptyPlaceholder('暂无运行记录。开始灵魂匹配、语音匹配或收藏主动私聊后，会在这里显示进度。', { icon: '◌' }));
            return section;
        }
        const list = element('div', { className: 'yl-operation-console-list' });
        const labels = { running: '进行中', success: '已完成', failure: '未完成' };
        for (const entry of snapshot.entries) {
            const card = element('article', { className: 'yl-operation-console-entry' });
            card.dataset.status = entry.status;
            const heading = element('div', { className: 'yl-operation-console-heading' });
            append(heading, [
                element('strong', { text: entry.name }),
                element('span', { className: 'yl-operation-console-status', text: labels[entry.status] || '状态更新' }),
            ]);
            const time = typeof entry.updatedAt === 'string' ? entry.updatedAt.slice(11, 19) : '';
            append(card, [heading, element('p', { text: entry.message }), element('span', { className: 'yl-operation-console-time', text: time })]);
            list.appendChild(card);
        }
        section.appendChild(list);
        return section;
    }
    function buildContentModeSlider() {
        const row = element('div', { className: 'yl-mode-easter-egg' });
        row.appendChild(element('span', { text: 'SFW' }));
        const wrap = element('label', { className: 'yl-switch yl-mode-switch' });
        const toggle = element('input', { type: 'checkbox', checked: currentView.mode === 'NSFW', ariaLabel: '内容模式切换' });
        listen(toggle, toggle, 'change', () => { if (Boolean(toggle.checked) !== (currentView.mode === 'NSFW')) void toggleContentModeFromSlider(); }, abortController.signal);
        wrap.appendChild(toggle);
        row.appendChild(wrap); row.appendChild(element('span', { text: 'NSFW' }));
        return row;
    }
    function buildSettingsDetail() {
        if (activePage === 'settings_images') {
            const section = element('section', { className: 'yl-settings-detail yl-image-manager-page' });
            imageManagerPanel = createImageManagerPanel({
                documentRef,
                imageLibrary,
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
                : activePage === 'settings_personalization_preference' ? 'preference' : 'personalization';
        const section = element('section', { className: 'yl-settings-detail' });
        section.appendChild(buildSettingsPanel({
            settingsStore, llmClient, signal: abortController.signal, view,
            contentMode: currentView.mode,
            onFeedback: createOperationFeedbackHandler(), onRerender: renderPage, onNavigate: setActivePage,
        }));
        return section;
    }
    function buildPrivacySettings() {
        const section = element('section', { className: 'yl-settings-home' });
        const button = element('button', { className: 'yl-center-entry', type: 'button', ariaLabel: '个性化内容推荐管理' });
        append(button, [element('strong', { text: '个性化内容推荐管理' }), element('span', { text: '开启或关闭个性化推荐，并编辑当前设备的关键词权重。' }), element('span', { text: '›' })]);
        listen(button, button, 'click', () => setActivePage('settings_personalization'), abortController.signal);
        section.appendChild(button);
        return section;
    }

    async function toggleContentModeFromSlider() {
        const operationToken = setFeedback('正在切换内容模式…'); renderPage();
        const result = await actionBridge.runMvuAction('toggle_content_mode');
        if (!result?.ok) { setFeedback(describeActionFailure(result), operationToken); refreshState(); return; }
        aboutClickStreak = 0;
        aboutUnlocked = true;
        setFeedback(`已切换为 ${currentView.mode === 'SFW' ? 'NSFW' : 'SFW'}。`, operationToken);
        refreshState();
        if (!bindingDialog.hidden && featureBindingDialogState) {
            openFeatureBinding(featureBindingDialogState.features, featureBindingDialogState.dialogTitle);
        }
    }

    async function runInitialRecommendationCandidate() {
        if (typeof actionBridge.runRecommendationInitialCandidate !== 'function') { setFeedback('随机创建尚未就绪。'); renderPage(); return; }
        refreshing = true;
        const operationToken = showAiLoading('正在生成首位候选人，请稍候…');
        setFeedback('正在生成下一位候选人…', operationToken); renderPage();
        let result;
        try { result = await actionBridge.runRecommendationInitialCandidate(); }
        catch { result = { ok: false }; }
        refreshing = false;
        const message = result?.ok ? '已通过成年人校验，首位候选人已加入队列。' : (result?.message || describeActionFailure(result));
        setFeedback(message, operationToken);
        showAiResult(Boolean(result?.ok), message || '候选人未生成，请稍后重试。', operationToken);
        refreshState();
    }
    async function runCandidateAction(kind, npcUid) {
        const isRefresh = kind === 'refresh';
        const advancesCandidate = kind === 'like' || kind === 'favorite' || kind === 'dislike';
        refreshing = isRefresh || advancesCandidate;
        const operationToken = isRefresh ? showAiLoading('正在生成下一位候选人，请稍候…') : setFeedback('正在保存操作…');
        setFeedback(isRefresh ? '正在生成下一位候选人…' : '正在保存操作…', operationToken); renderPage();
        let result;
        try {
            if (isRefresh) result = typeof actionBridge.runRecommendationRefresh === 'function' ? await actionBridge.runRecommendationRefresh(npcUid) : { ok: false, message: '刷新候选人生成功能尚未就绪。' };
            else result = await actionBridge.runMvuAction(kind, npcUid);
        } catch { result = { ok: false }; }
        if (!result?.ok) {
            refreshing = false;
            const message = result?.message || describeActionFailure(result);
            setFeedback(message, operationToken);
            if (isRefresh) showAiResult(false, message || '候选人未生成，请稍后重试。', operationToken);
            refreshState();
            return;
        }
        if (!advancesCandidate) {
            refreshing = false;
            const message = isRefresh ? '下一位候选人已生成。' : '已取消收藏。';
            setFeedback(message, operationToken);
            if (isRefresh) showAiResult(true, message, operationToken);
            refreshState();
            return;
        }
        const savedLabel = kind === 'like' ? '喜欢反馈已保存' : kind === 'favorite' ? '已加入收藏夹' : '不喜欢反馈已保存';
        if (typeof actionBridge.runRecommendationInitialCandidate !== 'function') {
            refreshing = false;
            setFeedback(`${savedLabel}，但下一位候选人生成功能尚未就绪。`, operationToken);
            refreshState();
            return;
        }
        let nextResult;
        try { nextResult = await actionBridge.runRecommendationInitialCandidate(); } catch { nextResult = { ok: false }; }
        refreshing = false;
        if (!nextResult?.ok) {
            const reason = nextResult?.message || describeActionFailure(nextResult) || '未知错误';
            setFeedback(`${savedLabel}，但下一位候选人生成失败：${reason}`, operationToken);
        } else setFeedback(`${savedLabel}，下一位候选人已生成。`, operationToken);
        refreshState();
    }
    async function startFavoritePrivateChat(candidate) {
        if (!candidate?.uid || typeof actionBridge.runMvuAction !== 'function') return;
        const requestId = ++interactionGeneration;
        const pageAtStart = activePage;
        const activityHandle = operationActivity.start('收藏主动私聊', '正在等待对方回应……');
        const operationToken = showRomanceLoading('发起心动私聊', '正在等待对方回应……');
        renderPage();
        let result;
        try { result = await actionBridge.runMvuAction('start_private_chat', candidate.uid); }
        catch { result = { ok: false }; }
        if (isDestroyed || requestId !== interactionGeneration) return;
        if (!result?.ok) {
            const message = result?.message || describeActionFailure(result) || '私聊邀请未完成，请稍后再试。';
            operationActivity.fail(activityHandle, '私聊邀请未完成，请稍后再试。');
            showRomanceResult({ title: '邀请未送达', message }, operationToken);
            refreshState();
            return;
        }
        refreshState();
        if (result.invitationOutcome === 'declined') {
            if (activePage === pageAtStart) setActivePage('favorites');
            operationActivity.fail(activityHandle, '对方暂未接受私聊邀请。');
            showRomanceResult({ declined: true, title: '这次暂未靠近', message: 'TA 暂时没有接受这次私聊邀请。' });
            return;
        }
        const sessionUid = result.sessionUid || (currentView.messageSessions ?? []).find((session) => session.npcUid === candidate.uid)?.sessionUid;
        if (activePage === pageAtStart) {
            if (sessionUid) openPrivateChat(sessionUid);
            else setActivePage('messages');
        }
        operationActivity.succeed(activityHandle, '私聊邀请已接受，已打开消息。');
        showRomanceResult({ accepted: true, title: '心意被接住了', message: '私聊已建立，去打个招呼吧。' });
    }


    listen(launcher, launcher, 'click', () => setOpen(!open), abortController.signal);
    listen(closeButton, closeButton, "click", () => setOpen(false), abortController.signal);
    listen(header, header, 'pointerdown', beginPanelDrag, abortController.signal);
    listen(header, header, 'pointermove', movePanelDrag, abortController.signal);
    listen(header, header, 'pointerup', endPanelDrag, abortController.signal);
    listen(header, header, 'pointercancel', endPanelDrag, abortController.signal);
    listen(root, documentRef, 'pointermove', movePanelDrag, abortController.signal);
    listen(root, documentRef, 'pointerup', endPanelDrag, abortController.signal);
    listen(root, documentRef, 'pointercancel', endPanelDrag, abortController.signal);
    listen(operationDismiss, operationDismiss, 'click', hideOperationDialog, abortController.signal);
    listen(operationClose, operationClose, 'click', hideOperationDialog, abortController.signal);
    listen(bindingDialogClose, bindingDialogClose, 'click', closeFeatureBindingDialog, abortController.signal);
    listen(avatarDialogClose, avatarDialogClose, 'click', closeAvatarDialog, abortController.signal);
    listen(avatarFileButton, avatarFileButton, 'click', () => { avatarFileInput.click?.(); }, abortController.signal);
    listen(avatarFileInput, avatarFileInput, 'change', () => { void saveLocalAvatarFile(avatarFileInput.files?.[0]); }, abortController.signal);
    listen(avatarLinkButton, avatarLinkButton, 'click', saveLinkedAvatar, abortController.signal);
    listen(avatarRemoveButton, avatarRemoveButton, 'click', removePlayerAvatar, abortController.signal);
    listen(root, documentRef, "click", (event) => {
        if (activeHelpAnchor && event.target !== activeHelpAnchor) { helpPopover.hidden = true; activeHelpAnchor = null; }
        if (chatMoreMenuSessionUid && !event.target?.closest?.('.yl-private-chat-actions')) closeChatMoreMenu();
    }, abortController.signal);
    listen(root, documentRef, "keydown", (event) => {
        if (event.key !== "Escape") return;
        if (!operationDialog.hidden) hideOperationDialog();
        else if (!bindingDialog.hidden) closeFeatureBindingDialog();
        else if (!avatarDialog.hidden) closeAvatarDialog();
        else if (imageManagerPanel?.handleEscape?.()) { /* image manager handled it */ }
        else if (chatMoreMenuSessionUid) closeChatMoreMenu();
        else if (!helpPopover.hidden) { helpPopover.hidden = true; activeHelpAnchor = null; }
        else if (open) setOpen(false);
    }, abortController.signal);
    unsubscribeOperationActivity = operationActivity.subscribe(() => {
        if (open && activePage === 'settings_console') renderPage();
    });
    renderPage();
    return Object.freeze({
        refreshState,
        destroy() { isDestroyed = true; interactionGeneration += 1; hideOperationDialog(); unsubscribeOperationActivity?.(); imageManagerPanel?.dispose?.(); clearMatchedImageState(); launcherDrag.dispose(); abortController.abort(); root.remove(); },
    });
}

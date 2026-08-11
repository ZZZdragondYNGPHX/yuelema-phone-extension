// 页面间共享的辅助函数与常量：从 src/app-shell.js 纯搬移而来，函数体逐行未改，仅将跨模块引用改为 ctx.*。壳层不直接使用这些构建函数。
import { element, listen } from '../dom.js';
import { createAvatarView, safeAvatarImageSource } from '../ui/avatar-view.js';
import { createUiIcon } from '../ui/icon.js';
import { createListRow } from '../ui/list-row.js';

export const SERVICE_UNLOCK_STORAGE_KEY = 'yuelema.service-hub-unlocked/v1';

/**
 * P3-G 等待期趣味反馈：等待文案轮播（纯 CSS 循环，零 JS 计时器）。
 * 结构 = .yl-wait-feedback > .yl-wait-captions > span×N（CSS 按 nth-child 错峰轮播）
 * 可选 shiftText 生成 .yl-wait-shift（CSS animation-delay 8s 后淡入的“还在努力”换挡文案）。
 * 整块 aria-hidden：等待状态本身由各页面既有 role="status" 节点向读屏播报。
 */
export function buildWaitCaptions(documentRef, captions, { shiftText = '' } = {}) {
    const doc = documentRef ?? globalThis.document;
    const wrap = doc.createElement('div');
    wrap.className = 'yl-wait-feedback';
    wrap.setAttribute('aria-hidden', 'true');
    const cycle = doc.createElement('div');
    cycle.className = 'yl-wait-captions';
    for (const caption of (Array.isArray(captions) ? captions : []).slice(0, 4)) {
        const span = doc.createElement('span');
        span.textContent = String(caption ?? '');
        cycle.appendChild(span);
    }
    wrap.appendChild(cycle);
    if (shiftText) {
        const shift = doc.createElement('span');
        shift.className = 'yl-wait-shift';
        shift.textContent = String(shiftText);
        wrap.appendChild(shift);
    }
    return wrap;
}

export function createSharedHelpers(ctx) {
    function displayTags(candidate) { return [...(candidate.兴趣标签 ?? []), ...(candidate.生活方式标签 ?? []), ...(candidate.性格标签 ?? []), ...(candidate.沟通风格标签 ?? [])]; }
    function publicAvatar(profile, {
        uid = '',
        className = 'yl-candidate-avatar',
        imageEnabled = true,
        interactive = false,
        fallback = '人',
        imageSource = null,
        onImageLoad = null,
        onImageFailure = null,
    } = {}) {
        const nickname = profile?.昵称 || '未命名对象';
        const matched = imageSource === null && imageEnabled ? ctx.matchedImageFor(profile) : null;
        const profileSource = imageSource === null ? safeAvatarImageSource(profile?.头像引用) : safeAvatarImageSource(imageSource);
        let localCharacterSource = '';
        if (imageSource === null && uid) {
            try { localCharacterSource = safeAvatarImageSource(ctx.characterAvatarStore?.snapshot?.(uid)); }
            catch { localCharacterSource = ''; }
        }
        const avatar = createAvatarView({
            documentRef: ctx.documentRef,
            nickname,
            imageSource: localCharacterSource || matched || profileSource,
            className,
            imageClassName: className + '-image',
            alt: nickname + '的头像',
            fallback,
            onImageLoad,
            onImageFailure,
        });
        if (imageSource === null && imageEnabled && !localCharacterSource && !matched && !profileSource && ctx.imageMatchPending.has(ctx.imageProfileKey(profile))) {
            avatar.dataset.imageStatus = 'loading';
        }
        if (!interactive || !uid) {
            avatar.setAttribute('aria-hidden', 'true');
            return avatar;
        }
        const openProfile = () => { ctx.selectedCandidateUid = uid; ctx.setActivePage('candidate_detail'); };
        avatar.setAttribute('role', 'button');
        avatar.setAttribute('tabindex', '0');
        avatar.setAttribute('aria-label', '查看' + nickname + '的公开资料');
        listen(avatar, avatar, 'click', openProfile, ctx.abortController.signal);
        listen(avatar, avatar, 'keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault?.(); openProfile(); }
        }, ctx.abortController.signal);
        return avatar;
    }
    function candidateAvatar(candidate, { imageEnabled = true, interactive = true, className = 'yl-candidate-avatar', onImageLoad = null, onImageFailure = null } = {}) {
        return publicAvatar(candidate, { uid: candidate?.uid, className, imageEnabled, interactive, onImageLoad, onImageFailure });
    }
    /** P3-D（E1 遗留）：hub 入口迁移 ListRow 组件——div[role="button"] + tabindex=0 + Enter/Space 自管激活。 */
    function buildHubEntry({ page, iconName, title, note, meta = '', className = '', tone = 'neutral' }) {
        const icon = element('span', { className: 'yl-hub-entry-icon' });
        icon.setAttribute('aria-hidden', 'true');
        icon.appendChild(createUiIcon(ctx.documentRef, iconName, { className: 'yl-hub-entry-svg', size: 20 }));
        const row = createListRow({
            documentRef: ctx.documentRef,
            avatar: icon,
            title,
            subtitle: note,
            meta: {
                chevron: true,
                chips: meta ? [element('span', { className: 'yl-hub-entry-meta', text: meta })] : [],
            },
            onClick: () => ctx.setActivePage(page),
        });
        row.className = ['yl-row', 'yl-hub-entry', className].filter(Boolean).join(' ');
        row.dataset.page = page;
        row.dataset.tone = tone;
        row.setAttribute('aria-label', title);
        return row;
    }
    function buildHubSection({ title, note = '', entries, className = '' }) {
        const section = element('section', { className: ['yl-hub-section', className].filter(Boolean).join(' ') });
        const heading = element('header', { className: 'yl-hub-section-heading' });
        heading.appendChild(element('h2', { text: title }));
        if (note) heading.appendChild(element('p', { text: note }));
        section.appendChild(heading);
        const list = element('div', { className: 'yl-hub-section-list' });
        for (const entry of entries) list.appendChild(buildHubEntry(entry));
        section.appendChild(list);
        return section;
    }
    function messageSessions() {
        return Array.isArray(ctx.currentView.messageSessions) ? ctx.currentView.messageSessions : [];
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
    function openPrivateChat(sessionUid, { preserveOperation = false } = {}) {
        const session = messageSessionByUid(sessionUid);
        if (!session) {
            ctx.activeMessageSessionUid = '';
            ctx.setActivePage('messages', { preserveOperation });
            return;
        }
        if (ctx.activeMessageSessionUid !== session.sessionUid) {
            if (ctx.activePage === 'private_chat') ctx.privateChatRequestGeneration += 1;
            ctx.activeChatToolsSessionUid = '';
            ctx.activeMeetupSessionUid = '';
            ctx.activeNsfwConsentSessionUid = '';
            ctx.activeNsfwRelationshipSessionUid = '';
            ctx.nsfwTurnConsentSessions?.clear?.();
        }
        ctx.activeMessageSessionUid = session.sessionUid;
        ctx.requestPrivateChatScrollToBottom?.(session.sessionUid);
        ctx.setActivePage('private_chat', { preserveOperation });
    }
    function chatSummarySettings() {
        const fallback = { enabled: false, interval: 20, retryLimit: 2 };
        try {
            const saved = ctx.settingsStore?.getChatSummarySettings?.() ?? ctx.settingsStore?.snapshot?.().chatSummary;
            if (!saved || typeof saved !== 'object') return fallback;
            return {
                enabled: saved.enabled === true,
                interval: Number.isInteger(saved.interval) ? saved.interval : fallback.interval,
                retryLimit: Number.isInteger(saved.retryLimit) ? saved.retryLimit : fallback.retryLimit,
            };
        } catch {
            return fallback;
        }
    }
    function chatSummaryEnabled() {
        return chatSummarySettings().enabled;
    }
    return {
        displayTags,
        publicAvatar,
        candidateAvatar,
        buildHubEntry,
        buildHubSection,
        messageSessions,
        messageSessionByUid,
        chatNickname,
        chatAvatar,
        openPrivateChat,
        chatSummarySettings,
        chatSummaryEnabled,
    };
}

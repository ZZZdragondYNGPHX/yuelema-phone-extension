// 页面间共享的辅助函数与常量：从 src/app-shell.js 纯搬移而来，函数体逐行未改，仅将跨模块引用改为 ctx.*。壳层不直接使用这些构建函数。
import { append, element, listen } from '../dom.js';
import { createAvatarView, safeAvatarImageSource } from '../ui/avatar-view.js';
import { createUiIcon } from '../ui/icon.js';

export const SERVICE_UNLOCK_STORAGE_KEY = 'yuelema.service-hub-unlocked/v1';

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
        const avatar = createAvatarView({
            documentRef: ctx.documentRef,
            nickname,
            imageSource: matched || profileSource,
            className,
            imageClassName: className + '-image',
            alt: nickname + '的头像',
            fallback,
            onImageLoad,
            onImageFailure,
        });
        if (imageSource === null && imageEnabled && !matched && !profileSource && ctx.imageMatchPending.has(ctx.imageProfileKey(profile))) {
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
    function buildHubEntry({ page, iconName, title, note, meta = '', className = '', tone = 'neutral' }) {
        const button = element('button', { className: ['yl-center-entry', 'yl-hub-entry', className].filter(Boolean).join(' '), type: 'button', ariaLabel: title });
        button.dataset.page = page;
        button.dataset.tone = tone;
        const icon = element('span', { className: 'yl-hub-entry-icon' });
        icon.appendChild(createUiIcon(ctx.documentRef, iconName, { className: 'yl-hub-entry-svg', size: 20 }));
        const copy = element('span', { className: 'yl-hub-entry-copy' });
        append(copy, [element('strong', { text: title }), element('span', { text: note })]);
        const trail = element('span', { className: 'yl-hub-entry-trail' });
        if (meta) trail.appendChild(element('span', { className: 'yl-hub-entry-meta', text: meta }));
        trail.appendChild(createUiIcon(ctx.documentRef, 'chevron_right', { className: 'yl-hub-entry-chevron', size: 18 }));
        append(button, [icon, copy, trail]);
        listen(button, button, 'click', () => ctx.setActivePage(page), ctx.abortController.signal);
        return button;
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
        }
        ctx.activeMessageSessionUid = session.sessionUid;
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

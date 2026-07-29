// 我的页 + 收藏夹 + 设置/总结/关于等二级页。
// P2-E1（策划书 §10.1/§10.2/§10.4 + 裁决 D7）：我的页改为 身份 Hero + 数据行 + 分组直达列表，
// “我的→设置目录→详情”的中间目录页已随主线收口彻底删除（settings 路由不复存在，
// 设置二级页返回全部直落「我的」）。头像管理、五连点彩蛋、SFW/NSFW 滑块、
// 专属服务开关等安全逻辑全部原样保留。
import { append, element, listen } from '../dom.js';
import { avatarImageSource } from '../player-avatar-store.js';
import { buildErrorDetail } from '../ui/operation-activity.js';
import { describeActionFailure } from '../ui-model.js';
import { createUiIcon } from '../ui/icon.js';
import { createButton } from '../ui/button.js';
import { createEmptyState } from '../ui/empty-state.js';
import { SERVICE_UNLOCK_STORAGE_KEY } from './shared.js';

const RECENT_RELEASE_NOTES = Object.freeze([
    'v1.0.11：三种生图接口共用浏览器端/酒馆后端选择；NAI 采样器与噪点表改为固定下拉，NAI 整体预设保存非机密连接、采样、尺寸和提示词。',
    'v1.0.8：正文经历按对象独立回流私聊；当前对象与其他对象记忆分区防串台；清除旧长期摘要平行字段。',
    'v1.0.7：图片管理新增醒目的生图入口与直接入库；三种生图接口各自管理提示词预设；修复私聊发送/回复回顶，并减少 AI 角色姓名集中于单一姓氏。',
    'v1.0.6：会话生图可在刷新后恢复并集中回顾、删除；角色头像可在公开资料页本地更换并随首页、匹配恢复；私聊回复不再因延迟布局回到顶部。',
]);

export function createProfilePage(ctx) {
    function showVersionInformation() {
        ctx.aboutClickStreak += 1;
        if (!ctx.serviceEntryUnlocked) ctx.releaseNotesClickStreak = 0;
        if (ctx.aboutClickStreak >= 5) ctx.aboutUnlocked = true;
        ctx.beginOperationDialog({ state: 'info', title: '版本信息', message: '当前版本：' + ctx.UI_VERSION, autoCloseMs: 3200 });
        ctx.renderPage();
    }
    function showRecentReleaseNotes() {
        ctx.releaseNotesClickStreak += 1;
        if (!ctx.aboutUnlocked) ctx.aboutClickStreak = 0;
        if (ctx.releaseNotesClickStreak >= 5) ctx.serviceEntryUnlocked = true;
        ctx.beginOperationDialog({ state: 'info', title: '最近三次更新', message: RECENT_RELEASE_NOTES.join('｜'), autoCloseMs: 5200 });
        ctx.renderPage();
    }
    function playerAvatarButton(nickname) {
        let avatar = null;
        try { avatar = ctx.playerAvatarStore?.snapshot?.() ?? null; } catch { avatar = null; }
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
        listen(button, button, 'click', ctx.openAvatarDialog, ctx.abortController.signal);
        return button;
    }
    function localCharacterTemplateCount() {
        try {
            const templates = typeof ctx.characterLibrary?.list === 'function' ? ctx.characterLibrary.list() : [];
            return Array.isArray(templates) ? templates.length : 0;
        } catch { return 0; }
    }
    function profileStatButton(value, label, page) {
        const stat = element('button', { className: 'yl-profile-stat', type: 'button', ariaLabel: `${label}：${value}` });
        stat.dataset.statTarget = page;
        append(stat, [element('strong', { text: String(value) }), element('span', { text: label })]);
        listen(stat, stat, 'click', () => ctx.setActivePage(page), ctx.abortController.signal);
        return stat;
    }
    function buildProfileHub() {
        const section = element('section', { className: 'yl-person-center yl-profile-dashboard' });
        const nickname = ctx.currentView.playerProfile.昵称 || '未填写个人资料';
        const city = ctx.currentView.playerProfile.城市 || '建立公开资料后开启更准确的匹配。';
        // 1. 身份 Hero：72px 头像（点击 = 头像管理弹窗）+ 昵称 + 城市 + 编辑公开资料 tonal 钮。
        // 保留 yl-profile-identity-card 类以维持 desktop 分区行合同（样式合同见 style.css desktop 区）。
        const hero = element('article', { className: 'yl-profile-hero yl-profile-identity-card' });
        const heroAvatar = element('div', { className: 'yl-person-hero' });
        heroAvatar.appendChild(playerAvatarButton(nickname));
        hero.appendChild(heroAvatar);
        const copy = element('div', { className: 'yl-profile-hero-copy' });
        append(copy, [
            element('strong', { text: nickname }),
            element('span', { text: city }),
        ]);
        hero.appendChild(copy);
        const edit = createButton({
            documentRef: ctx.documentRef, variant: 'tonal', label: '编辑公开资料',
            icon: 'edit_profile', onClick: () => ctx.setActivePage('profile_editor'),
        });
        edit.classList.toggle('yl-profile-hero-edit', true);
        hero.appendChild(edit);
        section.appendChild(hero);
        // 2. 数据行：三个可点击 stat，分别直达 消息 / 收藏夹 / 模板库。
        const stats = element('div', { className: 'yl-profile-stats yl-profile-metrics', ariaLabel: '我的数据' });
        append(stats, [
            profileStatButton(ctx.currentView.messageSessions.length, '私聊', 'messages'),
            profileStatButton(ctx.currentView.favorites.length, '收藏', 'favorites'),
            profileStatButton(localCharacterTemplateCount(), '角色模板', 'character_creator'),
        ]);
        section.appendChild(stats);
        // 3. 分组直达列表（两级到顶；关于软件只保留诊断分组这一个入口）。
        const groups = element('div', { className: 'yl-profile-groups yl-profile-dashboard-grid' });
        const relationshipEntries = [
            { page: 'favorites', iconName: 'favorite', title: '收藏夹', note: '查看保存的候选人，随时主动发起私聊。', meta: ctx.currentView.favorites.length + ' 人', tone: 'rose' },
            { page: 'matches', iconName: 'matches', title: '已牵手对象', note: '查看互相匹配的对象，随时进入私聊。', meta: ctx.currentView.matches.length + ' 人', tone: 'rose' },
        ];
        if (ctx.serviceHubUnlocked) {
            relationshipEntries.push({ page: 'service_hub', iconName: 'service_hub', title: '约伴专属服务', note: '进入已开启的会员专属约伴服务馆。', meta: '专属', tone: 'gold' });
        }
        groups.appendChild(ctx.buildHubSection({
            title: '关系资产', className: 'yl-profile-group yl-profile-section-relationships', entries: relationshipEntries,
        }));
        groups.appendChild(ctx.buildHubSection({
            title: '创作', className: 'yl-profile-group yl-profile-section-tools',
            entries: [
                { page: 'character_creator', iconName: 'create_character', title: '创建角色', note: '创建、导入并管理明确为成年人的角色模板。', meta: localCharacterTemplateCount() + ' 个', tone: 'violet' },
                { page: 'settings_images', iconName: 'image', title: '图片素材', note: '管理本地角色展示图与匹配关键词。', meta: '本地', tone: 'violet' },
            ],
        }));
        groups.appendChild(ctx.buildHubSection({
            title: '设置', className: 'yl-profile-group yl-profile-section-preferences',
            entries: [
                { page: 'settings_connections', iconName: 'connection', title: '连接预设', note: '按名称选择和维护非机密连接信息。', meta: '连接' },
                { page: 'settings_prompts', iconName: 'prompt', title: '提示词预设', note: '维护提示词条目树以及导入和导出。', meta: '文本' },
                { page: 'settings_image_generation', iconName: 'sparkle', title: '生图', note: '配置会话生图接口与固定提示词。', meta: '生成' },
                { page: 'settings_privacy', iconName: 'privacy', title: '隐私与总结', note: '个性化推荐与对话总结都在这里管理。', meta: '受控' },
                { page: 'settings_preferences', iconName: 'phone', title: '偏好', note: '切换手机端或电脑端界面布局，仅保存在当前浏览器。', meta: '本地' },
            ],
        }));
        groups.appendChild(ctx.buildHubSection({
            title: '诊断', className: 'yl-profile-group yl-profile-section-diagnostics',
            entries: [
                { page: 'settings_console', iconName: 'console', title: '运行记录', note: '查看安全运行进度，不显示密钥或原始数据。', meta: '会话级' },
                { page: 'about', iconName: 'info', title: '关于软件', note: '查看版本与更新日志。', meta: ctx.UI_VERSION },
            ],
        }));
        section.appendChild(groups);
        return section;
    }
    function seedPlayerDraft() {
        if (ctx.playerProfileDraft) return ctx.playerProfileDraft;
        const source = ctx.currentView.playerProfile;
        ctx.playerProfileDraft = { ...source, 兴趣标签: [...source.兴趣标签], 生活方式标签: [...source.生活方式标签], 性格标签: [...source.性格标签], 沟通风格标签: [...source.沟通风格标签] };
        return ctx.playerProfileDraft;
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
            listen(input, input, 'input', () => { draft[key] = type === 'tags' ? input.value.split(/[，,]/u).map((tag) => tag.trim()).filter(Boolean).slice(0, 12) : input.value.trim(); }, ctx.abortController.signal);
            block.appendChild(input); section.appendChild(block);
        }
        const canSave = typeof ctx.actionBridge.runSavePlayerPublicProfile === 'function';
        const save = element('button', { className: 'yl-settings-button', type: 'button', text: canSave ? '保存公开资料' : '保存本次草稿' });
        listen(save, save, 'click', () => { void savePlayerProfile(); }, ctx.abortController.signal);
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
        if (typeof ctx.actionBridge.runSavePlayerPublicProfile !== 'function') {
            ctx.setFeedback('个人资料草稿已保留在当前界面；当前宿主尚未提供受控 MVU 写入接口。');
            ctx.renderPage();
            return;
        }
        const operationToken = ctx.setFeedback('正在保存公开资料…');
        ctx.renderPage();
        const result = await ctx.actionBridge.runSavePlayerPublicProfile(playerProfilePayload());
        if (result?.ok) {
            ctx.playerProfileDraft = null;
            ctx.setFeedback('公开资料已保存，可参与后续评分与匹配。', operationToken);
            ctx.refreshState();
        } else {
            ctx.setFeedback(result?.message || describeActionFailure(result), operationToken);
            ctx.renderPage();
        }
    }
    function buildFavoritesPage() {
        if (!ctx.currentView.favorites.length) {
            return createEmptyState({
                documentRef: ctx.documentRef, variant: 'heart',
                title: '收藏夹还是空的', hint: '在发现页收藏心动的人，这里就会亮起来。',
            });
        }
        const section = element('section', { className: 'yl-favorite-list' });
        for (const candidate of ctx.currentView.favorites) {
            const card = element('article', { className: 'yl-favorite-card' });
            card.appendChild(ctx.candidateAvatar(candidate, { imageEnabled: true }));
            const copy = element('div', { className: 'yl-candidate-copy' });
            copy.appendChild(element('strong', { text: candidate.昵称 || '未命名对象' }));
            const tags = ctx.displayTags(candidate); if (tags.length) copy.appendChild(element('span', { text: tags.join(' · ') }));
            card.appendChild(copy);
            const actions = element('div', { className: 'yl-favorite-actions' });
            const removing = ctx.actionBridge.isPending('unfavorite', candidate.uid);
            const cancel = element('button', { className: 'yl-settings-button yl-favorite-cancel', type: 'button', ariaLabel: '取消收藏', disabled: removing, text: removing ? '处理中…' : '取消收藏' });
            listen(cancel, cancel, 'click', () => { void ctx.runCandidateAction('unfavorite', candidate.uid); }, ctx.abortController.signal);
            const starting = ctx.actionBridge.isPending('start_private_chat', candidate.uid);
            const start = element('button', { className: 'yl-settings-button yl-favorite-chat', type: 'button', ariaLabel: '发起私聊', disabled: starting || typeof ctx.actionBridge.runMvuAction !== 'function', text: starting ? '正在发起…' : '发起私聊' });
            listen(start, start, 'click', () => { void startFavoritePrivateChat(candidate); }, ctx.abortController.signal);
            append(actions, [cancel, start]); card.appendChild(actions); section.appendChild(card);
        }
        return section;
    }
    function summarySettingEntry(title, note, page, disabled = false) {
        const button = element('button', { className: 'yl-center-entry', type: 'button', ariaLabel: title, disabled });
        append(button, [element('strong', { text: title }), element('span', { text: note }), ctx.openMark()]);
        if (!disabled) listen(button, button, 'click', () => ctx.setActivePage(page), ctx.abortController.signal);
        return button;
    }
    function buildChatSummarySettingsHome() {
        const section = element('section', { className: 'yl-settings-home yl-chat-summary-settings-home' });
        const settings = ctx.chatSummarySettings();
        const status = element('section', { className: 'yl-chat-summary-status-card' });
        const statusCopy = element('div', { className: 'yl-chat-summary-status-copy' });
        append(statusCopy, [
            element('strong', { text: settings.enabled ? '自动总结已开启' : '自动总结已关闭' }),
            element('p', { text: settings.enabled
                ? `每 ${settings.interval} 楼自动整理一次，失败后最多重试 ${settings.retryLimit} 次；群聊与帖子总结只保存在浏览器本地。`
                : '关闭后私聊模型会收到当前保留的完整聊天记录（最多保留 240 条，更早内容不会进入模型）；群聊与帖子也不会自动整理。下方两个入口会保持不可操作。' }),
        ]);
        const switchLabel = element('label', { className: 'yl-switch yl-chat-summary-switch' });
        const toggle = element('input', { type: 'checkbox', checked: settings.enabled, ariaLabel: '自动对话总结开关' });
        switchLabel.appendChild(toggle);
        listen(toggle, toggle, 'change', () => {
            if (!ctx.settingsStore || typeof ctx.settingsStore.setChatSummarySettings !== 'function') {
                ctx.setFeedback('对话总结设置暂不可用。');
                toggle.checked = settings.enabled;
                return;
            }
            try {
                ctx.settingsStore.setChatSummarySettings({ ...settings, enabled: Boolean(toggle.checked) });
                ctx.setFeedback(toggle.checked ? '自动对话总结已开启。' : '自动对话总结已关闭。');
            } catch {
                ctx.setFeedback('对话总结开关未保存，请稍后重试。');
            }
            ctx.renderPage();
        }, ctx.abortController.signal);
        append(status, [statusCopy, switchLabel]);
        section.appendChild(status);
        section.appendChild(summarySettingEntry(
            '总结方案',
            settings.enabled ? '选择当前内容模式的连接与提示词预设，并设定私聊、聊天群和帖子共同使用的楼层间隔。' : '请先开启自动总结。',
            'settings_chat_summary_config',
            !settings.enabled,
        ));
        section.appendChild(summarySettingEntry(
            '总结档案',
            settings.enabled ? '查看私聊、每个聊天群和每篇论坛帖子的总结记录。' : '请先开启自动总结。',
            'settings_chat_summary_history',
            !settings.enabled,
        ));
        return section;
    }
    function appendPresetOptions(select, options, selectedValue) {
        for (const [value, label] of options) {
            const option = element('option', { value, text: label });
            option.selected = value === selectedValue;
            select.appendChild(option);
        }
    }
    function buildChatSummaryConfigPage() {
        if (!ctx.chatSummaryEnabled()) {
            return createEmptyState({ documentRef: ctx.documentRef, variant: 'inbox', title: '自动对话总结当前已关闭', hint: '请返回上一页开启后再配置。' });
        }
        if (!ctx.settingsStore || typeof ctx.settingsStore.snapshot !== 'function' || typeof ctx.settingsStore.setChatSummarySettings !== 'function') {
            return createEmptyState({ documentRef: ctx.documentRef, variant: 'inbox', title: '对话总结设置暂不可用' });
        }
        let snapshot;
        try { snapshot = ctx.settingsStore.snapshot(); } catch {
            return createEmptyState({ documentRef: ctx.documentRef, variant: 'inbox', title: '无法读取已保存的总结设置' });
        }
        const contentMode = ctx.currentView.mode === 'NSFW' ? 'NSFW' : 'SFW';
        const settings = ctx.chatSummarySettings();
        const binding = snapshot.functionModeBindings?.chat_summary?.[contentMode]
            ?? snapshot.functionBindings?.chat_summary
            ?? { connectionPresetId: null, promptPresetId: null };
        const section = element('section', { className: 'yl-settings-panel yl-chat-summary-config' });
        section.appendChild(element('p', { className: 'yl-phone-page-description', text: `以下设置只保存到当前浏览器；预设绑定仅影响当前 ${contentMode} 内容模式。` }));
        const fields = element('div', { className: 'yl-settings-fields' });
        const connection = element('select', { className: 'yl-settings-control', ariaLabel: '对话总结连接预设', name: 'chat-summary-connection' });
        appendPresetOptions(connection, [['', '使用默认连接'], ...(snapshot.connectionPresets ?? []).map((preset) => [preset.id, preset.name])], binding.connectionPresetId ?? '');
        const prompt = element('select', { className: 'yl-settings-control', ariaLabel: '对话总结提示词预设', name: 'chat-summary-prompt' });
        const promptOptions = (snapshot.promptPresets ?? []).filter((preset) => preset.contentMode === contentMode);
        appendPresetOptions(prompt, [['', '不附加提示词预设'], ...promptOptions.map((preset) => [preset.id, preset.name])], binding.promptPresetId ?? '');
        const interval = element('input', { className: 'yl-settings-control', type: 'number', min: 2, max: 60, value: String(settings.interval), inputMode: 'numeric', ariaLabel: '每几条消息层自动总结' });
        const retries = element('input', { className: 'yl-settings-control', type: 'number', min: 0, max: 5, value: String(settings.retryLimit), inputMode: 'numeric', ariaLabel: '总结失败重试次数' });
        const connectionField = element('label', { className: 'yl-settings-field' }); append(connectionField, [element('span', { text: '连接预设' }), connection]);
        const promptField = element('label', { className: 'yl-settings-field' }); append(promptField, [element('span', { text: '提示词预设' }), prompt]);
        const intervalField = element('label', { className: 'yl-settings-field' }); append(intervalField, [element('span', { text: '每 X 楼自动总结' }), interval, element('span', { className: 'yl-settings-summary', text: '私聊、聊天群和帖子评论都按一条发言计一楼；例如 88 楼可形成约 4 条 20 楼总结。群聊与帖子记录不会写入 MVU。' })]);
        const retryField = element('label', { className: 'yl-settings-field' }); append(retryField, [element('span', { text: '失败重试次数' }), retries, element('span', { className: 'yl-settings-summary', text: '失败后自动重试；最终失败会在聊天总结里保留原因和重新总结入口。' })]);
        append(fields, [connectionField, promptField, intervalField, retryField]);
        section.appendChild(fields);
        const actions = element('div', { className: 'yl-settings-actions' });
        const cancel = element('button', { className: 'yl-settings-button yl-settings-button-secondary', type: 'button', text: '取消' });
        const save = element('button', { className: 'yl-settings-button', type: 'button', text: '保存' });
        listen(cancel, cancel, 'click', () => ctx.setActivePage('settings_chat_summary'), ctx.abortController.signal);
        listen(save, save, 'click', () => {
            const nextInterval = Number(interval.value);
            const nextRetries = Number(retries.value);
            if (!Number.isInteger(nextInterval) || nextInterval < 2 || nextInterval > 60 || !Number.isInteger(nextRetries) || nextRetries < 0 || nextRetries > 5) {
                ctx.setFeedback('请把自动总结间隔设为 2–60，把重试次数设为 0–5。');
                return;
            }
            try {
                const nextBinding = { connectionPresetId: connection.value || null, promptPresetId: prompt.value || null };
                if (typeof ctx.settingsStore.bindFunctionForContentMode === 'function') ctx.settingsStore.bindFunctionForContentMode('chat_summary', contentMode, nextBinding);
                else ctx.settingsStore.bindFunction('chat_summary', nextBinding);
                ctx.settingsStore.setChatSummarySettings({ enabled: true, interval: nextInterval, retryLimit: nextRetries });
                ctx.setFeedback('对话总结方案已保存。');
                ctx.setActivePage('settings_chat_summary');
            } catch {
                ctx.setFeedback('总结方案未保存，请确认预设仍存在且内容模式匹配。');
            }
        }, ctx.abortController.signal);
        append(actions, [cancel, save]);
        section.appendChild(actions);
        return section;
    }
    function buildChatSummaryHistoryPage() {
        if (!ctx.chatSummaryEnabled()) {
            return createEmptyState({ documentRef: ctx.documentRef, variant: 'inbox', title: '自动对话总结当前已关闭', hint: '请返回上一页开启后再查看总结档案。' });
        }
        const sessions = ctx.messageSessions();
        const groupHistory = ctx.socialThreads();
        const postHistory = ctx.socialPosts();
        if (!sessions.length && !groupHistory.length && !postHistory.length) {
            return createEmptyState({ documentRef: ctx.documentRef, variant: 'inbox', title: '还没有可查看的总结', hint: '开始私聊、聊天群或论坛帖子后，这里会按楼层整理记录。' });
        }
        const section = element('section', { className: 'yl-chat-page yl-message-list-page yl-chat-summary-history' });
        section.appendChild(element('p', { className: 'yl-phone-page-description', text: '私聊总结会写入当前 MVU 会话；聊天群与论坛帖子总结只存在当前浏览器的专用缓存，不影响酒馆正文。' }));
        if (sessions.length) {
            section.appendChild(element('h2', { text: '私聊总结' }));
            const list = element('div', { className: 'yl-chat-session-list' });
            for (const session of sessions) {
                const info = session.summaryInfo;
                const button = element('button', { className: 'yl-chat-session yl-message-session', type: 'button', ariaLabel: `查看${ctx.chatNickname(session)}的总结档案` });
                button.appendChild(ctx.chatAvatar(session));
                const copy = element('span', { className: 'yl-session-copy' });
                append(copy, [
                    element('span', { className: 'yl-session-name', text: ctx.chatNickname(session) }),
                    element('span', { className: 'yl-session-preview', text: `已对话 ${info.totalLayers} 层 · ${info.records.length} 条总结${info.pendingMessageCount ? ` · ${info.pendingMessageCount} 条待整理` : ''}` }),
                ]);
                append(button, [copy, ctx.openMark()]);
                listen(button, button, 'click', () => { ctx.localSummaryTarget = null; ctx.summaryHistorySessionUid = session.sessionUid; ctx.setActivePage('settings_chat_summary_history_detail'); }, ctx.abortController.signal);
                list.appendChild(button);
            }
            section.appendChild(list);
        }
        function appendLocalHistory(title, items, kind) {
            if (!items.length) return;
            section.appendChild(element('h2', { text: title }));
            const list = element('div', { className: 'yl-chat-session-list yl-local-summary-history-list' });
            for (const item of items) {
                const info = ctx.localSummaryInfo(item);
                const button = element('button', { className: 'yl-chat-session yl-message-session', type: 'button', ariaLabel: `查看${item.title ?? item.name}的总结档案` });
                const icon = element('span', { className: 'yl-session-avatar yl-local-summary-history-icon' });
                icon.setAttribute('aria-hidden', 'true');
                icon.appendChild(createUiIcon(ctx.documentRef, kind === 'group' ? 'groups' : 'forum', { className: 'yl-local-summary-history-svg', size: 22 }));
                const copy = element('span', { className: 'yl-session-copy' });
                const titleText = kind === 'group' ? item.title : item.title;
                append(copy, [
                    element('span', { className: 'yl-session-name', text: titleText }),
                    element('span', { className: 'yl-session-preview', text: `已对话 ${info.totalFloors} 楼 · ${info.records.length} 条总结${info.pendingFloorCount ? ` · ${info.pendingFloorCount} 楼待整理` : ''}` }),
                ]);
                append(button, [icon, copy, ctx.openMark()]);
                listen(button, button, 'click', () => {
                    ctx.localSummaryTarget = { kind, id: kind === 'group' ? item.key : item.id, title: titleText };
                    ctx.summaryHistorySessionUid = ''; ctx.setActivePage('settings_chat_summary_history_detail');
                }, ctx.abortController.signal);
                list.appendChild(button);
            }
            section.appendChild(list);
        }
        appendLocalHistory('聊天群总结', groupHistory, 'group');
        appendLocalHistory('论坛帖子总结', postHistory, 'post');
        return section;
    }
    function buildChatSummaryHistoryDetailPage() {
        if (ctx.localSummaryTarget) return ctx.buildLocalConversationSummaryPage(ctx.localSummaryTarget.kind);
        const session = ctx.messageSessionByUid(ctx.summaryHistorySessionUid);
        if (!session) {
            return createEmptyState({ documentRef: ctx.documentRef, variant: 'search', title: '会话暂时不可见', hint: '这位角色的会话暂时不可见，请返回总结档案后重试。' });
        }
        return ctx.buildConversationSummaryDetail(session, { actionsEnabled: true, historyMode: true });
    }
    function buildPreferenceSettingsPage() {
        // 「偏好」设置页（主线收口新增）：只承载浏览器本地的界面布局切换，
        // 复用壳层 setUiLayoutMode（持久化 + aria 播报 + 位置钳制），不进 MVU、导出或提示词。
        const section = element('section', { className: 'yl-settings-home yl-preference-settings' });
        const desktopActive = ctx.uiLayoutMode === 'desktop';
        const card = element('section', { className: 'yl-chat-summary-status-card yl-preference-layout-card' });
        const copy = element('div', { className: 'yl-chat-summary-status-copy' });
        append(copy, [
            element('strong', { text: desktopActive ? '当前为电脑端界面' : '当前为手机端界面' }),
            element('p', { text: '布局偏好只保存在当前浏览器，不写入公开资料、MVU、导出或提示词；也可在「我的」页头随时切换。' }),
        ]);
        const switchLabel = element('label', { className: 'yl-switch yl-preference-layout-switch' });
        const toggle = element('input', { type: 'checkbox', checked: desktopActive, ariaLabel: '切换电脑端界面布局' });
        switchLabel.appendChild(toggle);
        listen(toggle, toggle, 'change', () => {
            ctx.setUiLayoutMode(toggle.checked ? 'desktop' : 'phone');
            ctx.renderPage();
        }, ctx.abortController.signal);
        append(card, [copy, switchLabel]);
        section.appendChild(card);
        return section;
    }
    function buildAboutSoftwarePage() {
        const section = element('section', { className: 'yl-about-page' });
        const intro = element('article', { className: 'yl-about-card yl-about-intro' });
        const introCopy = element('div', { className: 'yl-about-copy' });
        const mark = element('span', { className: 'yl-about-mark' });
        mark.setAttribute('aria-hidden', 'true');
        mark.appendChild(createUiIcon(ctx.documentRef, 'logo', { className: 'yl-about-mark-svg', size: 24 }));
        append(intro, [mark, introCopy]);
        append(introCopy, [element('strong', { text: '约了吗小手机' }), element('p', { text: '现代都市线上文字社交模拟器。版本提示与更新日志会在数秒后自动关闭。' })]);
        section.appendChild(intro);
        const actions = element('div', { className: 'yl-about-actions' });
        const version = element('button', { className: 'yl-center-entry', type: 'button', name: 'about-version-info', ariaLabel: '版本信息' });
        const versionIcon = element('span', { className: 'yl-about-entry-icon' });
        versionIcon.appendChild(createUiIcon(ctx.documentRef, 'info', { className: 'yl-about-entry-svg', size: 18 }));
        append(version, [versionIcon, element('strong', { text: '版本信息' }), element('span', { text: '查看当前版本号。' }), ctx.openMark()]);
        listen(version, version, 'click', showVersionInformation, ctx.abortController.signal); actions.appendChild(version);
        if (ctx.aboutUnlocked) {
            const modeEntry = element('button', { className: 'yl-settings-button yl-hidden-feature-entry', type: 'button', name: 'about-content-mode-entry', text: '切换 SFW / NSFW' });
            listen(modeEntry, modeEntry, 'click', () => { ctx.aboutModeControlOpen = !ctx.aboutModeControlOpen; ctx.renderPage(); }, ctx.abortController.signal); actions.appendChild(modeEntry);
            if (ctx.aboutModeControlOpen) actions.appendChild(buildContentModeSlider());
        }
        const releases = element('button', { className: 'yl-center-entry', type: 'button', name: 'about-release-notes', ariaLabel: '更新日志' });
        const releasesIcon = element('span', { className: 'yl-about-entry-icon' });
        releasesIcon.appendChild(createUiIcon(ctx.documentRef, 'refresh', { className: 'yl-about-entry-svg', size: 18 }));
        append(releases, [releasesIcon, element('strong', { text: '更新日志' }), element('span', { text: '查看最近三次更新内容。' }), ctx.openMark()]);
        listen(releases, releases, 'click', showRecentReleaseNotes, ctx.abortController.signal); actions.appendChild(releases);
        if (ctx.serviceEntryUnlocked) {
            if (ctx.serviceHubUnlocked) {
                actions.appendChild(element('p', { className: 'yl-about-safety-note', text: '专属服务已在当前浏览器开启；关闭只隐藏入口并清空本地候补和边界草稿，不会删除已有订单或本地历史。' }));
                const disableService = element('button', { className: 'yl-settings-button yl-hidden-feature-entry yl-service-unlock-entry', type: 'button', name: 'about-service-disable', text: '关闭专属服务' });
                listen(disableService, disableService, 'click', ctx.disableServiceHub, ctx.abortController.signal);
                actions.appendChild(disableService);
            } else {
                const serviceEntry = element('button', { className: 'yl-settings-button yl-hidden-feature-entry yl-service-unlock-entry', type: 'button', name: 'about-service-entry', text: '开启专属服务' });
                listen(serviceEntry, serviceEntry, 'click', () => { ctx.serviceHubUnlocked = true; try { globalThis.localStorage?.setItem(SERVICE_UNLOCK_STORAGE_KEY, '1'); } catch { /* browser storage is optional */ } ctx.serviceNavButton.hidden = false; ctx.nav.classList.toggle('has-service-entry', true); ctx.setActivePage('service_hub'); }, ctx.abortController.signal);
                actions.appendChild(serviceEntry);
            }
        }
        section.appendChild(actions);
        section.appendChild(element('p', { className: 'yl-about-safety-note', text: 'NSFW 会开启更直接的成年人虚构服务分类与表达；它不代表同意，也不会绕过受控 MVU 写入、隐私最小化或小手机不自动发送的规则。' }));
        const updateAvailable = Boolean(ctx.extensionUpdater && typeof ctx.runExtensionUpdate === 'function');
        const updatePending = Boolean(ctx.extensionUpdatePending);
        const updateEntry = element('button', {
            className: 'yl-center-entry',
            type: 'button',
            name: 'about-extension-update',
            ariaLabel: '检查并自动更新约了吗小手机扩展',
            disabled: !updateAvailable || updatePending,
        });
        updateEntry.setAttribute('aria-busy', String(updatePending));
        const updateIcon = element('span', { className: 'yl-about-entry-icon' });
        updateIcon.appendChild(createUiIcon(ctx.documentRef, 'refresh', { className: 'yl-about-entry-svg', size: 18 }));
        const updateTitle = updatePending ? '正在检查并更新' : '检查并更新扩展';
        const updateNote = !updateAvailable
            ? '当前酒馆未提供可用的扩展更新服务。'
            : '自动检查 Git 版本，并在需要时通过酒馆更新服务完成更新。';
        append(updateEntry, [updateIcon, element('strong', { text: updateTitle }), element('span', { text: updateNote }), ctx.openMark()]);
        if (updateAvailable && !updatePending) listen(updateEntry, updateEntry, 'click', () => { void ctx.runExtensionUpdate(); }, ctx.abortController.signal);
        section.appendChild(updateEntry);
        return section;
    }
    function buildOperationConsole() {
        const section = element('section', { className: 'yl-operation-console' });
        const toolbar = element('div', { className: 'yl-operation-console-toolbar' });
        toolbar.appendChild(element('p', { text: '只保留本次小手机会话的运行记录，不持久化；失败详情经脱敏后可在条目内展开查看，密钥与隐私数值永不显示。' }));
        const clear = element('button', { className: 'yl-settings-button', type: 'button', text: '清空显示记录', ariaLabel: '清空控制台显示记录' });
        listen(clear, clear, 'click', () => { ctx.operationActivity.clear(); ctx.renderPage(); }, ctx.abortController.signal);
        toolbar.appendChild(clear);
        section.appendChild(toolbar);
        const snapshot = ctx.operationActivity.snapshot();
        if (!snapshot.entries.length) {
            section.appendChild(createEmptyState({
                documentRef: ctx.documentRef, variant: 'inbox',
                title: '暂无运行记录', hint: '开始灵魂匹配、描述匹配或收藏主动私聊后，会在这里显示进度。',
            }));
            return section;
        }
        const list = element('div', { className: 'yl-operation-console-list' });
        const labels = { running: '进行中', success: '已完成', failure: '未完成', dismissed: '已关闭' };
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
        const toggle = element('input', { type: 'checkbox', checked: ctx.currentView.mode === 'NSFW', ariaLabel: '内容模式切换' });
        listen(toggle, toggle, 'change', () => { if (Boolean(toggle.checked) !== (ctx.currentView.mode === 'NSFW')) void ctx.toggleContentModeFromSlider(); }, ctx.abortController.signal);
        wrap.appendChild(toggle);
        row.appendChild(wrap); row.appendChild(element('span', { text: 'NSFW' }));
        return row;
    }
    function buildPrivacySettings() {
        // §10.1「隐私与总结」：个性化推荐管理与对话总结共用这一个二级页收纳。
        const section = element('section', { className: 'yl-settings-home yl-privacy-summary-home' });
        section.appendChild(ctx.buildHubSection({
            title: '隐私与总结', className: 'yl-profile-group',
            entries: [
                { page: 'settings_personalization', iconName: 'privacy', title: '个性化内容推荐管理', note: '开启或关闭个性化推荐，并编辑当前设备的关键词权重。', meta: '设备级' },
                { page: 'settings_chat_summary', iconName: 'summary', title: '对话总结', note: '按楼层整理私聊、群聊与论坛帖子。', meta: '本地' },
            ],
        }));
        return section;
    }
    async function startFavoritePrivateChat(candidate) {
        if (!candidate?.uid || typeof ctx.actionBridge.runMvuAction !== 'function') return;
        const requestId = ++ctx.interactionGeneration;
        const pageAtStart = ctx.activePage;
        const activityHandle = ctx.operationActivity.start('收藏主动私聊', '正在等待对方回应……');
        const operationToken = ctx.showRomanceLoading('发起心动私聊', '正在等待对方回应……');
        ctx.renderPage();
        let result;
        let thrown = null;
        try { result = await ctx.actionBridge.runMvuAction('start_private_chat', candidate.uid); }
        catch (error) { result = { ok: false }; thrown = error; }
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) {
            ctx.operationActivity.dismiss(activityHandle, '提示已关闭，结果未展示。');
            return;
        }
        if (!result?.ok) {
            const message = result?.message || describeActionFailure(result) || '私聊邀请未完成，请稍后再试。';
            // 2026-07-27 控制台诊断增强：界面提示保持粗略；错误码 / 校验路径结论 / reason 只进 detail。
            // 32+ 连续 ASCII token 会被控制台脱敏器整体抹除，长错误码按下划线注入空格保住可读性。
            const rawCode = typeof result?.code === 'string' ? result.code : '';
            const displayCode = rawCode.length >= 32 ? rawCode.replaceAll('_', '_ ').trim() : rawCode;
            const specifics = [result?.reason, result?.detail].filter((item) => typeof item === 'string' && item).join('；');
            ctx.operationActivity.fail(activityHandle, '私聊邀请未完成，请稍后再试。', {
                detail: buildErrorDetail(thrown ?? { code: displayCode, message: specifics }, { operation: '收藏主动私聊', stage: '受控 MVU 写入' }),
            });
            ctx.showRomanceResult({ title: '邀请未送达', message }, operationToken);
            ctx.refreshState();
            return;
        }
        ctx.refreshState();
        if (result.invitationOutcome === 'declined') {
            if (ctx.activePage === pageAtStart) ctx.setActivePage('favorites', { preserveOperation: true });
            ctx.operationActivity.fail(activityHandle, '对方暂未接受私聊邀请。');
            ctx.showRomanceResult({ declined: true, title: '这次暂未靠近', message: 'TA 暂时没有接受这次私聊邀请。' }, operationToken);
            return;
        }
        const sessionUid = result.sessionUid || (ctx.currentView.messageSessions ?? []).find((session) => session.npcUid === candidate.uid)?.sessionUid;
        if (ctx.activePage === pageAtStart) {
            if (sessionUid) ctx.openPrivateChat(sessionUid, { preserveOperation: true });
            else ctx.setActivePage('messages', { preserveOperation: true });
        }
        ctx.operationActivity.succeed(activityHandle, '私聊邀请已接受，已打开消息。');
        ctx.showRomanceResult({ accepted: true, title: '心意被接住了', message: '私聊已建立，去打个招呼吧。' }, operationToken);
    }
    return {
        showVersionInformation,
        showRecentReleaseNotes,
        playerAvatarButton,
        localCharacterTemplateCount,
        buildProfileHub,
        seedPlayerDraft,
        buildProfileEditor,
        playerProfilePayload,
        savePlayerProfile,
        buildFavoritesPage,
        summarySettingEntry,
        buildChatSummarySettingsHome,
        appendPresetOptions,
        buildChatSummaryConfigPage,
        buildChatSummaryHistoryPage,
        buildChatSummaryHistoryDetailPage,
        buildPreferenceSettingsPage,
        buildAboutSoftwarePage,
        buildOperationConsole,
        buildContentModeSlider,
        buildPrivacySettings,
        startFavoritePrivateChat,
    };
}

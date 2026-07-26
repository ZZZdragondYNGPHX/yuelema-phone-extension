// 社区/群组/论坛（hub、聊天群、心动社区、本地总结）：从 src/app-shell.js 纯搬移而来，函数体逐行未改，仅将跨模块引用改为 ctx.*。
import { append, element, listen } from '../dom.js';
import { DEFAULT_FORUM_AUTO_SETTINGS, DEFAULT_GROUP_AUTO_SETTINGS, FORUM_CHANNELS, externalGroupCacheKey, forumChannelForTopic, groupForumProfileForDisplay, publicProfileToGroupForumProfile } from '../groups/group-forum-store.js';
import { createUiIcon } from '../ui/icon.js';

const FORUM_PULL_THRESHOLD = 88;
const FORUM_WHEEL_RELEASE_DELAY = 180;
const FORUM_WHEEL_MAX_DISTANCE = 288;
// 论坛频道结构图标：本地 SVG 白名单映射；未知频道回退到店内文字符号（内容而非系统控制）。
const FORUM_CHANNEL_ICON_NAMES = Object.freeze({
    daily_mood: 'channel_mood',
    nearby_people: 'channel_nearby',
    city_moments: 'channel_moments',
    shared_interests: 'channel_interests',
    topic_square: 'channel_topics',
});

export function createCommunityPage(ctx) {
    function buildGroupsPage() { return buildGroupHub(); }
    function buildGroupHub() {
        const section = element('section', { className: 'yl-miniapp-grid yl-community-hub' });
        const intro = element('article', { className: 'yl-community-intro' });
        append(intro, [
            element('span', { className: 'yl-hub-eyebrow', text: '城市关系频道' }),
            element('h2', { text: '先选择一种一起聊天的方式' }),
            element('p', { text: '聊天群适合持续共聊；心动社区适合围绕话题阅读和参与。两者都只展示公开资料。' }),
        ]);
        const signal = element('div', { className: 'yl-relationship-signal', ariaLabel: '社区公开内容摘要' });
        signal.appendChild(element('span', { className: 'yl-signal-line', ariaHidden: 'true' }));
        append(signal, [
            element('span', { text: ctx.currentView.groups.length + ' 个可见群组' }),
            element('span', { text: socialPosts().length + ' 条本地社区帖子' }),
        ]);
        intro.appendChild(signal);
        section.appendChild(intro);
        const choices = element('div', { className: 'yl-community-choices' });
        choices.appendChild(ctx.buildHubEntry({ page: 'group_chat', iconName: 'group_chat', title: '聊天群', note: '创建群聊、查看群友更新，并在需要时生成本地总结。', meta: ctx.currentView.groups.length + ' 个群组', className: 'yl-miniapp-card yl-community-choice', tone: 'rose' }));
        choices.appendChild(ctx.buildHubEntry({ page: 'group_forum', iconName: 'forum', title: '心动社区', note: '按频道浏览公开帖子，下拉刷新后再进入讨论。', meta: socialPosts().length + ' 条帖子', className: 'yl-miniapp-card yl-community-choice', tone: 'violet' }));
        section.appendChild(choices);
        return section;
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
            speaker: message.sender === 'user' ? '我' : (message.author?.nickname || '群友'),
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
            ctx.groupMemberPickerContent.appendChild(ctx.buildEmptyPlaceholder('还没有可添加的私聊角色。请先在“消息”中建立至少一段私聊。', { icon: '✉' }));
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
        ctx.dialogController.open(ctx.groupMemberPickerDialog, { onRequestClose: closeGroupMemberPicker });
    }
    function closeGroupAutoDialog() {
        ctx.groupAutoDialogKey = '';
        ctx.closeManagedDialog(ctx.groupAutoDialog);
        ctx.groupAutoContent.replaceChildren();
    }
    function openGroupAutoDialog(group) {
        const thread = groupConversation(group);
        const current = thread.auto ?? DEFAULT_GROUP_AUTO_SETTINGS;
        ctx.groupAutoDialogKey = group.cacheKey;
        ctx.groupAutoTitle.textContent = `${group.name} · 自动更新`;
        ctx.groupAutoContent.replaceChildren();
        ctx.groupAutoContent.appendChild(element('p', { className: 'yl-phone-page-description', text: '开启后，只会每隔设定秒数调用当前“聊天群”AI 预设；玩家发言不会触发额外调用。关闭时则在玩家发言后更新。' }));
        const enabledField = element('label', { className: 'yl-switch yl-group-auto-switch' });
        const enabled = element('input', { type: 'checkbox', checked: current.enabled === true, ariaLabel: '开启聊天群自动更新' });
        enabledField.appendChild(enabled);
        const enabledLabel = element('label', { className: 'yl-settings-field' }); append(enabledLabel, [element('span', { text: '开启自动更新' }), enabledField]);
        const interval = element('input', { className: 'yl-settings-control', type: 'number', min: 5, max: 3600, value: String(Number.isInteger(current.intervalSeconds) ? current.intervalSeconds : DEFAULT_GROUP_AUTO_SETTINGS.intervalSeconds), inputMode: 'numeric', ariaLabel: '自动更新时间秒数', disabled: current.enabled !== true });
        const intervalField = element('label', { className: 'yl-settings-field' }); append(intervalField, [element('span', { text: '更新时间（s）' }), interval, element('span', { className: 'yl-settings-summary', text: '关闭时不可编辑；开启后可设为 5–3600 秒。仅在当前聊天群界面打开时运行。' })]);
        listen(enabled, enabled, 'change', () => { interval.disabled = !enabled.checked; }, ctx.abortController.signal);
        ctx.groupAutoContent.appendChild(enabledLabel); ctx.groupAutoContent.appendChild(intervalField);
        const actions = element('div', { className: 'yl-settings-actions' });
        const cancel = element('button', { className: 'yl-settings-button yl-settings-button-secondary', type: 'button', text: '取消' });
        const confirm = element('button', { className: 'yl-settings-button', type: 'button', text: '确定' });
        listen(cancel, cancel, 'click', closeGroupAutoDialog, ctx.abortController.signal);
        listen(confirm, confirm, 'click', () => {
            const seconds = Number(interval.value);
            if (enabled.checked && (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600)) { ctx.setFeedback('更新时间请填写 5–3600 秒之间的整数。'); return; }
            const intervalSeconds = Number.isInteger(seconds) && seconds >= 5 && seconds <= 3600 ? seconds : DEFAULT_GROUP_AUTO_SETTINGS.intervalSeconds;
            if (!ctx.groupForumStore?.setGroupAuto) { ctx.setFeedback('本地聊天群缓存尚未就绪。'); return; }
            void (async () => {
                try {
                    await ctx.groupForumStore.setGroupAuto({ key: group.cacheKey, title: group.name, settings: { enabled: Boolean(enabled.checked), intervalSeconds } });
                    await syncGroupForumSnapshot({ rerender: false });
                    closeGroupAutoDialog();
                    ctx.setFeedback(enabled.checked ? `已开启自动更新：每 ${intervalSeconds}s。` : '已关闭自动更新；之后会在你发言后更新。');
                    ctx.renderPage(); syncGroupAutoTimer();
                } catch { ctx.setFeedback('自动更新设置没有保存，请稍后重试。'); }
            })();
        }, ctx.abortController.signal);
        append(actions, [cancel, confirm]); ctx.groupAutoContent.appendChild(actions);
        ctx.dialogController.open(ctx.groupAutoDialog, { onRequestClose: closeGroupAutoDialog });
    }
    function openGroupPresetDialog(group) {
        ctx.openFeatureBinding([{ key: 'group_chat', title: group.name + '聊天群' }], `${group.name} · 预设`, {
            readBinding: (_feature, contentMode) => localBindingForMode(groupConversation(group).bindings, contentMode),
            saveBinding: async (_feature, contentMode, binding) => {
                if (!ctx.groupForumStore?.setGroupBinding) throw new Error('local group bindings unavailable');
                await ctx.groupForumStore.setGroupBinding({ key: group.cacheKey, title: group.name, contentMode, binding });
                await syncGroupForumSnapshot({ rerender: false });
            },
        });
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
        try {
            result = await ctx.actionBridge.generateGroupConversationUpdate({
                group,
                history: localHistoryForModel(groupConversation(group)),
                trigger: 'auto',
                binding: localBindingForMode(groupConversation(group).bindings),
            });
        }
        catch { result = { ok: false }; }
        if (ctx.isDestroyed || generation !== ctx.groupAutoGeneration || ctx.activeGroupCacheKey !== cacheKey) {
            ctx.operationActivity.dismiss(activity, '聊天群已离开，自动更新结果未展示。');
            return;
        }
        if (!result?.ok || !result.update) {
            ctx.operationActivity.fail(activity, '聊天群自动更新未完成。');
            return;
        }
        try {
            await ctx.groupForumStore?.appendGroupModelUpdate?.({ key: group.cacheKey, title: group.name, update: result.update, members: group.members });
            await syncGroupForumSnapshot({ rerender: false });
            ctx.operationActivity.succeed(activity, '聊天群已按设定时间自动更新。');
            if (ctx.open && ctx.activePage === 'group_chat_room' && ctx.activeGroupCacheKey === cacheKey) ctx.renderPage();
            void maybeRunLocalAutomaticSummary({ kind: 'group', id: cacheKey, title: group.name });
        } catch {
            ctx.operationActivity.fail(activity, '聊天群自动更新未保存到本地缓存。');
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
        ctx.forumSettingsTitle.textContent = '心动社区设置';
        ctx.forumSettingsContent.replaceChildren();
        ctx.forumSettingsContent.appendChild(element('p', {
            className: 'yl-phone-page-description',
            text: '频道更新只生成固定五频道的新帖子；帖子更新只改写已存在本地帖子的可见内容。两套连接与提示词预设互不影响，模型不能改变程序固定的数据框架。',
        }));
        const channelFields = buildLocalBindingZone({
            title: '频道更新区',
            description: '用于顶部替换刷新或底部追加刷新时生成新帖子。每次仍由代码强制生成五个固定频道各一篇。',
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
        const intervalField = element('label', { className: 'yl-settings-field' }); append(intervalField, [element('span', { text: '更新时间（s）' }), interval, element('span', { className: 'yl-settings-summary', text: '关闭时不可编辑；开启后可设为 5–3600 秒，仅在社区首页打开时运行。' })]);
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
            if (!ctx.groupForumStore?.setForumAuto) { ctx.setFeedback('心动社区自动更新设置暂不可用。'); return; }
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
                } catch { ctx.setFeedback('心动社区自动更新设置没有保存，请稍后重试。'); }
            })();
        }, ctx.abortController.signal);
        append(actions, [cancel, save]); ctx.forumSettingsContent.appendChild(actions);
        ctx.dialogController.open(ctx.forumSettingsDialog, { onRequestClose: closeForumSettingsDialog });
    }
    function stopForumAutoTimer() {
        if (ctx.forumAutoTimer !== null) clearInterval(ctx.forumAutoTimer);
        ctx.forumAutoTimer = null;
        ctx.forumAutoGeneration += 1;
    }
    function syncForumAutoTimer() {
        const auto = forumAutoSettings();
        if (!ctx.open || ctx.activePage !== 'group_forum' || auto.enabled !== true || !socialPosts().length) { stopForumAutoTimer(); return; }
        if (ctx.forumAutoTimer !== null) return;
        const generation = ++ctx.forumAutoGeneration;
        ctx.forumAutoTimer = setInterval(() => { void runForumExistingPostsAutoUpdate(generation); }, auto.intervalSeconds * 1000);
    }
    async function runForumExistingPostsAutoUpdate(generation) {
        if (ctx.isDestroyed || !ctx.open || ctx.activePage !== 'group_forum' || generation !== ctx.forumAutoGeneration || forumAutoSettings().enabled !== true) return;
        const posts = socialPosts();
        if (!posts.length || !ctx.actionBridge.generateForumExistingPostsUpdate || ctx.actionBridge.isPending?.('forum_existing_update', '')) return;
        const activity = ctx.operationActivity.start('心动社区自动更新', '正在更新所有已存在的本地帖子，不会生成新帖子。');
        let result;
        try { result = await ctx.actionBridge.generateForumExistingPostsUpdate({ posts, binding: localBindingForMode(forumAutoSettings().postBindings) }); }
        catch { result = { ok: false }; }
        if (ctx.isDestroyed || generation !== ctx.forumAutoGeneration || ctx.activePage !== 'group_forum') {
            ctx.operationActivity.dismiss(activity, '心动社区已离开，自动更新结果未展示。');
            return;
        }
        if (!result?.ok || !result.update) {
            ctx.operationActivity.fail(activity, '心动社区自动更新未完成。');
            return;
        }
        try {
            await ctx.groupForumStore?.updateExistingForumPosts?.({ update: result.update });
            await syncGroupForumSnapshot({ rerender: false });
            ctx.operationActivity.succeed(activity, '已更新所有现有本地帖子；没有生成新帖子。');
            if (ctx.open && ctx.activePage === 'group_forum' && generation === ctx.forumAutoGeneration) ctx.renderPage();
        } catch {
            ctx.operationActivity.fail(activity, '心动社区自动更新没有保存到本地缓存。');
        }
    }
    function buildGroupListActionButton(pageId) {
        if (pageId !== 'group_chat') return null;
        const button = element('button', { className: 'yl-group-more-button', type: 'button', ariaLabel: '聊天群创建与查找' });
        button.appendChild(createUiIcon(ctx.documentRef, 'more_vertical', { className: 'yl-group-more-svg', size: 20 }));
        listen(button, button, 'click', () => { ctx.groupListMenuOpen = !ctx.groupListMenuOpen; ctx.renderPage(); }, ctx.abortController.signal);
        return button;
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
            const auto = element('button', { className: 'yl-private-chat-menu-item', type: 'button', text: '自动更新设置', ariaLabel: '设置聊天群自动更新' });
            const preset = element('button', { className: 'yl-private-chat-menu-item', type: 'button', text: '预设', ariaLabel: `配置${group.name}的预设` });
            listen(exit, exit, 'click', () => { ctx.groupRoomMenuOpen = false; ctx.groupRoomConfirmation = 'exit'; ctx.groupRoomConfirmationKey = group.cacheKey; ctx.renderPage(); }, ctx.abortController.signal);
            listen(clear, clear, 'click', () => { ctx.groupRoomMenuOpen = false; ctx.groupRoomConfirmation = 'clear'; ctx.groupRoomConfirmationKey = group.cacheKey; ctx.renderPage(); }, ctx.abortController.signal);
            listen(auto, auto, 'click', () => { ctx.groupRoomMenuOpen = false; ctx.renderPage(); openGroupAutoDialog(group); }, ctx.abortController.signal);
            listen(preset, preset, 'click', () => { ctx.groupRoomMenuOpen = false; ctx.renderPage(); openGroupPresetDialog(group); }, ctx.abortController.signal);
            append(menu, [exit, clear, auto, preset]); wrapper.appendChild(menu);
        }
        return wrapper;
    }
    function buildGroupChatPage() {
        const section = element('section', { className: 'yl-group-list-page' });
        if (ctx.groupListMenuOpen) {
            const menu = element('div', { className: 'yl-group-list-menu', ariaLabel: '聊天群操作菜单' });
            const create = element('button', { className: 'yl-settings-button', type: 'button', text: '创建' });
            const search = element('button', { className: 'yl-settings-button yl-settings-button-secondary', type: 'button', text: ctx.groupSearchOpen ? '收起查找' : '查找' });
            listen(create, create, 'click', () => { ctx.groupListMenuOpen = false; ctx.setActivePage('group_chat_create'); }, ctx.abortController.signal);
            listen(search, search, 'click', () => { ctx.groupSearchOpen = !ctx.groupSearchOpen; ctx.groupListMenuOpen = false; ctx.renderPage(); }, ctx.abortController.signal);
            append(menu, [create, search]); section.appendChild(menu);
        }
        const results = element('div', { className: 'yl-group-room-results' });
        const renderGroupResults = () => {
            const query = ctx.groupSearchQuery.trim().toLocaleLowerCase('zh-CN');
            const groups = currentGroupCards().filter((group) => !query || `${group.name} ${group.description} ${groupParticipants(group).map((profile) => profile.nickname).join(' ')}`.toLocaleLowerCase('zh-CN').includes(query));
            if (!groups.length) {
                results.replaceChildren(ctx.buildEmptyPlaceholder(query ? '没有找到匹配的聊天群。' : '还没有聊天群。点右上角 ⋮ 创建，或等待卡片提供公开群组。', { icon: '◌' }));
                return;
            }
            const list = element('div', { className: 'yl-group-room-list' });
            for (const group of groups) {
                const thread = groupConversation(group);
                const last = thread.messages?.at?.(-1);
                const card = element('button', { className: 'yl-group-room-card', type: 'button', ariaLabel: `打开${group.name}` });
                const avatars = element('div', { className: 'yl-group-room-avatars' });
                for (const profile of groupParticipants(group).slice(0, 4)) avatars.appendChild(ctx.publicAvatar(safeLocalDisplayProfile(profile), { className: 'yl-group-room-avatar', imageEnabled: true, interactive: false }));
                const copy = element('span', { className: 'yl-group-room-copy' });
                const auto = thread.auto?.enabled === true ? ` · 自动 ${thread.auto.intervalSeconds}s` : '';
                append(copy, [element('strong', { text: group.name }), element('span', { text: last ? `${last.sender === 'user' ? '我' : (last.author?.nickname || '群友')}：${last.content}` : `${groupParticipants(group).length} 位成员${auto}` })]);
                append(card, [avatars, copy, ctx.openMark()]);
                listen(card, card, 'click', () => { ctx.activeGroupCacheKey = group.cacheKey; ctx.setActivePage('group_chat_room'); }, ctx.abortController.signal);
                list.appendChild(card);
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
        const add = element('button', { className: 'yl-settings-button yl-settings-button-secondary', type: 'button', text: '选择私聊角色' });
        listen(add, add, 'click', openGroupMemberPicker, ctx.abortController.signal); memberField.appendChild(add);
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
        const cancel = element('button', { className: 'yl-settings-button yl-settings-button-secondary', type: 'button', text: '取消' });
        const confirm = element('button', { className: 'yl-settings-button', type: 'button', text: '确认创建' });
        listen(cancel, cancel, 'click', () => { ctx.groupCreateName = ''; ctx.groupCreateMembers = []; ctx.setActivePage('group_chat'); }, ctx.abortController.signal);
        listen(confirm, confirm, 'click', () => {
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
        }, ctx.abortController.signal);
        append(actions, [cancel, confirm]); section.appendChild(actions);
        return section;
    }
    function localMessageBubble(message, { forum = false, kind = forum ? 'forum' : 'group', conversationId = '' } = {}) {
        const isUser = message.sender === 'user';
        const bubble = element('article', { className: `yl-local-message ${isUser ? 'is-user' : 'is-member'}${forum ? ' is-forum' : ''}` });
        if (!isUser) {
            const profile = safeLocalDisplayProfile(message.author);
            bubble.appendChild(ctx.publicAvatar(profile, { className: 'yl-local-message-avatar', imageEnabled: true, interactive: false }));
            const copy = element('div', { className: 'yl-local-message-copy' });
            copy.appendChild(element('strong', { text: profile.昵称 }));
            copy.appendChild(element('p', { text: message.content }));
            if (message.imageDirective) {
                const imageCard = ctx.buildImageDirectiveCard({
                    kind, conversationId, messageId: message.id, characterUid: ctx.localProfileCharacterUid(message.author), directive: message.imageDirective,
                });
                if (imageCard) copy.appendChild(imageCard);
            }
            bubble.appendChild(copy);
        } else {
            const copy = element('div', { className: 'yl-local-message-copy' });
            copy.appendChild(element('strong', { text: '我' })); copy.appendChild(element('p', { text: message.content })); bubble.appendChild(copy);
        }
        return bubble;
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
    function buildGroupChatRoomPage() {
        const group = activeGroupCard();
        if (!group) return ctx.buildEmptyPlaceholder('当前聊天群已变化，请返回列表重新选择。', { icon: '◌' });
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
        const transcript = element('div', { className: 'yl-local-transcript', ariaLabel: `${group.name}的聊天记录` });
        if (!conversation.messages?.length) transcript.appendChild(ctx.buildEmptyPlaceholder('还没有群消息。说句话开始吧；关闭自动更新时，群友会在你发言后回应。', { icon: '◌' }));
        else for (const message of conversation.messages) transcript.appendChild(localMessageBubble(message, { kind: 'group', conversationId: group.cacheKey }));
        if (ctx.actionBridge.isPending?.('group_chat_update', group.cacheKey)) transcript.appendChild(element('div', { className: 'yl-chat-replying', text: '群友正在更新···' }));
        section.appendChild(transcript);
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
        try {
            result = await ctx.actionBridge.generateGroupConversationUpdate({
                group,
                history: localHistoryForModel(groupConversation(group)),
                trigger,
                binding: localBindingForMode(groupConversation(group).bindings),
            });
        }
        catch { result = { ok: false }; }
        if (ctx.isDestroyed || ctx.activeGroupCacheKey !== group.cacheKey) { ctx.operationActivity.dismiss(activity, '聊天群已离开，更新结果未展示。'); return; }
        if (!result?.ok || !result.update) {
            ctx.operationActivity.fail(activity, '聊天群更新未完成。'); ctx.setFeedback(result?.message || '聊天群更新未完成，请稍后重试。'); ctx.renderPage(); return;
        }
        try {
            await ctx.groupForumStore?.appendGroupModelUpdate?.({ key: group.cacheKey, title: group.name, update: result.update, members: group.members });
            await syncGroupForumSnapshot({ rerender: false });
            ctx.operationActivity.succeed(activity, '聊天群已更新到本地缓存。'); ctx.renderPage();
            void maybeRunLocalAutomaticSummary({ kind: 'group', id: group.cacheKey, title: group.name });
        } catch { ctx.operationActivity.fail(activity, '聊天群更新没有保存到本地缓存。'); ctx.setFeedback('聊天群更新没有保存到本地缓存。'); }
    }
    function forumIsAtTop(surface) {
        const contentTop = Number(ctx.content?.scrollTop);
        const surfaceTop = Number(surface?.scrollTop);
        return !(Number.isFinite(contentTop) && contentTop > 0) && !(Number.isFinite(surfaceTop) && surfaceTop > 0);
    }
    function forumIsAtBottom(surface) {
        const candidates = [ctx.content, surface].map((node) => ({
            scrollTop: Number(node?.scrollTop),
            scrollHeight: Number(node?.scrollHeight),
            clientHeight: Number(node?.clientHeight),
        })).filter((item) => Number.isFinite(item.scrollHeight) && Number.isFinite(item.clientHeight) && item.scrollHeight > item.clientHeight);
        if (!candidates.length) return false;
        return candidates.some((item) => Math.max(0, item.scrollTop || 0) >= item.scrollHeight - item.clientHeight - 2);
    }
    function resetForumPullIndicator(indicator, kind = 'replace') {
        if (!indicator) return;
        indicator.classList.toggle('is-visible', false); indicator.classList.toggle('is-armed', false); indicator.classList.toggle('is-refreshing', false); indicator.classList.toggle('is-append', kind === 'append');
        indicator.style?.setProperty?.('--yl-forum-pull-offset', '0px');
        indicator.textContent = kind === 'append' ? '↓ 上拉加载更多' : '↻ 下拉刷新';
    }
    function updateForumPullIndicator(indicator, distance, armed, { source = 'touch', kind = 'replace' } = {}) {
        if (!indicator) return;
        const offset = Math.min(160, Math.max(0, Math.round(distance * 0.55)));
        indicator.style?.setProperty?.('--yl-forum-pull-offset', `${offset}px`);
        indicator.classList.toggle('is-visible', distance > 0); indicator.classList.toggle('is-armed', armed); indicator.classList.toggle('is-append', kind === 'append');
        if (kind === 'append') {
            indicator.textContent = armed ? (source === 'wheel' ? '↓ 停止滚轮以加载' : '↓ 松开加载更多') : (source === 'wheel' ? '↓ 向下滚动加载' : '↓ 继续上拉加载');
        } else {
            indicator.textContent = armed ? (source === 'wheel' ? '↻ 停止滚轮以刷新' : '↻ 松开刷新') : (source === 'wheel' ? '↻ 向上滚动刷新' : '↻ 继续下拉');
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
        const start = (event) => {
            if (ctx.forumRefreshing || event?.isPrimary === false || event?.pointerType === 'mouse') return;
            const kind = forumIsAtTop(surface) ? 'replace' : (forumIsAtBottom(surface) ? 'append' : '');
            if (!kind) return;
            cancelForumWheelPull();
            ctx.forumPullState = {
                pointerId: event?.pointerId,
                startY: Number(event?.clientY) || 0,
                peak: 0,
                cancelled: false,
                kind,
                direction: kind === 'append' ? -1 : 1,
                indicator: kind === 'append' ? appendIndicator : replacementIndicator,
                inputType: event?.inputType === 'touch' ? 'touch' : 'pointer',
            };
            if (ctx.forumPullState.inputType === 'pointer') surface.setPointerCapture?.(event?.pointerId);
        };
        const move = (event) => {
            const state = ctx.forumPullState;
            if (!state || (state.pointerId !== undefined && event?.pointerId !== undefined && state.pointerId !== event.pointerId)) return;
            const distance = ((Number(event?.clientY) || 0) - state.startY) * state.direction;
            const stillAtBoundary = state.kind === 'replace' ? forumIsAtTop(surface) : forumIsAtBottom(surface);
            if (!stillAtBoundary || distance <= 0 || distance < state.peak - 4) {
                if (state.peak > 0) state.cancelled = true;
                resetForumPullIndicator(state.indicator, state.kind); return;
            }
            state.peak = Math.max(state.peak, distance);
            const armed = distance >= FORUM_PULL_THRESHOLD && !state.cancelled;
            updateForumPullIndicator(state.indicator, distance, armed, { source: 'touch', kind: state.kind });
            if (distance > 0) event?.preventDefault?.();
        };
        const end = (event) => {
            const state = ctx.forumPullState;
            if (!state || (state.pointerId !== undefined && event?.pointerId !== undefined && state.pointerId !== event.pointerId)) return;
            if (state.inputType === 'pointer') {
                try { surface.releasePointerCapture?.(state.pointerId); } catch { /* Pointer capture may already be gone. */ }
            }
            ctx.forumPullState = null;
            const shouldRefresh = !state.cancelled && state.peak >= FORUM_PULL_THRESHOLD;
            resetForumPullIndicator(state.indicator, state.kind);
            if (shouldRefresh) void runForumHomeRefresh({ mode: state.kind });
        };
        const touchPoint = (event, pointerId = undefined) => {
            const points = [...(event?.touches ?? []), ...(event?.changedTouches ?? [])];
            if (pointerId === undefined) return points[0] ?? null;
            return points.find((point) => point?.identifier === pointerId) ?? null;
        };
        const touchStart = (event) => {
            if (ctx.forumPullState?.inputType === 'pointer') return;
            const point = touchPoint(event);
            if (!point) return;
            start({ pointerId: point.identifier, clientY: point.clientY, isPrimary: true, inputType: 'touch' });
        };
        const touchMove = (event) => {
            const state = ctx.forumPullState;
            if (!state || state.inputType !== 'touch') return;
            const point = touchPoint(event, state.pointerId);
            if (!point) return;
            move({ pointerId: point.identifier, clientY: point.clientY, preventDefault: () => event.preventDefault?.() });
        };
        const touchEnd = (event) => {
            const state = ctx.forumPullState;
            if (!state || state.inputType !== 'touch') return;
            const point = touchPoint(event, state.pointerId);
            end({ pointerId: point?.identifier ?? state.pointerId });
        };
        const wheel = (event) => {
            if (ctx.forumRefreshing || event?.ctrlKey || ctx.forumPullState) return;
            const delta = normalizedWheelDelta(event);
            if (!delta) return;
            if (Math.abs(Number(event?.deltaX) || 0) > Math.abs(delta)) return;
            const requestedKind = delta < 0 && forumIsAtTop(surface)
                ? 'replace'
                : (delta > 0 && forumIsAtBottom(surface) ? 'append' : '');
            let state = ctx.forumWheelPullState;
            if (state && (!requestedKind || state.kind !== requestedKind)) { cancelForumWheelPull(); return; }
            if (!state) {
                if (!requestedKind) return;
                state = {
                    kind: requestedKind,
                    distance: 0,
                    indicator: requestedKind === 'append' ? appendIndicator : replacementIndicator,
                    releaseTimer: null,
                };
                ctx.forumWheelPullState = state;
            }
            const increment = Math.min(72, Math.max(8, Math.abs(delta) * 0.55));
            state.distance = Math.min(FORUM_WHEEL_MAX_DISTANCE, state.distance + increment);
            updateForumPullIndicator(state.indicator, state.distance, state.distance >= FORUM_PULL_THRESHOLD, { source: 'wheel', kind: state.kind });
            event?.preventDefault?.();
            if (state.releaseTimer !== null) clearTimeout(state.releaseTimer);
            state.releaseTimer = setTimeout(() => {
                if (ctx.forumWheelPullState !== state) return;
                ctx.forumWheelPullState = null;
                const shouldRefresh = state.distance >= FORUM_PULL_THRESHOLD;
                resetForumPullIndicator(state.indicator, state.kind);
                if (shouldRefresh) void runForumHomeRefresh({ mode: state.kind });
            }, FORUM_WHEEL_RELEASE_DELAY);
        };
        listen(surface, surface, 'pointerdown', start, controller.signal);
        listen(surface, surface, 'pointermove', move, controller.signal);
        listen(surface, surface, 'pointerup', end, controller.signal);
        listen(surface, surface, 'pointercancel', end, controller.signal);
        // Older embedded WebViews may expose Touch Events without Pointer Events.
        surface.addEventListener('touchstart', touchStart, { passive: true, signal: controller.signal });
        surface.addEventListener('touchmove', touchMove, { passive: false, signal: controller.signal });
        surface.addEventListener('touchend', touchEnd, { passive: true, signal: controller.signal });
        surface.addEventListener('touchcancel', touchEnd, { passive: true, signal: controller.signal });
        // The persistent phone content area is the browser's actual scroll container.
        // Listening there makes a wheel over the forum heading and feed behave alike.
        listen(surface, ctx.content, 'wheel', wheel, controller.signal);
    }
    function buildForumPage() {
        const section = element('section', { className: 'yl-forum-home' });
        const replacing = ctx.forumRefreshing && ctx.forumRefreshMode === 'replace';
        const appending = ctx.forumRefreshing && ctx.forumRefreshMode === 'append';
        const pull = element('div', { className: replacing ? 'yl-forum-pull-indicator is-visible is-refreshing' : 'yl-forum-pull-indicator', text: replacing ? '正在替换心动社区帖子…' : '↻ 下拉刷新' });
        const appendPull = element('div', { className: appending ? 'yl-forum-append-indicator yl-forum-pull-indicator is-visible is-refreshing is-append' : 'yl-forum-append-indicator yl-forum-pull-indicator is-append', text: appending ? '正在追加心动社区帖子…' : '↓ 上拉加载更多' });
        const selectedChannel = activeForumChannel();
        const auto = forumAutoSettings();
        section.appendChild(pull); bindForumPullToRefresh(section, pull, appendPull);
        const hero = element('section', { className: 'yl-forum-home-hero' });
        const heroTitle = selectedChannel ? `${selectedChannel.title} · 子区` : '心动社区 ♥';
        const heroDescription = selectedChannel ? `${selectedChannel.note} · 只显示该频道的本地帖子` : '分享生活 · 遇见心动的 TA';
        const autoHint = auto.enabled
            ? `帖子自动更新已开启：每 ${auto.intervalSeconds}s 仅更新已有帖子。`
            : '帖子自动更新已关闭。';
        const pullHint = selectedChannel
            ? `当前：${selectedChannel.title}；再点高亮频道返回全部动态。顶部下拉会替换旧帖子，滑到最底后继续上拉会追加新帖子。${autoHint}`
            : `顶部：手机下拉松开或电脑向上滚动后停滚，会替换旧帖子；到底后手机继续上拉或电脑向下滚动，会追加五个频道的新帖子。${autoHint}`;
        append(hero, [element('h2', { text: heroTitle }), element('p', { text: heroDescription }), element('span', { className: 'yl-forum-pull-hint', text: pullHint })]); section.appendChild(hero);
        const channels = element('div', { className: 'yl-forum-channel-strip' });
        for (const channel of FORUM_CHANNELS) {
            const selected = selectedChannel?.id === channel.id;
            const card = element('button', { className: selected ? 'yl-forum-channel is-active' : 'yl-forum-channel', type: 'button', pressed: selected, ariaLabel: selected ? `返回心动社区全部动态（当前${channel.title}）` : `进入${channel.title}子区` });
            card.setAttribute('data-forum-channel', channel.id);
            const channelIconName = FORUM_CHANNEL_ICON_NAMES[channel.id];
            const channelGlyph = element('b', { className: 'yl-forum-channel-icon', text: channelIconName ? '' : channel.icon });
            if (channelIconName) channelGlyph.appendChild(createUiIcon(ctx.documentRef, channelIconName, { className: 'yl-forum-channel-svg', size: 18 }));
            append(card, [channelGlyph, element('strong', { text: channel.title }), element('small', { text: channel.note })]);
            listen(card, card, 'click', () => selectForumChannel(channel.id), ctx.abortController.signal);
            channels.appendChild(card);
        }
        section.appendChild(channels);
        const posts = forumPostsForActiveChannel();
        if (!posts.length) {
            const channelName = selectedChannel?.title ?? '心动社区';
            section.appendChild(ctx.buildEmptyPlaceholder(`${channelName}还没有本地帖子。请在顶部手机下拉松开，或电脑向上滚动后停滚；这会新增五个频道各一篇帖子。`, { icon: '↻' }));
        }
        else {
            const feed = element('div', { className: 'yl-forum-feed' });
            feed.appendChild(element('h3', { className: 'yl-forum-feed-heading', text: selectedChannel ? `${selectedChannel.title} · ${posts.length} 条本地帖子` : `社区动态 · ${posts.length} 条本地帖子` }));
            for (const post of posts) {
                const card = element('button', { className: 'yl-forum-feed-card', type: 'button', ariaLabel: `打开帖子：${post.title}` });
                const author = safeLocalDisplayProfile(post.author);
                const authorRow = element('span', { className: 'yl-forum-feed-author' });
                authorRow.appendChild(ctx.publicAvatar(author, { className: 'yl-group-member-avatar', imageEnabled: true, interactive: false }));
                const authorCopy = element('span'); append(authorCopy, [element('strong', { text: author.昵称 }), element('small', { text: [forumChannelForPost(post).title, author.城市].filter(Boolean).join(' · ') || '心动社区' })]); authorRow.appendChild(authorCopy);
                const preview = post.body.length > 160 ? `${post.body.slice(0, 160)}…` : post.body;
                append(card, [authorRow, element('h3', { text: post.title }), element('p', { text: preview }), element('span', { className: 'yl-forum-feed-footer', text: `${post.messages.length} 条评论 · ${post.tags.map((tag) => '#' + tag).join(' ')}` })]);
                listen(card, card, 'click', () => { ctx.activeForumPostId = post.id; ctx.setActivePage('forum_post'); }, ctx.abortController.signal);
                feed.appendChild(card);
            }
            section.appendChild(feed);
        }
        section.appendChild(appendPull);
        return section;
    }
    async function runForumHomeRefresh({ mode = 'replace' } = {}) {
        if (ctx.forumRefreshing || !ctx.actionBridge.generateForumHomeRefresh || ctx.actionBridge.isPending?.('forum_home_refresh', '')) return;
        if (!['replace', 'append'].includes(mode)) return;
        ctx.forumRefreshing = true; ctx.forumRefreshMode = mode; ctx.renderPage();
        const replacing = mode === 'replace';
        const activity = ctx.operationActivity.start('论坛首页刷新', replacing ? '正在替换旧帖子并刷新全部五个频道。' : '正在保留旧帖子并追加全部五个频道。');
        let result;
        try {
            result = await ctx.actionBridge.generateForumHomeRefresh({
                existingTitles: replacing ? [] : socialPosts().slice(0, 24).map((post) => post.title),
                refreshMode: mode,
                binding: localBindingForMode(forumAutoSettings().channelBindings),
            });
        }
        catch { result = { ok: false }; }
        ctx.forumRefreshing = false; ctx.forumRefreshMode = '';
        if (ctx.isDestroyed || ctx.activePage !== 'group_forum') { ctx.operationActivity.dismiss(activity, '论坛首页已离开，刷新结果未展示。'); return; }
        if (!result?.ok || !result.update) {
            ctx.operationActivity.fail(activity, '论坛首页未刷新。'); ctx.setFeedback(result?.message || '论坛首页刷新未完成，请稍后重试。'); ctx.renderPage(); return;
        }
        try {
            const saveRefresh = replacing ? ctx.groupForumStore?.replaceForumPosts : ctx.groupForumStore?.addForumRefresh;
            await saveRefresh?.({ update: result.update, communityProfiles: result.communityProfiles ?? [] });
            await syncGroupForumSnapshot({ rerender: false });
            ctx.operationActivity.succeed(activity, replacing ? '旧帖子已替换为新的五频道帖子。' : '新帖子已追加到本地缓存。'); ctx.renderPage(); syncForumAutoTimer();
        } catch { ctx.operationActivity.fail(activity, '论坛首页更新没有保存到本地缓存。'); ctx.setFeedback('论坛首页更新没有保存到本地缓存。'); ctx.renderPage(); }
    }
    function buildForumPostPage() {
        const post = socialPostFor(ctx.activeForumPostId);
        if (!post) return ctx.buildEmptyPlaceholder('当前帖子已不可用，请返回论坛首页后刷新。', { icon: '▤' });
        const section = element('section', { className: 'yl-forum-post-page' });
        const layout = element('div', { className: 'yl-forum-post-layout' });
        const main = element('article', { className: 'yl-forum-post-main' });
        const author = safeLocalDisplayProfile(post.author);
        const authorRow = element('div', { className: 'yl-forum-post-author' });
        authorRow.appendChild(ctx.publicAvatar(author, { className: 'yl-forum-post-avatar', imageEnabled: true, interactive: false }));
        const authorCopy = element('div'); append(authorCopy, [element('strong', { text: author.昵称 }), element('span', { text: [author.gender, author.ageRange, author.city].filter(Boolean).join(' · ') }), element('small', { text: '刚刚 · 心动社区' })]); authorRow.appendChild(authorCopy);
        const actionRow = element('div', { className: 'yl-forum-post-actions' });
        const summary = element('button', { className: 'yl-settings-button yl-settings-button-secondary', type: 'button', text: '聊天总结', disabled: !ctx.chatSummaryEnabled(), ariaLabel: '查看帖子总结' });
        listen(summary, summary, 'click', () => { ctx.localSummaryTarget = { kind: 'post', id: post.id, title: post.title }; ctx.setActivePage('forum_post_summary'); }, ctx.abortController.signal);
        append(actionRow, [summary, ctx.buildConversationImageControls({ kind: 'forum', conversationId: post.id })]); append(main, [authorRow, actionRow, element('h2', { text: post.title }), element('p', { className: 'yl-forum-post-body', text: post.body })]);
        const tags = element('div', { className: 'yl-tag-list yl-forum-post-tags' });
        for (const tag of post.tags) tags.appendChild(element('span', { className: 'yl-tag-chip', text: '#' + tag }));
        main.appendChild(tags);
        main.appendChild(element('h3', { text: `评论（${post.messages.length}）` }));
        const comments = element('div', { className: 'yl-forum-comment-list' });
        if (!post.messages.length) comments.appendChild(ctx.buildEmptyPlaceholder('还没有评论。留下第一句公开想法吧。', { icon: '◌' }));
        else for (const message of post.messages) comments.appendChild(localMessageBubble(message, { forum: true, kind: 'forum', conversationId: post.id }));
        if (ctx.actionBridge.isPending?.('forum_post_update', post.id)) comments.appendChild(element('div', { className: 'yl-chat-replying', text: '讨论正在更新···' }));
        main.appendChild(comments); layout.appendChild(main);
        const side = element('aside', { className: 'yl-forum-post-author-card' });
        side.appendChild(ctx.publicAvatar(author, { className: 'yl-forum-post-avatar', imageEnabled: true, interactive: false })); side.appendChild(element('strong', { text: author.昵称 })); side.appendChild(buildParticipantMeta(post.author));
        if (post.author.occupation) side.appendChild(element('span', { text: post.author.occupation }));
        if (post.author.interests.length) side.appendChild(element('span', { text: post.author.interests.join(' / ') }));
        layout.appendChild(side); section.appendChild(layout);
        const pending = Boolean(ctx.actionBridge.isPending?.('forum_post_update', post.id));
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
        if (!ctx.actionBridge.generateForumPostConversationUpdate || ctx.actionBridge.isPending?.('forum_post_update', post.id)) return;
        const activity = ctx.operationActivity.start('论坛帖子更新', '正在生成帖子下的本地讨论。'); ctx.renderPage();
        let result;
        try {
            result = await ctx.actionBridge.generateForumPostConversationUpdate({
                postId: post.id,
                post,
                history: localHistoryForModel(post),
                binding: localBindingForMode(forumAutoSettings().postBindings),
            });
        }
        catch { result = { ok: false }; }
        if (ctx.isDestroyed || ctx.activeForumPostId !== post.id) { ctx.operationActivity.dismiss(activity, '帖子已离开，更新结果未展示。'); return; }
        if (!result?.ok || !result.update) {
            ctx.operationActivity.fail(activity, '论坛帖子更新未完成。'); ctx.setFeedback(result?.message || '论坛帖子更新未完成，请稍后重试。'); ctx.renderPage(); return;
        }
        try {
            await ctx.groupForumStore?.appendForumModelUpdate?.({ postId: post.id, update: result.update });
            await syncGroupForumSnapshot({ rerender: false }); ctx.operationActivity.succeed(activity, '论坛帖子已更新到本地缓存。'); ctx.renderPage();
            void maybeRunLocalAutomaticSummary({ kind: 'post', id: post.id, title: post.title });
        } catch { ctx.operationActivity.fail(activity, '论坛帖子更新没有保存到本地缓存。'); ctx.setFeedback('论坛帖子更新没有保存到本地缓存。'); }
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
            speaker: message.sender === 'user' ? '我' : (message.author?.nickname || '群友'),
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
        const retryLimit = automatic ? ctx.chatSummarySettings().retryLimit : 0;
        let result = null;
        for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
            try { result = await ctx.actionBridge.generateLocalGroupForumSummary({ target, messages: source.messages }); }
            catch { result = { ok: false }; }
            if (result?.ok && result.summary) break;
        }
        try {
            if (result?.ok && result.summary) {
                await ctx.groupForumStore.saveConversationSummary({ target: { kind: target.kind, id: target.id }, summaryId, startFloor: source.startFloor, endFloor: source.endFloor, content: result.summary });
                await syncGroupForumSnapshot({ rerender: false });
                if (!automatic) ctx.setFeedback('本地聊天总结已保存。');
            } else {
                const message = result?.message || '本次总结未完成，请稍后重试。';
                await ctx.groupForumStore.failConversationSummary({ target: { kind: target.kind, id: target.id }, startFloor: source.startFloor, endFloor: source.endFloor, message });
                await syncGroupForumSnapshot({ rerender: false });
                if (!automatic) ctx.setFeedback(message);
            }
        } catch { if (!automatic) ctx.setFeedback('本地聊天总结没有保存。'); }
        finally {
            ctx.localSummaryBusy = false;
            if (!ctx.isDestroyed && ctx.open && ((target.kind === 'group' && ctx.activeGroupCacheKey === target.id) || (target.kind === 'post' && ctx.activeForumPostId === target.id) || ctx.activePage === 'settings_chat_summary_history')) ctx.renderPage();
        }
        if (automatic && result?.ok) void maybeRunLocalAutomaticSummary(target);
    }
    function buildLocalConversationSummaryPage(kind) {
        const fallback = kind === 'group' ? activeGroupCard() : socialPostFor(ctx.activeForumPostId);
        const target = ctx.localSummaryTarget?.kind === kind ? ctx.localSummaryTarget : (fallback ? { kind, id: kind === 'group' ? fallback.cacheKey : fallback.id, title: kind === 'group' ? fallback.name : fallback.title } : null);
        if (!target) return ctx.buildEmptyPlaceholder('当前对话暂不可查看总结。', { icon: '⌁' });
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
        if (!info.records.length) section.appendChild(ctx.buildEmptyPlaceholder(ctx.chatSummaryEnabled() ? '还没有完成的总结记录；达到设定楼数后会自动整理。' : '自动对话总结当前已关闭。请在设置中开启后再整理。', { icon: '⌁' }));
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
        buildGroupHub,
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
        openGroupAutoDialog,
        openGroupPresetDialog,
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
        localMessageBubble,
        buildParticipantMeta,
        buildGroupRoomConfirmation,
        runGroupRoomDataAction,
        buildGroupChatRoomPage,
        sendGroupMessage,
        runGroupConversationUpdate,
        forumIsAtTop,
        forumIsAtBottom,
        resetForumPullIndicator,
        updateForumPullIndicator,
        cancelForumWheelPull,
        cancelForumPullInteractions,
        normalizedWheelDelta,
        bindForumPullToRefresh,
        buildForumPage,
        runForumHomeRefresh,
        buildForumPostPage,
        sendForumComment,
        runForumPostConversationUpdate,
        localConversationForTarget,
        localSummarySource,
        maybeRunLocalAutomaticSummary,
        runLocalConversationSummary,
        buildLocalConversationSummaryPage,
    };
}

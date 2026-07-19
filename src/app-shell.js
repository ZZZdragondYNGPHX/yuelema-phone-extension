import { append, element, listen } from './dom.js';
import { readLatestState } from './mvu/adapter.js';
import { NAV_ITEMS, PAGE_COPY, createPhoneView, describeActionFailure } from './ui-model.js';
import { buildSettingsPanel } from './settings-panel.js';
import { buildCharacterCreatorPanel } from './characters/character-creator-panel.js';

const UI_VERSION = '0.1.1';
const EMPTY_POOL_ACTIONS = Object.freeze([
    ['创建角色', '手动建立一名成年人。', 'open_character_creator'],
    ['导入角色模板', '导入自己的角色资料。', 'open_character_import'],
    ['快速随机创建候选人', '用快速模型生成下一位成年人。', 'open_random_candidates'],
]);
const ACTION_LABELS = Object.freeze({ like: '喜欢', refresh: '刷新', favorite: '收藏', dislike: '不喜欢' });
const PRIMARY_PAGE_FOR = Object.freeze({
    group_chat: 'groups', group_forum: 'groups', profile_editor: 'profile', favorites: 'profile', settings: 'profile',
    settings_connections: 'profile', settings_prompts: 'profile', about: 'profile', match_tools: 'matches', candidate_detail: 'home',
});

/** @param {{ documentRef: Document, rootId: string, actionBridge: ReturnType<import('./action-bridge.js').createActionBridge>, readState?: () => unknown }} options */
export function mountPhoneApp({ documentRef, rootId, actionBridge, settingsStore, llmClient, characterLibrary, readState = () => readLatestState() }) {
    const abortController = new AbortController();
    const root = documentRef.createElement('section');
    root.id = rootId;
    root.className = 'yl-phone-extension';
    root.setAttribute('aria-label', '约了吗小手机');

    let open = false;
    let activePage = 'home';
    let feedback = '';
    let refreshing = false;
    let characterCreatorOpen = false;
    let activeMessageSessionUid = '';
    let activeMeetupSessionUid = '';
    let selectedCandidateUid = '';
    let aboutClickStreak = 0;
    let aboutUnlocked = false;
    let playerProfileDraft = null;
    const chatDrafts = new Map();
    const meetupDrafts = new Map();
    const groupChatInputDrafts = new Map();
    const groupChatGeneratedDrafts = new Map();
    const forumTopicDrafts = new Map();
    const forumGeneratedDrafts = new Map();
    let soulMatchDraft = null;
    let textMatchDraft = null;
    let currentView = createPhoneView(readState());

    const launcher = element('button', { className: 'yl-phone-launcher', type: 'button', ariaLabel: '打开约了吗小手机', pressed: false, text: '约' });
    launcher.appendChild(element('span', { className: 'yl-phone-launcher-label', text: '约了吗' }));
    const panel = element('aside', { className: 'yl-phone-panel', ariaLabel: '约了吗小手机窗口', hidden: true });
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    const header = element('header', { className: 'yl-phone-header' });
    const brand = element('div', { className: 'yl-phone-brand' });
    const statusLine = element('span', { className: 'yl-phone-status' });
    append(brand, [element('strong', { text: '约了吗' }), statusLine]);
    const closeButton = element('button', { className: 'yl-phone-close', type: 'button', ariaLabel: '关闭约了吗小手机', text: '×' });
    append(header, [brand, closeButton]);
    const content = element('main', { className: 'yl-phone-content' });
    const nav = element('nav', { className: 'yl-phone-nav', ariaLabel: '约了吗主导航' });
    const navButtons = new Map();
    for (const item of NAV_ITEMS) {
        const button = element('button', { className: 'yl-phone-nav-item', type: 'button', ariaLabel: item.label, text: `${item.icon} ${item.label}` });
        button.dataset.page = item.id;
        navButtons.set(item.id, button);
        listen(button, button, 'click', () => setActivePage(item.id), abortController.signal);
        nav.appendChild(button);
    }
    append(panel, [header, content, nav]);
    append(root, [launcher, panel]);
    documentRef.body.appendChild(root);

    function setOpen(nextOpen) {
        open = Boolean(nextOpen);
        panel.hidden = !open;
        root.classList.toggle('is-open', open);
        launcher.setAttribute('aria-pressed', String(open));
        launcher.setAttribute('aria-label', open ? '关闭约了吗小手机' : '打开约了吗小手机');
        if (open) refreshState();
    }
    function setActivePage(pageId) {
        if (!PAGE_COPY[pageId]) return;
        activePage = pageId;
        actionBridge.emit('navigate', { page: pageId });
        renderPage();
    }
    function refreshState() {
        currentView = createPhoneView(readState());
        if (open) renderPage();
        return currentView;
    }
    function setFeedback(message) { feedback = String(message ?? '').slice(0, 220); }
    function renderFeedback(page) { if (feedback) page.appendChild(element('p', { className: 'yl-phone-feedback', text: feedback })); }
    function primaryPage(pageId) { return PRIMARY_PAGE_FOR[pageId] ?? pageId; }
    function backPage(pageId) {
        if (['group_chat', 'group_forum'].includes(pageId)) return 'groups';
        if (pageId === 'match_tools') return 'matches';
        if (['profile_editor', 'favorites', 'settings'].includes(pageId)) return 'profile';
        if (['settings_connections', 'settings_prompts', 'about'].includes(pageId)) return 'settings';
        if (pageId === 'candidate_detail') return 'home';
        return '';
    }
    function buildHelp(text) {
        const button = element('button', { className: 'yl-help-tooltip', type: 'button', ariaLabel: `说明：${text}`, text: '?' });
        button.setAttribute('data-tooltip', text);
        return button;
    }
    function buildPageHeading(copy, pageId) {
        const row = element('div', { className: 'yl-page-heading' });
        const back = backPage(pageId);
        if (back) {
            const button = element('button', { className: 'yl-page-back', type: 'button', ariaLabel: '返回', text: '‹' });
            listen(button, button, 'click', () => setActivePage(back), abortController.signal);
            row.appendChild(button);
        }
        row.appendChild(element('h1', { text: copy.title }));
        if (copy.help) row.appendChild(buildHelp(copy.help));
        return row;
    }
    function renderPage() {
        const copy = PAGE_COPY[activePage];
        statusLine.textContent = currentView.status === 'ready' ? '已连接' : 'MVU 未就绪';
        content.replaceChildren();
        const page = element('article', { className: `yl-phone-page yl-page-${activePage}` });
        page.appendChild(buildPageHeading(copy, activePage));
        if (copy.description) page.appendChild(element('p', { className: 'yl-phone-page-description', text: copy.description }));
        if (currentView.status !== 'ready') page.appendChild(element('div', { className: 'yl-phone-placeholder', text: '暂时无法读取当前聊天的软件状态。' }));
        else if (activePage === 'home') page.appendChild(currentView.candidate ? buildCandidateCard(currentView.candidate) : (characterCreatorOpen ? buildCharacterCreator() : buildEmptyPoolActions()));
        else if (activePage === 'matches') page.appendChild(buildMatchesPage());
        else if (activePage === 'match_tools') page.appendChild(buildMatchToolsPanel());
        else if (activePage === 'messages') page.appendChild(buildMessagesPage());
        else if (activePage === 'groups') page.appendChild(buildGroupsPage());
        else if (activePage === 'group_chat') page.appendChild(buildGroupChatPage());
        else if (activePage === 'group_forum') page.appendChild(buildForumPage());
        else if (activePage === 'profile') page.appendChild(buildProfileHub());
        else if (activePage === 'profile_editor') page.appendChild(buildProfileEditor());
        else if (activePage === 'favorites') page.appendChild(buildFavoritesPage());
        else if (activePage === 'settings') page.appendChild(buildSettingsHome());
        else if (['settings_connections', 'settings_prompts'].includes(activePage)) page.appendChild(buildSettingsDetail());
        else if (activePage === 'about') page.appendChild(buildAboutPage());
        else if (activePage === 'candidate_detail') page.appendChild(buildCandidateDetail());
        renderFeedback(page);
        content.appendChild(page);
        for (const [id, button] of navButtons) {
            const selected = id === primaryPage(activePage);
            button.classList.toggle('is-active', selected);
            button.setAttribute('aria-current', selected ? 'page' : 'false');
        }
    }

    function buildEmptyPoolActions() {
        const section = element('section', { className: 'yl-phone-empty-actions' });
        section.appendChild(element('h2', { text: '开始建立角色池' }));
        for (const [label, note, action] of EMPTY_POOL_ACTIONS) {
            const button = element('button', { className: 'yl-phone-action-card', type: 'button', ariaLabel: label });
            append(button, [element('strong', { text: label }), element('span', { text: note })]);
            listen(button, button, 'click', () => {
                actionBridge.emit(action);
                if (action === 'open_character_creator' || action === 'open_character_import') {
                    characterCreatorOpen = true;
                    setFeedback(action === 'open_character_import' ? '粘贴模板 JSON 后再确认。' : '填写完整的成年人资料后登记。');
                    renderPage();
                } else void runInitialRecommendationCandidate();
            }, abortController.signal);
            section.appendChild(button);
        }
        return section;
    }
    function buildCharacterCreator() {
        if (!characterLibrary || typeof actionBridge.registerCharacter !== 'function') return element('div', { className: 'yl-phone-placeholder', text: '角色创作尚未就绪。' });
        return buildCharacterCreatorPanel({ documentRef, actionBridge, characterLibrary, signal: abortController.signal, onFeedback: setFeedback, onRegistered: () => { characterCreatorOpen = false; refreshState(); } });
    }
    function displayTags(candidate) { return [...(candidate.兴趣标签 ?? []), ...(candidate.生活方式标签 ?? []), ...(candidate.性格标签 ?? []), ...(candidate.沟通风格标签 ?? [])]; }
    function candidateAvatar(candidate) {
        const label = candidate.昵称 || '未命名对象';
        const button = element('button', { className: 'yl-candidate-avatar', type: 'button', ariaLabel: `查看${label}的公开资料`, text: label.slice(0, 1) || '人' });
        listen(button, button, 'click', () => { selectedCandidateUid = candidate.uid; setActivePage('candidate_detail'); }, abortController.signal);
        return button;
    }
    function buildActionRow(candidate, { tooltips = true } = {}) {
        const actions = element('div', { className: 'yl-candidate-actions' });
        const helpText = { like: '提高公开标签偏好并发起匹配邀请。', dislike: '降低相似公开标签的推荐权重。', favorite: '保存到收藏夹。', refresh: '请求快速模型生成下一位候选人。' };
        for (const kind of ['like', 'dislike', 'favorite', 'refresh']) {
            const pending = actionBridge.isPending(kind, candidate.uid);
            const button = element('button', { className: `yl-phone-action-card yl-action-${kind}`, type: 'button', ariaLabel: ACTION_LABELS[kind], text: pending ? '处理中…' : ACTION_LABELS[kind], disabled: pending });
            if (tooltips) button.appendChild(buildHelp(helpText[kind]));
            listen(button, button, 'click', () => { void runCandidateAction(kind, candidate.uid); }, abortController.signal);
            actions.appendChild(button);
        }
        return actions;
    }
    function buildCandidateCard(candidate) {
        const card = element('section', { className: refreshing ? 'yl-candidate-card is-refreshing' : 'yl-candidate-card' });
        const top = element('div', { className: 'yl-candidate-topline' });
        top.appendChild(candidateAvatar(candidate));
        const copy = element('div', { className: 'yl-candidate-copy' });
        copy.appendChild(element('h2', { text: candidate.昵称 || '未命名候选人' }));
        copy.appendChild(element('p', { className: 'yl-phone-page-description', text: [candidate.年龄段, candidate.城市, candidate.寻找意图].filter(Boolean).join(' · ') || '仅公开资料' }));
        top.appendChild(copy); card.appendChild(top);
        const tags = displayTags(candidate);
        if (tags.length) card.appendChild(element('p', { className: 'yl-candidate-tags', text: tags.join(' · ') }));
        card.appendChild(buildActionRow(candidate));
        return card;
    }
    function buildCandidateDetail() {
        const candidate = currentView.candidates.find((entry) => entry.uid === selectedCandidateUid) ?? currentView.candidate;
        if (!candidate) return element('div', { className: 'yl-phone-placeholder', text: '该公开资料已不在当前可见列表。' });
        const section = element('section', { className: 'yl-public-profile' });
        section.appendChild(candidateAvatar(candidate));
        section.appendChild(element('h2', { text: candidate.昵称 || '未命名对象' }));
        for (const [label, value] of [['年龄段', candidate.年龄段], ['性别', candidate.性别], ['性取向', candidate.性取向], ['城市', candidate.城市], ['距离范围', candidate.距离范围], ['寻找意图', candidate.寻找意图], ['简介', candidate.简介]]) if (value) section.appendChild(element('p', { className: 'yl-phone-page-description', text: `${label}：${value}` }));
        const tags = displayTags(candidate);
        if (tags.length) section.appendChild(element('p', { className: 'yl-candidate-tags', text: tags.join(' · ') }));
        section.appendChild(buildActionRow(candidate, { tooltips: false }));
        return section;
    }

    function buildMatchesPage() {
        const section = element('section', { className: 'yl-phone-empty-actions yl-match-list' });
        const tools = element('button', { className: 'yl-phone-action-card yl-match-tools-entry', type: 'button', ariaLabel: '打开灵魂匹配和文字匹配' });
        append(tools, [element('strong', { text: '灵魂匹配 · 文字匹配' }), element('span', { text: '使用同一组公开资料与匹配配置。' })]);
        listen(tools, tools, 'click', () => setActivePage('match_tools'), abortController.signal);
        section.appendChild(tools);
        const matches = currentView.matches ?? [];
        if (!matches.length) {
            section.appendChild(element('p', { className: 'yl-phone-placeholder', text: '暂无互相匹配。' }));
            return section;
        }
        for (const match of matches) {
            const card = element('article', { className: 'yl-chat-session yl-match-row' });
            card.appendChild(candidateAvatar(match.profile));
            const info = element('div', { className: 'yl-candidate-copy' });
            info.appendChild(element('strong', { text: match.profile.昵称 || '未命名对象' }));
            const detail = [match.profile.年龄段, match.profile.城市, match.profile.寻找意图].filter(Boolean).join(' · ');
            if (detail) info.appendChild(element('span', { text: detail }));
            card.appendChild(info);
            const openMessages = element('button', { className: 'yl-settings-button', type: 'button', text: '聊天' });
            listen(openMessages, openMessages, 'click', () => setActivePage('messages'), abortController.signal);
            card.appendChild(openMessages); section.appendChild(card);
        }
        return section;
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
        setFeedback('正在生成群聊草稿…'); renderPage();
        const result = await actionBridge.generateGroupChatDraft({ groupUid: group.UID, playerMessage });
        if (result?.ok && result.draft?.reply) {
            groupChatGeneratedDrafts.set(group.UID, { reply: result.draft.reply });
            setFeedback('群聊草稿已生成，尚未发布。');
        } else setFeedback(result?.message || describeActionFailure(result));
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
        setFeedback('正在生成论坛帖子草稿…'); renderPage();
        const result = await actionBridge.generateForumPostDraft({ groupUid: group.UID, topic });
        if (result?.ok && result.draft?.title && result.draft?.body) {
            forumGeneratedDrafts.set(group.UID, { title: result.draft.title, body: result.draft.body });
            setFeedback('论坛帖子草稿已生成，尚未发布。');
        } else setFeedback(result?.message || describeActionFailure(result));
        renderPage();
    }
    function groupCards({ forum = false } = {}) {
        const groups = Array.isArray(currentView.groups) ? currentView.groups : [];
        const section = element('section', { className: 'yl-phone-empty-actions yl-group-list' });
        if (!groups.length) {
            section.appendChild(element('p', { className: 'yl-phone-placeholder', text: forum ? '暂无可浏览论坛主题。' : '暂无可浏览聊天群。' }));
            return section;
        }
        for (const group of groups) {
            const card = element('article', { className: 'yl-chat-session yl-group-card' });
            card.appendChild(element('h2', { text: group.主题 }));
            if (group.描述) card.appendChild(element('p', { className: 'yl-phone-page-description', text: group.描述 }));
            const memberNames = (group.成员 ?? []).map((person) => person.公开资料?.昵称).filter(Boolean);
            card.appendChild(element('p', { className: 'yl-phone-page-description', text: memberNames.length ? `成员：${memberNames.join(' · ')}` : '成员资料暂不可见' }));
            const discoverable = Array.isArray(group.可发现角色) ? group.可发现角色 : [];
            if (forum) {
                card.appendChild(element('span', { className: 'yl-group-forum-state', text: discoverable.length ? `可参与讨论对象 ${discoverable.length} 位` : '暂无公开讨论对象' }));
                card.appendChild(buildForumComposer(group));
            } else {
                for (const person of discoverable) {
                    const profile = person.公开资料 ?? {};
                    const row = element('div', { className: 'yl-character-library-row' });
                    row.appendChild(element('strong', { text: profile.昵称 || '未命名成年人' }));
                    const session = (currentView.messageSessions ?? []).find((item) => item.npcUid === person.UID);
                    if (session) {
                        const openChat = element('button', { className: 'yl-settings-button', type: 'button', text: '进入已有私聊' });
                        listen(openChat, openChat, 'click', () => { activeMessageSessionUid = session.sessionUid; setActivePage('messages'); }, abortController.signal);
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
    function buildMessagesPage() {
        const sessions = Array.isArray(currentView.messageSessions) ? currentView.messageSessions : [];
        if (!sessions.length) return element('div', { className: 'yl-phone-placeholder', text: '暂无已建立的私聊会话。' });
        if (!sessions.some((session) => session.sessionUid === activeMessageSessionUid)) activeMessageSessionUid = sessions[0].sessionUid;
        const section = element('section', { className: 'yl-chat-page' });
        const sessionList = element('div', { className: 'yl-chat-session-list' });
        for (const session of sessions) {
            const selected = session.sessionUid === activeMessageSessionUid;
            const button = element('button', { className: selected ? 'yl-chat-session is-selected' : 'yl-chat-session', type: 'button', ariaLabel: `打开与${session.profile.昵称 || '该对象'}的会话`, text: `${session.profile.昵称 || '未命名对象'} · ${session.status}` });
            listen(button, button, 'click', () => { activeMessageSessionUid = session.sessionUid; renderPage(); }, abortController.signal);
            sessionList.appendChild(button);
        }
        section.appendChild(sessionList);
        const selected = sessions.find((session) => session.sessionUid === activeMessageSessionUid);
        if (selected) section.appendChild(buildConversationPanel(selected));
        return section;
    }
    function buildConversationPanel(session) {
        const panel = element('section', { className: 'yl-chat-conversation' });
        panel.appendChild(element('h2', { text: session.profile.昵称 || '未命名对象' }));
        const transcript = element('div', { className: 'yl-chat-transcript' });
        if (!session.messages.length) transcript.appendChild(element('p', { className: 'yl-phone-page-description', text: '还没有消息。' }));
        for (const message of session.messages) {
            const row = element('article', { className: message.sender === '玩家' ? 'yl-chat-bubble is-player' : 'yl-chat-bubble' });
            row.appendChild(element('strong', { text: message.sender })); row.appendChild(element('p', { text: message.content }));
            if (message.time) row.appendChild(element('span', { text: message.time })); transcript.appendChild(row);
        }
        panel.appendChild(transcript);
        if (!session.canSend || typeof actionBridge.runPrivateChat !== 'function') {
            panel.appendChild(element('div', { className: 'yl-phone-placeholder', text: session.canSend ? '私聊发送尚未就绪。' : '该会话当前为只读状态。' }));
            return panel;
        }
        const pending = actionBridge.isPending('private_chat', session.sessionUid);
        const composer = element('div', { className: 'yl-chat-composer' });
        const input = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 3, maxLength: 600, placeholder: '发送一条消息…', value: chatDrafts.get(session.sessionUid) ?? '', disabled: pending });
        listen(input, input, 'input', () => { chatDrafts.set(session.sessionUid, input.value); }, abortController.signal);
        const send = element('button', { className: 'yl-settings-button', type: 'button', text: pending ? '处理中…' : '发送', disabled: pending });
        listen(send, send, 'click', () => { void runPrivateChat(session); }, abortController.signal);
        append(composer, [input, send]); panel.appendChild(composer);
        if (typeof actionBridge.runMeetupHandoff === 'function') panel.appendChild(buildMeetupHandoffPanel(session));
        return panel;
    }
    async function runPrivateChat(session) {
        const playerMessage = chatDrafts.get(session.sessionUid) ?? '';
        setFeedback('正在请求私聊回复…'); renderPage();
        const result = await actionBridge.runPrivateChat({ sessionUid: session.sessionUid, npcUid: session.npcUid, playerMessage });
        if (result.ok) { chatDrafts.delete(session.sessionUid); setFeedback('私聊已保存。'); } else setFeedback(result?.message || describeActionFailure(result));
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
        setFeedback('正在校验面基约定…'); renderPage();
        const result = await actionBridge.runMeetupHandoff({ sessionUid: session.sessionUid, npcUid: session.npcUid, ...meetupFieldsFor(session.sessionUid) });
        if (result.ok && result.draftApplied) { meetupDrafts.delete(session.sessionUid); activeMeetupSessionUid = ''; setFeedback('正文草稿已填入，未自动发送。'); }
        else if (result.ok) setFeedback('已保存约定，但没有找到正文输入框。');
        else setFeedback(describeActionFailure(result));
        refreshState();
    }

    function buildProfileHub() {
        const section = element('section', { className: 'yl-person-center' });
        const nickname = currentView.playerProfile.昵称 || '未填写个人资料';
        const headerCard = element('article', { className: 'yl-person-summary' });
        headerCard.appendChild(element('span', { className: 'yl-person-avatar', text: nickname.slice(0, 1) || '我' }));
        const copy = element('div');
        copy.appendChild(element('strong', { text: nickname }));
        copy.appendChild(element('span', { text: currentView.playerProfile.城市 || '建立公开资料后开启更准确的匹配。' }));
        headerCard.appendChild(copy); section.appendChild(headerCard);
        const entries = [['profile_editor', '◉', '个人资料', '填写公开资料。'], ['favorites', '☆', `收藏夹${currentView.favorites.length ? ` · ${currentView.favorites.length}` : ''}`, '查看保存的候选人。'], ['settings', '⚙', '设置', '匹配、连接、提示词与关于软件。']];
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
        section.appendChild(element('p', { className: 'yl-phone-page-description', text: '只编辑公开资料；本页不会读取或显示私密层。' }));
        const fields = [['昵称', 'text'], ['头像引用', 'url'], ['年龄段', 'text'], ['性别', 'text'], ['性取向', 'text'], ['城市', 'text'], ['距离范围', 'text'], ['寻找意图', 'text'], ['简介', 'textarea'], ['兴趣标签', 'tags'], ['生活方式标签', 'tags'], ['性格标签', 'tags'], ['沟通风格标签', 'tags']];
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
            昵称: draft.昵称, 头像引用: draft.头像引用, 年龄段: draft.年龄段, 性别: draft.性别, 性取向: draft.性取向,
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
        setFeedback('正在保存公开资料…');
        renderPage();
        const result = await actionBridge.runSavePlayerPublicProfile(playerProfilePayload());
        if (result?.ok) {
            playerProfileDraft = null;
            setFeedback('公开资料已保存，可参与后续评分与匹配。');
            refreshState();
        } else {
            setFeedback(result?.message || describeActionFailure(result));
            renderPage();
        }
    }
    function buildFavoritesPage() {
        if (!currentView.favorites.length) return element('div', { className: 'yl-phone-placeholder', text: '收藏夹还是空的。' });
        const section = element('section', { className: 'yl-favorite-list' });
        for (const candidate of currentView.favorites) {
            const card = element('article', { className: 'yl-favorite-card' });
            card.appendChild(candidateAvatar(candidate));
            const copy = element('div', { className: 'yl-candidate-copy' });
            copy.appendChild(element('strong', { text: candidate.昵称 || '未命名对象' }));
            const tags = displayTags(candidate); if (tags.length) copy.appendChild(element('span', { text: tags.join(' · ') }));
            card.appendChild(copy); card.appendChild(buildActionRow(candidate, { tooltips: false })); section.appendChild(card);
        }
        return section;
    }
    function buildSettingsHome() {
        const section = element('section', { className: 'yl-settings-home' });
        const entries = [['match_tools', 'AI 匹配工具', '灵魂匹配与文字匹配。'], ['settings_connections', '连接预设', '按名称选择和维护连接。'], ['settings_prompts', '提示词预设', '维护世界书式提示词条目。'], ['about', '关于软件', `版本 ${UI_VERSION}`]];
        for (const [page, title, note] of entries) {
            const button = element('button', { className: 'yl-center-entry', type: 'button', ariaLabel: title });
            append(button, [element('strong', { text: title }), element('span', { text: note }), element('span', { text: '›' })]);
            listen(button, button, 'click', () => setActivePage(page), abortController.signal); section.appendChild(button);
        }
        return section;
    }
    function buildSettingsDetail() {
        if (!settingsStore) return element('div', { className: 'yl-phone-placeholder', text: '本地设置尚未就绪。' });
        const label = activePage === 'settings_connections' ? '连接预设' : '提示词预设';
        const section = element('section', { className: 'yl-settings-detail' });
        section.appendChild(element('p', { className: 'yl-phone-page-description', text: `${label}在下方统一管理。` }));
        section.appendChild(buildSettingsPanel({ settingsStore, llmClient, signal: abortController.signal, onFeedback: setFeedback, onRerender: renderPage }));
        return section;
    }
    function buildAboutPage() {
        const section = element('section', { className: 'yl-about-card' });
        const version = element('button', { className: 'yl-version-button', type: 'button', ariaLabel: `约了吗版本 ${UI_VERSION}`, text: `约了吗 ${UI_VERSION}` });
        listen(version, version, 'click', () => { void advanceContentModeGate({ reveal: true }); }, abortController.signal);
        section.appendChild(version);
        section.appendChild(element('p', { className: 'yl-phone-page-description', text: '现代都市线上文字社交模拟器。' }));
        if (aboutUnlocked) {
            const row = element('div', { className: 'yl-mode-easter-egg' });
            row.appendChild(element('span', { text: 'SFW' }));
            const slider = element('input', { className: 'yl-mode-slider', type: 'range', min: 0, max: 1, value: currentView.mode === 'NSFW' ? 1 : 0, ariaLabel: '内容模式切换' });
            listen(slider, slider, 'change', () => { if ((slider.value === '1') !== (currentView.mode === 'NSFW')) void toggleContentModeFromSlider(); }, abortController.signal);
            row.appendChild(slider); row.appendChild(element('span', { text: 'NSFW' })); section.appendChild(row);
        }
        return section;
    }
    async function advanceContentModeGate({ reveal = false } = {}) {
        const result = await actionBridge.runMvuAction('advance_content_mode_gate');
        if (result?.ok) {
            aboutClickStreak += 1;
            if (reveal && aboutClickStreak >= 5) { aboutUnlocked = true; setFeedback('内容模式滑条已解锁。'); } else setFeedback('已记录。');
        } else setFeedback(describeActionFailure(result));
        refreshState();
    }
    async function toggleContentModeFromSlider() {
        setFeedback('正在切换内容模式…'); renderPage();
        for (let click = 0; click < 5; click += 1) {
            const result = await actionBridge.runMvuAction('advance_content_mode_gate');
            if (!result?.ok) { setFeedback(describeActionFailure(result)); refreshState(); return; }
        }
        aboutClickStreak = 0; aboutUnlocked = true;
        setFeedback(`已切换为 ${currentView.mode === 'SFW' ? 'NSFW' : 'SFW'}。`); refreshState();
    }

    function buildMatchToolsPanel() {
        const section = element('section', { className: 'yl-meetup-panel' });
        const heading = element('div', { className: 'yl-heading-with-help' });
        heading.appendChild(element('h2', { text: 'AI 匹配工具' })); heading.appendChild(buildHelp('两种匹配都只使用公开资料；生成后由你确认是否采用。'));
        section.appendChild(heading);
        if (typeof actionBridge.generateMatchDraft !== 'function') { section.appendChild(element('p', { className: 'yl-phone-placeholder', text: 'AI 匹配工具尚未就绪。' })); return section; }
        const controls = element('div', { className: 'yl-phone-empty-actions' });
        for (const [kind, label] of [['soul', '灵魂匹配'], ['text', '文字匹配']]) {
            const pending = actionBridge.isPending(`${kind}_match_draft`);
            const button = element('button', { className: 'yl-settings-button', type: 'button', disabled: pending, text: pending ? '处理中…' : label });
            listen(button, button, 'click', () => { void runMatchDraft(kind); }, abortController.signal); controls.appendChild(button);
        }
        section.appendChild(controls);
        if (soulMatchDraft) {
            const card = element('article', { className: 'yl-chat-conversation' });
            card.appendChild(element('strong', { text: '灵魂匹配草稿' })); card.appendChild(element('p', { className: 'yl-phone-page-description', text: soulMatchDraft.explanation }));
            for (const entry of soulMatchDraft.tagWeightDraft) card.appendChild(element('span', { text: `${entry.tag} → ${entry.weight}` }));
            const pending = actionBridge.isPending('apply_soul_match_preference');
            const apply = element('button', { className: 'yl-settings-button', type: 'button', disabled: pending, text: pending ? '正在采用…' : '采用公开标签偏好' });
            listen(apply, apply, 'click', () => { void applySoulMatchDraft(); }, abortController.signal); card.appendChild(apply); section.appendChild(card);
        }
        if (textMatchDraft) {
            const card = element('article', { className: 'yl-chat-conversation' });
            card.appendChild(element('strong', { text: '文字匹配建议' })); card.appendChild(element('p', { className: 'yl-phone-page-description', text: textMatchDraft.explanation }));
            for (const [field, values] of Object.entries(textMatchDraft.filters)) if (values.length) card.appendChild(element('span', { text: `${field}：${values.join(' · ')}` }));
            section.appendChild(card);
        }
        return section;
    }
    async function runMatchDraft(kind) {
        setFeedback(kind === 'soul' ? '正在生成灵魂匹配草稿…' : '正在生成文字匹配建议…'); renderPage();
        const result = await actionBridge.generateMatchDraft(kind);
        if (result.ok) { if (kind === 'soul') soulMatchDraft = result.draft; else textMatchDraft = result.draft; setFeedback('草稿已生成，尚未自动写入。'); }
        else setFeedback(result?.message || describeActionFailure(result));
        renderPage();
    }
    async function applySoulMatchDraft() {
        if (!soulMatchDraft || typeof actionBridge.applySoulMatchPreferenceDraft !== 'function') return;
        setFeedback('正在采用公开标签偏好…'); renderPage();
        const result = await actionBridge.applySoulMatchPreferenceDraft(soulMatchDraft);
        if (result.ok) { soulMatchDraft = null; setFeedback('公开标签偏好已保存。'); refreshState(); } else { setFeedback(describeActionFailure(result)); renderPage(); }
    }

    async function runInitialRecommendationCandidate() {
        if (typeof actionBridge.runRecommendationInitialCandidate !== 'function') { setFeedback('随机创建尚未就绪。'); renderPage(); return; }
        refreshing = true; setFeedback('正在生成下一位候选人…'); renderPage();
        const result = await actionBridge.runRecommendationInitialCandidate();
        refreshing = false; setFeedback(result.ok ? '已通过成年人校验，首位候选人已加入队列。' : result?.message || describeActionFailure(result)); refreshState();
    }
    async function runCandidateAction(kind, npcUid) {
        const isRefresh = kind === 'refresh';
        refreshing = isRefresh;
        const request = isRefresh && typeof actionBridge.runRecommendationRefresh === 'function'
            ? actionBridge.runRecommendationRefresh(npcUid)
            : actionBridge.runMvuAction(kind, npcUid);
        setFeedback(isRefresh ? '正在生成下一位候选人…' : '正在保存操作…'); renderPage();
        const result = await request;
        refreshing = false;
        setFeedback(result.ok ? (isRefresh ? '已切换到下一位候选人。' : '操作已保存。') : result?.message || describeActionFailure(result));
        refreshState();
    }

    listen(launcher, launcher, 'click', () => setOpen(!open), abortController.signal);
    listen(closeButton, closeButton, 'click', () => setOpen(false), abortController.signal);
    listen(root, documentRef, 'keydown', (event) => { if (event.key === 'Escape' && open) setOpen(false); }, abortController.signal);
    renderPage();
    return Object.freeze({ refreshState, destroy() { abortController.abort(); root.remove(); } });
}




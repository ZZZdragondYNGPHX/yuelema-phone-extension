import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createMemoryStorage, createSettingsStore } from '../../settings/settings-store.js';
import { createPlayerAvatarStore } from '../../player-avatar-store.js';

const miniDom = installMiniDom();
const { mountPhoneApp } = await import('../../app-shell.js');

test.after(() => miniDom.restore());

function adultCharacter(nickname = '公开候选人') {
    return {
        成人验证: true,
        公开资料: {
            昵称: nickname, 头像引用: '', 年龄段: '25-29', 性别: '女', 性取向: '双性恋',
            城市: '上海', 距离范围: '10 km', 寻找意图: '聊天后约会', 简介: '只展示公开资料。',
            兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'],
        },
        仅好友资料: {}, 隐藏资料: {}, 偏好与边界: '',
        拒绝阈值: 40, 已读不回阈值: 55, 取消匹配阈值: 70, 拉黑阈值: 90,
        与玩家关系: { 状态: '未匹配', 全局账号表现: 80, NPC专属匹配度: 85, 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 },
    };
}

function readyReadResult() {
    const candidate = adultCharacter();
    return {
        ok: true,
        state: {
            系统: { UID计数器: { 角色: 1 } },
            软件: { 内容模式: 'SFW' },
            玩家: { 公开资料: adultCharacter('玩家').公开资料 },
            推荐: { 当前队列: ['npc_1'], 临时候选池: { npc_1: candidate }, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
            角色池: { npc_1: candidate }, 会话: {},
            群组: { group_city: { 主题: '城市夜谈', 描述: '公开成年人群组。', 成员UID: ['npc_1'], 可发现角色UID: ['npc_1'] } },
        },
    };
}

function emptyReadResult() {
    return {
        ok: true,
        state: {
            系统: { UID计数器: { 角色: 0 } }, 软件: { 内容模式: 'SFW' },
            推荐: { 当前队列: [], 临时候选池: {}, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
            角色池: {}, 会话: {}, 群组: {},
        },
    };
}

function click(node) {
    assert.ok(node, '要点击的控件必须存在');
    node.dispatchEvent(new Event('click'));
}

function pressKey(key) {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperty(event, 'key', { configurable: true, value: key });
    miniDom.document.dispatchEvent(event);
}

function assertOperationCloseControls(dialog, state) {
    assert.equal(dialog.dataset.state, state);
    const topClose = dialog.querySelector('.yl-dialog-close');
    const bottomClose = dialog.querySelector('[name="operation-dialog-action"]');
    assert.ok(topClose, '操作弹窗应始终提供右上角 ×');
    assert.equal(topClose.getAttribute('name'), 'operation-dialog-close');
    assert.equal(topClose.getAttribute('aria-label'), '关闭操作弹窗');
    assert.equal(topClose.hidden, false);
    assert.ok(bottomClose, '操作弹窗应始终提供底部文字关闭按钮');
    assert.equal(bottomClose.getAttribute('aria-label'), '关闭操作提示');
    assert.equal(bottomClose.hidden, false);
    assert.match(bottomClose.textContent, /关闭/u);
    return { topClose, bottomClose };
}

function buttonByText(text) {
    return miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes(text));
}

function buttonByPage(page) {
    return miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === page);
}

function backButton() {
    return miniDom.document.querySelector('.yl-page-back');
}

async function flushUi() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

test('all routed child pages keep a top-left back button and settings views stay isolated', () => {
    const settingsStore = createSettingsStore({ storage: createMemoryStorage() });
    const bridge = { emit() {}, isPending() { return false; }, runMvuAction: async () => ({ ok: true }) };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-subpage-back', actionBridge: bridge,
        settingsStore, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));

        const candidateDetailTrigger = miniDom.document.querySelectorAll('span').find((node) => (
            node.getAttribute('role') === 'button'
            && node.getAttribute('aria-label')?.startsWith('查看公开候选人')
        ));
        assert.ok(candidateDetailTrigger, '候选头像应作为可键盘操作的详情入口');
        assert.equal(candidateDetailTrigger.getAttribute('tabindex'), '0');
        click(candidateDetailTrigger);
        assert.ok(backButton(), '公开资料子页应有返回按钮');
        click(backButton());

        click(buttonByPage('groups'));
        click(buttonByText('聊天群'));
        assert.ok(backButton(), '聊天群子页应有返回按钮');
        click(backButton());
        click(buttonByText('心动社区'));
        assert.ok(backButton(), '论坛子页应有返回按钮');
        click(backButton());

        click(buttonByPage('profile'));
        click(buttonByText('个人资料'));
        assert.ok(backButton(), '个人资料子页应有返回按钮');
        click(backButton());
        click(buttonByText('收藏夹'));
        assert.ok(backButton(), '收藏夹子页应有返回按钮');
        click(backButton());
        click(buttonByText('设置'));
        assert.ok(backButton(), '设置子页应有返回按钮');
        assert.doesNotMatch(miniDom.document.body.textContent, /AI 匹配工具|灵魂匹配|文字匹配/u);

        click(buttonByText('连接预设'));
        assert.ok(backButton(), '连接预设子页应有返回按钮');
        assert.ok(miniDom.document.querySelector('[name="connection-name"]'));
        assert.equal(miniDom.document.querySelector('[name="prompt-preset-name"]'), null);
        click(backButton());

        click(buttonByText('提示词预设'));
        assert.ok(backButton(), '提示词预设子页应有返回按钮');
        assert.ok(miniDom.document.querySelector('[name="prompt-preset-name"]'));
        assert.equal(miniDom.document.querySelector('[name="connection-name"]'), null);
        assert.doesNotMatch(miniDom.document.body.textContent, /Worldbook|世界书式/u);
        click(backButton());

        click(buttonByText('隐私权限设置'));
        assert.ok(backButton(), '隐私权限设置子页应有返回按钮');
        click(buttonByText('个性化内容推荐管理'));
        assert.ok(backButton(), '个性化内容推荐管理子页应有返回按钮');
        assert.ok(miniDom.document.querySelector('[name="personalization-enabled"]'));
        assert.ok(miniDom.document.querySelector('[name="personalization-preference-entry"]'));
        assert.equal(miniDom.document.querySelector('[name="personalization-keyword"]'), null, '管理页不得预渲染关键词编辑器');
        click(buttonByText('个性化内容偏好'));
        assert.ok(backButton(), '个性化内容偏好次级页应有返回按钮');
        assert.ok(miniDom.document.querySelector('[name="personalization-keyword"]'));
        assert.equal(miniDom.document.querySelector('[name="personalization-enabled"]'), null, '次级页不得重复管理开关');
    } finally {
        mounted.destroy();
    }
});

test('match tools create a fresh mutual match and message session without using favourites', async () => {
    const calls = [];
    const readResult = readyReadResult();
    const bridge = {
        emit() {},
        isPending() { return false; },
        async runCandidateMatch(mode, options) {
            calls.push({ mode, voiceText: options.voiceText });
            const matched = adultCharacter('灵魂档案');
            matched.与玩家关系.状态 = '已匹配';
            matched.隐藏资料 = { 实际年龄: 28, 私人备注: 'never render' };
            readResult.state.角色池.npc_match_2 = matched;
            readResult.state.会话.chat_2 = { 对象UID: 'npc_match_2', 状态: '已匹配', 最近消息: [], 长期摘要: '', 已确认边界: '', 已确认承诺: '' };
            return { ok: true, matchOutcome: 'accepted', npcUid: 'npc_match_2', sessionUid: 'chat_2', explanation: '公开缘分说明', matchScore: 91 };
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-candidate-match-profile', actionBridge: bridge,
        settingsStore: createSettingsStore({ storage: createMemoryStorage() }), llmClient: null, characterLibrary: null, readState: () => readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('matches'));
        assert.match(miniDom.document.body.textContent, /灵魂匹配|语音匹配/u);
        const input = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '语音匹配文字描述');
        assert.ok(input, '语音匹配应提供独立文字输入框');
        input.value = '周末想逛展，也想认真聊天';
        input.dispatchEvent(new Event('input'));
        const matchButtons = miniDom.document.querySelectorAll('button').filter((node) => node.textContent === '开始匹配');
        assert.equal(matchButtons.length, 2, '灵魂与语音匹配各有一个开始按钮');
        click(matchButtons[1]);
        await flushUi();
        assert.deepEqual(calls, [{ mode: 'voice', voiceText: '周末想逛展，也想认真聊天' }]);
        const chat = miniDom.document.querySelector('.yl-private-chat-screen');
        assert.ok(chat, 'accepted 应直接进入非空私聊会话');
        assert.match(chat.textContent, /灵魂档案/u);
        assert.doesNotMatch(chat.textContent, /never render|隐藏资料|关系分|阈值/u);
    } finally {
        mounted.destroy();
    }
});

test('feature option entries are scoped to each requested app surface', () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-feature-options',
        actionBridge: { emit() {}, isPending() { return false; } }, settingsStore: store, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    const pageOption = () => miniDom.document.querySelector('.yl-feature-options');
    const closeBinding = () => click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '关闭功能预设选项'));
    const closeForumSettings = () => click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '关闭心动社区设置'));
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        assert.ok(pageOption(), '首页应有独立选项入口');
        click(pageOption());
        assert.ok(miniDom.document.querySelector('[name="recommendation_refresh-quick-connection"]'));
        closeBinding();

        click(buttonByPage('matches'));
        click(pageOption());
        assert.ok(miniDom.document.querySelector('[name="soul_match-quick-connection"]'));
        assert.ok(miniDom.document.querySelector('[name="text_match-quick-connection"]'));
        closeBinding();

        click(buttonByPage('messages'));
        click(pageOption());
        assert.ok(miniDom.document.querySelector('[name="chat-quick-connection"]'));
        closeBinding();

        click(buttonByPage('groups'));
        assert.equal(pageOption(), null, '群组首页不应再提供聊天群/论坛的全局绑定设置');
        click(buttonByText('聊天群'));
        assert.equal(pageOption(), null, '聊天群首页不应再提供全局绑定设置');
        click(backButton());
        click(buttonByText('心动社区'));
        click(pageOption());
        assert.ok(miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '开启帖子自动更新'));
        assert.ok(miniDom.document.querySelector('[name="forum-channel-connection"]'));
        assert.ok(miniDom.document.querySelector('[name="forum-channel-prompt"]'));
        assert.ok(miniDom.document.querySelector('[name="forum-post-connection"]'));
        assert.ok(miniDom.document.querySelector('[name="forum-post-prompt"]'));
        assert.equal(miniDom.document.querySelector('[name="forum-quick-connection"]'), null);
        closeForumSettings();

        click(buttonByPage('profile'));
        click(buttonByText('创建角色'));
        click(pageOption());
        assert.ok(miniDom.document.querySelector('[name="character_ai_completion-quick-connection"]'));
        assert.ok(miniDom.document.querySelector('[name="character_full_authoring-quick-connection"]'));
    } finally {
        mounted.destroy();
    }
});
test('home empty state does not expose character creation controls', () => {
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-home-empty-actions',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null, readState: emptyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        const home = miniDom.document.querySelector('.yl-page-home');
        assert.ok(home, '首页应保持可渲染的空状态');
        assert.equal(home.querySelectorAll('button').some((node) => node.textContent.includes('创建角色')), false);
        assert.equal(home.querySelectorAll('button').some((node) => node.textContent.includes('导入角色模板')), false);
    } finally {
        mounted.destroy();
    }
});

test('profile page owns the character creator entry and its child view returns to profile', () => {
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-profile-creator',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null, readState: emptyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('profile'));
        const createCharacter = buttonByText('创建角色');
        assert.ok(createCharacter, '“我的”页面应提供创建角色入口');
        click(createCharacter);
        assert.ok(backButton(), '角色创建子界面应有返回按钮');
        assert.equal(buttonByPage('profile').getAttribute('aria-current'), 'page', '创建角色仍属于“我的”导航层级');

        click(backButton());
        assert.equal(backButton(), null, '返回后应回到“我的”一级页面');
        assert.match(miniDom.document.body.textContent, /个人资料/u);
        assert.match(miniDom.document.body.textContent, /收藏夹/u);
        assert.match(miniDom.document.body.textContent, /设置/u);
    } finally {
        mounted.destroy();
    }
});

test('my-page avatar is browser-local, while the public-profile editor no longer exposes an avatar reference field', () => {
    const storage = createMemoryStorage();
    const playerAvatarStore = createPlayerAvatarStore({ storage });
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-player-avatar-menu',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null, playerAvatarStore, readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('profile'));
        const avatar = miniDom.document.querySelector('.yl-person-avatar-button');
        assert.ok(avatar, '我的页头像框应是独立入口');
        click(avatar);
        const menu = miniDom.document.querySelector('.yl-avatar-modal');
        assert.equal(menu.hidden, false);
        assert.match(menu.textContent, /从本地导入图片|引用图片链接|移除头像/u);
        const link = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '头像图片链接');
        assert.ok(link);
        link.value = 'https://example.invalid/player-avatar.webp';
        click(buttonByText('保存图片链接'));
        assert.deepEqual(playerAvatarStore.snapshot(), { kind: 'url', url: 'https://example.invalid/player-avatar.webp' });
        const image = miniDom.document.querySelector('.yl-person-avatar-button').querySelector('img');
        assert.equal(image.getAttribute('src'), 'https://example.invalid/player-avatar.webp');

        click(buttonByText('个人资料'));
        const editor = miniDom.document.querySelector('.yl-profile-editor');
        assert.doesNotMatch(editor.textContent, /头像引用/u);
        click(backButton());
        click(miniDom.document.querySelector('.yl-person-avatar-button'));
        click(buttonByText('移除头像'));
        assert.deepEqual(playerAvatarStore.snapshot(), { kind: 'placeholder' });
    } finally {
        mounted.destroy();
    }
});

test('help popover is positioned below the question mark and clamped inside the viewport', () => {
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-help-position',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        const trigger = miniDom.document.querySelector('.yl-help-trigger');
        const popover = miniDom.document.querySelector('.yl-help-popover');
        const styles = new Map();
        trigger.getBoundingClientRect = () => ({ left: 330, bottom: 100 });
        popover.getBoundingClientRect = () => ({ width: 260, height: 100 });
        popover.style = { setProperty(name, value) { styles.set(name, value); } };

        click(trigger);

        assert.equal(popover.hidden, false);
        assert.equal(styles.get('top'), '108px');
        assert.equal(styles.get('left'), '92px');
        assert.equal(styles.get('max-height'), '524px');
    } finally {
        mounted.destroy();
    }
});

test('operation dialogs always close and dismissed AI generations never reopen or leak errors', async () => {
    let next = deferred();
    const bridge = {
        emit() {}, isPending() { return false; },
        runCandidateMatch() { return next.promise; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-ai-dialog', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        const startMatch = () => { click(buttonByPage('matches')); click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '开始匹配')); };
        startMatch();

        const dialog = miniDom.document.querySelector('.yl-operation-dialog');
        assert.equal(dialog.hidden, false);
        assert.equal(dialog.getAttribute('aria-busy'), 'true');
        assert.equal(dialog.dataset.visual, 'connecting', '通用 AI 调用应使用双心电波连接动画');
        assert.match(dialog.textContent, /灵魂匹配/u);
        const loadingControls = assertOperationCloseControls(dialog, 'loading');

        click(loadingControls.bottomClose);
        assert.equal(dialog.hidden, true, 'loading 关闭只应隐藏提示窗口');
        next.resolve({ ok: true, matchOutcome: 'accepted', npcUid: 'npc_1', sessionUid: 'chat_new' });
        await flushUi();
        assert.equal(dialog.hidden, true, '已关闭 generation 的成功结果不得重新弹窗');

        next = deferred();
        startMatch();
        next.resolve({ ok: true, matchOutcome: 'accepted', npcUid: 'npc_1', sessionUid: 'chat_new' });
        await flushUi();
        assert.equal(dialog.hidden, false);
        assert.equal(dialog.getAttribute('aria-busy'), 'false');
        assert.match(dialog.textContent, /心动连接成功/u);
        const successControls = assertOperationCloseControls(dialog, 'success');
        click(successControls.topClose);
        assert.equal(dialog.hidden, true);

        next = deferred();
        startMatch();
        assertOperationCloseControls(dialog, 'loading');
        pressKey('Escape');
        assert.equal(dialog.hidden, true, 'Escape 应关闭 loading 弹窗');
        next.reject(new Error('Authorization: Bearer sk-dismissed-secret'));
        await flushUi();
        assert.equal(dialog.hidden, true, 'Escape 关闭的 generation 后续失败也不得重弹');
        assert.doesNotMatch(miniDom.document.body.textContent, /Authorization|Bearer|sk-dismissed-secret/u);

        next = deferred();
        startMatch();
        next.reject(new Error('Authorization: Bearer sk-visible-secret-api-key'));
        await flushUi();
        assert.equal(dialog.hidden, false);
        assert.equal(dialog.getAttribute('aria-busy'), 'false');
        assert.match(dialog.textContent, /灵魂匹配未完成/u);
        assertOperationCloseControls(dialog, 'failure');
        assert.doesNotMatch(dialog.textContent, /Authorization|Bearer|sk-visible-secret|api-key/u);

        click(buttonByPage('profile'));
        click(buttonByText('设置'));
        click(buttonByText('关于软件'));
        assert.equal(dialog.hidden, false);
        assert.match(dialog.textContent, /关于软件/u);
        assertOperationCloseControls(dialog, 'info');
        pressKey('Escape');
        assert.equal(dialog.hidden, true, 'Escape 应关闭 info 弹窗');
    } finally {
        mounted.destroy();
    }
});



test('success and failure dialogs auto-close while preserving manual close controls', async () => {
    const previousSetTimeout = globalThis.setTimeout;
    const previousClearTimeout = globalThis.clearTimeout;
    const timers = [];
    globalThis.setTimeout = (callback, delay) => {
        const timer = { callback, delay, cleared: false, unref() {} };
        timers.push(timer);
        return timer;
    };
    globalThis.clearTimeout = (timer) => { if (timer) timer.cleared = true; };

    let result = { ok: true, matchOutcome: 'accepted', npcUid: 'npc_1', sessionUid: 'chat_new' };
    const bridge = {
        emit() {}, isPending() { return false; },
        async runCandidateMatch() {
            if (result instanceof Error) throw result;
            return result;
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-dialog-auto-close', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        const startMatch = () => { click(buttonByPage('matches')); click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '开始匹配')); };
        startMatch();
        await flushUi();

        const dialog = miniDom.document.querySelector('.yl-operation-dialog');
        assertOperationCloseControls(dialog, 'success');
        assert.equal(dialog.dataset.visual, 'accepted', '通用 AI 成功应切换为双心依偎动画');
        const successTimer = timers.find((timer) => timer.delay === 4000 && !timer.cleared);
        assert.ok(successTimer, '成功状态应登记自动收束计时器');
        successTimer.callback();
        assert.equal(dialog.hidden, true);

        result = new Error('Authorization Bearer auto-close-secret');
        startMatch();
        await flushUi();
        assertOperationCloseControls(dialog, 'failure');
        assert.equal(dialog.dataset.visual, 'failure', '通用 AI 失败应切换为心碎动画');
        const failureTimer = timers.find((timer) => timer.delay === 6000 && !timer.cleared);
        assert.ok(failureTimer, '失败状态应登记自动收束计时器');
        failureTimer.callback();
        assert.equal(dialog.hidden, true);
        assert.doesNotMatch(miniDom.document.body.textContent, /Authorization|Bearer|auto-close-secret/u);
    } finally {
        mounted.destroy();
        globalThis.setTimeout = previousSetTimeout;
        globalThis.clearTimeout = previousClearTimeout;
    }
});

test('page switches, phone close, and destroy invalidate pending operation dialogs', async () => {
    const requests = [];
    const bridge = {
        emit() {}, isPending() { return false; },
        runCandidateMatch() {
            const request = deferred();
            requests.push(request);
            return request.promise;
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-dialog-cleanup', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
    const startMatch = () => { click(buttonByPage('matches')); click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '开始匹配')); };
    startMatch();
    const dialog = miniDom.document.querySelector('.yl-operation-dialog');
    assert.equal(dialog.hidden, false);

    click(buttonByPage('messages'));
    assert.equal(dialog.hidden, true, '切换页面应清理操作弹窗');
    requests[0].resolve({ ok: true, draft: { reply: '页面切换后的迟到结果。' } });
    await flushUi();
    assert.equal(dialog.hidden, true, '页面切换后迟到结果不得重弹');

    startMatch();
    click(miniDom.document.querySelector('.yl-phone-close'));
    assert.equal(dialog.hidden, true, '关闭小手机应清理操作弹窗');
    requests[1].resolve({ ok: true, draft: { reply: '小手机关闭后的迟到结果。' } });
    await flushUi();
    assert.equal(dialog.hidden, true, '小手机关闭后迟到结果不得重弹');

    click(miniDom.document.querySelector('.yl-phone-launcher'));
    startMatch();
    mounted.destroy();
    assert.equal(miniDom.document.querySelector('#ylm-test-dialog-cleanup'), null);
    requests[2].resolve({ ok: true, draft: { reply: '销毁后的迟到结果。' } });
    await flushUi();
    assert.equal(miniDom.document.querySelector('.yl-operation-dialog'), null, '销毁后不得留下或重建弹窗 DOM');
});

function pointerEvent(type, properties = {}) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ pointerId: 1, button: 0, isPrimary: true, pointerType: 'mouse', clientX: 0, clientY: 0, ...properties })) {
        Object.defineProperty(event, key, { configurable: true, value });
    }
    return event;
}

function installStyleRecorder(node) {
    const values = Object.create(null);
    node.style = new Proxy({
        setProperty(name, value) { values[name] = String(value); },
        removeProperty(name) { delete values[name]; },
    }, {
        get(target, key) { return key in target ? target[key] : values[key] ?? ''; },
        set(target, key, value) { values[key] = String(value); return true; },
    });
    return values;
}

function installPointerCaptureStub(...nodes) {
    let capturedPointerId = null;
    let captureCalls = 0;
    let releaseCalls = 0;
    for (const node of nodes) {
        node.setPointerCapture = (pointerId) => { capturedPointerId = pointerId; captureCalls += 1; };
        node.hasPointerCapture = (pointerId) => capturedPointerId === pointerId;
        node.releasePointerCapture = (pointerId) => { if (capturedPointerId === pointerId) capturedPointerId = null; releaseCalls += 1; };
    }
    return {
        get capturedPointerId() { return capturedPointerId; },
        get captureCalls() { return captureCalls; },
        get releaseCalls() { return releaseCalls; },
    };
}

test('content-mode failures use the dedicated alert dialog and never restore the page feedback bar', async () => {
    const bridge = {
        emit() {}, isPending() { return false; },
        async runMvuAction(kind) {
            assert.equal(kind, 'toggle_content_mode');
            return { ok: false, code: 'mvu_replace_failed', error: 'Authorization Bearer must-not-leak' };
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-mode-failure-dialog', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('profile'));
        click(buttonByText('设置'));
        for (let index = 0; index < 5; index += 1) click(buttonByText('关于软件'));

        const toggle = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '内容模式切换');
        assert.ok(toggle, '连续点击五次后应显示内容模式滑块');
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await flushUi();

        const dialog = miniDom.document.querySelector('.yl-operation-dialog');
        assert.equal(dialog.hidden, false);
        assert.equal(dialog.dataset.state, 'failure');
        assert.equal(dialog.getAttribute('role'), 'alertdialog');
        assert.equal(dialog.getAttribute('aria-live'), 'assertive');
        assert.match(dialog.textContent, /MVU 保存本次修改时出错/u);
        assert.doesNotMatch(dialog.textContent, /Authorization|Bearer|must-not-leak/u);
        assert.equal(miniDom.document.querySelector('.yl-phone-panel .yl-phone-feedback'), null, '页面内不得重新渲染废弃反馈栏');
    } finally {
        mounted.destroy();
    }
});

test('打开的功能设置会跟随内容模式刷新到另一套本地预设', async () => {
    let mode = 'SFW';
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const readState = () => {
        const result = readyReadResult();
        result.state.软件.内容模式 = mode;
        return result;
    };
    const bridge = {
        emit() {}, isPending() { return false; },
        async runMvuAction(kind) {
            assert.equal(kind, 'toggle_content_mode');
            mode = 'NSFW';
            return { ok: true };
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-mode-feature-binding', actionBridge: bridge,
        settingsStore: store, llmClient: null, characterLibrary: null, readState,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelector('.yl-feature-options'));
        const prompt = () => miniDom.document.querySelector('[name="recommendation_refresh-quick-prompt"]');
        const selectedPromptId = () => prompt().querySelectorAll('option').find((option) => option.selected)?.value;
        const promptOptionIds = () => prompt().querySelectorAll('option').map((option) => option.value);
        assert.equal(selectedPromptId(), 'builtin_recommendation_sfw');
        assert.equal(promptOptionIds().includes('builtin_recommendation_sfw'), true);
        assert.equal(promptOptionIds().includes('builtin_recommendation_nsfw'), false);
        assert.match(miniDom.document.querySelector('.yl-feature-binding-modal').textContent, /SFW/u);

        click(buttonByPage('profile'));
        click(buttonByText('设置'));
        for (let index = 0; index < 5; index += 1) click(buttonByText('关于软件'));
        const toggle = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '内容模式切换');
        assert.ok(toggle);
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await flushUi();

        assert.equal(selectedPromptId(), 'builtin_recommendation_nsfw');
        assert.equal(promptOptionIds().includes('builtin_recommendation_nsfw'), true);
        assert.equal(promptOptionIds().includes('builtin_recommendation_sfw'), false);
        assert.match(miniDom.document.querySelector('.yl-feature-binding-modal').textContent, /NSFW/u);
    } finally {
        mounted.destroy();
    }
});

test('launcher drag is wired into app-shell, suppresses the drag click, and keeps the next click usable', () => {
    const previousDefaultView = miniDom.document.defaultView;
    miniDom.document.defaultView = { innerWidth: 320, innerHeight: 240 };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-launcher-drag-integration',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        const launcher = miniDom.document.querySelector('.yl-phone-launcher');
        const panel = miniDom.document.querySelector('.yl-phone-panel');
        launcher.style = { position: '', left: '', top: '', right: '', bottom: '', touchAction: 'manipulation', setProperty(name, value) { this[name] = value; } };
        launcher.getBoundingClientRect = () => {
            const fixed = launcher.style.position === 'fixed';
            const left = fixed ? Number.parseFloat(launcher.style.left) : 20;
            const top = fixed ? Number.parseFloat(launcher.style.top) : 30;
            return { left, top, width: 56, height: 56, right: left + 56, bottom: top + 56 };
        };

        launcher.dispatchEvent(pointerEvent('pointerdown', { pointerId: 21, clientX: 40, clientY: 50 }));
        miniDom.document.dispatchEvent(pointerEvent('pointermove', { pointerId: 21, clientX: 100, clientY: 110 }));
        miniDom.document.dispatchEvent(pointerEvent('pointerup', { pointerId: 21, clientX: 100, clientY: 110 }));

        assert.equal(launcher.style.position, 'fixed');
        assert.equal(launcher.style.left, '80px');
        assert.equal(launcher.style.top, '90px');
        click(launcher);
        assert.equal(panel.hidden, true, '拖动结束后的合成 click 不得打开窗口');
        click(launcher);
        assert.equal(panel.hidden, false, '下一次普通点击仍应打开窗口');
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
    }
});

test('phone header pointer drag clamps the panel, cancels cleanly, and ignores the close button', () => {
    const previousDefaultView = miniDom.document.defaultView;
    const previousDocumentElement = miniDom.document.documentElement;
    miniDom.document.defaultView = { innerWidth: 400, innerHeight: 300 };
    miniDom.document.documentElement = { clientWidth: 400, clientHeight: 300 };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-panel-drag',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null, readState: emptyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        const panel = miniDom.document.querySelector('.yl-phone-panel');
        const header = miniDom.document.querySelector('.yl-phone-header');
        const close = miniDom.document.querySelector('.yl-phone-close');
        assert.ok(panel && header && close);
        const styles = installStyleRecorder(panel);
        panel.getBoundingClientRect = () => ({ left: 100, top: 50, right: 300, bottom: 200, width: 200, height: 150 });
        const capture = installPointerCaptureStub(header, panel);

        header.dispatchEvent(pointerEvent('pointerdown', { pointerId: 7, clientX: 150, clientY: 80 }));
        assert.equal(capture.capturedPointerId, 7, '拖动开始后应捕获当前 pointer');
        header.dispatchEvent(pointerEvent('pointermove', { pointerId: 7, clientX: -100, clientY: -100 }));
        assert.equal(styles.left, '0px');
        assert.equal(styles.top, '0px');

        header.dispatchEvent(pointerEvent('pointermove', { pointerId: 7, clientX: 1000, clientY: 1000 }));
        assert.equal(styles.left, '200px', '右边界应限制为 viewport 宽度减 panel 宽度');
        assert.equal(styles.top, '150px', '下边界应限制为 viewport 高度减 panel 高度');

        header.dispatchEvent(pointerEvent('pointercancel', { pointerId: 7, clientX: 1000, clientY: 1000 }));
        assert.equal(capture.capturedPointerId, null);
        assert.ok(capture.releaseCalls >= 1, 'pointercancel 应释放捕获');
        const cancelledPosition = { left: styles.left, top: styles.top };
        header.dispatchEvent(pointerEvent('pointermove', { pointerId: 7, clientX: 20, clientY: 20 }));
        assert.deepEqual({ left: styles.left, top: styles.top }, cancelledPosition, '取消后继续移动不得改变位置');

        const closePointerDown = pointerEvent('pointerdown', { pointerId: 9, clientX: 290, clientY: 60 });
        Object.defineProperty(closePointerDown, 'target', { configurable: true, value: close });
        const captureCallsBeforeClose = capture.captureCalls;
        header.dispatchEvent(closePointerDown);
        assert.equal(capture.captureCalls, captureCallsBeforeClose, '关闭按钮不得启动 header 拖动');
        click(close);
        assert.equal(panel.hidden, true);
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
        miniDom.document.documentElement = previousDocumentElement;
    }
});

test('home candidate card is a request-free visual shell with public info, keywords, and exactly four actions', () => {
    const readResult = readyReadResult();
    const candidate = readResult.state.角色池.npc_1;
    candidate.公开资料.头像引用 = 'https://example.invalid/candidate-background.webp';
    candidate.仅好友资料 = { 私密备注: 'friend-only-secret' };
    candidate.隐藏资料 = { 实际年龄: 28, 私密备注: 'hidden-candidate-secret' };
    candidate.偏好与边界 = 'internal-boundary-secret';
    let networkRequests = 0;
    const previousFetch = globalThis.fetch;
    const previousImage = globalThis.Image;
    globalThis.fetch = async () => { networkRequests += 1; throw new Error('candidate card must not fetch'); };
    globalThis.Image = class RequestCountingImage { set src(_value) { networkRequests += 1; } };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-candidate-shell',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        const card = miniDom.document.querySelector('.yl-candidate-card');
        assert.ok(card);
        const backgroundSlot = card.querySelector('.yl-candidate-image-slot');
        assert.ok(backgroundSlot, '候选卡应保留由宿主/CSS 接管的图片背景槽');
        assert.equal(backgroundSlot.tagName, 'DIV');
        assert.equal(backgroundSlot.classList.contains('yl-candidate-background-slot'), true);
        assert.equal(backgroundSlot.classList.contains('yl-candidate-image-slot'), true);
        assert.equal(backgroundSlot.getAttribute('src'), null, '背景槽不应创建主动加载图片的 src');

        const detailTrigger = card.querySelectorAll('span').find((node) => node.getAttribute('role') === 'button');
        assert.ok(detailTrigger, '候选头像应提供不占用操作按钮数量的详情入口');
        assert.equal(detailTrigger.getAttribute('tabindex'), '0');

        assert.match(card.textContent, /公开候选人/u);
        assert.match(card.textContent, /25-29/u);
        assert.match(card.textContent, /上海/u);
        assert.match(card.textContent, /电影/u);
        assert.match(card.textContent, /夜猫子/u);
        assert.match(card.textContent, /直接/u);
        assert.match(card.textContent, /慢热/u);
        assert.doesNotMatch(card.textContent, /friend-only-secret|hidden-candidate-secret|internal-boundary-secret/u);
        assert.doesNotMatch(card.textContent, /创建角色|导入角色模板|快速随机创建候选人/u);

        const cardButtons = card.querySelectorAll('button');
        assert.equal(cardButtons.length, 4, '候选卡除四个操作外不应混入额外按钮');
        assert.deepEqual(cardButtons.map((node) => node.getAttribute('aria-label')), ['喜欢', '不喜欢', '收藏', '刷新']);
        assert.equal(networkRequests, 0, '渲染背景预留槽不得触发 fetch 或 Image 请求');
    } finally {
        mounted.destroy();
        if (previousFetch === undefined) delete globalThis.fetch; else globalThis.fetch = previousFetch;
        if (previousImage === undefined) delete globalThis.Image; else globalThis.Image = previousImage;
    }
});

test('a saved favourite exposes only cancellation and a dating-app private-chat action', async () => {
    const readResult = readyReadResult();
    delete readResult.state.推荐.临时候选池.npc_1;
    readResult.state.推荐.当前队列 = [];
    readResult.state.推荐.收藏角色UID = ['npc_1'];
    const calls = [];
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-unfavorite-action',
        actionBridge: {
            emit() {}, isPending() { return false; },
            async runMvuAction(kind, npcUid) { calls.push([kind, npcUid]); return { ok: true }; },
        },
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('profile'));
        click(buttonByText('收藏夹'));
        const actions = miniDom.document.querySelector('.yl-favorite-card').querySelectorAll('button');
        assert.deepEqual(actions.map((node) => node.getAttribute('aria-label')), ['取消收藏', '发起私聊']);
        click(actions.find((node) => node.getAttribute('aria-label') === '取消收藏'));
        await flushUi();
        assert.deepEqual(calls, [['unfavorite', 'npc_1']]);
    } finally {
        mounted.destroy();
    }
});

test('accepted favourite invitation leaves favourites and opens the newly established private chat', async () => {
    const readResult = readyReadResult();
    delete readResult.state.推荐.临时候选池.npc_1;
    readResult.state.推荐.当前队列 = [];
    readResult.state.推荐.收藏角色UID = ['npc_1'];
    readResult.state.角色池.npc_1.与玩家关系.状态 = '陌生';
    const calls = [];
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-favourite-private-invite',
        actionBridge: {
            emit() {}, isPending() { return false; },
            async runMvuAction(kind, npcUid) {
                calls.push([kind, npcUid]);
                readResult.state.推荐.收藏角色UID = [];
                readResult.state.角色池.npc_1.与玩家关系.状态 = '已匹配';
                readResult.state.会话.chat_1 = { 对象UID: 'npc_1', 状态: '已匹配', 最近消息: [], 长期摘要: '', 已确认边界: '', 已确认承诺: '' };
                return { ok: true, sessionUid: 'chat_1', invitationOutcome: 'accepted' };
            },
        },
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('profile'));
        click(buttonByText('收藏夹'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发起私聊'));
        await flushUi();
        assert.deepEqual(calls, [['start_private_chat', 'npc_1']]);
        assert.ok(miniDom.document.querySelector('.yl-private-chat-screen'), '仅接受后才进入消息会话');
        assert.equal(miniDom.document.querySelector('.yl-operation-dialog').dataset.visual, 'accepted');
        assert.equal(readResult.state.推荐.收藏角色UID.length, 0);
        click(buttonByPage('profile'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '设置'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '控制台'));
        const consolePage = miniDom.document.querySelector('.yl-operation-console');
        assert.match(consolePage.textContent, /收藏主动私聊|私聊邀请已接受/u);
        assert.doesNotMatch(consolePage.textContent, /npc_1|chat_1|Patch|stat_data/u);
    } finally {
        mounted.destroy();
    }
});

test('declined favourite invitation stays out of messages and reports a safe rejection', async () => {
    const readResult = readyReadResult();
    delete readResult.state.推荐.临时候选池.npc_1;
    readResult.state.推荐.当前队列 = [];
    readResult.state.推荐.收藏角色UID = ['npc_1'];
    readResult.state.角色池.npc_1.与玩家关系.状态 = '陌生';
    const calls = [];
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-favourite-private-decline',
        actionBridge: {
            emit() {}, isPending() { return false; },
            async runMvuAction(kind, npcUid) {
                calls.push([kind, npcUid]);
                readResult.state.推荐.收藏角色UID = [];
                readResult.state.角色池.npc_1.与玩家关系.状态 = '已取消';
                return { ok: true, sessionUid: '', invitationOutcome: 'declined' };
            },
        },
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('profile'));
        click(buttonByText('收藏夹'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发起私聊'));
        await flushUi();
        assert.deepEqual(calls, [['start_private_chat', 'npc_1']]);
        assert.equal(miniDom.document.querySelector('.yl-private-chat-screen'), null, '婉拒不得创建或打开私聊会话');
        assert.match(miniDom.document.body.textContent, /暂时没有接受这次私聊邀请/u);
        assert.equal(miniDom.document.querySelector('.yl-operation-dialog').dataset.visual, 'declined');
        assert.equal(readResult.state.会话.chat_1, undefined);
    } finally {
        mounted.destroy();
    }
});


test('declined match stays on matches and never opens an empty session', async () => {
    const opened = [];
    const bridge = { emit() {}, isPending() { return false; }, async runCandidateMatch() { return { ok: true, matchOutcome: 'declined', npcUid: 'npc_declined', sessionUid: '' }; } };
    const mounted = mountPhoneApp({ documentRef: miniDom.document, rootId: 'ylm-test-declined-match', actionBridge: bridge, settingsStore: createSettingsStore({ storage: createMemoryStorage() }), llmClient: null, characterLibrary: null, readState: readyReadResult });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('matches'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '开始匹配'));
        await flushUi();
        assert.match(miniDom.document.body.textContent, /灵魂匹配|语音匹配/u);
        assert.equal(miniDom.document.querySelector('.yl-private-chat-screen'), null);
        assert.match(miniDom.document.body.textContent, /婉拒/u);
        assert.equal(miniDom.document.querySelector('.yl-operation-dialog').dataset.visual, 'declined');
        assert.deepEqual(opened, []);
    } finally { mounted.destroy(); }
});

test('home feedback actions save before generating next candidate while refresh and unfavorite stay single-purpose', async () => {
    const calls = [];
    let next = { ok: true };
    const bridge = {
        emit() {}, isPending() { return false; },
        async runMvuAction(kind, uid) { calls.push(['save', kind, uid]); return { ok: true }; },
        async runRecommendationInitialCandidate() { calls.push(['next']); return next; },
        async runRecommendationRefresh(uid) { calls.push(['refresh', uid]); return { ok: true }; },
    };
    const mounted = mountPhoneApp({ documentRef: miniDom.document, rootId: 'ylm-test-home-auto-next', actionBridge: bridge, settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '喜欢')); await flushUi();
        assert.deepEqual(calls.splice(0), [['save', 'like', 'npc_1'], ['next']]);
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '刷新')); await flushUi();
        assert.deepEqual(calls.splice(0), [['refresh', 'npc_1']]);
        next = { ok: false, message: '下一位服务暂时不可用' };
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '不喜欢')); await flushUi();
        assert.deepEqual(calls.splice(0), [['save', 'dislike', 'npc_1'], ['next']]);
        assert.match(miniDom.document.body.textContent, /不喜欢反馈已保存.*下一位候选人生成失败/u);
        click(buttonByPage('profile'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '设置'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '控制台'));
        assert.match(miniDom.document.querySelector('.yl-operation-console').textContent, /首页推荐/u);
        assert.doesNotMatch(miniDom.document.querySelector('.yl-operation-console').textContent, /npc_1|Patch|stat_data|UID/u);
    } finally { mounted.destroy(); }
});

test('initial home candidate generation is visible in the safe operation console', async () => {
    const calls = [];
    const bridge = {
        emit() {}, isPending() { return false; },
        async runRecommendationInitialCandidate() { calls.push('initial'); return { ok: true }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-home-initial-console', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: emptyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '刷新'));
        await flushUi();
        assert.deepEqual(calls, ['initial']);
        click(buttonByPage('profile'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '设置'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '控制台'));
        const consoleText = miniDom.document.querySelector('.yl-operation-console').textContent;
        assert.match(consoleText, /首页推荐|首位候选人已通过/u);
        assert.doesNotMatch(consoleText, /UID|Patch|stat_data|npc_/u);
    } finally { mounted.destroy(); }
});

test('closed match and favourite result dialogs never reopen when async results arrive', async () => {
    const matchRequest = deferred();
    const favoriteRequest = deferred();
    const matchRead = readyReadResult();
    const matchMounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-closed-match-result', actionBridge: {
            emit() {}, isPending() { return false; }, runCandidateMatch() { return matchRequest.promise; },
        }, settingsStore: createSettingsStore({ storage: createMemoryStorage() }), llmClient: null, characterLibrary: null, readState: () => matchRead,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('matches'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '开始匹配'));
        const dialog = miniDom.document.querySelector('.yl-operation-dialog');
        click(dialog.querySelector('.yl-dialog-close'));
        matchRequest.resolve({ ok: true, matchOutcome: 'declined', npcUid: 'npc_declined', sessionUid: '' });
        await flushUi();
        assert.equal(dialog.hidden, true, '关闭匹配弹窗后婉拒结果不得重弹');
    } finally { matchMounted.destroy(); }

    const favoriteRead = readyReadResult();
    delete favoriteRead.state.推荐.临时候选池.npc_1;
    favoriteRead.state.推荐.当前队列 = [];
    favoriteRead.state.推荐.收藏角色UID = ['npc_1'];
    const favoriteMounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-closed-favourite-result', actionBridge: {
            emit() {}, isPending() { return false; }, runMvuAction() { return favoriteRequest.promise; },
        }, settingsStore: null, llmClient: null, characterLibrary: null, readState: () => favoriteRead,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('profile'));
        click(buttonByText('收藏夹'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发起私聊'));
        const dialog = miniDom.document.querySelector('.yl-operation-dialog');
        click(dialog.querySelector('.yl-dialog-close'));
        favoriteRequest.resolve({ ok: true, invitationOutcome: 'declined', sessionUid: '' });
        await flushUi();
        assert.equal(dialog.hidden, true, '关闭收藏私聊弹窗后婉拒结果不得重弹');
    } finally { favoriteMounted.destroy(); }
});

test('closing a pending romance dialog or phone prevents an accepted result from navigating later', async () => {
    const matchRequest = deferred();
    const matchMounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-closed-match-navigation', actionBridge: {
            emit() {}, isPending() { return false; }, runCandidateMatch() { return matchRequest.promise; },
        }, settingsStore: createSettingsStore({ storage: createMemoryStorage() }), llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('matches'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '开始匹配'));
        const dialog = miniDom.document.querySelector('.yl-operation-dialog');
        click(miniDom.document.querySelector('.yl-phone-close'));
        matchRequest.resolve({ ok: true, matchOutcome: 'accepted', npcUid: 'npc_1', sessionUid: 'chat_1' });
        await flushUi();

        assert.equal(dialog.hidden, true, '收起小手机后接受结果不得重弹');
        click(miniDom.document.querySelector('.yl-phone-launcher'));
        assert.equal(miniDom.document.querySelector('.yl-private-chat-screen'), null, '收起小手机后接受结果不得强制打开私聊');
        assert.equal(buttonByPage('matches').getAttribute('aria-current'), 'page');
        click(buttonByPage('profile'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '设置'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '控制台'));
        const consoleText = miniDom.document.querySelector('.yl-operation-console').textContent;
        assert.match(consoleText, /灵魂匹配.*已关闭.*提示已关闭，结果未展示/u);
        assert.doesNotMatch(consoleText, /进行中/u);
    } finally { matchMounted.destroy(); }

    const favoriteRequest = deferred();
    const favoriteRead = readyReadResult();
    delete favoriteRead.state.推荐.临时候选池.npc_1;
    favoriteRead.state.推荐.当前队列 = [];
    favoriteRead.state.推荐.收藏角色UID = ['npc_1'];
    const favoriteMounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-closed-favourite-navigation', actionBridge: {
            emit() {}, isPending() { return false; }, runMvuAction() { return favoriteRequest.promise; },
        }, settingsStore: createSettingsStore({ storage: createMemoryStorage() }), llmClient: null, characterLibrary: null, readState: () => favoriteRead,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('profile'));
        click(buttonByText('收藏夹'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发起私聊'));
        const dialog = miniDom.document.querySelector('.yl-operation-dialog');
        click(dialog.querySelector('.yl-dialog-close'));
        favoriteRequest.resolve({ ok: true, invitationOutcome: 'accepted', sessionUid: 'chat_1' });
        await flushUi();

        assert.equal(dialog.hidden, true, '关闭收藏私聊弹窗后接受结果不得重弹');
        assert.ok(miniDom.document.querySelector('.yl-favorite-card'), '关闭提示后接受结果不得强制离开收藏夹');
        click(buttonByPage('profile'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '设置'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '控制台'));
        const consoleText = miniDom.document.querySelector('.yl-operation-console').textContent;
        assert.match(consoleText, /收藏主动私聊.*已关闭.*提示已关闭，结果未展示/u);
        assert.doesNotMatch(consoleText, /进行中/u);
    } finally { favoriteMounted.destroy(); }
});

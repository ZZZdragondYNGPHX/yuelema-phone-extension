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

/* P3-D：hub 入口迁移 ListRow（div[role=button]）后，可点目标 = 原生按钮 ∪ .yl-hub-entry 行 */
function clickTargets() {
    return [
        ...miniDom.document.querySelectorAll('button'),
        ...miniDom.document.querySelectorAll('.yl-hub-entry'),
    ];
}

function buttonByText(text) {
    return clickTargets().find((node) => node.textContent.includes(text));
}

function buttonByPage(page) {
    return clickTargets().find((node) => node.dataset.page === page);
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

test('layout preference is browser-local and the profile header toggles the same focused device button in place', async () => {
    const storage = createMemoryStorage();
    const actionCalls = [];
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-ui-layout-toggle', uiLayoutStorage: storage,
        actionBridge: { emit(...args) { actionCalls.push(args); }, isPending() { return false; } }, settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        assert.equal(miniDom.document.querySelector('.yl-ui-layout-toggle'), null, '布局按钮不得占用发现页的页头空间');
        click(buttonByPage('profile'));
        actionCalls.length = 0;
        const root = miniDom.document.querySelector('.yl-phone-extension');
        const panel = miniDom.document.querySelector('.yl-phone-panel');
        const content = miniDom.document.querySelector('.yl-phone-content');
        const toggle = miniDom.document.querySelector('.yl-ui-layout-toggle');
        assert.ok(toggle, '只有顶级“我的”页应渲染布局切换按钮');
        assert.equal(root.dataset.uiLayout, 'phone');
        assert.equal(panel.dataset.uiLayout, 'phone');
        assert.match(toggle.getAttribute('aria-label'), /当前为手机端界面，切换到电脑端界面/u);
        assert.equal(toggle.getAttribute('title'), toggle.getAttribute('aria-label'));
        assert.equal(toggle.dataset.uiLayout, 'phone');
        assert.equal(toggle.textContent, '', '设备按钮在窄屏只展示图标');
        assert.equal(toggle.querySelector('svg').dataset.layoutIcon, 'phone');
        assert.equal(toggle.querySelector('svg').getAttribute('aria-hidden'), 'true');
        assert.equal(toggle.querySelector('svg').getAttribute('focusable'), 'false');

        content.scrollTop = 137;
        toggle.focus();
        click(toggle);
        await flushUi();
        assert.strictEqual(miniDom.document.querySelector('.yl-ui-layout-toggle'), toggle, '布局切换不得通过 renderPage 重建按钮');
        assert.strictEqual(miniDom.document.activeElement, toggle, '原地更新 SVG 后应保留按钮焦点');
        assert.equal(content.scrollTop, 137, '布局切换不得重建内容或重置滚动位置');
        assert.equal(root.dataset.uiLayout, 'desktop');
        assert.equal(panel.dataset.uiLayout, 'desktop');
        assert.equal(storage.getItem('yuelema.ui-layout/v1'), 'desktop', '布局仅写入浏览器本地存储');
        assert.match(toggle.getAttribute('aria-label'), /当前为电脑端界面，切换到手机端界面/u);
        assert.equal(toggle.dataset.uiLayout, 'desktop');
        assert.equal(toggle.querySelector('svg').dataset.layoutIcon, 'desktop');
        assert.match(miniDom.document.querySelector('.yl-ui-layout-status').textContent, /已切换到电脑端界面/u);
        assert.equal(root.dataset.contentMode, 'SFW', '布局切换不得混入内容模式');
        assert.deepEqual(actionCalls, [], '布局切换不得进入 action bridge 或 MVU');

        click(buttonByPage('settings_connections'));
        assert.equal(miniDom.document.querySelector('.yl-ui-layout-toggle'), null, '布局按钮只属于顶级“我的”页');
    } finally { mounted.destroy(); }
});

test('layout preference restores desktop on remount and invalid or unreadable values fall back to phone', async () => {
    const storage = createMemoryStorage();
    storage.setItem('yuelema.ui-layout/v1', 'desktop');
    const mountWith = (rootId, uiLayoutStorage) => mountPhoneApp({
        documentRef: miniDom.document, rootId, uiLayoutStorage,
        actionBridge: { emit() {}, isPending() { return false; } }, settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });

    const persisted = mountWith('ylm-test-ui-layout-persisted', storage);
    try {
        const root = miniDom.document.querySelector('.yl-phone-extension');
        assert.equal(root.dataset.uiLayout, 'desktop');
        click(miniDom.document.querySelector('.yl-phone-launcher'));
        click(buttonByPage('profile'));
        assert.equal(miniDom.document.querySelector('.yl-ui-layout-toggle').querySelector('svg').dataset.layoutIcon, 'desktop');
    } finally { persisted.destroy(); }

    for (const [rootId, uiLayoutStorage] of [
        ['ylm-test-ui-layout-invalid', { getItem() { return 'tablet'; }, setItem() {} }],
        ['ylm-test-ui-layout-read-error', { getItem() { throw new Error('private storage detail'); }, setItem() {} }],
        ['ylm-test-ui-layout-unavailable', null],
    ]) {
        const mounted = mountWith(rootId, uiLayoutStorage);
        try { assert.equal(miniDom.document.querySelector('.yl-phone-extension').dataset.uiLayout, 'phone'); }
        finally { mounted.destroy(); }
    }
    await flushUi();
});

test('layout storage write failure silently preserves phone without rebuilding UI or emitting actions', async () => {
    const actionCalls = [];
    const storage = { getItem() { return null; }, setItem() { throw new Error('QuotaExceeded: private detail'); } };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-ui-layout-write-error', uiLayoutStorage: storage,
        actionBridge: { emit(...args) { actionCalls.push(args); }, isPending() { return false; } }, settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelector('.yl-phone-launcher'));
        click(buttonByPage('profile'));
        actionCalls.length = 0;
        const toggle = miniDom.document.querySelector('.yl-ui-layout-toggle');
        toggle.focus();
        click(toggle);
        await flushUi();
        assert.strictEqual(miniDom.document.querySelector('.yl-ui-layout-toggle'), toggle);
        assert.strictEqual(miniDom.document.activeElement, toggle);
        assert.equal(miniDom.document.querySelector('.yl-phone-extension').dataset.uiLayout, 'phone');
        assert.equal(toggle.querySelector('svg').dataset.layoutIcon, 'phone');
        assert.match(miniDom.document.querySelector('.yl-ui-layout-status').textContent, /已保留手机端界面/u);
        assert.doesNotMatch(miniDom.document.body.textContent, /QuotaExceeded|private detail/u);
        assert.deepEqual(actionCalls, []);
    } finally { mounted.destroy(); }
});
test('desktop dragging remains clamped and switching back to phone restores centered geometry', async () => {
    const previousDefaultView = miniDom.document.defaultView;
    const previousDocumentElement = miniDom.document.documentElement;
    miniDom.document.defaultView = { innerWidth: 400, innerHeight: 300 };
    miniDom.document.documentElement = { clientWidth: 400, clientHeight: 300 };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-ui-layout-clamp', uiLayoutStorage: createMemoryStorage(),
        actionBridge: { emit() {}, isPending() { return false; } }, settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelector('.yl-phone-launcher'));
        click(buttonByPage('profile'));
        const panel = miniDom.document.querySelector('.yl-phone-panel');
        const header = miniDom.document.querySelector('.yl-phone-header');
        const toggle = miniDom.document.querySelector('.yl-ui-layout-toggle');
        const styles = installStyleRecorder(panel);
        panel.getBoundingClientRect = () => {
            const localLeft = Number.parseFloat(styles.left);
            const localTop = Number.parseFloat(styles.top);
            const left = Number.isFinite(localLeft) ? localLeft + 30 : 100;
            const top = Number.isFinite(localTop) ? localTop + 15 : 50;
            const width = panel.dataset.uiLayout === 'desktop' ? 350 : 200;
            const height = panel.dataset.uiLayout === 'desktop' ? 240 : 150;
            return { left, top, width, height, right: left + width, bottom: top + height };
        };

        click(toggle);
        assert.equal(panel.dataset.uiLayout, 'desktop');
        assert.equal(styles.left, undefined, '未拖动时切换不得把 CSS right/bottom 锚点改成 left/top');
        assert.equal(styles.top, undefined);
        header.dispatchEvent(pointerEvent('pointerdown', { pointerId: 71, clientX: 150, clientY: 80 }));
        header.dispatchEvent(pointerEvent('pointermove', { pointerId: 71, clientX: 260, clientY: 160 }));
        header.dispatchEvent(pointerEvent('pointerup', { pointerId: 71, clientX: 260, clientY: 160 }));
        assert.equal(styles.left, '20px', '电脑端拖动应限制在当前 viewport 内，并保留 transform 偏移补偿');
        assert.equal(styles.top, '45px');

        click(toggle);
        await flushUi();
        assert.equal(panel.dataset.uiLayout, 'phone');
        assert.equal(styles.left, undefined, '回到手机布局必须清除 desktop 的自定义拖动坐标');
        assert.equal(styles.top, undefined);
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
        miniDom.document.documentElement = previousDocumentElement;
    }
});
test('all routed child pages keep a top-left back button and settings views stay isolated', async () => {
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
        await flushUi(); // P2-C：社区 Hub 已砍掉，异步直达上次停留 tab（默认广场）
        assert.ok(backButton(), '广场 tab 作为路由子页应有返回按钮');
        const communitySeg = miniDom.document.querySelector('.yl-seg');
        assert.ok(communitySeg, '社区应提供广场/群聊 SegmentedControl');
        click(communitySeg.querySelectorAll('.yl-seg__item').find((node) => node.dataset.segmentId === 'chat'));
        assert.ok(backButton(), '群聊 tab 作为路由子页应有返回按钮');

        click(buttonByPage('profile'));
        click(buttonByText('编辑公开资料'));
        assert.ok(backButton(), '个人资料子页应有返回按钮');
        click(backButton());
        click(buttonByText('收藏夹'));
        assert.ok(backButton(), '收藏夹子页应有返回按钮');
        click(backButton());
        /* E1 裁平：设置目录页已删除，各设置详情直接从「我的」进入 */
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

        click(buttonByText('隐私与总结'));
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
            readResult.state.会话.chat_2 = { 对象UID: 'npc_match_2', 状态: '已匹配', 最近消息: [], 已确认边界: '', 已确认承诺: '' };
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
        assert.match(miniDom.document.body.textContent, /灵魂匹配/u);
        assert.match(miniDom.document.body.textContent, /描述匹配/u);
        /* Segmented 切换：默认灵魂模式无描述输入，切到描述模式后出现 */
        const seg = miniDom.document.querySelector('.yl-seg');
        assert.ok(seg, '匹配页应提供灵魂/描述 SegmentedControl');
        assert.equal(seg.querySelectorAll('.yl-seg__item').length, 2);
        assert.equal(miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '描述匹配文字描述'), undefined, '灵魂模式不渲染描述输入');
        click(seg.querySelectorAll('.yl-seg__item').find((node) => node.dataset.segmentId === 'voice'));
        const input = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '描述匹配文字描述');
        assert.ok(input, '描述模式应提供独立文字输入框');
        input.value = '周末想逛展，也想认真聊天';
        input.dispatchEvent(new Event('input'));
        const matchButtons = miniDom.document.querySelectorAll('button').filter((node) => node.textContent === '开始匹配');
        assert.equal(matchButtons.length, 1, 'Hero 卡只保留一个开始匹配主钮');
        click(matchButtons[0]);
        await flushUi();
        assert.deepEqual(calls, [{ mode: 'voice', voiceText: '周末想逛展，也想认真聊天' }]);
        /* 成功 = It's a Match 全屏浮层：分数环 + 公开理由 chips，不自动进入私聊 */
        const overlay = miniDom.document.querySelector('.yl-match-overlay');
        assert.ok(overlay, 'accepted 应弹出 It’s a Match 浮层');
        assert.match(overlay.textContent, /It's a Match/u);
        assert.ok(overlay.querySelector('.yl-score-ring'), '成功浮层应展示同频度分数环');
        assert.match(overlay.textContent, /91%/u);
        const chips = overlay.querySelectorAll('.yl-chip').map((node) => node.textContent);
        assert.ok(chips.length >= 2 && chips.length <= 4, '同频理由应为 2~4 个 chips');
        for (const chip of chips) {
            assert.ok(['电影', '夜猫子', '直接', '慢热', '聊天后约会', '上海'].includes(chip), `理由 chip 只允许公开关键词：${chip}`);
        }
        assert.doesNotMatch(overlay.textContent, /never render|隐藏资料|关系分|阈值|npc_match/u, '成功浮层不得泄露隐藏字段或内部标识');
        assert.equal(miniDom.document.querySelector('.yl-private-chat-screen'), null, '成功浮层未确认前不得自动进入私聊');
        click(overlay.querySelectorAll('button').find((node) => node.textContent.includes('开始聊天')));
        const chat = miniDom.document.querySelector('.yl-private-chat-screen');
        assert.ok(chat, '点击开始聊天后进入非空私聊会话');
        assert.match(chat.textContent, /灵魂档案/u);
        assert.equal(miniDom.document.querySelector('.yl-match-overlay'), null, '进入私聊后浮层关闭');
        assert.doesNotMatch(chat.textContent, /never render|隐藏资料|关系分|阈值/u);
    } finally {
        mounted.destroy();
    }
});

test('feature option entries are scoped to each requested app surface', async () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-feature-options',
        actionBridge: { emit() {}, isPending() { return false; } }, settingsStore: store, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    const pageOption = () => miniDom.document.querySelector('.yl-feature-options');
    const closeBinding = () => click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '关闭功能预设选项'));
    const closeForumSettings = () => click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '关闭社区设置'));
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
        assert.equal(pageOption(), null, '社区跳转过渡帧不应提供全局绑定设置');
        await flushUi(); // P2-C：社区 Hub 已砍掉，异步直达广场 tab
        assert.equal(pageOption(), null, '社区广场不再渲染壳层「设置」钮，入口由 topbar「⋯」承担');
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '社区设置'));
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
        assert.match(menu.textContent, /从本地导入图片|不加载网络图片链接|移除头像/u);
        assert.doesNotMatch(menu.textContent, /引用图片链接|保存图片链接/u);
        assert.ok(miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('type') === 'file'));
        assert.equal(miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '头像图片链接'), undefined);
        assert.deepEqual(playerAvatarStore.snapshot(), { kind: 'placeholder' });

        click(buttonByText('编辑公开资料'));
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

test('character public profile avatar opens the shared local menu and uses the uid-scoped saved avatar', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const removed = [];
    const characterAvatarStore = {
        snapshot(uid) { return uid === 'npc_1' && !removed.includes(uid) ? { kind: 'embedded', dataUrl: png } : { kind: 'placeholder' }; },
        async setAvatar() {},
        async removeAvatar(uid) { removed.push(uid); },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-character-avatar-menu',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null, characterAvatarStore, readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        const cardAvatar = miniDom.document.querySelectorAll('.yl-candidate-avatar')
            .find((node) => node.getAttribute('aria-label') === '查看公开候选人的公开资料');
        assert.ok(cardAvatar);
        assert.equal(cardAvatar.querySelector('img')?.getAttribute('src'), png, '首页应优先显示按角色 UID 保存的本地头像');
        click(cardAvatar);
        const detailAvatar = miniDom.document.querySelector('.yl-public-profile')?.querySelector('.yl-candidate-avatar');
        assert.equal(detailAvatar.getAttribute('aria-label'), '更换公开候选人的头像');
        click(detailAvatar);
        const menu = miniDom.document.querySelector('.yl-avatar-modal');
        assert.equal(menu.hidden, false);
        assert.match(menu.textContent, /更换公开候选人的头像|从本地导入图片|移除头像/u);
        click(buttonByText('移除头像'));
        await flushUi();
        assert.deepEqual(removed, ['npc_1']);
        assert.equal(miniDom.document.querySelector('.yl-public-profile')?.querySelector('.yl-candidate-avatar')?.querySelector('img'), null);
    } finally {
        mounted.destroy();
    }
});

test('operation dialogs always close and dismissed AI generations never reopen or leak errors', async () => {
    /* P2-B 后匹配流程改为页面内光环/结果卡，不再走操作弹窗；
       弹窗机制回归改用仍走 romance 弹窗的收藏主动私聊流程作为载体。 */
    let next = deferred();
    const readResult = readyReadResult();
    delete readResult.state.推荐.临时候选池.npc_1;
    readResult.state.推荐.当前队列 = [];
    readResult.state.推荐.收藏角色UID = ['npc_1'];
    readResult.state.角色池.npc_1.与玩家关系.状态 = '陌生';
    const bridge = {
        emit() {}, isPending() { return false; },
        runMvuAction() { return next.promise; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-ai-dialog', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        const startInvite = () => {
            click(buttonByPage('profile'));
            click(buttonByText('收藏夹'));
            click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发起私聊'));
        };
        startInvite();

        const dialog = miniDom.document.querySelector('.yl-operation-dialog');
        assert.equal(dialog.hidden, false);
        assert.equal(dialog.getAttribute('aria-busy'), 'true');
        assert.equal(dialog.dataset.visual, 'connecting', '恋爱互动应使用双心连接动画');
        assert.match(dialog.textContent, /发起心动私聊/u);
        const loadingControls = assertOperationCloseControls(dialog, 'loading');

        click(loadingControls.bottomClose);
        assert.equal(dialog.hidden, true, 'loading 关闭只应隐藏提示窗口');
        next.resolve({ ok: true, invitationOutcome: 'accepted', sessionUid: 'chat_new' });
        await flushUi();
        assert.equal(dialog.hidden, true, '已关闭 generation 的成功结果不得重新弹窗');

        next = deferred();
        startInvite();
        next.resolve({ ok: true, invitationOutcome: 'accepted', sessionUid: 'chat_new' });
        await flushUi();
        assert.equal(dialog.hidden, false);
        assert.equal(dialog.getAttribute('aria-busy'), 'false');
        assert.match(dialog.textContent, /心意被接住了/u);
        const successControls = assertOperationCloseControls(dialog, 'success');
        click(successControls.topClose);
        assert.equal(dialog.hidden, true);

        next = deferred();
        startInvite();
        assertOperationCloseControls(dialog, 'loading');
        pressKey('Escape');
        assert.equal(dialog.hidden, true, 'Escape 应关闭 loading 弹窗');
        next.reject(new Error('Authorization: Bearer sk-dismissed-secret'));
        await flushUi();
        assert.equal(dialog.hidden, true, 'Escape 关闭的 generation 后续失败也不得重弹');
        assert.doesNotMatch(miniDom.document.body.textContent, /Authorization|Bearer|sk-dismissed-secret/u);

        next = deferred();
        startInvite();
        next.reject(new Error('Authorization: Bearer sk-visible-secret-api-key'));
        await flushUi();
        assert.equal(dialog.hidden, false);
        assert.equal(dialog.getAttribute('aria-busy'), 'false');
        assert.match(dialog.textContent, /邀请未送达/u);
        assertOperationCloseControls(dialog, 'failure');
        assert.doesNotMatch(dialog.textContent, /Authorization|Bearer|sk-visible-secret|api-key/u);

        click(buttonByPage('profile'));
        click(buttonByText('关于软件'));
        assert.ok(miniDom.document.querySelector('[name="about-version-info"]'), '关于软件应进入子界面');
        click(miniDom.document.querySelector('[name="about-version-info"]'));
        assert.equal(dialog.hidden, false);
        assert.match(dialog.textContent, /版本信息/u);
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

    let result = { ok: true, invitationOutcome: 'accepted', sessionUid: 'chat_new' };
    const readResult = readyReadResult();
    delete readResult.state.推荐.临时候选池.npc_1;
    readResult.state.推荐.当前队列 = [];
    readResult.state.推荐.收藏角色UID = ['npc_1'];
    readResult.state.角色池.npc_1.与玩家关系.状态 = '陌生';
    const bridge = {
        emit() {}, isPending() { return false; },
        async runMvuAction() {
            if (result instanceof Error) throw result;
            return result;
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-dialog-auto-close', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        const startInvite = () => {
            click(buttonByPage('profile'));
            click(buttonByText('收藏夹'));
            click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发起私聊'));
        };
        startInvite();
        await flushUi();

        const dialog = miniDom.document.querySelector('.yl-operation-dialog');
        assertOperationCloseControls(dialog, 'success');
        assert.equal(dialog.dataset.visual, 'accepted', '恋爱互动成功应切换为双心依偎动画');
        const successTimer = timers.find((timer) => timer.delay === 4000 && !timer.cleared);
        assert.ok(successTimer, '成功状态应登记自动收束计时器');
        successTimer.callback();
        assert.equal(dialog.hidden, true);

        result = new Error('Authorization Bearer auto-close-secret');
        startInvite();
        await flushUi();
        assertOperationCloseControls(dialog, 'failure');
        assert.equal(dialog.dataset.visual, 'failure', '恋爱互动失败应切换为心碎动画');
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
    const readResult = readyReadResult();
    delete readResult.state.推荐.临时候选池.npc_1;
    readResult.state.推荐.当前队列 = [];
    readResult.state.推荐.收藏角色UID = ['npc_1'];
    readResult.state.角色池.npc_1.与玩家关系.状态 = '陌生';
    const bridge = {
        emit() {}, isPending() { return false; },
        runMvuAction() {
            const request = deferred();
            requests.push(request);
            return request.promise;
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-dialog-cleanup', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => readResult,
    });
    click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
    const startInvite = () => {
        click(buttonByPage('profile'));
        click(buttonByText('收藏夹'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发起私聊'));
    };
    startInvite();
    const dialog = miniDom.document.querySelector('.yl-operation-dialog');
    assert.equal(dialog.hidden, false);

    click(buttonByPage('messages'));
    assert.equal(dialog.hidden, true, '切换页面应清理操作弹窗');
    requests[0].resolve({ ok: true, invitationOutcome: 'accepted', sessionUid: 'chat_new' });
    await flushUi();
    assert.equal(dialog.hidden, true, '页面切换后迟到结果不得重弹');

    startInvite();
    click(miniDom.document.querySelector('.yl-phone-close'));
    assert.equal(dialog.hidden, true, '关闭小手机应清理操作弹窗');
    requests[1].resolve({ ok: true, invitationOutcome: 'accepted', sessionUid: 'chat_new' });
    await flushUi();
    assert.equal(dialog.hidden, true, '小手机关闭后迟到结果不得重弹');

    click(miniDom.document.querySelector('.yl-phone-launcher'));
    startInvite();
    mounted.destroy();
    assert.equal(miniDom.document.querySelector('#ylm-test-dialog-cleanup'), null);
    requests[2].resolve({ ok: true, invitationOutcome: 'accepted', sessionUid: 'chat_new' });
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

function touchEvent(type, touches, changedTouches = touches) {
    return pointerEvent(type, { touches, changedTouches });
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
        click(buttonByText('关于软件'));
        const version = () => miniDom.document.querySelector('[name="about-version-info"]');
        for (let index = 0; index < 5; index += 1) click(version());
        click(miniDom.document.querySelector('[name="about-content-mode-entry"]'));
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
        click(buttonByText('关于软件'));
        const version = () => miniDom.document.querySelector('[name="about-version-info"]');
        for (let index = 0; index < 5; index += 1) click(version());
        click(miniDom.document.querySelector('[name="about-content-mode-entry"]'));
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
    const storage = createMemoryStorage();
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-launcher-drag-integration', uiLayoutStorage: storage,
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
        assert.deepEqual(JSON.parse(storage.getItem('yuelema.launcher-position/v1')), { left: 80, top: 90 }, '拖动结束应把入口坐标保存在浏览器本地');
        click(launcher);
        assert.equal(panel.hidden, true, '拖动结束后的合成 click 不得打开窗口');
        click(launcher);
        assert.equal(panel.hidden, false, '下一次普通点击仍应打开窗口');
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
    }
});

test('launcher tools open by desktop right-click or a 10-second mobile hold and reset both saved placements', () => {
    const previousDefaultView = miniDom.document.defaultView;
    const previousSetTimeout = globalThis.setTimeout;
    const previousClearTimeout = globalThis.clearTimeout;
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    const execCalls = [];
    miniDom.document.execCommand = (command) => {
        execCalls.push([command, miniDom.document.body.childNodes.at(-1)?.value ?? '']);
        return true;
    };
    miniDom.document.defaultView = { innerWidth: 360, innerHeight: 740 };
    const storage = createMemoryStorage();
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-launcher-tools', uiLayoutStorage: storage,
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null,
        readState: () => ({ ok: false, code: 'mvu_get_unavailable' }),
    });
    try {
        const launcher = miniDom.document.querySelector('.yl-phone-launcher');
        const tools = miniDom.document.querySelector('.yl-launcher-tools');
        const reset = miniDom.document.querySelector('.yl-launcher-tools-reset');
        const panel = miniDom.document.querySelector('.yl-phone-panel');
        const launcherStyles = installStyleRecorder(launcher);
        const panelStyles = installStyleRecorder(panel);
        launcher.getBoundingClientRect = () => {
            const left = Number.parseFloat(launcherStyles.left || '292');
            const top = Number.parseFloat(launcherStyles.top || '672');
            return { left, top, right: left + 56, bottom: top + 56, width: 56, height: 56 };
        };
        tools.getBoundingClientRect = () => ({ left: 180, top: 678, right: 284, bottom: 722, width: 104, height: 44 });

        const contextMenu = pointerEvent('contextmenu', { pointerType: 'mouse', button: 2, clientX: 310, clientY: 690 });
        launcher.dispatchEvent(contextMenu);
        assert.equal(contextMenu.defaultPrevented, true);
        assert.equal(tools.hidden, false, '电脑右键应在悬浮球旁打开工具栏');
        assert.equal(launcher.getAttribute('aria-expanded'), 'true');
        assert.ok(reset);

        storage.setItem('yuelema.launcher-position/v1', JSON.stringify({ left: 80, top: 90 }));
        storage.setItem('yuelema.phone-panel-position/v1', JSON.stringify({ left: 40, top: 50 }));
        launcherStyles.position = 'fixed';
        launcherStyles.left = '80px';
        launcherStyles.top = '90px';
        panelStyles.left = '40px';
        panelStyles.top = '50px';
        panelStyles.right = 'auto';
        panelStyles.bottom = 'auto';
        click(reset);

        assert.equal(storage.getItem('yuelema.launcher-position/v1'), null);
        assert.equal(storage.getItem('yuelema.phone-panel-position/v1'), null);
        assert.equal(launcherStyles.position, '', '归位应恢复悬浮球原始 CSS 锚点');
        assert.equal(launcherStyles.left, '');
        assert.equal(panelStyles.left ?? '', '', '关闭状态下归位应清除面板自定义坐标');
        assert.equal(panelStyles.top ?? '', '');
        assert.equal(tools.hidden, true);

        click(launcher);
        click(launcher);
        assert.equal(panel.hidden, true);

        const timers = [];
        globalThis.setTimeout = (callback, delay) => {
            const timer = { callback, delay, cleared: false };
            timers.push(timer);
            return timer;
        };
        globalThis.clearTimeout = (timer) => { if (timer) timer.cleared = true; };
        launcher.dispatchEvent(pointerEvent('pointerdown', {
            pointerId: 41, pointerType: 'touch', clientX: 310, clientY: 690,
        }));
        const holdTimer = timers.at(-1);
        assert.equal(holdTimer.delay, 10_000, '手机必须持续长按十秒才显示归位工具栏');
        holdTimer.callback();
        assert.equal(tools.hidden, false);
        click(miniDom.document.querySelector('.yl-launcher-tools-diagnostic'));
        assert.equal(execCalls.at(-1)?.[0], 'copy');
        assert.match(execCalls.at(-1)?.[1] ?? '', /mvu_read_complete/u);
        assert.match(execCalls.at(-1)?.[1] ?? '', /phone_view_created/u);
        assert.match(execCalls.at(-1)?.[1] ?? '', /render_complete/u);
        assert.match(execCalls.at(-1)?.[1] ?? '', /内容状态：view=unavailable code=mvu_get_unavailable/u);

        const postHoldClick = new Event('click', { cancelable: true });
        launcher.dispatchEvent(postHoldClick);
        assert.equal(postHoldClick.defaultPrevented, true, '长按完成后的合成 click 不得顺带打开小手机');
        assert.equal(panel.hidden, true);
    } finally {
        mounted.destroy();
        globalThis.setTimeout = previousSetTimeout;
        globalThis.clearTimeout = previousClearTimeout;
        miniDom.document.defaultView = previousDefaultView;
        delete miniDom.document.execCommand;
        if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
        else delete globalThis.navigator;
    }
});

test('bottom-right handle resizes from the original minimum to the full visual viewport and reset clears the saved size', () => {
    const previousDefaultView = miniDom.document.defaultView;
    miniDom.document.defaultView = { innerWidth: 360, innerHeight: 740 };
    const storage = createMemoryStorage();
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-panel-resize', uiLayoutStorage: storage,
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null,
        readState: () => ({ ok: false, code: 'mvu_get_unavailable' }),
    });
    try {
        const launcher = miniDom.document.querySelector('.yl-phone-launcher');
        const panel = miniDom.document.querySelector('.yl-phone-panel');
        const handle = miniDom.document.querySelector('.yl-phone-resize-handle');
        const styles = installStyleRecorder(panel);
        panel.getBoundingClientRect = () => {
            const width = Number.parseFloat(styles.width || '328');
            const height = Number.parseFloat(styles.height || '628');
            const left = Number.parseFloat(styles.left || '16');
            const top = Number.parseFloat(styles.top || '56');
            return { left, top, right: left + width, bottom: top + height, width, height };
        };
        installPointerCaptureStub(handle);
        click(launcher);

        handle.dispatchEvent(pointerEvent('pointerdown', {
            pointerId: 72, pointerType: 'mouse', clientX: 344, clientY: 684,
        }));
        miniDom.document.dispatchEvent(pointerEvent('pointermove', {
            pointerId: 72, pointerType: 'mouse', clientX: 520, clientY: 920,
        }));
        miniDom.document.dispatchEvent(pointerEvent('pointerup', {
            pointerId: 72, pointerType: 'mouse', clientX: 520, clientY: 920,
        }));

        assert.equal(styles.width, '360px');
        assert.equal(styles.height, '740px');
        assert.equal(styles.left, '0px');
        assert.equal(styles.top, '0px');
        assert.equal(panel.classList.contains('is-viewport-fill'), true);
        assert.deepEqual(JSON.parse(storage.getItem('yuelema.phone-panel-size/v1')), {
            phone: { width: 360, height: 740 },
        });

        launcher.dispatchEvent(pointerEvent('contextmenu', { pointerType: 'mouse', button: 2 }));
        click(miniDom.document.querySelector('.yl-launcher-tools-reset'));
        assert.equal(storage.getItem('yuelema.phone-panel-size/v1'), null);
        assert.equal(styles.width ?? '', '');
        assert.equal(styles.height ?? '', '');
        assert.equal(panel.classList.contains('is-viewport-fill'), false);
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
    }
});

test('touch resize requires a long press before movement can change the panel size', () => {
    const previousDefaultView = miniDom.document.defaultView;
    const previousSetTimeout = globalThis.setTimeout;
    const previousClearTimeout = globalThis.clearTimeout;
    miniDom.document.defaultView = { innerWidth: 390, innerHeight: 800 };
    const timers = [];
    globalThis.setTimeout = (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
    };
    globalThis.clearTimeout = (timer) => { if (timer) timer.cleared = true; };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-touch-panel-resize', uiLayoutStorage: createMemoryStorage(),
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null,
        readState: () => ({ ok: false, code: 'mvu_get_unavailable' }),
    });
    try {
        const panel = miniDom.document.querySelector('.yl-phone-panel');
        const handle = miniDom.document.querySelector('.yl-phone-resize-handle');
        const styles = installStyleRecorder(panel);
        panel.getBoundingClientRect = () => {
            const width = Number.parseFloat(styles.width || '358');
            const height = Number.parseFloat(styles.height || '688');
            const left = Number.parseFloat(styles.left || '16');
            const top = Number.parseFloat(styles.top || '56');
            return { left, top, right: left + width, bottom: top + height, width, height };
        };
        installPointerCaptureStub(handle);
        click(miniDom.document.querySelector('.yl-phone-launcher'));
        handle.dispatchEvent(pointerEvent('pointerdown', {
            pointerId: 73, pointerType: 'touch', clientX: 374, clientY: 744,
        }));
        const hold = timers.at(-1);
        assert.equal(hold.delay, 500);
        assert.equal(styles.width ?? '', '', 'pressing alone must not resize');
        hold.callback();
        miniDom.document.dispatchEvent(pointerEvent('pointermove', {
            pointerId: 73, pointerType: 'touch', clientX: 390, clientY: 800,
        }));
        assert.equal(styles.width, '374px');
        assert.equal(styles.height, '744px');
    } finally {
        mounted.destroy();
        globalThis.setTimeout = previousSetTimeout;
        globalThis.clearTimeout = previousClearTimeout;
        miniDom.document.defaultView = previousDefaultView;
    }
});

test('desktop header pointer drag clamps the panel, cancels cleanly, and ignores the close button', () => {
    const previousDefaultView = miniDom.document.defaultView;
    const previousDocumentElement = miniDom.document.documentElement;
    miniDom.document.defaultView = { innerWidth: 400, innerHeight: 300 };
    miniDom.document.documentElement = { clientWidth: 400, clientHeight: 300 };
    const storage = createMemoryStorage();
    storage.setItem('yuelema.ui-layout/v1', 'desktop');
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-panel-drag', uiLayoutStorage: storage,
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

test('phone panel recenters an out-of-viewport saved placement and the bottom nav long-press drags through Touch Events', async () => {
    const previousDefaultView = miniDom.document.defaultView;
    const previousDocumentElement = miniDom.document.documentElement;
    miniDom.document.defaultView = {
        innerWidth: 360, innerHeight: 640,
        visualViewport: { offsetLeft: 0, offsetTop: 0, width: 360, height: 640, addEventListener() {} },
    };
    miniDom.document.documentElement = { clientWidth: 360, clientHeight: 640 };
    const storage = createMemoryStorage();
    storage.setItem('yuelema.phone-panel-position/v1', JSON.stringify({ left: 999, top: -40 }));
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-phone-panel-placement', uiLayoutStorage: storage,
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null, readState: emptyReadResult,
    });
    try {
        const panel = miniDom.document.querySelector('.yl-phone-panel');
        const header = miniDom.document.querySelector('.yl-phone-header');
        const nav = miniDom.document.querySelector('.yl-phone-nav');
        assert.ok(panel && header && nav);
        const styles = installStyleRecorder(panel);
        panel.getBoundingClientRect = () => {
            const left = Number.parseFloat(styles.left || '100');
            const top = Number.parseFloat(styles.top || '120');
            return { left, top, right: left + 220, bottom: top + 360, width: 220, height: 360 };
        };
        const headerCapture = installPointerCaptureStub(header);
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));

        assert.equal(styles.left, '70px', '恢复坐标越出当前视口时应回到可视视口水平居中');
        assert.equal(styles.top, '140px', '恢复坐标越出当前视口时应回到可视视口垂直居中');
        header.dispatchEvent(pointerEvent('pointerdown', { pointerId: 17, pointerType: 'touch', clientX: 180, clientY: 120 }));
        assert.equal(headerCapture.captureCalls, 0, '手机布局仍不得把头部滚动手势当成窗口拖动');

        const startTouch = { identifier: 42, clientX: 200, clientY: 560 };
        nav.dispatchEvent(touchEvent('touchstart', [startTouch]));
        await new Promise((resolve) => setTimeout(resolve, 390));
        const move = touchEvent('touchmove', [{ identifier: 42, clientX: 140, clientY: 590 }]);
        miniDom.document.dispatchEvent(move);
        assert.equal(move.defaultPrevented, true, '长按成立并移动后必须阻止宿主滚动接管手势');
        assert.equal(styles.left, '10px');
        assert.equal(styles.top, '170px');
        miniDom.document.dispatchEvent(touchEvent('touchend', [], [{ identifier: 42, clientX: 140, clientY: 590 }]));
        assert.deepEqual(JSON.parse(storage.getItem('yuelema.phone-panel-position/v1')), { left: 10, top: 170 }, '拖窗结束应把面板坐标保存在浏览器本地');

        const syntheticClick = new Event('click', { cancelable: true });
        nav.dispatchEvent(syntheticClick);
        assert.equal(syntheticClick.defaultPrevented, true, '拖动后的合成 click 必须被拦截一次');
        const messagesButton = nav.querySelectorAll('button').find((node) => node.dataset.page === 'messages');
        click(messagesButton);
        assert.ok(nav.querySelectorAll('button').find((node) => node.dataset.page === 'messages')?.classList.contains('is-active'), '拦截拖动 click 后的下一次普通轻点仍应正常切换页面');
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
        /* §5 主次分级排序：收藏(ghost) / 不喜欢(描边) / 喜欢(渐变主钮) / 下一位(ghost) */
        assert.deepEqual(cardButtons.map((node) => node.getAttribute('aria-label')), ['收藏', '不喜欢', '喜欢', '刷新候选人，显示下一位']);
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
                readResult.state.会话.chat_1 = { 对象UID: 'npc_1', 状态: '已匹配', 最近消息: [], 已确认边界: '', 已确认承诺: '' };
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
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.getAttribute('aria-label') === '运行记录'));
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


test('declined match renders an in-page pastel result card and never opens an empty session', async () => {
    const bridge = { emit() {}, isPending() { return false; }, async runCandidateMatch() { return { ok: true, matchOutcome: 'declined', npcUid: 'npc_declined', sessionUid: '', matchScore: 41, explanation: '这次的公开偏好方向不太一致。' }; } };
    const mounted = mountPhoneApp({ documentRef: miniDom.document, rootId: 'ylm-test-declined-match', actionBridge: bridge, settingsStore: createSettingsStore({ storage: createMemoryStorage() }), llmClient: null, characterLibrary: null, readState: readyReadResult });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('matches'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '开始匹配'));
        await flushUi();
        assert.match(miniDom.document.body.textContent, /灵魂匹配|描述匹配/u);
        assert.equal(miniDom.document.querySelector('.yl-private-chat-screen'), null);
        /* 婉拒 = 页面内浅色结果卡（不再是冷冰冰的弹窗），灰分数环 + declined 态双心 + 再试一次 */
        const resultCard = miniDom.document.querySelector('.yl-match-result-card');
        assert.ok(resultCard, '婉拒应渲染页面内结果卡');
        assert.equal(resultCard.dataset.outcome, 'declined');
        assert.match(resultCard.textContent, /这次没对上频率/u);
        assert.match(resultCard.textContent, /41%/u);
        const mutedRing = resultCard.querySelector('.yl-score-ring');
        assert.ok(mutedRing, '婉拒结果卡应有分数环');
        assert.ok(mutedRing.className.includes('is-muted'), '婉拒分数环必须是灰色 muted 形态');
        const hearts = resultCard.querySelector('.yl-hearts--declined');
        assert.ok(hearts, '婉拒必须使用 declined 态 SVG 双心');
        assert.equal(hearts.dataset.state, 'declined');
        assert.ok(resultCard.querySelectorAll('button').find((node) => node.textContent.includes('再试一次')), '婉拒结果卡应提供再试一次');
        assert.equal(miniDom.document.querySelector('.yl-operation-dialog').hidden, true, '婉拒不再弹出操作弹窗');
        assert.equal(miniDom.document.querySelector('.yl-match-overlay'), null, '婉拒不得出现成功浮层');
    } finally { mounted.destroy(); }
});

test('home favorites save without generating a profile while like/dislike still advance and refresh stays single-purpose', async () => {
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
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '收藏')); await flushUi();
        assert.deepEqual(calls.splice(0), [['save', 'favorite', 'npc_1']], '收藏只保存，不得生成新角色');
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '喜欢')); await flushUi();
        assert.deepEqual(calls.splice(0), [['save', 'like', 'npc_1'], ['next']]);
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '刷新候选人，显示下一位')); await flushUi();
        assert.deepEqual(calls.splice(0), [['refresh', 'npc_1']]);
        next = { ok: false, message: '下一位服务暂时不可用' };
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '不喜欢')); await flushUi();
        assert.deepEqual(calls.splice(0), [['save', 'dislike', 'npc_1'], ['next']]);
        assert.match(miniDom.document.body.textContent, /不喜欢反馈已保存.*下一位候选人生成失败/u);
        click(buttonByPage('profile'));
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.getAttribute('aria-label') === '运行记录'));
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
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '刷新候选人，显示下一位'));
        await flushUi();
        assert.deepEqual(calls, ['initial']);
        click(buttonByPage('profile'));
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.getAttribute('aria-label') === '运行记录'));
        const consoleText = miniDom.document.querySelector('.yl-operation-console').textContent;
        assert.match(consoleText, /首页推荐|首位候选人已通过/u);
        assert.doesNotMatch(consoleText, /UID|Patch|stat_data|npc_/u);
    } finally { mounted.destroy(); }
});

test('closed match and favourite result surfaces never reopen when async results arrive', async () => {
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
        /* 匹配进行中改为页面内光环加速，离开页面即放弃本次结果 */
        click(buttonByPage('messages'));
        matchRequest.resolve({ ok: true, matchOutcome: 'declined', npcUid: 'npc_declined', sessionUid: '', matchScore: 40 });
        await flushUi();
        click(buttonByPage('matches'));
        assert.equal(miniDom.document.querySelector('.yl-match-result-card'), null, '离开匹配页后婉拒结果不得回填展示');
        assert.equal(miniDom.document.querySelector('.yl-match-overlay'), null, '离开匹配页后不得出现成功浮层');
        assert.equal(miniDom.document.querySelector('.yl-operation-dialog').hidden, true, '匹配流程不再依赖操作弹窗');
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
        assert.equal(miniDom.document.querySelector('.yl-match-overlay'), null, '收起小手机后接受结果不得重新弹出成功浮层');
        assert.equal(buttonByPage('matches').getAttribute('aria-current'), 'page');
        click(buttonByPage('profile'));
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.getAttribute('aria-label') === '运行记录'));
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
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.getAttribute('aria-label') === '运行记录'));
        const consoleText = miniDom.document.querySelector('.yl-operation-console').textContent;
        assert.match(consoleText, /收藏主动私聊.*已关闭.*提示已关闭，结果未展示/u);
        assert.doesNotMatch(consoleText, /进行中/u);
    } finally { favoriteMounted.destroy(); }
});

test('discovery workbench exposes one public candidate projection with semantic action icons', async () => {
    const read = readyReadResult();
    read.state.推荐.临时候选池.npc_1.隐藏资料 = { 私密备注: '绝不应渲染' };
    const actionCalls = [];
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-discovery-workbench', uiLayoutStorage: createMemoryStorage(),
        actionBridge: { emit(...args) { actionCalls.push(args); }, isPending() { return false; } }, settingsStore: null, llmClient: null, characterLibrary: null, readState: () => read,
    });
    try {
        click(miniDom.document.querySelector('.yl-phone-launcher'));
        const workbench = miniDom.document.querySelector('.yl-discovery-workbench');
        assert.ok(workbench, '发现页必须提供同一候选的工作台容器');
        assert.ok(workbench.querySelector('.yl-candidate-media'), '候选人相遇画面必须独立为媒体区');
        const dossier = workbench.querySelector('.yl-candidate-dossier');
        assert.ok(dossier, '候选人的公开档案必须独立为资料区');
        assert.match(dossier.textContent, /本次公开档案|只展示公开资料|聊天后约会/u);
        assert.doesNotMatch(workbench.textContent, /绝不应渲染|拒绝阈值|NPC专属匹配度/u, '发现工作台不得渲染隐藏资料或关系阈值');

        const expectedIcons = new Map([
            ['喜欢', { ariaLabel: '喜欢', iconName: 'action_like' }],
            ['不喜欢', { ariaLabel: '不喜欢', iconName: 'action_dislike' }],
            ['收藏', { ariaLabel: '收藏', iconName: 'action_favorite' }],
            ['下一位', { ariaLabel: '刷新候选人，显示下一位', iconName: 'action_next' }],
        ]);
        for (const [label, { ariaLabel, iconName }] of expectedIcons) {
            const button = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === ariaLabel);
            assert.ok(button, `发现操作应保留可访问名称：${ariaLabel}`);
            assert.equal(button.textContent, label, `${ariaLabel} 应保留可见动作文字：${label}`);
            assert.equal(button.querySelector('svg')?.dataset.icon, iconName, `${label} 必须使用本地白名单 SVG`);
        }
        assert.deepEqual(actionCalls, [], '仅构建发现工作台不得触发 action bridge');
    } finally { mounted.destroy(); }
    await flushUi();
});

test('matching page uses description terminology while retaining the voice action contract', async () => {
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-description-match', uiLayoutStorage: createMemoryStorage(),
        actionBridge: { emit() {}, isPending() { return false; }, async runCandidateMatch(mode) { return { ok: false, message: mode }; } }, settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelector('.yl-phone-launcher'));
        click(buttonByPage('matches'));
        assert.match(miniDom.document.body.textContent, /描述匹配/u);
        assert.doesNotMatch(miniDom.document.body.textContent, /语音匹配文字描述/u);
        /* SegmentedControl 双向切换：voice 段显示描述输入，切回 soul 段即移除 */
        const segItems = miniDom.document.querySelector('.yl-seg').querySelectorAll('.yl-seg__item');
        assert.deepEqual(segItems.map((node) => node.textContent), ['灵魂匹配', '描述匹配']);
        click(segItems.find((node) => node.dataset.segmentId === 'voice'));
        assert.equal(miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '描述匹配文字描述')?.getAttribute('aria-label'), '描述匹配文字描述');
        const activeVoice = miniDom.document.querySelector('.yl-seg').querySelectorAll('.yl-seg__item').find((node) => node.dataset.segmentId === 'voice');
        assert.equal(activeVoice.getAttribute('aria-checked'), 'true', '重渲后描述段保持选中');
        click(miniDom.document.querySelector('.yl-seg').querySelectorAll('.yl-seg__item').find((node) => node.dataset.segmentId === 'soul'));
        assert.equal(miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '描述匹配文字描述'), undefined, '切回灵魂模式后描述输入移除');
        const history = miniDom.document.querySelector('.yl-match-history');
        assert.equal(history?.getAttribute('aria-label'), '已牵手对象', '匹配结果应进入独立且可访问的结果区域');
        assert.match(history.textContent, /已牵手对象|还没有互相匹配/u);
        assert.ok(history.querySelector('.yl-empty'), '已牵手空态使用 EmptyState 组件');
        assert.ok(history.querySelector('.yl-empty__svg'), '空态插画必须是 SVG');
    } finally { mounted.destroy(); }
    await flushUi();
});

test('candidate public media exposes loading, error, retry, and ready states without changing candidate actions', async () => {
    const first = deferred();
    const second = deferred();
    const requests = [first, second];
    let resolveCalls = 0;
    let clearCalls = 0;
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-candidate-media-state',
        uiLayoutStorage: createMemoryStorage(),
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null,
        llmClient: null,
        characterLibrary: null,
        imageMatchCoordinator: {
            resolveImage() { return requests[resolveCalls++].promise; },
            clearCache() { clearCalls += 1; },
        },
        readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelector('.yl-phone-launcher'));
        await flushUi();

        let feedback = miniDom.document.querySelector('.yl-candidate-media-feedback');
        assert.equal(feedback.dataset.mediaState, 'loading');
        assert.equal(feedback.getAttribute('aria-busy'), 'true');
        assert.match(feedback.textContent, /正在为公开候选人准备公开画面/u);
        assert.equal(feedback.querySelector('button'), null, '非错误状态不应在 DOM 中留下额外重试控件');

        first.reject(new Error('private provider detail must not render'));
        await flushUi();
        feedback = miniDom.document.querySelector('.yl-candidate-media-feedback');
        assert.equal(feedback.dataset.mediaState, 'error');
        assert.doesNotMatch(feedback.textContent, /private provider detail/u);
        const retry = feedback.querySelector('button');
        assert.equal(retry.hidden, false);
        assert.equal(retry.disabled, false);
        assert.equal(retry.textContent, '重新尝试图片匹配');

        click(retry);
        await flushUi();
        feedback = miniDom.document.querySelector('.yl-candidate-media-feedback');
        assert.equal(feedback.dataset.mediaState, 'loading');
        assert.equal(clearCalls, 1);
        assert.equal(resolveCalls, 2);

        second.resolve({ id: 'public-image', source: { kind: 'embedded', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } });
        await flushUi();
        const backgroundImage = miniDom.document.querySelector('.yl-candidate-background-image');
        assert.ok(backgroundImage, '安全来源解析后应进入现有背景图加载路径');
        backgroundImage.dispatchEvent(new Event('load'));
        await flushUi();

        feedback = miniDom.document.querySelector('.yl-candidate-media-feedback');
        assert.equal(feedback.dataset.mediaState, 'ready');
        assert.equal(feedback.getAttribute('aria-busy'), 'false');
        assert.match(feedback.textContent, /公开画面已准备好/u);

        const avatarImage = miniDom.document.querySelector('.yl-candidate-avatar-image');
        assert.ok(avatarImage, '候选头像应复用同一公开媒体记录');
        avatarImage.dispatchEvent(new Event('error'));
        await flushUi();
        feedback = miniDom.document.querySelector('.yl-candidate-media-feedback');
        assert.equal(feedback.dataset.mediaState, 'error', '头像加载失败也必须进入可见、可重试的公开媒体状态');
        assert.equal(feedback.querySelector('button')?.textContent, '重新尝试图片匹配');
        assert.equal(miniDom.document.querySelectorAll('button').filter((node) => node.className.includes('yl-phone-action-card')).length, 4, '媒体反馈不得改变四操作轨');
    } finally {
        mounted.destroy();
    }
});
test('Phase 67: primary nav renders whitelist SVG icons with 发现/社区 naming and structural glyphs are gone', async () => {
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-phase67-nav',
        actionBridge: { emit() {}, isPending() { return false; } }, settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        const expected = [
            ['home', '发现', 'home'],
            ['matches', '匹配', 'matches'],
            ['messages', '消息', 'messages'],
            ['groups', '社区', 'groups'],
            ['profile', '我的', 'profile'],
        ];
        for (const [page, label, iconName] of expected) {
            const button = buttonByPage(page);
            assert.ok(button, `底栏应有 ${label} 导航`);
            const navLabel = button.querySelector('.yl-nav-label');
            assert.equal(navLabel.textContent, label, `导航 ${page} 的前台名称应为 ${label}`);
            const svg = button.querySelector('svg');
            assert.equal(svg?.dataset.icon, iconName, `导航 ${page} 必须使用本地白名单 SVG`);
            assert.equal(svg.getAttribute('aria-hidden'), 'true');
        }
        click(buttonByPage('groups'));
        const heading = miniDom.document.querySelector('.yl-page-heading').querySelector('h1');
        assert.equal(heading.textContent, '社区', '社区一级页标题应与导航命名一致');

        // 结构性关闭图标：操作弹窗右上角必须是本地 close SVG 而非文字 ×。
        const operationClose = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('name') === 'operation-dialog-close');
        assert.equal(operationClose.querySelector('svg')?.dataset.icon, 'close');
        assert.equal(operationClose.textContent, '', '关闭按钮不再渲染文字符号');

        // 返回按钮使用 chevron_left SVG。
        click(buttonByPage('profile'));
        click(buttonByPage('settings_connections'));
        const back = backButton();
        assert.equal(back.querySelector('svg')?.dataset.icon, 'chevron_left');
        assert.equal(back.getAttribute('aria-label'), '返回');
    } finally {
        mounted.destroy();
    }
});

/* Phase 67 的 profile hub 五分组结构断言已删除（E1 改为 Hero+数据行+四分组结构）；
   等价结构与隐私断言由 src/ui/test/profile-settings-ui.test.mjs 全量承接。 */

function focusIsInside(node, container) {
    let current = node;
    while (current) {
        if (current === container) return true;
        current = current.parentNode ?? null;
    }
    return false;
}

test('Phase 68: dialogs trap focus, close on Escape, and politely return focus to the opener', async () => {
    const settingsStore = createSettingsStore(createMemoryStorage());
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-phase68-dialog-focus',
        actionBridge: { emit() {}, isPending() { return false; } }, settingsStore, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('messages'));
        const optionsButton = miniDom.document.querySelector('.yl-feature-options');
        assert.ok(optionsButton, '消息页应提供功能预设入口');
        optionsButton.focus();
        click(optionsButton);

        const dialog = miniDom.document.querySelector('.yl-feature-binding-modal');
        assert.equal(dialog.hidden, false, '功能预设弹窗应已打开');
        assert.equal(dialog.getAttribute('aria-modal'), 'true', '打开的弹窗必须声明 aria-modal');
        assert.ok(focusIsInside(miniDom.document.activeElement, dialog), '打开弹窗时焦点必须进入弹窗');

        const beforeTab = miniDom.document.activeElement;
        pressKey('Tab');
        assert.ok(focusIsInside(miniDom.document.activeElement, dialog), 'Tab 循环必须停留在弹窗内');
        pressKey('Tab');
        assert.ok(focusIsInside(miniDom.document.activeElement, dialog), '连续 Tab 仍不得逃出弹窗');
        assert.ok(beforeTab, '弹窗内应存在可聚焦控件');

        pressKey('Escape');
        assert.equal(dialog.hidden, true, 'Escape 应关闭栈顶弹窗');
        assert.strictEqual(miniDom.document.activeElement, optionsButton, '关闭后焦点应回到打开弹窗的按钮');
        assert.equal(miniDom.document.querySelector('.yl-phone-panel').hidden, false, 'Escape 关闭弹窗时不得连带关闭小手机窗口');
    } finally {
        mounted.destroy();
    }
});

test('Phase 68: operation dialog focuses its close action once and stays put across state updates', async () => {
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-phase68-operation-focus',
        actionBridge: { emit() {}, isPending() { return false; } }, settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('profile'));
        const aboutEntry = miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.textContent.includes('关于软件'));
        click(aboutEntry);
        const versionButton = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('name') === 'about-version-info');
        assert.ok(versionButton, '关于子页应提供版本信息入口');
        versionButton.focus();
        click(versionButton);

        const dialog = miniDom.document.querySelector('.yl-operation-dialog');
        assert.equal(dialog.hidden, false, '版本信息应打开操作弹窗');
        const bottomClose = dialog.querySelector('[name="operation-dialog-action"]');
        assert.strictEqual(miniDom.document.activeElement, bottomClose, '操作弹窗打开时应聚焦底部关闭按钮');

        pressKey('Escape');
        assert.equal(dialog.hidden, true, 'Escape 应关闭操作弹窗');
        // 版本信息按钮在弹窗打开的同一轮 renderPage 中被重建，opener 已失效：
        // 焦点不得滞留在隐藏弹窗内，应按 §7.1.1 兜底落到当前页标题。
        assert.equal(focusIsInside(miniDom.document.activeElement, dialog), false, '焦点不得滞留在已隐藏的操作弹窗内');
        const heading = miniDom.document.querySelector('.yl-page-heading')?.querySelector('h1');
        assert.ok(heading, '关于页应有页标题');
        assert.strictEqual(miniDom.document.activeElement, heading, 'opener 失效时焦点应兜底到页面标题');
    } finally {
        mounted.destroy();
    }
});

test('P2-B: romance animation is four-state SVG twin hearts with no glyph fallback', async () => {
    const first = deferred();
    const readResult = readyReadResult();
    const queue = [first.promise, Promise.resolve({ ok: false, message: '这次调用没能完成' })];
    const bridge = {
        emit() {}, isPending() { return false; },
        runCandidateMatch() {
            const matched = adultCharacter('频率对象');
            matched.与玩家关系.状态 = '已匹配';
            readResult.state.角色池.npc_match_9 = matched;
            readResult.state.会话.chat_9 = { 对象UID: 'npc_match_9', 状态: '已匹配', 最近消息: [], 已确认边界: '', 已确认承诺: '' };
            return queue.shift();
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-romance-four-states', actionBridge: bridge,
        settingsStore: createSettingsStore({ storage: createMemoryStorage() }), llmClient: null, characterLibrary: null, readState: () => readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('matches'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '开始匹配'));

        /* connecting：光环加速 + connecting 态双心 + 文案轮播，且不再打开 loading 弹窗 */
        const halo = miniDom.document.querySelector('.yl-match-halo');
        assert.ok(halo, '匹配页应有光环 Hero');
        assert.ok(halo.className.includes('is-matching'), '匹配中光环必须进入加速态');
        const connecting = miniDom.document.querySelector('.yl-hearts--connecting');
        assert.ok(connecting, '匹配中必须渲染 connecting 态双心');
        assert.equal(connecting.dataset.state, 'connecting');
        assert.ok(connecting.querySelector('svg'), '恋爱动画必须是 SVG 而非字符');
        assert.ok(miniDom.document.querySelector('.yl-match-captions'), '匹配中应有文案轮播');
        assert.equal(miniDom.document.querySelector('.yl-operation-dialog').hidden, true, '匹配中不再打开通用 loading 弹窗');
        const matchesPage = miniDom.document.querySelector('.yl-page-matches');
        assert.doesNotMatch(matchesPage.textContent, /[♥∿╳♡✦]/u, '匹配页不得再出现字符恋爱动画');

        /* accepted：It's a Match 浮层内 accepted 态双心 + 心形粒子；继续逛逛可留在匹配页 */
        first.resolve({ ok: true, matchOutcome: 'accepted', npcUid: 'npc_match_9', sessionUid: 'chat_9', matchScore: 88, explanation: '都喜欢电影和慢热的聊天节奏。' });
        await flushUi();
        const overlay = miniDom.document.querySelector('.yl-match-overlay');
        assert.ok(overlay, 'accepted 应出现成功浮层');
        const acceptedHearts = overlay.querySelector('.yl-hearts--accepted');
        assert.ok(acceptedHearts, '成功浮层必须渲染 accepted 态双心');
        assert.equal(acceptedHearts.dataset.state, 'accepted');
        assert.ok(overlay.querySelector('.yl-match-particles'), '成功浮层必须有 SVG 心形粒子');
        click(overlay.querySelectorAll('button').find((node) => node.textContent.includes('继续逛逛')));
        assert.equal(miniDom.document.querySelector('.yl-match-overlay'), null, '继续逛逛应关闭浮层');
        assert.ok(miniDom.document.querySelector('.yl-match-hero'), '继续逛逛后停留在匹配页');

        /* failure：页面内 failure 结果卡 + failure 态双心 */
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '开始匹配'));
        await flushUi();
        const failureCard = miniDom.document.querySelector('.yl-match-result-card');
        assert.ok(failureCard, '失败应渲染页面内结果卡');
        assert.equal(failureCard.dataset.outcome, 'failure');
        const failureHearts = failureCard.querySelector('.yl-hearts--failure');
        assert.ok(failureHearts, '失败必须使用 failure 态双心');
        assert.equal(failureHearts.dataset.state, 'failure');
    } finally { mounted.destroy(); }
});

test('P2-B: discovery favourite shows an active solid state and next-candidate waits render a skeleton card', async () => {
    const readResult = readyReadResult();
    readResult.state.推荐.收藏角色UID = ['npc_1'];
    const refreshRequest = deferred();
    const bridge = {
        emit() {}, isPending() { return false; },
        runRecommendationRefresh() { return refreshRequest.promise; },
        async runMvuAction() { return { ok: true }; },
        async runRecommendationInitialCandidate() { return { ok: true }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-discover-skeleton', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        const favourite = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '取消收藏');
        assert.ok(favourite, '已收藏候选人应显示取消收藏');
        assert.ok(favourite.className.includes('is-active'), '已收藏按钮必须是实心激活态');

        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '刷新候选人，显示下一位'));
        const loadingCard = miniDom.document.querySelector('.yl-candidate-loading-card');
        assert.ok(loadingCard, '换人等待时应以骨架卡替换候选卡');
        assert.ok(loadingCard.querySelector('.yl-skeleton--candidate-card'), '骨架卡必须使用 Skeleton 候选卡变体');
        assert.equal(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '喜欢'), undefined, '骨架屏期间操作按钮不可用');

        refreshRequest.resolve({ ok: true });
        await flushUi();
        assert.equal(miniDom.document.querySelector('.yl-candidate-loading-card'), null, '生成完成后骨架卡退场');
        assert.ok(miniDom.document.querySelector('.yl-discovery-workbench'), '候选工作台恢复');
        assert.ok(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '喜欢'), '四操作轨恢复');
    } finally { mounted.destroy(); }
});

test('P2-B: match/discover animation classes stay under the global reduced-motion blanket', async () => {
    const { readFile } = await import('node:fs/promises');
    const stylesheet = await readFile(new URL('../../../style.css', import.meta.url), 'utf8');
    /* 新动画类必须存在（光环呼吸/加速、文案轮播、双心四态、粒子、收藏轻弹） */
    for (const marker of ['.yl-match-halo.is-matching', '.yl-match-captions', '.yl-hearts--connecting',
        '.yl-hearts--accepted', '.yl-hearts--declined', '.yl-hearts--failure', '.yl-match-particle',
        '.yl-action-favorite.is-active', '.yl-candidate-loading-card']) {
        assert.ok(stylesheet.includes(marker), `style.css 缺少动画/状态类：${marker}`);
    }
    /* 页面级 keyframes 全部位于 .yl-phone-extension 子树类上，受 motion 分区
       prefers-reduced-motion 与 body.reduced-motion 双通道全局降级覆盖（合同测试锁定该块存在） */
    assert.match(stylesheet, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}\.yl-phone-extension \*/u, 'reduced-motion 全局降级必须覆盖扩展全部子树');
    /* reduced-motion 下文案轮播静态回退：首条文案保持可见 */
    assert.match(stylesheet, /\.yl-match-captions span:first-child \{ opacity: 1; \}/u, '文案轮播必须有 reduced-motion 静态回退');
});

test('console entries with sanitized detail expose collapse/expand and copy controls', async () => {
    const { buildErrorDetail } = await import('../operation-activity.js');
    const copied = [];
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { clipboard: { writeText(text) { copied.push(text); return Promise.resolve(); } } },
    });
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-console-detail',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        const failing = mounted.operationActivity.start('灵魂匹配', '灵魂匹配中……');
        mounted.operationActivity.fail(failing, '匹配未成功，请稍后再试。', {
            detail: buildErrorDetail(new Error('上游响应无法解析'), { httpStatus: 502, hint: '上游网关错误，可稍后重试' }),
        });
        const plain = mounted.operationActivity.start('描述匹配', '正在寻找合拍的描述……');
        mounted.operationActivity.succeed(plain, '描述匹配成功。');

        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('profile'));
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.getAttribute('aria-label') === '运行记录'));

        const consolePage = miniDom.document.querySelector('.yl-operation-console');
        assert.ok(consolePage, '控制台页面必须渲染');
        const cards = consolePage.querySelectorAll('.yl-operation-console-entry');
        assert.equal(cards.length, 2);

        /* 无 detail 的条目不得出现详情控件 */
        const successCard = cards.find((card) => card.dataset.status === 'success');
        assert.equal(successCard.querySelector('.yl-operation-console-detail-toggle'), null);
        assert.equal(successCard.querySelector('.yl-operation-console-detail'), null);

        /* 失败条目：详情默认收起，textContent 渲染完整脱敏诊断 */
        const failureCard = cards.find((card) => card.dataset.status === 'failure');
        const toggle = failureCard.querySelector('.yl-operation-console-detail-toggle');
        const copyButton = failureCard.querySelector('.yl-operation-console-detail-copy');
        const detailBlock = failureCard.querySelector('.yl-operation-console-detail');
        assert.ok(toggle, '有 detail 的条目必须提供展开按钮');
        assert.ok(copyButton, '有 detail 的条目必须提供复制按钮');
        assert.ok(detailBlock, '详情块必须存在');
        assert.equal(detailBlock.hidden, true, '详情默认收起');
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');
        assert.match(detailBlock.textContent, /错误类型: Error/u);
        assert.match(detailBlock.textContent, /HTTP 状态: 502/u);
        assert.match(detailBlock.textContent, /提示: 上游网关错误，可稍后重试/u);
        assert.equal(detailBlock.childNodes.length, 0, '详情必须为纯 textContent，无子节点标记');

        click(toggle);
        assert.equal(detailBlock.hidden, false, '点击后展开');
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');
        assert.equal(toggle.textContent, '收起详情');

        click(copyButton);
        assert.equal(copied.length, 1);
        assert.match(copied[0], /HTTP 状态: 502/u);
        assert.equal(copied[0], detailBlock.textContent, '复制内容与展示的脱敏详情一致');

        click(toggle);
        assert.equal(detailBlock.hidden, true, '再次点击收起');
        assert.equal(toggle.textContent, '详情');

        /* 摘要 message 仍是粗略文案：详情技术信息只在 detail 块内 */
        assert.match(failureCard.textContent, /匹配未成功，请稍后再试。/u);
    } finally {
        mounted.destroy();
        if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
        else delete globalThis.navigator;
    }
});

test('console detail copy falls back to execCommand and stays silent without any clipboard', async () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    const execCalls = [];
    miniDom.document.execCommand = (command) => {
        execCalls.push([command, miniDom.document.body.childNodes.at(-1)?.value ?? '']);
        return true;
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-console-detail-fallback',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readyReadResult,
    });
    try {
        const handle = mounted.operationActivity.start('AI 操作', 'AI 处理中……');
        mounted.operationActivity.fail(handle, 'AI 操作未完成，请稍后再试。', { detail: '错误码: upstream_timeout\nHTTP 状态: 504' });
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('profile'));
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.getAttribute('aria-label') === '运行记录'));
        const copyButton = miniDom.document.querySelector('.yl-operation-console-detail-copy');
        assert.ok(copyButton);
        click(copyButton);
        assert.equal(execCalls.length, 1);
        assert.equal(execCalls[0][0], 'copy');
        assert.equal(execCalls[0][1], '错误码: upstream_timeout\nHTTP 状态: 504');

        /* execCommand 也不可用时保持静默，不抛错 */
        delete miniDom.document.execCommand;
        click(copyButton);
    } finally {
        mounted.destroy();
        delete miniDom.document.execCommand;
        if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
        else delete globalThis.navigator;
    }
});

/* —— 阶段 74 修复：关于页「检查并更新扩展」——
   失败弹窗必须给出具体原因（HTTP 状态 + 脱敏宿主说明），完整诊断落运行控制台；
   加载态反映在入口按钮 aria-busy / disabled 上。 —— */

test('extension update failure surfaces HTTP status and host text in the dialog and full detail in the run console', async () => {
    const { HostExtensionUpdateError } = await import('../../host-extension-update.js');
    const gate = deferred();
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-extension-update-failure',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null,
        extensionUpdater: { checkAndUpdate: () => gate.promise }, readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('profile'));
        click(buttonByText('关于软件'));
        const updateEntry = () => miniDom.document.querySelector('[name="about-extension-update"]');
        assert.ok(updateEntry(), '关于页应提供检查并更新扩展入口');
        assert.equal(updateEntry().disabled, false);
        assert.equal(updateEntry().getAttribute('aria-busy'), 'false');
        click(updateEntry());

        /* 检查中的加载态：入口忙碌 + 弹窗 loading 展示当前版本 */
        assert.equal(updateEntry().disabled, true, '检查期间入口应禁用防止重复触发');
        assert.equal(updateEntry().getAttribute('aria-busy'), 'true');
        assert.match(updateEntry().textContent, /正在检查并更新/u);
        const dialog = miniDom.document.querySelector('.yl-operation-dialog');
        assert.equal(dialog.hidden, false);
        assert.equal(dialog.dataset.state, 'loading');
        assert.match(dialog.textContent, /正在检查扩展更新/u);
        assert.match(dialog.textContent, /当前版本 v1\.0\.11/u, 'loading 弹窗应展示当前版本');

        gate.reject(new HostExtensionUpdateError('request_failed_http', {
            status: 500,
            hostMessage: 'Internal Server Error. Check the server logs for more details.',
            phase: 'update',
        }));
        await flushUi();

        assert.equal(dialog.hidden, false);
        assert.equal(dialog.dataset.state, 'failure');
        assert.match(dialog.textContent, /宿主扩展更新请求失败/u);
        assert.match(dialog.textContent, /HTTP 500/u, '失败弹窗必须展示 HTTP 状态');
        assert.match(dialog.textContent, /应用更新阶段/u, '失败弹窗必须指明失败阶段');
        assert.match(dialog.textContent, /Internal Server Error\. Check the server logs/u, '失败弹窗必须展示宿主说明');
        assert.match(dialog.textContent, /运行记录/u, '失败弹窗应指向运行控制台详情');
        assert.doesNotMatch(dialog.textContent, /请在酒馆原生扩展管理中查看详情/u, '不得再退回吞错的兜底文案');
        assert.equal(updateEntry().disabled, false, '失败后入口应恢复可用');
        assert.equal(updateEntry().getAttribute('aria-busy'), 'false');

        /* 完整诊断落运行控制台：阶段、错误码、HTTP 状态与宿主说明 */
        click(buttonByPage('profile'));
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.getAttribute('aria-label') === '运行记录'));
        const consoleEntry = miniDom.document.querySelectorAll('.yl-operation-console-entry').find((node) => node.textContent.includes('扩展更新'));
        assert.ok(consoleEntry, '运行控制台应有扩展更新条目');
        assert.equal(consoleEntry.dataset.status, 'failure');
        assert.match(consoleEntry.textContent, /检查或更新扩展未完成。/u);
        const detailBlock = consoleEntry.querySelector('.yl-operation-console-detail');
        assert.ok(detailBlock, '失败条目应携带诊断详情');
        assert.match(detailBlock.textContent, /操作: 检查并更新扩展/u);
        assert.match(detailBlock.textContent, /阶段: 应用更新阶段/u);
        assert.match(detailBlock.textContent, /错误码: request_failed_http/u);
        assert.match(detailBlock.textContent, /HTTP 状态: 500/u);
        assert.match(detailBlock.textContent, /宿主说明 Internal Server Error/u);
    } finally {
        mounted.destroy();
    }
});

test('extension update success states show the current version and non-git installs get a dedicated explanation', async () => {
    const { HostExtensionUpdateError } = await import('../../host-extension-update.js');
    let result = Promise.resolve({ outcome: 'up_to_date' });
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-extension-update-success',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null,
        extensionUpdater: { checkAndUpdate: () => result }, readState: readyReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(buttonByPage('profile'));
        click(buttonByText('关于软件'));
        const updateEntry = () => miniDom.document.querySelector('[name="about-extension-update"]');
        const dialog = miniDom.document.querySelector('.yl-operation-dialog');

        click(updateEntry());
        await flushUi();
        assert.equal(dialog.hidden, false);
        assert.equal(dialog.dataset.state, 'success');
        assert.match(dialog.textContent, /当前已是最新版本/u);
        assert.match(dialog.textContent, /v1\.0\.11 已是最新版本/u, '最新结果应展示当前版本号');

        result = Promise.resolve({ outcome: 'updated' });
        click(updateEntry());
        await flushUi();
        assert.equal(dialog.dataset.state, 'success');
        assert.match(dialog.textContent, /更新已完成/u);
        assert.match(dialog.textContent, /重新载入酒馆页面/u);

        result = Promise.reject(new HostExtensionUpdateError('not_git_installation', { phase: 'version' }));
        click(updateEntry());
        await flushUi();
        assert.equal(dialog.dataset.state, 'failure');
        assert.match(dialog.textContent, /不是 Git 安装/u);
        assert.match(dialog.textContent, /以 Git 方式重新安装/u);
        assert.doesNotMatch(dialog.textContent, /请在酒馆原生扩展管理中查看详情/u);

        /* 运行控制台按次记录：最新 / 已更新 各一条成功 */
        const entries = mounted.operationActivity.snapshot().entries.filter((entry) => entry.name === '扩展更新');
        assert.equal(entries.length, 3);
        assert.equal(entries.filter((entry) => entry.status === 'success').length, 2);
        assert.equal(entries.filter((entry) => entry.status === 'failure').length, 1);
    } finally {
        mounted.destroy();
    }
});


test('homepage favourite confirmation describes saving, not removing, the candidate', async () => {
    const readResult = readyReadResult();
    const calls = [];
    const bridge = {
        emit() {}, isPending() { return false; },
        async runMvuAction(kind, npcUid) {
            calls.push([kind, npcUid]);
            return { ok: true };
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-favourite-confirmation-copy', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '收藏'));
        await flushUi();

        assert.deepEqual(calls, [['favorite', 'npc_1']]);
        const dialog = miniDom.document.querySelector('.yl-operation-dialog');
        assert.equal(dialog.hidden, false);
        assert.equal(dialog.dataset.state, 'success');
        assert.match(dialog.textContent, /已加入收藏夹。/u);
        assert.doesNotMatch(dialog.textContent, /已取消收藏。/u);
    } finally {
        mounted.destroy();
    }
});

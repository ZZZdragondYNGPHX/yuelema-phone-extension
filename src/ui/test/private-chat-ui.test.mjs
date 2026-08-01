import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createMemoryStorage, createSettingsStore } from '../../settings/settings-store.js';
import { createEmptyRelationshipNarrative } from '../../mvu/relationship-narrative.js';
import { createEmptyNsfwConsent, grantNsfwConsent } from '../../mvu/nsfw-consent.js';

const miniDom = installMiniDom();
const { mountPhoneApp } = await import('../../app-shell.js');

test.after(() => miniDom.restore());

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function readResult() {
    return {
        ok: true,
        state: {
            软件: { 内容模式: 'SFW' },
            推荐: { 当前队列: [], 临时候选池: {} },
            角色池: {
                npc_lin: {
                    成人验证: true,
                    公开资料: {
                        昵称: '林澈', 头像引用: 'https://example.invalid/public-avatar.webp', 年龄段: '25-29',
                        性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km',
                        寻找意图: '先聊天再约会', 简介: '公开简介。',
                        兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'],
                    },
                    仅好友资料: { 关系状态: 'friend-secret-must-not-render' },
                    隐藏资料: { 实际年龄: 28, 私人备注: 'hidden-secret-must-not-render' },
                    与玩家关系: { 状态: '已匹配', 全局账号表现: 93, NPC专属匹配度: 98, 好感: 30, 信任: 20, 戒备: 0, 面基意愿: 0 },
                },
            },
            会话: {
                chat_lin: {
                    对象UID: 'npc_lin', 状态: '已匹配',
                    最近消息: [
                        { 消息UID: 'm1', 发送者: '角色', 内容: '晚上好，今天过得怎么样？', 时间: '20:30' },
                        { 消息UID: 'm2', 发送者: '玩家', 内容: '刚看完一部电影，想和你分享。', 时间: '20:32' },
                    ],
                    总结: { 记录: [{ 内容: 'session-summary-must-not-render' }] },
                    NSFW同意: createEmptyNsfwConsent(),
                },
            },
        },
    };
}

function click(node) {
    assert.ok(node, '要点击的控件必须存在');
    node.dispatchEvent(new Event('click'));
}

function rightClick(node) {
    assert.ok(node, '要右键的控件必须存在');
    const event = new Event('contextmenu', { cancelable: true });
    node.dispatchEvent(event);
    return event;
}

function pressEnter(node, { shiftKey = false, isComposing = false } = {}) {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperties(event, {
        key: { configurable: true, value: 'Enter' },
        shiftKey: { configurable: true, value: shiftKey },
        isComposing: { configurable: true, value: isComposing },
    });
    node.dispatchEvent(event);
}

async function flushUi() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
}

test('private chat uses a distinct mobile conversation surface and only calls the controlled chat bridge', async () => {
    const events = [];
    const calls = [];
    const response = deferred();
    let pending = false;
    const bridge = {
        emit(kind, payload) { events.push({ kind, payload }); },
        isPending(kind, sessionUid) { return kind === 'private_chat' && sessionUid === 'chat_lin' && pending; },
        runMvuAction() { throw new Error('private chat UI must not use generic MVU actions'); },
        runPrivateChat(request) {
            calls.push(request);
            pending = true;
            return response.promise.then(() => {
                pending = false;
                return { ok: true };
            });
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-private-chat-ui', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));

        assert.ok(miniDom.document.querySelector('.yl-message-list-page'), '消息一级页应是独立会话列表');
        assert.equal(miniDom.document.querySelector('.yl-private-chat-screen'), null, '消息一级页不得预渲染聊天详情');
        const listDom = miniDom.document.body.textContent;
        assert.match(listDom, /林澈|刚看完一部电影/u);

        const openChat = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊');
        click(openChat);

        const screen = miniDom.document.querySelector('.yl-private-chat-screen');
        assert.ok(screen, '点开会话后应进入独立私聊界面');
        assert.ok(miniDom.document.querySelector('.yl-page-back'), '私聊界面应能返回消息列表');
        assert.match(screen.textContent, /晚上好，今天过得怎么样？|刚看完一部电影/u);
        for (const forbidden of [
            'friend-secret-must-not-render', 'hidden-secret-must-not-render', 'session-summary-must-not-render',
            '实际年龄', '全局账号表现', 'NPC专属匹配度', 'https://example.invalid/public-avatar.webp', 'chat_lin', 'npc_lin',
        ]) assert.equal(miniDom.document.body.textContent.includes(forbidden), false, `私聊 DOM 不得暴露 ${forbidden}`);

        assert.equal(miniDom.document.querySelector('.yl-meetup-panel'), null, '私聊页底部不应常驻约定面基卡片');
        const sendButton = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送消息');
        assert.ok(sendButton.querySelector('.yl-chat-send-icon'), '发送按钮应显示纸飞机图标');
        assert.doesNotMatch(sendButton.textContent, /↑/u);
        const input = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入私聊消息');
        assert.ok(input, '私聊详情应有输入栏');
        input.value = '周末想去看场展览。';
        input.dispatchEvent(new Event('input'));
        pressEnter(input, { shiftKey: true });
        assert.equal(calls.length, 0, 'Shift+Enter 只换行，不发送消息');

        click(sendButton);
        assert.deepEqual(calls, [{ sessionUid: 'chat_lin', npcUid: 'npc_lin', playerMessage: '周末想去看场展览。', turnConsentConfirmed: false }], '左键纸飞机应沿用现有私聊发送桥');
        assert.ok(miniDom.document.querySelector('.yl-chat-replying'), '请求期间应在聊天流内显示回复中状态');
        assert.equal(miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入私聊消息').disabled, true);

        response.resolve();
        await flushUi();
        const refreshedInput = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入私聊消息');
        assert.equal(refreshedInput.value, '', '受控写入成功后只清除当前会话的本地草稿');
        assert.deepEqual(events.map((entry) => entry.payload.page), ['messages', 'private_chat']);
    } finally {
        mounted.destroy();
    }
});

test('private chat keeps the reading anchor and follows the bottom across pending and completed replies', async () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const frameCallbacks = [];
    globalThis.requestAnimationFrame = (callback) => { frameCallbacks.push(callback); return frameCallbacks.length; };
    const flushFrames = () => {
        while (frameCallbacks.length) frameCallbacks.shift()();
    };
    const response = deferred();
    const result = readResult();
    let pending = false;
    const bridge = {
        emit() {},
        isPending(kind, sessionUid) { return kind === 'private_chat' && sessionUid === 'chat_lin' && pending; },
        runPrivateChat() {
            pending = true;
            return response.promise.then(() => {
                pending = false;
                result.state.会话.chat_lin.最近消息.push({ 消息UID: 'm3', 发送者: '角色', 内容: '新的回复。', 时间: '20:33' });
                return { ok: true };
            });
        },
    };
    const mounted = mountPhoneApp({ documentRef: miniDom.document, rootId: 'ylm-test-private-chat-scroll', actionBridge: bridge, settingsStore: null, llmClient: null, characterLibrary: null, readState: () => result });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelector('.yl-message-session'));
        const content = miniDom.document.querySelector('.yl-phone-content');
        const installTranscriptMeasurements = (scrollTop = 0) => {
            const transcript = miniDom.document.querySelector('.yl-chat-transcript');
            Object.defineProperties(transcript, {
                clientHeight: { value: 200, configurable: true },
                scrollHeight: { configurable: true, get: () => miniDom.document.querySelectorAll('.yl-bubble').length * 300 },
                scrollTop: { value: scrollTop, writable: true, configurable: true },
            });
            return transcript;
        };
        let transcript = installTranscriptMeasurements(400);
        flushFrames();
        const originalAppendChild = content.appendChild.bind(content);
        content.appendChild = (node) => {
            const resultNode = originalAppendChild(node);
            installTranscriptMeasurements(0);
            return resultNode;
        };
        const input = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入私聊消息');
        input.value = '继续聊。'; input.dispatchEvent(new Event('input'));
        transcript.scrollTop = 0;
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送消息'));
        transcript = miniDom.document.querySelector('.yl-chat-transcript');
        assert.equal(transcript.scrollTop, 400, '用户发送时即使旧容器已错误回顶，也必须明确跟随到消息末尾');
        transcript.scrollTop = 0;
        flushFrames();
        assert.equal(transcript.scrollTop, 400, '用户发送后的布局帧晚到时仍应强制内层时间线回到底部');
        response.resolve();
        await flushUi();
        transcript = miniDom.document.querySelector('.yl-chat-transcript');
        assert.equal(transcript.scrollTop, 700, '新回复完成后，原本位于底部的用户应跟随内层时间线到新底部');
        transcript.scrollTop = 0;
        flushFrames();
        assert.equal(transcript.scrollTop, 700, 'AI 回复布局完成后内层时间线不得再次回到顶部');
        transcript.scrollTop = 0;
        click(miniDom.document.querySelector('.yl-chat-jump-latest'));
        assert.equal(transcript.scrollTop, 700, '手动“跳到最新”应作为自动滚动失手时的一键兜底');
        transcript.scrollTop = 0;
        flushFrames();
        assert.equal(transcript.scrollTop, 700, '手动跳转也必须抵抗真实浏览器迟到的布局帧');
    } finally {
        mounted.destroy();
        if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
        else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
});

test('chat summary settings disable their two subpages until enabled, then render a per-character summary archive', () => {
    const result = readResult();
    result.state.会话.chat_lin.对话层数 = 4;
    result.state.会话.chat_lin.最近消息 = [
        { 消息UID: 'm1', 发送者: '角色', 内容: '晚上好，今天过得怎么样？', 时间: '20:30', 层数: 1 },
        { 消息UID: 'm2', 发送者: '玩家', 内容: '刚看完一部电影，想和你分享。', 时间: '20:32', 层数: 2 },
        { 消息UID: 'm3', 发送者: '角色', 内容: '我也喜欢电影。', 时间: '20:33', 层数: 3 },
        { 消息UID: 'm4', 发送者: '玩家', 内容: '下次一起看展吧。', 时间: '20:34', 层数: 4 },
    ];
    result.state.会话.chat_lin.总结 = {
        已总结消息UID: 'm2', 总结序号: 1,
        记录: [{ 总结UID: 'summary_1', 起始消息UID: 'm1', 结束消息UID: 'm2', 起始层数: 1, 结束层数: 2, 内容: '双方从电影开始聊天。', 时间: '' }],
        状态: '成功', 失败原因: '', 目标总结UID: '', 尝试次数: 1,
    };
    const settingsStore = createSettingsStore({ storage: createMemoryStorage() });
    const bridge = { emit() {}, isPending() { return false; }, runPrivateChatSummary() { return Promise.resolve({ ok: true, remainingMessageCount: 0 }); } };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-chat-summary-settings', actionBridge: bridge,
        settingsStore, llmClient: null, characterLibrary: null, readState: () => result,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'profile'));
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.getAttribute('aria-label') === '隐私与总结'));
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.getAttribute('aria-label') === '对话总结'));

        const plan = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '总结方案');
        const archive = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '总结档案');
        assert.equal(plan.disabled, true);
        assert.equal(archive.disabled, true);
        const toggle = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '自动对话总结开关');
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));

        const enabledPlan = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '总结方案');
        const enabledArchive = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '总结档案');
        assert.equal(enabledPlan.disabled, false);
        assert.equal(enabledArchive.disabled, false);
        click(enabledPlan);
        assert.ok(miniDom.document.querySelector('.yl-chat-summary-config'));
        assert.ok(miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '每几条消息层自动总结'));
        assert.ok(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '保存'));

        click(miniDom.document.querySelector('.yl-page-back'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '总结档案'));
        assert.ok(miniDom.document.querySelector('.yl-chat-summary-history'));
        assert.match(miniDom.document.body.textContent, /已对话 4 层 · 1 条总结 · 2 条待整理/u);
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '查看林澈的总结档案'));
        assert.match(miniDom.document.body.textContent, /第 1–2 层总结|双方从电影开始聊天/u);
    } finally {
        mounted.destroy();
    }
});

test('a successful private-chat reply starts background summary work and shows only a compact top-of-chat result toast', async () => {
    const settingsStore = createSettingsStore({ storage: createMemoryStorage() });
    settingsStore.setChatSummarySettings({ enabled: true, interval: 2, retryLimit: 0 });
    let privatePending = false;
    const summaryCalls = [];
    const bridge = {
        emit() {},
        isPending(kind) { return kind === 'private_chat' && privatePending; },
        runPrivateChat() {
            privatePending = true;
            return Promise.resolve().then(() => {
                privatePending = false;
                return { ok: true, summaryCheckRequested: true };
            });
        },
        runPrivateChatSummary(request) {
            summaryCalls.push(request);
            return Promise.resolve({ ok: true, remainingMessageCount: 0 });
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-chat-summary-toast', actionBridge: bridge,
        settingsStore, llmClient: null, characterLibrary: null, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));
        const input = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入私聊消息');
        input.value = '继续聊电影吧。';
        input.dispatchEvent(new Event('input'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送消息'));
        await flushUi();

        assert.deepEqual(summaryCalls, [{ sessionUid: 'chat_lin', npcUid: 'npc_lin', summaryUid: '', automatic: true }]);
        const toast = miniDom.document.querySelector('.yl-chat-summary-toast');
        assert.ok(toast);
        assert.match(toast.textContent, /聊天总结已完成|已自动整理本次私聊/u);
        assert.equal(miniDom.document.querySelector('.yl-operation-dialog').hidden, true, '自动总结不得弹出阻塞式操作弹窗');
    } finally {
        mounted.destroy();
    }
});

test('desktop right-click and mobile long-press on the paper plane open the meetup tool through the private-chat handoff bridge', async () => {
    const meetupCalls = [];
    let privateChatCalls = 0;
    const result = readResult();
    result.state.角色池.npc_lin.与玩家关系.友情值 = 60;
    const bridge = {
        emit() {},
        isPending() { return false; },
        runPrivateChat() { privateChatCalls += 1; return { ok: true }; },
        runPrivateChatMeetupHandoff(request) { meetupCalls.push(request); return { ok: true, draftApplied: true }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-private-chat-tools', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => result,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));

        assert.equal(miniDom.document.querySelector('.yl-meetup-panel'), null, '未打开工具栏前不渲染底部面基卡片');
        let sendButton = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送消息');
        const previousSetTimeout = globalThis.setTimeout;
        const previousClearTimeout = globalThis.clearTimeout;
        const longPressTimers = [];
        globalThis.setTimeout = (callback, delay) => { const timer = { callback, delay, cleared: false }; longPressTimers.push(timer); return timer; };
        globalThis.clearTimeout = (timer) => { if (timer) timer.cleared = true; };
        try {
            const longPress = new Event('pointerdown', { cancelable: true });
            Object.defineProperty(longPress, 'pointerType', { configurable: true, value: 'touch' });
            sendButton.dispatchEvent(longPress);
            assert.equal(longPressTimers.at(-1).delay, 460, '手机长按应在明确阈值后展开工具栏');
            sendButton.dispatchEvent(new Event('touchstart'));
            assert.equal(longPressTimers.length, 1, 'Pointer/Touch 兼容事件不得为同一次长按重复创建计时器');
            longPressTimers.at(-1).callback();
        } finally {
            globalThis.setTimeout = previousSetTimeout;
            globalThis.clearTimeout = previousClearTimeout;
        }
        let toolMenu = miniDom.document.querySelector('.yl-chat-tool-menu');
        assert.ok(toolMenu, '手机长按纸飞机应打开工具面板');
        assert.ok(miniDom.document.querySelector('.yl-sheet'), '工具面板应挂在 BottomSheet 中');
        assert.equal(privateChatCalls, 0, '手机长按不得发送私聊');
        sendButton = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送消息');
        const contextMenuEvent = rightClick(sendButton);
        assert.equal(miniDom.document.querySelector('.yl-chat-tool-menu'), null, '桌面右键可收起已打开的工具栏');
        const secondContextMenuEvent = rightClick(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送消息'));
        assert.equal(secondContextMenuEvent.defaultPrevented, true, '右键纸飞机应阻止浏览器默认菜单');
        assert.equal(contextMenuEvent.defaultPrevented, true, '右键纸飞机应阻止浏览器默认菜单');
        toolMenu = miniDom.document.querySelector('.yl-chat-tool-menu');
        assert.ok(toolMenu, '右键纸飞机应打开工具面板');
        assert.equal(toolMenu.getAttribute('role'), null, '工具栏是 disclosure 列表，不得宣称无键盘模型的 role=menu');
        assert.equal(toolMenu.getAttribute('aria-label'), '私聊发送工具栏');
        assert.match(toolMenu.textContent, /约定面基 · 友情路线/u);
        sendButton = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送消息');
        assert.equal(sendButton.getAttribute('aria-expanded'), 'true');
        const plusButton = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开聊天工具');
        assert.ok(plusButton, '输入框左侧应有可见「+」按钮（裁决 D4）');
        assert.equal(plusButton.getAttribute('aria-expanded'), 'true');
        assert.equal(privateChatCalls, 0, '打开工具栏不得发送私聊');
        assert.equal(meetupCalls.length, 0, '打开工具栏不得提前提交面基');

        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约定面基，友情路线'));
        assert.equal(miniDom.document.querySelector('.yl-chat-tool-menu'), null, '选择工具后应收起工具面板');
        assert.ok(miniDom.document.querySelector('.yl-meetup-panel'), '约定面基工具应打开 BottomSheet 两步表单');
        assert.match(miniDom.document.querySelector('.yl-meetup-step-indicator').textContent, /第 1 \/ 2 步/u);

        const fieldValues = new Map([
            ['本周六 19:30', '本周六 19:30'],
            ['静安寺地铁站 2 号口', '静安寺地铁站 2 号口'],
            ['一起吃饭，确认是否继续约会', '一起吃饭，确认是否继续约会'],
            ['公共场所见面；任何亲密行为需当场确认', '公共场所见面；任何亲密行为需当场确认'],
            ['散场时间', '21:30 前散场'],
            ['各自独立到场，可随时离开', '各自独立到场，可随时离开'],
        ]);
        const fillVisibleMeetupFields = () => {
            for (const textarea of miniDom.document.querySelectorAll('textarea')) {
                const value = fieldValues.get(textarea.getAttribute('placeholder'));
                if (!value) continue;
                textarea.value = value;
                textarea.dispatchEvent(new Event('input'));
            }
        };
        fillVisibleMeetupFields();
        assert.equal(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '填入正文草稿'), undefined, '第 1 步不出现提交钮');
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '下一步'));
        assert.match(miniDom.document.querySelector('.yl-meetup-step-indicator').textContent, /第 2 \/ 2 步/u);
        fillVisibleMeetupFields();
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '填入正文草稿'));
        await flushUi();

        assert.deepEqual(meetupCalls, [{
            sessionUid: 'chat_lin',
            time: '本周六 19:30', place: '静安寺地铁站 2 号口', mutualIntent: '一起吃饭，确认是否继续约会',
            confirmedBoundaries: '公共场所见面；任何亲密行为需当场确认', pendingItems: '21:30 前散场', riskNotice: '各自独立到场，可随时离开',
        }], '工具栏入口必须复用 runMeetupHandoff，不得另造写入路径');
        assert.equal(privateChatCalls, 0, '约定面基不得触发私聊发送');
        assert.equal(miniDom.document.querySelector('.yl-meetup-panel'), null, '成功填入后应收起面基表单');
    } finally {
        mounted.destroy();
    }
});

test('meetup tool stays visibly disabled and cannot invoke the bridge before a route unlocks', () => {
    const meetupCalls = [];
    const bridge = {
        emit() {},
        isPending() { return false; },
        runPrivateChat() { return { ok: true }; },
        runMeetupHandoff(request) { meetupCalls.push(request); return { ok: true, draftApplied: true }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-private-chat-locked-meetup', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));
        rightClick(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送消息'));

        const lockedTool = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '关系未达面基条件');
        assert.ok(lockedTool, '未达路线门槛时仍保留灰色面基入口');
        assert.equal(lockedTool.disabled, true);
        assert.equal(lockedTool.getAttribute('aria-disabled'), 'true');
        click(lockedTool);
        assert.equal(meetupCalls.length, 0);
        assert.equal(miniDom.document.querySelector('.yl-meetup-panel'), null);
    } finally {
        mounted.destroy();
    }
});

test('NSFW chat tools expose a controlled only-SFW toggle without rendering protected relationship fields', async () => {
    const calls = [];
    const result = readResult();
    result.state.软件.内容模式 = 'NSFW';
    const narrative = createEmptyRelationshipNarrative();
    narrative.进程.边界暂停状态 = '仅SFW';
    result.state.关系叙事 = { npc_lin: narrative };
    const bridge = {
        emit() {},
        isPending() { return false; },
        runPrivateChat() { return { ok: true }; },
        runPrivateChatNsfwSafety(request) {
            calls.push(request);
            narrative.进程.边界暂停状态 = request.action === 'pause' ? '仅SFW' : '';
            return { ok: true };
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-chat-only-sfw', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => result,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));
        assert.match(miniDom.document.body.textContent, /当前关系仅进行 SFW 互动/u);
        for (const protectedField of ['边界暂停状态', '关系结束状态', '冻结关系值']) {
            assert.equal(miniDom.document.body.textContent.includes(protectedField), false, `私聊 DOM 不得暴露 ${protectedField}`);
        }

        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开聊天工具'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '恢复成人话题'));
        await flushUi();
        assert.deepEqual(calls, [{ sessionUid: 'chat_lin', action: 'resume' }]);

        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开聊天工具'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '仅 SFW · 暂停成人话题'));
        await flushUi();
        assert.deepEqual(calls, [
            { sessionUid: 'chat_lin', action: 'resume' },
            { sessionUid: 'chat_lin', action: 'pause' },
        ]);
    } finally {
        mounted.destroy();
    }
});

test('stage C UI requires scoped consent plus per-turn confirmation, exposes explicit direction choice, and confirms downgrade', async () => {
    const result = readResult();
    result.state.软件.内容模式 = 'NSFW';
    result.state.角色池.npc_lin.与玩家关系.友情值 = 20;
    result.state.角色池.npc_lin.与玩家关系.心动值 = 50;
    result.state.角色池.npc_lin.与玩家关系.欲望值 = 50;
    const narrative = createEmptyRelationshipNarrative();
    narrative.进程.NSFW方向确认可用 = true;
    result.state.角色池.npc_zhou = structuredClone(result.state.角色池.npc_lin);
    result.state.角色池.npc_zhou.公开资料.昵称 = '周岚';
    result.state.会话.chat_zhou = {
        对象UID: 'npc_zhou', 状态: '已匹配', 最近消息: [], 总结: { 记录: [] }, NSFW同意: createEmptyNsfwConsent(),
    };
    result.state.关系叙事 = { npc_lin: narrative, npc_zhou: createEmptyRelationshipNarrative() };
    const consentCalls = [];
    const chatCalls = [];
    const directionCalls = [];
    const relationshipCalls = [];
    const bridge = {
        emit() {}, isPending() { return false; },
        async runPrivateChatNsfwConsent(request) {
            consentCalls.push(request);
            result.state.会话.chat_lin.NSFW同意 = request.action === 'grant'
                ? grantNsfwConsent(result.state.会话.chat_lin.NSFW同意, { scopes: request.scopes, turns: request.turns })
                : createEmptyNsfwConsent();
            return { ok: true };
        },
        async runPrivateChat(request) { chatCalls.push(request); return { ok: true }; },
        async runPrivateChatNsfwDirection(request) {
            directionCalls.push(request);
            narrative.进程.NSFW路线锁定 = request.direction === 'love' ? '爱情' : request.direction === 'consensual_intimacy' ? '共识亲密' : '暂不定义';
            return { ok: true };
        },
        async runPrivateChatNsfwRelationshipAction(request) {
            relationshipCalls.push(request);
            narrative.进程.NSFW路线锁定 = '暂不定义';
            narrative.进程.边界暂停状态 = '仅SFW';
            result.state.会话.chat_lin.NSFW同意 = createEmptyNsfwConsent();
            return { ok: true };
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-chat-c-stage', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => result,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));
        let input = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入私聊消息');
        input.value = '先确认范围再继续。';
        input.dispatchEvent(new Event('input'));
        assert.equal(miniDom.document.querySelector('.yl-chat-send-button').disabled, true, '没有会话共识时不得发送 NSFW 消息');

        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开聊天工具'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '建立成人话题共识'));
        const scope = miniDom.document.querySelectorAll('input').find((node) => node.value === '成人话题');
        scope.checked = true;
        const duration = miniDom.document.querySelectorAll('select').find((node) => node.getAttribute('aria-label') === '选择成人话题共识有效轮数');
        duration.value = '3';
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '确认并启用'));
        await flushUi();
        assert.deepEqual(consentCalls, [{ sessionUid: 'chat_lin', action: 'grant', scopes: ['成人话题'], turns: 3 }]);

        input = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入私聊消息');
        input.value = '本轮继续。';
        input.dispatchEvent(new Event('input'));
        let turnConsent = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('id') === 'yl-nsfw-turn-consent-chat_lin');
        assert.ok(turnConsent);
        assert.equal(miniDom.document.querySelector('.yl-chat-send-button').disabled, true, '会话共识不能代替本轮确认');
        turnConsent.checked = true;
        turnConsent.dispatchEvent(new Event('change'));

        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '返回'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与周岚的私聊'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '返回'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));
        turnConsent = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('id') === 'yl-nsfw-turn-consent-chat_lin');
        assert.equal(turnConsent.checked, false, '切换角色必须清除本轮继续的瞬时确认');
        turnConsent.checked = true;
        turnConsent.dispatchEvent(new Event('change'));
        click(miniDom.document.querySelector('.yl-chat-send-button'));
        await flushUi();
        assert.equal(chatCalls[0].turnConsentConfirmed, true);

        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开聊天工具'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '选择爱情方向'));
        await flushUi();
        assert.deepEqual(directionCalls, [{ sessionUid: 'chat_lin', direction: 'love' }]);

        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开聊天工具'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开成人关系降级或结束操作'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '确认降级为朋友（仅 SFW）'));
        await flushUi();
        assert.deepEqual(relationshipCalls, [{ sessionUid: 'chat_lin', action: 'degrade_to_friends' }]);
        assert.match(miniDom.document.body.textContent, /当前关系仅进行 SFW 互动/u);
    } finally {
        mounted.destroy();
    }
});

test('relationship pause and end states keep private chat read-only before any send', () => {
    const result = readResult();
    const narrative = createEmptyRelationshipNarrative();
    narrative.进程.边界暂停状态 = '暂停';
    result.state.关系叙事 = { npc_lin: narrative };
    const bridge = { emit() {}, isPending() { return false; }, runPrivateChat() { throw new Error('must not send'); } };
    const mounted = mountPhoneApp({ documentRef: miniDom.document, rootId: 'ylm-test-chat-relationship-paused', actionBridge: bridge, settingsStore: null, llmClient: null, characterLibrary: null, readState: () => result });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));
        assert.match(miniDom.document.body.textContent, /当前关系已暂停、拉黑或归档/u);
        assert.equal(miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '私聊消息输入已禁用')?.disabled, true);

        narrative.进程.边界暂停状态 = '';
        narrative.进程.关系结束状态 = '结束联系';
        mounted.refreshState();
        assert.match(miniDom.document.body.textContent, /当前关系已经结束/u);
        assert.equal(miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '私聊消息输入已禁用')?.disabled, true);
    } finally {
        mounted.destroy();
    }
});

test('private chat preserves its draft and projects a safe failure when the state changed before commit', async () => {
    const bridge = {
        emit() {},
        isPending() { return false; },
        runPrivateChat() { return { ok: false, code: 'private_chat_session_messages_invalid' }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-private-chat-failure', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));
        const input = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入私聊消息');
        input.value = '这条草稿需要保留。';
        input.dispatchEvent(new Event('input'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送消息'));
        await flushUi();

        const dialog = miniDom.document.querySelector('.yl-operation-dialog');
        assert.equal(dialog.hidden, false);
        assert.match(dialog.textContent, /当前会话记录异常/u);
        assert.doesNotMatch(dialog.textContent, /private_chat_session_messages_invalid/u);
        const refreshedInput = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入私聊消息');
        assert.equal(refreshedInput.value, '这条草稿需要保留。');
    } finally {
        mounted.destroy();
    }
});

test('private-chat contact avatar opens only the contact public profile', () => {
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-private-chat-avatar-profile',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));
        const avatar = miniDom.document.querySelector('.yl-chat-contact-avatar');
        assert.equal(avatar.getAttribute('role'), 'button');
        assert.equal(avatar.getAttribute('tabindex'), '0');
        click(avatar);
        const profile = miniDom.document.querySelector('.yl-public-profile');
        assert.ok(profile);
        assert.match(profile.textContent, /林澈|公开简介/u);
        assert.doesNotMatch(profile.textContent, /friend-secret-must-not-render|hidden-secret-must-not-render|实际年龄|chat_lin|npc_lin/u);
    } finally {
        mounted.destroy();
    }
});

test('a late private-chat failure stays silent after the user left the conversation', async () => {
    const response = deferred();
    let pending = false;
    const bridge = {
        emit() {},
        isPending(kind, sessionUid) { return kind === 'private_chat' && sessionUid === 'chat_lin' && pending; },
        runPrivateChat() {
            pending = true;
            return response.promise.then((result) => {
                pending = false;
                return result;
            });
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-private-chat-late-result', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));
        const input = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入私聊消息');
        input.value = '稍后会离开当前会话。';
        input.dispatchEvent(new Event('input'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送消息'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        response.resolve({ ok: false, code: 'private_chat_session_messages_invalid' });
        await flushUi();

        assert.ok(miniDom.document.querySelector('.yl-message-list-page'));
        assert.equal(miniDom.document.querySelector('.yl-operation-dialog').hidden, true, '离开会话后的迟到失败不得重新弹窗');
    } finally {
        mounted.destroy();
    }
});


test('message search uses only nickname and latest visible message', () => {
    const mounted = mountPhoneApp({ documentRef: miniDom.document, rootId: 'ylm-test-chat-search', actionBridge: { emit() {}, isPending() { return false; } }, settingsStore: null, llmClient: null, characterLibrary: null, readState: readResult });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '搜索私聊会话'));
        const search = miniDom.document.querySelector('[name="missing"]') ?? miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '搜索私聊');
        assert.ok(search);
        search.value = '林澈'; search.dispatchEvent(new Event('input'));
        assert.ok(miniDom.document.querySelector('.yl-message-session'));
        const latestSearch = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '搜索私聊');
        latestSearch.value = '刚看完一部电影'; latestSearch.dispatchEvent(new Event('input'));
        assert.ok(miniDom.document.querySelector('.yl-message-session'));
        for (const secret of ['chat_lin', 'npc_lin', 'hidden-secret-must-not-render', '93']) {
            const input = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '搜索私聊');
            input.value = secret; input.dispatchEvent(new Event('input'));
            assert.equal(miniDom.document.querySelector('.yl-message-session'), null);
        }
    } finally { mounted.destroy(); }
});

test('consecutive contact replies merge into one group of separate bubbles and blocked chat disables input', () => {
    const result = readResult();
    result.state.会话.chat_lin.状态 = '已拉黑';
    result.state.角色池.npc_lin.与玩家关系.状态 = '已拉黑';
    result.state.会话.chat_lin.最近消息 = [
        { 消息UID: 'a', 发送者: '角色', 内容: '第一条回复', 时间: '20:30' },
        { 消息UID: 'b', 发送者: '角色', 内容: '第二条回复', 时间: '20:31' },
    ];
    const mounted = mountPhoneApp({ documentRef: miniDom.document, rootId: 'ylm-test-chat-multi-blocked', actionBridge: { emit() {}, isPending() { return false; }, runPrivateChat() { throw new Error('must not send'); } }, settingsStore: null, llmClient: null, characterLibrary: null, readState: () => result });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelector('.yl-message-session'));
        assert.equal(miniDom.document.querySelectorAll('.yl-bubble--peer').length, 2, '两条回复仍是两个独立气泡');
        assert.equal(miniDom.document.querySelectorAll('.yl-msg-group--peer').length, 1, '同发送者连续气泡合并为一组');
        const group = miniDom.document.querySelector('.yl-msg-group--peer');
        assert.equal(group.querySelectorAll('.yl-chat-message-avatar').length, 1, '组内只显示一次头像');
        assert.equal(group.querySelectorAll('.yl-bubble-name').length, 1, '组内只显示一次昵称');
        assert.equal(group.querySelectorAll('.yl-bubble-time').length, 1, '时间只作为组尾角标出现一次');
        assert.match(miniDom.document.body.textContent, /对方已将你拉黑，无法继续发送消息。/u, '只读态应有状态说明 pill');
        assert.equal(miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '私聊消息输入已禁用')?.disabled, true);
        assert.equal(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送消息已禁用')?.disabled, true);
    } finally { mounted.destroy(); }
});

test('timeline inserts a one-time system pill, time dividers over 10 minutes, and groups alternating senders', () => {
    const result = readResult();
    result.state.会话.chat_lin.最近消息 = [
        { 消息UID: 't1', 发送者: '角色', 内容: '早上好呀。', 时间: '2026-07-25 09:00' },
        { 消息UID: 't2', 发送者: '角色', 内容: '今天有空吗？', 时间: '2026-07-25 09:02' },
        { 消息UID: 't3', 发送者: '玩家', 内容: '下午可以。', 时间: '2026-07-25 09:05' },
        { 消息UID: 't4', 发送者: '角色', 内容: '那就下午聊。', 时间: '2026-07-25 21:30' },
    ];
    const mounted = mountPhoneApp({ documentRef: miniDom.document, rootId: 'ylm-test-chat-timeline', actionBridge: { emit() {}, isPending() { return false; }, runPrivateChat() { return { ok: true }; } }, settingsStore: null, llmClient: null, characterLibrary: null, readState: () => result });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));

        const timeline = miniDom.document.querySelector('.yl-chat-timeline');
        assert.ok(timeline, '消息流使用合同 class yl-chat-timeline');
        assert.equal(timeline.querySelectorAll('.yl-system-pill').length, 1, '首次进入会话插入一条一次性系统 pill');
        const dividers = timeline.querySelectorAll('.yl-time-divider');
        assert.equal(dividers.length, 2, '开场 + 超过 10 分钟的间隔各插一个时间分隔 pill');
        assert.match(dividers[0].textContent, /(?:7月25日|今天) 09:00/u);
        assert.match(dividers[1].textContent, /(?:7月25日|今天) 21:30/u);
        assert.equal(timeline.querySelectorAll('.yl-msg-group--peer').length, 2, '角色的两段连续发言各成一组');
        assert.equal(timeline.querySelectorAll('.yl-msg-group--self').length, 1, '玩家发言单独成组');
        const firstPeerGroup = timeline.querySelectorAll('.yl-msg-group--peer')[0];
        assert.equal(firstPeerGroup.querySelectorAll('.yl-bubble--peer').length, 2, '相邻同发送者消息合并进同组');
        assert.equal(firstPeerGroup.querySelectorAll('.yl-bubble-time').length, 1, '时间只落在组尾气泡角标');
        assert.equal(miniDom.document.querySelector('.yl-chat-privacy-note'), null, '常驻隐私横幅已删除');
        assert.doesNotMatch(timeline.textContent, /最近消息/u, '「最近消息」伪分组标签已删除');

        // 同一挂载内再次进入该会话：一次性系统 pill 仍在本次访问内保留，但属于同一条（不重复累积）。
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));
        assert.equal(miniDom.document.querySelectorAll('.yl-system-pill').length, 1);
    } finally { mounted.destroy(); }
});

test('timeline surfaces body-written meetup progress and refreshes when the meetup record reaches a terminal state', () => {
    const result = readResult();
    result.state.面基记录 = {
        meetup_1: {
            对象UID: 'npc_lin', 关系路线: '恋爱', 时间: '周六 19:00', 地点: '江边步道',
            双方意图: '先散步再吃宵夜', 已确认边界: 'boundary-must-not-render', 待确认事项: '', 风险提示: '',
            状态: '正文进行中', 正文结果摘要: '',
        },
    };
    const mounted = mountPhoneApp({ documentRef: miniDom.document, rootId: 'ylm-test-chat-meetup-pill', actionBridge: { emit() {}, isPending() { return false; }, runPrivateChat() { return { ok: true }; } }, settingsStore: null, llmClient: null, characterLibrary: null, readState: () => result });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));

        const timeline = miniDom.document.querySelector('.yl-chat-timeline');
        assert.match(timeline.textContent, /面基（恋爱路线）：见面正在正文中进行/u, '进行中的面基显示进展 pill');
        assert.doesNotMatch(timeline.textContent, /boundary-must-not-render/u, '已确认边界自由文本不进入聊天面');
        assert.doesNotMatch(timeline.textContent, /见面小结/u, '未结束时不显示结果摘要');

        // 正文回写终态 + 结果摘要后，VARIABLE_UPDATE_ENDED → refreshState 即可刷新展示。
        result.state.面基记录.meetup_1.状态 = '已结束';
        result.state.面基记录.meetup_1.正文结果摘要 = '散完步一起吃了宵夜，气氛比线上更自然，约好下周看展。';
        mounted.refreshState();
        const refreshed = miniDom.document.querySelector('.yl-chat-timeline');
        assert.match(refreshed.textContent, /面基（恋爱路线）：见面已结束/u);
        assert.match(refreshed.textContent, /见面小结：散完步一起吃了宵夜/u, '正文结果摘要作为见面小结展示');
    } finally { mounted.destroy(); }
});

test('private chat deletion uses inline confirmation, clears draft, and returns to list', async () => {
    const result = readResult(); const calls = [];
    const bridge = { emit() {}, isPending() { return false; }, async clearPrivateChat(uid) { calls.push(uid); delete result.state.会话[uid]; return { ok: true }; }, async runPrivateChat() { return { ok: false }; } };
    const mounted = mountPhoneApp({ documentRef: miniDom.document, rootId: 'ylm-test-chat-delete', actionBridge: bridge, settingsStore: null, llmClient: null, characterLibrary: null, readState: () => result });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机')); click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages')); click(miniDom.document.querySelector('.yl-message-session'));
        const input = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入私聊消息'); input.value = '保留中的草稿'; input.dispatchEvent(new Event('input'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的更多操作'));
         click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '清空聊天记录'));
        assert.ok(miniDom.document.querySelector('.yl-chat-delete-confirmation'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '确认清空聊天记录')); await flushUi();
        assert.deepEqual(calls, ['chat_lin']); assert.ok(miniDom.document.querySelector('.yl-message-list-page') || /暂无已建立/u.test(miniDom.document.body.textContent)); assert.equal(miniDom.document.querySelector('.yl-private-chat-screen'), null);
    } finally { mounted.destroy(); }
});


test('private chat more menu deletes the complete character through the controlled bridge', async () => {
    const result = readResult(); const calls = [];
    const bridge = {
        emit() {}, isPending() { return false; },
        async deleteCharacter(uid) { calls.push(uid); delete result.state.角色池[uid]; delete result.state.会话.chat_lin; return { ok: true }; },
        async runPrivateChat() { return { ok: false }; },
    };
    const mounted = mountPhoneApp({ documentRef: miniDom.document, rootId: 'ylm-test-chat-delete-character', actionBridge: bridge, settingsStore: null, llmClient: null, characterLibrary: null, readState: () => result });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelector('.yl-message-session'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的更多操作'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '删除角色完整数据'));
        assert.match(miniDom.document.body.textContent, /完整角色数据/u);
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '确认删除角色完整数据'));
        await flushUi();
        assert.deepEqual(calls, ['npc_lin']);
        assert.equal(miniDom.document.querySelector('.yl-private-chat-screen'), null);
    } finally { mounted.destroy(); }
});

test('desktop layout adds a public-projection context rail beside the private chat', async () => {
    const storage = createMemoryStorage();
    storage.setItem('yuelema.ui-layout/v1', 'desktop');
    const bridge = { emit() {}, isPending() { return false; }, runPrivateChat() { return Promise.resolve({ ok: true }); } };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-private-chat-context-desktop', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, uiLayoutStorage: storage, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));

        const workbench = miniDom.document.querySelector('.yl-private-chat-workbench');
        assert.ok(workbench, 'desktop 私聊应组成会话工作台');
        assert.ok(workbench.querySelector('.yl-private-chat-screen'), '工作台内仍是同一私聊主列');
        const rail = workbench.querySelector('.yl-chat-context-panel');
        assert.ok(rail, 'desktop 私聊应有公开资料上下文栏');
        assert.equal(rail.getAttribute('aria-label'), '林澈的公开资料');
        for (const expected of ['25-29', '上海', '先聊天再约会', '公开简介。', '电影', '这里只显示对方的公开资料。']) {
            assert.ok(rail.textContent.includes(expected), `上下文栏应展示公开字段：${expected}`);
        }
        for (const forbidden of [
            'friend-secret-must-not-render', 'hidden-secret-must-not-render', 'session-summary-must-not-render',
            '实际年龄', '全局账号表现', 'NPC专属匹配度', '拒绝阈值', 'npc_lin', 'chat_lin',
        ]) assert.equal(miniDom.document.body.textContent.includes(forbidden), false, `上下文栏不得暴露 ${forbidden}`);
    } finally {
        mounted.destroy();
    }
});

function twoSessionResult() {
    const result = readResult();
    result.state.角色池.npc_zhou = {
        成人验证: true,
        公开资料: {
            昵称: '周遥', 头像引用: '', 年龄段: '30-34', 性别: '男', 性取向: '异性恋', 城市: '杭州',
            距离范围: '5 km', 寻找意图: '认真交往', 简介: '第二会话公开简介。',
            兴趣标签: ['登山'], 生活方式标签: ['早起'], 性格标签: ['温和'], 沟通风格标签: ['直接'],
        },
        与玩家关系: { 状态: '已匹配', 好感: 10, 信任: 10, 戒备: 0, 面基意愿: 0 },
    };
    result.state.会话.chat_zhou = {
        对象UID: 'npc_zhou', 状态: '已匹配',
        最近消息: [{ 消息UID: 'z1', 发送者: '角色', 内容: '周末去爬山吗？', 时间: '19:00' }],
    };
    return result;
}

test('desktop master-detail: session rail lists every conversation and switches sessions', async () => {
    const storage = createMemoryStorage();
    storage.setItem('yuelema.ui-layout/v1', 'desktop');
    const result = twoSessionResult();
    const bridge = { emit() {}, isPending() { return false; }, runPrivateChat() { return Promise.resolve({ ok: true }); } };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-private-chat-master-detail', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, uiLayoutStorage: storage, readState: () => result,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));

        const workbench = miniDom.document.querySelector('.yl-private-chat-workbench');
        assert.ok(workbench, 'desktop 私聊应组成会话工作台');
        const rail = workbench.querySelector('.yl-chat-session-rail');
        assert.ok(rail, 'desktop 私聊工作台应有最左会话列');
        assert.equal(rail.getAttribute('aria-label'), '私聊会话列表');
        const rows = rail.querySelectorAll('.yl-message-session');
        assert.equal(rows.length, 2, '会话列应逐 session 渲染全部会话行');
        const activeRows = rows.filter((row) => row.classList.contains('is-active'));
        assert.equal(activeRows.length, 1, '当前会话行应有唯一激活态');
        assert.equal(activeRows[0].getAttribute('aria-label'), '打开与林澈的私聊');
        assert.equal(activeRows[0].getAttribute('aria-current'), 'true');

        click(rail.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与周遥的私聊'));
        await flushUi();
        assert.match(miniDom.document.querySelector('.yl-private-chat-contact').textContent, /周遥/u, '点击会话行应切换到对应会话');
        assert.equal(miniDom.document.querySelector('.yl-chat-context-panel').getAttribute('aria-label'), '周遥的公开资料', '上下文栏应同步切换');
        const nextActive = miniDom.document.querySelector('.yl-chat-session-rail')
            .querySelectorAll('.yl-message-session').filter((row) => row.classList.contains('is-active'));
        assert.equal(nextActive.length, 1);
        assert.equal(nextActive[0].getAttribute('aria-label'), '打开与周遥的私聊', '激活态应跟随当前会话');
    } finally {
        mounted.destroy();
    }
});

test('desktop context rail collapse toggle persists through the yuelema.-prefixed local key', async () => {
    const storedValues = new Map();
    const storageStub = {
        getItem: (key) => (storedValues.has(key) ? storedValues.get(key) : null),
        setItem: (key, value) => { storedValues.set(key, String(value)); },
        removeItem: (key) => { storedValues.delete(key); },
    };
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storageStub });
    const layoutStorage = createMemoryStorage();
    layoutStorage.setItem('yuelema.ui-layout/v1', 'desktop');
    const bridge = { emit() {}, isPending() { return false; }, runPrivateChat() { return Promise.resolve({ ok: true }); } };
    const openLinChat = () => {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));
    };
    const findToggle = () => miniDom.document.querySelectorAll('button').find((node) => node.classList.contains('yl-chat-context-toggle'));
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-context-collapse-a', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, uiLayoutStorage: layoutStorage, readState: readResult,
    });
    try {
        openLinChat();
        assert.equal(findToggle().getAttribute('aria-expanded'), 'true', '上下文栏默认展开');
        assert.ok(miniDom.document.querySelector('.yl-chat-context-facts'), '展开态渲染公开资料事实');
        click(findToggle());
        assert.equal(findToggle().getAttribute('aria-expanded'), 'false', '点击折叠钮应收起');
        assert.ok(miniDom.document.querySelector('.yl-chat-context-panel').classList.contains('is-collapsed'), '折叠态挂 is-collapsed 类');
        assert.equal(miniDom.document.querySelector('.yl-chat-context-facts'), null, '折叠态不渲染资料正文');
        assert.equal(storedValues.get('yuelema.chat-context-collapsed/v1'), '1', '折叠偏好写入 yuelema. 前缀本地键');
    } finally {
        mounted.destroy();
    }
    const remounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-context-collapse-b', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, uiLayoutStorage: layoutStorage, readState: readResult,
    });
    try {
        openLinChat();
        assert.equal(findToggle().getAttribute('aria-expanded'), 'false', '重挂载后折叠态应从本地键恢复');
        assert.ok(miniDom.document.querySelector('.yl-chat-context-panel').classList.contains('is-collapsed'));
        click(findToggle());
        assert.equal(findToggle().getAttribute('aria-expanded'), 'true', '再次点击应恢复展开');
        assert.equal(storedValues.get('yuelema.chat-context-collapsed/v1'), '0', '展开偏好同样落盘');
    } finally {
        remounted.destroy();
        if (previousDescriptor) Object.defineProperty(globalThis, 'localStorage', previousDescriptor);
        else delete globalThis.localStorage;
    }
});

test('phone layout keeps the private chat single-column without a context rail', async () => {
    const bridge = { emit() {}, isPending() { return false; }, runPrivateChat() { return Promise.resolve({ ok: true }); } };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-private-chat-context-phone', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, uiLayoutStorage: createMemoryStorage(), readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));
        assert.equal(miniDom.document.querySelector('.yl-private-chat-workbench'), null, 'phone 私聊不应套工作台外壳');
        assert.equal(miniDom.document.querySelector('.yl-chat-context-panel'), null, 'phone 私聊不渲染上下文栏');
        assert.equal(miniDom.document.querySelector('.yl-chat-session-rail'), null, 'phone 私聊不渲染 desktop 会话列');
        assert.ok(miniDom.document.querySelector('.yl-private-chat-screen'), 'phone 私聊保持单列会话');
    } finally {
        mounted.destroy();
    }
});

test('Phase 69: chat action lists are disclosures and Escape dismisses the send toolbar', async () => {
    let privateChatCalls = 0;
    const result = readResult();
    result.state.角色池.npc_lin.与玩家关系.友情值 = 60;
    const bridge = {
        emit() {}, isPending() { return false; },
        runPrivateChat() { privateChatCalls += 1; return { ok: true }; },
        runPrivateChatMeetupHandoff() { return { ok: true, draftApplied: true }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-phase69-disclosure', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => result,
    });
    const pressEscape = () => {
        const event = new Event('keydown', { cancelable: true });
        Object.defineProperty(event, 'key', { configurable: true, value: 'Escape' });
        miniDom.document.dispatchEvent(event);
    };
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));

        const more = () => miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的更多操作');
        const moreMenu = () => miniDom.document.querySelector('.yl-private-chat-more-menu');
        assert.equal(more().getAttribute('aria-haspopup'), null, '更多操作是 disclosure，不再宣称 haspopup=menu');
        assert.equal(more().getAttribute('aria-expanded'), 'false');
        assert.equal(moreMenu().hidden, true, '菜单节点常驻 DOM 但默认隐藏');
        click(more());
        assert.equal(more().getAttribute('aria-expanded'), 'true');
        assert.equal(moreMenu().hidden, false, '更多操作应展开动作列表');
        assert.equal(moreMenu().getAttribute('role'), null, '无键盘模型的动作列表不得宣称 role=menu');
        assert.equal(moreMenu().querySelectorAll('button').every((node) => node.getAttribute('role') === null), true, '列表项是普通按钮而非 menuitem');
        pressEscape();
        assert.equal(moreMenu().hidden, true, 'Escape 应关闭更多操作列表');

        const sendButton = () => miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送消息');
        assert.equal(sendButton().getAttribute('aria-haspopup'), null, '纸飞机不再宣称 haspopup');
        rightClick(sendButton());
        assert.ok(miniDom.document.querySelector('.yl-chat-tool-menu'), '右键应展开发送工具栏');
        pressEscape();
        assert.equal(miniDom.document.querySelector('.yl-chat-tool-menu'), null, 'Escape 应关闭发送工具栏');
        assert.equal(miniDom.document.querySelector('.yl-phone-panel').hidden, false, 'Escape 关闭工具栏时不得连带关闭小手机窗口');
        assert.equal(privateChatCalls, 0, '整个过程不得触发私聊发送');
    } finally {
        mounted.destroy();
    }
});

// —— 阶段 77：私聊/总结失败把脱敏诊断写入安全控制台 detail（message 仍为粗略文案）——

test('a failed private-chat send records a console failure entry with sanitized diagnostic detail', async () => {
    const bridge = {
        emit() {},
        isPending() { return false; },
        runPrivateChat() {
            return { ok: false, status: 'rejected', code: 'private_chat_connection_missing', message: '请先为“聊天”绑定连接预设或设置默认连接。' };
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-private-chat-console-detail', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));
        const input = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入私聊消息');
        input.value = '这句话不能进入控制台详情。';
        input.dispatchEvent(new Event('input'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送消息'));
        await flushUi();

        const entry = mounted.operationActivity.snapshot().entries.find((item) => item.name === '私聊回复');
        assert.ok(entry, '私聊发送必须在控制台留下条目');
        assert.equal(entry.status, 'failure');
        assert.equal(entry.message, '私聊回复未完成。', '界面摘要保持粗略友好文案');
        assert.ok(entry.detail, '失败条目必须携带诊断 detail');
        assert.match(entry.detail, /操作: 私聊回复/u);
        assert.match(entry.detail, /错误码: private_chat_connection_missing/u);
        /* 硬线：detail 不得含对话原文、关系数值/阈值或凭据样式 token */
        assert.doesNotMatch(entry.detail, /这句话不能进入控制台详情/u);
        assert.doesNotMatch(entry.detail, /好感|信任|戒备|阈值|Bearer|sk-/u);
    } finally {
        mounted.destroy();
    }
});

test('a failed automatic chat summary records attempts and error code in the console detail', async () => {
    const settingsStore = createSettingsStore({ storage: createMemoryStorage() });
    settingsStore.setChatSummarySettings({ enabled: true, interval: 2, retryLimit: 2 });
    let privatePending = false;
    const bridge = {
        emit() {},
        isPending(kind) { return kind === 'private_chat' && privatePending; },
        runPrivateChat() {
            privatePending = true;
            return Promise.resolve().then(() => {
                privatePending = false;
                return { ok: true, summaryCheckRequested: true };
            });
        },
        runPrivateChatSummary() {
            return Promise.resolve({
                ok: false, status: 'rejected', code: 'chat_summary_invalid_json',
                message: '总结模型没有返回可用的总结；本次不会覆盖已有记录。', attempts: 3, failurePersisted: true, automatic: true,
            });
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-chat-summary-console-detail', actionBridge: bridge,
        settingsStore, llmClient: null, characterLibrary: null, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));
        const input = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入私聊消息');
        input.value = '触发一次自动总结。';
        input.dispatchEvent(new Event('input'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送消息'));
        await flushUi();

        const summaryEntry = mounted.operationActivity.snapshot().entries.find((item) => item.name === '聊天总结');
        assert.ok(summaryEntry, '自动总结必须在控制台留下条目');
        assert.equal(summaryEntry.status, 'failure');
        assert.equal(summaryEntry.message, '聊天总结未完成。');
        assert.match(summaryEntry.detail, /共尝试 3 次后仍未完成/u);
        assert.match(summaryEntry.detail, /错误码: chat_summary_invalid_json/u);
        assert.doesNotMatch(summaryEntry.detail, /触发一次自动总结/u);
        /* 私聊发送本身成功：其条目应为 success 且无 detail */
        const chatEntry = mounted.operationActivity.snapshot().entries.find((item) => item.name === '私聊回复');
        assert.equal(chatEntry.status, 'success');
        assert.equal(chatEntry.detail, null);
    } finally {
        mounted.destroy();
    }
});

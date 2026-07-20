import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';

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
                    长期摘要: 'session-summary-must-not-render',
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
        assert.deepEqual(calls, [{ sessionUid: 'chat_lin', npcUid: 'npc_lin', playerMessage: '周末想去看场展览。' }], '左键纸飞机应沿用现有私聊发送桥');
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

test('right-clicking the paper plane opens the meetup tool and reuses the existing handoff bridge', async () => {
    const meetupCalls = [];
    let privateChatCalls = 0;
    const bridge = {
        emit() {},
        isPending() { return false; },
        runPrivateChat() { privateChatCalls += 1; return { ok: true }; },
        runMeetupHandoff(request) { meetupCalls.push(request); return { ok: true, draftApplied: true }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-private-chat-tools', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开与林澈的私聊'));

        assert.equal(miniDom.document.querySelector('.yl-meetup-panel'), null, '未打开工具栏前不渲染底部面基卡片');
        let sendButton = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送消息');
        const contextMenuEvent = rightClick(sendButton);
        assert.equal(contextMenuEvent.defaultPrevented, true, '右键纸飞机应阻止浏览器默认菜单');
        const toolMenu = miniDom.document.querySelector('.yl-chat-tool-menu');
        assert.ok(toolMenu, '右键纸飞机应打开小型工具栏');
        assert.equal(toolMenu.getAttribute('role'), 'menu');
        assert.match(toolMenu.textContent, /^约定面基$/u);
        sendButton = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送消息');
        assert.equal(sendButton.getAttribute('aria-expanded'), 'true');
        assert.equal(privateChatCalls, 0, '打开工具栏不得发送私聊');
        assert.equal(meetupCalls.length, 0, '打开工具栏不得提前提交面基');

        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约定面基'));
        assert.equal(miniDom.document.querySelector('.yl-chat-tool-menu'), null, '选择工具后应收起右键菜单');
        assert.ok(miniDom.document.querySelector('.yl-meetup-panel'), '约定面基工具应打开原有面基表单');

        const fieldValues = new Map([
            ['本周六 19:30', '本周六 19:30'],
            ['静安寺地铁站 2 号口', '静安寺地铁站 2 号口'],
            ['一起吃饭，确认是否继续约会', '一起吃饭，确认是否继续约会'],
            ['公共场所见面；任何亲密行为需当场确认', '公共场所见面；任何亲密行为需当场确认'],
            ['散场时间', '21:30 前散场'],
            ['各自独立到场，可随时离开', '各自独立到场，可随时离开'],
        ]);
        for (const textarea of miniDom.document.querySelectorAll('textarea')) {
            const value = fieldValues.get(textarea.getAttribute('placeholder'));
            if (!value) continue;
            textarea.value = value;
            textarea.dispatchEvent(new Event('input'));
        }
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '填入正文草稿'));
        await flushUi();

        assert.deepEqual(meetupCalls, [{
            sessionUid: 'chat_lin', npcUid: 'npc_lin',
            time: '本周六 19:30', place: '静安寺地铁站 2 号口', mutualIntent: '一起吃饭，确认是否继续约会',
            confirmedBoundaries: '公共场所见面；任何亲密行为需当场确认', pendingItems: '21:30 前散场', riskNotice: '各自独立到场，可随时离开',
        }], '工具栏入口必须复用 runMeetupHandoff，不得另造写入路径');
        assert.equal(privateChatCalls, 0, '约定面基不得触发私聊发送');
        assert.equal(miniDom.document.querySelector('.yl-meetup-panel'), null, '成功填入后应收起面基表单');
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

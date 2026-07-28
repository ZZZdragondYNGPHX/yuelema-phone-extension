import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';

const miniDom = installMiniDom();
const { mountPhoneApp } = await import('../../app-shell.js');

test.after(() => miniDom.restore());

function publicCharacter(nickname) {
    return {
        成人验证: true,
        公开资料: {
            昵称: nickname, 头像引用: '', 年龄段: '25-29', 性别: '女', 性取向: '双性恋',
            城市: '上海', 距离范围: '10 km', 寻找意图: '先聊天再约会', 简介: '公开简介。',
            兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'],
        },
        仅好友资料: { 私密备注: 'friend-only-secret-must-not-render' },
        隐藏资料: { 实际年龄: 28, 私人备注: 'hidden-secret-must-not-render' },
        与玩家关系: { 状态: '已匹配', 全局账号表现: 90, NPC专属匹配度: 88, 好感: 42, 信任: 36, 戒备: 2, 面基意愿: 8 },
    };
}

function messageSearchReadResult() {
    return {
        ok: true,
        state: {
            软件: { 内容模式: 'SFW' },
            推荐: { 当前队列: [], 临时候选池: {} },
            角色池: {
                npc_lin: publicCharacter('林澈'),
                npc_su: publicCharacter('苏晚'),
            },
            会话: {
                chat_lin: {
                    对象UID: 'npc_lin', 状态: '已匹配',
                    最近消息: [
                        { 消息UID: 'message_lin_1', 发送者: '角色', 内容: '周末去看独立电影吗？', 时间: '20:30' },
                        { 消息UID: 'message_lin_2', 发送者: '玩家', 内容: '我想把那间新开的书店分享给你。', 时间: '20:32' },
                    ],
                    总结: { 记录: [{ 内容: 'summary-must-not-render' }] },
                },
                chat_su: {
                    对象UID: 'npc_su', 状态: '已匹配',
                    最近消息: [
                        { 消息UID: 'message_su_1', 发送者: '角色', 内容: '下班后一起沿江散步吧。', 时间: '21:00' },
                    ],
                    总结: { 记录: [{ 内容: 'another-summary-must-not-render' }] },
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

function byAria(label) {
    return miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === label);
}

function openMessageSearch() {
    click(byAria('搜索私聊会话'));
    const input = miniDom.document.querySelector('.yl-message-search-input');
    assert.ok(input, '点开搜索 icon 后应展开可访问的搜索输入框');
    assert.equal(input.getAttribute('aria-label'), '搜索私聊');
    return input;
}

function messageSearchInput() {
    const input = miniDom.document.querySelector('.yl-message-search-input');
    assert.ok(input, '消息页搜索输入框应保持存在');
    return input;
}

function sessionNames() {
    return miniDom.document.querySelectorAll('.yl-session-name').map((node) => node.textContent);
}

function enterSearch(input, value) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
}

function createBridge(actionCalls) {
    return {
        emit(...args) { actionCalls.push(args); },
        isPending() { return false; },
        runMvuAction() { throw new Error('消息搜索不得调用 MVU action bridge'); },
    };
}

test('message list sorts by latest message time desc and search stays icon-expandable, local and private', () => {
    const actionCalls = [];
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-message-search-filter',
        actionBridge: createBridge(actionCalls),
        settingsStore: null,
        llmClient: null,
        characterLibrary: null,
        readState: messageSearchReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        actionCalls.length = 0;

        assert.deepEqual(sessionNames(), ['苏晚', '林澈'], '§7.1.1：按最后一条消息时间倒序，废除 UID 字母序');
        assert.equal(miniDom.document.querySelector('.yl-message-search-input'), null, '搜索条默认收起，页头只保留搜索 icon');
        assert.equal(miniDom.document.querySelector('.yl-message-list-eyebrow'), null, '「心动消息」横幅已删除');

        const input = openMessageSearch();
        enterSearch(input, '散步');
        assert.deepEqual(sessionNames(), ['苏晚'], '应按最近一条公开短消息过滤');

        enterSearch(messageSearchInput(), '林澈');
        assert.deepEqual(sessionNames(), ['林澈'], '应按公开昵称过滤');

        enterSearch(messageSearchInput(), '不存在的词');
        assert.deepEqual(sessionNames(), [], '无结果时不渲染会话行');
        assert.ok(miniDom.document.querySelector('.yl-empty--search'), '搜索无结果应显示 EmptyState');

        enterSearch(messageSearchInput(), '');
        assert.deepEqual(sessionNames(), ['苏晚', '林澈'], '清空搜索应恢复完整会话列表');
        assert.deepEqual(actionCalls, [], '本地搜索不得调用 action bridge');

        const rendered = miniDom.document.body.textContent;
        assert.doesNotMatch(rendered, /friend-only-secret|hidden-secret|summary-must-not-render|npc_|chat_|message_|全局账号表现|NPC专属匹配度|好感|信任|戒备|面基意愿/u);
    } finally {
        mounted.destroy();
    }
});

test('message search keeps the same focused input and draft while filtering locally without rebuilding the page', () => {
    const actionCalls = [];
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-message-search-input-stability',
        actionBridge: createBridge(actionCalls),
        settingsStore: null,
        llmClient: null,
        characterLibrary: null,
        readState: messageSearchReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        actionCalls.length = 0;

        const input = openMessageSearch();
        const page = miniDom.document.querySelector('.yl-page-messages');
        input.focus();
        enterSearch(input, '散步');

        assert.ok(miniDom.document.querySelector('.yl-page-messages') === page, '键入搜索不得重建整页');
        assert.ok(messageSearchInput() === input, '键入搜索后输入 DOM 必须保持同一对象');
        assert.strictEqual(miniDom.document.activeElement, input, '键入搜索后输入焦点必须保持');
        assert.equal(input.value, '散步', '键入搜索后输入 draft 必须保持');
        assert.deepEqual(actionCalls, [], '键入搜索不得调用 action bridge');
    } finally {
        mounted.destroy();
    }
});

test('local read watermark drives row badges, bold previews and the nav unread badge; opening a chat clears them', () => {
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-message-unread',
        actionBridge: { emit() {}, isPending() { return false; }, runPrivateChat() { return { ok: true }; } },
        settingsStore: null,
        llmClient: null,
        characterLibrary: null,
        readState: messageSearchReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));

        const unreadRows = miniDom.document.querySelectorAll('.yl-message-session').filter((row) => row.classList.contains('is-unread'));
        assert.equal(unreadRows.length, 2, '未跟踪的会话全部按未读展示');
        const rowBadges = miniDom.document.querySelectorAll('.yl-message-session').map((row) => row.querySelector('.yl-badge--unread')?.textContent ?? '');
        assert.deepEqual(rowBadges, ['1', '2'], '苏晚 1 条 / 林澈 2 条未读徽章');
        const navButton = miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages');
        assert.equal(navButton.querySelector('.yl-nav-unread-badge')?.textContent, '3', '底部导航消息 tab 应挂未读总数徽章');

        click(byAria('打开与苏晚的私聊'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        const suRow = byAria('打开与苏晚的私聊');
        assert.equal(suRow.classList.contains('is-unread'), false, '打开会话即推进已读水位');
        assert.equal(suRow.querySelector('.yl-badge--unread'), null);
        assert.equal(navButton.querySelector('.yl-nav-unread-badge')?.textContent, '2', '导航徽章同步为剩余未读数');

        rightClick(byAria('打开与林澈的私聊'));
        click(byAria('标为已读'));
        assert.equal(miniDom.document.querySelectorAll('.yl-badge--unread').length, 0, '标为已读后行徽章全部消失');
        assert.equal(navButton.querySelector('.yl-nav-unread-badge'), null, '未读归零后导航徽章不渲染');
    } finally {
        mounted.destroy();
    }
});

test('long-press/right-click menu pins a session to the top with a pin mark, stored locally only', () => {
    const actionCalls = [];
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-message-pin',
        actionBridge: createBridge(actionCalls),
        settingsStore: null,
        llmClient: null,
        characterLibrary: null,
        readState: messageSearchReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        actionCalls.length = 0;

        const contextMenuEvent = rightClick(byAria('打开与林澈的私聊'));
        assert.equal(contextMenuEvent.defaultPrevented, true, '右键会话行应阻止浏览器默认菜单');
        const menu = miniDom.document.querySelector('.yl-message-session-menu');
        assert.ok(menu, '右键应弹出会话操作菜单');
        click(byAria('置顶会话'));

        assert.deepEqual(sessionNames(), ['林澈', '苏晚'], '置顶会话应排到最前');
        const pinnedRow = byAria('打开与林澈的私聊');
        assert.equal(pinnedRow.classList.contains('is-pinned'), true);
        assert.ok(pinnedRow.querySelector('.yl-session-pin'), '置顶行应带图钉标识');

        rightClick(byAria('打开与林澈的私聊'));
        click(byAria('取消置顶'));
        assert.deepEqual(sessionNames(), ['苏晚', '林澈'], '取消置顶恢复时间倒序');
        assert.deepEqual(actionCalls, [], '置顶/已读是纯本地 UI 状态，不得调用 action bridge');
    } finally {
        mounted.destroy();
    }
});

test('new-handshake rail shows matched sessions the player has not messaged and opens the chat directly', () => {
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-message-rail',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null,
        llmClient: null,
        characterLibrary: null,
        readState: messageSearchReadResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));

        const rail = miniDom.document.querySelector('.yl-new-match-rail');
        assert.ok(rail, '存在还没聊过的匹配对象时应显示新牵手 rail');
        const railNames = rail.querySelectorAll('.yl-new-match-name').map((node) => node.textContent);
        assert.deepEqual(railNames, ['苏晚'], '玩家已回过话的会话不进 rail');
        click(byAria('和苏晚开始聊天'));
        assert.ok(miniDom.document.querySelector('.yl-private-chat-screen'), 'rail 头像点击直达私聊');
    } finally {
        mounted.destroy();
    }
});

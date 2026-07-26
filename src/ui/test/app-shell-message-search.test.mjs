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
                    长期摘要: 'summary-must-not-render',
                },
                chat_su: {
                    对象UID: 'npc_su', 状态: '已匹配',
                    最近消息: [
                        { 消息UID: 'message_su_1', 发送者: '角色', 内容: '下班后一起沿江散步吧。', 时间: '21:00' },
                    ],
                    长期摘要: 'another-summary-must-not-render',
                },
            },
        },
    };
}

function click(node) {
    assert.ok(node, '要点击的控件必须存在');
    node.dispatchEvent(new Event('click'));
}

function messageSearchInput() {
    const input = miniDom.document.querySelector('.yl-message-search-input');
    assert.ok(input, '消息页应提供可访问的搜索输入框');
    assert.equal(input.getAttribute('aria-label'), '搜索私聊');
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

test('message search filters by public nickname or latest short message and clearing it restores every session without exposing private state', () => {
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

        assert.deepEqual(sessionNames(), ['林澈', '苏晚']);
        const input = messageSearchInput();
        enterSearch(input, '散步');
        assert.deepEqual(sessionNames(), ['苏晚'], '应按最近一条公开短消息过滤');

        const latestInput = messageSearchInput();
        enterSearch(latestInput, '林澈');
        assert.deepEqual(sessionNames(), ['林澈'], '应按公开昵称过滤');

        const clearInput = messageSearchInput();
        enterSearch(clearInput, '');
        assert.deepEqual(sessionNames(), ['林澈', '苏晚'], '清空搜索应恢复完整会话列表');
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

        const input = messageSearchInput();
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

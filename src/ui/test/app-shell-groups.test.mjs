import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';

const miniDom = installMiniDom();
const { mountPhoneApp } = await import('../../app-shell.js');
const { createGroupForumStore } = await import('../../groups/group-forum-store.js');
const { createMemoryStorage, createSettingsStore } = await import('../../settings/settings-store.js');

test.after(() => miniDom.restore());

function adultCharacter(nickname) {
    return {
        成人验证: true,
        公开资料: {
            昵称: nickname, 头像引用: 'https://example.invalid/public.webp', 年龄段: '25-29', 性别: '女', 性取向: '双性恋',
            城市: '上海', 距离范围: '10 km', 寻找意图: '聊天后约会', 简介: '这是公开资料。',
            兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'],
        },
        仅好友资料: { 关系状态: 'friend-secret-must-not-render', 边界与偏好: 'friend-boundary-must-not-render' },
        隐藏资料: { 实际年龄: 28, 私人备注: 'hidden-secret-must-not-render' },
        偏好与边界: 'internal-boundary-must-not-render',
        拒绝阈值: 40, 已读不回阈值: 55, 取消匹配阈值: 70, 拉黑阈值: 90,
        与玩家关系: { 状态: '已匹配', 全局账号表现: 82, NPC专属匹配度: 91, 好感: 20, 信任: 20, 戒备: 0, 面基意愿: 0 },
    };
}

function readResult() {
    return {
        ok: true,
        state: {
            软件: { 内容模式: 'SFW' },
            推荐: { 当前队列: [], 临时候选池: {} },
            角色池: { npc_group: adultCharacter('公开发现对象') },
            会话: {
                chat_group: {
                    对象UID: 'npc_group', 状态: '已匹配',
                    最近消息: [{ 消息UID: 'm_1', 发送者: '角色', 内容: 'session-secret-must-not-render', 时间: '' }],
                    长期摘要: 'session-summary-must-not-render',
                },
            },
            群组: {
                group_city: {
                    主题: '城市夜谈', 描述: '仅浏览公开兴趣的成年人群组。',
                    成员UID: ['npc_group'], 可发现角色UID: ['npc_group'],
                },
            },
        },
    };
}

function click(node) {
    node.dispatchEvent(new Event('click'));
}

function pointer(type, clientY, pointerId = 1, pointerType = undefined) {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, {
        clientY: { value: clientY }, pointerId: { value: pointerId }, pointerType: { value: pointerType }, isPrimary: { value: true },
    });
    return event;
}

function touch(type, clientY, identifier = 1, { ended = false } = {}) {
    const event = new Event(type, { cancelable: true });
    const point = { clientY, identifier };
    Object.defineProperties(event, {
        touches: { value: ended ? [] : [point] },
        changedTouches: { value: [point] },
    });
    return event;
}

function wheel(deltaY, deltaMode = 0) {
    const event = new Event('wheel', { cancelable: true });
    Object.defineProperties(event, { deltaY: { value: deltaY }, deltaMode: { value: deltaMode } });
    return event;
}

function forumRefreshPosts(author, { cityTitle = '雨后的书店', cityBody = '想找一间适合安静看书的小店。' } = {}) {
    return [
        { author, topic: '今日心情', title: '今天的小确幸', body: '下班路上买到喜欢的甜点，想把好心情分享出来。', tags: ['日常', '心情'] },
        { author, topic: '附近的人', title: '附近的晚风', body: '傍晚想在江边散步，欢迎同城朋友一起聊聊。', tags: ['附近', '散步'] },
        { author, topic: '同城瞬间', title: cityTitle, body: cityBody, tags: ['书店', '同城'] },
        { author, topic: '兴趣同频', title: '周末影展同好', body: '想找喜欢电影的人一起选一场周末影展。', tags: ['电影', '同好'] },
        { author, topic: '话题广场', title: '你的治愈小事', body: '聊聊这一周让你感觉被治愈的瞬间吧。', tags: ['话题', '分享'] },
    ];
}

function connectionPreset(id, name = id) {
    return {
        id, name,
        url: 'https://api.example.invalid/v1', model: `${id}-model`,
        temperature: 0.6, maxTokens: 256, timeoutMs: 30_000, transportMode: 'json',
    };
}

test('chat group menu creates a browser-local room from private-chat public profiles and honors automatic-update mode', async () => {
    const events = [];
    const writes = { parse: 0, replace: 0, event: 0, groupUpdates: 0 };
    const bridge = {
        emit(kind, payload) { events.push({ kind, payload }); },
        isPending() { return false; },
        runMvuAction() { writes.parse += 1; },
        runPrivateChat() { writes.replace += 1; },
        runMeetupHandoff() { writes.event += 1; },
        async generateGroupConversationUpdate(request) {
            writes.groupUpdates += 1;
            assert.equal(request.group.scope, 'local');
            return { ok: true, update: { participants: [], messages: [{ speaker: '公开发现对象', text: '我也想去，周六下午见。' }] } };
        },
    };
    const groupForumStore = createGroupForumStore({ now: () => new Date('2026-07-22T04:00:00.000Z') });
    await groupForumStore.ready();
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-groups',
        actionBridge: bridge,
        settingsStore: null,
        llmClient: null,
        characterLibrary: null,
        groupForumStore,
        readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'groups'));
        assert.match(miniDom.document.body.textContent, /聊天群/u);
        assert.match(miniDom.document.body.textContent, /心动社区/u);
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('聊天群')));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '聊天群创建与查找'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '创建'));

        const name = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '编辑群名');
        name.value = '周末看展小队'; name.dispatchEvent(new Event('input'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '选择私聊角色'));
        const picker = miniDom.document.querySelector('.yl-group-member-picker');
        assert.equal(picker.hidden, false);
        const member = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '选择公开发现对象');
        member.checked = true; member.dispatchEvent(new Event('change'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '确认添加'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '确认创建'));
        await flushUi();

        assert.match(miniDom.document.body.textContent, /周末看展小队/u);
        assert.match(miniDom.document.body.textContent, /公开发现对象/u);
        const firstInput = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入群消息');
        firstInput.value = '周六下午有人想去看展吗？'; firstInput.dispatchEvent(new Event('input'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送群消息'));
        await flushUi();
        assert.equal(writes.groupUpdates, 1, '关闭自动更新时，玩家发言后应调用一次群聊 AI');

        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开周末看展小队的更多操作'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '自动更新设置'));
        const enabled = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '开启聊天群自动更新');
        const seconds = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '自动更新时间秒数');
        assert.equal(seconds.disabled, true, '关闭自动更新时，秒数输入应不可编辑');
        enabled.checked = true; enabled.dispatchEvent(new Event('change'));
        assert.equal(seconds.disabled, false, '开启后，秒数输入应立即可编辑');
        seconds.value = '5';
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '确定'));
        await flushUi();
        const secondInput = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入群消息');
        secondInput.value = '我已经到展馆附近了。'; secondInput.dispatchEvent(new Event('input'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送群消息'));
        await flushUi();
        assert.equal(writes.groupUpdates, 1, '开启自动更新后，玩家发言不应额外调用 AI');

        const local = await groupForumStore.snapshot();
        assert.equal(local.groups.length, 1);
        assert.equal(local.threads[0].auto.enabled, true);
        assert.equal(local.threads[0].auto.intervalSeconds, 5);
        const dom = miniDom.document.body.textContent;
        for (const forbidden of ['friend-secret-must-not-render', 'friend-boundary-must-not-render', 'hidden-secret-must-not-render', 'internal-boundary-must-not-render', 'session-secret-must-not-render', 'session-summary-must-not-render', '全局账号表现', 'NPC专属匹配度', '拒绝阈值', 'chat_group', 'npc_group']) {
            assert.equal(dom.includes(forbidden), false, `groups DOM must not render ${forbidden}`);
        }
        assert.deepEqual(writes, { parse: 0, replace: 0, event: 0, groupUpdates: 1 });
    } finally {
        mounted.destroy();
    }
});

test('enabled group auto-update invokes the selected group AI on its configured timer only while the room stays open', async () => {
    const previousSetInterval = globalThis.setInterval;
    const previousClearInterval = globalThis.clearInterval;
    const timers = [];
    globalThis.setInterval = (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
    };
    globalThis.clearInterval = (timer) => { if (timer) timer.cleared = true; };
    const groupForumStore = createGroupForumStore({ now: () => new Date('2026-07-22T04:00:00.000Z') });
    await groupForumStore.ready();
    const member = { nickname: '林澈', ageRange: '25-29', gender: '女', city: '上海', mbti: 'INFJ', zodiac: '双鱼座', occupation: '摄影师', interests: ['摄影'], presence: '在线', matchRate: null };
    await groupForumStore.createGroup({ name: '定时测试群', members: [member] });
    const calls = [];
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-group-auto-timer',
        actionBridge: {
            emit() {}, isPending() { return false; },
            async generateGroupConversationUpdate(request) {
                calls.push(request);
                return { ok: true, update: { participants: [], messages: [{ speaker: '林澈', text: '定时更新的群消息。' }] } };
            },
        },
        settingsStore: null, llmClient: null, characterLibrary: null, groupForumStore, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'groups'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('聊天群')));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开定时测试群'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开定时测试群的更多操作'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '自动更新设置'));
        const enabled = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '开启聊天群自动更新');
        const seconds = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '自动更新时间秒数');
        assert.equal(seconds.disabled, true);
        enabled.checked = true; enabled.dispatchEvent(new Event('change'));
        assert.equal(seconds.disabled, false);
        seconds.value = '5';
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '确定'));
        await flushUi();
        assert.equal(timers.length, 1);
        assert.equal(timers[0].delay, 5_000);
        timers[0].callback();
        await flushUi();
        assert.equal(calls.length, 1);
        assert.equal(calls[0].trigger, 'auto');
        assert.equal((await groupForumStore.snapshot()).threads[0].messages[0].content, '定时更新的群消息。');
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '返回'));
        assert.equal(timers[0].cleared, true, '离开聊天群时必须停止定时器');
    } finally {
        mounted.destroy();
        globalThis.setInterval = previousSetInterval;
        globalThis.clearInterval = previousClearInterval;
    }
});

test('group room right-top more menu exposes exit, clear-history, automatic settings, and per-group presets without touching MVU', async () => {
    const groupForumStore = createGroupForumStore({ now: () => new Date('2026-07-22T04:00:00.000Z') });
    await groupForumStore.ready();
    const member = { nickname: '林澈', ageRange: '25-29', gender: '女', city: '上海', mbti: 'INFJ', zodiac: '双鱼座', occupation: '摄影师', interests: ['摄影'], presence: '在线', matchRate: null };
    const group = await groupForumStore.createGroup({ name: '菜单测试群', members: [member] });
    await groupForumStore.appendGroupUserMessage({ key: group.id, title: group.name, content: '会被清空的本地消息。' });
    await groupForumStore.setGroupAuto({ key: group.id, title: group.name, settings: { enabled: true, intervalSeconds: 30 } });
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-group-room-menu',
        actionBridge: { emit() {}, isPending() { return false; } }, settingsStore: null, llmClient: null,
        characterLibrary: null, groupForumStore, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'groups'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('聊天群')));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开菜单测试群'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开菜单测试群的更多操作'));
        assert.match(miniDom.document.body.textContent, /退出群聊|清空群历史|自动更新设置|预设/u);
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '清空群历史'));
        assert.match(miniDom.document.body.textContent, /只会删除聊天消息/u);
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '确认清空群历史'));
        await flushUi();
        let snapshot = await groupForumStore.snapshot();
        assert.equal(snapshot.groups.length, 1);
        assert.equal(snapshot.threads[0].messages.length, 0);
        assert.deepEqual(snapshot.threads[0].auto, { enabled: true, intervalSeconds: 30 });

        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开菜单测试群的更多操作'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '退出群聊'));
        assert.match(miniDom.document.body.textContent, /删除该本地群/u);
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '确认退出群聊'));
        await flushUi();
        snapshot = await groupForumStore.snapshot();
        assert.equal(snapshot.groups.length, 0);
        assert.equal(snapshot.threads.length, 0);
        assert.equal(miniDom.document.body.textContent.includes('菜单测试群'), false);
    } finally {
        mounted.destroy();
    }
});

test('group preset binding is removed from the chat-group home and saved independently for each room', async () => {
    const groupForumStore = createGroupForumStore({ now: () => new Date('2026-07-22T04:00:00.000Z') });
    await groupForumStore.ready();
    const member = { nickname: '林澈', ageRange: '25-29', gender: '女', city: '上海', mbti: 'INFJ', zodiac: '双鱼座', occupation: '摄影师', interests: ['摄影'], presence: '在线', matchRate: null };
    const first = await groupForumStore.createGroup({ name: '预设甲群', members: [member] });
    await groupForumStore.createGroup({ name: '预设乙群', members: [{ ...member, nickname: '周遥' }] });
    const settingsStore = createSettingsStore({ storage: createMemoryStorage() });
    settingsStore.addConnectionPreset(connectionPreset('group_conn', '群聊连接'));
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-group-local-binding',
        actionBridge: { emit() {}, isPending() { return false; } }, settingsStore, llmClient: null,
        characterLibrary: null, groupForumStore, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'groups'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('聊天群')));
        assert.equal(miniDom.document.querySelector('.yl-feature-options'), null, '聊天群首页不应再显示全局绑定设置');
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === `打开${first.name}`));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === `打开${first.name}的更多操作`));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '预设'));
        const firstConnection = miniDom.document.querySelector('[name="group_chat-quick-connection"]');
        assert.ok(firstConnection, '预设应在具体群的更多菜单内打开');
        firstConnection.value = 'group_conn';
        const firstPrompt = miniDom.document.querySelector('[name="group_chat-quick-prompt"]');
        firstPrompt.value = 'builtin_group_chat_sfw';
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '保存此功能绑定'));
        await flushUi();
        let snapshot = await groupForumStore.snapshot();
        assert.deepEqual(snapshot.threads.find((thread) => thread.key === first.id)?.bindings.SFW, { connectionPresetId: 'group_conn', promptPresetId: 'builtin_group_chat_sfw' });
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '关闭功能预设选项'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '返回'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开预设乙群'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开预设乙群的更多操作'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '预设'));
        assert.equal(miniDom.document.querySelector('[name="group_chat-quick-connection"]').value, '', '另一群不应继承第一群的绑定');
        snapshot = await groupForumStore.snapshot();
        assert.equal(snapshot.threads.some((thread) => thread.key !== first.id && thread.bindings.SFW.connectionPresetId === 'group_conn'), false);
        assert.equal(settingsStore.snapshot().functionModeBindings.group_chat.SFW.connectionPresetId, null, '群内绑定不能反写到全局设置仓库');
    } finally {
        mounted.destroy();
    }
});



function emptyPoolReadResult() {
    return {
        ok: true,
        state: {
            系统: { UID计数器: { 角色: 0 } },
            软件: { 内容模式: 'SFW' },
            推荐: { 当前队列: [], 临时候选池: {}, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
            角色池: {}, 会话: {}, 群组: {},
        },
    };
}

async function flushUi() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
}

test('empty candidate card refresh invokes the fast recommendation bridge without exposing creation controls', async () => {
    const events = [];
    let initialCalls = 0;
    const bridge = {
        emit(kind, payload) { events.push({ kind, payload }); },
        isPending() { return false; },
        async runRecommendationInitialCandidate() { initialCalls += 1; return { ok: true }; },
        runMvuAction() { throw new Error('must not use generic action'); },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-empty-pool', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: emptyPoolReadResult,
    });
    try {
        const launcher = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机');
        click(launcher);
        const refresh = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '刷新');
        assert.ok(refresh, 'empty candidate card must expose its refresh action');
        assert.equal(miniDom.document.body.textContent.includes('快速随机创建候选人'), false);
        click(refresh);
        await flushUi();

        assert.equal(initialCalls, 1);
        assert.equal(events.some((entry) => entry.kind === 'open_random_candidates'), true);
        assert.equal(miniDom.document.body.textContent.includes('后续阶段接入'), false);
        assert.match(miniDom.document.body.textContent, /已通过成年人校验/u);
    } finally {
        mounted.destroy();
    }
});


test('about child page exposes version/update dialogs, hidden mode control, and the consent-first service hub', async () => {
    let toggleCalls = 0;
    let serviceGenerateCalls = 0;
    let serviceHandoffCalls = 0;
    let serviceRepeatCalls = 0;
    const handoffDrafts = [];
    const events = [];
    const serviceState = emptyPoolReadResult().state;
    serviceState.系统 = { UID计数器: { 角色: 0, 服务订单: 0 } };
    serviceState.服务订单 = {};
    const bridge = {
        emit(kind, payload) { events.push({ kind, payload }); },
        isPending() { return false; },
        async runMvuAction(kind) { assert.equal(kind, 'toggle_content_mode'); toggleCalls += 1; return { ok: true }; },
        async generateCharacterAuthoringDraft({ expectedContentMode }) { assert.equal(expectedContentMode, 'SFW'); serviceGenerateCalls += 1; return { ok: true, candidate: adultCharacter('林澄') }; },
        async runServiceOrderHandoff({ candidate, categoryId, expectedContentMode }) {
            assert.equal(candidate.公开资料.昵称, '林澄'); assert.equal(categoryId, 'coffee_walk'); assert.equal(expectedContentMode, 'SFW');
            serviceHandoffCalls += 1;
            serviceState.角色池.npc_service_1 = structuredClone(candidate);
            serviceState.服务订单.service_1 = { 角色UID: 'npc_service_1', 内容模式: 'SFW', 服务分类: 'coffee_walk', 服务主题: '咖啡与散步：与林澄的文字协商', 状态: '待确认', 发起时间: '待正文确认', 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '' };
            return { ok: true, orderUid: 'service_1' };
        },
        async runServiceOrderRepeat({ sourceOrderUid, expectedContentMode }) {
            assert.equal(sourceOrderUid, 'service_1'); assert.equal(expectedContentMode, 'SFW'); serviceRepeatCalls += 1;
            serviceState.服务订单.service_2 = { 角色UID: 'npc_service_1', 内容模式: 'SFW', 服务分类: 'coffee_walk', 服务主题: '咖啡与散步：与林澄的文字协商', 状态: '待确认', 发起时间: '待正文确认', 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '' };
            return { ok: true, orderUid: 'service_2' };
        },
        appendMeetupDraft(draft) { handoffDrafts.push(draft); return { ok: true }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-about', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => ({ ok: true, state: serviceState }),
    });
    try {
        const launcher = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机');
        click(launcher);
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'profile'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('设置')));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '关于软件'));

        assert.ok(miniDom.document.querySelector('.yl-page-back'), '关于软件应是可返回的子界面');
        const version = () => miniDom.document.querySelector('[name="about-version-info"]');
        for (let index = 0; index < 5; index += 1) {
            click(version());
            const dialog = miniDom.document.querySelector('.yl-operation-dialog');
            assert.equal(dialog.hidden, false);
            assert.match(dialog.textContent, /当前版本：0.1.36/u);
        }
        const modeEntry = miniDom.document.querySelector('[name="about-content-mode-entry"]');
        assert.ok(modeEntry, '连续五次版本信息后应显示内容模式隐藏入口');
        click(modeEntry);
        const toggle = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '内容模式切换');
        assert.ok(toggle);
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await flushUi();
        assert.equal(toggleCalls, 1);

        const releases = () => miniDom.document.querySelector('[name="about-release-notes"]');
        for (let index = 0; index < 5; index += 1) {
            click(releases());
            const dialog = miniDom.document.querySelector('.yl-operation-dialog');
            assert.equal(dialog.hidden, false);
            assert.match(dialog.textContent, /最近三次更新/u);
            assert.match(dialog.textContent, /v0.1.36/u);
        }
        const serviceEntry = miniDom.document.querySelector('[name="about-service-entry"]');
        assert.ok(serviceEntry, '连续五次更新日志后应显示专属服务入口');
        click(serviceEntry);

        const serviceNav = miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'service_hub');
        assert.ok(serviceNav);
        assert.equal(serviceNav.hidden, false, '服务导航应插在群组和我的之间并可见');
        const primaryNavPages = miniDom.document.querySelectorAll('.yl-phone-nav-item').map((node) => node.dataset.page);
        assert.ok(primaryNavPages.indexOf('groups') < primaryNavPages.indexOf('service_hub'));
        assert.ok(primaryNavPages.indexOf('service_hub') < primaryNavPages.indexOf('profile'));
        assert.match(miniDom.document.body.textContent, /今日陪伴计划/u);
        const serviceTabs = () => miniDom.document.querySelectorAll('.yl-service-tab');
        assert.deepEqual(serviceTabs().map((node) => node.textContent), ['⌂首页', '◇发现', '♡服务', '◷历史']);
        const firstServiceCategory = miniDom.document.querySelector('[name="service-category-coffee_walk"]');
        assert.ok(firstServiceCategory, '首页应显示可直接生成角色的服务分类');
        click(firstServiceCategory);
        await flushUi();
        assert.equal(serviceGenerateCalls, 3, '同一批本地草稿必须串行生成三位角色');
        assert.match(miniDom.document.body.textContent, /林澄/u);
        assert.match(miniDom.document.body.textContent, /复制到 MVU 并创建服务记录/u);
        const profileAction = miniDom.document.querySelector('[name="service-profile-service_local_1"]');
        assert.equal(handoffDrafts.length, 0, '选择前不得接管正文输入框');
        click(profileAction);
        await flushUi();
        assert.equal(serviceHandoffCalls, 1);
        assert.equal(handoffDrafts.length, 1);
        assert.match(handoffDrafts[0], /【本次新建的待确认订单】/u);
        assert.doesNotMatch(handoffDrafts[0], /service_1/u, '正文草稿不得暴露内部订单 UID');
        assert.match(handoffDrafts[0], /与「林澄」体验「咖啡与散步」租借陪伴主题/u);
        assert.doesNotMatch(handoffDrafts[0], /自动发送/u);
        click(serviceTabs()[2]);
        assert.match(miniDom.document.body.textContent, /林澄/u);
        assert.match(miniDom.document.body.textContent, /待确认/u);

        serviceState.服务订单.service_1.状态 = '进行中';
        serviceState.服务订单.service_1.开始时间 = '已开始';
        serviceState.服务订单.service_1.已确认边界 = 'hidden-boundary-must-not-render';
        mounted.refreshState();
        assert.match(miniDom.document.body.textContent, /进行中/u);
        assert.doesNotMatch(miniDom.document.body.textContent, /hidden-boundary-must-not-render/u);

        serviceState.服务订单.service_1.状态 = '已完成';
        serviceState.服务订单.service_1.结束时间 = '已结束';
        serviceState.服务订单.service_1.结束摘要 = '双方已确认结束，未包含现实信息。';
        mounted.refreshState();
        assert.match(miniDom.document.body.textContent, /暂无进行中的服务/u);
        click(serviceTabs()[3]);
        assert.match(miniDom.document.body.textContent, /林澄/u);
        const repeat = miniDom.document.querySelector('[name="service-order-repeat"]');
        assert.ok(repeat, '完整终态订单应仅从历史入口再次下单');
        click(repeat);
        await flushUi();
        assert.equal(serviceRepeatCalls, 1);
        assert.equal(handoffDrafts.length, 2);
        assert.match(handoffDrafts[1], /【本次新建的待确认订单】/u);
        assert.doesNotMatch(handoffDrafts[1], /service_2/u, '复约草稿不得暴露内部订单 UID');
        click(serviceTabs()[2]);
        assert.match(miniDom.document.body.textContent, /待确认/u);

        assert.equal(events.some((entry) => entry.kind === 'navigate' && entry.payload.page === 'about'), true);
        assert.equal(events.some((entry) => entry.kind === 'navigate' && entry.payload.page === 'service_hub'), true);
    } finally {
        mounted.destroy();
    }
});

test('personal profile safely calls the controlled public-profile bridge when the host provides it', async () => {
    const submitted = [];
    const bridge = {
        emit() {}, isPending() { return false; },
        async runSavePlayerPublicProfile(profile) { submitted.push(profile); return { ok: true }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-player-profile', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: emptyPoolReadResult,
    });
    try {
        const launcher = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机');
        click(launcher);
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'profile'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('个人资料')));
        const save = miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('保存公开资料'));
        assert.ok(save, 'a supported host must expose the controlled save action');
        click(save);
        await flushUi();

        assert.equal(submitted.length, 1);
        assert.deepEqual(Object.keys(submitted[0]).sort(), ['昵称', '头像引用', '年龄段', '性别', '性取向', '城市', '距离范围', '寻找意图', '简介', '兴趣标签', '生活方式标签', '性格标签', '沟通风格标签'].sort());
        assert.doesNotMatch(JSON.stringify(submitted[0]), /隐藏|仅好友|实际年龄/u);
    } finally {
        mounted.destroy();
    }
});

test('summary archive lists private chats, local chat groups, and forum posts while keeping local summaries outside MVU', async () => {
    const settingsStore = createSettingsStore({ storage: createMemoryStorage() });
    settingsStore.setChatSummarySettings({ enabled: true, interval: 2, retryLimit: 0 });
    const groupForumStore = createGroupForumStore({ now: () => new Date('2026-07-22T04:00:00.000Z') });
    await groupForumStore.ready();
    const member = { nickname: '林澈', ageRange: '25-29', gender: '女', city: '上海', mbti: 'INFJ', zodiac: '双鱼座', occupation: '摄影师', interests: ['摄影'], presence: '在线', matchRate: null };
    const group = await groupForumStore.createGroup({ name: '同城看展群', members: [member] });
    await groupForumStore.appendGroupUserMessage({ key: group.id, title: group.name, content: '周末一起看展吗？' });
    await groupForumStore.saveConversationSummary({ target: { kind: 'group', id: group.id }, startFloor: 1, endFloor: 1, content: '玩家在群内发出周末看展邀请。' });
    const createdPosts = await groupForumStore.addForumRefresh({
        communityProfiles: [],
        update: {
            participants: [{ ...member, nickname: '许青', city: '杭州', mbti: 'ENFP', occupation: '插画师', interests: ['书店'] }],
            posts: forumRefreshPosts('许青'),
        },
    });
    const post = createdPosts.find((item) => item.title === '雨后的书店');
    assert.ok(post);
    await groupForumStore.appendForumUserComment({ postId: post.id, content: '周末会开放吗？' });
    await groupForumStore.saveConversationSummary({ target: { kind: 'post', id: post.id }, startFloor: 1, endFloor: 1, content: '玩家询问书店周末是否开放。' });

    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-local-summary-history', actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore, llmClient: null, characterLibrary: null, groupForumStore, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'profile'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('设置')));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('对话总结')));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('总结档案')));
        const archive = miniDom.document.body.textContent;
        assert.match(archive, /私聊总结/u);
        assert.match(archive, /聊天群总结/u);
        assert.match(archive, /论坛帖子总结/u);
        assert.match(archive, /同城看展群/u);
        assert.match(archive, /雨后的书店/u);
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '查看同城看展群的总结档案'));
        assert.match(miniDom.document.body.textContent, /玩家在群内发出周末看展邀请/u);
        assert.doesNotMatch(JSON.stringify(await groupForumStore.snapshot()), /stat_data|对象UID|JSONPatch/u);
    } finally {
        mounted.destroy();
    }
});

test('forum home only calls AI after an armed pull gesture, and opened posts update local discussion after a user reply', async () => {
    let homeCalls = 0;
    let postCalls = 0;
    const temporaryProfile = {
        nickname: '苏晴', ageRange: '25-29', gender: '女', city: '上海', mbti: 'ISFP', zodiac: '天秤座', occupation: '花艺师', interests: ['花店'], presence: '在线', matchRate: null,
    };
    const bridge = {
        emit() {}, isPending() { return false; },
        async generateForumHomeRefresh() {
            homeCalls += 1;
            return { ok: true, communityProfiles: [], update: { participants: [temporaryProfile], posts: forumRefreshPosts('苏晴') } };
        },
        async generateForumPostConversationUpdate(request) {
            postCalls += 1;
            assert.equal(request.post.title, '雨后的书店');
            return { ok: true, update: { participants: [], messages: [{ speaker: '苏晴', text: '上午会比较安静，欢迎早点来。' }] } };
        },
    };
    const groupForumStore = createGroupForumStore({ now: () => new Date('2026-07-22T04:00:00.000Z') });
    await groupForumStore.ready();
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-group-drafts', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, groupForumStore, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'groups'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('心动社区')));
        const surface = miniDom.document.querySelector('.yl-forum-home');
        surface.dispatchEvent(pointer('pointerdown', 0));
        surface.dispatchEvent(pointer('pointermove', 104));
        surface.dispatchEvent(pointer('pointermove', 44));
        surface.dispatchEvent(pointer('pointerup', 44));
        await flushUi();
        assert.equal(homeCalls, 0, '上拉取消后不得调用论坛 AI');

        const armedSurface = miniDom.document.querySelector('.yl-forum-home');
        armedSurface.dispatchEvent(pointer('pointerdown', 0, 2));
        armedSurface.dispatchEvent(pointer('pointermove', 104, 2));
        assert.equal(miniDom.document.querySelector('.yl-forum-pull-indicator').classList.contains('is-armed'), true);
        armedSurface.dispatchEvent(pointer('pointerup', 104, 2));
        await flushUi();
        assert.equal(homeCalls, 1, '到达下拉阈值并松开后才调用论坛 AI');
        assert.match(miniDom.document.body.textContent, /雨后的书店/u);

        const touchSurface = miniDom.document.querySelector('.yl-forum-home');
        touchSurface.dispatchEvent(touch('touchstart', 0, 3));
        touchSurface.dispatchEvent(touch('touchmove', 104, 3));
        assert.equal(miniDom.document.querySelector('.yl-forum-pull-indicator').classList.contains('is-armed'), true, 'Touch Events 也应能把顶部刷新手势解锁');
        touchSurface.dispatchEvent(touch('touchend', 104, 3, { ended: true }));
        await flushUi();
        assert.equal(homeCalls, 2, '没有 Pointer Events 的手机 WebView 也应在触摸下拉松开后刷新帖子');
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开帖子：雨后的书店'));
        const input = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入论坛评论');
        input.value = '周末人会很多吗？'; input.dispatchEvent(new Event('input'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送论坛评论'));
        await flushUi();
        assert.equal(postCalls, 1);
        const snapshot = await groupForumStore.snapshot();
        assert.equal(snapshot.posts.find((post) => post.title === '雨后的书店')?.messages.length, 2);
        assert.doesNotMatch(JSON.stringify(snapshot), /session-secret|对象UID|stat_data/u);
    } finally {
        mounted.destroy();
    }
});

test('forum channel cards are actionable subareas and filter the local feed without issuing an extra AI request', async () => {
    const profile = {
        nickname: '许青', ageRange: '25-29', gender: '女', city: '杭州', mbti: 'ENFP', zodiac: '双鱼座', occupation: '插画师', interests: ['书店'], presence: '在线', matchRate: null,
    };
    const groupForumStore = createGroupForumStore({ now: () => new Date('2026-07-22T04:00:00.000Z') });
    await groupForumStore.ready();
    await groupForumStore.addForumRefresh({ communityProfiles: [], update: { participants: [profile], posts: forumRefreshPosts('许青') } });
    let refreshCalls = 0;
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-forum-channels',
        actionBridge: { emit() {}, isPending() { return false; }, async generateForumHomeRefresh() { refreshCalls += 1; return { ok: false }; } },
        settingsStore: null, llmClient: null, characterLibrary: null, groupForumStore, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'groups'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('心动社区')));
        const content = miniDom.document.querySelector('.yl-phone-content');
        content.scrollTop = 48;
        const mood = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('data-forum-channel') === 'daily_mood');
        assert.ok(mood);
        click(mood);
        assert.equal(content.scrollTop, 0, '进入子区后应回到该频道列表顶部');
        assert.match(miniDom.document.body.textContent, /今日心情 · 子区/u);
        assert.match(miniDom.document.body.textContent, /今天的小确幸/u);
        assert.doesNotMatch(miniDom.document.body.textContent, /雨后的书店/u);
        const activeMood = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('data-forum-channel') === 'daily_mood');
        assert.equal(activeMood.getAttribute('aria-pressed'), 'true');
        assert.match(activeMood.getAttribute('aria-label'), /返回心动社区全部动态/u);
        click(activeMood);
        assert.match(miniDom.document.body.textContent, /雨后的书店/u);
        assert.equal(refreshCalls, 0, '切换本地频道不应额外调用论坛 AI');
    } finally {
        mounted.destroy();
    }
});

test('heart community settings toggle updates all existing local posts on its timer without creating a post', async () => {
    const previousSetInterval = globalThis.setInterval;
    const previousClearInterval = globalThis.clearInterval;
    const timers = [];
    globalThis.setInterval = (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
    };
    globalThis.clearInterval = (timer) => { if (timer) timer.cleared = true; };
    const profile = {
        nickname: '顾宁', ageRange: '25-29', gender: '女', city: '上海', mbti: 'INFJ', zodiac: '双鱼座', occupation: '编辑', interests: ['阅读'], presence: '在线', matchRate: null,
    };
    const groupForumStore = createGroupForumStore({ now: () => new Date('2026-07-22T04:00:00.000Z') });
    await groupForumStore.ready();
    await groupForumStore.addForumRefresh({ communityProfiles: [], update: { participants: [profile], posts: forumRefreshPosts('顾宁') } });
    const settingsStore = createSettingsStore({ storage: createMemoryStorage() });
    settingsStore.addConnectionPreset(connectionPreset('channel_conn', '频道连接'));
    settingsStore.addConnectionPreset(connectionPreset('post_conn', '帖子连接'));
    let homeCalls = 0;
    let existingCalls = 0;
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-forum-auto',
        actionBridge: {
            emit() {}, isPending() { return false; },
            async generateForumHomeRefresh() { homeCalls += 1; return { ok: false }; },
            async generateForumExistingPostsUpdate(request) {
                existingCalls += 1;
                assert.equal(request.posts.length, 5);
                return { ok: true, update: { updates: request.posts.map((post, index) => ({ slot: index + 1, title: `自动更新：${post.title}`, body: `这是第${index + 1}篇已有帖子的新内容。`, tags: ['自动更新'] })) } };
            },
        }, settingsStore, llmClient: null, characterLibrary: null, groupForumStore, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'groups'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('心动社区')));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开心动社区设置'));
        const enabled = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '开启帖子自动更新');
        const interval = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '帖子自动更新时间秒数');
        assert.equal(interval.disabled, true, '关闭帖子自动更新时，秒数输入必须是灰色不可编辑');
        enabled.checked = true; enabled.dispatchEvent(new Event('change'));
        assert.equal(interval.disabled, false);
        interval.value = '11';
        miniDom.document.querySelector('[name="forum-channel-connection"]').value = 'channel_conn';
        miniDom.document.querySelector('[name="forum-channel-prompt"]').value = 'builtin_forum_sfw';
        miniDom.document.querySelector('[name="forum-post-connection"]').value = 'post_conn';
        miniDom.document.querySelector('[name="forum-post-prompt"]').value = 'builtin_forum_sfw';
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '确定'));
        await flushUi();
        assert.equal(timers.length, 1);
        assert.equal(timers[0].delay, 11_000);
        timers[0].callback();
        await flushUi();
        const snapshot = await groupForumStore.snapshot();
        assert.equal(existingCalls, 1);
        assert.equal(homeCalls, 0, '自动更新不可创建新帖子');
        assert.equal(snapshot.posts.length, 5);
        assert.match(snapshot.posts[0].title, /^自动更新：/u);
        assert.equal(snapshot.posts.every((post) => post.tags[0] === '自动更新'), true);
        assert.deepEqual(snapshot.forumAuto.channelBindings.SFW, { connectionPresetId: 'channel_conn', promptPresetId: 'builtin_forum_sfw' });
        assert.deepEqual(snapshot.forumAuto.postBindings.SFW, { connectionPresetId: 'post_conn', promptPresetId: 'builtin_forum_sfw' });
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '返回'));
        assert.equal(timers[0].cleared, true, '离开心动社区时必须停止既有帖子自动更新');
    } finally {
        mounted.destroy();
        globalThis.setInterval = previousSetInterval;
        globalThis.clearInterval = previousClearInterval;
    }
});

test('desktop wheel pull refreshes only from the forum top after the wheel settles, and reverse scrolling cancels it', async () => {
    const previousSetTimeout = globalThis.setTimeout;
    const previousClearTimeout = globalThis.clearTimeout;
    const timers = [];
    globalThis.setTimeout = (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
    };
    globalThis.clearTimeout = (timer) => { if (timer) timer.cleared = true; };
    let homeCalls = 0;
    const temporaryProfile = {
        nickname: '江晚', ageRange: '25-29', gender: '女', city: '上海', mbti: 'INTJ', zodiac: '天蝎座', occupation: '策展人', interests: ['展览'], presence: '在线', matchRate: null,
    };
    const groupForumStore = createGroupForumStore({ now: () => new Date('2026-07-22T04:00:00.000Z') });
    await groupForumStore.ready();
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-forum-wheel-pull',
        actionBridge: {
            emit() {}, isPending() { return false; },
            async generateForumHomeRefresh() {
                homeCalls += 1;
                return { ok: true, communityProfiles: [], update: { participants: [temporaryProfile], posts: forumRefreshPosts('江晚', { cityTitle: '美术馆的午后', cityBody: '想找一位同好一起看新展。' }) } };
            },
        },
        settingsStore: null, llmClient: null, characterLibrary: null, groupForumStore, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'groups'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('心动社区')));
        const content = miniDom.document.querySelector('.yl-phone-content');
        const surface = miniDom.document.querySelector('.yl-forum-home');

        content.scrollTop = 24;
        content.dispatchEvent(wheel(-200));
        assert.equal(timers.length, 0, '非顶部滚轮不能开始刷新手势');

        content.scrollTop = 0;
        surface.dispatchEvent(pointer('pointerdown', 0, 9, 'mouse'));
        surface.dispatchEvent(pointer('pointermove', 120, 9, 'mouse'));
        surface.dispatchEvent(pointer('pointerup', 120, 9, 'mouse'));
        assert.equal(miniDom.document.querySelector('.yl-forum-pull-indicator').classList.contains('is-armed'), false, '桌面鼠标拖动不应替代滚轮刷新');
        content.dispatchEvent(wheel(-100));
        content.dispatchEvent(wheel(-100));
        const armed = miniDom.document.querySelector('.yl-forum-pull-indicator');
        assert.equal(armed.classList.contains('is-armed'), true);
        const cancelledTimer = timers.at(-1);
        assert.equal(cancelledTimer.delay, 180);
        content.dispatchEvent(wheel(40));
        assert.equal(cancelledTimer.cleared, true);
        assert.equal(armed.classList.contains('is-visible'), false);
        cancelledTimer.callback();
        await flushUi();
        assert.equal(homeCalls, 0, '反向向下滚动必须取消本轮刷新');

        content.dispatchEvent(wheel(-100));
        content.dispatchEvent(wheel(-100));
        const releaseTimer = timers.at(-1);
        releaseTimer.callback();
        await flushUi();
        assert.equal(homeCalls, 1, '顶部向上滚动达到阈值、停滚后才刷新');
        assert.match(miniDom.document.body.textContent, /美术馆的午后/u);
    } finally {
        mounted.destroy();
        globalThis.setTimeout = previousSetTimeout;
        globalThis.clearTimeout = previousClearTimeout;
    }
});

test('forum top refresh replaces old posts and bottom loading appends posts only after reaching the end', async () => {
    const previousSetTimeout = globalThis.setTimeout;
    const previousClearTimeout = globalThis.clearTimeout;
    const timers = [];
    globalThis.setTimeout = (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
    };
    globalThis.clearTimeout = (timer) => { if (timer) timer.cleared = true; };
    const oldProfile = { nickname: '旧作者', ageRange: '25-29', gender: '女', city: '上海', mbti: 'INFJ', zodiac: '双鱼座', occupation: '编辑', interests: ['阅读'], presence: '在线', matchRate: null };
    const groupForumStore = createGroupForumStore({ now: () => new Date('2026-07-22T04:00:00.000Z') });
    await groupForumStore.ready();
    const oldBatch = await groupForumStore.addForumRefresh({ communityProfiles: [], update: { participants: [oldProfile], posts: forumRefreshPosts('旧作者', { cityTitle: '旧帖子' }) } });
    const oldPost = oldBatch.find((post) => post.title === '旧帖子');
    await groupForumStore.appendForumUserComment({ postId: oldPost.id, content: '旧评论。' });
    await groupForumStore.saveConversationSummary({ target: { kind: 'post', id: oldPost.id }, startFloor: 1, endFloor: 1, content: '旧总结。' });
    const requests = [];
    const freshProfile = { ...oldProfile, nickname: '新作者', occupation: '策展人' };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-forum-replace-append',
        actionBridge: {
            emit() {}, isPending() { return false; },
            async generateForumHomeRefresh(request) {
                requests.push(request);
                const prefix = request.refreshMode === 'replace' ? '替换' : '追加';
                return {
                    ok: true, communityProfiles: [],
                    update: { participants: [freshProfile], posts: forumRefreshPosts('新作者', { cityTitle: `${prefix}新帖子` }).map((post) => ({ ...post, title: `${prefix}：${post.title}` })) },
                };
            },
        }, settingsStore: null, llmClient: null, characterLibrary: null, groupForumStore, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'groups'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('心动社区')));
        const content = miniDom.document.querySelector('.yl-phone-content');
        Object.defineProperties(content, {
            clientHeight: { value: 100, configurable: true },
            scrollHeight: { value: 500, configurable: true },
            scrollTop: { value: 0, writable: true, configurable: true },
        });
        let surface = miniDom.document.querySelector('.yl-forum-home');
        surface.dispatchEvent(pointer('pointerdown', 0, 31));
        surface.dispatchEvent(pointer('pointermove', 104, 31));
        surface.dispatchEvent(pointer('pointerup', 104, 31));
        await flushUi();
        assert.equal(requests.length, 1);
        assert.equal(requests[0].refreshMode, 'replace');
        let snapshot = await groupForumStore.snapshot();
        assert.equal(snapshot.posts.length, 5);
        assert.equal(snapshot.posts.some((post) => post.id === oldPost.id), false, '顶部刷新成功后应删除旧帖和总结');
        assert.equal((await groupForumStore.getSummaryHistory()).posts.some((entry) => entry.id === oldPost.id), false);

        content.scrollTop = 400;
        surface = miniDom.document.querySelector('.yl-forum-home');
        content.dispatchEvent(wheel(100));
        const cancelled = timers.at(-1);
        content.dispatchEvent(wheel(-40));
        assert.equal(cancelled.cleared, true, '到底后的反向滚轮必须取消追加');
        cancelled.callback();
        await flushUi();
        assert.equal(requests.length, 1);

        content.scrollTop = 400;
        content.dispatchEvent(wheel(100));
        content.dispatchEvent(wheel(100));
        const release = timers.at(-1);
        release.callback();
        await flushUi();
        assert.equal(requests.length, 2);
        assert.equal(requests[1].refreshMode, 'append');
        snapshot = await groupForumStore.snapshot();
        assert.equal(snapshot.posts.length, 10, '底部加载应保留五篇旧帖并追加五篇新帖');
        assert.equal(snapshot.posts.some((post) => post.title === '替换：替换新帖子'), true);
        assert.equal(snapshot.posts.some((post) => post.title === '追加：追加新帖子'), true);
    } finally {
        mounted.destroy();
        globalThis.setTimeout = previousSetTimeout;
        globalThis.clearTimeout = previousClearTimeout;
    }
});

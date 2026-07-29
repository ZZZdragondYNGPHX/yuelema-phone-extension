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
                    总结: { 记录: [{ 内容: 'session-summary-must-not-render' }] },
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

function segItem(label) {
    return miniDom.document.querySelectorAll('button').find((node) => node.classList.contains('yl-seg__item') && node.textContent === label);
}

function groupRow(name) {
    return miniDom.document.querySelectorAll('.yl-row').find((node) => node.getAttribute('aria-label') === `打开${name}`);
}

// P2-C：社区无 Hub 直达——点底部「社区」→ 微任务跳到上次停留 tab，再用 SegmentedControl 显式选择目标 tab。
async function openCommunityTab(label) {
    click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'groups'));
    await flushUi();
    const item = segItem(label);
    if (item && item.getAttribute('aria-checked') !== 'true') {
        click(item);
        await flushUi();
    }
}

function forumRefreshPosts(author, { cityTitle = '雨后的书店', cityBody = '想找一间适合安静看书的小店。' } = {}) {
    return [
        { author, topic: '今日心情', title: '今天的小确幸', body: '下班路上买到喜欢的甜点，想把好心情分享出来。', tags: ['日常', '心情'] },
        { author, topic: '附近的人', title: '附近的晚风', body: '傍晚想在江边散步，欢迎同城朋友一起聊聊。', tags: ['附近', '散步'] },
        { author, topic: '同城瞬间', title: cityTitle, body: cityBody, tags: ['书店', '同城'] },
        { author, topic: '兴趣同频', title: '周末影展同好', body: '想找喜欢电影的人一起选一场周末影展。', tags: ['电影', '同好'] },
        { author, topic: '深夜树洞', title: '深夜的一句晚安', body: '睡前想把没说出口的心事放在这里。', tags: ['深夜', '心事'] },
        { author, topic: '恋爱吐槽', title: '暧昧期的拉扯', body: '聊得热络又突然冷场，大家怎么看这种节奏？', tags: ['吐槽', '恋爱'] },
        { author, topic: '约会报告', title: '咖啡店初见记录', body: '第一次见面选了安静的咖啡店，气氛比预想的自然。', tags: ['约会', '报告'] },
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
        await openCommunityTab('群聊');
        assert.equal(miniDom.document.querySelector('.yl-community-hub'), null, '社区不再有二选一 Hub 中转页');
        assert.ok(miniDom.document.querySelector('.yl-seg'), '社区页顶部应有「广场｜群聊」分段切换');
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '创建群聊'));

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
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '群设置'));
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
        await openCommunityTab('群聊');
        click(groupRow('定时测试群'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开定时测试群的更多操作'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '群设置'));
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

test('group room right-top more menu exposes exit, clear-history, and the combined group-settings dialog without touching MVU', async () => {
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
        await openCommunityTab('群聊');
        click(groupRow('菜单测试群'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开菜单测试群的更多操作'));
        assert.match(miniDom.document.body.textContent, /退出群聊/u);
        assert.match(miniDom.document.body.textContent, /清空群历史/u);
        assert.match(miniDom.document.body.textContent, /群设置/u, '房间菜单必须提供合并后的「群设置」入口（预设绑定 + 自动更新）');
        const roomMoreOpen = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开菜单测试群的更多操作');
        assert.equal(roomMoreOpen.getAttribute('aria-haspopup'), null, 'Phase 69：群房间更多操作是 disclosure，不再宣称 haspopup=menu');
        assert.equal(roomMoreOpen.getAttribute('aria-expanded'), 'true');
        const roomMenu = miniDom.document.querySelector('.yl-group-room-more-menu');
        assert.equal(roomMenu.getAttribute('role'), null, 'Phase 69：无键盘模型的动作列表不得宣称 role=menu');
        assert.equal(roomMenu.querySelectorAll('button').every((node) => node.getAttribute('role') === null), true, 'Phase 69：列表项是普通按钮而非 menuitem');
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

test('group settings dialog binds connection and prompt presets per room and passes the saved binding into the next generation', async () => {
    const groupForumStore = createGroupForumStore({ now: () => new Date('2026-07-22T04:00:00.000Z') });
    await groupForumStore.ready();
    const member = { nickname: '林澈', ageRange: '25-29', gender: '女', city: '上海', mbti: 'INFJ', zodiac: '双鱼座', occupation: '摄影师', interests: ['摄影'], presence: '在线', matchRate: null };
    const first = await groupForumStore.createGroup({ name: '预设甲群', members: [member] });
    await groupForumStore.createGroup({ name: '预设乙群', members: [{ ...member, nickname: '周遥' }] });
    const settingsStore = createSettingsStore({ storage: createMemoryStorage() });
    settingsStore.addConnectionPreset(connectionPreset('group_conn', '群聊连接'));
    const generationBindings = [];
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-group-local-binding',
        actionBridge: {
            emit() {}, isPending() { return false; },
            async generateGroupConversationUpdate(request) {
                generationBindings.push(request.binding);
                return { ok: true, update: { participants: [], messages: [{ speaker: '林澈', text: '收到，按新预设更新。' }] } };
            },
        },
        settingsStore, llmClient: null,
        characterLibrary: null, groupForumStore, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        await openCommunityTab('群聊');
        assert.equal(miniDom.document.querySelector('.yl-feature-options'), null, '聊天群首页不应再显示全局绑定设置');
        click(groupRow(first.name));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === `打开${first.name}的更多操作`));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '群设置'));
        const firstConnection = miniDom.document.querySelector('[name="group-chat-connection"]');
        assert.ok(firstConnection, '群设置对话框应在具体群的更多菜单内打开并提供连接预设选择');
        const firstPrompt = miniDom.document.querySelector('[name="group-chat-prompt"]');
        assert.ok(firstPrompt, '群设置对话框应同时提供提示词预设选择');
        assert.ok(miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '开启聊天群自动更新'), '预设绑定应与自动更新在同一群设置对话框内并列呈现');
        assert.match(miniDom.document.body.textContent, /绑定只影响本群公开聊天的内容风格/u, '对话框应说明绑定只影响内容风格，结构由代码固定');
        firstConnection.value = 'group_conn';
        firstPrompt.value = 'builtin_group_chat_sfw';
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '确定'));
        await flushUi();
        let snapshot = await groupForumStore.snapshot();
        assert.deepEqual(snapshot.threads.find((thread) => thread.key === first.id)?.bindings.SFW, { connectionPresetId: 'group_conn', promptPresetId: 'builtin_group_chat_sfw' });
        assert.deepEqual(snapshot.threads.find((thread) => thread.key === first.id)?.bindings.NSFW, { connectionPresetId: null, promptPresetId: null }, 'SFW 保存不得影响 NSFW 独立绑定');

        const input = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入群消息');
        input.value = '按新预设聊一句。'; input.dispatchEvent(new Event('input'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送群消息'));
        await flushUi();
        assert.equal(generationBindings.length, 1, '保存绑定后发言应触发一次生成');
        assert.deepEqual(generationBindings[0], { connectionPresetId: 'group_conn', promptPresetId: 'builtin_group_chat_sfw' }, '保存后的下一次生成必须携带本群绑定');

        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '返回'));
        click(groupRow('预设乙群'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开预设乙群的更多操作'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '群设置'));
        assert.equal(miniDom.document.querySelector('[name="group-chat-connection"]').value, '', '另一群不应继承第一群的绑定');
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
        const refresh = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '刷新候选人，显示下一位');
        assert.ok(refresh, 'empty candidate card must expose its refresh action');
        assert.equal(refresh.textContent, '下一位', 'empty candidate refresh keeps the concise visible label');
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
    let serviceGenerationInFlight = 0;
    let maxServiceGenerationInFlight = 0;
    const serviceGenerationResponses = [
        { ok: true, candidate: adultCharacter('林澄') },
        { ok: true, candidate: adultCharacter('林澄') }, // 重复昵称：不得占用第二席。
        { ok: true, candidate: adultCharacter('顾晴') },
        { ok: false, code: 'temporary_service_failure', retryable: false },
        { ok: true, candidate: adultCharacter('周岚') },
    ];
    let serviceHandoffCalls = 0;
    let serviceRepeatCalls = 0;
    const handoffDrafts = [];
    const serviceHistory = [];
    const events = [];
    const serviceState = emptyPoolReadResult().state;
    serviceState.系统 = { UID计数器: { 角色: 0, 服务订单: 0 } };
    serviceState.服务订单 = {};
    const bridge = {
        emit(kind, payload) { events.push({ kind, payload }); },
        isPending() { return false; },
        async runMvuAction(kind) { assert.equal(kind, 'toggle_content_mode'); toggleCalls += 1; return { ok: true }; },
        async generateServiceProfileDraft({ creativeBrief, expectedContentMode }) {
            assert.equal(expectedContentMode, 'SFW');
            assert.match(creativeBrief, /这是本批第 [123] 位/u);
            serviceGenerateCalls += 1;
            serviceGenerationInFlight += 1;
            maxServiceGenerationInFlight = Math.max(maxServiceGenerationInFlight, serviceGenerationInFlight);
            await Promise.resolve();
            const response = serviceGenerationResponses.shift() ?? { ok: false, code: 'unexpected_service_call', retryable: false };
            serviceGenerationInFlight -= 1;
            return response;
        },
        async runServiceOrderHandoff({ candidates, categoryId, expectedContentMode }) {
            assert.deepEqual(candidates.map((candidate) => candidate.公开资料.昵称), ['林澄', '顾晴']);
            assert.equal(categoryId, 'girl_shuren'); assert.equal(expectedContentMode, 'SFW');
            serviceHandoffCalls += 1;
            serviceState.角色池.npc_service_1 = structuredClone(candidates[0]);
            serviceState.角色池.npc_service_2 = structuredClone(candidates[1]);
            serviceState.服务订单.service_1 = { 角色UID: 'npc_service_1', 角色UID列表: ['npc_service_1', 'npc_service_2'], 内容模式: 'SFW', 服务分类: 'girl_shuren', 服务主题: '熟人商品：与林澄、顾晴的文字协商', 状态: '待确认', 发起时间: '待正文确认', 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '' };
            return { ok: true, orderUid: 'service_1', npcUids: ['npc_service_1', 'npc_service_2'] };
        },
        async runServiceOrderRebook({ npcUids, categoryId, expectedContentMode }) {
            assert.deepEqual(npcUids, ['npc_service_1', 'npc_service_2']); assert.equal(categoryId, 'girl_shuren'); assert.equal(expectedContentMode, 'SFW'); serviceRepeatCalls += 1;
            serviceState.服务订单.service_2 = { 角色UID: 'npc_service_1', 角色UID列表: ['npc_service_1', 'npc_service_2'], 内容模式: 'SFW', 服务分类: 'coffee_walk', 服务主题: '咖啡与散步：与林澄、顾晴的文字协商', 状态: '待确认', 发起时间: '待正文确认', 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '' };
            return { ok: true, orderUid: 'service_2' };
        },
        appendMeetupDraft(draft) { handoffDrafts.push(draft); return { ok: true }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-about', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, serviceOrderHistoryStore: { list: () => serviceHistory }, readState: () => ({ ok: true, state: serviceState }),
    });
    try {
        const launcher = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机');
        click(launcher);
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'profile'));
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.getAttribute('aria-label') === '关于软件'));

        assert.ok(miniDom.document.querySelector('.yl-page-back'), '关于软件应是可返回的子界面');
        const version = () => miniDom.document.querySelector('[name="about-version-info"]');
        for (let index = 0; index < 5; index += 1) {
            click(version());
            const dialog = miniDom.document.querySelector('.yl-operation-dialog');
            assert.equal(dialog.hidden, false);
            assert.match(dialog.textContent, /当前版本：1.0.10/u);
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
            assert.match(dialog.textContent, /v1.0.10/u);
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
        assert.match(miniDom.document.body.textContent, /今日心动档案/u);
        const serviceTabs = () => miniDom.document.querySelectorAll('.yl-service-tab');
        assert.deepEqual(serviceTabs().map((node) => node.textContent), ['精选', '订单', '记录']);
        assert.deepEqual(
            serviceTabs().map((tab) => tab.querySelector('svg')?.dataset.icon),
            ['sparkle', 'service_hub', 'clock'],
            '服务台 tab 应使用本地 SVG 白名单结构图标而非文字符号',
        );
        const firstServiceCategory = miniDom.document.querySelector('[name="service-category-girl_shuren"]');
        assert.ok(firstServiceCategory, '精选页应显示可选择的服务分类');
        click(firstServiceCategory);
        await flushUi();
        assert.equal(serviceGenerateCalls, 0, 'P2-D：点击分类只选中，不得自动触发三席生成');
        click(miniDom.document.querySelector('[name="service-slot-generate"]'));
        await flushUi();
        assert.equal(serviceGenerateCalls, 4, '重复昵称应重试当前席，第三席失败后必须停止而非重跑前两席');
        assert.equal(maxServiceGenerationInFlight, 1, '三席模型调用必须严格串行');
        assert.match(miniDom.document.body.textContent, /已通过校验的 2 位候补已保留/u);
        assert.equal(miniDom.document.querySelectorAll('.yl-local-service-profile').length, 0, '三席未齐前不得开放候选下单');
        assert.equal(miniDom.document.querySelectorAll('button').some((node) => String(node.getAttribute('name') ?? '').startsWith('service-profile-service_local_')), false);
        const retryRemainingSlot = miniDom.document.querySelector('[name="service-profile-generate"]');
        assert.match(retryRemainingSlot.textContent, /重试剩余第 3 位/u);
        click(retryRemainingSlot);
        await flushUi();
        assert.equal(serviceGenerateCalls, 5, '重试必须只补第三席，不得清空或重新生成前两席');
        assert.equal(serviceGenerationResponses.length, 0);
        const completedProfiles = miniDom.document.querySelectorAll('.yl-local-service-profile');
        assert.equal(completedProfiles.length, 3);
        assert.deepEqual(completedProfiles.map((node) => node.querySelector('strong')?.textContent), ['林澄', '顾晴', '周岚'], '重复昵称不得进入最终三席');
        assert.match(miniDom.document.body.textContent, /选择此角色/u);
        assert.match(miniDom.document.body.textContent, /以已选 0 位创建服务订单/u);
        click(serviceTabs()[0]);
        /* P2-D：发布面板收纳在精选底部折叠区，需先展开 */
        click(miniDom.document.querySelector('[name="service-publication-toggle"]'));
        assert.match(miniDom.document.body.textContent, /服务者发布服务/u);
        assert.ok(miniDom.document.querySelector('[name="service-published-open-girl_shuren"]'));
        assert.ok(miniDom.document.querySelector('[name="service-published-refresh-girl_shuren"]'));
        click(miniDom.document.querySelector('[name="service-published-open-girl_shuren"]'));
        await flushUi();
        assert.equal(serviceGenerateCalls, 5, '查看已发布分类不得重新生成或覆盖已完成的三席');

        serviceState.软件.内容模式 = 'NSFW';
        mounted.refreshState();
        click(serviceTabs()[0]);
        assert.match(miniDom.document.body.textContent, /夜色心动档案/u);
        assert.match(miniDom.document.body.textContent, /熟人商品/u);
        assert.equal(miniDom.document.querySelectorAll('.yl-phone-extension').find((node) => node.id === 'ylm-test-about').dataset.contentMode, 'NSFW');
        assert.doesNotMatch(miniDom.document.body.textContent, /林澄/u, 'SFW 候补不得泄漏到 NSFW 列表');
        serviceState.软件.内容模式 = 'SFW';
        mounted.refreshState();
        click(miniDom.document.querySelector('[name="service-published-open-girl_shuren"]'));
        assert.match(miniDom.document.body.textContent, /林澄/u, '切回 SFW 后已完成的候补批次必须保留');
        assert.equal(miniDom.document.querySelectorAll('.yl-phone-extension').find((node) => node.id === 'ylm-test-about').dataset.contentMode, 'SFW');

        const firstProfileSelect = miniDom.document.querySelector('[name="service-profile-select-service_local_1"]');
        assert.equal(handoffDrafts.length, 0, '选择前不得接管正文输入框');
        /* P2-D：选席改为真 checkbox 的 checked + change */
        firstProfileSelect.checked = true;
        firstProfileSelect.dispatchEvent(new Event('change'));
        await flushUi();
        const secondProfileSelect = miniDom.document.querySelector('[name="service-profile-select-service_local_2"]');
        secondProfileSelect.checked = true;
        secondProfileSelect.dispatchEvent(new Event('change'));
        await flushUi();
        assert.match(miniDom.document.body.textContent, /以已选 2 位创建服务订单/u);
        const createSelected = miniDom.document.querySelector('[name="service-order-create-selected"]');
        click(createSelected);
        await flushUi();
        assert.equal(serviceHandoffCalls, 1);
        assert.equal(handoffDrafts.length, 1);
        assert.match(handoffDrafts[0], /【本次新建的待确认订单】/u);
        assert.doesNotMatch(handoffDrafts[0], /service_1/u, '正文草稿不得暴露内部订单 UID');
        assert.match(handoffDrafts[0], /与「林澄、顾晴」体验「熟人商品」租借陪伴主题/u);
        assert.doesNotMatch(miniDom.document.body.textContent, /npc_service_|service_\d/u, '页面正文不得显示内部 UID');
        assert.doesNotMatch(handoffDrafts[0], /自动发送/u);
        click(serviceTabs()[1]);
        /* 订单 tab 先显示摘要列表；点开详情后才出现 Stepper（详情页含对象公开资料与确认成交/取消订单）。 */
        click(miniDom.document.querySelector('[name="service-order-open-detail"]'));
        /* P2-D：结构化服务信息位于订单 Stepper 第 2 步 */
        assert.equal(miniDom.document.querySelector('[name="service-information-价格"]'), null, '第 1 步不应预渲染服务信息表单');
        click(miniDom.document.querySelector('[name="service-step-next"]'));
        assert.ok(miniDom.document.querySelector('[name="service-information-价格"]'), 'pending-order editor must expose structured service information');
        assert.ok(miniDom.document.querySelector('[name="service-information-服务者信用"]'));
        assert.match(miniDom.document.body.textContent, /林澄/u);
        assert.match(miniDom.document.body.textContent, /待确认/u);

        serviceState.服务订单.service_1.状态 = '进行中';
        serviceState.服务订单.service_1.开始时间 = '已开始';
        serviceState.服务订单.service_1.已确认边界 = 'hidden-boundary-must-not-render';
        mounted.refreshState();
        assert.match(miniDom.document.body.textContent, /进行中/u);
        assert.match(miniDom.document.body.textContent, /等待正文写入完整结束条件/u);
        assert.equal(miniDom.document.querySelector('[name="service-order-complete"]'), null, 'without the body signal the UI must not stage a false completed history record');
        assert.doesNotMatch(miniDom.document.body.textContent, /hidden-boundary-must-not-render/u);

        serviceState.服务订单.service_1.状态 = '已完成';
        serviceState.服务订单.service_1.结束时间 = '已结束';
        serviceState.服务订单.service_1.结束摘要 = '双方已确认结束，未包含现实信息。';
        serviceHistory.push({ localId: 'history_service_1', orderUid: 'service_1', roleUid: 'npc_service_1', roleUids: ['npc_service_1', 'npc_service_2'], status: '已完成', archiveState: 'archived', mode: 'SFW', categoryId: 'girl_shuren', category: '熟人商品', topic: '熟人商品：与林澄、顾晴的文字协商', initiatedAt: '待正文确认', startedAt: '已开始', endedAt: '已结束', summary: '双方已确认结束，未包含现实信息。', profile: { 昵称: '林澄', 年龄段: '25-29', 简介: '喜欢看展和散步。', 兴趣标签: ['电影'] }, profiles: [{ 昵称: '林澄', 年龄段: '25-29', 简介: '喜欢看展和散步。', 兴趣标签: ['电影'] }, { 昵称: '顾晴', 年龄段: '25-29', 简介: '喜欢看展和散步。', 兴趣标签: ['电影'] }] });
        mounted.refreshState();
        assert.match(miniDom.document.body.textContent, /暂无进行中的服务/u);
        click(serviceTabs()[2]);
        assert.match(miniDom.document.body.textContent, /林澄/u);
        /* P2-D：历史动作先开行尾「⋯」菜单 */
        click(miniDom.document.querySelector('[name="service-history-menu-history_service_1"]'));
        const repeat = miniDom.document.querySelector('[name="service-history-rebook"]');
        assert.ok(repeat, '本地归档历史应提供再次下单入口');
        click(repeat);
        await flushUi();
        assert.equal(serviceRepeatCalls, 1);
        assert.equal(handoffDrafts.length, 2);
        assert.match(handoffDrafts[1], /【本次新建的待确认订单】/u);
        assert.doesNotMatch(handoffDrafts[1], /service_2/u, '复约草稿不得暴露内部订单 UID');
        click(serviceTabs()[1]);
        assert.match(miniDom.document.body.textContent, /待确认/u);

        assert.equal(events.some((entry) => entry.kind === 'navigate' && entry.payload.page === 'about'), true);
        assert.equal(events.some((entry) => entry.kind === 'navigate' && entry.payload.page === 'service_hub'), true);
    } finally {
        mounted.destroy();
    }
});

test('service completion stays mode-scoped and stages only after returning to the matching mode', async () => {
    const serviceState = {
        软件: { 内容模式: 'SFW' },
        角色池: { npc_service_1: adultCharacter('林澈') },
        服务订单: {
            service_1: {
                角色UID: 'npc_service_1', 角色UID列表: ['npc_service_1'], 内容模式: 'SFW', 服务分类: 'girl_shuren', 服务主题: '熟人商品：与林澈的文字协商',
                状态: '进行中', 发起时间: '待正文确认', 开始时间: '正文第 2 轮', 结束时间: '', 结束摘要: '', 已确认边界: '已确认边界',
                合法结束条件: { 已满足: true, 摘要: '正文已满足结束条件。', 记录时间: '正文最新回合' },
            },
        },
    };
    const calls = { stage: 0, complete: 0, finalize: 0, archived: 0 };
    const historyStore = {
        list() { return []; },
        stage(order, { status }) { calls.stage += 1; assert.equal(order.mode, 'SFW'); assert.equal(status, '已完成'); return { localId: 'history_service_1' }; },
        markArchived(localId) { calls.archived += 1; assert.equal(localId, 'history_service_1'); return true; },
    };
    const bridge = {
        emit() {}, isPending() { return false; },
        async runServiceOrderComplete({ orderUid, expectedContentMode }) {
            calls.complete += 1; assert.equal(orderUid, 'service_1'); assert.equal(expectedContentMode, 'SFW'); delete serviceState.服务订单.service_1; return { ok: true };
        },
        async runServiceOrderFinalize({ orderUid }) { calls.finalize += 1; assert.equal(orderUid, 'service_1'); return { ok: true }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-service-completion-mode-race', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, serviceOrderHistoryStore: historyStore, readState: () => ({ ok: true, state: serviceState }),
    });
    try {
        mounted.refreshState();
        serviceState.软件.内容模式 = 'NSFW';
        mounted.refreshState();
        await flushUi();
        assert.deepEqual(calls, { stage: 0, complete: 0, finalize: 0, archived: 0 }, 'a completion signal from the hidden mode must not create a false local terminal record');

        serviceState.软件.内容模式 = 'SFW';
        mounted.refreshState();
        await flushUi();
        assert.deepEqual(calls, { stage: 1, complete: 1, finalize: 1, archived: 1 });
        mounted.refreshState();
        await flushUi();
        assert.equal(calls.stage, 1, 'the same completed order must never be archived twice');
    } finally {
        mounted.destroy();
    }
});

test('a terminal order written directly by the body text is staged locally and finalized without a fake transition', async () => {
    const serviceState = {
        软件: { 内容模式: 'SFW' },
        角色池: { npc_service_1: adultCharacter('林澈') },
        服务订单: {
            service_1: {
                角色UID: 'npc_service_1', 角色UID列表: ['npc_service_1'], 内容模式: 'SFW', 服务分类: 'girl_shuren', 服务主题: '熟人商品：与林澈的文字协商',
                状态: '已完成', 发起时间: '待正文确认', 开始时间: '正文第 2 轮', 结束时间: '正文第 9 轮', 结束摘要: '正文直写的结束摘要，无现实信息。', 已确认边界: '已确认边界',
                合法结束条件: { 已满足: false, 摘要: '', 记录时间: '' },
            },
        },
    };
    const calls = { stage: 0, complete: 0, finalize: 0, archived: 0 };
    const historyStore = {
        list() { return []; },
        stage(order, { status }) { calls.stage += 1; assert.equal(order.id, 'service_1'); assert.equal(status, '已完成'); return { localId: 'history_service_1' }; },
        markArchived(localId) { calls.archived += 1; assert.equal(localId, 'history_service_1'); return true; },
    };
    const bridge = {
        emit() {}, isPending() { return false; },
        async runServiceOrderComplete() { calls.complete += 1; return { ok: true }; },
        async runServiceOrderFinalize({ orderUid }) { calls.finalize += 1; assert.equal(orderUid, 'service_1'); delete serviceState.服务订单.service_1; return { ok: true }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-service-terminal-recovery', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, serviceOrderHistoryStore: historyStore, readState: () => ({ ok: true, state: serviceState }),
    });
    try {
        mounted.refreshState();
        await flushUi();
        assert.deepEqual(calls, { stage: 1, complete: 0, finalize: 1, archived: 1 }, 'the fallback must archive and delete without invoking the completion transition');
        mounted.refreshState();
        await flushUi();
        assert.deepEqual(calls, { stage: 1, complete: 0, finalize: 1, archived: 1 }, 'a finalized order must not be recovered twice');
    } finally {
        mounted.destroy();
    }
});

test('late service-profile generation ignored after the phone closes cannot alter the local candidate batch', async () => {
    const state = {
        软件: { 内容模式: 'SFW' }, 推荐: { 当前队列: [], 临时候选池: {} }, 角色池: {}, 服务订单: {},
    };
    let resolveLate;
    const bridge = {
        emit() {}, isPending() { return false; },
        async generateServiceProfileDraft() {
            return await new Promise((resolve) => { resolveLate = resolve; });
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-service-late-generation', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => ({ ok: true, state }),
    });
    try {
        const launcher = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机');
        click(launcher);
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'profile'));
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.getAttribute('aria-label') === '关于软件'));
        for (let index = 0; index < 5; index += 1) click(miniDom.document.querySelector('[name="about-release-notes"]'));
        click(miniDom.document.querySelector('[name="about-service-entry"]'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'service_hub'));
        click(miniDom.document.querySelector('[name="service-category-girl_shuren"]'));
        click(miniDom.document.querySelector('[name="service-slot-generate"]'));
        await Promise.resolve();
        assert.equal(typeof resolveLate, 'function');

        click(miniDom.document.querySelector('.yl-phone-close'));
        resolveLate({ ok: true, candidate: adultCharacter('迟到候补') });
        await flushUi();
        assert.equal(miniDom.document.querySelector('.yl-operation-dialog').hidden, true, 'a late provider result must not reopen the closed operation dialog');

        click(launcher);
        assert.match(miniDom.document.body.textContent, /当前进度 0\/3/u);
        assert.doesNotMatch(miniDom.document.body.textContent, /迟到候补/u);
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
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('编辑公开资料')));
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
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.textContent.includes('隐私与总结')));
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.textContent.includes('对话总结')));
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
        await openCommunityTab('广场');
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
        await openCommunityTab('广场');
        const content = miniDom.document.querySelector('.yl-phone-content');
        content.scrollTop = 48;
        const mood = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('data-forum-channel') === 'daily_mood');
        assert.ok(mood);
        click(mood);
        assert.equal(content.scrollTop, 0, '进入子区后应回到该频道列表顶部');
        assert.match(miniDom.document.body.textContent, /今日心情 · 1 条本地帖子/u);
        assert.match(miniDom.document.body.textContent, /今天的小确幸/u);
        assert.doesNotMatch(miniDom.document.body.textContent, /雨后的书店/u);
        const activeMood = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('data-forum-channel') === 'daily_mood');
        assert.equal(activeMood.getAttribute('aria-pressed'), 'true');
        assert.match(activeMood.getAttribute('aria-label'), /返回社区全部动态/u);
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
                assert.equal(request.posts.length, 8);
                return { ok: true, update: { updates: request.posts.map((post, index) => ({ slot: index + 1, title: `自动更新：${post.title}`, body: `这是第${index + 1}篇已有帖子的新内容。`, tags: ['自动更新'] })) } };
            },
        }, settingsStore, llmClient: null, characterLibrary: null, groupForumStore, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        await openCommunityTab('广场');
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '社区设置'));
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
        assert.equal(snapshot.posts.length, 8);
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
        await openCommunityTab('广场');
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
        await openCommunityTab('广场');
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
        assert.equal(snapshot.posts.length, 8);
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
        assert.equal(snapshot.posts.length, 16, '底部加载应保留八篇旧帖并追加八篇新帖');
        assert.equal(snapshot.posts.some((post) => post.title === '替换：替换新帖子'), true);
        assert.equal(snapshot.posts.some((post) => post.title === '追加：追加新帖子'), true);
    } finally {
        mounted.destroy();
        globalThis.setTimeout = previousSetTimeout;
        globalThis.clearTimeout = previousClearTimeout;
    }
});

test('forum wheel can append when a one-post channel is too short to create a scroll range', async () => {
    const previousSetTimeout = globalThis.setTimeout;
    const previousClearTimeout = globalThis.clearTimeout;
    const timers = [];
    globalThis.setTimeout = (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
    };
    globalThis.clearTimeout = (timer) => { if (timer) timer.cleared = true; };
    const profile = { nickname: '短列表作者', ageRange: '25-29', gender: '女', city: '上海', mbti: 'INFJ', zodiac: '双鱼座', occupation: '编辑', interests: ['阅读'], presence: '在线', matchRate: null };
    const appendedProfile = { ...profile, nickname: '追加作者' };
    const groupForumStore = createGroupForumStore({ now: () => new Date('2026-07-22T04:00:00.000Z') });
    await groupForumStore.ready();
    await groupForumStore.addForumRefresh({ communityProfiles: [], update: { participants: [profile], posts: forumRefreshPosts('短列表作者') } });
    const requests = [];
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-forum-short-channel-append',
        actionBridge: {
            emit() {}, isPending() { return false; },
            async generateForumHomeRefresh(request) {
                requests.push(request);
                return {
                    ok: true, communityProfiles: [],
                    update: { participants: [appendedProfile], posts: forumRefreshPosts('追加作者').map((post) => ({ ...post, title: `追加：${post.title}` })) },
                };
            },
        }, settingsStore: null, llmClient: null, characterLibrary: null, groupForumStore, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        await openCommunityTab('广场');
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('data-forum-channel') === 'city_moments'));
        assert.match(miniDom.document.body.textContent, /同城瞬间 · 1 条本地帖子/u);
        const content = miniDom.document.querySelector('.yl-phone-content');
        Object.defineProperties(content, {
            clientHeight: { value: 500, configurable: true },
            scrollHeight: { value: 260, configurable: true },
            scrollTop: { value: 0, writable: true, configurable: true },
        });
        content.dispatchEvent(wheel(100));
        content.dispatchEvent(wheel(100));
        const release = timers.at(-1);
        assert.equal(release.delay, 180);
        release.callback();
        await flushUi();
        assert.equal(requests.length, 1);
        assert.equal(requests[0].refreshMode, 'append');
        assert.equal((await groupForumStore.snapshot()).posts.length, 16);

        const shortSurface = miniDom.document.querySelector('.yl-forum-home');
        shortSurface.dispatchEvent(pointer('pointerdown', 100, 61));
        shortSurface.dispatchEvent(pointer('pointermove', 0, 61));
        shortSurface.dispatchEvent(pointer('pointerup', 0, 61));
        await flushUi();
        assert.equal(requests.length, 2);
        assert.equal(requests[1].refreshMode, 'append', '短列表同时位于顶部和底部时，触摸上拉必须按移动方向选择追加');
    } finally {
        mounted.destroy();
        globalThis.setTimeout = previousSetTimeout;
        globalThis.clearTimeout = previousClearTimeout;
    }
});

test('forum bottom append keeps the scroll anchor, shows bottom progress, lands new posts at the feed end and reports success', async () => {
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
    const freshProfile = { ...oldProfile, nickname: '新作者', occupation: '策展人' };
    const groupForumStore = createGroupForumStore({ now: () => new Date('2026-07-22T04:00:00.000Z') });
    await groupForumStore.ready();
    await groupForumStore.addForumRefresh({ communityProfiles: [], update: { participants: [oldProfile], posts: forumRefreshPosts('旧作者') } });
    let releaseRefresh = null;
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-forum-append-scroll',
        actionBridge: {
            emit() {}, isPending() { return false; },
            generateForumHomeRefresh(request) {
                assert.equal(request.refreshMode, 'append');
                return new Promise((resolve) => {
                    releaseRefresh = () => resolve({
                        ok: true, communityProfiles: [],
                        update: { participants: [freshProfile], posts: forumRefreshPosts('新作者').map((post) => ({ ...post, title: `追加：${post.title}` })) },
                    });
                });
            },
        }, settingsStore: null, llmClient: null, characterLibrary: null, groupForumStore, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        await openCommunityTab('广场');
        const content = miniDom.document.querySelector('.yl-phone-content');
        Object.defineProperties(content, {
            clientHeight: { value: 100, configurable: true },
            scrollHeight: { value: 500, configurable: true },
            scrollTop: { value: 0, writable: true, configurable: true },
        });
        // 模拟真实浏览器：清空滚动容器时 scrollTop 会塌缩回 0（renderPage 的 content.replaceChildren）。
        const originalReplaceChildren = content.replaceChildren.bind(content);
        content.replaceChildren = (...nodes) => { content.scrollTop = 0; return originalReplaceChildren(...nodes); };
        content.scrollTop = 400;
        content.dispatchEvent(wheel(100));
        content.dispatchEvent(wheel(100));
        timers.at(-1).callback();
        await flushUi();
        assert.ok(releaseRefresh, '到底部的滚轮手势必须触发追加请求');
        assert.equal(content.scrollTop, 400, '进行中必须停留在底部追加区，而不是跳回顶部');
        const surface = miniDom.document.querySelector('.yl-forum-home');
        const appendIndicator = surface.querySelector('.yl-forum-append-indicator');
        assert.ok(appendIndicator.classList.contains('is-refreshing'), '追加进行中必须点亮底部指示');
        assert.match(appendIndicator.textContent, /正在追加广场帖子/u);
        assert.ok(surface.querySelector('.yl-skeleton'), '追加进行中必须在帖子流末尾渲染骨架屏');
        releaseRefresh();
        await flushUi();
        await flushUi();
        assert.equal(content.scrollTop, 400, '追加完成后必须保持原滚动位置');
        const snapshot = await groupForumStore.snapshot();
        assert.equal(snapshot.posts.length, 16, '追加必须保留八篇旧帖并新增八篇');
        assert.deepEqual(
            snapshot.posts.slice(8).map((post) => post.title),
            forumRefreshPosts('新作者').map((post) => `追加：${post.title}`),
            '新帖子必须按合同顺序追加在本地列表末尾',
        );
        const titles = miniDom.document.querySelectorAll('.yl-post-title').map((node) => node.textContent);
        assert.equal(titles.length, 16);
        assert.match(titles.at(-1), /^追加：/u, '帖子流底部渲染的最后一张卡必须来自追加批次');
        assert.doesNotMatch(titles[0], /^追加：/u, '旧帖子必须仍然排在帖子流顶部');
        const dialog = miniDom.document.querySelector('.yl-operation-dialog');
        assert.equal(dialog.hidden, false, '追加成功必须给出可见提示');
        assert.match(dialog.textContent, /已保留旧帖子，并在广场底部追加八个频道的新帖子/u);
    } finally {
        mounted.destroy();
        globalThis.setTimeout = previousSetTimeout;
        globalThis.clearTimeout = previousClearTimeout;
    }
});

test('late service-order handoff after close preserves the MVU result without filling the body draft', async () => {
    const state = { 软件: { 内容模式: 'SFW' }, 推荐: { 当前队列: [], 临时候选池: {} }, 角色池: {}, 服务订单: {}, 系统: { UID计数器: { 角色: 0, 服务订单: 0 } } };
    let resolveHandoff;
    let generated = 0;
    let appendedDrafts = 0;
    const bridge = {
        emit() {}, isPending() { return false; },
        async generateServiceProfileDraft() { generated += 1; return { ok: true, candidate: adultCharacter(`候补${generated}`) }; },
        async runServiceOrderHandoff({ candidates }) {
            return await new Promise((resolve) => {
                resolveHandoff = () => {
                    state.角色池.npc_service_late = structuredClone(candidates[0]);
                    state.服务订单.service_late = { 角色UID: 'npc_service_late', 角色UID列表: ['npc_service_late'], 内容模式: 'SFW', 服务分类: 'coffee_walk', 服务主题: '咖啡与散步：与候补1的文字协商', 状态: '待确认', 发起时间: '待正文确认', 开始时间: '', 结束时间: '', 结束摘要: '', 已确认边界: '' };
                    resolve({ ok: true, orderUid: 'service_late', npcUids: ['npc_service_late'] });
                };
            });
        },
        appendMeetupDraft() { appendedDrafts += 1; return { ok: true }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-service-late-handoff', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => ({ ok: true, state }),
    });
    try {
        const launcher = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机');
        click(launcher);
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'profile'));
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.getAttribute('aria-label') === '关于软件'));
        for (let index = 0; index < 5; index += 1) click(miniDom.document.querySelector('[name="about-release-notes"]'));
        click(miniDom.document.querySelector('[name="about-service-entry"]'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'service_hub'));
        click(miniDom.document.querySelector('[name="service-category-girl_shuren"]'));
        click(miniDom.document.querySelector('[name="service-slot-generate"]'));
        await flushUi();
        const lateSelect = miniDom.document.querySelector('[name="service-profile-select-service_local_1"]');
        lateSelect.checked = true;
        lateSelect.dispatchEvent(new Event('change'));
        click(miniDom.document.querySelector('[name="service-order-create-selected"]'));
        await Promise.resolve();
        assert.equal(typeof resolveHandoff, 'function');

        click(miniDom.document.querySelector('.yl-phone-close'));
        resolveHandoff();
        await flushUi();
        assert.equal(appendedDrafts, 0, 'closing the phone must prevent a late atomic handoff from taking over the body input');

        click(launcher);
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'service_hub'));
        click(miniDom.document.querySelectorAll('.yl-service-tab').find((node) => node.textContent === '订单'));
        assert.match(miniDom.document.body.textContent, /待确认/u, 'the already-committed MVU order remains recoverable after reopening');
    } finally {
        mounted.destroy();
    }
});

test('pending service-history archive retries finalize only and leaves rebooking untouched', async () => {
    const state = {
        软件: { 内容模式: 'SFW' }, 推荐: { 当前队列: [], 临时候选池: {} },
        角色池: { npc_service_archive: adultCharacter('归档候补') },
        服务订单: {
            service_archive: { 角色UID: 'npc_service_archive', 角色UID列表: ['npc_service_archive'], 内容模式: 'SFW', 服务分类: 'coffee_walk', 服务主题: '咖啡与散步：与归档候补的文字协商', 状态: '已完成', 发起时间: '待正文确认', 开始时间: '正文第 2 轮', 结束时间: '正文第 6 轮', 结束摘要: '正文已完成。', 已确认边界: '已确认边界' },
        },
    };
    const record = { localId: 'history_archive', orderUid: 'service_archive', roleUid: 'npc_service_archive', roleUids: ['npc_service_archive'], mode: 'SFW', categoryId: 'coffee_walk', category: '咖啡与散步', topic: '咖啡与散步：与归档候补的文字协商', status: '已完成', archiveState: 'pending_archive', summary: '正文已完成。', profile: { 昵称: '归档候补', 年龄段: '25-29', 简介: '公开资料', 兴趣标签: [] }, profiles: [] };
    const calls = { finalize: 0, archived: 0, rebook: 0 };
    const historyStore = {
        list() { return [record]; },
        markArchived(localId) { calls.archived += 1; assert.equal(localId, record.localId); record.archiveState = 'archived'; return true; },
    };
    const bridge = {
        emit() {}, isPending() { return false; },
        async runServiceOrderFinalize({ orderUid }) { calls.finalize += 1; assert.equal(orderUid, 'service_archive'); return calls.finalize === 1 ? { ok: false, code: 'temporary_failure' } : { ok: true }; },
        async runServiceOrderRebook() { calls.rebook += 1; return { ok: false }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-service-pending-archive', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, serviceOrderHistoryStore: historyStore, readState: () => ({ ok: true, state }),
    });
    try {
        const launcher = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机');
        click(launcher);
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'profile'));
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.getAttribute('aria-label') === '关于软件'));
        for (let index = 0; index < 5; index += 1) click(miniDom.document.querySelector('[name="about-release-notes"]'));
        click(miniDom.document.querySelector('[name="about-service-entry"]'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'service_hub'));
        click(miniDom.document.querySelectorAll('.yl-service-tab').find((node) => node.textContent === '记录'));
        /* P2-D：归档动作位于行尾「⋯」菜单内 */
        click(miniDom.document.querySelector('[name="service-history-menu-history_archive"]'));
        assert.ok(miniDom.document.querySelector('[name="service-history-finalize"]'));
        click(miniDom.document.querySelector('[name="service-history-finalize"]'));
        await flushUi();
        assert.deepEqual(calls, { finalize: 1, archived: 0, rebook: 0 }, 'a failed retry must not archive or create another order');
        click(miniDom.document.querySelector('[name="service-history-menu-history_archive"]'));
        click(miniDom.document.querySelector('[name="service-history-finalize"]'));
        await flushUi();
        assert.deepEqual(calls, { finalize: 2, archived: 1, rebook: 0 });
    } finally {
        mounted.destroy();
    }
});


test('XP search scopes generated service drafts to the active person category and never enters the controlled order payload', async () => {
    const state = {
        软件: { 内容模式: 'SFW' }, 推荐: { 当前队列: [], 临时候选池: {} }, 角色池: {}, 服务订单: {},
    };
    const creativeBriefs = [];
    let handoffPayload = null;
    const candidates = [adultCharacter('姜遥'), adultCharacter('许栀'), adultCharacter('唐宁')];
    const bridge = {
        emit() {}, isPending() { return false; },
        async generateServiceProfileDraft({ creativeBrief, expectedContentMode }) {
            creativeBriefs.push({ creativeBrief, expectedContentMode });
            return { ok: true, candidate: candidates.shift() };
        },
        async runServiceOrderHandoff(payload) {
            handoffPayload = structuredClone(payload);
            return { ok: true, orderUid: 'service_xp_1', npcUids: ['npc_xp_1'] };
        },
        appendMeetupDraft() { return { ok: true }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-service-xp-search', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => ({ ok: true, state }),
    });
    try {
        const launcher = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机');
        click(launcher);
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'profile'));
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.getAttribute('aria-label') === '关于软件'));
        for (let index = 0; index < 5; index += 1) click(miniDom.document.querySelector('[name="about-release-notes"]'));
        click(miniDom.document.querySelector('[name="about-service-entry"]'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'service_hub'));
        click(miniDom.document.querySelectorAll('.yl-service-tab').find((node) => node.textContent === '精选'));

        const search = miniDom.document.querySelector('[name="service-xp-search"]');
        assert.ok(search, '精选页必须提供本次 XP 搜索输入框');
        search.value = '眼镜 制服 成熟感';
        search.dispatchEvent(new Event('input'));
        click(miniDom.document.querySelector('[name="service-xp-search-submit"]'));
        await flushUi();

        assert.equal(creativeBriefs.length, 3, 'XP 搜索应依次生成独立的三席草稿');
        assert.deepEqual(creativeBriefs.map((item) => item.expectedContentMode), ['SFW', 'SFW', 'SFW']);
        assert.equal(creativeBriefs.every((item) => item.creativeBrief.includes('眼镜 制服 成熟感')), true);
        assert.match(miniDom.document.body.textContent, /当前 XP 搜索：眼镜 制服 成熟感/u);
        assert.equal(miniDom.document.querySelectorAll('.yl-local-service-profile').length, 3);

        const xpSelect = miniDom.document.querySelector('[name="service-profile-select-service_local_1"]');
        xpSelect.checked = true;
        xpSelect.dispatchEvent(new Event('change'));
        click(miniDom.document.querySelector('[name="service-order-create-selected"]'));
        await flushUi();
        assert.equal(handoffPayload.categoryId, 'girl_shuren');
        assert.equal(JSON.stringify(handoffPayload).includes('眼镜 制服 成熟感'), false, 'XP 搜索词不得传入受控 MVU 订单 payload');

        click(miniDom.document.querySelector('[name="service-xp-search-clear"]'));
        assert.doesNotMatch(miniDom.document.body.textContent, /当前 XP 搜索/u);
        assert.equal(miniDom.document.querySelectorAll('.yl-local-service-profile').length, 0, '清除后必须回到不含 XP 搜索的独立候补批次');

        state.软件.内容模式 = 'NSFW';
        mounted.refreshState();
        assert.equal(miniDom.document.querySelectorAll('.yl-phone-extension').find((node) => node.id === 'ylm-test-service-xp-search').dataset.contentMode, 'NSFW');
        assert.equal(miniDom.document.querySelector('[name="service-xp-search"]')?.value, '', '切换模式必须清空本次 XP 搜索状态');
    } finally {
        mounted.destroy();
    }
});

test('community group search keeps the input node stable and only swaps the result list', async () => {
    const bridge = { emit() {}, isPending() { return false; } };
    const groupForumStore = createGroupForumStore({ now: () => new Date('2026-07-26T04:00:00.000Z') });
    await groupForumStore.ready();
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-group-search-stability', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, groupForumStore, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        await openCommunityTab('群聊');
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '查找群组'));

        const input = miniDom.document.querySelector('.yl-group-search-input');
        assert.ok(input, '开启查找后应显示查找输入框');
        const results = miniDom.document.querySelector('.yl-group-room-results');
        assert.ok(results, '查找结果应有独立容器');
        input.focus();

        input.value = '夜谈';
        input.dispatchEvent(new Event('input'));
        assert.strictEqual(miniDom.document.querySelector('.yl-group-search-input'), input, '输入过滤不得重建查找输入框');
        assert.strictEqual(miniDom.document.activeElement, input, '过滤时必须保留输入框焦点');
        assert.match(results.textContent, /城市夜谈/u, '匹配的群应保留在结果区');

        input.value = '不存在的群名';
        input.dispatchEvent(new Event('input'));
        assert.strictEqual(miniDom.document.querySelector('.yl-group-search-input'), input, '空结果时输入框仍不得重建');
        assert.strictEqual(miniDom.document.activeElement, input, '空结果时焦点仍在输入框');
        assert.match(results.textContent, /没有找到匹配的聊天群/u, '空结果应给出可读说明');
        assert.doesNotMatch(results.textContent, /城市夜谈/u, '不匹配的群不得残留在结果区');
    } finally {
        mounted.destroy();
    }
});

test('Phase 69: service hub tabs expose a complete tab keyboard model with roving focus', async () => {
    const state = { 软件: { 内容模式: 'SFW' }, 推荐: { 当前队列: [], 临时候选池: {} }, 角色池: {}, 服务订单: {} };
    const bridge = { emit() {}, isPending() { return false; } };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-phase69-service-tabs', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: () => ({ ok: true, state }),
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'profile'));
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.getAttribute('aria-label') === '关于软件'));
        for (let index = 0; index < 5; index += 1) click(miniDom.document.querySelector('[name="about-release-notes"]'));
        click(miniDom.document.querySelector('[name="about-service-entry"]'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'service_hub'));

        const tablist = miniDom.document.querySelector('.yl-service-tabs');
        assert.equal(tablist.getAttribute('role'), 'tablist');
        const tabs = () => miniDom.document.querySelectorAll('.yl-service-tab');
        assert.deepEqual(tabs().map((tab) => tab.getAttribute('role')), ['tab', 'tab', 'tab']);
        assert.deepEqual(tabs().map((tab) => tab.getAttribute('tabindex')), ['0', '-1', '-1'], 'roving tabindex 只让激活 tab 参与 Tab 序');
        assert.equal(tabs().every((tab) => tab.getAttribute('aria-controls') === 'yl-service-hub-panel'), true);
        const body = miniDom.document.querySelector('.yl-service-body');
        assert.equal(body.getAttribute('role'), 'tabpanel');
        assert.equal(body.getAttribute('id'), 'yl-service-hub-panel');
        assert.equal(body.getAttribute('aria-labelledby'), 'yl-service-hub-tab-featured');

        tabs()[0].focus();
        const arrow = (key) => {
            const event = new Event('keydown', { cancelable: true });
            Object.defineProperty(event, 'key', { configurable: true, value: key });
            tablist.dispatchEvent(event);
            return event;
        };
        const right = arrow('ArrowRight');
        assert.equal(right.defaultPrevented, true, '方向键应阻止页面滚动默认行为');
        assert.equal(miniDom.document.activeElement.getAttribute('name'), 'service-hub-tab-orders', 'ArrowRight 把焦点移到下一个 tab');
        assert.equal(miniDom.document.activeElement.getAttribute('aria-selected'), 'false', '方向键只移动焦点，不激活面板');
        arrow('End');
        assert.equal(miniDom.document.activeElement.getAttribute('name'), 'service-hub-tab-records');
        arrow('ArrowRight');
        assert.equal(miniDom.document.activeElement.getAttribute('name'), 'service-hub-tab-featured', '方向键在首尾循环');
        arrow('ArrowLeft');
        assert.equal(miniDom.document.activeElement.getAttribute('name'), 'service-hub-tab-records');
        arrow('Home');
        assert.equal(miniDom.document.activeElement.getAttribute('name'), 'service-hub-tab-featured');

        click(tabs().find((tab) => tab.getAttribute('name') === 'service-hub-tab-orders'));
        assert.equal(miniDom.document.activeElement?.getAttribute?.('name'), 'service-hub-tab-orders', '激活后焦点落在新激活 tab 上');
        assert.equal(miniDom.document.querySelector('.yl-service-body').getAttribute('aria-labelledby'), 'yl-service-hub-tab-orders');
        assert.deepEqual(tabs().map((tab) => tab.getAttribute('aria-selected')), ['false', 'true', 'false']);
        assert.deepEqual(tabs().map((tab) => tab.getAttribute('tabindex')), ['-1', '0', '-1'], '激活后 roving tabindex 跟随新 tab');
    } finally {
        mounted.destroy();
    }
});

test('P2-C: community lands directly on content, remembers the last tab locally, and renders modern group rows', async () => {
    const storedValues = new Map();
    const storageStub = {
        getItem: (key) => (storedValues.has(key) ? storedValues.get(key) : null),
        setItem: (key, value) => { storedValues.set(key, String(value)); },
        removeItem: (key) => { storedValues.delete(key); },
    };
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storageStub });
    const groupForumStore = createGroupForumStore({ now: () => new Date('2026-07-26T04:00:00.000Z') });
    await groupForumStore.ready();
    const member = { nickname: '林澈', ageRange: '25-29', gender: '女', city: '上海', mbti: 'INFJ', zodiac: '双鱼座', occupation: '摄影师', interests: ['摄影'], presence: '在线', matchRate: null };
    await groupForumStore.createGroup({
        name: '结构测试群',
        members: [member, { ...member, nickname: '周遥' }, { ...member, nickname: '许青' }, { ...member, nickname: '顾宁' }],
    });
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-community-tabs', actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null, llmClient: null, characterLibrary: null, groupForumStore, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'groups'));
        await flushUi();
        // §8.1 直达内容：无 Hub 中转，默认落在广场
        assert.equal(miniDom.document.querySelector('.yl-community-hub'), null, '二选一 Hub 必须删除');
        assert.ok(miniDom.document.querySelector('.yl-forum-home'), '默认应直达广场内容页');
        assert.ok(miniDom.document.querySelector('.yl-community-topbar'), '社区自绘 topbar 应存在');
        assert.ok(miniDom.document.querySelector('.yl-seg'), '顶部应有「广场｜群聊」SegmentedControl');
        assert.equal(miniDom.document.querySelectorAll('.yl-channel-chip').length, 8, '广场应有 8 个频道横滑 chip');
        assert.ok(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '社区设置'), '广场页头应有「⋯」社区设置入口');
        // 切到群聊并写入本地 tab 记忆
        click(segItem('群聊'));
        await flushUi();
        assert.ok(miniDom.document.querySelector('.yl-group-list-page'));
        assert.equal(storedValues.get('yuelema.community-tab/v1'), 'chat', '切 tab 应写入本地记忆');
        // §8.3-2 顶部两个 tonal 按钮
        const create = miniDom.document.querySelectorAll('button').find((node) => node.textContent === '创建群聊');
        const search = miniDom.document.querySelectorAll('button').find((node) => node.textContent === '查找群组');
        assert.ok(create && create.classList.contains('yl-btn--tonal'), '创建群聊应为列表顶部 tonal 按钮');
        assert.ok(search && search.classList.contains('yl-btn--tonal'), '查找群组应为列表顶部 tonal 按钮');
        // §8.3-1 群列表 ListRow：叠放头像 ≤3 + “+N”
        const row = groupRow('结构测试群');
        assert.ok(row && row.classList.contains('yl-row'), '群列表项应使用 ListRow');
        const stack = row.querySelector('.yl-group-avatar-stack');
        assert.equal(stack.querySelectorAll('.yl-group-stack-avatar').length, 3, '叠放头像最多 3 个');
        assert.equal(stack.querySelector('.yl-group-stack-more').textContent, '+1', '第 4 位起折叠为 +N');
        // 离开再回：记住上次停留 tab（群聊）
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'groups'));
        await flushUi();
        assert.ok(miniDom.document.querySelector('.yl-group-list-page'), '重进社区应直达上次停留的群聊 tab');
        assert.equal(miniDom.document.querySelector('.yl-forum-home'), null, '记住 tab 后不应先落回广场');
        // 切回广场同样落盘
        click(segItem('广场'));
        await flushUi();
        assert.equal(storedValues.get('yuelema.community-tab/v1'), 'square');
        assert.ok(miniDom.document.querySelector('.yl-forum-home'));
    } finally {
        mounted.destroy();
        if (previousDescriptor) Object.defineProperty(globalThis, 'localStorage', previousDescriptor);
        else delete globalThis.localStorage;
    }
});

test('P2-C: group chat room reuses the contract bubble classes with stable per-speaker name tones', async () => {
    const groupForumStore = createGroupForumStore({ now: () => new Date('2026-07-26T04:00:00.000Z') });
    await groupForumStore.ready();
    const member = { nickname: '林澈', ageRange: '25-29', gender: '女', city: '上海', mbti: 'INFJ', zodiac: '双鱼座', occupation: '摄影师', interests: ['摄影'], presence: '在线', matchRate: null };
    await groupForumStore.createGroup({ name: '气泡测试群', members: [member, { ...member, nickname: '周遥' }] });
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-community-tones',
        actionBridge: {
            emit() {}, isPending() { return false; },
            async generateGroupConversationUpdate() {
                return { ok: true, update: { participants: [], messages: [
                    { speaker: '林澈', text: '我先说一句。' },
                    { speaker: '周遥', text: '我接一句。' },
                    { speaker: '林澈', text: '再补一句。' },
                ] } };
            },
        },
        settingsStore: null, llmClient: null, characterLibrary: null, groupForumStore, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        await openCommunityTab('群聊');
        click(groupRow('气泡测试群'));
        const input = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入群消息');
        input.value = '大家好。'; input.dispatchEvent(new Event('input'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送群消息'));
        await flushUi();
        // 跨代理合同 class 逐字复用
        assert.ok(miniDom.document.querySelector('.yl-chat-timeline'), '群聊室必须复用合同 timeline 容器');
        assert.ok(miniDom.document.querySelector('.yl-system-pill'), '时间线内应有本地保存说明 system pill');
        assert.ok(miniDom.document.querySelector('.yl-time-divider'), '首条消息前应有时间分隔 pill');
        const selfGroup = miniDom.document.querySelector('.yl-msg-group--self');
        assert.ok(selfGroup && selfGroup.querySelector('.yl-bubble'), '玩家消息应渲染为 self 气泡组');
        assert.ok(selfGroup.querySelector('.yl-bubble-time'), '气泡组末尾应有时间角标');
        const peerGroups = miniDom.document.querySelectorAll('.yl-msg-group--peer');
        assert.equal(peerGroups.length, 3, '发言人交替时应按连续段分组（林澈/周遥/林澈）');
        // 昵称 tone：格式合法 + 同名稳定
        const toneOf = new Map();
        for (const name of miniDom.document.querySelectorAll('.yl-bubble-name')) {
            const tone = name.className.split(/\s+/u).find((token) => token.startsWith('yl-name-tone-'));
            assert.match(tone ?? '', /^yl-name-tone-[0-5]$/u, '发言人昵称必须携带 6 色 tone 类');
            if (toneOf.has(name.textContent)) assert.equal(toneOf.get(name.textContent), tone, '同一发言人的 tone 必须稳定');
            else toneOf.set(name.textContent, tone);
        }
        assert.equal(toneOf.size, 2, '两位发言人都应有昵称 tone');
        // 重新渲染（返回列表再进入房间）后 tone 分配保持一致
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '返回'));
        click(groupRow('气泡测试群'));
        for (const [name, tone] of toneOf) {
            const again = miniDom.document.querySelectorAll('.yl-bubble-name').find((node) => node.textContent === name);
            assert.ok(again, '重进房间后发言人昵称仍应渲染');
            assert.equal(again.className.split(/\s+/u).includes(tone), true, '重渲染后 tone 类保持稳定');
        }
    } finally {
        mounted.destroy();
    }
});

// —— 阶段 77：群组/论坛域失败把服务层带出的诊断写入安全控制台 detail（message 保持粗略文案）——

test('forum home refresh failure surfaces the service diagnostic in the operation console detail', async () => {
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-forum-console-detail',
        actionBridge: {
            emit() {},
            isPending() { return false; },
            async generateForumHomeRefresh() {
                return {
                    ok: false,
                    code: 'forum_update_channel_invalid',
                    message: '论坛更新的频道名缺失、重复或不在固定频道列表中，已丢弃。',
                    diagnostic: { stage: '响应校验', field: 'posts[2].topic', actual: '月亮频道', hint: '频道名必须精确等于固定频道名之一' },
                };
            },
        },
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        await openCommunityTab('广场');
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '刷新帖子'));
        await flushUi();

        const entry = mounted.operationActivity.snapshot().entries.find((item) => item.name === '广场刷新');
        assert.ok(entry, '广场刷新必须在控制台留下条目');
        assert.equal(entry.status, 'failure');
        assert.equal(entry.message, '广场未刷新。', '界面摘要保持粗略友好文案');
        assert.ok(entry.detail, '失败条目必须携带诊断 detail');
        assert.match(entry.detail, /操作: 广场刷新/u);
        assert.match(entry.detail, /阶段: 响应校验/u);
        assert.match(entry.detail, /错误码: forum_update_channel_invalid/u);
        assert.match(entry.detail, /字段: posts\[2\]\.topic/u);
        assert.match(entry.detail, /实际: 月亮频道/u);
        assert.doesNotMatch(entry.detail, /Bearer|sk-|阈值/u);
    } finally {
        mounted.destroy();
    }
});

test('group room update failure formats HTTP status from the service diagnostic into the console detail', async () => {
    const profile = {
        nickname: '许青', ageRange: '25-29', gender: '女', city: '杭州', mbti: 'ENFP', zodiac: '双鱼座', occupation: '插画师', interests: ['书店'], presence: '在线', matchRate: null,
    };
    const groupForumStore = createGroupForumStore({ now: () => new Date('2026-07-22T04:00:00.000Z') });
    await groupForumStore.ready();
    await groupForumStore.createGroup({ name: '控制台诊断群', members: [profile] });
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-group-console-detail',
        actionBridge: {
            emit() {},
            isPending() { return false; },
            async generateGroupConversationUpdate() {
                return {
                    ok: false,
                    code: 'SERVER_ERROR',
                    message: '模型服务暂时不可用，请稍后重试。',
                    retryable: true,
                    diagnostic: { stage: '模型请求', error: { name: 'YueLeMaLlmError', message: '模型服务暂时不可用，请稍后重试。', code: 'SERVER_ERROR', status: 502 } },
                };
            },
        },
        settingsStore: null, llmClient: null, characterLibrary: null, groupForumStore, readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        await openCommunityTab('群聊');
        click(groupRow('控制台诊断群'));
        const input = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('aria-label') === '输入群消息');
        assert.ok(input, '群聊房间应有输入栏');
        input.value = '这句群消息原文不进控制台。';
        input.dispatchEvent(new Event('input'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发送群消息'));
        await flushUi();

        const entry = mounted.operationActivity.snapshot().entries.find((item) => item.name === '聊天群更新');
        assert.ok(entry, '聊天群更新必须在控制台留下条目');
        assert.equal(entry.status, 'failure');
        assert.equal(entry.message, '聊天群更新未完成。');
        assert.match(entry.detail, /错误类型: YueLeMaLlmError/u);
        assert.match(entry.detail, /HTTP 状态: 502/u);
        assert.match(entry.detail, /错误码: SERVER_ERROR/u);
        assert.doesNotMatch(entry.detail, /这句群消息原文不进控制台/u);
    } finally {
        mounted.destroy();
    }
});

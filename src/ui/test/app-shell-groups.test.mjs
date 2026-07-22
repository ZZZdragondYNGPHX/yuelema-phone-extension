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

        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '设置聊天群自动更新'));
        const enabled = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '开启聊天群自动更新');
        const seconds = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '自动更新时间秒数');
        enabled.checked = true; seconds.value = '5';
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
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '设置聊天群自动更新'));
        const enabled = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '开启聊天群自动更新');
        const seconds = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '自动更新时间秒数');
        enabled.checked = true; seconds.value = '5';
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


test('about entry shows a version dialog and reveals the SFW/NSFW slider after five local clicks', async () => {
    let toggleCalls = 0;
    const events = [];
    const bridge = {
        emit(kind, payload) { events.push({ kind, payload }); },
        isPending() { return false; },
        async runMvuAction(kind) { assert.equal(kind, 'toggle_content_mode'); toggleCalls += 1; return { ok: true }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-about', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: emptyPoolReadResult,
    });
    try {
        const launcher = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机');
        click(launcher);
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'profile'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('设置')));

        const about = () => miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '关于软件');
        for (let index = 0; index < 5; index += 1) {
            click(about());
            const dialog = miniDom.document.querySelector('.yl-operation-dialog');
            assert.equal(dialog.hidden, false);
            assert.match(dialog.textContent, /约了吗 0\.1\.27/u);
        }
        await flushUi();

        assert.equal(toggleCalls, 0);
        const toggle = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '内容模式切换');
        assert.ok(toggle);
        assert.equal(toggle.getAttribute('type'), 'checkbox');
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await flushUi();
        assert.equal(toggleCalls, 1);
        assert.equal(events.some((entry) => entry.kind === 'navigate' && entry.payload.page === 'about'), false);
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

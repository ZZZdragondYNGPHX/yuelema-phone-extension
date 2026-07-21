import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';

const miniDom = installMiniDom();
const { mountPhoneApp } = await import('../../app-shell.js');

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

test('groups page renders public projections only and existing-chat entry only navigates', () => {
    const events = [];
    const writes = { parse: 0, replace: 0, event: 0 };
    const bridge = {
        emit(kind, payload) { events.push({ kind, payload }); },
        isPending() { return false; },
        runMvuAction() { writes.parse += 1; },
        runPrivateChat() { writes.replace += 1; },
        runMeetupHandoff() { writes.event += 1; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-groups',
        actionBridge: bridge,
        settingsStore: null,
        llmClient: null,
        characterLibrary: null,
        readState: readResult,
    });

    const launcher = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机');
    assert.ok(launcher, 'launcher must exist');
    click(launcher);
    const groupNav = miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'groups');
    assert.ok(groupNav, 'groups navigation button must exist');
    click(groupNav);

    const hubDom = miniDom.document.body.textContent;
    assert.match(hubDom, /聊天群/u);
    assert.match(hubDom, /论坛/u);
    const chatGroupApp = miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('聊天群'));
    assert.ok(chatGroupApp, 'groups navigation must open the mini-app hub');
    click(chatGroupApp);

    const groupDom = miniDom.document.body.textContent;
    assert.match(groupDom, /城市夜谈/u);
    assert.match(groupDom, /公开发现对象/u);
    assert.match(groupDom, /进入已有私聊/u);
    for (const forbidden of [
        'friend-secret-must-not-render', 'friend-boundary-must-not-render', 'hidden-secret-must-not-render',
        'internal-boundary-must-not-render', 'session-secret-must-not-render', 'session-summary-must-not-render',
        '全局账号表现', 'NPC专属匹配度', '拒绝阈值', 'chat_group', 'npc_group',
    ]) assert.equal(groupDom.includes(forbidden), false, `groups DOM must not render ${forbidden}`);

    const existingChat = miniDom.document.querySelectorAll('button').find((node) => node.textContent === '进入已有私聊');
    assert.ok(existingChat, 'existing-chat entry must exist for the matched session');
    click(existingChat);

    assert.deepEqual(events.map((entry) => entry.kind), ['navigate', 'navigate', 'navigate']);
    assert.deepEqual(events.map((entry) => entry.payload.page), ['groups', 'group_chat', 'private_chat']);
    assert.deepEqual(writes, { parse: 0, replace: 0, event: 0 });
    mounted.destroy();
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
        assert.match(dialog.textContent, /约了吗 0\.1\.20/u);
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

test('group and forum generators retain drafts in UI memory and never expose a publish or MVU-write path', async () => {
    const calls = [];
    const writes = { mvu: 0, private: 0, meetup: 0 };
    const bridge = {
        emit() {}, isPending() { return false; },
        runMvuAction() { writes.mvu += 1; }, runPrivateChat() { writes.private += 1; }, runMeetupHandoff() { writes.meetup += 1; },
        async generateGroupChatDraft(request) { calls.push({ kind: 'group', request }); return { ok: true, draft: { reply: '这是一条公开群聊草稿。' } }; },
        async generateForumPostDraft(request) { calls.push({ kind: 'forum', request }); return { ok: true, draft: { title: '公开论坛草稿', body: '这是待审核的公开帖子草稿。' } }; },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document, rootId: 'ylm-test-group-drafts', actionBridge: bridge,
        settingsStore: null, llmClient: null, characterLibrary: null, readState: readResult,
    });
    try {
        const launcher = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机');
        click(launcher);
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'groups'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('聊天群')));
        const groupInput = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('placeholder') === '输入一条公开群聊消息…');
        assert.ok(groupInput, 'group draft input must exist');
        groupInput.value = '今晚聊电影吗？'; groupInput.dispatchEvent(new Event('input'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '生成群聊草稿'));
        await flushUi();
        assert.deepEqual(calls[0], { kind: 'group', request: { groupUid: 'group_city', playerMessage: '今晚聊电影吗？' } });
        assert.match(miniDom.document.body.textContent, /这是一条公开群聊草稿/u);
        assert.match(miniDom.document.body.textContent, /未发布，不会写入软件状态/u);

        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'groups'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('论坛')));
        const forumInput = miniDom.document.querySelectorAll('textarea').find((node) => node.getAttribute('placeholder') === '输入一个公开发帖主题…');
        assert.ok(forumInput, 'forum draft input must exist');
        forumInput.value = '周末观影交流'; forumInput.dispatchEvent(new Event('input'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '生成帖子草稿'));
        await flushUi();
        assert.deepEqual(calls[1], { kind: 'forum', request: { groupUid: 'group_city', topic: '周末观影交流' } });
        const dom = miniDom.document.body.textContent;
        assert.match(dom, /公开论坛草稿/u);
        assert.match(dom, /待审核草稿，未发布且不会写入软件状态/u);
        assert.equal(/发布帖子|发布群聊|确认发布/u.test(dom), false, 'UI must not pretend a draft is persisted');
        assert.deepEqual(writes, { mvu: 0, private: 0, meetup: 0 });
    } finally {
        mounted.destroy();
    }
});

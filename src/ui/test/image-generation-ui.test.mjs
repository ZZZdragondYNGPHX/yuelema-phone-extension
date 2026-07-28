import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createMemoryStorage, createSettingsStore } from '../../settings/settings-store.js';
import { createConversationImageStore, createMemoryConversationImageStorage } from '../../images/conversation-image-store.js';

const miniDom = installMiniDom();
const { mountPhoneApp } = await import('../../app-shell.js');

test.after(() => miniDom.restore());

function click(node) {
    assert.ok(node, '要点击的控件必须存在');
    node.dispatchEvent(new Event('click'));
}

function rightClick(node) {
    assert.ok(node, '要右键的图片必须存在');
    const event = new Event('contextmenu', { cancelable: true });
    node.dispatchEvent(event);
    return event;
}

async function flushUi() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
}

function byAria(root, label) {
    const found = root.querySelectorAll('button').concat(root.querySelectorAll('input'), root.querySelectorAll('textarea'))
        .find((node) => node.getAttribute('aria-label') === label);
    assert.ok(found, `应存在 aria-label=${label} 的控件`);
    return found;
}

function stateResult() {
    return {
        ok: true,
        state: {
            软件: { 内容模式: 'SFW' },
            推荐: { 当前队列: [], 临时候选池: {} },
            角色池: {
                npc_drawing: {
                    成人验证: true,
                    公开资料: {
                        昵称: '绘梨', 头像引用: '', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '8 km',
                        寻找意图: '先聊天再约会', 简介: '喜欢分享日常。', 兴趣标签: ['摄影'], 生活方式标签: ['夜猫子'], 性格标签: ['主动'], 沟通风格标签: ['分享欲强'],
                    },
                    仅好友资料: {},
                    隐藏资料: { 实际年龄: 26 },
                    绘图: { core_dna: 'adult woman, short dark hair', outfit_dna: 'cream cardigan' },
                    与玩家关系: { 状态: '已匹配', 好感: 30, 信任: 20, 戒备: 0, 面基意愿: 0 },
                },
            },
            会话: {
                chat_drawing: {
                    对象UID: 'npc_drawing', 状态: '已匹配',
                    最近消息: [
                        { 消息UID: 'm_image_manual', 发送者: '角色', 内容: '刚拍到一张很喜欢的照片。', 时间: '20:30' },
                        { 消息UID: 'm_image_auto', 发送者: '角色', 内容: '这一刻也想分享给你。', 时间: '20:31' },
                        { 消息UID: 'm_image_auto_second', 发送者: '角色', 内容: '还想补一张同一晚的照片。', 时间: '20:32' },
                    ],
                },
            },
        },
    };
}

const manualDirective = Object.freeze({ kind: 'share_photo', scene: 'rainy Shanghai street at night, warm storefront light, candid photo' });
const autoDirective = Object.freeze({ kind: 'selfie', scene: 'adult woman smiling indoors, casual phone selfie, warm lamp light' });
const autoSecondDirective = Object.freeze({ kind: 'share_photo', scene: 'adult woman near a rainy window, warm room, candid photo' });

test('private chat image directives use the bridge, keep regenerate available, and auto-failure does not loop', async () => {
    const settingsStore = createSettingsStore({ storage: createMemoryStorage() });
    settingsStore.setImageGenerationSettings({ ...settingsStore.getImageGenerationSettings(), enabled: true });
    const imageRequests = [];
    let chatCalls = 0;
    const bridge = {
        emit() {},
        isPending() { return false; },
        runPrivateChat() {
            chatCalls += 1;
            return Promise.resolve({
                ok: true,
                imageDirectives: chatCalls === 1
                    ? [{ messageUid: 'm_image_manual', directive: manualDirective }]
                    : [
                        { messageUid: 'm_image_auto', directive: autoDirective },
                        { messageUid: 'm_image_auto_second', directive: autoSecondDirective },
                    ],
            });
        },
        generateConversationImage(request) {
            imageRequests.push(request);
            if (imageRequests.length === 1) return Promise.resolve({ ok: true, image: { src: 'data:image/png;base64,iVBORw0KGgo=' } });
            if (imageRequests.length === 2) return Promise.resolve({ ok: false, code: 'INVALID_IMAGE_REQUEST', message: '请使用 ComfyUI “Save (API Format)” 导出的工作流。' });
            return Promise.resolve({ ok: false, code: 'image_generation_failed' });
        },
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-image-generation-ui',
        actionBridge: bridge,
        settingsStore,
        llmClient: null,
        characterLibrary: null,
        readState: stateResult,
    });
    try {
        click(byAria(miniDom.document, '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(byAria(miniDom.document, '打开与绘梨的私聊'));

        const automatic = byAria(miniDom.document, '私聊自动生图');
        assert.equal(automatic.checked, false, '私聊自动生图默认关闭');
        const settingsButton = byAria(miniDom.document, '打开生图设置');
        click(settingsButton);
        assert.match(miniDom.document.body.textContent, /生图设置/u, '会话入口应能进入生图设置子页面');
        click(byAria(miniDom.document, '返回'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(byAria(miniDom.document, '打开与绘梨的私聊'));
        assert.ok(miniDom.document.querySelector('.yl-private-chat-screen'));

        let input = byAria(miniDom.document, '输入私聊消息');
        input.value = '想看看。';
        input.dispatchEvent(new Event('input'));
        click(byAria(miniDom.document, '发送消息'));
        await flushUi();

        const manualCard = miniDom.document.querySelectorAll('.yl-image-directive-card').find((node) => node.dataset.status === 'idle');
        assert.ok(manualCard, 'AI 回传的结构化语句应折叠显示在对应对话泡下');
        const manualGenerate = byAria(manualCard, '生成图片');
        click(manualGenerate);
        await flushUi();

        assert.equal(imageRequests.length, 1);
        assert.deepEqual(
            { kind: imageRequests[0].kind, conversationId: imageRequests[0].conversationId, messageId: imageRequests[0].messageId, characterUid: imageRequests[0].characterUid, directive: imageRequests[0].directive },
            { kind: 'private', conversationId: 'chat_drawing', messageId: 'm_image_manual', characterUid: 'npc_drawing', directive: manualDirective },
            'UI 只能把请求交给受控 bridge，不得自行调用生图接口',
        );
        const generated = miniDom.document.querySelector('.yl-image-directive-image');
        assert.ok(generated, '生图成功后应以图片替换折叠结构内容');
        assert.ok(byAria(miniDom.document, '重新生成图片'), '成功后仍须保留重新生成按钮');
        const menuEvent = rightClick(generated);
        assert.equal(menuEvent.defaultPrevented, true);
        const actionDialog = miniDom.document.querySelector('.yl-image-action-dialog');
        assert.equal(actionDialog.hidden, false);
        assert.ok(byAria(actionDialog, '查看本次结构化语句'));
        assert.ok(byAria(actionDialog, '查看原图'));
        click(byAria(actionDialog, '查看本次结构化语句'));
        const directiveDialog = miniDom.document.querySelector('.yl-image-directive-dialog');
        assert.equal(directiveDialog.hidden, false);
        assert.match(byAria(directiveDialog, '当前图片结构化语句').value, /rainy Shanghai street/u);
        click(byAria(miniDom.document, '关闭生图结构化语句'));
        rightClick(generated);
        click(byAria(miniDom.document.querySelector('.yl-image-action-dialog'), '查看原图'));
        const originalDialog = miniDom.document.querySelector('.yl-image-original-dialog');
        assert.equal(originalDialog.hidden, false);
        assert.equal(originalDialog.querySelector('.yl-image-original').getAttribute('src'), generated.getAttribute('src'));
        click(byAria(originalDialog, '关闭原图'));
        click(byAria(miniDom.document, '重新生成图片'));
        await flushUi();
        assert.match(miniDom.document.body.textContent, /Save \(API Format\)/u, '手动生图失败弹窗应显示客户端提供的安全具体原因');
        click(byAria(miniDom.document, '关闭操作提示'));

        automatic.checked = true;
        automatic.dispatchEvent(new Event('change'));
        assert.deepEqual(settingsStore.snapshot().imageGeneration.conversationSettings.private.chat_drawing, { autoGenerate: true });

        input = byAria(miniDom.document, '输入私聊消息');
        input.value = '再来一张。';
        input.dispatchEvent(new Event('input'));
        click(byAria(miniDom.document, '发送消息'));
        await flushUi();

        assert.equal(imageRequests.length, 4, '开启自动生图后，同一会话的两条新结构都应各自交给 bridge');
        assert.deepEqual(imageRequests.slice(2).map((request) => request.messageId).sort(), ['m_image_auto', 'm_image_auto_second']);
        const failed = miniDom.document.querySelectorAll('.yl-image-directive-card').find((node) => node.dataset.status === 'failed');
        assert.ok(failed, '自动生成失败应保留可重试的失败状态');
        mounted.refreshState();
        await flushUi();
        assert.equal(imageRequests.length, 4, '失败状态重渲染后不得自动无限重试');
    } finally {
        mounted.destroy();
    }
});

test('private chat restores persisted generated image and directive after a new app mount without regenerating', async () => {
    const storage = createMemoryConversationImageStorage();
    const conversationImageStore = createConversationImageStore({ storage });
    await conversationImageStore.ready();
    await conversationImageStore.put({
        kind: 'private',
        conversationId: 'chat_drawing',
        messageId: 'm_image_manual',
        directive: manualDirective,
        imageSource: 'data:image/png;base64,iVBORw0KGgo=',
    });
    let generationCalls = 0;
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-image-generation-persistence',
        actionBridge: {
            emit() {},
            isPending() { return false; },
            generateConversationImage() { generationCalls += 1; return Promise.resolve({ ok: false }); },
        },
        settingsStore: createSettingsStore({ storage: createMemoryStorage() }),
        llmClient: null,
        characterLibrary: null,
        conversationImageStore,
        readState: stateResult,
    });
    try {
        click(byAria(miniDom.document, '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'messages'));
        click(byAria(miniDom.document, '打开与绘梨的私聊'));
        const image = miniDom.document.querySelector('.yl-image-directive-image');
        assert.ok(image, '新挂载实例应直接显示持久化图片');
        assert.equal(image.getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=');
        rightClick(image);
        click(byAria(miniDom.document.querySelector('.yl-image-action-dialog'), '查看本次结构化语句'));
        assert.match(byAria(miniDom.document, '当前图片结构化语句').value, /rainy Shanghai street/u);
        click(byAria(miniDom.document, '关闭生图结构化语句'));
        assert.equal(generationCalls, 0, '恢复已有图片不得再次请求接口');

        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'profile'));
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.dataset.page === 'settings_image_generation'));
        click(byAria(miniDom.document, '查看图片缓存'));
        assert.match(miniDom.document.body.textContent, /已保存 1 \/ 48 张/u);
        const cacheCard = miniDom.document.querySelector('.yl-image-cache-card');
        assert.ok(cacheCard);
        assert.equal(cacheCard.textContent.includes('m_image_manual'), false, '缓存 UI 不得显示内部消息 UID');
        click(byAria(cacheCard, '查看缓存原图'));
        assert.equal(miniDom.document.querySelector('.yl-image-original-dialog').hidden, false);
        click(byAria(miniDom.document, '关闭原图'));
        click(byAria(cacheCard, '删除缓存图片'));
        assert.equal(miniDom.document.querySelector('.yl-image-cache-delete-dialog').hidden, false);
        click(byAria(miniDom.document, '确认删除图片'));
        await flushUi();
        assert.equal(conversationImageStore.peek('private', 'chat_drawing', 'm_image_manual'), null);
        assert.match(miniDom.document.body.textContent, /图片缓存为空/u);
        click(byAria(miniDom.document, '返回'));
        assert.match(miniDom.document.body.textContent, /生图设置/u, '缓存子窗口返回时应回到生图设置');
    } finally {
        mounted.destroy();
    }
});


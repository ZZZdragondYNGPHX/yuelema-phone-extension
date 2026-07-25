import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createMemoryStorage, createSettingsStore } from '../../settings/settings-store.js';

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
        const directiveDialog = miniDom.document.querySelector('.yl-image-directive-dialog');
        assert.equal(directiveDialog.hidden, false);
        assert.match(byAria(directiveDialog, '当前图片结构化语句').value, /rainy Shanghai street/u);

        automatic.checked = true;
        automatic.dispatchEvent(new Event('change'));
        assert.deepEqual(settingsStore.snapshot().imageGeneration.conversationSettings.private.chat_drawing, { autoGenerate: true });

        input = byAria(miniDom.document, '输入私聊消息');
        input.value = '再来一张。';
        input.dispatchEvent(new Event('input'));
        click(byAria(miniDom.document, '发送消息'));
        await flushUi();

        assert.equal(imageRequests.length, 3, '开启自动生图后，同一会话的两条新结构都应各自交给 bridge');
        assert.deepEqual(imageRequests.slice(1).map((request) => request.messageId).sort(), ['m_image_auto', 'm_image_auto_second']);
        const failed = miniDom.document.querySelectorAll('.yl-image-directive-card').find((node) => node.dataset.status === 'failed');
        assert.ok(failed, '自动生成失败应保留可重试的失败状态');
        mounted.refreshState();
        await flushUi();
        assert.equal(imageRequests.length, 3, '失败状态重渲染后不得自动无限重试');
    } finally {
        mounted.destroy();
    }
});


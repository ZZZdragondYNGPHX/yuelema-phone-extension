import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createImageLibraryStore, createMemoryImageLibraryStorage } from '../../images/image-library-store.js';

const miniDom = installMiniDom();
const { mountPhoneApp } = await import('../../app-shell.js');

test.after(() => miniDom.restore());

const IMAGE_URL = 'https://cdn.example.test/matched.webp';

function candidateRecord() {
    return {
        成人验证: true,
        公开资料: {
            昵称: '林晚', 头像引用: '', 年龄段: '25-29', 性别: '女', 性取向: '双性恋',
            城市: '上海', 距离范围: '10 km', 寻找意图: '认真约会', 简介: '喜欢夜景与展览。',
            兴趣标签: ['展览'], 生活方式标签: ['夜景'], 性格标签: ['温柔'], 沟通风格标签: ['直接'],
        },
        仅好友资料: {}, 隐藏资料: {}, 偏好与边界: '',
        拒绝阈值: 40, 已读不回阈值: 55, 取消匹配阈值: 70, 拉黑阈值: 90,
        与玩家关系: { 状态: '陌生', 全局账号表现: 80, NPC专属匹配度: 85, 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 },
    };
}

function readResult() {
    const candidate = candidateRecord();
    return {
        ok: true,
        state: {
            系统: { UID计数器: { 角色: 1 } }, 软件: { 内容模式: 'SFW' },
            玩家: { 公开资料: candidateRecord().公开资料 },
            推荐: { 当前队列: ['npc_1'], 临时候选池: { npc_1: candidate }, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
            角色池: { npc_1: candidate }, 会话: {}, 群组: {},
        },
    };
}

function click(node) {
    assert.ok(node);
    node.dispatchEvent(new Event('click'));
}

async function flushUi() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
}

test('设置页提供图片管理入口并挂载浏览器本地图片面板', async () => {
    const imageLibrary = createImageLibraryStore({ storage: createMemoryImageLibraryStorage() });
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-image-manager-route',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null,
        llmClient: null,
        characterLibrary: null,
        imageLibrary,
        readState: readResult,
    });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'profile'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('设置')));
        const entry = miniDom.document.querySelectorAll('button').find((node) => node.textContent.includes('图片管理'));
        assert.ok(entry);
        click(entry);
        await flushUi();
        assert.ok(miniDom.document.querySelector('.yl-image-manager'));
        assert.ok(miniDom.document.querySelector('[name="image-file"]'));
        assert.ok(miniDom.document.querySelector('[name="image-url"]'));
        assert.match(miniDom.document.body.textContent, /图片库还是空的/u);
        assert.ok(miniDom.document.querySelector('.yl-page-back'));
    } finally {
        mounted.destroy();
    }
});

test('首页候选卡背景和公开资料头像使用匹配图片，其他列表范围保持未接入', async () => {
    const imageRecord = Object.freeze({
        id: 'image_matched',
        source: Object.freeze({ kind: 'url', url: IMAGE_URL }),
        keywordWeights: Object.freeze([{ keyword: '夜景', weight: 5 }]),
    });
    const calls = [];
    const coordinator = {
        async resolveImage(profile, options) {
            calls.push({ profile, options });
            return imageRecord;
        },
        clearCache() {},
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-image-presentation',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null,
        llmClient: null,
        characterLibrary: null,
        imageMatchCoordinator: coordinator,
        readState: readResult,
    });
    try {
        await flushUi();
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        await flushUi();
        const card = miniDom.document.querySelector('.yl-candidate-card');
        const background = card.querySelector('.yl-candidate-background-image');
        const avatarImage = card.querySelector('.yl-candidate-avatar-image');
        assert.equal(background?.getAttribute('src'), IMAGE_URL);
        assert.equal(avatarImage?.getAttribute('src'), IMAGE_URL);
        assert.equal(calls.length >= 1, true);
        assert.equal(Object.hasOwn(calls[0].profile, 'uid'), false);
        assert.equal(Object.hasOwn(calls[0].profile, '隐藏资料'), false);
        assert.equal(calls[0].options.contentMode, 'SFW');

        click(card.querySelectorAll('span').find((node) => node.getAttribute('role') === 'button'));
        await flushUi();
        assert.equal(miniDom.document.querySelector('.yl-public-profile')?.querySelector('.yl-candidate-avatar-image')?.getAttribute('src'), IMAGE_URL);
    } finally {
        mounted.destroy();
    }
});

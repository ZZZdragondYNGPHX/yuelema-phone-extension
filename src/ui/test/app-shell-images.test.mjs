import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createImageLibraryStore, createMemoryImageLibraryStorage } from '../../images/image-library-store.js';
import { createMemoryStorage, createSettingsStore } from '../../settings/settings-store.js';

const miniDom = installMiniDom();
const { mountPhoneApp } = await import('../../app-shell.js');

test.after(() => miniDom.restore());

const IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

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

function installStyleRecorder(node) {
    const values = Object.create(null);
    node.style = new Proxy({
        setProperty(name, value) { values[name] = String(value); },
        getPropertyValue(name) { return values[name] ?? ''; },
    }, {
        get(target, key) { return key in target ? target[key] : values[key] ?? ''; },
        set(_target, key, value) { values[key] = String(value); return true; },
    });
    return values;
}

function assertDialogInsideViewport(dialog, viewport, label) {
    const rect = dialog.getBoundingClientRect();
    const centerX = (rect.left + rect.right) / 2;
    const centerY = (rect.top + rect.bottom) / 2;
    assert.ok(Math.abs(centerX - (viewport.offsetLeft + viewport.width / 2)) <= 1, `${label} 横向居中`);
    assert.ok(Math.abs(centerY - (viewport.offsetTop + viewport.height / 2)) <= 1, `${label} 纵向居中`);
    assert.ok(rect.left >= viewport.offsetLeft + 13.5 && rect.top >= viewport.offsetTop + 13.5, `${label} 左上不越界`);
    assert.ok(rect.right <= viewport.offsetLeft + viewport.width - 13.5, `${label} 右边不越界`);
    assert.ok(rect.bottom <= viewport.offsetTop + viewport.height - 13.5, `${label} 底边不越界`);
}

function assertViewportCover(node, viewport, label) {
    const rect = node.getBoundingClientRect();
    assert.ok(Math.abs(rect.left - viewport.offsetLeft) <= 1, `${label} 左边覆盖`);
    assert.ok(Math.abs(rect.top - viewport.offsetTop) <= 1, `${label} 顶边覆盖`);
    assert.ok(Math.abs(rect.right - (viewport.offsetLeft + viewport.width)) <= 1, `${label} 右边覆盖`);
    assert.ok(Math.abs(rect.bottom - (viewport.offsetTop + viewport.height)) <= 1, `${label} 底边覆盖`);
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
        const entry = miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.textContent.includes('图片素材'));
        assert.ok(entry);
        click(entry);
        await flushUi();
        assert.ok(miniDom.document.querySelector('.yl-image-manager'));
        assert.ok(miniDom.document.querySelector('[name="image-file"]'));
        assert.equal(miniDom.document.querySelector('[name="image-url"]'), null, '图片管理不得保留远程 URL 输入');
        assert.equal(miniDom.document.querySelector('.yl-image-remote-import-backdrop')?.hidden, true, '图片链接输入只允许出现在隐藏弹窗');
        assert.equal(miniDom.document.querySelectorAll('button').some((node) => node.textContent === '下载并保存到图片库'), false);
        assert.match(miniDom.document.body.textContent, /图片库还是空的/u);
        assert.ok(miniDom.document.querySelector('.yl-page-back'));

        click(miniDom.document.querySelectorAll('button').find((node) => node.textContent === '生图'));
        await flushUi();
        assert.equal(miniDom.document.querySelector('.yl-page-heading')?.querySelector('h1')?.textContent, '生成图片', '应进入独立生图子路由');
        const generationPanel = miniDom.document.querySelector('.yl-image-manager');
        assert.equal(generationPanel.classList.contains('is-generation-view'), true);
        assert.equal(generationPanel.querySelector('.yl-image-manager-side').hidden, true, '子路由不得显示图片库侧栏');
        assert.equal(generationPanel.querySelector('.yl-image-manager-grid').hidden, true, '子路由不得显示图片网格');
        assert.equal(generationPanel.querySelector('.yl-image-generation-workbench').hidden, false);

        click(miniDom.document.querySelector('.yl-page-back'));
        await flushUi();
        assert.equal(miniDom.document.querySelector('.yl-page-heading')?.querySelector('h1')?.textContent, '图片管理');
        assert.equal(miniDom.document.querySelector('.yl-image-manager-side').hidden, false, '返回后恢复图片库');
    } finally {
        mounted.destroy();
    }
});

test('图片关键词编辑弹窗也经共享仿射定位管线收敛到移动视口', async () => {
    const previousDefaultView = miniDom.document.defaultView;
    const windowRef = new EventTarget();
    const visualViewport = new EventTarget();
    Object.assign(windowRef, { innerWidth: 360, innerHeight: 640, visualViewport });
    Object.assign(visualViewport, { offsetLeft: 0, offsetTop: 0, width: 360, height: 640 });
    miniDom.document.defaultView = windowRef;
    const imageLibrary = createImageLibraryStore({ storage: createMemoryImageLibraryStorage() });
    await imageLibrary.add({
        id: 'affine_editor_image',
        source: { kind: 'embedded', dataUrl: IMAGE_DATA_URL },
        keywordWeights: [{ keyword: '夜景', weight: 4 }],
    });
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-image-editor-affine',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null,
        llmClient: null,
        characterLibrary: null,
        imageLibrary,
        readState: readResult,
    });
    try {
        click(miniDom.document.querySelector('.yl-phone-launcher'));
        click(miniDom.document.querySelectorAll('.yl-phone-nav-item').find((node) => node.dataset.page === 'profile'));
        click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.textContent.includes('图片素材')));
        await flushUi();

        const editor = miniDom.document.querySelector('.yl-image-keyword-editor');
        const styles = installStyleRecorder(editor);
        const model = { scaleX: 0.78, scaleY: 1.2, offsetX: 112, offsetY: -128 };
        const backdrop = miniDom.document.querySelector('.yl-image-keyword-backdrop');
        const backdropStyles = installStyleRecorder(backdrop);
        backdrop.getBoundingClientRect = () => {
            const cssLeft = Number.parseFloat(backdropStyles.left) || 0;
            const cssTop = Number.parseFloat(backdropStyles.top) || 0;
            const cssWidth = Number.parseFloat(backdropStyles.width) || 1;
            const cssHeight = Number.parseFloat(backdropStyles.height) || 1;
            const left = model.offsetX + (cssLeft * model.scaleX);
            const top = model.offsetY + (cssTop * model.scaleY);
            const width = cssWidth * model.scaleX;
            const height = cssHeight * model.scaleY;
            return { left, top, width, height, right: left + width, bottom: top + height };
        };
        editor.getBoundingClientRect = () => {
            const cssLeft = Number.parseFloat(styles.left) || 0;
            const cssTop = Number.parseFloat(styles.top) || 0;
            const maxWidth = Number.parseFloat(styles['max-width']);
            const maxHeight = Number.parseFloat(styles['max-height']);
            const cssWidth = Math.min(390, Number.isFinite(maxWidth) ? maxWidth : 390);
            const cssHeight = Math.min(650, Number.isFinite(maxHeight) ? maxHeight : 650);
            const width = cssWidth * model.scaleX;
            const height = cssHeight * model.scaleY;
            const centerX = model.offsetX + (cssLeft * model.scaleX);
            const centerY = model.offsetY + (cssTop * model.scaleY);
            return {
                left: centerX - width / 2, top: centerY - height / 2,
                width, height, right: centerX + width / 2, bottom: centerY + height / 2,
            };
        };

        const card = miniDom.document.querySelector('.yl-image-card');
        card.dispatchEvent(new Event('contextmenu', { cancelable: true }));
        click(miniDom.document.querySelector('.yl-image-context-action'));
        assert.equal(editor.hidden, false);
        assertViewportCover(backdrop, visualViewport, '图片编辑 backdrop');
        assertDialogInsideViewport(editor, visualViewport, '图片关键词 editor');

        Object.assign(model, { scaleX: 1.18, scaleY: 0.7, offsetX: -86, offsetY: 132 });
        Object.assign(visualViewport, { offsetLeft: 16, offsetTop: 28, width: 620, height: 350 });
        visualViewport.dispatchEvent(new Event('resize'));
        assertViewportCover(backdrop, visualViewport, '旋转后图片编辑 backdrop');
        assertDialogInsideViewport(editor, visualViewport, '旋转后图片关键词 editor');
    } finally {
        mounted.destroy();
        miniDom.document.defaultView = previousDefaultView;
    }
});

test('首页候选卡背景和公开资料头像使用匹配图片，其他列表范围保持未接入', async () => {
    const imageRecord = Object.freeze({
        id: 'image_matched',
        source: Object.freeze({ kind: 'embedded', dataUrl: IMAGE_DATA_URL }),
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
        assert.equal(background?.getAttribute('src'), IMAGE_DATA_URL);
        assert.equal(avatarImage?.getAttribute('src'), IMAGE_DATA_URL);
        assert.equal(calls.length >= 1, true);
        assert.equal(Object.hasOwn(calls[0].profile, 'uid'), false);
        assert.equal(Object.hasOwn(calls[0].profile, '隐藏资料'), false);
        assert.equal(calls[0].options.contentMode, 'SFW');

        click(card.querySelectorAll('span').find((node) => node.getAttribute('role') === 'button'));
        await flushUi();
        assert.equal(miniDom.document.querySelector('.yl-public-profile')?.querySelector('.yl-candidate-avatar-image')?.getAttribute('src'), IMAGE_DATA_URL);
    } finally {
        mounted.destroy();
    }
});


test('SFW/NSFW 模式切换后不复用旧模式的匹配图片', async () => {
    const NSFW_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const imagesByMode = {
        SFW: Object.freeze({ id: 'image_sfw', source: Object.freeze({ kind: 'embedded', dataUrl: IMAGE_DATA_URL }), keywordWeights: Object.freeze([{ keyword: '夜景', weight: 5 }]) }),
        NSFW: Object.freeze({ id: 'image_nsfw', source: Object.freeze({ kind: 'embedded', dataUrl: NSFW_IMAGE_DATA_URL }), keywordWeights: Object.freeze([{ keyword: '夜景', weight: 5 }]) }),
    };
    const calls = [];
    const coordinator = {
        async resolveImage(profile, options) {
            const mode = options?.contentMode === 'NSFW' ? 'NSFW' : 'SFW';
            calls.push(mode);
            return imagesByMode[mode];
        },
        clearCache() {},
    };
    let mode = 'SFW';
    const readModalState = () => {
        const result = readResult();
        result.state.软件.内容模式 = mode;
        return result;
    };
    const mounted = mountPhoneApp({
        documentRef: miniDom.document,
        rootId: 'ylm-test-image-mode-switch',
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: null,
        llmClient: null,
        characterLibrary: null,
        imageMatchCoordinator: coordinator,
        readState: readModalState,
    });
    try {
        await flushUi();
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        await flushUi();
        assert.equal(miniDom.document.querySelector('.yl-candidate-background-image')?.getAttribute('src'), IMAGE_DATA_URL);
        assert.equal(calls.includes('SFW'), true);

        mode = 'NSFW';
        mounted.refreshState();
        await flushUi();
        assert.equal(calls.includes('NSFW'), true, '模式切换后必须以新模式重新请求选图');
        assert.equal(
            miniDom.document.querySelector('.yl-candidate-background-image')?.getAttribute('src'),
            NSFW_IMAGE_DATA_URL,
            'NSFW 模式不得复用 SFW 模式的匹配图片',
        );

        const callsBeforeSwitchBack = calls.length;
        mode = 'SFW';
        mounted.refreshState();
        await flushUi();
        assert.equal(miniDom.document.querySelector('.yl-candidate-background-image')?.getAttribute('src'), IMAGE_DATA_URL, '切回 SFW 恢复本模式的匹配图片');
        assert.equal(calls.length, callsBeforeSwitchBack, '切回旧模式可复用该模式自己的缓存，不再重复请求');
    } finally {
        mounted.destroy();
    }
});

test('图片管理设置按钮打开 image_match 预设绑定', async () => {
    const imageLibrary = createImageLibraryStore({ storage: createMemoryImageLibraryStorage() });
    const settingsStore = createSettingsStore({ storage: createMemoryStorage() });
    const mounted = mountPhoneApp({ documentRef: miniDom.document, rootId: 'ylm-test-image-binding', actionBridge: { emit() {}, isPending() { return false; } }, settingsStore, llmClient: null, characterLibrary: null, imageLibrary, readState: readResult });
    try {
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
        click(miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === 'profile')); click(miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.textContent.includes('图片素材'))); await flushUi();
        click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '配置图片管理预设'));
        assert.match(miniDom.document.body.textContent, /图片匹配设置/u);
        assert.ok(miniDom.document.querySelector('[name="image_match-quick-connection"]'));
        assert.ok(miniDom.document.querySelector('[name="image_match-quick-prompt"]'));
    } finally { mounted.destroy(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createDialogController } from '../../ui/dialog-controller.js';
import {
    createImageLibraryStore,
    createMemoryImageLibraryStorage,
    ImageLibraryError,
} from '../image-library-store.js';

const miniDom = installMiniDom();
const WEBP_DATA_URL = 'data:image/webp;base64,UklGRggAAABXRUJQAAAAAA==';
const { createImageManagerPanel } = await import('../image-manager-panel.js');

test.after(() => miniDom.restore());

function createStore() {
    return createImageLibraryStore({
        storage: createMemoryImageLibraryStorage(),
        now: () => new Date('2026-07-20T12:00:00.000Z'),
    });
}

function buttonByText(node, text) {
    const button = node.querySelectorAll('button').find((candidate) => candidate.textContent === text);
    assert.ok(button, `应存在按钮：${text}`);
    return button;
}

async function flushUi(rounds = 4) {
    for (let index = 0; index < rounds; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

async function buildHarness({ seed = [], imageLibrary, compressImageFile, onChange, onFeedback, onConfigure, dialogController } = {}) {
    const store = imageLibrary ?? createStore();
    for (const input of seed) await store.add(input);
    const changes = [];
    const feedback = [];
    const api = createImageManagerPanel({
        documentRef: miniDom.document,
        imageLibrary: store,
        compressImageFile,
        onChange: onChange ?? ((event) => changes.push(event)),
        onFeedback: onFeedback ?? ((message) => feedback.push(message)),
        onConfigure,
        dialogController,
    });
    await flushUi();
    return { store, changes, feedback, ...api };
}

function keyEvent(key) {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperty(event, 'key', { value: key, configurable: true });
    return event;
}

function createFakeDialogController() {
    const openCalls = [];
    const closeCalls = [];
    return {
        openCalls,
        closeCalls,
        open(dialog, options = {}) {
            openCalls.push({ dialog, options });
            dialog.hidden = false;
        },
        close(dialog, options = {}) {
            closeCalls.push({ dialog, options });
            dialog.hidden = true;
        },
        handleKeydown() { return false; },
        hasOpenDialog() { return openCalls.length > closeCalls.length; },
        isTopDialog(dialog) { return openCalls.length > closeCalls.length && openCalls.at(-1).dialog === dialog; },
        dispose() {},
    };
}

function seedRecord(id, keywordWeights = []) {
    return { id, source: { kind: 'embedded', dataUrl: WEBP_DATA_URL }, keywordWeights };
}

function openKeywordEditor(element) {
    const card = element.querySelector('.yl-image-card');
    assert.ok(card, '应存在图片卡片');
    card.dispatchEvent(new Event('contextmenu', { cancelable: true }));
    const menu = element.querySelector('.yl-image-context-menu');
    assert.equal(menu.hidden, false);
    buttonByText(menu, '编辑匹配关键词').dispatchEvent(new Event('click', { cancelable: true }));
    const backdrop = element.querySelector('.yl-image-keyword-backdrop');
    assert.equal(backdrop.hidden, false);
    return backdrop;
}

test('返回可嵌入 DOM 节点、closeEditor/dispose，并显示空图片库状态', async () => {
    const harness = await buildHarness();
    assert.equal(harness.element, harness.node);
    assert.equal(harness.element, harness.panel);
    assert.equal(typeof harness.closeEditor, 'function');
    assert.equal(typeof harness.dispose, 'function');
    assert.equal(harness.element.querySelector('.yl-image-manager-empty').textContent.includes('图片库还是空的'), true);
    assert.equal(harness.element.querySelector('.yl-image-manager-status').textContent, '当前没有图片。');
    harness.closeEditor();
    harness.dispose();
    harness.dispose();
});

test('右上角设置按钮明确可访问，点击只调用注入的 onConfigure', async () => {
    const calls = [];
    const store = createStore();
    const operationCounts = { list: 0, add: 0, update: 0, remove: 0 };
    const imageLibrary = Object.fromEntries(Object.keys(operationCounts).map((method) => [method, async (...args) => {
        operationCounts[method] += 1;
        return store[method](...args);
    }]));
    const harness = await buildHarness({ imageLibrary, onConfigure: () => calls.push('configure') });
    try {
        const button = buttonByText(harness.element, '设置');
        assert.equal(button.getAttribute('type'), 'button');
        assert.equal(button.getAttribute('aria-label'), '配置图片管理预设');
        assert.equal(button.classList.contains('yl-image-manager-configure'), true);
        assert.equal(button.parentNode.classList.contains('yl-image-manager-titlebar'), true);

        for (const method of Object.keys(operationCounts)) operationCounts[method] = 0;
        button.dispatchEvent(new Event('click', { cancelable: true }));

        assert.deepEqual(calls, ['configure']);
        assert.deepEqual(operationCounts, { list: 0, add: 0, update: 0, remove: 0 });
        assert.equal(harness.feedback.length, 0);
        assert.equal(harness.changes.length, 0);
    } finally {
        harness.dispose();
    }
});

test('does not expose remote URL intake or assign injected remote sources to image elements', async () => {
    const remoteRecord = Object.freeze({
        id: 'unsafe_remote',
        source: Object.freeze({ kind: 'url', url: 'https://images.example/city-night.webp' }),
        keywordWeights: Object.freeze([]),
    });
    const imageLibrary = {
        async list() { return [remoteRecord]; },
        async add() { throw new Error('not used'); },
        async update() { throw new Error('not used'); },
        async remove() { throw new Error('not used'); },
    };
    const harness = await buildHarness({ imageLibrary });
    try {
        assert.equal(harness.element.querySelector('[name="image-url"]'), null);
        assert.equal(harness.element.querySelectorAll('button').some((button) => button.textContent === '导入图片链接'), false);
        assert.equal(harness.element.querySelector('.yl-image-manager-description').textContent.includes('图片链接'), false);
        const image = harness.element.querySelector('.yl-image-preview');
        assert.equal(image.getAttribute('src'), null);
        assert.equal(harness.element.querySelector('.yl-image-preview-state').textContent, '图片来源无效');
    } finally {
        harness.dispose();
    }
});

test('本地 PNG/JPEG/WebP 通过注入压缩器导入，且回调结果只保存嵌入来源', async () => {
    const compressedFiles = [];
    const harness = await buildHarness({
        compressImageFile: async (file) => {
            compressedFiles.push(file);
            return {
                kind: 'embedded',
                dataUrl: 'data:image/webp;base64,UklGRggAAABXRUJQAAAAAA==',
                width: 512,
                height: 512,
                mimeType: 'image/webp',
            };
        },
    });
    try {
        const file = { type: 'image/png', size: 2048, name: 'portrait.png' };
        const input = harness.element.querySelector('[name="image-file"]');
        input.files = [file];
        input.dispatchEvent(new Event('change'));
        await flushUi(6);

        assert.deepEqual(compressedFiles, [file]);
        const records = await harness.store.list();
        assert.deepEqual(records[0].source, { kind: 'embedded', dataUrl: 'data:image/webp;base64,UklGRggAAABXRUJQAAAAAA==' });
        assert.equal(harness.element.querySelector('.yl-image-preview').getAttribute('src'), 'data:image/webp;base64,UklGRggAAABXRUJQAAAAAA==');
    } finally {
        harness.dispose();
    }
});

test('本地压缩结果含二进制标记样字节时仍能从 file input 写入并重载预览', async () => {
    const binaryWithMarkupLikeBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x00, 0x3c, 0x61, 0x3e, 0xff, 0x00]);
    const dataUrl = `data:image/webp;base64,${binaryWithMarkupLikeBytes.toString('base64')}`;
    const harness = await buildHarness({ compressImageFile: async () => dataUrl });
    try {
        const input = harness.element.querySelector('[name="image-file"]');
        input.files = [{ type: 'image/jpeg', size: 4096, name: 'real-binary.jpg' }];
        input.dispatchEvent(new Event('change'));
        await flushUi(6);

        const records = await harness.store.list();
        assert.equal(records.length, 1);
        assert.deepEqual(records[0].source, { kind: 'embedded', dataUrl });
        assert.equal(harness.element.querySelector('.yl-image-preview').getAttribute('src'), dataUrl);
        assert.equal(harness.feedback.at(-1), '本地图片已压缩并保存到图片库。');
    } finally {
        harness.dispose();
    }
});
test('asynchronous local-image storage errors are projected without leaking internal text', async () => {
    const backing = createStore();
    const failingLibrary = {
        list: () => backing.list(),
        update: (...args) => backing.update(...args),
        remove: (...args) => backing.remove(...args),
        async add() {
            const error = new ImageLibraryError('STORAGE_WRITE_FAILED');
            error.unsafeDetail = 'Authorization Bearer private-secret';
            throw error;
        },
    };
    const harness = await buildHarness({ imageLibrary: failingLibrary, compressImageFile: async () => WEBP_DATA_URL });
    try {
        const input = harness.element.querySelector('[name="image-file"]');
        input.files = [{ type: 'image/webp', size: 1024, name: 'portrait.webp' }];
        input.dispatchEvent(new Event('change'));
        await flushUi(5);

        assert.equal(harness.feedback.at(-1), '图片库保存失败。');
        assert.equal(JSON.stringify(harness.feedback).includes('private-secret'), false);
        assert.equal(harness.element.querySelector('.yl-image-manager-status').textContent, '本地图片未保存。');
    } finally {
        harness.dispose();
    }
});

test('右键菜单仅含编辑入口，关键词和 -5..5 整数权重可保存', async () => {
    const harness = await buildHarness({
        seed: [{
            id: 'night_portrait',
            source: { kind: 'embedded', dataUrl: WEBP_DATA_URL },
            keywordWeights: [{ keyword: '夜景', weight: 3 }],
        }],
    });
    try {
        const card = harness.element.querySelector('.yl-image-card');
        card.dispatchEvent(new Event('contextmenu', { cancelable: true }));
        const menu = harness.element.querySelector('.yl-image-context-menu');
        assert.equal(menu.hidden, false);
        assert.equal(menu.querySelectorAll('button').length, 1);
        assert.equal(menu.querySelector('button').textContent, '编辑匹配关键词');
        menu.querySelector('button').dispatchEvent(new Event('click', { cancelable: true }));

        const rows = harness.element.querySelector('.yl-image-keyword-rows');
        const inputs = rows.querySelectorAll('input');
        const keyword = inputs.find((input) => input.dataset.role === 'keyword');
        const weight = inputs.find((input) => input.dataset.role === 'weight');
        assert.equal(keyword.value, '夜景');
        assert.equal(weight.value, '3');
        keyword.value = '温柔';
        weight.value = '-2';
        buttonByText(harness.element, '保存关键词').dispatchEvent(new Event('click', { cancelable: true }));
        await flushUi(6);

        assert.deepEqual((await harness.store.get('night_portrait')).keywordWeights, [{ keyword: '温柔', weight: -2 }]);
        assert.equal(harness.element.querySelector('.yl-image-keyword-backdrop').hidden, true);
        assert.equal(harness.changes.at(-1).type, 'update');
    } finally {
        harness.dispose();
    }
});

test('非整数或越界权重不会写库并显示安全错误', async () => {
    const harness = await buildHarness({
        seed: [{
            id: 'portrait',
            source: { kind: 'embedded', dataUrl: WEBP_DATA_URL },
            keywordWeights: [],
        }],
    });
    try {
        openKeywordEditor(harness.element);
        const inputs = harness.element.querySelector('.yl-image-keyword-rows').querySelectorAll('input');
        inputs.find((input) => input.dataset.role === 'keyword').value = '艺术';
        inputs.find((input) => input.dataset.role === 'weight').value = '3.5';
        buttonByText(harness.element, '保存关键词').dispatchEvent(new Event('click', { cancelable: true }));
        await flushUi(4);

        assert.equal(harness.feedback.at(-1), '关键词权重必须是 -5 到 5 的整数。');
        assert.deepEqual((await harness.store.get('portrait')).keywordWeights, []);
        assert.equal(harness.element.querySelector('.yl-image-keyword-backdrop').hidden, false);
    } finally {
        harness.dispose();
    }
});

test('编辑弹窗内可删除图片，closeEditor 和 handleEscape 可清理瞬态界面', async () => {
    const harness = await buildHarness({
        seed: [{
            id: 'delete_me',
            source: { kind: 'embedded', dataUrl: WEBP_DATA_URL },
            keywordWeights: [],
        }],
    });
    try {
        openKeywordEditor(harness.element);
        harness.closeEditor();
        assert.equal(harness.element.querySelector('.yl-image-keyword-backdrop').hidden, true);

        openKeywordEditor(harness.element);
        assert.equal(harness.handleEscape(), true);
        assert.equal(harness.element.querySelector('.yl-image-keyword-backdrop').hidden, true);
        assert.equal(harness.handleEscape(), false);

        openKeywordEditor(harness.element);
        buttonByText(harness.element, '删除图片').dispatchEvent(new Event('click', { cancelable: true }));
        await flushUi(6);
        assert.equal((await harness.store.list()).length, 0);
        assert.equal(harness.element.querySelector('.yl-image-manager-empty').textContent.includes('图片库还是空的'), true);
        assert.equal(harness.changes.at(-1).type, 'remove');
    } finally {
        harness.dispose();
    }
});

test('移动端长按打开菜单，随后的合成普通点击不会立即关闭菜单', async () => {
    const harness = await buildHarness({
        seed: [{
            id: 'touch_portrait',
            source: { kind: 'embedded', dataUrl: WEBP_DATA_URL },
            keywordWeights: [],
        }],
    });
    try {
        const card = harness.element.querySelector('.yl-image-card');
        card.dispatchEvent(new Event('click', { cancelable: true }));
        assert.equal(harness.element.querySelector('.yl-image-context-menu').hidden, true, '普通点击不得打开菜单');

        card.dispatchEvent(new Event('pointerdown', { cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 590));
        assert.equal(harness.element.querySelector('.yl-image-context-menu').hidden, false, '长按应打开菜单');
        card.dispatchEvent(new Event('pointerup', { cancelable: true }));
        card.dispatchEvent(new Event('click', { cancelable: true }));
        assert.equal(harness.element.querySelector('.yl-image-context-menu').hidden, false, '长按后的点击不得和菜单冲突');
    } finally {
        harness.dispose();
    }
});

test('注入 dialogController 时打开编辑器经控制器 open：opener 为触发卡片，onRequestClose 可关闭并清理瞬态', async () => {
    const dialogController = createFakeDialogController();
    const harness = await buildHarness({ seed: [seedRecord('opener_card', [{ keyword: '夜景', weight: 3 }])], dialogController });
    try {
        const backdrop = openKeywordEditor(harness.element);
        const editor = harness.element.querySelector('.yl-image-keyword-editor');
        const card = harness.element.querySelector('.yl-image-card');
        assert.equal(dialogController.openCalls.length, 1);
        assert.equal(dialogController.openCalls[0].dialog, editor, '入栈的 dialog 应是 role=dialog 的编辑器节点');
        assert.equal(dialogController.openCalls[0].options.opener, card, 'opener 应是触发的图片卡片');
        assert.equal(typeof dialogController.openCalls[0].options.onRequestClose, 'function');

        dialogController.openCalls[0].options.onRequestClose();
        assert.equal(backdrop.hidden, true, 'onRequestClose 应关闭编辑器');
        assert.equal(dialogController.closeCalls.length, 1, '关闭应把编辑器移出控制器栈');
        assert.equal(dialogController.closeCalls[0].dialog, editor);
        assert.equal(dialogController.hasOpenDialog(), false);
        assert.equal(harness.element.querySelector('.yl-image-keyword-rows').querySelectorAll('input').length, 0, '关闭应清理关键词行瞬态');
        assert.equal(harness.element.querySelector('.yl-image-keyword-editor-preview').childNodes.length, 0, '关闭应清理预览瞬态');
    } finally {
        harness.dispose();
    }
});

test('有控制器时不在 documentRef 上注册自己的 keydown Escape（无双通道）', async () => {
    const registered = [];
    const original = miniDom.document.addEventListener.bind(miniDom.document);
    miniDom.document.addEventListener = (type, ...rest) => {
        registered.push(type);
        return original(type, ...rest);
    };
    let harness = null;
    try {
        harness = await buildHarness({ seed: [seedRecord('no_own_keydown')], dialogController: createFakeDialogController() });
        assert.equal(registered.includes('keydown'), false, '有控制器时不得注册面板自己的 document keydown');
        assert.equal(registered.includes('click'), true, '外点关闭右键菜单的 document click 监听仍应注册');

        const backdrop = openKeywordEditor(harness.element);
        miniDom.document.dispatchEvent(keyEvent('Escape'));
        assert.equal(backdrop.hidden, false, 'document Escape 不再由面板处理，编辑器交由控制器全局链关闭');
    } finally {
        delete miniDom.document.addEventListener;
        harness?.dispose();
    }
});

test('无控制器降级仍注册 document keydown，Escape 关闭编辑器', async () => {
    const registered = [];
    const original = miniDom.document.addEventListener.bind(miniDom.document);
    miniDom.document.addEventListener = (type, ...rest) => {
        registered.push(type);
        return original(type, ...rest);
    };
    let harness = null;
    try {
        harness = await buildHarness({ seed: [seedRecord('legacy_escape')] });
        assert.equal(registered.includes('keydown'), true, '无控制器时保留面板自己的 document keydown');

        const backdrop = openKeywordEditor(harness.element);
        miniDom.document.dispatchEvent(keyEvent('Escape'));
        assert.equal(backdrop.hidden, true, '无控制器时 document Escape 仍关闭编辑器');
    } finally {
        delete miniDom.document.addEventListener;
        harness?.dispose();
    }
});

test('保存/取消/删除/backdrop 点击都恰好经控制器 close 一次，栈不悬挂', async () => {
    const dialogController = createFakeDialogController();
    const harness = await buildHarness({ seed: [seedRecord('close_paths', [{ keyword: '夜景', weight: 3 }])], dialogController });
    try {
        const backdrop = openKeywordEditor(harness.element);
        buttonByText(harness.element, '取消').dispatchEvent(new Event('click', { cancelable: true }));
        assert.equal(dialogController.closeCalls.length, 1, '取消应 close 一次');
        assert.equal(backdrop.hidden, true);

        openKeywordEditor(harness.element);
        backdrop.dispatchEvent(new Event('click', { cancelable: true }));
        assert.equal(dialogController.closeCalls.length, 2, 'backdrop 点击应 close 一次');
        assert.equal(backdrop.hidden, true);

        openKeywordEditor(harness.element);
        buttonByText(harness.element, '保存关键词').dispatchEvent(new Event('click', { cancelable: true }));
        await flushUi(6);
        assert.equal(dialogController.closeCalls.length, 3, '保存成功应 close 一次');
        assert.equal(backdrop.hidden, true);
        assert.equal(harness.changes.at(-1).type, 'update');

        openKeywordEditor(harness.element);
        buttonByText(harness.element, '删除图片').dispatchEvent(new Event('click', { cancelable: true }));
        await flushUi(6);
        assert.equal(dialogController.closeCalls.length, 4, '删除成功应 close 一次');
        assert.equal(backdrop.hidden, true);
        assert.equal((await harness.store.list()).length, 0);

        assert.equal(dialogController.openCalls.length, 4);
        assert.equal(dialogController.hasOpenDialog(), false, '四条关闭路径后控制器栈应为空');
        harness.closeEditor();
        assert.equal(dialogController.closeCalls.length, 4, '编辑器已关时 closeEditor 不得重复出栈');
    } finally {
        harness.dispose();
    }
});

test('有控制器时 handleEscape 只接管右键菜单，编辑器 Escape 归控制器', async () => {
    const dialogController = createFakeDialogController();
    const harness = await buildHarness({ seed: [seedRecord('escape_split')], dialogController });
    try {
        assert.equal(harness.handleEscape(), false, '无瞬态界面时返回 false');

        const card = harness.element.querySelector('.yl-image-card');
        card.dispatchEvent(new Event('contextmenu', { cancelable: true }));
        const menu = harness.element.querySelector('.yl-image-context-menu');
        assert.equal(menu.hidden, false);
        assert.equal(harness.handleEscape(), true, '右键菜单不入控制器栈，仍由 handleEscape 关闭');
        assert.equal(menu.hidden, true);

        const backdrop = openKeywordEditor(harness.element);
        assert.equal(harness.handleEscape(), false, '编辑器开着时返回 false：Escape 由控制器 handleKeydown 负责');
        assert.equal(backdrop.hidden, false, 'handleEscape 不得越权关闭控制器管理的编辑器');
        assert.equal(dialogController.closeCalls.length, 0);
    } finally {
        harness.dispose();
    }
});

test('真实 dialogController：打开聚焦首行关键词输入，Escape 经控制器关闭并回焦触发卡片', async () => {
    const dialogController = createDialogController({ documentRef: miniDom.document });
    const harness = await buildHarness({ seed: [seedRecord('focus_flow', [{ keyword: '夜景', weight: 3 }])], dialogController });
    miniDom.document.body.appendChild(harness.element);
    try {
        const card = harness.element.querySelector('.yl-image-card');
        card.dispatchEvent(keyEvent('Enter'));

        const backdrop = harness.element.querySelector('.yl-image-keyword-backdrop');
        const editor = harness.element.querySelector('.yl-image-keyword-editor');
        assert.equal(backdrop.hidden, false);
        assert.equal(dialogController.hasOpenDialog(), true);
        assert.equal(dialogController.isTopDialog(editor), true);
        const firstKeywordInput = harness.element.querySelector('.yl-image-keyword-rows')
            .querySelectorAll('input')
            .find((input) => input.dataset.role === 'keyword');
        assert.equal(miniDom.document.activeElement, firstKeywordInput, '打开后应聚焦首行关键词输入');

        assert.equal(dialogController.handleKeydown(keyEvent('Escape')), true);
        assert.equal(backdrop.hidden, true, 'Escape 经控制器 onRequestClose 关闭编辑器');
        assert.equal(dialogController.hasOpenDialog(), false, '关闭后控制器栈应为空');
        assert.equal(miniDom.document.activeElement, card, '关闭后应礼貌回焦触发卡片');
    } finally {
        dialogController.dispose();
        harness.element.remove();
        miniDom.document.activeElement = null;
        harness.dispose();
    }
});

test('本地预览加载失败时显示失败状态', async () => {
    const harness = await buildHarness({
        seed: [{
            id: 'broken_portrait',
            source: { kind: 'embedded', dataUrl: WEBP_DATA_URL },
            keywordWeights: [],
        }],
    });
    try {
        const image = harness.element.querySelector('.yl-image-preview');
        image.dispatchEvent(new Event('error'));
        const state = harness.element.querySelector('.yl-image-preview-state');
        assert.equal(state.hidden, false);
        assert.equal(state.textContent, '图片加载失败');
    } finally {
        harness.dispose();
    }
});

test('未注入链接导入能力时不渲染链接入口，也不复活 image-url 表单', async () => {
    const harness = await buildHarness();
    assert.equal(harness.element.querySelector('[name="image-import-url"]'), null, '无能力时不得留下死链接输入框');
    assert.equal(harness.element.querySelector('[name="image-url"]'), null, '旧 image-url 表单不得复活');
    const remoteButton = harness.element.querySelectorAll('button').find((button) => button.textContent === '下载并保存到图片库');
    assert.equal(remoteButton, undefined, '无能力时不得留下死导入按钮');
});

test('链接导入成功：一次下载经压缩链保存为 embedded 记录，URL 不落库不回显', async () => {
    const importedUrls = [];
    const store = createStore();
    const feedback = [];
    const api = createImageManagerPanel({
        documentRef: miniDom.document,
        imageLibrary: store,
        compressImageFile: async () => WEBP_DATA_URL,
        onChange() {},
        onFeedback: (message) => feedback.push(message),
        importRemoteImageFile: async (url) => { importedUrls.push(url); return { size: 128, type: 'image/png' }; },
    });
    await flushUi();
    const harness = { store, feedback, ...api };
    const urlInput = harness.element.querySelector('[name="image-import-url"]');
    assert.ok(urlInput, '注入能力后应有链接输入框');
    urlInput.value = '  https://example.com/photo.png  ';
    buttonByText(harness.element, '下载并保存到图片库').dispatchEvent(new Event('click'));
    await flushUi();
    assert.deepEqual(importedUrls, ['https://example.com/photo.png'], '应以去空格后的链接调用注入导入器且只调一次');
    const records = await harness.store.list();
    assert.equal(records.length, 1, '成功导入应新增一条记录');
    assert.equal(records[0].source.kind, 'embedded', '记录必须是 embedded 来源');
    assert.equal(records[0].source.dataUrl, WEBP_DATA_URL, '记录必须是压缩链输出的 data URL');
    assert.equal(JSON.stringify(records).includes('example.com'), false, 'URL 不得落入图片库记录');
    assert.equal(urlInput.value, '', '成功后应清空链接输入');
    assert.ok(harness.feedback.some((message) => message.includes('链接本身不会被保存')), '反馈必须申明链接不持久化');
    assert.equal(harness.element.textContent.includes('example.com'), false, '面板可见文本不得回显链接');
});

test('链接导入失败：不新增记录并显示安全投影文案', async () => {
    const store = createStore();
    const feedback = [];
    const failure = new Error('REMOTE_FETCH_FAILED');
    failure.code = 'REMOTE_FETCH_FAILED';
    const api = createImageManagerPanel({
        documentRef: miniDom.document,
        imageLibrary: store,
        compressImageFile: async () => WEBP_DATA_URL,
        onChange() {},
        onFeedback: (message) => feedback.push(message),
        importRemoteImageFile: async () => { throw failure; },
    });
    await flushUi();
    const urlInput = api.element.querySelector('[name="image-import-url"]');
    const importButton = buttonByText(api.element, '下载并保存到图片库');
    importButton.dispatchEvent(new Event('click'));
    assert.equal(api.element.querySelector('.yl-image-manager-status').textContent, '请先粘贴要导入的图片链接。', '空链接应先提示');
    urlInput.value = 'https://example.com/broken.png';
    importButton.dispatchEvent(new Event('click'));
    await flushUi();
    assert.equal((await store.list()).length, 0, '失败不得新增记录');
    assert.equal(api.element.querySelector('.yl-image-manager-status').textContent, '链接图片未保存。');
    assert.ok(feedback.includes('图片链接下载失败；请确认链接可公开访问后重试。'), '应输出安全投影文案');
    assert.equal(feedback.some((message) => message.includes('example.com')), false, '失败反馈不得回显链接');
    assert.equal(importButton.disabled, false, '失败后导入按钮应恢复可用');
});

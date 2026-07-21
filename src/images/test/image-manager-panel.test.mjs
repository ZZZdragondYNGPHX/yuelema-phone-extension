import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import {
    createImageLibraryStore,
    createMemoryImageLibraryStorage,
    ImageLibraryError,
} from '../image-library-store.js';

const miniDom = installMiniDom();
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

async function buildHarness({ seed = [], imageLibrary, compressImageFile, onChange, onFeedback, onConfigure } = {}) {
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
    });
    await flushUi();
    return { store, changes, feedback, ...api };
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

test('URL 导入后显示网格预览并触发 onChange', async () => {
    const harness = await buildHarness();
    try {
        const urlInput = harness.element.querySelector('[name="image-url"]');
        urlInput.value = 'https://images.example/city-night.webp';
        buttonByText(harness.element, '导入图片链接').dispatchEvent(new Event('click', { cancelable: true }));
        await flushUi(6);

        const records = await harness.store.list();
        assert.equal(records.length, 1);
        assert.deepEqual(records[0].source, { kind: 'url', url: 'https://images.example/city-night.webp' });
        const image = harness.element.querySelector('.yl-image-preview');
        assert.equal(image.getAttribute('src'), 'https://images.example/city-night.webp');
        assert.equal(image.getAttribute('referrerpolicy'), 'no-referrer');
        assert.equal(harness.changes.at(-1).type, 'add');
        assert.equal(harness.feedback.at(-1).includes('图片链接已保存'), true);
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
test('异步图片库错误通过 projectImageLibraryError 投影且不泄露底层文本', async () => {
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
    const harness = await buildHarness({ imageLibrary: failingLibrary });
    try {
        const input = harness.element.querySelector('[name="image-url"]');
        input.value = 'https://images.example/failure.webp';
        buttonByText(harness.element, '导入图片链接').dispatchEvent(new Event('click', { cancelable: true }));
        await flushUi(5);

        assert.equal(harness.feedback.at(-1), '图片库保存失败。');
        assert.equal(JSON.stringify(harness.feedback).includes('private-secret'), false);
        assert.equal(harness.element.querySelector('.yl-image-manager-status').textContent, '图片链接未保存。');
    } finally {
        harness.dispose();
    }
});

test('右键菜单仅含编辑入口，关键词和 -5..5 整数权重可保存', async () => {
    const harness = await buildHarness({
        seed: [{
            id: 'night_portrait',
            source: { kind: 'url', url: 'https://images.example/night.webp' },
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
            source: { kind: 'url', url: 'https://images.example/portrait.webp' },
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
            source: { kind: 'url', url: 'https://images.example/delete.webp' },
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
            source: { kind: 'url', url: 'https://images.example/touch.webp' },
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

test('远程预览加载失败时显示失败状态', async () => {
    const harness = await buildHarness({
        seed: [{
            id: 'broken_portrait',
            source: { kind: 'url', url: 'https://images.example/broken.webp' },
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

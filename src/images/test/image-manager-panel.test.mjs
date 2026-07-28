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

async function buildHarness({
    seed = [], imageLibrary, compressImageFile, onChange, onFeedback, onConfigure,
    onConfigureGeneration, dialogController, downloadImagePack, generateImage,
    initialImageProvider, importRemoteImageFile,
} = {}) {
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
        onConfigureGeneration,
        dialogController,
        importRemoteImageFile,
        downloadImagePack,
        generateImage,
        initialImageProvider,
    });
    await flushUi();
    return { store, changes, feedback, ...api };
}

test('图片管理的生图按钮打开独立界面，选择接口并生成后直接压缩保存到图片库', async () => {
    const requests = [];
    const compressed = [];
    const generationSettings = [];
    const harness = await buildHarness({
        initialImageProvider: 'openai_compatible',
        generateImage: async (request) => {
            requests.push(request);
            return { ok: true, image: { dataUrl: WEBP_DATA_URL, src: WEBP_DATA_URL, mimeType: 'image/webp', kind: 'data_url' } };
        },
        compressImageFile: async (blob) => {
            compressed.push({ type: blob.type, size: blob.size });
            return WEBP_DATA_URL;
        },
        onConfigureGeneration: () => generationSettings.push('open'),
    });
    try {
        buttonByText(harness.element, '生图').dispatchEvent(new Event('click', { cancelable: true }));
        const workbench = harness.element.querySelector('.yl-image-generation-workbench');
        assert.equal(workbench.hidden, false);
        assert.equal(harness.element.classList.contains('is-generation-view'), true, '生图态应切换为独占网格');
        assert.equal(harness.element.querySelector('.yl-image-manager-side').hidden, true);
        assert.equal(harness.element.querySelector('.yl-image-manager-grid').hidden, true);
        assert.equal(harness.element.querySelector('[name="image-library-generation-provider"]').value, 'openai_compatible');

        buttonByText(workbench, '接口设置').dispatchEvent(new Event('click', { cancelable: true }));
        assert.deepEqual(generationSettings, ['open']);

        const provider = harness.element.querySelector('[name="image-library-generation-provider"]');
        const prompt = harness.element.querySelector('[name="image-library-generation-prompt"]');
        provider.value = 'comfyui';
        prompt.value = 'rainy neon city street';
        buttonByText(workbench, '生成并保存').dispatchEvent(new Event('click', { cancelable: true }));
        await flushUi(10);

        assert.equal(requests.length, 1);
        assert.equal(requests[0].provider, 'comfyui');
        assert.equal(requests[0].prompt, 'rainy neon city street');
        assert.ok(requests[0].signal instanceof AbortSignal);
        assert.deepEqual(compressed, [{ type: 'image/webp', size: 16 }]);
        const records = await harness.store.list();
        assert.equal(records.length, 1);
        assert.equal(records[0].source.dataUrl, WEBP_DATA_URL);
        assert.deepEqual(records[0].keywordWeights, []);
        assert.equal(harness.changes.at(-1).type, 'generate');
        assert.equal(workbench.hidden, true, '保存成功后应返回图片库');
        assert.equal(harness.element.classList.contains('is-generation-view'), false);
        assert.equal(harness.element.querySelector('.yl-image-manager-grid').hidden, false);
        assert.ok(harness.feedback.includes('图片已生成、压缩并保存到图片库。'));
    } finally {
        harness.dispose();
    }
});

test('图片库生图失败或取消时不保存图片，并保留提示词供重试', async () => {
    let resolveGeneration;
    const harness = await buildHarness({
        generateImage: ({ signal }) => new Promise((resolve) => {
            resolveGeneration = () => resolve(signal.aborted
                ? { ok: false, message: '生图请求已取消。' }
                : { ok: false, message: '接口暂时不可用。' });
        }),
        compressImageFile: async () => WEBP_DATA_URL,
    });
    try {
        buttonByText(harness.element, '生图').dispatchEvent(new Event('click', { cancelable: true }));
        const prompt = harness.element.querySelector('[name="image-library-generation-prompt"]');
        prompt.value = 'quiet lakeside at dawn';
        buttonByText(harness.element, '生成并保存').dispatchEvent(new Event('click', { cancelable: true }));
        await flushUi(2);
        const cancel = buttonByText(harness.element, '取消生成');
        assert.equal(cancel.hidden, false);
        cancel.dispatchEvent(new Event('click', { cancelable: true }));
        resolveGeneration();
        await flushUi(6);

        assert.equal((await harness.store.list()).length, 0);
        assert.equal(prompt.value, 'quiet lakeside at dawn');
        assert.equal(harness.element.querySelector('.yl-image-generation-status').textContent, '本次生成已取消，提示词仍保留。');
    } finally {
        harness.dispose();
    }
});

test('导出完整图包包含图片与关键词权重，并交给显式下载能力', async () => {
    const downloads = [];
    const harness = await buildHarness({
        seed: [seedRecord('pack_portrait', [{ keyword: '温柔', weight: 4 }])],
        downloadImagePack: async (json) => downloads.push(json),
    });
    try {
        buttonByText(harness.element, '导出完整图包').dispatchEvent(new Event('click', { cancelable: true }));
        await flushUi(6);

        assert.equal(downloads.length, 1);
        const exported = JSON.parse(downloads[0]);
        assert.equal(exported.schema, 'yuelema.image-library');
        assert.equal(exported.images[0].source.dataUrl, WEBP_DATA_URL);
        assert.deepEqual(exported.images[0].keywordWeights, [{ keyword: '温柔', weight: 4 }]);
        assert.equal(harness.element.querySelector('.yl-image-manager-status').textContent, '已导出 1 张图片及其关键词权重。');
    } finally {
        harness.dispose();
    }
});

test('图包文件只做合并导入，重复图片跳过且现有关键词不被覆盖', async () => {
    const harness = await buildHarness({
        seed: [seedRecord('existing', [{ keyword: '现有', weight: 5 }])],
    });
    try {
        const exported = await harness.store.export();
        const input = harness.element.querySelector('[name="image-pack-file"]');
        input.files = [{ type: 'application/json', name: 'pack.json', text: async () => exported }];
        input.dispatchEvent(new Event('change'));
        await flushUi(8);

        assert.equal((await harness.store.list()).length, 1);
        assert.deepEqual((await harness.store.get('existing')).keywordWeights, [{ keyword: '现有', weight: 5 }]);
        assert.match(harness.element.querySelector('.yl-image-manager-status').textContent, /已导入 0 张，跳过 1 张重复图片/u);
        assert.equal(harness.changes.at(-1).type, 'import');
        assert.ok(harness.feedback.includes('图包已安全合并；现有图片未被覆盖。'));
    } finally {
        harness.dispose();
    }
});

test('非法图包不会改变现有图片库', async () => {
    const harness = await buildHarness({ seed: [seedRecord('existing')] });
    try {
        const input = harness.element.querySelector('[name="image-pack-file"]');
        input.files = [{ type: 'application/json', name: 'broken.json', text: async () => '{bad json' }];
        input.dispatchEvent(new Event('change'));
        await flushUi(6);

        assert.deepEqual((await harness.store.list()).map((record) => record.id), ['existing']);
        assert.equal(harness.element.querySelector('.yl-image-manager-status').textContent, '图包未导入，现有图片保持不变。');
        assert.ok(harness.feedback.includes('图片库 JSON 无法解析。'));
    } finally {
        harness.dispose();
    }
});

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
    const empty = harness.element.querySelector('.yl-image-manager-empty');
    assert.equal(empty.textContent.includes('图片库还是空的'), true);
    assert.equal(empty.classList.contains('yl-empty'), true, '空态应使用 createEmptyState 组件');
    assert.equal(empty.classList.contains('yl-empty--inbox'), true, '空态应使用 inbox 插画变体');
    const illustration = empty.querySelector('.yl-empty__svg');
    assert.ok(illustration, '空态应内联 SVG 插画');
    assert.equal(illustration.dataset.illustration, 'inbox');
    assert.equal(empty.querySelector('.yl-empty__title').textContent, '图片库还是空的');
    assert.equal(empty.querySelector('.yl-empty__hint').textContent.includes('PNG、JPEG 或 WebP'), true);
    assert.equal(harness.element.querySelector('.yl-image-manager-status').textContent, '当前没有图片。');
    harness.closeEditor();
    harness.dispose();
    harness.dispose();
});

test('初次读取期间网格显示骨架屏，读取完成后骨架被替换', async () => {
    const store = createStore();
    await store.add(seedRecord('skeleton_probe'));
    const api = createImageManagerPanel({
        documentRef: miniDom.document,
        imageLibrary: store,
        onChange() {},
        onFeedback() {},
    });
    try {
        const skeleton = api.element.querySelector('.yl-skeleton');
        assert.ok(skeleton, '构建后、读取完成前应显示骨架屏');
        assert.equal(skeleton.classList.contains('yl-skeleton--candidate-card'), true);
        assert.equal(skeleton.getAttribute('aria-hidden'), 'true', '骨架屏必须对读屏隐藏');
        assert.equal(skeleton.parentNode.classList.contains('yl-image-manager-grid'), true);
        assert.ok(skeleton.querySelectorAll('.yl-skeleton__item').length >= 1);
        await flushUi();
        assert.equal(api.element.querySelector('.yl-skeleton'), null, '读取完成后骨架应被网格内容替换');
        assert.ok(api.element.querySelector('.yl-image-card'), '读取完成后应渲染图片卡片');
    } finally {
        api.dispose();
    }
});

test('读取失败时网格显示 EmptyState 失败态且骨架不残留', async () => {
    const failingLibrary = {
        async list() { throw new ImageLibraryError('STORAGE_READ_FAILED'); },
        async add() { throw new Error('not used'); },
        async update() { throw new Error('not used'); },
        async remove() { throw new Error('not used'); },
    };
    const harness = await buildHarness({ imageLibrary: failingLibrary });
    try {
        assert.equal(harness.element.querySelector('.yl-skeleton'), null, '失败后骨架不得残留');
        const failed = harness.element.querySelector('.yl-image-manager-empty');
        assert.ok(failed, '失败态应渲染空态容器');
        assert.equal(failed.classList.contains('yl-empty'), true, '失败态应使用 createEmptyState 组件');
        assert.equal(failed.querySelector('.yl-empty__svg').dataset.illustration, 'search');
        assert.equal(failed.textContent.includes('图片库读取失败'), true);
        assert.equal(harness.element.querySelector('.yl-image-manager-status').textContent, '图片库读取失败。');
    } finally {
        harness.dispose();
    }
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
        assert.equal(button.parentNode.classList.contains('yl-image-manager-title-actions'), true);
        assert.equal(button.parentNode.parentNode.classList.contains('yl-image-manager-titlebar'), true);
        const generateButton = buttonByText(harness.element, '生图');
        assert.equal(generateButton.getAttribute('aria-label'), '打开图片库生图');
        assert.equal(generateButton.parentNode, button.parentNode);
        assert.deepEqual(button.parentNode.childNodes.slice(0, 2), [generateButton, button], '生图文字按钮必须紧挨在设置按钮左侧');
        assert.equal(generateButton.querySelector('svg'), null, '左上角入口保持为与设置一致的纯文字按钮');

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

test('未注入链接导入能力时不渲染按钮，链接输入保持隐藏', async () => {
    const harness = await buildHarness();
    assert.equal(harness.element.querySelector('.yl-image-remote-import-backdrop').hidden, true, '链接下载输入框不得显示在主面板');
    assert.equal(harness.element.querySelector('[name="image-url"]'), null, '旧 image-url 表单不得复活');
    const remoteButton = harness.element.querySelectorAll('button').find((button) => button.textContent === '下载并保存到图片库');
    assert.equal(remoteButton, undefined, '不得留下无来源的下载按钮');
    assert.ok(harness.element.querySelector('[name="image-file"]'));
    assert.ok(harness.element.querySelector('[name="image-pack-file"]'));
});

test('链接下载按钮打开独立弹窗，取消不保存，确认后压缩入库', async () => {
    const importedUrls = [];
    const harness = await buildHarness({
        importRemoteImageFile: async (url) => {
            importedUrls.push(url);
            return { size: 128, type: 'image/png' };
        },
        compressImageFile: async () => WEBP_DATA_URL,
    });
    try {
        const button = buttonByText(harness.element, '下载并保存到图片库');
        const backdrop = harness.element.querySelector('.yl-image-remote-import-backdrop');
        const input = harness.element.querySelector('[name="image-import-url"]');
        assert.equal(backdrop.hidden, true, '主面板不应常驻显示链接输入框');

        button.dispatchEvent(new Event('click'));
        assert.equal(backdrop.hidden, false);
        assert.equal(miniDom.document.activeElement, input);
        assert.ok(buttonByText(backdrop, '确定'));
        assert.ok(buttonByText(backdrop, '取消'));

        input.value = 'https://example.com/cancelled.png';
        buttonByText(backdrop, '取消').dispatchEvent(new Event('click'));
        assert.equal(backdrop.hidden, true);
        assert.equal((await harness.store.list()).length, 0);
        assert.deepEqual(importedUrls, []);

        button.dispatchEvent(new Event('click'));
        input.value = '  https://example.com/photo.png  ';
        buttonByText(backdrop, '确定').dispatchEvent(new Event('click'));
        await flushUi();
        assert.deepEqual(importedUrls, ['https://example.com/photo.png']);
        assert.equal(backdrop.hidden, true);
        const records = await harness.store.list();
        assert.equal(records.length, 1);
        assert.equal(records[0].source.kind, 'embedded');
        assert.equal(records[0].source.dataUrl, WEBP_DATA_URL);
        assert.equal(JSON.stringify(records).includes('example.com'), false, '链接本身不得落库');
    } finally {
        harness.dispose();
    }
});

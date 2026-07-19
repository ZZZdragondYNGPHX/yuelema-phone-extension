import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createMemoryStorage, createSettingsStore } from '../settings-store.js';

const miniDom = installMiniDom();
const { buildSettingsPanel } = await import('../../settings-panel.js');

test.after(() => miniDom.restore());

function buildHarness(store = createSettingsStore({ storage: createMemoryStorage() })) {
    const feedback = [];
    let rerenders = 0;
    const panel = buildSettingsPanel({
        settingsStore: store,
        llmClient: null,
        signal: new AbortController().signal,
        onFeedback: (message) => feedback.push(message),
        onRerender: () => { rerenders += 1; },
    });
    return { store, panel, feedback, get rerenders() { return rerenders; } };
}

function byAria(panel, label) {
    const found = panel.querySelectorAll('input').concat(panel.querySelectorAll('select'), panel.querySelectorAll('textarea'), panel.querySelectorAll('button'))
        .find((node) => node.getAttribute('aria-label') === label);
    assert.ok(found, `应存在控件：${label}`);
    return found;
}

function button(panel, label) {
    const found = panel.querySelectorAll('button').find((node) => node.textContent === label);
    assert.ok(found, `应存在按钮：${label}`);
    return found;
}

async function click(node) {
    node.dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
}

function addConnection(store, id = 'fast') {
    store.addConnectionPreset({
        id, name: `${id} 连接`, url: 'https://api.example/v1', model: 'gpt-test', temperature: 0.7, maxTokens: 800, timeoutMs: 30_000,
    });
}

function addSinglePrompt(store, id = 'base') {
    store.addPromptPreset({
        id, name: `${id} 提示词`, depth: 4, order: 100, position: 'before_character_definition', enabled: true, content: '安全的单条提示词',
    });
}

test('连接预设自动生成 ID、按名称选择载入，界面不要求手填已有 ID', async () => {
    const harness = buildHarness();
    const { panel, store } = harness;
    assert.equal(panel.textContent.includes('编辑时填已有 ID'), false);
    assert.equal(panel.textContent.includes('预设 ID（'), false);

    byAria(panel, '连接预设名称').value = '快速模型';
    byAria(panel, 'API URL').value = 'https://api.example/v1';
    byAria(panel, '模型名称').value = 'gpt-fast';
    await click(button(panel, '保存连接预设'));
    const saved = store.snapshot().connectionPresets;
    assert.equal(saved.length, 1);
    assert.match(saved[0].id, /^conn_/u);
    assert.equal(saved[0].name, '快速模型');
    assert.equal(store.exportJson().includes('API Key'), false);

    const loaded = buildHarness(store).panel;
    const picker = byAria(loaded, '已保存连接预设');
    picker.value = saved[0].id;
    picker.dispatchEvent(new Event('change'));
    assert.equal(byAria(loaded, '连接预设名称').value, '快速模型');
    assert.equal(byAria(loaded, 'API URL').value, 'https://api.example/v1');
    assert.equal(byAria(loaded, '模型名称').value, 'gpt-fast');
});

test('提示词预设可保存多个 Worldbook 风格条目，导出只包含提示词且可安全导回', async () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    addConnection(store);
    const { panel } = buildHarness(store);
    byAria(panel, '提示词预设名称').value = '匹配工作流';
    byAria(panel, '提示词条目名称').value = '公开资料边界';
    byAria(panel, '提示词条目正文').value = '只使用公开资料。';
    await click(button(panel, '添加条目'));
    byAria(panel, '提示词条目名称').value = '输出格式';
    byAria(panel, '提示词深度').value = '7';
    byAria(panel, '提示词顺序').value = '120';
    byAria(panel, '提示词条目正文').value = '只输出合法 JSON。';
    await click(button(panel, '添加条目'));
    await click(button(panel, '保存提示词预设'));

    const saved = store.snapshot().promptPresets;
    assert.equal(saved.length, 1);
    assert.match(saved[0].id, /^prompt_/u);
    const envelope = JSON.parse(saved[0].content);
    assert.deepEqual(envelope.schema, 'yuelema.prompt-entries');
    assert.equal(envelope.entries.length, 2);
    assert.deepEqual(envelope.entries.map((entry) => entry.name), ['公开资料边界', '输出格式']);
    assert.deepEqual(envelope.entries.map((entry) => entry.depth), [4, 7]);

    const exportPanel = buildHarness(store).panel;
    await click(button(exportPanel, '导出全部提示词预设 JSON'));
    const transfer = byAria(exportPanel, '提示词预设导入导出 JSON').value;
    const bundle = JSON.parse(transfer);
    assert.deepEqual(Object.keys(bundle).sort(), ['promptPresets', 'schema', 'schemaVersion']);
    assert.equal(transfer.includes('connectionPresets'), false);
    assert.equal(transfer.toLowerCase().includes('apikey'), false);

    const importedStore = createSettingsStore({ storage: createMemoryStorage() });
    addConnection(importedStore, 'preserved_connection');
    const importPanel = buildHarness(importedStore).panel;
    byAria(importPanel, '提示词预设导入导出 JSON').value = transfer;
    await click(button(importPanel, '导入并覆盖提示词预设'));
    assert.equal(importedStore.snapshot().connectionPresets[0].id, 'preserved_connection');
    assert.equal(importedStore.snapshot().promptPresets.length, 1);
    assert.deepEqual(JSON.parse(importedStore.snapshot().promptPresets[0].content).entries.map((entry) => entry.name), ['公开资料边界', '输出格式']);
});

test('灵魂匹配和文字匹配在 UI 保存时同步为同一对独立选择的连接与提示词', async () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    addConnection(store, 'fast');
    addConnection(store, 'smart');
    addSinglePrompt(store, 'soul_prompt');
    addSinglePrompt(store, 'text_prompt');
    // 模拟旧版本留下的不同绑定，UI 必须在保存时收敛为同一对。
    store.bindFunction('soul_match', { connectionPresetId: 'fast', promptPresetId: 'soul_prompt' });
    store.bindFunction('text_match', { connectionPresetId: 'smart', promptPresetId: 'text_prompt' });

    const { panel } = buildHarness(store);
    assert.match(panel.textContent, /当前已同步/u);
    byAria(panel, '灵魂匹配和文字匹配共用连接预设').value = 'smart';
    byAria(panel, '灵魂匹配和文字匹配共用提示词预设').value = 'text_prompt';
    await click(button(panel, '同步并保存匹配绑定'));

    const snapshot = store.snapshot();
    assert.deepEqual(snapshot.functionBindings.soul_match, { connectionPresetId: 'smart', promptPresetId: 'text_prompt' });
    assert.deepEqual(snapshot.functionBindings.text_match, { connectionPresetId: 'smart', promptPresetId: 'text_prompt' });
});

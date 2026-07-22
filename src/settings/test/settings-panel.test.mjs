import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createMemoryStorage, createSettingsStore } from '../settings-store.js';
import {
    clearPersistentKeys,
    clearSessionKeys,
    configurePersistentKeyStorage,
    hasPersistentKey,
    requireSessionKey,
    resetPersistentKeyStorage,
    unlockSessionKey,
} from '../../llm/session-key-store.js';

const miniDom = installMiniDom();
const { buildSettingsPanel } = await import('../../settings-panel.js');

test.after(() => miniDom.restore());
test.afterEach(() => {
    clearPersistentKeys();
    resetPersistentKeyStorage();
});

function buildHarness(store = createSettingsStore({ storage: createMemoryStorage() }), options = {}) {
    const feedback = [];
    const navigations = [];
    let rerenders = 0;
    const panel = buildSettingsPanel({
        settingsStore: store,
        llmClient: null,
        signal: new AbortController().signal,
        onFeedback: (message) => feedback.push(message),
        onRerender: () => { rerenders += 1; },
        onNavigate: (target) => navigations.push(target),
        ...options,
    });
    return { store, panel, feedback, navigations, get rerenders() { return rerenders; } };
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

function byName(panel, name) {
    const found = panel.querySelector(`[name="${name}"]`);
    assert.ok(found, `应存在 name=${name} 的控件`);
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

function addSinglePrompt(store, id = 'base', contentMode = 'SFW') {
    store.addPromptPreset({
        id, name: `${id} 提示词`, depth: 4, order: 100, position: 'before_character_definition', enabled: true, contentMode, content: '安全的单条提示词',
    });
}

test('连接预设自动生成 ID、按名称选择载入，界面不要求手填已有 ID', async () => {
    const { panel, store } = buildHarness(createSettingsStore({ storage: createMemoryStorage() }), { section: 'connection' });
    assert.equal(panel.textContent.includes('编辑时填已有 ID'), false);
    assert.equal(panel.textContent.includes('预设 ID（'), false);
    assert.equal(panel.textContent.includes('提示词预设'), false);
    assert.equal(panel.querySelector('[name="prompt-preset-name"]'), null);

    byAria(panel, '连接预设名称').value = '快速模型';
    byAria(panel, 'API URL').value = 'https://api.example/v1';
    byAria(panel, '模型名称').value = 'gpt-fast';
    await click(button(panel, '保存连接预设'));
    const saved = store.snapshot().connectionPresets;
    assert.equal(saved.length, 1);
    assert.match(saved[0].id, /^conn_/u);
    assert.equal(saved[0].name, '快速模型');
    assert.equal(saved[0].transportMode, 'stream');
    assert.equal(saved[0].maxTokens, 2048);
    assert.equal(store.exportJson().includes('API Key'), false);

    const loaded = buildHarness(store).panel;
    const picker = byAria(loaded, '已保存连接预设');
    assert.equal(picker.value, saved[0].id);
    assert.equal(byAria(loaded, '连接预设名称').value, '快速模型');
    picker.value = saved[0].id;
    picker.dispatchEvent(new Event('change'));
    assert.equal(byAria(loaded, '连接预设名称').value, '快速模型');
    assert.equal(byAria(loaded, 'API URL').value, 'https://api.example/v1');
    assert.equal(byAria(loaded, '模型名称').value, 'gpt-fast');
    assert.equal(byAria(loaded, '传输模式').value, 'stream');
});

test('填写 API Key 后保存连接预设会保存到独立浏览器缓存，但不会写入设置导出', async () => {
    const keyStorage = createMemoryStorage();
    configurePersistentKeyStorage(keyStorage);
    const { panel, store, feedback } = buildHarness(createSettingsStore({ storage: createMemoryStorage() }), { section: 'connection' });
    byAria(panel, '连接预设名称').value = '可直接调用';
    byAria(panel, 'API URL').value = 'https://api.example/v1';
    byAria(panel, '模型名称').value = 'gpt-direct';
    byAria(panel, 'API Key，保存到此浏览器').value = 'browser-cache-secret';
    await click(button(panel, '保存连接预设'));

    const saved = store.snapshot().connectionPresets[0];
    assert.ok(saved);
    assert.equal(hasPersistentKey(saved.id), true);
    assert.equal(byAria(panel, 'API Key，保存到此浏览器').value, '');
    assert.equal(store.exportJson().includes('browser-cache-secret'), false);
    clearSessionKeys();
    assert.equal(requireSessionKey(saved.id), 'browser-cache-secret');
    assert.ok(feedback.some((message) => message.includes('已保存到当前浏览器')));
});

test('连接页可删除当前连接的浏览器缓存 API Key', async () => {
    configurePersistentKeyStorage(createMemoryStorage());
    const store = createSettingsStore({ storage: createMemoryStorage() });
    addConnection(store, 'fast');
    unlockSessionKey('fast', 'remove-this-browser-key');
    const { panel, feedback } = buildHarness(store, { section: 'connection' });

    assert.equal(hasPersistentKey('fast'), true);
    await click(button(panel, '删除当前已保存 API Key'));

    assert.equal(hasPersistentKey('fast'), false);
    assert.ok(feedback.some((message) => message.includes('已删除当前连接')));
});

test('Model 为空时也能解锁并从 /models 拉取模型列表', async () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    let receivedPreset = null;
    const llmClient = {
        async fetchModels({ preset }) {
            receivedPreset = { ...preset };
            return ['model-alpha', 'model-beta'];
        },
    };
    const { panel } = buildHarness(store, { section: 'connection', llmClient });
    byAria(panel, '连接预设名称').value = '待探测连接';
    byAria(panel, 'API URL').value = 'https://api.example/v1';
    byAria(panel, '模型名称').value = '';
    byAria(panel, 'API Key，保存到此浏览器').value = 'session-secret';
    await click(byName(panel, 'connection-fetch-models'));
    assert.ok(receivedPreset);
    assert.equal(receivedPreset.model, '');
    assert.equal(receivedPreset.transportMode, 'stream');
    const choices = byAria(panel, '已拉取模型');
    assert.equal(choices.hidden, false);
    assert.equal(choices.querySelectorAll('option').length, 3);
    choices.value = 'model-beta';
    choices.dispatchEvent(new Event('change'));
    assert.equal(byAria(panel, '模型名称').value, 'model-beta');
});

test('功能绑定为各入口分别呈现并保存，匹配与角色创作绑定互不覆盖', async () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    addConnection(store, 'fast');
    addConnection(store, 'smart');
    addSinglePrompt(store, 'base');
    addSinglePrompt(store, 'creative');
    const { panel } = buildHarness(store);

    for (const functionKey of [
        'chat', 'soul_match', 'text_match', 'character_ai_completion', 'character_full_authoring',
    ]) {
        assert.ok(byName(panel, `${functionKey}-connection-preset`));
        assert.ok(byName(panel, `${functionKey}-prompt-preset`));
    }
    assert.equal(panel.querySelector('[name="character_authoring-connection-preset"]'), null);

    async function saveBinding(functionKey, connectionPresetId, promptPresetId) {
        const connection = byName(panel, `${functionKey}-connection-preset`);
        const prompt = byName(panel, `${functionKey}-prompt-preset`);
        connection.value = connectionPresetId;
        prompt.value = promptPresetId;
        const row = connection.parentNode?.parentNode;
        const save = row?.querySelectorAll('button').find((node) => node.textContent === '保存此功能绑定');
        assert.ok(save, `应存在 ${functionKey} 的保存按钮`);
        await click(save);
    }

    await saveBinding('soul_match', 'fast', 'base');
    await saveBinding('text_match', 'smart', 'creative');
    await saveBinding('character_ai_completion', 'fast', 'creative');
    await saveBinding('character_full_authoring', 'smart', 'base');

    assert.deepEqual(store.snapshot().functionModeBindings.soul_match.SFW, { connectionPresetId: 'fast', promptPresetId: 'base' });
    assert.deepEqual(store.snapshot().functionModeBindings.text_match.SFW, { connectionPresetId: 'smart', promptPresetId: 'creative' });
    assert.deepEqual(store.snapshot().functionModeBindings.character_ai_completion.SFW, { connectionPresetId: 'fast', promptPresetId: 'creative' });
    assert.deepEqual(store.snapshot().functionModeBindings.character_full_authoring.SFW, { connectionPresetId: 'smart', promptPresetId: 'base' });
});

test('提示词详情不混入连接设置，文案去掉风格措辞且可安全导入导出', async () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    addConnection(store);
    const { panel } = buildHarness(store, { view: 'prompt' });
    assert.equal(panel.textContent.includes('Worldbook'), false);
    assert.equal(panel.textContent.includes('世界书式'), false);
    assert.equal(panel.textContent.includes('连接预设（'), false);
    assert.equal(panel.querySelector('[name="connection-name"]'), null);
    byAria(panel, '提示词预设名称').value = '匹配工作流';
    byAria(panel, '提示词条目名称').value = '公开资料边界';
    byAria(panel, '提示词条目正文').value = '只使用公开资料。';
    await click(button(panel, '添加条目'));
    byAria(panel, '提示词条目名称').value = '输出格式';
    byAria(panel, '提示词深度').value = '7';
    byAria(panel, '提示词顺序').value = '120';
    byAria(panel, '提示词条目正文').value = '只输出合法 JSON。';
    await click(button(panel, '添加条目'));

    const tree = panel.querySelectorAll('div').find((node) => node.getAttribute('aria-label') === '提示词条目树');
    assert.ok(tree);
    assert.match(tree.textContent, /匹配工作流/u);
    assert.match(tree.textContent, /角色定义之前/u);
    assert.match(tree.textContent, /角色定义之后/u);
    assert.match(tree.textContent, /公开资料边界/u);
    assert.match(tree.textContent, /输出格式/u);
    assert.match(tree.textContent, /depth 7 · order 120/u);
    await click(byAria(panel, '编辑提示词条目 公开资料边界'));
    assert.match(panel.textContent, /编辑：公开资料边界/u);
    const firstToggle = byAria(panel, '公开资料边界启用状态');
    firstToggle.checked = false;
    firstToggle.dispatchEvent(new Event('change'));

    await click(button(panel, '保存提示词预设'));

    const saved = store.snapshot().promptPresets;
    const created = saved.find((preset) => preset.name === '匹配工作流');
    assert.equal(saved.length, 21);
    assert.ok(created);
    assert.match(created.id, /^prompt_/u);
    const envelope = JSON.parse(created.content);
    assert.deepEqual(envelope.schema, 'yuelema.prompt-entries');
    assert.equal(envelope.entries.length, 2);
    assert.deepEqual(envelope.entries.map((entry) => entry.name), ['公开资料边界', '输出格式']);
    assert.deepEqual(envelope.entries.map((entry) => entry.depth), [4, 7]);
    assert.deepEqual(envelope.entries.map((entry) => entry.enabled), [false, true]);

    const exportPanel = buildHarness(store, { section: 'prompt' }).panel;
    await click(button(exportPanel, '导出全部提示词预设 JSON'));
    const transfer = byAria(exportPanel, '提示词预设导入导出 JSON').value;
    const bundle = JSON.parse(transfer);
    assert.deepEqual(Object.keys(bundle).sort(), ['promptPresets', 'schema', 'schemaVersion']);
    assert.equal(transfer.includes('connectionPresets'), false);
    assert.equal(transfer.toLowerCase().includes('apikey'), false);

    const importedStore = createSettingsStore({ storage: createMemoryStorage() });
    addConnection(importedStore, 'preserved_connection');
    const importPanel = buildHarness(importedStore, { section: 'prompts' }).panel;
    byAria(importPanel, '提示词预设导入导出 JSON').value = transfer;
    await click(button(importPanel, '导入并覆盖提示词预设'));
    assert.equal(importedStore.snapshot().connectionPresets[0].id, 'preserved_connection');
    assert.equal(importedStore.snapshot().promptPresets.length, 21);
    const importedCreated = importedStore.snapshot().promptPresets.find((preset) => preset.name === '匹配工作流');
    assert.ok(importedCreated);
    assert.deepEqual(JSON.parse(importedCreated.content).entries.map((entry) => entry.name), ['公开资料边界', '输出格式']);
});

test('功能绑定设置页会按当前 NSFW 模式保存，不覆盖 SFW 默认预设', async () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    addConnection(store, 'fast');
    addSinglePrompt(store, 'custom_nsfw', 'NSFW');
    const { panel } = buildHarness(store, { contentMode: 'NSFW' });
    const connection = byName(panel, 'chat-connection-preset');
    const prompt = byName(panel, 'chat-prompt-preset');
    connection.value = 'fast';
    prompt.value = 'custom_nsfw';
    const row = connection.parentNode?.parentNode;
    const save = row?.querySelectorAll('button').find((node) => node.textContent === '保存此功能绑定');
    assert.ok(save);
    await click(save);

    assert.deepEqual(store.snapshot().functionModeBindings.chat.NSFW, { connectionPresetId: 'fast', promptPresetId: 'custom_nsfw' });
    assert.equal(store.resolveFunction('chat', { contentMode: 'SFW' }).promptPreset.id, 'builtin_private_chat_sfw');
});

test('提示词预设可标记为 NSFW，功能绑定只显示当前模式对应的预设', async () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const promptPanel = buildHarness(store, { section: 'prompt' }).panel;
    byAria(promptPanel, '提示词预设名称').value = '只给 NSFW 的语音匹配';
    const nsfw = byName(promptPanel, 'prompt-preset-nsfw');
    nsfw.checked = true;
    nsfw.dispatchEvent(new Event('change'));
    byAria(promptPanel, '提示词条目名称').value = '成年人边界';
    byAria(promptPanel, '提示词条目正文').value = '只处理明确成年且自愿的公开偏好。';
    await click(button(promptPanel, '添加条目'));
    await click(button(promptPanel, '保存提示词预设'));

    const created = store.snapshot().promptPresets.find((preset) => preset.name === '只给 NSFW 的语音匹配');
    assert.ok(created);
    assert.equal(created.contentMode, 'NSFW');

    const sfwPanel = buildHarness(store, { contentMode: 'SFW' }).panel;
    const sfwValues = byName(sfwPanel, 'text_match-prompt-preset').querySelectorAll('option').map((option) => option.value);
    assert.equal(sfwValues.includes(created.id), false);
    assert.equal(sfwValues.includes('builtin_voice_match_sfw'), true);
    assert.equal(sfwValues.includes('builtin_voice_match_nsfw'), false);

    const nsfwPanel = buildHarness(store, { contentMode: 'NSFW' }).panel;
    const nsfwValues = byName(nsfwPanel, 'text_match-prompt-preset').querySelectorAll('option').map((option) => option.value);
    assert.equal(nsfwValues.includes(created.id), true);
    assert.equal(nsfwValues.includes('builtin_voice_match_nsfw'), true);
    assert.equal(nsfwValues.includes('builtin_voice_match_sfw'), false);
});

test('个性化内容推荐管理通过导航回调打开偏好次级页，不展开关键词编辑器', async () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const { panel, navigations } = buildHarness(store, { view: 'personalization' });
    const editor = panel.querySelectorAll('section').find((node) => node.getAttribute('aria-label') === '个性化内容偏好编辑器');
    assert.equal(editor, undefined, '管理页不得创建或隐藏关键词编辑器，避免样式覆盖 hidden 后泄漏到当前页。');

    await click(byName(panel, 'personalization-preference-entry'));
    assert.deepEqual(navigations, ['settings_personalization_preference']);
    assert.equal(panel.querySelector('[name="personalization-keyword"]'), null);
});

test('个性化内容推荐关闭需确认，取消保持开启，关闭后偏好入口置灰', async () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const harness = buildHarness(store, { section: 'personalization' });
    const toggle = byName(harness.panel, 'personalization-enabled');
    const preferenceEntry = byName(harness.panel, 'personalization-preference-entry');
    assert.equal(toggle.checked, true);
    assert.equal(preferenceEntry.disabled, false);
    assert.equal(harness.panel.textContent.includes('AI 匹配工具'), false);
    assert.equal(harness.panel.textContent.includes('灵魂匹配'), false);
    assert.equal(harness.panel.textContent.includes('文字匹配'), false);

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    const notice = harness.panel.querySelectorAll('section').find((node) => node.getAttribute('aria-label') === '个性化内容推荐说明');
    assert.ok(notice);
    assert.equal(notice.hidden, false);
    assert.equal(notice.getAttribute('role'), 'dialog');
    assert.equal(notice.getAttribute('aria-modal'), 'true');
    assert.match(notice.textContent, /1.个性化内容推荐功能/u);
    assert.match(notice.textContent, /2.我不喜欢推荐的内容怎么办?/u);
    assert.match(notice.textContent, /3.关闭个性化内容推荐的效果是什么?/u);
    assert.equal(store.snapshot().personalization.enabled, true);

    await click(byName(harness.panel, 'personalization-modal-close'));
    assert.equal(notice.hidden, true);
    assert.equal(toggle.checked, true);
    assert.equal(store.snapshot().personalization.enabled, true);

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await click(byName(harness.panel, 'personalization-disable-cancel'));
    assert.equal(notice.hidden, true);
    assert.equal(toggle.checked, true);
    assert.equal(store.snapshot().personalization.enabled, true);

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await click(byName(harness.panel, 'personalization-disable-confirm'));
    assert.equal(store.snapshot().personalization.enabled, false);

    const disabledPanel = buildHarness(store, { view: 'personalization' }).panel;
    assert.equal(byName(disabledPanel, 'personalization-enabled').checked, false);
    assert.equal(byName(disabledPanel, 'personalization-preference-entry').disabled, true);

    const disabledToggle = byName(disabledPanel, 'personalization-enabled');
    disabledToggle.checked = true;
    disabledToggle.dispatchEvent(new Event('change'));
    assert.equal(store.snapshot().personalization.enabled, true);
});

test('preference 子视图通过稳定 name 查看并保存关键词权重', async () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const { panel } = buildHarness(store, { view: 'preference' });
    const editor = panel.querySelectorAll('section').find((node) => node.getAttribute('aria-label') === '个性化内容偏好编辑器');
    assert.ok(editor);
    assert.equal(editor.hidden, false);
    assert.equal(panel.querySelector('[name="personalization-preference-entry"]'), null);
    assert.equal(panel.querySelector('[name="personalization-enabled"]'), null, '偏好次级页不得重复渲染管理开关。');

    byName(panel, 'personalization-keyword').value = '电影';
    byName(panel, 'personalization-keyword-weight').value = '4';
    await click(byName(panel, 'personalization-keyword-upsert'));
    await click(byName(panel, 'personalization-preference-save'));
    assert.deepEqual(store.snapshot().personalization.keywordWeights, [{ keyword: '电影', weight: 4 }]);

    const reopened = buildHarness(store, { section: 'preferences' }).panel;
    assert.match(reopened.textContent, /电影 · 权重 4/u);
    assert.equal(reopened.textContent.includes('真实推荐算法未改变'), false);
    assert.match(reopened.textContent, /AI 可自由生成新标签/u);
});

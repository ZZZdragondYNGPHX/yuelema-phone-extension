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
// The production panel uses insertBefore to keep the transport notice before tabs.
// Add that DOM primitive only to this focused MiniDOM test harness.
const miniNodePrototype = Object.getPrototypeOf(Object.getPrototypeOf(document.createElement('div')));
if (typeof miniNodePrototype.insertBefore !== 'function') {
    Object.defineProperty(miniNodePrototype, 'insertBefore', {
        value(child, referenceNode) {
            if (referenceNode === null || referenceNode === undefined) return this.appendChild(child);
            const index = this.childNodes.indexOf(referenceNode);
            if (index < 0) throw new Error('insertBefore 参考节点不属于当前父节点。');
            child.remove();
            this.childNodes.splice(index, 0, child);
            child.parentNode = this;
            return child;
        },
    });
}
const { buildSettingsPanel } = await import('../../settings-panel.js');
const { createDialogController } = await import('../../ui/dialog-controller.js');

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

function keyEvent(key, { shiftKey = false } = {}) {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperty(event, 'key', { configurable: true, value: key });
    Object.defineProperty(event, 'shiftKey', { configurable: true, value: shiftKey });
    return event;
}

function personalizationNotice(panel) {
    const notice = panel.querySelectorAll('section').find((node) => node.getAttribute('aria-label') === '个性化内容推荐说明');
    assert.ok(notice, '应存在个性化内容推荐说明弹窗');
    return notice;
}

function isWithin(node, ancestor) {
    let current = node;
    while (current) {
        if (current === ancestor) return true;
        current = current.parentNode ?? null;
    }
    return false;
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
    const { panel, store } = buildHarness(createSettingsStore({ storage: createMemoryStorage() }), { view: 'connection' });
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
    assert.equal(saved[0].transportMode, 'json');
    assert.equal(saved[0].temperature, 1);
    assert.equal(saved[0].maxTokens, 10000);
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
    assert.equal(byAria(loaded, '传输模式').value, 'json');
});

test('填写 API Key 后保存连接预设会保存到独立浏览器缓存，但不会写入设置导出', async () => {
    const keyStorage = createMemoryStorage();
    configurePersistentKeyStorage(keyStorage);
    const { panel, store, feedback } = buildHarness(createSettingsStore({ storage: createMemoryStorage() }), { view: 'connection' });
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
    const { panel, feedback } = buildHarness(store, { view: 'connection' });

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
    const { panel } = buildHarness(store, { view: 'connection', llmClient });
    byAria(panel, '连接预设名称').value = '待探测连接';
    byAria(panel, 'API URL').value = 'https://api.example/v1';
    byAria(panel, '模型名称').value = '';
    byAria(panel, 'API Key，保存到此浏览器').value = 'session-secret';
    await click(byName(panel, 'connection-fetch-models'));
    assert.ok(receivedPreset);
    assert.equal(receivedPreset.model, '');
    assert.equal(receivedPreset.transportMode, 'json');
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
    assert.equal(saved.length, 23);
    assert.ok(created);
    assert.match(created.id, /^prompt_/u);
    const envelope = JSON.parse(created.content);
    assert.deepEqual(envelope.schema, 'yuelema.prompt-entries');
    assert.equal(envelope.entries.length, 2);
    assert.deepEqual(envelope.entries.map((entry) => entry.name), ['公开资料边界', '输出格式']);
    assert.deepEqual(envelope.entries.map((entry) => entry.depth), [4, 7]);
    assert.deepEqual(envelope.entries.map((entry) => entry.enabled), [false, true]);

    const exportPanel = buildHarness(store, { view: 'prompt' }).panel;
    await click(button(exportPanel, '导出全部提示词预设 JSON'));
    const transfer = byAria(exportPanel, '提示词预设导入导出 JSON').value;
    const bundle = JSON.parse(transfer);
    assert.deepEqual(Object.keys(bundle).sort(), ['promptPresets', 'schema', 'schemaVersion']);
    assert.equal(transfer.includes('connectionPresets'), false);
    assert.equal(transfer.toLowerCase().includes('apikey'), false);

    const importedStore = createSettingsStore({ storage: createMemoryStorage() });
    addConnection(importedStore, 'preserved_connection');
    const importPanel = buildHarness(importedStore, { view: 'prompt' }).panel;
    byAria(importPanel, '提示词预设导入导出 JSON').value = transfer;
    await click(button(importPanel, '导入并覆盖提示词预设'));
    assert.equal(importedStore.snapshot().connectionPresets[0].id, 'preserved_connection');
    assert.equal(importedStore.snapshot().promptPresets.length, 23);
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

    // 每个可绑定功能行都必须有中文标签：不得出现 undefined 行，text_match 显示为「描述匹配」。
    assert.equal(panel.textContent.includes('undefined'), false, '功能绑定行不得渲染 undefined 标签');
    assert.equal(panel.textContent.includes('对话总结'), true, 'chat_summary 绑定行需要中文标签');
    assert.equal(panel.textContent.includes('约伴服务角色生成'), true, 'service_profile_generation 绑定行需要中文标签');
    assert.equal(panel.textContent.includes('描述匹配'), true, 'text_match 绑定行应显示为描述匹配');
    assert.equal(panel.textContent.includes('语音匹配'), false, '绑定行不得再出现语音匹配旧文案');
});

test('提示词预设可标记为 NSFW，功能绑定只显示当前模式对应的预设', async () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const promptPanel = buildHarness(store, { view: 'prompt' }).panel;
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
    const harness = buildHarness(store, { view: 'personalization' });
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
    assert.match(notice.textContent, /个性化推荐仅使用当前设备保存的关键词权重/u);
    assert.match(notice.textContent, /可长按推荐选择「不感兴趣」/u);
    assert.match(notice.textContent, /关闭后改按非个性化因素展示/u);
    assert.equal(store.snapshot().personalization.enabled, true);

    const modalClose = byName(harness.panel, 'personalization-modal-close');
    assert.equal(modalClose.getAttribute('aria-label'), '关闭个性化内容推荐说明');
    assert.equal(modalClose.textContent.includes('×'), false, '关闭按钮不再使用文字 ×');
    const closeIcon = modalClose.childNodes.find((node) => typeof node.tagName === 'string' && node.tagName.toLowerCase() === 'svg');
    assert.ok(closeIcon, '关闭按钮应包含 SVG 图标');
    assert.equal(closeIcon.getAttribute('aria-hidden'), 'true');
    assert.equal(closeIcon.dataset.icon, 'close');

    await click(modalClose);
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

test('注入 dialogController 后：取消勾选打开弹窗即把焦点移入弹窗内首个可聚焦元素', async () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const dialogController = createDialogController({ documentRef: miniDom.document });
    const harness = buildHarness(store, { view: 'personalization', dialogController });
    miniDom.document.body.appendChild(harness.panel);
    try {
        const toggle = byName(harness.panel, 'personalization-enabled');
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));

        const notice = personalizationNotice(harness.panel);
        assert.equal(notice.hidden, false);
        assert.equal(dialogController.hasOpenDialog(), true);
        assert.equal(dialogController.isTopDialog(notice), true);
        const active = miniDom.document.activeElement;
        assert.ok(isWithin(active, notice), '焦点应进入弹窗子树');
        assert.equal(active, byName(harness.panel, 'personalization-modal-close'), '应聚焦弹窗内首个可聚焦元素（标题栏关闭按钮）');
    } finally {
        dialogController.dispose();
        harness.panel.remove();
        miniDom.document.activeElement = null;
    }
});

test('注入 dialogController 后：Escape 经控制器关闭弹窗、复位开关并礼貌回焦 opener', async () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const dialogController = createDialogController({ documentRef: miniDom.document });
    const harness = buildHarness(store, { view: 'personalization', dialogController });
    miniDom.document.body.appendChild(harness.panel);
    try {
        const toggle = byName(harness.panel, 'personalization-enabled');
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));
        const notice = personalizationNotice(harness.panel);
        assert.equal(notice.hidden, false);

        const handled = dialogController.handleKeydown(keyEvent('Escape'));
        assert.equal(handled, true);
        assert.equal(notice.hidden, true);
        assert.equal(toggle.checked, true, 'Escape 关闭后开关应复位为开启');
        assert.equal(dialogController.hasOpenDialog(), false, '弹窗应已从控制器栈弹出');
        assert.equal(miniDom.document.activeElement, toggle, '关闭后焦点应礼貌回到 opener 复选框');
        assert.equal(store.snapshot().personalization.enabled, true, 'Escape 只关闭说明，不改变设置');
    } finally {
        dialogController.dispose();
        harness.panel.remove();
        miniDom.document.activeElement = null;
    }
});

test('注入 dialogController 后：按钮关闭路径同样经控制器回焦，确定分支照常关闭个性化', async () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const dialogController = createDialogController({ documentRef: miniDom.document });
    const harness = buildHarness(store, { view: 'personalization', dialogController });
    miniDom.document.body.appendChild(harness.panel);
    try {
        const toggle = byName(harness.panel, 'personalization-enabled');
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));
        const notice = personalizationNotice(harness.panel);

        await click(byName(harness.panel, 'personalization-disable-cancel'));
        assert.equal(notice.hidden, true);
        assert.equal(toggle.checked, true);
        assert.equal(dialogController.hasOpenDialog(), false);
        assert.equal(miniDom.document.activeElement, toggle, '按钮关闭同样回焦 opener');
        assert.equal(store.snapshot().personalization.enabled, true);

        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));
        assert.equal(dialogController.hasOpenDialog(), true);
        await click(byName(harness.panel, 'personalization-disable-confirm'));
        assert.equal(dialogController.hasOpenDialog(), false, '确定分支也应把弹窗移出控制器栈');
        assert.equal(store.snapshot().personalization.enabled, false);
        assert.equal(harness.rerenders, 1, '确定成功后仍触发重建');
    } finally {
        dialogController.dispose();
        harness.panel.remove();
        miniDom.document.activeElement = null;
    }
});

test('不传 dialogController 时旧行为不回归：hidden 切换打开与关闭仍工作', async () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const harness = buildHarness(store, { view: 'personalization' });
    const toggle = byName(harness.panel, 'personalization-enabled');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    const notice = personalizationNotice(harness.panel);
    assert.equal(notice.hidden, false);
    assert.equal(toggle.checked, true);

    await click(byName(harness.panel, 'personalization-modal-close'));
    assert.equal(notice.hidden, true);
    assert.equal(toggle.checked, true);
    assert.equal(store.snapshot().personalization.enabled, true);

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    assert.equal(notice.hidden, false);
    await click(byName(harness.panel, 'personalization-disable-cancel'));
    assert.equal(notice.hidden, true);
    assert.equal(toggle.checked, true);
});

test('preference 子视图只查看并保存当前 contentMode 的独立关键词词库', async () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    store.setPersonalizationKeywordWeights('NSFW', [{ keyword: '成年人话题', weight: 2 }]);
    const { panel } = buildHarness(store, { view: 'preference', contentMode: 'SFW' });
    const editor = panel.querySelectorAll('section').find((node) => node.getAttribute('aria-label') === '个性化内容偏好编辑器');
    assert.ok(editor);
    assert.equal(editor.hidden, false);
    assert.equal(panel.querySelector('[name="personalization-preference-entry"]'), null);
    assert.equal(panel.querySelector('[name="personalization-enabled"]'), null, '偏好次级页不得重复渲染管理开关。');
    assert.match(panel.textContent, /仅编辑 SFW 词库；另一模式不受影响/u);
    assert.equal(panel.textContent.includes('成年人话题'), false, 'SFW 编辑器不得显示 NSFW 词库。');

    byName(panel, 'personalization-keyword').value = '电影';
    byName(panel, 'personalization-keyword-weight').value = '4';
    await click(byName(panel, 'personalization-keyword-upsert'));
    await click(byName(panel, 'personalization-preference-save'));
    assert.deepEqual(store.snapshot().personalization.keywordWeightsByMode.SFW, [{ keyword: '电影', weight: 4 }]);
    assert.deepEqual(store.snapshot().personalization.keywordWeightsByMode.NSFW, [{ keyword: '成年人话题', weight: 2 }]);

    const reopenedSfw = buildHarness(store, { view: 'preference', contentMode: 'SFW' }).panel;
    assert.match(reopenedSfw.textContent, /电影 · 权重 4/u);
    assert.equal(reopenedSfw.textContent.includes('成年人话题'), false);
    assert.equal(reopenedSfw.textContent.includes('真实推荐算法未改变'), false);
    assert.match(reopenedSfw.textContent, /正权重提高相关标签概率/u);

    const reopenedNsfw = buildHarness(store, { view: 'preference', contentMode: 'NSFW' }).panel;
    assert.match(reopenedNsfw.textContent, /仅编辑 NSFW 词库；另一模式不受影响/u);
    assert.match(reopenedNsfw.textContent, /成年人话题 · 权重 2/u);
    assert.equal(reopenedNsfw.textContent.includes('电影 · 权重 4'), false);
});

test('生图设置只保存非机密配置，API Key 清空后留在独立浏览器缓存', async () => {
    const keyStorage = createMemoryStorage();
    const settingsStorage = createMemoryStorage();
    configurePersistentKeyStorage(keyStorage);
    const { panel, store, feedback, navigations } = buildHarness(createSettingsStore({ storage: settingsStorage }), { view: 'image_generation' });
    assert.match(panel.textContent, /前置 → core_dna → outfit_dna → AI 场景 → 后置/u);
    const clientMode = byName(panel, 'image-generation-client-mode');
    assert.equal(clientMode.tagName, 'SELECT');
    assert.equal(clientMode.value, 'browser');
    assert.deepEqual(clientMode.childNodes.map((option) => [option.value, option.textContent]), [['browser', '浏览器端'], ['sillytavern', '酒馆后端']]);
    await click(button(panel, '查看图片缓存'));
    assert.deepEqual(navigations, ['settings_image_cache']);

    byAria(panel, '启用生图接口').checked = true;
    byName(panel, 'image-generation-preset-id').value = 'image_preset';
    byAria(panel, 'NAI API Key').value = 'image-browser-cache-secret';
    await click(button(panel, '保存 NAI API Key'));
    assert.equal(byAria(panel, 'NAI API Key').value, '');
    assert.equal(requireSessionKey('image_preset'), 'image-browser-cache-secret');

    clientMode.value = 'sillytavern';
    clientMode.dispatchEvent(new Event('change'));
    assert.equal(store.snapshot().imageGeneration.clientMode, 'sillytavern', '切换后必须立即写入当前设置快照。');
    assert.equal(createSettingsStore({ storage: settingsStorage }).snapshot().imageGeneration.clientMode, 'sillytavern', '切换后必须立即写入浏览器存储，而不是等待保存生图设置。');
    assert.equal(byAria(panel, 'NAI API Key').parentNode.parentNode.hidden, false);
    assert.equal(byAria(panel, 'OpenAI-compatible API Key').parentNode.parentNode.hidden, false);
    assert.equal(byName(panel, 'image-generation-preset-id').disabled, false);
    assert.equal(byAria(panel, '生图站点').disabled, true);
    assert.equal(byAria(panel, '生图接口路径').disabled, true);
    assert.equal(byAria(panel, 'OpenAI 生图密钥预设 ID').disabled, false);
    assert.equal(byAria(panel, 'OpenAI 生图站点').disabled, false);
    assert.equal(byAria(panel, 'OpenAI 生图接口路径').disabled, false);
    clientMode.value = 'browser';
    clientMode.dispatchEvent(new Event('change'));
    assert.equal(byName(panel, 'image-generation-preset-id').disabled, false);
    assert.equal(byAria(panel, 'OpenAI 生图站点').disabled, false);
    clientMode.value = 'sillytavern';
    clientMode.dispatchEvent(new Event('change'));

    byAria(panel, '前置正面提示词').value = 'masterpiece';
    byAria(panel, '后置正面提示词').value = 'cinematic light';
    byAria(panel, '固定负面提示词').value = 'lowres';
    byName(panel, 'image-generation-api-mode').value = 'comfyui';
    byAria(panel, 'ComfyUI API 工作流 JSON').value = '{\n  "1": {"class_type": "SaveImage", "inputs": {}}\n}';
    await click(button(panel, '保存生图设置'));

    assert.equal(store.snapshot().imageGeneration.enabled, true);
    assert.equal(store.snapshot().imageGeneration.clientMode, 'sillytavern');
    assert.equal(store.snapshot().imageGeneration.presetId, 'image_preset');
    assert.equal(store.snapshot().imageGeneration.positivePrefix, 'masterpiece');
    assert.equal(store.snapshot().imageGeneration.positiveSuffix, 'cinematic light');
    assert.equal(store.snapshot().imageGeneration.apiMode, 'comfyui');
    assert.match(store.snapshot().imageGeneration.comfyWorkflow, /SaveImage/u);
    assert.equal(store.exportJson().includes('image-browser-cache-secret'), false);
    assert.ok(feedback.some((message) => message.includes('NAI API Key 已保存到当前浏览器')));
});

test('载入 NAI 整体预设时只即时保存客户端模式', () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const image = store.getImageGenerationSettings();
    store.setImageGenerationSettings({
        ...image,
        clientMode: 'browser',
        promptPresets: {
            ...image.promptPresets,
            novelai: [{
                id: 'host-nai-preset', name: '酒馆 NAI', positivePrefix: 'preset prefix', positiveSuffix: '', negativePrompt: '',
                clientMode: 'sillytavern', presetId: 'nai-host', baseUrl: image.baseUrl, endpointPath: image.endpointPath,
                model: image.model, sampler: image.sampler, noiseSchedule: image.noiseSchedule,
                guidance: image.guidance, guidanceRescale: image.guidanceRescale, width: image.width, height: image.height,
                steps: image.steps, seed: image.seed, qualityToggle: image.qualityToggle, variety: image.variety,
            }],
        },
        activePromptPresetIds: { ...image.activePromptPresetIds, novelai: null },
    });
    const { panel } = buildHarness(store, { view: 'image_generation' });
    const picker = byName(panel, 'image-prompt-preset-novelai');
    picker.value = 'host-nai-preset';
    picker.dispatchEvent(new Event('change'));

    assert.equal(store.snapshot().imageGeneration.clientMode, 'sillytavern');
    assert.equal(byName(panel, 'image-generation-client-mode').value, 'sillytavern');
    assert.equal(byAria(panel, '生图站点').disabled, true, 'NAI 酒馆模式必须立即反映固定宿主路由限制。');
    assert.equal(byAria(panel, '前置正面提示词').value, 'preset prefix');
});

test('客户端即时持久化失败时回退到最近一次成功保存的模式', () => {
    const backingStore = createSettingsStore({ storage: createMemoryStorage() });
    let allowWrites = true;
    const store = {
        ...backingStore,
        setImageGenerationSettings(next) {
            if (!allowWrites) throw new Error('storage unavailable');
            return backingStore.setImageGenerationSettings(next);
        },
    };
    const { panel } = buildHarness(store, { view: 'image_generation' });
    const clientMode = byName(panel, 'image-generation-client-mode');
    clientMode.value = 'sillytavern';
    clientMode.dispatchEvent(new Event('change'));
    assert.equal(backingStore.snapshot().imageGeneration.clientMode, 'sillytavern');

    allowWrites = false;
    clientMode.value = 'browser';
    clientMode.dispatchEvent(new Event('change'));
    assert.equal(clientMode.value, 'sillytavern');
    assert.equal(backingStore.snapshot().imageGeneration.clientMode, 'sillytavern');
});
test('生图供应商按钮显示三个独立面板并分别保存 NAI、OpenAI 与 ComfyUI 参数', async () => {
    configurePersistentKeyStorage(createMemoryStorage());
    const imageGenerationClient = {
        async fetchComfyUIResources({ baseUrl }) {
            assert.equal(baseUrl, 'http://127.0.0.1:8188');
            return {
                models: ['portrait.safetensors'],
                samplers: ['euler', 'dpmpp_2m'],
                schedulers: ['normal', 'karras'],
                vae: ['vae.safetensors'],
                clips: ['clip-l.safetensors'],
            };
        },
    };
    const { panel, store, feedback } = buildHarness(createSettingsStore({ storage: createMemoryStorage() }), {
        view: 'image_generation',
        imageGenerationClient,
    });
    const naiPanel = panel.querySelectorAll('.yl-image-provider-panel').find((node) => node.getAttribute('id') === 'yl-novelai-provider-panel');
    const openaiPanel = panel.querySelectorAll('.yl-image-provider-panel').find((node) => node.getAttribute('id') === 'yl-openai-provider-panel');
    const comfyPanel = panel.querySelectorAll('.yl-image-provider-panel').find((node) => node.getAttribute('id') === 'yl-comfyui-provider-panel');
    const naiTab = byName(panel, 'image-provider-novelai');
    const openaiTab = byName(panel, 'image-provider-openai');
    const comfyTab = byName(panel, 'image-provider-comfyui');
    assert.equal(naiTab.getAttribute('aria-selected'), 'true');
    assert.equal(naiPanel.hidden, false);
    assert.equal(openaiPanel.hidden, true);
    assert.equal(comfyPanel.hidden, true);
    assert.match(naiPanel.textContent, /NAI 专属配置/u);
    assert.equal(byName(panel, 'image-generation-sampler').tagName, 'SELECT');
    assert.equal(byName(panel, 'image-generation-noise-schedule').tagName, 'SELECT');
    assert.deepEqual(byName(panel, 'image-generation-sampler').childNodes.map((option) => option.textContent), ['Euler Ancestral', 'Euler', 'DPM++ 2M', 'DPM++ 2M SDE', 'DPM++ 2S Ancestral', 'DPM2', 'DPM Fast', 'DDIM']);
    assert.deepEqual(byName(panel, 'image-generation-noise-schedule').childNodes.map((option) => option.textContent), ['Karras', 'Exponential', 'Polyexponential', 'Sine', 'Linear', 'Cosine', 'Beta']);
    assert.equal(isWithin(byAria(panel, 'NAI API Key'), naiPanel), true);
    assert.equal(isWithin(byAria(panel, 'OpenAI-compatible API Key'), openaiPanel), true);

    await click(openaiTab);
    assert.equal(openaiTab.getAttribute('aria-selected'), 'true');
    assert.equal(naiPanel.hidden, true);
    assert.equal(openaiPanel.hidden, false);
    assert.match(openaiPanel.textContent, /OpenAI-compatible 专属配置/u);
    byAria(panel, 'OpenAI 前置正面提示词').value = 'OpenAI natural language prefix';
    byAria(panel, 'OpenAI 固定负面提示词').value = 'Avoid text.';
    byAria(panel, 'OpenAI 生图站点').value = 'https://openai-images.example.invalid';
    byAria(panel, 'OpenAI 生图模型').value = 'gpt-image-test';
    byAria(panel, 'OpenAI 图片宽度').value = '1536';
    byAria(panel, 'OpenAI 图片高度').value = '1024';
    byAria(panel, 'OpenAI-compatible API Key').value = 'openai-only-secret';
    await click(button(panel, '保存 OpenAI-compatible API Key'));
    assert.equal(requireSessionKey('image_generation_openai'), 'openai-only-secret');
    assert.throws(() => requireSessionKey('image_generation_default'));

    await click(comfyTab);
    assert.equal(comfyTab.getAttribute('aria-selected'), 'true');
    assert.equal(naiPanel.hidden, true);
    assert.equal(openaiPanel.hidden, true);
    assert.equal(comfyPanel.hidden, false);
    assert.equal(byName(panel, 'image-generation-api-mode').value, 'comfyui');

    byAria(panel, 'ComfyUI 前置正面提示词').value = 'comfy prefix';
    byAria(panel, 'ComfyUI 固定负面提示词').value = 'comfy negative';
    await click(button(panel, '连接并刷新 ComfyUI 数据'));
    assert.equal(byAria(panel, 'ComfyUI 模型').value, 'portrait.safetensors');
    assert.ok(feedback.some((message) => message.includes('ComfyUI 数据已刷新')));
    await click(button(panel, '保存生图设置'));

    const saved = store.snapshot().imageGeneration;
    assert.equal(saved.apiMode, 'comfyui');
    assert.equal(saved.comfyModel, 'portrait.safetensors');
    assert.equal(saved.comfyPositivePrefix, 'comfy prefix');
    assert.equal(saved.comfyNegativePrompt, 'comfy negative');
    assert.equal(saved.baseUrl, 'https://image.novelai.net', 'NAI 连接必须保持独立');
    assert.equal(saved.positivePrefix, '', 'NAI 提示词必须保持独立');
    assert.equal(saved.openaiPositivePrefix, 'OpenAI natural language prefix');
    assert.equal(saved.openaiNegativePrompt, 'Avoid text.');
    assert.equal(saved.openaiBaseUrl, 'https://openai-images.example.invalid');
    assert.equal(saved.openaiModel, 'gpt-image-test');
    assert.equal(saved.openaiWidth, 1536);
    assert.equal(saved.openaiHeight, 1024);
    assert.equal(saved.width, 1024, 'NAI 尺寸必须保持独立');
    assert.equal(store.exportJson().includes('openai-only-secret'), false);

    const keyboard = keyEvent('ArrowLeft');
    comfyTab.dispatchEvent(keyboard);
    assert.equal(keyboard.defaultPrevented, true);
    assert.equal(byName(panel, 'image-provider-openai').getAttribute('aria-selected'), 'true');
});

test('NAI 整体预设与 OpenAI、ComfyUI 提示词预设可添加、载入、删除及导入导出', async () => {
    configurePersistentKeyStorage(createMemoryStorage());
    const { panel, store, feedback } = buildHarness(createSettingsStore({ storage: createMemoryStorage() }), { view: 'image_generation' });
    const providerPanel = (id) => panel.querySelectorAll('.yl-image-provider-panel').find((node) => node.getAttribute('id') === id);
    const naiPanel = providerPanel('yl-novelai-provider-panel');
    const openaiPanel = providerPanel('yl-openai-provider-panel');
    const comfyPanel = providerPanel('yl-comfyui-provider-panel');

    assert.match(naiPanel.textContent, /NAI 整体预设/u);
    byAria(naiPanel, 'NAI 提示词预设名称').value = 'NAI 人像';
    byName(panel, 'image-generation-client-mode').value = 'sillytavern';
    byName(panel, 'image-generation-preset-id').value = 'nai_preset_slot';
    byAria(panel, '生图站点').value = 'https://nai-preset.example.invalid';
    byAria(panel, '生图接口路径').value = '/ai/generate-image';
    byAria(panel, '生图模型').value = 'nai-test-model';
    byName(panel, 'image-generation-sampler').value = 'k_dpmpp_2m_sde';
    byName(panel, 'image-generation-noise-schedule').value = 'polyexponential';
    byAria(panel, 'Guidance').value = '6.5';
    byAria(panel, 'Guidance Rescale').value = '0.2';
    byAria(panel, '图片宽度').value = '832';
    byAria(panel, '图片高度').value = '1216';
    byAria(panel, '步数').value = '32';
    byAria(panel, '种子').value = '42';
    byAria(panel, '质量标签').checked = false;
    byAria(panel, '随机性').checked = true;
    byAria(naiPanel, '前置正面提示词').value = 'nai only prefix';
    await click(button(naiPanel, '添加为新预设'));

    await click(byName(panel, 'image-provider-openai'));
    byAria(openaiPanel, 'OpenAI-compatible 提示词预设名称').value = 'OpenAI 写真';
    byAria(openaiPanel, 'OpenAI 前置正面提示词').value = 'openai only prefix';
    await click(button(openaiPanel, '添加为新预设'));

    await click(byName(panel, 'image-provider-comfyui'));
    byAria(comfyPanel, 'ComfyUI 提示词预设名称').value = 'Comfy 场景';
    byAria(comfyPanel, 'ComfyUI 前置正面提示词').value = 'comfy only prefix';
    await click(button(comfyPanel, '添加为新预设'));

    let saved = store.snapshot().imageGeneration;
    assert.deepEqual(saved.promptPresets.novelai.map((item) => item.name), ['NAI 人像']);
    assert.deepEqual(saved.promptPresets.openai_compatible.map((item) => item.name), ['OpenAI 写真']);
    assert.deepEqual(saved.promptPresets.comfyui.map((item) => item.name), ['Comfy 场景']);
    assert.deepEqual(saved.promptPresets.novelai[0], {
        id: saved.promptPresets.novelai[0].id, name: 'NAI 人像',
        positivePrefix: 'nai only prefix', positiveSuffix: '', negativePrompt: '',
        clientMode: 'sillytavern', presetId: 'nai_preset_slot', baseUrl: 'https://nai-preset.example.invalid', endpointPath: '/ai/generate-image',
        model: 'nai-test-model', sampler: 'k_dpmpp_2m_sde', noiseSchedule: 'polyexponential',
        guidance: 6.5, guidanceRescale: 0.2, width: 832, height: 1216, steps: 32, seed: 42, qualityToggle: false, variety: true,
    });
    const reopened = buildHarness(store, { view: 'image_generation' }).panel;
    assert.equal(byName(reopened, 'image-generation-client-mode').value, 'sillytavern');
    assert.equal(byName(reopened, 'image-generation-preset-id').disabled, false, '载入酒馆后端 NAI 整体预设后，必须可读取该预设对应的浏览器 Key。');
    assert.equal(byName(reopened, 'image-generation-preset-id').value, 'nai_preset_slot');
    assert.equal(byAria(reopened, '生图站点').value, 'https://nai-preset.example.invalid');
    assert.equal(byName(reopened, 'image-generation-sampler').value, 'k_dpmpp_2m_sde');
    assert.equal(byName(reopened, 'image-generation-noise-schedule').value, 'polyexponential');
    assert.equal(byAria(reopened, '图片宽度').value, '832');
    assert.equal(byAria(reopened, '图片高度').value, '1216');
    assert.equal(byAria(reopened, '固定负面提示词').value, '');

    await click(button(naiPanel, '导出此接口预设'));
    const naiTransfer = byAria(naiPanel, 'NAI 提示词预设导入导出 JSON');
    const naiBundle = JSON.parse(naiTransfer.value);
    assert.equal(naiBundle.provider, 'novelai');
    assert.equal(naiBundle.presets[0].positivePrefix, 'nai only prefix');
    assert.equal(naiBundle.presets[0].clientMode, 'sillytavern');
    assert.equal(naiBundle.presets[0].presetId, 'nai_preset_slot');
    assert.equal(naiBundle.presets[0].sampler, 'k_dpmpp_2m_sde');
    assert.equal(naiBundle.presets[0].noiseSchedule, 'polyexponential');
    assert.equal(naiBundle.presets[0].width, 832);
    assert.equal(naiBundle.presets[0].height, 1216);
    assert.doesNotMatch(naiTransfer.value, /apiKey|token|authorization|not-a-real-key/iu);
    assert.doesNotMatch(naiTransfer.value, /openai only prefix|comfy only prefix|apiKey/iu);

    await click(button(openaiPanel, '删除当前预设'));
    saved = store.snapshot().imageGeneration;
    assert.equal(saved.promptPresets.openai_compatible.length, 0);
    assert.equal(saved.promptPresets.novelai.length, 1);
    assert.equal(saved.promptPresets.comfyui.length, 1);

    naiTransfer.value = JSON.stringify({
        schema: 'yuelema.image-prompt-preset-bundle',
        schemaVersion: 1,
        provider: 'comfyui',
        presets: [],
    });
    await click(button(naiPanel, '导入并覆盖此接口预设'));
    assert.equal(store.snapshot().imageGeneration.promptPresets.novelai.length, 1, '错接口图包不得覆盖 NAI 预设');
    assert.ok(feedback.some((message) => message.includes('接口归属不匹配')));
});

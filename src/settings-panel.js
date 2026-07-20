import { append, element, listen } from './dom.js';
import { FUNCTION_KEYS, YueLeMaSettingsError } from './settings/settings-store.js';
import { unlockSessionKey } from './llm/session-key-store.js';
import { toPublicLlmError } from './llm/openai-compatible-client.js';

const FUNCTION_LABELS = Object.freeze({
    chat: '私聊',
    character_ai_completion: '角色 AI 补全',
    character_full_authoring: '角色完整创作',
    soul_match: '灵魂匹配',
    text_match: '文字匹配',
    recommendation_refresh: '推荐刷新',
    group_chat: '聊天群',
    forum: '论坛',
});
const LEGACY_FUNCTION_KEYS = new Set(['character_authoring']);
const PROMPT_BUNDLE_SCHEMA = 'yuelema.prompt-preset-bundle';
const PROMPT_BUNDLE_VERSION = 1;
const PROMPT_ENTRY_ENVELOPE = 'yuelema.prompt-entries';
const PROMPT_ENTRY_ENVELOPE_VERSION = 1;
const PROMPT_POSITIONS = new Set(['before_character_definition', 'after_character_definition']);
const MAX_PROMPT_ENTRIES_PER_PRESET = 48;
const MAX_PROMPT_BUNDLE_BYTES = 512 * 1024;
const PERSONALIZATION_NOTICE = Object.freeze([
    '1.个性化内容推荐功能\n个性化内容推荐是指我们基于收集的信息，向您进行定制化内容的展现，如向您展现或推荐相关程度更高的视频内容、线下活动、信息流等。',
    '2.我不喜欢推荐的内容怎么办?\n您有权自行控制和决策是否使用个性化内容推荐功能：\n1)当您对我们基于个性化内容推荐策略推送的具体信息不感兴趣或希望减少某类信息推荐时，您可以长按该内容，选择「不感兴趣」，我们会基于您的反馈调整策略。\n2)如果您不希望被推荐个性化的内容，可通过本页设置关闭“个性化内容推荐”。',
    '3.关闭个性化内容推荐的效果是什么?\n当您选择关闭个性化内容推荐后，您将无法享受个性化内容推荐服务，我们会基于内容热度等非个性化因素向您展示内容，您可能会看到您不感兴趣甚至不喜欢的内容，您的使用体验可能会受到影响。\n个性化推荐将生效当前设备。',
]);

function normalizeSettingsView(value) {
    const aliases = new Map([
        ['connection', 'connection'], ['connections', 'connection'], ['settings_connections', 'connection'],
        ['prompt', 'prompt'], ['prompts', 'prompt'], ['settings_prompts', 'prompt'],
        ['personalization', 'personalization'], ['privacy', 'personalization'], ['settings_personalization', 'personalization'],
        ['preference', 'preference'], ['preferences', 'preference'], ['personalization_preference', 'preference'],
        ['all', 'all'],
    ]);
    return aliases.get(value ?? 'all') ?? 'all';
}

function nextId(prefix) {
    const random = globalThis.crypto?.getRandomValues
        ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0].toString(36)
        : Math.random().toString(36).slice(2, 10);
    return `${prefix}_${Date.now().toString(36)}_${random}`.slice(0, 96);
}

function safeErrorMessage(error, fallback) {
    if (error instanceof YueLeMaSettingsError) return error.message;
    return fallback;
}

function field(label, control) {
    const wrapper = element('label', { className: 'yl-settings-field' });
    wrapper.appendChild(element('span', { text: label }));
    wrapper.appendChild(control);
    return wrapper;
}

/** Wraps a checkbox in a styling shell so CSS can render an iOS-style toggle; the input keeps its name and behavior. */
function switchShell(input) {
    const shell = element('span', { className: 'yl-switch' });
    shell.appendChild(input);
    return shell;
}

/** Section title row with a decorative unicode glyph slot for the section icon. */
function sectionHeading(icon, title) {
    const heading = element('div', { className: 'yl-section-heading' });
    const glyph = element('span', { className: 'yl-section-icon', text: icon });
    glyph.setAttribute('aria-hidden', 'true');
    append(heading, [glyph, element('h2', { text: title })]);
    return heading;
}

function selectWithOptions(options, value, ariaLabel, name) {
    const select = element('select', { className: 'yl-settings-control', ariaLabel, name });
    for (const option of options) {
        const item = element('option', { text: option.label, value: option.value });
        if (option.value === value) item.selected = true;
        select.appendChild(item);
    }
    return select;
}

function presetPicker(options, value, ariaLabel, name) {
    const select = selectWithOptions(options, value, ariaLabel, name);
    // Native select provides the requested scrollable preset chooser without custom HTML.
    select.size = Math.min(Math.max(options.length, 1), 6);
    return select;
}

function numberValue(control, fallback) {
    const parsed = Number(control.value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function actionButton(label, handler, signal, { disabled = false, secondary = false, danger = false, name } = {}) {
    const classes = ['yl-settings-button'];
    if (secondary) classes.push('yl-settings-button-secondary');
    if (danger) classes.push('yl-button-danger');
    else if (secondary) classes.push('yl-button-ghost');
    const button = element('button', {
        className: classes.join(' '),
        type: 'button', text: label, ariaLabel: label, disabled, name,
    });
    listen(button, button, 'click', () => { void handler(); }, signal);
    return button;
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function cleanEntryText(value, label, maximum) {
    if (typeof value !== 'string') throw new YueLeMaSettingsError('INVALID_PROMPT_ENTRY', `${label}必须是文本。`);
    const cleaned = value.trim();
    if (cleaned.length < 1 || cleaned.length > maximum || /[\u0000-\u001F\u007F]/u.test(cleaned)) {
        throw new YueLeMaSettingsError('INVALID_PROMPT_ENTRY', `${label}长度或字符不符合要求。`);
    }
    return cleaned;
}

function cleanEntryInteger(value, label, minimum, maximum) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new YueLeMaSettingsError('INVALID_PROMPT_ENTRY', `${label}必须是 ${minimum}–${maximum} 范围内的整数。`);
    }
    return value;
}

function normalizePromptEntry(input, fallbackId = nextId('prompt_entry')) {
    if (!isPlainObject(input)) throw new YueLeMaSettingsError('INVALID_PROMPT_ENTRY', '提示词条目必须是对象。');
    const id = typeof input.id === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(input.id) ? input.id : fallbackId;
    const position = cleanEntryText(input.position, 'position', 64);
    if (!PROMPT_POSITIONS.has(position)) {
        throw new YueLeMaSettingsError('INVALID_PROMPT_ENTRY', 'position 仅支持 before_character_definition 或 after_character_definition。');
    }
    if (typeof input.enabled !== 'boolean') throw new YueLeMaSettingsError('INVALID_PROMPT_ENTRY', 'enabled 必须为布尔值。');
    return {
        id,
        name: cleanEntryText(input.name, '条目名称', 80),
        depth: cleanEntryInteger(input.depth, 'depth', 0, 1000),
        order: cleanEntryInteger(input.order, 'order', -1000, 1000),
        position,
        enabled: input.enabled,
        content: cleanEntryText(input.content, '条目正文', 10_000),
    };
}

function decodePromptEntries(preset) {
    const legacy = () => [normalizePromptEntry({
        id: nextId('prompt_entry'), name: preset.name, depth: preset.depth, order: preset.order,
        position: preset.position, enabled: preset.enabled, content: preset.content,
    })];
    try {
        const parsed = JSON.parse(preset.content);
        if (!isPlainObject(parsed) || parsed.schema !== PROMPT_ENTRY_ENVELOPE || parsed.schemaVersion !== PROMPT_ENTRY_ENVELOPE_VERSION) return legacy();
        if (!Array.isArray(parsed.entries) || parsed.entries.length === 0 || parsed.entries.length > MAX_PROMPT_ENTRIES_PER_PRESET) {
            throw new YueLeMaSettingsError('INVALID_PROMPT_ENTRY', '提示词预设条目数量无效。');
        }
        const entries = parsed.entries.map((entry) => normalizePromptEntry(entry));
        if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
            throw new YueLeMaSettingsError('INVALID_PROMPT_ENTRY', '提示词条目 ID 不可重复。');
        }
        return entries;
    } catch (error) {
        if (error instanceof YueLeMaSettingsError) throw error;
        return legacy();
    }
}

function buildPromptPreset({ id, name, entries }) {
    const presetName = cleanEntryText(name, '提示词预设名称', 80);
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_PROMPT_ENTRIES_PER_PRESET) {
        throw new YueLeMaSettingsError('INVALID_PROMPT_ENTRY', '每个提示词预设必须包含 1–48 个条目。');
    }
    const normalizedEntries = entries.map((entry) => normalizePromptEntry(entry));
    if (new Set(normalizedEntries.map((entry) => entry.id)).size !== normalizedEntries.length) {
        throw new YueLeMaSettingsError('INVALID_PROMPT_ENTRY', '提示词条目 ID 不可重复。');
    }
    const content = JSON.stringify({
        schema: PROMPT_ENTRY_ENVELOPE,
        schemaVersion: PROMPT_ENTRY_ENVELOPE_VERSION,
        entries: normalizedEntries,
    });
    if (new TextEncoder().encode(content).byteLength > 12_000) {
        throw new YueLeMaSettingsError('SETTINGS_TOO_LARGE', '提示词条目合计超过当前安全存储上限。');
    }
    const representative = normalizedEntries[0];
    return {
        id,
        name: presetName,
        // The v1 store remains strict. These representative fields keep it valid while
        // content losslessly carries the multi-entry prompt collection.
        depth: representative.depth,
        order: representative.order,
        position: representative.position,
        enabled: representative.enabled,
        content,
    };
}

function promptSummary(preset) {
    try {
        const entries = decodePromptEntries(preset);
        const enabled = entries.filter((entry) => entry.enabled).length;
        return `${preset.name} · ${entries.length} 个条目 · ${enabled} 个启用`;
    } catch {
        return `${preset.name} · 条目数据损坏`;
    }
}

function buildPromptBundle(snapshot) {
    return JSON.stringify({
        schema: PROMPT_BUNDLE_SCHEMA,
        schemaVersion: PROMPT_BUNDLE_VERSION,
        promptPresets: snapshot.promptPresets,
    });
}

function readPromptBundle(rawJson) {
    if (typeof rawJson !== 'string' || new TextEncoder().encode(rawJson).byteLength > MAX_PROMPT_BUNDLE_BYTES) {
        throw new YueLeMaSettingsError('SETTINGS_TOO_LARGE', '提示词预设导入文件超过允许的大小限制。');
    }
    let parsed;
    try {
        parsed = JSON.parse(rawJson);
    } catch {
        throw new YueLeMaSettingsError('INVALID_IMPORT_JSON', '导入文件不是有效 JSON。');
    }
    if (!isPlainObject(parsed) || Object.keys(parsed).some((key) => !['schema', 'schemaVersion', 'promptPresets'].includes(key))) {
        throw new YueLeMaSettingsError('INVALID_IMPORT_JSON', '提示词预设导入文件字段无效。');
    }
    if (parsed.schema !== PROMPT_BUNDLE_SCHEMA || parsed.schemaVersion !== PROMPT_BUNDLE_VERSION || !Array.isArray(parsed.promptPresets)) {
        throw new YueLeMaSettingsError('INVALID_IMPORT_JSON', '提示词预设导入文件版本不受支持。');
    }
    return parsed.promptPresets;
}

/**
 * Builds the settings console. Only non-secret settings cross the persistence boundary.
 * The API Key input is consumed once by unlockSessionKey and immediately cleared.
 */
export function buildSettingsPanel({ settingsStore, llmClient, signal, onFeedback, onRerender, onNavigate, section, view }) {
    const panel = element('section', { className: 'yl-settings-panel' });
    const activeView = normalizeSettingsView(view ?? section);
    const navigate = typeof onNavigate === 'function' ? onNavigate : () => {};
    let settings;
    try {
        settings = settingsStore.snapshot();
    } catch {
        panel.appendChild(element('p', {
            className: 'yl-phone-placeholder',
            text: '本地设置无法读取。可清除本扩展的非机密设置后重新建立；API Key 不会被清除，因为它本未被保存。',
        }));
        panel.appendChild(actionButton('清除损坏的非机密设置', async () => {
            settingsStore.clear();
            onFeedback('已清除本扩展的非机密设置；本次会话 API Key 从未写入本地。');
            onRerender();
        }, signal, { danger: true }));
        return panel;
    }

    if (activeView === 'all') {
        append(panel, [
            element('h2', { text: '本地设置' }),
            element('p', {
                className: 'yl-phone-page-description',
                text: '连接、提示词和个性化内容推荐设置仅保存在当前浏览器；API Key 只在本次扩展会话解锁。',
            }),
            buildConnectionSection(settings),
            buildPromptSection(settings),
            buildBindingSection(settings),
            buildPromptTransferSection(settings),
            buildPersonalizationSection(settings, { openPreferences: false, includePreferenceEntry: true }),
        ]);
    } else if (activeView === 'connection') {
        panel.appendChild(buildConnectionSection(settings));
    } else if (activeView === 'prompt') {
        append(panel, [buildPromptSection(settings), buildPromptTransferSection(settings)]);
    } else {
        panel.appendChild(buildPersonalizationSection(settings, {
            openPreferences: activeView === 'preference',
            includePreferenceEntry: activeView !== 'preference',
        }));
    }
    return panel;

    function updateSettings(operation, success) {
        try {
            operation();
            onFeedback(success);
            onRerender();
        } catch (error) {
            onFeedback(safeErrorMessage(error, '设置未保存；请检查必填字段与数值范围。'));
        }
    }

    function buildConnectionSection(snapshot) {
        const section = element('section', { className: 'yl-settings-section' });
        append(section, [
            sectionHeading('⚡', '连接预设（OpenAI-compatible）'),
            element('p', { className: 'yl-phone-page-description', text: '先填写名称、Base URL 与本次会话 API Key，即可直接拉取模型；Model 不再是拉取列表的前置条件。API Key 只用于本次会话，不会保存。' }),
        ]);
        let activeId = null;
        let draftId = nextId('conn');
        const picker = presetPicker([
            { label: '选择一个已保存连接预设…', value: '' },
            ...snapshot.connectionPresets.map((preset) => ({ label: preset.name, value: preset.id })),
        ], '', '已保存连接预设', 'connection-preset-picker');
        section.appendChild(field('已保存连接预设', picker));

        const name = element('input', { className: 'yl-settings-control', type: 'text', name: 'connection-name', placeholder: '例如：快速模型', maxLength: 80, ariaLabel: '连接预设名称' });
        const url = element('input', { className: 'yl-settings-control', type: 'url', name: 'connection-url', placeholder: 'https://example.com/v1', maxLength: 500, ariaLabel: 'API URL' });
        const model = element('input', { className: 'yl-settings-control', type: 'text', name: 'connection-model', placeholder: '可先留空，拉取后选择', maxLength: 200, ariaLabel: '模型名称' });
        const transportMode = selectWithOptions([
            { label: '普通响应（JSON）', value: 'json' },
            { label: '流式传输（SSE）', value: 'stream' },
            { label: '假流式显示（完整返回后渐显）', value: 'pseudo_stream' },
        ], 'stream', '传输模式', 'connection-transport-mode');
        transportMode.value = 'stream';
        const temperature = element('input', { className: 'yl-settings-control', type: 'number', name: 'connection-temperature', value: '0.7', min: 0, max: 2, ariaLabel: '温度' });
        const maxTokens = element('input', { className: 'yl-settings-control', type: 'number', name: 'connection-max-tokens', value: '800', min: 1, max: 16384, ariaLabel: '最大 Token' });
        const timeoutMs = element('input', { className: 'yl-settings-control', type: 'number', name: 'connection-timeout', value: '60000', min: 1000, max: 120000, ariaLabel: '超时毫秒' });
        const apiKey = element('input', { className: 'yl-settings-control', type: 'password', name: 'connection-api-key', placeholder: '仅本次会话解锁', autocomplete: 'off', maxLength: 2048, ariaLabel: 'API Key，仅本次会话' });
        const fields = element('div', { className: 'yl-settings-fields' });
        append(fields, [
            field('名称', name), field('Base URL', url), field('Model（可稍后拉取）', model), field('传输模式', transportMode),
            field('Temperature', temperature), field('Max tokens', maxTokens), field('Timeout (ms)', timeoutMs), field('API Key（不保存）', apiKey),
        ]);
        section.appendChild(fields);
        section.appendChild(element('p', { className: 'yl-settings-summary yl-transport-hint', text: '真流式可边接收边聚合，降低长回复在单次 JSON 解析阶段中断的风险；假流式兼容不支持 SSE 的接口，在完整响应到达后分段呈现。最终仍受服务端最大输出与本地超时限制。' }));

        const modelChoices = element('select', { className: 'yl-settings-control yl-model-choices', name: 'connection-model-choices', ariaLabel: '已拉取模型', hidden: true });
        listen(modelChoices, modelChoices, 'change', () => {
            if (!modelChoices.value) return;
            model.value = modelChoices.value;
            onFeedback(`已选择模型“${modelChoices.value}”；保存连接预设后生效。`);
        }, signal);
        section.appendChild(field('接口返回的模型', modelChoices));

        function resetConnectionDraft() {
            activeId = null;
            draftId = nextId('conn');
            picker.value = '';
            name.value = '';
            url.value = '';
            model.value = '';
            transportMode.value = 'stream';
            temperature.value = '0.7';
            maxTokens.value = '800';
            timeoutMs.value = '60000';
            apiKey.value = '';
            modelChoices.hidden = true;
            modelChoices.replaceChildren();
        }
        function loadConnectionPreset(preset) {
            activeId = preset.id;
            picker.value = preset.id;
            name.value = preset.name;
            url.value = preset.url;
            model.value = preset.model;
            transportMode.value = preset.transportMode ?? 'json';
            temperature.value = String(preset.temperature);
            maxTokens.value = String(preset.maxTokens);
            timeoutMs.value = String(preset.timeoutMs);
            apiKey.value = '';
            modelChoices.hidden = true;
        }
        listen(picker, picker, 'change', () => {
            const preset = snapshot.connectionPresets.find((item) => item.id === picker.value);
            if (preset) {
                loadConnectionPreset(preset);
                onFeedback(`已载入“${preset.name}”；API Key 仍需本次会话单独解锁。`);
            }
        }, signal);
        const formPreset = () => ({
            id: activeId ?? draftId, name: name.value, url: url.value, model: model.value,
            transportMode: transportMode.value,
            temperature: numberValue(temperature, 0.7), maxTokens: numberValue(maxTokens, 800), timeoutMs: numberValue(timeoutMs, 60_000),
        });
        const controls = element('div', { className: 'yl-settings-actions' });
        controls.appendChild(actionButton('新建连接预设', async () => {
            resetConnectionDraft();
            onFeedback('已新建空白连接预设；Model 可先留空并直接拉取列表。');
        }, signal, { secondary: true }));
        controls.appendChild(actionButton('保存连接预设', async () => {
            const candidate = formPreset();
            updateSettings(() => {
                if (activeId) settingsStore.editConnectionPreset(candidate);
                else settingsStore.addConnectionPreset(candidate);
            }, '连接预设已保存；API Key 未写入本地。');
        }, signal));
        controls.appendChild(actionButton('删除当前连接预设', async () => {
            if (!activeId) {
                onFeedback('请先从已保存连接预设列表选择一个项目。');
                return;
            }
            updateSettings(() => settingsStore.deleteConnectionPreset(activeId), '连接预设已删除，同时已清理相关绑定。');
        }, signal, { secondary: true, danger: true }));
        const fetchModelsButton = actionButton('解锁并拉取模型列表', async () => {
            if (!llmClient) { onFeedback('当前浏览器未提供可用网络 transport，无法拉取模型。'); return; }
            const originalText = fetchModelsButton.textContent;
            fetchModelsButton.disabled = true;
            fetchModelsButton.textContent = '正在拉取模型…';
            try {
                const candidate = formPreset();
                if (!String(candidate.name ?? '').trim()) candidate.name = '未保存连接';
                unlockSessionKey(candidate.id, apiKey.value);
                apiKey.value = '';
                onFeedback('已解锁本次会话，正在从 /models 拉取模型列表…');
                const models = await llmClient.fetchModels({ preset: candidate });
                modelChoices.replaceChildren();
                modelChoices.appendChild(element('option', { text: '请选择模型…', value: '' }));
                for (const item of models) modelChoices.appendChild(element('option', { text: item, value: item }));
                modelChoices.hidden = false;
                if (!model.value && models.length === 1) {
                    modelChoices.value = models[0];
                    model.value = models[0];
                }
                onFeedback(`已取得 ${models.length} 个模型；请选择模型并保存连接预设。`);
            } catch (error) {
                apiKey.value = '';
                onFeedback(toPublicLlmError(error).message);
            } finally {
                fetchModelsButton.disabled = false;
                fetchModelsButton.textContent = originalText;
            }
        }, signal, { secondary: true, name: 'connection-fetch-models' });
        controls.appendChild(fetchModelsButton);
        section.appendChild(controls);
        return section;
    }
    function buildPromptSection(snapshot) {
        const section = element('section', { className: 'yl-settings-section yl-prompt-workbench' });
        append(section, [
            sectionHeading('⌘', '提示词预设条目树'),
            element('p', { className: 'yl-phone-page-description', text: '预设作为根节点，插入位置作为分支，每个提示词条目作为叶节点。点击叶节点即可编辑；启用状态、depth 与 order 会在树上直接显示。' }),
        ]);
        let activeId = null;
        let entries = [];
        let editingEntryId = null;
        const picker = presetPicker([
            { label: '选择一个已保存提示词预设…', value: '' },
            ...snapshot.promptPresets.map((preset) => ({ label: promptSummary(preset), value: preset.id })),
        ], '', '已保存提示词预设', 'prompt-preset-picker');
        section.appendChild(field('已保存提示词预设', picker));
        const name = element('input', { className: 'yl-settings-control', type: 'text', name: 'prompt-preset-name', placeholder: '例如：推荐刷新', maxLength: 80, ariaLabel: '提示词预设名称' });
        section.appendChild(field('预设名称', name));

        const tree = element('div', { className: 'yl-prompt-tree', ariaLabel: '提示词条目树' });
        tree.setAttribute('role', 'tree');
        section.appendChild(tree);

        const editor = element('section', { className: 'yl-prompt-entry-editor' });
        const editorHeading = element('div', { className: 'yl-prompt-editor-heading' });
        const editorTitle = element('h3', { text: '新条目编辑器' });
        const editorState = element('span', { className: 'yl-prompt-editor-state', text: '尚未选择树节点' });
        append(editorHeading, [editorTitle, editorState]);
        editor.appendChild(editorHeading);
        const entryName = element('input', { className: 'yl-settings-control', type: 'text', name: 'prompt-entry-name', placeholder: '例如：公开资料约束', maxLength: 80, ariaLabel: '提示词条目名称' });
        const depth = element('input', { className: 'yl-settings-control', type: 'number', name: 'prompt-entry-depth', value: '4', min: 0, max: 1000, ariaLabel: '提示词深度' });
        const order = element('input', { className: 'yl-settings-control', type: 'number', name: 'prompt-entry-order', value: '100', min: -1000, max: 1000, ariaLabel: '提示词顺序' });
        const position = selectWithOptions([
            { label: '角色定义之前', value: 'before_character_definition' },
            { label: '角色定义之后', value: 'after_character_definition' },
        ], 'before_character_definition', '提示词位置', 'prompt-entry-position');
        position.value = 'before_character_definition';
        const enabled = element('input', { className: 'yl-settings-checkbox', type: 'checkbox', name: 'prompt-entry-enabled', checked: true, ariaLabel: '启用提示词条目' });
        const content = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 10, name: 'prompt-entry-content', placeholder: '输入提示词正文', maxLength: 10_000, ariaLabel: '提示词条目正文' });
        const fields = element('div', { className: 'yl-settings-fields' });
        append(fields, [
            field('条目名称', entryName), field('Depth', depth), field('Order', order), field('Position', position), field('Enabled', switchShell(enabled)), field('提示词正文', content),
        ]);
        editor.appendChild(fields);
        section.appendChild(editor);

        function currentEntry() {
            return normalizePromptEntry({
                id: editingEntryId ?? nextId('prompt_entry'), name: entryName.value, depth: numberValue(depth, 4),
                order: numberValue(order, 100), position: position.value, enabled: enabled.checked, content: content.value,
            });
        }
        function loadEntry(entry) {
            editingEntryId = entry.id;
            entryName.value = entry.name;
            depth.value = String(entry.depth);
            order.value = String(entry.order);
            position.value = entry.position;
            enabled.checked = entry.enabled;
            content.value = entry.content;
            editorTitle.textContent = `编辑：${entry.name}`;
            editorState.textContent = `${entry.enabled ? '已启用' : '已禁用'} · depth ${entry.depth} · order ${entry.order}`;
            renderTree();
        }
        function clearEntryDraft() {
            editingEntryId = null;
            entryName.value = '';
            depth.value = '4';
            order.value = '100';
            position.value = 'before_character_definition';
            enabled.checked = true;
            content.value = '';
            editorTitle.textContent = '新条目编辑器';
            editorState.textContent = '填写后加入当前预设草稿';
            renderTree();
        }
        function treeIconButton(label, text, handler, disabled = false) {
            const button = element('button', { className: 'yl-prompt-tree-action', type: 'button', ariaLabel: label, text, disabled });
            listen(button, button, 'click', handler, signal);
            return button;
        }
        function renderTreeBranch(positionValue, label) {
            const branchEntries = entries
                .map((entry, index) => ({ entry, index }))
                .filter(({ entry }) => entry.position === positionValue)
                .sort((left, right) => left.entry.order - right.entry.order || left.index - right.index);
            const branch = element('section', { className: 'yl-prompt-tree-branch' });
            branch.setAttribute('role', 'group');
            const branchHeading = element('div', { className: 'yl-prompt-tree-branch-heading' });
            append(branchHeading, [
                element('span', { className: 'yl-prompt-tree-node-dot', text: '◆' }),
                element('strong', { text: label }),
                element('span', { className: 'yl-prompt-tree-count', text: `${branchEntries.length} 个条目` }),
            ]);
            branch.appendChild(branchHeading);
            const children = element('div', { className: 'yl-prompt-tree-children' });
            if (branchEntries.length === 0) children.appendChild(element('p', { className: 'yl-prompt-tree-empty', text: '此分支暂无条目' }));
            for (const { entry, index } of branchEntries) {
                const leaf = element('article', { className: `yl-prompt-tree-leaf${editingEntryId === entry.id ? ' is-active' : ''}${entry.enabled ? '' : ' is-disabled'}` });
                leaf.setAttribute('role', 'treeitem');
                leaf.setAttribute('aria-selected', String(editingEntryId === entry.id));
                const main = element('button', { className: 'yl-prompt-tree-main', type: 'button', ariaLabel: `编辑提示词条目 ${entry.name}` });
                const copy = element('span', { className: 'yl-prompt-tree-copy' });
                append(copy, [
                    element('strong', { text: entry.name }),
                    element('span', { text: `depth ${entry.depth} · order ${entry.order}` }),
                    element('span', { className: 'yl-prompt-tree-preview', text: entry.content.replace(/\s+/gu, ' ').slice(0, 72) || '（空正文）' }),
                ]);
                append(main, [element('span', { className: 'yl-prompt-tree-leaf-dot', text: entry.enabled ? '●' : '○' }), copy]);
                listen(main, main, 'click', () => {
                    loadEntry(entry);
                    onFeedback(`正在编辑条目“${entry.name}”。`);
                }, signal);
                const actions = element('div', { className: 'yl-prompt-tree-leaf-actions' });
                const toggle = element('input', { className: 'yl-settings-checkbox', type: 'checkbox', checked: entry.enabled, ariaLabel: `${entry.name}启用状态` });
                listen(toggle, toggle, 'change', () => {
                    entries = entries.map((item) => item.id === entry.id ? { ...item, enabled: toggle.checked } : item);
                    if (editingEntryId === entry.id) enabled.checked = toggle.checked;
                    renderTree();
                    onFeedback(`条目“${entry.name}”已在当前草稿中${toggle.checked ? '启用' : '禁用'}；保存预设后生效。`);
                }, signal);
                actions.appendChild(switchShell(toggle));
                actions.appendChild(treeIconButton(`上移条目 ${entry.name}`, '↑', () => {
                    if (index <= 0) return;
                    const next = [...entries];
                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                    entries = next;
                    renderTree();
                }, index <= 0));
                actions.appendChild(treeIconButton(`下移条目 ${entry.name}`, '↓', () => {
                    if (index >= entries.length - 1) return;
                    const next = [...entries];
                    [next[index + 1], next[index]] = [next[index], next[index + 1]];
                    entries = next;
                    renderTree();
                }, index >= entries.length - 1));
                append(leaf, [main, actions]);
                children.appendChild(leaf);
            }
            branch.appendChild(children);
            return branch;
        }
        function renderTree() {
            tree.replaceChildren();
            const rootNode = element('section', { className: 'yl-prompt-tree-root' });
            rootNode.setAttribute('role', 'treeitem');
            rootNode.setAttribute('aria-expanded', 'true');
            const rootHeading = element('div', { className: 'yl-prompt-tree-root-heading' });
            append(rootHeading, [
                element('span', { className: 'yl-prompt-tree-root-icon', text: '⌘' }),
                element('div', { className: 'yl-prompt-tree-root-copy', text: name.value.trim() || '未命名提示词预设' }),
                element('span', { className: 'yl-prompt-tree-count', text: `${entries.length} 个条目 · ${entries.filter((entry) => entry.enabled).length} 个启用` }),
            ]);
            rootNode.appendChild(rootHeading);
            const branches = element('div', { className: 'yl-prompt-tree-branches' });
            branches.appendChild(renderTreeBranch('before_character_definition', '角色定义之前'));
            branches.appendChild(renderTreeBranch('after_character_definition', '角色定义之后'));
            rootNode.appendChild(branches);
            tree.appendChild(rootNode);
        }
        function resetPromptDraft() {
            activeId = null;
            picker.value = '';
            name.value = '';
            entries = [];
            clearEntryDraft();
        }
        function loadPromptPreset(preset) {
            activeId = preset.id;
            picker.value = preset.id;
            name.value = preset.name;
            entries = decodePromptEntries(preset);
            clearEntryDraft();
        }
        listen(name, name, 'input', renderTree, signal);
        listen(picker, picker, 'change', () => {
            const preset = snapshot.promptPresets.find((item) => item.id === picker.value);
            if (!preset) return;
            try {
                loadPromptPreset(preset);
                onFeedback(`已载入“${preset.name}”，请从条目树选择叶节点编辑。`);
            } catch (error) {
                onFeedback(safeErrorMessage(error, '此提示词预设无法安全载入。'));
            }
        }, signal);
        renderTree();

        const entryControls = element('div', { className: 'yl-settings-actions yl-prompt-entry-actions' });
        entryControls.appendChild(actionButton('添加条目', async () => {
            try {
                const candidate = currentEntry();
                if (entries.some((entry) => entry.id === candidate.id)) {
                    onFeedback('当前条目已在树中；请使用“保存条目修改”。');
                    return;
                }
                if (entries.length >= MAX_PROMPT_ENTRIES_PER_PRESET) {
                    onFeedback('一个提示词预设最多 48 个条目。');
                    return;
                }
                entries = [...entries, candidate];
                clearEntryDraft();
                onFeedback('提示词条目已加入条目树；点击“保存提示词预设”后才会写入本地。');
            } catch (error) {
                onFeedback(safeErrorMessage(error, '提示词条目未加入；请检查字段。'));
            }
        }, signal));
        entryControls.appendChild(actionButton('保存条目修改', async () => {
            try {
                if (!editingEntryId) {
                    onFeedback('请先从条目树选择一个叶节点。');
                    return;
                }
                const candidate = currentEntry();
                entries = entries.map((entry) => entry.id === editingEntryId ? candidate : entry);
                loadEntry(candidate);
                onFeedback('条目修改已保留在当前树草稿；请保存提示词预设。');
            } catch (error) {
                onFeedback(safeErrorMessage(error, '提示词条目未修改；请检查字段。'));
            }
        }, signal, { secondary: true }));
        entryControls.appendChild(actionButton('新建空白条目', async () => {
            clearEntryDraft();
            onFeedback('已切换到新条目编辑器。');
        }, signal, { secondary: true }));
        entryControls.appendChild(actionButton('删除当前条目', async () => {
            if (!editingEntryId) {
                onFeedback('请先从条目树选择一个叶节点。');
                return;
            }
            entries = entries.filter((entry) => entry.id !== editingEntryId);
            clearEntryDraft();
            onFeedback('条目已从当前树草稿删除；请保存提示词预设。');
        }, signal, { secondary: true, danger: true }));
        section.appendChild(entryControls);

        const controls = element('div', { className: 'yl-settings-actions' });
        controls.appendChild(actionButton('新建提示词预设', async () => {
            resetPromptDraft();
            onFeedback('已新建空白提示词预设；先在编辑器中添加至少一个条目。');
        }, signal, { secondary: true }));
        controls.appendChild(actionButton('保存提示词预设', async () => updateSettings(() => {
            const candidate = buildPromptPreset({ id: activeId ?? nextId('prompt'), name: name.value, entries });
            if (activeId) settingsStore.editPromptPreset(candidate);
            else settingsStore.addPromptPreset(candidate);
        }, '提示词预设及条目树已保存。'), signal));
        controls.appendChild(actionButton('删除当前提示词预设', async () => {
            if (!activeId) {
                onFeedback('请先从已保存提示词预设列表选择一个项目。');
                return;
            }
            updateSettings(() => settingsStore.deletePromptPreset(activeId), '提示词预设已删除，同时已清理相关绑定。');
        }, signal, { secondary: true, danger: true }));
        section.appendChild(controls);
        return section;
    }
    function buildPersonalizationSection(snapshot, { openPreferences, includePreferenceEntry }) {
        const section = element('section', { className: 'yl-settings-section' });
        append(section, [
            sectionHeading('✦', openPreferences ? '个性化内容偏好' : '个性化内容推荐管理'),
            element('p', {
                className: 'yl-phone-page-description',
                text: '此处仅保存当前设备上的讽刺展示设置与关键词权重，不会改变真实推荐、排序、模型调用或 MVU 数据。',
            }),
        ]);

        const personalization = snapshot.personalization ?? { enabled: true, keywordWeights: [] };
        const enabled = element('input', {
            className: 'yl-settings-checkbox', type: 'checkbox', checked: personalization.enabled,
            name: 'personalization-enabled', ariaLabel: '个性化内容推荐',
        });
        section.appendChild(field('个性化内容推荐', switchShell(enabled)));

        if (includePreferenceEntry) {
            const preferenceEntry = actionButton('个性化内容偏好', async () => {
                if (!enabled.checked) return;
                navigate('settings_personalization_preference');
            }, signal, {
                disabled: !personalization.enabled,
                secondary: true,
                name: 'personalization-preference-entry',
            });
            section.appendChild(preferenceEntry);
        }

        const preferenceEditor = element('section', {
            className: 'yl-settings-binding',
            hidden: !personalization.enabled || !openPreferences,
        });
        preferenceEditor.setAttribute('aria-label', '个性化内容偏好编辑器');
        let keywordWeights = personalization.keywordWeights.map((item) => ({ ...item }));
        let editingIndex = -1;
        const list = element('div', { className: 'yl-settings-list' });
        const keyword = element('input', {
            className: 'yl-settings-control', type: 'text', name: 'personalization-keyword',
            placeholder: '例如：电影', maxLength: 40, ariaLabel: '个性化偏好关键词',
        });
        const weight = element('input', {
            className: 'yl-settings-control', type: 'number', name: 'personalization-keyword-weight',
            value: '1', min: -5, max: 5, ariaLabel: '个性化偏好关键词权重',
        });

        function clearKeywordDraft() {
            editingIndex = -1;
            keyword.value = '';
            weight.value = '1';
        }
        function keywordCandidate() {
            const cleaned = keyword.value.trim();
            const numericWeight = Number(weight.value);
            if (cleaned.length < 1 || cleaned.length > 40 || /[\u0000-\u001F\u007F]/u.test(cleaned)) {
                throw new YueLeMaSettingsError('INVALID_PERSONALIZATION', '关键词长度或字符不符合要求。');
            }
            if (!Number.isInteger(numericWeight) || numericWeight < -5 || numericWeight > 5) {
                throw new YueLeMaSettingsError('INVALID_PERSONALIZATION', '关键词权重必须是 -5–5 范围内的整数。');
            }
            const duplicateIndex = keywordWeights.findIndex((item) => item.keyword.toLowerCase() === cleaned.toLowerCase());
            if (duplicateIndex >= 0 && duplicateIndex !== editingIndex) {
                throw new YueLeMaSettingsError('INVALID_PERSONALIZATION', '该关键词已经存在。');
            }
            return { keyword: cleaned, weight: numericWeight };
        }
        function renderKeywordWeights() {
            list.replaceChildren();
            if (keywordWeights.length === 0) {
                list.appendChild(element('p', { className: 'yl-settings-summary', text: '尚未设置关键词权重。' }));
                return;
            }
            keywordWeights.forEach((item, index) => {
                const row = element('section', { className: 'yl-settings-binding' });
                row.appendChild(element('p', { className: 'yl-settings-summary', text: item.keyword + ' · 权重 ' + item.weight }));
                row.appendChild(actionButton('编辑关键词', async () => {
                    editingIndex = index;
                    keyword.value = item.keyword;
                    weight.value = String(item.weight);
                }, signal, { secondary: true }));
                row.appendChild(actionButton('删除关键词', async () => {
                    keywordWeights = keywordWeights.filter((_, itemIndex) => itemIndex !== index);
                    clearKeywordDraft();
                    renderKeywordWeights();
                }, signal, { secondary: true, danger: true }));
                list.appendChild(row);
            });
        }
        renderKeywordWeights();
        preferenceEditor.appendChild(list);
        const fields = element('div', { className: 'yl-settings-fields' });
        append(fields, [field('关键词', keyword), field('权重（-5 到 5）', weight)]);
        preferenceEditor.appendChild(fields);
        const preferenceActions = element('div', { className: 'yl-settings-actions' });
        preferenceActions.appendChild(actionButton('添加或更新关键词', async () => {
            try {
                const candidate = keywordCandidate();
                if (editingIndex >= 0) keywordWeights = keywordWeights.map((item, index) => index === editingIndex ? candidate : item);
                else keywordWeights = [...keywordWeights, candidate];
                clearKeywordDraft();
                renderKeywordWeights();
                onFeedback('关键词权重已加入当前草稿；保存后写入本地设置。');
            } catch (error) {
                onFeedback(safeErrorMessage(error, '关键词权重无效。'));
            }
        }, signal, { name: 'personalization-keyword-upsert' }));
        preferenceActions.appendChild(actionButton('保存个性化内容偏好', async () => updateSettings(
            () => settingsStore.setPersonalizationKeywordWeights(keywordWeights),
            '个性化内容偏好已保存到当前设备；真实推荐算法未改变。',
        ), signal, { name: 'personalization-preference-save' }));
        preferenceEditor.appendChild(preferenceActions);
        section.appendChild(preferenceEditor);

        const notice = element('section', { className: 'yl-settings-section yl-settings-modal', hidden: true });
        notice.setAttribute('aria-label', '个性化内容推荐说明');
        notice.setAttribute('role', 'dialog');
        notice.setAttribute('aria-modal', 'true');
        const closeNotice = () => {
            notice.hidden = true;
            enabled.checked = true;
        };
        const noticeTitlebar = element('div', { className: 'yl-dialog-titlebar' });
        const noticeClose = element('button', {
            className: 'yl-dialog-close', type: 'button', text: '×', name: 'personalization-modal-close',
            ariaLabel: '关闭个性化内容推荐说明',
        });
        append(noticeTitlebar, [element('h2', { text: '个性化内容推荐说明' }), noticeClose]);
        notice.appendChild(noticeTitlebar);
        listen(noticeClose, noticeClose, 'click', () => {
            closeNotice();
            onFeedback('已关闭说明，个性化内容推荐保持开启。');
        }, signal);
        for (const paragraph of PERSONALIZATION_NOTICE) notice.appendChild(element('p', { text: paragraph }));
        const noticeActions = element('div', { className: 'yl-settings-actions' });
        noticeActions.appendChild(actionButton('确定', async () => updateSettings(
            () => settingsStore.setPersonalizationEnabled(false),
            '个性化内容推荐已在当前设备关闭；真实推荐算法未改变。',
        ), signal, { name: 'personalization-disable-confirm' }));
        noticeActions.appendChild(actionButton('保持开启并关闭', async () => {
            closeNotice();
            onFeedback('已取消关闭，个性化内容推荐保持开启。');
        }, signal, { secondary: true, name: 'personalization-disable-cancel' }));
        notice.appendChild(noticeActions);
        section.appendChild(notice);

        listen(enabled, enabled, 'change', () => {
            if (enabled.checked) {
                updateSettings(() => settingsStore.setPersonalizationEnabled(true), '个性化内容推荐已在当前设备开启。');
                return;
            }
            enabled.checked = true;
            notice.hidden = false;
        }, signal);
        return section;
    }

    function buildBindingSection(snapshot) {
        const section = element('section', { className: 'yl-settings-section' });
        append(section, [
            sectionHeading('⇄', '默认预设与功能绑定'),
            element('p', {
                className: 'yl-phone-page-description',
                text: '连接与提示词可独立选择。未单独绑定的功能回退到默认预设；此处不提供标签权重设置。',
            }),
        ]);
        const connectionOptions = [
            { label: '不设置（无默认）', value: '' },
            ...snapshot.connectionPresets.map((preset) => ({ label: preset.name, value: preset.id })),
        ];
        const promptOptions = [
            { label: '不设置（无默认）', value: '' },
            ...snapshot.promptPresets.map((preset) => ({ label: preset.name, value: preset.id })),
        ];
        const defaultConnection = selectWithOptions(
            connectionOptions,
            snapshot.defaults.connectionPresetId ?? '',
            '默认连接预设',
            'default-connection-preset',
        );
        const defaultPrompt = selectWithOptions(
            promptOptions,
            snapshot.defaults.promptPresetId ?? '',
            '默认提示词预设',
            'default-prompt-preset',
        );
        const defaultsFields = element('div', { className: 'yl-settings-fields' });
        append(defaultsFields, [field('默认连接', defaultConnection), field('默认提示词', defaultPrompt)]);
        section.appendChild(defaultsFields);
        section.appendChild(actionButton('保存默认预设', async () => updateSettings(() => settingsStore.setDefaults({
            connectionPresetId: defaultConnection.value || null,
            promptPresetId: defaultPrompt.value || null,
        }), '默认预设已保存。'), signal));

        for (const functionKey of FUNCTION_KEYS.filter((key) => !LEGACY_FUNCTION_KEYS.has(key))) {
            const binding = snapshot.functionBindings[functionKey];
            const row = element('section', { className: 'yl-settings-binding' });
            row.appendChild(element('strong', { text: FUNCTION_LABELS[functionKey] }));
            const connection = selectWithOptions(
                [{ label: '使用默认连接', value: '' }, ...snapshot.connectionPresets.map((preset) => ({ label: preset.name, value: preset.id }))],
                binding.connectionPresetId ?? '',
                `${FUNCTION_LABELS[functionKey]}连接预设`,
                `${functionKey}-connection-preset`,
            );
            const prompt = selectWithOptions(
                [{ label: '使用默认提示词', value: '' }, ...snapshot.promptPresets.map((preset) => ({ label: preset.name, value: preset.id }))],
                binding.promptPresetId ?? '',
                `${FUNCTION_LABELS[functionKey]}提示词预设`,
                `${functionKey}-prompt-preset`,
            );
            append(row, [field('连接', connection), field('提示词', prompt)]);
            row.appendChild(actionButton('保存此功能绑定', async () => updateSettings(() => settingsStore.bindFunction(functionKey, {
                connectionPresetId: connection.value || null,
                promptPresetId: prompt.value || null,
            }), `${FUNCTION_LABELS[functionKey]}绑定已保存。`), signal, { secondary: true }));
            section.appendChild(row);
        }
        return section;
    }

    function buildPromptTransferSection(snapshot) {
        const section = element('section', { className: 'yl-settings-section' });
        append(section, [
            sectionHeading('⇅', '提示词预设导入 / 导出'),
            element('p', { className: 'yl-phone-page-description', text: '仅导入或导出全部提示词预设；不会包含 API Key、MVU 状态、聊天或角色隐私资料。导入会清理指向已不存在提示词预设的功能绑定。' }),
        ]);
        const json = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 8, name: 'prompt-preset-transfer-json', placeholder: '点击导出生成 JSON，或粘贴提示词预设 JSON 后导入', maxLength: MAX_PROMPT_BUNDLE_BYTES, ariaLabel: '提示词预设导入导出 JSON' });
        section.appendChild(json);
        const controls = element('div', { className: 'yl-settings-actions' });
        controls.appendChild(actionButton('导出全部提示词预设 JSON', async () => {
            try {
                json.value = buildPromptBundle(snapshot);
                onFeedback('已生成提示词预设 JSON；其中不包含 API Key 或角色隐私资料。');
            } catch (error) {
                onFeedback(safeErrorMessage(error, '无法导出提示词预设。'));
            }
        }, signal));
        controls.appendChild(actionButton('导入并覆盖提示词预设', async () => updateSettings(() => {
            const promptPresets = readPromptBundle(json.value);
            const document = JSON.parse(settingsStore.exportJson());
            const availablePromptIds = new Set(promptPresets.map((preset) => preset?.id));
            document.promptPresets = promptPresets;
            if (!availablePromptIds.has(document.defaults.promptPresetId)) document.defaults.promptPresetId = null;
            for (const functionKey of FUNCTION_KEYS) {
                if (!availablePromptIds.has(document.functionBindings[functionKey].promptPresetId)) {
                    document.functionBindings[functionKey].promptPresetId = null;
                }
            }
            settingsStore.importJson(JSON.stringify(document));
        }, '提示词预设已导入；API Key 未被导入。'), signal, { secondary: true, danger: true }));
        section.appendChild(controls);
        return section;
    }
}



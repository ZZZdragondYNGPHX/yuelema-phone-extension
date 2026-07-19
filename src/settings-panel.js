import { append, element, listen } from './dom.js';
import { FUNCTION_KEYS, YueLeMaSettingsError } from './settings/settings-store.js';
import { unlockSessionKey } from './llm/session-key-store.js';
import { toPublicLlmError } from './llm/openai-compatible-client.js';

const FUNCTION_LABELS = Object.freeze({
    chat: '私聊',
    character_authoring: '角色补全 / 完整创作',
    soul_match: '灵魂匹配',
    text_match: '文字匹配',
    recommendation_refresh: '推荐刷新',
    group_chat: '聊天群',
    forum: '论坛',
});
const PROMPT_BUNDLE_SCHEMA = 'yuelema.prompt-preset-bundle';
const PROMPT_BUNDLE_VERSION = 1;
const PROMPT_ENTRY_ENVELOPE = 'yuelema.prompt-entries';
const PROMPT_ENTRY_ENVELOPE_VERSION = 1;
const PROMPT_POSITIONS = new Set(['before_character_definition', 'after_character_definition']);
const MAX_PROMPT_ENTRIES_PER_PRESET = 48;
const MAX_PROMPT_BUNDLE_BYTES = 512 * 1024;

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

function actionButton(label, handler, signal, { disabled = false, secondary = false } = {}) {
    const button = element('button', {
        className: secondary ? 'yl-settings-button yl-settings-button-secondary' : 'yl-settings-button',
        type: 'button', text: label, ariaLabel: label, disabled,
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
        // content losslessly carries the Worldbook-style entry collection.
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
export function buildSettingsPanel({ settingsStore, llmClient, signal, onFeedback, onRerender }) {
    const panel = element('section', { className: 'yl-settings-panel' });
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
        }, signal));
        return panel;
    }

    append(panel, [
        element('h2', { text: '模型、提示词与功能绑定' }),
        element('p', {
            className: 'yl-phone-page-description',
            text: '连接预设与提示词预设保存在本浏览器；API Key 只在本次扩展会话解锁，绝不保存、导出或回显。',
        }),
        buildConnectionSection(settings),
        buildPromptSection(settings),
        buildBindingSection(settings),
        buildPromptTransferSection(settings),
    ]);
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
            element('h2', { text: '连接预设（OpenAI-compatible）' }),
            element('p', { className: 'yl-phone-page-description', text: '从已保存列表按名称选择并载入编辑；新建时会自动生成内部 ID。URL 仅支持 HTTPS；localhost / 回环地址可使用 HTTP。' }),
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
        const model = element('input', { className: 'yl-settings-control', type: 'text', name: 'connection-model', placeholder: '模型名称', maxLength: 200, ariaLabel: '模型名称' });
        const temperature = element('input', { className: 'yl-settings-control', type: 'number', name: 'connection-temperature', value: '0.7', min: 0, max: 2, ariaLabel: '温度' });
        const maxTokens = element('input', { className: 'yl-settings-control', type: 'number', name: 'connection-max-tokens', value: '800', min: 1, max: 16384, ariaLabel: '最大 Token' });
        const timeoutMs = element('input', { className: 'yl-settings-control', type: 'number', name: 'connection-timeout', value: '30000', min: 1000, max: 120000, ariaLabel: '超时毫秒' });
        const apiKey = element('input', { className: 'yl-settings-control', type: 'password', name: 'connection-api-key', placeholder: '仅本次会话解锁', autocomplete: 'off', maxLength: 2048, ariaLabel: 'API Key，仅本次会话' });
        const fields = element('div', { className: 'yl-settings-fields' });
        append(fields, [
            field('名称', name), field('Base URL', url), field('Model', model), field('Temperature', temperature),
            field('Max tokens', maxTokens), field('Timeout (ms)', timeoutMs), field('API Key（不保存）', apiKey),
        ]);
        section.appendChild(fields);

        function resetConnectionDraft() {
            activeId = null;
            draftId = nextId('conn');
            picker.value = '';
            name.value = '';
            url.value = '';
            model.value = '';
            temperature.value = '0.7';
            maxTokens.value = '800';
            timeoutMs.value = '30000';
            apiKey.value = '';
        }
        function loadConnectionPreset(preset) {
            activeId = preset.id;
            picker.value = preset.id;
            name.value = preset.name;
            url.value = preset.url;
            model.value = preset.model;
            temperature.value = String(preset.temperature);
            maxTokens.value = String(preset.maxTokens);
            timeoutMs.value = String(preset.timeoutMs);
            apiKey.value = '';
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
            temperature: numberValue(temperature, 0.7), maxTokens: numberValue(maxTokens, 800), timeoutMs: numberValue(timeoutMs, 30_000),
        });
        const modelChoices = element('select', { className: 'yl-settings-control', name: 'connection-model-choices', ariaLabel: '已拉取模型', hidden: true });
        listen(modelChoices, modelChoices, 'change', () => { if (modelChoices.value) model.value = modelChoices.value; }, signal);
        section.appendChild(modelChoices);
        const controls = element('div', { className: 'yl-settings-actions' });
        controls.appendChild(actionButton('新建连接预设', async () => {
            resetConnectionDraft();
            onFeedback('已新建空白连接预设；填写后点击保存。');
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
        }, signal, { secondary: true }));
        controls.appendChild(actionButton('解锁并拉取 /models', async () => {
            if (!llmClient) { onFeedback('当前浏览器未提供可用网络 transport，无法拉取模型。'); return; }
            try {
                const candidate = formPreset();
                unlockSessionKey(candidate.id, apiKey.value);
                apiKey.value = '';
                const models = await llmClient.fetchModels({ preset: candidate });
                modelChoices.replaceChildren();
                modelChoices.appendChild(element('option', { text: '选择已拉取模型', value: '' }));
                for (const item of models) modelChoices.appendChild(element('option', { text: item, value: item }));
                modelChoices.hidden = false;
                onFeedback(`已取得 ${models.length} 个模型名称；请选择后再保存连接预设。`);
            } catch (error) {
                apiKey.value = '';
                onFeedback(toPublicLlmError(error).message);
            }
        }, signal, { secondary: true }));
        section.appendChild(controls);
        return section;
    }

    function buildPromptSection(snapshot) {
        const section = element('section', { className: 'yl-settings-section' });
        append(section, [
            element('h2', { text: '提示词预设（Worldbook 风格）' }),
            element('p', { className: 'yl-phone-page-description', text: '一个提示词预设可保存多个条目；每个条目独立设置名称、depth、order、position、enabled 与正文。旧版单条目预设载入后可直接扩展。' }),
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
        const entryList = element('div', { className: 'yl-settings-list' });
        section.appendChild(entryList);

        const entryName = element('input', { className: 'yl-settings-control', type: 'text', name: 'prompt-entry-name', placeholder: '例如：公开资料约束', maxLength: 80, ariaLabel: '提示词条目名称' });
        const depth = element('input', { className: 'yl-settings-control', type: 'number', name: 'prompt-entry-depth', value: '4', min: 0, max: 1000, ariaLabel: '提示词深度' });
        const order = element('input', { className: 'yl-settings-control', type: 'number', name: 'prompt-entry-order', value: '100', min: -1000, max: 1000, ariaLabel: '提示词顺序' });
        const position = selectWithOptions([
            { label: '角色定义之前', value: 'before_character_definition' },
            { label: '角色定义之后', value: 'after_character_definition' },
        ], 'before_character_definition', '提示词位置', 'prompt-entry-position');
        // Explicit assignment makes a fresh draft deterministic in browser and test DOM.
        position.value = 'before_character_definition';
        const enabled = element('input', { className: 'yl-settings-checkbox', type: 'checkbox', name: 'prompt-entry-enabled', checked: true, ariaLabel: '启用提示词条目' });
        const content = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 8, name: 'prompt-entry-content', placeholder: '输入提示词正文', maxLength: 10_000, ariaLabel: '提示词条目正文' });
        const fields = element('div', { className: 'yl-settings-fields' });
        append(fields, [
            field('条目名称', entryName), field('Depth', depth), field('Order', order), field('Position', position), field('Enabled', enabled), field('提示词正文', content),
        ]);
        section.appendChild(fields);

        function clearEntryDraft() {
            editingEntryId = null;
            entryName.value = '';
            depth.value = '4';
            order.value = '100';
            position.value = 'before_character_definition';
            enabled.checked = true;
            content.value = '';
        }
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
        }
        function renderEntryList() {
            entryList.replaceChildren();
            if (entries.length === 0) {
                entryList.appendChild(element('p', { className: 'yl-settings-summary', text: '尚未添加条目。先填写下方条目，再点击“添加条目”。' }));
                return;
            }
            for (const entry of entries) {
                const row = element('section', { className: 'yl-settings-binding' });
                row.appendChild(element('p', { className: 'yl-settings-summary', text: `${entry.name} · depth ${entry.depth} · order ${entry.order} · ${entry.enabled ? '启用' : '禁用'}` }));
                row.appendChild(actionButton('编辑此条目', async () => {
                    loadEntry(entry);
                    onFeedback(`正在编辑条目“${entry.name}”。`);
                }, signal, { secondary: true }));
                entryList.appendChild(row);
            }
        }
        function resetPromptDraft() {
            activeId = null;
            picker.value = '';
            name.value = '';
            entries = [];
            clearEntryDraft();
            renderEntryList();
        }
        function loadPromptPreset(preset) {
            activeId = preset.id;
            picker.value = preset.id;
            name.value = preset.name;
            entries = decodePromptEntries(preset);
            clearEntryDraft();
            renderEntryList();
        }
        listen(picker, picker, 'change', () => {
            const preset = snapshot.promptPresets.find((item) => item.id === picker.value);
            if (!preset) return;
            try {
                loadPromptPreset(preset);
                onFeedback(`已载入“${preset.name}”，可选择条目编辑后保存。`);
            } catch (error) {
                onFeedback(safeErrorMessage(error, '此提示词预设无法安全载入。'));
            }
        }, signal);
        renderEntryList();

        const entryControls = element('div', { className: 'yl-settings-actions' });
        entryControls.appendChild(actionButton('添加条目', async () => {
            try {
                const candidate = currentEntry();
                if (entries.some((entry) => entry.id === candidate.id)) {
                    onFeedback('当前条目已在列表中；请使用“保存条目修改”。');
                    return;
                }
                if (entries.length >= MAX_PROMPT_ENTRIES_PER_PRESET) {
                    onFeedback('一个提示词预设最多 48 个条目。');
                    return;
                }
                entries = [...entries, candidate];
                clearEntryDraft();
                renderEntryList();
                onFeedback('提示词条目已加入当前草稿；点击“保存提示词预设”后才会写入本地。');
            } catch (error) {
                onFeedback(safeErrorMessage(error, '提示词条目未加入；请检查字段。'));
            }
        }, signal));
        entryControls.appendChild(actionButton('保存条目修改', async () => {
            try {
                if (!editingEntryId) {
                    onFeedback('请先从条目列表选择“编辑此条目”。');
                    return;
                }
                const candidate = currentEntry();
                entries = entries.map((entry) => entry.id === editingEntryId ? candidate : entry);
                loadEntry(candidate);
                renderEntryList();
                onFeedback('条目修改已保留在当前草稿；请保存提示词预设。');
            } catch (error) {
                onFeedback(safeErrorMessage(error, '提示词条目未修改；请检查字段。'));
            }
        }, signal, { secondary: true }));
        entryControls.appendChild(actionButton('删除当前条目', async () => {
            if (!editingEntryId) {
                onFeedback('请先从条目列表选择“编辑此条目”。');
                return;
            }
            entries = entries.filter((entry) => entry.id !== editingEntryId);
            clearEntryDraft();
            renderEntryList();
            onFeedback('条目已从当前草稿删除；请保存提示词预设。');
        }, signal, { secondary: true }));
        section.appendChild(entryControls);

        const controls = element('div', { className: 'yl-settings-actions' });
        controls.appendChild(actionButton('新建提示词预设', async () => {
            resetPromptDraft();
            onFeedback('已新建空白提示词预设；先添加至少一个条目再保存。');
        }, signal, { secondary: true }));
        controls.appendChild(actionButton('保存提示词预设', async () => updateSettings(() => {
            const candidate = buildPromptPreset({ id: activeId ?? nextId('prompt'), name: name.value, entries });
            if (activeId) settingsStore.editPromptPreset(candidate);
            else settingsStore.addPromptPreset(candidate);
        }, '提示词预设已保存。'), signal));
        controls.appendChild(actionButton('删除当前提示词预设', async () => {
            if (!activeId) {
                onFeedback('请先从已保存提示词预设列表选择一个项目。');
                return;
            }
            updateSettings(() => settingsStore.deletePromptPreset(activeId), '提示词预设已删除，同时已清理相关绑定。');
        }, signal, { secondary: true }));
        section.appendChild(controls);
        return section;
    }

    function buildBindingSection(snapshot) {
        const section = element('section', { className: 'yl-settings-section' });
        append(section, [
            element('h2', { text: '默认预设与功能绑定' }),
            element('p', { className: 'yl-phone-page-description', text: '连接与提示词可独立选择。未单独绑定的功能回退到默认预设；灵魂匹配与文字匹配始终共用同一对绑定。' }),
        ]);
        const connectionOptions = [{ label: '不设置（无默认）', value: '' }, ...snapshot.connectionPresets.map((preset) => ({ label: preset.name, value: preset.id }))];
        const promptOptions = [{ label: '不设置（无默认）', value: '' }, ...snapshot.promptPresets.map((preset) => ({ label: preset.name, value: preset.id }))];
        const defaultConnection = selectWithOptions(connectionOptions, snapshot.defaults.connectionPresetId ?? '', '默认连接预设', 'default-connection-preset');
        const defaultPrompt = selectWithOptions(promptOptions, snapshot.defaults.promptPresetId ?? '', '默认提示词预设', 'default-prompt-preset');
        const defaultsFields = element('div', { className: 'yl-settings-fields' });
        append(defaultsFields, [field('默认连接', defaultConnection), field('默认提示词', defaultPrompt)]);
        section.appendChild(defaultsFields);
        section.appendChild(actionButton('保存默认预设', async () => updateSettings(() => settingsStore.setDefaults({
            connectionPresetId: defaultConnection.value || null, promptPresetId: defaultPrompt.value || null,
        }), '默认预设已保存。'), signal));

        const individualKeys = FUNCTION_KEYS.filter((key) => !['soul_match', 'text_match'].includes(key));
        for (const functionKey of individualKeys) {
            const binding = snapshot.functionBindings[functionKey];
            section.appendChild(buildFunctionBindingRow({ functionKey, binding }));
        }

        const soulBinding = snapshot.functionBindings.soul_match;
        const textBinding = snapshot.functionBindings.text_match;
        const bindingsAlreadySynced = soulBinding.connectionPresetId === textBinding.connectionPresetId
            && soulBinding.promptPresetId === textBinding.promptPresetId;
        const sharedRow = element('section', { className: 'yl-settings-binding' });
        sharedRow.appendChild(element('strong', { text: '灵魂匹配 / 文字匹配（共用）' }));
        sharedRow.appendChild(element('p', {
            className: 'yl-settings-summary',
            text: bindingsAlreadySynced ? '当前已同步；保存时会同时更新灵魂匹配与文字匹配。' : '检测到旧设置未同步；以下选择以灵魂匹配为准，保存后会自动统一。',
        }));
        const sharedConnection = selectWithOptions([{ label: '使用默认连接', value: '' }, ...snapshot.connectionPresets.map((preset) => ({ label: preset.name, value: preset.id }))], soulBinding.connectionPresetId ?? '', '灵魂匹配和文字匹配共用连接预设', 'shared-match-connection-preset');
        const sharedPrompt = selectWithOptions([{ label: '使用默认提示词', value: '' }, ...snapshot.promptPresets.map((preset) => ({ label: preset.name, value: preset.id }))], soulBinding.promptPresetId ?? '', '灵魂匹配和文字匹配共用提示词预设', 'shared-match-prompt-preset');
        append(sharedRow, [field('共用连接', sharedConnection), field('共用提示词', sharedPrompt)]);
        sharedRow.appendChild(actionButton('同步并保存匹配绑定', async () => updateSettings(() => {
            const binding = { connectionPresetId: sharedConnection.value || null, promptPresetId: sharedPrompt.value || null };
            settingsStore.bindFunction('soul_match', binding);
            settingsStore.bindFunction('text_match', binding);
        }, '灵魂匹配与文字匹配已使用同一对连接和提示词预设。'), signal, { secondary: true }));
        section.appendChild(sharedRow);
        return section;

        function buildFunctionBindingRow({ functionKey, binding }) {
            const row = element('section', { className: 'yl-settings-binding' });
            row.appendChild(element('strong', { text: FUNCTION_LABELS[functionKey] }));
            const connection = selectWithOptions([{ label: '使用默认连接', value: '' }, ...snapshot.connectionPresets.map((preset) => ({ label: preset.name, value: preset.id }))], binding.connectionPresetId ?? '', `${FUNCTION_LABELS[functionKey]}连接预设`, `${functionKey}-connection-preset`);
            const prompt = selectWithOptions([{ label: '使用默认提示词', value: '' }, ...snapshot.promptPresets.map((preset) => ({ label: preset.name, value: preset.id }))], binding.promptPresetId ?? '', `${FUNCTION_LABELS[functionKey]}提示词预设`, `${functionKey}-prompt-preset`);
            append(row, [field('连接', connection), field('提示词', prompt)]);
            row.appendChild(actionButton('保存此功能绑定', async () => updateSettings(() => settingsStore.bindFunction(functionKey, {
                connectionPresetId: connection.value || null, promptPresetId: prompt.value || null,
            }), `${FUNCTION_LABELS[functionKey]}绑定已保存。`), signal, { secondary: true }));
            return row;
        }
    }

    function buildPromptTransferSection(snapshot) {
        const section = element('section', { className: 'yl-settings-section' });
        append(section, [
            element('h2', { text: '提示词预设导入 / 导出' }),
            element('p', { className: 'yl-phone-page-description', text: '仅导入或导出全部提示词预设；不会包含连接预设、API Key、MVU 状态、聊天或角色隐私资料。导入会保留仍可用的连接绑定，并清理指向已不存在提示词预设的绑定。' }),
        ]);
        const json = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 8, name: 'prompt-preset-transfer-json', placeholder: '点击导出生成 JSON，或粘贴提示词预设 JSON 后导入', maxLength: MAX_PROMPT_BUNDLE_BYTES, ariaLabel: '提示词预设导入导出 JSON' });
        section.appendChild(json);
        const controls = element('div', { className: 'yl-settings-actions' });
        controls.appendChild(actionButton('导出全部提示词预设 JSON', async () => {
            try {
                json.value = buildPromptBundle(snapshot);
                onFeedback('已生成提示词预设 JSON；其中不包含连接预设或 API Key。');
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
        }, '提示词预设已导入；连接预设和 API Key 均未被导入。'), signal, { secondary: true }));
        section.appendChild(controls);
        return section;
    }
}




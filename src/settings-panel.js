import { append, element, listen } from './dom.js';
import { createUiIcon } from './ui/icon.js';
import { CONTENT_MODES, FUNCTION_KEYS, YueLeMaSettingsError } from './settings/settings-store.js';
import {
    deletePersistentKey,
    hasMemorySessionKey,
    hasPersistentKey,
    hasSessionKey,
    isPersistentKeyStorageAvailable,
    unlockSessionKey,
} from './llm/session-key-store.js';
import { toPublicLlmError } from './llm/openai-compatible-client.js';
import { toPublicImageGenerationError } from './llm/image-generation-client.js';

const FUNCTION_LABELS = Object.freeze({
    chat: '私聊',
    chat_summary: '对话总结',
    character_ai_completion: '角色 AI 补全',
    character_full_authoring: '角色完整创作',
    soul_match: '灵魂匹配',
    text_match: '描述匹配',
    recommendation_refresh: '推荐刷新',
    group_chat: '聊天群',
    forum: '论坛',
    image_match: '图片匹配',
    service_profile_generation: '约伴服务角色生成',
});
const CONTENT_MODE_LABELS = Object.freeze({ SFW: 'SFW', NSFW: 'NSFW' });
const PROMPT_BUNDLE_SCHEMA = 'yuelema.prompt-preset-bundle';
const PROMPT_BUNDLE_VERSION = 1;
const PROMPT_ENTRY_ENVELOPE = 'yuelema.prompt-entries';
const PROMPT_ENTRY_ENVELOPE_VERSION = 1;
const PROMPT_POSITIONS = new Set(['before_character_definition', 'after_character_definition']);
const MAX_PROMPT_ENTRIES_PER_PRESET = 48;
const MAX_PROMPT_BUNDLE_BYTES = 512 * 1024;
const DEFAULT_CONNECTION_MAX_TOKENS = 2_048;
const PERSONALIZATION_NOTICE = Object.freeze([
    '个性化推荐仅使用当前设备保存的关键词权重调整推荐，不会写入 MVU、聊天或角色资料。',
    '可长按推荐选择「不感兴趣」，或在本页关闭个性化推荐。',
    '关闭后改按非个性化因素展示，已保存的关键词不会被删除。',
]);

function normalizeSettingsView(value) {
    return new Set(['all', 'connection', 'prompt', 'personalization', 'image_generation', 'preference']).has(value)
        ? value : 'all';
}

function normalizeContentMode(value) {
    return value === 'NSFW' ? 'NSFW' : 'SFW';
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

/** Section title row: caption-level group heading with a local SVG icon (设计系统 2.0，§10.2). */
function sectionHeading(iconName, title) {
    const heading = element('div', { className: 'yl-section-heading' });
    const glyph = element('span', { className: 'yl-section-icon' });
    glyph.setAttribute('aria-hidden', 'true');
    glyph.appendChild(createUiIcon(document, iconName, { className: 'yl-section-svg', size: 18 }));
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
    // Set the control value explicitly for native and older embedded WebViews.
    select.value = value;
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

function buildPromptPreset({ id, name, contentMode, entries }) {
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
        contentMode: contentMode === 'NSFW' ? 'NSFW' : 'SFW',
        content,
    };
}

function promptSummary(preset) {
    try {
        const entries = decodePromptEntries(preset);
        const enabled = entries.filter((entry) => entry.enabled).length;
        return `${preset.name} · ${preset.contentMode === 'NSFW' ? 'NSFW' : 'SFW'} · ${entries.length} 个条目 · ${enabled} 个启用`;
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
 * Builds the settings console. Connection configuration stays export-safe, while
 * API Keys live only in the separate browser-local key cache and are never shown.
 */
export function buildSettingsPanel({ settingsStore, llmClient, imageGenerationClient = null, signal, onFeedback, onRerender, onNavigate, view, contentMode, dialogController, openDialog = null }) {
    const panel = element('section', { className: 'yl-settings-panel' });
    const activeView = normalizeSettingsView(view);
    const activeContentMode = normalizeContentMode(contentMode);
    const navigate = typeof onNavigate === 'function' ? onNavigate : () => {};
    let settings;
    try {
        settings = settingsStore.snapshot();
    } catch {
        panel.appendChild(element('p', {
            className: 'yl-phone-placeholder',
            text: '本地设置无法读取。可清除非机密设置后重建；独立浏览器缓存中的 API Key 不受影响。',
        }));
        panel.appendChild(actionButton('清除损坏的非机密设置', async () => {
            settingsStore.clear();
            onFeedback('已清除本扩展的非机密设置；独立浏览器缓存中的 API Key 未被导出或写入 MVU。');
            onRerender();
        }, signal, { danger: true }));
        return panel;
    }

    if (activeView === 'all') {
        append(panel, [
            element('h2', { text: '本地设置' }),
            element('p', {
                className: 'yl-phone-page-description',
                text: '设置仅保存在当前浏览器；API Key 位于独立缓存，不进入导出、MVU 或角色卡。',
            }),
            buildConnectionSection(settings),
            buildPromptSection(settings),
            buildBindingSection(settings, activeContentMode),
            buildPromptTransferSection(settings),
            buildPersonalizationSection(settings, { openPreferences: false, includePreferenceEntry: true }),
        ]);
    } else if (activeView === 'connection') {
        panel.appendChild(buildConnectionSection(settings));
    } else if (activeView === 'prompt') {
        append(panel, [buildPromptSection(settings), buildPromptTransferSection(settings)]);
    } else if (activeView === 'image_generation') {
        panel.appendChild(buildImageGenerationSection(settings));
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
            sectionHeading('connection', '连接预设（OpenAI-compatible）'),
            element('p', { className: 'yl-phone-page-description', text: '连接配置保存在当前浏览器；API Key 位于独立缓存，永不写入 MVU、角色卡、提示词或导出文件。可直接拉取模型列表。' }),
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
        const maxTokens = element('input', { className: 'yl-settings-control', type: 'number', name: 'connection-max-tokens', value: String(DEFAULT_CONNECTION_MAX_TOKENS), min: 1, max: 16384, ariaLabel: '最大 Token' });
        const timeoutMs = element('input', { className: 'yl-settings-control', type: 'number', name: 'connection-timeout', value: '60000', min: 1000, max: 120000, ariaLabel: '超时毫秒' });
        const apiKey = element('input', { className: 'yl-settings-control', type: 'password', name: 'connection-api-key', placeholder: '保存到当前浏览器缓存', autocomplete: 'off', maxLength: 2048, ariaLabel: 'API Key，保存到此浏览器' });
        const fields = element('div', { className: 'yl-settings-fields' });
        append(fields, [
            field('名称', name), field('Base URL', url), field('Model（可稍后拉取）', model), field('传输模式', transportMode),
            field('Temperature', temperature), field('Max tokens', maxTokens), field('Timeout (ms)', timeoutMs), field('API Key（保存到此浏览器）', apiKey),
        ]);
        section.appendChild(fields);
        const keyStatus = element('p', { className: 'yl-settings-summary', ariaLabel: 'API Key 缓存状态' });
        section.appendChild(keyStatus);
        section.appendChild(element('p', { className: 'yl-settings-summary yl-transport-hint', text: '真流式实时聚合；假流式在完整响应后分段呈现。推荐刷新至少申请 2048 Token，仍受服务端上限与本地超时限制。' }));

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
            maxTokens.value = String(DEFAULT_CONNECTION_MAX_TOKENS);
            timeoutMs.value = '60000';
            apiKey.value = '';
            modelChoices.hidden = true;
            modelChoices.replaceChildren();
            refreshKeyStatus();
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
            refreshKeyStatus();
        }
        function refreshKeyStatus() {
            const presetId = activeId ?? draftId;
            if (hasPersistentKey(presetId)) {
                keyStatus.textContent = '此浏览器：已保存 API Key；页面重开、扩展重载后会自动可用。';
            } else if (hasMemorySessionKey(presetId) || hasSessionKey(presetId)) {
                keyStatus.textContent = '本次会话：API Key 可用，但浏览器缓存不可用；页面重开后需要重新填写。';
            } else if (!isPersistentKeyStorageAvailable()) {
                keyStatus.textContent = '此浏览器的缓存不可用；填写 Key 后只能在本次会话使用。';
            } else {
                keyStatus.textContent = '此连接尚未保存 API Key。填写后点击“保存连接预设”即可保存到此浏览器。';
            }
        }
        // A saved default is already safe browser-local configuration, so load
        // it into the editor on reopen. This avoids presenting a blank form as
        // though the user must recreate the preset. The API Key input remains
        // blank even when the separate browser cache has a saved Key.
        const initialPreset = snapshot.connectionPresets.find((preset) => preset.id === snapshot.defaults.connectionPresetId);
        if (initialPreset) loadConnectionPreset(initialPreset);
        else refreshKeyStatus();
        listen(picker, picker, 'change', () => {
            const preset = snapshot.connectionPresets.find((item) => item.id === picker.value);
            if (preset) {
                loadConnectionPreset(preset);
                onFeedback(hasPersistentKey(preset.id)
                    ? `已载入“${preset.name}”；此浏览器中已保存的 API Key 会自动可用。`
                    : `已载入“${preset.name}”；尚未为此连接保存 API Key。`);
            }
        }, signal);
        const formPreset = () => ({
            id: activeId ?? draftId, name: name.value, url: url.value, model: model.value,
            transportMode: transportMode.value,
            temperature: numberValue(temperature, 0.7), maxTokens: numberValue(maxTokens, DEFAULT_CONNECTION_MAX_TOKENS), timeoutMs: numberValue(timeoutMs, 60_000),
        });
        const controls = element('div', { className: 'yl-settings-actions' });
        controls.appendChild(actionButton('新建连接预设', async () => {
            resetConnectionDraft();
            onFeedback('已新建空白连接预设；Model 可先留空并直接拉取列表。');
        }, signal, { secondary: true }));
        controls.appendChild(actionButton('保存连接预设', async () => {
            const candidate = formPreset();
            try {
                if (activeId) settingsStore.editConnectionPreset(candidate);
                else settingsStore.addConnectionPreset(candidate);
            } catch (error) {
                onFeedback(safeErrorMessage(error, '设置未保存；请检查必填字段与数值范围。'));
                return;
            }
            if (String(apiKey.value ?? '').trim()) {
                try {
                    const result = unlockSessionKey(candidate.id, apiKey.value);
                    apiKey.value = '';
                    refreshKeyStatus();
                    onFeedback(result.persisted
                        ? '连接预设已保存；API Key 已保存到当前浏览器，下次打开会自动可用。'
                        : '连接预设已保存；API Key 只能在本次会话使用，因为浏览器缓存不可用。');
                } catch (error) {
                    onFeedback(safeErrorMessage(error, '连接预设已保存，但 API Key 未能保存到当前浏览器。'));
                }
            } else {
                refreshKeyStatus();
                onFeedback(hasPersistentKey(candidate.id)
                    ? '连接预设已保存；继续使用此浏览器中已保存的 API Key。'
                    : '连接预设已保存；尚未填写 API Key。');
            }
            onRerender();
        }, signal));
        controls.appendChild(actionButton('删除当前连接预设', async () => {
            if (!activeId) {
                onFeedback('请先从已保存连接预设列表选择一个项目。');
                return;
            }
            const deletingId = activeId;
            try {
                settingsStore.deleteConnectionPreset(deletingId);
            } catch (error) {
                onFeedback(safeErrorMessage(error, '连接预设未删除。'));
                return;
            }
            deletePersistentKey(deletingId);
            onFeedback('连接预设已删除，同时已清理相关绑定和此浏览器保存的 API Key。');
            onRerender();
        }, signal, { secondary: true, danger: true }));
        controls.appendChild(actionButton('删除当前已保存 API Key', async () => {
            if (!activeId) {
                onFeedback('请先从已保存连接预设列表选择一个项目。');
                return;
            }
            const removed = deletePersistentKey(activeId);
            apiKey.value = '';
            refreshKeyStatus();
            onFeedback(removed
                ? '已删除当前连接在此浏览器保存的 API Key。'
                : '当前连接没有可删除的浏览器缓存 API Key。');
        }, signal, { secondary: true, danger: true }));
        const fetchModelsButton = actionButton('解锁并拉取模型列表', async () => {
            if (!llmClient) { onFeedback('当前浏览器未提供可用网络 transport，无法拉取模型。'); return; }
            const originalText = fetchModelsButton.textContent;
            fetchModelsButton.disabled = true;
            fetchModelsButton.textContent = '正在拉取模型…';
            try {
                const candidate = formPreset();
                if (!String(candidate.name ?? '').trim()) candidate.name = '未保存连接';
                const typedKey = String(apiKey.value ?? '').trim();
                if (typedKey) {
                    const result = unlockSessionKey(candidate.id, typedKey);
                    apiKey.value = '';
                    refreshKeyStatus();
                    onFeedback(result.persisted
                        ? 'API Key 已保存到当前浏览器，正在从 /models 拉取模型列表…'
                        : '浏览器缓存不可用，正在使用本次会话 API Key 拉取模型列表…');
                } else if (!hasSessionKey(candidate.id)) {
                    onFeedback('请先输入 API Key，或选择一个已保存 API Key 的连接预设。');
                    return;
                } else {
                    onFeedback('正在使用此浏览器已保存的 API Key 拉取模型列表…');
                }
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
            sectionHeading('prompt', '提示词预设条目树'),
            element('p', { className: 'yl-phone-page-description', text: '预设按根节点、插入位置和条目组织；SFW/NSFW 预设只出现在对应模式的绑定列表中。' }),
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
        const isNsfw = element('input', { className: 'yl-settings-checkbox', type: 'checkbox', name: 'prompt-preset-nsfw', ariaLabel: '是否为 NSFW' });
        const presetFields = element('div', { className: 'yl-settings-fields' });
        append(presetFields, [field('预设名称', name), field('是否为 NSFW', switchShell(isNsfw))]);
        section.appendChild(presetFields);

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
                element('span', { className: 'yl-prompt-tree-node-dot' }),
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
            const rootIcon = element('span', { className: 'yl-prompt-tree-root-icon' });
            rootIcon.setAttribute('aria-hidden', 'true');
            rootIcon.appendChild(createUiIcon(document, 'prompt', { className: 'yl-prompt-tree-root-svg', size: 16 }));
            append(rootHeading, [
                rootIcon,
                element('div', { className: 'yl-prompt-tree-root-copy', text: name.value.trim() || '未命名提示词预设' }),
                element('span', { className: 'yl-prompt-tree-count', text: `${isNsfw.checked ? 'NSFW' : 'SFW'} · ${entries.length} 个条目 · ${entries.filter((entry) => entry.enabled).length} 个启用` }),
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
            isNsfw.checked = false;
            entries = [];
            clearEntryDraft();
        }
        function loadPromptPreset(preset) {
            activeId = preset.id;
            picker.value = preset.id;
            name.value = preset.name;
            isNsfw.checked = preset.contentMode === 'NSFW';
            entries = decodePromptEntries(preset);
            clearEntryDraft();
        }
        listen(name, name, 'input', renderTree, signal);
        listen(isNsfw, isNsfw, 'change', renderTree, signal);
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
            const candidate = buildPromptPreset({
                id: activeId ?? nextId('prompt'), name: name.value,
                contentMode: isNsfw.checked ? 'NSFW' : 'SFW', entries,
            });
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

    function buildImageGenerationSection(snapshot) {
        const section = element('section', { className: 'yl-settings-section yl-image-generation-settings' });
        const image = snapshot.imageGeneration ?? settingsStore.getImageGenerationSettings();
        append(section, [
            sectionHeading('sparkle', '生图设置'),
            element('p', {
                className: 'yl-phone-page-description',
                text: '生图只读取非机密配置与独立浏览器 Key；API Key 不会写入设置、MVU、提示词或导出文件。',
            }),
        ]);
        section.appendChild(actionButton('查看图片缓存', async () => {
            onNavigate?.('settings_image_cache');
        }, signal, { secondary: true, name: 'image-generation-cache-open' }));

        const enabled = element('input', { className: 'yl-settings-checkbox', type: 'checkbox', checked: image.enabled, name: 'image-generation-enabled', ariaLabel: '启用生图接口' });
        section.appendChild(field('启用生图接口', switchShell(enabled)));

        const apiMode = element('input', { type: 'hidden', name: 'image-generation-api-mode', value: image.apiMode });
        section.appendChild(apiMode);
        const providerTabs = element('div', { className: 'yl-image-provider-tabs' });
        providerTabs.setAttribute('role', 'tablist');
        providerTabs.setAttribute('aria-label', '生图接口模式');
        const providerButtons = new Map();
        for (const provider of [
            { id: 'novelai', label: 'NAI' },
            { id: 'openai_compatible', label: 'OpenAI' },
            { id: 'comfyui', label: 'ComfyUI' },
        ]) {
            const button = element('button', {
                className: 'yl-image-provider-tab',
                id: `yl-image-provider-tab-${provider.id}`,
                type: 'button',
                text: provider.label,
                name: `image-provider-${provider.id.replace('_compatible', '')}`,
                ariaLabel: `${provider.label} 专属配置`,
            });
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-controls', `yl-${provider.id.replace('_compatible', '')}-provider-panel`);
            providerButtons.set(provider.id, button);
            providerTabs.appendChild(button);
        }
        section.appendChild(providerTabs);

        const presetId = element('input', { className: 'yl-settings-control', type: 'text', name: 'image-generation-preset-id', value: image.presetId, maxLength: 96, ariaLabel: '生图密钥预设 ID' });
        const naiApiKey = element('input', { className: 'yl-settings-control', type: 'password', name: 'image-generation-nai-api-key', autocomplete: 'off', maxLength: 4096, placeholder: '输入后仅保存到当前浏览器', ariaLabel: 'NAI API Key' });
        const naiKeyStatus = element('p', { className: 'yl-image-generation-key-status' });
        const baseUrl = element('input', { className: 'yl-settings-control', type: 'url', name: 'image-generation-base-url', value: image.baseUrl, maxLength: 512, ariaLabel: '生图站点' });
        const endpointPath = element('input', { className: 'yl-settings-control', type: 'text', name: 'image-generation-endpoint-path', value: image.endpointPath, maxLength: 256, ariaLabel: '生图接口路径' });
        const model = element('input', { className: 'yl-settings-control', type: 'text', name: 'image-generation-model', value: image.model, maxLength: 160, ariaLabel: '生图模型' });
        const sampler = element('input', { className: 'yl-settings-control', type: 'text', name: 'image-generation-sampler', value: image.sampler, maxLength: 80, ariaLabel: '采样器' });
        const noiseSchedule = element('input', { className: 'yl-settings-control', type: 'text', name: 'image-generation-noise-schedule', value: image.noiseSchedule, maxLength: 80, ariaLabel: '噪点表' });
        const guidance = element('input', { className: 'yl-settings-control', type: 'number', name: 'image-generation-guidance', value: String(image.guidance), min: 0, max: 30, ariaLabel: 'Guidance' });
        const guidanceRescale = element('input', { className: 'yl-settings-control', type: 'number', name: 'image-generation-guidance-rescale', value: String(image.guidanceRescale), min: 0, max: 1, ariaLabel: 'Guidance Rescale' });
        const width = element('input', { className: 'yl-settings-control', type: 'number', name: 'image-generation-width', value: String(image.width), min: 256, max: 2048, ariaLabel: '图片宽度' });
        const height = element('input', { className: 'yl-settings-control', type: 'number', name: 'image-generation-height', value: String(image.height), min: 256, max: 2048, ariaLabel: '图片高度' });
        const steps = element('input', { className: 'yl-settings-control', type: 'number', name: 'image-generation-steps', value: String(image.steps), min: 1, max: 100, ariaLabel: '步数' });
        const seed = element('input', { className: 'yl-settings-control', type: 'number', name: 'image-generation-seed', value: String(image.seed), min: 0, max: 4294967295, ariaLabel: '种子' });
        const qualityToggle = element('input', { className: 'yl-settings-checkbox', type: 'checkbox', checked: image.qualityToggle, name: 'image-generation-quality-toggle', ariaLabel: '质量标签' });
        const variety = element('input', { className: 'yl-settings-checkbox', type: 'checkbox', checked: image.variety, name: 'image-generation-variety', ariaLabel: '随机性' });
        const positivePrefix = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 3, name: 'image-generation-positive-prefix', value: image.positivePrefix, maxLength: 4000, ariaLabel: '前置正面提示词' });
        const positiveSuffix = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 3, name: 'image-generation-positive-suffix', value: image.positiveSuffix, maxLength: 4000, ariaLabel: '后置正面提示词' });
        const negativePrompt = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 3, name: 'image-generation-negative-prompt', value: image.negativePrompt, maxLength: 4000, ariaLabel: '固定负面提示词' });
        const openaiPositivePrefix = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 3, name: 'image-generation-openai-positive-prefix', value: image.openaiPositivePrefix, maxLength: 4000, ariaLabel: 'OpenAI 前置正面提示词' });
        const openaiPositiveSuffix = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 3, name: 'image-generation-openai-positive-suffix', value: image.openaiPositiveSuffix, maxLength: 4000, ariaLabel: 'OpenAI 后置正面提示词' });
        const openaiNegativePrompt = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 3, name: 'image-generation-openai-negative-prompt', value: image.openaiNegativePrompt, maxLength: 4000, ariaLabel: 'OpenAI 固定负面提示词' });
        const openaiPresetId = element('input', { className: 'yl-settings-control', type: 'text', name: 'image-generation-openai-preset-id', value: image.openaiPresetId, maxLength: 96, ariaLabel: 'OpenAI 生图密钥预设 ID' });
        const openaiBaseUrl = element('input', { className: 'yl-settings-control', type: 'url', name: 'image-generation-openai-base-url', value: image.openaiBaseUrl, maxLength: 512, ariaLabel: 'OpenAI 生图站点' });
        const openaiEndpointPath = element('input', { className: 'yl-settings-control', type: 'text', name: 'image-generation-openai-endpoint-path', value: image.openaiEndpointPath, maxLength: 256, ariaLabel: 'OpenAI 生图接口路径' });
        const openaiModel = element('input', { className: 'yl-settings-control', type: 'text', name: 'image-generation-openai-model', value: image.openaiModel, maxLength: 160, ariaLabel: 'OpenAI 生图模型' });
        const openaiWidth = element('input', { className: 'yl-settings-control', type: 'number', name: 'image-generation-openai-width', value: String(image.openaiWidth), min: 256, max: 2048, ariaLabel: 'OpenAI 图片宽度' });
        const openaiHeight = element('input', { className: 'yl-settings-control', type: 'number', name: 'image-generation-openai-height', value: String(image.openaiHeight), min: 256, max: 2048, ariaLabel: 'OpenAI 图片高度' });
        const openaiApiKey = element('input', { className: 'yl-settings-control', type: 'password', name: 'image-generation-openai-api-key', autocomplete: 'off', maxLength: 4096, placeholder: '输入后仅保存到当前浏览器', ariaLabel: 'OpenAI-compatible API Key' });
        const openaiKeyStatus = element('p', { className: 'yl-image-generation-key-status' });
        const insecureTransportWarning = () => element('p', {
            className: 'yl-phone-page-description',
            text: '兼容仅提供 HTTP 的生图服务；使用 HTTP 时，API Key、提示词与返回内容会以明文传输，请仅连接你信任的服务。',
        });
        const buildKeyControls = ({ providerLabel, presetInput, keyInput, keyStatus, saveName, deleteName }) => {
            const refresh = () => {
                const id = String(presetInput.value ?? '').trim();
                try {
                    keyStatus.textContent = hasSessionKey(id)
                        ? `此 ${providerLabel} 预设已有可用 API Key（不会显示或导出）。`
                        : `此 ${providerLabel} 预设尚未解锁 API Key。`;
                } catch {
                    keyStatus.textContent = `请填写合法的 ${providerLabel} 密钥预设 ID 后再管理 API Key。`;
                }
            };
            const actions = element('div', { className: 'yl-settings-actions yl-image-generation-key-actions' });
            actions.appendChild(actionButton(`保存 ${providerLabel} API Key`, async () => {
                try {
                    const result = unlockSessionKey(presetInput.value, keyInput.value);
                    keyInput.value = '';
                    refresh();
                    onFeedback(result.persisted ? `${providerLabel} API Key 已保存到当前浏览器。` : `浏览器缓存不可用；${providerLabel} API Key 仅在本次会话可用。`);
                } catch (error) {
                    keyInput.value = '';
                    onFeedback(safeErrorMessage(error, `${providerLabel} API Key 未保存，请检查预设 ID 与 Key。`));
                }
            }, signal, { name: saveName }));
            actions.appendChild(actionButton(`删除 ${providerLabel} API Key`, async () => {
                try {
                    const removed = deletePersistentKey(presetInput.value);
                    keyInput.value = '';
                    refresh();
                    onFeedback(removed ? `已删除当前 ${providerLabel} 预设在此浏览器保存的 API Key。` : `当前 ${providerLabel} 预设没有可删除的浏览器缓存 API Key。`);
                } catch (error) {
                    onFeedback(safeErrorMessage(error, `${providerLabel} API Key 未删除。`));
                }
            }, signal, { secondary: true, danger: true, name: deleteName }));
            listen(presetInput, presetInput, 'input', refresh, signal);
            refresh();
            return { actions };
        };

        const naiProviderPanel = element('div', { className: 'yl-image-provider-panel', id: 'yl-novelai-provider-panel' });
        naiProviderPanel.setAttribute('role', 'tabpanel');
        naiProviderPanel.setAttribute('aria-labelledby', 'yl-image-provider-tab-novelai');
        append(naiProviderPanel, [
            element('h3', { className: 'yl-image-provider-title', text: 'NAI 专属配置' }),
            element('p', { className: 'yl-phone-page-description', text: '这里只配置 NovelAI 的连接、采样、尺寸、提示词与浏览器 Key。' }),
            insecureTransportWarning(),
        ]);
        const naiFields = element('div', { className: 'yl-settings-fields yl-image-generation-fields' });
        append(naiFields, [
            field('NAI 密钥预设 ID', presetId), field('NAI 生图站点', baseUrl), field('NAI 接口路径', endpointPath),
            field('NAI 模型', model), field('NAI 采样器', sampler), field('NAI 噪点表', noiseSchedule), field('Guidance', guidance),
            field('Guidance Rescale', guidanceRescale), field('宽度', width), field('高度', height), field('步数', steps), field('种子（0 为随机）', seed),
            field('质量标签', switchShell(qualityToggle)), field('随机性', switchShell(variety)),
            field('NAI 前置正面提示词', positivePrefix), field('NAI 后置正面提示词', positiveSuffix), field('NAI 固定负面提示词', negativePrompt),
        ]);
        naiProviderPanel.appendChild(naiFields);
        naiProviderPanel.appendChild(field('NAI API Key', naiApiKey));
        naiProviderPanel.appendChild(naiKeyStatus);
        naiProviderPanel.appendChild(buildKeyControls({
            providerLabel: 'NAI', presetInput: presetId, keyInput: naiApiKey, keyStatus: naiKeyStatus,
            saveName: 'image-generation-nai-key-save', deleteName: 'image-generation-nai-key-delete',
        }).actions);

        const openaiProviderPanel = element('div', { className: 'yl-image-provider-panel', id: 'yl-openai-provider-panel' });
        openaiProviderPanel.setAttribute('role', 'tabpanel');
        openaiProviderPanel.setAttribute('aria-labelledby', 'yl-image-provider-tab-openai_compatible');
        append(openaiProviderPanel, [
            element('h3', { className: 'yl-image-provider-title', text: 'OpenAI-compatible 专属配置' }),
            element('p', { className: 'yl-phone-page-description', text: '这里只配置 OpenAI-compatible 的接口、模型、尺寸、提示词与浏览器 Key；不会读取 NAI 参数。' }),
            insecureTransportWarning(),
        ]);
        const openaiFields = element('div', { className: 'yl-settings-fields yl-image-generation-fields' });
        append(openaiFields, [
            field('OpenAI 密钥预设 ID', openaiPresetId), field('OpenAI 生图站点', openaiBaseUrl),
            field('OpenAI 接口路径', openaiEndpointPath), field('OpenAI 模型', openaiModel),
            field('OpenAI 宽度', openaiWidth), field('OpenAI 高度', openaiHeight),
            field('OpenAI 前置正面提示词', openaiPositivePrefix), field('OpenAI 后置正面提示词', openaiPositiveSuffix),
            field('OpenAI 固定负面提示词', openaiNegativePrompt),
        ]);
        openaiProviderPanel.appendChild(openaiFields);
        openaiProviderPanel.appendChild(field('OpenAI-compatible API Key', openaiApiKey));
        openaiProviderPanel.appendChild(openaiKeyStatus);
        openaiProviderPanel.appendChild(buildKeyControls({
            providerLabel: 'OpenAI-compatible', presetInput: openaiPresetId, keyInput: openaiApiKey, keyStatus: openaiKeyStatus,
            saveName: 'image-generation-openai-key-save', deleteName: 'image-generation-openai-key-delete',
        }).actions);

        const comfyBaseUrl = element('input', { className: 'yl-settings-control', type: 'url', name: 'image-generation-comfy-base-url', value: image.comfyBaseUrl, maxLength: 512, ariaLabel: 'ComfyUI 地址' });
        const resourceSelect = (value, ariaLabel, name, emptyLabel) => selectWithOptions(
            [{ label: value || emptyLabel, value: value || '' }],
            value || '',
            ariaLabel,
            name,
        );
        const comfyModel = resourceSelect(image.comfyModel, 'ComfyUI 模型', 'image-generation-comfy-model', '未选择模型');
        const comfySampler = resourceSelect(image.comfySampler, 'ComfyUI 采样器', 'image-generation-comfy-sampler', 'euler');
        const comfyScheduler = resourceSelect(image.comfyScheduler, 'ComfyUI 调度器', 'image-generation-comfy-scheduler', 'normal');
        const comfyVae = resourceSelect(image.comfyVae, 'ComfyUI VAE', 'image-generation-comfy-vae', '不指定 VAE');
        const comfyClip = resourceSelect(image.comfyClip, 'ComfyUI CLIP', 'image-generation-comfy-clip', '不指定 CLIP');
        const comfyGuidance = element('input', { className: 'yl-settings-control', type: 'number', name: 'image-generation-comfy-guidance', value: String(image.comfyGuidance), min: 0, max: 30, ariaLabel: 'ComfyUI CFG' });
        const comfyWidth = element('input', { className: 'yl-settings-control', type: 'number', name: 'image-generation-comfy-width', value: String(image.comfyWidth), min: 256, max: 2048, ariaLabel: 'ComfyUI 图片宽度' });
        const comfyHeight = element('input', { className: 'yl-settings-control', type: 'number', name: 'image-generation-comfy-height', value: String(image.comfyHeight), min: 256, max: 2048, ariaLabel: 'ComfyUI 图片高度' });
        const comfySteps = element('input', { className: 'yl-settings-control', type: 'number', name: 'image-generation-comfy-steps', value: String(image.comfySteps), min: 1, max: 100, ariaLabel: 'ComfyUI 步数' });
        const comfySeed = element('input', { className: 'yl-settings-control', type: 'number', name: 'image-generation-comfy-seed', value: String(image.comfySeed), min: 0, max: 4294967295, ariaLabel: 'ComfyUI 种子' });
        const comfyPositivePrefix = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 3, name: 'image-generation-comfy-positive-prefix', value: image.comfyPositivePrefix, maxLength: 4000, ariaLabel: 'ComfyUI 前置正面提示词' });
        const comfyPositiveSuffix = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 3, name: 'image-generation-comfy-positive-suffix', value: image.comfyPositiveSuffix, maxLength: 4000, ariaLabel: 'ComfyUI 后置正面提示词' });
        const comfyNegativePrompt = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 3, name: 'image-generation-comfy-negative-prompt', value: image.comfyNegativePrompt, maxLength: 4000, ariaLabel: 'ComfyUI 固定负面提示词' });
        const comfyWorkflow = element('textarea', {
            className: 'yl-settings-control yl-settings-textarea',
            rows: 8,
            name: 'image-generation-comfy-workflow',
            value: image.comfyWorkflow,
            maxLength: 200000,
            placeholder: '留空使用基础工作流；或粘贴 ComfyUI “Save (API Format)” 导出的 JSON',
            ariaLabel: 'ComfyUI API 工作流 JSON',
        });

        const comfyProviderPanel = element('div', { className: 'yl-image-provider-panel yl-comfyui-provider-panel', id: 'yl-comfyui-provider-panel' });
        comfyProviderPanel.setAttribute('role', 'tabpanel');
        append(comfyProviderPanel, [
            element('h3', { className: 'yl-image-provider-title', text: 'ComfyUI 专属配置' }),
            element('p', { className: 'yl-phone-page-description', text: '独立保存 ComfyUI 地址与引擎参数；不读取 NAI/OpenAI 的接口路径或 API Key。远程 HTTP 会明文传输提示词与图片。' }),
        ]);
        const comfyConnectionFields = element('div', { className: 'yl-settings-fields yl-image-generation-fields' });
        comfyConnectionFields.appendChild(field('ComfyUI 地址（支持 HTTP / HTTPS）', comfyBaseUrl));
        comfyProviderPanel.appendChild(comfyConnectionFields);
        const resourceStatus = element('p', { className: 'yl-image-generation-key-status', text: '连接后可从 /object_info 读取模型、采样器、调度器、VAE 与 CLIP。' });
        const replaceResourceOptions = (select, values, emptyLabel) => {
            const selected = String(select.value ?? '');
            const choices = selected && !values.includes(selected) ? [selected, ...values] : values;
            select.replaceChildren();
            if (!selected || !choices.length) select.appendChild(element('option', { text: emptyLabel, value: '' }));
            for (const value of choices) select.appendChild(element('option', { text: value, value }));
            select.value = choices.includes(selected) ? selected : (choices[0] ?? '');
        };
        const refreshResources = actionButton('连接并刷新 ComfyUI 数据', async () => {
            if (typeof imageGenerationClient?.fetchComfyUIResources !== 'function') {
                onFeedback('当前浏览器未提供 ComfyUI 资源读取能力。');
                return;
            }
            resourceStatus.textContent = '正在连接 ComfyUI 并读取 /object_info…';
            try {
                const resources = await imageGenerationClient.fetchComfyUIResources({ baseUrl: comfyBaseUrl.value, signal });
                replaceResourceOptions(comfyModel, resources.models, '未读取到模型');
                replaceResourceOptions(comfySampler, resources.samplers, '未读取到采样器');
                replaceResourceOptions(comfyScheduler, resources.schedulers, '未读取到调度器');
                replaceResourceOptions(comfyVae, resources.vae, '不指定 VAE');
                replaceResourceOptions(comfyClip, resources.clips, '不指定 CLIP');
                resourceStatus.textContent = `已读取：模型 ${resources.models.length}、采样器 ${resources.samplers.length}、调度器 ${resources.schedulers.length}、VAE ${resources.vae.length}、CLIP ${resources.clips.length}。`;
                onFeedback('ComfyUI 数据已刷新；保存后用于后续生图。');
            } catch (error) {
                const projected = toPublicImageGenerationError(error);
                resourceStatus.textContent = 'ComfyUI 数据读取失败，请检查服务、地址与 CORS。';
                onFeedback(projected.message);
            }
        }, signal, { name: 'image-generation-comfy-refresh' });
        comfyProviderPanel.appendChild(refreshResources);
        comfyProviderPanel.appendChild(resourceStatus);
        const comfyFields = element('div', { className: 'yl-settings-fields yl-image-generation-fields' });
        append(comfyFields, [
            field('模型', comfyModel), field('采样器', comfySampler), field('调度器', comfyScheduler),
            field('VAE', comfyVae), field('CLIP', comfyClip), field('CFG', comfyGuidance),
            field('宽度', comfyWidth), field('高度', comfyHeight), field('步数', comfySteps), field('种子（0 为随机）', comfySeed),
            field('固定前置提示词', comfyPositivePrefix), field('固定后置提示词', comfyPositiveSuffix),
            field('负面提示词', comfyNegativePrompt), field('工作流 JSON', comfyWorkflow),
        ]);
        comfyProviderPanel.appendChild(comfyFields);
        section.appendChild(naiProviderPanel);
        section.appendChild(openaiProviderPanel);
        section.appendChild(comfyProviderPanel);

        const setProvider = (provider) => {
            apiMode.value = provider;
            naiProviderPanel.hidden = provider !== 'novelai';
            openaiProviderPanel.hidden = provider !== 'openai_compatible';
            comfyProviderPanel.hidden = provider !== 'comfyui';
            for (const [id, button] of providerButtons) {
                const active = id === provider;
                button.setAttribute('aria-selected', String(active));
                button.setAttribute('tabindex', active ? '0' : '-1');
                button.className = `yl-image-provider-tab${active ? ' is-active' : ''}`;
            }
        };
        for (const [provider, button] of providerButtons) {
            listen(button, button, 'click', () => setProvider(provider), signal);
            listen(button, button, 'keydown', (event) => {
                const providers = [...providerButtons.keys()];
                const current = providers.indexOf(apiMode.value);
                let next = current;
                if (event.key === 'ArrowRight') next = (current + 1) % providers.length;
                else if (event.key === 'ArrowLeft') next = (current - 1 + providers.length) % providers.length;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = providers.length - 1;
                else return;
                event.preventDefault();
                setProvider(providers[next]);
                providerButtons.get(providers[next])?.focus?.();
            }, signal);
        }
        setProvider(image.apiMode);

        const formSettings = () => ({
            enabled: Boolean(enabled.checked), presetId: presetId.value, apiMode: apiMode.value, baseUrl: baseUrl.value, endpointPath: endpointPath.value,
            model: model.value, sampler: sampler.value, noiseSchedule: noiseSchedule.value,
            guidance: numberValue(guidance, image.guidance), guidanceRescale: numberValue(guidanceRescale, image.guidanceRescale),
            width: numberValue(width, image.width), height: numberValue(height, image.height), steps: numberValue(steps, image.steps), seed: numberValue(seed, image.seed),
            qualityToggle: Boolean(qualityToggle.checked), variety: Boolean(variety.checked),
            positivePrefix: positivePrefix.value, positiveSuffix: positiveSuffix.value, negativePrompt: negativePrompt.value,
            openaiPositivePrefix: openaiPositivePrefix.value, openaiPositiveSuffix: openaiPositiveSuffix.value, openaiNegativePrompt: openaiNegativePrompt.value,
            openaiPresetId: openaiPresetId.value, openaiBaseUrl: openaiBaseUrl.value,
            openaiEndpointPath: openaiEndpointPath.value, openaiModel: openaiModel.value,
            openaiWidth: numberValue(openaiWidth, image.openaiWidth), openaiHeight: numberValue(openaiHeight, image.openaiHeight),
            comfyBaseUrl: comfyBaseUrl.value, comfyModel: comfyModel.value, comfySampler: comfySampler.value, comfyScheduler: comfyScheduler.value,
            comfyVae: comfyVae.value, comfyClip: comfyClip.value,
            comfyGuidance: numberValue(comfyGuidance, image.comfyGuidance),
            comfyWidth: numberValue(comfyWidth, image.comfyWidth), comfyHeight: numberValue(comfyHeight, image.comfyHeight),
            comfySteps: numberValue(comfySteps, image.comfySteps), comfySeed: numberValue(comfySeed, image.comfySeed),
            comfyPositivePrefix: comfyPositivePrefix.value, comfyPositiveSuffix: comfyPositiveSuffix.value, comfyNegativePrompt: comfyNegativePrompt.value,
            comfyWorkflow: comfyWorkflow.value,
            conversationSettings: image.conversationSettings,
        });
        const save = actionButton('保存生图设置', async () => updateSettings(
            () => settingsStore.setImageGenerationSettings(formSettings()),
            '生图设置已保存；API Key 仍只保存在独立浏览器缓存。',
        ), signal, { name: 'image-generation-save' });
        section.appendChild(element('p', { className: 'yl-image-generation-order-note', text: '正面提示词：前置 → core_dna → outfit_dna → AI 场景 → 后置；负面提示词独立保持。' }));
        section.appendChild(save);
        return section;
    }

    function buildPersonalizationSection(snapshot, { openPreferences }) {
        const section = element('section', { className: 'yl-settings-section' });
        const personalization = snapshot.personalization ?? { enabled: true, keywordWeightsByMode: { SFW: [], NSFW: [] } };
        const selectedContentMode = activeContentMode;

        if (!openPreferences) {
            append(section, [
                sectionHeading('privacy', '个性化内容推荐管理'),
                element('p', {
                    className: 'yl-phone-page-description',
                    text: '保存当前设备的分模式关键词学习库；不会改变连接、提示词或聊天/MVU 数据。',
                }),
            ]);
            const enabled = element('input', {
                className: 'yl-settings-checkbox', type: 'checkbox', checked: personalization.enabled,
                name: 'personalization-enabled', ariaLabel: '个性化内容推荐',
            });
            section.appendChild(field('个性化内容推荐', switchShell(enabled)));
            const preferenceEntry = actionButton('个性化内容偏好', async () => {
                if (!enabled.checked) return;
                navigate('settings_personalization_preference');
            }, signal, {
                disabled: !personalization.enabled,
                secondary: true,
                name: 'personalization-preference-entry',
            });
            section.appendChild(preferenceEntry);

            const notice = element('section', { className: 'yl-settings-section yl-settings-modal', hidden: true });
            notice.setAttribute('aria-label', '个性化内容推荐说明');
            notice.setAttribute('role', 'dialog');
            notice.setAttribute('aria-modal', 'true');
            const closeNotice = () => {
                // 控制器 close 自带 hidden=true 与礼貌回焦 opener；无控制器时保持旧的 hidden 切换降级。
                if (dialogController) dialogController.close(notice);
                else notice.hidden = true;
                enabled.checked = true;
            };
            const noticeTitlebar = element('div', { className: 'yl-dialog-titlebar' });
            const noticeClose = element('button', {
                className: 'yl-dialog-close', type: 'button', name: 'personalization-modal-close',
                ariaLabel: '关闭个性化内容推荐说明',
            });
            noticeClose.appendChild(createUiIcon(document, 'close', { className: 'yl-dialog-close-svg', size: 18 }));
            append(noticeTitlebar, [element('h2', { text: '个性化内容推荐说明' }), noticeClose]);
            notice.appendChild(noticeTitlebar);
            listen(noticeClose, noticeClose, 'click', () => {
                closeNotice();
                onFeedback('已关闭说明，个性化内容推荐保持开启。');
            }, signal);
            for (const paragraph of PERSONALIZATION_NOTICE) notice.appendChild(element('p', { text: paragraph }));
            const noticeActions = element('div', { className: 'yl-settings-actions' });
            noticeActions.appendChild(actionButton('确定', async () => {
                // 先把弹窗移出控制器焦点栈（含回焦 opener），成功保存后 onRerender 会重建整个面板。
                if (dialogController) dialogController.close(notice);
                updateSettings(
                    () => settingsStore.setPersonalizationEnabled(false),
                    '个性化内容推荐已在当前设备关闭；后续首页刷新将不再参考本地标签权重。',
                );
            }, signal, { name: 'personalization-disable-confirm' }));
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
                // 控制器 open 自带 hidden=false、aria-modal 与首个可聚焦元素聚焦；Escape/Tab 由 app-shell 全局委托。
                if (typeof openDialog === 'function') openDialog(notice, { opener: enabled, onRequestClose: closeNotice });
                else if (dialogController) dialogController.open(notice, { opener: enabled, onRequestClose: closeNotice });
                else notice.hidden = false;
            }, signal);
            return section;
        }

        append(section, [
            sectionHeading('sparkle', '个性化内容偏好'),
            element('p', {
                className: 'yl-phone-page-description',
                text: '仅编辑 ' + CONTENT_MODE_LABELS[selectedContentMode] + ' 词库；另一模式不受影响。正权重提高相关标签概率，负权重降低，0 表示尚未学习。',
            }),
        ]);
        if (!personalization.enabled) {
            section.appendChild(element('p', {
                className: 'yl-settings-summary',
                text: '个性化内容推荐当前已关闭。请返回管理页重新开启后再编辑关键词权重。',
            }));
            return section;
        }

        const preferenceEditor = element('section', { className: 'yl-settings-binding' });
        preferenceEditor.setAttribute('aria-label', '个性化内容偏好编辑器');
        let keywordWeights = personalization.keywordWeightsByMode[selectedContentMode].map((item) => ({ ...item }));
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
            () => settingsStore.setPersonalizationKeywordWeights(selectedContentMode, keywordWeights),
            CONTENT_MODE_LABELS[selectedContentMode] + ' 模式的个性化内容偏好已保存；另一模式词库未改变。',
        ), signal, { name: 'personalization-preference-save' }));
        preferenceEditor.appendChild(preferenceActions);
        section.appendChild(preferenceEditor);
        return section;
    }

    function buildBindingSection(snapshot, selectedContentMode) {
        const section = element('section', { className: 'yl-settings-section' });
        append(section, [
            sectionHeading('settings', `${CONTENT_MODE_LABELS[selectedContentMode]} 模式预设与功能绑定`),
            element('p', {
                className: 'yl-phone-page-description',
                text: '仅编辑 ' + CONTENT_MODE_LABELS[selectedContentMode] + ' 功能绑定；提示词只显示当前模式预设，连接可回退到默认连接。',
            }),
        ]);
        const connectionOptions = [
            { label: '不设置（无默认）', value: '' },
            ...snapshot.connectionPresets.map((preset) => ({ label: preset.name, value: preset.id })),
        ];
        const modePromptPresets = snapshot.promptPresets.filter((preset) => preset.contentMode === selectedContentMode);
        const promptOptions = modePromptPresets.map((preset) => ({ label: preset.name, value: preset.id }));
        const defaultConnection = selectWithOptions(
            connectionOptions,
            snapshot.defaults.connectionPresetId ?? '',
            '默认连接预设',
            'default-connection-preset',
        );
        const defaultsFields = element('div', { className: 'yl-settings-fields' });
        append(defaultsFields, [field('默认连接（所有模式）', defaultConnection)]);
        section.appendChild(defaultsFields);
        section.appendChild(actionButton('保存默认连接', async () => updateSettings(() => settingsStore.setDefaults({
            connectionPresetId: defaultConnection.value || null,
            promptPresetId: snapshot.defaults.promptPresetId ?? null,
        }), '默认连接预设已保存。'), signal));

        for (const functionKey of FUNCTION_KEYS.filter((key) => key !== 'character_authoring')) {
            const binding = snapshot.functionModeBindings[functionKey][selectedContentMode];
            const row = element('section', { className: 'yl-settings-binding' });
            row.appendChild(element('strong', { text: FUNCTION_LABELS[functionKey] + ' · ' + CONTENT_MODE_LABELS[selectedContentMode] }));
            const connection = selectWithOptions(
                [{ label: '使用默认连接', value: '' }, ...snapshot.connectionPresets.map((preset) => ({ label: preset.name, value: preset.id }))],
                binding.connectionPresetId ?? '',
                `${FUNCTION_LABELS[functionKey]}连接预设`,
                `${functionKey}-connection-preset`,
            );
            const prompt = selectWithOptions(
                [{ label: '不附加提示词预设', value: '' }, ...promptOptions],
                binding.promptPresetId ?? '',
                `${FUNCTION_LABELS[functionKey]}提示词预设`,
                `${functionKey}-prompt-preset`,
            );
            append(row, [field('连接', connection), field('提示词', prompt)]);
            row.appendChild(actionButton('保存此功能绑定', async () => updateSettings(() => {
                const next = { connectionPresetId: connection.value || null, promptPresetId: prompt.value || null };
                settingsStore.bindFunctionForContentMode(functionKey, selectedContentMode, next);
            }, `${FUNCTION_LABELS[functionKey]}的 ${CONTENT_MODE_LABELS[selectedContentMode]} 绑定已保存。`), signal, { secondary: true }));
            section.appendChild(row);
        }
        return section;
    }

    function buildPromptTransferSection(snapshot) {
        const section = element('section', { className: 'yl-settings-section' });
        append(section, [
            sectionHeading('refresh', '提示词预设导入 / 导出'),
            element('p', { className: 'yl-phone-page-description', text: '仅导入或导出提示词预设；不含 API Key、MVU、聊天或角色隐私资料。' }),
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
                for (const contentMode of CONTENT_MODES) {
                    const binding = document.functionModeBindings[functionKey][contentMode];
                    if (!availablePromptIds.has(binding.promptPresetId)) binding.promptPresetId = null;
                }
            }
            settingsStore.importJson(JSON.stringify(document));
        }, '提示词预设已导入；API Key 未被导入。'), signal, { secondary: true, danger: true }));
        section.appendChild(controls);
        return section;
    }
}

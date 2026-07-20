/**
 * Functional preset-binding data helper.
 *
 * This module intentionally has no DOM, storage, network, or session-key access.
 * It projects only preset IDs/names for selectors and delegates persistence to the
 * existing settings store after validating a selected pair against its snapshot.
 */
import { CONTENT_MODES, FUNCTION_KEYS } from './settings-store.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,96}$/;
const BINDING_FIELDS = new Set(['connectionPresetId', 'promptPresetId']);
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SECRET_FIELD_NAMES = new Set([
    'apikey', 'api_key', 'key', 'token', 'access_token', 'authorization', 'password', 'secret',
]);

const surfaces = [
    { id: 'home_recommendation', functionKey: 'recommendation_refresh' },
    { id: 'match_soul', functionKey: 'soul_match' },
    { id: 'match_text', functionKey: 'text_match' },
    { id: 'messages_chat', functionKey: 'chat' },
    { id: 'groups_chat', functionKey: 'group_chat' },
    { id: 'groups_forum', functionKey: 'forum' },
    { id: 'character_ai_completion', functionKey: 'character_ai_completion' },
    { id: 'character_full_authoring', functionKey: 'character_full_authoring' },
].map((surface) => Object.freeze(surface));

/** A stable UI-neutral map from product surface IDs to settings function keys. */
export const FEATURE_BINDING_SURFACES = Object.freeze(surfaces);
export const FEATURE_BINDING_SURFACE_IDS = Object.freeze(surfaces.map((surface) => surface.id));

export class FeatureBindingError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'FeatureBindingError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new FeatureBindingError(code, message);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function containsUnsafeKey(value, seen = new Set()) {
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_OBJECT_KEYS.has(key) || SECRET_FIELD_NAMES.has(key.toLowerCase())) return true;
        if (containsUnsafeKey(value[key], seen)) return true;
    }
    return false;
}

function assertSafeDocument(document) {
    if (!isPlainObject(document) || containsUnsafeKey(document)) {
        fail('UNSAFE_BINDING_DOCUMENT', '功能绑定设置不可安全读取。');
    }
    if (!Array.isArray(document.connectionPresets) || !Array.isArray(document.promptPresets)
        || !isPlainObject(document.defaults) || !isPlainObject(document.functionBindings)
        || (document.functionModeBindings !== undefined && !isPlainObject(document.functionModeBindings))) {
        fail('INVALID_BINDING_DOCUMENT', '功能绑定设置结构无效。');
    }
}

function cleanContentMode(value) {
    if (value === undefined) return null;
    if (!CONTENT_MODES.includes(value)) fail('INVALID_CONTENT_MODE', '内容模式必须是 SFW 或 NSFW。');
    return value;
}

function cleanOptionalId(value, field) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
        fail('INVALID_BINDING_SELECTION', `${field}无效。`);
    }
    return value;
}

function normalizePresetIds(presets, kind) {
    const ids = new Set();
    for (const preset of presets) {
        if (!isPlainObject(preset) || typeof preset.id !== 'string' || !ID_PATTERN.test(preset.id)) {
            fail('INVALID_BINDING_DOCUMENT', `${kind}预设无效。`);
        }
        if (ids.has(preset.id)) fail('INVALID_BINDING_DOCUMENT', `${kind}预设 ID 重复。`);
        ids.add(preset.id);
    }
    return ids;
}

function normalizeStoredSelection(value) {
    if (value === undefined || value === null) return { connectionPresetId: null, promptPresetId: null };
    if (!isPlainObject(value) || Object.keys(value).some((key) => !BINDING_FIELDS.has(key))) {
        fail('INVALID_BINDING_DOCUMENT', '功能绑定记录无效。');
    }
    return {
        connectionPresetId: cleanOptionalId(value.connectionPresetId, '连接预设 ID'),
        promptPresetId: cleanOptionalId(value.promptPresetId, '提示词预设 ID'),
    };
}

function requireSurface(surfaceId) {
    if (typeof surfaceId !== 'string') fail('UNKNOWN_FEATURE_SURFACE', '功能入口不存在。');
    const surface = FEATURE_BINDING_SURFACES.find((item) => item.id === surfaceId);
    if (!surface) fail('UNKNOWN_FEATURE_SURFACE', '功能入口不存在。');
    if (!FUNCTION_KEYS.includes(surface.functionKey)) {
        fail('UNSUPPORTED_FEATURE_SURFACE', '功能入口尚未注册。');
    }
    return surface;
}

function assertKnownPresetIds(selection, connectionIds, promptIds) {
    if (selection.connectionPresetId !== null && !connectionIds.has(selection.connectionPresetId)) {
        fail('UNKNOWN_PRESET_ID', '选择的连接预设不存在。');
    }
    if (selection.promptPresetId !== null && !promptIds.has(selection.promptPresetId)) {
        fail('UNKNOWN_PRESET_ID', '选择的提示词预设不存在。');
    }
}

function selectorOptions(presets) {
    return presets.map((preset) => {
        if (!isPlainObject(preset) || typeof preset.id !== 'string' || typeof preset.name !== 'string') {
            fail('INVALID_BINDING_DOCUMENT', '预设选项无效。');
        }
        return Object.freeze({ id: preset.id, name: preset.name });
    });
}

/** Return a detached descriptor for one supported feature surface. */
export function getFeatureBindingSurface(surfaceId) {
    const surface = requireSurface(surfaceId);
    return Object.freeze({ id: surface.id, functionKey: surface.functionKey });
}

/** Return detached descriptors, suitable for a caller's own UI labels and routes. */
export function listFeatureBindingSurfaces() {
    return FEATURE_BINDING_SURFACES.map((surface) => ({ id: surface.id, functionKey: surface.functionKey }));
}

/**
 * Strictly validate a selector value against the currently saved preset IDs.
 * `null` means inherit the document default for that kind of preset.
 */
export function validateFeatureBindingSelection(document, selection) {
    assertSafeDocument(document);
    const connectionIds = normalizePresetIds(document.connectionPresets, '连接');
    const promptIds = normalizePresetIds(document.promptPresets, '提示词');
    const normalized = normalizeStoredSelection(selection);
    assertKnownPresetIds(normalized, connectionIds, promptIds);
    return Object.freeze(normalized);
}

/**
 * Derive a no-secret effective binding. Only IDs and their source are returned;
 * connection configuration and prompt content intentionally never enter this API.
 */
export function deriveEffectiveFeatureBinding(document, surfaceId, { contentMode } = {}) {
    assertSafeDocument(document);
    const surface = requireSurface(surfaceId);
    const selectedContentMode = cleanContentMode(contentMode);
    const connectionIds = normalizePresetIds(document.connectionPresets, '连接');
    const promptIds = normalizePresetIds(document.promptPresets, '提示词');
    const defaults = normalizeStoredSelection(document.defaults);
    assertKnownPresetIds(defaults, connectionIds, promptIds);
    const genericSelection = normalizeStoredSelection(document.functionBindings[surface.functionKey]);
    assertKnownPresetIds(genericSelection, connectionIds, promptIds);
    const modeSelection = selectedContentMode === null
        ? null
        : normalizeStoredSelection(document.functionModeBindings?.[surface.functionKey]?.[selectedContentMode]);
    if (modeSelection) assertKnownPresetIds(modeSelection, connectionIds, promptIds);

    const connectionPresetId = modeSelection?.connectionPresetId ?? genericSelection.connectionPresetId ?? defaults.connectionPresetId;
    const promptPresetId = modeSelection?.promptPresetId ?? genericSelection.promptPresetId ?? defaults.promptPresetId;
    return Object.freeze({
        surfaceId: surface.id,
        functionKey: surface.functionKey,
        contentMode: selectedContentMode,
        selected: Object.freeze({ ...(modeSelection ?? genericSelection) }),
        effective: Object.freeze({
            connectionPresetId,
            promptPresetId,
            connectionSource: modeSelection?.connectionPresetId !== null && modeSelection?.connectionPresetId !== undefined
                ? 'mode_binding' : genericSelection.connectionPresetId === null ? (connectionPresetId === null ? 'none' : 'default') : 'binding',
            promptSource: modeSelection?.promptPresetId !== null && modeSelection?.promptPresetId !== undefined
                ? 'mode_binding' : genericSelection.promptPresetId === null ? (promptPresetId === null ? 'none' : 'default') : 'binding',
        }),
    });
}

/**
 * Create a minimal store adapter for app-shell integration. It never reads or
 * exposes session keys and persists only the two validated preset IDs.
 */
export function createFeatureBindingHelper({ settingsStore } = {}) {
    if (!settingsStore || typeof settingsStore.snapshot !== 'function' || typeof settingsStore.bindFunction !== 'function') {
        fail('INVALID_SETTINGS_STORE', '功能绑定需要可用的设置存储。');
    }

    function documentSnapshot() {
        return settingsStore.snapshot();
    }

    function getViewModel(surfaceId, { contentMode } = {}) {
        const document = documentSnapshot();
        const binding = deriveEffectiveFeatureBinding(document, surfaceId, { contentMode });
        return Object.freeze({
            ...binding,
            connectionOptions: Object.freeze(selectorOptions(document.connectionPresets)),
            promptOptions: Object.freeze(selectorOptions(document.promptPresets)),
        });
    }

    function save(surfaceId, selection, { contentMode } = {}) {
        const surface = requireSurface(surfaceId);
        const normalized = validateFeatureBindingSelection(documentSnapshot(), selection);
        const selectedContentMode = cleanContentMode(contentMode);
        if (selectedContentMode !== null && typeof settingsStore.bindFunctionForContentMode === 'function') {
            settingsStore.bindFunctionForContentMode(surface.functionKey, selectedContentMode, normalized);
        } else {
            settingsStore.bindFunction(surface.functionKey, normalized);
        }
        return getViewModel(surfaceId, { contentMode: selectedContentMode ?? undefined });
    }

    return Object.freeze({
        getSurface: getFeatureBindingSurface,
        listSurfaces: listFeatureBindingSurfaces,
        getViewModel,
        save,
    });
}

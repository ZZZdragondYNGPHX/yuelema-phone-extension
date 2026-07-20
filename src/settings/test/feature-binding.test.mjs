import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage, createSettingsStore } from '../settings-store.js';
import {
    FEATURE_BINDING_SURFACE_IDS,
    FeatureBindingError,
    createFeatureBindingHelper,
    deriveEffectiveFeatureBinding,
    getFeatureBindingSurface,
    listFeatureBindingSurfaces,
    validateFeatureBindingSelection,
} from '../feature-binding.js';

function connection(id, name = id) {
    return {
        id,
        name,
        url: 'https://api.example.invalid/v1',
        model: `${id}-model`,
        temperature: 0.7,
        maxTokens: 512,
        timeoutMs: 30_000,
        transportMode: 'json',
    };
}

function prompt(id, name = id, contentMode = 'SFW') {
    return {
        id,
        name,
        depth: 4,
        order: 100,
        position: 'after_character_definition',
        enabled: true,
        contentMode,
        content: '只返回安全的中文草稿。',
    };
}

function makeStore() {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    store.addConnectionPreset(connection('fast', '快速连接'));
    store.addConnectionPreset(connection('smart', '精细连接'));
    store.addPromptPreset(prompt('base', '默认提示词', 'SFW'));
    store.addPromptPreset(prompt('creative', '创作提示词', 'NSFW'));
    return store;
}

function errorCode(code) {
    return (error) => error instanceof FeatureBindingError && error.code === code;
}

test('功能入口映射覆盖全部需要预设的产品表面，角色两种 AI 创作独立映射', () => {
    assert.deepEqual(FEATURE_BINDING_SURFACE_IDS, [
        'home_recommendation',
        'match_soul',
        'match_text',
        'messages_chat',
        'groups_chat',
        'groups_forum',
        'character_ai_completion',
        'character_full_authoring',
    ]);
    assert.deepEqual(listFeatureBindingSurfaces().map((surface) => surface.functionKey), [
        'recommendation_refresh', 'soul_match', 'text_match', 'chat', 'group_chat', 'forum',
        'character_ai_completion', 'character_full_authoring',
    ]);
    assert.deepEqual(getFeatureBindingSurface('match_soul'), {
        id: 'match_soul', functionKey: 'soul_match',
    });
    assert.throws(() => getFeatureBindingSurface('unknown'), errorCode('UNKNOWN_FEATURE_SURFACE'));
});

test('每个功能入口可独立保存连接与提示词，并按各自默认值安全回退', () => {
    const store = makeStore();
    store.setDefaults({ connectionPresetId: 'fast', promptPresetId: 'base' });
    const helper = createFeatureBindingHelper({ settingsStore: store });

    const completion = helper.save('character_ai_completion', {
        connectionPresetId: 'smart', promptPresetId: 'creative',
    });
    const fullAuthoring = helper.save('character_full_authoring', {
        connectionPresetId: 'fast', promptPresetId: 'base',
    });
    const soul = helper.getViewModel('match_soul');

    assert.deepEqual(completion.selected, { connectionPresetId: 'smart', promptPresetId: 'creative' });
    assert.deepEqual(fullAuthoring.selected, { connectionPresetId: 'fast', promptPresetId: 'base' });
    assert.deepEqual(soul.effective, {
        connectionPresetId: 'fast', promptPresetId: 'base', connectionSource: 'default', promptSource: 'default',
    });
    const snapshot = store.snapshot();
    assert.deepEqual(snapshot.functionBindings.character_ai_completion, {
        connectionPresetId: 'smart', promptPresetId: 'creative',
    });
    assert.deepEqual(snapshot.functionBindings.character_full_authoring, {
        connectionPresetId: 'fast', promptPresetId: 'base',
    });
});

test('selector view model projects only saved preset IDs and names, never connection config or prompt content', () => {
    const helper = createFeatureBindingHelper({ settingsStore: makeStore() });
    const model = helper.getViewModel('messages_chat');

    assert.deepEqual(model.connectionOptions, [
        { id: 'fast', name: '快速连接' },
        { id: 'smart', name: '精细连接' },
    ]);
    assert.equal(model.promptOptions.length, 14);
    assert.deepEqual(model.promptOptions.slice(-2), [
        { id: 'base', name: '默认提示词' },
        { id: 'creative', name: '创作提示词' },
    ]);
    assert.equal(JSON.stringify(model).includes('https://api.example.invalid'), false);
    assert.equal(JSON.stringify(model).includes('只返回安全的中文草稿。'), false);
    assert.equal(JSON.stringify(model).toLowerCase().includes('apikey'), false);
});

test('模式化辅助绑定只写入指定模式，不覆盖另一套选择', () => {
    const store = makeStore();
    const helper = createFeatureBindingHelper({ settingsStore: store });
    const nsfw = helper.save('messages_chat', {
        connectionPresetId: 'smart', promptPresetId: 'creative',
    }, { contentMode: 'NSFW' });
    const sfw = helper.getViewModel('messages_chat', { contentMode: 'SFW' });

    assert.equal(nsfw.contentMode, 'NSFW');
    assert.equal(nsfw.effective.connectionSource, 'mode_binding');
    assert.deepEqual(store.snapshot().functionModeBindings.chat.NSFW, {
        connectionPresetId: 'smart', promptPresetId: 'creative',
    });
    assert.equal(sfw.selected.promptPresetId, 'builtin_private_chat_sfw');
    assert.throws(() => helper.getViewModel('messages_chat', { contentMode: 'other' }), errorCode('INVALID_CONTENT_MODE'));
});

test('模式化视图只投影对应提示词，并拒绝跨模式保存', () => {
    const store = makeStore();
    const helper = createFeatureBindingHelper({ settingsStore: store });
    const sfw = helper.getViewModel('messages_chat', { contentMode: 'SFW' });
    const nsfw = helper.getViewModel('messages_chat', { contentMode: 'NSFW' });

    assert.equal(sfw.promptOptions.some((preset) => preset.id === 'creative'), false);
    assert.equal(sfw.promptOptions.some((preset) => preset.id === 'builtin_private_chat_sfw'), true);
    assert.equal(sfw.promptOptions.some((preset) => preset.id === 'builtin_private_chat_nsfw'), false);
    assert.equal(nsfw.promptOptions.some((preset) => preset.id === 'creative'), true);
    assert.equal(nsfw.promptOptions.some((preset) => preset.id === 'builtin_private_chat_nsfw'), true);
    assert.equal(nsfw.promptOptions.some((preset) => preset.id === 'builtin_private_chat_sfw'), false);
    assert.throws(() => helper.save('messages_chat', {
        connectionPresetId: 'fast', promptPresetId: 'base',
    }, { contentMode: 'NSFW' }), errorCode('PROMPT_MODE_MISMATCH'));
});

test('选择严格校验已保存 ID、字段和数据结构，不允许未知或未注册入口', () => {
    const store = makeStore();
    const document = store.snapshot();

    assert.deepEqual(validateFeatureBindingSelection(document, {
        connectionPresetId: 'fast', promptPresetId: null,
    }), { connectionPresetId: 'fast', promptPresetId: null });
    assert.throws(() => validateFeatureBindingSelection(document, {
        connectionPresetId: 'missing', promptPresetId: null,
    }), errorCode('UNKNOWN_PRESET_ID'));
    assert.throws(() => validateFeatureBindingSelection(document, {
        connectionPresetId: 'fast', promptPresetId: 'base', extra: true,
    }), errorCode('INVALID_BINDING_DOCUMENT'));
    assert.throws(() => createFeatureBindingHelper({ settingsStore: store }).save('not_registered', {
        connectionPresetId: null, promptPresetId: null,
    }), errorCode('UNKNOWN_FEATURE_SURFACE'));
});

test('派生结果不会接纳或回显密钥字段，删除预设后保持默认回退', () => {
    const store = makeStore();
    store.setDefaults({ connectionPresetId: 'fast', promptPresetId: 'base' });
    const helper = createFeatureBindingHelper({ settingsStore: store });
    helper.save('groups_forum', { connectionPresetId: 'smart', promptPresetId: 'creative' });
    store.deleteConnectionPreset('smart');
    store.deletePromptPreset('creative');

    const afterDelete = helper.getViewModel('groups_forum');
    assert.deepEqual(afterDelete.effective, {
        connectionPresetId: 'fast', promptPresetId: 'base', connectionSource: 'default', promptSource: 'default',
    });

    const unsafeDocument = structuredClone(store.snapshot());
    unsafeDocument.connectionPresets[0].apiKey = 'never-return-this';
    assert.throws(() => deriveEffectiveFeatureBinding(unsafeDocument, 'groups_forum'), (error) => {
        assert.equal(error.code, 'UNSAFE_BINDING_DOCUMENT');
        assert.equal(error.message.includes('never-return-this'), false);
        return true;
    });
});

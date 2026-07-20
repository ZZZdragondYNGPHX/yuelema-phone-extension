import assert from 'node:assert/strict';
import test from 'node:test';
import {
    FUNCTION_KEYS,
    MAX_SERIALIZED_BYTES,
    SETTINGS_STORAGE_KEY,
    YueLeMaSettingsError,
    createMemoryStorage,
    createSettingsStore,
    normalizePromptPreset,
} from '../settings-store.js';

function connection(id, name = id) {
    return {
        id,
        name,
        url: 'https://api.example.invalid/v1',
        model: `${id}-model`,
        temperature: 0.6,
        maxTokens: 256,
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
        content: `提示词-${id}`,
    };
}

function errorCode(code) {
    return (error) => error instanceof YueLeMaSettingsError && error.code === code;
}

test('默认内存存储与预设 CRUD、默认策略、功能回退', () => {
    const storage = createMemoryStorage();
    const store = createSettingsStore({ storage });
    const initial = store.load();
    assert.equal(initial.schema, 'yuelema.settings');
    assert.equal(initial.schemaVersion, 4);
    assert.deepEqual(initial.personalization, { enabled: true, keywordWeights: [] });
    assert.equal(initial.connectionPresets.length, 0);
    assert.equal(initial.promptPresets.length, 12);
    assert.ok(initial.promptPresets.every((preset) => preset.id.startsWith('builtin_')));
    assert.equal(initial.promptPresets.filter((preset) => preset.contentMode === 'SFW').length, 6);
    assert.equal(initial.promptPresets.filter((preset) => preset.contentMode === 'NSFW').length, 6);
    assert.match(initial.promptPresets.find((preset) => preset.id === 'builtin_recommendation_sfw').content, /仅好友资料、隐藏资料和与玩家关系/u);
    assert.match(initial.promptPresets.find((preset) => preset.id === 'builtin_recommendation_nsfw').content, /仅好友资料、隐藏资料和与玩家关系/u);
    assert.deepEqual(Object.keys(initial.functionBindings), FUNCTION_KEYS);
    assert.deepEqual(Object.keys(initial.functionModeBindings), FUNCTION_KEYS);
    assert.equal(storage.getItem(SETTINGS_STORAGE_KEY) !== null, true, '首次加载应把可编辑默认预设写入本地非机密设置');

    store.addConnectionPreset(connection('fast'));
    store.addConnectionPreset(connection('smart'));
    store.addPromptPreset(prompt('chat_base'));
    store.addPromptPreset(prompt('match_base'));
    assert.equal(store.snapshot().defaults.connectionPresetId, 'fast');
    assert.equal(store.snapshot().defaults.promptPresetId, 'chat_base');

    store.bindFunction('chat', { connectionPresetId: 'smart', promptPresetId: 'chat_base' });
    store.bindFunction('recommendation_refresh', { promptPresetId: 'match_base' });
    const chat = store.resolveFunction('chat');
    assert.equal(chat.connectionPreset.id, 'smart');
    assert.equal(chat.promptPreset.id, 'chat_base');
    assert.equal(chat.usedDefaultConnectionPreset, false);
    const refresh = store.resolveFunction('recommendation_refresh');
    assert.equal(refresh.connectionPreset.id, 'fast');
    assert.equal(refresh.promptPreset.id, 'match_base');
    assert.equal(refresh.usedDefaultConnectionPreset, true);

    store.editConnectionPreset({ ...connection('smart', '聪明模型'), maxTokens: 1024 });
    assert.equal(store.resolveFunction('chat').connectionPreset.name, '聪明模型');
    store.setDefaults({ connectionPresetId: 'smart', promptPresetId: 'match_base' });
    store.deleteConnectionPreset('smart');
    const afterDelete = store.snapshot();
    assert.equal(afterDelete.defaults.connectionPresetId, 'fast');
    assert.equal(afterDelete.functionBindings.chat.connectionPresetId, null);
    assert.equal(store.resolveFunction('chat').connectionPreset.id, 'fast');

    store.deletePromptPreset('chat_base');
    assert.equal(store.snapshot().functionBindings.chat.promptPresetId, null);
    assert.equal(store.resolveFunction('chat').promptPreset.id, 'match_base');
    assert.ok(storage.getItem(SETTINGS_STORAGE_KEY));
});

test('导入导出保持严格 schema，并拒绝密钥、原型键、未知字段和无效绑定', () => {
    const storage = createMemoryStorage();
    const store = createSettingsStore({ storage });
    store.addConnectionPreset(connection('fast'));
    store.addPromptPreset(prompt('chat_base'));
    store.bindFunction('chat', { connectionPresetId: 'fast', promptPresetId: 'chat_base' });
    const before = store.exportJson();
    const imported = createSettingsStore({ storage: createMemoryStorage() });
    imported.importJson(before);
    assert.equal(imported.resolveFunction('chat').connectionPreset.id, 'fast');
    assert.equal(imported.exportJson(), before);
    assert.equal(before.includes('apiKey'), false);
    assert.deepEqual(JSON.parse(before).personalization, { enabled: true, keywordWeights: [] });

    const withSecret = JSON.stringify({
        ...JSON.parse(before),
        apiKey: 'must-not-appear',
    });
    assert.throws(() => imported.importJson(withSecret), errorCode('UNSAFE_INPUT'));
    assert.equal(imported.exportJson(), before);

    // JSON parse makes __proto__ an own untrusted property; do not construct it through object literal syntax.
    const maliciousJson = '{"schema":"yuelema.settings","schemaVersion":1,"connectionPresets":[],"promptPresets":[{"id":"p","name":"p","depth":0,"order":0,"position":"after_character_definition","enabled":true,"content":"x","__proto__":{}}],"defaults":{"connectionPresetId":null,"promptPresetId":null},"functionBindings":{}}';
    assert.throws(() => imported.importJson(maliciousJson), errorCode('UNSAFE_INPUT'));

    const unknownField = JSON.parse(before);
    unknownField.functionBindings.chat.extra = 'no';
    assert.throws(() => imported.importJson(JSON.stringify(unknownField)), errorCode('INVALID_BINDING'));
    const unknownTarget = JSON.parse(before);
    unknownTarget.functionBindings.chat.connectionPresetId = 'missing';
    assert.throws(() => imported.importJson(JSON.stringify(unknownTarget)), errorCode('UNKNOWN_PRESET_ID'));
});

test('连接预设传输模式可持久化，旧 v2 缺失字段默认迁移为 json', () => {
    const storage = createMemoryStorage();
    const store = createSettingsStore({ storage });
    store.addConnectionPreset({ ...connection('streaming'), transportMode: 'stream' });
    store.addConnectionPreset({ ...connection('pseudo'), transportMode: 'pseudo_stream' });

    const saved = JSON.parse(store.exportJson());
    assert.equal(saved.connectionPresets[0].transportMode, 'stream');
    assert.equal(saved.connectionPresets[1].transportMode, 'pseudo_stream');
    assert.equal(createSettingsStore({ storage }).load().connectionPresets[0].transportMode, 'stream');

    const legacyV2 = {
        schema: 'yuelema.settings',
        schemaVersion: 2,
        connectionPresets: [{
            id: 'legacy_v2',
            name: '旧 v2 连接',
            url: 'https://api.example.invalid/v1',
            model: 'legacy-model',
            temperature: 0.7,
            maxTokens: 512,
            timeoutMs: 30_000,
        }],
        promptPresets: [],
        defaults: { connectionPresetId: 'legacy_v2', promptPresetId: null },
        functionBindings: {},
        personalization: { enabled: true, keywordWeights: [] },
    };
    const migrated = createSettingsStore({ storage: createMemoryStorage() });
    assert.equal(migrated.importJson(JSON.stringify(legacyV2)).connectionPresets[0].transportMode, 'json');
    assert.equal(JSON.parse(migrated.exportJson()).connectionPresets[0].transportMode, 'json');

    assert.throws(
        () => store.addConnectionPreset({ ...connection('invalid'), transportMode: 'automatic' }),
        (error) => error?.code === 'INVALID_PRESET',
    );
});

test('历史角色创作绑定迁移为两个独立入口，灵魂与文字匹配保持独立', () => {
    const historical = {
        schema: 'yuelema.settings',
        schemaVersion: 2,
        connectionPresets: [connection('fast'), connection('smart')],
        promptPresets: [prompt('base'), prompt('creative')],
        defaults: { connectionPresetId: 'fast', promptPresetId: 'base' },
        functionBindings: {
            character_authoring: { connectionPresetId: 'smart', promptPresetId: 'creative' },
            soul_match: { connectionPresetId: 'fast', promptPresetId: 'base' },
            text_match: { connectionPresetId: 'smart', promptPresetId: 'creative' },
        },
        personalization: { enabled: true, keywordWeights: [] },
    };
    const store = createSettingsStore({ storage: createMemoryStorage() });
    store.importJson(JSON.stringify(historical));
    assert.deepEqual(store.snapshot().functionBindings.character_ai_completion, { connectionPresetId: 'smart', promptPresetId: 'creative' });
    assert.deepEqual(store.snapshot().functionBindings.character_full_authoring, { connectionPresetId: 'smart', promptPresetId: 'creative' });
    assert.deepEqual(store.snapshot().functionBindings.soul_match, { connectionPresetId: 'fast', promptPresetId: 'base' });
    assert.deepEqual(store.snapshot().functionBindings.text_match, { connectionPresetId: 'smart', promptPresetId: 'creative' });

    store.bindFunction('soul_match', { connectionPresetId: 'smart', promptPresetId: 'base' });
    assert.deepEqual(store.snapshot().functionBindings.soul_match, { connectionPresetId: 'smart', promptPresetId: 'base' });
    assert.deepEqual(store.snapshot().functionBindings.text_match, { connectionPresetId: 'smart', promptPresetId: 'creative' });

    const explicitCompletion = createSettingsStore({ storage: createMemoryStorage() });
    explicitCompletion.importJson(JSON.stringify({
        ...historical,
        functionBindings: {
            ...historical.functionBindings,
            character_ai_completion: { connectionPresetId: null, promptPresetId: null },
        },
    }));
    assert.deepEqual(explicitCompletion.snapshot().functionBindings.character_ai_completion, { connectionPresetId: null, promptPresetId: null });
    assert.deepEqual(explicitCompletion.snapshot().functionBindings.character_full_authoring, { connectionPresetId: 'smart', promptPresetId: 'creative' });
});

test('个性化内容推荐设置本地持久化，开放关键词可先以 0 收录再由公开反馈增量更新且不接入功能绑定', () => {
    const storage = createMemoryStorage();
    const store = createSettingsStore({ storage });
    store.setPersonalizationKeywordWeights([
        { keyword: '电影', weight: 4 },
        { keyword: '夜猫子', weight: -2 },
    ]);
    store.setPersonalizationEnabled(false);

    const snapshot = store.snapshot();
    assert.deepEqual(snapshot.personalization, {
        enabled: false,
        keywordWeights: [{ keyword: '电影', weight: 4 }, { keyword: '夜猫子', weight: -2 }],
    });
    assert.equal(Object.hasOwn(snapshot.functionBindings, 'personalization'), false);

    const reloaded = createSettingsStore({ storage });
    assert.deepEqual(reloaded.load().personalization, snapshot.personalization);
    assert.throws(() => store.setPersonalizationEnabled('false'), errorCode('INVALID_PERSONALIZATION'));
    assert.throws(() => store.setPersonalizationKeywordWeights([{ keyword: '电影', weight: 6 }]), errorCode('INVALID_SETTINGS'));
    assert.throws(() => store.setPersonalizationKeywordWeights([{ keyword: '电影', weight: 1 }, { keyword: '电影', weight: 2 }]), errorCode('INVALID_PERSONALIZATION'));
    assert.throws(() => store.setPersonalizationKeywordWeights([{ keyword: '电影', weight: 1, apiKey: 'secret' }]), errorCode('UNSAFE_INPUT'));

    const activeStore = createSettingsStore({ storage: createMemoryStorage() });
    activeStore.setPersonalizationKeywordWeights([{ keyword: '电影', weight: 4 }]);
    activeStore.ensurePersonalizationKeywordWeights(['电影', '摄影', '手冲咖啡']);
    assert.deepEqual(activeStore.snapshot().personalization.keywordWeights, [
        { keyword: '电影', weight: 4 },
        { keyword: '摄影', weight: 0 },
        { keyword: '手冲咖啡', weight: 0 },
    ]);
    activeStore.applyPersonalizationKeywordWeightDelta(['电影', '摄影'], 3);
    assert.deepEqual(activeStore.snapshot().personalization.keywordWeights, [
        { keyword: '电影', weight: 5 },
        { keyword: '摄影', weight: 3 },
        { keyword: '手冲咖啡', weight: 0 },
    ]);
    activeStore.setPersonalizationEnabled(false);
    activeStore.ensurePersonalizationKeywordWeights(['旅行']);
    activeStore.applyPersonalizationKeywordWeightDelta(['电影'], -3);
    assert.deepEqual(activeStore.snapshot().personalization.keywordWeights, [
        { keyword: '电影', weight: 5 },
        { keyword: '摄影', weight: 3 },
        { keyword: '手冲咖啡', weight: 0 },
    ], '关闭个性化时，成功的 MVU 交互不应继续改写设备偏好。');
    assert.throws(() => activeStore.applyPersonalizationKeywordWeightDelta(['电影'], 0), errorCode('INVALID_PERSONALIZATION'));
    assert.throws(() => activeStore.ensurePersonalizationKeywordWeights('电影'), errorCode('INVALID_PERSONALIZATION'));
});

test('schema v1 设置可安全迁移到 v4 个性化字段、默认提示词与模式绑定，导出固定为当前版本', () => {
    const legacy = {
        schema: 'yuelema.settings',
        schemaVersion: 1,
        connectionPresets: [connection('fast')],
        promptPresets: [prompt('base')],
        defaults: { connectionPresetId: 'fast', promptPresetId: 'base' },
        functionBindings: {},
    };
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const migrated = store.importJson(JSON.stringify(legacy));
    assert.equal(migrated.schemaVersion, 4);
    assert.deepEqual(migrated.personalization, { enabled: true, keywordWeights: [] });
    assert.equal(migrated.promptPresets.filter((preset) => preset.id.startsWith('builtin_')).length, 12);
    assert.equal(store.resolveFunction('chat', { contentMode: 'SFW' }).promptPreset.id, 'base', '已有默认提示词应优先保留');
    assert.equal(store.resolveFunction('chat', { contentMode: 'NSFW' }).promptPreset.id, 'builtin_private_chat_nsfw', '旧 SFW 默认提示词不得泄漏到 NSFW 绑定');
    assert.equal(JSON.parse(store.exportJson()).schemaVersion, 4);
});

test('schema v3 迁移补齐提示词模式，并修复历史跨模式绑定', () => {
    const legacySfw = prompt('legacy_sfw', '旧 SFW 提示词');
    delete legacySfw.contentMode;
    const legacyV3 = {
        schema: 'yuelema.settings',
        schemaVersion: 3,
        connectionPresets: [connection('fast')],
        promptPresets: [legacySfw],
        defaults: { connectionPresetId: 'fast', promptPresetId: 'legacy_sfw' },
        functionBindings: {
            chat: { connectionPresetId: 'fast', promptPresetId: 'legacy_sfw' },
        },
        functionModeBindings: {
            chat: {
                SFW: { connectionPresetId: 'fast', promptPresetId: 'legacy_sfw' },
                NSFW: { connectionPresetId: 'fast', promptPresetId: 'legacy_sfw' },
            },
        },
        personalization: { enabled: true, keywordWeights: [] },
    };
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const migrated = store.importJson(JSON.stringify(legacyV3));

    assert.equal(migrated.schemaVersion, 4);
    assert.equal(migrated.promptPresets.find((preset) => preset.id === 'legacy_sfw').contentMode, 'SFW');
    assert.equal(migrated.promptPresets.filter((preset) => preset.id.startsWith('builtin_')).length, 12);
    assert.equal(store.resolveFunction('chat', { contentMode: 'SFW' }).promptPreset.id, 'legacy_sfw');
    assert.equal(store.resolveFunction('chat', { contentMode: 'NSFW' }).promptPreset.id, 'builtin_private_chat_nsfw');
});

test('提示词字段、纯文本大小限制与安全错误不会回显凭据', () => {
    assert.deepEqual(normalizePromptPreset(prompt('p')), prompt('p'));
    assert.throws(() => normalizePromptPreset({ ...prompt('p'), position: 'middle' }), errorCode('INVALID_PROMPT_PRESET'));
    assert.throws(() => normalizePromptPreset({ ...prompt('p'), enabled: 'true' }), errorCode('INVALID_PROMPT_PRESET'));
    assert.throws(() => normalizePromptPreset({ ...prompt('p'), content: 'x'.repeat(12_001) }), errorCode('INVALID_SETTINGS'));

    const store = createSettingsStore();
    assert.throws(() => store.addConnectionPreset({ ...connection('unsafe'), authorization: 'Bearer never-export-me' }), (error) => {
        assert.equal(error.code, 'UNSAFE_INPUT');
        assert.equal(error.message.includes('never-export-me'), false);
        return true;
    });
    assert.throws(() => store.importJson('x'.repeat(MAX_SERIALIZED_BYTES + 1)), errorCode('SETTINGS_TOO_LARGE'));
    assert.throws(() => store.importJson('{'), errorCode('INVALID_IMPORT_JSON'));
});

test('清理会重建可编辑默认预设且不触及会话密钥模块', () => {
    const storage = createMemoryStorage();
    const store = createSettingsStore({ storage });
    store.addConnectionPreset(connection('fast'));
    assert.notEqual(storage.getItem(SETTINGS_STORAGE_KEY), null);
    const cleared = store.clear();
    assert.notEqual(storage.getItem(SETTINGS_STORAGE_KEY), null);
    assert.equal(cleared.connectionPresets.length, 0);
    assert.equal(cleared.promptPresets.length, 12);
});

test('SFW/NSFW 功能绑定独立解析，默认预设可在本地删除且引用会被清理', () => {
    const storage = createMemoryStorage();
    const store = createSettingsStore({ storage });
    store.load();
    store.addConnectionPreset(connection('fast'));
    store.addConnectionPreset(connection('smart'));

    assert.equal(store.resolveFunction('chat', { contentMode: 'SFW' }).promptPreset.id, 'builtin_private_chat_sfw');
    assert.equal(store.resolveFunction('chat', { contentMode: 'NSFW' }).promptPreset.id, 'builtin_private_chat_nsfw');
    store.bindFunctionForContentMode('chat', 'SFW', { connectionPresetId: 'fast', promptPresetId: 'builtin_private_chat_sfw' });
    store.bindFunctionForContentMode('chat', 'NSFW', { connectionPresetId: 'smart', promptPresetId: 'builtin_private_chat_nsfw' });
    assert.equal(store.resolveFunction('chat', { contentMode: 'SFW' }).connectionPreset.id, 'fast');
    assert.equal(store.resolveFunction('chat', { contentMode: 'NSFW' }).connectionPreset.id, 'smart');
    assert.throws(() => store.resolveFunction('chat', { contentMode: 'OTHER' }), errorCode('INVALID_CONTENT_MODE'));
    assert.throws(() => store.bindFunctionForContentMode('chat', 'NSFW', {
        connectionPresetId: 'smart', promptPresetId: 'builtin_private_chat_sfw',
    }), errorCode('PROMPT_MODE_MISMATCH'));
    assert.equal(store.resolveFunction('soul_match', { contentMode: 'SFW' }).promptPreset.id, 'builtin_soul_match_sfw');
    assert.equal(store.resolveFunction('text_match', { contentMode: 'NSFW' }).promptPreset.id, 'builtin_voice_match_nsfw');

    store.deletePromptPreset('builtin_private_chat_nsfw');
    assert.equal(store.snapshot().functionModeBindings.chat.NSFW.promptPresetId, null);
    assert.equal(store.resolveFunction('chat', { contentMode: 'NSFW' }).promptPreset, null);
});

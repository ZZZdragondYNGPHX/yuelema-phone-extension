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
    };
}

function prompt(id, name = id) {
    return {
        id,
        name,
        depth: 4,
        order: 100,
        position: 'after_character_definition',
        enabled: true,
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
    assert.equal(initial.schemaVersion, 1);
    assert.equal(initial.connectionPresets.length, 0);
    assert.deepEqual(Object.keys(initial.functionBindings), FUNCTION_KEYS);

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

test('清理会移除持久化但不触及会话密钥模块', () => {
    const storage = createMemoryStorage();
    const store = createSettingsStore({ storage });
    store.addConnectionPreset(connection('fast'));
    assert.notEqual(storage.getItem(SETTINGS_STORAGE_KEY), null);
    const cleared = store.clear();
    assert.equal(storage.getItem(SETTINGS_STORAGE_KEY), null);
    assert.equal(cleared.connectionPresets.length, 0);
});



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
import { getFeatureBindingSurface } from '../feature-binding.js';

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

test('专属服务设置表面稳定映射到独立 service_profile_generation 功能键', () => {
    assert.deepEqual(getFeatureBindingSurface('service_profiles'), {
        id: 'service_profiles',
        functionKey: 'service_profile_generation',
    });
});
test('默认内存存储与预设 CRUD、默认策略、功能回退', () => {
    const storage = createMemoryStorage();
    const store = createSettingsStore({ storage });
    const initial = store.load();
    assert.equal(initial.schema, 'yuelema.settings');
    assert.equal(initial.schemaVersion, 17);
    assert.deepEqual(initial.personalization, { enabled: true, keywordWeightsByMode: { SFW: [], NSFW: [] } });
    assert.equal(initial.connectionPresets.length, 0);
    assert.equal(initial.promptPresets.length, 22);
    assert.ok(initial.promptPresets.every((preset) => preset.id.startsWith('builtin_')));
    assert.equal(initial.promptPresets.filter((preset) => preset.contentMode === 'SFW').length, 11);
    assert.equal(initial.promptPresets.filter((preset) => preset.contentMode === 'NSFW').length, 11);
    assert.deepEqual(initial.chatSummary, { enabled: false, interval: 20, retryLimit: 2 });
    assert.match(initial.promptPresets.find((preset) => preset.id === 'builtin_recommendation_sfw').content, /仅好友资料、隐藏资料和与玩家关系/u);
    assert.match(initial.promptPresets.find((preset) => preset.id === 'builtin_recommendation_nsfw').content, /仅好友资料、隐藏资料和与玩家关系/u);
    assert.equal(initial.functionModeBindings.group_chat.SFW.promptPresetId, 'builtin_group_chat_sfw');
    assert.equal(initial.functionModeBindings.group_chat.NSFW.promptPresetId, 'builtin_group_chat_nsfw');
    assert.equal(initial.functionModeBindings.forum.SFW.promptPresetId, 'builtin_forum_sfw');
    assert.equal(initial.functionModeBindings.forum.NSFW.promptPresetId, 'builtin_forum_nsfw');
    assert.equal(initial.functionModeBindings.service_profile_generation.SFW.promptPresetId, 'builtin_service_profile_sfw');
    assert.equal(initial.functionModeBindings.service_profile_generation.NSFW.promptPresetId, 'builtin_service_profile_nsfw');
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

test('对话总结设置独立持久化、严格限制开关、轮次与重试次数', () => {
    const storage = createMemoryStorage();
    const store = createSettingsStore({ storage });
    assert.deepEqual(store.getChatSummarySettings(), { enabled: false, interval: 20, retryLimit: 2 });
    store.setChatSummarySettings({ enabled: true, interval: 12, retryLimit: 3 });
    assert.deepEqual(store.getChatSummarySettings(), { enabled: true, interval: 12, retryLimit: 3 });
    assert.deepEqual(createSettingsStore({ storage }).getChatSummarySettings(), { enabled: true, interval: 12, retryLimit: 3 });
    assert.throws(() => store.setChatSummarySettings({ enabled: true, interval: 1, retryLimit: 3 }), errorCode('INVALID_CHAT_SUMMARY'));
    assert.throws(() => store.setChatSummarySettings({ enabled: 'true', interval: 12, retryLimit: 3 }), errorCode('INVALID_CHAT_SUMMARY'));
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
    assert.deepEqual(JSON.parse(before).personalization, { enabled: true, keywordWeightsByMode: { SFW: [], NSFW: [] } });

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

test('连接预设传输模式可持久化并严格校验', () => {
    const storage = createMemoryStorage();
    const store = createSettingsStore({ storage });
    store.addConnectionPreset({ ...connection('streaming'), transportMode: 'stream' });
    store.addConnectionPreset({ ...connection('pseudo'), transportMode: 'pseudo_stream' });

    const saved = JSON.parse(store.exportJson());
    assert.equal(saved.connectionPresets[0].transportMode, 'stream');
    assert.equal(saved.connectionPresets[1].transportMode, 'pseudo_stream');
    assert.equal(createSettingsStore({ storage }).load().connectionPresets[0].transportMode, 'stream');


    assert.throws(
        () => store.addConnectionPreset({ ...connection('invalid'), transportMode: 'automatic' }),
        (error) => error?.code === 'INVALID_PRESET',
    );
});

test('旧 settings schema v1-v10 统一拒绝且不覆盖当前 v17 设置', () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const current = store.load();
    const before = store.exportJson();

    for (const schemaVersion of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
        const legacy = structuredClone(current);
        legacy.schemaVersion = schemaVersion;
        assert.throws(() => store.importJson(JSON.stringify(legacy)), errorCode('UNSUPPORTED_SETTINGS_VERSION'));
        assert.equal(store.exportJson(), before);
    }
});

test('v11-v14 设置在加载与导入时迁移到 v17：内置提示词刷新为新文案，自定义预设保留', () => {
    for (const legacyVersion of [11, 12, 13, 14]) {
        const seedStore = createSettingsStore({ storage: createMemoryStorage() });
        seedStore.load();
        seedStore.addPromptPreset(prompt('custom_keep', '自定义预设', 'NSFW'));
        const legacy = JSON.parse(seedStore.exportJson());
        legacy.schemaVersion = legacyVersion;
        const staleContent = '旧版内置文案：只做许可不做指导。';
        for (const preset of legacy.promptPresets) {
            if (preset.id === 'builtin_private_chat_nsfw' || preset.id === 'builtin_recommendation_sfw') {
                preset.content = staleContent;
            }
        }

        const seeded = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(legacy) });
        const migrated = createSettingsStore({ storage: seeded }).load();
        assert.equal(migrated.schemaVersion, 17);
        assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_private_chat_nsfw').content, /露骨文爱/u);
        assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_private_chat_nsfw').content, /欲擒故纵/u, '迁移后应带上 v13 情色写作指导');
        assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_recommendation_sfw').content, /本模式保持日常社交尺度/u);
        assert.equal(migrated.promptPresets.some((preset) => preset.content === staleContent), false);
        assert.equal(migrated.promptPresets.find((preset) => preset.id === 'custom_keep').content, '提示词-custom_keep');
        assert.equal(JSON.parse(seeded.getItem(SETTINGS_STORAGE_KEY)).schemaVersion, 17, '迁移结果必须落盘为 v17');

        const imported = createSettingsStore({ storage: createMemoryStorage() });
        const result = imported.importJson(JSON.stringify(legacy));
        assert.equal(result.schemaVersion, 17);
        assert.match(result.promptPresets.find((preset) => preset.id === 'builtin_private_chat_nsfw').content, /露骨文爱/u);
        assert.match(result.promptPresets.find((preset) => preset.id === 'builtin_private_chat_nsfw').content, /欲擒故纵/u);
        assert.equal(result.promptPresets.find((preset) => preset.id === 'custom_keep').content, '提示词-custom_keep');
    }
});

test('v13→v14 迁移把「语音匹配」内置预设改名为「描述匹配」，ID 与用户绑定保持不变', () => {
    const seedStore = createSettingsStore({ storage: createMemoryStorage() });
    seedStore.load();
    seedStore.addPromptPreset(prompt('custom_text_match_nsfw', '自定义描述匹配预设', 'NSFW'));
    seedStore.bindFunctionForContentMode('text_match', 'NSFW', {
        connectionPresetId: null,
        promptPresetId: 'custom_text_match_nsfw',
    });
    const legacy = JSON.parse(seedStore.exportJson());
    legacy.schemaVersion = 13;
    for (const preset of legacy.promptPresets) {
        if (preset.id === 'builtin_voice_match_sfw') {
            preset.name = '内置·语音匹配·SFW';
            preset.content = '旧版语音匹配 SFW 文案。';
        }
        if (preset.id === 'builtin_voice_match_nsfw') {
            preset.name = '内置·语音匹配·NSFW';
            preset.content = '旧版语音匹配 NSFW 文案。';
        }
    }

    const seeded = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(legacy) });
    const migrated = createSettingsStore({ storage: seeded }).load();
    assert.equal(migrated.schemaVersion, 17);
    const sfw = migrated.promptPresets.find((preset) => preset.id === 'builtin_voice_match_sfw');
    const nsfw = migrated.promptPresets.find((preset) => preset.id === 'builtin_voice_match_nsfw');
    assert.equal(sfw.name, '内置·描述匹配·SFW', '迁移后 SFW 内置预设显示名应改为描述匹配');
    assert.equal(nsfw.name, '内置·描述匹配·NSFW', '迁移后 NSFW 内置预设显示名应改为描述匹配');
    assert.match(sfw.content, /描述匹配/u);
    assert.doesNotMatch(sfw.content, /语音匹配/u);
    assert.doesNotMatch(nsfw.content, /语音匹配/u);
    assert.equal(migrated.promptPresets.some((preset) => /语音匹配/u.test(preset.name) && preset.id.startsWith('builtin_')), false);
    assert.equal(
        migrated.functionModeBindings.text_match.SFW.promptPresetId,
        'builtin_voice_match_sfw',
        '默认 SFW 描述匹配绑定沿用稳定的 builtin_voice_match_sfw ID',
    );
    assert.equal(
        migrated.functionModeBindings.text_match.NSFW.promptPresetId,
        'custom_text_match_nsfw',
        '用户自定义的 text_match 绑定在迁移后必须原样保留',
    );
    const reloaded = createSettingsStore({ storage: seeded }).load();
    assert.equal(reloaded.promptPresets.find((preset) => preset.id === 'builtin_voice_match_sfw').name, '内置·描述匹配·SFW');
});

test('v14→当前版本迁移刷新全部 SFW 内置文案：NSFW 内置与用户自建逐字保留，被删除的内置不复活', () => {
    const seedStore = createSettingsStore({ storage: createMemoryStorage() });
    seedStore.load();
    seedStore.addPromptPreset(prompt('custom_sfw_keep', '自定义 SFW 预设', 'SFW'));
    seedStore.deletePromptPreset('builtin_image_match_sfw');
    const legacy = JSON.parse(seedStore.exportJson());
    legacy.schemaVersion = 14;
    const staleSfw = '旧版 v14 SFW 文案：粗糙滞后，等待质量升级。';
    const nsfwBefore = new Map();
    for (const preset of legacy.promptPresets) {
        if (!preset.id.startsWith('builtin_')) continue;
        if (preset.contentMode === 'SFW') preset.content = staleSfw;
        if (preset.contentMode === 'NSFW') nsfwBefore.set(preset.id, preset.content);
    }
    assert.equal(nsfwBefore.size, 11, '基线应覆盖全部 11 个 NSFW 内置预设');

    const seeded = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(legacy) });
    const migrated = createSettingsStore({ storage: seeded }).load();
    assert.equal(migrated.schemaVersion, 17);
    assert.equal(migrated.promptPresets.some((preset) => preset.content === staleSfw), false, '全部 SFW 内置文案都应刷新为 v15 新文案');
    assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_private_chat_sfw').content, /只要尊重已知边界，就不是冒犯/u, '私聊 SFW 应带上友好直白宽容条款');
    assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_recommendation_sfw').content, /基础匹配硬条件/u, '推荐 SFW 应带上性别硬条件提醒');
    for (const [id, content] of nsfwBefore) {
        assert.equal(migrated.promptPresets.find((preset) => preset.id === id).content, content, `${id} 的 NSFW 文案必须逐字保留`);
    }
    assert.equal(migrated.promptPresets.find((preset) => preset.id === 'custom_sfw_keep').content, '提示词-custom_sfw_keep', '用户自建预设必须逐字保留');
    assert.equal(migrated.promptPresets.some((preset) => preset.id === 'builtin_image_match_sfw'), false, '用户删除的内置预设不得复活');
    assert.equal(migrated.functionModeBindings.image_match.SFW.promptPresetId, null, '删除内置后的空绑定不得被迁移改写');
    assert.equal(migrated.functionModeBindings.chat.SFW.promptPresetId, 'builtin_private_chat_sfw', '既有绑定 ID 迁移后保持原样');
    assert.equal(JSON.parse(seeded.getItem(SETTINGS_STORAGE_KEY)).schemaVersion, 17, '迁移结果必须落盘为 v17');
});

test('v15→v17 迁移补入独立 ComfyUI 配置、刷新服务内置提示词且不改写自定义提示词', () => {
    const seedStore = createSettingsStore({ storage: createMemoryStorage() });
    seedStore.load();
    seedStore.addPromptPreset(prompt('custom_v15_keep', '自定义 v15 预设', 'SFW'));
    const legacy = JSON.parse(seedStore.exportJson());
    legacy.schemaVersion = 15;
    legacy.imageGeneration.baseUrl = 'https://images.example.invalid';
    legacy.imageGeneration.model = 'nai-model-kept';
    for (const key of Object.keys(legacy.imageGeneration)) {
        if (key.startsWith('comfy') && key !== 'comfyWorkflow') delete legacy.imageGeneration[key];
    }
    legacy.imageGeneration.comfyWorkflow = '';

    const migrated = createSettingsStore({
        storage: createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(legacy) }),
    }).load();
    assert.equal(migrated.schemaVersion, 17);
    assert.equal(migrated.imageGeneration.baseUrl, 'https://images.example.invalid');
    assert.equal(migrated.imageGeneration.model, 'nai-model-kept');
    assert.equal(migrated.imageGeneration.comfyBaseUrl, 'http://127.0.0.1:8188');
    assert.equal(migrated.imageGeneration.comfySampler, 'euler');
    assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_service_profile_sfw').content, /最高优先级硬条件/u);
    assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_service_profile_nsfw').content, /双向性别\/性取向兼容/u);
    assert.equal(migrated.promptPresets.find((preset) => preset.id === 'custom_v15_keep').content, '提示词-custom_v15_keep');
});

test('v16→v17 只刷新仍存在的服务内置提示词，不复活删除项或改写自定义预设', () => {
    const seedStore = createSettingsStore({ storage: createMemoryStorage() });
    seedStore.load();
    seedStore.addPromptPreset(prompt('custom_v16_keep', '自定义 v16 预设', 'SFW'));
    seedStore.deletePromptPreset('builtin_service_profile_nsfw');
    const legacy = JSON.parse(seedStore.exportJson());
    legacy.schemaVersion = 16;
    legacy.promptPresets.find((preset) => preset.id === 'builtin_service_profile_sfw').content = '旧版约伴 SFW 提示词。';

    const seeded = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(legacy) });
    const migrated = createSettingsStore({ storage: seeded }).load();
    assert.equal(migrated.schemaVersion, 17);
    assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_service_profile_sfw').content, /最高优先级硬条件/u);
    assert.equal(migrated.promptPresets.some((preset) => preset.id === 'builtin_service_profile_nsfw'), false);
    assert.equal(migrated.promptPresets.find((preset) => preset.id === 'custom_v16_keep').content, '提示词-custom_v16_keep');
    assert.equal(JSON.parse(seeded.getItem(SETTINGS_STORAGE_KEY)).schemaVersion, 17);
});

test('个性化关键词权重按 SFW/NSFW 独立持久化、收录和增量更新', () => {
    const storage = createMemoryStorage();
    const store = createSettingsStore({ storage });
    store.setPersonalizationKeywordWeights('SFW', [
        { keyword: '电影', weight: 4 },
        { keyword: '夜猫子', weight: -2 },
    ]);
    store.setPersonalizationKeywordWeights('NSFW', [{ keyword: '成年人话题', weight: 3 }]);
    store.setPersonalizationEnabled(false);

    const snapshot = store.snapshot();
    assert.deepEqual(snapshot.personalization, {
        enabled: false,
        keywordWeightsByMode: {
            SFW: [{ keyword: '电影', weight: 4 }, { keyword: '夜猫子', weight: -2 }],
            NSFW: [{ keyword: '成年人话题', weight: 3 }],
        },
    });
    assert.equal(Object.hasOwn(snapshot.functionBindings, 'personalization'), false);
    assert.deepEqual(createSettingsStore({ storage }).load().personalization, snapshot.personalization);

    assert.throws(() => store.setPersonalizationEnabled('false'), errorCode('INVALID_PERSONALIZATION'));
    assert.throws(() => store.setPersonalizationKeywordWeights('OTHER', []), errorCode('INVALID_CONTENT_MODE'));
    assert.throws(() => store.setPersonalizationKeywordWeights('SFW', [{ keyword: '电影', weight: 6 }]), errorCode('INVALID_SETTINGS'));
    assert.throws(() => store.setPersonalizationKeywordWeights('SFW', [{ keyword: '电影', weight: 1 }, { keyword: '电影', weight: 2 }]), errorCode('INVALID_PERSONALIZATION'));
    assert.throws(() => store.setPersonalizationKeywordWeights('SFW', [{ keyword: '电影', weight: 1, apiKey: 'secret' }]), errorCode('UNSAFE_INPUT'));

    const activeStore = createSettingsStore({ storage: createMemoryStorage() });
    activeStore.setPersonalizationKeywordWeights('SFW', [{ keyword: '电影', weight: 4 }]);
    activeStore.setPersonalizationKeywordWeights('NSFW', [{ keyword: '电影', weight: -4 }]);
    activeStore.ensurePersonalizationKeywordWeights('SFW', ['电影', '摄影', '手冲咖啡']);
    assert.deepEqual(activeStore.snapshot().personalization.keywordWeightsByMode.SFW, [
        { keyword: '电影', weight: 4 },
        { keyword: '摄影', weight: 0 },
        { keyword: '手冲咖啡', weight: 0 },
    ]);
    assert.deepEqual(activeStore.snapshot().personalization.keywordWeightsByMode.NSFW, [{ keyword: '电影', weight: -4 }]);

    activeStore.applyPersonalizationKeywordWeightDelta('SFW', ['电影', '摄影'], 3);
    activeStore.applyPersonalizationKeywordWeightDelta('NSFW', ['电影', '欲望'], -1);
    assert.deepEqual(activeStore.snapshot().personalization.keywordWeightsByMode.SFW, [
        { keyword: '电影', weight: 5 },
        { keyword: '摄影', weight: 3 },
        { keyword: '手冲咖啡', weight: 0 },
    ]);
    assert.deepEqual(activeStore.snapshot().personalization.keywordWeightsByMode.NSFW, [
        { keyword: '电影', weight: -5 },
        { keyword: '欲望', weight: -1 },
    ]);

    activeStore.setPersonalizationEnabled(false);
    activeStore.ensurePersonalizationKeywordWeights('SFW', ['旅行']);
    activeStore.applyPersonalizationKeywordWeightDelta('NSFW', ['电影'], 3);
    assert.equal(activeStore.snapshot().personalization.keywordWeightsByMode.SFW.some((item) => item.keyword === '旅行'), false);
    assert.equal(activeStore.snapshot().personalization.keywordWeightsByMode.NSFW[0].weight, -5);
    assert.throws(() => activeStore.applyPersonalizationKeywordWeightDelta('SFW', ['电影'], 0), errorCode('INVALID_PERSONALIZATION'));
    assert.throws(() => activeStore.ensurePersonalizationKeywordWeights('SFW', '电影'), errorCode('INVALID_PERSONALIZATION'));
    assert.throws(() => activeStore.ensurePersonalizationKeywordWeights(undefined, ['电影']), errorCode('INVALID_CONTENT_MODE'));
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
    assert.equal(cleared.promptPresets.length, 22);
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
    assert.equal(store.resolveFunction('group_chat', { contentMode: 'SFW' }).promptPreset.id, 'builtin_group_chat_sfw');
    assert.equal(store.resolveFunction('forum', { contentMode: 'NSFW' }).promptPreset.id, 'builtin_forum_nsfw');
    store.bindFunctionForContentMode('service_profile_generation', 'SFW', { connectionPresetId: 'fast', promptPresetId: 'builtin_service_profile_sfw' });
    store.bindFunctionForContentMode('service_profile_generation', 'NSFW', { connectionPresetId: 'smart', promptPresetId: 'builtin_service_profile_nsfw' });
    assert.equal(store.resolveFunction('service_profile_generation', { contentMode: 'SFW' }).connectionPreset.id, 'fast');
    assert.equal(store.resolveFunction('service_profile_generation', { contentMode: 'NSFW' }).connectionPreset.id, 'smart');
    assert.equal(store.resolveFunction('character_full_authoring', { contentMode: 'SFW' }).connectionPreset.id, 'fast', '专属服务绑定不得改写完整角色创作绑定。');

    store.deletePromptPreset('builtin_private_chat_nsfw');
    assert.equal(store.snapshot().functionModeBindings.chat.NSFW.promptPresetId, null);
    assert.equal(store.resolveFunction('chat', { contentMode: 'NSFW' }).promptPreset, null);
});

test('browser-local group and forum binding overlays resolve without changing exportable settings bindings', () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    store.load();
    store.addConnectionPreset(connection('default'));
    store.addConnectionPreset(connection('local_group'));
    const before = store.snapshot().functionModeBindings.group_chat.SFW;
    const resolved = store.resolveFunction('group_chat', {
        contentMode: 'SFW',
        binding: { connectionPresetId: 'local_group', promptPresetId: 'builtin_group_chat_sfw' },
    });
    assert.equal(resolved.connectionPreset.id, 'local_group');
    assert.equal(resolved.promptPreset.id, 'builtin_group_chat_sfw');
    assert.equal(resolved.usedLocalBinding, true);
    assert.deepEqual(store.snapshot().functionModeBindings.group_chat.SFW, before, '局部群绑定不得写回可导出的设置');
    assert.throws(() => store.resolveFunction('forum', {
        contentMode: 'NSFW', binding: { connectionPresetId: 'local_group', promptPresetId: 'builtin_forum_sfw' },
    }), errorCode('PROMPT_MODE_MISMATCH'));
    assert.throws(() => store.resolveFunction('forum', {
        contentMode: 'SFW', binding: { connectionPresetId: 'missing', promptPresetId: null },
    }), errorCode('UNKNOWN_PRESET_ID'));
});

test('生图设置严格隔离密钥并按对话类型保存自动生图开关', () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const initial = store.load();
    assert.equal(initial.schemaVersion, 17);
    assert.equal(initial.imageGeneration.enabled, false);
    assert.equal(initial.imageGeneration.apiMode, 'novelai');
    assert.equal(initial.imageGeneration.comfyWorkflow, '');
    assert.deepEqual(initial.imageGeneration.conversationSettings, { private: {}, group: {}, forum: {} });

    const base = store.getImageGenerationSettings();
    store.setImageGenerationSettings({
        ...base,
        enabled: true,
        apiMode: 'openai_compatible',
        baseUrl: 'https://images.example.invalid',
        endpointPath: '/v1/images/generations',
        model: 'image-model',
        positivePrefix: 'masterpiece',
        positiveSuffix: 'soft lighting',
        negativePrompt: 'lowres',
        comfyWorkflow: '',
    });
    store.setConversationImageGenerationSettings('private', 'chat_1', { autoGenerate: true });
    store.setConversationImageGenerationSettings('group', 'group_1', { autoGenerate: false });
    assert.deepEqual(store.getConversationImageGenerationSettings('private', 'chat_1'), { autoGenerate: true });
    assert.deepEqual(store.getConversationImageGenerationSettings('group', 'chat_1'), { autoGenerate: false });
    assert.deepEqual(store.getConversationImageGenerationSettings('forum', 'post_1'), { autoGenerate: false });
    assert.doesNotMatch(store.exportJson(), /apiKey|authorization|bearer|secret-value/iu);

    assert.throws(() => store.setImageGenerationSettings({ ...base, apiKey: 'secret-value' }), errorCode('UNSAFE_INPUT'));
    assert.throws(() => store.setImageGenerationSettings({ ...base, baseUrl: 'http://images.example.invalid' }), errorCode('INVALID_IMAGE_GENERATION'));
    assert.throws(() => store.setImageGenerationSettings({ ...base, baseUrl: 'https://images.example.invalid/?api_key=secret-value' }), errorCode('INVALID_IMAGE_GENERATION'));
    assert.throws(() => store.setImageGenerationSettings({ ...base, endpointPath: '/../private' }), errorCode('INVALID_IMAGE_GENERATION'));
    assert.throws(() => store.setImageGenerationSettings({ ...base, width: 255 }), errorCode('INVALID_SETTINGS'));
    assert.throws(() => store.setConversationImageGenerationSettings('private', 'bad/id', { autoGenerate: true }), errorCode('INVALID_IMAGE_GENERATION'));

    assert.doesNotThrow(() => store.setImageGenerationSettings({ ...base, baseUrl: 'http://127.0.0.1:7860' }));
});

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
    IMAGE_CLIENT_MODES,
    NAI_NOISE_SCHEDULE_OPTIONS,
    NAI_SAMPLER_OPTIONS,
} from '../settings-store.js';
import { getFeatureBindingSurface } from '../feature-binding.js';
import { BUILTIN_PROMPT_PRESET_IDS } from '../default-prompt-presets.js';

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
    assert.equal(initial.schemaVersion, 23);
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

test('旧 settings schema v1-v10 统一拒绝且不覆盖当前 v22 设置', () => {
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

test('v11-v14 设置在加载与导入时迁移到 v22：内置提示词刷新为新文案，自定义预设保留', () => {
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
        assert.equal(migrated.schemaVersion, 23);
        assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_private_chat_nsfw').content, /全尺度/u);
        assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_private_chat_nsfw').content, /全尺度/u, '迁移后应带上 v22 全尺度成人文案');
        assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_recommendation_sfw').content, /本模式保持日常社交尺度/u);
        assert.equal(migrated.promptPresets.some((preset) => preset.content === staleContent), false);
        assert.equal(migrated.promptPresets.find((preset) => preset.id === 'custom_keep').content, '提示词-custom_keep');
        assert.equal(JSON.parse(seeded.getItem(SETTINGS_STORAGE_KEY)).schemaVersion, 23, '迁移结果必须落盘为 v23');

        const imported = createSettingsStore({ storage: createMemoryStorage() });
        const result = imported.importJson(JSON.stringify(legacy));
        assert.equal(result.schemaVersion, 23);
        assert.match(result.promptPresets.find((preset) => preset.id === 'builtin_private_chat_nsfw').content, /全尺度/u);
        assert.match(result.promptPresets.find((preset) => preset.id === 'builtin_private_chat_nsfw').content, /全尺度/u);
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
    assert.equal(migrated.schemaVersion, 23);
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

test('v14→当前版本迁移刷新 SFW 与 NSFW 内置文案：用户自建保留，被删除的内置不复活', () => {
    const seedStore = createSettingsStore({ storage: createMemoryStorage() });
    seedStore.load();
    seedStore.addPromptPreset(prompt('custom_sfw_keep', '自定义 SFW 预设', 'SFW'));
    seedStore.deletePromptPreset('builtin_image_match_sfw');
    const legacy = JSON.parse(seedStore.exportJson());
    legacy.schemaVersion = 14;
    const staleSfw = '旧版 v14 SFW 文案：粗糙滞后，等待质量升级。';
    for (const preset of legacy.promptPresets) {
        if (!preset.id.startsWith('builtin_')) continue;
        if (preset.contentMode === 'SFW') preset.content = staleSfw;
        if (preset.contentMode === 'NSFW') preset.content = '旧版 v14 NSFW 文案。';
    }

    const seeded = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(legacy) });
    const migrated = createSettingsStore({ storage: seeded }).load();
    assert.equal(migrated.schemaVersion, 23);
    assert.equal(migrated.promptPresets.some((preset) => preset.content === staleSfw), false, '全部 SFW 内置文案都应刷新为 v15 新文案');
    assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_private_chat_sfw').content, /只要尊重已知边界，就不是冒犯/u, '私聊 SFW 应带上友好直白宽容条款');
    assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_recommendation_sfw').content, /基础匹配硬条件/u, '推荐 SFW 应带上性别硬条件提醒');
    assert.equal(migrated.promptPresets.some((preset) => preset.content === '旧版 v14 NSFW 文案。'), false, '全部存量 NSFW 内置文案都应刷新为 v22 新文案');
    assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_private_chat_nsfw').content, /全尺度/u);
    assert.equal(migrated.promptPresets.find((preset) => preset.id === 'custom_sfw_keep').content, '提示词-custom_sfw_keep', '用户自建预设必须逐字保留');
    assert.equal(migrated.promptPresets.some((preset) => preset.id === 'builtin_image_match_sfw'), false, '用户删除的内置预设不得复活');
    assert.equal(migrated.functionModeBindings.image_match.SFW.promptPresetId, null, '删除内置后的空绑定不得被迁移改写');
    assert.equal(migrated.functionModeBindings.chat.SFW.promptPresetId, 'builtin_private_chat_sfw', '既有绑定 ID 迁移后保持原样');
    assert.equal(JSON.parse(seeded.getItem(SETTINGS_STORAGE_KEY)).schemaVersion, 23, '迁移结果必须落盘为 v23');
});

test('v15→v22 迁移补入独立 ComfyUI 配置、刷新服务和 NSFW 内置提示词且不改写自定义提示词', () => {
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
    assert.equal(migrated.schemaVersion, 23);
    assert.equal(migrated.imageGeneration.baseUrl, 'https://images.example.invalid');
    assert.equal(migrated.imageGeneration.model, 'nai-model-kept');
    assert.equal(migrated.imageGeneration.comfyBaseUrl, 'http://127.0.0.1:8188');
    assert.equal(migrated.imageGeneration.comfySampler, 'euler');
    assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_service_profile_sfw').content, /最高优先级硬条件/u);
    assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_service_profile_nsfw').content, /双向性别\/性取向兼容/u);
    assert.equal(migrated.promptPresets.find((preset) => preset.id === 'custom_v15_keep').content, '提示词-custom_v15_keep');
});

test('v16→v22 只刷新仍存在的服务和 NSFW 内置提示词，不复活删除项或改写自定义预设', () => {
    const seedStore = createSettingsStore({ storage: createMemoryStorage() });
    seedStore.load();
    seedStore.addPromptPreset(prompt('custom_v16_keep', '自定义 v16 预设', 'SFW'));
    seedStore.deletePromptPreset('builtin_service_profile_nsfw');
    const legacy = JSON.parse(seedStore.exportJson());
    legacy.schemaVersion = 16;
    legacy.promptPresets.find((preset) => preset.id === 'builtin_service_profile_sfw').content = '旧版约伴 SFW 提示词。';

    const seeded = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(legacy) });
    const migrated = createSettingsStore({ storage: seeded }).load();
    assert.equal(migrated.schemaVersion, 23);
    assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_service_profile_sfw').content, /最高优先级硬条件/u);
    assert.equal(migrated.promptPresets.some((preset) => preset.id === 'builtin_service_profile_nsfw'), false);
    assert.equal(migrated.promptPresets.find((preset) => preset.id === 'custom_v16_keep').content, '提示词-custom_v16_keep');
    assert.equal(JSON.parse(seeded.getItem(SETTINGS_STORAGE_KEY)).schemaVersion, 23);
});

test('v17→v22 复制既有通用提示词到 OpenAI 专属预设并保留 NAI 值', () => {
    const seedStore = createSettingsStore({ storage: createMemoryStorage() });
    const legacy = seedStore.load();
    legacy.schemaVersion = 17;
    legacy.imageGeneration.positivePrefix = 'legacy positive';
    legacy.imageGeneration.positiveSuffix = 'legacy suffix';
    legacy.imageGeneration.negativePrompt = 'legacy negative';
    delete legacy.imageGeneration.openaiPositivePrefix;
    delete legacy.imageGeneration.openaiPositiveSuffix;
    delete legacy.imageGeneration.openaiNegativePrompt;
    const migrated = createSettingsStore({
        storage: createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(legacy) }),
    }).load();
    assert.equal(migrated.schemaVersion, 23);
    assert.equal(migrated.imageGeneration.positivePrefix, 'legacy positive');
    assert.equal(migrated.imageGeneration.openaiPositivePrefix, 'legacy positive');
    assert.equal(migrated.imageGeneration.openaiPositiveSuffix, 'legacy suffix');
    assert.equal(migrated.imageGeneration.openaiNegativePrompt, 'legacy negative');
    assert.equal(migrated.imageGeneration.openaiPresetId, 'image_generation_openai');
    assert.equal(migrated.imageGeneration.openaiBaseUrl, 'https://api.openai.com');
    assert.equal(migrated.imageGeneration.openaiModel, 'gpt-image-1');
});

test('v18→v22 保留 OpenAI 专属配置并从旧共用尺寸初始化独立尺寸', () => {
    const seedStore = createSettingsStore({ storage: createMemoryStorage() });
    const legacy = seedStore.load();
    legacy.schemaVersion = 18;
    legacy.imageGeneration.width = 832;
    legacy.imageGeneration.height = 1216;
    legacy.imageGeneration.openaiBaseUrl = 'https://openai-v18.example.invalid';
    legacy.imageGeneration.openaiModel = 'gpt-image-v18';
    legacy.imageGeneration.openaiPositivePrefix = 'keep openai prefix';
    delete legacy.imageGeneration.openaiWidth;
    delete legacy.imageGeneration.openaiHeight;
    const migrated = createSettingsStore({
        storage: createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(legacy) }),
    }).load();
    assert.equal(migrated.schemaVersion, 23);
    assert.equal(migrated.imageGeneration.openaiBaseUrl, 'https://openai-v18.example.invalid');
    assert.equal(migrated.imageGeneration.openaiModel, 'gpt-image-v18');
    assert.equal(migrated.imageGeneration.openaiPositivePrefix, 'keep openai prefix');
    assert.equal(migrated.imageGeneration.openaiWidth, 832);
    assert.equal(migrated.imageGeneration.openaiHeight, 1216);
});

test('v19→v22 为三个接口补入互相独立的空提示词预设集合', () => {
    const seedStore = createSettingsStore({ storage: createMemoryStorage() });
    const legacy = seedStore.load();
    legacy.schemaVersion = 19;
    delete legacy.imageGeneration.promptPresets;
    delete legacy.imageGeneration.activePromptPresetIds;
    const migrated = createSettingsStore({
        storage: createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(legacy) }),
    }).load();
    assert.equal(migrated.schemaVersion, 23);
    assert.deepEqual(migrated.imageGeneration.promptPresets, { novelai: [], openai_compatible: [], comfyui: [] });
    assert.deepEqual(migrated.imageGeneration.activePromptPresetIds, { novelai: null, openai_compatible: null, comfyui: null });
});

test('v20→v22 迁移加入全局客户端，映射旧 NAI 噪点表并保留 prompt-only NAI 预设', () => {
    const seedStore = createSettingsStore({ storage: createMemoryStorage() });
    const legacy = seedStore.load();
    legacy.schemaVersion = 20;
    delete legacy.imageGeneration.clientMode;
    legacy.imageGeneration.noiseSchedule = 'native';
    legacy.imageGeneration.apiMode = 'comfyui';
    legacy.imageGeneration.openaiBaseUrl = 'https://openai-v20.example.invalid';
    legacy.imageGeneration.comfyBaseUrl = 'http://127.0.0.1:8288';
    legacy.imageGeneration.promptPresets.novelai = [{
        id: 'legacy_nai_prompt', name: '旧 NAI 提示词预设',
        positivePrefix: 'legacy prefix', positiveSuffix: 'legacy suffix', negativePrompt: 'legacy negative',
    }];
    legacy.imageGeneration.activePromptPresetIds.novelai = 'legacy_nai_prompt';

    const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(legacy) });
    const migrated = createSettingsStore({ storage }).load();
    assert.equal(migrated.schemaVersion, 23);
    assert.equal(migrated.imageGeneration.clientMode, 'browser');
    assert.equal(migrated.imageGeneration.noiseSchedule, 'karras');
    assert.equal(migrated.imageGeneration.apiMode, 'comfyui');
    assert.equal(migrated.imageGeneration.openaiBaseUrl, 'https://openai-v20.example.invalid');
    assert.equal(migrated.imageGeneration.comfyBaseUrl, 'http://127.0.0.1:8288');
    assert.deepEqual(migrated.imageGeneration.promptPresets.novelai, [{
        id: 'legacy_nai_prompt', name: '旧 NAI 提示词预设',
        positivePrefix: 'legacy prefix', positiveSuffix: 'legacy suffix', negativePrompt: 'legacy negative',
    }]);
    assert.equal(migrated.imageGeneration.activePromptPresetIds.novelai, 'legacy_nai_prompt');
    assert.equal(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)).schemaVersion, 23);
});

test('v21→v22 只刷新仍存在的 NSFW 内置提示词，保留 SFW、自定义、删除项与绑定', () => {
    const seedStore = createSettingsStore({ storage: createMemoryStorage() });
    seedStore.load();
    seedStore.addPromptPreset(prompt('custom_nsfw_keep', '自定义 NSFW', 'NSFW'));
    seedStore.bindFunctionForContentMode('chat', 'NSFW', {
        connectionPresetId: null,
        promptPresetId: 'custom_nsfw_keep',
    });
    seedStore.deletePromptPreset('builtin_image_match_nsfw');
    const legacy = JSON.parse(seedStore.exportJson());
    legacy.schemaVersion = 21;
    const sfwBefore = legacy.promptPresets.find((preset) => preset.id === 'builtin_private_chat_sfw').content;
    for (const preset of legacy.promptPresets) {
        if (preset.id.startsWith('builtin_') && preset.contentMode === 'NSFW') preset.content = '旧版 v21 NSFW 文案。';
    }

    const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(legacy) });
    const migrated = createSettingsStore({ storage }).load();
    assert.equal(migrated.schemaVersion, 23);
    assert.equal(migrated.promptPresets.some((preset) => preset.content === '旧版 v21 NSFW 文案。'), false);
    assert.match(migrated.promptPresets.find((preset) => preset.id === 'builtin_private_chat_nsfw').content, /全尺度/u);
    assert.equal(migrated.promptPresets.find((preset) => preset.id === 'builtin_private_chat_sfw').content, sfwBefore);
    assert.equal(migrated.promptPresets.find((preset) => preset.id === 'custom_nsfw_keep').content, '提示词-custom_nsfw_keep');
    assert.equal(migrated.promptPresets.some((preset) => preset.id === 'builtin_image_match_nsfw'), false);
    assert.equal(migrated.functionModeBindings.chat.NSFW.promptPresetId, 'custom_nsfw_keep');
    assert.equal(migrated.functionModeBindings.image_match.NSFW.promptPresetId, null);
    assert.equal(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)).schemaVersion, 23);
});

test('v22→v23 只刷新仍存在的四份角色补全/完整创作内置提示词，保留自定义、删除项与绑定', () => {
    const seedStore = createSettingsStore({ storage: createMemoryStorage() });
    seedStore.load();
    seedStore.addPromptPreset(prompt('custom_character_keep', '自定义角色创作', 'NSFW'));
    seedStore.bindFunctionForContentMode('character_ai_completion', 'NSFW', {
        connectionPresetId: null,
        promptPresetId: 'custom_character_keep',
    });
    seedStore.deletePromptPreset(BUILTIN_PROMPT_PRESET_IDS.characterAuthoringSfw);
    const legacy = JSON.parse(seedStore.exportJson());
    legacy.schemaVersion = 22;
    const untouchedChat = legacy.promptPresets.find((preset) => preset.id === BUILTIN_PROMPT_PRESET_IDS.privateChatSfw).content;
    const characterIds = new Set([
        BUILTIN_PROMPT_PRESET_IDS.characterCompletionSfw,
        BUILTIN_PROMPT_PRESET_IDS.characterCompletionNsfw,
        BUILTIN_PROMPT_PRESET_IDS.characterAuthoringSfw,
        BUILTIN_PROMPT_PRESET_IDS.characterAuthoringNsfw,
    ]);
    for (const preset of legacy.promptPresets) if (characterIds.has(preset.id)) preset.content = '旧版 v22 角色创作文案。';

    const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(legacy) });
    const migrated = createSettingsStore({ storage }).load();
    assert.equal(migrated.schemaVersion, 23);
    assert.equal(migrated.promptPresets.some((preset) => preset.content === '旧版 v22 角色创作文案。'), false);
    assert.match(migrated.promptPresets.find((preset) => preset.id === BUILTIN_PROMPT_PRESET_IDS.characterCompletionSfw).content, /completionScopes/u);
    assert.match(migrated.promptPresets.find((preset) => preset.id === BUILTIN_PROMPT_PRESET_IDS.characterAuthoringNsfw).content, /characterBlueprint/u);
    assert.equal(migrated.promptPresets.some((preset) => preset.id === BUILTIN_PROMPT_PRESET_IDS.characterAuthoringSfw), false, '已删除的内置项不得复活');
    assert.equal(migrated.promptPresets.find((preset) => preset.id === BUILTIN_PROMPT_PRESET_IDS.privateChatSfw).content, untouchedChat);
    assert.equal(migrated.promptPresets.find((preset) => preset.id === 'custom_character_keep').content, '提示词-custom_character_keep');
    assert.equal(migrated.functionModeBindings.character_ai_completion.NSFW.promptPresetId, 'custom_character_keep');
    assert.equal(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)).schemaVersion, 23);
});

test('NAI 整体预设保存完整非机密配置，严格拒绝不完整、未知或秘密字段', () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    const base = store.getImageGenerationSettings();
    const complete = {
        id: 'nai_complete', name: 'NAI 酒馆预设',
        positivePrefix: 'portrait', positiveSuffix: 'cinematic', negativePrompt: 'lowres',
        clientMode: 'sillytavern', presetId: 'nai_slot', baseUrl: 'https://image.novelai.net', endpointPath: '/ai/generate-image',
        model: 'nai-diffusion-4-5-full', sampler: 'k_dpmpp_2m_sde', noiseSchedule: 'polyexponential',
        guidance: 6.5, guidanceRescale: 0.2, width: 832, height: 1216, steps: 32, seed: 42, qualityToggle: false, variety: true,
    };
    store.setImageGenerationSettings({
        ...base,
        promptPresets: { ...base.promptPresets, novelai: [complete] },
        activePromptPresetIds: { ...base.activePromptPresetIds, novelai: 'nai_complete' },
    });
    const saved = store.snapshot().imageGeneration.promptPresets.novelai[0];
    assert.deepEqual(saved, complete);
    assert.doesNotMatch(store.exportJson(), /apiKey|token|authorization|bearer/iu);

    const settingsWith = (preset) => ({
        ...store.snapshot().imageGeneration,
        promptPresets: { ...store.snapshot().imageGeneration.promptPresets, novelai: [preset] },
        activePromptPresetIds: { ...store.snapshot().imageGeneration.activePromptPresetIds, novelai: preset.id },
    });
    const { seed, ...missingSeed } = complete;
    assert.throws(() => store.setImageGenerationSettings(settingsWith(missingSeed)), errorCode('INVALID_IMAGE_GENERATION'));
    assert.throws(() => store.setImageGenerationSettings(settingsWith({ ...complete, clientMode: 'desktop-app' })), errorCode('INVALID_IMAGE_GENERATION'));
    assert.throws(() => store.setImageGenerationSettings(settingsWith({ ...complete, sampler: 'unlisted_sampler' })), errorCode('INVALID_IMAGE_GENERATION'));
    assert.throws(() => store.setImageGenerationSettings(settingsWith({ ...complete, noiseSchedule: 'native' })), errorCode('INVALID_IMAGE_GENERATION'));
    assert.throws(() => store.setImageGenerationSettings(settingsWith({ ...complete, apiKey: 'not-a-real-key' })), errorCode('UNSAFE_INPUT'));
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
    assert.equal(initial.schemaVersion, 23);
    assert.equal(initial.imageGeneration.enabled, false);
    assert.equal(initial.imageGeneration.apiMode, 'novelai');
    assert.equal(initial.imageGeneration.baseUrl, 'https://image.novelai.net');
    assert.equal(initial.imageGeneration.endpointPath, '/ai/generate-image');
    assert.equal(initial.imageGeneration.model, 'nai-diffusion-4-5-full');
    assert.equal(initial.imageGeneration.sampler, 'k_euler');
    assert.equal(initial.imageGeneration.noiseSchedule, 'karras');
    assert.equal(initial.imageGeneration.guidance, 7);
    assert.equal(initial.imageGeneration.guidanceRescale, 0);
    assert.equal(initial.imageGeneration.width, 1024);
    assert.equal(initial.imageGeneration.height, 1024);
    assert.equal(initial.imageGeneration.steps, 28);
    assert.equal(initial.imageGeneration.variety, false);
    assert.equal(initial.imageGeneration.openaiPositivePrefix, '');
    assert.equal(initial.imageGeneration.openaiPresetId, 'image_generation_openai');
    assert.equal(initial.imageGeneration.openaiBaseUrl, 'https://api.openai.com');
    assert.equal(initial.imageGeneration.openaiEndpointPath, '/v1/images/generations');
    assert.equal(initial.imageGeneration.openaiModel, 'gpt-image-1');
    assert.equal(initial.imageGeneration.openaiWidth, 1024);
    assert.equal(initial.imageGeneration.openaiHeight, 1024);
    assert.equal(initial.imageGeneration.comfyWorkflow, '');
    assert.equal(initial.imageGeneration.clientMode, 'browser');
    assert.equal(initial.imageGeneration.sampler, 'k_euler');
    assert.equal(initial.imageGeneration.noiseSchedule, 'karras');
    assert.deepEqual(IMAGE_CLIENT_MODES, ['browser', 'sillytavern']);
    assert.deepEqual(NAI_SAMPLER_OPTIONS.map((item) => item.label), ['Euler Ancestral', 'Euler', 'DPM++ 2M', 'DPM++ 2M SDE', 'DPM++ 2S Ancestral', 'DPM2', 'DPM Fast', 'DDIM']);
    assert.deepEqual(NAI_NOISE_SCHEDULE_OPTIONS.map((item) => item.label), ['Karras', 'Exponential', 'Polyexponential', 'Sine', 'Linear', 'Cosine', 'Beta']);
    assert.deepEqual(initial.imageGeneration.promptPresets, { novelai: [], openai_compatible: [], comfyui: [] });
    assert.deepEqual(initial.imageGeneration.activePromptPresetIds, { novelai: null, openai_compatible: null, comfyui: null });
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
    assert.doesNotThrow(() => store.setImageGenerationSettings({ ...base, baseUrl: 'http://images.example.invalid' }));
    assert.throws(() => store.setImageGenerationSettings({ ...base, baseUrl: 'https://images.example.invalid/?api_key=secret-value' }), errorCode('INVALID_IMAGE_GENERATION'));
    assert.throws(() => store.setImageGenerationSettings({ ...base, baseUrl: 'ftp://images.example.invalid' }), errorCode('INVALID_IMAGE_GENERATION'));
    assert.throws(() => store.setImageGenerationSettings({ ...base, endpointPath: '/../private' }), errorCode('INVALID_IMAGE_GENERATION'));
    assert.throws(() => store.setImageGenerationSettings({ ...base, width: 255 }), errorCode('INVALID_SETTINGS'));
    assert.throws(() => store.setImageGenerationSettings({ ...base, positivePrefix: 'masterpiece\nhigh detail' }), errorCode('INVALID_IMAGE_GENERATION'));
    assert.throws(() => store.setConversationImageGenerationSettings('private', 'bad/id', { autoGenerate: true }), errorCode('INVALID_IMAGE_GENERATION'));

    assert.doesNotThrow(() => store.setImageGenerationSettings({ ...base, baseUrl: 'http://127.0.0.1:7860' }));
});

test('三个生图接口的提示词预设独立保存、导出并严格校验当前选择', () => {
    const store = createSettingsStore({ storage: createMemoryStorage() });
    store.load();
    const base = store.getImageGenerationSettings();
    store.setImageGenerationSettings({
        ...base,
        promptPresets: {
            novelai: [{ id: 'nai_portrait', name: 'NAI 人像', positivePrefix: 'nai prefix', positiveSuffix: 'nai suffix', negativePrompt: 'nai negative' }],
            openai_compatible: [{ id: 'openai_photo', name: 'OpenAI 写真', positivePrefix: 'openai prefix', positiveSuffix: '', negativePrompt: 'openai negative' }],
            comfyui: [{ id: 'comfy_scene', name: 'Comfy 场景', positivePrefix: 'comfy prefix', positiveSuffix: 'comfy suffix', negativePrompt: '' }],
        },
        activePromptPresetIds: {
            novelai: 'nai_portrait',
            openai_compatible: 'openai_photo',
            comfyui: 'comfy_scene',
        },
    });
    const saved = store.snapshot().imageGeneration;
    assert.equal(saved.promptPresets.novelai[0].positivePrefix, 'nai prefix');
    assert.equal(saved.promptPresets.openai_compatible[0].positivePrefix, 'openai prefix');
    assert.equal(saved.promptPresets.comfyui[0].positivePrefix, 'comfy prefix');
    assert.doesNotMatch(store.exportJson(), /apiKey|authorization|bearer/iu);
    assert.throws(() => store.setImageGenerationSettings({
        ...saved,
        activePromptPresetIds: { ...saved.activePromptPresetIds, novelai: 'openai_photo' },
    }), errorCode('UNKNOWN_PRESET_ID'));
    assert.throws(() => store.setImageGenerationSettings({
        ...saved,
        promptPresets: {
            ...saved.promptPresets,
            novelai: [...saved.promptPresets.novelai, { ...saved.promptPresets.novelai[0] }],
        },
    }), errorCode('DUPLICATE_PRESET_ID'));
});

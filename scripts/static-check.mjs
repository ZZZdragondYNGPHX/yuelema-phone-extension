import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const requiredFiles = [
    'manifest.json', 'index.js', 'style.css', 'README.md', 'test/extension-lifecycle.test.mjs',
    'src/app-shell.js', 'src/dom.js', 'src/action-bridge.js', 'src/ui-model.js', 'src/settings-panel.js',
    'src/mvu/json-pointer.js', 'src/mvu/controlled-patch.js', 'src/mvu/adapter.js', 'src/mvu/readiness.js', 'src/mvu/test/readiness.test.mjs',
    'src/llm/session-key-store.js', 'src/llm/openai-compatible-client.js', 'src/llm/test/session-key-store.test.mjs', 'src/llm/test/openai-compatible-client.test.mjs',
    'src/settings/settings-store.js', 'src/settings/default-prompt-presets.js', 'src/settings/browser-storage.js', 'src/settings/prompt-compiler.js', 'src/settings/feature-binding.js',
    'src/settings/test/settings-store.test.mjs', 'src/settings/test/browser-storage.test.mjs', 'src/settings/test/prompt-compiler.test.mjs', 'src/settings/test/settings-panel.test.mjs', 'src/settings/test/feature-binding.test.mjs',
    'src/recommendation/candidate.js', 'src/recommendation/recommendation-refresh.js', 'src/recommendation/match-scoring.js', 'src/recommendation/soul-text-match-service.js',
    'src/groups/group-discovery-service.js', 'src/groups/group-llm-safety.js', 'src/groups/group-chat-service.js', 'src/groups/forum-service.js',
    'src/chat/private-chat-response.js', 'src/chat/private-chat-service.js', 'src/chat/test/private-chat-response.test.mjs', 'src/chat/test/private-chat-service.test.mjs',
    'src/test-support/minidom.mjs', 'src/launcher-drag.js', 'src/ui/test/launcher-drag.test.mjs', 'src/characters/character-template-codec.js', 'src/characters/character-library-store.js', 'src/characters/character-template-library-store.js', 'src/characters/avatar-codec.js', 'src/characters/character-creator-panel.js', 'src/characters/character-authoring-service.js',
    'src/characters/test/character-template-codec.test.mjs', 'src/characters/test/character-library-store.test.mjs', 'src/characters/test/character-template-library-store.test.mjs', 'src/characters/test/avatar-codec.test.mjs', 'src/characters/test/character-authoring-service.test.mjs', 'src/characters/test/character-creator-panel.test.mjs',
    'src/recommendation/test/candidate.test.mjs', 'src/recommendation/test/recommendation-refresh.test.mjs', 'src/recommendation/test/match-scoring.test.mjs', 'src/recommendation/test/soul-text-match-service.test.mjs',
    'src/groups/test/group-discovery-service.test.mjs', 'src/groups/test/group-chat-service.test.mjs', 'src/groups/test/forum-service.test.mjs',
    'src/mvu/test/recommendation-refresh-patch.test.mjs', 'src/mvu/test/like-match-patch.test.mjs', 'src/mvu/test/meetup-handoff.test.mjs', 'src/mvu/test/soul-preference-patch.test.mjs', 'src/mvu/test/player-public-profile-patch.test.mjs',
    'src/ui/test/ui-model.test.mjs', 'src/ui/test/action-bridge.test.mjs', 'src/ui/test/app-shell-groups.test.mjs', 'src/ui/test/app-shell-ux.test.mjs', 'src/ui/test/private-chat-ui.test.mjs',
];

function fail(message) {
    console.error(`✗ ${message}`);
    process.exitCode = 1;
}

for (const relativePath of requiredFiles) {
    try {
        await readFile(resolve(root, relativePath), 'utf8');
        console.log(`✓ ${relativePath}`);
    } catch {
        fail(`缺少文件：${relativePath}`);
    }
}

const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
for (const key of ['display_name', 'js', 'css', 'author', 'version', 'minimum_client_version']) {
    if (typeof manifest[key] !== 'string' || !manifest[key]) fail(`manifest.${key} 缺失或非字符串`);
}
if (manifest.version !== '0.1.15') fail('manifest.version 必须与扩展版本 0.1.15 统一');
if (manifest.minimum_client_version !== '1.18.0') fail('manifest.minimum_client_version 必须为已核对完整 lifecycle hooks 的 1.18.0');
if (manifest?.hooks?.activate !== 'onActivate') fail('manifest.hooks.activate 必须指向 onActivate');
if (manifest?.hooks?.disable !== 'onDisable') fail('manifest.hooks.disable 必须指向 onDisable，确保禁用即清理内存密钥镜像');
if (manifest?.hooks?.delete !== 'onDelete') fail('manifest.hooks.delete 必须指向 onDelete，确保删除前清理运行时资源');
console.log('✓ manifest 基础字段与 lifecycle hooks');

const sourceFiles = [
    'index.js', 'test/extension-lifecycle.test.mjs',
    'src/app-shell.js', 'src/dom.js', 'src/action-bridge.js', 'src/ui-model.js', 'src/settings-panel.js',
    'src/mvu/json-pointer.js', 'src/mvu/controlled-patch.js', 'src/mvu/adapter.js', 'src/mvu/readiness.js', 'src/mvu/test/readiness.test.mjs',
    'src/llm/session-key-store.js', 'src/llm/openai-compatible-client.js', 'src/llm/test/session-key-store.test.mjs', 'src/llm/test/openai-compatible-client.test.mjs',
    'src/settings/settings-store.js', 'src/settings/default-prompt-presets.js', 'src/settings/browser-storage.js', 'src/settings/prompt-compiler.js', 'src/settings/feature-binding.js',
    'src/settings/test/settings-store.test.mjs', 'src/settings/test/browser-storage.test.mjs', 'src/settings/test/prompt-compiler.test.mjs', 'src/settings/test/settings-panel.test.mjs', 'src/settings/test/feature-binding.test.mjs',
    'src/recommendation/candidate.js', 'src/recommendation/recommendation-refresh.js', 'src/recommendation/match-scoring.js', 'src/recommendation/soul-text-match-service.js',
    'src/groups/group-discovery-service.js', 'src/groups/group-llm-safety.js', 'src/groups/group-chat-service.js', 'src/groups/forum-service.js',
    'src/chat/private-chat-response.js', 'src/chat/private-chat-service.js', 'src/chat/test/private-chat-response.test.mjs', 'src/chat/test/private-chat-service.test.mjs',
    'src/test-support/minidom.mjs', 'src/characters/character-template-codec.js', 'src/characters/character-library-store.js', 'src/characters/avatar-codec.js', 'src/characters/character-creator-panel.js', 'src/characters/character-authoring-service.js',
    'src/characters/test/character-template-codec.test.mjs', 'src/characters/test/character-library-store.test.mjs', 'src/characters/test/avatar-codec.test.mjs', 'src/characters/test/character-authoring-service.test.mjs', 'src/characters/test/character-creator-panel.test.mjs',
    'src/recommendation/test/candidate.test.mjs', 'src/recommendation/test/recommendation-refresh.test.mjs', 'src/recommendation/test/match-scoring.test.mjs', 'src/recommendation/test/soul-text-match-service.test.mjs',
    'src/groups/test/group-discovery-service.test.mjs', 'src/groups/test/group-chat-service.test.mjs', 'src/groups/test/forum-service.test.mjs',
    'src/mvu/test/recommendation-refresh-patch.test.mjs', 'src/mvu/test/like-match-patch.test.mjs', 'src/mvu/test/meetup-handoff.test.mjs', 'src/mvu/test/soul-preference-patch.test.mjs', 'src/mvu/test/player-public-profile-patch.test.mjs',
    'src/ui/test/ui-model.test.mjs', 'src/ui/test/action-bridge.test.mjs', 'src/ui/test/app-shell-groups.test.mjs', 'src/ui/test/app-shell-ux.test.mjs', 'src/ui/test/private-chat-ui.test.mjs',
].map(relativePath => resolve(root, relativePath));
const sourceText = await Promise.all(sourceFiles.map(path => readFile(path, 'utf8')));
const allSource = sourceText.join('\n');

const prohibited = [
    [/\.innerHTML\s*=/, '禁止 innerHTML 写入'],
    [/\bfetch\s*\(/, 'UI/MVU 层不得绕过注入式 LLM transport 发网'],
    [/\bstat_data\s*[.=]/, '禁止直接写 stat_data'],
    [/replaceVariables\s*\(/, '禁止前端 replaceVariables 绕过 MVU'],
    [/\.click\s*\(/, '禁止面基流程或界面自动点击发送'],
];
for (const [pattern, message] of prohibited) {
    if (pattern.test(allSource)) fail(message);
    else console.log(`✓ ${message}`);
}

const sessionKeyStore = await readFile(resolve(root, 'src/llm/session-key-store.js'), 'utf8');
const llmClientSource = await readFile(resolve(root, 'src/llm/openai-compatible-client.js'), 'utf8');
const llmSource = [sessionKeyStore, llmClientSource].join('\n');
const llmExecutableSource = llmSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
for (const [pattern, message] of [
    [/sessionStorage|indexedDB|extension_settings/i, 'LLM API Key 仅允许专用 localStorage 缓存，不得写入其他浏览器或扩展设置存储'],
    [/console\./, 'LLM 模块不得把凭据或错误写入控制台'],
    [/globalThis\.fetch|\bfetch\s*\(/, 'LLM 模块必须使用显式注入的 transport'],
]) {
    if (pattern.test(llmExecutableSource)) fail(message);
    else console.log(`✓ ${message}`);
}
const llmClientExecutableSource = llmClientSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
if (/localStorage/i.test(llmClientExecutableSource)) fail('只有 session-key-store.js 可以访问 API Key 浏览器缓存');
if (!sessionKeyStore.includes('API_KEY_CACHE_STORAGE_KEY') || !sessionKeyStore.includes('requireSessionKey') || !sessionKeyStore.includes('deletePersistentKey')) fail('缺少预设 ID 隔离的浏览器 API Key 缓存与调用回退');
console.log('✓ API Key 仅通过专用浏览器缓存保存，并与设置导出 / MVU 隔离');
const appShell = await readFile(resolve(root, 'src/app-shell.js'), 'utf8');
const actionBridge = await readFile(resolve(root, 'src/action-bridge.js'), 'utf8');
const uiModel = await readFile(resolve(root, 'src/ui-model.js'), 'utf8');
const index = await readFile(resolve(root, 'index.js'), 'utf8');
if (!index.includes('export function onDisable') || !index.includes('export function onDelete') || !index.includes('clearSessionKeys()')) fail('缺少扩展禁用/删除时清理内存密钥镜像的生命周期实现');
for (const label of ['首页', '匹配', '消息', '群组', '我的']) {
    if (!appShell.includes(label) && !allSource.includes(`label: '${label}'`)) fail(`缺少导航：${label}`);
}
console.log('✓ 五导航定义');

for (const marker of ['readLatestState', 'buildControlledPatch', 'applyControlledPatch', 'runMvuAction']) {
    if (!actionBridge.includes(marker)) fail(`缺少 MVU 受控接线：${marker}`);
}
for (const marker of ['喜欢', '刷新', '收藏', '不喜欢', 'toggle_content_mode']) {
    if (!appShell.includes(marker)) fail(`缺少受控 UI 操作：${marker}`);
}
console.log('✓ 推荐四按钮、本地五击暗门、显式内容模式切换与官方 MVU 回收链接线');

if (/隐藏资料|仅好友资料/u.test(appShell)) fail('app-shell 不得读取或渲染隐藏/仅好友资料');
if (/\.\.\.\s*profile|Object\.entries\(profile\)/u.test(uiModel)) fail('公开资料投影不得枚举或展开完整角色资料');
if (!uiModel.includes('PUBLIC_PROFILE_FIELDS') || !uiModel.includes('projectPublicProfile')) fail('缺少公开字段白名单投影');
console.log('✓ UI 仅消费公开字段白名单');

if (!actionBridge.includes("querySelector('#send_textarea')")) fail('缺少面基输入框适配点');
if (!actionBridge.includes('appendMeetupDraft')) fail('缺少面基草稿函数');
console.log('✓ 面基仅追加输入框适配点');

if (!index.includes('VARIABLE_UPDATE_ENDED') || !index.includes('removeListener')) fail('缺少可清理的 MVU 变量更新事件订阅');
if (!index.includes('waitForReadableMvu') || !index.includes('refreshWhenMvuReady')) fail('缺少 MVU 晚到初始化后的安全重绑');
if (!index.includes('onDisable') || !index.includes('onDelete') || !index.includes('pagehide') || !index.includes('clearSessionKeys')) fail('缺少关闭/卸载/内存密钥镜像清理接缝');
console.log('✓ 变量更新订阅与卸载内存清理接缝');

const settingsStore = await readFile(resolve(root, 'src/settings/settings-store.js'), 'utf8');
const settingsPanel = await readFile(resolve(root, 'src/settings-panel.js'), 'utf8');
const defaultPromptPresets = await readFile(resolve(root, 'src/settings/default-prompt-presets.js'), 'utf8');
if (!settingsStore.includes('FUNCTION_KEYS') || !settingsStore.includes('functionModeBindings') || !settingsStore.includes('exportJson') || !settingsStore.includes('importJson')) fail('缺少设置预设与安全导入导出层');
if (!defaultPromptPresets.includes('builtin_recommendation_sfw') || !defaultPromptPresets.includes('builtin_private_chat_sfw') || !defaultPromptPresets.includes('builtin_character_authoring_sfw')) fail('缺少本地可编辑的默认 SFW/NSFW 提示词预设');
if (!settingsPanel.includes('unlockSessionKey') || !settingsPanel.includes('hasPersistentKey') || !settingsPanel.includes('deletePersistentKey') || !settingsPanel.includes('fetchModels') || !settingsPanel.includes('functionBindings')) fail('缺少设置 UI 的浏览器 Key 缓存、模型拉取或功能绑定接线');
if (!index.includes('createBrowserSettingsStorage') || !index.includes('createOpenAICompatibleClient')) fail('缺少浏览器非机密设置持久化或显式 LLM transport 接线');
console.log('✓ 非机密设置、浏览器 Key 缓存、模型拉取与功能绑定接线');
const generatedCandidate = await readFile(resolve(root, 'src/recommendation/candidate.js'), 'utf8');
const recommendationRefresh = await readFile(resolve(root, 'src/recommendation/recommendation-refresh.js'), 'utf8');
const controlledPatch = await readFile(resolve(root, 'src/mvu/controlled-patch.js'), 'utf8');
if (!generatedCandidate.includes('normalizeGeneratedCandidate')) fail('缺少生成候选的成年人和结构校验器');
if (!recommendationRefresh.includes('generateRecommendationCandidate') || !recommendationRefresh.includes('recommendation_refresh') || !recommendationRefresh.includes('normalizeGeneratedCandidate')) fail('缺少推荐刷新模型调用、功能绑定或候选校验接线');
if (!controlledPatch.includes('buildRecommendationRefreshPatch')) fail('缺少推荐刷新原子 JSONPatch 生产器');
if (!actionBridge.includes('runRecommendationRefresh')) fail('缺少推荐刷新受控 MVU 写入桥接');
console.log('✓ 阶段 3 推荐刷新候选校验、模型绑定与受控 Patch 接线');

const characterTemplateCodec = await readFile(resolve(root, 'src/characters/character-template-codec.js'), 'utf8');
const characterLibraryStore = await readFile(resolve(root, 'src/characters/character-library-store.js'), 'utf8');
const characterTemplateLibraryStore = await readFile(resolve(root, 'src/characters/character-template-library-store.js'), 'utf8');
const avatarCodec = await readFile(resolve(root, 'src/characters/avatar-codec.js'), 'utf8');
const characterCreator = await readFile(resolve(root, 'src/characters/character-creator-panel.js'), 'utf8');
if (!characterTemplateCodec.includes('normalizeGeneratedCandidate') || !characterTemplateCodec.includes('includeAvatar')) fail('缺少角色模板成年人校验或可选头像导出');
if (!characterLibraryStore.includes('MAX_CHARACTER_LIBRARY_TEMPLATES') || !characterLibraryStore.includes('importCharacterTemplate') || !characterLibraryStore.includes('exportCharacterTemplate')) fail('缺少历史本地角色模板库及 codec 接线');
if (!characterTemplateLibraryStore.includes('createCharacterTemplateLibraryStore') || !characterTemplateLibraryStore.includes('saveDraft') || !characterTemplateLibraryStore.includes('importLibraryJson') || !characterTemplateLibraryStore.includes('exportLibraryJson')) fail('缺少新版本地角色模板库的生成、存储、导入导出能力');
if (!avatarCodec.includes('compressLocalAvatar') || !avatarCodec.includes('MAX_SOURCE_AVATAR_BYTES') || !avatarCodec.includes('projectAvatarError')) fail('缺少本地头像压缩与安全错误投影');
if (!characterCreator.includes('registerCharacter') || !characterCreator.includes('importCharacterTemplate') || !characterCreator.includes('compressLocalAvatar')) fail('缺少角色创建/导入/头像/MVU 登记接线');
if (!controlledPatch.includes('buildCharacterRegistrationPatch') || !actionBridge.includes('registerCharacter') || !index.includes('createCharacterTemplateLibraryStore')) fail('缺少角色受控登记或新版本地模板库实例化接线');
const characterAuthoringService = await readFile(resolve(root, 'src/characters/character-authoring-service.js'), 'utf8');
if (!characterAuthoringService.includes('generateCharacterCompletionCandidate') || !characterAuthoringService.includes('generateCharacterAuthoringCandidate') || !characterAuthoringService.includes("functionKey: 'character_ai_completion'") || !characterAuthoringService.includes("functionKey: 'character_full_authoring'")) fail('缺少角色补全/完整创作模型服务或独立功能绑定');
if (!characterCreator.includes('AI 补全 / 完整创作') || !characterCreator.includes('generateCharacterCompletionDraft') || !characterCreator.includes('generateCharacterAuthoringDraft')) fail('缺少只载入草稿的 AI 角色创作 UI 接线');
if (!actionBridge.includes('generateCharacterCompletionDraft') || !actionBridge.includes('generateCharacterAuthoringDraft')) fail('缺少 AI 角色创作受控桥接');
if (!appShell.includes('createLauncherDragController') || !appShell.includes('launcherDrag.dispose')) fail('缺少小手机悬浮入口拖动控制器接线');
if (!characterCreator.includes('只保存当前草稿到本地模板库') || !characterCreator.includes('导入单个模板到本地库') || !characterCreator.includes('合并导入整个模板库') || !characterCreator.includes('导出整个库')) fail('缺少创建角色界面的模板库生成、存储、导入导出 UI 接线');
console.log('✓ 角色模板、本地头像、AI 补全/完整创作草稿、模板库与受控登记接线');

const groupDiscoveryService = await readFile(resolve(root, 'src/groups/group-discovery-service.js'), 'utf8');
if (!groupDiscoveryService.includes('buildGroupBrowseModel') || !groupDiscoveryService.includes('listGroupDiscoverableCharacters') || !groupDiscoveryService.includes('projectPublicGroupCharacter')) fail('缺少群组公开浏览或发现人物投影服务');
if (!uiModel.includes('buildGroupBrowseModel') || !appShell.includes('buildGroupsPage') || !appShell.includes('进入已有私聊')) fail('缺少群组浏览、发现人物或已有私聊入口 UI 接线');
console.log('✓ 群组只读浏览、公开发现人物与已有私聊入口已纳入静态检查');

const groupChatService = await readFile(resolve(root, 'src/groups/group-chat-service.js'), 'utf8');
const forumService = await readFile(resolve(root, 'src/groups/forum-service.js'), 'utf8');
const groupLlmSafety = await readFile(resolve(root, 'src/groups/group-llm-safety.js'), 'utf8');
for (const [label, source] of [['群聊服务', groupChatService], ['论坛服务', forumService]]) {
    for (const [pattern, message] of [
        [/\bfetch\s*\(/, '不得直接 fetch'],
        [/\b(?:applyControlledPatch|replaceMvuData|parseMessage|replaceVariables)\s*\(/, '不得执行 MVU 或变量写入'],
        [/\bchat_metadata\b/i, '不得读取聊天元数据'],
    ]) {
        if (pattern.test(source)) fail(`${label}${message}`);
    }
}
if (!groupChatService.includes('generateGroupChatReply') || !forumService.includes('generateForumPostDraft') || !groupLlmSafety.includes('buildPublicGroupLlmContext') || !groupLlmSafety.includes('isSafeGroupLlmOutput')) fail('缺少群聊/论坛草稿服务或公开 LLM 安全投影');
function extractBridgeMethod(source, name) {
    const start = source.indexOf(`async function ${name}`);
    if (start < 0) return '';
    const end = source.indexOf('\n    async function ', start + 1);
    return source.slice(start, end < 0 ? source.length : end);
}
for (const [name, serviceMarker] of [['generateGroupChatDraft', 'generateGroupChatReply'], ['generateForumPostDraft', 'generateForumPostDraft']]) {
    const methodSource = extractBridgeMethod(actionBridge, name);
    if (!methodSource || !methodSource.includes('readLatestState') || !methodSource.includes(serviceMarker)) fail(`缺少 ${name} 的只读草稿桥接`);
    if (/\b(?:applyControlledPatch|replaceMvuData|parseMessage|replaceVariables)\s*\(/.test(methodSource)) fail(`${name} 不得通过受控 Patch 或 MVU 写入`);
}
console.log('✓ 阶段 19 群聊/论坛文件、LLM 安全边界与只读草稿桥接');
const privateChatResponse = await readFile(resolve(root, 'src/chat/private-chat-response.js'), 'utf8');
const privateChatService = await readFile(resolve(root, 'src/chat/private-chat-service.js'), 'utf8');
const matchScoring = await readFile(resolve(root, 'src/recommendation/match-scoring.js'), 'utf8');
if (!privateChatResponse.includes('normalizePrivateChatResponse') || !privateChatResponse.includes('projectPrivateChatResponseError')) fail('缺少私聊模型回复的严格校验与安全错误投影');
if (!privateChatService.includes('validatePrivateChatRequest') || !privateChatService.includes('buildPrivateChatContext') || !privateChatService.includes('generatePrivateChatReply')) fail('缺少私聊上下文隐私投影、请求校验或模型调用接线');
if (!controlledPatch.includes('buildPrivateChatPatch') || !actionBridge.includes('runPrivateChat')) fail('缺少私聊受控 Patch 或唯一 MVU 写入桥接');
if (!appShell.includes('buildMessagesPage') || !appShell.includes('buildPrivateChatPage') || !appShell.includes('openPrivateChat') || !uiModel.includes('private_chat:')) fail('缺少私聊列表、会话子页或消息路由接线');
if (!matchScoring.includes('scorePublicCompatibility') || !matchScoring.includes('scoreTwoLayerMatch') || !controlledPatch.includes('buildLikeMatchPatch')) fail('缺少公开资料双层评分或喜欢后的受控匹配会话创建');
if (!controlledPatch.includes('appendPreferenceWeightOperations') || !controlledPatch.includes('标签权重')) fail('缺少喜欢、收藏、不喜欢的公开标签权重受控更新');
if (!controlledPatch.includes('buildSoulMatchPreferencePatch') || !actionBridge.includes('generateMatchDraft') || !actionBridge.includes('applySoulMatchPreferenceDraft')) fail('缺少灵魂匹配草稿的确认式受控写入链');
const soulTextMatchService = await readFile(resolve(root, 'src/recommendation/soul-text-match-service.js'), 'utf8');
if (!soulTextMatchService.includes('generateSoulMatchDraft') || !soulTextMatchService.includes('generateTextMatchDraft') || !soulTextMatchService.includes('buildSoulTextMatchContext')) fail('缺少灵魂/文字匹配服务或隐私上下文投影');
console.log('✓ 私聊模型回复、隐私上下文、列表/会话 UI、双层评分、标签偏好、灵魂/文字匹配与匹配会话已纳入静态检查');

if (process.exitCode) process.exit(process.exitCode);
console.log('静态检查通过。');

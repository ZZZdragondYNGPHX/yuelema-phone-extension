import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionBridge } from '../../action-bridge.js';
import { createEmptyRelationshipNarrative } from '../../mvu/relationship-narrative.js';
import { createEmptyBodyRelationshipCandidate } from '../../mvu/body-relationship-candidate.js';
import { createEmptyNsfwConsent, grantNsfwConsent } from '../../mvu/nsfw-consent.js';

function adultCandidate() {
    return {
        成人验证: true,
        公开资料: { 昵称: '林澈', 头像引用: '', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '先聊天再约会', 简介: '喜欢看展和散步。', 兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'] },
        仅好友资料: { 关系状态: '单身', 边界与偏好: '尊重拒绝。' },
        隐藏资料: { 实际年龄: 28, 私人备注: '对临时失约敏感。' },
        偏好与边界: '先确认边界。', 拒绝阈值: 35, 已读不回阈值: 55, 取消匹配阈值: 75, 拉黑阈值: 90,
        与玩家关系: { 状态: '陌生', 全局账号表现: 68, NPC专属匹配度: 72, 好感: 0, 信任: 0, 戒备: 10, 面基意愿: 0 },
    };
}

function state() {
    return {
        软件: { 内容模式: 'SFW', 关于软件点击数: 0 },
        玩家: { 成人验证: true, 公开资料: {}, 推荐偏好: { 标签权重: { SFW: {}, NSFW: {} } } },
        角色池: {},
        正文记忆: {},
        正文关系候选: {},
        关系叙事: {},
        推荐: {
            当前队列: ['npc_ava'],
            临时候选池: {
                npc_ava: {
                    成人验证: true,
                    公开资料: { 昵称: '艾娃' },
                    隐藏资料: { 实际年龄: 24, 私人备注: 'not visible' },
                    与玩家关系: { 状态: '陌生', 数值: 0 },
                },
            },
            冷却角色UID: [],
            收藏角色UID: [],
            不喜欢角色UID: [],
            拉黑角色UID: [],
        },
    };
}

function recommendationState() {
    const current = state();
    current.系统 = { UID计数器: { 角色: 12 } };
    current.玩家 = {
        成人验证: true,
        公开资料: { 昵称: '玩家', 年龄段: '成年人', 性别: '男', 性取向: '异性恋', 城市: '上海', 距离范围: '不限', 寻找意图: '聊天', 简介: '公开简介', 兴趣标签: ['电影'], 生活方式标签: [], 性格标签: [], 沟通风格标签: [] },
        隐藏资料: { 私人备注: '不得发送给快速模型' },
        仅好友资料: { 关系状态: '不得发送给快速模型' },
        推荐偏好: { 标签权重: { SFW: { 电影: 2 }, NSFW: {} } },
    };
    return current;
}

const connectionPreset = { id: 'fast', name: 'Fast', url: 'https://example.invalid/v1', model: 'quick', temperature: 0.7, maxTokens: 800, timeoutMs: 30_000 };
const settingsStore = { resolveFunction: () => ({ connectionPreset, promptPreset: { enabled: true, content: '保持轻快、真实的都市语气。' } }) };

function matchedPrivateChatState(contentMode = 'SFW') {
    const current = recommendationState();
    current.软件.内容模式 = contentMode;
    current.角色池 = {
        npc_ava: {
            成人验证: true,
            公开资料: { 昵称: '艾娃' },
            仅好友资料: {}, 隐藏资料: { 实际年龄: 24, 私人备注: '' },
            偏好与边界: '', 拒绝阈值: 0, 已读不回阈值: 80, 取消匹配阈值: 80, 拉黑阈值: 90,
            与玩家关系: { 状态: '已匹配', 全局账号表现: 60, NPC专属匹配度: 70, 好感: 20, 信任: 20, 戒备: 20, 面基意愿: 0, 友情值: 10, 心动值: 20, 欲望值: 30 },
        },
    };
    current.会话 = { chat_1: { 对象UID: 'npc_ava', 状态: '已匹配', 最近消息: [], 已确认边界: '', 已确认承诺: '', NSFW同意: createEmptyNsfwConsent() } };
    current.正文记忆.npc_ava = '';
    current.关系叙事.npc_ava = createEmptyRelationshipNarrative();
    current.正文关系候选.npc_ava = createEmptyBodyRelationshipCandidate();
    return current;
}

function resolvePatchParent(root, pointer) {
    const segments = pointer.split('/').slice(1).map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
    const key = segments.pop();
    let node = root;
    for (const segment of segments) node = node[segment];
    return { node, key };
}

function applyJsonPatch(state, patch) {
    for (const operation of patch) {
        const { node, key } = resolvePatchParent(state, operation.path);
        if (operation.op === 'remove') {
            if (Array.isArray(node)) node.splice(Number(key), 1); else delete node[key];
        } else if (operation.op === 'move') {
            const source = resolvePatchParent(state, operation.from);
            const value = source.node[source.key];
            if (Array.isArray(source.node)) source.node.splice(Number(source.key), 1); else delete source.node[source.key];
            if (Array.isArray(node) && key === '-') node.push(value); else node[key] = value;
        } else if (Array.isArray(node) && key === '-') {
            node.push(operation.value);
        } else {
            node[key] = operation.value;
        }
    }
}

function createMvu({ deferredParse = false, initialState = state(), persistReplacement = false } = {}) {
    const calls = [];
    let releaseParse;
    const parsePromise = deferredParse ? new Promise(resolve => { releaseParse = resolve; }) : null;
    const data = { stat_data: initialState };
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'variable_update_ended' },
        getMvuData(scope) { calls.push(['get', scope]); return data; },
        async parseMessage(raw, oldData) {
            calls.push(['parse', raw, oldData]);
            if (parsePromise) await parsePromise;
            const next = structuredClone(oldData);
            const encoded = raw.match(/<JSONPatch>([\s\S]+)<\/JSONPatch>/u)?.[1];
            if (encoded) applyJsonPatch(next.stat_data, JSON.parse(encoded));
            return next;
        },
        async replaceMvuData(nextData, scope) {
            calls.push(['replace', nextData, scope]);
            if (persistReplacement) data.stat_data = nextData.stat_data;
        },
    };
    return { mvu, calls, data, releaseParse: () => releaseParse?.() };
}

test('favorite action is built and committed only through the official MVU pipeline', async () => {
    const { mvu, calls } = createMvu();
    const emitted = [];
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu,
        eventEmit: async (...args) => { emitted.push(args); },
    });

    const result = await bridge.runMvuAction('favorite', 'npc_ava');
    assert.equal(result.ok, true);
    assert.equal(calls.filter(([name]) => name === 'replace').length, 1);
    assert.equal(emitted.length, 1);
    const update = calls.find(([name]) => name === 'parse')[1];
    assert.match(update, /^<UpdateVariable><JSONPatch>/u);
    assert.match(update, /"op":"move"/u);
    assert.match(update, /收藏角色UID/u);
});

test('喜欢和不喜欢只在 MVU 写入成功后同步公开标签到本地个性化权重', async () => {
    const initialState = state();
    initialState.系统 = { UID计数器: { 会话: 0 } };
    initialState.会话 = {};
    initialState.推荐.临时候选池.npc_ava = adultCandidate();
    initialState.推荐.临时候选池.npc_ava.公开资料 = {
        昵称: '艾娃',
        兴趣标签: ['电影', '摄影'],
        生活方式标签: ['夜猫子'],
        性格标签: ['直接'],
        沟通风格标签: ['慢热'],
    };
    const { mvu } = createMvu({ initialState });
    const deltas = [];
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu,
        eventEmit: async () => {},
        settingsStore: {
            applyPersonalizationKeywordWeightDelta(contentMode, tags, delta) {
                deltas.push([contentMode, tags, delta]);
            },
        },
    });

    const liked = await bridge.runMvuAction('like', 'npc_ava');
    assert.equal(liked.ok, true);
    assert.deepEqual(deltas, [['SFW', ['电影', '摄影', '夜猫子', '直接', '慢热'], 3]]);

    const disliked = await bridge.runMvuAction('dislike', 'npc_ava');
    assert.equal(disliked.ok, true);
    assert.deepEqual(deltas, [
        ['SFW', ['电影', '摄影', '夜猫子', '直接', '慢热'], 3],
        ['SFW', ['电影', '摄影', '夜猫子', '直接', '慢热'], -3],
    ]);
});

test('SFW/NSFW 滑块通过受控 MVU 管线实际切换内容模式', async () => {
    const initialState = state();
    delete initialState.软件.关于软件点击数;
    const calls = [];
    const data = { stat_data: initialState };
    let persisted;
    const mvu = {
        events: { VARIABLE_UPDATE_ENDED: 'variable_update_ended' },
        getMvuData(scope) { calls.push(['get', scope]); return data; },
        async parseMessage(raw, oldData) {
            calls.push(['parse', raw, oldData]);
            const encoded = raw.match(/<JSONPatch>([\s\S]+)<\/JSONPatch>/u)?.[1];
            const patch = JSON.parse(encoded);
            const next = structuredClone(oldData);
            for (const operation of patch) {
                if (operation.path === '/软件/内容模式') next['stat_data']['软件']['内容模式'] = operation.value;
            }
            return next;
        },
        async replaceMvuData(nextData, scope) { calls.push(['replace', nextData, scope]); persisted = nextData; },
    };
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
    });

    const result = await bridge.runMvuAction('toggle_content_mode');

    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.equal(persisted['stat_data']['软件']['内容模式'], 'NSFW');
    assert.equal(Object.hasOwn(persisted['stat_data']['软件'], '关于软件点击数'), false, '本地五击解锁不应要求或写入旧计数字段');
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'parse', 'replace', 'event']);
});

test('duplicate controlled action is rejected while the first action is in flight', async () => {
    const { mvu, releaseParse } = createMvu({ deferredParse: true });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu,
        eventEmit: async () => {},
    });

    const first = bridge.runMvuAction('refresh', 'npc_ava');
    const duplicate = await bridge.runMvuAction('refresh', 'npc_ava');
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.code, 'ui_action_pending');
    releaseParse();
    assert.equal((await first).ok, true);
});

test('invalid generated candidate performs no MVU write and leaves recommendation state untouched', async () => {
    const initialState = recommendationState();
    const before = structuredClone(initialState);
    const { mvu, calls, data } = createMvu({ initialState });
    const emitted = [];
    const seededKeywords = [];
    const underage = adultCandidate();
    underage.隐藏资料.实际年龄 = 17;
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu,
        eventEmit: async (...args) => { emitted.push(args); },
        settingsStore: {
            ...settingsStore,
            ensurePersonalizationKeywordWeights(contentMode, tags) { seededKeywords.push([contentMode, tags]); },
        },
        llmClient: { async chat() { return { text: JSON.stringify(underage) }; } },
    });

    const result = await bridge.runRecommendationRefresh('npc_ava');

    assert.equal(result.ok, false);
    assert.deepEqual(calls.map(([name]) => name), ['get']);
    assert.equal(calls.some(([name]) => name === 'parse' || name === 'replace'), false);
    assert.deepEqual(emitted, []);
    assert.deepEqual(seededKeywords, [], '模型或 MVU 事务未成功时不得提前污染本地关键词词库。');
    assert.deepEqual(data.stat_data, before);
});

test('successful generated recommendation starts public-only image matching without waiting before the controlled commit', async () => {
    const { mvu, calls } = createMvu({ initialState: recommendationState() });
    const seededKeywords = [];
    const imageMatches = [];
    const signal = new AbortController().signal;
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
        settingsStore: {
            ...settingsStore,
            ensurePersonalizationKeywordWeights(contentMode, tags) { seededKeywords.push([contentMode, tags]); },
        },
        llmClient: { async chat() { return { text: JSON.stringify(adultCandidate()) }; } },
        imageMatchCoordinator: {
            match(publicProfile, options) {
                imageMatches.push([structuredClone(publicProfile), options]);
                return new Promise(() => {});
            },
        },
    });

    const result = await bridge.runRecommendationRefresh('npc_ava', { signal });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'get', 'parse', 'replace', 'event']);
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /^<UpdateVariable><JSONPatch>/u);
    assert.match(wrappedPatch, /npc_llm_13/u);
    assert.match(wrappedPatch, /冷却角色UID/u);
    assert.deepEqual(seededKeywords, [['SFW', ['电影', '夜猫子', '直接', '慢热']]], '仅在官方写回成功后才以 0 权重收录新公开标签。');
    assert.equal(imageMatches.length, 1, '图片匹配 Promise 未完成也不得阻塞推荐写回。');
    assert.deepEqual(imageMatches[0][0], adultCandidate().公开资料);
    assert.equal(Object.hasOwn(imageMatches[0][0], '隐藏资料'), false);
    assert.deepEqual(imageMatches[0][1], { contentMode: 'SFW', signal });
});
test('user-authored adult character is registered only through the controlled MVU pipeline', async () => {
    const { mvu, calls } = createMvu({ initialState: recommendationState() });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
    });

    const result = await bridge.registerCharacter(adultCandidate());

    assert.equal(result.ok, true);
    assert.equal(result.npcUid, 'npc_custom_13', '登记成功结果应返回受控边界分配的角色 UID，供浏览器本地头像建立映射');
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'parse', 'replace', 'event']);
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /npc_custom_13/u);
    assert.match(wrappedPatch, /临时候选池/u);
    assert.doesNotMatch(wrappedPatch, /当前队列/u, '创建后应等待关键词相近的刷新或匹配，而不是立刻强制展示');
});

test('home refresh selects a positive-keyword custom character before any model request', async () => {
    const initialState = recommendationState();
    initialState.推荐.临时候选池.npc_custom_13 = adultCandidate();
    let modelCalls = 0;
    const { mvu, calls } = createMvu({ initialState });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
        settingsStore: {
            snapshot() {
                return { personalization: { keywordWeightsByMode: { SFW: [{ keyword: '电影', weight: 4 }], NSFW: [] } } };
            },
        },
        llmClient: { async chat() { modelCalls += 1; return { text: '{}' }; } },
    });

    const result = await bridge.runRecommendationRefresh('npc_ava');

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.candidateSource, 'custom');
    assert.equal(result.npcUid, 'npc_custom_13');
    assert.equal(modelCalls, 0);
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /npc_custom_13/u);
    assert.doesNotMatch(wrappedPatch, /npc_llm_/u);
});

test('invalid user-authored character never enters the MVU write pipeline', async () => {
    const initialState = recommendationState();
    const { mvu, calls, data } = createMvu({ initialState });
    const invalid = adultCandidate();
    invalid.隐藏资料.实际年龄 = 16;
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu, eventEmit: async () => {},
    });

    const result = await bridge.registerCharacter(invalid);
    assert.equal(result.ok, false);
    assert.deepEqual(calls.map(([name]) => name), ['get']);
    assert.deepEqual(data.stat_data, initialState);
    // 2026-07-27 控制台诊断增强：受控管线的可选 reason 由 action-bridge 原样带出，
    // 只含字段路径与校验结论，绝不含隐藏资料的具体数值。
    assert.equal(result.code, 'character_registration_candidate_invalid');
    assert.equal(result.reason, '成年人校验未通过：字段 隐藏资料.实际年龄');
    assert.equal(JSON.stringify(result).includes('16'), false);
});


test('private chat runs model validation before one official MVU write transaction', async () => {
    const initialState = recommendationState();
    initialState.角色池 = {
        npc_ava: {
            成人验证: true,
            公开资料: { 昵称: '艾娃' },
            仅好友资料: { 关系状态: '单身', 边界与偏好: '先确认意愿。' },
            隐藏资料: { 实际年龄: 24, 私人备注: '不得发送' },
            偏好与边界: '', 拒绝阈值: 0, 已读不回阈值: 80, 取消匹配阈值: 80, 拉黑阈值: 90,
            与玩家关系: { 状态: '已匹配', 全局账号表现: 60, NPC专属匹配度: 70, 好感: 20, 信任: 20, 戒备: 20, 面基意愿: 0 },
        },
    };
    initialState.会话 = { chat_1: { 对象UID: 'npc_ava', 状态: '已匹配', 最近消息: [], 已确认边界: '', 已确认承诺: '', NSFW同意: createEmptyNsfwConsent() } };
    initialState.正文记忆.npc_ava = '玩家与艾娃此前在线下见过一次。';
    initialState.关系叙事.npc_ava = createEmptyRelationshipNarrative();
    initialState.正文关系候选.npc_ava = createEmptyBodyRelationshipCandidate();
    const { mvu, calls } = createMvu({ initialState });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); }, settingsStore,
        llmClient: { async chat() { return { text: JSON.stringify({ replies: ['晚上好。', '聊聊周末？'], relationship: { 好感: 1, 信任: 0, 戒备: -1, 面基意愿: 0 } }) }; } },
    });

    const result = await bridge.runPrivateChat({ sessionUid: 'chat_1', npcUid: 'npc_ava', playerMessage: '晚上好' });

    assert.equal(result.ok, true);
    assert.equal(result.interactionOutcome, 'replied');
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'get', 'parse', 'replace', 'event']);
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /会话\/chat_1\/最近消息/u);
    assert.match(wrappedPatch, /与玩家关系\/好感/u);
    assert.doesNotMatch(wrappedPatch, /不得发送/u);
});

test('private chat backfills only its missing relationship-narrative slot before generating a reply', async () => {
    const initialState = recommendationState();
    initialState.角色池 = {
        npc_ava: {
            成人验证: true,
            公开资料: { 昵称: '艾娃' },
            仅好友资料: {}, 隐藏资料: { 实际年龄: 24, 私人备注: '不得发送' },
            偏好与边界: '', 拒绝阈值: 0, 已读不回阈值: 80, 取消匹配阈值: 80, 拉黑阈值: 90,
            与玩家关系: { 状态: '已匹配', 全局账号表现: 60, NPC专属匹配度: 70, 好感: 20, 信任: 20, 戒备: 20, 面基意愿: 0 },
        },
    };
    initialState.会话 = { chat_1: { 对象UID: 'npc_ava', 状态: '已匹配', 最近消息: [], 已确认边界: '', 已确认承诺: '', NSFW同意: createEmptyNsfwConsent() } };
    initialState.正文记忆.npc_ava = '';
    initialState.正文关系候选.npc_ava = createEmptyBodyRelationshipCandidate();
    const { mvu, calls } = createMvu({ initialState, persistReplacement: true });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu, eventEmit: async (...args) => { calls.push(['event', ...args]); }, settingsStore,
        llmClient: { async chat() { return { text: JSON.stringify({ replies: ['晚上好。'], relationship: { 好感: 1, 信任: 0, 戒备: 0, 面基意愿: 0 } }) }; } },
    });

    const result = await bridge.runPrivateChat({ sessionUid: 'chat_1', npcUid: 'npc_ava', playerMessage: '晚上好' });

    assert.equal(result.ok, true);
    const parsedPatches = calls.filter(([name]) => name === 'parse')
        .map(([, raw]) => JSON.parse(raw.match(/<JSONPatch>([\s\S]+)<\/JSONPatch>/u)[1]));
    assert.equal(parsedPatches.length, 2);
    assert.deepEqual(parsedPatches[0].map((operation) => operation.path), ['/关系叙事/npc_ava']);
    assert.equal(parsedPatches[0][0].op, 'add');
    assert.deepEqual(parsedPatches[0][0].value, createEmptyRelationshipNarrative());
    assert.equal(parsedPatches[1].some((operation) => operation.path === '/会话/chat_1/最近消息/-'), true);
});

test('dedicated NSFW safety action derives the role from the latest session and commits only one protected leaf', async () => {
    const initialState = matchedPrivateChatState('NSFW');
    const { mvu, calls } = createMvu({ initialState, persistReplacement: true });
    const bridge = createActionBridge({ documentRef: { querySelector: () => null }, mvu, eventEmit: async () => {} });

    const paused = await bridge.runPrivateChatNsfwSafety({ sessionUid: 'chat_1', action: 'pause', npcUid: 'npc_forged' });
    assert.equal(paused.ok, true, JSON.stringify(paused));
    let patches = calls.filter(([name]) => name === 'parse')
        .map(([, raw]) => JSON.parse(raw.match(/<JSONPatch>([\s\S]+)<\/JSONPatch>/u)[1]));
    assert.deepEqual(patches[0], [{ op: 'replace', path: '/关系叙事/npc_ava/进程/边界暂停状态', value: '仅SFW' }]);

    const resumed = await bridge.runPrivateChatNsfwSafety({ sessionUid: 'chat_1', action: 'resume' });
    assert.equal(resumed.ok, true);
    patches = calls.filter(([name]) => name === 'parse')
        .map(([, raw]) => JSON.parse(raw.match(/<JSONPatch>([\s\S]+)<\/JSONPatch>/u)[1]));
    assert.deepEqual(patches[1], [{ op: 'replace', path: '/关系叙事/npc_ava/进程/边界暂停状态', value: '' }]);
});

test('stage C consent, explicit direction, and downgrade actions each use the latest controlled MVU transaction', async () => {
    const initialState = matchedPrivateChatState('NSFW');
    initialState.角色池.npc_ava.与玩家关系.心动值 = 50;
    initialState.关系叙事.npc_ava.进程.NSFW方向确认可用 = true;
    const { mvu, calls, data } = createMvu({ initialState, persistReplacement: true });
    const bridge = createActionBridge({ documentRef: { querySelector: () => null }, mvu, eventEmit: async () => {} });

    const granted = await bridge.runPrivateChatNsfwConsent({
        sessionUid: 'chat_1', action: 'grant', scopes: ['成人话题'], turns: 3,
    });
    assert.equal(granted.ok, true);
    assert.equal(data.stat_data.会话.chat_1.NSFW同意.状态, '有效');

    const direction = await bridge.runPrivateChatNsfwDirection({ sessionUid: 'chat_1', direction: 'love' });
    assert.equal(direction.ok, true);
    assert.equal(data.stat_data.关系叙事.npc_ava.进程.NSFW路线锁定, '爱情');

    data.stat_data.关系叙事.npc_ava.进程.冻结关系值 = '欲望值';
    const degraded = await bridge.runPrivateChatNsfwRelationshipAction({ sessionUid: 'chat_1', action: 'degrade_to_friends' });
    assert.equal(degraded.ok, true);
    assert.equal(data.stat_data.关系叙事.npc_ava.进程.NSFW路线锁定, '暂不定义');
    assert.equal(data.stat_data.关系叙事.npc_ava.进程.冻结关系值, '');
    assert.equal(data.stat_data.关系叙事.npc_ava.进程.边界暂停状态, '仅SFW');
    assert.equal(data.stat_data.会话.chat_1.NSFW同意.状态, '已撤回');
    assert.equal(calls.filter(([name]) => name === 'replace').length, 3);
});

test('private chat fails closed when only-SFW changes during the async model request', async () => {
    const initialState = matchedPrivateChatState('NSFW');
    initialState.会话.chat_1.NSFW同意 = grantNsfwConsent(initialState.会话.chat_1.NSFW同意, { scopes: ['成人话题'], turns: 3 });
    const { mvu, calls, data } = createMvu({ initialState });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu, eventEmit: async () => {}, settingsStore,
        llmClient: {
            async chat() {
                data.stat_data.关系叙事.npc_ava.进程.边界暂停状态 = '仅SFW';
                return { text: JSON.stringify({ replies: ['收到。'], relationship: { 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 } }) };
            },
        },
    });
    const result = await bridge.runPrivateChat({ sessionUid: 'chat_1', npcUid: 'npc_ava', playerMessage: '继续聊', turnConsentConfirmed: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'private_chat_safety_state_changed');
    assert.equal(calls.some(([name]) => name === 'parse'), false);
});

test('private chat rejects a consent revision changed while the model request is in flight', async () => {
    const initialState = matchedPrivateChatState('NSFW');
    initialState.会话.chat_1.NSFW同意 = grantNsfwConsent(initialState.会话.chat_1.NSFW同意, { scopes: ['成人话题'], turns: 3 });
    const { mvu, calls, data } = createMvu({ initialState });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu, eventEmit: async () => {}, settingsStore,
        llmClient: {
            async chat() {
                data.stat_data.会话.chat_1.NSFW同意 = grantNsfwConsent(data.stat_data.会话.chat_1.NSFW同意, { scopes: ['露骨调情'], turns: 1 });
                return { text: JSON.stringify({
                    replies: ['范围已经变化，请重新确认。'], relationship: { 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 },
                    nsfwConsentAssessment: 'in_scope',
                }) };
            },
        },
    });
    const result = await bridge.runPrivateChat({
        sessionUid: 'chat_1', npcUid: 'npc_ava', playerMessage: '继续聊', turnConsentConfirmed: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'private_chat_nsfw_consent_state_changed');
    assert.equal(calls.some(([name]) => name === 'parse'), false);
});


test('private chat returns read_without_reply after the local rhythm builder suppresses model bubbles', async () => {
    const initialState = recommendationState();
    initialState.角色池 = {
        npc_ava: {
            成人验证: true,
            公开资料: { 昵称: '艾娃' },
            仅好友资料: { 关系状态: '单身', 边界与偏好: '先确认意愿。' },
            隐藏资料: { 实际年龄: 24, 私人备注: '不得发送' },
            偏好与边界: '', 拒绝阈值: 0, 已读不回阈值: 55, 取消匹配阈值: 80, 拉黑阈值: 90,
            // 2026-07-27 节奏校准修复后，已读不回需要真实恶化：使用已紧张的关系并越过开局宽限层数。
            与玩家关系: { 状态: '已匹配', 全局账号表现: 60, NPC专属匹配度: 70, 好感: 5, 信任: 5, 戒备: 40, 面基意愿: 0 },
        },
    };
    initialState.会话 = { chat_1: { 对象UID: 'npc_ava', 状态: '已匹配', 最近消息: [], 对话层数: 12, 已确认边界: '', 已确认承诺: '', NSFW同意: createEmptyNsfwConsent() } };
    initialState.正文记忆.npc_ava = '';
    initialState.关系叙事.npc_ava = createEmptyRelationshipNarrative();
    initialState.正文关系候选.npc_ava = createEmptyBodyRelationshipCandidate();
    const { mvu, calls } = createMvu({ initialState });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); }, settingsStore,
        llmClient: { async chat() { return { text: JSON.stringify({ replies: ['这条不得写入。'], relationship: { 好感: -10, 信任: 0, 戒备: 5, 面基意愿: 0 } }) }; } },
    });

    const result = await bridge.runPrivateChat({ sessionUid: 'chat_1', npcUid: 'npc_ava', playerMessage: '刚才抱歉' });

    assert.equal(result.ok, true);
    assert.equal(result.interactionOutcome, 'read_without_reply');
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /对方已读，但暂时没有回复/u);
    assert.doesNotMatch(wrappedPatch, /这条不得写入/u);
});

test('private chat returns blocked only after the controlled patch atomically blocks the role and session', async () => {
    const initialState = recommendationState();
    initialState.角色池 = {
        npc_ava: {
            成人验证: true,
            公开资料: { 昵称: '艾娃' },
            仅好友资料: { 关系状态: '单身', 边界与偏好: '先确认意愿。' },
            隐藏资料: { 实际年龄: 24, 私人备注: '不得发送' },
            偏好与边界: '', 拒绝阈值: 0, 已读不回阈值: 50, 取消匹配阈值: 80, 拉黑阈值: 80,
            与玩家关系: { 状态: '已匹配', 全局账号表现: 60, NPC专属匹配度: 70, 好感: 0, 信任: 0, 戒备: 90, 面基意愿: 0 },
        },
    };
    // 拉黑只在开局宽限层数之外仍持续恶化/不改善时触发。
    initialState.会话 = { chat_1: { 对象UID: 'npc_ava', 状态: '已匹配', 最近消息: [], 对话层数: 12, 已确认边界: '', 已确认承诺: '', NSFW同意: createEmptyNsfwConsent() } };
    initialState.正文记忆.npc_ava = '';
    initialState.关系叙事.npc_ava = createEmptyRelationshipNarrative();
    initialState.正文关系候选.npc_ava = createEmptyBodyRelationshipCandidate();
    const { mvu, calls } = createMvu({ initialState });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); }, settingsStore,
        llmClient: { async chat() { return { text: JSON.stringify({ replies: ['这条不得写入。'], relationship: { 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 } }) }; } },
    });

    const result = await bridge.runPrivateChat({ sessionUid: 'chat_1', npcUid: 'npc_ava', playerMessage: '继续发送' });

    assert.equal(result.ok, true);
    assert.equal(result.interactionOutcome, 'blocked');
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /已拉黑/u);
    assert.match(wrappedPatch, /拉黑角色UID/u);
    assert.doesNotMatch(wrappedPatch, /这条不得写入/u);
});

test('clearPrivateChat reads fresh state, uses the dedicated builder, and commits only through the official pipeline', async () => {
    const initialState = recommendationState();
    initialState.角色池 = {
        npc_ava: {
            成人验证: true,
            公开资料: { 昵称: '艾娃' },
            仅好友资料: {}, 隐藏资料: { 实际年龄: 24, 私人备注: '' },
            偏好与边界: '', 拒绝阈值: 0, 已读不回阈值: 55, 取消匹配阈值: 80, 拉黑阈值: 90,
            与玩家关系: { 状态: '已匹配', 全局账号表现: 60, NPC专属匹配度: 70, 好感: 20, 信任: 20, 戒备: 20, 面基意愿: 0 },
        },
    };
    initialState.会话 = { chat_1: { 对象UID: 'npc_ava', 状态: '已匹配', 最近消息: [], 已确认边界: '', 已确认承诺: '', NSFW同意: createEmptyNsfwConsent() } };
    const { mvu, calls } = createMvu({ initialState });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
    });
    const result = await bridge.clearPrivateChat('chat_1');

    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'parse', 'replace', 'event']);
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /"op":"remove","path":"\/会话\/chat_1"/u);
    assert.match(wrappedPatch, /与玩家关系\/状态/u);
    assert.doesNotMatch(wrappedPatch, /角色池\/npc_ava"/u);
});


test('deleteCharacter reads fresh state and atomically removes every character reference through the official pipeline', async () => {
    const initialState = recommendationState();
    initialState.系统 = { UID计数器: { 角色: 12, 会话: 8, 面基: 4, 群组: 2 } };
    initialState.角色池 = {
        npc_ava: adultCandidate(),
        npc_other: { ...adultCandidate(), 公开资料: { ...adultCandidate().公开资料, 昵称: '其他角色' } },
    };
    initialState.正文记忆 = { npc_ava: '玩家与艾娃的经历。', npc_other: '玩家与其他角色的经历。' };
    initialState.正文关系候选 = { npc_ava: createEmptyBodyRelationshipCandidate(), npc_other: createEmptyBodyRelationshipCandidate() };
    initialState.关系叙事 = { npc_ava: createEmptyRelationshipNarrative(), npc_other: createEmptyRelationshipNarrative() };
    initialState.推荐 = {
        当前队列: ['npc_ava', 'npc_other'],
        临时候选池: { npc_ava: adultCandidate() },
        冷却角色UID: ['npc_ava'], 收藏角色UID: ['npc_ava'],
        不喜欢角色UID: [], 拉黑角色UID: ['npc_other', 'npc_ava'],
    };
    initialState.会话 = {
        chat_1: { 对象UID: 'npc_ava', 状态: '已匹配', 最近消息: [], 已确认边界: '', 已确认承诺: '', NSFW同意: createEmptyNsfwConsent() },
        chat_other: { 对象UID: 'npc_other', 状态: '已匹配', 最近消息: [], 已确认边界: '', 已确认承诺: '', NSFW同意: createEmptyNsfwConsent() },
    };
    initialState.面基记录 = {
        meetup_1: { 对象UID: 'npc_ava', 状态: '待发送' },
        meetup_other: { 对象UID: 'npc_other', 状态: '已结束' },
    };
    initialState.群组 = {
        group_city: { 主题: '城市夜谈', 描述: '', 成员UID: ['npc_ava', 'npc_other'], 可发现角色UID: ['npc_ava'] },
    };
    const { mvu, calls } = createMvu({ initialState });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
    });

    const result = await bridge.deleteCharacter('npc_ava');

    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'parse', 'replace', 'event']);
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    const patch = JSON.parse(wrappedPatch.match(/<JSONPatch>([\s\S]+)<\/JSONPatch>/u)[1]);
    assert.equal(patch.some((operation) => operation.path === '/角色池/npc_ava' && operation.op === 'remove'), true);
    assert.equal(patch.some((operation) => operation.path === '/关系叙事/npc_ava' && operation.op === 'remove'), true);
    assert.equal(patch.some((operation) => operation.path === '/推荐/临时候选池/npc_ava' && operation.op === 'remove'), true);
    assert.equal(patch.some((operation) => operation.path === '/会话/chat_1' && operation.op === 'remove'), true);
    assert.equal(patch.some((operation) => operation.path === '/面基记录/meetup_1' && operation.op === 'remove'), true);
    assert.deepEqual(result.data.stat_data.推荐.当前队列, ['npc_other']);
    assert.deepEqual(result.data.stat_data.推荐.拉黑角色UID, ['npc_other']);
    assert.deepEqual(result.data.stat_data.群组.group_city.成员UID, ['npc_other']);
    assert.deepEqual(result.data.stat_data.群组.group_city.可发现角色UID, []);
    assert.equal(Object.hasOwn(result.data.stat_data.角色池, 'npc_ava'), false);
    assert.equal(Object.hasOwn(result.data.stat_data.关系叙事, 'npc_ava'), false);
    assert.equal(Object.hasOwn(result.data.stat_data.会话, 'chat_other'), true);
    assert.equal(Object.hasOwn(result.data.stat_data.面基记录, 'meetup_other'), true);
    assert.deepEqual(result.data.stat_data.系统.UID计数器, { 角色: 12, 会话: 8, 面基: 4, 群组: 2 });
});


test('AI character completion and full authoring return memory drafts before any registration write', async () => {
    const initialState = recommendationState();
    initialState.软件 = { 内容模式: 'NSFW', 关于软件点击数: 0 };
    const { mvu, calls } = createMvu({ initialState });
    const requests = [];
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu, eventEmit: async () => {}, settingsStore,
        llmClient: { async chat(request) { requests.push(request); return { text: JSON.stringify(adultCandidate()) }; } },
    });

    const completion = await bridge.generateCharacterCompletionDraft({
        publicProfile: adultCandidate().公开资料,
        instruction: '补全为一名明确成年、适合先文字聊天的都市角色。',
    });
    assert.equal(completion.ok, true);
    assert.equal(completion.candidate.公开资料.头像引用, '');
    assert.deepEqual(calls, []);
    assert.doesNotMatch(JSON.stringify(requests[0].messages), /对临时失约敏感/u);

    const full = await bridge.generateCharacterAuthoringDraft({ creativeBrief: '创作一名明确成年的现代都市软件角色。' });
    assert.equal(full.ok, true);
    assert.equal(full.candidate.成人验证, true);
    assert.equal(full.candidate.公开资料.头像引用, '');
    assert.deepEqual(calls.map(([name]) => name), ['get']);
    assert.doesNotMatch(JSON.stringify(requests[1].messages), /公开简介|不得发送给快速模型/u);
    assert.equal(calls.some(([name]) => name === 'parse' || name === 'replace'), false);
});



function emptyRecommendationState() {
    const current = recommendationState();
    current.推荐.当前队列 = [];
    current.推荐.临时候选池 = {};
    return current;
}

function serviceOrderState() {
    const current = recommendationState();
    current.系统 = { UID计数器: { 角色: 12, 服务订单: 0 } };
    current.角色池 = {};
    current.服务订单 = {};
    return current;
}

test('service-order bridge rejects a changed expected mode before it builds or writes a patch', async () => {
    const { mvu, calls } = createMvu({ initialState: serviceOrderState() });
    const bridge = createActionBridge({ documentRef: { querySelector: () => null }, mvu, eventEmit: async () => {} });

    const result = await bridge.runServiceOrderHandoff({ candidate: adultCandidate(), categoryId: 'coffee_walk', expectedContentMode: 'NSFW' });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'service_order_mode_changed');
    assert.deepEqual(calls.map(([name]) => name), ['get']);

    // 2026-07-27 控制台诊断增强：build 层的候选级 reason 由桥接原样带出（候选序号 +
    // 字段路径 + 结论），且绝不包含隐藏资料的具体数值；MVU 未发生任何写入。
    const minor = adultCandidate();
    minor.隐藏资料.实际年龄 = 17;
    const candidateFailure = await bridge.runServiceOrderHandoff({ candidate: minor, categoryId: 'girl_shuren', expectedContentMode: 'SFW' });
    assert.equal(candidateFailure.ok, false);
    assert.equal(candidateFailure.code, 'service_order_candidate_invalid');
    assert.equal(candidateFailure.reason, '候选[1] 成年人校验未通过：字段 隐藏资料.实际年龄');
    assert.equal(JSON.stringify(candidateFailure).includes('17'), false);
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get'], 'reason 增强不得引入任何 parse/replace 写入');

    const wrongGender = adultCandidate();
    wrongGender.公开资料.性别 = '男';
    wrongGender.公开资料.性取向 = '双性恋';
    const compatibilityFailure = await bridge.runServiceOrderHandoff({
        candidate: wrongGender,
        categoryId: 'girl_shuren',
        expectedContentMode: 'SFW',
    });
    assert.equal(compatibilityFailure.ok, false);
    assert.equal(compatibilityFailure.code, 'service_order_basic_compatibility_invalid');
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'get'], '性别硬冲突必须在 build/parse/replace 前拒绝');
});

test('mode toggles wait for a service-order transaction instead of reading the same MVU snapshot', async () => {
    const { mvu, calls, releaseParse } = createMvu({ deferredParse: true, initialState: serviceOrderState() });
    const bridge = createActionBridge({ documentRef: { querySelector: () => null }, mvu, eventEmit: async () => {} });

    const handoff = bridge.runServiceOrderHandoff({ candidate: adultCandidate(), categoryId: 'girl_shuren', expectedContentMode: 'SFW' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter(([name]) => name === 'get').length, 2);
    assert.equal(calls.filter(([name]) => name === 'parse').length, 1);

    const toggle = bridge.runMvuAction('toggle_content_mode');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter(([name]) => name === 'get').length, 2, 'queued toggle must not read until the order commit releases the shared lane');

    releaseParse();
    const [handoffResult, toggleResult] = await Promise.all([handoff, toggle]);
    assert.equal(handoffResult.ok, true);
    assert.equal(toggleResult.ok, true);
    assert.equal(calls.filter(([name]) => name === 'get').length, 4);
});

test('full authoring rejects a stale expected content mode after local generation without writing MVU', async () => {
    const initialState = recommendationState();
    initialState.软件 = { 内容模式: 'SFW', 关于软件点击数: 0 };
    const { mvu, calls, data } = createMvu({ initialState });
    let modelCalls = 0;
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu, eventEmit: async () => {}, settingsStore,
        llmClient: {
            async chat() {
                modelCalls += 1;
                data.stat_data.软件.内容模式 = 'NSFW';
                return { text: JSON.stringify(adultCandidate()) };
            },
        },
    });

    const result = await bridge.generateCharacterAuthoringDraft({
        creativeBrief: '创作一名明确成年的现代都市软件角色。', expectedContentMode: 'SFW',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'character_authoring_mode_changed');
    assert.equal(modelCalls, 1);
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get']);
    assert.equal(calls.some(([name]) => name === 'parse' || name === 'replace'), false);
});
test('initial fast-model candidate also starts image matching after public-profile validation', async () => {
    const initialState = emptyRecommendationState();
    initialState.软件.内容模式 = 'NSFW';
    const { mvu, calls } = createMvu({ initialState });
    const seededKeywords = [];
    const imageMatches = [];
    const signal = new AbortController().signal;
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
        settingsStore: {
            ...settingsStore,
            ensurePersonalizationKeywordWeights(contentMode, tags) { seededKeywords.push([contentMode, tags]); },
        },
        llmClient: { async chat() { return { text: JSON.stringify(adultCandidate()) }; } },
        imageMatchCoordinator: {
            async match(publicProfile, options) {
                imageMatches.push([structuredClone(publicProfile), options]);
                return { ok: true, match: null };
            },
        },
    });

    const result = await bridge.runRecommendationInitialCandidate({ signal });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'get', 'parse', 'replace', 'event']);
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /npc_llm_13/u);
    assert.doesNotMatch(wrappedPatch, /冷却角色UID/u);
    assert.deepEqual(seededKeywords, [['NSFW', ['电影', '夜猫子', '直接', '慢热']]]);
    assert.equal(imageMatches.length, 1);
    assert.deepEqual(imageMatches[0][0], adultCandidate().公开资料);
    assert.deepEqual(imageMatches[0][1], { contentMode: 'NSFW', signal });
});

test('initial fast-model candidate performs zero writes on model rejection or a changed queue', async () => {
    const invalidState = emptyRecommendationState();
    const invalid = adultCandidate();
    invalid.隐藏资料.实际年龄 = 17;
    const invalidHarness = createMvu({ initialState: invalidState });
    const invalidBridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu: invalidHarness.mvu, eventEmit: async () => {}, settingsStore,
        llmClient: { async chat() { return { text: JSON.stringify(invalid) }; } },
    });
    const invalidResult = await invalidBridge.runRecommendationInitialCandidate();
    assert.equal(invalidResult.ok, false);
    assert.deepEqual(invalidHarness.calls.map(([name]) => name), ['get']);

    const changedState = emptyRecommendationState();
    const changedHarness = createMvu({ initialState: changedState });
    const changedBridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu: changedHarness.mvu, eventEmit: async () => {}, settingsStore,
        llmClient: { async chat() {
            changedHarness.data['stat_data'].推荐.当前队列.push('npc_ava');
            changedHarness.data['stat_data'].推荐.临时候选池.npc_ava = adultCandidate();
            return { text: JSON.stringify(adultCandidate()) };
        } },
    });
    const changedResult = await changedBridge.runRecommendationInitialCandidate();
    assert.equal(changedResult.ok, false);
    assert.equal(changedResult.code, 'recommendation_initial_queue_not_empty');
    assert.deepEqual(changedHarness.calls.map(([name]) => name), ['get', 'get']);
    assert.equal(changedHarness.calls.some(([name]) => name === 'parse' || name === 'replace'), false);
});



test('player public profile save uses only the MVU get to parse to replace to event pipeline', async () => {
    const initialState = recommendationState();
    initialState.软件.功能开关 = { 玩家已建档: false };
    initialState.玩家.成人验证 = true;
    const { mvu, calls } = createMvu({ initialState });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
    });
    const profile = {
        昵称: '新昵称', 头像引用: '', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '先聊天', 简介: '只是公开资料',
        兴趣标签: ['电影'], 生活方式标签: [], 性格标签: [], 沟通风格标签: [],
    };
    const result = await bridge.runSavePlayerPublicProfile(profile);
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'parse', 'replace', 'event']);
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /玩家\/公开资料\/昵称/u);
    assert.match(wrappedPatch, /玩家已建档/u);
    assert.doesNotMatch(wrappedPatch, /隐藏资料|实际年龄|replaceVariables|chat_metadata/u);
});

test('player public profile save keeps the official pipeline when an older chat lacks the optional profile gate', async () => {
    const initialState = recommendationState();
    initialState.软件.功能开关 = undefined;
    initialState.玩家.成人验证 = true;
    initialState.玩家.公开资料 = structuredClone(adultCandidate().公开资料);
    const { mvu, calls } = createMvu({ initialState });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
    });
    const profile = { ...adultCandidate().公开资料, 昵称: '兼容旧聊天的昵称' };
    const result = await bridge.runSavePlayerPublicProfile(profile);
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'parse', 'replace', 'event']);
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /玩家\/公开资料\/昵称/u);
    assert.doesNotMatch(wrappedPatch, /玩家已建档/u);
});
function groupDraftState() {
    const current = recommendationState();
    current.角色池 = { npc_group: adultCandidate() };
    current.群组 = {
        group_city: {
            主题: '城市夜谈', 描述: '仅浏览公开兴趣的成年人群组。',
            成员UID: ['npc_group'], 可发现角色UID: ['npc_group'],
        },
    };
    return current;
}

test('group and forum draft bridges read MVU once, use their dedicated bindings, and never write MVU state', async () => {
    const { mvu, calls } = createMvu({ initialState: groupDraftState() });
    const resolved = [];
    const requests = [];
    const groupSettings = {
        resolveFunction(kind) {
            resolved.push(kind);
            return { connectionPreset, promptPreset: { enabled: true, content: '仅使用公开资料。' } };
        },
    };
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu, eventEmit: async (...args) => { calls.push(['event', ...args]); },
        settingsStore: groupSettings,
        llmClient: { async chat(request) {
            requests.push(request);
            return { text: resolved.at(-1) === 'group_chat' ? '{"reply":"今晚有人想聊电影吗？"}' : '{"title":"周末城市夜谈","body":"欢迎分享公开的观影计划。"}' };
        } },
    });

    const groupResult = await bridge.generateGroupChatDraft({ groupUid: 'group_city', playerMessage: '今晚有人聊电影吗？' });
    const forumResult = await bridge.generateForumPostDraft({ groupUid: 'group_city', topic: '周末观影交流' });

    assert.deepEqual(resolved, ['group_chat', 'forum']);
    assert.equal(groupResult.ok, true);
    assert.equal(groupResult.draft.reply, '今晚有人想聊电影吗？');
    assert.equal(forumResult.ok, true);
    assert.equal(forumResult.draft.title, '周末城市夜谈');
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get']);
    assert.equal(calls.some(([name]) => ['parse', 'replace', 'event'].includes(name)), false);
    const userContextJson = requests.map((request) => request.messages.find((message) => message.role === 'user')?.content ?? '').join('\\n');
    assert.doesNotMatch(userContextJson, /不得发送给快速模型|对临时失约敏感|关系状态|npc_group|group_city|UID|JSONPatch|UpdateVariable/u);
});

test('group and forum draft bridge pending keys are isolated by feature and group UID', async () => {
    const { mvu } = createMvu({ initialState: groupDraftState() });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu, eventEmit: async () => {},
        settingsStore: { resolveFunction: () => ({ connectionPreset, promptPreset: { enabled: true, content: '' } }) },
        llmClient: { async chat() { await gate; return { text: '{"reply":"公开短消息"}' }; } },
    });
    const first = bridge.generateGroupChatDraft({ groupUid: 'group_city', playerMessage: '你好' });
    assert.equal(bridge.isPending('group_chat_draft', 'group_city'), true);
    const duplicate = await bridge.generateGroupChatDraft({ groupUid: 'group_city', playerMessage: '你好' });
    assert.equal(duplicate.code, 'ui_action_pending');
    assert.equal(bridge.isPending('forum_draft', 'group_city'), false);
    release();
    assert.equal((await first).ok, true);
});

test('action bridge exposes only the transactional candidate-match entry point', () => {
    const { mvu } = createMvu({ initialState: recommendationState() });
    const bridge = createActionBridge({ documentRef: { querySelector: () => null }, mvu, eventEmit: async () => {} });

    assert.equal(bridge.generateCandidateMatchDraft, undefined);
    assert.equal(typeof bridge.runCandidateMatch, 'function');
});

test('soul match creates an independent npc_match session and never promotes a favourite or queue candidate', async () => {
    const initialState = recommendationState();
    initialState.会话 = {};
    initialState.系统 = { UID计数器: { 角色: 12, 会话: 4 } };
    initialState.推荐.收藏角色UID = ['npc_ava'];
    const { mvu, calls } = createMvu({ initialState });
    const imageMatches = [];
    const signal = new AbortController().signal;
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu, eventEmit: async (...args) => { calls.push(['event', ...args]); },
        settingsStore: {
            snapshot() { return { personalization: { keywordWeightsByMode: { SFW: [{ keyword: '电影', weight: 3 }], NSFW: [] } } }; },
            resolveFunction(key) { assert.equal(key, 'soul_match'); return { connectionPreset, promptPreset: { enabled: true, content: '' } }; },
        },
        llmClient: { async chat() {
            return { text: JSON.stringify({
                profile: {
                    昵称: '林夏', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km',
                    寻找意图: '先聊天再认真约会', 简介: '喜欢电影和夜跑。', 兴趣标签: ['电影'], 生活方式标签: [], 性格标签: [], 沟通风格标签: [],
                }, drawing: { core_dna: 'adult woman, black hair, brown eyes', outfit_dna: 'cream cardigan, dark skirt' }, explanation: '公开兴趣接近。', matchScore: 1,
            }) };
        } },
        imageMatchCoordinator: {
            match(publicProfile, options) {
                imageMatches.push([structuredClone(publicProfile), options]);
                return new Promise(() => {});
            },
        },
    });

    const result = await bridge.runCandidateMatch('soul', { signal });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual([result.npcUid, result.sessionUid], ['npc_match_13', 'chat_5']);
    assert.equal(result.matchOutcome, 'accepted');
    assert.equal(result.matchScore, 91, '决策分数必须来自本地算法而不是模型自报的 1。');
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'get', 'parse', 'replace', 'event']);
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /角色池\/npc_match_13|角色池~1npc_match_13/u);
    assert.match(wrappedPatch, /会话\/chat_5|会话~1chat_5/u);
    assert.doesNotMatch(wrappedPatch, /收藏角色UID|当前队列|临时候选池\/npc_ava/u);
    assert.equal(imageMatches.length, 1, '灵魂匹配不得等待图片选择完成。');
    assert.equal(imageMatches[0][0].昵称, '林夏');
    assert.equal(Object.hasOwn(imageMatches[0][0], '隐藏资料'), false);
    assert.deepEqual(imageMatches[0][1], { contentMode: 'SFW', signal });
});

test('soul match promotes a positive-keyword custom character and preserves its authored identity without model generation', async () => {
    const initialState = recommendationState();
    initialState.会话 = {};
    initialState.系统 = { UID计数器: { 角色: 13, 会话: 4 } };
    initialState.推荐.临时候选池.npc_custom_13 = adultCandidate();
    let modelCalls = 0;
    const { mvu, calls, data } = createMvu({ initialState });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
        settingsStore: {
            snapshot() {
                return { personalization: { keywordWeightsByMode: { SFW: [{ keyword: '电影', weight: 4 }], NSFW: [] } } };
            },
        },
        llmClient: { async chat() { modelCalls += 1; return { text: '{}' }; } },
    });

    const result = await bridge.runCandidateMatch('soul');

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.candidateSource, 'custom');
    assert.equal(result.npcUid, 'npc_custom_13');
    assert.equal(result.sessionUid, 'chat_5');
    assert.equal(result.matchOutcome, 'accepted');
    assert.equal(modelCalls, 0);
    const committed = calls.find(([name]) => name === 'replace')[1].stat_data;
    assert.equal(committed.角色池.npc_custom_13.公开资料.昵称, '林澈');
    assert.equal(committed.推荐.临时候选池.npc_custom_13, undefined);
    assert.equal(committed.会话.chat_5.对象UID, 'npc_custom_13');
});

test('voice match first resolves transient voice keywords and then commits the same independent mutual-match session', async () => {
    const initialState = recommendationState();
    initialState.会话 = {};
    initialState.系统 = { UID计数器: { 角色: 5, 会话: 1 } };
    const { mvu, calls } = createMvu({ initialState });
    let modelCall = 0;
    const imageMatches = [];
    const signal = new AbortController().signal;
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu, eventEmit: async (...args) => { calls.push(['event', ...args]); },
        settingsStore: {
            snapshot() { return { personalization: { keywordWeightsByMode: { SFW: [{ keyword: '电影', weight: 1 }], NSFW: [] } } }; },
            resolveFunction(key) { assert.equal(key, 'text_match'); return { connectionPreset, promptPreset: { enabled: true, content: '' } }; },
        },
        llmClient: { async chat() {
            modelCall += 1;
            if (modelCall === 1) return { text: '{"keywordWeights":[{"keyword":"逛展","weight":5}]}' };
            return { text: JSON.stringify({
                profile: {
                    昵称: '顾言', 年龄段: '26-31', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '15 km',
                    寻找意图: '聊天', 简介: '周末喜欢看展和散步。', 兴趣标签: ['逛展'], 生活方式标签: [], 性格标签: [], 沟通风格标签: [],
                }, drawing: { core_dna: 'adult woman, black hair, brown eyes', outfit_dna: 'cream cardigan, dark skirt' }, explanation: '本次语音关键词优先。', matchScore: 1,
            }) };
        } },
        imageMatchCoordinator: {
            match(publicProfile, options) {
                imageMatches.push([structuredClone(publicProfile), options]);
                return Promise.reject(new Error('image model unavailable'));
            },
        },
    });

    const result = await bridge.runCandidateMatch('voice', { voiceText: '想找愿意一起逛展、认真聊天的人。', signal });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual([result.npcUid, result.sessionUid], ['npc_match_6', 'chat_2']);
    assert.equal(result.matchOutcome, 'accepted');
    assert.equal(result.matchScore, 100, '描述匹配只按临时+本地关键词权重本地评分（逛展=5 → 100），玩家资料字段不参与。');
    assert.equal(modelCall, 2, '语音匹配应先解析关键词，再生成候选人');
    assert.deepEqual(calls.map(([name]) => name), ['get', 'get', 'get', 'parse', 'replace', 'event']);
    assert.equal(imageMatches.length, 1, '图片匹配拒绝不得阻塞语音角色生成与 MVU 写回。');
    assert.equal(imageMatches[0][0].昵称, '顾言');
    assert.deepEqual(imageMatches[0][1], { contentMode: 'SFW', signal });
});

test('description match uses its transient positive weights to encounter an authored custom character', async () => {
    const initialState = recommendationState();
    initialState.会话 = {};
    initialState.系统 = { UID计数器: { 角色: 13, 会话: 2 } };
    initialState.推荐.临时候选池.npc_custom_13 = adultCandidate();
    let modelCall = 0;
    const { mvu, calls } = createMvu({ initialState });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
        settingsStore: {
            snapshot() {
                return { personalization: { keywordWeightsByMode: { SFW: [], NSFW: [] } } };
            },
            resolveFunction() {
                return { connectionPreset, promptPreset: { enabled: true, content: '' } };
            },
        },
        llmClient: { async chat() {
            modelCall += 1;
            if (modelCall === 1) return { text: '{"keywordWeights":[{"keyword":"电影","weight":5}]}' };
            return { text: JSON.stringify({
                profile: {
                    昵称: '临时生成者', 年龄段: '25-29', 性别: '女', 性取向: '双性恋',
                    城市: '上海', 距离范围: '10 km', 寻找意图: '聊天', 简介: '临时资料。',
                    兴趣标签: ['电影'], 生活方式标签: [], 性格标签: [], 沟通风格标签: [],
                },
                drawing: { core_dna: 'adult woman, black hair, brown eyes', outfit_dna: 'cream cardigan, dark skirt' },
                explanation: '关键词接近。',
            }) };
        } },
    });

    const result = await bridge.runCandidateMatch('voice', { voiceText: '想找喜欢电影的人。' });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.candidateSource, 'custom');
    assert.equal(result.npcUid, 'npc_custom_13');
    assert.equal(result.sessionUid, 'chat_3');
    assert.equal(modelCall, 2, '描述匹配仍须先提取本次临时关键词，再判断自建角色');
    const wrappedPatch = calls.find(([name]) => name === 'parse')[1];
    assert.match(wrappedPatch, /npc_custom_13/u);
    assert.doesNotMatch(wrappedPatch, /npc_match_/u);
});

test('candidate match rejects a hard gender-orientation mismatch without any MVU write', async () => {
    const initialState = recommendationState();
    initialState.会话 = {};
    initialState.系统 = { UID计数器: { 角色: 8, 会话: 3 } };
    const { mvu, calls } = createMvu({ initialState });
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
        settingsStore: {
            snapshot() { return { personalization: { keywordWeightsByMode: { SFW: [{ keyword: '电影', weight: 5 }], NSFW: [] } } }; },
            resolveFunction(key) { assert.equal(key, 'soul_match'); return { connectionPreset, promptPreset: { enabled: true, content: '' } }; },
        },
        llmClient: { async chat() {
            return { text: JSON.stringify({
                profile: {
                    昵称: '周衡', 年龄段: '25-29', 性别: '男', 性取向: '异性恋', 城市: '上海', 距离范围: '10 km',
                    寻找意图: '聊天', 简介: '模型声称高分，但公开取向不相容。', 兴趣标签: ['电影'], 生活方式标签: [], 性格标签: [], 沟通风格标签: [],
                }, drawing: { core_dna: 'adult woman, black hair, brown eyes', outfit_dna: 'cream cardigan, dark skirt' }, explanation: '本地兼容结果优先。', matchScore: 100,
            }) };
        } },
    });

    const result = await bridge.runCandidateMatch('soul');

    assert.deepEqual(result, {
        ok: false,
        status: 'rejected',
        code: 'candidate_match_basic_compatibility_invalid',
        message: '模型返回的角色不符合性别或性取向硬条件；当前状态未改变。',
    });
    assert.deepEqual(calls.map(([name]) => name), ['get']);
});

test('conversation image bridge composes immutable drawing prompts and never writes MVU', async () => {
    const initialState = state();
    initialState.角色池.npc_ava = {
        ...adultCandidate(),
        绘图: { core_dna: 'adult woman, short black hair', outfit_dna: 'cream cardigan, street fashion' },
    };
    const { mvu, calls } = createMvu({ initialState });
    const imageRequests = [];
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu,
        eventEmit: async (...args) => { calls.push(['event', ...args]); },
        settingsStore: {
            getImageGenerationSettings() {
                return {
                    enabled: true, presetId: 'image_default', apiMode: 'novelai', baseUrl: 'https://image.example.invalid', endpointPath: '/generate',
                    model: 'model', sampler: 'sampler', noiseSchedule: 'schedule', guidance: 7, guidanceRescale: 0,
                    width: 1024, height: 1024, steps: 28, seed: 0, qualityToggle: true, variety: false,
                    positivePrefix: 'masterpiece', positiveSuffix: 'soft lighting', negativePrompt: 'lowres', conversationSettings: { private: {}, group: {}, forum: {} },
                };
            },
        },
        imageGenerationClient: {
            async generate(request) {
                imageRequests.push(request);
                return { kind: 'data_url', mimeType: 'image/png', src: 'data:image/png;base64,iVBORw0KGgo=' };
            },
        },
    });

    const result = await bridge.generateConversationImage({
        kind: 'private', conversationId: 'chat_ava', messageId: 'message_ava_1', characterUid: 'npc_ava',
        directive: { kind: 'selfie', scene: 'smiling at a cafe table' },
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.image.dataUrl, 'data:image/png;base64,iVBORw0KGgo=');
    assert.equal(imageRequests.length, 1);
    assert.equal(imageRequests[0].positivePrompt, 'masterpiece, adult woman, short black hair, cream cardigan, street fashion, smiling at a cafe table, soft lighting');
    assert.equal(imageRequests[0].negativePrompt, 'lowres');
    assert.deepEqual(calls.map(([name]) => name), ['get']);
});

test('conversation image bridge uses ComfyUI-specific prompts without borrowing NAI prompt settings', async () => {
    let request;
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu: createMvu({ initialState: state() }).mvu,
        settingsStore: {
            getImageGenerationSettings() {
                return {
                    enabled: true,
                    apiMode: 'comfyui',
                    positivePrefix: 'nai prefix',
                    positiveSuffix: 'nai suffix',
                    negativePrompt: 'nai negative',
                    comfyPositivePrefix: String.raw`comfy prefix, <lora:detailer\Loraeyes_V1:1>`,
                    comfyPositiveSuffix: 'comfy suffix',
                    comfyNegativePrompt: 'comfy negative',
                };
            },
        },
        imageGenerationClient: {
            async generate(input) {
                request = input;
                return { kind: 'data_url', mimeType: 'image/png', src: 'data:image/png;base64,iVBORw0KGgo=' };
            },
        },
    });
    const result = await bridge.generateConversationImage({
        kind: 'forum',
        conversationId: 'post_city',
        messageId: 'message_city_1',
        directive: { kind: 'scene_snapshot', scene: 'rainy city street' },
    });
    assert.equal(result.ok, true);
    assert.equal(request.positivePrompt, String.raw`comfy prefix, <lora:detailer\Loraeyes_V1:1>, rainy city street, comfy suffix`);
    assert.equal(request.negativePrompt, 'comfy negative');
    assert.doesNotMatch(request.positivePrompt, /nai/u);
});

test('conversation image bridge routes OpenAI-compatible prompts without borrowing NAI or ComfyUI presets', async () => {
    let request;
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu: createMvu({ initialState: state() }).mvu,
        settingsStore: {
            getImageGenerationSettings() {
                return {
                    enabled: true,
                    apiMode: 'openai_compatible',
                    positivePrefix: 'nai tags',
                    positiveSuffix: 'nai suffix',
                    negativePrompt: 'nai negative',
                    openaiPositivePrefix: 'Create a realistic photograph of',
                    openaiPositiveSuffix: 'Use natural light and documentary framing.',
                    openaiNegativePrompt: 'Avoid text and watermarks.',
                    comfyPositivePrefix: 'comfy tags',
                    comfyPositiveSuffix: 'comfy suffix',
                    comfyNegativePrompt: 'comfy negative',
                };
            },
        },
        imageGenerationClient: {
            async generate(input) {
                request = input;
                return { kind: 'data_url', mimeType: 'image/png', src: 'data:image/png;base64,iVBORw0KGgo=' };
            },
        },
    });
    const result = await bridge.generateConversationImage({
        kind: 'forum',
        conversationId: 'post_openai',
        messageId: 'message_openai_1',
        directive: { kind: 'scene_snapshot', scene: 'a rain-soaked private garden at dusk' },
    });
    assert.equal(result.ok, true);
    assert.equal(request.positivePrompt, 'Create a realistic photograph of, a rain-soaked private garden at dusk, Use natural light and documentary framing.');
    assert.equal(request.negativePrompt, 'Avoid text and watermarks.');
    assert.doesNotMatch(request.positivePrompt, /nai|comfy/iu);
});

test('image-library generation uses the user-selected provider, fixed prompt order, and never reads or writes MVU', async () => {
    const { mvu, calls } = createMvu({ initialState: state() });
    let request;
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu,
        settingsStore: {
            getImageGenerationSettings() {
                return {
                    enabled: true,
                    apiMode: 'novelai',
                    positivePrefix: 'nai prefix',
                    positiveSuffix: 'nai suffix',
                    negativePrompt: 'nai negative',
                    openaiPositivePrefix: 'openai prefix',
                    openaiPositiveSuffix: 'openai suffix',
                    openaiNegativePrompt: 'openai negative',
                    comfyPositivePrefix: 'comfy prefix',
                    comfyPositiveSuffix: 'comfy suffix',
                    comfyNegativePrompt: 'comfy negative',
                };
            },
        },
        imageGenerationClient: {
            async generate(input) {
                request = input;
                return { kind: 'data_url', mimeType: 'image/webp', src: 'data:image/webp;base64,UklGRggAAABXRUJQAAAAAA==' };
            },
        },
    });

    const result = await bridge.generateLibraryImage({
        provider: 'openai_compatible',
        prompt: 'rainy city street at dusk',
    });

    assert.equal(result.ok, true);
    assert.equal(result.image.dataUrl, 'data:image/webp;base64,UklGRggAAABXRUJQAAAAAA==');
    assert.equal(request.settings.apiMode, 'openai_compatible');
    assert.equal(request.positivePrompt, 'openai prefix, all depicted people are adults age 18 or older, rainy city street at dusk, openai suffix');
    assert.equal(request.negativePrompt, 'openai negative');
    assert.equal(request.settings.positivePrefix, 'nai prefix', '请求级接口选择不得改写保存设置');
    assert.deepEqual(calls, [], '图片库生图不得读取或写入 MVU');
});

test('image-library generation rejects disabled settings, invalid providers, and unsafe prompt text before the client', async () => {
    let enabled = false;
    let imageCalls = 0;
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        settingsStore: {
            getImageGenerationSettings() {
                return { enabled, apiMode: 'novelai', positivePrefix: '', positiveSuffix: '', negativePrompt: '' };
            },
        },
        imageGenerationClient: { async generate() { imageCalls += 1; } },
    });

    const invalidProvider = await bridge.generateLibraryImage({ provider: 'unknown', prompt: 'city' });
    assert.equal(invalidProvider.code, 'image_provider_invalid');
    const disabled = await bridge.generateLibraryImage({ provider: 'novelai', prompt: 'city' });
    assert.equal(disabled.code, 'image_generation_disabled');

    enabled = true;
    const unsafe = await bridge.generateLibraryImage({ provider: 'novelai', prompt: 'line one\nline two' });
    assert.equal(unsafe.ok, false);
    assert.equal(unsafe.code, 'IMAGE_DIRECTIVE_TEXT_INVALID');
    assert.equal(imageCalls, 0);
});

test('conversation image bridge projects prompt validation with its exact safe phase', async () => {
    const diagnostics = [];
    let imageCalls = 0;
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null },
        mvu: createMvu({ initialState: state() }).mvu,
        settingsStore: {
            getImageGenerationSettings() {
                return {
                    enabled: true,
                    apiMode: 'comfyui',
                    comfyPositivePrefix: '<img src=x onerror=private-value>',
                    comfyPositiveSuffix: '',
                    comfyNegativePrompt: '',
                };
            },
        },
        imageGenerationClient: { async generate() { imageCalls += 1; } },
        diagnosticLogger: {
            info: (...args) => diagnostics.push(['info', ...args]),
            error: (...args) => diagnostics.push(['error', ...args]),
        },
    });
    const result = await bridge.generateConversationImage({
        kind: 'forum',
        conversationId: 'post_city',
        messageId: 'message_city_2',
        directive: { kind: 'scene_snapshot', scene: 'rainy city street' },
    });
    assert.equal(result.code, 'IMAGE_DIRECTIVE_TEXT_INVALID');
    assert.match(result.message, /前置正面提示词/u);
    assert.equal(imageCalls, 0);
    const failure = diagnostics.find(([, label]) => label === '[约了吗][生图] 对话生图失败');
    assert.equal(failure?.[2]?.phase, 'prompt_compose');
    assert.equal(failure?.[2]?.errorType, 'ImageDirectiveError');
    assert.doesNotMatch(JSON.stringify(diagnostics), /private-value|rainy city street|post_city|message_city_2/u);
});

test('conversation image bridge blocks disabled requests and never exposes unexpected client errors', async () => {
    const { mvu, calls } = createMvu({ initialState: state() });
    let enabled = false;
    let imageCalls = 0;
    const diagnostics = [];
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu,
        settingsStore: { getImageGenerationSettings() { return { enabled }; } },
        imageGenerationClient: { async generate() { imageCalls += 1; throw new Error('api-key-secret'); } },
        diagnosticLogger: {
            info: (...args) => diagnostics.push(['info', ...args]),
            error: (...args) => diagnostics.push(['error', ...args]),
        },
    });
    const request = { kind: 'group', conversationId: 'group_city', messageId: 'message_city_1', directive: { kind: 'scene_snapshot', scene: 'city park at dusk' } };
    const disabled = await bridge.generateConversationImage(request);
    assert.equal(disabled.code, 'image_generation_disabled');
    assert.equal(imageCalls, 0);

    enabled = true;
    const failed = await bridge.generateConversationImage(request);
    assert.equal(failed.code, 'IMAGE_UNKNOWN_ERROR');
    assert.doesNotMatch(JSON.stringify(failed), /api-key-secret|secret/iu);
    assert.equal(imageCalls, 1);
    assert.deepEqual(calls, []);
    assert.ok(diagnostics.some(([, label, detail]) => label === '[约了吗][生图] 对话生图前置拒绝'
        && detail.phase === 'settings_gate' && detail.code === 'image_generation_disabled'));
    assert.ok(diagnostics.some(([, label, detail]) => label === '[约了吗][生图] 对话生图失败'
        && detail.code === 'IMAGE_UNKNOWN_ERROR'));
    assert.doesNotMatch(JSON.stringify(diagnostics), /group_city|message_city_1|city park at dusk|api-key-secret/iu);
});


test('conversation image pending scope is per message and rejects malformed message IDs', async () => {
    const { mvu, calls } = createMvu({ initialState: state() });
    const resolvers = [];
    const imageRequests = [];
    const bridge = createActionBridge({
        documentRef: { querySelector: () => null }, mvu,
        settingsStore: { getImageGenerationSettings() { return { enabled: true, positivePrefix: '', positiveSuffix: '', negativePrompt: '' }; } },
        imageGenerationClient: { generate(request) { imageRequests.push(request); return new Promise((resolve) => resolvers.push(resolve)); } },
    });
    const base = { kind: 'group', conversationId: 'group_city', directive: { kind: 'scene_snapshot', scene: 'city park at dusk' } };
    const first = bridge.generateConversationImage({ ...base, messageId: 'message_city_1' });
    const second = bridge.generateConversationImage({ ...base, messageId: 'message_city_2' });
    await Promise.resolve();
    assert.equal(imageRequests.length, 2, '同一会话的不同结构指令必须各自开始生成');
    const duplicate = await bridge.generateConversationImage({ ...base, messageId: 'message_city_1' });
    assert.equal(duplicate.code, 'ui_action_pending', '同一条结构指令仍应防止重复请求');
    const invalid = await bridge.generateConversationImage({ ...base, messageId: 'bad message id' });
    assert.equal(invalid.code, 'image_conversation_invalid');
    resolvers[0]({ kind: 'data_url', mimeType: 'image/png', src: 'data:image/png;base64,iVBORw0KGgo=' });
    resolvers[1]({ kind: 'data_url', mimeType: 'image/png', src: 'data:image/png;base64,iVBORw0KGgo=' });
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
    assert.deepEqual(calls, [], '对话生图不得写入 MVU');
});

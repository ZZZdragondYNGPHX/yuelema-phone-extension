import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildCharacterAuthoringContext,
    buildCharacterCompletionContext,
    generateCharacterAuthoringCandidate,
    generateCharacterCompletionCandidate,
} from '../character-authoring-service.js';

const connectionPreset = Object.freeze({
    id: 'authoring', name: 'Authoring', url: 'https://example.invalid/v1', model: 'creative', temperature: 0.8, maxTokens: 1600, timeoutMs: 30_000,
});

function adultCandidate() {
    return {
        成人验证: true,
        公开资料: {
            昵称: '林澈', 头像引用: 'https://untrusted.example/avatar.webp', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '先聊天再约会', 简介: '喜欢看展和散步。',
            兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'],
        },
        仅好友资料: { 关系状态: '单身', 边界与偏好: '尊重拒绝。' },
        隐藏资料: { 实际年龄: 28, 私人备注: '仅新角色自己的本地私密设定。' },
        偏好与边界: '先确认边界。', 拒绝阈值: 35, 已读不回阈值: 55, 取消匹配阈值: 75, 拉黑阈值: 90,
        与玩家关系: { 状态: '陌生', 全局账号表现: 68, NPC专属匹配度: 72, 好感: 0, 信任: 0, 戒备: 20, 面基意愿: 0 },
    };
}

function editingPublicProfile() {
    return {
        昵称: '待编辑角色',
        头像引用: 'data:image/webp;base64,avatar-data-must-not-leak',
        年龄段: '成年人', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '聊天后约会', 简介: '喜欢电影。',
        兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['慢热'], 沟通风格标签: ['直接'],
        隐藏资料: { 私人备注: 'editing-private-secret-must-not-leak' },
        仅好友资料: { 关系状态: 'friend-secret-must-not-leak' },
    };
}

function playerPublicProfile() {
    return {
        昵称: 'player-name-must-not-leak',
        头像引用: 'data:image/png;base64,player-avatar-must-not-leak',
        年龄段: '成年人', 性别: '男', 性取向: '异性恋', 城市: '上海', 距离范围: '不限', 寻找意图: '聊天', 简介: 'player-bio-must-not-leak',
        兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['慢热'], 沟通风格标签: ['直接'],
        隐藏资料: { 私人备注: 'player-hidden-secret-must-not-leak' },
        仅好友资料: { 关系状态: 'player-friend-secret-must-not-leak' },
    };
}

function settingsStore() {
    return {
        resolveFunction(functionKey) {
            assert.equal(functionKey, 'character_authoring');
            return { connectionPreset, promptPreset: { enabled: true, content: '保持现代都市、真实克制的语气。' } };
        },
    };
}

test('completion context projects only the editable public fields and instruction, never avatar or private draft data', () => {
    const context = buildCharacterCompletionContext({
        publicProfile: editingPublicProfile(),
        instruction: '补全为一位明确成年的都市摄影师。',
    });
    const serialized = JSON.stringify(context);
    assert.equal(context.editingPublicProfile.昵称, '待编辑角色');
    for (const forbidden of ['avatar-data-must-not-leak', 'editing-private-secret-must-not-leak', 'friend-secret-must-not-leak']) {
        assert.equal(serialized.includes(forbidden), false);
    }
    assert.equal(Object.isFrozen(context), true);
    assert.equal(Object.isFrozen(context.editingPublicProfile), true);
});

test('full-authoring context permits only mode, brief, and minimal player public match fields', () => {
    const context = buildCharacterAuthoringContext({
        creativeBrief: '创作一位明确成年的独立音乐人。', contentMode: 'NSFW', playerPublicProfile: playerPublicProfile(),
    });
    const serialized = JSON.stringify(context);
    assert.equal(context.contentMode, 'NSFW');
    assert.deepEqual(context.playerPublicMatchContext.兴趣标签, ['电影']);
    for (const forbidden of [
        'player-name-must-not-leak', 'player-avatar-must-not-leak', 'player-bio-must-not-leak',
        'player-hidden-secret-must-not-leak', 'player-friend-secret-must-not-leak',
    ]) assert.equal(serialized.includes(forbidden), false);
});

test('completion calls character_authoring only and returns a fully normalized adult in-memory candidate with avatar cleared', async () => {
    let request;
    const result = await generateCharacterCompletionCandidate({
        publicProfile: editingPublicProfile(), instruction: '补全为一位明确成年的都市摄影师。', settingsStore: settingsStore(),
        llmClient: { async chat(value) { request = value; return { text: JSON.stringify(adultCandidate()) }; } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.candidate.成人验证, true);
    assert.equal(result.candidate.隐藏资料.实际年龄, 28);
    assert.equal(result.candidate.隐藏资料.私人备注, '仅新角色自己的本地私密设定。');
    assert.deepEqual(result.candidate.仅好友资料, { 关系状态: '单身', 边界与偏好: '尊重拒绝。' });
    assert.equal(result.candidate.公开资料.头像引用, '');
    const serialized = JSON.stringify(request);
    for (const forbidden of ['avatar-data-must-not-leak', 'editing-private-secret-must-not-leak', 'friend-secret-must-not-leak', 'data:image']) {
        assert.equal(serialized.includes(forbidden), false);
    }
    assert.equal(serialized.includes('UID'), true);
    assert.equal(serialized.includes('JSON 对象'), true);
    assert.equal(serialized.includes('不得索取、复述或泄露输入中的现有私密草稿'), true);
    assert.equal(serialized.includes('可以为新候选生成完整的仅好友资料、隐藏资料和其他私有层'), true);
});

test('full authoring receives no player secret or non-minimal identity data and returns a safe in-memory candidate', async () => {
    let request;
    const result = await generateCharacterAuthoringCandidate({
        creativeBrief: '创作一位明确成年的独立音乐人。', contentMode: 'NSFW', playerPublicProfile: playerPublicProfile(), settingsStore: settingsStore(),
        llmClient: { async chat(value) { request = value; return { text: JSON.stringify(adultCandidate()) }; } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.candidate.公开资料.头像引用, '');
    const serialized = JSON.stringify(request);
    for (const forbidden of [
        'player-name-must-not-leak', 'player-avatar-must-not-leak', 'player-bio-must-not-leak',
        'player-hidden-secret-must-not-leak', 'player-friend-secret-must-not-leak', 'data:image',
    ]) assert.equal(serialized.includes(forbidden), false);
    assert.equal(serialized.includes('NSFW'), true);
    assert.equal(serialized.includes('不得索取、复述或泄露输入中未提供的玩家私密资料'), true);
    assert.equal(serialized.includes('可以为新候选生成完整的仅好友资料、隐藏资料和其他私有层'), true);
});

test('invalid or underage model result is a generic safe no-result without raw validation detail', async () => {
    const underage = adultCandidate();
    underage.隐藏资料.实际年龄 = 17;
    const result = await generateCharacterAuthoringCandidate({
        creativeBrief: '创作成年人。', contentMode: 'SFW', playerPublicProfile: playerPublicProfile(), settingsStore: settingsStore(),
        llmClient: { async chat() { return { text: JSON.stringify(underage) }; } },
    });
    assert.deepEqual(result, {
        ok: false,
        code: 'character_authoring_response_invalid',
        message: '模型返回的完整角色草稿未通过成年人或结构校验；当前草稿未改变。',
    });
});

test('invalid input and missing binding fail before calling the model with a safe projected error', async () => {
    let called = false;
    const invalid = await generateCharacterCompletionCandidate({
        publicProfile: null, instruction: '补全。', settingsStore: settingsStore(),
        llmClient: { async chat() { called = true; return { text: '{}' }; } },
    });
    assert.equal(called, false);
    assert.deepEqual(invalid, {
        ok: false,
        code: 'character_authoring_input_invalid',
        message: '待补全的公开资料或说明无效；当前草稿未改变。',
    });

    const missing = await generateCharacterAuthoringCandidate({
        creativeBrief: '创作成年人。', contentMode: 'SFW', playerPublicProfile: playerPublicProfile(),
        settingsStore: { resolveFunction: () => ({ connectionPreset: null, promptPreset: null }) },
        llmClient: { async chat() { called = true; return { text: '{}' }; } },
    });
    assert.equal(called, false);
    assert.deepEqual(missing, {
        ok: false,
        code: 'character_authoring_connection_missing',
        message: '请先为“角色创作”绑定连接预设或设置默认连接。',
    });
});

test('unexpected model failure is projected without raw API or key material', async () => {
    const result = await generateCharacterCompletionCandidate({
        publicProfile: editingPublicProfile(), instruction: '补全。', settingsStore: settingsStore(),
        llmClient: { async chat() { throw new Error('Authorization Bearer super-secret-key-must-not-leak'); } },
    });
    assert.deepEqual(result, {
        ok: false, code: 'UNKNOWN_ERROR', message: '模型请求未完成，请稍后重试。', retryable: false,
    });
    assert.equal(JSON.stringify(result).includes('super-secret-key-must-not-leak'), false);
});



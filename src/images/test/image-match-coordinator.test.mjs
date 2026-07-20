import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageMatchCoordinator } from '../image-match-coordinator.js';

const profile = {
    昵称: '林舒',
    年龄段: '成年人',
    城市: '北京',
    简介: '喜欢艺术展和夜间散步。',
    兴趣标签: ['艺术'],
    隐藏资料: { 私人备注: 'hidden-secret' },
    仅好友资料: { 关系状态: 'friend-secret' },
    UID: 'npc-secret',
    apiKey: 'profile-api-secret',
};

const images = [
    {
        id: 'night',
        source: { kind: 'url', url: 'https://cdn.example.test/night.jpg' },
        keywordWeights: [
            { keyword: '艺术', weight: 4 },
            { keyword: '夜间', weight: 2 },
        ],
    },
    {
        id: 'sport',
        source: { kind: 'url', url: 'https://cdn.example.test/sport.jpg' },
        keywordWeights: [{ keyword: '运动', weight: 5 }],
    },
];

function makeDependencies({ chat, connectionPreset = null } = {}) {
    return {
        imageLibrary: { async list() { return images; } },
        settingsStore: {
            resolveFunction(functionKey) {
                assert.equal(functionKey, 'image_match');
                return { connectionPreset };
            },
        },
        llmClient: chat ? { chat } : null,
    };
}

const connectionPreset = {
    id: 'image-match',
    name: '图片匹配',
    url: 'https://api.example.test/v1',
    model: 'visionless-text-model',
    temperature: 0.2,
    maxTokens: 512,
    timeoutMs: 30_000,
    transportMode: 'json',
};

test('LLM success uses image_match binding, returns selected image, and caches by public profile plus library revision', async () => {
    let calls = 0;
    const coordinator = createImageMatchCoordinator(makeDependencies({
        connectionPreset,
        chat: async (request) => {
            calls += 1;
            assert.equal(request.preset.id, 'image-match');
            return { text: JSON.stringify({ keywordWeights: [{ keyword: '艺术', weight: 5 }] }) };
        },
    }));

    const first = await coordinator.match(profile);
    const second = await coordinator.match(profile);
    const cached = await coordinator.getCached(profile);
    const image = await coordinator.resolveImage(profile);

    assert.equal(first.ok, true);
    assert.equal(first.source, 'llm');
    assert.equal(first.match.imageId, 'night');
    assert.equal(second, first);
    assert.equal(cached, first);
    assert.equal(image.id, 'night');
    assert.equal(calls, 1);
});

test('LLM failure never escapes and falls back to deterministic local matching', async () => {
    const coordinator = createImageMatchCoordinator(makeDependencies({
        connectionPreset,
        chat: async () => { throw new Error('api-key=must-not-escape'); },
    }));

    const result = await coordinator.match(profile);
    assert.equal(result.ok, true);
    assert.equal(result.source, 'local');
    assert.equal(result.match.imageId, 'night');
    assert.equal(result.llm.applied, false);
    assert.equal(JSON.stringify(result).includes('api-key=must-not-escape'), false);
});

test('privacy fields, UID, API key, and image URL do not enter the prompt or ordinary connection object', async () => {
    let request;
    const coordinator = createImageMatchCoordinator(makeDependencies({
        connectionPreset,
        chat: async (input) => {
            request = input;
            return { text: JSON.stringify({ keywordWeights: [{ keyword: '艺术', weight: 5 }] }) };
        },
    }));

    await coordinator.match(profile);
    assert.ok(request);
    const serializedMessages = JSON.stringify(request.messages);
    assert.equal(serializedMessages.includes('hidden-secret'), false);
    assert.equal(serializedMessages.includes('friend-secret'), false);
    assert.equal(serializedMessages.includes('npc-secret'), false);
    assert.equal(serializedMessages.includes('profile-api-secret'), false);
    assert.equal(serializedMessages.includes('https://cdn.example.test/night.jpg'), false);
    assert.equal(serializedMessages.includes('data:image'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(request.preset, 'apiKey'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(request.preset, 'token'), false);
    assert.equal(Object.getPrototypeOf(request.preset), Object.prototype);
});

test('secret-bearing binding is rejected before the LLM client and still uses local fallback', async () => {
    let called = false;
    const coordinator = createImageMatchCoordinator({
        imageLibrary: { async list() { return images; } },
        settingsStore: {
            resolveFunction() {
                return { connectionPreset: { ...connectionPreset, apiKey: 'secret' } };
            },
        },
        llmClient: { async chat() { called = true; return { text: '{}' }; } },
    });

    const result = await coordinator.match(profile);
    assert.equal(called, false);
    assert.equal(result.source, 'local');
    assert.equal(result.match.imageId, 'night');
});

test('missing binding does not throw and uses local fallback', async () => {
    const coordinator = createImageMatchCoordinator({
        imageLibrary: { async list() { return images; } },
        settingsStore: { resolveFunction() { return { connectionPreset: null }; } },
        llmClient: { async chat() { throw new Error('should not run'); } },
    });

    const result = await coordinator.match(profile);
    assert.equal(result.ok, true);
    assert.equal(result.source, 'local');
    assert.equal(result.match.imageId, 'night');
});

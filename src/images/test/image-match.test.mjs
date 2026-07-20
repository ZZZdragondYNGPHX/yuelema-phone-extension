import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildImageMatchContextText,
    buildImageMatchPrompt,
    createImageLibraryRevision,
    createImageMatchCacheKey,
    createImageMatchProfileFingerprint,
    parseImageMatchLlmResponse,
    selectBestImageMatch,
    selectBestImageMatchFromKeywordWeights,
} from '../image-match.js';
import { matchImageForPublicProfile, requestImageMatchKeywordWeights } from '../image-match-service.js';

const profile = {
    昵称: '林舒',
    年龄段: '成年人',
    性别: '女',
    性取向: '异性恋',
    城市: '北京',
    距离范围: '10km以内',
    寻找意图: '寻找志同道合的朋友',
    简介: '喜欢画展、独立电影和夜间散步，习惯先进行深度对话。',
    兴趣标签: ['艺术', '电影'],
    生活方式标签: ['夜生活'],
    性格标签: ['慢热'],
    沟通风格标签: ['深度对话'],
};

const images = [
    {
        id: 'image-night',
        source: { kind: 'url', url: 'https://cdn.example.test/night.jpg', dataUrl: 'data:image/png;base64,secret-image' },
        keywordWeights: [
            { keyword: '夜生活', weight: 4 },
            { keyword: '艺术', weight: 3 },
            { keyword: '慢热', weight: 2 },
        ],
    },
    {
        id: 'image-sport',
        keywordWeights: [
            { keyword: '运动', weight: 5 },
            { keyword: '户外', weight: 3 },
        ],
    },
];

test('local matching scores public fields and returns a positive deterministic match', () => {
    const result = selectBestImageMatch(profile, images);
    assert.deepEqual(result, {
        imageId: 'image-night',
        score: 9,
        matchedKeywords: ['慢热', '夜生活', '艺术'],
    });
});

test('matching supports safe substring without matching a partial Latin word', () => {
    const result = selectBestImageMatch({ 简介: '喜欢夜间散步和展览。' }, [{
        id: 'substring', keywordWeights: [{ keyword: '夜间', weight: 2 }, { keyword: 'art', weight: 5 }],
    }]);
    assert.deepEqual(result, { imageId: 'substring', score: 2, matchedKeywords: ['夜间'] });
});

test('equal scores use image id as a stable tie-breaker', () => {
    const library = [
        { id: 'z-image', keywordWeights: [{ keyword: '艺术', weight: 2 }] },
        { id: 'a-image', keywordWeights: [{ keyword: '艺术', weight: 2 }] },
    ];
    assert.equal(selectBestImageMatch({ 兴趣标签: ['艺术'] }, library).imageId, 'a-image');
    assert.equal(selectBestImageMatch({ 兴趣标签: ['艺术'] }, library.slice().reverse()).imageId, 'a-image');
});

test('no positive match returns null, including a matched negative-only image', () => {
    assert.equal(selectBestImageMatch({ 兴趣标签: ['运动'] }, [{
        id: 'negative', keywordWeights: [{ keyword: '运动', weight: -5 }],
    }]), null);
    assert.equal(selectBestImageMatch({ 兴趣标签: ['烘焙'] }, [{
        id: 'none', keywordWeights: [{ keyword: '运动', weight: 5 }],
    }]), null);
});

test('profile fingerprint and library revision are stable across irrelevant source data and ordering', () => {
    const profileVariant = { ...profile, 兴趣标签: ['电影', '艺术'], 隐藏资料: { secret: 'must-not-read' } };
    const imagesVariant = images.slice().reverse().map((image) => ({
        ...image,
        source: { kind: 'embedded', dataUrl: 'data:image/jpeg;base64,another-secret' },
    }));
    assert.equal(createImageMatchProfileFingerprint(profile), createImageMatchProfileFingerprint(profileVariant));
    assert.equal(createImageLibraryRevision(images), createImageLibraryRevision(imagesVariant));
    assert.equal(createImageMatchCacheKey(profile, images), createImageMatchCacheKey(profileVariant, imagesVariant));
});

test('LLM parser accepts only registered integer keyword weights', () => {
    const parsed = parseImageMatchLlmResponse(JSON.stringify({ keywordWeights: [
        { keyword: '艺术', weight: 5 },
        { keyword: '夜生活', weight: -1 },
    ] }), ['艺术', '夜生活']);
    assert.deepEqual(parsed, [
        { keyword: '夜生活', weight: -1 },
        { keyword: '艺术', weight: 5 },
    ]);
    assert.deepEqual(selectBestImageMatchFromKeywordWeights(images, parsed), {
        imageId: 'image-night', score: 15, matchedKeywords: ['艺术'],
    });
});

test('LLM parser rejects arrays, multiple roots, extra fields, duplicates and unknown keywords', () => {
    const invalid = [
        '[]',
        '{}{}',
        JSON.stringify({ keywordWeights: [], explanation: 'extra' }),
        JSON.stringify({ keywordWeights: [{ keyword: '艺术', weight: 1 }, { keyword: '艺术', weight: 2 }] }),
        JSON.stringify({ keywordWeights: [{ keyword: '未注册', weight: 1 }] }),
        JSON.stringify({ keywordWeights: [{ keyword: '艺术', weight: 1.5 }] }),
        JSON.stringify({ keywordWeights: [{ keyword: '艺术', weight: 6 }] }),
        JSON.stringify({ keywordWeights: [{ keyword: '艺术', weight: 1, secret: 'x' }] }),
    ];
    for (const raw of invalid) assert.throws(() => parseImageMatchLlmResponse(raw, ['艺术']), /ImageMatchValidationError/u);
});

test('prompt contains only public profile projection and keyword vocabulary, never image URLs or sensitive data', () => {
    const publicProjection = {
        ...profile,
        隐藏资料: { 私人备注: 'hidden-secret' },
        仅好友资料: { 关系状态: 'friend-secret' },
        UID: 'npc-secret',
        apiKey: 'api-secret',
    };
    const context = buildImageMatchContextText(publicProjection, ['艺术', '夜生活']);
    const prompt = buildImageMatchPrompt(publicProjection, ['艺术', '夜生活']);
    assert.match(context, /林舒/u);
    assert.match(context, /艺术/u);
    for (const secret of ['hidden-secret', 'friend-secret', 'npc-secret', 'api-secret', 'https://cdn.example.test/night.jpg', 'data:image']) {
        assert.equal(context.includes(secret), false);
        assert.equal(JSON.stringify(prompt).includes(secret), false);
    }
});

test('service uses injected llmClient and returns an LLM-selected match without networking', async () => {
    let request;
    const result = await matchImageForPublicProfile({
        candidatePublicProfile: { 简介: '喜欢艺术。' },
        imageRecords: images,
        connectionPreset: { id: 'image-match', url: 'https://api.example.test/v1', model: 'model' },
        llmClient: { async chat(input) {
            request = input;
            return { text: JSON.stringify({ keywordWeights: [{ keyword: '艺术', weight: 5 }] }) };
        } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'llm');
    assert.equal(result.match.imageId, 'image-night');
    assert.equal(result.llm.applied, true);
    assert.ok(Array.isArray(request.messages));
    assert.equal(JSON.stringify(request.messages).includes('https://cdn.example.test/night.jpg'), false);
});

test('LLM failure safely falls back to local match and does not expose raw error', async () => {
    const result = await matchImageForPublicProfile({
        candidatePublicProfile: profile,
        imageRecords: images,
        connectionPreset: { id: 'image-match', url: 'https://api.example.test/v1', model: 'model' },
        llmClient: { async chat() { throw new Error('api-key=must-never-escape'); } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'local');
    assert.equal(result.match.imageId, 'image-night');
    assert.equal(result.llm.applied, false);
    assert.equal(JSON.stringify(result).includes('api-key=must-never-escape'), false);
});

test('standalone LLM request rejects secret-bearing presets and never calls the client', async () => {
    let called = false;
    const result = await requestImageMatchKeywordWeights({
        candidatePublicProfile: profile,
        imageRecords: images,
        connectionPreset: { id: 'bad', apiKey: 'secret' },
        llmClient: { async chat() { called = true; return { text: '{}' }; } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'image_match_connection_invalid');
    assert.equal(called, false);
});



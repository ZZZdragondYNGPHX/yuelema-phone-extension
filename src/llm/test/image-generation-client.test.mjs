import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageGenerationClient, toPublicImageGenerationError } from '../image-generation-client.js';
import { configurePersistentKeyStorage, resetPersistentKeyStorage, unlockSessionKey } from '../session-key-store.js';

const png = Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
const settings = { apiMode: 'openai_compatible', presetId: 'image_generation_default', baseUrl: 'https://img.example.test', endpointPath: '/v1/images/generations', model: 'model', sampler: 'euler', noiseSchedule: 'native', width: 512, height: 512, steps: 20, seed: 0, guidance: 7, guidanceRescale: 0, qualityToggle: true, variety: false };

function storage() { const m = new Map(); return { getItem:k=>m.get(k)??null, setItem:(k,v)=>m.set(k,String(v)), removeItem:k=>m.delete(k) }; }

test.beforeEach(() => { configurePersistentKeyStorage(storage()); unlockSessionKey('image_generation_default', 'secret-key'); });
test.afterEach(() => resetPersistentKeyStorage());

test('client sends injected request and accepts JSON base64 image', async () => {
    let request;
    const client = createImageGenerationClient({ fetchImpl: async (url, init) => { request = { url, init }; return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(png).toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } }); } });
    const result = await client.generate({ settings, positivePrompt: 'best quality', negativePrompt: 'bad' });
    assert.equal(request.url, 'https://img.example.test/v1/images/generations');
    assert.match(request.init.headers.Authorization, /^Bearer /u);
    assert.match(result.src, /^data:image\/png;base64,/u);
});

test('client accepts a direct image response and rejects unsafe non-loopback http', async () => {
    const client = createImageGenerationClient({ fetchImpl: async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }) });
    assert.equal((await client.generate({ settings, positivePrompt: 'scene', negativePrompt: '' })).mimeType, 'image/png');
    await assert.rejects(() => client.generate({ settings: { ...settings, baseUrl: 'http://remote.example.test' }, positivePrompt: 'scene', negativePrompt: '' }));
    await assert.rejects(() => client.generate({ settings: { ...settings, baseUrl: 'https://img.example.test/?api_key=secret-key' }, positivePrompt: 'scene', negativePrompt: '' }));
});

test('public error projection never includes response or credentials', async () => {
    const client = createImageGenerationClient({ fetchImpl: async () => new Response('secret backend detail', { status: 401 }) });
    let projected;
    try { await client.generate({ settings, positivePrompt: 'scene', negativePrompt: '' }); } catch (error) { projected = toPublicImageGenerationError(error); }
    assert.equal(projected.code, 'IMAGE_HTTP_ERROR');
    assert.doesNotMatch(JSON.stringify(projected), /secret|backend|credential/iu);
});


test('client rejects remote image URLs instead of letting the UI fetch them', async () => {
    const client = createImageGenerationClient({
        fetchImpl: async () => new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.test/generated.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await assert.rejects(
        () => client.generate({ settings, positivePrompt: 'scene', negativePrompt: '' }),
        (error) => error?.code === 'INVALID_IMAGE_RESPONSE',
    );
});

test('client rejects declared oversized responses before buffering them', async () => {
    const client = createImageGenerationClient({
        fetchImpl: async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(25 * 1024 * 1024) } }),
    });
    await assert.rejects(
        () => client.generate({ settings, positivePrompt: 'scene', negativePrompt: '' }),
        (error) => error?.code === 'INVALID_IMAGE_RESPONSE',
    );
});

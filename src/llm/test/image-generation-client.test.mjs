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

test('ComfyUI submits an API workflow, polls history, and reads the generated image without an API key', async () => {
    resetPersistentKeyStorage();
    const requests = [];
    const comfySettings = {
        ...settings,
        apiMode: 'comfyui',
        comfyBaseUrl: 'http://127.0.0.1:8188',
        comfyModel: 'portrait.safetensors',
        comfySampler: 'dpmpp_2m',
        comfyScheduler: 'karras',
        comfyVae: 'portrait-vae.safetensors',
        comfyClip: 'clip-l.safetensors',
        comfyWidth: 832,
        comfyHeight: 1216,
        comfySteps: 32,
        comfySeed: 42,
        comfyGuidance: 6.5,
        comfyWorkflow: JSON.stringify({
            1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '%MODEL_NAME%' } },
            2: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['1', 1] } },
            3: { class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%height%', batch_size: 1 } },
            4: { class_type: 'VAELoader', inputs: { vae_name: '%VAE_NAME%' } },
            5: { class_type: 'CLIPLoader', inputs: { clip_name: '%CLIP_NAME%' } },
        }),
    };
    const client = createImageGenerationClient({
        fetchImpl: async (url, init) => {
            requests.push({ url, init });
            if (url.endsWith('/prompt')) return new Response(JSON.stringify({ prompt_id: 'task-1' }), { status: 200 });
            if (url.endsWith('/history/task-1')) {
                return new Response(JSON.stringify({ 'task-1': { outputs: { 9: { images: [{ filename: 'done.png', subfolder: 'ylm', type: 'output' }] } } } }), { status: 200 });
            }
            return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
        },
    });

    const result = await client.generate({ settings: comfySettings, positivePrompt: 'adult portrait', negativePrompt: 'lowres' });
    const submitted = JSON.parse(requests[0].init.body);
    assert.equal(requests[0].url, 'http://127.0.0.1:8188/prompt');
    assert.equal(requests[0].init.headers.Authorization, undefined);
    assert.equal(submitted.prompt['1'].inputs.ckpt_name, 'portrait.safetensors');
    assert.equal(submitted.prompt['2'].inputs.text, 'adult portrait');
    assert.equal(submitted.prompt['3'].inputs.width, 832);
    assert.equal(submitted.prompt['4'].inputs.vae_name, 'portrait-vae.safetensors');
    assert.equal(submitted.prompt['5'].inputs.clip_name, 'clip-l.safetensors');
    assert.match(requests[2].url, /\/view\?filename=done\.png&subfolder=ylm&type=output$/u);
    assert.equal(result.mimeType, 'image/png');
});

test('ComfyUI rejects UI-format workflows and unsafe workflow keys before network access', async () => {
    resetPersistentKeyStorage();
    let calls = 0;
    const client = createImageGenerationClient({ fetchImpl: async () => { calls += 1; throw new Error('must not run'); } });
    await assert.rejects(
        () => client.generate({ settings: { ...settings, apiMode: 'comfyui', baseUrl: 'http://127.0.0.1:8188', comfyWorkflow: '{"nodes":[]}' }, positivePrompt: 'scene', negativePrompt: '' }),
        (error) => error?.code === 'INVALID_IMAGE_REQUEST' && /API Format/u.test(error.message),
    );
    await assert.rejects(
        () => client.generate({ settings: { ...settings, apiMode: 'comfyui', baseUrl: 'http://127.0.0.1:8188', comfyWorkflow: '{"__proto__":{"x":1}}' }, positivePrompt: 'scene', negativePrompt: '' }),
        (error) => error?.code === 'INVALID_IMAGE_REQUEST',
    );
    assert.equal(calls, 0);
});

test('ComfyUI resource refresh reads bounded object_info choices through the injected transport', async () => {
    let request;
    const client = createImageGenerationClient({
        fetchImpl: async (url, init) => {
            request = { url, init };
            return new Response(JSON.stringify({
                CheckpointLoaderSimple: { input: { required: { ckpt_name: [['portrait.safetensors', 'anime.safetensors']] } } },
                KSampler: { input: { required: { sampler_name: [['euler', 'dpmpp_2m']], scheduler: [['normal', 'karras']] } } },
                VAELoader: { input: { required: { vae_name: [['vae.safetensors']] } } },
                DualCLIPLoader: { input: { required: { clip_name1: [['clip-l.safetensors']], clip_name2: [['t5xxl.safetensors']] } } },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
    });
    const resources = await client.fetchComfyUIResources({ baseUrl: 'http://127.0.0.1:8188' });
    assert.equal(request.url, 'http://127.0.0.1:8188/object_info');
    assert.equal(request.init.method, 'GET');
    assert.deepEqual(resources.models, ['portrait.safetensors', 'anime.safetensors']);
    assert.deepEqual(resources.samplers, ['euler', 'dpmpp_2m']);
    assert.deepEqual(resources.schedulers, ['normal', 'karras']);
    assert.deepEqual(resources.vae, ['vae.safetensors']);
    assert.deepEqual(resources.clips, ['clip-l.safetensors', 't5xxl.safetensors']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageGenerationClient, toPublicImageGenerationError } from '../image-generation-client.js';
import { configurePersistentKeyStorage, resetPersistentKeyStorage, unlockSessionKey } from '../session-key-store.js';

const png = Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
const settings = { apiMode: 'openai_compatible', presetId: 'image_generation_default', baseUrl: 'https://img.example.test', endpointPath: '/v1/images/generations', model: 'model', sampler: 'euler', noiseSchedule: 'native', width: 512, height: 512, steps: 20, seed: 0, guidance: 7, guidanceRescale: 0, qualityToggle: true, variety: false };

function storage() { const m = new Map(); return { getItem:k=>m.get(k)??null, setItem:(k,v)=>m.set(k,String(v)), removeItem:k=>m.delete(k) }; }
function zipWithDataDescriptor(filename, payload) {
    const name = Buffer.from(filename);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x08, 6);
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(payload.length, 8);
    descriptor.writeUInt32LE(payload.length, 12);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x08, 8);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(name.length, 28);
    const directoryOffset = local.length + name.length + payload.length + descriptor.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + name.length, 12);
    eocd.writeUInt32LE(directoryOffset, 16);
    return Buffer.concat([local, name, payload, descriptor, central, name, eocd]);
}

test.beforeEach(() => { configurePersistentKeyStorage(storage()); unlockSessionKey('image_generation_default', 'secret-key'); });
test.afterEach(() => resetPersistentKeyStorage());

test('client sends injected request and accepts JSON base64 image', async () => {
    let request;
    const client = createImageGenerationClient({ fetchImpl: async (url, init) => { request = { url, init }; return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(png).toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } }); } });
    const result = await client.generate({ settings, positivePrompt: 'best quality', negativePrompt: 'bad' });
    assert.equal(request.url, 'https://img.example.test/v1/images/generations');
    assert.match(request.init.headers.Authorization, /^Bearer /u);
    const body = JSON.parse(request.init.body);
    assert.deepEqual(Object.keys(body), ['model', 'prompt', 'size', 'response_format', 'n']);
    assert.equal(body.prompt, 'best quality. Avoid the following visual elements: bad.');
    assert.equal(body.negative_prompt, undefined);
    assert.equal(body.width, undefined);
    assert.equal(body.steps, undefined);
    assert.match(result.src, /^data:image\/png;base64,/u);
});

test('GPT image requests omit legacy response_format and use the OpenAI-specific connection profile', async () => {
    unlockSessionKey('openai-image-profile', 'openai-image-secret');
    let request;
    const client = createImageGenerationClient({
        fetchImpl: async (url, init) => {
            request = { url, body: JSON.parse(init.body) };
            return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(png).toString('base64') }] }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        },
    });
    await client.generate({
        settings: {
            ...settings,
            baseUrl: 'https://nai.example.invalid',
            endpointPath: '/nai',
            model: 'nai-model',
            openaiPresetId: 'openai-image-profile',
            openaiBaseUrl: 'https://api.openai.example',
            openaiEndpointPath: '/v1/images/generations',
            openaiModel: 'gpt-image-1',
        },
        positivePrompt: 'A quiet garden',
        negativePrompt: '',
    });
    assert.equal(request.url, 'https://api.openai.example/v1/images/generations');
    assert.equal(request.body.model, 'gpt-image-1');
    assert.equal(request.body.response_format, undefined);
    assert.deepEqual(Object.keys(request.body), ['model', 'prompt', 'size', 'n']);
});

test('GPT image requests use independent OpenAI dimensions and map them to a supported orientation size', async () => {
    unlockSessionKey('openai-image-profile', 'openai-image-secret');
    let body;
    const client = createImageGenerationClient({
        fetchImpl: async (_url, init) => {
            body = JSON.parse(init.body);
            return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(png).toString('base64') }] }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        },
    });
    await client.generate({
        settings: {
            ...settings,
            openaiPresetId: 'openai-image-profile',
            openaiBaseUrl: 'https://api.openai.example',
            openaiEndpointPath: '/v1/images/generations',
            openaiModel: 'gpt-image-1',
            width: 1216,
            height: 832,
            openaiWidth: 832,
            openaiHeight: 1216,
        },
        positivePrompt: 'A quiet garden',
        negativePrompt: '',
    });
    assert.equal(body.size, '1024x1536');
});

test('client rejects multiline prompts before starting image transport', async () => {
    let calls = 0;
    const client = createImageGenerationClient({ fetchImpl: async () => { calls += 1; throw new Error('must not run'); } });
    await assert.rejects(
        () => client.generate({ settings, positivePrompt: 'best quality\nmasterpiece', negativePrompt: 'bad' }),
        (error) => error?.code === 'INVALID_IMAGE_REQUEST',
    );
    assert.equal(calls, 0);
});

test('client extracts a NovelAI ZIP whose local entry sizes are supplied by a data descriptor', async () => {
    const archive = zipWithDataDescriptor('image_0.png', Buffer.from(png));
    const client = createImageGenerationClient({
        fetchImpl: async () => new Response(archive, { status: 200, headers: { 'content-type': 'binary/octet-stream' } }),
    });
    const result = await client.generate({ settings, positivePrompt: 'scene', negativePrompt: '' });
    assert.equal(result.mimeType, 'image/png');
    assert.match(result.src, /^data:image\/png;base64,/u);
});

test('NovelAI V4 models receive the V4 caption contract while V3 keeps the legacy shape', async () => {
    const bodies = [];
    const client = createImageGenerationClient({
        fetchImpl: async (_url, init) => {
            bodies.push(JSON.parse(init.body));
            return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
        },
    });
    const naiSettings = {
        ...settings,
        apiMode: 'novelai',
        endpointPath: '/ai/generate-image',
        model: 'nai-diffusion-4-5-full',
        sampler: 'k_euler',
        noiseSchedule: 'native',
    };
    await client.generate({ settings: naiSettings, positivePrompt: 'adult portrait', negativePrompt: 'lowres' });
    await client.generate({ settings: { ...naiSettings, model: 'nai-diffusion-3' }, positivePrompt: 'adult portrait', negativePrompt: 'lowres' });

    assert.equal(bodies[0].parameters.params_version, 3);
    assert.equal(bodies[0].parameters.v4_prompt.caption.base_caption, 'adult portrait');
    assert.deepEqual(bodies[0].parameters.v4_prompt.caption.char_captions, []);
    assert.equal(bodies[0].parameters.v4_negative_prompt.caption.base_caption, 'lowres');
    assert.equal(bodies[0].parameters.v4_prompt.use_order, true);
    assert.equal(bodies[0].parameters.legacy, false);
    assert.equal(bodies[1].parameters.v4_prompt, undefined);
    assert.equal(bodies[1].parameters.params_version, undefined);
});

test('client emits safe stage diagnostics without logging credentials or prompts', async () => {
    unlockSessionKey('img-log-test', 'secret-image-key-never-log');
    const calls = [];
    const diagnosticLogger = {
        info: (...args) => calls.push(['info', ...args]),
        error: (...args) => calls.push(['error', ...args]),
    };
    const client = createImageGenerationClient({
        diagnosticLogger,
        fetchImpl: async () => new Response(JSON.stringify({
            data: [{ b64_json: Buffer.from(png).toString('base64') }],
        }), { status: 200, headers: { 'content-type': 'application/json', 'content-length': '123' } }),
    });

    await client.generate({ settings: { ...settings, presetId: 'img-log-test' }, positivePrompt: 'private prompt never log', negativePrompt: 'private negative never log' });

    assert.deepEqual(calls.map(([level, label]) => [level, label]), [
        ['info', '[约了吗][生图] 请求开始'],
        ['info', '[约了吗][生图] 请求体准备完成'],
        ['info', '[约了吗][生图] 收到响应'],
        ['info', '[约了吗][生图] 请求完成'],
    ]);
    const serialized = JSON.stringify(calls);
    assert.doesNotMatch(serialized, /secret-image-key-never-log|private prompt never log|private negative never log/u);
    assert.match(serialized, /"provider":"openai_compatible"/u);
    assert.match(serialized, /"positivePromptChars":24/u);
    assert.match(serialized, /"status":200/u);
    assert.match(serialized, /"mimeType":"image\/png"/u);
});

test('client logs a bounded redacted provider error excerpt without leaking credentials or prompts', async () => {
    unlockSessionKey('img-log-failure', 'another-secret-key');
    const calls = [];
    const client = createImageGenerationClient({
        diagnosticLogger: { info: (...args) => calls.push(['info', ...args]), error: (...args) => calls.push(['error', ...args]) },
        fetchImpl: async () => new Response(JSON.stringify({
            statusCode: 400,
            message: 'parameters.v4_prompt is required; another private prompt',
            authorization: 'Bearer another-secret-key',
            echoedNegative: 'bad',
            developerHint: 'send params_version=3 with v4_prompt',
        }), {
            status: 400,
            headers: { 'content-type': 'application/json', 'x-request-id': 'nai-request-123', 'cf-ray': 'edge-trace-456', 'retry-after': '5' },
        }),
    });

    await assert.rejects(
        () => client.generate({ settings: { ...settings, apiMode: 'novelai', presetId: 'img-log-failure' }, positivePrompt: 'another private prompt', negativePrompt: 'bad' }),
        (error) => error.code === 'IMAGE_HTTP_ERROR' && error.status === 400,
    );

    const summary = calls.find(([, label]) => label === '[约了吗][生图] 错误响应摘要');
    const contract = calls.find(([, label]) => label === '[约了吗][生图] NovelAI 请求合同');
    const trace = calls.find(([, label]) => label === '[约了吗][生图] NovelAI 错误响应定位');
    const requestShape = calls.find(([, label]) => label === '[约了吗][生图] 请求体准备完成');
    assert.equal(requestShape?.[2]?.provider, 'novelai');
    assert.ok(requestShape?.[2]?.parameterFields.includes('negative_prompt'));
    assert.equal(contract?.[2]?.modelFamily, 'legacy');
    assert.equal(contract?.[2]?.sampler, 'euler');
    assert.equal(trace?.[2]?.requestTraceId, 'nai-request-123');
    assert.equal(trace?.[2]?.edgeTraceId, 'edge-trace-456');
    assert.equal(trace?.[2]?.retryAfter, '5');
    assert.equal(summary?.[2]?.providerCategory, 'request_validation');
    assert.equal(summary?.[2]?.bodyInspection, 'structured_json');
    assert.equal(summary?.[2]?.providerStatusCode, 400);
    assert.equal(summary?.[2]?.providerMessageChars, 56);
    assert.deepEqual(summary?.[2]?.responseSchemaFields, ['statusCode', 'message']);
    assert.deepEqual(summary?.[2]?.providerValidationFields, ['parameters', 'v4_prompt']);
    assert.match(summary?.[2]?.providerBodyExcerpt, /params_version=3 with v4_prompt/u);
    assert.match(summary?.[2]?.providerBodyExcerpt, /\[REDACTED\]/u);
    const failure = calls.find(([, label]) => label === '[约了吗][生图] 请求失败');
    assert.deepEqual(failure?.[2], {
        requestId: failure?.[2]?.requestId,
        provider: 'novelai',
        phase: 'http_response',
        code: 'IMAGE_HTTP_ERROR',
        message: '生图服务拒绝了本次请求，请检查接口设置或稍后重试。',
        retryable: false,
        status: 400,
        elapsedMs: failure?.[2]?.elapsedMs,
    });
    const serialized = JSON.stringify(calls);
    assert.doesNotMatch(serialized, /another-secret-key|another private prompt/u);
    assert.doesNotMatch(serialized, /"bad"/u);
});

test('client logs safe browser transport failure type without the exception message', async () => {
    const calls = [];
    const client = createImageGenerationClient({
        diagnosticLogger: { info: (...args) => calls.push(['info', ...args]), error: (...args) => calls.push(['error', ...args]) },
        fetchImpl: async () => { throw new TypeError('CORS detail with secret-image-key-never-log'); },
    });
    await assert.rejects(
        () => client.generate({ settings, positivePrompt: 'private prompt never log', negativePrompt: '' }),
        (error) => error?.code === 'IMAGE_NETWORK_ERROR',
    );
    const transport = calls.find(([, label]) => label === '[约了吗][生图] 传输失败');
    assert.equal(transport?.[2]?.errorType, 'TypeError');
    assert.equal(transport?.[2]?.aborted, false);
    assert.doesNotMatch(JSON.stringify(calls), /CORS detail|secret-image-key|private prompt never log/u);
});

test('credential diagnostics preserve the locked-key error when an external signal exists', async () => {
    resetPersistentKeyStorage();
    const calls = [];
    const client = createImageGenerationClient({
        diagnosticLogger: { error: (...args) => calls.push(args) },
        fetchImpl: async () => assert.fail('locked credentials must fail before transport'),
    });
    await assert.rejects(
        () => client.generate({ settings: { ...settings, presetId: 'missing-key' }, positivePrompt: 'scene', negativePrompt: '', signal: new AbortController().signal }),
        (error) => error.code === 'SESSION_KEY_LOCKED',
    );
    assert.equal(calls[0]?.[1]?.phase, 'credential_lookup');
    assert.equal(calls[0]?.[1]?.code, 'SESSION_KEY_LOCKED');
});

test('client accepts direct image responses from HTTPS and explicitly configured HTTP services', async () => {
    const client = createImageGenerationClient({ fetchImpl: async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }) });
    assert.equal((await client.generate({ settings, positivePrompt: 'scene', negativePrompt: '' })).mimeType, 'image/png');
    const urls = [];
    const httpClient = createImageGenerationClient({ fetchImpl: async (url) => {
        urls.push(url);
        return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    } });
    await httpClient.generate({ settings: { ...settings, baseUrl: 'http://remote.example.test' }, positivePrompt: 'scene', negativePrompt: '' });
    assert.deepEqual(urls, ['http://remote.example.test/v1/images/generations']);
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
    const diagnostics = [];
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
        diagnosticLogger: {
            info: (...args) => diagnostics.push(['info', ...args]),
            error: (...args) => diagnostics.push(['error', ...args]),
        },
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
    assert.deepEqual(diagnostics.map(([, label]) => label), [
        '[约了吗][生图] 请求开始',
        '[约了吗][生图] ComfyUI 工作流准备完成',
        '[约了吗][生图] ComfyUI 工作流提交响应',
        '[约了吗][生图] ComfyUI 任务已接受',
        '[约了吗][生图] ComfyUI 任务状态响应',
        '[约了吗][生图] ComfyUI 图片读取响应',
        '[约了吗][生图] 请求完成',
    ]);
    assert.equal(diagnostics[1][2].customWorkflow, true);
    assert.equal(diagnostics[1][2].nodeCount, 5);
    assert.doesNotMatch(JSON.stringify(diagnostics), /adult portrait|lowres|task-1|done\.png/u);
});

test('ComfyUI rejects UI-format workflows and unsafe workflow keys before network access', async () => {
    resetPersistentKeyStorage();
    let calls = 0;
    const diagnostics = [];
    const client = createImageGenerationClient({
        diagnosticLogger: { error: (...args) => diagnostics.push(args) },
        fetchImpl: async () => { calls += 1; throw new Error('must not run'); },
    });
    await assert.rejects(
        () => client.generate({ settings: { ...settings, apiMode: 'comfyui', baseUrl: 'http://127.0.0.1:8188', comfyWorkflow: '{"nodes":[]}' }, positivePrompt: 'scene', negativePrompt: '' }),
        (error) => error?.code === 'INVALID_IMAGE_REQUEST' && /API Format/u.test(error.message),
    );
    await assert.rejects(
        () => client.generate({ settings: { ...settings, apiMode: 'comfyui', baseUrl: 'http://127.0.0.1:8188', comfyWorkflow: '{"__proto__":{"x":1}}' }, positivePrompt: 'scene', negativePrompt: '' }),
        (error) => error?.code === 'INVALID_IMAGE_REQUEST',
    );
    assert.equal(calls, 0);
    assert.equal(diagnostics[0]?.[1]?.phase, 'workflow_prepare');
    assert.equal(diagnostics[0]?.[1]?.code, 'INVALID_IMAGE_REQUEST');
    assert.match(diagnostics[0]?.[1]?.message, /API Format/u);
});

test('ComfyUI resource refresh reads bounded object_info choices through the injected transport', async () => {
    let request;
    const diagnostics = [];
    const padding = 'x'.repeat(2 * 1024 * 1024);
    const client = createImageGenerationClient({
        diagnosticLogger: {
            info: (...args) => diagnostics.push(['info', ...args]),
            error: (...args) => diagnostics.push(['error', ...args]),
        },
        fetchImpl: async (url, init) => {
            request = { url, init };
            return new Response(JSON.stringify({
                CheckpointLoaderSimple: { input: { required: { ckpt_name: [['portrait.safetensors', 'anime.safetensors']] } } },
                KSampler: { input: { required: { sampler_name: [['euler', 'dpmpp_2m']], scheduler: [['normal', 'karras']] } } },
                VAELoader: { input: { required: { vae_name: [['vae.safetensors']] } } },
                DualCLIPLoader: { input: { required: { clip_name1: [['clip-l.safetensors']], clip_name2: [['t5xxl.safetensors']] } } },
                customNodeMetadata: padding,
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
    assert.deepEqual(diagnostics.map(([level, label]) => [level, label]), [
        ['info', '[约了吗][生图] ComfyUI 资源读取开始'],
        ['info', '[约了吗][生图] ComfyUI 资源收到响应'],
        ['info', '[约了吗][生图] ComfyUI 资源读取完成'],
    ]);
    assert.equal(diagnostics[2][2].models, 2);
    assert.equal(diagnostics[2][2].clips, 2);
});

test('ComfyUI resource refresh reports oversized object_info without calling it an oversized image', async () => {
    const diagnostics = [];
    const client = createImageGenerationClient({
        diagnosticLogger: { error: (...args) => diagnostics.push(args) },
        fetchImpl: async () => new Response('{}', {
            status: 200,
            headers: {
                'content-type': 'application/json',
                'content-length': String((32 * 1024 * 1024) + 1),
            },
        }),
    });

    await assert.rejects(
        () => client.fetchComfyUIResources({ baseUrl: 'http://127.0.0.1:8188' }),
        (error) => error?.code === 'COMFY_RESOURCE_RESPONSE_TOO_LARGE'
            && /资源列表过大/u.test(error.message)
            && !/图片过大/u.test(error.message),
    );
    assert.equal(diagnostics[0]?.[0], '[约了吗][生图] ComfyUI 资源读取失败');
    assert.equal(diagnostics[0]?.[1]?.phase, 'response_parse');
    assert.equal(diagnostics[0]?.[1]?.code, 'COMFY_RESOURCE_RESPONSE_TOO_LARGE');
});

test('ComfyUI resource refresh turns transport failures into safe staged diagnostics', async () => {
    const diagnostics = [];
    const client = createImageGenerationClient({
        diagnosticLogger: { error: (...args) => diagnostics.push(args) },
        fetchImpl: async () => { throw new Error('private browser transport details'); },
    });

    await assert.rejects(
        () => client.fetchComfyUIResources({ baseUrl: 'http://127.0.0.1:8188' }),
        (error) => error?.code === 'IMAGE_NETWORK_ERROR' && error.retryable === true,
    );
    assert.equal(diagnostics[0]?.[0], '[约了吗][生图] ComfyUI 资源读取失败');
    assert.equal(diagnostics[0]?.[1]?.phase, 'network_request');
    assert.equal(diagnostics[0]?.[1]?.code, 'IMAGE_NETWORK_ERROR');
    assert.doesNotMatch(JSON.stringify(diagnostics), /private browser transport details/u);
});

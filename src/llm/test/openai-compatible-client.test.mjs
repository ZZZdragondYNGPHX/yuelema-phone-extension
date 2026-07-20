import assert from 'node:assert/strict';
import {
    MAX_RESPONSE_BYTES,
    createConnectionPreset,
    createOpenAICompatibleClient,
    normalizeApiUrl,
    normalizeConnectionProbe,
    splitPseudoStreamText,
    toPublicLlmError,
} from '../openai-compatible-client.js';
import {
    clearPersistentKeys,
    clearSessionKeys,
    configurePersistentKeyStorage,
    hasSessionKey,
    resetPersistentKeyStorage,
    unlockSessionKey,
} from '../session-key-store.js';
import { createMemoryStorage } from '../../settings/settings-store.js';

function jsonResponse(payload, { status = 200 } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json; charset=utf-8' },
        async json() { return payload; },
    };
}

function textResponse({ status = 200 } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'text/plain' },
        async json() { throw new SyntaxError('not json'); },
    };
}

function sseResponse(chunks, { status = 200, contentType = 'text/event-stream; charset=utf-8' } = {}) {
    const encoder = new TextEncoder();
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => contentType },
        body: new ReadableStream({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
                controller.close();
            },
        }),
    };
}

function pendingStreamResponse(onCancel) {
    return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: {
            getReader() {
                return {
                    read() { return new Promise(() => {}); },
                    async cancel() { onCancel?.(); },
                    releaseLock() {},
                };
            },
        },
    };
}

async function rejectsCode(action, code) {
    await assert.rejects(action, (error) => error?.code === code);
}

const preset = createConnectionPreset({
    id: 'quick_chat', name: '快速聊天', url: 'https://api.example.invalid/v1/', model: 'fast-model',
    temperature: 0.6, maxTokens: 256, timeoutMs: 100,
});
assert.deepEqual(preset, {
    id: 'quick_chat', name: '快速聊天', url: 'https://api.example.invalid/v1', model: 'fast-model',
    temperature: 0.6, maxTokens: 256, timeoutMs: 100, transportMode: 'json',
});
assert.equal(Object.isFrozen(preset), true);
assert.equal(normalizeApiUrl('http://localhost:8000/v1'), 'http://localhost:8000/v1');
assert.throws(() => normalizeApiUrl('http://example.com/v1'), (error) => error.code === 'INVALID_URL');
assert.throws(() => createConnectionPreset({ ...preset, apiKey: 'not-saved' }), (error) => error.code === 'PRESET_SECRET_FORBIDDEN');
assert.throws(() => createConnectionPreset({ ...preset, model: "bad\nmodel" }), (error) => error.code === 'INVALID_PRESET');
assert.throws(() => createConnectionPreset({ ...preset, model: '' }), (error) => error.code === 'INVALID_PRESET');
assert.throws(() => createConnectionPreset({ ...preset, transportMode: 'auto' }), (error) => error.code === 'INVALID_PRESET');
assert.deepEqual(normalizeConnectionProbe({ ...preset, model: '' }), { ...preset, model: '' });
assert.deepEqual(normalizeConnectionProbe({ ...preset, model: undefined }), { ...preset, model: '' });
assert.deepEqual(normalizeConnectionProbe({ ...preset, model: '   ' }), { ...preset, model: '' });

configurePersistentKeyStorage(createMemoryStorage());
clearPersistentKeys();
clearSessionKeys();
assert.equal(hasSessionKey(preset.id), false);
const sessionKey = ['mock', 'session', 'credential'].join('-');
unlockSessionKey(preset.id, sessionKey);
assert.equal(hasSessionKey(preset.id), true);
clearSessionKeys();
assert.equal(hasSessionKey(preset.id), true);

let observedRequest;
const client = createOpenAICompatibleClient({
    async fetchImpl(url, options) {
        observedRequest = { url, options };
        return jsonResponse({ choices: [{ message: { content: '短回复' } }] });
    },
});
const reply = await client.chat({ preset, messages: [{ role: 'user', content: '你好' }] });
assert.equal(reply.text, '短回复');
assert.equal(reply.source, 'message.content');
assert.equal(Object.hasOwn(reply, 'raw'), false);
assert.equal(Object.hasOwn(reply, 'presentation'), false);
assert.equal(observedRequest.url, 'https://api.example.invalid/v1/chat/completions');
assert.equal(observedRequest.options.method, 'POST');
assert.equal(observedRequest.options.headers.authorization, `Bearer ${sessionKey}`);
assert.equal(JSON.parse(observedRequest.options.body).model, 'fast-model');
assert.equal(Object.hasOwn(JSON.parse(observedRequest.options.body), 'stream'), false);

const fallbackClient = createOpenAICompatibleClient({
    async fetchImpl() { return jsonResponse({ choices: [{ text: '兼容文本' }] }); },
});
assert.equal((await fallbackClient.chat({ preset, messages: [{ role: 'user', content: 'fallback' }] })).text, '兼容文本');

let pseudoBody;
const pseudoPreset = createConnectionPreset({ ...preset, transportMode: 'pseudo_stream' });
const pseudoClient = createOpenAICompatibleClient({
    async fetchImpl(_url, options) {
        pseudoBody = JSON.parse(options.body);
        return jsonResponse({ choices: [{ message: { content: '甲乙😀丙丁' } }] });
    },
});
const pseudoReply = await pseudoClient.chat({ preset: pseudoPreset, messages: [{ role: 'user', content: 'x' }] });
assert.equal(pseudoBody.stream, undefined);
assert.deepEqual(pseudoReply.presentation, { transportMode: 'pseudo_stream', chunkSize: 24 });
assert.deepEqual(splitPseudoStreamText(pseudoReply.text, { chunkSize: 2 }), ['甲乙', '😀丙', '丁']);
assert.throws(() => splitPseudoStreamText('x', { chunkSize: 0 }), (error) => error.code === 'INVALID_REQUEST');

const streamPreset = createConnectionPreset({ ...preset, transportMode: 'stream' });
const streamedDeltas = [];
let streamBody;
const streamClient = createOpenAICompatibleClient({
    async fetchImpl(_url, options) {
        streamBody = JSON.parse(options.body);
        assert.equal(options.headers.accept, 'text/event-stream');
        return sseResponse([
            'data: {"choices":[{"delta":{"content":"长"}}]}\r\n\r\n',
            'data: {"choices":[{"delta":{"content":[{"text":"回"},{"text":{"value":"复"}}]}}]}\n',
            ': keep-alive\n\n',
            'data: [DO',
            'NE]\n\n',
        ]);
    },
});
const streamReply = await streamClient.chat({
    preset: streamPreset,
    messages: [{ role: 'user', content: 'stream' }],
    onDelta(delta, meta) {
        streamedDeltas.push([delta, meta.transportMode, meta.receivedCharacters]);
    },
});
assert.equal(streamBody.stream, true);
assert.equal(streamReply.text, '长回复');
assert.equal(streamReply.source, 'delta.content');
assert.deepEqual(streamReply.presentation, { transportMode: 'stream' });
assert.deepEqual(streamedDeltas, [['长', 'stream', 1], ['回复', 'stream', 3]]);
assert.equal(Object.hasOwn(streamReply, 'raw'), false);

const modelClient = createOpenAICompatibleClient({
    async fetchImpl(url, options) {
        assert.equal(url, 'https://api.example.invalid/v1/models');
        assert.equal(options.method, 'GET');
        return jsonResponse({ data: [{ id: 'fast-model' }, { id: 'fast-model' }, { id: 'quality-model' }] });
    },
});
assert.deepEqual(await modelClient.fetchModels({ preset: { ...preset, model: '' } }), ['fast-model', 'quality-model']);
assert.deepEqual(await modelClient.fetchModels({ preset: { ...preset, model: undefined } }), ['fast-model', 'quality-model']);

const postModelClient = createOpenAICompatibleClient({
    async fetchImpl(_url, options) {
        assert.equal(options.method, 'POST');
        return jsonResponse({ models: [{ name: 'post-model' }] });
    },
});
assert.deepEqual(await postModelClient.fetchModels({ preset: { ...preset, model: '' }, method: 'POST' }), ['post-model']);

const authClient = createOpenAICompatibleClient({ async fetchImpl() { return textResponse({ status: 401 }); } });
await rejectsCode(() => authClient.chat({ preset, messages: [{ role: 'user', content: 'x' }] }), 'AUTH_FAILED');
const throttledClient = createOpenAICompatibleClient({ async fetchImpl() { return jsonResponse({}, { status: 429 }); } });
await rejectsCode(() => throttledClient.chat({ preset, messages: [{ role: 'user', content: 'x' }] }), 'RATE_LIMITED');
const serverClient = createOpenAICompatibleClient({ async fetchImpl() { return jsonResponse({}, { status: 503 }); } });
await rejectsCode(() => serverClient.chat({ preset, messages: [{ role: 'user', content: 'x' }] }), 'SERVER_ERROR');
const nonJsonClient = createOpenAICompatibleClient({ async fetchImpl() { return textResponse(); } });
await rejectsCode(() => nonJsonClient.chat({ preset, messages: [{ role: 'user', content: 'x' }] }), 'NON_JSON_RESPONSE');
const nonStreamClient = createOpenAICompatibleClient({ async fetchImpl() { return sseResponse([], { contentType: 'application/json' }); } });
await rejectsCode(() => nonStreamClient.chat({ preset: streamPreset, messages: [{ role: 'user', content: 'x' }] }), 'NON_STREAM_RESPONSE');
const invalidStreamClient = createOpenAICompatibleClient({
    async fetchImpl() { return sseResponse(['data: PRIVATE_RAW_RESPONSE\n\n']); },
});
await assert.rejects(
    () => invalidStreamClient.chat({ preset: streamPreset, messages: [{ role: 'user', content: 'x' }] }),
    (error) => error.code === 'INVALID_STREAM_RESPONSE' && !error.message.includes('PRIVATE_RAW_RESPONSE'),
);

const tooLargeStreamClient = createOpenAICompatibleClient({
    async fetchImpl() { return sseResponse([new Uint8Array(MAX_RESPONSE_BYTES + 1)]); },
});
await rejectsCode(() => tooLargeStreamClient.chat({ preset: streamPreset, messages: [{ role: 'user', content: 'x' }] }), 'RESPONSE_TOO_LARGE');
const tooLargeJsonClient = createOpenAICompatibleClient({
    async fetchImpl() { return jsonResponse({ choices: [{ message: { content: 'x'.repeat(MAX_RESPONSE_BYTES) } }] }); },
});
await rejectsCode(() => tooLargeJsonClient.chat({ preset, messages: [{ role: 'user', content: 'x' }] }), 'RESPONSE_TOO_LARGE');

const timeoutClient = createOpenAICompatibleClient({
    fetchImpl(_url, options) {
        return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
    },
});
await rejectsCode(() => timeoutClient.chat({ preset, timeoutMs: 20, messages: [{ role: 'user', content: 'x' }] }), 'TIMEOUT');

let timedOutReaderCancelled = false;
const streamTimeoutClient = createOpenAICompatibleClient({
    async fetchImpl() { return pendingStreamResponse(() => { timedOutReaderCancelled = true; }); },
});
await rejectsCode(() => streamTimeoutClient.chat({ preset: streamPreset, timeoutMs: 20, messages: [{ role: 'user', content: 'x' }] }), 'TIMEOUT');
assert.equal(timedOutReaderCancelled, true);

const controller = new AbortController();
const cancelClient = createOpenAICompatibleClient({
    fetchImpl(_url, options) {
        return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
    },
});
const cancelled = cancelClient.chat({ preset, signal: controller.signal, messages: [{ role: 'user', content: 'x' }] });
controller.abort();
await rejectsCode(() => cancelled, 'CANCELLED');

let cancelledReader = false;
const streamController = new AbortController();
const streamCancelClient = createOpenAICompatibleClient({
    async fetchImpl() { return pendingStreamResponse(() => { cancelledReader = true; }); },
});
const streamCancelled = streamCancelClient.chat({
    preset: streamPreset,
    signal: streamController.signal,
    messages: [{ role: 'user', content: 'x' }],
});
await new Promise((resolve) => setTimeout(resolve, 0));
streamController.abort();
await rejectsCode(() => streamCancelled, 'CANCELLED');
assert.equal(cancelledReader, true);

clearPersistentKeys();
clearSessionKeys();
assert.equal(hasSessionKey(preset.id), false);
await rejectsCode(() => client.chat({ preset, messages: [{ role: 'user', content: 'x' }] }), 'SESSION_KEY_LOCKED');
const publicError = toPublicLlmError(new Error(sessionKey));
assert.equal(publicError.code, 'UNKNOWN_ERROR');
assert.equal(publicError.message.includes('credential'), false);

console.log('✓ llm transport modes, SSE and OpenAI-compatible client mock tests passed');
resetPersistentKeyStorage();



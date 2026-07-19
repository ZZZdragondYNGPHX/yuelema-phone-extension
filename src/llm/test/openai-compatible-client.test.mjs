import assert from 'node:assert/strict';
import {
    createConnectionPreset,
    createOpenAICompatibleClient,
    normalizeApiUrl,
    toPublicLlmError,
} from '../openai-compatible-client.js';
import {
    clearSessionKeys,
    hasSessionKey,
    unlockSessionKey,
} from '../session-key-store.js';

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

async function rejectsCode(action, code) {
    await assert.rejects(action, (error) => error?.code === code);
}

const preset = createConnectionPreset({
    id: 'quick_chat', name: '快速聊天', url: 'https://api.example.invalid/v1/', model: 'fast-model',
    temperature: 0.6, maxTokens: 256, timeoutMs: 100,
});
assert.deepEqual(preset, {
    id: 'quick_chat', name: '快速聊天', url: 'https://api.example.invalid/v1', model: 'fast-model',
    temperature: 0.6, maxTokens: 256, timeoutMs: 100,
});
assert.equal(Object.isFrozen(preset), true);
assert.equal(normalizeApiUrl('http://localhost:8000/v1'), 'http://localhost:8000/v1');
assert.throws(() => normalizeApiUrl('http://example.com/v1'), (error) => error.code === 'INVALID_URL');
assert.throws(() => createConnectionPreset({ ...preset, apiKey: 'not-saved' }), (error) => error.code === 'PRESET_SECRET_FORBIDDEN');
assert.throws(() => createConnectionPreset({ ...preset, model: "bad\nmodel" }), (error) => error.code === 'INVALID_PRESET');

clearSessionKeys();
assert.equal(hasSessionKey(preset.id), false);
const sessionKey = ['mock', 'session', 'credential'].join('-');
unlockSessionKey(preset.id, sessionKey);
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
assert.equal(observedRequest.url, 'https://api.example.invalid/v1/chat/completions');
assert.equal(observedRequest.options.method, 'POST');
assert.equal(observedRequest.options.headers.authorization, `Bearer ${sessionKey}`);
assert.equal(JSON.parse(observedRequest.options.body).model, 'fast-model');

const fallbackClient = createOpenAICompatibleClient({
    async fetchImpl() { return jsonResponse({ choices: [{ text: '兼容文本' }] }); },
});
assert.equal((await fallbackClient.chat({ preset, messages: [{ role: 'user', content: 'fallback' }] })).text, '兼容文本');

const modelClient = createOpenAICompatibleClient({
    async fetchImpl(url, options) {
        assert.equal(url, 'https://api.example.invalid/v1/models');
        assert.equal(options.method, 'GET');
        return jsonResponse({ data: [{ id: 'fast-model' }, { id: 'fast-model' }, { id: 'quality-model' }] });
    },
});
assert.deepEqual(await modelClient.fetchModels({ preset }), ['fast-model', 'quality-model']);

const postModelClient = createOpenAICompatibleClient({
    async fetchImpl(_url, options) {
        assert.equal(options.method, 'POST');
        return jsonResponse({ models: [{ name: 'post-model' }] });
    },
});
assert.deepEqual(await postModelClient.fetchModels({ preset, method: 'POST' }), ['post-model']);

const authClient = createOpenAICompatibleClient({ async fetchImpl() { return textResponse({ status: 401 }); } });
await rejectsCode(() => authClient.chat({ preset, messages: [{ role: 'user', content: 'x' }] }), 'AUTH_FAILED');
const throttledClient = createOpenAICompatibleClient({ async fetchImpl() { return jsonResponse({}, { status: 429 }); } });
await rejectsCode(() => throttledClient.chat({ preset, messages: [{ role: 'user', content: 'x' }] }), 'RATE_LIMITED');
const serverClient = createOpenAICompatibleClient({ async fetchImpl() { return jsonResponse({}, { status: 503 }); } });
await rejectsCode(() => serverClient.chat({ preset, messages: [{ role: 'user', content: 'x' }] }), 'SERVER_ERROR');
const nonJsonClient = createOpenAICompatibleClient({ async fetchImpl() { return textResponse(); } });
await rejectsCode(() => nonJsonClient.chat({ preset, messages: [{ role: 'user', content: 'x' }] }), 'NON_JSON_RESPONSE');

const timeoutClient = createOpenAICompatibleClient({
    fetchImpl(_url, options) {
        return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
    },
});
await rejectsCode(() => timeoutClient.chat({ preset, timeoutMs: 20, messages: [{ role: 'user', content: 'x' }] }), 'TIMEOUT');

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

clearSessionKeys();
assert.equal(hasSessionKey(preset.id), false);
await rejectsCode(() => client.chat({ preset, messages: [{ role: 'user', content: 'x' }] }), 'SESSION_KEY_LOCKED');
const publicError = toPublicLlmError(new Error(sessionKey));
assert.equal(publicError.code, 'UNKNOWN_ERROR');
assert.equal(publicError.message.includes('credential'), false);

console.log('✓ llm session-key and OpenAI-compatible client mock tests passed');



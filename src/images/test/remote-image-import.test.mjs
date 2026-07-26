import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteImageImporter, projectRemoteImportError } from '../remote-image-import.js';

function fakeResponse({ ok = true, type = 'image/png', size = 2048, contentLength = null, blobError = false } = {}) {
    return {
        ok,
        headers: { get: (name) => (name === 'content-length' && contentLength !== null ? String(contentLength) : null) },
        blob: async () => {
            if (blobError) throw new Error('host blob failure with secret detail');
            return { size, type };
        },
    };
}

test('remote importer requires an injected transport and never owns default network', () => {
    assert.throws(() => createRemoteImageImporter(), (error) => error.code === 'REMOTE_IMPORT_UNAVAILABLE');
    assert.throws(() => createRemoteImageImporter({}), (error) => error.code === 'REMOTE_IMPORT_UNAVAILABLE');
});

test('remote importer downloads once with omitted credentials, no referrer, and no cache', async () => {
    const calls = [];
    const importer = createRemoteImageImporter({
        fetchImpl: async (input, init) => { calls.push({ input, init }); return fakeResponse(); },
    });
    const blob = await importer.importImageFile('https://example.com/a.png');
    assert.equal(blob.type, 'image/png');
    assert.equal(calls.length, 1, '导入只允许一次请求');
    assert.equal(calls[0].init.credentials, 'omit');
    assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
    assert.equal(calls[0].init.cache, 'no-store');
    assert.equal(calls[0].init.method, 'GET');
});

test('remote importer rejects non-http URLs, embedded credentials, and junk input', async () => {
    const importer = createRemoteImageImporter({ fetchImpl: async () => fakeResponse() });
    for (const url of ['ftp://example.com/a.png', 'javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.com/a.png', '', '   ', 'not a url', 'data:image/png;base64,AAAA']) {
        await assert.rejects(() => importer.importImageFile(url), (error) => error.code === 'REMOTE_URL_INVALID', `应拒绝：${url}`);
    }
});

test('remote importer enforces size caps from both content-length and blob size', async () => {
    const oversizedHeader = createRemoteImageImporter({ fetchImpl: async () => fakeResponse({ contentLength: 9 * 1024 * 1024 }) });
    await assert.rejects(() => oversizedHeader.importImageFile('https://example.com/big.png'), (error) => error.code === 'REMOTE_IMAGE_TOO_LARGE');

    const oversizedBlob = createRemoteImageImporter({ fetchImpl: async () => fakeResponse({ size: 9 * 1024 * 1024 }) });
    await assert.rejects(() => oversizedBlob.importImageFile('https://example.com/big.png'), (error) => error.code === 'REMOTE_IMAGE_TOO_LARGE');
});

test('remote importer rejects non-image payloads and failed responses', async () => {
    const wrongType = createRemoteImageImporter({ fetchImpl: async () => fakeResponse({ type: 'text/html' }) });
    await assert.rejects(() => wrongType.importImageFile('https://example.com/page'), (error) => error.code === 'REMOTE_IMAGE_TYPE_UNSUPPORTED');

    const failed = createRemoteImageImporter({ fetchImpl: async () => fakeResponse({ ok: false }) });
    await assert.rejects(() => failed.importImageFile('https://example.com/a.png'), (error) => error.code === 'REMOTE_FETCH_FAILED');

    const network = createRemoteImageImporter({ fetchImpl: async () => { throw new Error('socket reset at 10.0.0.8'); } });
    await assert.rejects(() => network.importImageFile('https://example.com/a.png'), (error) => error.code === 'REMOTE_FETCH_FAILED');

    const brokenBody = createRemoteImageImporter({ fetchImpl: async () => fakeResponse({ blobError: true }) });
    await assert.rejects(() => brokenBody.importImageFile('https://example.com/a.png'), (error) => error.code === 'REMOTE_FETCH_FAILED');
});

test('remote importer maps AbortError to a timeout code and wires an abort signal', async () => {
    let receivedSignal = null;
    const aborting = createRemoteImageImporter({
        fetchImpl: async (_input, init) => { receivedSignal = init.signal; const error = new Error('aborted'); error.name = 'AbortError'; throw error; },
    });
    await assert.rejects(() => aborting.importImageFile('https://example.com/slow.png'), (error) => error.code === 'REMOTE_IMPORT_TIMEOUT');
    assert.ok(receivedSignal, '注入 transport 应收到超时 abort signal');
});

test('remote import errors never leak the URL or raw host failure text', async () => {
    const secretUrl = 'https://private.example.com/secret-album/photo.png?token=abc123';
    const importer = createRemoteImageImporter({ fetchImpl: async () => { throw new Error(`refused ${secretUrl}`); } });
    try {
        await importer.importImageFile(secretUrl);
        assert.fail('应当抛出导入错误');
    } catch (error) {
        const projected = projectRemoteImportError(error);
        assert.ok(projected, '已知错误码必须可投影');
        assert.doesNotMatch(projected.message, /example\.com|token|abc123|secret/u);
        assert.doesNotMatch(String(error.message), /example\.com|token|abc123|secret/u);
    }
    assert.equal(projectRemoteImportError(new Error('random')), null, '未知错误不得冒充远程导入错误');
});

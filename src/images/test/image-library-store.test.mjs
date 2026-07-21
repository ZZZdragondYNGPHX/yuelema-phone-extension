import test from 'node:test';
import assert from 'node:assert/strict';
import {
    IMAGE_LIBRARY_SCHEMA_ID,
    IMAGE_LIBRARY_SCHEMA_VERSION,
    IMAGE_LIBRARY_STORAGE_KEY,
    MAX_EMBEDDED_IMAGE_DATA_URL_LENGTH,
    MAX_IMAGE_LIBRARY_SERIALIZED_BYTES,
    ImageLibraryError,
    createImageLibraryStore,
    createMemoryImageLibraryStorage,
    projectImageLibraryError,
} from '../image-library-store.js';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';
const FIXED_TIME = '2026-07-20T12:00:00.000Z';

function storeWithMemory() {
    return createImageLibraryStore({
        storage: createMemoryImageLibraryStorage(),
        now: () => FIXED_TIME,
    });
}

function expectCode(action, code) {
    return assert.rejects(action, (error) => {
        assert.ok(error instanceof ImageLibraryError);
        assert.equal(error.code, code);
        assert.match(error.message, /^image_library_error:/u);
        return true;
    });
}

test('uses an async memory storage adapter and returns a frozen versioned snapshot', async () => {
    const storage = createMemoryImageLibraryStorage();
    const store = createImageLibraryStore({ storage, now: () => FIXED_TIME });

    assert.deepEqual(await store.snapshot(), {
        schema: IMAGE_LIBRARY_SCHEMA_ID,
        schemaVersion: IMAGE_LIBRARY_SCHEMA_VERSION,
        images: [],
    });
    assert.equal(Object.isFrozen(await store.snapshot()), true);
    assert.equal(await storage.getItem(IMAGE_LIBRARY_STORAGE_KEY), null);
});

test('accepts safe embedded and HTTP/HTTPS URL sources and normalizes image records', async () => {
    const store = storeWithMemory();
    const embedded = await store.add({
        source: { kind: 'embedded', dataUrl: 'data:image/PNG;base64,iVBORw0KGgo=' },
        keywordWeights: [{ keyword: '艺术', weight: 5 }],
    });
    const remote = await store.add({
        source: { kind: 'url', url: 'https://cdn.example.test/images/forest.webp' },
        keywordWeights: [{ keyword: '夜景', weight: -2 }],
    });

    assert.match(embedded.id, /^image_/u);
    assert.deepEqual(embedded.source, { kind: 'embedded', dataUrl: PNG_DATA_URL });
    assert.deepEqual(remote.source, { kind: 'url', url: 'https://cdn.example.test/images/forest.webp' });
    assert.equal(Object.isFrozen(embedded), true);
    assert.equal(Object.isFrozen(embedded.source), true);
    assert.equal(Object.isFrozen(embedded.keywordWeights), true);

    await expectCode(
        store.add({ source: { kind: 'url', url: 'file:///private/image.png' } }),
        'INVALID_IMAGE_SOURCE',
    );
    await expectCode(
        store.add({ source: { kind: 'url', url: 'blob:https://example.test/local-object' } }),
        'INVALID_IMAGE_SOURCE',
    );
});

test('accepts signature-valid embedded binary whose decoded bytes contain markup-like sequences', async () => {
    const store = storeWithMemory();
    // Binary image payloads are not text. This fixture deliberately contains a
    // byte sequence that the shared avatar codec used to misclassify as HTML.
    const binaryWithMarkupLikeBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x00, 0x3c, 0x61, 0x3e, 0xff, 0x00]);
    const dataUrl = `data:image/webp;base64,${binaryWithMarkupLikeBytes.toString('base64')}`;

    const added = await store.add({ source: { kind: 'embedded', dataUrl } });
    assert.deepEqual(added.source, { kind: 'embedded', dataUrl });

    const reloaded = createImageLibraryStore({
        storage: createMemoryImageLibraryStorage([[IMAGE_LIBRARY_STORAGE_KEY, await store.export()]]),
        now: () => FIXED_TIME,
    });
    assert.deepEqual((await reloaded.list())[0].source, { kind: 'embedded', dataUrl });
});

test('embedded source rejects malformed, disguised, transient, and oversized values', async () => {
    const store = storeWithMemory();
    await expectCode(store.add({
        source: { kind: 'embedded', dataUrl: 'data:image/webp;base64,not*base64' },
    }), 'INVALID_IMAGE_SOURCE');
    await expectCode(store.add({
        source: { kind: 'embedded', dataUrl: 'data:text/html;base64,PGgxPm5vPC9oMT4=' },
    }), 'INVALID_IMAGE_SOURCE');
    await expectCode(store.add({
        source: { kind: 'embedded', dataUrl: 'data:image/png;base64,PGgxPm5vPC9oMT4=' },
    }), 'INVALID_IMAGE_SOURCE');
    await expectCode(store.add({
        source: { kind: 'embedded', dataUrl: 'blob:https://example.test/local-object' },
    }), 'INVALID_IMAGE_SOURCE');
    await expectCode(store.add({
        source: { kind: 'embedded', dataUrl: 'file:///private/image.png' },
    }), 'INVALID_IMAGE_SOURCE');
    const oversized = `data:image/png;base64,iVBORw0KGgo${'A'.repeat(MAX_EMBEDDED_IMAGE_DATA_URL_LENGTH)}`;
    await expectCode(store.add({
        source: { kind: 'embedded', dataUrl: oversized },
    }), 'INVALID_IMAGE_SOURCE');
});
test('supports image and keyword CRUD without exposing mutable internal state', async () => {
    const store = storeWithMemory();
    const added = await store.add({
        id: 'image_portrait_1',
        source: { kind: 'url', url: 'http://images.example.test/portrait.jpg' },
        keywordWeights: [
            { keyword: '艺术', weight: 5 },
            { keyword: '慢热', weight: 2 },
        ],
    });
    assert.throws(() => { added.keywordWeights[0].weight = 0; }, TypeError);
    assert.equal((await store.get('image_portrait_1')).keywordWeights[0].weight, 5);

    const updated = await store.update('image_portrait_1', {
        keywordWeights: [{ keyword: '夜景', weight: 3 }],
    });
    assert.deepEqual(updated.keywordWeights, [{ keyword: '夜景', weight: 3 }]);
    assert.deepEqual((await store.list()).map((item) => item.id), ['image_portrait_1']);

    const removed = await store.remove('image_portrait_1');
    assert.equal(removed.id, 'image_portrait_1');
    assert.deepEqual(await store.list(), []);
    await expectCode(store.get('image_portrait_1'), 'IMAGE_NOT_FOUND');
});

test('exports and imports a complete document while invalid imports roll back atomically', async () => {
    const storage = createMemoryImageLibraryStorage();
    const store = createImageLibraryStore({ storage, now: () => FIXED_TIME });
    await store.add({
        id: 'image_existing',
        source: { kind: 'embedded', dataUrl: PNG_DATA_URL },
        keywordWeights: [{ keyword: '温柔', weight: 1 }],
    });
    const before = await store.snapshot();
    const exported = await store.export();
    const imported = await store.import(exported);
    assert.deepEqual(imported, before);

    await expectCode(store.import('{not-json'), 'INVALID_LIBRARY_JSON');
    await expectCode(store.import({
        schema: IMAGE_LIBRARY_SCHEMA_ID,
        schemaVersion: IMAGE_LIBRARY_SCHEMA_VERSION,
        images: [{
            id: 'image_bad',
            source: { kind: 'url', url: 'https://example.test/bad.jpg' },
            keywordWeights: [{ keyword: '重复', weight: 1 }, { keyword: '重复', weight: 2 }],
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME,
        }],
    }), 'DUPLICATE_KEYWORD');
    assert.deepEqual(await store.snapshot(), before);
    assert.equal((await storage.getItem(IMAGE_LIBRARY_STORAGE_KEY)).includes('image_existing'), true);
});


test('keeps the prior in-memory document when an import storage write fails', async () => {
    const values = new Map();
    let rejectWrites = false;
    const storage = {
        async getItem(key) { return values.get(key) ?? null; },
        async setItem(key, value) {
            if (rejectWrites) throw new Error('quota');
            values.set(key, value);
        },
        async removeItem(key) { values.delete(key); },
    };
    const store = createImageLibraryStore({ storage, now: () => FIXED_TIME });
    await store.add({
        id: 'image_before_failure',
        source: { kind: 'embedded', dataUrl: PNG_DATA_URL },
    });
    const before = await store.snapshot();
    rejectWrites = true;

    await expectCode(store.import({
        schema: IMAGE_LIBRARY_SCHEMA_ID,
        schemaVersion: IMAGE_LIBRARY_SCHEMA_VERSION,
        images: [],
    }), 'STORAGE_WRITE_FAILED');
    assert.deepEqual(await store.snapshot(), before);
});
test('rejects duplicate keywords, invalid ranges, oversized data, and sensitive fields', async () => {
    const store = storeWithMemory();
    await expectCode(store.add({
        source: { kind: 'url', url: 'https://example.test/a.png' },
        keywordWeights: [{ keyword: '艺术', weight: 1 }, { keyword: ' 艺术 ', weight: 2 }],
    }), 'DUPLICATE_KEYWORD');
    await expectCode(store.add({
        source: { kind: 'url', url: 'https://example.test/a.png' },
        keywordWeights: [{ keyword: '艺术', weight: 6 }],
    }), 'INVALID_KEYWORD_WEIGHTS');
    await expectCode(store.add({
        source: { kind: 'url', url: 'https://example.test/a.png' },
        apiKey: 'sk-secret-value',
    }), 'SENSITIVE_FIELD_FORBIDDEN');
    await expectCode(store.add({
        source: { kind: 'url', url: 'https://example.test/a.png' },
        uid: 'character_1',
    }), 'SENSITIVE_FIELD_FORBIDDEN');
    await expectCode(store.add({
        source: { kind: 'url', url: 'https://example.test/a.png?token=secret' },
    }), 'SENSITIVE_FIELD_FORBIDDEN');
    await expectCode(store.import('x'.repeat(MAX_IMAGE_LIBRARY_SERIALIZED_BYTES + 1)), 'LIBRARY_TOO_LARGE');
});

test('projects only stable UI-safe errors without leaking raw data', () => {
    const projected = projectImageLibraryError(new ImageLibraryError('SENSITIVE_FIELD_FORBIDDEN'));
    assert.deepEqual(projected, {
        code: 'SENSITIVE_FIELD_FORBIDDEN',
        message: '图片库不能包含密钥、角色 UID、Patch 或隐私关系资料。',
    });
    assert.deepEqual(projectImageLibraryError(new Error('sk-live-secret')), {
        code: 'IMAGE_LIBRARY_ERROR',
        message: '图片库操作失败。',
    });
});




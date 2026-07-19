import test from 'node:test';
import assert from 'node:assert/strict';
import { compressLocalAvatar, MAX_SOURCE_AVATAR_BYTES, projectAvatarError } from '../avatar-codec.js';

function fakeFile({ type = 'image/png', size = 3 } = {}) {
    return { type, size };
}

function fakeBlob({ type = 'image/webp', bytes = Uint8Array.from([1, 2, 3]) } = {}) {
    return { type, size: bytes.length, async arrayBuffer() { return bytes.buffer.slice(0); } };
}

function successOptions(overrides = {}) {
    const events = [];
    return {
        events,
        decodeImage: async () => ({ width: 2000, height: 1000, closed: false, close() { this.closed = true; events.push('closed'); } }),
        canvasFactory(width, height) {
            events.push(['canvas', width, height]);
            return {
                getContext() { return { drawImage(...args) { events.push(['draw', args.slice(1)]); } }; },
                async convertToBlob() { return fakeBlob(); },
            };
        },
        ...overrides,
    };
}

test('compressLocalAvatar scales image, returns bounded embedded avatar and releases decoder resource', async () => {
    const options = successOptions();
    const output = await compressLocalAvatar(fakeFile(), options);
    assert.deepEqual(output, {
        kind: 'embedded', dataUrl: 'data:image/webp;base64,AQID', width: 1024, height: 512, mimeType: 'image/webp',
    });
    assert.deepEqual(options.events, [['canvas', 1024, 512], ['draw', [0, 0, 1024, 512]], 'closed']);
});

test('compressLocalAvatar rejects unsupported or oversized source files before decoding', async () => {
    await assert.rejects(() => compressLocalAvatar(fakeFile({ type: 'image/gif' }), successOptions()), { code: 'avatar_file_type_invalid' });
    await assert.rejects(() => compressLocalAvatar(fakeFile({ size: MAX_SOURCE_AVATAR_BYTES + 1 }), successOptions()), { code: 'avatar_file_too_large' });
});

test('compressLocalAvatar does not pretend compression succeeds when decoder or canvas fails', async () => {
    await assert.rejects(() => compressLocalAvatar(fakeFile(), successOptions({ decodeImage: async () => { throw new Error('bad image'); } })), { code: 'avatar_compression_failed' });
    await assert.rejects(() => compressLocalAvatar(fakeFile(), successOptions({ canvasFactory: () => null })), { code: 'avatar_canvas_unavailable' });
});

test('avatar failures use safe public messages', () => {
    const projected = projectAvatarError(Object.assign(new Error('avatar_codec_failed:avatar_file_too_large'), { code: 'avatar_file_too_large' }));
    assert.deepEqual(projected, { code: 'avatar_file_too_large', message: '本地头像原文件超过 8 MB。' });
    assert.doesNotMatch(projectAvatarError(new Error('contains secret')).message, /secret/iu);
});

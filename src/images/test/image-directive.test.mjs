import test from 'node:test';
import assert from 'node:assert/strict';
import { composeImagePrompt, formatImageDirective, normalizeImageDirective } from '../image-directive.js';

test('image directive accepts only the closed kind/scene contract', () => {
    assert.deepEqual(normalizeImageDirective({ kind: 'selfie', scene: 'mirror selfie, warm bedroom light' }), {
        kind: 'selfie', scene: 'mirror selfie, warm bedroom light',
    });
    assert.throws(() => normalizeImageDirective({ kind: 'selfie', scene: 'ok', prompt: 'owned by model' }));
    assert.throws(() => normalizeImageDirective({ kind: 'selfie', scene: '<img src=x>' }));
    assert.throws(() => normalizeImageDirective({ kind: 'unknown', scene: 'ok' }));
});

test('prompt composition preserves the required order and separate negative prompt', () => {
    const result = composeImagePrompt({
        positivePrefix: 'best quality', coreDna: 'black hair; blue eyes', outfitDna: 'white shirt',
        directive: { kind: 'share_photo', scene: 'cafe window, candid smile' },
        positiveSuffix: 'soft lighting', negativePrompt: 'low quality',
    });
    assert.equal(result.positivePrompt, 'best quality, black hair; blue eyes, white shirt, cafe window, candid smile, soft lighting');
    assert.equal(result.negativePrompt, 'low quality');
    assert.match(formatImageDirective(result.directive), /"scene"/u);
});

test('dangerous and secret-shaped fields are rejected without invoking getters', () => {
    const input = Object.create(null);
    Object.defineProperty(input, 'kind', { enumerable: true, get() { throw new Error('getter called'); } });
    Object.defineProperty(input, 'scene', { enumerable: true, value: 'safe' });
    assert.throws(() => normalizeImageDirective(input));
    assert.throws(() => normalizeImageDirective({ kind: 'selfie', scene: 'safe', api_key: 'secret' }));
});

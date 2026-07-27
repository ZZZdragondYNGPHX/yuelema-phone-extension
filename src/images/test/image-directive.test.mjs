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
        positivePrefix: 'best quality\nmasterpiece', coreDna: 'black hair; blue eyes', outfitDna: 'white shirt',
        directive: { kind: 'share_photo', scene: 'cafe window, candid smile' },
        positiveSuffix: 'soft lighting', negativePrompt: 'low quality\nbad anatomy',
    });
    assert.equal(result.positivePrompt, 'best quality\nmasterpiece, black hair; blue eyes, white shirt, cafe window, candid smile, soft lighting');
    assert.equal(result.negativePrompt, 'low quality\nbad anatomy');
    assert.throws(() => composeImagePrompt({ positivePrefix: 'safe\u000bunsafe', directive: { kind: 'selfie', scene: 'portrait' } }));
    assert.match(formatImageDirective(result.directive), /"scene"/u);
});

test('prompt composition permits bounded LoRA tokens but still rejects HTML', () => {
    const result = composeImagePrompt({
        positivePrefix: String.raw`amagi hana, <lora:detailer\Loraeyes_V1:1>, <lora:detailer\hairdetailer:0.8>`,
        directive: { kind: 'private_photo', scene: 'adult woman portrait' },
        positiveSuffix: 'masterpiece',
    });
    assert.match(result.positivePrompt, /<lora:detailer\\Loraeyes_V1:1>/u);
    assert.throws(() => composeImagePrompt({
        positivePrefix: '<img src=x onerror=alert(1)>',
        directive: { kind: 'private_photo', scene: 'adult woman portrait' },
    }));
    assert.throws(() => composeImagePrompt({
        positivePrefix: '<lora:detailer:1><script>alert(1)</script>',
        directive: { kind: 'private_photo', scene: 'adult woman portrait' },
    }));
});

test('dangerous and secret-shaped fields are rejected without invoking getters', () => {
    const input = Object.create(null);
    Object.defineProperty(input, 'kind', { enumerable: true, get() { throw new Error('getter called'); } });
    Object.defineProperty(input, 'scene', { enumerable: true, value: 'safe' });
    assert.throws(() => normalizeImageDirective(input));
    assert.throws(() => normalizeImageDirective({ kind: 'selfie', scene: 'safe', api_key: 'secret' }));
});

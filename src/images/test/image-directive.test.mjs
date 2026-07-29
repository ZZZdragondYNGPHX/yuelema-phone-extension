import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageDirectiveError, composeImagePrompt, formatImageDirective, normalizeImageDirective, normalizePrivateChatImageDirective } from '../image-directive.js';

function expectCode(callback, code) {
    assert.throws(callback, (error) => error instanceof ImageDirectiveError && error.code === code);
}

test('image directive accepts only the closed kind/scene/outfit contract', () => {
    assert.deepEqual(normalizeImageDirective({ kind: 'selfie', scene: 'mirror selfie, warm bedroom light' }), {
        kind: 'selfie', scene: 'mirror selfie, warm bedroom light',
    });
    assert.deepEqual(normalizeImageDirective({
        kind: 'selfie', scene: 'mirror selfie, warm bedroom light', outfit: 'blue and white cosplay dress, ribbon earrings',
    }), {
        kind: 'selfie', scene: 'mirror selfie, warm bedroom light', outfit: 'blue and white cosplay dress, ribbon earrings',
    });
    assert.throws(() => normalizeImageDirective({ kind: 'selfie', scene: 'ok', prompt: 'owned by model' }));
    assert.throws(() => normalizeImageDirective({ kind: 'selfie', scene: '<img src=x>' }));
    assert.throws(() => normalizeImageDirective({ kind: 'unknown', scene: 'ok' }));
    expectCode(() => normalizeImageDirective({ kind: 'scene_snapshot', scene: 'rainy garden', outfit: 'raincoat' }), 'IMAGE_DIRECTIVE_OUTFIT_NOT_ALLOWED');
});

test('private chat rejects identity and appearance DNA in scene without exposing prompt text', () => {
    const conflictingScene = 'A cute young Asian woman in a beautiful fantasy anime cosplay costume, delicate blue and white dress, stylish wig, smiling warmly at the camera, taking a selfie in a brightly lit bedroom';
    try {
        normalizePrivateChatImageDirective({ kind: 'selfie', scene: conflictingScene });
        assert.fail('expected private scene rejection');
    } catch (error) {
        assert.equal(error.code, 'IMAGE_DIRECTIVE_PRIVATE_SCENE_DNA');
        assert.doesNotMatch(error.message, /young Asian woman|cosplay costume|blue and white dress/iu);
    }
    expectCode(
        () => normalizePrivateChatImageDirective({ kind: 'private_photo', scene: 'close-up shot, black hair and blue eyes, studio light' }),
        'IMAGE_DIRECTIVE_PRIVATE_SCENE_DNA',
    );
    expectCode(
        () => normalizePrivateChatImageDirective({ kind: 'selfie', scene: 'blue and white cosplay dress, bedroom selfie framing' }),
        'IMAGE_DIRECTIVE_PRIVATE_SCENE_DNA',
    );
});

test('private chat accepts a separated transient outfit and a DNA-free scene', () => {
    const directive = normalizePrivateChatImageDirective({
        kind: 'selfie',
        outfit: 'blue and white fantasy cosplay dress, silver star earrings',
        scene: 'smiling warmly at the camera, handheld selfie framing, brightly lit bedroom, soft window light',
    });
    assert.deepEqual(directive, {
        kind: 'selfie',
        outfit: 'blue and white fantasy cosplay dress, silver star earrings',
        scene: 'smiling warmly at the camera, handheld selfie framing, brightly lit bedroom, soft window light',
    });
    expectCode(
        () => normalizePrivateChatImageDirective({ kind: 'selfie', outfit: 'long silver wig with blue eyes', scene: 'bedroom selfie framing' }),
        'IMAGE_DIRECTIVE_PRIVATE_OUTFIT_DNA',
    );
    expectCode(
        () => normalizePrivateChatImageDirective({ kind: 'scene_snapshot', scene: 'empty bedroom', outfit: 'blue dress' }),
        'IMAGE_DIRECTIVE_OUTFIT_NOT_ALLOWED',
    );
});

test('manual scene snapshots retain general scene support while private restrictions stay scoped', () => {
    const manual = normalizeImageDirective({
        kind: 'scene_snapshot', scene: 'young Asian woman in a blue dress beside a rainy garden window',
    });
    assert.equal(manual.scene, 'young Asian woman in a blue dress beside a rainy garden window');
    expectCode(
        () => normalizePrivateChatImageDirective({ kind: 'scene_snapshot', scene: manual.scene }),
        'IMAGE_DIRECTIVE_PRIVATE_SCENE_DNA',
    );
});

test('prompt composition preserves the required order, replaces outfit DNA, and separates negative prompt', () => {
    const result = composeImagePrompt({
        positivePrefix: 'best quality', coreDna: 'black hair; blue eyes', outfitDna: 'white shirt',
        directive: { kind: 'share_photo', outfit: 'blue and white cosplay dress', scene: 'cafe window, candid smile' },
        positiveSuffix: 'soft lighting', negativePrompt: 'low quality',
    });
    assert.equal(result.positivePrompt, 'best quality, black hair; blue eyes, blue and white cosplay dress, cafe window, candid smile, soft lighting');
    assert.equal(result.negativePrompt, 'low quality');
    assert.equal(result.directive.outfit, 'blue and white cosplay dress');
    assert.throws(() => composeImagePrompt({ positivePrefix: 'best quality\nmasterpiece', directive: { kind: 'selfie', scene: 'portrait' } }));
    assert.match(formatImageDirective(result.directive), /"outfit"/u);
});

test('prompt composition permits bounded LoRA tokens but still rejects HTML', () => {
    const result = composeImagePrompt({
        positivePrefix: String.raw`amagi hana, <lora:detailer\Loraeyes_V1:1>, <lora:detailer\hairdetailer:0.8>`,
        directive: { kind: 'private_photo', scene: 'portrait framing, studio light' },
        positiveSuffix: 'masterpiece',
    });
    assert.match(result.positivePrompt, /<lora:detailer\\Loraeyes_V1:1>/u);
    assert.throws(() => composeImagePrompt({
        positivePrefix: '<img src=x onerror=alert(1)>',
        directive: { kind: 'private_photo', scene: 'portrait framing' },
    }));
    assert.throws(() => composeImagePrompt({
        positivePrefix: '<lora:detailer:1><script>alert(1)</script>',
        directive: { kind: 'private_photo', scene: 'portrait framing' },
    }));
});

test('dangerous and secret-shaped fields are rejected without invoking getters', () => {
    const input = Object.create(null);
    Object.defineProperty(input, 'kind', { enumerable: true, get() { throw new Error('getter called'); } });
    Object.defineProperty(input, 'scene', { enumerable: true, value: 'safe' });
    assert.throws(() => normalizeImageDirective(input));
    assert.throws(() => normalizeImageDirective({ kind: 'selfie', scene: 'safe', api_key: 'secret' }));
});

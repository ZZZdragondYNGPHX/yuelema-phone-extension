import test from 'node:test';
import assert from 'node:assert/strict';
import { CHARACTER_AVATAR_STORAGE_KEY, createCharacterAvatarStore } from '../character-avatar-store.js';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

function memoryAsyncStorage() {
    const values = new Map();
    return {
        async getItem(key) { return values.get(key) ?? null; },
        async setItem(key, value) { values.set(key, structuredClone(value)); },
        raw(key) { return values.get(key); },
    };
}

test('character avatars persist by validated role uid and remain isolated from MVU/profile data', async () => {
    const storage = memoryAsyncStorage();
    const store = createCharacterAvatarStore({ storage });
    await store.ready();
    assert.deepEqual(store.snapshot('npc_custom_4'), { kind: 'placeholder' });

    await store.setAvatar('npc_custom_4', { kind: 'embedded', dataUrl: PNG_DATA_URL });
    assert.deepEqual(store.snapshot('npc_custom_4'), { kind: 'embedded', dataUrl: PNG_DATA_URL });
    assert.deepEqual(store.snapshot('npc_custom_5'), { kind: 'placeholder' });
    assert.deepEqual(Object.keys(storage.raw(CHARACTER_AVATAR_STORAGE_KEY)), ['version', 'avatars']);

    const restored = createCharacterAvatarStore({ storage });
    await restored.ready();
    assert.equal(restored.snapshot('npc_custom_4').dataUrl, PNG_DATA_URL);
    await restored.removeAvatar('npc_custom_4');
    assert.deepEqual(restored.snapshot('npc_custom_4'), { kind: 'placeholder' });
});

test('character avatar storage rejects unsafe identifiers and remote image references', async () => {
    const store = createCharacterAvatarStore({ storage: memoryAsyncStorage() });
    await store.ready();
    await assert.rejects(store.setAvatar('../玩家', { kind: 'embedded', dataUrl: PNG_DATA_URL }), { code: 'CHARACTER_AVATAR_UID_INVALID' });
    await assert.rejects(store.setAvatar('npc_custom_1', { kind: 'url', url: 'https://example.invalid/avatar.png' }));
});

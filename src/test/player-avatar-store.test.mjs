import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../settings/settings-store.js';
import { avatarImageSource, createPlayerAvatarStore, PLAYER_AVATAR_STORAGE_KEY } from '../player-avatar-store.js';

test('player avatar is isolated browser-local data with a safe URL and remove lifecycle', () => {
    const storage = createMemoryStorage();
    const store = createPlayerAvatarStore({ storage });
    assert.deepEqual(store.snapshot(), { kind: 'placeholder' });

    const saved = store.setAvatar({ kind: 'url', url: 'https://example.invalid/avatar.webp' });
    assert.deepEqual(saved, { kind: 'url', url: 'https://example.invalid/avatar.webp' });
    assert.deepEqual(createPlayerAvatarStore({ storage }).snapshot(), saved, '新页面实例可恢复当前浏览器的本地头像');
    assert.equal(avatarImageSource(saved), 'https://example.invalid/avatar.webp');
    assert.ok(storage.getItem(PLAYER_AVATAR_STORAGE_KEY));

    store.removeAvatar();
    assert.deepEqual(store.snapshot(), { kind: 'placeholder' });
    assert.equal(storage.getItem(PLAYER_AVATAR_STORAGE_KEY), null);
});

test('player avatar store rejects unsafe or non-image avatar references', () => {
    const store = createPlayerAvatarStore({ storage: createMemoryStorage() });
    assert.throws(() => store.setAvatar({ kind: 'url', url: 'javascript:alert(1)' }));
    assert.throws(() => store.setAvatar({ kind: 'embedded', dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }));
    assert.equal(avatarImageSource({ kind: 'placeholder' }), '');
});

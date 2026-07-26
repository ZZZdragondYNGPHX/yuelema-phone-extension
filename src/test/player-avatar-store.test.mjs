import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../settings/settings-store.js';
import { avatarImageSource, createPlayerAvatarStore, PLAYER_AVATAR_STORAGE_KEY } from '../player-avatar-store.js';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

test('player avatar is isolated browser-local embedded data with a remove lifecycle', () => {
    const storage = createMemoryStorage();
    const store = createPlayerAvatarStore({ storage });
    assert.deepEqual(store.snapshot(), { kind: 'placeholder' });

    const saved = store.setAvatar({ kind: 'embedded', dataUrl: PNG_DATA_URL });
    assert.deepEqual(saved, { kind: 'embedded', dataUrl: PNG_DATA_URL });
    assert.deepEqual(createPlayerAvatarStore({ storage }).snapshot(), saved, '新页面实例可恢复当前浏览器的本地头像');
    assert.equal(avatarImageSource(saved), PNG_DATA_URL);
    assert.ok(storage.getItem(PLAYER_AVATAR_STORAGE_KEY));

    store.removeAvatar();
    assert.deepEqual(store.snapshot(), { kind: 'placeholder' });
    assert.equal(storage.getItem(PLAYER_AVATAR_STORAGE_KEY), null);
});

test('player avatar store rejects remote, unsafe or non-image avatar references', () => {
    const storage = createMemoryStorage();
    const store = createPlayerAvatarStore({ storage });
    assert.throws(() => store.setAvatar({ kind: 'url', url: 'https://example.invalid/avatar.webp' }));
    assert.throws(() => store.setAvatar({ kind: 'url', url: 'javascript:alert(1)' }));
    assert.throws(() => store.setAvatar({ kind: 'embedded', dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }));
    assert.equal(avatarImageSource({ kind: 'placeholder' }), '');
    assert.equal(avatarImageSource({ kind: 'url', url: 'https://example.invalid/avatar.webp' }), '');

    storage.setItem(PLAYER_AVATAR_STORAGE_KEY, JSON.stringify({ version: 1, avatar: { kind: 'url', url: 'https://legacy.invalid/avatar.webp' } }));
    assert.deepEqual(createPlayerAvatarStore({ storage }).snapshot(), { kind: 'placeholder' }, '旧远程头像记录应安全降级');
});

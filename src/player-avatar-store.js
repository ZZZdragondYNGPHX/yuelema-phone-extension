/**
 * Browser-local presentation avatar for the “我的” header.
 *
 * It is intentionally separate from MVU public data and settings import/export:
 * a player controls it entirely in the current browser, and it never reaches a
 * model, prompt, connection preset, or character card.
 */
import { normalizeAvatarReference } from './characters/character-template-codec.js';

export const PLAYER_AVATAR_STORAGE_KEY = 'yuelema.player-avatar/v1';

const PLACEHOLDER = Object.freeze({ kind: 'placeholder' });

function supportedStorage(storage) {
    return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' && typeof storage.removeItem === 'function';
}

function parseStoredAvatar(raw) {
    if (typeof raw !== 'string' || raw.length < 2 || raw.length > 1_100_000) return PLACEHOLDER;
    try {
        const record = JSON.parse(raw);
        if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== 1 || !Object.hasOwn(record, 'avatar')) return PLACEHOLDER;
        return normalizeAvatarReference(record.avatar);
    } catch {
        return PLACEHOLDER;
    }
}

/** Returns an avatar store whose public API cannot carry arbitrary settings or secrets. */
export function createPlayerAvatarStore({ storage } = {}) {
    let fallback = PLACEHOLDER;
    const canStore = supportedStorage(storage);

    function snapshot() {
        if (!canStore) return fallback;
        try {
            const avatar = parseStoredAvatar(storage.getItem(PLAYER_AVATAR_STORAGE_KEY));
            fallback = avatar;
            return avatar;
        } catch {
            return fallback;
        }
    }

    function setAvatar(value) {
        const avatar = normalizeAvatarReference(value);
        fallback = avatar;
        if (canStore) {
            try { storage.setItem(PLAYER_AVATAR_STORAGE_KEY, JSON.stringify({ version: 1, avatar })); }
            catch { /* retain the current-lifetime fallback without surfacing raw storage errors */ }
        }
        return avatar;
    }

    function removeAvatar() {
        fallback = PLACEHOLDER;
        if (canStore) {
            try { storage.removeItem(PLAYER_AVATAR_STORAGE_KEY); }
            catch { /* clearing a local presentation preference is best effort */ }
        }
        return PLACEHOLDER;
    }

    return Object.freeze({ snapshot, setAvatar, removeAvatar });
}

export function avatarImageSource(avatar) {
    if (!avatar || typeof avatar !== 'object') return '';
    if (avatar.kind === 'url' && typeof avatar.url === 'string') return avatar.url;
    if (avatar.kind === 'embedded' && typeof avatar.dataUrl === 'string') return avatar.dataUrl;
    return '';
}

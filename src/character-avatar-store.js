import { normalizeAvatarReference } from './characters/character-template-codec.js';

export const CHARACTER_AVATAR_STORAGE_KEY = 'yuelema.character-avatars.v1';
const STORAGE_VERSION = 1;
const MAX_AVATAR_COUNT = 50;
const PLACEHOLDER = Object.freeze({ kind: 'placeholder' });

function validUid(value) {
    return typeof value === 'string' && /^npc_[A-Za-z0-9_-]{1,64}$/u.test(value);
}

function storageAvailable(storage) {
    return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function';
}

function normalizeStoredDocument(value) {
    const avatars = new Map();
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STORAGE_VERSION) return avatars;
    const source = value.avatars;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return avatars;
    for (const [uid, avatar] of Object.entries(source).slice(0, MAX_AVATAR_COUNT)) {
        if (!validUid(uid)) continue;
        try {
            const normalized = normalizeAvatarReference(avatar);
            if (normalized.kind === 'embedded') avatars.set(uid, normalized);
        } catch {
            // One malformed legacy record must not make every other avatar unavailable.
        }
    }
    return avatars;
}

/**
 * Browser-local role-avatar storage. The synchronous snapshot API serves rendering
 * from a validated memory mirror; writes are serialized through the injected
 * localforage-compatible adapter and never touch MVU, prompts or settings export.
 */
export function createCharacterAvatarStore({ storage } = {}) {
    const canPersist = storageAvailable(storage);
    let avatars = new Map();
    let initialized = false;
    let writeQueue = Promise.resolve();

    async function ready() {
        if (initialized) return status();
        initialized = true;
        if (!canPersist) return status();
        try {
            avatars = normalizeStoredDocument(await storage.getItem(CHARACTER_AVATAR_STORAGE_KEY));
        } catch {
            avatars = new Map();
        }
        return status();
    }

    function snapshot(uid) {
        if (!validUid(uid)) return PLACEHOLDER;
        return avatars.get(uid) ?? PLACEHOLDER;
    }

    function serializedDocument(next) {
        return {
            version: STORAGE_VERSION,
            avatars: Object.fromEntries([...next.entries()].map(([uid, avatar]) => [uid, avatar])),
        };
    }

    function commit(next) {
        avatars = next;
        if (!canPersist) return Promise.resolve(false);
        writeQueue = writeQueue.catch(() => false).then(async () => {
            await storage.setItem(CHARACTER_AVATAR_STORAGE_KEY, serializedDocument(next));
            return true;
        });
        return writeQueue;
    }

    async function setAvatar(uid, value) {
        if (!validUid(uid)) throw Object.assign(new TypeError('character_avatar_uid_invalid'), { code: 'CHARACTER_AVATAR_UID_INVALID' });
        const avatar = normalizeAvatarReference(value);
        if (avatar.kind !== 'embedded') throw Object.assign(new TypeError('character_avatar_embedded_required'), { code: 'CHARACTER_AVATAR_EMBEDDED_REQUIRED' });
        const next = new Map(avatars);
        if (!next.has(uid) && next.size >= MAX_AVATAR_COUNT) {
            throw Object.assign(new TypeError('character_avatar_limit_reached'), { code: 'CHARACTER_AVATAR_LIMIT_REACHED' });
        }
        next.set(uid, avatar);
        await commit(next);
        return avatar;
    }

    async function removeAvatar(uid) {
        if (!validUid(uid)) return PLACEHOLDER;
        const next = new Map(avatars);
        next.delete(uid);
        await commit(next);
        return PLACEHOLDER;
    }

    function status() {
        return Object.freeze({ ready: initialized, persistent: canPersist, count: avatars.size });
    }

    return Object.freeze({ ready, snapshot, setAvatar, removeAvatar, status });
}

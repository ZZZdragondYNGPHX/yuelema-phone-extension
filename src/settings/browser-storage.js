/**
 * Browser storage adapter for non-secret settings only.
 *
 * API Keys never cross this boundary: they remain in llm/session-key-store.js.
 * A blocked browser storage implementation falls back to isolated in-memory storage
 * for the current extension lifetime, instead of failing phone UI rendering.
 */
import { createMemoryStorage } from './settings-store.js';

function safeDefaultStorage() {
    try { return globalThis.localStorage; } catch { return null; }
}

export function createBrowserSettingsStorage(storageCandidate = safeDefaultStorage()) {
    const fallback = createMemoryStorage();
    if (!storageCandidate || typeof storageCandidate.getItem !== 'function'
        || typeof storageCandidate.setItem !== 'function' || typeof storageCandidate.removeItem !== 'function') {
        return fallback;
    }

    return Object.freeze({
        getItem(key) {
            try { return storageCandidate.getItem(key); } catch { return fallback.getItem(key); }
        },
        setItem(key, value) {
            try { storageCandidate.setItem(key, value); } catch { fallback.setItem(key, value); }
        },
        removeItem(key) {
            try { storageCandidate.removeItem(key); } catch { fallback.removeItem(key); }
        },
    });
}

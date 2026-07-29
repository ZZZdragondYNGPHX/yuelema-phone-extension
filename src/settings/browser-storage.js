/**
 * Browser storage adapter for non-secret settings only.
 *
 * API Keys never cross this boundary: they remain in llm/session-key-store.js.
 * Settings must remain truthful across an extension reload. If browser storage is
 * unavailable, surface a controlled error instead of accepting a write into a
 * lifetime-only memory fallback and reporting it as saved.
 */
export const BROWSER_SETTINGS_STORAGE_UNAVAILABLE = 'BROWSER_SETTINGS_STORAGE_UNAVAILABLE';

function safeDefaultStorage() {
    try { return globalThis.localStorage; } catch { return null; }
}

function unavailableStorageError() {
    const error = new Error('浏览器本地设置不可用，无法保存。');
    error.code = BROWSER_SETTINGS_STORAGE_UNAVAILABLE;
    return error;
}

export function createBrowserSettingsStorage(storageCandidate = safeDefaultStorage()) {
    if (!storageCandidate || typeof storageCandidate.getItem !== 'function'
        || typeof storageCandidate.setItem !== 'function' || typeof storageCandidate.removeItem !== 'function') {
        return Object.freeze({
            getItem() { throw unavailableStorageError(); },
            setItem() { throw unavailableStorageError(); },
            removeItem() { throw unavailableStorageError(); },
        });
    }

    return Object.freeze({
        getItem(key) {
            try { return storageCandidate.getItem(key); } catch { throw unavailableStorageError(); }
        },
        setItem(key, value) {
            try { storageCandidate.setItem(key, value); } catch { throw unavailableStorageError(); }
        },
        removeItem(key) {
            try { storageCandidate.removeItem(key); } catch { throw unavailableStorageError(); }
        },
    });
}

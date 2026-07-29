import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_SETTINGS_STORAGE_UNAVAILABLE, createBrowserSettingsStorage } from '../browser-storage.js';

test('browser storage adapter uses the supplied storage when available', () => {
    const values = new Map();
    const storage = createBrowserSettingsStorage({
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key),
    });
    storage.setItem('safe', 'value');
    assert.equal(storage.getItem('safe'), 'value');
    storage.removeItem('safe');
    assert.equal(storage.getItem('safe'), null);
});

test('browser storage adapter fails closed when browser storage throws', () => {
    const storage = createBrowserSettingsStorage({
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('blocked'); },
        removeItem() { throw new Error('blocked'); },
    });
    for (const operation of [
        () => storage.getItem('safe'),
        () => storage.setItem('safe', 'value'),
        () => storage.removeItem('safe'),
    ]) {
        assert.throws(operation, (error) => error?.code === BROWSER_SETTINGS_STORAGE_UNAVAILABLE);
    }
});

test('browser storage adapter does not create a volatile fallback when storage is missing', () => {
    const storage = createBrowserSettingsStorage(null);
    assert.throws(() => storage.setItem('safe', 'value'), (error) => error?.code === BROWSER_SETTINGS_STORAGE_UNAVAILABLE);
});

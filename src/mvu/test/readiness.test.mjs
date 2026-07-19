import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveWaitGlobalInitialized, waitForReadableMvu } from '../readiness.js';

function mvu() {
    return { getMvuData() {} };
}

test('uses an already available readable Mvu without waiting', async () => {
    let calls = 0;
    const result = await waitForReadableMvu({
        getMvu: () => mvu(),
        waitGlobalInitialized: () => { calls += 1; },
    });

    assert.equal(result.ok, true);
    assert.equal(result.source, 'already_available');
    assert.equal(calls, 0);
});

test('waits for TavernHelper readiness then validates the published Mvu facade', async () => {
    const host = { TavernHelper: {} };
    host.TavernHelper.waitGlobalInitialized = async (name) => {
        assert.equal(name, 'Mvu');
        host.Mvu = mvu();
    };

    const result = await waitForReadableMvu({ globalRef: host, timeoutMs: 100 });

    assert.equal(result.ok, true);
    assert.equal(result.source, 'wait_global_initialized');
    assert.equal(result.mvu, host.Mvu);
});

test('does not treat a readiness completion without getMvuData as usable', async () => {
    const result = await waitForReadableMvu({
        getMvu: () => ({}),
        waitGlobalInitialized: async () => {},
        timeoutMs: 100,
    });

    assert.deepEqual(result, { ok: false, code: 'mvu_wait_completed_without_read_api' });
});

test('reports missing readiness capability without creating a timer', async () => {
    const result = await waitForReadableMvu({
        getMvu: () => undefined,
        waitGlobalInitialized: null,
    });

    assert.deepEqual(result, { ok: false, code: 'mvu_wait_unavailable' });
});

test('resolves the public TavernHelper readiness method with its receiver', () => {
    const helper = { waitGlobalInitialized() { return this; } };
    const resolved = resolveWaitGlobalInitialized({ TavernHelper: helper });

    assert.equal(resolved(), helper);
});

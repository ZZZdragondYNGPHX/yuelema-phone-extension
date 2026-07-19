/**
 * Host-neutral readiness helpers for MagVarUpdate. They never mutate MVU
 * data: their only responsibility is to wait for the host to publish a
 * readable Mvu facade, then let the caller refresh its read-only projection.
 */

function isReadableMvu(mvu) {
    return !!mvu && typeof mvu.getMvuData === 'function';
}

function normalizeTimeout(value) {
    const timeout = Number(value);
    return Number.isFinite(timeout) && timeout > 0 ? Math.trunc(timeout) : 5000;
}

/**
 * Resolves the documented JS-Slash-Runner readiness helper when it is
 * available either directly or via TavernHelper's public facade.
 */
export function resolveWaitGlobalInitialized(globalRef = globalThis) {
    if (typeof globalRef?.waitGlobalInitialized === 'function') {
        return globalRef.waitGlobalInitialized.bind(globalRef);
    }
    if (typeof globalRef?.TavernHelper?.waitGlobalInitialized === 'function') {
        return globalRef.TavernHelper.waitGlobalInitialized.bind(globalRef.TavernHelper);
    }
    return null;
}

/**
 * Waits at most `timeoutMs` for the named global. A successful wait still
 * validates that Mvu exposes its read API; this prevents a stale or unrelated
 * global from being treated as usable. No rejection is allowed to escape an
 * extension lifecycle hook.
 */
export async function waitForReadableMvu({
    globalRef = globalThis,
    getMvu = () => globalRef?.Mvu,
    waitGlobalInitialized = resolveWaitGlobalInitialized(globalRef),
    timeoutMs = 5000,
    setTimeoutImpl = globalThis.setTimeout?.bind(globalThis),
    clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
    const availableNow = getMvu();
    if (isReadableMvu(availableNow)) return { ok: true, mvu: availableNow, source: 'already_available' };
    if (typeof waitGlobalInitialized !== 'function') return { ok: false, code: 'mvu_wait_unavailable' };
    if (typeof setTimeoutImpl !== 'function') return { ok: false, code: 'mvu_timeout_unavailable' };

    let timeoutHandle;
    const timeout = new Promise((resolve) => {
        timeoutHandle = setTimeoutImpl(() => resolve({ ok: false, code: 'mvu_wait_timeout' }), normalizeTimeout(timeoutMs));
    });
    const ready = Promise.resolve()
        .then(() => waitGlobalInitialized('Mvu'))
        .then(
            () => {
                const mvu = getMvu();
                return isReadableMvu(mvu)
                    ? { ok: true, mvu, source: 'wait_global_initialized' }
                    : { ok: false, code: 'mvu_wait_completed_without_read_api' };
            },
            () => ({ ok: false, code: 'mvu_wait_failed' }),
        );

    const result = await Promise.race([ready, timeout]);
    if (timeoutHandle !== undefined && typeof clearTimeoutImpl === 'function') clearTimeoutImpl(timeoutHandle);
    return result;
}

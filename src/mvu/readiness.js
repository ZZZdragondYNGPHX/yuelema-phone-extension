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

function normalizePollInterval(value) {
    const interval = Number(value);
    return Number.isFinite(interval) && interval > 0 ? Math.trunc(interval) : 100;
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
    pollIntervalMs = 100,
    retryReadiness = false,
    setTimeoutImpl = globalThis.setTimeout?.bind(globalThis),
    clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
    const availableNow = getMvu();
    if (isReadableMvu(availableNow)) return { ok: true, mvu: availableNow, source: 'already_available' };
    if (typeof setTimeoutImpl !== 'function') return { ok: false, code: 'mvu_timeout_unavailable' };
    if (typeof waitGlobalInitialized !== 'function' && !retryReadiness) {
        return { ok: false, code: 'mvu_wait_unavailable' };
    }

    const timeout = normalizeTimeout(timeoutMs);
    const pollInterval = normalizePollInterval(pollIntervalMs);
    const deadline = Date.now() + timeout;

    return new Promise((resolve) => {
        let timerHandle;
        let settled = false;
        let readinessCallStarted = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            if (timerHandle !== undefined && typeof clearTimeoutImpl === 'function') clearTimeoutImpl(timerHandle);
            resolve(result);
        };
        const schedule = (callback) => {
            timerHandle = setTimeoutImpl(callback, Math.min(pollInterval, Math.max(1, deadline - Date.now())));
        };
        const attempt = () => {
            if (settled) return;
            const currentMvu = getMvu();
            if (isReadableMvu(currentMvu)) {
                finish({ ok: true, mvu: currentMvu, source: 'already_available' });
                return;
            }
            if (Date.now() >= deadline) {
                finish({ ok: false, code: 'mvu_wait_timeout' });
                return;
            }

            const wait = typeof waitGlobalInitialized === 'function'
                ? waitGlobalInitialized
                : resolveWaitGlobalInitialized(globalRef);
            if (typeof wait !== 'function') {
                if (!retryReadiness) {
                    finish({ ok: false, code: 'mvu_wait_unavailable' });
                    return;
                }
                schedule(attempt);
                return;
            }
            if (readinessCallStarted) {
                schedule(attempt);
                return;
            }
            readinessCallStarted = true;
            Promise.resolve()
                .then(() => wait('Mvu'))
                .then(
                    () => {
                        const mvu = getMvu();
                        finish(isReadableMvu(mvu)
                            ? { ok: true, mvu, source: 'wait_global_initialized' }
                            : { ok: false, code: 'mvu_wait_completed_without_read_api' });
                    },
                    () => finish({ ok: false, code: 'mvu_wait_failed' }),
                );
        };
        attempt();
    });
}

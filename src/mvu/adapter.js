import { LATEST_MESSAGE_SCOPE, buildUpdateVariable, validateControlledPatchAgainstState } from './controlled-patch.js';
import { isPlainRecord } from './json-pointer.js';

function unavailable(code) {
    return { ok: false, status: 'unavailable', code };
}

function failed(code, error) {
    return { ok: false, status: 'failed', code, error: error instanceof Error ? error.message : undefined };
}

function validMvuApi(mvu) {
    return mvu && typeof mvu.getMvuData === 'function'
        && typeof mvu.parseMessage === 'function'
        && typeof mvu.replaceMvuData === 'function';
}

function cloneReadOnly(value) {
    if (typeof structuredClone !== 'function') return value;
    return structuredClone(value);
}

function resolveEventEmitter({ eventEmit, getContext }) {
    if (typeof eventEmit === 'function') return eventEmit;
    if (typeof getContext === 'function') {
        try {
            const context = getContext();
            if (typeof context?.eventSource?.emit === 'function') {
                return context.eventSource.emit.bind(context.eventSource);
            }
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Reads only the latest message-scope MVU envelope. The returned snapshot is a
 * clone when the platform supports structuredClone, so callers cannot mutate a
 * live stat_data reference by accident.
 */
export function readLatestState({ mvu = globalThis.Mvu, scope = LATEST_MESSAGE_SCOPE } = {}) {
    if (!mvu || typeof mvu.getMvuData !== 'function') return unavailable('mvu_get_unavailable');
    try {
        const data = mvu.getMvuData(scope);
        if (!isPlainRecord(data) || !isPlainRecord(data.stat_data)) return unavailable('mvu_stat_data_unavailable');
        const snapshot = cloneReadOnly(data);
        return { ok: true, status: 'ok', scope: { ...scope }, data: snapshot, state: snapshot.stat_data };
    } catch (error) {
        return failed('mvu_read_failed', error);
    }
}

/**
 * The only write-capable seam. It refuses all paths except the narrow patch
 * whitelist, then invokes the documented MVU parse -> replace -> event sequence.
 * It never assigns to stat_data, chat metadata, or replaceVariables directly.
 */
export async function applyControlledPatch({
    patch,
    mvu = globalThis.Mvu,
    scope = LATEST_MESSAGE_SCOPE,
    eventEmit = globalThis.eventEmit,
    getContext = globalThis.SillyTavern?.getContext?.bind(globalThis.SillyTavern),
} = {}) {
    if (!validMvuApi(mvu)) return unavailable('mvu_official_pipeline_unavailable');
    const emit = resolveEventEmitter({ eventEmit, getContext });
    if (!emit || typeof mvu.events?.VARIABLE_UPDATE_ENDED !== 'string') {
        return unavailable('mvu_variable_event_unavailable');
    }

    let oldData;
    try {
        oldData = mvu.getMvuData(scope);
    } catch (error) {
        return failed('mvu_read_failed', error);
    }
    if (!isPlainRecord(oldData) || !isPlainRecord(oldData.stat_data)) return unavailable('mvu_stat_data_unavailable');

    const stateValidation = validateControlledPatchAgainstState(oldData.stat_data, patch);
    if (!stateValidation.ok) return { ok: false, status: 'rejected', code: stateValidation.code, detail: stateValidation.detail };

    const wrapped = buildUpdateVariable(patch);
    if (!wrapped.ok) return { ok: false, status: 'rejected', code: wrapped.code, detail: wrapped.detail };

    let newData;
    try {
        newData = await mvu.parseMessage(wrapped.value, oldData);
    } catch (error) {
        return failed('mvu_parse_failed', error);
    }
    if (!isPlainRecord(newData)) return { ok: false, status: 'no_change', code: 'mvu_parse_returned_no_data' };

    try {
        await mvu.replaceMvuData(newData, scope);
    } catch (error) {
        return failed('mvu_replace_failed', error);
    }

    try {
        await emit(mvu.events.VARIABLE_UPDATE_ENDED, newData, oldData);
    } catch (error) {
        // replaceMvuData already succeeded; report a degraded completion rather than
        // retrying a write or falsely claiming that no state changed.
        return { ok: true, status: 'persisted_event_failed', code: 'mvu_event_emit_failed', error: error instanceof Error ? error.message : undefined };
    }
    return { ok: true, status: 'applied', scope: { ...scope }, data: newData };
}

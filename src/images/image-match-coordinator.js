import { createConnectionPreset } from '../llm/openai-compatible-client.js';
import { createImageMatchCacheKey } from './image-match.js';
import { matchImageForPublicProfile as runImageMatch } from './image-match-service.js';

const IMAGE_MATCH_FUNCTION_KEY = 'image_match';
const CONNECTION_FIELDS = Object.freeze([
    'id',
    'name',
    'url',
    'baseUrl',
    'model',
    'temperature',
    'maxTokens',
    'timeoutMs',
    'transportMode',
]);
const CONNECTION_FIELD_SET = new Set(CONNECTION_FIELDS);

function isPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function own(value, key) {
    return isPlainRecord(value) && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function freezeFallback(code = null, cacheKey = null) {
    return Object.freeze({
        ok: true,
        match: null,
        source: 'fallback',
        cacheKey,
        llm: Object.freeze({
            attempted: false,
            applied: false,
            code,
            keywordWeights: null,
        }),
    });
}

/**
 * Rebuild a connection preset from the allow-listed non-secret fields. This
 * intentionally rejects any secret-bearing object instead of forwarding it.
 */
function normalizeConnectionPreset(input) {
    if (!isPlainRecord(input)) return null;
    if (Object.keys(input).some((field) => !CONNECTION_FIELD_SET.has(field))) return null;
    const candidate = {};
    for (const field of CONNECTION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(input, field)) candidate[field] = input[field];
    }
    try {
        const preset = createConnectionPreset(candidate);
        return Object.freeze(preset);
    } catch {
        return null;
    }
}

function connectionCacheFingerprint(preset) {
    if (!preset) return 'connection:none';
    return `connection:v1:${JSON.stringify([
        preset.id,
        preset.name,
        preset.url,
        preset.model,
        preset.temperature,
        preset.maxTokens,
        preset.timeoutMs,
        preset.transportMode,
    ])}`;
}

function resolveImageMatchBinding(settingsStore, contentMode) {
    if (!settingsStore || typeof settingsStore.resolveFunction !== 'function') return null;
    try {
        const options = contentMode === undefined ? {} : { contentMode };
        const resolved = settingsStore.resolveFunction(IMAGE_MATCH_FUNCTION_KEY, options);
        return normalizeConnectionPreset(resolved?.connectionPreset);
    } catch {
        return null;
    }
}

function cacheEntryMatches(entry, bindingFingerprint) {
    return Boolean(entry && entry.bindingFingerprint === bindingFingerprint && entry.result);
}

/**
 * Browser-memory-only image matching coordinator.
 *
 * It reads the image library, resolves only the `image_match` connection
 * binding, and delegates all prompt construction/network transport to the
 * injected image-match service and llm client. It never writes MVU, settings,
 * exports, or persistent cache data.
 *
 * `getCached` and `resolveImage` are asynchronous because the image library is
 * an injected async store. `resolveImage` returns the selected image record or
 * null, while `match` returns the service result.
 */
export function createImageMatchCoordinator({ imageLibrary, settingsStore = null, llmClient = null } = {}) {
    const cache = new Map();
    const inFlight = new Map();
    let cacheGeneration = 0;

    async function readImageRecords() {
        if (!imageLibrary || typeof imageLibrary.list !== 'function') return null;
        try {
            const records = await imageLibrary.list();
            return Array.isArray(records) ? records : null;
        } catch {
            return null;
        }
    }

    async function match(publicProfile, { signal, contentMode } = {}) {
        const imageRecords = await readImageRecords();
        if (!imageRecords) return freezeFallback('image_match_library_unavailable');

        let cacheKey;
        try {
            cacheKey = createImageMatchCacheKey(publicProfile, imageRecords);
        } catch {
            return freezeFallback('image_match_input_invalid');
        }

        const connectionPreset = resolveImageMatchBinding(settingsStore, contentMode);
        const bindingFingerprint = connectionCacheFingerprint(connectionPreset);
        const cached = cache.get(cacheKey);
        if (cacheEntryMatches(cached, bindingFingerprint)) return cached.result;

        const requestKey = cacheKey + "\u0000" + bindingFingerprint;
        const pending = inFlight.get(requestKey);
        if (pending) return pending;
        const generation = cacheGeneration;
        const request = (async () => {
            let result;
            try {
                result = await runImageMatch({
                    candidatePublicProfile: publicProfile,
                    imageRecords,
                    llmClient,
                    connectionPreset,
                    signal,
                });
            } catch {
                // The service is already defensive; this is the coordinator's final
                // boundary so a provider/library integration failure never escapes.
                result = freezeFallback('image_match_failed', cacheKey);
            }

            const safeResult = result && typeof result === 'object'
                ? Object.freeze(result)
                : freezeFallback('image_match_failed', cacheKey);
            if (generation === cacheGeneration) {
                cache.set(cacheKey, Object.freeze({
                    bindingFingerprint,
                    result: safeResult,
                }));
            }
            return safeResult;
        })().finally(() => { if (inFlight.get(requestKey) === request) inFlight.delete(requestKey); });
        inFlight.set(requestKey, request);
        return request;
    }

    async function getCached(publicProfile, { contentMode } = {}) {
        const imageRecords = await readImageRecords();
        if (!imageRecords) return null;
        let cacheKey;
        try {
            cacheKey = createImageMatchCacheKey(publicProfile, imageRecords);
        } catch {
            return null;
        }
        const connectionPreset = resolveImageMatchBinding(settingsStore, contentMode);
        const entry = cache.get(cacheKey);
        return cacheEntryMatches(entry, connectionCacheFingerprint(connectionPreset)) ? entry.result : null;
    }

    async function resolveImage(publicProfile, options = {}) {
        const result = await match(publicProfile, options);
        const imageId = result?.match?.imageId;
        if (typeof imageId !== 'string') return null;
        const imageRecords = await readImageRecords();
        if (!imageRecords) return null;
        return imageRecords.find((record) => own(record, 'id') === imageId) ?? null;
    }

    function clearCache() {
        cacheGeneration += 1;
        cache.clear();
        inFlight.clear();
    }

    return Object.freeze({ match, getCached, resolveImage, clearCache });
}



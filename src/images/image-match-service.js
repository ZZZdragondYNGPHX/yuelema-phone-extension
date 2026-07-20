import {
    buildImageMatchPrompt,
    collectImageMatchKeywords,
    createImageMatchCacheKey,
    parseImageMatchLlmResponse,
    projectImageMatchPublicProfile,
    normalizeImageLibrary,
    selectBestImageMatch,
    selectBestImageMatchFromKeywordWeights,
} from './image-match.js';

const SECRET_KEY_PATTERN = /^(?:api[_ -]?key|key|token|access[_ -]?token|authorization|password|secret)$/iu;
const DEFAULT_MAX_TOKENS = 512;

function containsSecretField(value, seen = new Set()) {
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    for (const key of Object.keys(value)) {
        if (SECRET_KEY_PATTERN.test(key)) return true;
        if (containsSecretField(value[key], seen)) return true;
    }
    return false;
}

function safeBase(candidatePublicProfile, imageRecords) {
    const profile = projectImageMatchPublicProfile(candidatePublicProfile);
    const images = normalizeImageLibrary(imageRecords);
    return Object.freeze({
        profile,
        images,
        allowedKeywords: collectImageMatchKeywords(images),
        cacheKey: createImageMatchCacheKey(profile, images),
        localMatch: selectBestImageMatch(profile, images),
    });
}

function freezeServiceResult(result) {
    return Object.freeze({
        ok: result.ok,
        match: result.match ?? null,
        source: result.source,
        cacheKey: result.cacheKey,
        llm: Object.freeze({
            attempted: Boolean(result.llm?.attempted),
            applied: Boolean(result.llm?.applied),
            code: result.llm?.code ?? null,
            keywordWeights: result.llm?.keywordWeights ?? null,
        }),
    });
}

/**
 * Calls only an injected llmClient.chat implementation. This module never owns
 * a fetch implementation, endpoint, API key, storage adapter, or MVU writer.
 */
export async function requestImageMatchKeywordWeights({
    candidatePublicProfile,
    imageRecords,
    llmClient,
    connectionPreset,
    signal,
    maxTokens = DEFAULT_MAX_TOKENS,
} = {}) {
    let base;
    try {
        base = safeBase(candidatePublicProfile, imageRecords);
    } catch {
        return Object.freeze({ ok: false, code: 'image_match_input_invalid', keywordWeights: null });
    }
    if (!llmClient || typeof llmClient.chat !== 'function') {
        return Object.freeze({ ok: false, code: 'image_match_llm_unavailable', keywordWeights: null });
    }
    if (!connectionPreset || typeof connectionPreset !== 'object' || Array.isArray(connectionPreset) || containsSecretField(connectionPreset)) {
        return Object.freeze({ ok: false, code: 'image_match_connection_invalid', keywordWeights: null });
    }
    if (base.allowedKeywords.length < 1) {
        return Object.freeze({ ok: false, code: 'image_match_keywords_empty', keywordWeights: null });
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) {
        return Object.freeze({ ok: false, code: 'image_match_request_invalid', keywordWeights: null });
    }

    try {
        const prompt = buildImageMatchPrompt(base.profile, base.allowedKeywords);
        const completion = await llmClient.chat({
            preset: connectionPreset,
            messages: prompt.messages,
            maxTokens,
            signal,
        });
        const keywordWeights = parseImageMatchLlmResponse(completion?.text, base.allowedKeywords);
        return Object.freeze({ ok: true, code: null, keywordWeights });
    } catch {
        return Object.freeze({ ok: false, code: 'image_match_llm_failed', keywordWeights: null });
    }
}

/**
 * Local deterministic matching is authoritative fallback. A valid LLM vector
 * may improve semantic matching, but any missing connection, thrown request,
 * invalid JSON, unregistered keyword, or non-positive LLM result keeps the
 * local result without exposing provider errors or raw model output.
 */
export async function matchImageForPublicProfile({
    candidatePublicProfile,
    imageRecords,
    llmClient = null,
    connectionPreset = null,
    signal,
    maxTokens = DEFAULT_MAX_TOKENS,
} = {}) {
    let base;
    try {
        base = safeBase(candidatePublicProfile, imageRecords);
    } catch {
        return freezeServiceResult({
            ok: false,
            match: null,
            source: 'fallback',
            cacheKey: null,
            llm: { attempted: false, applied: false, code: 'image_match_input_invalid' },
        });
    }

    const canAttemptLlm = Boolean(llmClient && typeof llmClient.chat === 'function' && connectionPreset);
    if (!canAttemptLlm) {
        return freezeServiceResult({
            ok: true,
            match: base.localMatch,
            source: base.localMatch ? 'local' : 'fallback',
            cacheKey: base.cacheKey,
            llm: { attempted: false, applied: false, code: null },
        });
    }

    const llmResult = await requestImageMatchKeywordWeights({
        candidatePublicProfile: base.profile,
        imageRecords: base.images,
        llmClient,
        connectionPreset,
        signal,
        maxTokens,
    });
    if (!llmResult.ok) {
        return freezeServiceResult({
            ok: true,
            match: base.localMatch,
            source: base.localMatch ? 'local' : 'fallback',
            cacheKey: base.cacheKey,
            llm: { attempted: true, applied: false, code: llmResult.code },
        });
    }

    let llmMatch = null;
    try {
        llmMatch = selectBestImageMatchFromKeywordWeights(base.images, llmResult.keywordWeights);
    } catch {
        llmMatch = null;
    }
    return freezeServiceResult({
        ok: true,
        match: llmMatch ?? base.localMatch,
        source: llmMatch ? 'llm' : (base.localMatch ? 'local' : 'fallback'),
        cacheKey: base.cacheKey,
        llm: {
            attempted: true,
            applied: Boolean(llmMatch),
            code: llmMatch ? null : 'image_match_llm_no_positive_match',
            keywordWeights: llmResult.keywordWeights,
        },
    });
}

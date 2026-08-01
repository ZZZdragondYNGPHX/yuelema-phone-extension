import { NSFW_SAFETY_ASSESSMENT_KINDS } from './private-chat-response.js';
import { isActiveNsfwConsent } from '../mvu/nsfw-consent.js';
import { bodyRelationshipCandidateRouteContract } from '../mvu/body-relationship-candidate.js';

export const CONTENT_MODES = Object.freeze(['SFW', 'NSFW']);
export const SFW_MEETUP_ROUTE_THRESHOLD = 50;
export const MEETUP_ROUTE_THRESHOLD = SFW_MEETUP_ROUTE_THRESHOLD;
export const SFW_UNDERSTANDING_THRESHOLD = 60;
// Body-event confirmation is a semantic review only.  It never carries a
// score, route, UID, JSON Pointer, or event ID from the model.
export const BODY_EVENT_REVIEW_STATES = Object.freeze(['defer', 'confirm', 'decline']);

const MODE_KINDS = Object.freeze({
    SFW: Object.freeze(['none', 'friendly', 'romantic_flirt']),
    NSFW: Object.freeze(['none', 'friendly', 'romantic_flirt', 'romantic_desire', 'sexual_desire']),
});
const NSFW_SAFETY_ASSESSMENTS = new Set(NSFW_SAFETY_ASSESSMENT_KINDS);
const SFW_PROGRESS_THRESHOLDS = Object.freeze([
    Object.freeze({ threshold: 20, field: 'SFW细微裂缝已触发' }),
    Object.freeze({ threshold: 40, field: 'SFW朋友分享已触发' }),
    Object.freeze({ threshold: SFW_MEETUP_ROUTE_THRESHOLD, field: 'SFW面基已解锁' }),
]);
const NSFW_PROGRESS_FIELDS = Object.freeze({
    心动值: Object.freeze([
        Object.freeze({ threshold: 30, field: 'NSFW爱情阶段30已触发' }),
        Object.freeze({ threshold: 40, field: 'NSFW爱情阶段40已触发' }),
    ]),
    欲望值: Object.freeze([
        Object.freeze({ threshold: 30, field: 'NSFW共识亲密阶段30已触发' }),
        Object.freeze({ threshold: 40, field: 'NSFW共识亲密阶段40已触发' }),
    ]),
});
const NSFW_DIRECTION_THRESHOLD = 50;
const PLAYER_TURN_ID_PATTERN = /^msg_chat_([A-Za-z0-9][A-Za-z0-9_-]{0,63})_p_([1-9]\d*)$/u;

function integerScore(value) {
    return Number.isInteger(value) && value >= 0 && value <= 100 ? value : 0;
}

function isProgressRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isKnownAssessment(mode, kind, intensity, direction) {
    return MODE_KINDS[mode].includes(kind)
        && Number.isInteger(intensity) && intensity >= 0 && intensity <= 3
        && ((kind === 'none' && intensity === 0 && direction === 'none')
            || (kind !== 'none' && intensity >= 1 && ['increase', 'decrease'].includes(direction)));
}

function emptySettlement(kind = 'none', direction = 'none') {
    return Object.freeze({
        field: '', delta: 0, nextValue: 0, kind, direction,
        eventId: '', progressUpdates: Object.freeze({}), safetyPause: false,
    });
}

function fieldForAssessment(mode, kind, direction) {
    // Phase B.1 deliberately keeps every SFW private-chat interaction on the
    // friendship route. The 60-point insight decision is still unconfirmed;
    // no normal chat can auto-write heart progress before that decision.
    if (mode === 'SFW') return ['friendly', 'romantic_flirt'].includes(kind) ? '友情值' : '';

    // C.1 uses this mapping only for an explicit, separately classified safety
    // conflict. Positive NSFW progress remains closed until C.2.
    if (kind === 'romantic_desire') return '心动值';
    if (kind === 'sexual_desire') return '欲望值';
    if (direction === 'decrease' && kind === 'friendly') return '友情值';
    if (direction === 'decrease' && kind === 'romantic_flirt') return '心动值';
    return '';
}

export function deriveRelationshipSafetyState(progress) {
    const safeProgress = isProgressRecord(progress) ? progress : {};
    const boundary = typeof safeProgress.边界暂停状态 === 'string' ? safeProgress.边界暂停状态 : '';
    return Object.freeze({
        onlySfw: boundary === '仅SFW',
        paused: Boolean(boundary && boundary !== '仅SFW'),
        ended: Boolean(safeProgress.关系结束状态),
    });
}

function progressBlocksField(progress, field) {
    const safety = deriveRelationshipSafetyState(progress);
    return safety.paused || safety.ended || progress?.冻结关系值 === field;
}

function progressUpdatesForSfw({ progress, currentValue, nextValue, turnId, eventId }) {
    const consumed = Array.isArray(progress.已消费事件ID) ? progress.已消费事件ID : [];
    const updates = {
        最后结算回合UID: turnId,
        已消费事件ID: Object.freeze([...consumed, eventId].slice(-64)),
    };
    for (const { threshold, field } of SFW_PROGRESS_THRESHOLDS) {
        if (currentValue < threshold && nextValue >= threshold && progress[field] !== true) updates[field] = true;
    }
    return Object.freeze(updates);
}

function progressUpdatesForNsfw({ progress, field, currentValue, nextValue, turnId, eventId }) {
    const consumed = Array.isArray(progress.已消费事件ID) ? progress.已消费事件ID : [];
    const updates = {
        最后结算回合UID: turnId,
        已消费事件ID: Object.freeze([...consumed, eventId].slice(-64)),
    };
    if (nextValue > currentValue) {
        for (const milestone of NSFW_PROGRESS_FIELDS[field] ?? []) {
            if (currentValue < milestone.threshold && nextValue >= milestone.threshold && progress[milestone.field] !== true) {
                updates[milestone.field] = true;
            }
        }
        if (currentValue < NSFW_DIRECTION_THRESHOLD && nextValue >= NSFW_DIRECTION_THRESHOLD && progress.NSFW方向确认可用 !== true) {
            updates.NSFW方向确认可用 = true;
        }
    }
    return Object.freeze(updates);
}

function progressUpdatesForBodyEvent({ contentMode, progress, field, currentValue, nextValue, turnId, eventId, establishRoute = false }) {
    if (normalizeContentMode(contentMode) === 'SFW') {
        return progressUpdatesForSfw({ progress, currentValue, nextValue, turnId, eventId });
    }
    const updates = { ...progressUpdatesForNsfw({ progress, field, currentValue, nextValue, turnId, eventId }) };
    if (establishRoute && !progress.冻结关系值) {
        updates.冻结关系值 = field === '心动值' ? '欲望值' : '心动值';
    }
    return Object.freeze(updates);
}

function emptyBodyCandidateSettlement(status = 'none') {
    return Object.freeze({
        handled: false,
        consume: false,
        status,
        field: '',
        delta: 0,
        nextValue: 0,
        eventId: '',
        progressUpdates: Object.freeze({}),
    });
}

function bodyCandidateDelta(candidate, currentValue) {
    if (candidate?.建议方向 === '正向') {
        const requested = candidate.事件类别 === '尊重拒绝' ? 1 : 2;
        return Math.min(100 - currentValue, requested);
    }
    if (candidate?.建议方向 === '负向') {
        const requested = candidate.严重度 === '常规' ? 2
            : candidate.严重度 === '明显' ? 3
                : candidate.严重度 === '严重' ? 4 : 0;
        return requested ? -Math.min(currentValue, requested) : 0;
    }
    return 0;
}

export function normalizeContentMode(value) {
    return value === 'NSFW' ? 'NSFW' : 'SFW';
}

export function allowedAssessmentKinds(contentMode) {
    return MODE_KINDS[normalizeContentMode(contentMode)];
}

/**
 * Converts the local player-message UID into a bounded, per-session event ID.
 * The model and UI never provide this value. Its shorter form fits the schema's
 * opaque-ID limit without storing player text or protected narrative fields.
 */
export function relationshipEventIdForTurn(turnId) {
    const match = typeof turnId === 'string' ? PLAYER_TURN_ID_PATTERN.exec(turnId) : null;
    return match ? `chat:${match[1]}:${match[2]}` : '';
}

/** Ordinary online positive interaction is always +1 in B.1. +2 is reserved
 * for a later locally verified high-weight candidate, never model intensity. */
export function calculateBondGrowth(currentValue, intensity, { highWeight = false } = {}) {
    const current = integerScore(currentValue);
    if (!Number.isInteger(intensity) || intensity < 1 || intensity > 3 || current >= 100) return 0;
    const requested = highWeight === true ? 2 : 1;
    return Math.min(100 - current, requested);
}

/** Model severity is a category only; local rules map it to -2/-3/-4. */
export function calculateBondDecline(currentValue, intensity) {
    const current = integerScore(currentValue);
    if (!Number.isInteger(intensity) || intensity < 1 || intensity > 3 || current <= 0) return 0;
    return -Math.min(current, intensity + 1);
}

/**
 * The deterministic B.1 settlement engine. It accepts only a validated
 * semantic assessment and state supplied by the controlled builder; no model
 * value can choose a score, a JSON Pointer, a UID, or an arbitrary patch.
 */
export function settleRelationshipProgress({ contentMode, relationship, progress, assessment, nsfwSafetyAssessment = 'none', nsfwConsentAssessment = 'none', replied = true, turnId = '' } = {}) {
    const sourceMode = normalizeContentMode(contentMode);
    const current = relationship && typeof relationship === 'object' ? relationship : {};
    const safeProgress = isProgressRecord(progress) ? progress : {};
    const safetyState = deriveRelationshipSafetyState(safeProgress);
    const mode = sourceMode === 'NSFW' && safetyState.onlySfw ? 'SFW' : sourceMode;
    const kind = assessment?.kind;
    const intensity = assessment?.intensity;
    const direction = assessment?.direction ?? (kind === 'none' ? 'none' : 'increase');
    if (!replied || safetyState.paused || safetyState.ended) {
        return emptySettlement(kind ?? 'none', direction);
    }

    const safetyPause = sourceMode === 'NSFW'
        && !safetyState.onlySfw
        && NSFW_SAFETY_ASSESSMENTS.has(nsfwSafetyAssessment)
        && nsfwSafetyAssessment !== 'none';
    if (safetyPause) {
        const eventId = relationshipEventIdForTurn(turnId);
        const alreadyConsumed = eventId && Array.isArray(safeProgress.已消费事件ID) && safeProgress.已消费事件ID.includes(eventId);
        const canDecline = isKnownAssessment('NSFW', kind, intensity, direction)
            && kind !== 'none' && direction === 'decrease'
            && !(eventId && (safeProgress.最后结算回合UID === turnId || alreadyConsumed));
        const field = canDecline ? fieldForAssessment('NSFW', kind, direction) : '';
        const currentValue = field ? integerScore(current[field]) : 0;
        const delta = field && !progressBlocksField(safeProgress, field)
            ? calculateBondDecline(currentValue, intensity) : 0;
        const nextValue = currentValue + delta;
        const progressUpdates = delta !== 0 && eventId
            ? progressUpdatesForNsfw({ progress: safeProgress, field, currentValue, nextValue, turnId, eventId })
            : Object.freeze({});
        return Object.freeze({
            field, delta, nextValue, kind: kind ?? 'none', direction,
            eventId: delta !== 0 ? eventId : '', progressUpdates, safetyPause: true,
        });
    }

    if (!isKnownAssessment(mode, kind, intensity, direction) || kind === 'none') {
        return emptySettlement(kind ?? 'none', direction);
    }
    // C.2/C.3 only permit ordinary NSFW relationship movement when the
    // separately validated consent envelope, the transient current-turn
    // confirmation, and the model's narrowed in-scope classification agree.
    // “仅 SFW” keeps using the existing SFW friendship path.
    if (sourceMode === 'NSFW' && mode === 'NSFW' && nsfwConsentAssessment !== 'in_scope') {
        return emptySettlement(kind, direction);
    }
    // After the first reviewed meetup establishes one NSFW route, ordinary
    // phone chat no longer farms either rail. Subsequent progress comes only
    // from a separately verified body-event candidate; safety hard gates still
    // retain their dedicated decline/pause path above.
    if (sourceMode === 'NSFW' && mode === 'NSFW' && safeProgress.冻结关系值) {
        return emptySettlement(kind, direction);
    }

    const field = fieldForAssessment(mode, kind, direction);
    if (!field || progressBlocksField(safeProgress, field)) return emptySettlement(kind, direction);

    const eventId = relationshipEventIdForTurn(turnId);
    const alreadyConsumed = eventId && Array.isArray(safeProgress.已消费事件ID) && safeProgress.已消费事件ID.includes(eventId);
    if (eventId && (safeProgress.最后结算回合UID === turnId || alreadyConsumed)) return emptySettlement(kind, direction);

    const currentValue = integerScore(current[field]);
    const delta = direction === 'decrease'
        ? calculateBondDecline(currentValue, intensity)
        : calculateBondGrowth(currentValue, intensity);
    if (delta === 0) return emptySettlement(kind, direction);

    const nextValue = currentValue + delta;
    const progressUpdates = eventId
        ? (mode === 'SFW'
            ? progressUpdatesForSfw({ progress: safeProgress, currentValue, nextValue, turnId, eventId })
            : progressUpdatesForNsfw({ progress: safeProgress, field, currentValue, nextValue, turnId, eventId }))
        : Object.freeze({});
    return Object.freeze({ field, delta, nextValue, kind, direction, eventId, progressUpdates, safetyPause: false });
}

/**
 * Settles one already-validated, explicit body-event candidate.  The caller
 * owns candidate/source validation; this pure step only maps its constrained
 * semantics to the global step sizes and the existing per-role event lock.
 *
 * B.2 intentionally supports SFW friendship only.  Other routes remain
 * deferred for their dedicated state-machine phases instead of being guessed
 * from an otherwise valid-looking body record.
 */
export function settleBodyRelationshipCandidate({
    contentMode,
    relationship,
    progress,
    candidate,
    review = 'defer',
    turnId = '',
    replied = true,
} = {}) {
    if (!candidate || typeof candidate !== 'object') return emptyBodyCandidateSettlement();
    if (!replied) return emptyBodyCandidateSettlement('no_reply');
    const safeProgress = isProgressRecord(progress) ? progress : {};
    const eventId = typeof candidate.事件ID === 'string' ? candidate.事件ID : '';
    const routeContract = bodyRelationshipCandidateRouteContract(candidate?.关系路线);
    const field = routeContract
        && Array.isArray(candidate?.允许影响关系值)
        && candidate.允许影响关系值.length === 1
        && candidate.允许影响关系值[0] === routeContract.relationshipField
        ? routeContract.relationshipField : '';
    if (!eventId || !field) return emptyBodyCandidateSettlement('invalid');

    const consumed = Array.isArray(safeProgress.已消费事件ID) ? safeProgress.已消费事件ID : [];
    if (consumed.includes(eventId)) {
        return Object.freeze({
            ...emptyBodyCandidateSettlement('already_consumed'),
            consume: true,
            eventId,
        });
    }
    const mode = normalizeContentMode(contentMode);
    const routeAllowed = routeContract?.directionLock
        ? mode === 'NSFW' && safeProgress.NSFW方向确认可用 === true && safeProgress.NSFW路线锁定 === routeContract.directionLock
        : mode === 'SFW';
    if (!routeAllowed || progressBlocksField(safeProgress, field)) {
        return emptyBodyCandidateSettlement('deferred');
    }
    if (safeProgress.最后结算回合UID === turnId) return emptyBodyCandidateSettlement('turn_locked');

    const normalizedReview = BODY_EVENT_REVIEW_STATES.includes(review) ? review : 'defer';
    if (candidate.需再次确认 === true && normalizedReview === 'defer') {
        return emptyBodyCandidateSettlement('awaiting_confirmation');
    }

    const current = relationship && typeof relationship === 'object' ? relationship : {};
    const currentValue = integerScore(current[field]);
    // An explicit retraction always wins, even for a candidate that would not
    // otherwise need another confirmation. `需再次确认` only decides whether
    // silence/defer may settle; it never turns a clear decline into consent.
    const declined = normalizedReview === 'decline';
    const delta = declined ? 0 : bodyCandidateDelta(candidate, currentValue);
    const nextValue = currentValue + delta;
    return Object.freeze({
        handled: true,
        consume: true,
        status: declined ? 'declined' : candidate.建议方向 === '无变化' ? 'no_change' : 'settled',
        field,
        delta,
        nextValue,
        eventId,
        progressUpdates: progressUpdatesForBodyEvent({
            contentMode: mode,
            progress: safeProgress,
            field,
            currentValue,
            nextValue,
            turnId,
            eventId,
            establishRoute: mode === 'NSFW' && !declined && candidate.建议方向 === '正向',
        }),
    });
}

/** Backwards-compatible name for callers that only need the projected change. */
export function projectBondProgress(options = {}) {
    return settleRelationshipProgress(options);
}

/** Returns a DOM-safe derived meetup gate without exposing scores or thresholds. */
export function deriveMeetupAccess({ contentMode, relationship, progress, nsfwConsent } = {}) {
    const mode = normalizeContentMode(contentMode);
    const current = relationship && typeof relationship === 'object' ? relationship : {};
    const safety = deriveRelationshipSafetyState(progress);
    if (safety.ended) return Object.freeze({ unlocked: false, route: '', routes: Object.freeze([]), reason: 'relationship_ended' });
    if (safety.paused) return Object.freeze({ unlocked: false, route: '', routes: Object.freeze([]), reason: 'relationship_paused' });
    if (mode === 'NSFW') {
        if (safety.onlySfw) return Object.freeze({ unlocked: false, route: '', routes: Object.freeze([]), reason: 'only_sfw' });
        if (!isActiveNsfwConsent(nsfwConsent)) return Object.freeze({ unlocked: false, route: '', routes: Object.freeze([]), reason: 'nsfw_consent_required' });
        const locked = progress?.NSFW路线锁定;
        const route = locked === '爱情' ? '恋爱' : locked === '共识亲密' ? '欲望' : '';
        if (!route || progress?.NSFW方向确认可用 !== true) {
            return Object.freeze({ unlocked: false, route: '', routes: Object.freeze([]), reason: 'nsfw_direction_unconfirmed' });
        }
        const eligible = route === '恋爱'
            ? integerScore(current.心动值) >= NSFW_DIRECTION_THRESHOLD
            : integerScore(current.欲望值) >= NSFW_DIRECTION_THRESHOLD;
        return Object.freeze({
            unlocked: eligible,
            route: eligible ? route : '',
            routes: Object.freeze(eligible ? [route] : []),
            reason: eligible ? 'eligible' : 'threshold_not_met',
        });
    }
    const routes = integerScore(current.友情值) >= SFW_MEETUP_ROUTE_THRESHOLD ? ['友情'] : [];
    return Object.freeze({
        unlocked: routes.length > 0,
        route: routes[0] ?? '',
        routes: Object.freeze(routes),
        reason: routes.length ? 'eligible' : 'threshold_not_met',
    });
}

export function meetupRouteGuidance(route) {
    if (route === '友情') return '本次按友情路线推进：重点表现信任、陪伴、默契和现实相处；不要仅因见面自动升级为恋爱或性关系。';
    if (route === '恋爱') return '本次按恋爱路线推进：重点表现约会感、心动、暧昧和甜蜜调情；不得自动跨越尚未确认的亲密边界。';
    if (route === '欲望') return '本次按欲望路线推进：可表现成年人之间明确的性吸引、直白爱欲与情色张力；只依据双方已确认的意图和边界，未确认行为必须先沟通。';
    return '';
}

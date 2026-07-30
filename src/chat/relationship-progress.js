export const CONTENT_MODES = Object.freeze(['SFW', 'NSFW']);
export const SFW_MEETUP_ROUTE_THRESHOLD = 50;
// NSFW route confirmation is a later phase. Preserve its existing gate until
// that phase has its own consent and route-lock implementation.
export const NSFW_MEETUP_ROUTE_THRESHOLD = 60;
export const MEETUP_ROUTE_THRESHOLD = SFW_MEETUP_ROUTE_THRESHOLD;
export const SFW_UNDERSTANDING_THRESHOLD = 60;

const MODE_KINDS = Object.freeze({
    SFW: Object.freeze(['none', 'friendly', 'romantic_flirt']),
    NSFW: Object.freeze(['none', 'friendly', 'romantic_flirt', 'romantic_desire', 'sexual_desire']),
});
const ROUTES = Object.freeze([
    Object.freeze({ route: '友情', field: '友情值' }),
    Object.freeze({ route: '恋爱', field: '心动值' }),
    Object.freeze({ route: '欲望', field: '欲望值' }),
]);
const SFW_PROGRESS_THRESHOLDS = Object.freeze([
    Object.freeze({ threshold: 20, field: 'SFW细微裂缝已触发' }),
    Object.freeze({ threshold: 40, field: 'SFW朋友分享已触发' }),
    Object.freeze({ threshold: SFW_MEETUP_ROUTE_THRESHOLD, field: 'SFW面基已解锁' }),
]);
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
        eventId: '', progressUpdates: Object.freeze({}),
    });
}

function fieldForAssessment(mode, kind, direction) {
    // Phase B.1 deliberately keeps every SFW private-chat interaction on the
    // friendship route. The 60-point insight decision is still unconfirmed;
    // no normal chat can auto-write heart progress before that decision.
    if (mode === 'SFW') return ['friendly', 'romantic_flirt'].includes(kind) ? '友情值' : '';

    // Phase C will define NSFW's consent gates and dual-route milestones. Until
    // then, preserve the existing desire classifications, but apply the new
    // global bounded deltas to any allowed change.
    if (kind === 'romantic_desire') return '心动值';
    if (kind === 'sexual_desire') return '欲望值';
    if (direction === 'decrease' && kind === 'friendly') return '友情值';
    if (direction === 'decrease' && kind === 'romantic_flirt') return '心动值';
    return '';
}

function progressBlocksField(progress, field) {
    return Boolean(progress?.边界暂停状态)
        || Boolean(progress?.关系结束状态)
        || progress?.冻结关系值 === field;
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

function progressUpdatesForNsfw({ progress, turnId, eventId }) {
    const consumed = Array.isArray(progress.已消费事件ID) ? progress.已消费事件ID : [];
    return Object.freeze({
        最后结算回合UID: turnId,
        已消费事件ID: Object.freeze([...consumed, eventId].slice(-64)),
    });
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
export function settleRelationshipProgress({ contentMode, relationship, progress, assessment, replied = true, turnId = '' } = {}) {
    const mode = normalizeContentMode(contentMode);
    const current = relationship && typeof relationship === 'object' ? relationship : {};
    const safeProgress = isProgressRecord(progress) ? progress : {};
    const kind = assessment?.kind;
    const intensity = assessment?.intensity;
    const direction = assessment?.direction ?? (kind === 'none' ? 'none' : 'increase');
    if (!replied || !isKnownAssessment(mode, kind, intensity, direction) || kind === 'none') {
        return emptySettlement(kind ?? 'none', direction);
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
            : progressUpdatesForNsfw({ progress: safeProgress, turnId, eventId }))
        : Object.freeze({});
    return Object.freeze({ field, delta, nextValue, kind, direction, eventId, progressUpdates });
}

/** Backwards-compatible name for callers that only need the projected change. */
export function projectBondProgress(options = {}) {
    return settleRelationshipProgress(options);
}

/** Returns a DOM-safe derived meetup gate without exposing scores or thresholds. */
export function deriveMeetupAccess({ contentMode, relationship } = {}) {
    const mode = normalizeContentMode(contentMode);
    const current = relationship && typeof relationship === 'object' ? relationship : {};
    const threshold = mode === 'SFW' ? SFW_MEETUP_ROUTE_THRESHOLD : NSFW_MEETUP_ROUTE_THRESHOLD;
    const candidates = ROUTES
        .filter(({ route }) => mode === 'NSFW' || route === '友情')
        .map((item, index) => ({ ...item, score: integerScore(current[item.field]), index }))
        .filter((item) => item.score >= threshold)
        .sort((left, right) => right.score - left.score || left.index - right.index);
    const routes = candidates.map((item) => item.route);
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

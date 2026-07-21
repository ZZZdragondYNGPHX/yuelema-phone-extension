const RELATIONSHIP_FIELDS = Object.freeze(['好感', '信任', '戒备', '面基意愿']);

function isBoundedInteger(value, lower, upper) {
    return Number.isInteger(value) && value >= lower && value <= upper;
}

function clamp(value, lower, upper) {
    return Math.min(Math.max(value, lower), upper);
}

/**
 * Projects the model's narrow relationship deltas locally. The model never
 * receives or decides thresholds, states, UIDs, or write paths.
 */
export function projectInteractionRelationship(relationship, deltas) {
    if (!relationship || typeof relationship !== 'object' || !deltas || typeof deltas !== 'object') return null;
    const projected = {};
    for (const field of RELATIONSHIP_FIELDS) {
        if (!isBoundedInteger(relationship[field], 0, 100) || !isBoundedInteger(deltas[field], -10, 10)) return null;
        projected[field] = clamp(relationship[field] + deltas[field], 0, 100);
    }
    return Object.freeze(projected);
}

/**
 * Converts visible relationship values into a deterministic 0..100 interaction
 * pressure. Guarded or low-affinity relationships create more pressure; meetup
 * intent is deliberately excluded because it is not permission to keep chatting.
 */
export function computeInteractionPressure(relationship) {
    if (!relationship || typeof relationship !== 'object') return null;
    const affection = relationship.好感;
    const trust = relationship.信任;
    const guard = relationship.戒备;
    if (![affection, trust, guard].every((value) => isBoundedInteger(value, 0, 100))) return null;
    return clamp(Math.round(guard + Math.max(0, 50 - affection) / 2 + Math.max(0, 50 - trust) / 2), 0, 100);
}

/**
 * Applies one character's hidden rhythm thresholds after response validation.
 * Block takes precedence over read-without-reply when thresholds overlap.
 */
export function decideInteractionRhythm({ relationship, responseRelationship, readWithoutReplyThreshold, blockThreshold } = {}) {
    if (!isBoundedInteger(readWithoutReplyThreshold, 0, 100) || !isBoundedInteger(blockThreshold, 0, 100)) return null;
    const projectedRelationship = projectInteractionRelationship(relationship, responseRelationship);
    if (!projectedRelationship) return null;
    const pressure = computeInteractionPressure(projectedRelationship);
    if (pressure === null) return null;
    const outcome = pressure >= blockThreshold
        ? 'blocked'
        : (pressure >= readWithoutReplyThreshold ? 'read_without_reply' : 'replied');
    return Object.freeze({ outcome, pressure, projectedRelationship });
}

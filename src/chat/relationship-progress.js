export const CONTENT_MODES = Object.freeze(['SFW', 'NSFW']);
export const BOND_FIELDS = Object.freeze(['友情值', '心动值', '欲望值']);
export const FRIENDSHIP_HEART_UNLOCK = 40;
export const MEETUP_ROUTE_THRESHOLD = 60;

const MODE_KINDS = Object.freeze({
    SFW: Object.freeze(['none', 'friendly', 'romantic_flirt']),
    NSFW: Object.freeze(['none', 'romantic_desire', 'sexual_desire']),
});
const BASE_GROWTH = Object.freeze([0, 2, 4, 6]);
const ROUTES = Object.freeze([
    Object.freeze({ route: '友情', field: '友情值' }),
    Object.freeze({ route: '恋爱', field: '心动值' }),
    Object.freeze({ route: '欲望', field: '欲望值' }),
]);

function integerScore(value) {
    return Number.isInteger(value) && value >= 0 && value <= 100 ? value : 0;
}

export function normalizeContentMode(value) {
    return value === 'NSFW' ? 'NSFW' : 'SFW';
}

export function allowedAssessmentKinds(contentMode) {
    return MODE_KINDS[normalizeContentMode(contentMode)];
}

export function calculateBondGrowth(currentValue, intensity) {
    const current = integerScore(currentValue);
    if (!Number.isInteger(intensity) || intensity < 0 || intensity > 3 || intensity === 0 || current >= 100) return 0;
    const raw = BASE_GROWTH[intensity];
    return Math.min(100 - current, Math.max(1, Math.ceil(raw * (100 - current) / 100)));
}

/**
 * Converts a model's mode-scoped semantic assessment into at most one locally
 * controlled bond increment. The model never selects paths or numeric deltas.
 */
export function projectBondProgress({ contentMode, relationship, assessment, replied = true } = {}) {
    const mode = normalizeContentMode(contentMode);
    const current = relationship && typeof relationship === 'object' ? relationship : {};
    const kind = assessment?.kind;
    const intensity = assessment?.intensity;
    if (!replied || !MODE_KINDS[mode].includes(kind) || !Number.isInteger(intensity) || intensity < 0 || intensity > 3) {
        return Object.freeze({ field: '', delta: 0, nextValue: 0, kind: 'none' });
    }
    let field = '';
    if (mode === 'SFW') {
        if (kind === 'friendly') field = '友情值';
        if (kind === 'romantic_flirt') field = integerScore(current.友情值) >= FRIENDSHIP_HEART_UNLOCK ? '心动值' : '友情值';
    } else {
        if (kind === 'romantic_desire') field = '心动值';
        if (kind === 'sexual_desire') field = '欲望值';
    }
    if (!field || kind === 'none') return Object.freeze({ field: '', delta: 0, nextValue: 0, kind });
    const currentValue = integerScore(current[field]);
    const delta = calculateBondGrowth(currentValue, intensity);
    return Object.freeze({ field: delta ? field : '', delta, nextValue: currentValue + delta, kind });
}

/** Returns a DOM-safe derived meetup gate without exposing scores or thresholds. */
export function deriveMeetupAccess({ contentMode, relationship } = {}) {
    const mode = normalizeContentMode(contentMode);
    const current = relationship && typeof relationship === 'object' ? relationship : {};
    const candidates = ROUTES
        .filter(({ route }) => route !== '欲望' || mode === 'NSFW')
        .map((item, index) => ({ ...item, score: integerScore(current[item.field]), index }))
        .filter((item) => item.score >= MEETUP_ROUTE_THRESHOLD)
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

const RELATIONSHIP_FIELDS = Object.freeze(['好感', '信任', '戒备', '面基意愿']);

/**
 * 2026-07-27 校准修复：旧公式以 50 为“未熟识赤字”基线，导致所有来源的新
 * 角色开局压力约 50，而默认已读不回阈值 55 只留 5 点安全边际——第一条消息
 * 稍有波动即被已读不回/拉黑（真机系统性死局）。基线降为 30 后，固定初值
 * 来源（物化 20/10/15、创建面板 0/0/0）的开局压力都是 30，对默认阈值 55
 * 留出 25 点边际；恶化到已读不回需要净 +25 压力（至少两轮明确负向增量）。
 */
const UNFAMILIARITY_BASELINE = 30;

/**
 * 开局宽限层数：对话层数（玩家/角色发言计数，系统提示不计层）低于该值时，
 * 刚匹配的会话处于“互相试探期”——非恶化回合必定回复，且不允许直接拉黑
 * （最重为已读不回）。这是程序侧兜底：即使生成侧给出失衡的初值/阈值，
 * 第一条消息也不可能被拉黑。宽限结束后阈值语义完全恢复。
 */
export const EARLY_CONVERSATION_LAYER_GRACE = 8;

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
 * A freshly matched stranger (both sides opted in) is intentionally low
 * pressure: only guard plus the deficit below the unfamiliarity baseline count.
 */
export function computeInteractionPressure(relationship) {
    if (!relationship || typeof relationship !== 'object') return null;
    const affection = relationship.好感;
    const trust = relationship.信任;
    const guard = relationship.戒备;
    if (![affection, trust, guard].every((value) => isBoundedInteger(value, 0, 100))) return null;
    return clamp(Math.round(
        guard
        + Math.max(0, UNFAMILIARITY_BASELINE - affection) / 2
        + Math.max(0, UNFAMILIARITY_BASELINE - trust) / 2,
    ), 0, 100);
}

/**
 * Applies one character's hidden rhythm thresholds after response validation.
 * Block takes precedence over read-without-reply when thresholds overlap.
 *
 * 恢复与兜底规则（均为程序侧裁决，模型仍不知晓阈值/状态）：
 * - 改善回合（本回合套用增量后的压力低于套用前）把结果上调一级：
 *   blocked → read_without_reply、read_without_reply → replied。这保证正向
 *   互动可以确定性地走出已读不回，不会一旦进入就螺旋恶化。
 * - 传入 dialogueLayers（当前对话层数）且低于开局宽限时：非恶化回合必定
 *   replied，且最重结果为 read_without_reply（试探期不允许直接拉黑）。
 * - 拉黑仍会在关系实质恶化（压力不降且 ≥ 拉黑阈值、已过宽限期）时触发。
 */
export function decideInteractionRhythm({ relationship, responseRelationship, readWithoutReplyThreshold, blockThreshold, dialogueLayers = null } = {}) {
    if (!isBoundedInteger(readWithoutReplyThreshold, 0, 100) || !isBoundedInteger(blockThreshold, 0, 100)) return null;
    if (dialogueLayers !== null && (!Number.isInteger(dialogueLayers) || dialogueLayers < 0)) return null;
    const projectedRelationship = projectInteractionRelationship(relationship, responseRelationship);
    if (!projectedRelationship) return null;
    const pressure = computeInteractionPressure(projectedRelationship);
    const previousPressure = computeInteractionPressure(relationship);
    if (pressure === null || previousPressure === null) return null;
    const improving = pressure < previousPressure;
    const earlyConversation = dialogueLayers !== null && dialogueLayers < EARLY_CONVERSATION_LAYER_GRACE;
    let outcome = pressure >= blockThreshold
        ? 'blocked'
        : (pressure >= readWithoutReplyThreshold ? 'read_without_reply' : 'replied');
    if (improving && outcome !== 'replied') {
        outcome = outcome === 'blocked' ? 'read_without_reply' : 'replied';
    }
    if (earlyConversation) {
        if (outcome === 'blocked') outcome = 'read_without_reply';
        if (outcome === 'read_without_reply' && pressure <= previousPressure) outcome = 'replied';
    }
    return Object.freeze({ outcome, pressure, projectedRelationship });
}

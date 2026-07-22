/**
 * Turns a strictly public AI match draft into the complete, locally-owned MVU
 * candidate envelope required by the controlled write boundary.
 *
 * The model never receives or creates these internal fields.  They are stable
 * local defaults, and the returned candidate still has the normal “陌生” state;
 * controlled-patch.js is the only place that upgrades it to a matched session.
 */
import { normalizeGeneratedCandidate } from './candidate.js';
import { getLocalCandidateMatchEvaluation, normalizeCandidateMatchDraft } from './soul-text-match-service.js';
import { scoreLocalCandidateMatch } from './match-scoring.js';

function inferredAdultAge(ageRange) {
    const values = [...String(ageRange ?? '').matchAll(/\d{1,3}/gu)]
        .map((match) => Number(match[0]))
        .filter((value) => Number.isInteger(value) && value >= 18 && value <= 120);
    return values[0] ?? 25;
}

/**
 * Materializes a public-only match result without accepting any user-supplied
 * private data, UID, relationship status, or Patch path.
 */
export function materializeCandidateMatchDraft(draft, {
    contentMode = 'SFW',
    playerPublicProfile = {},
    effectiveKeywordWeights = [],
} = {}) {
    const attestedEvaluation = getLocalCandidateMatchEvaluation(draft);
    const normalized = normalizeCandidateMatchDraft(draft, { contentMode });
    const evaluation = attestedEvaluation ?? scoreLocalCandidateMatch(
        playerPublicProfile,
        normalized.profile,
        effectiveKeywordWeights,
    );
    const publicProfile = {
        ...normalized.profile,
        // AI match drafts deliberately never supply remote image URLs.  The
        // public app avatar stays a local presentation concern.
        头像引用: '',
    };
    const candidate = normalizeGeneratedCandidate({
        成人验证: true,
        公开资料: publicProfile,
        仅好友资料: {
            关系状态: '已互相喜欢，正在通过文字聊天相互了解。',
            边界与偏好: '尊重意愿与边界；重要安排需要在聊天中明确确认。',
        },
        隐藏资料: { 实际年龄: inferredAdultAge(publicProfile.年龄段), 私人备注: '' },
        偏好与边界: '尊重隐私、意愿与清晰沟通。',
        拒绝阈值: 50,
        已读不回阈值: 55,
        取消匹配阈值: 75,
        拉黑阈值: 90,
        与玩家关系: {
            状态: '陌生',
            全局账号表现: 50,
            NPC专属匹配度: evaluation.score,
            好感: 20,
            信任: 10,
            戒备: 15,
            面基意愿: 0,
            友情值: 0,
            心动值: 0,
            欲望值: 0,
        },
    }, { requirePersonalName: true, contentMode });
    const cancellationThreshold = candidate.取消匹配阈值;
    const meetsCancellationThreshold = evaluation.eligible !== false && evaluation.score >= cancellationThreshold;
    return Object.freeze({
        candidate,
        explanation: normalized.explanation,
        matchScore: evaluation.score,
        cancellationThreshold,
        meetsCancellationThreshold,
        shouldEstablishSession: meetsCancellationThreshold,
        evaluation,
    });
}

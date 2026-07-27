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
import { MATCH_ACCEPTANCE_THRESHOLD, scoreLocalCandidateMatch } from './match-scoring.js';
import {
    RECOMMENDATION_DIAGNOSTIC_SCOPES,
    recordRecommendationDiagnostics,
} from './recommendation-diagnostics.js';

function inferredAdultAge(ageRange) {
    const values = [...String(ageRange ?? '').matchAll(/\d{1,3}/gu)]
        .map((match) => Number(match[0]))
        .filter((value) => Number.isInteger(value) && value >= 18 && value <= 120);
    return values[0] ?? 25;
}

// 阶段 56（阈值人设化）：本地物化没有模型可以推导阈值，改为按已生成的公开
// 性格/沟通风格标签做确定性三档映射，只映射真正驱动聊天节奏的两个压力阈值
// （已读不回/拉黑）。拒绝阈值与取消匹配阈值在本流程中是本地匹配分闸门
// （见下方 meetsCancellationThreshold），改动会直接改变会话能否建立的语义，
// 因此保持固定值不参与人设映射。三档均满足生成约束（拉黑 ≥60 且高于已读不回）。
const TOLERANT_TRAIT_PATTERN = /(外向|开朗|包容|随和|热情|乐观|幽默|耐心|大方|好脾气|钝感|松弛)/u;
const GUARDED_TRAIT_PATTERN = /(敏感|慢热|内向|谨慎|高冷|戒备|社恐|拘谨|多疑|界限分明)/u;

export function inferRhythmThresholdsFromTraits(profile) {
    const traits = [
        ...(Array.isArray(profile?.性格标签) ? profile.性格标签 : []),
        ...(Array.isArray(profile?.沟通风格标签) ? profile.沟通风格标签 : []),
    ].join(' ');
    const tolerant = TOLERANT_TRAIT_PATTERN.test(traits);
    const guarded = GUARDED_TRAIT_PATTERN.test(traits);
    if (tolerant && !guarded) return { 已读不回阈值: 60, 拉黑阈值: 95 };
    if (guarded && !tolerant) return { 已读不回阈值: 50, 拉黑阈值: 80 };
    return { 已读不回阈值: 55, 拉黑阈值: 90 };
}

/**
 * Materializes a public-only match result without accepting any user-supplied
 * private data, UID, relationship status, or Patch path.
 */
export function materializeCandidateMatchDraft(draft, options = {}) {
    try {
        return materializeCandidateMatchDraftUnchecked(draft, options);
    } catch (error) {
        // action-bridge 会吞掉这里的异常并回退为粗略结果码；为安全控制台的
        // detail 先按调用方合同登记诊断（只含错误码/校验字段名，绝不含隐藏
        // 层字段值、关系分或阈值数值），再原样向上抛。
        recordRecommendationDiagnostics(RECOMMENDATION_DIAGNOSTIC_SCOPES.candidateMatch, {
            code: 'candidate_match_response_invalid',
            stage: '本地物化（草稿转完整候选）',
            actual: typeof error?.code === 'string' ? `校验未通过（${error.code}）` : '本地物化失败',
            hint: '匹配草稿在本地转换为完整候选时未通过结构或成年人校验',
        });
        throw error;
    }
}

function materializeCandidateMatchDraftUnchecked(draft, {
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
        绘图: normalized.drawing,
        偏好与边界: '尊重隐私、意愿与清晰沟通。',
        // 拒绝/取消匹配阈值是本地匹配分闸门，保持固定；压力阈值按人设标签映射。
        拒绝阈值: 50,
        // Matching should remain selective without turning neutral public-tag
        // differences into near-certain rejection. Hard adult and reciprocal
        // gender/orientation gates are enforced before this local score gate.
        取消匹配阈值: MATCH_ACCEPTANCE_THRESHOLD,
        ...inferRhythmThresholdsFromTraits(publicProfile),
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

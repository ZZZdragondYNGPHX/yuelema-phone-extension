// 首页/发现/推荐候选卡页面（策划书 §5 轻改）：
// 操作钮主次分级（喜欢 64 渐变主钮 / 不喜欢 56 描边 / 收藏与下一位 44 ghost，收藏成功实心轻弹）、
// 换人时候选卡骨架屏、空态换 EmptyState；媒体区高度与档案区内滚 / 操作行 sticky 由 style.css discover 子区提供。
// D2 滑卡手势本轮不做（仅保留卡片 transform 结构）、D3 撤销不做。
import { append, element, listen } from '../dom.js';
import { describeActionFailure } from '../ui-model.js';
import {
    RECOMMENDATION_DIAGNOSTIC_SCOPES,
    formatRecommendationFailureDetail,
} from '../recommendation/recommendation-diagnostics.js';
import { createUiIcon } from '../ui/icon.js';
import { createMediaState } from '../ui/media-state.js';
import { createEmptyState } from '../ui/empty-state.js';
import { createSkeleton } from '../ui/skeleton.js';
import { buildWaitCaptions } from './shared.js';

const ACTION_LABELS = Object.freeze({ like: '喜欢', refresh: '刷新', favorite: '收藏', unfavorite: '取消收藏', start_private_chat: '发起私聊', dislike: '不喜欢' });
// P3-G 等待期趣味文案（纯 CSS 轮播）：换人 / AI 生成下一位时替代干等。
const DISCOVER_WAIT_CAPTIONS = Object.freeze(['正在为你物色下一位…', '翻看今天的新面孔…', '比对你们聊得来的话题…', '把关中：只见成年人…']);
const DISCOVER_WAIT_SHIFT_TEXT = '还在精挑细选…这一位值得多等几秒';
const ACTION_ICON_NAMES = Object.freeze({ like: 'action_like', refresh: 'action_next', favorite: 'action_favorite', unfavorite: 'action_favorite', start_private_chat: 'action_chat', dislike: 'action_dislike' });

/**
 * 首页推荐失败的控制台 detail：优先消费服务层寄存的诊断（HTTP 状态、
 * 解析/校验字段等），退化时仅凭结果码与粗略 message 组装；界面 message
 * 保持粗略友好，技术细节只进 detail。
 */
function recommendationFailureDetail({ result, error, stage }) {
    return formatRecommendationFailureDetail({
        scope: RECOMMENDATION_DIAGNOSTIC_SCOPES.recommendationRefresh,
        result, error, operation: '首页推荐', stage,
    });
}

export function createDiscoverPage(ctx) {
    function buildMetaBadges(candidate) {
        const badges = element('span', { className: 'yl-candidate-meta-badges' });
        for (const value of [candidate.年龄段, candidate.城市]) {
            if (value) badges.appendChild(element('span', { className: 'yl-chip yl-chip-meta', text: value }));
        }
        return badges;
    }
    function buildTagChips(tags, emptyText) {
        const wrapper = element('div', { className: 'yl-candidate-tags yl-candidate-tag-chips' });
        if (!tags.length) {
            wrapper.appendChild(element('span', { className: 'yl-chip yl-chip-tag yl-chip-empty', text: emptyText }));
            return wrapper;
        }
        for (const tag of tags) wrapper.appendChild(element('span', { className: 'yl-chip yl-chip-tag', text: tag }));
        return wrapper;
    }
    function buildActionButton(kind, { pending = false, disabled = false, label = ACTION_LABELS[kind], ariaLabel = label } = {}) {
        const actionStyle = kind === 'unfavorite' ? 'favorite' : kind;
        // 收藏成功后按钮转实心并轻弹（is-active 由 CSS 提供动画），消除“收藏了但外观无差异”的困惑。
        const activeClass = kind === 'unfavorite' ? ' is-active' : '';
        const button = element('button', { className: `yl-phone-action-card yl-action-${actionStyle} yl-action-circle${activeClass}`, type: 'button', ariaLabel, disabled });
        const icon = createUiIcon(ctx.documentRef, ACTION_ICON_NAMES[kind], { className: 'yl-action-icon', size: 22, strokeWidth: 1.9 });
        const text = element('span', { className: 'yl-action-label', text: pending ? '处理中…' : label });
        append(button, [icon, text]);
        // P3-G：收藏成功的心形微爆——3 颗小心从按钮向上飘散（纯装饰，CSS 一次性动画）。
        if (kind === 'unfavorite') {
            const burst = element('span', { className: 'yl-fav-burst' });
            burst.setAttribute('aria-hidden', 'true');
            for (let heartIndex = 0; heartIndex < 3; heartIndex += 1) {
                const heart = element('span', { className: 'yl-fav-burst-heart' });
                heart.appendChild(createUiIcon(ctx.documentRef, 'action_like', { className: 'yl-fav-burst-svg', size: 10 }));
                burst.appendChild(heart);
            }
            button.appendChild(burst);
        }
        return button;
    }
    function isFavoriteCandidate(candidate) {
        return Boolean(candidate?.uid && (ctx.currentView.favorites ?? []).some((favorite) => favorite.uid === candidate.uid));
    }
    function buildActionRow(candidate) {
        const actions = element('div', { className: 'yl-candidate-actions' });
        const favoriteAction = isFavoriteCandidate(candidate) ? 'unfavorite' : 'favorite';
        // §5 按钮分级排序：收藏(44 ghost) / 不喜欢(56 描边) / 喜欢(64 渐变主钮) / 下一位(44 ghost)。
        for (const kind of [favoriteAction, 'dislike', 'like', 'refresh']) {
            const pending = ctx.actionBridge.isPending(kind, candidate.uid);
            const button = buildActionButton(kind, { pending, disabled: ctx.refreshing || pending, label: kind === 'refresh' ? '下一位' : ACTION_LABELS[kind], ariaLabel: kind === 'refresh' ? '刷新候选人，显示下一位' : ACTION_LABELS[kind] });
            listen(button, button, 'click', () => { void runCandidateAction(kind, candidate.uid); }, ctx.abortController.signal);
            actions.appendChild(button);
        }
        return actions;
    }
    /** 换人 / AI 生成中的候选卡骨架屏（§5-4）：头像圆 + 文本条组，替代纯弹窗等待感。 */
    function buildCandidateSkeletonCard() {
        const card = element('section', { className: 'yl-candidate-card yl-discovery-workbench yl-candidate-loading-card', ariaLabel: '正在生成下一位候选人' });
        card.setAttribute('aria-busy', 'true');
        card.appendChild(createSkeleton({ documentRef: ctx.documentRef, variant: 'candidate-card', count: 1 }));
        card.appendChild(buildWaitCaptions(ctx.documentRef, DISCOVER_WAIT_CAPTIONS, { shiftText: DISCOVER_WAIT_SHIFT_TEXT }));
        return card;
    }
    function buildCandidateCard(candidate) {
        if (ctx.refreshing) return buildCandidateSkeletonCard();
        const card = element('section', { className: 'yl-candidate-card yl-discovery-workbench' });
        const tags = ctx.displayTags(candidate);
        const media = element('div', { className: 'yl-candidate-media' });
        const imageKey = ctx.imageProfileKey(candidate);
        media.appendChild(buildCandidateBackgroundSlot(candidate, tags));
        const top = element('div', { className: 'yl-candidate-topline yl-candidate-media-copy' });
        top.appendChild(ctx.candidateAvatar(candidate, {
            imageEnabled: true,
            onImageFailure: () => {
                if (!imageKey || ctx.imageAssetFailures.has(imageKey)) return;
                ctx.imageAssetsReady.delete(imageKey);
                ctx.imageAssetFailures.add(imageKey);
                if (ctx.open) ctx.renderPage();
            },
        }));
        const copy = element('div', { className: 'yl-candidate-copy' });
        const nameRow = element('div', { className: 'yl-candidate-name-row' });
        nameRow.appendChild(element('h2', { text: candidate.昵称 || '未命名候选人' }));
        nameRow.appendChild(buildMetaBadges(candidate));
        copy.appendChild(nameRow);
        copy.appendChild(element('p', { className: 'yl-phone-page-description yl-candidate-subline', text: [candidate.年龄段, candidate.城市].filter(Boolean).join(' · ') || '仅公开资料' }));
        top.appendChild(copy); media.appendChild(top); card.appendChild(media);
        card.appendChild(buildCandidateDossier(candidate, tags));
        return card;
    }
    function buildCandidateDossier(candidate, tags) {
        const dossier = element('aside', { className: 'yl-candidate-dossier', ariaLabel: `${candidate.昵称 || '候选人'}的公开档案` });
        dossier.appendChild(element('span', { className: 'yl-candidate-dossier-kicker', text: '本次公开档案' }));
        dossier.appendChild(element('p', { className: 'yl-candidate-bio', text: candidate.简介 || '这位候选人暂未留下更多公开介绍。' }));
        dossier.appendChild(buildCandidateMediaFeedback(candidate));
        const facts = element('div', { className: 'yl-candidate-facts' });
        let factCount = 0;
        for (const [label, value] of [['寻找意图', candidate.寻找意图], ['距离', candidate.距离范围]]) {
            if (!value) continue;
            facts.appendChild(element('span', { className: 'yl-candidate-fact-label', text: label }));
            facts.appendChild(element('span', { className: 'yl-candidate-fact-value', text: value }));
            factCount += 1;
        }
        if (factCount) dossier.appendChild(facts);
        dossier.appendChild(buildTagChips(tags, '暂无公开关键词'));
        dossier.appendChild(buildActionRow(candidate));
        return dossier;
    }
    function buildCandidateMediaFeedback(candidate) {
        const nickname = candidate?.昵称 || '这位候选人';
        const state = ctx.candidateImageState(candidate);
        const mediaState = createMediaState({
            documentRef: ctx.documentRef,
            kind: 'background',
            initialState: state,
            className: 'yl-candidate-media-feedback yl-media-state',
            statusClassName: 'yl-candidate-media-feedback-status',
            retryClassName: 'yl-candidate-media-feedback-retry yl-settings-button',
            retryLabel: '重新尝试图片匹配',
            onRetry: () => ctx.retryCandidateImage(candidate),
            stateText: {
                loading: '正在为' + nickname + '准备公开画面。',
                ready: nickname + '的公开画面已准备好。',
                empty: nickname + '暂时没有可用公开画面，仍可继续浏览资料。',
                error: '公开画面暂时无法显示。可重新尝试，资料和操作不会受影响。',
            },
        });
        mediaState.element.dataset.candidateUid = String(candidate?.uid ?? '');
        return mediaState.element;
    }
    function buildCandidateBackgroundSlot(candidate, tags) {
        const slot = element('div', { className: 'yl-candidate-background-slot yl-candidate-image-slot' });
        slot.setAttribute('aria-hidden', 'true');
        slot.dataset.imageSlot = 'candidate-background';
        slot.dataset.candidateUid = String(candidate?.uid ?? '');
        slot.dataset.keywords = tags.join('|');
        const key = ctx.imageProfileKey(candidate);
        const record = candidate ? ctx.matchedImageFor(candidate) : null;
        const state = ctx.candidateImageState(candidate);
        slot.dataset.imageStatus = state;
        if (record && state !== 'error') {
            ctx.appendImagePreview(slot, record, 'yl-candidate-background-image', '', {
                onLoad: () => {
                    if (ctx.imageAssetsReady.has(key)) return;
                    ctx.imageAssetsReady.add(key);
                    ctx.imageAssetFailures.delete(key);
                    if (ctx.open) ctx.renderPage();
                },
                onFailure: () => {
                    if (ctx.imageAssetFailures.has(key)) return;
                    ctx.imageAssetsReady.delete(key);
                    ctx.imageAssetFailures.add(key);
                    if (ctx.open) ctx.renderPage();
                },
            });
        }
        return slot;
    }
    function buildEmptyCandidateCard() {
        if (ctx.refreshing) return buildCandidateSkeletonCard();
        const card = element('section', { className: 'yl-candidate-card yl-candidate-card-empty yl-discovery-workbench' });
        const media = element('div', { className: 'yl-candidate-media' });
        media.appendChild(buildCandidateBackgroundSlot(null, []));
        const top = element('div', { className: 'yl-candidate-topline yl-candidate-media-copy' });
        top.appendChild(element('span', { className: 'yl-candidate-avatar yl-candidate-avatar-placeholder', text: '？' }));
        const copy = element('div', { className: 'yl-candidate-copy' });
        const nameRow = element('div', { className: 'yl-candidate-name-row' });
        nameRow.appendChild(element('h2', { text: '等待下一次相遇' }));
        copy.appendChild(nameRow);
        copy.appendChild(element('p', { className: 'yl-phone-page-description yl-candidate-subline', text: '下一位将来自已校验的成年人公开资料。' }));
        top.appendChild(copy); media.appendChild(top); card.appendChild(media);
        const dossier = element('aside', { className: 'yl-candidate-dossier yl-candidate-dossier-empty', ariaLabel: '开始发现候选人' });
        // §5-3 空态统一：EmptyState 组件替代 ✧◌ 字符空态。
        dossier.appendChild(createEmptyState({
            documentRef: ctx.documentRef, variant: 'search',
            title: '发现从这里开始',
            hint: '点击“下一位”，由快速模型生成一位明确成年的公开候选人。',
        }));
        const actions = element('div', { className: 'yl-candidate-actions' });
        for (const kind of ['favorite', 'dislike', 'like', 'refresh']) {
            const enabled = kind === 'refresh' && typeof ctx.actionBridge.runRecommendationInitialCandidate === 'function';
            const button = buildActionButton(kind, { pending: ctx.refreshing && kind === 'refresh', disabled: !enabled || ctx.refreshing, label: kind === 'refresh' ? '下一位' : ACTION_LABELS[kind], ariaLabel: kind === 'refresh' ? '刷新候选人，显示下一位' : ACTION_LABELS[kind] });
            if (enabled) listen(button, button, 'click', () => { ctx.actionBridge.emit('open_random_candidates'); void runInitialRecommendationCandidate(); }, ctx.abortController.signal);
            actions.appendChild(button);
        }
        dossier.appendChild(actions); card.appendChild(dossier);
        return card;
    }
    function buildCandidateDetail() {
        const candidate = [
            ...(ctx.currentView.candidates ?? []),
            ...(ctx.currentView.matches ?? []).map((match) => match.profile),
            ...(ctx.currentView.messageSessions ?? []).map((session) => session.profile),
        ].find((entry) => entry?.uid === ctx.selectedCandidateUid) ?? ctx.currentView.candidate;
        if (!candidate) return element('div', { className: 'yl-phone-placeholder', text: '该公开资料已不在当前可见列表。' });
        const section = element('section', { className: 'yl-public-profile' });
        const avatar = ctx.candidateAvatar(candidate, { imageEnabled: true, interactive: false });
        avatar.classList.add('is-avatar-editable');
        avatar.setAttribute('role', 'button');
        avatar.setAttribute('tabindex', '0');
        avatar.setAttribute('aria-label', `更换${candidate.昵称 || '该角色'}的头像`);
        const openAvatarEditor = () => ctx.openAvatarDialog({ kind: 'character', uid: candidate.uid, nickname: candidate.昵称 });
        listen(avatar, avatar, 'click', openAvatarEditor, ctx.abortController.signal);
        listen(avatar, avatar, 'keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault?.(); openAvatarEditor(); }
        }, ctx.abortController.signal);
        section.appendChild(avatar);
        section.appendChild(element('h2', { text: candidate.昵称 || '未命名对象' }));
        for (const [label, value] of [['年龄段', candidate.年龄段], ['性别', candidate.性别], ['性取向', candidate.性取向], ['城市', candidate.城市], ['距离范围', candidate.距离范围], ['寻找意图', candidate.寻找意图], ['简介', candidate.简介]]) if (value) section.appendChild(element('p', { className: 'yl-phone-page-description', text: `${label}：${value}` }));
        const tags = ctx.displayTags(candidate);
        if (tags.length) section.appendChild(buildTagChips(tags, '暂无关键词'));
        if (ctx.currentView.candidate?.uid === candidate.uid) section.appendChild(buildActionRow(candidate));
        return section;
    }
    async function runInitialRecommendationCandidate() {
        if (typeof ctx.actionBridge.runRecommendationInitialCandidate !== 'function') { ctx.setFeedback('随机创建尚未就绪。'); ctx.renderPage(); return; }
        ctx.refreshing = true;
        const activityHandle = ctx.operationActivity.start('首页推荐', '正在生成首位候选人……');
        const operationToken = ctx.showAiLoading('正在生成首位候选人，请稍候…');
        ctx.setFeedback('正在生成下一位候选人…', operationToken); ctx.renderPage();
        let result;
        let caughtError = null;
        try { result = await ctx.actionBridge.runRecommendationInitialCandidate(); }
        catch (error) { caughtError = error; result = { ok: false }; }
        ctx.refreshing = false;
        const message = result?.ok ? '已通过成年人校验，首位候选人已加入队列。' : (result?.message || describeActionFailure(result));
        if (result?.ok) ctx.operationActivity.succeed(activityHandle, '首位候选人已通过成年人校验并加入队列。');
        else {
            ctx.operationActivity.fail(activityHandle, '首位候选人未生成，请稍后再试。', {
                detail: recommendationFailureDetail({ result, error: caughtError, stage: '空池首位候选生成' }),
            });
        }
        ctx.setFeedback(message, operationToken);
        ctx.showAiResult(Boolean(result?.ok), message || '候选人未生成，请稍后重试。', operationToken);
        ctx.refreshState();
    }
    async function runCandidateAction(kind, npcUid) {
        const isRefresh = kind === 'refresh';
        // 收藏只保存到收藏夹；只有明确的喜欢/不喜欢反馈才会推进到下一位。
        const advancesCandidate = kind === 'like' || kind === 'dislike';
        ctx.refreshing = isRefresh || advancesCandidate;
        const refreshActivityHandle = isRefresh ? ctx.operationActivity.start('首页推荐', '正在生成下一位候选人……') : null;
        const operationToken = isRefresh ? ctx.showAiLoading('正在生成下一位候选人，请稍候…') : ctx.setFeedback('正在保存操作…');
        ctx.setFeedback(isRefresh ? '正在生成下一位候选人…' : '正在保存操作…', operationToken); ctx.renderPage();
        let result;
        let caughtError = null;
        try {
            if (isRefresh) result = typeof ctx.actionBridge.runRecommendationRefresh === 'function' ? await ctx.actionBridge.runRecommendationRefresh(npcUid) : { ok: false, message: '刷新候选人生成功能尚未就绪。' };
            else result = await ctx.actionBridge.runMvuAction(kind, npcUid);
        } catch (error) { caughtError = error; result = { ok: false }; }
        if (!result?.ok) {
            ctx.refreshing = false;
            const message = result?.message || describeActionFailure(result);
            if (refreshActivityHandle) {
                ctx.operationActivity.fail(refreshActivityHandle, '下一位候选人未生成，请稍后再试。', {
                    detail: recommendationFailureDetail({ result, error: caughtError, stage: '刷新生成下一位候选' }),
                });
            }
            ctx.setFeedback(message, operationToken);
            if (isRefresh) ctx.showAiResult(false, message || '候选人未生成，请稍后重试。', operationToken);
            ctx.refreshState();
            return;
        }
        if (!advancesCandidate) {
            ctx.refreshing = false;
            const message = isRefresh ? '下一位候选人已生成。' : kind === 'favorite' ? '已加入收藏夹。' : '已取消收藏。';
            if (refreshActivityHandle) ctx.operationActivity.succeed(refreshActivityHandle, '下一位候选人已生成。');
            ctx.setFeedback(message, operationToken);
            if (isRefresh) ctx.showAiResult(true, message, operationToken);
            ctx.refreshState();
            return;
        }
        const savedLabel = kind === 'like' ? '喜欢反馈已保存' : kind === 'favorite' ? '已加入收藏夹' : '不喜欢反馈已保存';
        if (typeof ctx.actionBridge.runRecommendationInitialCandidate !== 'function') {
            ctx.refreshing = false;
            ctx.setFeedback(`${savedLabel}，但下一位候选人生成功能尚未就绪。`, operationToken);
            ctx.refreshState();
            return;
        }
        const nextActivityHandle = ctx.operationActivity.start('首页推荐', '正在生成下一位候选人……');
        ctx.showAiLoading('正在生成下一位候选人，请稍候…', operationToken);
        ctx.setFeedback('正在生成下一位候选人…', operationToken); ctx.renderPage();
        let nextResult;
        let nextCaughtError = null;
        try { nextResult = await ctx.actionBridge.runRecommendationInitialCandidate(); }
        catch (error) { nextCaughtError = error; nextResult = { ok: false }; }
        ctx.refreshing = false;
        if (!nextResult?.ok) {
            const reason = nextResult?.message || describeActionFailure(nextResult) || '未知错误';
            ctx.operationActivity.fail(nextActivityHandle, '下一位候选人未生成，请稍后再试。', {
                detail: recommendationFailureDetail({ result: nextResult, error: nextCaughtError, stage: '反馈保存后生成下一位候选' }),
            });
            const message = `${savedLabel}，但下一位候选人生成失败：${reason}`;
            ctx.setFeedback(message, operationToken);
            ctx.showAiResult(false, message, operationToken);
        } else {
            ctx.operationActivity.succeed(nextActivityHandle, '下一位候选人已生成。');
            const message = `${savedLabel}，下一位候选人已生成。`;
            ctx.setFeedback(message, operationToken);
            ctx.showAiResult(true, message, operationToken);
        }
        ctx.refreshState();
    }
    return {
        buildMetaBadges,
        buildTagChips,
        buildActionButton,
        isFavoriteCandidate,
        buildActionRow,
        buildCandidateCard,
        buildCandidateDossier,
        buildCandidateMediaFeedback,
        buildCandidateBackgroundSlot,
        buildEmptyCandidateCard,
        buildCandidateDetail,
        runInitialRecommendationCandidate,
        runCandidateAction,
    };
}

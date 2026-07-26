// 匹配页（策划书 §6 大改）：匹配光环 Hero + 「灵魂匹配｜描述匹配」SegmentedControl、
// It's a Match 成功浮层、页面内婉拒/失败结果卡、新牵手横滑 rail、已牵手 ListRow 列表、
// 约伴情境入口条（裁决 D1，可关闭、本地记忆）。
// 恋爱四态动画（connecting/accepted/declined/failure）全部 SVG 双心（§4.5），四态显式传参，
// reduced-motion 降级由 style.css motion 分区全局接管。
// 分数与同频理由只做展示：数据仅来自 action-bridge 返回值与公开资料投影，绝不请求或渲染非公开字段。
import { append, element, listen } from '../dom.js';
import { describeActionFailure } from '../ui-model.js';
import {
    RECOMMENDATION_DIAGNOSTIC_SCOPES,
    formatRecommendationFailureDetail,
} from '../recommendation/recommendation-diagnostics.js';
import { createButton } from '../ui/button.js';
import { createEmptyState } from '../ui/empty-state.js';
import { createListRow } from '../ui/list-row.js';
import { createSegmentedControl } from '../ui/segmented-control.js';
import { createUiIcon } from '../ui/icon.js';
import { HEART_PATH, createRomanceHearts } from '../ui/romance-hearts.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SERVICE_BANNER_STORAGE_KEY = 'yuelema.match-service-banner-dismissed/v1';
const MATCH_PROGRESS_CAPTIONS = Object.freeze(['正在感应频率…', '正在比对公开关键词…', '正在等待对方回应…']);

/**
 * 匹配失败的控制台 detail：优先消费服务层寄存的诊断（两阶段各自的 HTTP/
 * 解析/校验失败、本地物化失败等），退化时仅凭结果码组装；界面文案不变。
 */
function candidateMatchFailureDetail({ result, error, operation, stage }) {
    return formatRecommendationFailureDetail({
        scope: RECOMMENDATION_DIAGNOSTIC_SCOPES.candidateMatch,
        result, error, operation, stage,
    });
}
const SCORE_RING_RADIUS = 30;
const SCORE_RING_CIRCUMFERENCE = 2 * Math.PI * SCORE_RING_RADIUS;

export function createMatchPage(ctx) {
    /** SegmentedControl 当前模式（纯 UI 状态，不进 MVU）。 */
    let matchModeId = 'soul';
    /** '' | 'soul' | 'voice'：匹配请求进行中的模式。 */
    let matchPendingMode = '';
    /** 最近一次匹配结果（内存展示态）：{ outcome, mode, score, reasons, profile, npcUid, sessionUid, message }。 */
    let matchResult = null;
    let gradientSeq = 0;
    let serviceBannerDismissed = (() => {
        try { return globalThis.localStorage?.getItem(SERVICE_BANNER_STORAGE_KEY) === '1'; } catch { return false; }
    })();

    function svgNode(name, attributes = {}) {
        const node = ctx.documentRef.createElementNS(SVG_NS, name);
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
        return node;
    }
    function decorativeSvg(viewBox, className) {
        const svg = svgNode('svg', { viewBox, fill: 'none', class: className });
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        return svg;
    }
    /** 在 SVG 内注入品牌渐变 defs，返回可用于 stroke 的引用；stop 颜色由 CSS token 提供。 */
    function appendBrandGradient(svg) {
        gradientSeq += 1;
        const id = 'yl-match-grad-' + gradientSeq;
        const defs = svgNode('defs');
        const gradient = svgNode('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '1' });
        gradient.appendChild(svgNode('stop', { offset: '0', class: 'yl-grad-stop-a' }));
        gradient.appendChild(svgNode('stop', { offset: '1', class: 'yl-grad-stop-b' }));
        defs.appendChild(gradient);
        svg.appendChild(defs);
        return 'url(#' + id + ')';
    }
    /** 恋爱四态动画基元：SVG 双心，state 必须显式传入四态之一（§4.5）；实现上提为共享组件与壳层弹窗共用。 */
    function buildRomanceHearts(state) {
        return createRomanceHearts(ctx.documentRef, state);
    }
    /** 同频度分数环：仅展示 0–100 的整数分，muted 为婉拒灰色形态。 */
    function buildScoreRing(score, { muted = false } = {}) {
        const normalized = Number.isFinite(score) ? Math.min(100, Math.max(0, Math.round(score))) : null;
        const ring = element('div', { className: muted ? 'yl-score-ring is-muted' : 'yl-score-ring' });
        if (normalized !== null) ring.dataset.score = String(normalized);
        const svg = decorativeSvg('0 0 72 72', 'yl-score-ring__svg');
        const strokeRef = muted ? '' : appendBrandGradient(svg);
        svg.appendChild(svgNode('circle', { cx: 36, cy: 36, r: SCORE_RING_RADIUS, class: 'yl-score-ring__track' }));
        const value = svgNode('circle', {
            cx: 36, cy: 36, r: SCORE_RING_RADIUS,
            'stroke-linecap': 'round',
            'stroke-dasharray': (((normalized ?? 0) / 100) * SCORE_RING_CIRCUMFERENCE).toFixed(1) + ' ' + SCORE_RING_CIRCUMFERENCE.toFixed(1),
            class: 'yl-score-ring__value',
        });
        if (strokeRef) value.setAttribute('stroke', strokeRef);
        svg.appendChild(value);
        ring.appendChild(svg);
        const copy = element('div', { className: 'yl-score-ring__copy' });
        append(copy, [
            element('strong', { text: normalized !== null ? normalized + '%' : '—' }),
            element('span', { text: '同频度' }),
        ]);
        ring.appendChild(copy);
        return ring;
    }
    /** 成功浮层中心的心形粒子（纯装饰 SVG）。 */
    function buildHeartParticles() {
        const svg = decorativeSvg('0 0 120 64', 'yl-match-particles');
        const spots = [[6, 30, .34], [28, 6, .46], [50, 40, .3], [68, 4, .5], [90, 26, .38], [106, 44, .3]];
        spots.forEach(([x, y, scale], index) => {
            svg.appendChild(svgNode('path', {
                d: HEART_PATH,
                transform: 'translate(' + x + ' ' + y + ') scale(' + scale + ')',
                class: 'yl-match-particle yl-match-particle-' + (index + 1),
            }));
        });
        return svg;
    }
    /** 结果叙述安全阀：过长或含内部信息（UID/路径/技术细节）的文本回退为固定文案。 */
    function safeMatchNarrative(textValue, fallback) {
        const value = String(textValue ?? '').trim();
        if (!value || value.length > 200) return fallback;
        if (/(?:api[_ -]?key|authorization|bearer|stat_data|jsonpatch|prompt|stack|http(?:s)?:\/\/|\buid\b|阈值|关系分|\b(?:npc|chat|meetup|group)_[a-z0-9_-]+\b)/iu.test(value)) return fallback;
        return value;
    }
    /** 同频理由 chips：只从公开标签 / 公开字段中挑选，绝不透出评分内部构成。 */
    function matchReasonChips(explanation, profile) {
        const narrative = typeof explanation === 'string' ? explanation : '';
        const usable = (value) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 18;
        const tags = (profile ? ctx.displayTags(profile) : []).filter(usable).map((tag) => tag.trim());
        const hits = tags.filter((tag) => narrative.includes(tag));
        const chips = [];
        for (const candidate of [...hits, ...tags, profile?.寻找意图, profile?.城市]) {
            if (!usable(candidate)) continue;
            const value = candidate.trim();
            if (!chips.includes(value)) chips.push(value);
            if (chips.length >= 4) break;
        }
        if (!chips.length) chips.push('公开档案同频');
        return chips.slice(0, 4);
    }
    /** 玩家头像（本地头像仅作展示，不进任何提示词/导出）。 */
    function playerAvatar(className) {
        let source = null;
        try { source = ctx.playerAvatarStore?.snapshot?.() ?? null; } catch { source = null; }
        return ctx.publicAvatar(ctx.currentView.playerProfile ?? {}, {
            className, imageEnabled: false, interactive: false, fallback: '我', imageSource: source,
        });
    }
    /** 匹配光环：渐变同心圆 + 玩家头像；匹配中加速旋转。 */
    function buildMatchHalo() {
        const matching = matchPendingMode !== '';
        const halo = element('div', { className: matching ? 'yl-match-halo is-matching' : 'yl-match-halo' });
        const svg = decorativeSvg('0 0 200 200', 'yl-halo-svg');
        const strokeRef = appendBrandGradient(svg);
        for (const [index, radius, width] of [[1, 94, 1.6], [2, 76, 1.4], [3, 58, 1.2]]) {
            svg.appendChild(svgNode('circle', {
                cx: 100, cy: 100, r: radius, stroke: strokeRef, 'stroke-width': width,
                class: 'yl-halo-ring yl-halo-ring-' + index,
            }));
        }
        halo.appendChild(svg);
        const slot = element('span', { className: 'yl-halo-avatar-slot' });
        slot.appendChild(playerAvatar('yl-halo-avatar'));
        halo.appendChild(slot);
        return halo;
    }
    /** 约伴情境入口条（D1）：仅解锁后显示，可关闭并记入浏览器本地。 */
    function dismissServiceBanner() {
        serviceBannerDismissed = true;
        try { globalThis.localStorage?.setItem(SERVICE_BANNER_STORAGE_KEY, '1'); } catch { /* 浏览器存储不可用时仅本次会话内记忆 */ }
        ctx.renderPage();
    }
    function buildServiceContextBanner() {
        const banner = element('article', { className: 'yl-match-service-banner', ariaLabel: '约伴入口' });
        const icon = element('span', { className: 'yl-match-service-banner__icon' });
        icon.appendChild(createUiIcon(ctx.documentRef, 'service_hub', { className: 'yl-ui-icon', size: 20 }));
        banner.appendChild(icon);
        const copy = element('div', { className: 'yl-match-service-banner__copy' });
        append(copy, [
            element('strong', { text: '约伴会员馆已解锁' }),
            element('span', { text: '想直接安排一次高质量陪伴？去约伴看看。' }),
        ]);
        banner.appendChild(copy);
        const go = createButton({ documentRef: ctx.documentRef, variant: 'tonal', label: '去看看', onClick: () => ctx.setActivePage('service_hub') });
        go.classList.toggle('yl-match-service-banner__go');
        banner.appendChild(go);
        const close = createButton({ documentRef: ctx.documentRef, variant: 'icon', icon: 'close', ariaLabel: '关闭约伴入口提示', onClick: dismissServiceBanner });
        close.classList.toggle('yl-match-service-banner__close');
        banner.appendChild(close);
        return banner;
    }
    /** 匹配 Hero 卡：光环 + 模式分段 + 说明/输入 + 主按钮；两模式同卡同配色。 */
    function buildMatchHero() {
        const hero = element('article', { className: 'yl-match-hero', ariaLabel: 'AI 匹配' });
        hero.appendChild(buildMatchHalo());
        const matching = matchPendingMode !== '';
        if (matching) {
            const progress = element('div', { className: 'yl-match-progress' });
            progress.setAttribute('role', 'status');
            progress.setAttribute('aria-label', '匹配进行中');
            progress.appendChild(buildRomanceHearts('connecting'));
            const captions = element('div', { className: 'yl-match-captions' });
            for (const caption of MATCH_PROGRESS_CAPTIONS) captions.appendChild(element('span', { text: caption }));
            progress.appendChild(captions);
            // P3-G：超过 8 秒的换挡文案，纯 CSS animation-delay 淡入，零计时器。
            const shift = element('span', { className: 'yl-wait-shift', text: '还在牵线…好的相遇值得多等一会' });
            shift.setAttribute('aria-hidden', 'true');
            progress.appendChild(shift);
            hero.appendChild(progress);
        }
        const seg = createSegmentedControl({
            documentRef: ctx.documentRef,
            segments: [{ id: 'soul', label: '灵魂匹配' }, { id: 'voice', label: '描述匹配' }],
            activeId: matchModeId,
            ariaLabel: '匹配模式',
            onChange: (id) => { matchModeId = id; ctx.renderPage(); },
        });
        hero.appendChild(seg.root);
        hero.appendChild(element('p', {
            className: 'yl-match-hero-hint',
            text: matchModeId === 'soul'
                ? '用你保存的关键词，寻找同频的公开档案。'
                : '用一段文字说说此刻想遇见怎样的人；这次提取的关键词会优先于本地偏好。',
        }));
        if (matchModeId === 'voice') {
            const voiceInput = element('textarea', {
                className: 'yl-settings-control yl-settings-textarea yl-match-desc-input',
                rows: 3, maxLength: 800, placeholder: '此刻想遇见怎样的人…',
                value: ctx.voiceMatchText, ariaLabel: '描述匹配文字描述',
            });
            listen(voiceInput, voiceInput, 'input', () => { ctx.voiceMatchText = voiceInput.value; }, ctx.abortController.signal);
            hero.appendChild(voiceInput);
        }
        const mode = matchModeId === 'voice' ? 'voice' : 'soul';
        const pending = matching || ctx.actionBridge.isPending('candidate_match_' + mode, '');
        const startButton = createButton({
            documentRef: ctx.documentRef,
            variant: 'primary',
            label: pending ? '匹配中…' : '开始匹配',
            disabled: pending || typeof ctx.actionBridge.runCandidateMatch !== 'function',
            onClick: () => { void runCandidateMatch(mode); },
        });
        startButton.classList.toggle('yl-match-start');
        hero.appendChild(startButton);
        return hero;
    }
    /** 页面内结果卡（婉拒 / 失败）：浅色卡 + 模糊剪影 + 灰分数环 + 理由 + 再试一次。 */
    function buildMatchResultCard() {
        const declined = matchResult.outcome === 'declined';
        const card = element('article', {
            className: 'yl-match-result-card',
            ariaLabel: declined ? '匹配结果：这次暂未牵手' : '匹配结果：未完成',
        });
        card.dataset.outcome = matchResult.outcome;
        const visual = element('div', { className: 'yl-match-result-visual' });
        const silhouette = element('span', { className: 'yl-match-result-avatar' });
        silhouette.setAttribute('aria-hidden', 'true');
        silhouette.appendChild(createUiIcon(ctx.documentRef, 'profile', { className: 'yl-match-result-avatar-icon', size: 28 }));
        visual.appendChild(silhouette);
        visual.appendChild(buildRomanceHearts(declined ? 'declined' : 'failure'));
        card.appendChild(visual);
        if (declined && Number.isFinite(matchResult.score)) card.appendChild(buildScoreRing(matchResult.score, { muted: true }));
        card.appendChild(element('strong', { className: 'yl-match-result-title', text: declined ? '这次没对上频率' : '这次连接未完成' }));
        card.appendChild(element('p', { className: 'yl-match-result-reason', text: matchResult.message }));
        const actions = element('div', { className: 'yl-match-result-actions' });
        const retryMode = matchResult.mode === 'voice' ? 'voice' : 'soul';
        actions.appendChild(createButton({
            documentRef: ctx.documentRef, variant: 'tonal', label: '再试一次',
            onClick: () => { void runCandidateMatch(retryMode); },
        }));
        actions.appendChild(createButton({
            documentRef: ctx.documentRef, variant: 'ghost', label: '知道了',
            onClick: () => { matchResult = null; ctx.renderPage(); },
        }));
        card.appendChild(actions);
        return card;
    }
    /** It's a Match 全屏浮层：双头像滑入相触 + 心形粒子 + 分数环 + 同频理由 chips。 */
    function buildMatchSuccessOverlay() {
        const overlay = element('section', { className: 'yl-match-overlay' });
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'false');
        overlay.setAttribute('aria-label', '匹配成功');
        const card = element('div', { className: 'yl-match-overlay-card' });
        const close = createButton({
            documentRef: ctx.documentRef, variant: 'icon', icon: 'close', ariaLabel: '关闭匹配结果',
            onClick: () => { matchResult = null; ctx.renderPage(); },
        });
        close.classList.toggle('yl-match-overlay-close');
        card.appendChild(close);
        card.appendChild(element('span', { className: 'yl-match-overlay-kicker', text: "It's a Match" }));
        card.appendChild(element('h2', { className: 'yl-match-overlay-title', text: '两颗心对上了频率' }));
        const avatars = element('div', { className: 'yl-match-overlay-avatars' });
        const mine = element('span', { className: 'yl-match-avatar-ring yl-match-overlay-avatar yl-match-overlay-avatar--self' });
        mine.appendChild(playerAvatar('yl-halo-avatar'));
        const spark = element('span', { className: 'yl-match-overlay-spark' });
        spark.appendChild(buildHeartParticles());
        spark.appendChild(buildRomanceHearts('accepted'));
        const theirs = element('span', { className: 'yl-match-avatar-ring yl-match-overlay-avatar yl-match-overlay-avatar--peer' });
        if (matchResult.profile) theirs.appendChild(ctx.candidateAvatar(matchResult.profile, { imageEnabled: true, interactive: false }));
        else theirs.appendChild(element('span', { className: 'yl-candidate-avatar', text: '心' }));
        append(avatars, [mine, spark, theirs]);
        card.appendChild(avatars);
        if (Number.isFinite(matchResult.score)) card.appendChild(buildScoreRing(matchResult.score));
        if (matchResult.reasons.length) {
            const reasons = element('div', { className: 'yl-match-reasons' });
            for (const reason of matchResult.reasons) reasons.appendChild(element('span', { className: 'yl-chip yl-chip--tag', text: reason }));
            card.appendChild(reasons);
        }
        const actions = element('div', { className: 'yl-match-overlay-actions' });
        actions.appendChild(createButton({
            documentRef: ctx.documentRef, variant: 'primary', label: '开始聊天',
            disabled: !matchResult.sessionUid,
            onClick: () => {
                const sessionUid = matchResult?.sessionUid ?? '';
                matchResult = null;
                ctx.openPrivateChat(sessionUid, { preserveOperation: true });
            },
        }));
        actions.appendChild(createButton({
            documentRef: ctx.documentRef, variant: 'ghost', label: '继续逛逛',
            onClick: () => { matchResult = null; ctx.renderPage(); },
        }));
        card.appendChild(actions);
        overlay.appendChild(card);
        return overlay;
    }
    /** 新牵手 rail + 已牵手 ListRow 列表；空态用 EmptyState。 */
    function buildMatchHistory() {
        const matches = ctx.currentView.matches ?? [];
        const sessions = ctx.currentView.messageSessions ?? [];
        const sessionFor = (uid) => sessions.find((session) => session.npcUid === uid) ?? null;
        const openMatchChat = (uid) => {
            const session = sessionFor(uid);
            if (session) ctx.openPrivateChat(session.sessionUid);
            else ctx.setActivePage('messages');
        };
        const history = element('section', { className: 'yl-match-history', ariaLabel: '已牵手对象' });
        const fresh = matches.filter((match) => {
            const session = sessionFor(match.uid);
            return !session || session.messages.length === 0;
        });
        if (fresh.length) {
            const railBlock = element('div', { className: 'yl-match-rail-block' });
            railBlock.appendChild(element('h2', { className: 'yl-match-history-title', text: '新牵手' }));
            const rail = element('div', { className: 'yl-match-rail', ariaLabel: '新牵手，还没聊过' });
            for (const match of fresh) {
                const nickname = match.profile.昵称 || '未命名对象';
                const item = element('button', { className: 'yl-match-rail-item', type: 'button', ariaLabel: '和' + nickname + '开始聊天' });
                const ring = element('span', { className: 'yl-match-avatar-ring' });
                ring.appendChild(ctx.candidateAvatar(match.profile, { imageEnabled: true, interactive: false }));
                item.appendChild(ring);
                item.appendChild(element('span', { className: 'yl-match-rail-name', text: nickname }));
                listen(item, item, 'click', () => openMatchChat(match.uid), ctx.abortController.signal);
                rail.appendChild(item);
            }
            railBlock.appendChild(rail);
            history.appendChild(railBlock);
        }
        history.appendChild(element('h2', { className: 'yl-match-history-title', text: '已牵手对象' }));
        if (!matches.length) {
            history.appendChild(createEmptyState({
                documentRef: ctx.documentRef, variant: 'heart',
                title: '还没有互相匹配的对象', hint: '先试试上面的匹配工具吧。',
            }));
            return history;
        }
        const list = element('div', { className: 'yl-match-history-list' });
        for (const match of matches) {
            const subtitle = [match.profile.年龄段, match.profile.城市].filter(Boolean).join(' · ');
            list.appendChild(createListRow({
                documentRef: ctx.documentRef,
                avatar: ctx.candidateAvatar(match.profile, { imageEnabled: true, interactive: false }),
                title: match.profile.昵称 || '未命名对象',
                subtitle,
                meta: { chevron: true, chips: match.profile.寻找意图 ? [match.profile.寻找意图] : [] },
                onClick: () => openMatchChat(match.uid),
            }));
        }
        history.appendChild(list);
        return history;
    }
    function buildMatchesPage() {
        const section = element('section', { className: 'yl-phone-empty-actions yl-match-list' });
        const tools = element('section', { className: 'yl-match-tools', ariaLabel: 'AI 匹配工具' });
        if (ctx.serviceHubUnlocked && !serviceBannerDismissed) tools.appendChild(buildServiceContextBanner());
        tools.appendChild(buildMatchHero());
        if (matchResult && matchResult.outcome !== 'accepted') tools.appendChild(buildMatchResultCard());
        section.appendChild(tools);
        section.appendChild(buildMatchHistory());
        if (matchResult?.outcome === 'accepted') section.appendChild(buildMatchSuccessOverlay());
        return section;
    }
    async function runCandidateMatch(mode) {
        if (typeof ctx.actionBridge.runCandidateMatch !== 'function') { ctx.setFeedback('AI 匹配服务尚未就绪。'); return; }
        const requestId = ++ctx.interactionGeneration;
        const pageAtStart = ctx.activePage;
        const modeLabel = mode === 'soul' ? '灵魂匹配' : '描述匹配';
        const activityHandle = ctx.operationActivity.start(modeLabel, modeLabel + '中……');
        matchResult = null;
        matchPendingMode = mode;
        ctx.renderPage();
        let result;
        let caughtError = null;
        try { result = await ctx.actionBridge.runCandidateMatch(mode, { voiceText: ctx.voiceMatchText }); }
        catch (error) { caughtError = error; result = { ok: false }; }
        matchPendingMode = '';
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) {
            ctx.operationActivity.dismiss(activityHandle, '提示已关闭，结果未展示。');
            return;
        }
        if (!result?.ok) {
            const message = safeMatchNarrative(result?.message || describeActionFailure(result), modeLabel + '未生成可用结果，请稍后再试。');
            ctx.operationActivity.fail(activityHandle, modeLabel + '未完成，请稍后再试。', {
                detail: candidateMatchFailureDetail({ result, error: caughtError, operation: modeLabel, stage: '候选匹配生成' }),
            });
            matchResult = { outcome: 'failure', mode, score: null, reasons: [], profile: null, npcUid: '', sessionUid: '', message };
            if (ctx.activePage === pageAtStart) ctx.renderPage();
            return;
        }
        const score = Number.isFinite(result.matchScore) ? Math.round(result.matchScore) : null;
        if (result.matchOutcome === 'declined') {
            ctx.refreshState();
            ctx.operationActivity.fail(activityHandle, modeLabel + '未匹配成功。', {
                detail: candidateMatchFailureDetail({
                    result: { code: 'match_declined' }, operation: modeLabel, stage: '本地评估',
                }),
            });
            matchResult = {
                outcome: 'declined', mode, score, reasons: [], profile: null, npcUid: '', sessionUid: '',
                message: safeMatchNarrative(result.explanation, '这次没有对上互动频率，对方婉拒了。先把心意留在这里，稍后再试试。'),
            };
            if (ctx.activePage === pageAtStart) ctx.renderPage();
            return;
        }
        const accepted = result.matchOutcome === 'accepted'
            || (!result.matchOutcome && Boolean(result.npcUid && result.sessionUid));
        if (!accepted || !result.npcUid || !result.sessionUid) {
            ctx.refreshState();
            ctx.operationActivity.fail(activityHandle, modeLabel + '结果缺少可用会话。', {
                detail: candidateMatchFailureDetail({
                    result, operation: modeLabel, stage: '结果落地',
                }) ?? candidateMatchFailureDetail({
                    result: { code: 'match_result_incomplete' }, operation: modeLabel, stage: '结果落地',
                }),
            });
            matchResult = { outcome: 'failure', mode, score: null, reasons: [], profile: null, npcUid: '', sessionUid: '', message: '匹配结果缺少可用会话，本次没有进入消息。' };
            if (ctx.activePage === pageAtStart) ctx.renderPage();
            return;
        }
        ctx.refreshState();
        const matchedProfile = (ctx.currentView.matches ?? []).find((match) => match.uid === result.npcUid)?.profile ?? null;
        matchResult = {
            outcome: 'accepted', mode, score,
            reasons: matchReasonChips(result.explanation, matchedProfile),
            profile: matchedProfile,
            npcUid: result.npcUid, sessionUid: result.sessionUid,
            message: '',
        };
        ctx.operationActivity.succeed(activityHandle, modeLabel + '成功，等待你开启第一句聊天。');
        if (ctx.activePage === pageAtStart) ctx.renderPage();
    }
    return {
        buildMatchesPage,
        runCandidateMatch,
    };
}

// 匹配页（灵魂/描述匹配、已牵手列表）：从 src/app-shell.js 纯搬移而来，函数体逐行未改，仅将跨模块引用改为 ctx.*。
import { append, element, listen } from '../dom.js';
import { describeActionFailure } from '../ui-model.js';

export function createMatchPage(ctx) {
    function buildMatchesPage() {
        const section = element('section', { className: 'yl-phone-empty-actions yl-match-list' });
        const tools = element('section', { className: 'yl-match-tools', ariaLabel: 'AI 匹配工具' });
        const soul = element('article', { className: 'yl-soul-match-card' });
        append(soul, [
            element('span', { className: 'yl-soul-match-orbit', text: '✦' }),
            element('strong', { text: '灵魂匹配' }),
            element('span', { text: '从已保存的个性化关键词权重里，寻找更同频的公开档案。' }),
        ]);
        const soulButton = element('button', { className: 'yl-settings-button yl-soul-match-button', type: 'button', text: ctx.actionBridge.isPending('candidate_match_soul', '') ? '匹配中…' : '开始匹配', disabled: ctx.actionBridge.isPending('candidate_match_soul', '') || typeof ctx.actionBridge.runCandidateMatch !== 'function' });
        listen(soulButton, soulButton, 'click', () => { void runCandidateMatch('soul'); }, ctx.abortController.signal); soul.appendChild(soulButton); tools.appendChild(soul);

        const voice = element('article', { className: 'yl-voice-match-card' });
        append(voice, [element('strong', { text: '描述匹配' }), element('span', { text: '用一段文字说说此刻想遇见怎样的人；这次提取的关键词会优先于本地偏好。' })]);
        const voiceInput = element('textarea', { className: 'yl-settings-control yl-settings-textarea', rows: 3, maxLength: 800, placeholder: '例如：想找一个周末愿意逛展、也能认真听我说话的人。', value: ctx.voiceMatchText, ariaLabel: '描述匹配文字描述' });
        listen(voiceInput, voiceInput, 'input', () => { ctx.voiceMatchText = voiceInput.value; }, ctx.abortController.signal);
        const voiceButton = element('button', { className: 'yl-settings-button', type: 'button', text: ctx.actionBridge.isPending('candidate_match_voice', '') ? '匹配中…' : '开始匹配', disabled: ctx.actionBridge.isPending('candidate_match_voice', '') || typeof ctx.actionBridge.runCandidateMatch !== 'function' });
        listen(voiceButton, voiceButton, 'click', () => { void runCandidateMatch('voice'); }, ctx.abortController.signal); append(voice, [voiceInput, voiceButton]); tools.appendChild(voice);
        section.appendChild(tools);

        const matches = ctx.currentView.matches ?? [];
        const history = element('section', { className: 'yl-match-history', ariaLabel: '已牵手对象' });
        const historyTitle = element('h2', { className: 'yl-match-history-title', text: '已牵手对象' }); history.appendChild(historyTitle);
        if (!matches.length) history.appendChild(ctx.buildEmptyPlaceholder('还没有互相匹配的对象。先试试匹配工具吧。', { tag: 'p', icon: '♥' }));
        for (const match of matches) {
            const card = element('article', { className: 'yl-chat-session yl-match-row' });
            const ring = element('span', { className: 'yl-match-avatar-ring' }); ring.appendChild(ctx.candidateAvatar(match.profile, { imageEnabled: true })); card.appendChild(ring);
            const info = element('div', { className: 'yl-candidate-copy' }); info.appendChild(element('strong', { text: match.profile.昵称 || '未命名对象' }));
            const detail = [match.profile.年龄段, match.profile.城市, match.profile.寻找意图].filter(Boolean).join(' · '); if (detail) info.appendChild(element('span', { text: detail })); card.appendChild(info);
            const session = (ctx.currentView.messageSessions ?? []).find((item) => item.npcUid === match.uid);
            const openMessages = element('button', { className: 'yl-settings-button', type: 'button', text: '聊天' });
            listen(openMessages, openMessages, 'click', () => {
                if (session) ctx.openPrivateChat(session.sessionUid);
                else ctx.setActivePage('messages');
            }, ctx.abortController.signal);
            card.appendChild(openMessages); history.appendChild(card);
        }
        section.appendChild(history);
        return section;
    }
    async function runCandidateMatch(mode) {
        if (typeof ctx.actionBridge.runCandidateMatch !== 'function') { ctx.setFeedback('AI 匹配服务尚未就绪。'); return; }
        const requestId = ++ctx.interactionGeneration;
        const pageAtStart = ctx.activePage;
        const modeLabel = mode === 'soul' ? '灵魂匹配' : '描述匹配';
        const runningMessage = modeLabel + '中……';
        const activityHandle = ctx.operationActivity.start(modeLabel, runningMessage);
        const operationToken = ctx.showRomanceLoading(modeLabel, runningMessage);
        ctx.renderPage();
        let result;
        try { result = await ctx.actionBridge.runCandidateMatch(mode, { voiceText: ctx.voiceMatchText }); }
        catch { result = { ok: false }; }
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) {
            ctx.operationActivity.dismiss(activityHandle, '提示已关闭，结果未展示。');
            return;
        }
        if (!result?.ok) {
            const message = result?.message || describeActionFailure(result) || modeLabel + '未生成可用结果，请稍后再试。';
            ctx.operationActivity.fail(activityHandle, modeLabel + '未完成，请稍后再试。');
            ctx.showRomanceResult({ title: modeLabel + '未完成', message }, operationToken);
            ctx.renderPage();
            return;
        }
        if (result.matchOutcome === 'declined') {
            ctx.refreshState();
            if (ctx.activePage === pageAtStart) ctx.setActivePage('matches', { preserveOperation: true });
            const message = '这次没有达到彼此的互动节奏，对方已婉拒，先把心意留在这里吧。';
            ctx.operationActivity.fail(activityHandle, modeLabel + '未匹配成功。');
            ctx.showRomanceResult({ declined: true, title: '这次暂未牵手', message }, operationToken);
            return;
        }
        const accepted = result.matchOutcome === 'accepted'
            || (!result.matchOutcome && Boolean(result.npcUid && result.sessionUid));
        if (!accepted || !result.npcUid || !result.sessionUid) {
            ctx.refreshState();
            if (ctx.activePage === pageAtStart) ctx.setActivePage('matches', { preserveOperation: true });
            ctx.operationActivity.fail(activityHandle, modeLabel + '结果缺少可用会话。');
            ctx.showRomanceResult({ title: modeLabel + '未完成', message: '匹配结果缺少可用会话，本次没有进入消息。' }, operationToken);
            return;
        }
        ctx.refreshState();
        if (ctx.activePage === pageAtStart) ctx.openPrivateChat(result.sessionUid, { preserveOperation: true });
        const successMessage = modeLabel + '成功，两颗心已经靠近。';
        ctx.operationActivity.succeed(activityHandle, modeLabel + '成功，已打开私聊。');
        ctx.showRomanceResult({ accepted: true, title: '心动连接成功', message: successMessage }, operationToken);
    }
    return {
        buildMatchesPage,
        runCandidateMatch,
    };
}

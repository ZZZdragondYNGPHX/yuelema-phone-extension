// 约伴/专属服务台页面：从 src/app-shell.js 纯搬移而来，函数体逐行未改，仅将跨模块引用改为 ctx.*。
import { append, element, listen } from '../dom.js';
import { describeActionFailure } from '../ui-model.js';
import { createUiIcon } from '../ui/icon.js';

const SERVICE_ORDER_UID_PATTERN = /^service_[A-Za-z0-9_-]{1,64}$/u;
const SERVICE_PROFILE_SLOT_COUNT = 3;
const SERVICE_PROFILE_MAX_RETRIES = 3;
// 美人团外卖参考卡的三类商品结构；仅借用分类语义，不继承其中与本项目成年人、同意和隐私规则冲突的内容。
const SERVICE_PRODUCT_CATEGORIES = Object.freeze([
    Object.freeze({ id: 'girl_shuren', label: '熟人商品', note: '虚构的成年熟人关系；不映射现实具体个人，仍须当次确认。' }),
    Object.freeze({ id: 'girl_luren', label: '路人商品', note: '虚构的成年陌生人邂逅；不使用现实可识别人物。' }),
    Object.freeze({ id: 'random_generation', label: '随机商品', note: '按你的偏好随机组合的虚构成年都市角色。' }),
]);
const SERVICE_HUB_TABS = Object.freeze([
    Object.freeze({ id: 'home', label: '首页', iconName: 'home' }),
    Object.freeze({ id: 'discover', label: '发现', iconName: 'sparkle' }),
    Object.freeze({ id: 'service', label: '服务', iconName: 'service_hub' }),
    Object.freeze({ id: 'history', label: '历史', iconName: 'clock' }),
]);

export function createServicePage(ctx) {
    function serviceHubModeCopy(mode = ctx.currentView.mode) {
        const nsfw = mode === 'NSFW';
        return Object.freeze({
            label: nsfw ? 'NSFW · 夜色模式' : 'SFW · 心动模式',
            title: nsfw ? '夜色心动档案' : '今日心动档案',
            subtitle: nsfw
                ? '先选择想认识的成年人角色原型；NSFW 只调整虚构成人表达的尺度，仍需逐人、当次确认。'
                : '先选择想认识的成年人角色原型；SFW 会生成恋爱与日常向的相处可能，不自动下单或发送。',
            categories: SERVICE_PRODUCT_CATEGORIES,
        });
    }
    function serviceCategory(copy, categoryId) { return copy.categories.find((category) => category.id === categoryId) ?? copy.categories[0] ?? null; }
    function normalizeServiceXpSearch(value) {
        return String(value ?? '').replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 80);
    }
    function serviceCreativeBrief(category, mode, xpSearch = '') {
        const label = category?.label || '成年人角色原型';
        const search = normalizeServiceXpSearch(xpSearch);
        const xpConstraint = search ? ` 用户想探索的 XP 方向为「${search}」，只能把它作为虚构创作灵感，不得把它写成现实身份、默认同意或强迫情节。` : '';
        const categoryConstraint = category?.id === 'girl_shuren'
            ? '关系只能是虚构的成年人熟人背景，不得把现实具体个人、既有伴侣或亲友直接代入。'
            : category?.id === 'girl_luren'
                ? '人物必须是虚构、不可识别的成年人陌生人，不得仿写现实名人或真实个人。'
                : '人物由偏好随机组合为虚构的成年人现代都市角色，不得引用受版权保护的具名角色。';
        return mode === 'NSFW'
            ? `创作一名明确成年、现代都市中的「${label}」人物原型角色。只写公开资料；人物应主动、鲜明且直白地表现已确认的成人取向与虚构文字角色扮演偏好，但不得默认同意。不得出现未成年人、胁迫或非自愿内容。${categoryConstraint}${xpConstraint}`
            : `创作一名明确成年、现代都市中的「${label}」人物原型角色。只写公开资料；人物应自然、温柔且适合恋爱与日常陪伴剧情。不得出现成人色情内容、未成年人、胁迫或非自愿内容。${categoryConstraint}${xpConstraint}`;
    }
    function serviceProfileName(profile) {
        const name = profile?.candidate?.公开资料?.昵称 ?? profile?.profile?.昵称;
        return typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : '本地服务角色';
    }
    function serviceProfileCategoryLabel(profile) {
        return serviceCategory(serviceHubModeCopy(profile?.mode), profile?.categoryId)?.label || (typeof profile?.category === 'string' && profile.category.trim() ? profile.category.trim().slice(0, 80) : '成年人陪伴');
    }
    function serviceExperienceDraft(profileOrProfiles, mode, orderUid) {
        const profiles = Array.isArray(profileOrProfiles) ? profileOrProfiles : [profileOrProfiles];
        const names = profiles.map(serviceProfileName).filter(Boolean).join('、') || '已确认成年人角色';
        const category = serviceProfileCategoryLabel(profiles[0]);
        const orderReference = SERVICE_ORDER_UID_PATTERN.test(orderUid ?? '') ? '【本次新建的待确认订单】' : '';
        return mode === 'NSFW'
            ? `${orderReference}我选择与「${names}」进行「${category}」主题的虚构成人服务角色扮演。请依据本次订单，在正文中让每位明确成年人分别、自愿地协商结构化主题、允许项、排除项、强度与隐私处理；玩家确认接单后才推进为进行中。仅记录本次所需的最小摘要，不展示内部订单编号。` :
            `${orderReference}我想与「${names}」体验「${category}」租借陪伴主题。请依据本次订单，在正文中让每位明确成年人分别、自愿地协商结构化主题、允许项、排除项、时间与隐私处理；玩家确认接单后才推进为进行中。仅记录本次所需的最小摘要，不展示内部订单编号。`;
    }
    function serviceBatchKey(mode, categoryId, xpSearch = '') {
        const search = normalizeServiceXpSearch(xpSearch);
        return search ? `${mode}:${categoryId}:xp:${search.toLocaleLowerCase('zh-CN')}` : `${mode}:${categoryId}`;
    }
    function profilesForServiceBatch(mode, categoryId, { readyOnly = false, xpSearch = '' } = {}) {
        const search = normalizeServiceXpSearch(xpSearch);
        return ctx.serviceLocalProfiles.filter((profile) => profile.mode === mode && profile.categoryId === categoryId && normalizeServiceXpSearch(profile.xpSearch) === search && (!readyOnly || profile.ready === true));
    }
    function serviceBatchProgress(mode, categoryId, xpSearch = '') {
        const batch = ctx.serviceGenerationBatches.get(serviceBatchKey(mode, categoryId, xpSearch));
        return batch ? batch.profiles.length : 0;
    }
    function candidateNameKey(candidate) {
        const name = candidate?.公开资料?.昵称;
        return typeof name === 'string' ? name.trim().toLocaleLowerCase('zh-CN') : '';
    }
    async function generateLocalServiceProfiles(categoryId = '', { refresh = false, xpSearch = '' } = {}) {
        const normalizedXpSearch = normalizeServiceXpSearch(xpSearch);
        if (ctx.serviceProfileGenerationPending) return;
        if (typeof ctx.actionBridge.generateServiceProfileDraft !== 'function') { ctx.setFeedback('约伴服务角色生成功能尚未就绪。'); return; }
        const requestMode = ctx.currentView.mode;
        const category = serviceCategory(serviceHubModeCopy(requestMode), categoryId);
        if (!category) { ctx.setFeedback('请选择有效的服务分类。'); return; }
        const batchKey = serviceBatchKey(requestMode, category.id, normalizedXpSearch);
        const existing = ctx.serviceGenerationBatches.get(batchKey);
        if (existing?.complete && !refresh) return;
        const batch = existing && !existing.complete
            ? existing
            : { key: batchKey, batchId: `${batchKey}:${++ctx.serviceGenerationBatchSequence}`, mode: requestMode, categoryId: category.id, xpSearch: normalizedXpSearch, profiles: [], complete: false, failedSlot: 0 };
        ctx.serviceGenerationBatches.set(batchKey, batch);
        const requestId = ++ctx.interactionGeneration;
        const requestAbortController = new AbortController();
        ctx.serviceProfileGenerationAbortController = requestAbortController;
        ctx.serviceProfileGenerationPending = true;
        const operationToken = ctx.setFeedback(`正在为「${category.label}」依次生成第 ${batch.profiles.length + 1} 位本地角色草稿…`); ctx.renderPage();
        try {
            for (let slot = batch.profiles.length + 1; slot <= SERVICE_PROFILE_SLOT_COUNT; slot += 1) {
                let accepted = null;
                for (let attempt = 1; attempt <= SERVICE_PROFILE_MAX_RETRIES; attempt += 1) {
                    if (requestAbortController.signal.aborted || ctx.currentView.mode !== requestMode) break;
                    const result = await ctx.actionBridge.generateServiceProfileDraft({
                        creativeBrief: `${serviceCreativeBrief(category, requestMode, normalizedXpSearch)} 这是本批第 ${slot} 位；与已生成角色保持不同的公开身份、昵称与兴趣。`,
                        expectedContentMode: requestMode,
                        signal: requestAbortController.signal,
                    });
                    if (requestAbortController.signal.aborted || ctx.isDestroyed || requestId !== ctx.interactionGeneration || ctx.currentView.mode !== requestMode) break;
                    const duplicate = result?.ok && result?.candidate && batch.profiles.some((profile) => candidateNameKey(profile.candidate) === candidateNameKey(result.candidate));
                    if (result?.ok && result?.candidate && !duplicate) { accepted = result; break; }
                    if (!result?.retryable && !duplicate) break;
                }
                if (!accepted) { batch.failedSlot = slot; break; }
                const profile = { id: `service_local_${++ctx.serviceProfileSequence}`, candidate: accepted.candidate, mode: requestMode, categoryId: category.id, xpSearch: normalizedXpSearch, orderUid: '', ready: false, batchId: batch.batchId };
                batch.profiles.push(profile);
                ctx.serviceLocalProfiles.push(profile);
                if (!ctx.isDestroyed && requestId === ctx.interactionGeneration && ctx.currentView.mode === requestMode) {
                    ctx.setFeedback(`第 ${slot} 位角色已通过格式校验，正在继续生成下一位…`, operationToken);
                    ctx.renderPage();
                }
            }
        } catch { batch.failedSlot = Math.max(1, batch.profiles.length + 1); }
        if (ctx.serviceProfileGenerationAbortController === requestAbortController) {
            ctx.serviceProfileGenerationAbortController = null;
            ctx.serviceProfileGenerationPending = false;
        }
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
        if (ctx.currentView.mode !== requestMode || requestAbortController.signal.aborted) {
            ctx.setFeedback('本批未完成的生成已停止；已通过校验的候补仍保留在所属模式中。', operationToken); ctx.renderPage(); return;
        }
        if (batch.profiles.length === SERVICE_PROFILE_SLOT_COUNT) {
            batch.complete = true;
            batch.failedSlot = 0;
            const retained = ctx.serviceLocalProfiles.filter((profile) => profile.mode !== requestMode || profile.categoryId !== category.id || normalizeServiceXpSearch(profile.xpSearch) !== normalizedXpSearch);
            ctx.selectedServiceProfileIds.clear();
            for (const profile of batch.profiles) profile.ready = true;
            ctx.serviceLocalProfiles.splice(0, ctx.serviceLocalProfiles.length, ...retained.slice(-24), ...batch.profiles);
            ctx.activeServiceHubTab = 'discover'; ctx.activeServiceCategoryId = category.id;
            ctx.setFeedback('已依次生成 3 位本地服务角色；现在可选择其中一位创建服务记录。', operationToken); ctx.renderPage(); return;
        }
        ctx.setFeedback(`第 ${batch.failedSlot || batch.profiles.length + 1} 位尚未生成成功；已通过校验的 ${batch.profiles.length} 位候补已保留。可重试剩余席位。`, operationToken);
        ctx.renderPage();
    }
    function appendServiceExperienceDraft(profile, mode, orderUid, operationToken = null, successMessage = '已复制角色、创建待确认服务记录并填入正文草稿；未自动发送。', operationEpoch = ctx.serviceOrderOperationEpoch) {
        if (!SERVICE_ORDER_UID_PATTERN.test(orderUid ?? '')) { ctx.setFeedback(describeActionFailure({ code: 'service_order_result_invalid' }), operationToken); return false; }
        if (!ctx.canAppendServiceExperienceDraft(mode, operationEpoch)) return false;
        if (mode !== 'SFW' && mode !== 'NSFW' || ctx.currentView.mode !== mode) {
            ctx.setFeedback('内容模式已改变；服务记录已同步，但未填入正文草稿。', operationToken);
            return false;
        }
        if (typeof ctx.actionBridge.appendMeetupDraft !== 'function') { ctx.setFeedback('服务记录已写入 MVU，但当前无法接管酒馆输入框。', operationToken); return false; }
        const handoff = ctx.actionBridge.appendMeetupDraft(serviceExperienceDraft(profile, mode, orderUid));
        if (handoff?.ok) { ctx.setFeedback(successMessage, operationToken); return true; }
        ctx.setFeedback('服务记录已写入 MVU，但没有找到酒馆输入框；可稍后再次填入。', operationToken); return false;
    }
    function localServiceOrder(profile) {
        if (!profile?.orderUid || !Array.isArray(ctx.currentView.serviceOrders)) return null;
        return ctx.currentView.serviceOrders.find((order) => order.id === profile.orderUid) ?? null;
    }
    function isTerminalServiceOrder(order) { return order?.status === '已完成' || order?.status === '已取消'; }
    function selectedServiceProfiles(categoryId) {
        return profilesForServiceBatch(ctx.currentView.mode, categoryId, { readyOnly: true, xpSearch: ctx.serviceXpSearchApplied }).filter((profile) => ctx.selectedServiceProfileIds.has(profile.id) && !profile.orderUid);
    }
    function toggleServiceProfileSelection(profile) {
        if (!profile || profile.mode !== ctx.currentView.mode || profile.categoryId !== ctx.activeServiceCategoryId || normalizeServiceXpSearch(profile.xpSearch) !== ctx.serviceXpSearchApplied || profile.orderUid) return;
        if (ctx.selectedServiceProfileIds.has(profile.id)) ctx.selectedServiceProfileIds.delete(profile.id);
        else ctx.selectedServiceProfileIds.add(profile.id);
        ctx.renderPage();
    }
    async function createServiceOrderFromSelectedProfiles(category) {
        const profiles = selectedServiceProfiles(category?.id);
        if (!category || !profiles.length || ctx.serviceProfileHandoffPendingId) { ctx.setFeedback('请先选择 1 至 3 位当前分类的候补角色。'); return; }
        if (typeof ctx.actionBridge.runServiceOrderHandoff !== 'function') { ctx.setFeedback('专属服务 MVU 桥接尚未就绪；本地角色仍未写入。'); return; }
        const requestMode = ctx.currentView.mode;
        if (ctx.currentView.serviceOrders.some((order) => ['待确认', '进行中'].includes(order.status))) { ctx.setFeedback('当前已有一笔待确认或进行中的服务订单。'); return; }
        const requestId = ++ctx.interactionGeneration; const operationEpoch = ctx.serviceOrderOperationEpoch; ctx.serviceProfileHandoffPendingId = serviceBatchKey(requestMode, category.id, ctx.serviceXpSearchApplied);
        const operationToken = ctx.setFeedback(`正在复制 ${profiles.length} 位角色并创建待确认服务记录…`); ctx.renderPage(); let result;
        try { result = await ctx.actionBridge.runServiceOrderHandoff({ candidates: profiles.map((profile) => profile.candidate), categoryId: category.id, expectedContentMode: requestMode }); } catch { result = { ok: false }; }
        ctx.serviceProfileHandoffPendingId = '';
        if (!result?.ok || !SERVICE_ORDER_UID_PATTERN.test(result.orderUid ?? '') || !Array.isArray(result.npcUids) || result.npcUids.length !== profiles.length) {
            if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
            ctx.setFeedback(result?.ok ? describeActionFailure({ code: 'service_order_result_invalid' }) : (result?.message || describeActionFailure(result)), operationToken); ctx.renderPage(); return;
        }
        for (const profile of profiles) { profile.orderUid = result.orderUid; ctx.selectedServiceProfileIds.delete(profile.id); }
        ctx.refreshState();
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
        if (ctx.currentView.mode !== requestMode) { ctx.setFeedback('内容模式已改变；已创建待确认服务记录，但未填入正文草稿。', operationToken); return; }
        appendServiceExperienceDraft(profiles, requestMode, result.orderUid, operationToken, undefined, operationEpoch);
    }
    async function repeatServiceOrder(order) {
        if (!order?.id || ctx.serviceOrderRepeatPendingId) return;
        if (typeof ctx.actionBridge.runServiceOrderRepeat !== 'function') { ctx.setFeedback('历史再次下单的 MVU 桥接尚未就绪。'); return; }
        const requestMode = order.mode;
        if (ctx.currentView.mode !== requestMode) { ctx.setFeedback('内容模式已改变，请在当前模式重新选择历史服务。'); ctx.renderPage(); return; }
        const requestId = ++ctx.interactionGeneration; const operationEpoch = ctx.serviceOrderOperationEpoch; ctx.serviceOrderRepeatPendingId = order.id;
        const operationToken = ctx.setFeedback('正在创建新的待确认服务记录…'); ctx.renderPage(); let result;
        try { result = await ctx.actionBridge.runServiceOrderRepeat({ sourceOrderUid: order.id, expectedContentMode: requestMode }); } catch { result = { ok: false }; }
        ctx.serviceOrderRepeatPendingId = '';
        if (!result?.ok) {
            if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
            ctx.setFeedback(result?.message || describeActionFailure(result), operationToken); ctx.renderPage(); return;
        }
        if (!SERVICE_ORDER_UID_PATTERN.test(result.orderUid ?? '')) {
            ctx.refreshState();
            if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
            ctx.setFeedback(describeActionFailure({ code: 'service_order_result_invalid' }), operationToken); ctx.renderPage(); return;
        }
        ctx.refreshState();
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
        if (ctx.currentView.mode !== requestMode) { ctx.setFeedback('内容模式已改变；已创建新的待确认服务记录，但未填入正文草稿。', operationToken); return; }
        appendServiceExperienceDraft(order, requestMode, result.orderUid, operationToken, '已创建新的待确认服务记录并填入正文草稿；未自动发送。', operationEpoch);
    }
    function buildServiceHubCard(title, note, tags = []) {
        const card = element('article', { className: 'yl-service-card' }); append(card, [element('strong', { text: title }), element('p', { text: note })]);
        if (tags.length) { const row = element('div', { className: 'yl-service-tags' }); for (const tag of tags) row.appendChild(element('span', { text: tag })); card.appendChild(row); } return card;
    }
    function buildLocalServiceProfileCard(profile) {
        const publicProfile = profile?.candidate?.公开资料 ?? {}; const name = serviceProfileName(profile); const category = serviceCategory(serviceHubModeCopy(), profile.categoryId)?.label || '成年人陪伴';
        const card = buildServiceHubCard(name, typeof publicProfile.简介 === 'string' && publicProfile.简介 ? publicProfile.简介 : '该角色只保留公开摘要，尚未复制到 MVU。', [category, typeof publicProfile.年龄段 === 'string' ? publicProfile.年龄段 : '明确成年人', ...(Array.isArray(publicProfile.兴趣标签) ? publicProfile.兴趣标签.slice(0, 2) : [])]);
        card.classList.toggle('yl-local-service-profile', true); const order = localServiceOrder(profile); const pending = Boolean(ctx.serviceProfileHandoffPendingId);
        if (profile.orderUid) {
            const terminal = isTerminalServiceOrder(order); const waitingForOrder = !order;
            const actionText = terminal ? '前往历史记录' : waitingForOrder ? '等待服务记录同步' : '再次填入正文草稿';
            const action = element('button', { className: 'yl-settings-button', type: 'button', name: `service-profile-${profile.id}`, disabled: pending || waitingForOrder, text: actionText });
            listen(action, action, 'click', () => { if (terminal) { ctx.activeServiceHubTab = 'history'; ctx.renderPage(); } else if (order) { appendServiceExperienceDraft(order, order.mode, order.id); ctx.renderPage(); } }, ctx.abortController.signal); card.appendChild(action);
            return card;
        }
        const selected = ctx.selectedServiceProfileIds.has(profile.id);
        const select = element('button', { className: 'yl-settings-button', type: 'button', name: `service-profile-select-${profile.id}`, disabled: pending, text: selected ? '已选择（取消选择）' : '选择此角色' });
        select.setAttribute('aria-pressed', String(selected)); listen(select, select, 'click', () => toggleServiceProfileSelection(profile), ctx.abortController.signal); card.appendChild(select);
        return card;
    }
    function buildServiceProfileGenerator(category, xpSearch = '') {
        const search = normalizeServiceXpSearch(xpSearch);
        const progress = category ? serviceBatchProgress(ctx.currentView.mode, category.id, search) : 0;
        const title = category ? `生成「${category.label}」本地角色` : '选择人物类别后生成本地角色';
        const note = search ? `按固定三席串行生成，应用本次 XP 搜索但不保存该搜索词。当前进度：${progress}/3。` : `按固定三席串行生成；每位一通过格式校验便保留在当前模式候补池。当前进度：${progress}/3。三席齐全后才开放选择。`;
        const card = buildServiceHubCard(title, note, search ? ['本地草稿', 'XP 搜索', '先确认后复制'] : ['本地草稿', '串行三席', '先确认后复制']);
        const complete = Boolean(category && ctx.serviceGenerationBatches.get(serviceBatchKey(ctx.currentView.mode, category.id, search))?.complete);
        const text = ctx.serviceProfileGenerationPending ? '正在生成…' : complete ? '刷新 3 位本地角色' : progress > 0 && progress < SERVICE_PROFILE_SLOT_COUNT ? `重试剩余第 ${progress + 1} 位` : '批量生成 3 位角色';
        const generate = element('button', { className: 'yl-settings-button yl-service-generate-button', type: 'button', name: 'service-profile-generate', disabled: ctx.serviceProfileGenerationPending || !category, text });
        listen(generate, generate, 'click', () => { if (category) void generateLocalServiceProfiles(category.id, { refresh: complete, xpSearch: search }); }, ctx.abortController.signal); card.appendChild(generate); return card;
    }
    function serviceOrdersForCurrentMode() { return Array.isArray(ctx.currentView.serviceOrders) ? ctx.currentView.serviceOrders.filter((order) => order.mode === ctx.currentView.mode) : []; }
    function serviceParticipantCount(order) { return Array.isArray(order?.profiles) && order.profiles.length ? order.profiles.length : 1; }
    function defaultServiceBoundaries(order) {
        const participantCount = serviceParticipantCount(order);
        const initial = { 内容模式: order?.mode, 主题: order?.topic || '', 允许项: '由双方在正文中确认的内容', 排除项: '未明确同意的内容', 强度: order?.mode === 'NSFW' ? '由双方协商' : '轻松陪伴', 隐私处理: '仅保留最小化订单摘要', 服务信息: { 价格: '', 时长: '', 排期: '', 套餐: '', 评价: '', 投诉: '', 退款: '', 服务者信用: '' }, 玩家已同意: false, NPC明确同意: Array(participantCount).fill(false) };
        const saved = ctx.serviceBoundaryDrafts.get(order?.id);
        if (!saved) return initial;
        return { ...initial, ...saved, 内容模式: order?.mode, 服务信息: { ...initial.服务信息, ...(saved.服务信息 && typeof saved.服务信息 === 'object' ? saved.服务信息 : {}) }, NPC明确同意: Array.isArray(saved.NPC明确同意) && saved.NPC明确同意.length === participantCount ? [...saved.NPC明确同意].map((item) => item === true) : initial.NPC明确同意 };
    }
    function readServiceBoundaryDraft(order) { const draft = defaultServiceBoundaries(order); return { ...draft, 服务信息: { ...draft.服务信息 }, NPC明确同意: [...draft.NPC明确同意] }; }
    function serviceBoundariesConsented(order) { const draft = defaultServiceBoundaries(order); return draft.玩家已同意 === true && Array.isArray(draft.NPC明确同意) && draft.NPC明确同意.length === serviceParticipantCount(order) && draft.NPC明确同意.every((item) => item === true); }
    function createServiceBoundaryEditor(order) {
        const wrap = element('section', { className: 'yl-service-boundary-editor' });
        wrap.appendChild(element('strong', { text: '确认本次服务边界' }));
        wrap.appendChild(element('p', { text: '确认前，须在正文完成本次协商；玩家与每位参与的明确成年人都要逐人确认。结构化记录不会自动发送正文。' }));
        const draft = defaultServiceBoundaries(order);
        for (const field of ['主题', '允许项', '排除项', '强度', '隐私处理']) {
            const input = element('input', { className: 'yl-settings-control', type: 'text', name: 'service-boundary-' + field, value: draft[field] || '', ariaLabel: field });
            listen(input, input, 'input', () => { const next = readServiceBoundaryDraft(order); next[field] = String(input.value ?? '').slice(0, 240); ctx.serviceBoundaryDrafts.set(order.id, next); }, ctx.abortController.signal);
            const row = element('label', { className: 'yl-settings-field' }); append(row, [element('span', { text: field }), input]); wrap.appendChild(row);
        }
        wrap.appendChild(element('strong', { text: '服务信息（仅本次订单合同，不写入本地历史）' }));
        for (const field of ['价格', '时长', '排期', '套餐', '评价', '投诉', '退款', '服务者信用']) {
            const input = element('input', { className: 'yl-settings-control', type: 'text', name: 'service-information-' + field, value: draft.服务信息?.[field] || '', ariaLabel: field });
            listen(input, input, 'input', () => { const next = readServiceBoundaryDraft(order); next.服务信息[field] = String(input.value ?? '').slice(0, 120); ctx.serviceBoundaryDrafts.set(order.id, next); }, ctx.abortController.signal);
            const row = element('label', { className: 'yl-settings-field' }); append(row, [element('span', { text: field }), input]); wrap.appendChild(row);
        }
        const playerConfirm = element('input', { type: 'checkbox', name: 'service-boundary-player-consent', checked: draft.玩家已同意 === true, ariaLabel: '玩家已同意本次服务主题与边界' });
        listen(playerConfirm, playerConfirm, 'change', () => { const next = readServiceBoundaryDraft(order); next.玩家已同意 = Boolean(playerConfirm.checked); ctx.serviceBoundaryDrafts.set(order.id, next); ctx.renderPage(); }, ctx.abortController.signal);
        const playerRow = element('label', { className: 'yl-settings-field yl-service-consent-check' }); append(playerRow, [playerConfirm, element('span', { text: '我已同意本次服务主题与结构化边界' })]); wrap.appendChild(playerRow);
        const profiles = Array.isArray(order?.profiles) && order.profiles.length ? order.profiles : [order?.profile];
        profiles.forEach((profile, index) => {
            const name = typeof profile?.昵称 === 'string' && profile.昵称.trim() ? profile.昵称.trim().slice(0, 80) : `第 ${index + 1} 位参与者`;
            const npcConfirm = element('input', { type: 'checkbox', name: `service-boundary-npc-consent-${index + 1}`, checked: draft.NPC明确同意[index] === true, ariaLabel: `${name}已在正文明确同意` });
            listen(npcConfirm, npcConfirm, 'change', () => { const next = readServiceBoundaryDraft(order); next.NPC明确同意[index] = Boolean(npcConfirm.checked); ctx.serviceBoundaryDrafts.set(order.id, next); ctx.renderPage(); }, ctx.abortController.signal);
            const npcRow = element('label', { className: 'yl-settings-field yl-service-consent-check' }); append(npcRow, [npcConfirm, element('span', { text: `我已在正文取得「${name}」的明确同意` })]); wrap.appendChild(npcRow);
        });
        return wrap;
    }
    async function archiveAndFinalizeServiceOrder(order, status) {
        if (!order || ctx.serviceOrderMutationPendingId || !ctx.serviceOrderHistoryStore?.stage) return;
        if (order.mode !== ctx.currentView.mode) return;
        if (status === '已完成' && order.completionReady !== true) {
            ctx.setFeedback('正文尚未写入完整的结束条件；订单会保持进行中，直到正文标记结束。');
            return;
        }
        const staged = ctx.serviceOrderHistoryStore.stage(order, { status });
        if (!staged) { ctx.setFeedback('本地最小历史写入失败，未修改 MVU 订单。'); return; }
        const requestId = ++ctx.interactionGeneration; ctx.serviceOrderMutationPendingId = order.id;
        const token = ctx.setFeedback(status === '已取消' ? '正在取消并归档订单…' : '正在完成并归档订单…'); ctx.renderPage();
        const transition = status === '已取消' ? ctx.actionBridge.runServiceOrderCancel : ctx.actionBridge.runServiceOrderComplete;
        let result;
        try { result = await transition?.({ orderUid: order.id, expectedContentMode: order.mode }); } catch { result = { ok: false }; }
        if (!result?.ok) { ctx.serviceOrderMutationPendingId = ''; if (!ctx.isDestroyed && requestId === ctx.interactionGeneration) { ctx.setFeedback(describeActionFailure(result), token); ctx.renderPage(); } return; }
        ctx.refreshState();
        try { result = await ctx.actionBridge.runServiceOrderFinalize?.({ orderUid: order.id }); } catch { result = { ok: false }; }
        if (result?.ok) ctx.serviceOrderHistoryStore.markArchived(staged.localId);
        ctx.serviceOrderMutationPendingId = '';
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
        ctx.refreshState(); ctx.setFeedback(result?.ok ? '订单已归档至本设备历史，并已从 MVU 开放订单中移除。' : '订单已进入终态；本地已保留待修复归档，稍后可重试。', token); ctx.renderPage();
    }
    async function startServiceOrder(order) {
        if (!order || ctx.serviceOrderMutationPendingId) return;
        const boundaries = readServiceBoundaryDraft(order); const requestId = ++ctx.interactionGeneration; ctx.serviceOrderMutationPendingId = order.id;
        const token = ctx.setFeedback('正在确认服务边界并开始订单…'); ctx.renderPage(); let result;
        try { result = await ctx.actionBridge.runServiceOrderStart?.({ orderUid: order.id, boundaries, expectedContentMode: order.mode }); } catch { result = { ok: false }; }
        ctx.serviceOrderMutationPendingId = '';
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
        if (!result?.ok) { ctx.setFeedback(describeActionFailure(result), token); ctx.renderPage(); return; }
        ctx.serviceBoundaryDrafts.delete(order.id); ctx.refreshState(); ctx.setFeedback('已确认接单；正文剧情现在可以推进。小手机不会自动发送。', token); ctx.renderPage();
    }
    async function rebookServiceHistory(record) {
        if (!record || ctx.serviceOrderMutationPendingId) return;
        const requestId = ++ctx.interactionGeneration; const operationEpoch = ctx.serviceOrderOperationEpoch; ctx.serviceOrderMutationPendingId = record.localId;
        const token = ctx.setFeedback('正在建立新的待确认订单…'); ctx.renderPage(); let result;
        try { result = await ctx.actionBridge.runServiceOrderRebook?.({ npcUids: record.roleUids, categoryId: record.categoryId, expectedContentMode: record.mode }); } catch { result = { ok: false }; }
        ctx.serviceOrderMutationPendingId = '';
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
        if (!result?.ok) { ctx.setFeedback(describeActionFailure(result), token); ctx.renderPage(); return; }
        ctx.refreshState();
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
        ctx.activeServiceHubTab = 'service';
        const createdOrder = ctx.currentView.serviceOrders.find((order) => order?.id === result.orderUid) ?? null;
        if (!createdOrder || ctx.currentView.mode !== record.mode) {
            ctx.setFeedback('已建立新的待确认订单；请重新确认本次边界。', token); ctx.renderPage(); return;
        }
        appendServiceExperienceDraft(createdOrder, record.mode, result.orderUid, token, '已建立新的待确认订单并填入正文草稿；未自动发送。', operationEpoch);
        ctx.renderPage();
    }
    async function finalizePendingServiceHistory(record) {
        if (!record || record.archiveState !== 'pending_archive' || ctx.serviceOrderMutationPendingId || typeof ctx.serviceOrderHistoryStore?.markArchived !== 'function') return;
        if (record.mode !== ctx.currentView.mode) { ctx.setFeedback('请切换回该订单所属内容模式后再继续归档。'); return; }
        const terminal = ctx.currentView.serviceOrders.find((order) => order.id === record.orderUid && order.mode === record.mode && isTerminalServiceOrder(order));
        if (!terminal) {
            const malformed = ctx.currentView.serviceOrderIssues?.some((issue) => issue?.id === record.orderUid);
            if (malformed) { ctx.activeServiceHubTab = 'service'; ctx.setFeedback('该 MVU 订单已损坏；请使用“移除损坏记录”后再处理本地历史。'); ctx.renderPage(); return; }
            ctx.serviceOrderHistoryStore.markArchived(record.localId);
            ctx.setFeedback('未找到需要删除的 MVU 终态订单；已将本地记录标为完成归档。');
            ctx.renderPage();
            return;
        }
        const requestId = ++ctx.interactionGeneration; ctx.serviceOrderMutationPendingId = record.localId;
        const token = ctx.setFeedback('正在继续移除 MVU 终态订单…'); ctx.renderPage(); let result;
        try { result = await ctx.actionBridge.runServiceOrderFinalize?.({ orderUid: terminal.id }); } catch { result = { ok: false }; }
        ctx.serviceOrderMutationPendingId = '';
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
        if (!result?.ok) { ctx.setFeedback(describeActionFailure(result), token); ctx.renderPage(); return; }
        ctx.serviceOrderHistoryStore.markArchived(record.localId);
        ctx.refreshState(); ctx.setFeedback('已完成本地归档，并从 MVU 开放订单中移除。', token); ctx.renderPage();
    }
    async function deleteServiceHistory(record) {
        if (!record || ctx.serviceOrderMutationPendingId) return;
        if (!globalThis.confirm?.('删除后将同时移除本单全部服务角色，且无法恢复。确定删除吗？')) return;
        const requestId = ++ctx.interactionGeneration; ctx.serviceOrderMutationPendingId = record.localId;
        const token = ctx.setFeedback('正在删除历史与服务角色…'); ctx.renderPage(); let result;
        try { result = await ctx.actionBridge.deleteServiceHistoryRoles?.({ npcUids: record.roleUids }); } catch { result = { ok: false }; }
        ctx.serviceOrderMutationPendingId = '';
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
        if (!result?.ok) { ctx.setFeedback(describeActionFailure(result), token); ctx.renderPage(); return; }
        ctx.serviceOrderHistoryStore.remove(record.localId); ctx.refreshState(); ctx.setFeedback('历史与关联服务角色已删除，无法恢复。', token); ctx.renderPage();
    }
    async function repairServiceOrderIssue(issue) {
        if (!issue?.id || ctx.serviceOrderMutationPendingId || typeof ctx.actionBridge.repairServiceOrder !== 'function') return;
        const requestId = ++ctx.interactionGeneration; ctx.serviceOrderMutationPendingId = issue.id;
        const token = ctx.setFeedback('正在移除损坏服务记录…'); ctx.renderPage(); let result;
        try { result = await ctx.actionBridge.repairServiceOrder({ orderUid: issue.id }); } catch { result = { ok: false }; }
        ctx.serviceOrderMutationPendingId = '';
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
        if (!result?.ok) { ctx.setFeedback(describeActionFailure(result), token); ctx.renderPage(); return; }
        ctx.refreshState(); ctx.setFeedback('损坏服务记录已移除；可重新创建服务订单。', token); ctx.renderPage();
    }
    function buildServiceOrderIssueCard(issue) {
        const card = buildServiceHubCard('检测到损坏服务记录', issue?.message || '该记录无法安全显示。', ['已隐藏']);
        const repair = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-order-repair', disabled: ctx.serviceOrderMutationPendingId === issue?.id, text: ctx.serviceOrderMutationPendingId === issue?.id ? '正在修复…' : '移除损坏记录' });
        listen(repair, repair, 'click', () => { void repairServiceOrderIssue(issue); }, ctx.abortController.signal); card.appendChild(repair); return card;
    }
    function buildServiceOrderCard(order) {
        const names = Array.isArray(order?.profiles) ? order.profiles.map((profile) => profile?.昵称).filter(Boolean) : []; const name = names.join('、') || order?.profile?.昵称 || '已复制角色'; const status = order?.status || '待确认'; const note = order?.summary || (status === '待确认' ? '正文中尚未完成每位参与者的明确确认。' : status === '进行中' ? (order?.completionReady ? '正文已标记结束条件，小手机将自动完成并归档。' : '服务正在正文中推进；正文达到结束条件后会自动完成。') : '已由正文更新结果。');
        const card = buildServiceHubCard(name, note, [order.category, status]); card.classList.toggle('yl-service-order-card', true); card.appendChild(element('span', { className: 'yl-service-order-topic', text: order.topic }));
        const time = order.endedAt || order.startedAt || order.initiatedAt; if (time) card.appendChild(element('span', { className: 'yl-service-order-time', text: time }));
        const mutationPending = ctx.serviceOrderMutationPendingId === order.id;
        if (status === '待确认') {
            card.appendChild(createServiceBoundaryEditor(order));
            const actions = element('div', { className: 'yl-service-order-actions' });
            const refill = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-order-refill-draft', disabled: mutationPending, text: '继续协商 / 重新填入草稿' });
            listen(refill, refill, 'click', () => { appendServiceExperienceDraft(order, order.mode, order.id); }, ctx.abortController.signal);
            const consentReady = serviceBoundariesConsented(order);
            const confirm = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-order-start', disabled: mutationPending || !consentReady, text: mutationPending ? '正在确认…' : consentReady ? '确认接单' : '请先逐人确认同意' });
            listen(confirm, confirm, 'click', () => { void startServiceOrder(order); }, ctx.abortController.signal);
            const cancel = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-order-cancel', disabled: mutationPending, text: '取消订单' });
            listen(cancel, cancel, 'click', () => { void archiveAndFinalizeServiceOrder(order, '已取消'); }, ctx.abortController.signal);
            append(actions, [refill, confirm, cancel]); card.appendChild(actions);
        } else if (status === '进行中') {
            const actions = element('div', { className: 'yl-service-order-actions' });
            const draft = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-order-refill-draft', disabled: mutationPending, text: '继续协商 / 重新填入草稿' });
            listen(draft, draft, 'click', () => { appendServiceExperienceDraft(order, order.mode, order.id); }, ctx.abortController.signal);
            const completion = element('p', { className: 'yl-service-order-completion', text: order?.completionReady ? '正文已标记完整结束条件，正在自动归档。' : '等待正文写入完整结束条件；小手机不会手动伪造完成。' });
            append(actions, [draft, completion]); card.appendChild(actions);
        }
        if (status === '已完成' || status === '已取消') {
            const pending = ctx.serviceOrderRepeatPendingId === order.id;
            const repeat = element('button', { className: 'yl-settings-button yl-service-repeat-button', type: 'button', name: 'service-order-repeat', disabled: pending, text: pending ? '正在创建新订单…' : '再次下单' });
            repeat.setAttribute('aria-label', `再次下单：${name}`);
            listen(repeat, repeat, 'click', () => { void repeatServiceOrder(order); }, ctx.abortController.signal);
            card.appendChild(repeat);
        }
        return card;
    }
    function buildLocalServiceHistoryCard(record) {
        const name = record?.profile?.昵称 || '已归档服务者'; const card = buildServiceHubCard(name, record?.summary || '仅保留最小化本地订单标记。', [record?.category || '服务', record?.status || '已归档']);
        card.classList.toggle('yl-service-order-card', true); card.appendChild(element('span', { className: 'yl-service-order-topic', text: record?.topic || '' }));
        if (record?.endedAt) card.appendChild(element('span', { className: 'yl-service-order-time', text: record.endedAt }));
        const actions = element('div', { className: 'yl-service-order-actions' }); const pending = ctx.serviceOrderMutationPendingId === record?.localId;
        const needsArchive = record?.archiveState === 'pending_archive';
        const rebook = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-history-rebook', disabled: pending || needsArchive, text: pending ? '正在创建…' : '再次下单' });
        listen(rebook, rebook, 'click', () => { void rebookServiceHistory(record); }, ctx.abortController.signal);
        const remove = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-history-delete', disabled: pending, text: '删除历史与角色' });
        listen(remove, remove, 'click', () => { void deleteServiceHistory(record); }, ctx.abortController.signal);
        if (needsArchive) {
            const finalize = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-history-finalize', disabled: pending, text: pending ? '正在继续归档…' : '继续归档' });
            listen(finalize, finalize, 'click', () => { void finalizePendingServiceHistory(record); }, ctx.abortController.signal);
            append(actions, [finalize, rebook, remove]);
        } else append(actions, [rebook, remove]);
        card.appendChild(actions);
        if (needsArchive) card.appendChild(element('p', { text: '该记录等待与 MVU 终态同步；点击“继续归档”只会重试删除终态订单，不会重新下单。' }));
        return card;
    }
    function buildServicePublicationPanel(copy) {
        const panel = buildServiceHubCard('服务者发布服务', '每个分类各保留当前模式的本地服务发布；刷新会继续使用“约伴服务角色生成”绑定的连接预设，且不会写入 MVU。', ['本地发布', '可刷新']);
        const list = element('div', { className: 'yl-service-publication-list' });
        for (const category of copy.categories) {
            const batch = ctx.serviceGenerationBatches.get(serviceBatchKey(ctx.currentView.mode, category.id));
            const count = profilesForServiceBatch(ctx.currentView.mode, category.id, { readyOnly: true }).length;
            const row = element('div', { className: 'yl-service-publication-row' });
            append(row, [element('strong', { text: category.label }), element('span', { text: count ? `已发布 ${count}/3 位服务者` : '尚无服务者发布' })]);
            const actions = element('div', { className: 'yl-service-order-actions' });
            const open = element('button', { className: 'yl-settings-button', type: 'button', name: `service-published-open-${category.id}`, text: count ? '查看发布' : '生成发布' });
            listen(open, open, 'click', () => {
                ctx.activeServiceCategoryId = category.id;
                ctx.activeServiceHubTab = 'discover';
                ctx.renderPage();
                if (!batch?.complete) void generateLocalServiceProfiles(category.id);
            }, ctx.abortController.signal);
            actions.appendChild(open);
            if (count === SERVICE_PROFILE_SLOT_COUNT && batch?.complete) {
                const refresh = element('button', { className: 'yl-settings-button', type: 'button', name: `service-published-refresh-${category.id}`, disabled: ctx.serviceProfileGenerationPending, text: '刷新发布' });
                listen(refresh, refresh, 'click', () => { void generateLocalServiceProfiles(category.id, { refresh: true }); }, ctx.abortController.signal);
                actions.appendChild(refresh);
            }
            row.appendChild(actions); list.appendChild(row);
        }
        panel.appendChild(list); return panel;
    }
    function buildServiceXpSearchControls(category) {
        const section = element('section', { className: 'yl-service-xp-search', ariaLabel: 'XP 搜索' });
        append(section, [
            element('strong', { text: '搜索想探索的 XP' }),
            element('p', { text: '搜索词只用于本次本地角色草稿，不会写入订单、MVU、历史或运行记录。' }),
        ]);
        const row = element('div', { className: 'yl-service-xp-search-row' });
        const input = element('input', { className: 'yl-settings-control yl-service-xp-search-input', type: 'search', name: 'service-xp-search', maxLength: 80, value: ctx.serviceXpSearchDraft, placeholder: '例如：眼镜、制服、成熟感', ariaLabel: '搜索想探索的 XP' });
        const applySearch = () => {
            const next = normalizeServiceXpSearch(ctx.serviceXpSearchDraft);
            ctx.serviceXpSearchDraft = next;
            ctx.selectedServiceProfileIds.clear();
            ctx.serviceXpSearchApplied = next;
            ctx.renderPage();
            if (next && category && !ctx.serviceGenerationBatches.get(serviceBatchKey(ctx.currentView.mode, category.id, next))?.complete) {
                void generateLocalServiceProfiles(category.id, { xpSearch: next });
            }
        };
        listen(input, input, 'input', () => { ctx.serviceXpSearchDraft = String(input.value ?? '').slice(0, 80); }, ctx.abortController.signal);
        listen(input, input, 'keydown', (event) => { if (event.key === 'Enter') { event.preventDefault?.(); applySearch(); } }, ctx.abortController.signal);
        const search = element('button', { className: 'yl-settings-button yl-service-xp-search-submit', type: 'button', name: 'service-xp-search-submit', disabled: !category || ctx.serviceProfileGenerationPending, text: ctx.serviceProfileGenerationPending ? '生成中…' : '搜索并生成' });
        listen(search, search, 'click', applySearch, ctx.abortController.signal);
        const clear = element('button', { className: 'yl-settings-button yl-service-xp-search-clear', type: 'button', name: 'service-xp-search-clear', disabled: !ctx.serviceXpSearchDraft && !ctx.serviceXpSearchApplied, text: '清除' });
        listen(clear, clear, 'click', () => { ctx.serviceXpSearchDraft = ''; ctx.serviceXpSearchApplied = ''; ctx.selectedServiceProfileIds.clear(); ctx.renderPage(); }, ctx.abortController.signal);
        append(row, [input, search, clear]);
        section.appendChild(row);
        if (ctx.serviceXpSearchApplied) section.appendChild(element('span', { className: 'yl-service-xp-search-active', text: `当前 XP 搜索：${ctx.serviceXpSearchApplied}` }));
        return section;
    }
    function buildServiceHubPage() {
        const copy = serviceHubModeCopy(); const category = serviceCategory(copy, ctx.activeServiceCategoryId); const section = element('section', { className: 'yl-service-hub', ariaLabel: '专属服务小程序' });
        const tabs = element('div', { className: 'yl-service-tabs', ariaLabel: '专属服务导航' }); tabs.setAttribute('role', 'tablist');
        const tabButtons = [];
        const focusServiceHubTab = (tabId) => { ctx.root.querySelectorAll?.(`[name="service-hub-tab-${tabId}"]`)?.[0]?.focus?.(); };
        for (const item of SERVICE_HUB_TABS) {
            const active = ctx.activeServiceHubTab === item.id;
            const tab = element('button', { className: 'yl-service-tab', type: 'button', name: `service-hub-tab-${item.id}`, ariaLabel: item.label });
            tab.setAttribute('role', 'tab');
            tab.setAttribute('id', `yl-service-hub-tab-${item.id}`);
            tab.setAttribute('aria-selected', String(active));
            tab.setAttribute('aria-controls', 'yl-service-hub-panel');
            // roving tabindex：Tab 键只停靠当前激活项，方向键在 tab 之间漫游。
            tab.setAttribute('tabindex', active ? '0' : '-1');
            tab.classList.toggle('is-active', active);
            const tabIcon = element('span', { className: 'yl-service-tab-icon' });
            tabIcon.appendChild(createUiIcon(ctx.documentRef, item.iconName, { className: 'yl-service-tab-svg', size: 18 }));
            append(tab, [tabIcon, element('span', { text: item.label })]);
            listen(tab, tab, 'click', () => { ctx.activeServiceHubTab = item.id; ctx.renderPage(); focusServiceHubTab(item.id); }, ctx.abortController.signal);
            tabs.appendChild(tab); tabButtons.push(tab);
        }
        listen(tabs, tabs, 'keydown', (event) => {
            if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
            const current = tabButtons.indexOf(ctx.documentRef.activeElement);
            const from = current >= 0 ? current : Math.max(0, SERVICE_HUB_TABS.findIndex((entry) => entry.id === ctx.activeServiceHubTab));
            const next = event.key === 'Home' ? 0
                : event.key === 'End' ? tabButtons.length - 1
                    : event.key === 'ArrowRight' ? (from + 1) % tabButtons.length
                        : (from - 1 + tabButtons.length) % tabButtons.length;
            event.preventDefault?.();
            for (let index = 0; index < tabButtons.length; index += 1) tabButtons[index].setAttribute('tabindex', index === next ? '0' : '-1');
            tabButtons[next].focus?.();
        }, ctx.abortController.signal);
        section.appendChild(tabs); const body = element('div', { className: 'yl-service-body' });
        body.setAttribute('role', 'tabpanel');
        body.setAttribute('id', 'yl-service-hub-panel');
        body.setAttribute('aria-labelledby', `yl-service-hub-tab-${ctx.activeServiceHubTab}`);
        if (ctx.activeServiceHubTab === 'home') {
            const hero = element('article', { className: 'yl-service-hero' }); append(hero, [element('span', { className: 'yl-service-mode-badge', text: copy.label }), element('h2', { text: copy.title }), element('p', { text: copy.subtitle })]); body.appendChild(hero);
            const grid = element('div', { className: 'yl-service-category-grid' });
            for (const item of copy.categories) { const button = element('button', { className: 'yl-service-category', type: 'button', name: `service-category-${item.id}`, ariaLabel: `浏览${item.label}` }); append(button, [element('strong', { text: item.label }), element('span', { text: item.note })]); listen(button, button, 'click', () => { ctx.serviceXpSearchDraft = ''; ctx.serviceXpSearchApplied = ''; ctx.activeServiceCategoryId = item.id; ctx.activeServiceHubTab = 'discover'; ctx.renderPage(); if (!ctx.serviceGenerationBatches.get(serviceBatchKey(ctx.currentView.mode, item.id, ''))?.complete) void generateLocalServiceProfiles(item.id, { xpSearch: '' }); }, ctx.abortController.signal); grid.appendChild(button); }
            const confirmationNote = ctx.currentView.mode === 'SFW'
                ? '本页的本地生成结果不会写入 MVU；选中后才会原子复制角色与建立“待确认”服务记录。正文必须先取得每位明确成年人的当前同意；SFW 服务不由小手机安排现实交易或外部行动。'
                : '本页的本地生成结果不会写入 MVU；选中后才会原子复制角色与建立“待确认”服务记录。NSFW 保持明确成年人、自愿与逐人确认；小手机只留存最小订单摘要，绝不自动发送或替任一方作出同意。';
            body.appendChild(grid); body.appendChild(buildServicePublicationPanel(copy)); body.appendChild(buildServiceHubCard('使用前确认', confirmationNote, ['逐次确认', '小手机不自动发送']));
        } else if (ctx.activeServiceHubTab === 'discover') {
            const choices = element('div', { className: 'yl-service-category-grid yl-service-discover-categories' });
            for (const item of copy.categories) { const choice = element('button', { className: 'yl-service-category', type: 'button', name: `service-discover-category-${item.id}`, text: item.label, pressed: ctx.activeServiceCategoryId === item.id }); choice.classList.toggle('is-active', ctx.activeServiceCategoryId === item.id); listen(choice, choice, 'click', () => { ctx.activeServiceCategoryId = item.id; ctx.selectedServiceProfileIds.clear(); ctx.renderPage(); }, ctx.abortController.signal); choices.appendChild(choice); }
            body.appendChild(choices); body.appendChild(buildServiceXpSearchControls(category)); body.appendChild(buildServiceProfileGenerator(category, ctx.serviceXpSearchApplied)); const visibleProfiles = profilesForServiceBatch(ctx.currentView.mode, category?.id, { readyOnly: true, xpSearch: ctx.serviceXpSearchApplied });
            if (!visibleProfiles.length) body.appendChild(buildServiceHubCard('候补尚未开放', `选择上方分类后按三席依次生成；当前已校验 ${category ? serviceBatchProgress(ctx.currentView.mode, category.id, ctx.serviceXpSearchApplied) : 0}/3 位。生成失败只重试当前席位，不清除前序候补。`, ['本地优先']));
            for (const profile of visibleProfiles) body.appendChild(buildLocalServiceProfileCard(profile));
            if (visibleProfiles.length === SERVICE_PROFILE_SLOT_COUNT) {
                const selected = selectedServiceProfiles(category?.id); const hasOpen = ctx.currentView.serviceOrders.some((order) => ['待确认', '进行中'].includes(order.status));
                const create = element('button', { className: 'yl-settings-button yl-service-generate-button', type: 'button', name: 'service-order-create-selected', disabled: !selected.length || hasOpen || Boolean(ctx.serviceProfileHandoffPendingId), text: ctx.serviceProfileHandoffPendingId ? '正在创建订单…' : `以已选 ${selected.length} 位创建服务订单` });
                listen(create, create, 'click', () => { void createServiceOrderFromSelectedProfiles(category); }, ctx.abortController.signal); body.appendChild(create);
            }
        } else if (ctx.activeServiceHubTab === 'service') {
            const active = serviceOrdersForCurrentMode().filter((order) => order.status === '待确认' || order.status === '进行中'); if (!active.length) body.appendChild(buildServiceHubCard('暂无进行中的服务', '从“发现”选择本地角色后才会创建待确认记录。确认角色复制和正文草稿后，仍须由你自行发送并在酒馆正文中推进。', ['不自动发送'])); for (const order of active) body.appendChild(buildServiceOrderCard(order)); for (const issue of (ctx.currentView.serviceOrderIssues || [])) body.appendChild(buildServiceOrderIssueCard(issue)); const boundaryNote = ctx.currentView.mode === 'SFW' ? '多人服务必须由每一位明确成年人分别同意；历史记录、关系或付款信息都不能代替当前同意。' : '多人服务必须由每一位明确成年人分别同意；历史记录、关系或既往主题都不能代替当前同意，NSFW 不会因小手机默认缩减成人表达尺度。'; body.appendChild(buildServiceHubCard('安全边界', boundaryNote, ['禁止默认同意', '禁止胁迫']));
        } else {
            const history = typeof ctx.serviceOrderHistoryStore?.list === 'function' ? ctx.serviceOrderHistoryStore.list({ includeInternal: true }).filter((record) => record.mode === ctx.currentView.mode) : [];
            if (!history.length) body.appendChild(buildServiceHubCard('暂无历史记录', '完成或取消后仅在当前浏览器保存最小记录；再次下单会建立全新的待确认订单，不继承此前边界。', ['重新确认', '最小留存']));
            for (const record of history) body.appendChild(buildLocalServiceHistoryCard(record));
        }
        section.appendChild(body); return section;
    }
    return {
        serviceHubModeCopy,
        serviceCategory,
        normalizeServiceXpSearch,
        serviceCreativeBrief,
        serviceProfileName,
        serviceProfileCategoryLabel,
        serviceExperienceDraft,
        serviceBatchKey,
        profilesForServiceBatch,
        serviceBatchProgress,
        candidateNameKey,
        generateLocalServiceProfiles,
        appendServiceExperienceDraft,
        localServiceOrder,
        isTerminalServiceOrder,
        selectedServiceProfiles,
        toggleServiceProfileSelection,
        createServiceOrderFromSelectedProfiles,
        repeatServiceOrder,
        buildServiceHubCard,
        buildLocalServiceProfileCard,
        buildServiceProfileGenerator,
        serviceOrdersForCurrentMode,
        serviceParticipantCount,
        defaultServiceBoundaries,
        readServiceBoundaryDraft,
        serviceBoundariesConsented,
        createServiceBoundaryEditor,
        archiveAndFinalizeServiceOrder,
        startServiceOrder,
        rebookServiceHistory,
        finalizePendingServiceHistory,
        deleteServiceHistory,
        repairServiceOrderIssue,
        buildServiceOrderIssueCard,
        buildServiceOrderCard,
        buildLocalServiceHistoryCard,
        buildServicePublicationPanel,
        buildServiceXpSearchControls,
        buildServiceHubPage,
    };
}

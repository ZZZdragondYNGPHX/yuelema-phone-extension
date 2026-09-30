// 约伴/专属服务台页面（v1.2.0 双模式）：稳定 tab id「featured｜orders｜records」显示为
// SFW 租伴/租约/记录 或 NSFW 探索/邀约/足迹；精选含本地主题馆、推荐、图鉴、候选详情与选择托盘，
// 订单含合同 v2 三步 Stepper（逐人确认 + 修订号）与暂停/恢复/中止/玩家确认结单。
// 全部写入仍走 ctx.actionBridge 受控管线；本文件只采集不含 UID 的草稿，身份与修订由 builder 派生。
import { append, element, listen } from '../dom.js';
import { describeActionFailure } from '../ui-model.js';
import { createUiIcon } from '../ui/icon.js';
import { createButton } from '../ui/button.js';
import { createListRow } from '../ui/list-row.js';
import { createStatusChip } from '../ui/badge.js';
import { createSkeleton } from '../ui/skeleton.js';
import { buildWaitCaptions } from './shared.js';
import { createServiceContractDraft } from '../service/service-order-contract.js';
import {
    buildServiceSearchView,
    createServiceListingView,
    deriveServiceExplorationAtlas,
    deriveServiceGroupComplementView,
    deriveServiceRecommendations,
    getServiceCategories,
    getServiceHubTabs,
    getServiceModeCopy,
    getServiceScenarioRotation,
    getServiceThemeRotation,
    normalizeServiceHubTab as normalizeServiceHubTabContract,
} from '../service/service-ui-contract.js';

const SERVICE_ORDER_UID_PATTERN = /^service_[A-Za-z0-9_-]{1,64}$/u;
const SERVICE_PROFILE_SLOT_COUNT = 3;
// P3-G 等待期趣味文案（纯 CSS 轮播）：三席串行生成时替代干等。
const SERVICE_WAIT_CAPTIONS = Object.freeze(['管家正在挑选人选…', '核对档期与偏好…', '确认对方明确成年且自愿…', '整理这一席的资料卡…']);
const SERVICE_WAIT_SHIFT_TEXT = '高质量的人选值得多等几秒…';
const SERVICE_PROFILE_MAX_RETRIES = 3;
export function normalizeServiceHubTab(value) {
    return normalizeServiceHubTabContract(value);
}
const SERVICE_BOUNDARY_FIELDS = Object.freeze(['主题', '允许项', '排除项', '强度', '隐私处理']);
const SERVICE_ARRANGEMENT_FIELDS = Object.freeze(['时长', '时间窗', '场景类型', '组合摘要', '虚构价格']);
const SERVICE_ORDER_STEPS_BY_MODE = Object.freeze({
    SFW: Object.freeze([{ step: 1, label: '相处边界' }, { step: 2, label: '约会安排' }, { step: 3, label: '逐人签约' }]),
    NSFW: Object.freeze([{ step: 1, label: '范围与停止' }, { step: 2, label: '节奏与事后' }, { step: 3, label: '逐人共识' }]),
});
const SERVICE_TAB_ICONS = Object.freeze({ featured: 'sparkle', orders: 'service_hub', records: 'clock' });
const SERVICE_BATCH_LRU_LIMIT = 12;

export function createServicePage(ctx) {
    /* —— 安全控制台接线（2026-07-27）——
     * ctx.operationActivity 可能缺席（测试或降级宿主）；缺席时全部静默跳过。
     * 界面提示（setFeedback / describeActionFailure 文案）保持原有粗略文案不变；
     * 具体失败原因只进控制台 detail：错误码、字段名/JSON 路径、校验结论与重试提示。
     * 硬线：detail 不携带 API Key、隐私层字段值、关系分或阈值数值，也不携带
     * 内部订单/角色 UID 的具体值（候选昵称允许出现）；入账时还会再过脱敏器。 */
    const operationConsole = ctx.operationActivity && typeof ctx.operationActivity.start === 'function' ? ctx.operationActivity : null;
    function startConsoleEntry(name, message) {
        if (!operationConsole) return null;
        try { return operationConsole.start(name, message); } catch { return null; }
    }
    function settleConsoleEntry(kind, handle, message, detail = null) {
        if (!operationConsole || !handle) return;
        try { operationConsole[kind](handle, message, { detail }); } catch { /* 控制台不可用时绝不影响功能路径 */ }
    }
    /** 32+ 连续 ASCII token 会被控制台脱敏器视作凭据整体抹除；给长错误码按下划线注入空格保住可读性。 */
    function displayCode(code) {
        const text = typeof code === 'string' ? code : '';
        return text.length >= 32 ? text.replaceAll('_', '_ ').trim() : text;
    }
    /** 单条失败摘要：错误码 + reason/detail（受控管线增量字段）+ 必要时的界面 message。 */
    function serviceFailureSummary(source) {
        if (source instanceof Error) {
            const parts = [source.name || '', typeof source.code === 'string' ? `错误码 ${displayCode(source.code)}` : '', typeof source.message === 'string' ? source.message.slice(0, 160) : ''];
            return parts.filter(Boolean).join('：') || '未知异常';
        }
        if (!source || typeof source !== 'object') return '未知失败';
        const parts = [
            typeof source.code === 'string' && source.code ? `错误码 ${displayCode(source.code)}` : '',
            typeof source.reason === 'string' && source.reason ? source.reason : '',
            typeof source.detail === 'string' && source.detail ? source.detail : '',
        ].filter(Boolean);
        if (!parts.length && typeof source.message === 'string' && source.message) parts.push(source.message);
        return parts.join('；') || '未知失败';
    }
    function serviceFailureDetail(operation, source, { stage = '', hint = '' } = {}) {
        return [
            `操作: ${operation}`,
            stage ? `阶段: ${stage}` : '',
            `原因: ${serviceFailureSummary(source)}`,
            hint ? `提示: ${hint}` : '',
        ].filter(Boolean).join('\n');
    }
    // 页面局部 UI 状态（不进 MVU、不进浏览器存储；关小手机即回收）。
    let servicePublicationOpen = false;
    let openServiceRecordMenuId = '';
    let serviceGeneratingBatchKey = '';
    let activeServiceOrderDetailId = '';
    let serviceCandidateDetailId = '';
    let serviceSelectedFilterIds = [];
    const serviceOrderStepState = new Map();
    function serviceHubModeCopy(mode = ctx.currentView.mode) {
        const base = getServiceModeCopy(mode);
        return Object.freeze({
            ...base,
            label: base.modeBadge,
            categories: getServiceCategories(mode).map((category) => ({ ...category, note: category.definition })),
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
            ? `创作一名明确成年、现代都市中的「${label}」人物原型角色。只写公开资料；这是全尺度色情分类，默认直白写明裸体、身体与器官偏好、自慰、口交、性交、高潮、性玩具、BDSM、多人幻想、情色角色扮演及其他成人玩法，可具体描述动作、感官、语言、强度与身体反应，不得含蓄化、自动转场或淡出。成人尺度不等于替任何参与者默认同意；不得出现未成年人、胁迫或非自愿内容。${categoryConstraint}${xpConstraint}`
            : `创作一名明确成年、现代都市中的「${label}」人物原型角色。只写公开资料；人物应自然、温柔且适合恋爱与日常陪伴剧情。不得出现成人色情内容、未成年人、胁迫或非自愿内容。${categoryConstraint}${xpConstraint}`;
    }
    function serviceProfileName(profile) {
        const name = profile?.candidate?.公开资料?.昵称 ?? profile?.profile?.昵称;
        return typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : '本地约伴角色';
    }
    function serviceProfileCategoryLabel(profile) {
        return serviceCategory(serviceHubModeCopy(profile?.mode), profile?.categoryId)?.label || (typeof profile?.category === 'string' && profile.category.trim() ? profile.category.trim().slice(0, 80) : '成年人陪伴');
    }
    function serviceExperienceDraft(profileOrProfiles, mode, orderUid) {
        const profiles = Array.isArray(profileOrProfiles) ? profileOrProfiles : [profileOrProfiles];
        const names = profiles.map(serviceProfileName).filter(Boolean).join('、') || '已确认成年人角色';
        const category = serviceProfileCategoryLabel(profiles[0]);
        const orderReference = SERVICE_ORDER_UID_PATTERN.test(orderUid ?? '') ? '【本次新建的待确认约伴】' : '';
        return mode === 'NSFW'
            ? `${orderReference}我想与「${names}」探索「${category}」主题的全尺度成年邀约。请让每位明确成年人分别、自愿地协商主题、允许项、排除项、强度、暂停信号、事后相处与隐私处理；玩家逐人确认后才进入进行中。已确认范围可以直白描写，但任何人都可随时暂停、修改或撤回；只保留最小终态摘要，不展示内部编号。` :
            `${orderReference}我想与「${names}」体验「${category}」的一段虚构租借恋人时光。请让每位明确成年人分别、自愿地协商主题、允许项、排除项、节奏、时间与隐私处理；玩家逐人确认后才进入进行中。只保留最小终态摘要，不展示内部编号。`;
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
    function retainRecentServiceBatches(currentKey = '') {
        if (!(ctx.serviceGenerationBatches instanceof Map)) return;
        while (ctx.serviceGenerationBatches.size > SERVICE_BATCH_LRU_LIMIT) {
            const oldestKey = ctx.serviceGenerationBatches.keys().next().value;
            if (oldestKey === undefined) break;
            if (oldestKey === currentKey) {
                const current = ctx.serviceGenerationBatches.get(oldestKey);
                ctx.serviceGenerationBatches.delete(oldestKey);
                ctx.serviceGenerationBatches.set(oldestKey, current);
                continue;
            }
            const evicted = ctx.serviceGenerationBatches.get(oldestKey);
            ctx.serviceGenerationBatches.delete(oldestKey);
            if (evicted?.batchId) {
                const removedIds = new Set(ctx.serviceLocalProfiles.filter((profile) => profile.batchId === evicted.batchId && !profile.orderUid).map((profile) => profile.id));
                ctx.serviceLocalProfiles.splice(0, ctx.serviceLocalProfiles.length, ...ctx.serviceLocalProfiles.filter((profile) => !removedIds.has(profile.id)));
                for (const id of removedIds) ctx.selectedServiceProfileIds.delete(id);
            }
        }
    }
    function candidateNameKey(candidate) {
        const name = candidate?.公开资料?.昵称;
        return typeof name === 'string' ? name.trim().toLocaleLowerCase('zh-CN') : '';
    }
    async function generateLocalServiceProfiles(categoryId = '', { refresh = false, xpSearch = '' } = {}) {
        const normalizedXpSearch = normalizeServiceXpSearch(xpSearch);
        if (ctx.serviceProfileGenerationPending) return;
        if (typeof ctx.actionBridge.generateServiceProfileDraft !== 'function') { ctx.setFeedback('约伴角色生成功能尚未就绪。'); return; }
        const requestMode = ctx.currentView.mode;
        const category = serviceCategory(serviceHubModeCopy(requestMode), categoryId);
        if (!category) { ctx.setFeedback('请选择有效的约伴来源。'); return; }
        const batchKey = serviceBatchKey(requestMode, category.id, normalizedXpSearch);
        const existing = ctx.serviceGenerationBatches.get(batchKey);
        if (existing?.complete && !refresh) return;
        const batch = existing && !existing.complete
            ? existing
            : { key: batchKey, batchId: `${batchKey}:${++ctx.serviceGenerationBatchSequence}`, mode: requestMode, categoryId: category.id, xpSearch: normalizedXpSearch, profiles: [], complete: false, failedSlot: 0 };
        ctx.serviceGenerationBatches.delete(batchKey);
        ctx.serviceGenerationBatches.set(batchKey, batch);
        retainRecentServiceBatches(batchKey);
        const requestId = ++ctx.interactionGeneration;
        const requestAbortController = new AbortController();
        ctx.serviceProfileGenerationAbortController = requestAbortController;
        ctx.serviceProfileGenerationPending = true;
        serviceGeneratingBatchKey = batchKey;
        const operationToken = ctx.setFeedback(`正在为「${category.label}」依次生成第 ${batch.profiles.length + 1} 位本地角色草稿…`); ctx.renderPage();
        const consoleHandle = startConsoleEntry('约伴三席生成', `正在为该分类依次生成第 ${batch.profiles.length + 1} 席本地角色……`);
        const attemptFailures = [];
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
                    // 逐席逐次原因只进控制台 detail；界面提示保持原有粗略文案。
                    attemptFailures.push(`第 ${slot} 席（第 ${attempt} 次）：${duplicate ? `候选昵称「${serviceProfileName({ candidate: result.candidate })}」与已生成角色重复` : serviceFailureSummary(result)}`);
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
        } catch (error) {
            batch.failedSlot = Math.max(1, batch.profiles.length + 1);
            attemptFailures.push(`第 ${batch.failedSlot} 席：${serviceFailureSummary(error)}`);
        }
        if (ctx.serviceProfileGenerationAbortController === requestAbortController) {
            ctx.serviceProfileGenerationAbortController = null;
            ctx.serviceProfileGenerationPending = false;
            serviceGeneratingBatchKey = '';
        }
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) {
            settleConsoleEntry('dismiss', consoleHandle, '生成已中止，结果未展示。');
            return;
        }
        if (ctx.currentView.mode !== requestMode || requestAbortController.signal.aborted) {
            settleConsoleEntry('dismiss', consoleHandle, '生成已停止；已通过校验的候补仍保留。');
            ctx.setFeedback('本批未完成的生成已停止；已通过校验的候补仍保留在所属模式中。', operationToken); ctx.renderPage(); return;
        }
        if (batch.profiles.length === SERVICE_PROFILE_SLOT_COUNT) {
            batch.complete = true;
            batch.failedSlot = 0;
            const retained = ctx.serviceLocalProfiles.filter((profile) => profile.mode !== requestMode || profile.categoryId !== category.id || normalizeServiceXpSearch(profile.xpSearch) !== normalizedXpSearch);
            ctx.selectedServiceProfileIds.clear();
            for (const profile of batch.profiles) profile.ready = true;
            ctx.serviceLocalProfiles.splice(0, ctx.serviceLocalProfiles.length, ...retained.slice(-24), ...batch.profiles);
            ctx.activeServiceHubTab = 'featured'; ctx.activeServiceCategoryId = category.id;
            settleConsoleEntry('succeed', consoleHandle, '已依次生成 3 位本地约伴角色。',
                attemptFailures.length ? `操作: 约伴三席生成\n阶段: 逐席生成（含中途重试）\n${attemptFailures.join('\n')}` : null);
            ctx.setFeedback('已依次生成 3 位本地约伴角色；现在可组成 1–3 位的本轮约伴。', operationToken); ctx.renderPage(); return;
        }
        settleConsoleEntry('fail', consoleHandle, `第 ${batch.failedSlot || batch.profiles.length + 1} 席未生成成功。`,
            [`操作: 约伴三席生成`, `阶段: 逐席生成（已保留 ${batch.profiles.length} 席）`, ...(attemptFailures.length ? attemptFailures : ['原因: 未知失败']), '提示: 可点击“重试剩余席位”继续'].join('\n'));
        ctx.setFeedback(`第 ${batch.failedSlot || batch.profiles.length + 1} 位尚未生成成功；已通过校验的 ${batch.profiles.length} 位候补已保留。可重试剩余席位。`, operationToken);
        ctx.renderPage();
    }
    function appendServiceExperienceDraft(profile, mode, orderUid, operationToken = null, successMessage = '已复制角色、创建待确认约伴并填入正文草稿；未自动发送。', operationEpoch = ctx.serviceOrderOperationEpoch) {
        if (!SERVICE_ORDER_UID_PATTERN.test(orderUid ?? '')) { ctx.setFeedback(describeActionFailure({ code: 'service_order_result_invalid' }), operationToken); return false; }
        if (!ctx.canAppendServiceExperienceDraft(mode, operationEpoch)) return false;
        if (mode !== 'SFW' && mode !== 'NSFW' || ctx.currentView.mode !== mode) {
            ctx.setFeedback('内容模式已改变；约伴记录已同步，但未填入正文草稿。', operationToken);
            return false;
        }
        if (typeof ctx.actionBridge.appendMeetupDraft !== 'function') { ctx.setFeedback('约伴记录已写入 MVU，但当前无法接管酒馆输入框。', operationToken); return false; }
        const handoff = ctx.actionBridge.appendMeetupDraft(serviceExperienceDraft(profile, mode, orderUid));
        if (handoff?.ok) { ctx.setFeedback(successMessage, operationToken); return true; }
        ctx.setFeedback('约伴记录已写入 MVU，但没有找到酒馆输入框；可稍后再次填入。', operationToken); return false;
    }
    // 约伴开始提示词：面向正文的执行草稿，绝不包含内部订单/角色 UID。
    function serviceDealDraft(order, boundaries = null) {
        const profiles = Array.isArray(order?.profiles) && order.profiles.length ? order.profiles : [order?.profile];
        const names = profiles.map((profile) => typeof profile?.昵称 === 'string' && profile.昵称.trim() ? profile.昵称.trim().slice(0, 80) : '').filter(Boolean).join('、') || '已确认成年人角色';
        const category = typeof order?.category === 'string' && order.category.trim() ? order.category.trim().slice(0, 80) : '成年人陪伴';
        const source = boundaries && typeof boundaries === 'object' ? boundaries : null;
        const requirements = [];
        const topic = String(source?.主题 ?? '').trim();
        if (topic) requirements.push(`主题「${topic.slice(0, 240)}」`);
        for (const field of ['允许项', '排除项', '强度', '隐私处理']) {
            const value = String(source?.[field] ?? '').trim();
            if (value) requirements.push(`${field}：${value.slice(0, 240)}`);
        }
        const requirementText = requirements.length ? `本次约伴合同：${requirements.join('；')}。` : '本次内容以每位参与者已确认的结构化合同为准。';
        const closing = '正文认为已到结束节点时，只写入完成候选（附最小摘要与记录时间），等待玩家在小手机确认完成或选择继续；任何撤回先暂停，不自动结单，不展示内部编号。';
        return order?.mode === 'NSFW'
            ? `【约伴确认开始】我已与「${names}」逐人确认「${category}」的本次成年邀约。${requirementText}请只在已确认范围内推进，每位参与者仍可随时暂停、修改或撤回。${closing}`
            : `【约伴确认开始】我已与「${names}」逐人确认「${category}」的本次租借恋人体验。${requirementText}请按已确认节奏推进，并保留随时暂停或调整的空间。${closing}`;
    }
    function appendServiceDealDraft(order, boundaries = null, operationToken = null, operationEpoch = ctx.serviceOrderOperationEpoch, successMessage = '已确认开始并把约伴提示词填入正文输入框；请自行发送，小手机绝不自动发送。') {
        const mode = order?.mode;
        if (!ctx.canAppendServiceExperienceDraft(mode, operationEpoch)) return false;
        if ((mode !== 'SFW' && mode !== 'NSFW') || ctx.currentView.mode !== mode) { ctx.setFeedback('内容模式已改变；约伴已开始，但未填入正文提示词。', operationToken); return false; }
        if (typeof ctx.actionBridge.appendMeetupDraft !== 'function') { ctx.setFeedback('约伴已开始，但当前无法接管酒馆输入框。', operationToken); return false; }
        const handoff = ctx.actionBridge.appendMeetupDraft(serviceDealDraft(order, boundaries));
        if (handoff?.ok) { ctx.setFeedback(successMessage, operationToken); return true; }
        ctx.setFeedback('约伴已开始，但没有找到酒馆输入框；可在详情中重新填入提示词。', operationToken); return false;
    }
    function localServiceOrder(profile) {
        if (!profile?.orderUid || !Array.isArray(ctx.currentView.serviceOrders)) return null;
        return ctx.currentView.serviceOrders.find((order) => order.id === profile.orderUid) ?? null;
    }
    function isTerminalServiceOrder(order) { return ['已完成', '已取消', '已中止'].includes(order?.status); }
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
        if (typeof ctx.actionBridge.runServiceOrderHandoff !== 'function') { ctx.setFeedback('约伴 MVU 桥接尚未就绪；本地角色仍未写入。'); return; }
        const requestMode = ctx.currentView.mode;
        if (ctx.currentView.serviceOrders.some((order) => ['待确认', '进行中', '暂停中'].includes(order.status))) { ctx.setFeedback('当前已有一笔开放约伴；请先处理它再创建新的邀约。'); return; }
        const requestId = ++ctx.interactionGeneration; const operationEpoch = ctx.serviceOrderOperationEpoch; ctx.serviceProfileHandoffPendingId = serviceBatchKey(requestMode, category.id, ctx.serviceXpSearchApplied);
        const operationToken = ctx.setFeedback(`正在复制 ${profiles.length} 位角色并创建待确认约伴…`); ctx.renderPage(); let result;
        const consoleHandle = startConsoleEntry('创建约伴', `正在复制 ${profiles.length} 位角色并创建待确认约伴……`);
        try { result = await ctx.actionBridge.runServiceOrderHandoff({ candidates: profiles.map((profile) => profile.candidate), categoryId: category.id, expectedContentMode: requestMode }); }
        catch (error) { result = { ok: false, thrown: error }; }
        ctx.serviceProfileHandoffPendingId = '';
        if (!result?.ok || !SERVICE_ORDER_UID_PATTERN.test(result.orderUid ?? '') || !Array.isArray(result.npcUids) || result.npcUids.length !== profiles.length) {
            settleConsoleEntry('fail', consoleHandle, '约伴未创建。', serviceFailureDetail('创建约伴',
                result?.ok ? { code: 'service_order_result_invalid', reason: '桥接返回结果与请求不一致（记录编号或角色数量不匹配）' } : (result?.thrown ?? result),
                { stage: '原子复制角色并建立待确认约伴' }));
            if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
            ctx.setFeedback(result?.ok ? describeActionFailure({ code: 'service_order_result_invalid' }) : (result?.message || describeActionFailure(result)), operationToken); ctx.renderPage(); return;
        }
        settleConsoleEntry('succeed', consoleHandle, '已创建待确认约伴。');
        for (const profile of profiles) { profile.orderUid = result.orderUid; ctx.selectedServiceProfileIds.delete(profile.id); }
        ctx.refreshState();
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
        if (ctx.currentView.mode !== requestMode) { ctx.setFeedback('内容模式已改变；已创建待确认约伴，但未填入正文草稿。', operationToken); return; }
        appendServiceExperienceDraft(profiles, requestMode, result.orderUid, operationToken, undefined, operationEpoch);
    }
    async function repeatServiceOrder(order) {
        if (!order?.id || ctx.serviceOrderRepeatPendingId) return;
        if (typeof ctx.actionBridge.runServiceOrderRepeat !== 'function') { ctx.setFeedback('历史再次邀约的 MVU 桥接尚未就绪。'); return; }
        const requestMode = order.mode;
        if (ctx.currentView.mode !== requestMode) { ctx.setFeedback('内容模式已改变，请在当前模式重新选择历史约伴。'); ctx.renderPage(); return; }
        const requestId = ++ctx.interactionGeneration; const operationEpoch = ctx.serviceOrderOperationEpoch; ctx.serviceOrderRepeatPendingId = order.id;
        const operationToken = ctx.setFeedback('正在创建新的待确认约伴…'); ctx.renderPage(); let result;
        const consoleHandle = startConsoleEntry('再次邀约', '正在从终态记录创建新的待确认约伴……');
        try { result = await ctx.actionBridge.runServiceOrderRepeat({ sourceOrderUid: order.id, expectedContentMode: requestMode }); }
        catch (error) { result = { ok: false, thrown: error }; }
        ctx.serviceOrderRepeatPendingId = '';
        if (!result?.ok) {
            settleConsoleEntry('fail', consoleHandle, '再次邀约未完成。', serviceFailureDetail('再次邀约', result?.thrown ?? result, { stage: '受控记录复建' }));
            if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
            ctx.setFeedback(result?.message || describeActionFailure(result), operationToken); ctx.renderPage(); return;
        }
        if (!SERVICE_ORDER_UID_PATTERN.test(result.orderUid ?? '')) {
            settleConsoleEntry('fail', consoleHandle, '再次邀约未完成。', serviceFailureDetail('再次邀约', { code: 'service_order_result_invalid', reason: '桥接返回的记录编号格式未通过校验' }, { stage: '返回结果校验' }));
            ctx.refreshState();
            if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
            ctx.setFeedback(describeActionFailure({ code: 'service_order_result_invalid' }), operationToken); ctx.renderPage(); return;
        }
        settleConsoleEntry('succeed', consoleHandle, '已创建新的待确认约伴。');
        ctx.refreshState();
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
        if (ctx.currentView.mode !== requestMode) { ctx.setFeedback('内容模式已改变；已创建新的待确认约伴，但未填入正文草稿。', operationToken); return; }
        appendServiceExperienceDraft(order, requestMode, result.orderUid, operationToken, '已创建新的待确认约伴并填入正文草稿；未自动发送。', operationEpoch);
    }
    function buildServiceHubCard(title, note, tags = []) {
        const card = element('article', { className: 'yl-service-card' }); append(card, [element('strong', { text: title }), element('p', { text: note })]);
        if (tags.length) { const row = element('div', { className: 'yl-service-tags' }); for (const tag of tags) row.appendChild(element('span', { text: tag })); card.appendChild(row); } return card;
    }
    function buildLocalServiceProfileCard(profile) {
        const publicProfile = profile?.candidate?.公开资料 ?? {}; const name = serviceProfileName(profile); const category = serviceCategory(serviceHubModeCopy(), profile.categoryId)?.label || '成年人约伴';
        const listing = createServiceListingView({ mode: profile?.mode, categoryId: profile?.categoryId, publicProfile, adultVerified: profile?.candidate?.成人验证 === true, rotationKey: profile?.batchId || '' });
        const card = buildServiceHubCard(name, listing?.headline || (typeof publicProfile.简介 === 'string' && publicProfile.简介 ? publicProfile.简介 : '该角色只保留公开摘要，尚未复制到 MVU。'), [category, listing?.adultBadge || '成年人已验证', ...(listing?.publicBadges || []).slice(0, 2)]);
        card.classList.toggle('yl-local-service-profile', true); const order = localServiceOrder(profile); const pending = Boolean(ctx.serviceProfileHandoffPendingId);
        const detail = element('button', { className: 'yl-settings-button', type: 'button', name: `service-candidate-detail-${profile.id}`, text: '查看公开详情' });
        listen(detail, detail, 'click', () => { serviceCandidateDetailId = profile.id; ctx.renderPage(); ctx.root.querySelectorAll?.('[name="service-candidate-detail-close"]')?.[0]?.focus?.(); }, ctx.abortController.signal);
        card.appendChild(detail);
        if (profile.orderUid) {
            const terminal = isTerminalServiceOrder(order); const waitingForOrder = !order;
            const actionText = terminal ? '前往历史记录' : waitingForOrder ? '等待服务记录同步' : '再次填入正文草稿';
            const action = element('button', { className: 'yl-settings-button', type: 'button', name: `service-profile-${profile.id}`, disabled: pending || waitingForOrder, text: actionText });
            listen(action, action, 'click', () => { if (terminal) { ctx.activeServiceHubTab = 'records'; ctx.renderPage(); } else if (order) { appendServiceExperienceDraft(order, order.mode, order.id); ctx.renderPage(); } }, ctx.abortController.signal); card.appendChild(action);
            return card;
        }
        const selected = ctx.selectedServiceProfileIds.has(profile.id);
        const check = element('input', { type: 'checkbox', name: `service-profile-select-${profile.id}`, checked: selected, disabled: pending, ariaLabel: `选择角色：${serviceProfileName(profile)}` });
        listen(check, check, 'change', () => {
            const want = Boolean(check.checked);
            if (want !== ctx.selectedServiceProfileIds.has(profile.id)) toggleServiceProfileSelection(profile);
        }, ctx.abortController.signal);
        const checkRow = element('label', { className: 'yl-service-slot-check' });
        append(checkRow, [check, element('span', { text: selected ? '已选择，将加入本单' : '选择此角色' })]);
        card.appendChild(checkRow);
        return card;
    }
    function closeServiceCandidateDetail(profileId = '') {
        serviceCandidateDetailId = '';
        ctx.renderPage();
        if (profileId) ctx.root.querySelectorAll?.(`[name="service-candidate-detail-${profileId}"]`)?.[0]?.focus?.();
    }
    function buildServiceCandidateDetailSheet(profile) {
        const publicProfile = profile?.candidate?.公开资料 ?? {};
        const listing = createServiceListingView({ mode: profile?.mode, categoryId: profile?.categoryId, publicProfile, adultVerified: profile?.candidate?.成人验证 === true, rotationKey: profile?.batchId || '' });
        if (!listing) return null;
        const backdrop = element('div', { className: 'yl-service-sheet-backdrop' });
        const sheet = element('section', { className: 'yl-service-candidate-sheet', ariaLabel: `${listing.publicProfile.nickname}的公开约伴详情` });
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        const close = element('button', { className: 'yl-settings-button yl-service-sheet-close', type: 'button', name: 'service-candidate-detail-close', text: '关闭' });
        listen(close, close, 'click', () => closeServiceCandidateDetail(profile.id), ctx.abortController.signal);
        append(sheet, [close, element('span', { className: 'yl-service-mode-badge', text: listing.adultBadge }), element('h3', { text: listing.headline }), element('p', { text: listing.publicSummary })]);
        const publicFacts = [listing.publicProfile.ageRange, listing.publicProfile.gender, listing.publicProfile.orientation, listing.publicProfile.city, listing.publicProfile.intent, ...listing.publicBadges].filter(Boolean);
        if (publicFacts.length) { const tags = element('div', { className: 'yl-service-tags' }); for (const fact of publicFacts.slice(0, 10)) tags.appendChild(element('span', { text: fact })); sheet.appendChild(tags); }
        const scenarios = element('div', { className: 'yl-service-scenario-grid' });
        for (const scenario of listing.scenarioCards) scenarios.appendChild(buildServiceHubCard(scenario.title, scenario.summary, []));
        sheet.appendChild(scenarios);
        const arrangement = listing.mode === 'SFW'
            ? `${listing.arrangement.duration} · ${listing.arrangement.scheduleWindow} · ${listing.arrangement.routeDirection} · ${listing.arrangement.fictionalStoryPrice.label}：${listing.arrangement.fictionalStoryPrice.value}`
            : `${listing.arrangement.estimatedDuration} · ${listing.arrangement.timeWindow} · ${listing.arrangement.sceneDirection} · ${listing.arrangement.aftercare}`;
        sheet.appendChild(buildServiceHubCard(listing.mode === 'SFW' ? '剧情安排示例' : '当次协商提示', arrangement, [listing.safetyNote]));
        if (!profile.orderUid) {
            const selected = ctx.selectedServiceProfileIds.has(profile.id);
            const select = element('button', { className: 'yl-settings-button yl-service-generate-button', type: 'button', name: 'service-candidate-detail-select', text: selected ? '移出当前组合' : listing.selectAction });
            listen(select, select, 'click', () => { toggleServiceProfileSelection(profile); serviceCandidateDetailId = ''; }, ctx.abortController.signal);
            sheet.appendChild(select);
        }
        listen(sheet, sheet, 'keydown', (event) => { if (event.key === 'Escape') { event.preventDefault?.(); closeServiceCandidateDetail(profile.id); } }, ctx.abortController.signal);
        listen(backdrop, backdrop, 'click', (event) => { if (event.target === backdrop) closeServiceCandidateDetail(profile.id); }, ctx.abortController.signal);
        backdrop.appendChild(sheet);
        return backdrop;
    }
    function buildServiceProfileGenerator(category, xpSearch = '') {
        const search = normalizeServiceXpSearch(xpSearch);
        const mode = ctx.currentView.mode;
        const batchKey = category ? serviceBatchKey(mode, category.id, search) : '';
        const batch = category ? ctx.serviceGenerationBatches.get(batchKey) : null;
        const complete = Boolean(batch?.complete);
        const progress = category ? serviceBatchProgress(mode, category.id, search) : 0;
        const generatingHere = ctx.serviceProfileGenerationPending && serviceGeneratingBatchKey === batchKey && Boolean(batchKey);
        const readyProfiles = category ? profilesForServiceBatch(mode, category.id, { readyOnly: true, xpSearch: search }) : [];
        const stagedProfiles = complete ? readyProfiles : (batch && !batch.complete ? batch.profiles : []);
        const wrap = element('section', { className: 'yl-service-slot-generator', ariaLabel: '三席生成器' });
        const head = element('div', { className: 'yl-service-slot-generator-head' });
        append(head, [
            element('strong', { text: category ? `三席生成器 ·「${category.label}」` : '三席生成器' }),
            element('span', { className: 'yl-service-slot-progress', text: `当前进度 ${progress}/${SERVICE_PROFILE_SLOT_COUNT}` }),
        ]);
        const headText = ctx.serviceProfileGenerationPending ? '正在生成…' : complete ? '刷新 3 位本地角色' : progress > 0 && progress < SERVICE_PROFILE_SLOT_COUNT ? `重试剩余第 ${progress + 1} 位` : '批量生成 3 位角色';
        const generate = element('button', { className: 'yl-settings-button yl-service-generate-button', type: 'button', name: 'service-profile-generate', disabled: ctx.serviceProfileGenerationPending || !category, text: headText });
        listen(generate, generate, 'click', () => { if (category) void generateLocalServiceProfiles(category.id, { refresh: complete, xpSearch: search }); }, ctx.abortController.signal);
        head.appendChild(generate);
        wrap.appendChild(head);
        wrap.appendChild(element('p', {
            className: 'yl-service-slot-note',
            text: search
                ? `按固定三席串行生成，应用本次 XP 搜索但不保存该搜索词。${category ? '' : '请先选择上方分类。'}三席齐全后才开放选择。`
                : `按固定三席串行生成；每位一通过格式校验便保留在当前模式候补池。${category ? '' : '请先选择上方分类。'}三席齐全后才开放选择。`,
        }));
        const slotRow = element('div', { className: 'yl-service-slot-row' });
        for (let slotIndex = 0; slotIndex < SERVICE_PROFILE_SLOT_COUNT; slotIndex += 1) {
            const profile = stagedProfiles[slotIndex] ?? null;
            if (profile && complete) {
                slotRow.appendChild(buildLocalServiceProfileCard(profile));
                continue;
            }
            if (profile) {
                const staged = element('article', { className: 'yl-service-slot yl-service-slot--staged' });
                append(staged, [
                    element('strong', { text: serviceProfileName(profile) }),
                    element('span', { className: 'yl-service-slot-state', text: '已通过格式校验' }),
                    element('p', { className: 'yl-service-slot-wait', text: '三席未齐前暂不开放选择。' }),
                ]);
                slotRow.appendChild(staged);
                continue;
            }
            if (generatingHere && slotIndex === stagedProfiles.length) {
                const loading = element('div', { className: 'yl-service-slot yl-service-slot--loading' });
                loading.appendChild(createSkeleton({ documentRef: ctx.documentRef, variant: 'candidate-card', count: 1 }));
                // P3-G 等待期趣味文案（纯 CSS 轮播，luxe 配色由 service 子区覆写）。
                loading.appendChild(buildWaitCaptions(ctx.documentRef, SERVICE_WAIT_CAPTIONS, { shiftText: SERVICE_WAIT_SHIFT_TEXT }));
                slotRow.appendChild(loading);
                continue;
            }
            const empty = element('div', { className: 'yl-service-slot yl-service-slot--empty' });
            empty.appendChild(element('strong', { text: `第 ${slotIndex + 1} 席` }));
            if (!ctx.serviceProfileGenerationPending && slotIndex === stagedProfiles.length) {
                const slotGenerate = element('button', { className: 'yl-settings-button yl-service-slot-generate', type: 'button', name: 'service-slot-generate', disabled: !category, text: progress > 0 ? '继续生成本席' : '生成' });
                listen(slotGenerate, slotGenerate, 'click', () => { if (category) void generateLocalServiceProfiles(category.id, { refresh: false, xpSearch: search }); }, ctx.abortController.signal);
                empty.appendChild(slotGenerate);
            } else {
                empty.appendChild(element('span', { className: 'yl-service-slot-wait', text: '待前席完成后依次生成' }));
            }
            slotRow.appendChild(empty);
        }
        wrap.appendChild(slotRow);
        return wrap;
    }
    function buildServiceSelectionTray(category) {
        const selected = selectedServiceProfiles(category?.id);
        const tray = element('aside', { className: 'yl-service-selection-tray', ariaLabel: '当前约伴组合' });
        tray.appendChild(element('strong', { text: `当前组合 ${selected.length}/3` }));
        if (!selected.length) tray.appendChild(element('p', { text: '从三席候选中选择 1–3 位；多人组合会展示公开风格互补，但仍须逐人确认。' }));
        const chips = element('div', { className: 'yl-service-tags' });
        for (const profile of selected) {
            const remove = element('button', { className: 'yl-service-selection-chip', type: 'button', name: `service-selection-remove-${profile.id}`, text: `${serviceProfileName(profile)} ×`, ariaLabel: `移出组合：${serviceProfileName(profile)}` });
            listen(remove, remove, 'click', () => toggleServiceProfileSelection(profile), ctx.abortController.signal);
            chips.appendChild(remove);
        }
        if (selected.length) tray.appendChild(chips);
        if (selected.length >= 2) {
            const listings = selected.map((profile) => createServiceListingView({ mode: profile.mode, categoryId: profile.categoryId, publicProfile: profile.candidate?.公开资料, adultVerified: profile.candidate?.成人验证 === true, rotationKey: profile.batchId || '' })).filter(Boolean);
            const complement = deriveServiceGroupComplementView({ mode: ctx.currentView.mode, listings });
            if (complement) tray.appendChild(buildServiceHubCard(complement.title, complement.summary, complement.contributions.map((item) => `${item.nickname} · ${item.contribution}`)));
        }
        const hasOpen = Array.isArray(ctx.currentView.serviceOrders) && ctx.currentView.serviceOrders.some((order) => ['待确认', '进行中', '暂停中'].includes(order.status));
        const create = element('button', { className: 'yl-settings-button yl-service-generate-button', type: 'button', name: 'service-order-create-selected', disabled: !selected.length || hasOpen || Boolean(ctx.serviceProfileHandoffPendingId), text: ctx.serviceProfileHandoffPendingId ? '正在创建…' : `${getServiceModeCopy(ctx.currentView.mode).createAction} · ${selected.length} 位` });
        listen(create, create, 'click', () => { void createServiceOrderFromSelectedProfiles(category); }, ctx.abortController.signal);
        tray.appendChild(create);
        if (hasOpen) tray.appendChild(element('p', { className: 'yl-service-record-note', text: '已有一笔开放约伴；无论它属于哪种内容模式，都需要先处理。' }));
        return tray;
    }
    function serviceOrdersForCurrentMode() { return Array.isArray(ctx.currentView.serviceOrders) ? ctx.currentView.serviceOrders.filter((order) => order.mode === ctx.currentView.mode) : []; }
    function serviceParticipantCount(order) { return Array.isArray(order?.profiles) && order.profiles.length ? order.profiles.length : 1; }
    function serviceOrderSteps(order) { return SERVICE_ORDER_STEPS_BY_MODE[order?.mode === 'NSFW' ? 'NSFW' : 'SFW']; }
    function defaultServiceBoundaries(order) {
        const participantCount = serviceParticipantCount(order);
        const currentRevision = Number.isInteger(order?.contractSummary?.revision) ? order.contractSummary.revision : 0;
        const initial = createServiceContractDraft({
            mode: order?.mode,
            participantCount,
            topic: order?.topic || '',
            revision: order?.status === '暂停中' ? currentRevision + 1 : 1,
        });
        const saved = ctx.serviceBoundaryDrafts.get(order?.id);
        if (!saved) return initial;
        return {
            ...initial,
            ...saved,
            协议版本: initial.协议版本,
            修订号: initial.修订号,
            内容模式: initial.内容模式,
            体验类型: initial.体验类型,
            安排: { ...initial.安排, ...(saved.安排 && typeof saved.安排 === 'object' ? saved.安排 : {}) },
            NPC明确同意: Array.isArray(saved.NPC明确同意) && saved.NPC明确同意.length === participantCount
                ? [...saved.NPC明确同意].map((item) => item === true) : initial.NPC明确同意,
        };
    }
    function readServiceBoundaryDraft(order) { const draft = defaultServiceBoundaries(order); return { ...draft, 安排: { ...draft.安排 }, NPC明确同意: [...draft.NPC明确同意] }; }
    function serviceBoundariesConsented(order) { const draft = defaultServiceBoundaries(order); return draft.玩家已同意 === true && Array.isArray(draft.NPC明确同意) && draft.NPC明确同意.length === serviceParticipantCount(order) && draft.NPC明确同意.every((item) => item === true); }
    function serviceOrderStep(order) {
        return serviceOrderStepState.get(order?.id) ?? { step: 1, maxVisited: 1 };
    }
    function setServiceOrderStep(order, step) {
        if (!order?.id) return;
        const bounded = Math.min(serviceOrderSteps(order).length, Math.max(1, Math.trunc(step)));
        const current = serviceOrderStep(order);
        if (bounded > current.maxVisited + 1) return; // 只能依次前进；回跳不受限。
        serviceOrderStepState.set(order.id, { step: bounded, maxVisited: Math.max(current.maxVisited, bounded) });
        ctx.renderPage();
    }
    function serviceStepSummary(order, step) {
        const draft = defaultServiceBoundaries(order);
        if (step === 1) {
            const topic = String(draft.主题 ?? '').trim();
            return `${topic ? topic.slice(0, 24) : '未填写主题'} · 强度：${String(draft.强度 ?? '').trim() || '未填写'} · 隐私：${String(draft.隐私处理 ?? '').trim() || '未填写'}`;
        }
        if (step === 2) {
            const fields = SERVICE_ARRANGEMENT_FIELDS.filter((field) => order?.mode === 'SFW' || field !== '虚构价格');
            const filled = fields.filter((field) => String(draft.安排?.[field] ?? '').trim()).length;
            return `已填写 ${filled}/${fields.length} 项本轮安排`;
        }
        const consented = draft.NPC明确同意.filter((item) => item === true).length;
        return `${draft.玩家已同意 === true ? '玩家已同意' : '玩家未确认'} · 参与者同意 ${consented}/${draft.NPC明确同意.length}`;
    }
    function buildServiceBoundaryTextField(order, field) {
        const draft = defaultServiceBoundaries(order);
        const input = element('input', { className: 'yl-settings-control', type: 'text', name: 'service-boundary-' + field, value: draft[field] || '', ariaLabel: field });
        listen(input, input, 'input', () => { const next = readServiceBoundaryDraft(order); next[field] = String(input.value ?? '').slice(0, 240); ctx.serviceBoundaryDrafts.set(order.id, next); }, ctx.abortController.signal);
        const row = element('label', { className: 'yl-settings-field' }); append(row, [element('span', { text: field }), input]);
        return row;
    }
    function createServiceBoundaryEditor(order) {
        const wrap = element('section', { className: 'yl-service-boundary-editor yl-service-stepper' });
        wrap.appendChild(element('strong', { text: order?.status === '暂停中' ? '重新协商合同（三步）' : '确认本轮约伴合同（三步）' }));
        wrap.appendChild(element('p', { className: 'yl-service-stepper-intro', text: '玩家与每位明确成年人都要逐人确认同一修订；沉默、旧关系与历史记录都不能代替本次确认。结构化合同不会自动发送正文。' }));
        const state = serviceOrderStep(order);
        const steps = serviceOrderSteps(order);
        const head = element('div', { className: 'yl-service-stepper-head' });
        for (const meta of steps) {
            const reachable = meta.step <= state.maxVisited;
            const tab = element('button', { className: 'yl-service-step-tab', type: 'button', name: `service-step-${meta.step}`, disabled: !reachable && meta.step !== state.step, ariaLabel: `第 ${meta.step} 步：${meta.label}` });
            tab.classList.toggle('is-active', state.step === meta.step);
            tab.classList.toggle('is-done', reachable && state.step !== meta.step);
            if (state.step === meta.step) tab.setAttribute('aria-current', 'step');
            append(tab, [element('span', { className: 'yl-service-step-num', text: String(meta.step) }), element('span', { text: meta.label })]);
            listen(tab, tab, 'click', () => setServiceOrderStep(order, meta.step), ctx.abortController.signal);
            head.appendChild(tab);
        }
        wrap.appendChild(head);
        // 已完成/已到访的其他步骤显示摘要行，随时可点步骤条回跳修改。
        for (const meta of steps) {
            if (meta.step === state.step || meta.step > state.maxVisited) continue;
            wrap.appendChild(element('p', { className: 'yl-service-step-summary', text: `第 ${meta.step} 步 · ${meta.label}：${serviceStepSummary(order, meta.step)}` }));
        }
        const draft = defaultServiceBoundaries(order);
        if (state.step === 1) {
            for (const field of SERVICE_BOUNDARY_FIELDS) wrap.appendChild(buildServiceBoundaryTextField(order, field));
        } else if (state.step === 2) {
            wrap.appendChild(element('strong', { text: order?.mode === 'NSFW' ? '本次节奏与事后安排' : '本次约会安排' }));
            wrap.appendChild(element('p', { className: 'yl-service-stepper-intro', text: '这里只保存当前合同；本地足迹不会保留完整安排。' }));
            const grid = element('div', { className: 'yl-service-grid-2' });
            for (const field of SERVICE_ARRANGEMENT_FIELDS.filter((item) => order?.mode === 'SFW' || item !== '虚构价格')) {
                const label = field === '虚构价格' ? '剧情内虚构体验价（不接入现实支付）' : field;
                const input = element('input', { className: 'yl-settings-control', type: 'text', name: 'service-arrangement-' + field, value: draft.安排?.[field] || '', ariaLabel: label });
                listen(input, input, 'input', () => { const next = readServiceBoundaryDraft(order); next.安排[field] = String(input.value ?? '').slice(0, 120); ctx.serviceBoundaryDrafts.set(order.id, next); }, ctx.abortController.signal);
                const row = element('label', { className: 'yl-settings-field' }); append(row, [element('span', { text: label }), input]); grid.appendChild(row);
            }
            wrap.appendChild(grid);
        } else {
            const playerConfirm = element('input', { type: 'checkbox', name: 'service-boundary-player-consent', checked: draft.玩家已同意 === true, ariaLabel: '玩家已同意本次合同修订' });
            listen(playerConfirm, playerConfirm, 'change', () => { const next = readServiceBoundaryDraft(order); next.玩家已同意 = Boolean(playerConfirm.checked); ctx.serviceBoundaryDrafts.set(order.id, next); ctx.renderPage(); }, ctx.abortController.signal);
            const playerRow = element('label', { className: 'yl-settings-field yl-service-consent-check' }); append(playerRow, [playerConfirm, element('span', { text: `我已同意本次合同修订 v${draft.修订号}` })]); wrap.appendChild(playerRow);
            const profiles = Array.isArray(order?.profiles) && order.profiles.length ? order.profiles : [order?.profile];
            profiles.forEach((profile, index) => {
                const name = typeof profile?.昵称 === 'string' && profile.昵称.trim() ? profile.昵称.trim().slice(0, 80) : `第 ${index + 1} 位参与者`;
                const consentCard = element('article', { className: 'yl-service-consent-card' });
                consentCard.appendChild(element('strong', { text: name }));
                const npcConfirm = element('input', { type: 'checkbox', name: `service-boundary-npc-consent-${index + 1}`, checked: draft.NPC明确同意[index] === true, ariaLabel: `${name}已在正文明确同意` });
                listen(npcConfirm, npcConfirm, 'change', () => { const next = readServiceBoundaryDraft(order); next.NPC明确同意[index] = Boolean(npcConfirm.checked); ctx.serviceBoundaryDrafts.set(order.id, next); ctx.renderPage(); }, ctx.abortController.signal);
                const npcRow = element('label', { className: 'yl-settings-field yl-service-consent-check' }); append(npcRow, [npcConfirm, element('span', { text: `我已在正文取得「${name}」的明确同意` })]); consentCard.appendChild(npcRow);
                wrap.appendChild(consentCard);
            });
        }
        const nav = element('div', { className: 'yl-service-step-nav' });
        if (state.step > 1) {
            const prev = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-step-prev', text: '上一步' });
            listen(prev, prev, 'click', () => setServiceOrderStep(order, state.step - 1), ctx.abortController.signal);
            nav.appendChild(prev);
        }
        if (state.step < steps.length) {
            const nextMeta = steps[state.step];
            const next = element('button', { className: 'yl-settings-button yl-service-step-next', type: 'button', name: 'service-step-next', text: `下一步：${nextMeta.label}` });
            listen(next, next, 'click', () => setServiceOrderStep(order, state.step + 1), ctx.abortController.signal);
            nav.appendChild(next);
        }
        if (nav.childNodes.length) wrap.appendChild(nav);
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
        const token = ctx.setFeedback(status === '已完成' ? '正在确认完成并归档…' : status === '已中止' ? '正在中止并归档…' : '正在取消并归档…'); ctx.renderPage();
        const operationName = status === '已完成' ? '玩家确认完成' : status === '已中止' ? '中止本轮约伴' : '取消待确认约伴';
        const consoleHandle = startConsoleEntry(operationName, `正在${operationName}……`);
        const transition = status === '已完成' ? ctx.actionBridge.runServiceOrderComplete : ctx.actionBridge.runServiceOrderCancel;
        let result;
        try { result = await transition?.({ orderUid: order.id, expectedContentMode: order.mode }); } catch (error) { result = { ok: false, thrown: error }; }
        if (!result?.ok) {
            ctx.serviceOrderHistoryStore.discardStage?.(staged.localId);
            settleConsoleEntry('fail', consoleHandle, `${operationName}未完成。`, serviceFailureDetail(operationName, result?.thrown ?? result, { stage: '受控状态转换' }));
            ctx.serviceOrderMutationPendingId = ''; if (!ctx.isDestroyed && requestId === ctx.interactionGeneration) { ctx.setFeedback(describeActionFailure(result), token); ctx.renderPage(); } return;
        }
        if (!ctx.serviceOrderHistoryStore.markTerminalConfirmed?.(staged.localId)) {
            ctx.serviceOrderMutationPendingId = '';
            settleConsoleEntry('fail', consoleHandle, '终态已确认，但本地归档阶段写入失败。', 'MVU 终态保持可见；未执行删除，可刷新后继续归档。');
            if (!ctx.isDestroyed && requestId === ctx.interactionGeneration) { ctx.refreshState(); ctx.setFeedback('本轮已进入终态，但本地归档确认失败；未删除 MVU 记录，请刷新后重试。', token); ctx.renderPage(); }
            return;
        }
        ctx.refreshState();
        try { result = await ctx.actionBridge.runServiceOrderFinalize?.({ orderUid: order.id }); } catch (error) { result = { ok: false, thrown: error }; }
        if (result?.ok) ctx.serviceOrderHistoryStore.finalize?.(staged.localId);
        serviceOrderStepState.delete(order.id);
        ctx.serviceOrderMutationPendingId = '';
        if (result?.ok) settleConsoleEntry('succeed', consoleHandle, '订单已进入终态并完成归档。');
        else settleConsoleEntry('fail', consoleHandle, '订单已进入终态，但归档未完成。', serviceFailureDetail(operationName, result?.thrown ?? result, { stage: '归档移除终态订单', hint: '本地保留待修复归档，可稍后在历史记录中继续归档' }));
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
        ctx.refreshState(); ctx.setFeedback(result?.ok ? '订单已归档至本设备历史，并已从 MVU 开放订单中移除。' : '订单已进入终态；本地已保留待修复归档，稍后可重试。', token); ctx.renderPage();
    }
    /**
     * 兜底：活动表里出现终态订单（正文违规直写终态，或此前 finalize 失败）时，
     * 先补记本地最小历史，再受控删除该终态订单。绝不改写订单内容或伪造状态迁移。
     */
    async function recoverTerminalServiceOrder(order) {
        if (!order || !isTerminalServiceOrder(order) || ctx.serviceOrderMutationPendingId || !ctx.serviceOrderHistoryStore?.stage) return;
        if (order.mode !== ctx.currentView.mode) return;
        const staged = ctx.serviceOrderHistoryStore.stage(order, { status: order.status, summary: order.summary });
        if (!staged) { ctx.setFeedback('本地最小历史写入失败；终态订单保持原样，稍后自动重试。'); return; }
        if (!ctx.serviceOrderHistoryStore.markTerminalConfirmed?.(staged.localId)) {
            ctx.setFeedback('终态已检测到，但本地归档确认失败；MVU 记录保持原样。');
            return;
        }
        const requestId = ++ctx.interactionGeneration; ctx.serviceOrderMutationPendingId = order.id;
        const consoleHandle = startConsoleEntry('终态订单归档兜底', '检测到活动表中的终态订单，正在补记本地历史并移除……');
        let result;
        try { result = await ctx.actionBridge.runServiceOrderFinalize?.({ orderUid: order.id }); } catch (error) { result = { ok: false, thrown: error }; }
        ctx.serviceOrderMutationPendingId = '';
        if (result?.ok) {
            ctx.serviceOrderHistoryStore.finalize?.(staged.localId);
            serviceOrderStepState.delete(order.id);
            settleConsoleEntry('succeed', consoleHandle, '终态订单已归档至本设备历史，并已从 MVU 活动订单中移除。');
        } else {
            settleConsoleEntry('fail', consoleHandle, '终态订单归档未完成。', serviceFailureDetail('终态订单归档兜底', result?.thrown ?? result, { stage: '归档移除终态订单', hint: '本地保留待修复归档，可稍后在历史记录中继续归档' }));
        }
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
        ctx.refreshState(); ctx.renderPage();
    }
    async function pauseServiceOrder(order) {
        if (!order || order.status !== '进行中' || ctx.serviceOrderMutationPendingId) return;
        const requestId = ++ctx.interactionGeneration;
        ctx.serviceOrderMutationPendingId = order.id;
        const token = ctx.setFeedback(order.withdrawalReady ? '检测到正文撤回候选，正在优先暂停…' : '正在暂停本轮约伴…');
        ctx.renderPage();
        let result;
        try { result = await ctx.actionBridge.runServiceOrderPause?.({ orderUid: order.id, expectedContentMode: order.mode }); }
        catch (error) { result = { ok: false, thrown: error }; }
        ctx.serviceOrderMutationPendingId = '';
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
        if (!result?.ok) { ctx.setFeedback(describeActionFailure(result), token); ctx.renderPage(); return; }
        ctx.serviceBoundaryDrafts.delete(order.id);
        serviceOrderStepState.set(order.id, { step: 1, maxVisited: 1 });
        ctx.refreshState();
        ctx.setFeedback('本轮已暂停。恢复前需建立新修订并逐人重新确认。', token);
        ctx.renderPage();
    }
    async function continueServiceOrder(order) {
        if (!order || order.status !== '进行中' || order.completionReady !== true || ctx.serviceOrderMutationPendingId) return;
        const requestId = ++ctx.interactionGeneration;
        ctx.serviceOrderMutationPendingId = order.id;
        const token = ctx.setFeedback('正在拒绝本次完成候选…');
        ctx.renderPage();
        let result;
        try { result = await ctx.actionBridge.runServiceOrderContinue?.({ orderUid: order.id, expectedContentMode: order.mode }); }
        catch (error) { result = { ok: false, thrown: error }; }
        ctx.serviceOrderMutationPendingId = '';
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
        ctx.refreshState();
        ctx.setFeedback(result?.ok ? '已选择继续；正文完成候选已清除。' : describeActionFailure(result), token);
        ctx.renderPage();
    }
    async function startServiceOrder(order) {
        if (!order || ctx.serviceOrderMutationPendingId) return;
        const boundaries = readServiceBoundaryDraft(order); const requestId = ++ctx.interactionGeneration; const operationEpoch = ctx.serviceOrderOperationEpoch; ctx.serviceOrderMutationPendingId = order.id;
        const resuming = order.status === '暂停中';
        const token = ctx.setFeedback(resuming ? '正在确认新修订并恢复约伴…' : '正在逐人确认并开始约伴…'); ctx.renderPage(); let result;
        const consoleHandle = startConsoleEntry(resuming ? '恢复约伴' : '确认开始', resuming ? '正在确认新修订并恢复约伴……' : '正在逐人确认并开始约伴……');
        try {
            result = resuming
                ? await ctx.actionBridge.runServiceOrderResume?.({ orderUid: order.id, boundaries, expectedContentMode: order.mode })
                : await ctx.actionBridge.runServiceOrderStart?.({ orderUid: order.id, boundaries, expectedContentMode: order.mode });
        }
        catch (error) { result = { ok: false, thrown: error }; }
        ctx.serviceOrderMutationPendingId = '';
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) {
            settleConsoleEntry('dismiss', consoleHandle, '提示已关闭，结果未展示。');
            return;
        }
        if (!result?.ok) {
            settleConsoleEntry('fail', consoleHandle, resuming ? '恢复约伴未完成。' : '确认开始未完成。', serviceFailureDetail(resuming ? '恢复约伴' : '确认开始', result?.thrown ?? result, { stage: '结构化合同校验与受控状态转换' }));
            ctx.setFeedback(describeActionFailure(result), token); ctx.renderPage(); return;
        }
        settleConsoleEntry('succeed', consoleHandle, resuming ? '新修订已确认，约伴恢复进行中。' : '合同已逐人确认，约伴进入进行中。');
        ctx.serviceBoundaryDrafts.delete(order.id); serviceOrderStepState.delete(order.id); ctx.refreshState();
        // 逐人确认后把执行提示词填入酒馆输入框；appendMeetupDraft 只写值并触发 input，绝不自动发送。
        const filled = appendServiceDealDraft(order, boundaries, token, operationEpoch);
        if (!filled && operationEpoch !== ctx.serviceOrderOperationEpoch) return;
        ctx.renderPage();
    }
    async function rebookServiceHistory(record) {
        if (!record || ctx.serviceOrderMutationPendingId) return;
        const requestId = ++ctx.interactionGeneration; const operationEpoch = ctx.serviceOrderOperationEpoch; ctx.serviceOrderMutationPendingId = record.localId;
        const token = ctx.setFeedback('正在建立新的待确认约伴…'); ctx.renderPage(); let result;
        const consoleHandle = startConsoleEntry('历史再次邀约', '正在从本地足迹建立新的待确认约伴……');
        try { result = await ctx.actionBridge.runServiceOrderRebook?.({ npcUids: record.roleUids, categoryId: record.categoryId, expectedContentMode: record.mode }); }
        catch (error) { result = { ok: false, thrown: error }; }
        ctx.serviceOrderMutationPendingId = '';
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) {
            settleConsoleEntry('dismiss', consoleHandle, '提示已关闭，结果未展示。');
            return;
        }
        if (!result?.ok) {
            settleConsoleEntry('fail', consoleHandle, '历史再次邀约未完成。', serviceFailureDetail('历史再次邀约', result?.thrown ?? result, { stage: '受控约伴重建' }));
            ctx.setFeedback(describeActionFailure(result), token); ctx.renderPage(); return;
        }
        settleConsoleEntry('succeed', consoleHandle, '已建立新的待确认约伴。');
        ctx.refreshState();
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) return;
        ctx.activeServiceHubTab = 'orders';
        const createdOrder = ctx.currentView.serviceOrders.find((order) => order?.id === result.orderUid) ?? null;
        if (!createdOrder || ctx.currentView.mode !== record.mode) {
            ctx.setFeedback('已建立新的待确认约伴；请重新确认本次合同。', token); ctx.renderPage(); return;
        }
        appendServiceExperienceDraft(createdOrder, record.mode, result.orderUid, token, '已建立新的待确认约伴并填入正文草稿；未自动发送。', operationEpoch);
        ctx.renderPage();
    }
    async function finalizePendingServiceHistory(record) {
        if (!record || record.archiveState !== 'pending_archive' || ctx.serviceOrderMutationPendingId || typeof ctx.serviceOrderHistoryStore?.finalize !== 'function') return;
        if (record.mode !== ctx.currentView.mode) { ctx.setFeedback('请切换回该订单所属内容模式后再继续归档。'); return; }
        const terminal = ctx.currentView.serviceOrders.find((order) => order.id === record.orderUid && order.mode === record.mode && isTerminalServiceOrder(order));
        if (!terminal) {
            const malformed = ctx.currentView.serviceOrderIssues?.some((issue) => issue?.id === record.orderUid);
            if (malformed) { ctx.activeServiceHubTab = 'orders'; ctx.setFeedback('该 MVU 订单已损坏；请使用“移除损坏记录”后再处理本地历史。'); ctx.renderPage(); return; }
            if (record.archivePhase !== 'terminal_confirmed') {
                ctx.setFeedback('这条历史仍停留在“转换前暂存”，未观察到 MVU 终态；已拒绝伪归档，请刷新状态后重试。');
                ctx.renderPage();
                return;
            }
            ctx.serviceOrderHistoryStore.finalize(record.localId);
            ctx.setFeedback('已确认此前终态记录不再存在，完成本地归档。');
            ctx.renderPage();
            return;
        }
        if (record.archivePhase === 'staged_before_transition' && !ctx.serviceOrderHistoryStore.markTerminalConfirmed?.(record.localId)) {
            ctx.setFeedback('观察到终态，但本地归档阶段写入失败；未删除 MVU 记录。');
            ctx.renderPage();
            return;
        }
        const requestId = ++ctx.interactionGeneration; ctx.serviceOrderMutationPendingId = record.localId;
        const token = ctx.setFeedback('正在继续移除 MVU 终态订单…'); ctx.renderPage(); let result;
        const consoleHandle = startConsoleEntry('继续归档', '正在继续移除终态订单……');
        try { result = await ctx.actionBridge.runServiceOrderFinalize?.({ orderUid: terminal.id }); } catch (error) { result = { ok: false, thrown: error }; }
        ctx.serviceOrderMutationPendingId = '';
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) {
            settleConsoleEntry('dismiss', consoleHandle, '提示已关闭，结果未展示。');
            return;
        }
        if (!result?.ok) {
            settleConsoleEntry('fail', consoleHandle, '继续归档未完成。', serviceFailureDetail('继续归档', result?.thrown ?? result, { stage: '移除终态订单', hint: '可稍后重试；本地记录仍保留待归档标记' }));
            ctx.setFeedback(describeActionFailure(result), token); ctx.renderPage(); return;
        }
        settleConsoleEntry('succeed', consoleHandle, '本地归档已完成。');
        ctx.serviceOrderHistoryStore.finalize(record.localId);
        ctx.refreshState(); ctx.setFeedback('已完成本地归档，并从 MVU 开放订单中移除。', token); ctx.renderPage();
    }
    async function deleteServiceHistory(record) {
        if (!record || ctx.serviceOrderMutationPendingId) return;
        if (!globalThis.confirm?.('删除后将同时移除本单全部服务角色，且无法恢复。确定删除吗？')) return;
        const requestId = ++ctx.interactionGeneration; ctx.serviceOrderMutationPendingId = record.localId;
        const token = ctx.setFeedback('正在删除历史与服务角色…'); ctx.renderPage(); let result;
        const consoleHandle = startConsoleEntry('删除服务历史', '正在删除本地历史与关联服务角色……');
        try { result = await ctx.actionBridge.deleteServiceHistoryRoles?.({ npcUids: record.roleUids }); } catch (error) { result = { ok: false, thrown: error }; }
        ctx.serviceOrderMutationPendingId = '';
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) {
            settleConsoleEntry('dismiss', consoleHandle, '提示已关闭，结果未展示。');
            return;
        }
        if (!result?.ok) {
            settleConsoleEntry('fail', consoleHandle, '删除服务历史未完成。', serviceFailureDetail('删除服务历史', result?.thrown ?? result, { stage: '受控删除孤立服务角色' }));
            ctx.setFeedback(describeActionFailure(result), token); ctx.renderPage(); return;
        }
        settleConsoleEntry('succeed', consoleHandle, '历史与关联服务角色已删除。');
        ctx.serviceOrderHistoryStore.remove(record.localId); ctx.refreshState(); ctx.setFeedback('历史与关联服务角色已删除，无法恢复。', token); ctx.renderPage();
    }
    async function repairServiceOrderIssue(issue) {
        if (!issue?.id || ctx.serviceOrderMutationPendingId || typeof ctx.actionBridge.repairServiceOrder !== 'function') return;
        const requestId = ++ctx.interactionGeneration; ctx.serviceOrderMutationPendingId = issue.id;
        const token = ctx.setFeedback('正在移除损坏服务记录…'); ctx.renderPage(); let result;
        const consoleHandle = startConsoleEntry('移除损坏订单', '正在移除损坏的服务订单记录……');
        try { result = await ctx.actionBridge.repairServiceOrder({ orderUid: issue.id }); } catch (error) { result = { ok: false, thrown: error }; }
        ctx.serviceOrderMutationPendingId = '';
        if (ctx.isDestroyed || requestId !== ctx.interactionGeneration) {
            settleConsoleEntry('dismiss', consoleHandle, '提示已关闭，结果未展示。');
            return;
        }
        if (!result?.ok) {
            settleConsoleEntry('fail', consoleHandle, '损坏记录未移除。', serviceFailureDetail('移除损坏订单', result?.thrown ?? result, { stage: '受控修复删除' }));
            ctx.setFeedback(describeActionFailure(result), token); ctx.renderPage(); return;
        }
        settleConsoleEntry('succeed', consoleHandle, '损坏服务记录已移除。');
        ctx.refreshState(); ctx.setFeedback('损坏服务记录已移除；可重新创建服务订单。', token); ctx.renderPage();
    }
    function buildServiceOrderIssueCard(issue) {
        const card = buildServiceHubCard('检测到损坏服务记录', issue?.message || '该记录无法安全显示。', ['已隐藏']);
        const repair = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-order-repair', disabled: ctx.serviceOrderMutationPendingId === issue?.id, text: ctx.serviceOrderMutationPendingId === issue?.id ? '正在修复…' : '移除损坏记录' });
        listen(repair, repair, 'click', () => { void repairServiceOrderIssue(issue); }, ctx.abortController.signal); card.appendChild(repair); return card;
    }
    /** 面向玩家的状态文案：由 mode 派生，原始状态枚举只留给持久层与校验。 */
    function serviceOrderStatusLabel(order) {
        const status = order?.status || '待确认';
        const modeCopy = getServiceModeCopy(order?.mode);
        if (status === '待确认') return modeCopy.pendingStatus;
        if (status === '进行中') return modeCopy.activeStatus;
        if (status === '暂停中') return '已暂停 · 待新修订';
        return status;
    }
    function buildServiceOrderCard(order) {
        const names = Array.isArray(order?.profiles) ? order.profiles.map((profile) => profile?.昵称).filter(Boolean) : [];
        const name = names.join('、') || order?.profile?.昵称 || '已复制角色';
        const status = order?.status || '待确认';
        const modeCopy = getServiceModeCopy(order?.mode);
        const statusLabel = serviceOrderStatusLabel(order);
        const note = order?.summary || (status === '待确认'
            ? '合同尚未由玩家和每位参与者逐人确认。'
            : status === '暂停中' ? '恢复前必须建立新修订并逐人重新确认。'
                : status === '进行中' ? (order?.withdrawalReady ? '正文提出了撤回候选，请优先暂停。' : order?.completionReady ? '正文提出完成候选，请由玩家决定完成或继续。' : '本轮正在正文中推进；可随时暂停或中止。')
                    : '本轮已进入终态。');
        const tags = [order.category, statusLabel];
        if (order.needsRenegotiation) tags.push('需重新协商');
        const card = buildServiceHubCard(name, note, tags); card.classList.toggle('yl-service-order-card', true); card.appendChild(element('span', { className: 'yl-service-order-topic', text: order.topic }));
        const time = order.endedAt || order.startedAt || order.initiatedAt; if (time) card.appendChild(element('span', { className: 'yl-service-order-time', text: time }));
        const mutationPending = ctx.serviceOrderMutationPendingId === order.id;
        if (status === '待确认' || status === '暂停中') {
            card.appendChild(createServiceBoundaryEditor(order));
            const actions = element('div', { className: 'yl-service-order-actions' });
            const refill = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-order-refill-draft', disabled: mutationPending, text: '重新填入协商草稿' });
            listen(refill, refill, 'click', () => { appendServiceExperienceDraft(order, order.mode, order.id); }, ctx.abortController.signal);
            actions.appendChild(refill);
            if (serviceOrderStep(order).step === serviceOrderSteps(order).length) {
                const consentReady = serviceBoundariesConsented(order);
                const confirm = element('button', { className: 'yl-settings-button', type: 'button', name: status === '暂停中' ? 'service-order-resume' : 'service-order-start', disabled: mutationPending || !consentReady, text: mutationPending ? '正在确认…' : consentReady ? (status === '暂停中' ? '确认新修订并恢复' : modeCopy.startAction) : '请先逐人确认' });
                listen(confirm, confirm, 'click', () => { void startServiceOrder(order); }, ctx.abortController.signal);
                actions.appendChild(confirm);
            }
            const cancel = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-order-cancel', disabled: mutationPending, text: status === '暂停中' ? '中止本轮' : '取消本轮' });
            listen(cancel, cancel, 'click', () => { void archiveAndFinalizeServiceOrder(order, status === '暂停中' ? '已中止' : '已取消'); }, ctx.abortController.signal);
            actions.appendChild(cancel);
            card.appendChild(actions);
        } else if (status === '进行中') {
            const actions = element('div', { className: 'yl-service-order-actions' });
            const draft = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-order-refill-draft', disabled: mutationPending, text: '重新填入约伴提示词' });
            listen(draft, draft, 'click', () => { appendServiceDealDraft(order, null, null, ctx.serviceOrderOperationEpoch, '已重新填入约伴提示词；请自行发送，小手机绝不自动发送。'); }, ctx.abortController.signal);
            const pause = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-order-pause', disabled: mutationPending, text: order?.withdrawalReady ? '优先暂停（正文已撤回）' : '暂停并重新协商' });
            listen(pause, pause, 'click', () => { void pauseServiceOrder(order); }, ctx.abortController.signal);
            const abort = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-order-abort', disabled: mutationPending, text: '中止本轮' });
            listen(abort, abort, 'click', () => { void archiveAndFinalizeServiceOrder(order, '已中止'); }, ctx.abortController.signal);
            append(actions, [draft, pause, abort]);
            if (order?.completionReady) {
                const candidate = element('div', { className: 'yl-service-order-completion' });
                candidate.appendChild(element('p', { text: '正文认为本轮已到结束节点。只有你能决定是否完成。' }));
                const finish = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-order-complete', disabled: mutationPending, text: modeCopy.finishAction });
                const keepGoing = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-order-continue', disabled: mutationPending, text: '还没结束，继续' });
                listen(finish, finish, 'click', () => { void archiveAndFinalizeServiceOrder(order, '已完成'); }, ctx.abortController.signal);
                listen(keepGoing, keepGoing, 'click', () => { void continueServiceOrder(order); }, ctx.abortController.signal);
                append(candidate, [finish, keepGoing]);
                actions.appendChild(candidate);
            } else actions.appendChild(element('p', { className: 'yl-service-order-completion', text: '正文尚未提出完成候选；小手机不会自动结单。' }));
            card.appendChild(actions);
        }
        if (isTerminalServiceOrder(order)) {
            const pending = ctx.serviceOrderRepeatPendingId === order.id;
            const repeat = element('button', { className: 'yl-settings-button yl-service-repeat-button', type: 'button', name: 'service-order-repeat', disabled: pending, text: pending ? '正在创建新约伴…' : modeCopy.repeatAction });
            repeat.setAttribute('aria-label', `${modeCopy.repeatAction}：${name}`);
            listen(repeat, repeat, 'click', () => { void repeatServiceOrder(order); }, ctx.abortController.signal);
            card.appendChild(repeat);
        }
        return card;
    }
    function openServiceOrderDetail(orderId) { activeServiceOrderDetailId = typeof orderId === 'string' ? orderId : ''; ctx.renderPage(); }
    function closeServiceOrderDetail() { activeServiceOrderDetailId = ''; ctx.renderPage(); }
    // 详情页对象资料卡：只渲染 projectPublicProfile 投影出的公开白名单字段；非公开层与关系分绝不进入 DOM。
    function buildServiceOrderProfileDetail(profile, index = 0) {
        const card = element('article', { className: 'yl-service-detail-profile' });
        card.appendChild(element('strong', { text: typeof profile?.昵称 === 'string' && profile.昵称.trim() ? profile.昵称.trim().slice(0, 80) : `第 ${index + 1} 位对象` }));
        const facts = [profile?.年龄段 || '明确成年人', profile?.性别, profile?.城市, profile?.寻找意图].filter((item) => typeof item === 'string' && item.trim());
        if (facts.length) { const row = element('div', { className: 'yl-service-tags' }); for (const fact of facts) row.appendChild(element('span', { text: fact })); card.appendChild(row); }
        if (typeof profile?.简介 === 'string' && profile.简介.trim()) card.appendChild(element('p', { text: profile.简介 }));
        const tags = Array.isArray(profile?.兴趣标签) ? profile.兴趣标签.slice(0, 6) : [];
        if (tags.length) { const row = element('div', { className: 'yl-service-tags yl-service-detail-tags' }); for (const tag of tags) row.appendChild(element('span', { text: tag })); card.appendChild(row); }
        return card;
    }
    function buildServiceOrderSummaryCard(order) {
        const names = Array.isArray(order?.profiles) ? order.profiles.map((profile) => profile?.昵称).filter(Boolean) : [];
        const name = names.join('、') || order?.profile?.昵称 || '已复制角色';
        const note = order.status === '待确认'
            ? '点开详情查看公开资料并逐人确认合同。'
            : order.status === '暂停中' ? '已暂停：建立新修订并逐人确认后才能恢复。'
                : order?.withdrawalReady ? '正文提出撤回候选，请优先暂停。'
                    : order?.completionReady ? '正文提出完成候选，等待玩家决定完成或继续。' : '正在正文中推进：可随时暂停、重签或中止。';
        const card = buildServiceHubCard(name, note, [order.category, serviceOrderStatusLabel(order)]);
        card.classList.toggle('yl-service-order-summary', true);
        const time = order.endedAt || order.startedAt || order.initiatedAt;
        if (time) card.appendChild(element('span', { className: 'yl-service-order-time', text: time }));
        const open = element('button', { className: 'yl-settings-button yl-service-order-open-detail', type: 'button', name: 'service-order-open-detail', text: '查看约伴详情' });
        open.setAttribute('aria-label', `查看约伴详情：${name}`);
        listen(open, open, 'click', () => openServiceOrderDetail(order.id), ctx.abortController.signal);
        card.appendChild(open);
        return card;
    }
    function buildServiceOrderDetailPage(order) {
        const wrap = element('section', { className: 'yl-service-order-detail', ariaLabel: '约伴详情' });
        const back = element('button', { className: 'yl-settings-button yl-service-detail-back', type: 'button', name: 'service-order-detail-back', text: '返回约伴列表' });
        listen(back, back, 'click', () => closeServiceOrderDetail(), ctx.abortController.signal);
        wrap.appendChild(back);
        wrap.appendChild(element('strong', { className: 'yl-service-detail-title', text: `约伴详情 · ${serviceOrderStatusLabel(order)}` }));
        const profiles = Array.isArray(order?.profiles) && order.profiles.length ? order.profiles : [order?.profile];
        const profileList = element('div', { className: 'yl-service-detail-profiles' });
        profiles.forEach((profile, index) => profileList.appendChild(buildServiceOrderProfileDetail(profile, index)));
        wrap.appendChild(profileList);
        if (order.contractSummary) {
            const contract = order.contractSummary;
            const contractCard = buildServiceHubCard(
                `合同 v${contract.version}${contract.revision ? ` · 修订 ${contract.revision}` : ''}`,
                `${contract.topic || order.topic} · 允许：${contract.allowed || '待重新确认'} · 排除：${contract.excluded || '待重新确认'} · 隐私：${contract.privacy || '最小留存'}`,
                [contract.experienceType, order.contractHealth === 'recoverable' ? '需重新协商' : '已验证'],
            );
            wrap.appendChild(contractCard);
        } else if (order.needsRenegotiation) wrap.appendChild(buildServiceHubCard('旧合同需要重新协商', '旧文本不会直接渲染，也不能继续或结单；你仍可安全暂停、中止，或建立新修订。', ['安全降级']));
        wrap.appendChild(buildServiceOrderCard(order));
        return wrap;
    }
    function buildLocalServiceHistoryCard(record) {
        const name = record?.profile?.昵称 || '已归档约伴对象';
        const pending = ctx.serviceOrderMutationPendingId === record?.localId;
        const needsArchive = record?.archiveState === 'pending_archive';
        const menuOpen = openServiceRecordMenuId === record?.localId;
        const statusChip = createStatusChip({ documentRef: ctx.documentRef, text: record?.status || '已归档', tone: record?.status === '已完成' ? 'success' : record?.status === '已取消' ? 'neutral' : 'info' });
        const archiveChip = createStatusChip({ documentRef: ctx.documentRef, text: needsArchive ? '待归档' : '已归档', tone: needsArchive ? 'warning' : 'neutral' });
        const row = createListRow({
            documentRef: ctx.documentRef,
            title: name,
            subtitle: record?.topic || record?.summary || '仅保留最小化本地订单标记。',
            meta: { time: record?.endedAt || '', chips: [statusChip, archiveChip] },
        });
        const container = element('article', { className: 'yl-service-record' });
        const main = element('div', { className: 'yl-service-record-main' });
        const more = createButton({
            documentRef: ctx.documentRef,
            variant: 'icon',
            icon: 'more_vertical',
            ariaLabel: `更多操作：${name}`,
            onClick: () => { openServiceRecordMenuId = menuOpen ? '' : String(record?.localId ?? ''); ctx.renderPage(); },
        });
        more.classList.toggle('yl-service-record-more', true);
        more.setAttribute('name', `service-history-menu-${record?.localId ?? ''}`);
        more.setAttribute('aria-expanded', String(menuOpen));
        append(main, [row, more]);
        container.appendChild(main);
        const menu = element('div', { className: 'yl-service-record-menu', hidden: !menuOpen });
        const rebook = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-history-rebook', disabled: pending || needsArchive, text: pending ? '正在创建…' : getServiceModeCopy(record?.mode).repeatAction });
        listen(rebook, rebook, 'click', () => { openServiceRecordMenuId = ''; void rebookServiceHistory(record); }, ctx.abortController.signal);
        if (needsArchive) {
            const finalize = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-history-finalize', disabled: pending, text: pending ? '正在继续归档…' : '继续归档' });
            listen(finalize, finalize, 'click', () => { openServiceRecordMenuId = ''; void finalizePendingServiceHistory(record); }, ctx.abortController.signal);
            menu.appendChild(finalize);
        }
        menu.appendChild(rebook);
        const remove = element('button', { className: 'yl-settings-button', type: 'button', name: 'service-history-delete', disabled: pending, text: '删除历史与角色' });
        listen(remove, remove, 'click', () => { openServiceRecordMenuId = ''; void deleteServiceHistory(record); }, ctx.abortController.signal);
        menu.appendChild(remove);
        container.appendChild(menu);
        if (needsArchive) container.appendChild(element('p', { className: 'yl-service-record-note', text: '该记录等待与 MVU 终态同步；「继续归档」只会重试删除终态记录，不会创建新约伴。' }));
        return container;
    }
    function buildServicePublicationPanel(copy) {
        const panel = buildServiceHubCard('本地候选批次', '每个来源仅展示当前模式最近生成的本地候选；刷新会使用约伴角色生成绑定，候选本身不会写入 MVU。', ['会话内', '可刷新']);
        const list = element('div', { className: 'yl-service-publication-list' });
        for (const category of copy.categories) {
            const batch = ctx.serviceGenerationBatches.get(serviceBatchKey(ctx.currentView.mode, category.id));
            const count = profilesForServiceBatch(ctx.currentView.mode, category.id, { readyOnly: true }).length;
            const row = element('div', { className: 'yl-service-publication-row' });
            append(row, [element('strong', { text: category.label }), element('span', { text: count ? `已有 ${count}/3 位候选` : '尚无候选' })]);
            const actions = element('div', { className: 'yl-service-order-actions' });
            const open = element('button', { className: 'yl-settings-button', type: 'button', name: `service-published-open-${category.id}`, text: count ? '查看候选' : '生成候选' });
            listen(open, open, 'click', () => {
                ctx.activeServiceCategoryId = category.id;
                ctx.activeServiceHubTab = 'featured';
                ctx.renderPage();
                if (!batch?.complete) void generateLocalServiceProfiles(category.id);
            }, ctx.abortController.signal);
            actions.appendChild(open);
            if (count === SERVICE_PROFILE_SLOT_COUNT && batch?.complete) {
                const refresh = element('button', { className: 'yl-settings-button', type: 'button', name: `service-published-refresh-${category.id}`, disabled: ctx.serviceProfileGenerationPending, text: '刷新候选' });
                listen(refresh, refresh, 'click', () => { void generateLocalServiceProfiles(category.id, { refresh: true }); }, ctx.abortController.signal);
                actions.appendChild(refresh);
            }
            row.appendChild(actions); list.appendChild(row);
        }
        panel.appendChild(list); return panel;
    }
    function buildServiceXpSearchControls(category) {
        const searchView = buildServiceSearchView({ mode: ctx.currentView.mode, query: ctx.serviceXpSearchDraft, selectedFilterIds: serviceSelectedFilterIds });
        const section = element('section', { className: 'yl-service-xp-search', ariaLabel: searchView.sectionLabel });
        append(section, [
            element('strong', { text: searchView.sectionLabel }),
            element('p', { text: searchView.helperText }),
        ]);
        const filters = element('div', { className: 'yl-service-filter-row', ariaLabel: '快捷筛选' });
        for (const filter of searchView.quickFilters) {
            const selected = searchView.selectedFilterIds.includes(filter.id);
            const button = element('button', { className: 'yl-service-filter-chip', type: 'button', name: `service-filter-${filter.id}`, pressed: selected, text: filter.label });
            button.classList.toggle('is-active', selected);
            listen(button, button, 'click', () => {
                serviceSelectedFilterIds = selected ? serviceSelectedFilterIds.filter((id) => id !== filter.id) : [...serviceSelectedFilterIds, filter.id].slice(-4);
                ctx.renderPage();
            }, ctx.abortController.signal);
            filters.appendChild(button);
        }
        section.appendChild(filters);
        const row = element('div', { className: 'yl-service-xp-search-row' });
        const input = element('input', { className: 'yl-settings-control yl-service-xp-search-input', type: 'search', name: 'service-xp-search', maxLength: 80, value: ctx.serviceXpSearchDraft, placeholder: searchView.placeholder, ariaLabel: searchView.sectionLabel });
        const applySearch = () => {
            const query = normalizeServiceXpSearch(ctx.serviceXpSearchDraft);
            const latest = buildServiceSearchView({ mode: ctx.currentView.mode, query, selectedFilterIds: serviceSelectedFilterIds });
            const next = normalizeServiceXpSearch([query, ...latest.appliedTokens].filter(Boolean).join('；'));
            ctx.serviceXpSearchDraft = query;
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
        const clear = element('button', { className: 'yl-settings-button yl-service-xp-search-clear', type: 'button', name: 'service-xp-search-clear', disabled: !ctx.serviceXpSearchDraft && !ctx.serviceXpSearchApplied && !serviceSelectedFilterIds.length, text: '清除' });
        listen(clear, clear, 'click', () => { ctx.serviceXpSearchDraft = ''; ctx.serviceXpSearchApplied = ''; serviceSelectedFilterIds = []; ctx.selectedServiceProfileIds.clear(); ctx.renderPage(); }, ctx.abortController.signal);
        append(row, [input, search, clear]);
        section.appendChild(row);
        if (ctx.serviceXpSearchApplied) section.appendChild(element('span', { className: 'yl-service-xp-search-active', text: `当前${searchView.sectionLabel}：${ctx.serviceXpSearchApplied}` }));
        return section;
    }
    function serviceHistoryForMode(mode = ctx.currentView.mode) {
        return typeof ctx.serviceOrderHistoryStore?.list === 'function'
            ? ctx.serviceOrderHistoryStore.list({ includeInternal: true }).filter((record) => record.mode === mode)
            : [];
    }
    function serviceRotationKey() {
        try { return new Date().toISOString().slice(0, 10); } catch { return 'local-rotation'; }
    }
    function buildServiceInspirationPanel(category) {
        const history = serviceHistoryForMode();
        const panel = element('section', { className: 'yl-service-inspiration', ariaLabel: '长期探索灵感' });
        panel.appendChild(element('strong', { text: '今日灵感馆' }));
        const themes = getServiceThemeRotation({ mode: ctx.currentView.mode, rotationKey: serviceRotationKey(), history, limit: 3 });
        const recommendations = deriveServiceRecommendations({ mode: ctx.currentView.mode, history, rotationKey: serviceRotationKey(), limit: 2 });
        const grid = element('div', { className: 'yl-service-theme-grid' });
        for (const theme of themes) {
            const card = buildServiceHubCard(theme.title, theme.subtitle, []);
            const action = element('button', { className: 'yl-settings-button', type: 'button', name: `service-theme-${theme.id}`, text: '用这个灵感生成' });
            listen(action, action, 'click', () => {
                const target = theme.categoryIds.includes(category?.id) ? category?.id : theme.categoryIds[0];
                if (target) ctx.activeServiceCategoryId = target;
                ctx.serviceXpSearchDraft = theme.title;
                ctx.serviceXpSearchApplied = normalizeServiceXpSearch(theme.title);
                ctx.selectedServiceProfileIds.clear();
                ctx.renderPage();
            }, ctx.abortController.signal);
            card.appendChild(action); grid.appendChild(card);
        }
        panel.appendChild(grid);
        if (recommendations.length) {
            const rec = element('div', { className: 'yl-service-recommendation-strip' });
            rec.appendChild(element('strong', { text: '按你的最小足迹推荐' }));
            for (const item of recommendations) rec.appendChild(element('p', { text: `${item.title} · ${item.reason}` }));
            panel.appendChild(rec);
        }
        return panel;
    }
    function buildServiceExplorationPanel(history) {
        const atlas = deriveServiceExplorationAtlas({ mode: ctx.currentView.mode, history });
        const panel = buildServiceHubCard(atlas.title, `已完成 ${atlas.totalCompleted} 次 · 点亮 ${atlas.uniqueCategories}/3 个方向 · 下一目标：${atlas.nextGoal}`, []);
        const categories = element('div', { className: 'yl-service-atlas-grid' });
        for (const item of atlas.categories) categories.appendChild(buildServiceHubCard(item.label, `${item.progressText} · 完成 ${item.visits} 次`, [item.discovered ? '已点亮' : '待探索']));
        panel.appendChild(categories);
        const milestones = element('div', { className: 'yl-service-tags' });
        for (const milestone of atlas.milestones) milestones.appendChild(element('span', { text: `${milestone.unlocked ? '✓' : '○'} ${milestone.label} ${milestone.progressText}` }));
        panel.appendChild(milestones);
        return panel;
    }
    function buildServiceHubPage() {
        const copy = serviceHubModeCopy(); const category = serviceCategory(copy, ctx.activeServiceCategoryId); const section = element('section', { className: 'yl-service-hub', ariaLabel: '专属服务小程序' });
        const activeTab = normalizeServiceHubTab(ctx.activeServiceHubTab);
        const hubTabs = getServiceHubTabs(ctx.currentView.mode).map((tab) => ({ ...tab, iconName: SERVICE_TAB_ICONS[tab.id] }));
        const tabs = element('div', { className: 'yl-service-tabs', ariaLabel: '专属服务导航' }); tabs.setAttribute('role', 'tablist');
        const tabButtons = [];
        const focusServiceHubTab = (tabId) => { ctx.root.querySelectorAll?.(`[name="service-hub-tab-${tabId}"]`)?.[0]?.focus?.(); };
        for (const item of hubTabs) {
            const active = activeTab === item.id;
            const tab = element('button', { className: 'yl-service-tab', type: 'button', name: `service-hub-tab-${item.id}`, ariaLabel: item.label });
            tab.setAttribute('role', 'tab');
            tab.setAttribute('id', `yl-service-hub-tab-${item.id}`);
            tab.setAttribute('aria-selected', String(active));
            tab.setAttribute('aria-controls', 'yl-service-hub-panel');
            if (active) tab.setAttribute('aria-current', 'page');
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
            const from = current >= 0 ? current : Math.max(0, hubTabs.findIndex((entry) => entry.id === activeTab));
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
        body.setAttribute('aria-labelledby', `yl-service-hub-tab-${activeTab}`);
        if (activeTab === 'featured') {
            const hero = element('article', { className: 'yl-service-hero' }); append(hero, [element('span', { className: 'yl-service-mode-badge', text: copy.label }), element('h2', { text: copy.title }), element('p', { text: copy.subtitle }), element('p', { className: 'yl-service-trust-line', text: copy.trustLine })]); body.appendChild(hero);
            body.appendChild(buildServiceInspirationPanel(category));
            const categoryRow = element('div', { className: 'yl-service-category-row', ariaLabel: '约伴来源' });
            for (const item of copy.categories) {
                const button = element('button', { className: 'yl-service-category', type: 'button', name: `service-category-${item.id}`, ariaLabel: `选择${item.label}`, pressed: ctx.activeServiceCategoryId === item.id });
                button.classList.toggle('is-active', ctx.activeServiceCategoryId === item.id);
                append(button, [element('strong', { text: item.label }), element('span', { text: item.note })]);
                listen(button, button, 'click', () => { ctx.activeServiceCategoryId = item.id; ctx.selectedServiceProfileIds.clear(); ctx.renderPage(); }, ctx.abortController.signal);
                categoryRow.appendChild(button);
            }
            body.appendChild(categoryRow);
            body.appendChild(buildServiceXpSearchControls(category));
            body.appendChild(buildServiceProfileGenerator(category, ctx.serviceXpSearchApplied));
            const visibleProfiles = profilesForServiceBatch(ctx.currentView.mode, category?.id, { readyOnly: true, xpSearch: ctx.serviceXpSearchApplied });
            if (visibleProfiles.length === SERVICE_PROFILE_SLOT_COUNT) body.appendChild(buildServiceSelectionTray(category));
            const collapse = element('section', { className: 'yl-service-collapse', ariaLabel: '本地候选批次面板' });
            const toggle = element('button', { className: 'yl-service-collapse-toggle', type: 'button', name: 'service-publication-toggle' });
            toggle.setAttribute('aria-expanded', String(servicePublicationOpen));
            append(toggle, [element('span', { text: servicePublicationOpen ? '收起候选批次面板' : '展开候选批次面板' }), createUiIcon(ctx.documentRef, 'chevron_right', { className: 'yl-ui-icon yl-service-collapse-chevron', size: 16 })]);
            listen(toggle, toggle, 'click', () => { servicePublicationOpen = !servicePublicationOpen; ctx.renderPage(); }, ctx.abortController.signal);
            collapse.appendChild(toggle);
            if (servicePublicationOpen) collapse.appendChild(buildServicePublicationPanel(copy));
            body.appendChild(collapse);
            body.appendChild(buildServiceHubCard('使用前确认', `${copy.safetyNote} 候选仅保留在当前小手机会话；选入后才通过受控管线建立约伴。`, ['逐人确认', '可暂停撤回', '不自动发送']));
            const detailProfile = visibleProfiles.find((profile) => profile.id === serviceCandidateDetailId);
            const sheet = detailProfile ? buildServiceCandidateDetailSheet(detailProfile) : null;
            if (sheet) section.appendChild(sheet);
        } else if (activeTab === 'orders') {
            const active = serviceOrdersForCurrentMode().filter((order) => ['待确认', '进行中', '暂停中'].includes(order.status));
            const detailOrder = active.find((order) => order.id === activeServiceOrderDetailId) ?? null;
            if (!detailOrder && activeServiceOrderDetailId) activeServiceOrderDetailId = ''; // 订单已结单/取消或模式切换后自动回到列表。
            if (detailOrder) {
                body.appendChild(buildServiceOrderDetailPage(detailOrder));
            } else {
                if (!active.length) {
                    const otherModeOpen = (ctx.currentView.serviceOrders || []).find((order) => order.mode !== ctx.currentView.mode && ['待确认', '进行中', '暂停中'].includes(order.status));
                    body.appendChild(otherModeOpen
                        ? buildServiceHubCard('另一内容模式有开放约伴', '为避免并行合同冲突，请切换回它所属的内容模式并先处理；这里不会展示对方模式的私密细节。', ['全局仅一笔开放约伴'])
                        : buildServiceHubCard('暂无进行中的约伴', `从「${copy.featuredLabel}」选择本地候选后才会建立待确认约伴。正文草稿仍须由你自行发送。`, ['不自动发送']));
                }
                for (const order of active) body.appendChild(buildServiceOrderSummaryCard(order));
                for (const issue of (ctx.currentView.serviceOrderIssues || [])) body.appendChild(buildServiceOrderIssueCard(issue));
            }
            body.appendChild(buildServiceHubCard('安全边界', '多人约伴必须由每一位明确成年人分别确认；历史、关系、公开偏好与他人的表态都不能替代当次同意。', ['禁止默认同意', '可暂停撤回']));
        } else {
            const history = serviceHistoryForMode();
            body.appendChild(buildServiceExplorationPanel(history));
            if (!history.length) body.appendChild(buildServiceHubCard('暂无足迹', '完成、取消或中止后只在当前浏览器保存最小记录；再次邀约会建立全新合同，不继承此前边界。', ['重新确认', '最小留存']));
            const list = element('div', { className: 'yl-service-record-list' });
            for (const record of history) list.appendChild(buildLocalServiceHistoryCard(record));
            if (history.length) body.appendChild(list);
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
        serviceDealDraft,
        appendServiceDealDraft,
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
        serviceOrderStep,
        setServiceOrderStep,
        serviceStepSummary,
        createServiceBoundaryEditor,
        archiveAndFinalizeServiceOrder,
        recoverTerminalServiceOrder,
        pauseServiceOrder,
        continueServiceOrder,
        startServiceOrder,
        rebookServiceHistory,
        finalizePendingServiceHistory,
        deleteServiceHistory,
        repairServiceOrderIssue,
        buildServiceOrderIssueCard,
        buildServiceOrderCard,
        buildServiceOrderSummaryCard,
        buildServiceOrderProfileDetail,
        buildServiceOrderDetailPage,
        openServiceOrderDetail,
        closeServiceOrderDetail,
        buildLocalServiceHistoryCard,
        buildServicePublicationPanel,
        buildServiceXpSearchControls,
        buildServiceHubPage,
    };
}

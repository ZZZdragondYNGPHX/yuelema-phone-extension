import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';

const miniDom = installMiniDom();
const { createServicePage, normalizeServiceHubTab } = await import('../../pages/service.js');

test.after(() => miniDom.restore());

function click(node) {
    assert.ok(node, '要点击的控件必须存在');
    node.dispatchEvent(new Event('click'));
}

function setChecked(input, value) {
    assert.ok(input, '要勾选的复选框必须存在');
    input.checked = Boolean(value);
    input.dispatchEvent(new Event('change'));
}

function typeInto(input, value) {
    assert.ok(input, '要输入的控件必须存在');
    input.value = String(value);
    input.dispatchEvent(new Event('input'));
}

async function flushUi() {
    for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function adultCandidate(name) {
    return { 成人验证: true, 公开资料: { 昵称: name, 年龄段: '25-29', 简介: '本地草稿角色。', 兴趣标签: ['看展', '散步'] } };
}

function createHarness({ bridge = {}, orders = [], issues = [], history = [], mode = 'SFW', activeTab = 'home' } = {}) {
    const container = miniDom.document.createElement('div');
    miniDom.document.body.appendChild(container);
    const feedback = [];
    const ctx = {
        documentRef: miniDom.document,
        root: container,
        abortController: new AbortController(),
        currentView: { mode, serviceOrders: orders, serviceOrderIssues: issues },
        actionBridge: bridge,
        serviceOrderHistoryStore: { list: () => history, stage: () => ({ localId: 'history_stage_1' }), markArchived: () => true, remove: () => true },
        serviceLocalProfiles: [],
        serviceGenerationBatches: new Map(),
        selectedServiceProfileIds: new Set(),
        serviceBoundaryDrafts: new Map(),
        serviceXpSearchDraft: '',
        serviceXpSearchApplied: '',
        activeServiceHubTab: activeTab,
        activeServiceCategoryId: 'girl_shuren',
        interactionGeneration: 0,
        serviceProfileSequence: 0,
        serviceGenerationBatchSequence: 0,
        serviceOrderOperationEpoch: 0,
        serviceProfileGenerationPending: false,
        serviceProfileGenerationAbortController: null,
        serviceProfileHandoffPendingId: '',
        serviceOrderRepeatPendingId: '',
        serviceOrderMutationPendingId: '',
        isDestroyed: false,
        canAppendServiceExperienceDraft: () => true,
        refreshState: () => {},
        setFeedback: (message, token = null) => { feedback.push(String(message ?? '')); return token ?? { id: feedback.length }; },
        renderPage: () => {},
    };
    const page = createServicePage(ctx);
    ctx.renderPage = () => { container.replaceChildren(page.buildServiceHubPage()); };
    ctx.renderPage();
    const destroy = () => { ctx.isDestroyed = true; ctx.abortController.abort(); container.remove(); };
    return { ctx, page, container, feedback, destroy };
}

test('约伴页收成三 tab：精选/订单/记录，旧 tab id 折算且可来回切换', () => {
    const harness = createHarness();
    const { ctx, container } = harness;
    try {
        const tabs = () => container.querySelectorAll('.yl-service-tab');
        assert.deepEqual(tabs().map((tab) => tab.textContent), ['精选', '订单', '记录']);
        assert.deepEqual(
            tabs().map((tab) => tab.querySelector('svg')?.dataset.icon),
            ['sparkle', 'service_hub', 'clock'],
            '三 tab 使用本地 SVG 结构图标',
        );
        // 壳层复位写入的旧 id「home」应折算为精选并渲染 hero。
        assert.equal(tabs()[0].getAttribute('aria-selected'), 'true');
        assert.match(container.textContent, /今日心动档案/u);
        assert.ok(container.querySelector('[name="service-category-girl_shuren"]'), '精选应包含分类卡');

        click(container.querySelector('[name="service-hub-tab-orders"]'));
        assert.equal(ctx.activeServiceHubTab, 'orders');
        assert.match(container.textContent, /暂无进行中的服务/u);
        assert.match(container.textContent, /「精选」/u, '订单空态引导指向精选而非旧「发现」');

        click(container.querySelector('[name="service-hub-tab-records"]'));
        assert.equal(ctx.activeServiceHubTab, 'records');
        assert.match(container.textContent, /暂无历史记录/u);

        // 旧内部命名统一折算。
        ctx.activeServiceHubTab = 'service';
        ctx.renderPage();
        assert.equal(container.querySelector('[name="service-hub-tab-orders"]').getAttribute('aria-selected'), 'true');
        ctx.activeServiceHubTab = 'history';
        ctx.renderPage();
        assert.equal(container.querySelector('[name="service-hub-tab-records"]').getAttribute('aria-selected'), 'true');
        ctx.activeServiceHubTab = 'discover';
        ctx.renderPage();
        assert.equal(container.querySelector('[name="service-hub-tab-featured"]').getAttribute('aria-selected'), 'true');
        assert.equal(normalizeServiceHubTab('home'), 'featured');
        assert.equal(normalizeServiceHubTab('service'), 'orders');
        assert.equal(normalizeServiceHubTab('history'), 'records');
        assert.equal(normalizeServiceHubTab('未知值'), 'featured');
    } finally {
        harness.destroy();
    }
});

test('三席生成器：空席虚线框、生成中骨架、完成后角色卡带勾选并可多选下单', async () => {
    const resolvers = [];
    const handoffDrafts = [];
    let handoffCalls = 0;
    const bridge = {
        generateServiceProfileDraft: () => new Promise((resolve) => { resolvers.push(resolve); }),
        async runServiceOrderHandoff({ candidates, categoryId, expectedContentMode }) {
            handoffCalls += 1;
            assert.deepEqual(candidates.map((candidate) => candidate.公开资料.昵称), ['林澄', '顾晴']);
            assert.equal(categoryId, 'girl_shuren');
            assert.equal(expectedContentMode, 'SFW');
            return { ok: true, orderUid: 'service_1', npcUids: ['npc_service_1', 'npc_service_2'] };
        },
        appendMeetupDraft(draft) { handoffDrafts.push(draft); return { ok: true }; },
    };
    const harness = createHarness({ bridge });
    const { ctx, container } = harness;
    try {
        // 空席：三个虚线框，只有第一席给「生成」钮，其余提示等待。
        assert.equal(container.querySelectorAll('.yl-service-slot--empty').length, 3);
        assert.equal(container.querySelectorAll('[name="service-slot-generate"]').length, 1);
        assert.equal(container.querySelectorAll('.yl-skeleton').length, 0);

        click(container.querySelector('[name="service-slot-generate"]'));
        await flushUi();
        // 生成中：当前席位换成骨架屏，且未开放任何勾选。
        assert.equal(resolvers.length, 1, '三席必须串行，只允许一个在途请求');
        assert.equal(container.querySelectorAll('.yl-service-slot--loading').length, 1);
        assert.ok(container.querySelector('.yl-service-slot--loading').querySelector('.yl-skeleton'));
        assert.equal(container.querySelectorAll('.yl-local-service-profile').length, 0);

        resolvers.shift()({ ok: true, candidate: adultCandidate('林澄') });
        await flushUi();
        assert.equal(container.querySelectorAll('.yl-service-slot--staged').length, 1, '首席通过校验后以待命卡显示');
        assert.match(container.textContent, /三席未齐前暂不开放选择/u);
        assert.equal(container.querySelectorAll('.yl-local-service-profile').length, 0, '三席未齐前不得开放候选下单');

        resolvers.shift()({ ok: true, candidate: adultCandidate('顾晴') });
        await flushUi();
        resolvers.shift()({ ok: true, candidate: adultCandidate('周岚') });
        await flushUi();

        // 完成：三张角色卡各带勾选框，进度徽标 3/3。
        assert.equal(container.querySelectorAll('.yl-local-service-profile').length, 3);
        assert.match(container.textContent, /当前进度 3\/3/u);
        const firstCheck = container.querySelector('[name="service-profile-select-service_local_1"]');
        const secondCheck = container.querySelector('[name="service-profile-select-service_local_2"]');
        assert.ok(firstCheck); assert.ok(secondCheck);
        const createButton = () => container.querySelector('[name="service-order-create-selected"]');
        assert.equal(createButton().disabled, true, '未选择时不可下单');

        setChecked(firstCheck, true);
        await flushUi();
        setChecked(container.querySelector('[name="service-profile-select-service_local_2"]'), true);
        await flushUi();
        assert.match(createButton().textContent, /以已选 2 位创建服务订单/u);
        assert.equal(createButton().disabled, false);

        click(createButton());
        await flushUi();
        assert.equal(handoffCalls, 1, '多选下单仍走 runServiceOrderHandoff 原调用链');
        assert.equal(handoffDrafts.length, 1);
        assert.match(handoffDrafts[0], /与「林澄、顾晴」体验「熟人商品」租借陪伴主题/u);
        assert.doesNotMatch(handoffDrafts[0], /service_1|npc_service_/u, '正文草稿不得暴露内部 UID');
    } finally {
        harness.destroy();
    }
});

test('订单 Stepper：详情页内三步流转、可回跳、确认成交只在第三步出现且提交结构不变', async () => {
    const startPayloads = [];
    const dealDrafts = [];
    const bridge = {
        async runServiceOrderStart({ orderUid, boundaries, expectedContentMode }) {
            startPayloads.push({ orderUid, boundaries, expectedContentMode });
            return { ok: true };
        },
        appendMeetupDraft(draft) { dealDrafts.push(String(draft ?? '')); return { ok: true }; },
    };
    const order = {
        id: 'service_1', mode: 'SFW', status: '待确认', category: '熟人商品',
        topic: '熟人商品：与林澄、顾晴的文字协商', summary: '', initiatedAt: '待正文确认',
        profiles: [{ 昵称: '林澄' }, { 昵称: '顾晴' }],
    };
    const harness = createHarness({ bridge, orders: [order], activeTab: 'orders' });
    const { container } = harness;
    try {
        // 订单 tab 先显示摘要列表；点开详情后才出现 Stepper 与操作按钮。
        assert.ok(container.querySelector('[name="service-order-open-detail"]'), '待处理订单在列表中提供详情入口');
        assert.equal(container.querySelector('.yl-service-step-tab'), null, '列表态不直接平铺 Stepper');
        click(container.querySelector('[name="service-order-open-detail"]'));
        // 第 1 步：边界字段可见；服务信息与确认钮都不出现；取消/重填始终可见。
        assert.equal(container.querySelectorAll('.yl-service-step-tab').length, 3);
        assert.ok(container.querySelector('[name="service-boundary-主题"]'));
        assert.equal(container.querySelector('[name="service-information-价格"]'), null);
        assert.equal(container.querySelector('[name="service-order-start"]'), null, '确认成交只允许出现在第三步');
        assert.ok(container.querySelector('[name="service-order-cancel"]'));
        assert.ok(container.querySelector('[name="service-order-refill-draft"]'));
        assert.equal(container.querySelector('[name="service-step-3"]').disabled, true, '未到达的步骤不可跳跃');

        typeInto(container.querySelector('[name="service-boundary-主题"]'), '今晚看展');
        click(container.querySelector('[name="service-step-next"]'));

        // 第 2 步：两列服务信息网格 + 第 1 步摘要行。
        assert.ok(container.querySelector('.yl-service-grid-2'));
        assert.ok(container.querySelector('[name="service-information-价格"]'));
        assert.ok(container.querySelector('[name="service-information-服务者信用"]'));
        assert.equal(container.querySelector('[name="service-order-start"]'), null);
        assert.match(container.textContent, /第 1 步 · 边界与强度：今晚看展/u);

        click(container.querySelector('[name="service-step-next"]'));

        // 第 3 步：玩家勾选 + 每位 NPC 一张同意小卡；确认钮出现但默认禁用。
        assert.equal(container.querySelectorAll('.yl-service-consent-card').length, 2);
        assert.ok(container.querySelector('[name="service-boundary-player-consent"]'));
        const start = () => container.querySelector('[name="service-order-start"]');
        assert.ok(start());
        assert.equal(start().disabled, true, '未逐人确认前不可接单');
        assert.match(container.textContent, /已填写 0\/8 项服务信息/u, '第 2 步完成后显示摘要行');

        // 回跳：步骤条可回到第 1 步，再直接跳回已到访的第 3 步。
        click(container.querySelector('[name="service-step-1"]'));
        assert.equal(container.querySelector('[name="service-boundary-主题"]').value, '今晚看展', '回跳后草稿保留');
        assert.equal(start(), null);
        click(container.querySelector('[name="service-step-3"]'));
        assert.ok(start());

        setChecked(container.querySelector('[name="service-boundary-player-consent"]'), true);
        setChecked(container.querySelector('[name="service-boundary-npc-consent-1"]'), true);
        setChecked(container.querySelector('[name="service-boundary-npc-consent-2"]'), true);
        assert.equal(start().disabled, false, '逐人确认后开放接单');

        click(start());
        await flushUi();
        assert.equal(startPayloads.length, 1);
        assert.equal(startPayloads[0].orderUid, 'service_1');
        assert.equal(startPayloads[0].expectedContentMode, 'SFW');
        assert.deepEqual(startPayloads[0].boundaries, {
            内容模式: 'SFW',
            主题: '今晚看展',
            允许项: '由双方在正文中确认的内容',
            排除项: '未明确同意的内容',
            强度: '轻松陪伴',
            隐私处理: '仅保留最小化订单摘要',
            服务信息: { 价格: '', 时长: '', 排期: '', 套餐: '', 评价: '', 投诉: '', 退款: '', 服务者信用: '' },
            玩家已同意: true,
            NPC明确同意: [true, true],
        }, '三步 Stepper 重排 UI 后提交的数据结构必须与原一张卡完全一致');
        assert.equal(dealDrafts.length, 1, '确认成交后必须把成交提示词填入正文输入框');
        assert.match(dealDrafts[0], /【订单已成交】/u);
        assert.match(dealDrafts[0], /「林澄、顾晴」/u, '成交提示词包含对象信息');
        assert.match(dealDrafts[0], /主题「今晚看展」/u, '成交提示词包含本次服务内容要求');
        assert.match(dealDrafts[0], /合法结束条件/u, '成交提示词说明正文完成后的变量更新约定');
        assert.doesNotMatch(dealDrafts[0], /service_1|npc_service_/u, '成交提示词不得暴露内部 UID');
    } finally {
        harness.destroy();
    }
});

test('订单详情页：展示对象公开资料、返回列表，取消订单走取消→归档→终态删除链', async () => {
    const calls = [];
    const bridge = {
        async runServiceOrderCancel({ orderUid, expectedContentMode }) { calls.push(['cancel', orderUid, expectedContentMode]); return { ok: true }; },
        async runServiceOrderComplete({ orderUid }) { calls.push(['complete', orderUid]); return { ok: true }; },
        async runServiceOrderFinalize({ orderUid }) { calls.push(['finalize', orderUid]); return { ok: true }; },
        appendMeetupDraft() { return { ok: true }; },
    };
    const order = {
        id: 'service_1', mode: 'SFW', status: '待确认', category: '熟人商品',
        topic: '熟人商品：与林澄的文字协商', summary: '', initiatedAt: '待正文确认',
        profiles: [{ 昵称: '林澄', 年龄段: '25-29', 性别: '女', 城市: '上海', 简介: '喜欢看展的独立策展人。', 兴趣标签: ['看展', '散步', '咖啡'] }],
        roleUids: ['npc_service_1'],
    };
    const staged = [];
    const archived = [];
    const harness = createHarness({ bridge, orders: [order], activeTab: 'orders' });
    const { ctx, container } = harness;
    ctx.serviceOrderHistoryStore = {
        list: () => [],
        stage: (source, options) => { staged.push([source.id, options.status]); return { localId: 'history_service_1' }; },
        markArchived: (localId) => { archived.push(localId); return true; },
        remove: () => true,
    };
    try {
        // 列表 → 详情：对象公开资料在详情页可见，隐藏资料字段不存在。
        click(container.querySelector('[name="service-order-open-detail"]'));
        assert.ok(container.querySelector('.yl-service-order-detail'));
        assert.ok(container.querySelector('[name="service-order-detail-back"]'));
        const profileCard = container.querySelector('.yl-service-detail-profile');
        assert.ok(profileCard, '详情页展示对象资料卡');
        assert.match(profileCard.textContent, /林澄/u);
        assert.match(profileCard.textContent, /25-29/u);
        assert.match(profileCard.textContent, /喜欢看展的独立策展人/u);
        assert.match(profileCard.textContent, /看展/u);
        assert.ok(container.querySelector('[name="service-order-cancel"]'), '详情页提供取消订单');
        assert.equal(container.querySelector('[name="service-order-start"]'), null, '第 1 步不出现确认成交');

        // 返回列表后再进入详情。
        click(container.querySelector('[name="service-order-detail-back"]'));
        assert.equal(container.querySelector('.yl-service-order-detail'), null, '返回后回到订单列表');
        assert.ok(container.querySelector('[name="service-order-open-detail"]'));
        click(container.querySelector('[name="service-order-open-detail"]'));

        // 取消订单：先本地暂存历史，再取消，最后终态删除并标记归档。
        click(container.querySelector('[name="service-order-cancel"]'));
        await flushUi();
        assert.deepEqual(staged, [['service_1', '已取消']]);
        assert.deepEqual(calls, [['cancel', 'service_1', 'SFW'], ['finalize', 'service_1']]);
        assert.deepEqual(archived, ['history_service_1']);
    } finally {
        harness.destroy();
    }
});

test('自动结单：合法结束条件就绪的进行中订单走完成→归档→终态删除链；未就绪则拒绝', async () => {
    const calls = [];
    const bridge = {
        async runServiceOrderCancel({ orderUid }) { calls.push(['cancel', orderUid]); return { ok: true }; },
        async runServiceOrderComplete({ orderUid, expectedContentMode }) { calls.push(['complete', orderUid, expectedContentMode]); return { ok: true }; },
        async runServiceOrderFinalize({ orderUid }) { calls.push(['finalize', orderUid]); return { ok: true }; },
        appendMeetupDraft() { return { ok: true }; },
    };
    const order = {
        id: 'service_1', mode: 'SFW', status: '进行中', category: '熟人商品',
        topic: '熟人商品：与林澄的文字协商', summary: '', initiatedAt: '待正文确认', startedAt: '玩家已确认接单',
        profiles: [{ 昵称: '林澄' }], roleUids: ['npc_service_1'], completionReady: false,
    };
    const staged = [];
    const archived = [];
    const harness = createHarness({ bridge, orders: [order], activeTab: 'orders' });
    const { ctx, page, feedback } = harness;
    ctx.serviceOrderHistoryStore = {
        list: () => [],
        stage: (source, options) => { staged.push([source.id, options.status]); return { localId: 'history_service_1' }; },
        markArchived: (localId) => { archived.push(localId); return true; },
        remove: () => true,
    };
    try {
        // 正文尚未写入完整结束条件：拒绝完成，不触发任何 MVU 写入。
        await page.archiveAndFinalizeServiceOrder(order, '已完成');
        assert.deepEqual(calls, []);
        assert.deepEqual(staged, []);
        assert.match(feedback.join('\n'), /正文尚未写入完整的结束条件/u);

        // VARIABLE_UPDATE_ENDED 刷新投影后 completionReady=true：自动完成并归档。
        const readyOrder = { ...order, completionReady: true };
        await page.archiveAndFinalizeServiceOrder(readyOrder, '已完成');
        assert.deepEqual(staged, [['service_1', '已完成']]);
        assert.deepEqual(calls, [['complete', 'service_1', 'SFW'], ['finalize', 'service_1']]);
        assert.deepEqual(archived, ['history_service_1']);
    } finally {
        harness.destroy();
    }
});

test('进行中订单详情：重新填入成交提示词不含边界草稿也不暴露 UID，且绝不自动发送', () => {
    const dealDrafts = [];
    const bridge = { appendMeetupDraft(draft) { dealDrafts.push(String(draft ?? '')); return { ok: true }; } };
    const order = {
        id: 'service_1', mode: 'SFW', status: '进行中', category: '熟人商品',
        topic: '熟人商品：与林澄的文字协商', summary: '', initiatedAt: '待正文确认', startedAt: '玩家已确认接单',
        profiles: [{ 昵称: '林澄' }], completionReady: false,
    };
    const harness = createHarness({ bridge, orders: [order], activeTab: 'orders' });
    const { container } = harness;
    try {
        click(container.querySelector('[name="service-order-open-detail"]'));
        const refill = container.querySelector('[name="service-order-refill-draft"]');
        assert.ok(refill, '进行中订单在详情页提供重新填入成交提示词');
        click(refill);
        assert.equal(dealDrafts.length, 1);
        assert.match(dealDrafts[0], /【订单已成交】/u);
        assert.match(dealDrafts[0], /「林澄」/u);
        assert.doesNotMatch(dealDrafts[0], /service_1|npc_service_/u, '成交提示词不得暴露内部 UID');
    } finally {
        harness.destroy();
    }
});

test('记录 tab：ListRow + 状态 chip，动作收进行尾「⋯」菜单', async () => {
    let rebookCalls = 0;
    const bridge = {
        async runServiceOrderRebook({ npcUids, categoryId, expectedContentMode }) {
            rebookCalls += 1;
            assert.deepEqual(npcUids, ['npc_1']);
            assert.equal(categoryId, 'girl_shuren');
            assert.equal(expectedContentMode, 'SFW');
            return { ok: true, orderUid: 'service_9' };
        },
        appendMeetupDraft() { return { ok: true }; },
    };
    const history = [
        { localId: 'h1', orderUid: 'service_1', roleUids: ['npc_1'], status: '已完成', archiveState: 'archived', mode: 'SFW', categoryId: 'girl_shuren', category: '熟人商品', topic: '熟人商品：与林澄的文字协商', endedAt: '昨天 21:00', summary: '双方已确认结束。', profile: { 昵称: '林澄' } },
        { localId: 'h2', orderUid: 'service_2', roleUids: ['npc_2'], status: '已取消', archiveState: 'pending_archive', mode: 'SFW', categoryId: 'girl_luren', category: '路人商品', topic: '路人商品：与顾晴的文字协商', endedAt: '今天 09:00', summary: '已取消。', profile: { 昵称: '顾晴' } },
    ];
    const harness = createHarness({ bridge, history, activeTab: 'records' });
    const { ctx, container } = harness;
    try {
        assert.equal(container.querySelectorAll('.yl-row').length, 2, '历史记录使用 ListRow');
        const chipTexts = container.querySelectorAll('.yl-chip').map((chip) => chip.textContent);
        assert.ok(chipTexts.includes('已完成'));
        assert.ok(chipTexts.includes('已取消'));
        assert.ok(chipTexts.includes('已归档'));
        assert.ok(chipTexts.includes('待归档'));
        assert.equal(container.querySelectorAll('.yl-service-record-menu').every((menu) => menu.hidden), true, '菜单默认收起');
        assert.equal(container.querySelector('[name="service-history-rebook"]').parentNode.hidden, true, '动作不直接平铺在行上');

        click(container.querySelector('[name="service-history-menu-h1"]'));
        const openMenus = () => container.querySelectorAll('.yl-service-record-menu').filter((menu) => !menu.hidden);
        assert.equal(openMenus().length, 1);
        assert.ok(openMenus()[0].querySelector('[name="service-history-rebook"]'));
        assert.ok(openMenus()[0].querySelector('[name="service-history-delete"]'));
        assert.equal(openMenus()[0].querySelector('[name="service-history-finalize"]'), null, '已归档记录无「继续归档」');
        assert.equal(openMenus()[0].querySelector('[name="service-history-rebook"]').disabled, false);

        click(container.querySelector('[name="service-history-menu-h2"]'));
        assert.equal(openMenus().length, 1, '同一时刻只展开一个行尾菜单');
        assert.ok(openMenus()[0].querySelector('[name="service-history-finalize"]'), '待归档记录提供「继续归档」');
        assert.equal(openMenus()[0].querySelector('[name="service-history-rebook"]').disabled, true, '待归档时不可再次下单');

        click(container.querySelector('[name="service-history-menu-h1"]'));
        click(openMenus()[0].querySelector('[name="service-history-rebook"]'));
        await flushUi();
        assert.equal(rebookCalls, 1, '再次下单仍走 runServiceOrderRebook 原调用链');
        assert.equal(ctx.activeServiceHubTab, 'orders', '再次下单后跳到订单 tab');
    } finally {
        harness.destroy();
    }
});

test('精选 tab：发布面板折叠于底部，分类卡横排选择不再自动生成', () => {
    const harness = createHarness();
    const { container } = harness;
    try {
        assert.ok(container.querySelector('.yl-service-category-row'), '三类分类卡横排容器存在');
        const luren = container.querySelector('[name="service-category-girl_luren"]');
        click(luren);
        assert.equal(container.querySelector('[name="service-category-girl_luren"]').getAttribute('aria-pressed'), 'true');
        assert.equal(container.querySelectorAll('.yl-service-slot--empty').length, 3, '切换分类后三席回到空席');

        const toggle = () => container.querySelector('[name="service-publication-toggle"]');
        assert.ok(toggle());
        assert.equal(toggle().getAttribute('aria-expanded'), 'false');
        assert.doesNotMatch(container.textContent, /服务者发布服务/u, '折叠时不渲染发布面板');
        click(toggle());
        assert.equal(toggle().getAttribute('aria-expanded'), 'true');
        assert.match(container.textContent, /服务者发布服务/u);
        assert.ok(container.querySelector('[name="service-published-open-girl_shuren"]'));
        click(toggle());
        assert.equal(toggle().getAttribute('aria-expanded'), 'false');
    } finally {
        harness.destroy();
    }
});

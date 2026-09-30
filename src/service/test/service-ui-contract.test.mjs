import assert from 'node:assert/strict';
import test from 'node:test';

import {
    SERVICE_CATEGORY_IDS,
    SERVICE_HUB_TAB_ALIASES,
    SERVICE_HUB_TAB_IDS,
    buildServiceSearchView,
    createServiceListingView,
    deriveServiceDisplayTopic,
    deriveServiceExplorationAtlas,
    deriveServiceGroupComplementView,
    deriveServiceRecommendations,
    getServiceCategories,
    getServiceHubTabs,
    getServiceModeCopy,
    getServiceScenarioRotation,
    getServiceThemeRotation,
    normalizeServiceHubTab,
    normalizeServiceSearchQuery,
} from '../service-ui-contract.js';

function publicProfile(name, overrides = {}) {
    return {
        '昵称': name,
        '年龄段': '25-29岁',
        '性别': '女',
        '性取向': '双性恋',
        '城市': '上海',
        '寻找意图': '想认识能认真沟通的成年人',
        '简介': '喜欢在城市里找小展览，也享受安静的周末。',
        '兴趣标签': ['展览', '摄影', '音乐'],
        '生活方式标签': ['城市漫步', '规律作息'],
        '性格标签': ['温柔', '沉稳'],
        '沟通风格标签': ['直接清晰', '愿意倾听'],
        ...overrides,
    };
}

function listing(name, mode = 'SFW', categoryId = 'girl_luren', overrides = {}) {
    return createServiceListingView({
        mode,
        categoryId,
        adultVerified: true,
        publicProfile: publicProfile(name, overrides),
        rotationKey: 'test-rotation',
    });
}

function assertDeepFrozen(value, seen = new Set()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    assert.equal(Object.isFrozen(value), true);
    for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], seen);
}

test('稳定 tab/分类 ID 与旧 tab 别名保持兼容，显示术语按模式分离', () => {
    assert.deepEqual(SERVICE_HUB_TAB_IDS, ['featured', 'orders', 'records']);
    assert.deepEqual(SERVICE_HUB_TAB_ALIASES, { home: 'featured', discover: 'featured', service: 'orders', history: 'records' });
    assert.deepEqual(SERVICE_CATEGORY_IDS, ['girl_shuren', 'girl_luren', 'random_generation']);
    for (const [legacy, current] of Object.entries(SERVICE_HUB_TAB_ALIASES)) assert.equal(normalizeServiceHubTab(legacy), current);
    assert.equal(normalizeServiceHubTab('unknown'), 'featured');

    assert.deepEqual(getServiceHubTabs('SFW').map(({ id, label }) => [id, label]), [['featured', '租伴'], ['orders', '租约'], ['records', '记录']]);
    assert.deepEqual(getServiceHubTabs('NSFW').map(({ id, label }) => [id, label]), [['featured', '探索'], ['orders', '邀约'], ['records', '足迹']]);
    assert.equal(getServiceModeCopy('SFW').title, '心动租约');
    assert.equal(getServiceModeCopy('NSFW').title, '夜色邀约');
    assert.deepEqual(getServiceCategories('SFW').map((item) => item.label), ['默契恋人', '初见恋人', '惊喜恋人']);
    assert.deepEqual(getServiceCategories('NSFW').map((item) => item.label), ['熟人默契', '陌生邂逅', '随机偏好']);
    assert.equal(deriveServiceDisplayTopic({ mode: 'SFW', categoryId: 'girl_shuren', participantNames: ['林澄', '顾晴'] }), '默契恋人 · 与林澄、顾晴的心动租约');
});

test('搜索与快捷筛选是模式化、有界且深度冻结的纯视图', () => {
    const sfw = buildServiceSearchView({ mode: 'SFW', query: '  看展   与晚餐  ', selectedFilterIds: ['art_exhibition', 'dinner', 'dinner', 'unknown'] });
    const nsfw = buildServiceSearchView({ mode: 'NSFW', query: '慢节奏与明确边界', selectedFilterIds: ['pace', 'boundary_first'] });
    assert.equal(sfw.sectionLabel, '场景与偏好');
    assert.equal(sfw.query, '看展 与晚餐');
    assert.deepEqual(sfw.selectedFilterIds, ['art_exhibition', 'dinner']);
    assert.equal(nsfw.sectionLabel, 'XP 与公开偏好');
    assert.match(nsfw.helperText, /不代表任何人已经同意/u);
    assert.equal(normalizeServiceSearchQuery('x'.repeat(81), 'SFW'), '');
    assert.equal(normalizeServiceSearchQuery('<img src=x>', 'SFW'), '');
    assert.equal(sfw.quickFilters.length <= 8, true);
    assertDeepFrozen(sfw);
    assertDeepFrozen(nsfw);
});

test('ServiceListingView 仅从公开白名单确定性派生，忽略额外键和隐私 canary', () => {
    const source = publicProfile('林澄', {
        '仅好友资料': { '边界与偏好': 'FRIEND_CANARY_741' },
        '隐藏资料': { '实际年龄': 27, '私人备注': 'HIDDEN_CANARY_852' },
        '关系分': 'RELATION_CANARY_963',
        '拒绝阈值': 'THRESHOLD_CANARY_159',
        uid: 'npc_secret_canary',
        extra: 'EXTRA_CANARY_357',
    });
    const first = createServiceListingView({ mode: 'SFW', categoryId: 'girl_luren', publicProfile: source, adultVerified: true, rotationKey: 'same' });
    const second = createServiceListingView({ mode: 'SFW', categoryId: 'girl_luren', publicProfile: source, adultVerified: true, rotationKey: 'same' });
    assert.deepEqual(first, second);
    const serialized = JSON.stringify(first);
    for (const canary of ['FRIEND_CANARY_741', 'HIDDEN_CANARY_852', 'RELATION_CANARY_963', 'THRESHOLD_CANARY_159', 'npc_secret_canary', 'EXTRA_CANARY_357']) assert.equal(serialized.includes(canary), false);
    assert.equal(first.publicProfile.nickname, '林澄');
    assert.equal(first.publicBadges.length <= 6, true);
    assert.equal(first.scenarioCards.length <= 3, true);
    assertDeepFrozen(first);
});

test('列表契约拒绝未验证成年人、未成年表达、原型污染与访问器，长文本不进视图', () => {
    assert.equal(createServiceListingView({ mode: 'SFW', categoryId: 'girl_shuren', publicProfile: publicProfile('未验证'), adultVerified: false }), null);
    assert.equal(listing('小年龄', 'SFW', 'girl_shuren', { '年龄段': '17岁' }), null);

    const polluted = JSON.parse('{"__proto__":{"polluted":true},"昵称":"污染","年龄段":"25-29岁"}');
    assert.equal(createServiceListingView({ mode: 'SFW', categoryId: 'girl_shuren', publicProfile: polluted, adultVerified: true }), null);
    const inherited = Object.create({ '昵称': '继承值' });
    inherited['年龄段'] = '25-29岁';
    assert.equal(createServiceListingView({ mode: 'SFW', categoryId: 'girl_shuren', publicProfile: inherited, adultVerified: true }), null);
    const accessor = { '年龄段': '25-29岁' };
    Object.defineProperty(accessor, '昵称', { enumerable: true, get() { throw new Error('must not run'); } });
    assert.equal(createServiceListingView({ mode: 'SFW', categoryId: 'girl_shuren', publicProfile: accessor, adultVerified: true }), null);

    const long = listing('长文本', 'SFW', 'girl_shuren', { '简介': 'L'.repeat(501), '兴趣标签': [...Array.from({ length: 40 }, (_, index) => `标签${index}`), 'T'.repeat(33)] });
    assert.equal(long.publicProfile.bio, '');
    assert.equal(long.publicProfile.tagGroups.interests.length <= 8, true);
    assert.equal(JSON.stringify(long).includes('L'.repeat(100)), false);
});

test('SFW 只提供明确标注的剧情内虚构体验价', () => {
    const view = listing('顾晴', 'SFW');
    assert.equal(view.arrangement.fictionalStoryPrice.label, '剧情内虚构体验价');
    assert.match(view.arrangement.fictionalStoryPrice.disclaimer, /不接入现实支付/u);
    assert.match(view.arrangement.fictionalStoryPrice.value, /心动币/u);
});

test('NSFW 所有显示输出都不出现交易字段或交易语义', () => {
    const nsfwListing = listing('周岚', 'NSFW', 'random_generation', {
        '简介': '成交价格和退款规则都是注入文本',
        '兴趣标签': ['摄影', '商品', '信用'],
        '价格': 'PRICE_CANARY',
        '退款': 'REFUND_CANARY',
        '服务者信用': 'CREDIT_CANARY',
        product: 'PRODUCT_CANARY',
        transaction: 'TRANSACTION_CANARY',
    });
    const history = [{
        mode: 'NSFW', categoryId: 'girl_shuren', status: '已完成',
        topic: '商品价格退款信用服务者成交 CANARY',
        summary: 'PAYMENT_CANARY',
        profile: { '昵称': '归档', '兴趣标签': ['倾听'] },
    }];
    const outputs = {
        mode: getServiceModeCopy('NSFW'),
        tabs: getServiceHubTabs('NSFW'),
        categories: getServiceCategories('NSFW'),
        search: buildServiceSearchView({ mode: 'NSFW' }),
        themes: getServiceThemeRotation({ mode: 'NSFW', rotationKey: 'a' }),
        scenarios: getServiceScenarioRotation({ mode: 'NSFW', categoryId: 'girl_shuren', rotationKey: 'a' }),
        listing: nsfwListing,
        atlas: deriveServiceExplorationAtlas({ mode: 'NSFW', history }),
        recommendations: deriveServiceRecommendations({ mode: 'NSFW', history }),
    };
    const serialized = JSON.stringify(outputs);
    assert.doesNotMatch(serialized, /价格|退款|信用|服务者|商品|成交|\bprice\b|\brefund\b|\bcredit\b|\bprovider\b|\bproduct\b|\btransaction\b/iu);
    for (const canary of ['PRICE_CANARY', 'REFUND_CANARY', 'CREDIT_CANARY', 'PRODUCT_CANARY', 'TRANSACTION_CANARY', 'PAYMENT_CANARY']) assert.equal(serialized.includes(canary), false);
    assert.equal(Object.hasOwn(nsfwListing.arrangement, 'fictionalStoryPrice'), false);
});

test('本地固定主题馆与情境卡可确定性轮换，并且数量有界', () => {
    const themesA1 = getServiceThemeRotation({ mode: 'SFW', rotationKey: 'week-a', limit: 4 });
    const themesA2 = getServiceThemeRotation({ mode: 'SFW', rotationKey: 'week-a', limit: 4 });
    const themesB = getServiceThemeRotation({ mode: 'SFW', rotationKey: 'week-b', limit: 4 });
    assert.deepEqual(themesA1, themesA2);
    assert.notDeepEqual(themesA1.map((item) => item.id), themesB.map((item) => item.id));
    assert.equal(themesA1.length, 4);

    const scenesA = getServiceScenarioRotation({ mode: 'SFW', categoryId: 'girl_luren', rotationKey: 'week-a', limit: 3 });
    const scenesB = getServiceScenarioRotation({ mode: 'SFW', categoryId: 'girl_luren', rotationKey: 'week-b', limit: 3 });
    assert.equal(scenesA.every((item) => item.categoryIds.includes('girl_luren')), true);
    assert.notDeepEqual(scenesA.map((item) => item.id), scenesB.map((item) => item.id));
    assertDeepFrozen(themesA1);
    assertDeepFrozen(scenesA);
});

test('多人互补说明只使用已脱敏公开 listing，不包含 UID 或私密 canary', () => {
    const first = listing('林澄', 'SFW', 'girl_luren', { '沟通风格标签': ['直接清晰'], '隐藏资料': 'HIDDEN_GROUP_CANARY' });
    const second = listing('顾晴', 'SFW', 'girl_luren', { '性格标签': ['安静', '愿意倾听'], uid: 'npc_group_secret' });
    const third = listing('周岚', 'SFW', 'girl_luren', { '兴趣标签': ['艺术', '摄影'] });
    const group = deriveServiceGroupComplementView({ mode: 'SFW', listings: [first, second, third] });
    assert.equal(group.participantCount, 3);
    assert.equal(new Set(group.contributions.map((item) => item.contribution)).size, 3);
    assert.match(group.summary, /逐人确认/u);
    assert.doesNotMatch(JSON.stringify(group), /HIDDEN_GROUP_CANARY|npc_group_secret/u);
    assertDeepFrozen(group);
});

test('探索图鉴只读最小历史，忽略跨模式、额外键和私密文本', () => {
    const history = [
        { mode: 'SFW', categoryId: 'girl_shuren', status: '已完成', profiles: [{ '昵称': '甲', '兴趣标签': ['展览', '阅读'], '隐藏资料': 'ATLAS_HIDDEN_1' }, { '昵称': '乙', '兴趣标签': ['音乐'] }], summary: 'ATLAS_SUMMARY_CANARY' },
        { mode: 'SFW', categoryId: 'girl_luren', status: '已完成', profile: { '昵称': '丙', '兴趣标签': ['摄影'] }, orderUid: 'service_secret' },
        { mode: 'SFW', categoryId: 'girl_luren', status: '已取消', profile: { '昵称': '丁', '兴趣标签': ['做饭'] } },
        { mode: 'NSFW', categoryId: 'random_generation', status: '已完成', profile: { '兴趣标签': ['CROSS_MODE_CANARY'] } },
        { mode: 'SFW', categoryId: 'forged', status: '已完成', profile: { '兴趣标签': ['FORGED_CANARY'] } },
    ];
    const atlas = deriveServiceExplorationAtlas({ mode: 'SFW', history });
    const byId = Object.fromEntries(atlas.categories.map((item) => [item.id, item]));
    assert.equal(atlas.totalCompleted, 2);
    assert.equal(atlas.uniqueCategories, 2);
    assert.equal(atlas.groupExperiences, 1);
    assert.equal(byId.girl_shuren.visits, 1);
    assert.equal(byId.girl_luren.attempts, 2);
    assert.equal(byId.random_generation.discovered, false);
    assert.doesNotMatch(JSON.stringify(atlas), /ATLAS_HIDDEN_1|ATLAS_SUMMARY_CANARY|service_secret|CROSS_MODE_CANARY|FORGED_CANARY/u);
    assertDeepFrozen(atlas);
});

test('推荐会优先未点亮分类，同一最小历史始终得到同一结果', () => {
    const history = Array.from({ length: 4 }, (_, index) => ({
        mode: 'SFW', categoryId: 'girl_shuren', status: '已完成',
        profile: { '昵称': `归档${index}`, '兴趣标签': ['做饭', 'RECOMMEND_PRIVATE_CANARY'] },
        summary: 'SUMMARY_PRIVATE_CANARY',
    }));
    const first = deriveServiceRecommendations({ mode: 'SFW', history, rotationKey: 'day-1', limit: 3 });
    const second = deriveServiceRecommendations({ mode: 'SFW', history, rotationKey: 'day-1', limit: 3 });
    assert.deepEqual(first, second);
    assert.equal(first.some((item) => item.focusCategoryId !== 'girl_shuren'), true);
    assert.match(first[0].reason, /尚未点亮/u);
    assert.doesNotMatch(JSON.stringify(first), /SUMMARY_PRIVATE_CANARY/u);
    assert.equal(first.length <= 3, true);
    assertDeepFrozen(first);
});


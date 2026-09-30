/**
 * Pure display contract for the hidden service hub.
 *
 * This module deliberately owns no browser state, performs no I/O and never
 * receives MVU paths or role UIDs. Every visible view is rebuilt from a small
 * public-profile whitelist plus fixed local dictionaries.
 */

export const SERVICE_UI_CONTRACT_VERSION = 1;

const MODES = new Set(['SFW', 'NSFW']);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CONTROL_OR_MARKUP_PATTERN = /[\u0000-\u001F\u007F<>]/u;
const PRIVATE_SHAPE_PATTERN = /(?:api[ _-]?key|bearer\s+[a-z0-9._~-]+|(?:https?:\/\/|www\.)\S+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\+?86[-\s]?)?1[3-9]\d{9}|(?:微信|wechat|qq|telegram|discord|line)(?:号|號|账号|帳號)?|(?:精确|精準|详细|詳細|具体)(?:地址|住址|定位)|(?:门牌|門牌|楼栋|樓棟|单元|單元|房间号|房間號|经纬度|經緯度))/iu;
const UNDERAGE_PATTERN = /(?:未成年|未满\s*18|未滿\s*18|儿童|兒童|小学生|小學生|初中生|高中生|少年|少女|(?:^|\D)(?:[0-9]|1[0-7])\s*岁)/u;
const NSFW_COMMERCE_PATTERN = /(?:价格|退款|信用|服务者|商品|成交|下单|支付|付费|收费|\b(?:price|refund|credit|provider|product|transaction|checkout|payment)\b)/iu;

function deepFreeze(value, seen = new Set()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
}

function isPlainDataRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length) return false;
    return !Object.getOwnPropertyNames(value).some((key) => DANGEROUS_KEYS.has(key));
}

/** Read an own enumerable data property without invoking accessors. */
function ownData(record, key) {
    if (!isPlainDataRecord(record)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function boundedText(value, maxLength, { mode = 'SFW', required = false } = {}) {
    if (typeof value !== 'string') return required ? null : '';
    const text = value.trim().replace(/\s+/gu, ' ');
    if ((!text && required) || text.length > maxLength || CONTROL_OR_MARKUP_PATTERN.test(text) || PRIVATE_SHAPE_PATTERN.test(text)) return required ? null : '';
    if (mode === 'NSFW' && NSFW_COMMERCE_PATTERN.test(text)) return required ? null : '';
    return text;
}

function boundedStringArray(value, { mode = 'SFW', limit = 8, itemLength = 32 } = {}) {
    if (!Array.isArray(value)) return deepFreeze([]);
    const result = [];
    for (const raw of value) {
        const item = boundedText(raw, itemLength, { mode });
        if (item && !result.includes(item)) result.push(item);
        if (result.length >= limit) break;
    }
    return deepFreeze(result);
}

function clampLimit(value, fallback, maximum) {
    return Number.isInteger(value) ? Math.min(maximum, Math.max(1, value)) : fallback;
}

function stableHash(value) {
    const text = String(value ?? '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function rotateFixed(source, seed, limit) {
    if (!source.length) return deepFreeze([]);
    const start = stableHash(seed) % source.length;
    const rotated = [...source.slice(start), ...source.slice(0, start)].slice(0, limit);
    return deepFreeze(rotated);
}

function validMode(mode) { return MODES.has(mode); }
function validCategory(categoryId) { return SERVICE_CATEGORY_IDS.includes(categoryId); }

export const SERVICE_HUB_TAB_IDS = deepFreeze(['featured', 'orders', 'records']);

export const SERVICE_HUB_TAB_ALIASES = deepFreeze({
    home: 'featured',
    discover: 'featured',
    service: 'orders',
    history: 'records',
});

export const SERVICE_CATEGORY_IDS = deepFreeze(['girl_shuren', 'girl_luren', 'random_generation']);

export const SERVICE_MODE_COPY = deepFreeze({
    SFW: {
        modeBadge: 'SFW · 租借恋人',
        title: '心动租约',
        subtitle: '为一段虚构都市相处时光，挑选明确成年的恋人候选。',
        featuredLabel: '租伴',
        ordersLabel: '租约',
        recordsLabel: '记录',
        candidateLabel: '租借恋人',
        createAction: '发起租约',
        pendingStatus: '待签约',
        startAction: '双方确认，开始约会',
        activeStatus: '约会进行中',
        finishAction: '完成租约',
        repeatAction: '再约一次',
        selectAction: '选入租约',
        trustLine: '全部角色明确成年 · 本轮逐人确认 · 可撤回 · 不自动发送',
        safetyNote: '公开偏好不代表当次身体接触的同意，仍需具体确认。',
    },
    NSFW: {
        modeBadge: 'NSFW · 成年约炮',
        title: '夜色邀约',
        subtitle: '探索虚构成年对象与当次意向，每一位参与者都需单独建立共识。',
        featuredLabel: '探索',
        ordersLabel: '邀约',
        recordsLabel: '足迹',
        candidateLabel: '邂逅对象',
        createAction: '发起邀约',
        pendingStatus: '待共识',
        startAction: '逐人确认，开始邀约',
        activeStatus: '邀约进行中',
        finishAction: '完成本次邂逅',
        repeatAction: '再次邀约',
        selectAction: '选入邀约',
        trustLine: '全部角色明确成年 · 本轮逐人确认 · 可撤回 · 不自动发送',
        safetyNote: '公开意向不是本次同意；具体范围、节奏与事后相处必须逐人确认。',
    },
});

export const SERVICE_CATEGORY_DISPLAY_COPY = deepFreeze({
    SFW: {
        girl_shuren: { label: '默契恋人', definition: '虚构成年的熟悉感相处，不映射现实亲友、伴侣或具体个人。' },
        girl_luren: { label: '初见恋人', definition: '与虚构成年陌生人的第一次恋人体验。' },
        random_generation: { label: '惊喜恋人', definition: '按公开偏好随机组合的成年恋人候选。' },
    },
    NSFW: {
        girl_shuren: { label: '熟人默契', definition: '虚构成年熟人设定；旧关系与既往同意不替代本次共识。' },
        girl_luren: { label: '陌生邂逅', definition: '与虚构、不可识别的成年人协商当次约炮。' },
        random_generation: { label: '随机偏好', definition: '随机组合公开人设与偏好，不随机同意、禁区或现实身份。' },
    },
});

export const SERVICE_SEARCH_COPY = deepFreeze({
    SFW: {
        sectionLabel: '场景与偏好',
        placeholder: '想要怎样的一日恋人或约会场景？',
        helperText: '只影响本轮租伴候选，不保存。',
        quickFilters: [
            { id: 'art_exhibition', label: '看展', queryToken: '艺文展览' },
            { id: 'dinner', label: '晚餐', queryToken: '晚餐与夜景' },
            { id: 'live_show', label: '演出', queryToken: '现场演出' },
            { id: 'study_company', label: '学习陪伴', queryToken: '安静学习' },
            { id: 'city_walk', label: '城市漫步', queryToken: '城市漫步' },
            { id: 'formal_occasion', label: '正式场合', queryToken: '正式场合' },
            { id: 'interaction_style', label: '相处风格', queryToken: '相处风格' },
        ],
    },
    NSFW: {
        sectionLabel: 'XP 与公开偏好',
        placeholder: '想探索怎样的对象、节奏或偏好？',
        helperText: '只影响本轮候选，不代表任何人已经同意。',
        quickFilters: [
            { id: 'familiarity', label: '熟悉氛围', queryToken: '熟悉感' },
            { id: 'first_meeting', label: '初见感', queryToken: '陌生邂逅' },
            { id: 'interaction_style', label: '互动风格', queryToken: '互动风格' },
            { id: 'pace', label: '节奏', queryToken: '节奏与强度' },
            { id: 'scene', label: '场景类型', queryToken: '场景类型' },
            { id: 'aftercare', label: '事后相处', queryToken: '事后相处' },
            { id: 'boundary_first', label: '边界优先', queryToken: '边界清晰' },
        ],
    },
});

const THEME_CATALOG = deepFreeze({
    SFW: [
        { id: 'tacit_everyday', title: '默契日常馆', subtitle: '从一顿饭、一条熟路开始，慢慢找回熟悉的节奏。', categoryIds: ['girl_shuren'], signalTags: ['做饭', '日常', '温柔', '倾听'] },
        { id: 'first_city', title: '城市初见馆', subtitle: '把第一次见面拆成好走、好聊、随时可返回的小行程。', categoryIds: ['girl_luren'], signalTags: ['漫步', '咖啡', '城市', '慢热'] },
        { id: 'surprise_hobby', title: '兴趣盲盒馆', subtitle: '用两种公开兴趣拼成一次未知但可控的约会。', categoryIds: ['random_generation'], signalTags: ['兴趣', '体验', '创作', '新鲜感'] },
        { id: 'arts_together', title: '艺文共游馆', subtitle: '展览、电影与演出之后，留一段只聊彼此感受的时间。', categoryIds: ['girl_luren', 'random_generation'], signalTags: ['展览', '电影', '音乐', '摄影'] },
        { id: 'formal_partner', title: '正式场合馆', subtitle: '为宴会、典礼或工作社交准备可预演的同行节奏。', categoryIds: ['girl_shuren', 'random_generation'], signalTags: ['礼仪', '稳重', '可靠', '沟通'] },
        { id: 'quiet_parallel', title: '静静同频馆', subtitle: '不必一直聊天，阅读、学习或工作时也有人在旁边。', categoryIds: ['girl_shuren', 'girl_luren', 'random_generation'], signalTags: ['安静', '阅读', '学习', '陪伴'] },
        { id: 'weekend_microtrip', title: '周末微旅行馆', subtitle: '用半日到一日，去城市边缘换一个呼吸方式。', categoryIds: ['girl_luren', 'random_generation'], signalTags: ['旅行', '户外', '探店', '摄影'] },
    ],
    NSFW: [
        { id: 'familiar_reconnect', title: '熟悉感重逢馆', subtitle: '保留熟悉的互动感，但把本次范围从头说清。', categoryIds: ['girl_shuren'], signalTags: ['熟悉感', '直接', '沟通', '默契'] },
        { id: 'first_encounter', title: '初见邂逅馆', subtitle: '从公开意向、可接受节奏与明确禁区开始相互了解。', categoryIds: ['girl_luren'], signalTags: ['初见', '坦率', '边界', '清晰'] },
        { id: 'preference_lottery', title: '偏好组合馆', subtitle: '随机的是公开风格组合，不随机任何人的决定。', categoryIds: ['random_generation'], signalTags: ['新鲜感', '创意', '偏好', '表达'] },
        { id: 'slow_pace', title: '慢节奏探索馆', subtitle: '用更多检查点和更少预设，给每个人留出改变想法的空间。', categoryIds: ['girl_luren', 'random_generation'], signalTags: ['慢热', '温和', '倾听', '可撤回'] },
        { id: 'clear_dialogue', title: '直白沟通馆', subtitle: '先对齐语言、节奏与停止信号，再决定是否继续。', categoryIds: ['girl_shuren', 'girl_luren', 'random_generation'], signalTags: ['直接', '清晰', '表达', '尊重'] },
        { id: 'aftercare_connection', title: '事后相处馆', subtitle: '把离开方式、后续联系意愿与情绪照顾也放进本次商量。', categoryIds: ['girl_shuren', 'girl_luren'], signalTags: ['照顾', '关怀', '倾听', '事后相处'] },
        { id: 'ensemble_consensus', title: '多人默契馆', subtitle: '用逐人复述与独立确认，看见每个人不同的节奏。', categoryIds: ['random_generation', 'girl_shuren'], signalTags: ['多人', '复述', '节奏', '独立确认'] },
    ],
});

const SCENARIO_CATALOG = deepFreeze({
    SFW: [
        { id: 'gallery_then_tea', title: '看展后的热茶', summary: '先各自看展，再交换三个最想留住的瞬间。', categoryIds: ['girl_luren', 'random_generation'] },
        { id: 'sunset_walk', title: '日落城市漫步', summary: '有固定返程点的慢行路线，给聊天也给沉默留空间。', categoryIds: ['girl_shuren', 'girl_luren'] },
        { id: 'parallel_focus', title: '并排专注两小时', summary: '各做各的事，在中途休息时交换今日进度。', categoryIds: ['girl_shuren', 'random_generation'] },
        { id: 'night_market', title: '夜市食物盲选', summary: '每人挑一样想分享的味道，路线与结束时间先说好。', categoryIds: ['girl_luren', 'random_generation'] },
        { id: 'formal_rehearsal', title: '正式场合预演', summary: '提前对齐称呼、礼仪与离场节点，让同行更从容。', categoryIds: ['girl_shuren', 'random_generation'] },
        { id: 'rainy_kitchen', title: '雨天厨房小计划', summary: '用有限食材合作完成一餐，动线与身体接触分开确认。', categoryIds: ['girl_shuren'] },
        { id: 'weekend_train', title: '周末短途列车', summary: '一站距离的微旅行，保留取消、改线与提前返回的选项。', categoryIds: ['girl_luren', 'random_generation'] },
        { id: 'music_exchange', title: '一人三首歌', summary: '轮流分享歌曲和当下心情，不追问不想解释的故事。', categoryIds: ['girl_shuren', 'girl_luren', 'random_generation'] },
    ],
    NSFW: [
        { id: 'clear_first_talk', title: '先把话说清', summary: '用可以、不可以、需要停下确认三类句子对齐当次范围。', categoryIds: ['girl_shuren', 'girl_luren', 'random_generation'] },
        { id: 'slow_checkpoints', title: '慢节奏检查点', summary: '把节奏拆成多个可停段落，每段开始前重新确认。', categoryIds: ['girl_luren', 'random_generation'] },
        { id: 'familiar_new_boundary', title: '熟悉感与新边界', summary: '保留人设上的熟悉感，本次边界仍然从空白开始。', categoryIds: ['girl_shuren'] },
        { id: 'first_meeting_exit', title: '初见与离开方案', summary: '在开始前确认独立离开、中途结束和事后回应方式。', categoryIds: ['girl_luren'] },
        { id: 'preference_cards', title: '公开偏好卡', summary: '每人各选一张想了解和一张明确跳过，选择只作聊天起点。', categoryIds: ['random_generation'] },
        { id: 'signal_rehearsal', title: '停止信号预演', summary: '用普通语句预演暂停、改变和结束，确认每人都能自由表达。', categoryIds: ['girl_shuren', 'girl_luren', 'random_generation'] },
        { id: 'ensemble_round', title: '多人逐一复述', summary: '一次只确认一位参与者，不以沉默、多数或他人表态代替回答。', categoryIds: ['random_generation', 'girl_shuren'] },
        { id: 'aftercare_plan', title: '事后相处预案', summary: '在情绪平稳时先商量结束后的空间、照顾与后续联系意愿。', categoryIds: ['girl_shuren', 'girl_luren', 'random_generation'] },
    ],
});

function publicTheme(theme) {
    return deepFreeze({ id: theme.id, title: theme.title, subtitle: theme.subtitle, categoryIds: [...theme.categoryIds] });
}

function publicScenario(scenario) {
    return deepFreeze({ id: scenario.id, title: scenario.title, summary: scenario.summary, categoryIds: [...scenario.categoryIds] });
}

export function normalizeServiceHubTab(value) {
    const raw = typeof value === 'string' ? value : '';
    if (SERVICE_HUB_TAB_IDS.includes(raw)) return raw;
    return SERVICE_HUB_TAB_ALIASES[raw] ?? 'featured';
}

export function getServiceModeCopy(mode = 'SFW') {
    return SERVICE_MODE_COPY[validMode(mode) ? mode : 'SFW'];
}

export function getServiceHubTabs(mode = 'SFW') {
    const copy = getServiceModeCopy(mode);
    return deepFreeze([
        { id: 'featured', label: copy.featuredLabel },
        { id: 'orders', label: copy.ordersLabel },
        { id: 'records', label: copy.recordsLabel },
    ]);
}

export function getServiceCategories(mode = 'SFW') {
    const selectedMode = validMode(mode) ? mode : 'SFW';
    return deepFreeze(SERVICE_CATEGORY_IDS.map((id) => ({ id, ...SERVICE_CATEGORY_DISPLAY_COPY[selectedMode][id] })));
}

export function getServiceDisplayCategory(mode, categoryId) {
    return validMode(mode) && validCategory(categoryId) ? SERVICE_CATEGORY_DISPLAY_COPY[mode][categoryId] : null;
}

export function deriveServiceDisplayTopic({ mode, categoryId, participantNames = [] } = {}) {
    const category = getServiceDisplayCategory(mode, categoryId);
    if (!category) return '';
    const names = boundedStringArray(participantNames, { mode, limit: 3, itemLength: 40 });
    if (!names.length) return `${category.label} · ${mode === 'SFW' ? '本轮心动租约' : '本轮夜色邀约'}`;
    return `${category.label} · 与${names.join('、')}的${mode === 'SFW' ? '心动租约' : '夜色邀约'}`.slice(0, 180);
}

export function normalizeServiceSearchQuery(value, mode = 'SFW') {
    if (!validMode(mode)) return '';
    return boundedText(value, 80, { mode });
}

export function buildServiceSearchView({ mode = 'SFW', query = '', selectedFilterIds = [] } = {}) {
    const selectedMode = validMode(mode) ? mode : 'SFW';
    const copy = SERVICE_SEARCH_COPY[selectedMode];
    const allowed = new Map(copy.quickFilters.map((item) => [item.id, item]));
    const selected = [];
    if (Array.isArray(selectedFilterIds)) {
        for (const id of selectedFilterIds) {
            if (typeof id === 'string' && allowed.has(id) && !selected.includes(id)) selected.push(id);
            if (selected.length >= 4) break;
        }
    }
    return deepFreeze({
        mode: selectedMode,
        sectionLabel: copy.sectionLabel,
        placeholder: copy.placeholder,
        helperText: copy.helperText,
        query: normalizeServiceSearchQuery(query, selectedMode),
        quickFilters: copy.quickFilters,
        selectedFilterIds: selected,
        appliedTokens: selected.map((id) => allowed.get(id).queryToken),
    });
}

function projectStrictPublicProfile(publicProfile, mode) {
    if (!isPlainDataRecord(publicProfile)) return null;
    const nickname = boundedText(ownData(publicProfile, '昵称'), 80, { mode, required: true });
    if (!nickname) return null;
    const rawAgeRange = boundedText(ownData(publicProfile, '年龄段'), 32, { mode });
    if (rawAgeRange && UNDERAGE_PATTERN.test(rawAgeRange)) return null;
    const fields = {
        nickname,
        ageRange: rawAgeRange || '明确成年人',
        gender: boundedText(ownData(publicProfile, '性别'), 48, { mode }),
        orientation: boundedText(ownData(publicProfile, '性取向'), 80, { mode }),
        city: boundedText(ownData(publicProfile, '城市'), 48, { mode }),
        intent: boundedText(ownData(publicProfile, '寻找意图'), 120, { mode }),
        bio: boundedText(ownData(publicProfile, '简介'), 500, { mode }),
        tagGroups: {
            interests: boundedStringArray(ownData(publicProfile, '兴趣标签'), { mode, limit: 8 }),
            lifestyle: boundedStringArray(ownData(publicProfile, '生活方式标签'), { mode, limit: 8 }),
            personality: boundedStringArray(ownData(publicProfile, '性格标签'), { mode, limit: 8 }),
            communication: boundedStringArray(ownData(publicProfile, '沟通风格标签'), { mode, limit: 8 }),
        },
    };
    return deepFreeze(fields);
}

function flattenedPublicTags(profile, limit = 8) {
    const result = [];
    for (const values of Object.values(profile.tagGroups)) {
        for (const value of values) {
            if (!result.includes(value)) result.push(value);
            if (result.length >= limit) return deepFreeze(result);
        }
    }
    return deepFreeze(result);
}

function listingSeed(mode, categoryId, profile, rotationKey) {
    return [mode, categoryId, profile.nickname, profile.ageRange, profile.city, profile.intent, ...flattenedPublicTags(profile, 12), boundedText(rotationKey, 64, { mode })].join('|');
}

export function getServiceThemeRotation({ mode = 'SFW', rotationKey = '', history = [], limit = 4 } = {}) {
    const selectedMode = validMode(mode) ? mode : 'SFW';
    const records = normalizeMinimalHistory(history, selectedMode);
    const seed = `${selectedMode}|${boundedText(rotationKey, 64, { mode: selectedMode })}|${historyFingerprint(records)}`;
    return deepFreeze(rotateFixed(THEME_CATALOG[selectedMode], seed, clampLimit(limit, 4, 6)).map(publicTheme));
}

export function getServiceScenarioRotation({ mode = 'SFW', categoryId = '', rotationKey = '', history = [], limit = 3 } = {}) {
    const selectedMode = validMode(mode) ? mode : 'SFW';
    const selectedCategory = validCategory(categoryId) ? categoryId : '';
    const source = selectedCategory
        ? SCENARIO_CATALOG[selectedMode].filter((item) => item.categoryIds.includes(selectedCategory))
        : SCENARIO_CATALOG[selectedMode];
    const records = normalizeMinimalHistory(history, selectedMode);
    const seed = `${selectedMode}|${selectedCategory}|${boundedText(rotationKey, 64, { mode: selectedMode })}|${historyFingerprint(records)}`;
    return deepFreeze(rotateFixed(source, seed, clampLimit(limit, 3, 6)).map(publicScenario));
}

/**
 * Deterministically builds a strict, UI-only listing from public data.
 * `adultVerified` must come from the existing candidate validation result.
 */
export function createServiceListingView({ mode, categoryId, publicProfile, adultVerified = false, rotationKey = '' } = {}) {
    if (!validMode(mode) || !validCategory(categoryId) || adultVerified !== true) return null;
    const profile = projectStrictPublicProfile(publicProfile, mode);
    if (!profile) return null;
    const category = SERVICE_CATEGORY_DISPLAY_COPY[mode][categoryId];
    const seed = listingSeed(mode, categoryId, profile, rotationKey);
    const scenarios = getServiceScenarioRotation({ mode, categoryId, rotationKey: seed, limit: 3 });
    const tags = flattenedPublicTags(profile, 6);
    const sellingPoints = mode === 'SFW'
        ? ['把普通日常过出约会感', '擅长在热闹与安静之间找节奏', '用清晰沟通让相处更松弛']
        : ['愿意先说清当次范围', '重视节奏变化与随时停止', '把事后相处也纳入商量'];
    const point = sellingPoints[stableHash(seed) % sellingPoints.length];
    const publicSummary = profile.bio || profile.intent || `${profile.nickname}的公开简介暂未补充。`;
    const durationOptions = mode === 'SFW' ? ['2 小时', '半日', '一日'] : ['短时段', '一个晚间', '由参与者当次商量'];
    const windowOptions = mode === 'SFW' ? ['工作日晚间', '周末午后', '双方另行确认的时段'] : ['双方均清醒的时段', '可以从容沟通的晚间', '逐人另行确认的时间窗'];
    const arrangement = mode === 'SFW'
        ? {
            duration: durationOptions[stableHash(`${seed}|duration`) % durationOptions.length],
            scheduleWindow: windowOptions[stableHash(`${seed}|window`) % windowOptions.length],
            routeDirection: scenarios[0]?.title ?? '行程待双方确认',
            fictionalStoryPrice: {
                label: '剧情内虚构体验价',
                value: `${[188, 268, 368, 520][stableHash(`${seed}|story-price`) % 4]} 心动币`,
                disclaimer: '仅作虚构剧情条款，不接入现实支付。',
            },
        }
        : {
            estimatedDuration: durationOptions[stableHash(`${seed}|duration`) % durationOptions.length],
            timeWindow: windowOptions[stableHash(`${seed}|window`) % windowOptions.length],
            sceneDirection: scenarios[0]?.title ?? '场景待逐人商量',
            aftercare: '事后相处与后续联系意愿待逐人确认。',
        };
    return deepFreeze({
        kind: 'ServiceListingView',
        version: SERVICE_UI_CONTRACT_VERSION,
        mode,
        categoryId,
        displayCategory: category.label,
        headline: `${profile.nickname} · ${point}`.slice(0, 140),
        publicSummary,
        adultVerified: true,
        adultBadge: '成年人已验证',
        publicProfile: profile,
        publicBadges: tags,
        scenarioCards: scenarios,
        arrangement,
        safetyNote: SERVICE_MODE_COPY[mode].safetyNote,
        selectAction: SERVICE_MODE_COPY[mode].selectAction,
    });
}

function contributionForListing(listing, used, index) {
    const tags = flattenedPublicTags(listing.publicProfile, 12).join(' ');
    const candidates = [];
    if (/(?:直接|清晰|沟通|表达|坦率)/u.test(tags)) candidates.push('边界沟通');
    if (/(?:外向|热闹|主动|活力|运动)/u.test(tags)) candidates.push('破冰带动');
    if (/(?:安静|慢热|沉稳|温柔|倾听)/u.test(tags)) candidates.push('节奏照看');
    if (/(?:计划|细致|理性|可靠|守时)/u.test(tags)) candidates.push('安排统筹');
    if (/(?:艺术|展览|音乐|摄影|电影|阅读|创作)/u.test(tags)) candidates.push('情境灵感');
    const fallbacks = listing.mode === 'SFW'
        ? ['话题连接', '行程灵感', '节奏照看']
        : ['边界复述', '节奏照看', '事后沟通'];
    for (const candidate of [...candidates, ...rotateFixed(fallbacks, `${listing.publicProfile.nickname}|${index}`, fallbacks.length)]) {
        if (!used.has(candidate)) return candidate;
    }
    return `${fallbacks[index % fallbacks.length]} ${index + 1}`;
}

/** Builds a 2–3 person complement note from already-sanitized listing views. */
export function deriveServiceGroupComplementView({ mode, listings = [] } = {}) {
    if (!validMode(mode) || !Array.isArray(listings) || listings.length < 2 || listings.length > 3) return null;
    const safeListings = [];
    for (const listing of listings) {
        if (!isPlainDataRecord(listing) || ownData(listing, 'kind') !== 'ServiceListingView' || ownData(listing, 'mode') !== mode || ownData(listing, 'adultVerified') !== true) return null;
        const profile = ownData(listing, 'publicProfile');
        if (!isPlainDataRecord(profile)) return null;
        const projected = projectStrictPublicProfile({
            '昵称': ownData(profile, 'nickname'),
            '年龄段': ownData(profile, 'ageRange'),
            '性别': ownData(profile, 'gender'),
            '性取向': ownData(profile, 'orientation'),
            '城市': ownData(profile, 'city'),
            '寻找意图': ownData(profile, 'intent'),
            '简介': ownData(profile, 'bio'),
            '兴趣标签': ownData(ownData(profile, 'tagGroups'), 'interests'),
            '生活方式标签': ownData(ownData(profile, 'tagGroups'), 'lifestyle'),
            '性格标签': ownData(ownData(profile, 'tagGroups'), 'personality'),
            '沟通风格标签': ownData(ownData(profile, 'tagGroups'), 'communication'),
        }, mode);
        if (!projected) return null;
        safeListings.push({ mode, publicProfile: projected });
    }
    const used = new Set();
    const contributions = safeListings.map((listing, index) => {
        const contribution = contributionForListing(listing, used, index);
        used.add(contribution);
        return deepFreeze({ nickname: listing.publicProfile.nickname, contribution });
    });
    const phrases = contributions.map((item) => `${item.nickname}偏向${item.contribution}`);
    return deepFreeze({
        participantCount: contributions.length,
        title: mode === 'SFW' ? '公开风格互补' : '公开节奏互补',
        summary: `${phrases.join('，')}；${mode === 'SFW' ? '这份组合只说明公开相处风格，当次安排仍需逐人确认。' : '这份组合只是公开风格提示，不代表任何具体同意。'}`.slice(0, 360),
        contributions,
    });
}

function normalizeMinimalHistory(history, mode) {
    if (!Array.isArray(history)) return [];
    const result = [];
    for (const record of history.slice(0, 80)) {
        if (!isPlainDataRecord(record) || ownData(record, 'mode') !== mode) continue;
        const categoryId = ownData(record, 'categoryId');
        const status = ownData(record, 'status');
        if (!validCategory(categoryId) || !['已完成', '已取消', '已中止'].includes(status)) continue;
        const rawProfiles = ownData(record, 'profiles');
        const sourceProfiles = Array.isArray(rawProfiles) && rawProfiles.length ? rawProfiles.slice(0, 3) : [ownData(record, 'profile')];
        const publicTags = [];
        for (const sourceProfile of sourceProfiles) {
            if (!isPlainDataRecord(sourceProfile)) continue;
            const tags = boundedStringArray(ownData(sourceProfile, '兴趣标签'), { mode, limit: 6, itemLength: 32 });
            for (const tag of tags) if (!publicTags.includes(tag) && publicTags.length < 12) publicTags.push(tag);
        }
        result.push({ categoryId, status, participantCount: Math.min(3, Math.max(1, sourceProfiles.length)), publicTags });
    }
    return result;
}

function historyFingerprint(records) {
    return records.map((record) => `${record.categoryId}:${record.status}:${record.participantCount}`).join('|').slice(0, 1200);
}

export function deriveServiceExplorationAtlas({ mode = 'SFW', history = [] } = {}) {
    const selectedMode = validMode(mode) ? mode : 'SFW';
    const records = normalizeMinimalHistory(history, selectedMode);
    const completed = records.filter((record) => record.status === '已完成');
    const counts = Object.fromEntries(SERVICE_CATEGORY_IDS.map((id) => [id, 0]));
    const attempts = Object.fromEntries(SERVICE_CATEGORY_IDS.map((id) => [id, 0]));
    const tags = new Set();
    let groupExperiences = 0;
    for (const record of records) {
        attempts[record.categoryId] += 1;
        if (record.status !== '已完成') continue;
        counts[record.categoryId] += 1;
        if (record.participantCount > 1) groupExperiences += 1;
        for (const tag of record.publicTags) if (tags.size < 24) tags.add(tag);
    }
    const categories = SERVICE_CATEGORY_IDS.map((id) => {
        const visits = counts[id];
        return {
            id,
            label: SERVICE_CATEGORY_DISPLAY_COPY[selectedMode][id].label,
            visits,
            attempts: attempts[id],
            discovered: visits > 0,
            level: Math.min(3, visits),
            progressText: visits === 0 ? '待点亮' : visits === 1 ? '初次点亮' : visits < 3 ? '继续了解' : '已成为熟悉方向',
        };
    });
    const uniqueCategories = categories.filter((item) => item.discovered).length;
    const milestoneSource = [
        { id: 'first_step', label: '第一个足印', unlocked: completed.length >= 1, progressText: `${Math.min(1, completed.length)}/1` },
        { id: 'all_sources', label: '三种来源全部点亮', unlocked: uniqueCategories === 3, progressText: `${uniqueCategories}/3` },
        { id: 'returning_explorer', label: '六次不同时光', unlocked: completed.length >= 6, progressText: `${Math.min(6, completed.length)}/6` },
        { id: 'ensemble_listener', label: '多人节奏练习', unlocked: groupExperiences >= 2, progressText: `${Math.min(2, groupExperiences)}/2` },
        { id: 'public_curiosity', label: '公开兴趣收集者', unlocked: tags.size >= 8, progressText: `${Math.min(8, tags.size)}/8` },
    ];
    const next = milestoneSource.find((item) => !item.unlocked);
    return deepFreeze({
        mode: selectedMode,
        title: selectedMode === 'SFW' ? '心动探索图鉴' : '夜色探索图鉴',
        totalCompleted: completed.length,
        uniqueCategories,
        groupExperiences,
        categories,
        milestones: milestoneSource,
        nextGoal: next ? `${next.label} · ${next.progressText}` : '当前图鉴里程碑已全部点亮',
    });
}

export function deriveServiceRecommendations({ mode = 'SFW', history = [], rotationKey = '', limit = 3 } = {}) {
    const selectedMode = validMode(mode) ? mode : 'SFW';
    const records = normalizeMinimalHistory(history, selectedMode);
    const completed = records.filter((record) => record.status === '已完成');
    const counts = Object.fromEntries(SERVICE_CATEGORY_IDS.map((id) => [id, 0]));
    const publicTags = new Set();
    for (const record of completed) {
        counts[record.categoryId] += 1;
        for (const tag of record.publicTags) if (publicTags.size < 24) publicTags.add(tag);
    }
    const safeRotation = boundedText(rotationKey, 64, { mode: selectedMode });
    const ranked = THEME_CATALOG[selectedMode].map((theme) => {
        const focusCategoryId = [...theme.categoryIds].sort((left, right) => counts[left] - counts[right] || left.localeCompare(right))[0];
        const leastVisits = counts[focusCategoryId];
        const matchingTag = theme.signalTags.find((tag) => publicTags.has(tag)) ?? '';
        const novelty = Math.max(0, 12 - leastVisits * 3);
        const affinity = matchingTag ? 4 : 0;
        const tie = stableHash(`${safeRotation}|${historyFingerprint(records)}|${theme.id}`) % 1000;
        return { theme, focusCategoryId, leastVisits, matchingTag, score: novelty * 10000 + affinity * 1000 + tie };
    }).sort((left, right) => right.score - left.score || left.theme.id.localeCompare(right.theme.id));
    const result = ranked.slice(0, clampLimit(limit, 3, 4)).map(({ theme, focusCategoryId, leastVisits, matchingTag }) => {
        let reason = '从本地固定主题中开始第一次探索。';
        if (completed.length && leastVisits === 0) reason = `尚未点亮「${SERVICE_CATEGORY_DISPLAY_COPY[selectedMode][focusCategoryId].label}」，适合扩展图鉴。`;
        else if (matchingTag) reason = `与最小公开记录中的「${matchingTag}」方向呼应。`;
        else if (completed.length) reason = '换一种公开相处风格，让探索图鉴保持新鲜。';
        return deepFreeze({ ...publicTheme(theme), focusCategoryId, reason });
    });
    return deepFreeze(result);
}

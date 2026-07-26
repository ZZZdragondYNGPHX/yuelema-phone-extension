import { buildGroupBrowseModel } from './groups/group-discovery-service.js';
import { listConversationSummaryRecords, listUnsummarizedConversationMessages, normalizeConversationSummaryState } from './chat/conversation-summary.js';
import { deriveMeetupAccess } from './chat/relationship-progress.js';

export const NAV_ITEMS = Object.freeze([
    { id: 'home', label: '首页', icon: '⌂' },
    { id: 'matches', label: '匹配', icon: '♥' },
    { id: 'messages', label: '消息', icon: '✉' },
    { id: 'groups', label: '群组', icon: '◎' },
    { id: 'profile', label: '我的', icon: '◉' },
]);

export const PAGE_COPY = Object.freeze({
    home: { title: '发现', description: '浏览公开资料。', help: '头像可打开对方的公开资料；线上互动仅保存受控 MVU 状态。' },
    matches: { title: '匹配', description: '互相喜欢的对象会出现在这里。', help: '本页只展示已建立的匹配关系与公开资料。' },
    messages: { title: '消息', description: '在已建立的会话中继续文字聊天。', help: '这里只展示会话可见的短消息；关键线下事件仍交给酒馆正文。' },
    private_chat: { title: '私聊', description: '', help: '消息会经已绑定的私聊功能处理；面基草稿不会自动发送。' },
    groups: { title: '小程序', description: '选择一个小程序。', help: '聊天群和论坛各自进入独立界面。' },
    group_chat: { title: '聊天群', description: '', help: '群消息、临时群友和自动更新只保存在当前浏览器，不写入 MVU。' },
    group_chat_room: { title: '聊天群', description: '', help: '右上角“…”可退出群聊、清空群历史或设置本群自动更新；自动更新仅在当前群打开时按设定秒数调用“聊天群”预设，关闭后改为玩家发言后更新。' },
    group_chat_create: { title: '创建聊天群', description: '群成员只可从已有私聊角色中选择；新群只保存公开资料快照到当前浏览器。', help: '不会建立新私聊、不会改动 MVU 群组或酒馆正文。' },
    group_chat_summary: { title: '聊天总结', description: '这份群聊总结仅保存在浏览器本地，不会写入 MVU。' },
    group_forum: { title: '心动社区', description: '', help: '顶部手机下拉松开、桌面向上滚轮停滚才会新增五个频道帖子；右上角“设置”可开关既有帖子自动更新，自动更新不会创建新帖子。点击频道仅查看对应本地帖子；首页本身不保存总结。' },
    forum_post: { title: '论坛帖子', description: '', help: '帖子讨论和临时评论者只保存在当前浏览器，不写入 MVU。' },
    forum_post_summary: { title: '聊天总结', description: '这份帖子讨论总结仅保存在浏览器本地，不会写入 MVU。' },
    profile: { title: '我的', description: '' },
    profile_editor: { title: '个人资料', description: '' },
    character_creator: { title: '创建角色', description: '创建、导入并管理仅在当前设备保存的成年人角色模板。' },
    favorites: { title: '收藏夹', description: '' },
    settings: { title: '设置', description: '' },
    settings_connections: { title: '连接预设', description: '' },
    settings_prompts: { title: '提示词预设', description: '' },
    settings_privacy: { title: '隐私权限设置', description: '' },
    settings_personalization: { title: '个性化内容推荐管理', description: '' },
    settings_personalization_preference: { title: '个性化内容偏好', description: '' },
    settings_images: { title: '图片管理', description: '管理只保存在当前浏览器的角色展示图片与匹配关键词。' },
    settings_console: { title: '控制台', description: '仅显示本次小手机会话中的安全运行状态。' },
    settings_chat_summary: { title: '对话总结', description: '设置自动总结策略，并浏览私聊、聊天群和帖子总结档案。' },
    settings_chat_summary_config: { title: '总结方案', description: '选择预设，并设置自动总结间隔与失败重试次数。' },
    settings_chat_summary_history: { title: '总结档案', description: '查看私聊、聊天群和论坛帖子已保存的对话总结。' },
    settings_chat_summary_history_detail: { title: '对话总结', description: '' },
    private_chat_summary: { title: '聊天总结', description: '查看本次私聊的总结结果并按需重新总结。' },
    match_profile: { title: '心动档案', description: '本次 AI 匹配的公开资料草稿；不会自动写入软件状态。' },
    candidate_detail: { title: '公开资料', description: '' },
});

/** Only these profile fields may cross from MVU state into the visible UI model. */
export const PUBLIC_PROFILE_FIELDS = Object.freeze([
    '昵称', '头像引用', '年龄段', '性别', '性取向', '城市', '距离范围', '寻找意图', '简介',
    '兴趣标签', '生活方式标签', '性格标签', '沟通风格标签',
]);

const PUBLIC_TEXT_FIELDS = Object.freeze([
    '昵称', '头像引用', '年龄段', '性别', '性取向', '城市', '距离范围', '寻找意图', '简介',
]);
const PUBLIC_TAG_FIELDS = Object.freeze(['兴趣标签', '生活方式标签', '性格标签', '沟通风格标签']);

function ownRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value, maxLength = 160) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function safeTags(value) {
    if (!Array.isArray(value)) return Object.freeze([]);
    const unique = [];
    for (const raw of value) {
        const tag = safeText(raw, 32);
        if (tag && !unique.includes(tag)) unique.push(tag);
        if (unique.length >= 12) break;
    }
    return Object.freeze(unique);
}

/**
 * Creates a privacy-preserving UI object. It deliberately never enumerates the
 * source profile and never includes hidden/friends-only data or the raw state.
 */
export function projectPublicProfile(profile, uid) {
    if (!ownRecord(profile) || typeof uid !== 'string' || !uid) return null;
    if (profile.成人验证 !== true || !ownRecord(profile.公开资料)) return null;

    const publicProfile = profile.公开资料;
    const projected = { uid };
    for (const field of PUBLIC_TEXT_FIELDS) projected[field] = safeText(publicProfile[field]);
    for (const field of PUBLIC_TAG_FIELDS) projected[field] = safeTags(publicProfile[field]);

    return Object.freeze(projected);
}

function findQueuedProfile(state) {
    if (!ownRecord(state) || !ownRecord(state.推荐) || !Array.isArray(state.推荐.当前队列)) return null;
    const candidatePool = ownRecord(state.推荐.临时候选池) ? state.推荐.临时候选池 : {};
    const rolePool = ownRecord(state.角色池) ? state.角色池 : {};

    for (const uid of state.推荐.当前队列) {
        if (typeof uid !== 'string') continue;
        const projected = projectPublicProfile(candidatePool[uid] ?? rolePool[uid], uid);
        if (projected) return projected;
    }
    return null;
}

function countPublicCandidates(state) {
    if (!ownRecord(state) || !ownRecord(state.推荐) || !Array.isArray(state.推荐.当前队列)) return 0;
    const candidatePool = ownRecord(state.推荐.临时候选池) ? state.推荐.临时候选池 : {};
    const rolePool = ownRecord(state.角色池) ? state.角色池 : {};
    let count = 0;
    for (const uid of state.推荐.当前队列) {
        if (typeof uid === 'string' && projectPublicProfile(candidatePool[uid] ?? rolePool[uid], uid)) count += 1;
    }
    return count;
}

/** Projects the player's public card only; no private profile or preference data crosses this boundary. */
export function projectPlayerPublicProfile(state) {
    const projected = projectPublicProfile(ownRecord(state) ? state.玩家 : null, 'player');
    if (!projected) return Object.freeze({
        uid: 'player', 昵称: '', 头像引用: '', 年龄段: '成年人', 性别: '', 性取向: '', 城市: '', 距离范围: '', 寻找意图: '', 简介: '',
        兴趣标签: Object.freeze([]), 生活方式标签: Object.freeze([]), 性格标签: Object.freeze([]), 沟通风格标签: Object.freeze([]),
    });
    return projected;
}

/** Provides public cards for the queue and favourites. The raw state and hidden profile layers never leave this module. */
export function projectRecommendationCollections(state) {
    const recommendation = ownRecord(state) && ownRecord(state.推荐) ? state.推荐 : {};
    const candidatePool = ownRecord(recommendation.临时候选池) ? recommendation.临时候选池 : {};
    const rolePool = ownRecord(state?.角色池) ? state.角色池 : {};
    const projectByUid = (uid) => typeof uid === 'string' ? projectPublicProfile(candidatePool[uid] ?? rolePool[uid], uid) : null;
    const projectList = (uids) => Object.freeze((Array.isArray(uids) ? uids : []).map(projectByUid).filter(Boolean));
    return Object.freeze({
        queue: projectList(recommendation.当前队列),
        favorites: projectList(recommendation.收藏角色UID),
    });
}

const CHAT_SESSION_UID_PATTERN = /^chat_[a-z0-9][a-z0-9_-]{0,63}$/i;
const CHAT_STATUS = new Set(['请求中', '已匹配', '已取消', '已拉黑']);
const CHAT_SENDERS = new Set(['玩家', '角色', '系统']);

/**
 * Projects only a chat-visible transcript and a public NPC card. This function
 * never returns the raw session, role, hidden profile, friends-only profile or state.
 */
/** Projects matched profiles without exposing relationship scores or non-public fields. */
export function projectMatchView(state) {
    if (!ownRecord(state) || !ownRecord(state.角色池)) return Object.freeze([]);
    const matches = [];
    for (const [uid, profile] of Object.entries(state.角色池)) {
        // Mutual-match cards are created only by the dedicated AI matching
        // transaction.  A saved recommendation can later become a private chat,
        // but must not be misrepresented as a soul/voice mutual match.
        if (!/^npc_match_\d+$/u.test(uid)) continue;
        const projected = projectPublicProfile(profile, uid);
        const relationship = projected ? profile.与玩家关系 : null;
        if (projected && ownRecord(relationship) && relationship.状态 === '已匹配') {
            matches.push(Object.freeze({ uid, profile: projected, status: '已匹配' }));
        }
    }
    return Object.freeze(matches.sort((left, right) => left.uid.localeCompare(right.uid, 'zh-Hans-CN')));
}

export function projectPrivateChatView(state) {
    if (!ownRecord(state) || !ownRecord(state.会话) || !ownRecord(state.角色池)) return Object.freeze([]);
    const sessions = [];
    for (const [sessionUid, session] of Object.entries(state.会话)) {
        if (!CHAT_SESSION_UID_PATTERN.test(sessionUid) || !ownRecord(session) || !CHAT_STATUS.has(session.状态)) continue;
        const npcUid = typeof session.对象UID === 'string' ? session.对象UID : '';
        const profile = projectPublicProfile(state.角色池[npcUid], npcUid);
        if (!profile) continue;
        const messages = [];
        for (const raw of Array.isArray(session.最近消息) ? session.最近消息.slice(-240) : []) {
            if (!ownRecord(raw) || !CHAT_SENDERS.has(raw.发送者)) continue;
            const content = safeText(raw.内容, 600);
            if (!content) continue;
            messages.push(Object.freeze({
                messageUid: safeText(raw.消息UID, 80), sender: raw.发送者, content, time: safeText(raw.时间, 80),
            }));
        }
        const summaryState = normalizeConversationSummaryState(session);
        const summaryRecords = listConversationSummaryRecords(session).map((record) => Object.freeze({
            summaryUid: record.uid,
            startLayer: record.startLayer,
            endLayer: record.endLayer,
            content: record.content,
            time: record.time,
        }));
        const totalLayers = Number.isInteger(session.对话层数) && session.对话层数 >= messages.length
            ? session.对话层数 : messages.length;
        const meetupAccess = deriveMeetupAccess({
            contentMode: state.软件?.内容模式,
            relationship: state.角色池[npcUid]?.与玩家关系,
        });
        sessions.push(Object.freeze({
            sessionUid, npcUid, status: session.状态, profile, messages: Object.freeze(messages),
            meetupAccess,
            summary: safeText(session.长期摘要, 500),
            summaryInfo: Object.freeze({
                totalLayers,
                pendingMessageCount: listUnsummarizedConversationMessages(session).length,
                records: Object.freeze(summaryRecords),
                status: summaryState.status,
                failureReason: summaryState.failureReason,
                targetSummaryUid: summaryState.targetSummaryUid,
                attempts: summaryState.attempts,
            }),
            canSend: session.状态 === '已匹配',
        }));
    }
    return Object.freeze(sessions.sort((left, right) => left.sessionUid.localeCompare(right.sessionUid, 'zh-Hans-CN')));
}

const SERVICE_ORDER_UID_PATTERN = /^service_[a-z0-9][a-z0-9_-]{0,63}$/i;
const SERVICE_ORDER_STATES = new Set(['待确认', '进行中', '已完成', '已取消']);
const SERVICE_CATEGORY_LABELS = Object.freeze({
    SFW: Object.freeze({ coffee_walk: '咖啡与散步', arts_outing: '展览与演出', city_guide: '城市向导', hobby_day: '兴趣活动' }),
    NSFW: Object.freeze({ adult_companion: '成人直白陪伴', erotic_roleplay: '情色角色扮演', explicit_chat: '露骨文爱', private_service: '私密成人服务' }),
});
const SERVICE_ORDER_LIFECYCLE_FIELDS = Object.freeze(['发起时间', '开始时间', '结束时间', '结束摘要', '已确认边界']);
const SERVICE_TIME_SAFE_PATTERNS = Object.freeze([
    /^(?:待正文确认|刚刚|今天|昨天)$/u,
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:[ T](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)?)?$/u,
    /^(?:正文)?第\s?[1-9]\d{0,5}\s?轮$/u,
]);
const SERVICE_SUMMARY_ALWAYS_SENSITIVE_PATTERN = /(?:身份证|身份證|护照|護照|银行卡|銀行卡|(?:手机|電話|电话)(?:号码|號碼)?|手机号|座机|座機|(?:微信|WeChat)(?:号|號|账号|帳號)?|QQ(?:号|號|号码|號碼|群)?|(?:Telegram|TG|Discord|LINE)(?:账号|帳號|号|號)?|精确地址|详细地址|詳細地址|具体住址|家庭住址|收货地址|收貨地址|现住址|現住址|门牌|楼栋|樓棟|单元|單元|房间号|房間號|房号|房號|经纬度|經緯度|定位|(?:完整|详细|詳細).{0,12}(?:露骨|色情|性).{0,8}(?:过程|過程)|\b(?:\d{15,18}[0-9Xx]|(?:\+?86[-\s]?)?1[3-9]\d{9}|0\d{2,3}[-\s]?\d{7,8})\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:https?:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|cn|io|me|app|xyz|top)\b|(?:省|市|区|區|县|縣).{0,32}(?:路|街|巷|弄|号|號|栋|棟|室))/iu;
const SERVICE_SUMMARY_SFW_TRANSACTION_PATTERN = /(?:支付(?:宝|寶)?|收款码|收款碼|付款码|付款碼|转账|轉帳|汇款|匯款|打款|定金|尾款|现金交易|現金交易)/iu;
const PUBLIC_MINOR_AGE_PATTERN = /(?:未成年|未滿|未满\s*18|minor|underage|(?:^|[^0-9])1[0-7]\s*(?:岁|歲)?(?:$|[^0-9]))/iu;

function verifiedAdultProfile(profile) {
    const hidden = profile?.隐藏资料;
    const publicProfile = profile?.公开资料;
    const publicAge = ownRecord(publicProfile) ? publicProfile.年龄段 : '';
    return ownRecord(profile) && profile.成人验证 === true && ownRecord(hidden) && Number.isInteger(hidden.实际年龄) && hidden.实际年龄 >= 18
        && hidden.实际年龄 <= 120 && typeof publicAge === 'string' && !PUBLIC_MINOR_AGE_PATTERN.test(publicAge);
}

function hasOrderText(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function isCurrentServiceOrderSnapshot(raw) {
    if (!SERVICE_ORDER_LIFECYCLE_FIELDS.every((field) => typeof raw[field] === 'string')) return false;
    const initiated = hasOrderText(raw.发起时间);
    const started = hasOrderText(raw.开始时间);
    const ended = hasOrderText(raw.结束时间);
    const summary = hasOrderText(raw.结束摘要);
    const confirmedBoundaries = hasOrderText(raw.已确认边界);
    switch (raw.状态) {
    case '待确认':
        return initiated && !started && !ended && !summary && !confirmedBoundaries;
    case '进行中':
        return initiated && started && !ended && !summary && confirmedBoundaries;
    case '已完成':
        return initiated && started && ended && summary && confirmedBoundaries;
    case '已取消':
        return initiated && ended && summary
            && ((started && confirmedBoundaries) || (!started && !confirmedBoundaries));
    default:
        return false;
    }
}

function projectServiceTime(value, fallback) {
    const time = safeText(value, 160);
    return SERVICE_TIME_SAFE_PATTERNS.some((pattern) => pattern.test(time)) ? time : fallback;
}

function projectServiceSummary(value, mode) {
    const rawSummary = typeof value === 'string' ? value.trim() : '';
    if (!rawSummary) return '';
    const sensitive = SERVICE_SUMMARY_ALWAYS_SENSITIVE_PATTERN.test(rawSummary)
        || (mode === 'SFW' && SERVICE_SUMMARY_SFW_TRANSACTION_PATTERN.test(rawSummary));
    return sensitive ? '该记录包含不适合展示的敏感内容，已隐藏。' : safeText(rawSummary, 600);
}

function hasCompletionSignal(raw) {
    const signal = raw?.合法结束条件;
    return ownRecord(signal) && raw?.状态 === '进行中' && signal.已满足 === true
        && typeof signal.摘要 === 'string' && signal.摘要.trim().length > 0
        && typeof signal.记录时间 === 'string' && signal.记录时间.trim().length > 0;
}

/**
 * Projects service orders together with their role's public card. Private role
 * layers, raw order payloads and internal counters never leave this boundary.
 */
export function projectServiceOrderView(state) {
    if (!ownRecord(state) || !ownRecord(state.服务订单) || !ownRecord(state.角色池)) return Object.freeze([]);
    const orders = [];
    for (const [orderUid, raw] of Object.entries(state.服务订单)) {
        if (!SERVICE_ORDER_UID_PATTERN.test(orderUid) || !ownRecord(raw) || !SERVICE_ORDER_STATES.has(raw.状态)) continue;
        const roleUids = Array.isArray(raw.角色UID列表) && raw.角色UID列表.length ? raw.角色UID列表 : [raw.角色UID];
        if (!['SFW', 'NSFW'].includes(raw.内容模式) || typeof raw.角色UID !== 'string' || roleUids.length < 1 || roleUids.length > 3 || roleUids[0] !== raw.角色UID || new Set(roleUids).size !== roleUids.length || !isCurrentServiceOrderSnapshot(raw)) continue;
        const categoryId = safeText(raw.服务分类, 64); const category = SERVICE_CATEGORY_LABELS[raw.内容模式]?.[categoryId] ?? '';
        const profiles = roleUids.map((roleUid) => {
            const role = state.角色池[roleUid]; if (!verifiedAdultProfile(role)) return null;
            return projectPublicProfile(role, roleUid);
        });
        if (!category || profiles.some((profile) => !profile)) continue;
        const names = profiles.map((profile) => profile.昵称 || '该角色'); const topic = category + '：与' + names.join('、') + '的文字协商';
        if (safeText(raw.服务主题, 240) !== topic) continue;
        const endedFallback = raw.状态 === '已取消' ? '订单已取消' : '订单已完成';
        orders.push(Object.freeze({
            id: orderUid, roleUid: raw.角色UID, roleUids: Object.freeze([...roleUids]), profile: profiles[0], profiles: Object.freeze(profiles),
            mode: raw.内容模式, categoryId, category, topic, status: raw.状态,
            initiatedAt: projectServiceTime(raw.发起时间, '订单已建立'),
            startedAt: hasOrderText(raw.开始时间) ? projectServiceTime(raw.开始时间, '已在正文中确认') : '',
            endedAt: hasOrderText(raw.结束时间) ? projectServiceTime(raw.结束时间, endedFallback) : '',
            summary: projectServiceSummary(raw.结束摘要, raw.内容模式),
            completionReady: hasCompletionSignal(raw),
        }));
    }
    return Object.freeze(orders.sort((left, right) => right.id.localeCompare(left.id, 'zh-Hans-CN')));
}

/** Returns generic repair targets without exposing raw malformed order data to the UI. */
export function projectServiceOrderIssues(state) {
    if (!ownRecord(state) || !ownRecord(state.服务订单)) return Object.freeze([]);
    const visible = new Set(projectServiceOrderView(state).map((order) => order.id));
    const issues = [];
    for (const [orderUid, raw] of Object.entries(state.服务订单)) {
        if (SERVICE_ORDER_UID_PATTERN.test(orderUid) && ownRecord(raw) && !visible.has(orderUid)) {
            issues.push(Object.freeze({ id: orderUid, message: '检测到一条无法安全显示的服务记录；可移除损坏记录后重新创建订单。' }));
        }
    }
    return Object.freeze(issues.sort((left, right) => left.id.localeCompare(right.id, 'zh-Hans-CN')));
}
/**
 * Converts readLatestState() output to the only view data consumed by app-shell.
 * `state` itself is intentionally omitted from the return value.
 */
export function createPhoneView(readResult) {
    if (!readResult?.ok || !ownRecord(readResult.state)) {
        return Object.freeze({
            status: 'unavailable',
            code: typeof readResult?.code === 'string' ? readResult.code : 'mvu_state_unavailable',
            mode: '未知',
            candidate: null,
            candidates: Object.freeze([]),
            favorites: Object.freeze([]),
            playerProfile: projectPlayerPublicProfile(null),
            queueCount: 0,
            matches: Object.freeze([]),
            messageSessions: Object.freeze([]),
            groups: Object.freeze([]),
            serviceOrders: Object.freeze([]),
            serviceOrderIssues: Object.freeze([]),
        });
    }

    const software = ownRecord(readResult.state.软件) ? readResult.state.软件 : {};
    const mode = software.内容模式 === 'NSFW' ? 'NSFW' : 'SFW';
    const collections = projectRecommendationCollections(readResult.state);
    const candidates = Object.freeze([...collections.queue, ...collections.favorites.filter((favorite) => !collections.queue.some((candidate) => candidate.uid === favorite.uid))]);
    return Object.freeze({
        status: 'ready',
        code: '',
        mode,
        candidate: collections.queue[0] ?? null,
        candidates,
        favorites: collections.favorites,
        playerProfile: projectPlayerPublicProfile(readResult.state),
        queueCount: countPublicCandidates(readResult.state),
        matches: projectMatchView(readResult.state),
        messageSessions: projectPrivateChatView(readResult.state),
        groups: buildGroupBrowseModel(readResult.state).群组,
        serviceOrders: projectServiceOrderView(readResult.state),
        serviceOrderIssues: projectServiceOrderIssues(readResult.state),
    });
}

export function describeActionFailure(result) {
    const code = typeof result?.code === 'string' ? result.code : '';
    const messages = {
        ui_action_pending: '操作正在处理中，请勿重复点击。',
        mvu_get_unavailable: 'MVU 尚未就绪，暂时无法读取本聊天状态。',
        mvu_stat_data_unavailable: '当前消息没有可用的软件状态。',
        mvu_official_pipeline_unavailable: 'MVU 官方更新管线尚未就绪。',
        mvu_variable_event_unavailable: '变量更新事件尚未就绪，未写入任何更改。',
        npc_not_found: '该候选人已变化，请等待界面刷新。',
        npc_adult_verification_failed: '该资料未通过成年人校验，已拒绝操作。',
        like_match_source_not_available: '该资料已不在当前候选或收藏列表，请返回后刷新。',
        like_preference_source_not_available: '这位对象已不在首页候选中；收藏后请从收藏夹发起私聊。',
        recommendation_source_not_available: '该资料已不在当前候选或收藏列表，请返回后刷新。',
        favorite_private_chat_not_favorited: '该对象已不在收藏夹中，请返回后刷新。',
        favorite_private_chat_already_started: '这次私聊邀请已经处理过了。',
        favorite_private_chat_state_invalid: '当前资料缺少可用于私聊判定的公开信息。',
        favorite_private_chat_score_invalid: '当前资料的匹配分数异常，未发起私聊。',
        content_mode_gate_state_invalid: '内容模式状态异常，未执行切换。',
        service_order_invalid_state: '当前聊天缺少专属服务订单数据结构，请导入 v0.1.37 角色卡后新开聊天。',
        service_order_state_invalid: '服务订单状态未就绪，未复制任何本地角色。',
        service_order_candidate_invalid: '本地角色未通过成年公开资料校验，未复制。',
        service_order_uid_conflict: '服务订单编号冲突，请刷新后重试。',
        service_order_mode_changed: '内容模式已变化，未提交服务订单更新，请刷新后重试。',
        service_order_result_invalid: '正文返回的服务订单结果未通过校验，未写入任何数据。',
        service_order_rebook_invalid: '历史服务角色或当前模式不可用于再次下单。',
        service_order_start_invalid: '待确认订单或结构化边界无效，未开始服务。',
        service_order_cancel_invalid: '只有待确认订单可以由玩家取消。',
        service_order_complete_invalid: '当前订单尚未进入进行中，不能完成归档。',
        service_order_finalize_invalid: '订单未达到可安全归档的终态。',
        service_order_conflict: '当前已有另一笔待确认或进行中的订单。',
        mvu_parse_returned_no_data: '本次没有可提交的变量变化。',
        mvu_parse_returned_no_stat_data: 'MVU 未返回可保存的软件状态，本次未写入。',
        mvu_parse_made_no_change: 'MVU 未接受本次修改（状态未发生变化），未写入任何数据。',
        mvu_parse_failed: 'MVU 解析本次修改时出错，未写入任何数据。',
        mvu_parse_input_clone_failed: 'MVU 的临时解析副本不可用，本次未写入任何数据。',
        mvu_relationship_routes_schema_outdated: '当前聊天的角色卡仍缺少关系路线字段。请导入与小手机相同版本的《约了吗》MVU 角色卡，并新开聊天后重试；本次模型结果未写入。',
        mvu_replace_failed: 'MVU 保存本次修改时出错。',
        mvu_read_failed: '读取当前状态失败，未写入任何数据。',
        private_chat_invalid_target: '当前私聊会话已变化，请返回消息列表后重试。',
        private_chat_session_not_found: '当前私聊会话已不可用，请返回消息列表后重试。',
        private_chat_not_matched: '当前对象尚未建立可发送的私聊。',
        private_chat_adult_verification_failed: '该资料未通过成年人校验，无法发送私聊。',
        private_chat_message_invalid: '消息不能为空或格式不正确。',
        private_chat_settings_unavailable: '私聊设置暂不可用。',
        private_chat_settings_invalid: '私聊预设无效，请检查设置。',
        private_chat_connection_missing: '请先为“私聊”绑定连接预设或设置默认连接。',
        private_chat_llm_unavailable: '当前浏览器未提供私聊模型连接。',
        private_chat_invalid_json: '快速模型没有返回可用的私聊回复，本条消息未写入。',
        private_chat_response_invalid: '私聊回复未通过校验，本条消息未写入。',
        private_chat_relationship_state_invalid: '当前关系状态异常，本条消息未写入。',
        private_chat_session_messages_invalid: '当前会话记录异常，本条消息未写入。',
        private_chat_history_requires_summary: '聊天记录已达到保留上限；请先完成未整理的聊天总结后再发送。',
        private_chat_rhythm_state_invalid: '当前角色的互动节奏设置异常，本条消息未写入。',
        private_chat_delete_invalid_target: '该会话标识无效，未执行删除。',
        private_chat_delete_not_found: '该会话已不存在，请返回消息列表刷新。',
        private_chat_delete_state_invalid: '该会话状态异常，未执行删除。',
    };
    if (messages[code]) return messages[code];
    return code ? `操作未完成，未写入任何未校验的数据。（${code}）` : '操作未完成，未写入任何未校验的数据。';
}

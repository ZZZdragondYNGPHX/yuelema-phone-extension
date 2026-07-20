import { buildGroupBrowseModel } from './groups/group-discovery-service.js';

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
    group_chat: { title: '聊天群', description: '', help: '只显示明确成年角色的公开资料。' },
    group_forum: { title: '论坛', description: '', help: '论坛页只展示公开主题与公开讨论入口。' },
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
        for (const raw of Array.isArray(session.最近消息) ? session.最近消息.slice(-30) : []) {
            if (!ownRecord(raw) || !CHAT_SENDERS.has(raw.发送者)) continue;
            const content = safeText(raw.内容, 600);
            if (!content) continue;
            messages.push(Object.freeze({
                messageUid: safeText(raw.消息UID, 80), sender: raw.发送者, content, time: safeText(raw.时间, 80),
            }));
        }
        sessions.push(Object.freeze({
            sessionUid, npcUid, status: session.状态, profile, messages: Object.freeze(messages),
            summary: safeText(session.长期摘要, 500), canSend: session.状态 === '已匹配',
        }));
    }
    return Object.freeze(sessions.sort((left, right) => left.sessionUid.localeCompare(right.sessionUid, 'zh-Hans-CN')));
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
        mvu_parse_returned_no_data: '本次没有可提交的变量变化。',
        mvu_parse_returned_no_stat_data: 'MVU 未返回可保存的软件状态，本次未写入。',
        mvu_parse_made_no_change: 'MVU 未接受本次修改（状态未发生变化），未写入任何数据。',
        mvu_parse_failed: 'MVU 解析本次修改时出错，未写入任何数据。',
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
    };
    if (messages[code]) return messages[code];
    return code ? `操作未完成，未写入任何未校验的数据。（${code}）` : '操作未完成，未写入任何未校验的数据。';
}

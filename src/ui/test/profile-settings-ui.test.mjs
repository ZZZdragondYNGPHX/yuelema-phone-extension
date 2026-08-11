// P2-E1 我的页 + 设置详情 + 二级页 DOM 回归（策划书 §10.1/§10.2/§10.4 + 裁决 D7）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';
import { createMemoryStorage, createSettingsStore } from '../../settings/settings-store.js';

const miniDom = installMiniDom();
const { mountPhoneApp } = await import('../../app-shell.js');

test.after(() => miniDom.restore());

function adultCharacter(nickname = '公开候选人') {
    return {
        成人验证: true,
        公开资料: {
            昵称: nickname, 头像引用: '', 年龄段: '25-29', 性别: '女', 性取向: '双性恋',
            城市: '上海', 距离范围: '10 km', 寻找意图: '聊天后约会', 简介: '只展示公开资料。',
            兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'],
        },
        仅好友资料: {}, 隐藏资料: {}, 偏好与边界: '',
        拒绝阈值: 40, 已读不回阈值: 55, 取消匹配阈值: 70, 拉黑阈值: 90,
        与玩家关系: { 状态: '未匹配', 全局账号表现: 80, NPC专属匹配度: 85, 好感: 0, 信任: 0, 戒备: 0, 面基意愿: 0 },
    };
}

function readyReadResult() {
    const candidate = adultCharacter();
    return {
        ok: true,
        state: {
            系统: { UID计数器: { 角色: 1 } },
            软件: { 内容模式: 'SFW' },
            玩家: { 成人验证: true, 公开资料: adultCharacter('玩家昵称').公开资料 },
            推荐: { 当前队列: ['npc_1'], 临时候选池: { npc_1: candidate }, 冷却角色UID: [], 收藏角色UID: [], 不喜欢角色UID: [], 拉黑角色UID: [] },
            角色池: { npc_1: candidate }, 会话: {},
            群组: {},
        },
    };
}

function click(node) {
    assert.ok(node, '要点击的控件必须存在');
    node.dispatchEvent(new Event('click'));
}

/* P3-D：hub 入口迁移 ListRow（div[role=button]）后，按 page 找入口需同时覆盖原生按钮与 .yl-hub-entry 行 */
function buttonByPage(page) {
    return [
        ...miniDom.document.querySelectorAll('button'),
        ...miniDom.document.querySelectorAll('.yl-hub-entry'),
    ].find((node) => node.dataset.page === page);
}

function navButton(page) {
    return miniDom.document.querySelectorAll('button').find((node) => node.dataset.page === page);
}

function backButton() {
    return miniDom.document.querySelector('.yl-page-back');
}

function mount(rootId, overrides = {}) {
    return mountPhoneApp({
        documentRef: miniDom.document, rootId,
        actionBridge: { emit() {}, isPending() { return false; } },
        settingsStore: createSettingsStore({ storage: createMemoryStorage() }),
        llmClient: null, characterLibrary: null, readState: readyReadResult,
        ...overrides,
    });
}

function openProfile() {
    click(miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '打开约了吗小手机'));
    click(navButton('profile'));
}

test('我的页：身份 Hero + 数据行 + 四个分组直达列表（D7 无设置目录、关于入口唯一）', () => {
    const mounted = mount('ylm-e1-profile-structure');
    try {
        openProfile();
        /* 身份 Hero：72px 头像按钮（头像管理逻辑不变）+ 昵称/城市 + 编辑公开资料 tonal 钮 */
        const hero = miniDom.document.querySelector('.yl-profile-hero');
        assert.ok(hero, '我的页应有身份 Hero');
        const avatarButton = hero.querySelector('.yl-person-avatar-button');
        assert.ok(avatarButton, 'Hero 应包含头像管理入口');
        assert.equal(avatarButton.getAttribute('aria-label'), '更换个人头像');
        assert.match(hero.textContent, /玩家昵称/u);
        assert.match(hero.textContent, /上海/u);
        const edit = hero.querySelector('.yl-btn--tonal');
        assert.ok(edit, '编辑公开资料应为 tonal 按钮');
        assert.match(edit.textContent, /编辑公开资料/u);
        /* 数据行：私聊 / 收藏 / 角色模板 三个可点击 stat */
        const stats = miniDom.document.querySelectorAll('.yl-profile-stat');
        assert.equal(stats.length, 3, '数据行应固定三个 stat');
        assert.deepEqual(stats.map((node) => node.dataset.statTarget), ['messages', 'favorites', 'character_creator']);
        /* 分组列表：关系资产 / 创作 / 设置 / 诊断 */
        const groups = miniDom.document.querySelectorAll('.yl-profile-group');
        assert.deepEqual(
            groups.map((group) => group.querySelector('h2').textContent),
            ['关系资产', '创作', '设置', '诊断'],
            '我的页应固定为四个分组',
        );
        const entryPages = miniDom.document.querySelectorAll('.yl-hub-entry').map((entry) => entry.dataset.page);
        assert.deepEqual(entryPages, [
            'favorites', 'matches', 'character_creator', 'settings_images',
            'settings_connections', 'settings_prompts', 'settings_image_generation', 'settings_privacy', 'settings_preferences',
            'settings_console', 'about',
        ], '分组入口应直达二级页，且不含设置目录页');
        assert.equal(entryPages.includes('settings'), false, 'D7：我的页不得再出现设置目录入口');
        assert.equal(entryPages.filter((page) => page === 'about').length, 1, '关于软件只保留诊断分组一个入口');
        for (const entry of miniDom.document.querySelectorAll('.yl-hub-entry')) {
            assert.ok(entry.querySelector('svg'), '每个分组入口都应有本地 SVG 图标');
            /* P3-D：入口行迁移 ListRow 后必须保持完整按钮语义与可访问名称 */
            assert.ok(entry.classList.contains('yl-row'), '分组入口应基于 ListRow 组件');
            assert.equal(entry.getAttribute('role'), 'button', '分组入口应保持 role=button 语义');
            assert.equal(entry.getAttribute('tabindex'), '0', '分组入口应保持键盘可聚焦');
            assert.ok(entry.getAttribute('aria-label'), '分组入口应保留可访问名称');
        }
        /* 未解锁时不得出现约伴专属服务入口 */
        assert.equal(entryPages.includes('service_hub'), false, '专属服务未解锁时不显示入口');
        /* 隐私红线：摘要不得泄漏阈值 / UID / 隐藏资料 */
        const pageText = miniDom.document.querySelector('.yl-person-center').textContent;
        assert.doesNotMatch(pageText, /拒绝阈值|NPC专属匹配度|npc_1|api[\s_-]*key/iu);
        /* 页头仍保留布局切换钮 */
        assert.ok(miniDom.document.querySelector('.yl-ui-layout-toggle'), '我的页头应保留布局切换钮');
    } finally {
        mounted.destroy();
    }
});

test('数据行 stat 分别直达 消息 / 收藏夹 / 模板库', () => {
    const mounted = mount('ylm-e1-profile-stats');
    try {
        openProfile();
        const stat = (target) => miniDom.document.querySelectorAll('.yl-profile-stat').find((node) => node.dataset.statTarget === target);
        click(stat('messages'));
        assert.ok(miniDom.document.querySelector('.yl-page-messages'), '私聊 stat 应跳消息页');
        click(navButton('profile'));
        click(stat('favorites'));
        assert.ok(miniDom.document.querySelector('.yl-page-favorites'), '收藏 stat 应跳收藏夹');
        assert.ok(backButton(), '收藏夹应保留返回按钮');
        click(backButton());
        click(stat('character_creator'));
        assert.ok(miniDom.document.querySelector('.yl-page-character_creator'), '角色模板 stat 应跳模板库（创建角色页）');
    } finally {
        mounted.destroy();
    }
});

test('设置从我的页直接二级可达：连接/提示词详情互相隔离且无目录中转', () => {
    const mounted = mount('ylm-e1-settings-direct');
    try {
        openProfile();
        click(buttonByPage('settings_connections'));
        assert.ok(backButton(), '连接预设详情应有返回按钮');
        assert.ok(miniDom.document.querySelector('[name="connection-name"]'), '应直接进入连接预设详情');
        assert.equal(miniDom.document.querySelector('[name="prompt-preset-name"]'), null, '连接详情不得混入提示词视图');
        assert.equal(miniDom.document.querySelector('.yl-settings-catalog-grid'), null, '不得渲染旧设置目录');
        click(navButton('profile'));
        click(buttonByPage('settings_prompts'));
        assert.ok(miniDom.document.querySelector('[name="prompt-preset-name"]'), '应直接进入提示词预设详情');
        assert.equal(miniDom.document.querySelector('[name="connection-name"]'), null, '提示词详情不得混入连接视图');
        click(navButton('profile'));
        click(buttonByPage('settings_image_generation'));
        assert.ok(miniDom.document.querySelector('[name="image-generation-enabled"]'), '生图设置应直接可达');
    } finally {
        mounted.destroy();
    }
});

test('设置详情套用新表单语言：平铺分组 + SVG 分区图标 + API Key 保持 password', () => {
    const mounted = mount('ylm-e1-settings-form');
    try {
        openProfile();
        click(buttonByPage('settings_connections'));
        const detail = miniDom.document.querySelector('.yl-settings-detail');
        assert.ok(detail, '设置详情应位于 yl-settings-detail 容器');
        assert.ok(detail.querySelector('.yl-settings-section'), '详情内应保留分组 section');
        const sectionIcon = detail.querySelector('.yl-section-icon');
        assert.ok(sectionIcon, '分组标题应有图标槽');
        const iconSvg = sectionIcon.querySelector('svg');
        assert.ok(iconSvg, '分区图标必须是本地 SVG');
        assert.equal(iconSvg.dataset.icon, 'connection');
        assert.equal(sectionIcon.textContent.trim(), '', '分区图标不得再使用字符字形');
        assert.ok(detail.querySelector('.yl-settings-control'), '表单控件应使用统一 yl-settings-control');
        const apiKey = miniDom.document.querySelector('[name="connection-api-key"]');
        assert.equal(apiKey.getAttribute('type'), 'password', 'API Key 输入必须保持 password');
        assert.match(miniDom.document.body.textContent, /API Key 位于独立缓存|保存到当前浏览器/u, 'API Key 存储说明必须保留');
    } finally {
        mounted.destroy();
    }
});

test('隐私与总结二级页同时收纳个性化推荐与对话总结', () => {
    const mounted = mount('ylm-e1-privacy-summary');
    try {
        openProfile();
        click(buttonByPage('settings_privacy'));
        assert.ok(backButton(), '隐私与总结页应有返回按钮');
        const entryPages = miniDom.document.querySelectorAll('.yl-hub-entry').map((entry) => entry.dataset.page);
        assert.deepEqual(entryPages, ['settings_personalization', 'settings_chat_summary'], '隐私与总结应包含两个直达入口');
        click(buttonByPage('settings_personalization'));
        assert.ok(miniDom.document.querySelector('[name="personalization-enabled"]'), '个性化推荐管理仍可达');
        click(navButton('profile'));
        click(buttonByPage('settings_privacy'));
        click(buttonByPage('settings_chat_summary'));
        assert.ok(miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '自动对话总结开关'), '对话总结开关仍可达');
    } finally {
        mounted.destroy();
    }
});

test('收藏夹空态使用 EmptyState 组件（heart 变体）', () => {
    const readResult = readyReadResult();
    const mounted = mount('ylm-e1-favorites-empty', { readState: () => readResult });
    try {
        openProfile();
        click(buttonByPage('favorites'));
        const empty = miniDom.document.querySelector('.yl-empty');
        assert.ok(empty, '收藏夹空态应使用 EmptyState 组件');
        assert.ok(empty.classList.contains('yl-empty--heart'), '收藏夹空态应为 heart 变体');
        assert.ok(empty.querySelector('.yl-empty__svg'), '空态插画必须是 SVG');
        assert.match(empty.textContent, /收藏夹还是空的/u);
    } finally {
        mounted.destroy();
    }
});

test('关于页彩蛋链保留，开启专属服务后我的页出现金框入口（D1）', () => {
    const mounted = mount('ylm-e1-service-entry');
    try {
        openProfile();
        click(buttonByPage('about'));
        assert.ok(miniDom.document.querySelector('[name="about-version-info"]'), '关于页应可从诊断分组直达');
        /* 五连点更新日志解锁专属服务入口（逻辑原样保留） */
        for (let index = 0; index < 5; index += 1) {
            click(miniDom.document.querySelector('[name="about-release-notes"]'));
        }
        const unlock = miniDom.document.querySelector('[name="about-service-entry"]');
        assert.ok(unlock, '五连点后应出现开启专属服务入口');
        click(unlock);
        assert.ok(miniDom.document.querySelector('.yl-page-service_hub'), '开启后应进入专属服务页');
        click(navButton('profile'));
        const service = miniDom.document.querySelectorAll('.yl-hub-entry').find((entry) => entry.dataset.page === 'service_hub');
        assert.ok(service, '解锁后关系资产分组应出现约伴专属服务入口');
        assert.equal(service.dataset.tone, 'gold', '专属服务入口应为金色 tone');
    } finally {
        mounted.destroy();
    }
});

async function flushUi() {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
}

test('关于页最底部提供固定扩展检查并自动更新入口，成功后安排自动重载与重开', async () => {
    let resolveUpdate;
    let calls = 0;
    let restartCalls = 0;
    const mounted = mount('ylm-e1-extension-update', {
        extensionUpdater: {
            checkAndUpdate() {
                calls += 1;
                return new Promise((resolve) => { resolveUpdate = resolve; });
            },
        },
        restartAfterUpdate() {
            restartCalls += 1;
            return { scheduled: true, reopenMarked: true };
        },
    });
    try {
        openProfile();
        click(buttonByPage('about'));
        const section = miniDom.document.querySelector('.yl-about-page');
        const update = miniDom.document.querySelector('[name="about-extension-update"]');
        assert.ok(update, '关于页最底部必须有扩展更新入口');
        assert.equal(section.childNodes.at(-1), update, '扩展更新入口必须位于关于页最底部');
        assert.ok(update.classList.contains('yl-center-entry'), '更新入口应复用中心列表视觉');
        assert.equal(update.disabled, false, '有宿主更新器时入口可用');
        click(update);
        assert.equal(calls, 1, '单击只调用一次宿主更新器');
        const pending = miniDom.document.querySelector('[name="about-extension-update"]');
        assert.equal(pending.disabled, true, '检查期间入口必须禁用');
        assert.equal(pending.getAttribute('aria-busy'), 'true');
        const dialog = miniDom.document.querySelector('.yl-operation-dialog');
        assert.equal(dialog.hidden, false, '检查期间应显示统一操作弹窗');
        assert.match(dialog.textContent, /正在检查扩展更新/u);
        resolveUpdate({ outcome: 'updated' });
        await flushUi();
        assert.match(dialog.textContent, /更新已完成/u);
        assert.match(dialog.textContent, /自动重新载入酒馆页面/u);
        assert.match(dialog.textContent, /自动重新打开小手机/u);
        assert.equal(restartCalls, 1, '更新成功后只安排一次自动重载与重开');
        assert.doesNotMatch(dialog.textContent, /https?:|github|[A-Za-z]:\\/iu, '成功反馈不得暴露远程地址或本地路径');
    } finally {
        mounted.destroy();
    }
});

test('无宿主更新器时关于页入口保持禁用并说明不可用', () => {
    const mounted = mount('ylm-e1-extension-update-unavailable');
    try {
        openProfile();
        click(buttonByPage('about'));
        const update = miniDom.document.querySelector('[name="about-extension-update"]');
        assert.ok(update, '即使宿主不支持也应说明入口状态');
        assert.equal(update.disabled, true);
        assert.match(update.textContent, /当前酒馆未提供可用的扩展更新服务/u);
    } finally {
        mounted.destroy();
    }
});
test('关于页版本五连点仍解锁 SFW/NSFW 滑块（彩蛋逻辑零改动）', () => {
    const mounted = mount('ylm-e1-about-easter-egg');
    try {
        openProfile();
        click(buttonByPage('about'));
        const mark = miniDom.document.querySelector('.yl-about-mark');
        assert.ok(mark.querySelector('svg'), '关于页品牌位应换为 logo SVG');
        for (let index = 0; index < 5; index += 1) {
            click(miniDom.document.querySelector('[name="about-version-info"]'));
        }
        const modeEntry = miniDom.document.querySelector('[name="about-content-mode-entry"]');
        assert.ok(modeEntry, '五连点版本信息后应出现内容模式入口');
        click(modeEntry);
        assert.ok(miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '内容模式切换'), '滑块应可展开');
    } finally {
        mounted.destroy();
    }
});

test('设置详情与关于页返回直落「我的」，settings 目录路由已彻底删除', () => {
    const mounted = mount('ylm-e1-settings-fallback');
    try {
        openProfile();
        /* 主线收口后 PAGE_PARENT_FOR 已裁平：设置详情返回不再经过任何中间目录页 */
        click(buttonByPage('settings_connections'));
        click(backButton());
        assert.ok(miniDom.document.querySelector('.yl-page-profile'), '设置详情返回应直落「我的」页');
        assert.equal(miniDom.document.querySelector('.yl-settings-flat'), null, '兜底平铺设置页已删除');
        assert.equal(miniDom.document.querySelector('.yl-settings-catalog-grid'), null, '不得再渲染设置分类卡目录');
        click(buttonByPage('about'));
        click(backButton());
        assert.ok(miniDom.document.querySelector('.yl-page-profile'), '关于页返回应直落「我的」页');
    } finally {
        mounted.destroy();
    }
});

test('「偏好」设置页承载浏览器本地布局切换且不进 MVU', () => {
    const layoutStorage = new Map();
    const storage = {
        getItem: (key) => (layoutStorage.has(key) ? layoutStorage.get(key) : null),
        setItem: (key, value) => layoutStorage.set(key, String(value)),
        removeItem: (key) => layoutStorage.delete(key),
    };
    const mounted = mount('ylm-e1-preferences', { uiLayoutStorage: storage });
    try {
        openProfile();
        const entry = miniDom.document.querySelectorAll('.yl-hub-entry').find((node) => node.dataset.page === 'settings_preferences');
        assert.ok(entry, '设置分组应有「偏好」入口');
        click(entry);
        assert.ok(backButton(), '偏好页应有返回按钮');
        const toggle = miniDom.document.querySelectorAll('input').find((node) => node.getAttribute('aria-label') === '切换电脑端界面布局');
        assert.ok(toggle, '偏好页应提供布局切换开关');
        assert.equal(toggle.checked, false, '默认应为手机端布局');
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        assert.equal(layoutStorage.get('yuelema.ui-layout/v1'), 'desktop', '布局偏好只写入浏览器本地存储');
        const root = miniDom.document.querySelector('.yl-phone-extension');
        assert.equal(root.dataset.uiLayout, 'desktop', '切换后根节点应进入电脑端布局');
        click(backButton());
        assert.ok(miniDom.document.querySelector('.yl-page-profile'), '偏好页返回应直落「我的」页');
    } finally {
        mounted.destroy();
    }
});

// —— 2026-07-27 安全控制台接线断言：说明文案 + 收藏主动私聊失败详情 ——
test('控制台说明句改为「脱敏后可展开查看」，收藏私聊失败在控制台留下含错误码的脱敏 detail', async () => {
    const favoriteRead = () => {
        const result = readyReadResult();
        result.state.推荐.收藏角色UID = ['npc_1'];
        return result;
    };
    const mounted = mount('yl-root-console-detail', {
        readState: favoriteRead,
        actionBridge: {
            emit() {}, isPending() { return false; },
            async runMvuAction() {
                return { ok: false, status: 'rejected', code: 'npc_adult_verification_failed', reason: '成年人校验未通过：字段 成人验证' };
            },
        },
    });
    try {
        openProfile();
        click(buttonByPage('favorites'));
        const start = miniDom.document.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === '发起私聊');
        assert.ok(start, '收藏卡应有发起私聊按钮');
        click(start);
        for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));

        click(navButton('profile'));
        click(buttonByPage('settings_console'));
        const consoleText = miniDom.document.querySelector('.yl-operation-console').textContent;
        assert.match(consoleText, /失败详情经脱敏后可在条目内展开查看/u, '控制台说明句应如实描述脱敏详情能力');
        assert.match(consoleText, /密钥与隐私数值永不显示/u);
        assert.doesNotMatch(consoleText, /不显示密钥、内部标识、补丁或原始模型内容/u, '旧的说明句应被替换');

        const entryCard = miniDom.document.querySelectorAll('.yl-operation-console-entry').find((node) => node.textContent.includes('收藏主动私聊'));
        assert.ok(entryCard, '收藏私聊失败应留下控制台条目');
        assert.equal(entryCard.dataset.status, 'failure');
        const toggle = entryCard.querySelector('.yl-operation-console-detail-toggle');
        assert.ok(toggle, '失败条目应提供详情展开控件');
        const detailBlock = entryCard.querySelector('.yl-operation-console-detail');
        assert.match(detailBlock.textContent, /npc_adult_verification_failed/u, 'detail 应含具体错误码');
        assert.match(detailBlock.textContent, /成年人校验未通过：字段 成人验证/u, 'detail 应透传受控管线 reason');
        assert.doesNotMatch(detailBlock.textContent, /sk-|Bearer|阈值 \d/u, 'detail 不得包含密钥或阈值数值');
    } finally {
        mounted.destroy();
    }
});

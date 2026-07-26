import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * 设计系统 2.0 样式合同（style.css 分区单文件重写版）。
 *
 * 合同覆盖：
 * 1. 八分区 banner 存在且顺序正确（tokens → themes → base → components → shell → pages → desktop → motion）。
 * 2. var() 全文件禁止回退值（旧深色化石回退值不得回流）。
 * 3. 字号阶梯下限 .72rem，禁止 px 字号。
 * 4. 裸 hex/rgb 色只允许出现在 tokens/themes 两区。
 * 5. desktop 规则单前缀（旧 .yl-phone-panel[data-ui-layout] 第二前缀形态被消灭）。
 * 6. 玻璃 blur 恰 3 处（底部导航 / 页头 / 弹层遮罩），body.no-blur 全部可关。
 * 7. prefers-reduced-motion 与宿主 body.reduced-motion 全局降级。
 * 8. 保留旧合同中仍有效的安全/无障碍断言语义：主题令牌契约、phone/desktop 显式布局、
 *    焦点环、44px 命中、粗指针不越权、760/980 双门禁工作台、发送图标去 clip-path。
 */
const stylesheet = await readFile(new URL('../../../style.css', import.meta.url), 'utf8');

const BANNERS = ['tokens', 'themes', 'base', 'components', 'shell', 'pages', 'desktop', 'motion'];

function bannerIndex(name) {
    return stylesheet.indexOf(`/* ============ ${name} ============ */`);
}

function section(name) {
    const start = bannerIndex(name);
    assert.notEqual(start, -1, `缺少分区 banner：${name}`);
    const next = BANNERS[BANNERS.indexOf(name) + 1];
    const end = next ? bannerIndex(next) : stylesheet.length;
    return stylesheet.slice(start, end === -1 ? stylesheet.length : end);
}

function blockAfter(source, marker, startAt = 0) {
    const markerIndex = source.indexOf(marker, startAt);
    assert.notEqual(markerIndex, -1, `缺少样式契约标记：${marker}`);
    const openBraceIndex = source.indexOf('{', markerIndex + marker.length);
    assert.notEqual(openBraceIndex, -1, `样式契约缺少规则体：${marker}`);
    let depth = 0;
    for (let index = openBraceIndex; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(openBraceIndex + 1, index);
        }
    }
    assert.fail(`样式契约规则未闭合：${marker}`);
}

function balancedBlock(source, openBraceIndex, label) {
    assert.equal(source[openBraceIndex], '{', `${label} 缺少规则体`);
    let depth = 0;
    for (let index = openBraceIndex; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) return { body: source.slice(openBraceIndex + 1, index), end: index + 1 };
        }
    }
    assert.fail(`${label} 规则未闭合`);
}

function stripMediaBlocks(source) {
    let outside = source;
    let mediaIndex = outside.search(/@media/u);
    while (mediaIndex !== -1) {
        const block = balancedBlock(outside, outside.indexOf('{', mediaIndex), '媒体块');
        outside = outside.slice(0, mediaIndex) + outside.slice(block.end);
        mediaIndex = outside.search(/@media/u);
    }
    return outside;
}

function assertDeclarations(block, declarations, label) {
    for (const declaration of declarations) {
        assert.match(block, declaration, `${label} 缺少必要声明：${declaration}`);
    }
}

test('八个分区 banner 存在且顺序正确', () => {
    let previous = -1;
    for (const name of BANNERS) {
        const index = bannerIndex(name);
        assert.notEqual(index, -1, `缺少分区 banner：${name}`);
        assert.ok(index > previous, `分区顺序错误：${name} 应位于前一分区之后`);
        previous = index;
    }
});

test('var() 全文件禁止回退值', () => {
    const fallbacks = [...stylesheet.matchAll(/var\(\s*--[\w-]+\s*,/gu)];
    assert.equal(fallbacks.length, 0, `发现带回退值的 var()：${fallbacks.slice(0, 5).map((m) => m[0]).join(' | ')}`);
});

test('全部 var() 引用的令牌都有定义（无悬空令牌）', () => {
    const used = new Set([...stylesheet.matchAll(/var\(\s*(--[\w-]+)\s*\)/gu)].map((m) => m[1]));
    const defined = new Set([...stylesheet.matchAll(/(--[\w-]+)\s*:/gu)].map((m) => m[1]));
    const dangling = [...used].filter((name) => !defined.has(name));
    assert.deepEqual(dangling, [], `未定义的令牌：${dangling.join(', ')}`);
});

test('字号阶梯：无 <.72rem 字号、无 px 字号，阶梯令牌单一套', () => {
    for (const declaration of stylesheet.matchAll(/font-size\s*:\s*([^;]+);/gu)) {
        for (const rem of declaration[1].matchAll(/([\d.]+)rem/gu)) {
            assert.ok(Number(rem[1]) >= 0.72, `发现小于 .72rem 的字号：${declaration[0]}`);
        }
        assert.doesNotMatch(declaration[1], /(?<![\w.])\d+px/u, `字号必须使用 rem 阶梯：${declaration[0]}`);
    }
    const tokens = section('tokens');
    assert.match(tokens, /--yl-type-xs\s*:\s*\.72rem/u);
    assert.match(tokens, /--yl-type-caption\s*:\s*\.8rem/u);
    assert.match(tokens, /--yl-type-body\s*:\s*\.92rem/u);
    assert.match(tokens, /--yl-type-headline\s*:\s*1\.4rem/u);
    /* 旧双轨令牌不得回流 */
    assert.doesNotMatch(stylesheet, /--yl-r-(?:sm|md|lg|xl|pill)/u, '旧 --yl-r-* 圆角令牌不得回流');
    assert.doesNotMatch(stylesheet, /--yl-t-(?:fast|slow)/u, '旧 --yl-t-* 动效令牌不得回流');
    assert.doesNotMatch(stylesheet, /--yl-radius-(?:surface|hero|control)/u, '旧 --yl-radius-surface/hero/control 令牌不得回流');
});

test('裸色只允许出现在 tokens/themes 两区', () => {
    const baseStart = bannerIndex('base');
    assert.notEqual(baseStart, -1);
    const afterThemes = stylesheet.slice(baseStart);
    const bareColors = [...afterThemes.matchAll(/#[0-9a-fA-F]{3,8}\b|(?<![\w-])rgba?\(/gu)];
    assert.equal(bareColors.length, 0, `themes 之后发现裸色 ${bareColors.length} 处`);
});

test('SFW 与 NSFW 主题块各自发布完整语义令牌契约', () => {
    const themes = section('themes');
    const requiredTokens = [
        /--yl-bg\s*:/u, /--yl-surface\s*:/u, /--yl-text\s*:/u, /--yl-text-2\s*:/u,
        /--yl-border\s*:/u, /--yl-accent\s*:/u, /--yl-on-accent\s*:/u,
        /--yl-success\s*:/u, /--yl-warning\s*:/u, /--yl-danger\s*:/u, /--yl-info\s*:/u,
        /--yl-presence\s*:/u, /--yl-gold\s*:/u, /--yl-scrim\s*:/u, /--yl-focus-ring\s*:/u,
        /--yl-luxe-gold\s*:/u,
    ];
    const sfwRoot = blockAfter(themes, '.yl-phone-extension[data-content-mode="SFW"]');
    const nsfwRoot = blockAfter(themes, '.yl-phone-extension[data-content-mode="NSFW"]');
    assertDeclarations(sfwRoot, requiredTokens, 'SFW 主题块');
    assertDeclarations(nsfwRoot, requiredTokens, 'NSFW 主题块');
    assert.match(sfwRoot, /color-scheme\s*:\s*light/u, 'SFW 必须声明浅色 color-scheme');
    assert.match(nsfwRoot, /color-scheme\s*:\s*dark/u, 'NSFW 必须声明深色 color-scheme');
    /* 品牌渐变与 presence 单一定义在 tokens/themes */
    assert.match(section('tokens'), /--yl-grad\s*:\s*linear-gradient/u);
});

test('phone 与 desktop 壳层保有显式、分离的网格布局契约', () => {
    const shell = section('shell');
    const phonePanel = blockAfter(shell, '.yl-phone-extension[data-ui-layout="phone"] .yl-phone-panel');
    assertDeclarations(phonePanel, [
        /grid-template-columns\s*:/u,
        /grid-template-rows\s*:/u,
        /grid-template-areas\s*:/u,
        /"header"/u,
        /"content"/u,
        /"nav"/u,
    ], '手机端壳层');

    const desktop = section('desktop');
    const desktopPanel = blockAfter(desktop, '.yl-phone-extension[data-ui-layout="desktop"] .yl-phone-panel');
    assertDeclarations(desktopPanel, [
        /grid-template-columns\s*:/u,
        /grid-template-rows\s*:/u,
        /"header\s+header"/u,
        /"nav\s+content"/u,
    ], '电脑端壳层');
    const desktopNav = blockAfter(desktop, '.yl-phone-extension[data-ui-layout="desktop"] .yl-phone-nav');
    assertDeclarations(desktopNav, [/grid-area\s*:\s*nav\s*;/u, /grid-template-columns\s*:/u], '电脑端侧边导航');
});

test('desktop 规则单前缀：第二前缀形态被彻底消灭', () => {
    assert.doesNotMatch(stylesheet, /\.yl-phone-panel\[data-ui-layout/u, '不得再出现 .yl-phone-panel[data-ui-layout 前缀');
    /* 每一处 data-ui-layout 门禁都必须挂在扩展根上 */
    for (const match of stylesheet.matchAll(/[^\s{},]*\[data-ui-layout="(?:phone|desktop)"\]/gu)) {
        assert.match(match[0], /^\.yl-phone-extension\[data-ui-layout=/u, `布局门禁必须写在扩展根上：${match[0]}`);
    }
});

test('玻璃 blur 恰 3 处（底部导航 / 页头 / 弹层遮罩），body.no-blur 可全部关闭', () => {
    const blurs = [...stylesheet.matchAll(/(?<!-)backdrop-filter\s*:\s*blur/gu)];
    assert.equal(blurs.length, 3, `backdrop-filter blur 声明应恰为 3 处，当前 ${blurs.length}`);
    const webkitBlurs = [...stylesheet.matchAll(/-webkit-backdrop-filter\s*:\s*blur/gu)];
    assert.equal(webkitBlurs.length, 3, '-webkit-backdrop-filter blur 声明应恰为 3 处');
    assert.match(stylesheet, /\.yl-phone-nav\s*\{[^}]*backdrop-filter\s*:\s*blur/u, '底部导航必须是 blur 之一');
    assert.match(stylesheet, /\.yl-phone-page\s*>\s*\.yl-page-heading\s*\{[^}]*backdrop-filter\s*:\s*blur/u, 'sticky 页头必须是 blur 之一');
    assert.match(stylesheet, /\.yl-sheet__scrim[^{]*\{[^}]*backdrop-filter\s*:\s*blur/u, '弹层遮罩必须是 blur 之一');
    const noBlur = stylesheet.match(/body\.no-blur[\s\S]{0,600}?backdrop-filter\s*:\s*none/u);
    assert.ok(noBlur, 'body.no-blur 必须能关闭玻璃效果');
});

test('reduced-motion：系统偏好与宿主开关双通道全局降级', () => {
    const motion = section('motion');
    const osIndex = motion.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
    assert.notEqual(osIndex, -1, '缺少 prefers-reduced-motion 降级块');
    const osBlock = balancedBlock(motion, motion.indexOf('{', osIndex), 'prefers-reduced-motion');
    assertDeclarations(osBlock.body, [
        /animation-duration\s*:\s*\.01ms\s*!important/u,
        /transition-duration\s*:\s*\.01ms\s*!important/u,
        /scroll-behavior\s*:\s*auto\s*!important/u,
    ], '系统 reduced-motion');
    const hostBlock = blockAfter(motion, 'body.reduced-motion .yl-phone-extension *');
    assertDeclarations(hostBlock, [
        /animation-duration\s*:\s*\.01ms\s*!important/u,
        /transition-duration\s*:\s*\.01ms\s*!important/u,
    ], '宿主 reduced-motion');
});

test('焦点环与 44px 命中：全站统一品牌焦点、图标钮共享命中令牌', () => {
    const base = section('base');
    const focusRule = blockAfter(base, ':focus-visible');
    assertDeclarations(focusRule, [
        /outline\s*:\s*2px solid var\(--yl-accent\)/u,
        /outline-offset\s*:/u,
    ], '统一焦点环');
    assert.match(section('tokens'), /--yl-icon-hit\s*:\s*44px/u, '缺少 44px 命中令牌');
    const iconFamily = blockAfter(section('components'), '.yl-phone-close, .yl-page-back, .yl-dialog-close, .yl-ui-layout-toggle');
    assertDeclarations(iconFamily, [
        /min-width\s*:\s*var\(--yl-icon-hit\)/u,
        /min-height\s*:\s*var\(--yl-icon-hit\)/u,
    ], '图标钮命中家族');
});

test('粗指针增强不得替换显式 desktop 布局', () => {
    const shell = section('shell');
    const coarseIndex = shell.search(/@media\s*\(max-width:\s*640px\),\s*\(pointer:\s*coarse\)/u);
    assert.notEqual(coarseIndex, -1, '缺少粗指针媒体块');
    const coarse = balancedBlock(shell, shell.indexOf('{', coarseIndex), '粗指针媒体块');
    assert.match(coarse.body, /\[data-ui-layout="phone"\] \.yl-phone-panel/u, '手机几何必须显式归属 phone 布局');
    assert.doesNotMatch(coarse.body, /(?:^|\n)\s*\.yl-phone-panel\s*\{/u, '粗指针规则不得直接覆盖所有面板');
    assert.doesNotMatch(coarse.body, /data-ui-layout="desktop"/u, '粗指针规则不得为 desktop 注入手机几何');
});

test('设计系统 2.0 组件合同：Button/ListRow/Seg/Sheet/Empty/Skeleton/Badge 全部施样', () => {
    const components = section('components');
    const primary = blockAfter(components, '.yl-btn--primary');
    assertDeclarations(primary, [/min-height\s*:\s*48px/u, /background\s*:\s*var\(--yl-grad\)/u], '主按钮');
    const iconButton = blockAfter(components, '.yl-btn--icon');
    assertDeclarations(iconButton, [/width\s*:\s*var\(--yl-icon-hit\)/u], 'icon 按钮 44 热区');
    for (const marker of ['.yl-btn--tonal', '.yl-btn--ghost', '.yl-btn--danger', '.yl-row', '.yl-row__meta',
        '.yl-badge', '.yl-chip--status', '.yl-seg__item', '.yl-sheet__panel', '.yl-sheet__scrim',
        '.yl-empty__art', '.yl-skeleton__line', '.yl-skeleton__avatar']) {
        assert.ok(components.includes(marker), `components 分区缺少 ${marker}`);
    }
    const badge = blockAfter(components, '.yl-badge');
    assert.match(badge, /background\s*:\s*var\(--yl-grad\)/u, '未读徽章必须使用品牌渐变');
    /* BottomSheet：phone 吸底为缺省，desktop 居中 Dialog 由单前缀门禁提供 */
    const sheetPanel = blockAfter(components, '.yl-sheet__panel');
    assert.match(sheetPanel, /bottom\s*:\s*0/u, 'sheet 缺省（phone）形态必须吸底');
    const desktopSheet = blockAfter(section('desktop'), '.yl-phone-extension[data-ui-layout="desktop"] .yl-sheet__panel');
    assert.match(desktopSheet, /max-width|width\s*:\s*min\(/u, 'desktop sheet 必须收敛为居中 Dialog 宽度');
    assert.match(desktopSheet, /translate\(50%,\s*50%\)/u, 'desktop sheet 必须居中');
});

test('SVG 发送图标保持权威渲染：无 clip-path、旧 ::before 图形停用', () => {
    assert.match(stylesheet, /\.yl-chat-send-icon\s*\{[^}]*\}/u);
    const iconRule = stylesheet.match(/\.yl-chat-send-icon\s*\{([^}]*)\}/u);
    assert.doesNotMatch(iconRule[1], /clip-path/u, 'SVG 发送图标不得依赖 clip-path');
    assert.match(stylesheet, /\.yl-chat-send-icon::before\s*\{[^}]*content\s*:\s*none/u, '旧 ::before 图形必须停用');
});

test('760px + 显式 desktop 双门禁：全部工作台多栏几何都在门禁之内', () => {
    const desktop = section('desktop');
    const gateIndex = desktop.search(/@media\s*\(min-width:\s*760px\)\s*\{/u);
    assert.notEqual(gateIndex, -1, '缺少 min-width: 760px 双门禁媒体查询');
    const gate = balancedBlock(desktop, desktop.indexOf('{', gateIndex), '760px 双门禁');
    /* 消息 master-detail */
    assert.match(gate.body, /\.yl-message-list-page\.yl-message-list-workbench[\s\S]{0,600}?grid-template-areas/u, '消息双栏必须在门禁内');
    for (const area of ['intro', 'search', 'status', 'list']) {
        assert.match(gate.body, new RegExp(`["\\s]${area}["\\s]`, 'u'), `消息双栏缺少 ${area} 区`);
    }
    /* 发现 媒体+档案、匹配 工具+已牵手 */
    assert.match(gate.body, /"media\s+dossier"/u, '发现页 desktop 必须排为媒体+档案两区');
    assert.match(gate.body, /"tools\s+history"/u, '匹配页 desktop 必须排为工具+已牵手两区');
    /* 社区 / 我的 / 设置目录（含行合同回归锁） */
    for (const marker of ['.yl-community-hub', '.yl-profile-dashboard', '.yl-settings-catalog-grid', '.yl-private-chat-workbench', '.yl-group-chat-room']) {
        assert.match(gate.body, new RegExp(`\\.yl-phone-extension\\[data-ui-layout="desktop"\\][^{]*${marker.replace(/\./gu, '\\.')}[^{]*\\{[^}]*grid-template-columns`, 'u'), `${marker} 的多栏几何必须位于 760px 双门禁之内`);
    }
    assert.match(gate.body, /\.yl-profile-dashboard[\s\S]{0,420}?grid-template-rows\s*:\s*auto 1fr/u, '我的工作台必须声明 auto 1fr 行合同');
    assert.match(gate.body, /\.yl-profile-dashboard-grid[\s\S]{0,600}?repeat\(auto-fit,\s*minmax\(236px,\s*1fr\)\)/u, '我的页目录必须自适应列宽');
    /* 私聊上下文栏 / 群名册：默认隐藏、门禁内展开且有独立滚动边界 */
    assert.match(section('pages'), /\.yl-chat-context-panel\s*\{[^}]*display\s*:\s*none/u, '上下文栏在门禁外不得占位');
    assert.match(gate.body, /\.yl-chat-context-panel[\s\S]{0,700}?max-height\s*:/u, '上下文栏必须有独立滚动边界');
    assert.match(gate.body, /\.yl-local-participant-strip[\s\S]{0,700}?flex-direction\s*:\s*column/u, '群成员条在 desktop 应转为纵向名册');
    /* 角色创作两栏 + 图片工作台 */
    assert.match(gate.body, /"form\s+preview"/u, '创作两栏必须由 form 与 preview 区组成');
    assert.match(gate.body, /"form\s+workspace"/u, '模板资料箱必须堆叠在预览列之下');
    assert.match(gate.body, /\.yl-character-editor[\s\S]{0,560}?grid-template-rows\s*:\s*auto auto 1fr/u, '创作工作台必须声明 1fr 行合同');
    assert.match(gate.body, /"side\s+grid"/u, '图片工作台必须形成侧栏+素材网格两区');
    assert.match(gate.body, /\.yl-image-manager-side[\s\S]{0,560}?position\s*:\s*sticky/u, '图片侧栏必须 sticky');
    assert.match(section('pages'), /\.yl-character-step-rail,\s*\.yl-character-preview\s*\{\s*display\s*:\s*none/u, '步骤 rail 与预览默认不占位');
});

test('980px 三栏档：rail 成为唯一步骤表达，页宽仅创作页放宽', () => {
    const desktop = section('desktop');
    const wideIndex = desktop.search(/@media\s*\(min-width:\s*980px\)\s*\{/u);
    assert.notEqual(wideIndex, -1, '缺少 980px 三栏门禁');
    const wide = balancedBlock(desktop, desktop.indexOf('{', wideIndex), '980px 门禁');
    assert.match(wide.body, /"rail\s+form\s+preview"/u, '980px 档必须形成 rail、form、preview 三栏');
    assert.match(wide.body, /\.yl-character-step-rail[\s\S]*?grid-area\s*:\s*rail/u, '步骤导航必须映射到 rail 区');
    assert.match(wide.body, /\.yl-character-journey[\s\S]*?display\s*:\s*none/u, '三栏档下静态 journey 必须让位给 rail');
    assert.match(wide.body, /\.yl-page-character_creator[\s\S]*?width\s*:\s*min\(100%,\s*1040px\)/u, '页宽放宽只允许发生在创作页');
});

test('双门禁之外不得残留裸 desktop 多栏几何', () => {
    const desktop = section('desktop');
    const outside = stripMediaBlocks(desktop);
    for (const className of ['.yl-message-list-workbench', '.yl-discovery-workbench', '.yl-community-hub',
        '.yl-profile-dashboard', '.yl-settings-catalog-grid', '.yl-private-chat-workbench', '.yl-group-chat-room',
        '.yl-character-editor', '.yl-character-step-rail', '.yl-character-preview', '.yl-image-manager']) {
        const escaped = className.replace(/\./gu, '\\.');
        const bare = new RegExp('\\[data-ui-layout="desktop"\\][^@{]*' + escaped + '[^{]*\\{[^}]*grid-template-columns\\s*:', 'u');
        assert.doesNotMatch(outside, bare, `${className} 不得在媒体门禁之外声明多栏几何`);
    }
});

test('素材网格自适应与图片死规则不回流', () => {
    assert.match(stylesheet, /\.yl-image-manager-grid\s*\{[^}]*repeat\(auto-fill,\s*minmax\(148px,\s*1fr\)\)/u, '素材网格必须使用自适应列宽');
    assert.doesNotMatch(stylesheet, /\.yl-image-manager-url-group|\.yl-image-manager-toolbar|\.yl-image-manager-weight-row/u, '阶段 66 前的图片死规则不得回流');
});

test('壳层 SVG 换装与旧字符图标清理', () => {
    assert.match(stylesheet, /\.yl-launcher-logo-svg/u, '悬浮球 logo SVG 必须有样式挂点');
    assert.match(stylesheet, /\.yl-drag-grip-svg/u, '拖动柄 grip SVG 必须有样式挂点');
    assert.doesNotMatch(stylesheet, /content\s*:\s*"[×⋮⠿›♥✧◌]"/u, 'CSS content 不得再渲染字符图标');
});

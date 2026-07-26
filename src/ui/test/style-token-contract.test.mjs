import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stylesheet = await readFile(new URL('../../../style.css', import.meta.url), 'utf8');

function blockAfter(marker, startAt = 0) {
    const markerIndex = stylesheet.indexOf(marker, startAt);
    assert.notEqual(markerIndex, -1, `缺少样式契约标记：${marker}`);

    const openBraceIndex = stylesheet.indexOf('{', markerIndex + marker.length);
    assert.notEqual(openBraceIndex, -1, `样式契约缺少规则体：${marker}`);

    let depth = 0;
    for (let index = openBraceIndex; index < stylesheet.length; index += 1) {
        if (stylesheet[index] === '{') depth += 1;
        if (stylesheet[index] === '}') {
            depth -= 1;
            if (depth === 0) return stylesheet.slice(openBraceIndex + 1, index);
        }
    }

    assert.fail(`样式契约规则未闭合：${marker}`);
}

function selectorPreludeAfter(marker, startAt = 0) {
    const markerIndex = stylesheet.indexOf(marker, startAt);
    assert.notEqual(markerIndex, -1, `缺少样式契约选择器：${marker}`);

    const openBraceIndex = stylesheet.indexOf('{', markerIndex + marker.length);
    assert.notEqual(openBraceIndex, -1, `样式选择器缺少规则体：${marker}`);
    return stylesheet.slice(markerIndex, openBraceIndex);
}

function assertDeclarations(block, declarations, label) {
    for (const declaration of declarations) {
        assert.match(block, declaration, `${label} 缺少必要声明：${declaration}`);
    }
}

test('SFW and NSFW roots each publish the semantic surface-token contract', () => {
    const requiredTokens = [
        /--yl-bg\s*:/u,
        /--yl-bg-elev\s*:/u,
        /--yl-surface\s*:/u,
        /--yl-text\s*:/u,
        /--yl-muted\s*:/u,
        /--yl-border\s*:/u,
        /--yl-accent\s*:/u,
        /--yl-grad\s*:/u,
        /--yl-panel-atmosphere\s*:/u,
        /--yl-surface-app\s*:/u,
        /--yl-surface-control\s*:/u,
        /--yl-text-primary\s*:/u,
        /--yl-control-foreground\s*:/u,
        /--yl-on-accent\s*:/u,
        /--yl-focus-color\s*:/u,
        /--yl-focus-ring\s*:/u,
        /--yl-disabled-opacity\s*:/u,
    ];

    const sfwRoot = blockAfter('.yl-phone-extension[data-content-mode="SFW"]');
    const nsfwRoot = blockAfter('.yl-phone-extension[data-content-mode="NSFW"]');

    assertDeclarations(sfwRoot, requiredTokens, 'SFW 根令牌块');
    assertDeclarations(nsfwRoot, requiredTokens, 'NSFW 根令牌块');
});

test('phone and desktop shells retain explicit, separate grid-layout contracts', () => {
    const phase61 = stylesheet.indexOf('Phase 61');
    assert.notEqual(phase61, -1, '缺少 Phase 61 布局标记');
    const phonePanel = blockAfter('.yl-phone-extension[data-ui-layout="phone"] .yl-phone-panel', phase61);
    const desktopPanel = blockAfter('.yl-phone-extension[data-ui-layout="desktop"] .yl-phone-panel', phase61);
    const desktopNavigation = blockAfter('.yl-phone-extension[data-ui-layout="desktop"] .yl-phone-nav', phase61);

    assertDeclarations(phonePanel, [
        /grid-template-columns\s*:/u,
        /grid-template-rows\s*:/u,
        /grid-template-areas\s*:/u,
        /"header"/u,
        /"content"/u,
        /"nav"/u,
    ], '手机端壳层');
    assertDeclarations(desktopPanel, [
        /grid-template-columns\s*:/u,
        /grid-template-rows\s*:/u,
        /grid-template-areas\s*:/u,
        /"header\s+header"/u,
        /"nav\s+content"/u,
    ], '电脑端壳层');
    assertDeclarations(desktopNavigation, [
        /grid-area\s*:\s*nav\s*;/u,
        /grid-template-columns\s*:/u,
    ], '电脑端侧边导航');
});

test('modern shell controls expose a visible keyboard focus treatment', () => {
    const focusMarker = '.yl-phone-extension :is(.yl-ui-layout-toggle, .yl-phone-close, .yl-page-back, .yl-private-chat-more';
    const focusRule = blockAfter(focusMarker);
    const focusSelectors = selectorPreludeAfter(focusMarker);

    for (const selector of [
        '.yl-ui-layout-toggle',
        '.yl-phone-close',
        '.yl-page-back',
        '.yl-private-chat-more',
        '.yl-chat-more-button',
        '.yl-group-more-button',
    ]) {
        assert.ok(focusSelectors.includes(selector), `焦点规则应覆盖 ${selector}`);
    }
    assertDeclarations(focusRule, [
        /outline\s*:\s*[^;]+;/u,
        /outline-offset\s*:/u,
    ], '紧凑控制焦点规则');
});

test('motion-reduction contract disables animation and transition for host and OS preferences', () => {
    const hostReducedMotion = blockAfter('body.reduced-motion .yl-phone-extension *, body.reduced-motion .yl-phone-extension *::before');
    const osReducedMotion = blockAfter('@media (prefers-reduced-motion: reduce)');

    assertDeclarations(hostReducedMotion, [
        /animation\s*:\s*none\s*!important\s*;/u,
        /transition\s*:\s*none\s*!important\s*;/u,
    ], '宿主 reduced-motion 规则');
    assertDeclarations(osReducedMotion, [
        /animation\s*:\s*none\s*!important\s*;/u,
        /transition\s*:\s*none\s*!important\s*;/u,
    ], '系统 reduced-motion 规则');
});

test('icon controls are backed by the shared 44px minimum hit-target token', () => {
    const extensionTokens = blockAfter('.yl-phone-extension', stylesheet.indexOf('Phase 61'));
    const layoutToggle = blockAfter('.yl-ui-layout-toggle');
    const sharedIconMarker = '.yl-phone-close,\n.yl-page-back,\n.yl-ui-layout-toggle,\n.yl-private-chat-more';
    const sharedIconTargets = blockAfter(sharedIconMarker);
    const sharedIconSelectors = selectorPreludeAfter(sharedIconMarker);

    assertDeclarations(extensionTokens, [
        /--yl-icon-hit-size\s*:\s*44px\s*;/u,
    ], '图标命中尺寸令牌');
    assertDeclarations(layoutToggle, [
        /min-width\s*:\s*var\(--yl-icon-hit-size\)\s*;/u,
        /min-height\s*:\s*var\(--yl-icon-hit-size\)\s*;/u,
    ], '设备布局切换器');
    for (const selector of ['.yl-phone-close', '.yl-page-back', '.yl-ui-layout-toggle', '.yl-private-chat-more', '.yl-chat-more-button', '.yl-group-more-button']) {
        assert.ok(sharedIconSelectors.includes(selector), `44px 图标命中规则应覆盖 ${selector}`);
    }
    assertDeclarations(sharedIconTargets, [
        /min-width\s*:\s*var\(--yl-icon-hit-size\)\s*;/u,
        /min-height\s*:\s*var\(--yl-icon-hit-size\)\s*;/u,
    ], '共享图标控件');
});





test('primary button selector excludes secondary and ghost variants before cascade resolution', () => {
    const phase62 = stylesheet.indexOf('Phase 62');
    assert.notEqual(phase62, -1, '缺少 Phase 62 组件语言标记');
    const primarySelector = selectorPreludeAfter(':where(.yl-settings-button):not(.yl-settings-button-secondary, .yl-button-ghost, .yl-button-danger)', phase62);
    const primaryRule = blockAfter(':where(.yl-settings-button):not(.yl-settings-button-secondary, .yl-button-ghost, .yl-button-danger)', phase62);

    assert.match(primarySelector, /yl-settings-button-secondary/u);
    assert.match(primarySelector, /yl-button-ghost/u);
    assert.match(primarySelector, /yl-button-danger/u);
    assertDeclarations(primaryRule, [/color\s*:\s*var\(--yl-on-accent\)\s*;/u], '主按钮前景');
    assert.match(stylesheet, /\.yl-settings-button\.yl-settings-button-secondary[\s\S]{0,420}background\s*:\s*var\(--yl-surface-control\)\s*;/u, 'secondary 应拥有显式表面变体');
});

test('coarse-pointer enhancements do not replace an explicit desktop layout', () => {
    const coarseMedia = blockAfter('@media (max-width: 640px), (pointer: coarse)');

    assert.match(coarseMedia, /\[data-ui-layout="phone"\] \.yl-phone-panel/u, '手机几何必须显式归属 phone 布局');
    assert.doesNotMatch(coarseMedia, /(?:^|\n)\s*\.yl-phone-panel\s*\{/u, '粗指针规则不得直接覆盖所有面板');
    assert.doesNotMatch(coarseMedia, /data-ui-layout="desktop"/u, '粗指针规则不得为 desktop 注入手机几何');
});

test('theme-neutral focus and compact-control primitives avoid fixed white foregrounds', () => {
    const focusRule = blockAfter('.yl-phone-extension :is(.yl-ui-layout-toggle, .yl-phone-close, .yl-page-back, .yl-private-chat-more');
    const featureOptions = blockAfter('.yl-feature-options');

    assertDeclarations(focusRule, [/outline\s*:\s*2px solid var\(--yl-focus-color\)\s*;/u], '紧凑控件焦点');
    assertDeclarations(featureOptions, [
        /color\s*:\s*var\(--yl-control-foreground/u,
        /background\s*:\s*var\(--yl-surface-control/u,
    ], '功能设置控件');
});

function phaseSection(phaseLabel) {
    const phaseIndex = stylesheet.indexOf(phaseLabel);
    assert.notEqual(phaseIndex, -1, `缺少 ${phaseLabel} 样式阶段标记`);

    const nextPhaseMatch = /Phase\s+\d+/gu;
    nextPhaseMatch.lastIndex = phaseIndex + phaseLabel.length;
    const nextPhase = nextPhaseMatch.exec(stylesheet);
    return stylesheet.slice(phaseIndex, nextPhase?.index ?? stylesheet.length);
}

function balancedBlock(source, openBraceIndex, label) {
    assert.equal(source[openBraceIndex], '{', `${label} 缺少规则体`);

    let depth = 0;
    for (let index = openBraceIndex; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) {
                return {
                    body: source.slice(openBraceIndex + 1, index),
                    end: index + 1,
                };
            }
        }
    }

    assert.fail(`${label} 规则未闭合`);
}

function findWideDesktopMessageMedia(source) {
    let cursor = 0;
    while (cursor < source.length) {
        const mediaIndex = source.indexOf('@media', cursor);
        if (mediaIndex === -1) break;

        const openBraceIndex = source.indexOf('{', mediaIndex);
        assert.notEqual(openBraceIndex, -1, 'Phase 63 media query 缺少规则体');
        const prelude = source.slice(mediaIndex, openBraceIndex);
        const block = balancedBlock(source, openBraceIndex, 'Phase 63 media query');
        const minWidthMatch = prelude.match(/\(\s*min-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/u);

        if (
            minWidthMatch
            && block.body.includes('[data-ui-layout="desktop"]')
            && block.body.includes('.yl-message-list-page')
        ) {
            return {
                body: block.body,
                minWidth: Number(minWidthMatch[1]),
                prelude,
            };
        }
        cursor = block.end;
    }

    assert.fail('Phase 63 缺少以 min-width 门控的 desktop 消息布局 media query');
}

function flatRules(source) {
    const rules = [];
    const rulePattern = /([^{}]+)\{([^{}]*)\}/gu;
    for (const match of source.matchAll(rulePattern)) {
        const selector = match[1].replace(/\/\*[\s\S]*?\*\//gu, '').trim();
        if (selector && !selector.startsWith('@')) {
            rules.push({ selector, body: match[2] });
        }
    }
    return rules;
}

function selectorContainsClass(selector, className) {
    const escaped = className.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`${escaped}(?![\\w-])`, 'u').test(selector);
}

function ruleForClass(rules, className, label) {
    const rule = rules.find(({ selector }) => selectorContainsClass(selector, className));
    assert.ok(rule, `${label} 缺少 ${className} 样式规则`);
    return rule;
}

test('Phase 63 gates the desktop message workbench behind an adequate minimum width', () => {
    const phase63 = phaseSection('Phase 63');
    const desktopMedia = findWideDesktopMessageMedia(phase63);
    const rules = flatRules(desktopMedia.body);
    const messageLayout = rules.find(({ selector, body }) => (
        selectorContainsClass(selector, '.yl-message-list-page')
        && selector.includes('[data-ui-layout="desktop"]')
        && /grid-template-areas\s*:/u.test(body)
    ));

    assert.ok(messageLayout, '宽屏消息布局必须由 desktop data-ui-layout 选择器显式门控');
    assert.ok(desktopMedia.minWidth >= 720, `desktop 双栏消息布局最小宽度不得低于 720px，当前为 ${desktopMedia.minWidth}px`);

    const selectorArms = messageLayout.selector.split(',').map((selector) => selector.trim());
    for (const selector of selectorArms.filter((selector) => selectorContainsClass(selector, '.yl-message-list-page'))) {
        assert.match(selector, /\[data-ui-layout="desktop"\]/u, '消息双栏的每个选择器分支都必须显式归属 desktop 布局');
    }
    assert.doesNotMatch(messageLayout.selector, /\[data-ui-layout="phone"\]/u, '消息双栏不得覆盖 phone 布局');

    const areaContract = messageLayout.body.match(/grid-template-areas\s*:\s*([^;]+);/u)?.[1] ?? '';
    for (const area of ['intro', 'search', 'status', 'list']) {
        assert.match(areaContract, new RegExp(`(?:^|\\s|\")${area}(?:$|\\s|\")`, 'u'), `消息双栏缺少 ${area} grid area`);
    }

    for (const [className, area] of [
        ['.yl-message-list-intro', 'intro'],
        ['.yl-message-search', 'search'],
        ['.yl-message-search-status', 'status'],
        ['.yl-chat-session-list', 'list'],
    ]) {
        const rule = ruleForClass(rules, className, `消息 ${area} 区域`);
        assert.match(rule.body, new RegExp(`grid-area\\s*:\\s*${area}\\s*;`, 'u'), `${className} 必须映射到 ${area} grid area`);
    }
});

test('Phase 63 makes the SVG send icon authoritative without a clipped pseudo-element plane', () => {
    const phase63 = phaseSection('Phase 63');
    const rules = flatRules(phase63);
    const iconRule = ruleForClass(rules, '.yl-chat-send-icon', 'SVG 发送图标');
    const pseudoRule = rules.find(({ selector }) => /\.yl-chat-send-icon::before(?![\w-])/u.test(selector));

    assert.match(iconRule.body, /display\s*:\s*block\s*;/u, 'SVG 发送图标应作为块级图标渲染');
    assert.doesNotMatch(iconRule.body, /clip-path\s*:/u, 'SVG 图标本体不得依赖 clip-path 绘制');
    assert.ok(pseudoRule, 'Phase 63 应显式停用旧的 .yl-chat-send-icon::before 图形');
    assert.match(pseudoRule.body, /content\s*:\s*(?:none|["']{2})\s*;/u, '旧的 ::before 图形必须通过 content 停用');
    assert.doesNotMatch(pseudoRule.body, /clip-path\s*:/u, 'Phase 63 的 ::before 覆盖不得继续使用 clip-path');
});

test('Phase 63 send-button disabled state is expressed with semantic tokens', () => {
    const phase63 = phaseSection('Phase 63');
    const rules = flatRules(phase63);
    const disabledRule = rules.find(({ selector }) => /\.yl-chat-send-button:disabled(?![\w-])/u.test(selector));

    assert.ok(disabledRule, 'Phase 63 缺少 .yl-chat-send-button:disabled 规则');
    assert.match(disabledRule.body, /color\s*:\s*var\(--yl-control-foreground-disabled(?:\s*,[^)]*)?\)\s*;/u, '发送禁用态前景必须使用 disabled 语义令牌');
    assert.match(disabledRule.body, /background(?:-color)?\s*:\s*var\(--yl-surface-control(?:\s*,[^)]*)?\)\s*;/u, '发送禁用态表面必须使用 control 语义令牌');
    assert.doesNotMatch(disabledRule.body, /(?:^|[\s:])#[0-9a-f]{3,8}\b/iu, '发送禁用态不得回退到固定十六进制颜色');
});

test('Phase 64 keeps discovery as a phone encounter card and gates the desktop dossier behind an explicit wide layout', () => {
    const phase64 = phaseSection('Phase 64');
    const phoneRules = flatRules(phase64);
    const workbench = ruleForClass(phoneRules, '.yl-discovery-workbench', '发现工作台');
    assert.match(workbench.body, /grid-template-areas\s*:/u, 'phone 发现工作台必须显式定义阅读区');
    assert.match(workbench.body, /"media"/u, 'phone 发现工作台必须包含媒体区');
    assert.match(workbench.body, /"dossier"/u, 'phone 发现工作台必须包含档案区');

    const actions = ruleForClass(phoneRules, '.yl-candidate-dossier .yl-candidate-actions', '候选操作轨');
    assert.match(actions.body, /grid-template-columns\s*:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/u, '四个候选动作必须保持稳定的四格拇指操作区');

    const desktopMedia = findWideDesktopDiscoveryMedia(phase64);
    assert.ok(desktopMedia.minWidth >= 760, `desktop 候选档案最小宽度不得低于 760px，当前为 ${desktopMedia.minWidth}px`);
    const desktopRules = flatRules(desktopMedia.body);
    const desktopWorkbench = desktopRules.find(({ selector, body }) => (
        selectorContainsClass(selector, '.yl-discovery-workbench')
        && selector.includes('[data-ui-layout="desktop"]')
        && /grid-template-areas\s*:/u.test(body)
    ));
    assert.ok(desktopWorkbench, 'desktop 档案布局必须由显式 data-ui-layout 门控');
    assert.match(desktopWorkbench.body, /"media\s+dossier"/u, 'desktop 必须将同一公开候选排为媒体和档案两区');
    assert.doesNotMatch(desktopWorkbench.selector, /\[data-ui-layout="phone"\]/u, 'phone 不得误入双栏候选布局');
});


test('Phase 64 closes typography, disabled-icon, matching-surface, and narrow-desktop contracts', () => {
    const phase62 = phaseSection('Phase 62');
    assert.match(phase62, /--yl-font-utility\s*:\s*var\(--yl-font-display\)\s*;/u, '档案 utility 字体令牌必须在组件语言层声明');
    for (const token of ['caption', 'label', 'body']) {
        assert.match(phase62, new RegExp('--yl-type-' + token + '\\s*:\\s*[^;]+;', 'u'), '缺少排版令牌 --yl-type-' + token);
    }

    const phase64 = phaseSection('Phase 64');
    const rules = flatRules(phase64);
    const disabledIcon = rules.find(({ selector }) => selector.includes('.yl-action-circle:disabled .yl-action-icon'));
    assert.ok(disabledIcon, '候选动作禁用色必须直接落到 SVG 图标');
    assert.match(disabledIcon.body, /color\s*:\s*var\(--yl-control-foreground-disabled\)\s*;/u);

    const soul = ruleForClass(rules, '.yl-match-tools .yl-soul-match-card', '灵魂匹配现代化表面');
    assert.match(soul.body, /var\(--yl-surface-raised\)|var\(--yl-accent-soft\)/u, '灵魂匹配应使用语义表面和强调色');
    assert.doesNotMatch(soul.body, /#[0-9a-f]{3,8}\b/iu, 'Phase 64 灵魂匹配不得继续依赖固定青蓝色');
    assert.match(phase64, /grid-template-areas\s*:\s*"tools history"/u, 'desktop 匹配页必须形成工具区和已牵手结果区');

    const narrowDesktop = phase64.match(/@media\s*\(min-width:\s*760px\)\s*and\s*\(max-height:\s*720px\)\s*\{[\s\S]*?\.yl-phone-extension\[data-ui-layout="desktop"\][\s\S]*?overflow\s*:\s*(?:hidden|auto)\s*;/u);
    assert.ok(narrowDesktop, '窄高 desktop 必须以同等显式布局门禁覆盖候选工作台');
    assert.match(phase64, /\.yl-phone-extension\[data-ui-layout="desktop"\][^{}]*\.yl-candidate-dossier,[\s\S]*?overflow\s*:\s*auto\s*;/u, '窄高 desktop 档案区必须可独立滚动');
});

function findWideDesktopDiscoveryMedia(source) {
    let cursor = 0;
    while (cursor < source.length) {
        const mediaIndex = source.indexOf('@media', cursor);
        if (mediaIndex === -1) break;
        const openBraceIndex = source.indexOf('{', mediaIndex);
        assert.notEqual(openBraceIndex, -1, 'Phase 64 media query 缺少规则体');
        const prelude = source.slice(mediaIndex, openBraceIndex);
        const block = balancedBlock(source, openBraceIndex, 'Phase 64 media query');
        const minWidthMatch = prelude.match(/\(\s*min-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/u);
        if (minWidthMatch && block.body.includes('[data-ui-layout="desktop"]') && block.body.includes('.yl-discovery-workbench')) {
            return { body: block.body, minWidth: Number(minWidthMatch[1]) };
        }
        cursor = block.end;
    }
    assert.fail('Phase 64 缺少以 min-width 门控的 desktop 发现布局 media query');
}

test('Phase 65 keeps media feedback stable, semantic, actionable, and motion-safe', () => {
    const phase65 = phaseSection('Phase 65');
    const rules = flatRules(phase65);
    const feedback = ruleForClass(rules, '.yl-candidate-media-feedback', '候选媒体状态卡');
    assert.match(feedback.body, /grid-template-columns\s*:\s*minmax\(0,\s*1fr\)\s+auto/u, '状态卡应将说明与可选动作分列');
    assert.match(feedback.body, /min-height\s*:\s*var\(--yl-icon-hit-size\)/u, '状态卡必须保持稳定触控高度');
    assert.doesNotMatch(feedback.body, /#[0-9a-f]{3,8}\b/iu, '状态卡不得新造固定颜色主题');

    const errorRule = rules.find(({ selector }) => selector.includes('.yl-candidate-media-feedback[data-media-state="error"]'));
    assert.ok(errorRule, '媒体错误态必须有独立语义表面');
    assert.match(errorRule.body, /var\(--yl-danger\)/u, '媒体错误态必须使用 danger 语义令牌');

    const retry = ruleForClass(rules, '.yl-candidate-media-feedback-retry', '媒体重试按钮');
    assert.match(retry.body, /min-height\s*:\s*var\(--yl-icon-hit-size\)/u, '媒体重试按钮必须保持可触控高度');

    assert.match(phase65, /\.yl-candidate-background-slot\[data-image-status="loading"\]::after[\s\S]*animation\s*:\s*yl-public-media-signal/u, '加载态应使用单一信号扫描动效');
    assert.match(phase65, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*yl-candidate-background-slot\[data-image-status="loading"\]::after[\s\S]*animation\s*:\s*none/u, '系统 reduced-motion 必须停用信号扫描');
});
function assertPixelMinimum(block, property, minimum, label) {
    const declaration = block.split(';')
        .map((value) => value.trim())
        .find((value) => value.startsWith(`${property}:`) || value.startsWith(`${property} :`));
    assert.ok(declaration, `${label} 缺少像素尺寸声明 ${property}`);
    const match = declaration.match(/:\s*(\d+(?:\.\d+)?)px\s*$/u);
    assert.ok(match, `${label} 的 ${property} 必须使用可验证的 px 尺寸`);
    assert.ok(Number(match[1]) >= minimum, `${label} 的 ${property} 不得低于 ${minimum}px`);
}

test('Phase 67 keeps hub hit targets at least 44px and exposes the three workbench families', () => {
    const phase67 = phaseSection('阶段 67');
    const rules = flatRules(phase67);
    const hubEntryRules = rules.filter(({ selector, body }) => (
        selectorContainsClass(selector, '.yl-hub-entry')
        && /min-height\s*:/u.test(body)
    ));

    assert.ok(hubEntryRules.length >= 2, 'hub 入口的基础与窄屏规则都应声明稳定命中高度');
    for (const [index, rule] of hubEntryRules.entries()) {
        assertPixelMinimum(rule.body, 'min-height', 44, `hub 入口命中规则 ${index + 1}`);
    }

    const hubEntry = ruleForClass(rules, '.yl-hub-entry', '通用工作台入口');
    assert.match(hubEntry.body, /display\s*:\s*grid\s*;/u, '工作台入口应保持图标、文案、状态轨三段布局');
    assert.match(hubEntry.body, /grid-template-columns\s*:\s*auto\s+minmax\(0,\s*1fr\)\s+auto\s*;/u);

    const community = ruleForClass(rules, '.yl-community-hub', '社区工作台');
    const profile = ruleForClass(rules, '.yl-profile-dashboard', '我的关系资产工作台');
    const settings = ruleForClass(rules, '.yl-settings-catalog', '设置目录工作台');
    assert.match(community.body, /gap\s*:/u);
    assert.match(profile.body, /gap\s*:/u);
    assert.match(settings.body, /gap\s*:/u);
    ruleForClass(rules, '.yl-community-choices', '社区入口组');
    ruleForClass(rules, '.yl-profile-dashboard-grid', '个人任务入口组');
    ruleForClass(rules, '.yl-settings-catalog-grid', '设置任务目录');
});

test('Phase 67 relationship signal and entry status tracks stay readable without becoming layout content', () => {
    const rules = flatRules(phaseSection('阶段 67'));
    const relationshipSignal = ruleForClass(rules, '.yl-relationship-signal', '关系信号轨');
    const signalLine = ruleForClass(rules, '.yl-signal-line', '关系信号线');
    const profileSignal = ruleForClass(rules, '.yl-profile-signal', '个人资产信号轨');
    const entryTrail = ruleForClass(rules, '.yl-hub-entry-trail', '入口状态轨');
    const entryMeta = ruleForClass(rules, '.yl-hub-entry-meta', '入口状态短标签');

    assertDeclarations(relationshipSignal.body, [
        /display\s*:\s*flex\s*;/u,
        /flex-wrap\s*:\s*wrap\s*;/u,
        /align-items\s*:\s*center\s*;/u,
    ], '关系信号轨');
    assertPixelMinimum(signalLine.body, 'width', 1, '关系信号线');
    assertPixelMinimum(signalLine.body, 'height', 1, '关系信号线');
    assert.match(signalLine.body, /linear-gradient\([^;]*var\(--yl-accent[^;]*var\(--yl-violet/u, '关系信号线应使用既有语义强调色');
    assert.match(profileSignal.body, /grid-column\s*:\s*1\s*\/\s*-1\s*;/u, '个人资产信号轨应跨越身份卡列');

    assertDeclarations(entryTrail.body, [
        /display\s*:\s*inline-flex\s*;/u,
        /justify-content\s*:\s*flex-end\s*;/u,
        /min-width\s*:\s*0\s*;/u,
    ], '入口状态轨');
    assertDeclarations(entryMeta.body, [
        /max-width\s*:/u,
        /overflow\s*:\s*hidden\s*;/u,
        /text-overflow\s*:\s*ellipsis\s*;/u,
        /white-space\s*:\s*nowrap\s*;/u,
    ], '入口状态短标签');
});

test('Phase 67 desktop workbenches are explicitly gated and hub motion respects reduced-motion', () => {
    const phase67 = phaseSection('阶段 67');
    const rules = flatRules(phase67);

    for (const [className, label] of [
        ['.yl-community-hub', '社区工作台'],
        ['.yl-profile-dashboard', '我的工作台'],
        ['.yl-settings-catalog-grid', '设置工作台'],
    ]) {
        const desktopRule = rules.find(({ selector, body }) => (
            selectorContainsClass(selector, className)
            && selector.includes('[data-ui-layout="desktop"]')
            && /grid-template-columns\s*:/u.test(body)
        ));
        assert.ok(desktopRule, `${label} 缺少显式 desktop 网格规则`);
        const relevantArms = desktopRule.selector
            .split(',')
            .map((selector) => selector.trim())
            .filter((selector) => selectorContainsClass(selector, className));
        assert.ok(relevantArms.length >= 2, `${label} 应同时覆盖扩展根与面板布局宿主`);
        assert.ok(relevantArms.some((selector) => selector.includes('.yl-phone-extension')));
        assert.ok(relevantArms.some((selector) => selector.includes('.yl-phone-panel')));
        for (const selector of relevantArms) {
            assert.match(selector, /\[data-ui-layout="desktop"\]/u, `${label} 的每个选择器分支都必须显式归属 desktop`);
            assert.doesNotMatch(selector, /\[data-ui-layout="phone"\]/u, `${label} 不得覆盖 phone 布局`);
        }
    }

    const mediaIndex = phase67.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
    assert.notEqual(mediaIndex, -1, 'Phase 67 缺少系统 reduced-motion 降级');
    const openBraceIndex = phase67.indexOf('{', mediaIndex);
    const reducedMotion = balancedBlock(phase67, openBraceIndex, 'Phase 67 reduced-motion');
    const reducedRules = flatRules(reducedMotion.body);
    const hubEntry = ruleForClass(reducedRules, '.yl-hub-entry', 'reduced-motion 工作台入口');
    assert.match(hubEntry.body, /transition\s*:\s*none\s*;/u, 'reduced-motion 下工作台入口不得保留过渡');
});

test('Phase 67 desktop workbenches sit behind the 760px + explicit desktop dual gate', () => {
    const phase67 = phaseSection('阶段 67');
    const mediaMatch = phase67.match(/@media\s*\(min-width:\s*760px\)\s*\{/u);
    assert.ok(mediaMatch, '阶段 67 缺少 min-width: 760px 门禁媒体查询');
    const media = balancedBlock(phase67, phase67.indexOf('{', mediaMatch.index), '阶段 67 双门禁');
    for (const [className, label] of [
        ['.yl-community-hub', '社区工作台'],
        ['.yl-profile-dashboard', '我的工作台'],
        ['.yl-settings-catalog-grid', '设置工作台'],
    ]) {
        const escaped = className.replace(/\./gu, '\\.');
        const gated = new RegExp('\\[data-ui-layout="desktop"\\][^\\{]*' + escaped + '[^\\{]*\\{[^\\}]*grid-template-columns', 'u');
        assert.match(media.body, gated, `${label} 的多栏规则必须位于 760px 双门禁之内`);
    }
    // 双门禁之外不得再残留同名的裸 desktop 多栏规则（防止窄视口被强制两栏）。
    let outside = phase67;
    let mediaIndex = outside.search(/@media/u);
    while (mediaIndex !== -1) {
        const block = balancedBlock(outside, outside.indexOf('{', mediaIndex), '阶段 67 媒体块');
        outside = outside.slice(0, mediaIndex) + outside.slice(block.end);
        mediaIndex = outside.search(/@media/u);
    }
    for (const className of ['.yl-community-hub', '.yl-profile-dashboard', '.yl-settings-catalog-grid']) {
        const escaped = className.replace(/\./gu, '\\.');
        const bare = new RegExp('\\[data-ui-layout="desktop"\\][^@\\{]*' + escaped + '[^\\{]*\\{[^\\}]*grid-template-columns\\s*:', 'u');
        assert.doesNotMatch(outside, bare, `${className} 不得在媒体门禁之外声明多栏几何`);
    }
    // 我的页行合同：row2 = 1fr 吸收右列跨行余量，防止数据卡被顶到页面中部（真机反馈缺陷回归锁）。
    assert.match(media.body, /\.yl-profile-dashboard[\s\S]{0,420}?grid-template-rows\s*:\s*auto 1fr/u, '我的工作台必须声明 auto 1fr 行合同');
    // 右列目录按可用宽度自适应两列流，宽组跨列且有明确的自适应列。
    assert.match(media.body, /\.yl-profile-dashboard-grid[\s\S]{0,420}?repeat\(auto-fit,\s*minmax\(236px,\s*1fr\)\)/u, '我的页目录必须自适应列宽');
    assert.match(phase67, /\.yl-profile-section-relationships[\s\S]*?grid-column\s*:\s*1\s*\/\s*-1/u);
    assert.match(phase67, /\.yl-profile-section-diagnostics[\s\S]*?\.yl-hub-section-list[\s\S]*?repeat\(auto-fit,\s*minmax\(220px,\s*1fr\)\)/u);
});

test('Phase 68 conversation context rails sit behind the 760px + explicit desktop dual gate', () => {
    const phase68 = phaseSection('Phase 68');
    const baseRules = flatRules(phase68);
    const contextPanel = ruleForClass(baseRules, '.yl-chat-context-panel', '私聊上下文栏默认态');
    assert.match(contextPanel.body, /display\s*:\s*none\s*;/u, '上下文栏在门禁外不得占位');

    const mediaMatch = phase68.match(/@media\s*\(min-width:\s*760px\)\s*\{/u);
    assert.ok(mediaMatch, 'Phase 68 缺少 min-width: 760px 门禁媒体查询');
    const media = balancedBlock(phase68, phase68.indexOf('{', mediaMatch.index), 'Phase 68 双门禁');
    const rules = flatRules(media.body);
    for (const [className, label] of [
        ['.yl-private-chat-workbench', '私聊工作台'],
        ['.yl-group-chat-room', '群房间工作台'],
    ]) {
        const desktopRule = rules.find(({ selector, body }) => (
            selectorContainsClass(selector, className)
            && selector.includes('[data-ui-layout="desktop"]')
            && /grid-template-columns\s*:/u.test(body)
        ));
        assert.ok(desktopRule, `${label} 缺少显式 desktop 双栏规则`);
        const arms = desktopRule.selector.split(',').map((selector) => selector.trim()).filter((selector) => selectorContainsClass(selector, className));
        assert.ok(arms.some((selector) => selector.includes('.yl-phone-extension')), `${label} 应覆盖扩展根布局宿主`);
        assert.ok(arms.some((selector) => selector.includes('.yl-phone-panel')), `${label} 应覆盖面板布局宿主`);
        for (const selector of arms) {
            assert.match(selector, /\[data-ui-layout="desktop"\]/u, `${label} 的每个选择器分支都必须显式归属 desktop`);
            assert.doesNotMatch(selector, /\[data-ui-layout="phone"\]/u, `${label} 不得覆盖 phone 布局`);
        }
    }
    assert.match(media.body, /\.yl-group-chat-room\s*>\s*\.yl-local-participant-strip[\s\S]*?flex-direction\s*:\s*column/u, '群成员条在 desktop 应转为纵向名册');
    assert.match(media.body, /\.yl-group-chat-room\s*>\s*\.yl-local-participant-strip[\s\S]*?max-height\s*:/u, '群成员名册必须有独立滚动边界');
    assert.match(media.body, /\.yl-chat-context-panel[\s\S]*?max-height\s*:/u, '私聊上下文栏必须有独立滚动边界');

    // 双门禁之外不得残留同名的裸 desktop 多栏规则。
    let outside = phase68;
    let mediaIndex = outside.search(/@media/u);
    while (mediaIndex !== -1) {
        const block = balancedBlock(outside, outside.indexOf('{', mediaIndex), 'Phase 68 媒体块');
        outside = outside.slice(0, mediaIndex) + outside.slice(block.end);
        mediaIndex = outside.search(/@media/u);
    }
    for (const className of ['.yl-private-chat-workbench', '.yl-group-chat-room', '.yl-chat-context-panel']) {
        const escaped = className.replace(/\./gu, '\\.');
        const bare = new RegExp('\\[data-ui-layout="desktop"\\][^@\\{]*' + escaped + '[^\\{]*\\{[^\\}]*grid-template-columns\\s*:', 'u');
        assert.doesNotMatch(outside, bare, `${className} 不得在媒体门禁之外声明多栏几何`);
    }
});

test('Phase 70 creator and image workbenches sit behind explicit desktop gates', () => {
    const phase70 = phaseSection('Phase 70');
    const baseRules = flatRules(phase70);
    const resident = baseRules.find(({ selector }) => (
        selectorContainsClass(selector, '.yl-character-step-rail')
        && selectorContainsClass(selector, '.yl-character-preview')
    ));
    assert.ok(resident, '步骤导航与公开预览必须有共同的默认隐藏规则');
    assert.match(resident.body, /display\s*:\s*none\s*;/u, '常驻构件在门禁外不得占位');

    const mediaMatch = phase70.match(/@media\s*\(min-width:\s*760px\)\s*\{/u);
    assert.ok(mediaMatch, 'Phase 70 缺少 min-width: 760px 门禁媒体查询');
    const media = balancedBlock(phase70, phase70.indexOf('{', mediaMatch.index), 'Phase 70 双门禁');
    const rules = flatRules(media.body);
    for (const [className, label] of [
        ['.yl-character-editor', '角色创作工作台'],
        ['.yl-image-manager', '图片素材工作台'],
    ]) {
        const desktopRule = rules.find(({ selector, body }) => (
            selectorContainsClass(selector, className)
            && selector.includes('[data-ui-layout="desktop"]')
            && /grid-template-columns\s*:/u.test(body)
        ));
        assert.ok(desktopRule, `${label} 缺少显式 desktop 多栏规则`);
        const arms = desktopRule.selector.split(',').map((selector) => selector.trim()).filter((selector) => selectorContainsClass(selector, className));
        assert.ok(arms.some((selector) => selector.includes('.yl-phone-extension')), `${label} 应覆盖扩展根布局宿主`);
        assert.ok(arms.some((selector) => selector.includes('.yl-phone-panel')), `${label} 应覆盖面板布局宿主`);
        for (const selector of arms) {
            assert.match(selector, /\[data-ui-layout="desktop"\]/u, `${label} 的每个选择器分支都必须显式归属 desktop`);
            assert.doesNotMatch(selector, /\[data-ui-layout="phone"\]/u, `${label} 不得覆盖 phone 布局`);
        }
    }
    assert.match(media.body, /"form\s+preview"/u, '创作两栏必须由 form 与 preview 区组成');
    assert.match(media.body, /"form\s+workspace"/u, '模板资料箱必须堆叠在预览列之下以平衡两列高度');
    assert.match(media.body, /\.yl-character-editor[\s\S]{0,560}?grid-template-rows\s*:\s*auto auto 1fr/u, '创作工作台必须声明 1fr 行合同吸收表单跨行余量');
    assert.match(media.body, /\.yl-character-preview[\s\S]*?max-height\s*:/u, '公开预览列必须有独立滚动边界');
    assert.match(media.body, /"side\s+grid"/u, '图片工作台必须形成整卡侧栏与素材网格两区');
    assert.match(media.body, /\.yl-image-manager-side[\s\S]{0,560}?position\s*:\s*sticky/u, '图片侧栏必须 sticky 保持导入入口可达');

    const wideMatch = phase70.match(/@media\s*\(min-width:\s*980px\)\s*\{/u);
    assert.ok(wideMatch, 'Phase 70 缺少 980px 三栏增强门槛');
    const wide = balancedBlock(phase70, phase70.indexOf('{', wideMatch.index), 'Phase 70 三栏门禁');
    assert.match(wide.body, /"rail\s+form\s+preview"/u, '980px 档必须形成 rail、form、preview 三栏');
    assert.match(wide.body, /\.yl-character-step-rail[\s\S]*?grid-area\s*:\s*rail/u, '步骤导航必须映射到 rail 区');
    assert.match(wide.body, /\.yl-character-journey[\s\S]*?display\s*:\s*none/u, '三栏档下静态 journey 必须让位给 rail');
    assert.match(wide.body, /\.yl-page-character_creator[\s\S]*?width\s*:\s*min\(100%,\s*1040px\)/u, '页宽放宽只允许发生在创作页');

    let outside = phase70;
    let mediaIndex = outside.search(/@media/u);
    while (mediaIndex !== -1) {
        const block = balancedBlock(outside, outside.indexOf('{', mediaIndex), 'Phase 70 媒体块');
        outside = outside.slice(0, mediaIndex) + outside.slice(block.end);
        mediaIndex = outside.search(/@media/u);
    }
    for (const className of ['.yl-character-editor', '.yl-character-step-rail', '.yl-character-preview', '.yl-image-manager']) {
        const escaped = className.replace(/\./gu, '\\.');
        const bare = new RegExp('\\[data-ui-layout="desktop"\\][^@\\{]*' + escaped + '[^\\{]*\\{[^\\}]*grid-template-columns\\s*:', 'u');
        assert.doesNotMatch(outside, bare, `${className} 不得在媒体门禁之外声明多栏几何`);
    }

    assert.match(stylesheet, /\.yl-image-manager-grid\s*\{[^}]*repeat\(auto-fill,\s*minmax\(148px,\s*1fr\)\)/u, '素材网格必须使用自适应列宽');
    assert.doesNotMatch(stylesheet, /\.yl-image-manager-url-group|\.yl-image-manager-toolbar|\.yl-image-manager-weight-row/u, '阶段 66 前的图片死规则不得回流');
});

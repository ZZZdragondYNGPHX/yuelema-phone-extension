import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from '../../test-support/minidom.mjs';

const miniDom = installMiniDom();
const { buildCharacterCreatorPanel } = await import('../character-creator-panel.js');

test.after(() => miniDom.restore());

function adultCandidate() {
    return {
        成人验证: true,
        公开资料: {
            昵称: 'AI 草稿角色', 头像引用: 'https://model.example/never-used.webp', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '上海', 距离范围: '10 km', 寻找意图: '先聊天再约会', 简介: '由模型补全的成年人资料。',
            兴趣标签: ['电影'], 生活方式标签: ['夜猫子'], 性格标签: ['直接'], 沟通风格标签: ['慢热'],
        },
        仅好友资料: { 关系状态: '单身', 边界与偏好: '尊重明确拒绝。' },
        隐藏资料: { 实际年龄: 28, 私人备注: '新候选自己的私密设定。' },
        偏好与边界: '先确认边界。', 拒绝阈值: 35, 已读不回阈值: 55, 取消匹配阈值: 75, 拉黑阈值: 90,
        与玩家关系: { 状态: '陌生', 全局账号表现: 68, NPC专属匹配度: 72, 好感: 0, 信任: 0, 戒备: 20, 面基意愿: 0, 友情值: 0, 心动值: 0, 欲望值: 0 },
    };
}

function createHarness({ completion } = {}) {
    const feedback = [];
    const writes = { register: 0, controlledPatch: 0, parse: 0, replace: 0, event: 0 };
    const completionRequests = [];
    const actionBridge = {
        async generateCharacterCompletionDraft(request) {
            completionRequests.push(structuredClone(request));
            return completion?.(request) ?? { ok: true, candidate: adultCandidate() };
        },
        async generateCharacterAuthoringDraft() {
            throw new Error('此回归只覆盖 AI 补全入口。');
        },
        async registerCharacter() { writes.register += 1; return { ok: true }; },
        async applyControlledPatch() { writes.controlledPatch += 1; },
        mvu: {
            parseMessage() { writes.parse += 1; },
            replaceMvuData() { writes.replace += 1; },
        },
        async emitVariableUpdate() { writes.event += 1; },
    };
    const panel = buildCharacterCreatorPanel({
        documentRef: miniDom.document,
        actionBridge,
        characterLibrary: { list: () => [] },
        signal: new AbortController().signal,
        onFeedback: (message) => feedback.push(message),
        onRegistered: () => { writes.register += 100; },
    });
    return { panel, feedback, writes, completionRequests };
}

function control(panel, name) {
    const found = panel.querySelector(`[name="${name}"]`);
    assert.ok(found, `应存在表单控件：${name}`);
    return found;
}

function completionButton(panel) {
    const found = panel.querySelectorAll('button').find((button) => button.textContent === 'AI 完善补全到草稿');
    assert.ok(found, '应存在 AI 补全按钮');
    return found;
}

function fillExistingDraft(panel) {
    const publicValues = {
        昵称: '原始公开昵称', 年龄段: '25-29', 性别: '女', 性取向: '双性恋', 城市: '北京', 距离范围: '5 km', 寻找意图: '先聊天', 简介: '原始公开简介',
    };
    for (const [key, value] of Object.entries(publicValues)) control(panel, `public-${key}`).value = value;
    control(panel, 'tag-兴趣标签').value = '原始兴趣, 咖啡';
    control(panel, 'friend-关系状态').value = 'friend-secret-must-not-leak';
    control(panel, 'friend-边界与偏好').value = 'friend-boundary-secret-must-not-leak';
    control(panel, 'hidden-age').value = '30';
    control(panel, 'hidden-note').value = 'hidden-note-must-not-leak';
    control(panel, 'boundary').value = 'private-boundary-must-not-leak';
    control(panel, 'avatar-kind').value = 'embedded';
    control(panel, 'ai-completion-instruction').value = '补全为明确成年的都市约会资料。';
}

function buttonByText(panel, text) {
    const found = panel.querySelectorAll('button').find((button) => button.textContent === text);
    assert.ok(found, `应存在按钮：${text}`);
    return found;
}

async function flushUi() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
}

function assertNoWrite(writes) {
    assert.deepEqual(writes, { register: 0, controlledPatch: 0, parse: 0, replace: 0, event: 0 });
}

test('AI 补全和完整创作各有独立的预设选项入口', () => {
    const features = [];
    const panel = buildCharacterCreatorPanel({
        documentRef: miniDom.document,
        actionBridge: { async registerCharacter() { return { ok: true }; } },
        characterLibrary: { list: () => [] },
        signal: new AbortController().signal,
        onFeedback() {},
        onConfigureFeature: (feature) => features.push(feature),
    });
    const buttons = panel.querySelectorAll('button');
    const completion = buttons.find((button) => button.getAttribute('aria-label') === '配置 AI 补全预设');
    const authoring = buttons.find((button) => button.getAttribute('aria-label') === '配置 AI 完整创作预设');
    assert.ok(completion);
    assert.ok(authoring);
    completion.dispatchEvent(new Event('click'));
    authoring.dispatchEvent(new Event('click'));
    assert.deepEqual(features, [
        { key: 'character_ai_completion', title: 'AI 补全' },
        { key: 'character_full_authoring', title: 'AI 完整创作' },
    ]);
});

test('successful registration hands the allocated uid and embedded avatar to browser-local persistence', async () => {
    const registered = [];
    const template = {
        format: 'yuelema.character/v1',
        character: { ...adultCandidate(), 公开资料: { ...adultCandidate().公开资料, 头像引用: '本地头像' } },
        avatar: { kind: 'embedded', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    };
    const panel = buildCharacterCreatorPanel({
        documentRef: miniDom.document,
        actionBridge: { async registerCharacter() { return { ok: true, npcUid: 'npc_custom_13' }; } },
        characterLibrary: { list: () => [], importTemplate() {} },
        signal: new AbortController().signal,
        onFeedback() {},
        onRegistered: async (value) => { registered.push(value); },
    });
    control(panel, 'character-template-json').value = JSON.stringify(template);
    buttonByText(panel, '校验并载入到编辑器').dispatchEvent(new Event('click'));
    panel.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flushUi();
    assert.deepEqual(registered, [{
        npcUid: 'npc_custom_13',
        avatar: { kind: 'embedded', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    }]);
});
test('头像来源只提供占位与本地压缩两种入口，不再存在 URL 头像表单', () => {
    const { panel } = createHarness();
    assert.equal(panel.querySelector('[name="avatar-url"]'), null, 'URL 头像输入框已按新合同移除');
    const kinds = control(panel, 'avatar-kind').querySelectorAll('option').map((option) => option.value);
    assert.deepEqual(kinds, ['placeholder', 'embedded'], '头像来源只允许 placeholder 与 embedded');
});

test('AI 补全成功只增量填空和补标签：已有资料与头像保留且不会登记或写 MVU', async () => {
    const { panel, feedback, writes, completionRequests } = createHarness();
    fillExistingDraft(panel);

    completionButton(panel).dispatchEvent(new Event('click'));
    await flushUi();

    assert.equal(completionRequests.length, 1);
    const request = completionRequests[0];
    assert.equal(request.instruction, '补全为明确成年的都市约会资料。');
    assert.equal(request.publicProfile.昵称, '原始公开昵称');
    assert.equal(request.publicProfile.头像引用, '');
    const serializedRequest = JSON.stringify(request);
    for (const forbidden of [
        'friend-secret-must-not-leak', 'friend-boundary-secret-must-not-leak',
        'hidden-note-must-not-leak', 'private-boundary-must-not-leak', 'data:image',
    ]) assert.equal(serializedRequest.includes(forbidden), false, `补全请求不得包含：${forbidden}`);

    assert.equal(control(panel, 'public-昵称').value, '原始公开昵称');
    assert.equal(control(panel, 'public-城市').value, '北京');
    assert.equal(control(panel, 'tag-兴趣标签').value, '原始兴趣, 咖啡, 电影');
    assert.equal(control(panel, 'tag-生活方式标签').value, '夜猫子');
    assert.equal(control(panel, 'friend-关系状态').value, 'friend-secret-must-not-leak');
    assert.equal(control(panel, 'hidden-age').value, '30');
    assert.equal(control(panel, 'hidden-note').value, 'hidden-note-must-not-leak');
    assert.equal(control(panel, 'boundary').value, 'private-boundary-must-not-leak');
    assert.equal(control(panel, 'avatar-kind').value, 'embedded');
    assert.equal(feedback.at(-1), 'AI 已增量补全草稿；原有内容与头像已保留，请检查后再登记。');
    assertNoWrite(writes);
});

test('AI 补全模型失败时保持原始表单草稿与头像来源选择，且不会写 MVU', async () => {
    const { panel, feedback, writes, completionRequests } = createHarness({
        completion: async () => { throw new Error('Authorization Bearer private-key-must-not-leak'); },
    });
    fillExistingDraft(panel);
    const before = {
        name: control(panel, 'public-昵称').value,
        friend: control(panel, 'friend-关系状态').value,
        hidden: control(panel, 'hidden-note').value,
        avatarKind: control(panel, 'avatar-kind').value,
    };
    assert.equal(before.avatarKind, 'embedded');

    completionButton(panel).dispatchEvent(new Event('click'));
    await flushUi();

    assert.equal(completionRequests.length, 1);
    assert.equal(control(panel, 'public-昵称').value, before.name);
    assert.equal(control(panel, 'friend-关系状态').value, before.friend);
    assert.equal(control(panel, 'hidden-note').value, before.hidden);
    assert.equal(control(panel, 'avatar-kind').value, before.avatarKind);
    assert.equal(feedback.at(-1), 'AI 角色创作未完成；当前草稿未改变。');
    assert.equal(JSON.stringify(feedback).includes('private-key-must-not-leak'), false);
    assertNoWrite(writes);
});

test('本地模板库 UI 接线支持保存草稿、单模板导入和整库导入导出，且不登记角色', () => {
    const calls = { save: [], importTemplate: [], importLibrary: [], exportLibrary: [], register: 0 };
    const exportedWithAvatar = '{"format":"yuelema.character-library/v2","avatar":true}';
    const exportedTextOnly = '{"format":"yuelema.character-library/v2","avatar":false}';
    const characterLibrary = {
        list: () => [],
        saveTemplate(input) { calls.save.push(structuredClone(input)); return { id: 'local_1' }; },
        importTemplateJson(value) { calls.importTemplate.push(value); return { id: 'local_2' }; },
        importLibraryJson(value, options) { calls.importLibrary.push([value, structuredClone(options)]); return { importedCount: 2 }; },
        exportLibraryJson(options) {
            calls.exportLibrary.push(structuredClone(options));
            return options.includeAvatar ? exportedWithAvatar : exportedTextOnly;
        },
    };
    const panel = buildCharacterCreatorPanel({
        documentRef: miniDom.document,
        actionBridge: {
            async registerCharacter() { calls.register += 1; return { ok: true }; },
        },
        characterLibrary,
        signal: new AbortController().signal,
        onFeedback() {},
    });
    const candidate = adultCandidate();
    for (const [key, value] of Object.entries(candidate.公开资料)) {
        if (Array.isArray(value)) control(panel, `tag-${key}`).value = value.join(', ');
        else if (key !== '头像引用') control(panel, `public-${key}`).value = value;
    }
    control(panel, 'friend-关系状态').value = candidate.仅好友资料.关系状态;
    control(panel, 'friend-边界与偏好').value = candidate.仅好友资料.边界与偏好;
    control(panel, 'hidden-age').value = String(candidate.隐藏资料.实际年龄);
    control(panel, 'hidden-note').value = candidate.隐藏资料.私人备注;
    control(panel, 'boundary').value = candidate.偏好与边界;
    for (const key of ['拒绝阈值', '已读不回阈值', '取消匹配阈值', '拉黑阈值']) {
        control(panel, `threshold-${key}`).value = String(candidate[key]);
    }

    buttonByText(panel, '只保存当前草稿到本地模板库').dispatchEvent(new Event('click'));
    assert.equal(calls.save.length, 1);
    assert.equal(calls.save[0].template.character.公开资料.昵称, 'AI 草稿角色');
    assert.deepEqual(
        {
            友情值: calls.save[0].template.character.与玩家关系.友情值,
            心动值: calls.save[0].template.character.与玩家关系.心动值,
            欲望值: calls.save[0].template.character.与玩家关系.欲望值,
        },
        { 友情值: 0, 心动值: 0, 欲望值: 0 },
    );
    assert.equal(calls.register, 0, '只保存草稿不得登记角色或写 MVU');

    const templateText = control(panel, 'character-template-json');
    const singleJson = JSON.stringify({ format: 'yuelema.character/v1', character: candidate, avatar: { kind: 'placeholder' } });
    templateText.value = singleJson;
    buttonByText(panel, '导入单个模板到本地库').dispatchEvent(new Event('click'));
    assert.deepEqual(calls.importTemplate, [singleJson]);

    const libraryJson = '{"format":"yuelema.character-library/v2","templates":[]}';
    templateText.value = libraryJson;
    buttonByText(panel, '合并导入整个模板库').dispatchEvent(new Event('click'));
    assert.deepEqual(calls.importLibrary, [[libraryJson, { mode: 'merge' }]]);

    buttonByText(panel, '导出整个库（含头像）').dispatchEvent(new Event('click'));
    assert.equal(templateText.value, exportedWithAvatar);
    buttonByText(panel, '导出整个库（不含头像）').dispatchEvent(new Event('click'));
    assert.equal(templateText.value, exportedTextOnly);
    assert.deepEqual(calls.exportLibrary, [{ includeAvatar: true }, { includeAvatar: false }]);
    assert.equal(calls.register, 0);
});

test('步骤导航 rail：四个按钮指向真实分段 id，点击后单选高亮', () => {
    const { panel } = createHarness();
    const rail = panel.querySelector('.yl-character-step-rail');
    assert.ok(rail, '应存在步骤导航 rail');
    assert.equal(rail.tagName, 'NAV');
    assert.equal(rail.getAttribute('aria-label'), '创建角色步骤导航');

    const buttons = rail.querySelectorAll('.yl-character-step-link');
    assert.equal(buttons.length, 4, 'rail 应有 4 个步骤按钮');
    const expected = [
        ['01', '心动名片', 'yl-character-section-public'],
        ['02', '形象与灵感', 'yl-character-section-avatar'],
        ['03', '边界与节奏', 'yl-character-section-private'],
        ['04', '确认登记', 'yl-character-section-submit'],
    ];
    const sectionIds = new Set(
        [...panel.querySelectorAll('section'), ...panel.querySelectorAll('footer')]
            .map((node) => node.getAttribute('id'))
            .filter(Boolean),
    );
    expected.forEach(([number, label, targetId], index) => {
        const button = buttons[index];
        assert.equal(button.getAttribute('type'), 'button');
        assert.equal(button.querySelector('.yl-character-step-number').textContent, number);
        assert.equal(button.querySelector('.yl-character-step-label').textContent, label);
        assert.equal(button.getAttribute('data-step-target'), targetId);
        assert.ok(sectionIds.has(targetId), `data-step-target 指向的分段应存在：${targetId}`);
    });

    assert.ok(buttons[0].classList.contains('is-active'), '默认第一项应处于激活态');
    assert.equal(buttons[0].getAttribute('aria-current'), 'step');

    buttons[2].dispatchEvent(new Event('click'));
    buttons.forEach((button, index) => {
        assert.equal(button.classList.contains('is-active'), index === 2, `按钮 ${index} 的 is-active 状态`);
        assert.equal(button.getAttribute('aria-current') === 'step', index === 2, `按钮 ${index} 的 aria-current 状态`);
    });
});

function sectionById(panel, id) {
    const found = [...panel.querySelectorAll('section'), ...panel.querySelectorAll('footer')]
        .find((node) => node.getAttribute('id') === id);
    assert.ok(found, `应存在分段：${id}`);
    return found;
}

test('journey 条是真锚点：四个按钮指向真实分段，点击滚动并同步高亮 journey 与 rail', () => {
    const { panel } = createHarness();
    const journey = panel.querySelector('.yl-character-journey');
    assert.ok(journey, '应存在 journey 锚点条');
    assert.equal(journey.tagName, 'NAV');
    const journeyButtons = journey.querySelectorAll('.yl-character-journey-item');
    assert.equal(journeyButtons.length, 4, 'journey 应有 4 个步骤按钮');
    const expectedTargets = [
        'yl-character-section-public', 'yl-character-section-avatar',
        'yl-character-section-private', 'yl-character-section-submit',
    ];
    journeyButtons.forEach((button, index) => {
        assert.equal(button.tagName, 'BUTTON', 'journey 项必须是可点击按钮而非装饰 div');
        assert.equal(button.getAttribute('type'), 'button');
        assert.equal(button.getAttribute('data-step-target'), expectedTargets[index]);
        sectionById(panel, expectedTargets[index]);
    });
    assert.ok(journeyButtons[0].classList.contains('is-active'), '默认第一步高亮');
    assert.equal(journeyButtons[0].getAttribute('aria-current'), 'step');

    const privateSection = sectionById(panel, 'yl-character-section-private');
    const scrollCalls = [];
    privateSection.scrollIntoView = (options) => scrollCalls.push(options);
    journeyButtons[2].dispatchEvent(new Event('click'));

    assert.equal(scrollCalls.length, 1, '点击 journey 锚点应滚动到对应分段');
    assert.equal(scrollCalls[0].block, 'start');
    const railButtons = panel.querySelector('.yl-character-step-rail').querySelectorAll('.yl-character-step-link');
    journeyButtons.forEach((button, index) => {
        assert.equal(button.classList.contains('is-active'), index === 2, `journey 按钮 ${index} 高亮状态`);
        assert.equal(button.getAttribute('aria-current') === 'step', index === 2);
    });
    railButtons.forEach((button, index) => {
        assert.equal(button.classList.contains('is-active'), index === 2, `rail 按钮 ${index} 应与 journey 同步高亮`);
    });
});

test('步骤卡可折叠：折叠钮切换 hidden 与 aria-expanded，锚点跳转与必填校验会自动展开', () => {
    const { panel } = createHarness();
    const publicSection = sectionById(panel, 'yl-character-section-public');
    const toggle = publicSection.querySelector('.yl-character-card-toggle');
    const body = publicSection.querySelector('.yl-character-card-body');
    assert.ok(toggle, '步骤卡应有折叠钮');
    assert.ok(body, '步骤卡正文应包在 card-body 中');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(body.hidden, false);
    assert.ok(body.querySelector('[name="public-昵称"]'), '表单控件应位于可折叠正文内');

    toggle.dispatchEvent(new Event('click'));
    assert.equal(publicSection.classList.contains('is-collapsed'), true);
    assert.equal(body.hidden, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.ok(toggle.getAttribute('aria-label').startsWith('展开'), '折叠后 aria-label 应变为展开');

    toggle.dispatchEvent(new Event('click'));
    assert.equal(publicSection.classList.contains('is-collapsed'), false);
    assert.equal(body.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');

    // journey 锚点点击自动展开折叠中的目标卡
    toggle.dispatchEvent(new Event('click'));
    assert.equal(body.hidden, true);
    const journeyButtons = panel.querySelector('.yl-character-journey').querySelectorAll('.yl-character-journey-item');
    journeyButtons[0].dispatchEvent(new Event('click'));
    assert.equal(body.hidden, false, '锚点跳转应自动展开目标步骤卡');
    assert.equal(publicSection.classList.contains('is-collapsed'), false);

    // 原生必填校验（invalid 事件）命中折叠卡内控件时也自动展开
    toggle.dispatchEvent(new Event('click'));
    assert.equal(body.hidden, true);
    control(panel, 'public-昵称').dispatchEvent(new Event('invalid'));
    assert.equal(body.hidden, false, 'invalid 校验应展开包含控件的折叠卡');

    // 每张步骤卡（含提交页外的 5 张）都可折叠；提交 footer 不折叠
    for (const id of ['yl-character-section-public', 'yl-character-section-avatar', 'yl-character-section-ai', 'yl-character-section-private', 'yl-character-section-thresholds']) {
        assert.ok(sectionById(panel, id).querySelector('.yl-character-card-toggle'), `${id} 应可折叠`);
    }
    assert.equal(sectionById(panel, 'yl-character-section-submit').querySelector('.yl-character-card-toggle'), null, '提交分段不应折叠');
});

test('装饰性英文标语全部换为中文 eyebrow（含「我的角色衣橱」）', () => {
    const { panel } = createHarness();
    const text = panel.textContent;
    assert.ok(text.includes('我的角色衣橱'), '模板库 eyebrow 应为「我的角色衣橱」');
    assert.ok(text.includes('实时预览'), '预览 eyebrow 应为中文');
    for (const slogan of [
        'CREATE A NEW CONNECTION', 'PUBLIC PROFILE', 'PROFILE PHOTO', 'CREATIVE ASSISTANT',
        'PRIVATE & BOUNDARIES', 'INTERACTION RHYTHM', 'LIVE PREVIEW', 'YOUR CHARACTER CLOSET',
        'IMPORT / EXPORT', 'LOCAL DRAFTS',
    ]) assert.equal(text.includes(slogan), false, `不得再出现英文装饰标语：${slogan}`);
});

test('关系反应阈值分组带人设推导语义、拉黑心理底线与生成下限说明', () => {
    const { panel } = createHarness();
    const descriptions = panel.querySelectorAll('.yl-character-field-group-description').map((node) => node.textContent).join('\n');
    assert.match(descriptions, /数值越高越难触发对应反应/u);
    assert.match(descriptions, /拉黑阈值不低于 60 且高于已读不回阈值/u);
    const hints = panel.querySelectorAll('.yl-character-field-hint').map((node) => node.textContent).join('\n');
    assert.match(hints, /彻底断联的心理底线/u);
    assert.match(hints, /至少高 20/u);
});

test('公开名片预览随公开字段更新，且绝不包含私密值', () => {
    const { panel } = createHarness();
    fillExistingDraft(panel);
    control(panel, 'threshold-拒绝阈值').value = '37';
    control(panel, 'public-昵称').dispatchEvent(new Event('input'));

    const preview = panel.querySelector('.yl-character-preview');
    assert.ok(preview, '应存在公开名片预览');
    const card = preview.querySelector('.yl-character-preview-card');
    assert.ok(card);
    assert.equal(card.querySelector('.yl-character-preview-name').textContent, '原始公开昵称');
    assert.equal(card.querySelector('.yl-character-preview-meta').textContent, '25-29 · 北京 · 5 km');
    assert.equal(card.querySelector('.yl-character-preview-intent').textContent, '想找：先聊天');
    assert.equal(card.querySelector('.yl-character-preview-bio').textContent, '原始公开简介');
    const tags = card.querySelectorAll('.yl-character-preview-tag').map((tag) => tag.textContent);
    assert.deepEqual(tags, ['原始兴趣', '咖啡']);

    const previewText = preview.textContent;
    for (const forbidden of [
        'friend-secret-must-not-leak', 'friend-boundary-secret-must-not-leak',
        'hidden-note-must-not-leak', 'private-boundary-must-not-leak', '37',
    ]) assert.equal(previewText.includes(forbidden), false, `预览不得包含私密值：${forbidden}`);
});

test('昵称为空时预览只显示空态文案', () => {
    const { panel } = createHarness();
    const empty = panel.querySelector('.yl-character-preview-empty');
    assert.ok(empty, '初始（昵称为空）应显示空态');
    assert.equal(empty.textContent, '填写昵称后，这里会出现 TA 的名片。');
    assert.equal(panel.querySelector('.yl-character-preview-name'), null);
    assert.equal(panel.querySelector('.yl-character-preview-avatar'), null);

    control(panel, 'public-昵称').value = '林夏';
    control(panel, 'public-昵称').dispatchEvent(new Event('input'));
    assert.equal(panel.querySelector('.yl-character-preview-empty'), null);
    assert.equal(panel.querySelector('.yl-character-preview-name').textContent, '林夏');

    control(panel, 'public-昵称').value = '   ';
    control(panel, 'public-昵称').dispatchEvent(new Event('input'));
    assert.ok(panel.querySelector('.yl-character-preview-empty'), '清空昵称后应回到空态');
});

test('载入本地模板后预览同步更新', () => {
    const characterLibrary = {
        list: () => [{ id: 'local_1', metadata: { name: '收藏草稿' } }],
        get: () => ({ template: { format: 'yuelema.character/v1', character: adultCandidate(), avatar: { kind: 'placeholder' } } }),
    };
    const panel = buildCharacterCreatorPanel({
        documentRef: miniDom.document,
        actionBridge: { async registerCharacter() { return { ok: true }; } },
        characterLibrary,
        signal: new AbortController().signal,
        onFeedback() {},
    });
    assert.ok(panel.querySelector('.yl-character-preview-empty'), '载入前昵称为空应显示空态');

    buttonByText(panel, '载入').dispatchEvent(new Event('click'));
    const card = panel.querySelector('.yl-character-preview-card');
    assert.equal(card.querySelector('.yl-character-preview-name').textContent, 'AI 草稿角色');
    assert.ok(card.querySelector('.yl-character-preview-meta').textContent.includes('上海'));
    const previewText = panel.querySelector('.yl-character-preview').textContent;
    assert.equal(previewText.includes('新候选自己的私密设定。'), false, '载入模板后预览也不得包含隐藏资料');
});

test('预览尾注声明私密资料边界', () => {
    const { panel } = createHarness();
    const note = panel.querySelector('.yl-character-preview-note');
    assert.ok(note, '应存在预览尾注');
    assert.equal(note.textContent, '预览只包含公开资料；仅好友与隐藏资料绝不会出现在这里。');
});

test('未注入链接导入器时不渲染任何链接导入控件', () => {
    const { panel } = createHarness();
    assert.equal(panel.querySelector('[name="avatar-import-url"]'), null, '无能力时不得留下死链接输入框');
    const remoteButton = panel.querySelectorAll('button').find((button) => button.textContent === '下载并压缩为本地头像');
    assert.equal(remoteButton, undefined, '无能力时不得留下死导入按钮');
});

test('链接导入成功：一次性下载结果压缩为 embedded 头像并同步预览，链接不落任何草稿', async () => {
    const importedUrls = [];
    const savedTemplates = [];
    const registeredCharacters = [];
    const panel = buildCharacterCreatorPanel({
        documentRef: miniDom.document,
        actionBridge: {
            async generateCharacterCompletionDraft() { return { ok: true, candidate: adultCandidate() }; },
            async registerCharacter(character) { registeredCharacters.push(structuredClone(character)); return { ok: true }; },
        },
        characterLibrary: {
            list: () => [],
            saveTemplate(input) { savedTemplates.push(structuredClone(input.template)); return { id: 'avatar-template' }; },
        },
        signal: new AbortController().signal,
        onFeedback() {},
        importAvatarFromUrl: async (url) => {
            importedUrls.push(url);
            return { kind: 'embedded', dataUrl: 'data:image/webp;base64,UklGRgwAAABXRUJQ', width: 64, height: 64, mimeType: 'image/webp' };
        },
    });
    fillExistingDraft(panel);
    completionButton(panel).dispatchEvent(new Event('click'));
    await flushUi();
    const urlInput = panel.querySelector('[name="avatar-import-url"]');
    assert.ok(urlInput, '注入能力后应有链接输入框');
    assert.equal(urlInput.getAttribute('type') ?? urlInput.type, 'text', '链接输入必须是 text，避免原生 url 校验阻塞整表单提交');
    urlInput.value = '  https://example.com/a.png  ';
    buttonByText(panel, '下载并压缩为本地头像').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(importedUrls, ['https://example.com/a.png'], '应以去空格后的链接调用注入导入器且只调一次');
    assert.equal(control(panel, 'avatar-kind').value, 'embedded', '导入成功后头像来源应切换为 embedded');
    const note = panel.querySelector('.yl-character-avatar-note');
    assert.ok(note.textContent.includes('链接本身不会被保存'), '提示必须申明链接不持久化');
    const previewAvatar = panel.querySelector('.yl-character-preview-avatar');
    assert.ok(previewAvatar, '预览应重建头像节点');
    assert.equal(panel.textContent.includes('example.com'), false, '面板任何可见文本不得回显链接');

    buttonByText(panel, '只保存当前草稿到本地模板库').dispatchEvent(new Event('click'));
    assert.deepEqual(savedTemplates[0].avatar, {
        kind: 'embedded',
        dataUrl: 'data:image/webp;base64,UklGRgwAAABXRUJQ',
    }, '压缩尺寸和 MIME 只供编辑器提示，模板保存只携带 codec 允许的头像字段');

    control(panel, 'save-local').checked = false;
    panel.querySelector('form').dispatchEvent(new Event('submit'));
    await flushUi();
    assert.equal(registeredCharacters.length, 1, '带压缩头像的草稿应能通过模板校验并登记角色');
});

test('链接导入失败：保持原头像草稿并显示安全投影文案', async () => {
    const failure = new Error('REMOTE_IMAGE_TYPE_UNSUPPORTED');
    failure.code = 'REMOTE_IMAGE_TYPE_UNSUPPORTED';
    const panel = buildCharacterCreatorPanel({
        documentRef: miniDom.document,
        actionBridge: { async registerCharacter() { return { ok: true }; } },
        characterLibrary: { list: () => [] },
        signal: new AbortController().signal,
        onFeedback() {},
        importAvatarFromUrl: async () => { throw failure; },
    });
    const urlInput = panel.querySelector('[name="avatar-import-url"]');
    const importButton = buttonByText(panel, '下载并压缩为本地头像');
    importButton.dispatchEvent(new Event('click'));
    assert.equal(panel.querySelector('.yl-character-avatar-note').textContent, '请先粘贴要导入的图片链接。', '空链接应先提示');
    urlInput.value = 'https://example.com/not-an-image';
    importButton.dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(control(panel, 'avatar-kind').value, 'embedded', '失败不得把头像来源改成 embedded');
    const note = panel.querySelector('.yl-character-avatar-note').textContent;
    assert.equal(note, '链接内容不是支持的图片格式（PNG / JPEG / WebP）。');
    assert.equal(note.includes('example.com'), false, '失败提示不得回显链接');
    assert.equal(importButton.disabled, false, '失败后导入按钮应恢复可用');
});

// —— 2026-07-27 安全控制台接线：operationActivity 为可选注入 ——
const { createOperationActivity } = await import('../../ui/operation-activity.js');

test('AI 补全失败：控制台条目 fail 且 detail 含错误码与服务层 detail，不含私密草稿或 Key', async () => {
    const operationActivity = createOperationActivity();
    const feedback = [];
    const panel = buildCharacterCreatorPanel({
        documentRef: miniDom.document,
        actionBridge: {
            async generateCharacterCompletionDraft() {
                return {
                    ok: false, code: 'character_authoring_connection_missing',
                    message: '请先为“角色创作”绑定连接预设或设置默认连接。',
                    detail: '功能「character_ai_completion」在 SFW 模式下未绑定连接预设，也没有可用的默认连接',
                };
            },
            async registerCharacter() { return { ok: true }; },
        },
        characterLibrary: { list: () => [] },
        signal: new AbortController().signal,
        onFeedback: (message) => feedback.push(message),
        operationActivity,
    });
    fillExistingDraft(panel);
    completionButton(panel).dispatchEvent(new Event('click'));
    await flushUi();

    const entry = operationActivity.snapshot().entries.find((item) => item.name === 'AI 补全');
    assert.ok(entry, 'AI 补全失败必须留下控制台条目');
    assert.equal(entry.status, 'failure');
    assert.ok(entry.detail, 'fail 时 detail 必须非空');
    assert.match(entry.detail, /character_ authoring_ connection_ missing/u, 'detail 应含具体错误码（长码按下划线拆分以避开脱敏器的长 token 规则）');
    assert.match(entry.detail, /character_ai_completion/u, 'detail 应指出未绑定的功能');
    for (const forbidden of ['friend-secret-must-not-leak', 'hidden-note-must-not-leak', 'sk-', 'Bearer']) {
        assert.equal(entry.detail.includes(forbidden), false, `detail 不得包含：${forbidden}`);
    }
    assert.equal(feedback.at(-1), 'AI 补全未生成可用草稿；当前草稿未改变。', '界面提示保持原有粗略文案');
});

test('角色登记失败：detail 透传 action-bridge 的 code/reason；未注入控制台时行为完全不变', async () => {
    const operationActivity = createOperationActivity();
    const failure = { ok: false, status: 'rejected', code: 'character_registration_candidate_invalid', reason: '成年人校验未通过：字段 隐藏资料.实际年龄' };
    const makePanel = (activity) => buildCharacterCreatorPanel({
        documentRef: miniDom.document,
        actionBridge: { async registerCharacter() { return failure; } },
        characterLibrary: null,
        signal: new AbortController().signal,
        onFeedback() {},
        operationActivity: activity,
    });

    const panel = makePanel(operationActivity);
    fillExistingDraft(panel);
    panel.querySelector('form').dispatchEvent(new Event('submit'));
    await flushUi();
    const entry = operationActivity.snapshot().entries.find((item) => item.name === '角色登记');
    assert.ok(entry, '登记失败必须留下控制台条目');
    assert.equal(entry.status, 'failure');
    assert.match(entry.detail, /character_ registration_ candidate_ invalid/u);
    assert.match(entry.detail, /隐藏资料\.实际年龄/u, 'reason 中的字段路径应透传到 detail');

    // 兼容性：不注入 operationActivity 时（现有 app-shell 调用形态）登记流程照常运行。
    const legacyPanel = makePanel(null);
    fillExistingDraft(legacyPanel);
    legacyPanel.querySelector('form').dispatchEvent(new Event('submit'));
    await flushUi();
    assert.ok(legacyPanel, '未注入控制台时面板构建与提交不抛异常');
});

test('模板载入失败：控制台 detail 含模板错误码与字段结论，成功路径落 success 条目', async () => {
    const operationActivity = createOperationActivity();
    const panel = buildCharacterCreatorPanel({
        documentRef: miniDom.document,
        actionBridge: { async registerCharacter() { return { ok: true }; } },
        characterLibrary: { list: () => [] },
        signal: new AbortController().signal,
        onFeedback() {},
        operationActivity,
    });
    control(panel, 'character-template-json').value = '{"format":"yuelema.character/v1","character":{}}';
    buttonByText(panel, '校验并载入到编辑器').dispatchEvent(new Event('click'));
    await flushUi();
    const entry = operationActivity.snapshot().entries.find((item) => item.name === '模板载入');
    assert.ok(entry, '模板载入失败必须留下控制台条目');
    assert.equal(entry.status, 'failure');
    assert.match(entry.detail, /template_character_invalid/u, 'detail 应含模板校验错误码');
});

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
    control(panel, 'avatar-kind').value = 'url';
    control(panel, 'avatar-url').value = 'https://private.example/original-avatar.webp';
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
test('AI 补全成功只载入草稿：清除 URL 头像且不会登记或写 MVU', async () => {
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
        'private.example/original-avatar.webp', 'friend-secret-must-not-leak', 'friend-boundary-secret-must-not-leak',
        'hidden-note-must-not-leak', 'private-boundary-must-not-leak', 'data:image',
    ]) assert.equal(serializedRequest.includes(forbidden), false, `补全请求不得包含：${forbidden}`);

    assert.equal(control(panel, 'public-昵称').value, 'AI 草稿角色');
    assert.equal(control(panel, 'avatar-kind').value, 'placeholder');
    assert.equal(control(panel, 'avatar-url').value, '');
    assert.equal(feedback.at(-1), 'AI 补全草稿已载入编辑器；请检查私有层、边界和阈值后再登记。');
    assertNoWrite(writes);
});

test('AI 补全模型失败时保持原始表单草稿与 URL 头像，且不会写 MVU', async () => {
    const { panel, feedback, writes, completionRequests } = createHarness({
        completion: async () => { throw new Error('Authorization Bearer private-key-must-not-leak'); },
    });
    fillExistingDraft(panel);
    const before = {
        name: control(panel, 'public-昵称').value,
        friend: control(panel, 'friend-关系状态').value,
        hidden: control(panel, 'hidden-note').value,
        avatarKind: control(panel, 'avatar-kind').value,
        avatarUrl: control(panel, 'avatar-url').value,
    };

    completionButton(panel).dispatchEvent(new Event('click'));
    await flushUi();

    assert.equal(completionRequests.length, 1);
    assert.equal(control(panel, 'public-昵称').value, before.name);
    assert.equal(control(panel, 'friend-关系状态').value, before.friend);
    assert.equal(control(panel, 'hidden-note').value, before.hidden);
    assert.equal(control(panel, 'avatar-kind').value, before.avatarKind);
    assert.equal(control(panel, 'avatar-url').value, before.avatarUrl);
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

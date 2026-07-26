import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalConversationSummaryContext, generateLocalConversationSummary } from '../local-conversation-summary-service.js';

function resolved(key) {
    assert.equal(key, 'chat_summary');
    return {
        connectionPreset: { id: 'summary', url: 'https://example.test/v1', model: 'summary-model' },
        promptPreset: { enabled: true, name: '总结规则', content: JSON.stringify({ schema: 'yuelema.prompt-entries', schemaVersion: 1, entries: [{ name: '规则', content: '只总结已发生事实。', position: 'before_character_definition', enabled: true, depth: 1, order: 0 }] }) },
    };
}

const messages = Object.freeze([
    { floor: 1, sender: 'user', speaker: '我', content: '周六下午可以一起看展。' },
    { floor: 2, sender: 'member', speaker: '林澈', content: '我也想去，展后喝咖啡吧。' },
]);

test('local group/forum summary uses chat_summary binding and returns a non-MVU draft only', async () => {
    let request;
    const result = await generateLocalConversationSummary({
        target: { kind: 'group', title: '同城周末搭子' },
        messages,
        contentMode: 'SFW',
        settingsStore: { resolveFunction: resolved },
        llmClient: { async chat(input) { request = input; return { text: JSON.stringify({ summary: '大家提议周六看展，林澈建议展后喝咖啡。' }) }; } },
    });
    assert.deepEqual(result, { ok: true, summary: '大家提议周六看展，林澈建议展后喝咖啡。' });
    assert.match(request.messages[0].content, /只总结已发生事实/u);
    assert.doesNotMatch(request.messages[1].content, /stat_data|对象UID|hidden-secret|session-secret/u);
});

test('local group/forum summary validates target, source and model output before storage can see it', async () => {
    assert.equal(buildLocalConversationSummaryContext({ target: { kind: 'home', title: '首页' }, messages }).code, 'local_summary_target_invalid');
    assert.equal(buildLocalConversationSummaryContext({ target: { kind: 'post', title: '帖子' }, messages: [{ ...messages[0], content: '<UpdateVariable>bad</UpdateVariable>' }] }).code, 'local_summary_source_invalid');
    const result = await generateLocalConversationSummary({
        target: { kind: 'post', title: '雨后的书店' }, messages, settingsStore: { resolveFunction: resolved },
        llmClient: { async chat() { return { text: JSON.stringify({ summary: '<UpdateVariable>bad</UpdateVariable>' }) }; } },
    });
    assert.equal(result.code, 'local_summary_response_invalid');
});

// —— 阶段 77：失败结果附带控制台诊断 ——

test('local summary failures carry parse/validation diagnostics without echoing model text', async () => {
    const target = { kind: 'group', title: '同城周末搭子' };
    const messages = [{ floor: 1, sender: 'user', speaker: '我', content: '周末去哪玩？' }];
    const run = (text) => generateLocalConversationSummary({
        target, messages, contentMode: 'SFW',
        settingsStore: { resolveFunction(key) { assert.equal(key, 'chat_summary'); return { connectionPreset: { id: 's', url: 'https://example.test/v1', model: 'm' }, promptPreset: null }; } },
        llmClient: { async chat() { return { text }; } },
    });

    const unparsable = await run('SUMMARY_RAW_LEAK not json');
    assert.equal(unparsable.code, 'local_summary_invalid_json');
    assert.equal(unparsable.diagnostic.stage, '响应解析');
    assert.match(unparsable.diagnostic.actual, /响应长度 \d+ 字符/u);
    assert.doesNotMatch(JSON.stringify(unparsable.diagnostic), /SUMMARY_RAW_LEAK/u);

    const invalid = await run(JSON.stringify({ summary: '', extra: 1 }));
    assert.equal(invalid.code, 'local_summary_response_invalid');
    assert.equal(invalid.diagnostic.field, 'summary');
    assert.match(invalid.diagnostic.expected, /1-1600 字/u);

    const badSource = await generateLocalConversationSummary({
        target, messages: [{ floor: 0, sender: 'user', speaker: '我', content: '楼层非法。' }], contentMode: 'SFW',
        settingsStore: { resolveFunction() { return { connectionPreset: { id: 's', url: 'https://example.test/v1', model: 'm' }, promptPreset: null }; } },
        llmClient: { async chat() { throw new Error('must not be called'); } },
    });
    assert.equal(badSource.code, 'local_summary_source_invalid');
    assert.equal(badSource.diagnostic.stage, '上下文构建');
    assert.equal(badSource.diagnostic.field, 'messages[0]');
});

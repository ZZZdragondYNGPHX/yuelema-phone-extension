import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HOST_EXTENSION_DIRECTORY,
    HOST_EXTENSION_IS_GLOBAL,
    HOST_MESSAGE_MAX_LENGTH,
    HostExtensionUpdateError,
    UPDATE_ENDPOINT,
    VERSION_ENDPOINT,
    checkAndUpdateHostExtension,
    createHostExtensionUpdater,
    projectHostExtensionUpdateError,
    sanitizeHostMessage,
} from '../host-extension-update.js';

function jsonResponse(body, { status = 200 } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() { return body; },
    };
}

function rejectedJsonResponse({ status = 200, message = 'PRIVATE_BACKEND_BODY' } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() { throw new Error(message); },
    };
}

function hostHeaders() {
    return { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf-token' };
}

function assertSafeError(error, code, status) {
    assert.ok(error instanceof HostExtensionUpdateError);
    assert.equal(error.code, code);
    if (status === undefined) assert.equal(error.status, undefined);
    else assert.equal(error.status, status);
    assert.doesNotMatch(error.message, /PRIVATE|BACKEND|SECRET/i);
    return true;
}

test('uses injected transport, fresh host headers, and the fixed user extension request shape', async () => {
    const requests = [];
    let headerCalls = 0;
    const result = await checkAndUpdateHostExtension({
        getRequestHeaders() {
            headerCalls += 1;
            return hostHeaders();
        },
        async transport(endpoint, options) {
            requests.push({ endpoint, options });
            return jsonResponse({ isUpToDate: true, currentBranchName: 'main', currentCommitHash: 'abc1234', remoteUrl: 'https://example.invalid/repo.git' });
        },
    });

    assert.deepEqual(result, { outcome: 'up_to_date' });
    assert.equal(headerCalls, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].endpoint, VERSION_ENDPOINT);
    assert.deepEqual(requests[0].options, {
        method: 'POST',
        headers: hostHeaders(),
        body: JSON.stringify({ extensionName: HOST_EXTENSION_DIRECTORY, global: HOST_EXTENSION_IS_GLOBAL }),
    });
});

test('reports up_to_date without invoking the update endpoint', async () => {
    const endpoints = [];
    const updater = createHostExtensionUpdater({
        getRequestHeaders: hostHeaders,
        async transport(endpoint) {
            endpoints.push(endpoint);
            return jsonResponse({ isUpToDate: true, currentBranchName: 'main', currentCommitHash: 'abc1234', remoteUrl: 'https://example.invalid/repo.git' });
        },
    });

    assert.deepEqual(await updater.checkAndUpdate(), { outcome: 'up_to_date' });
    assert.deepEqual(endpoints, [VERSION_ENDPOINT]);
});

test('automatically updates after a non-current version check', async () => {
    const requests = [];
    let headerCalls = 0;
    const result = await checkAndUpdateHostExtension({
        getRequestHeaders() {
            headerCalls += 1;
            return { 'X-CSRF-Token': `csrf-${headerCalls}` };
        },
        async transport(endpoint, options) {
            requests.push({ endpoint, options });
            if (endpoint === VERSION_ENDPOINT) return jsonResponse({ isUpToDate: false });
            return jsonResponse({ isUpToDate: false, shortCommitHash: 'def5678', extensionPath: 'PRIVATE_LOCAL_PATH', remoteUrl: 'https://example.invalid/repo.git' });
        },
    });

    assert.deepEqual(result, { outcome: 'updated' });
    assert.equal(headerCalls, 2);
    assert.deepEqual(requests.map((request) => request.endpoint), [VERSION_ENDPOINT, UPDATE_ENDPOINT]);
    assert.deepEqual(requests.map((request) => request.options.body), [
        JSON.stringify({ extensionName: HOST_EXTENSION_DIRECTORY, global: false }),
        JSON.stringify({ extensionName: HOST_EXTENSION_DIRECTORY, global: false }),
    ]);
    assert.deepEqual(requests.map((request) => request.options.headers), [
        { 'X-CSRF-Token': 'csrf-1' },
        { 'X-CSRF-Token': 'csrf-2' },
    ]);
});

test('rejects the host non-Git 200 response instead of claiming the extension is current', async () => {
    await assert.rejects(
        () => checkAndUpdateHostExtension({
            getRequestHeaders: hostHeaders,
            transport: async () => jsonResponse({
                currentBranchName: '',
                currentCommitHash: '',
                isUpToDate: true,
                remoteUrl: '',
            }),
        }),
        (error) => assertSafeError(error, 'not_git_installation'),
    );
});

test('fails safely when the injected transport or request-header factory is unavailable', async () => {
    await assert.rejects(
        () => checkAndUpdateHostExtension({ getRequestHeaders: hostHeaders }),
        (error) => assertSafeError(error, 'transport_unavailable'),
    );
    await assert.rejects(
        () => checkAndUpdateHostExtension({ transport: async () => jsonResponse({ isUpToDate: true }) }),
        (error) => assertSafeError(error, 'request_headers_unavailable'),
    );
    await assert.rejects(
        () => checkAndUpdateHostExtension({
            transport: async () => jsonResponse({ isUpToDate: true }),
            getRequestHeaders() { throw new Error('SECRET_HEADER_FAILURE'); },
        }),
        (error) => assertSafeError(error, 'request_headers_unavailable'),
    );
});

test('maps non-2xx and thrown transport failures to fixed safe messages while carrying status, phase and sanitized host text', async () => {
    await assert.rejects(
        () => checkAndUpdateHostExtension({
            getRequestHeaders: hostHeaders,
            transport: async () => ({
                ok: false,
                status: 500,
                text: async () => 'Internal Server Error. Check the server logs for more details.',
                json: async () => ({ message: 'PRIVATE_BACKEND_BODY' }),
            }),
        }),
        (error) => {
            assertSafeError(error, 'request_failed_http', 500);
            assert.equal(error.phase, 'version');
            assert.equal(error.hostMessage, 'Internal Server Error. Check the server logs for more details.');
            return true;
        },
    );
    // text() 缺失时退回 json() 序列化；两者都不可读则只保留状态码。
    await assert.rejects(
        () => checkAndUpdateHostExtension({
            getRequestHeaders: hostHeaders,
            transport: async () => ({ ok: false, status: 503, json: async () => ({ message: 'backend detail' }) }),
        }),
        (error) => {
            assertSafeError(error, 'request_failed_http', 503);
            assert.match(error.hostMessage, /backend detail/u);
            return true;
        },
    );
    await assert.rejects(
        () => checkAndUpdateHostExtension({
            getRequestHeaders: hostHeaders,
            transport: async () => ({ ok: false, status: 502, text: async () => { throw new Error('SECRET_BODY_READ_FAILURE'); } }),
        }),
        (error) => {
            assertSafeError(error, 'request_failed_http', 502);
            assert.equal(error.hostMessage, undefined);
            return true;
        },
    );
    await assert.rejects(
        () => checkAndUpdateHostExtension({
            getRequestHeaders: hostHeaders,
            transport: async () => { throw new Error('SECRET_CONNECTION_DETAIL'); },
        }),
        (error) => {
            assertSafeError(error, 'request_failed');
            assert.equal(error.phase, 'version');
            assert.equal(error.hostMessage, undefined);
            return true;
        },
    );
});

test('update-phase failures report phase "update" with the host explanation for the failed git pull', async () => {
    await assert.rejects(
        () => checkAndUpdateHostExtension({
            getRequestHeaders: hostHeaders,
            async transport(endpoint) {
                if (endpoint === VERSION_ENDPOINT) return jsonResponse({ isUpToDate: false, currentBranchName: 'main', currentCommitHash: 'abc1234' });
                return {
                    ok: false,
                    status: 500,
                    text: async () => 'Internal Server Error. Check the server logs for more details.',
                };
            },
        }),
        (error) => {
            assertSafeError(error, 'request_failed_http', 500);
            assert.equal(error.phase, 'update');
            assert.match(error.hostMessage, /Internal Server Error/u);
            return true;
        },
    );
});

test('host failure text is sanitized: control chars stripped, credential-like content redacted, length capped', async () => {
    assert.equal(sanitizeHostMessage('line1\r\nline2\u0000tab\u0009end'), 'line1 line2 tab end');
    const redacted = sanitizeHostMessage('Authorization: Bearer abc.DEF-123 token=super-secret-value sk-abcdefghijklmnop rest');
    assert.doesNotMatch(redacted, /abc\.DEF-123|super-secret-value|sk-abcdefghijklmnop/u);
    assert.match(redacted, /已脱敏/u);
    const longRandom = 'A'.repeat(64);
    assert.doesNotMatch(sanitizeHostMessage(`prefix ${longRandom} suffix`), /A{40}/u);
    const capped = sanitizeHostMessage(`${'宿主说明'.repeat(200)}`);
    assert.ok(capped.length <= HOST_MESSAGE_MAX_LENGTH + 1);
    assert.match(capped, /…$/u);
    assert.equal(sanitizeHostMessage(42), '');
    // Windows 安装路径可以原样保留（不是凭据），便于用户定位目录。
    assert.equal(
        sanitizeHostMessage('Directory does not exist at D:\\SillyTavern\\data\\default-user\\extensions\\yuelema-phone-extension'),
        'Directory does not exist at D:\\SillyTavern\\data\\default-user\\extensions\\yuelema-phone-extension',
    );
});

test('rejects malformed JSON and invalid version or update response structures without exposing body text', async () => {
    await assert.rejects(
        () => checkAndUpdateHostExtension({ getRequestHeaders: hostHeaders, transport: async () => rejectedJsonResponse() }),
        (error) => assertSafeError(error, 'invalid_json'),
    );
    await assert.rejects(
        () => checkAndUpdateHostExtension({ getRequestHeaders: hostHeaders, transport: async () => jsonResponse({ isUpToDate: 'false', raw: 'PRIVATE_BACKEND_BODY' }) }),
        (error) => assertSafeError(error, 'invalid_response'),
    );
    await assert.rejects(
        () => checkAndUpdateHostExtension({
            getRequestHeaders: hostHeaders,
            async transport(endpoint) {
                if (endpoint === VERSION_ENDPOINT) return jsonResponse({ isUpToDate: false });
                return jsonResponse({ isUpToDate: false, shortCommitHash: 42, raw: 'PRIVATE_BACKEND_BODY' });
            },
        }),
        (error) => assertSafeError(error, 'invalid_response'),
    );
});

test('safe error projection keeps the fixed message while exposing status, phase and sanitized host text', () => {
    const projected = projectHostExtensionUpdateError(new HostExtensionUpdateError('request_failed_http', { status: 401 }));
    assert.deepEqual(projected, { code: 'request_failed_http', message: '宿主扩展更新请求失败。', status: 401 });
    const detailed = projectHostExtensionUpdateError(new HostExtensionUpdateError('request_failed_http', {
        status: 500,
        hostMessage: 'Internal Server Error. Check the server logs for more details.',
        phase: 'update',
    }));
    assert.deepEqual(detailed, {
        code: 'request_failed_http',
        message: '宿主扩展更新请求失败。',
        status: 500,
        hostMessage: 'Internal Server Error. Check the server logs for more details.',
        phase: 'update',
    });
    const unknown = projectHostExtensionUpdateError(new Error('PRIVATE_BACKEND_BODY SECRET'));
    assert.deepEqual(unknown, { code: 'unknown_error', message: '检查扩展更新时发生未知错误。' });
    assert.doesNotMatch(JSON.stringify(unknown), /PRIVATE|BACKEND|SECRET/i);
});

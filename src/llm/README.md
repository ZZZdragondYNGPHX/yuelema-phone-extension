# 阶段 2：LLM 安全服务

本目录的当前实现为 `session-key-store.js` 与 `openai-compatible-client.js`。它提供无依赖的 OpenAI-compatible Chat Completions 接缝，支持普通 JSON、真流式 SSE 与假流式显示元信息；不直接接入 MVU，且不会默认访问全局网络。

## 当前接口

| 文件 | 职责 |
|---|---|
| `session-key-store.js` | 仅模块闭包 `Map` 的本次会话 API Key 解锁、查询、清除；无序列化、导出或持久化接口。 |
| `openai-compatible-client.js` | 非机密连接预设、`/models` 探针、JSON/SSE `chat/completions`、安全错误投影与假流式分块。 |
| `test/openai-compatible-client.test.mjs` | 全部使用注入式 mock transport，不访问真实网络。 |

连接预设只保存白名单非机密字段：`id`、`name`、`url`、`model`、`temperature`、`maxTokens`、`timeoutMs`、`transportMode`。`transportMode` 允许：

- `json`：普通 JSON 请求；旧预设缺失该字段时的默认值。
- `stream`：请求体发送 `stream: true`，读取 OpenAI-compatible SSE `data:` 行并聚合 `choices[0].delta.content`；支持 `[DONE]`、`onDelta`、超时和取消。
- `pseudo_stream`：仍发送普通 JSON 请求，结果附带安全的 `presentation` 元信息；UI 可调用 `splitPseudoStreamText()` 做逐段显示。

## 安全边界

- 保存连接预设时 `model` 仍必须非空；`fetchModels()` 使用独立的 `normalizeConnectionProbe()`，允许 model 缺失、空字符串或临时占位值，从而可先鉴权拉取模型再保存。
- URL 只允许 HTTPS；仅 `localhost`/回环地址允许 HTTP；拒绝 userinfo、query 与 fragment。
- API Key 只能由 `unlockSessionKey(presetId, apiKey)` 放进 ES 模块闭包 Map；检测到 `apiKey`、`token`、`authorization`、`secret` 等字段会拒绝且不回显值。
- `createOpenAICompatibleClient({ fetchImpl })` 必须显式注入 `fetchImpl`；模块不会默认使用 `globalThis.fetch`。
- JSON 与 SSE 响应均有 2 MiB 安全上限。错误只含稳定代码、可选 HTTP 状态与通用文案，不带请求体、响应体、Authorization、原始异常或凭据。

## 静态/Node 验证

在 `D:\Dev\AI制卡\约了吗\约了吗小手机` 运行：

```powershell
node --check .\src\llm\session-key-store.js
node --check .\src\llm\openai-compatible-client.js
node .\src\llm\test\openai-compatible-client.test.mjs
```

## 真机待验

1. 目标服务的 CORS、预检、Authorization header、`/models` GET/POST 与 `/chat/completions` SSE 兼容性。
2. SillyTavern WebView 中 `ReadableStream`、`TextDecoder`、AbortController、超时/取消及断线行为。
3. UI 的真流式增量渲染、假流式计时显示和窗口关闭行为。
4. 扩展停用、热重载与窗口卸载是否可靠调用 `clearSessionKeys()`。

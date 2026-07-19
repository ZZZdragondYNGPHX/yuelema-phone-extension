# 阶段 2：LLM 安全服务

本目录的**当前受支持实现**为 `session-key-store.js` 与 `openai-compatible-client.js`。它提供无依赖、非流式的 OpenAI-compatible Chat Completions 接缝；已接入手机设置页的本次会话解锁与手动模型列表，不直接接入 MVU 或提示词生成器。

## 当前接口

| 文件 | 职责 |
|---|---|
| `session-key-store.js` | 仅模块闭包 `Map` 的本次会话 API Key 解锁、查询、清除。没有序列化、导出或持久化接口。 |
| `openai-compatible-client.js` | 非机密连接预设校验、手动模型列表与非流式 `chat/completions` 客户端；要求显式注入 transport。 |
| `test/openai-compatible-client.test.mjs` | 无网络 mock 测试。 |

连接预设只可保存白名单非机密字段：`id`、`name`、`url`、`model`、`temperature`、`maxTokens`、`timeoutMs`。检测到 `apiKey`、`token`、`authorization`、`secret` 等字段会拒绝创建而不回显值。

- URL 只允许 HTTPS；仅 `localhost`/回环地址允许 HTTP；拒绝 userinfo、query 与 fragment。
- API Key 只能由 `unlockSessionKey(presetId, apiKey)` 放进 ES 模块闭包 Map。刷新页面、扩展卸载后或 `clearSessionKeys()` 调用后，均需重新解锁。
- 任何 UI 接线不得把 Key 放进 `extension_settings`、localStorage、IndexedDB、MVU、角色卡、世界书、聊天、DOM、提示词、导出、日志或错误。
- `createOpenAICompatibleClient({ fetchImpl })` 必须显式注入 `fetchImpl`；模块不会默认使用 `globalThis.fetch`，测试没有真实网络。
- `/models` 支持 GET（也可显式 POST）；聊天固定走 `{url}/chat/completions` 的非流式 JSON。
- 返回的错误只含稳定代码、可选 HTTP 状态与通用文案，不带请求体、响应体、Authorization、原始异常或凭据。

## 静态/Node 验证

在 `D:\Dev\AI制卡\约了吗\约了吗小手机` 运行：

```powershell
node --check .\src\llm\session-key-store.js
node --check .\src\llm\openai-compatible-client.js
node .\src\llm\test\openai-compatible-client.test.mjs
```

## 真机待验

1. 扩展停用、热重载与窗口卸载能否可靠地调用 `clearSessionKeys()`。
2. 目标服务的 CORS、预检、Authorization header、`/models` GET/POST 与 `/chat/completions` 字段兼容。
3. 实际 SillyTavern 宿主中的 AbortController/超时、取消、401/429/5xx 与网络断开表现。
4. 设置页、导入导出和功能绑定是否始终不携带凭据；API Key 输入框在解锁或失败后是否可靠清空。



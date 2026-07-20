# 阶段 2a：本地非机密设置与提示词预设存储

本目录是“约了吗”扩展的纯数据层，不接入 UI、`index.js`、MVU 或网络。所有实现均为无依赖 ESM，可在浏览器宿主或纯 Node 测试中使用。

## 允许持久化的内容

`settings-store.js` 管理版本化数据（当前 `schema: "yuelema.settings"`、`schemaVersion: 4`）：

- 非机密连接预设：`id`、`name`、`url`、`model`、`temperature`、`maxTokens`、`timeoutMs`、`transportMode`；
- 提示词预设及其条目数据，以及每个预设明确的 `contentMode: "SFW" | "NSFW"` 标记；
- 默认连接/提示词预设 ID；
- `chat`、角色 AI 补全、角色完整创作、`soul_match`、`text_match`、`recommendation_refresh`、`group_chat`、`forum` 的功能绑定；
- 个性化内容推荐开关与关键词权重。

`transportMode` 仅允许 `json`、`stream`、`pseudo_stream`。旧 schema v1 和旧 v2 连接预设缺失该字段时都会安全归一化为 `json`；旧 v1–v3 提示词缺失 `contentMode` 时按明确的 NSFW ID/名称推断，否则安全地归入 SFW。导出后固定带当前字段；这不会放宽保存预设时 model 必须非空的校验。

## 连接设置明确不含 API Key

API Key、token、authorization、password、secret 等字段会在添加、编辑、载入、导入前被拒绝；不会写入本目录的设置文档、回显、导出或错误对象。禁止原型键（`__proto__`、`prototype`、`constructor`），并限制导入/持久化 JSON 最大为 512 KiB。

API Key 由 `../llm/session-key-store.js` 按连接预设 ID 写入**独立**浏览器缓存；设置 UI 在保存有效连接预设时只把刚输入的 Key 交给该模块。本目录没有读取、序列化、导出或回显密钥的接口，因此导入/导出设置不会携带 Key。

## 存储与默认策略

```js
import { createMemoryStorage, createSettingsStore } from './settings-store.js';

const store = createSettingsStore({ storage: createMemoryStorage() });
store.addConnectionPreset({
  id: 'fast',
  name: '快速模型',
  url: 'https://api.example.com/v1',
  model: 'fast-chat',
  transportMode: 'stream',
});
```

- 未显式传入 `storage` 时默认使用内存存储；浏览器 UI 可显式注入兼容 `getItem/setItem/removeItem` 的 storage。
- 第一个添加的同类预设成为默认预设；连接绑定未指定的部分回退到默认连接，而带内容模式的 AI 调用只使用同一模式的提示词绑定，绝不跨 SFW / NSFW 回退。
- 删除默认或已绑定预设时会清理关联 ID，避免遗留无效引用。
- `add/edit/delete/import/export` 都执行完整 schema、大小和机密字段检查。

## 导入导出

- `exportJson()` 仅导出白名单字段、版本号和绑定 ID。
- `importJson(json)` 支持 schema v1 到 v4 的既有迁移，以及旧 v2 连接预设补全 `transportMode: "json"` 和旧提示词内容模式归类。
- 导入是整体替换；校验失败不会写入 storage，也不会污染当前内存快照。

## 纯 Node 验证

```powershell
node --check .\src\settings\settings-store.js
node --test .\src\settings\test\settings-store.test.mjs
```

测试为 mock/in-memory 测试，不访问浏览器存储、SillyTavern、MVU、网络或真实 API。

## 真机待验

1. 实际 localStorage 命名空间、配额和 schema v1–v3 旧数据迁移。
2. 设置 UI 对三个传输模式的编辑、保存、重载与导入导出。
3. 模型列表拉取和功能绑定是否始终不把密钥带入 DOM、日志或导出文件；并确认设置重载后调用端可按连接 ID 从独立 Key 缓存恢复认证。

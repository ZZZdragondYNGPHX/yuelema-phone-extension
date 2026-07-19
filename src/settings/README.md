# 阶段 2a：本地非机密设置与提示词预设存储

本目录是“约了吗”扩展的**纯数据层**，不接入 UI、`index.js`、MVU 或网络。所有实现均为无依赖 ESM，可在浏览器宿主或纯 Node 测试中使用。

## 允许持久化的内容

`settings-store.js` 仅管理下列版本化数据（当前 `schema: "yuelema.settings"`、`schemaVersion: 1`）：

- 非机密连接预设：`id`、`name`、`url`、`model`、`temperature`、`maxTokens`、`timeoutMs`；
- Worldbook 风格提示词预设：`id`、`name`、`depth`、`order`、`position`、`enabled`、`content`；
- 默认连接/提示词预设 ID；
- 五个功能的“功能 → 连接预设 ID / 提示词预设 ID”绑定：
  - `chat`
  - `character_authoring`
  - `soul_match`
  - `text_match`
  - `recommendation_refresh`

`position` 仅接受 `before_character_definition` 或 `after_character_definition`。提示词的深度、顺序、位置与启用状态都被保留，供后续提示词组装层读取；本模块不会自行调用模型或拼接模型请求。

## 明确禁止 API Key

API Key、token、authorization、password、secret 等字段会在添加、编辑、载入、导入前被拒绝；不会被持久化、回显、导出或写入错误对象。禁止原型键（`__proto__`、`prototype`、`constructor`），并限制导入/持久化 JSON 最大为 512 KiB。

**API Key 仍只能由 `../llm/session-key-store.js` 放入 ES 模块闭包的本次会话内存中。** 本目录没有解锁、读取、序列化或导出密钥的接口。页面刷新、停用扩展或显式清除后，都应由后续生命周期接线重新解锁；不得把 Key 放入任何设置对象。

## 存储与默认策略

```js
import { createMemoryStorage, createSettingsStore } from './settings-store.js';

const store = createSettingsStore({ storage: createMemoryStorage() });
store.addConnectionPreset({
  id: 'fast', name: '快速模型', url: 'https://api.example.com/v1', model: 'fast-chat',
});
store.addPromptPreset({
  id: 'chat_base', name: '聊天基础', depth: 4, order: 100,
  position: 'after_character_definition', enabled: true, content: '……',
});
store.bindFunction('chat', { connectionPresetId: 'fast', promptPresetId: 'chat_base' });
```

- 未显式传入 `storage` 时，仓库默认使用一个**内存存储**；后续 UI 可显式注入兼容 `getItem/setItem/removeItem` 的真实 `localStorage`，本阶段不会自行访问全局 `localStorage`。
- 第一个添加的同类预设会成为对应默认预设；`setDefaults()` 可改为任一现存预设或 `null`。
- 功能绑定可只指定一种预设，另一种回退到相应默认预设；`resolveFunction()` 返回最终解析结果及是否使用默认值。
- 删除默认预设时，默认值改为同类剩余预设的第一个 ID，或 `null`。删除已绑定预设时，相关功能绑定清为 `null`，使它回退到当时的默认策略，而不是遗留无效 ID。
- `add/edit/delete` 均会执行完整 schema 验证，再写入注入的 storage。

## 导入导出

- `exportJson()` 仅导出上述白名单字段、版本号和绑定 ID。
- `importJson(json)` 要求正确的 schema 版本、对象结构、关联 ID、字段范围和大小；不支持未知字段或迁移。
- 导入是**整体替换**：校验失败不会调用 storage 写入，也不会污染当前内存快照。

## 纯 Node 验证

在 `D:\Dev\AI制卡\约了吗\约了吗小手机` 运行：

```powershell
node --check .\src\settings\settings-store.js
node --test .\src\settings\test\settings-store.test.mjs
```

测试为 mock/in-memory 测试，不会访问浏览器存储、SillyTavern、MVU、网络或真实 API。

## 真机待验

1. 后续设置页注入实际 `localStorage` 时的多用户/扩展命名空间与配额表现。
2. 扩展生命周期是否可靠调用 `clearSessionKeys()`（该职责不属于本目录）。
3. 设置 UI 的编辑、导入/导出文件交互与模型列表请求是否始终不把密钥带入 DOM、日志或导出文件。


# 约了吗小手机：MVU 适配层（阶段 1）

此目录是扩展与 MagVarUpdate 之间唯一允许的 MVU 接缝。它只实现：

- `readLatestState()`：读取 `Mvu.getMvuData({ type: 'message', message_id: 'latest' })` 的克隆快照；
- `buildControlledPatch()`：将固定的 UI 意图转为状态感知、路径受限的 RFC JSONPatch；
- `buildUpdateVariable()`：将通过白名单的 Patch 封装为唯一认可的 `<UpdateVariable><JSONPatch>…`；
- `applyControlledPatch()`：只经 `Mvu.getMvuData → Mvu.parseMessage → Mvu.replaceMvuData → VARIABLE_UPDATE_ENDED` 回收。

## 严格边界

- **绝不**给 `stat_data`、聊天元数据或 `replaceVariables()` 直接赋值。
- 不接受调用方给出的任意 JSON Pointer、UID、对象值或模型原文。
- 角色 UID 只认可 `npc_…`，且必须已经存在于角色池或临时候选池，并通过 `成人验证=true` + `隐藏资料.实际年龄≥18` 校验。
- Patch 仅允许公开资料保存、推荐反馈/收藏/冷却、候选升级、收藏主动私聊判定、独立匹配会话、既有私聊与面基所需的最小路径；不允许 UI 或模型直接提供路径、UID、隐藏资料、关系数值或会话内容。
- 候选升级用 JSONPatch `move`，不把隐藏资料复制进 UI 命令或外部输入。
- MVU 或变量事件接口缺失时返回 `unavailable`，不尝试降级写入。

## 文件

```text
mvu/
├─ json-pointer.js             # own-property JSON Pointer 与原型污染防护
├─ controlled-patch.js         # UI 意图、Patch 白名单、状态一致性校验、封套
├─ adapter.js                  # 只读读取与官方回收管线适配器
└─ test/mvu-adapter.test.mjs   # 无浏览器、无联网的 Node 纯函数/管线测试
```

## 当前支持的 UI 命令

```js
buildControlledPatch(state, { kind: 'like', npcUid })
buildControlledPatch(state, { kind: 'favorite', npcUid })
buildControlledPatch(state, { kind: 'dislike', npcUid })
buildControlledPatch(state, { kind: 'refresh', npcUid })
buildControlledPatch(state, { kind: 'unfavorite', npcUid })
buildControlledPatch(state, { kind: 'start_private_chat', npcUid })
buildControlledPatch(state, { kind: 'advance_content_mode_gate' })
```

`refresh` 只回收当前对象进入冷却和移出当前队列；下一位候选人的快速 LLM 生成属于后续独立阶段，必须先经过角色草稿/成年人/Schema 校验后才能另行进入临时候选池。

`start_private_chat` 只接受收藏中的成年人角色。它在受控边界内以玩家和角色的**公开心动名片字段**、公开关键词与本地 `-5…5` 标签权重计算邀请分数，再与角色创建页“互动节奏”中的 `拒绝阈值` 比较：通过时才创建会话；未通过则只留下 `已取消` 状态、移出收藏，不创建会话。灵魂/语音匹配的模型输出先被本地物化为完整成年人角色，再经独立的受控 Patch 创建“已匹配”会话；不读取或复用收藏角色。

## 测试

```powershell
cd 'D:\Dev\AI制卡\约了吗\约了吗小手机'
node --test .\src\mvu\test\mvu-adapter.test.mjs
```

## 真机待验证

本目录依据本地 `C1` / `B1` 类型声明、`D5`、`second-api` 与 `statusbar` 资料编写；仍必须在目标 SillyTavern + TavernHelper + MVU 环境确认：

1. `Mvu` 的全局初始化时序，以及扩展激活后 latest message scope 的实际可读性；
2. `parseMessage()` 对 RFC `add / replace / remove / move` JSONPatch 封套的真实解析、Schema 拒绝和无变更返回值；
3. `replaceMvuData(newData, scope)` 的 message-scope 持久化及刷新/切聊天隔离；
4. `eventEmit(Mvu.events.VARIABLE_UPDATE_ENDED, newData, oldData)` 与 `SillyTavern.getContext().eventSource.emit(...)` 在目标版本中的实际事件可见性；
5. 扩展 UI 接线、按钮竞争/旧快照、状态栏刷新与卸载生命周期。

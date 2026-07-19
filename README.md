# 约了吗小手机 v0.1.1（阶段 19 静态验证）

这是现代现实都市「约了吗」MVU 角色卡的配套 SillyTavern UI 扩展。软件层承担推荐、线上短文本私聊、匹配、群组浏览、角色创作与面基约定；现实见面、约会及复杂长文本剧情仍由酒馆正文推进。

当前成果已通过本地静态检查与 Node 回归，尚未完成 SillyTavern 真机验收，不得据此宣称已在酒馆内发布可用。

> 连接预设、提示词预设和功能绑定可保存在本浏览器；API Key 只在当前扩展会话解锁，不保存、导出、写入 MVU 或回显。真实认证、CORS、模型接口与扩展生命周期仍待目标酒馆版本验证。

## 当前已实现

- 悬浮圆形入口、可关闭小手机窗口，以及首页 / 匹配 / 消息 / 群组 / 我的五导航。
- SFW / NSFW 五击门；内容尺度不替代明确同意、成年人校验或边界记录。
- 推荐候选公开卡的喜欢、刷新、收藏、不喜欢；刷新与空角色池的“快速随机创建候选人”均调用 `recommendation_refresh` 绑定的快速模型。
- 空池快速创建采用两次最新状态读取：模型草稿仅驻留内存，只有队列仍为空且资料通过成年/结构校验后，才以一次受控 RFC 6902 Patch 写入 `npc_llm_*` 候选、当前队列和角色计数器。
- 公开标签长期偏好、本地双层匹配、匹配会话与短文本私聊；模型只提出受限关系变化，程序校验并提交。
- 灵魂匹配生成公开标签权重草稿，须玩家确认后保存；文字匹配只作本次筛选建议，不写长期状态。
- 群组以小程序中心提供聊天群与论坛：均只读取明确成年对象的公开投影，并分别调用独立绑定生成内存草稿；无发布按钮、无 MVU 写入。“进入已有私聊”也只做本地导航。
- 面基在已匹配前提下生成并保存约定记录，再仅填入 `#send_textarea`；扩展不会自动点击或发送，玩家发送后由正文推进现实剧情。
- 角色编辑器与模板库：手动创建、导入导出、占位 / URL / 本地压缩头像、AI 完善补全与 AI 完整创作。AI 只返回内存草稿，玩家审核并点击“验证并登记”后才进入受控 Patch。
- OpenAI-compatible 非机密连接预设、Worldbook 风格提示词预设（`depth / order / position / enabled / content`）、模型手动拉取及按功能绑定。API Key 仅模块内存解锁。

## 状态、隐私与写入边界

- 所有可注册、匹配、私聊和面基对象必须明确成年；NSFW 不自动等于同意。
- 普通推荐、匹配、群组只读公开资料；私聊仅在已匹配时读取允许的仅好友资料；隐藏资料、实际年龄、内部阈值、关系分、私密草稿和 API Key 不得进入普通 DOM、导出预览或模型错误信息。
- UI 不能直接写 MVU 状态。唯一提交链为：

```text
readLatestState → build…Patch → validateControlledPatchAgainstState
→ Mvu.parseMessage → Mvu.replaceMvuData → VARIABLE_UPDATE_ENDED
```

- 空池快速创建、普通刷新、角色登记、匹配、私聊、灵魂偏好确认和面基记录均使用受控 RFC 6902 JSONPatch；禁止任意 UI/模型提供 JSON Pointer、UID 或 Patch。

## MVU 运行前置与安全降级

- 本扩展的完整读写能力要求当前聊天已加载兼容的 MagVarUpdate/MVU 提供方，且 `window.Mvu` 至少暴露 `getMvuData`、`parseMessage`、`replaceMvuData` 及对应的 `Mvu.events.VARIABLE_UPDATE_ENDED`。
- `JS-Slash-Runner` / `TavernHelper.waitGlobalInitialized(''Mvu'')` 只提供全局就绪通知，**不是** MVU 实现本身；它不能代替上述 provider。
- 扩展激活时若 MVU 尚未出现，会先保持只读的“MVU 状态暂不可读”界面；若已存在的 provider 随后发布可读 `Mvu`，扩展只会重新绑定监听并刷新投影，**不会**因等待动作写入任何聊天状态。
- 不可用或不完整时，扩展不会退回 `TavernHelper.insertOrAssignVariables`、通用变量 API 或直接改聊天元数据。所有状态变更仍必须走本文定义的 MVU 受控链。
- 角色卡中的远程脚本导入属于第三方网络代码。仅在使用者明确同意并确认其来源、版本与网络策略后启用；本扩展自身不会主动加载、替换或下载 MVU provider。
## 目录

```text
约了吗小手机/
├─ manifest.json / index.js / style.css
├─ src/
│  ├─ app-shell.js                 # 悬浮窗口、五导航、空池快速创建
│  ├─ action-bridge.js             # UI → MVU 唯一写入边界
│  ├─ dom.js / ui-model.js         # 安全 DOM 与公开投影
│  ├─ mvu/                         # 读取、受控 Patch、宿主适配
│  ├─ llm/                         # 会话 Key 与 OpenAI-compatible 客户端
│  ├─ settings/                    # 非机密设置、预设与功能绑定
│  ├─ recommendation/              # 候选校验、推荐、双层评分、灵魂/文字匹配
│  ├─ chat/                        # 私聊与面基交接
│  ├─ groups/                      # 只读公开群组浏览
│  ├─ characters/                  # 模板、头像、编辑器、AI 创作
│  ├─ test-support/minidom.mjs     # 聚焦 DOM 回归支撑
│  └─ */test/                      # Node 回归
└─ scripts/static-check.mjs
```

## 安装与启动（SillyTavern v1.18.0+）

> 下面是文件安装说明，不代表已完成目标酒馆版本的真机验收；安装后仍须按本文末尾的真机清单逐项测试。

1. 关闭或重载 SillyTavern，复制整个 `D:\Dev\AI制卡\约了吗\约了吗小手机` 目录到以下其中一个扩展目录，并将目标文件夹命名为 `yuelema-phone-extension`：
   - 用户作用域（推荐）：`<SillyTavern>\data\<用户句柄>\extensions\yuelema-phone-extension\`
   - 全局作用域：`<SillyTavern>\public\scripts\extensions\third-party\yuelema-phone-extension\`
2. 确认目标目录根部直接包含 `manifest.json`、`index.js`、`style.css` 与 `src/`，不要多套一层同名文件夹。
3. 重启 SillyTavern 或在扩展管理页面重新加载，确认“约了吗小手机”已启用。此扩展声明最低版本为 **SillyTavern v1.18.0**，以使用已核对的 `activate / disable / delete` lifecycle hooks。
4. 在角色管理页面导入 `D:\Dev\AI制卡\约了吗\角色卡源\dist\约了吗_MVU_v0.1.1.json`，并为这张卡**新开聊天**；不要用旧聊天的变量状态代替初始化验收。
5. 首次使用时在“我的 → 设置”配置 OpenAI-compatible 连接预设、提示词预设和功能绑定；API Key 每次仅本会话解锁。禁用或删除扩展时，`disable / delete` hook 会立即清除内存中的已解锁 Key；非机密预设与模板仍按本地浏览器存储策略保留。

## 本地验证（2026-07-19）

```powershell
Set-Location 'D:\Dev\AI制卡\约了吗\约了吗小手机'
npm run check
node --test
node --input-type=module -e "await import('./index.js'); console.log('production import graph resolves')"
```

实际结果（阶段 13）：`node --check .\\index.js` 与 `npm run check` 通过；全量 `node --test` **116/116** 通过；生产 ESM import 图通过。

定向 DOM 回归还覆盖：AI 草稿载入不自动登记/写 MVU 且不把私密草稿送入补全请求；群组只渲染公开资料、已有私聊入口只导航；空池第三入口实际调用快速推荐桥接，而非保留占位提示。

## 仍待 SillyTavern 真机验证

1. MVU 初始化、Zod Schema、中文 JSON Pointer、对象 `add` / 数组 `/-` / `move` 与 `parseMessage → replaceMvuData → VARIABLE_UPDATE_ENDED` 的实际持久化、刷新、切聊天隔离。
2. 新开聊天空池 → 会话 Key 解锁 → 快速模型 → 滑屏/候选显示；失败、取消、CORS、模型未绑定和重复点击时不得半写入或写错聊天。
3. 私聊、群组、角色 AI 草稿、面基输入框填充、悬浮窗口、安全区、软键盘、扩展卸载/重载的真实 DOM 与移动端表现。
4. Prompt Viewer、控制台、错误面板、导出、最终 DOM 和请求上下文中的 API Key、隐藏层、仅好友层、关系分、阈值、会话内部数据零泄露。





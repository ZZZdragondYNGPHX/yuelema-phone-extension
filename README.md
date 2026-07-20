# 约了吗小手机 v0.1.3（阶段 25 静态 / Node 验证）

这是现代现实都市「约了吗」MVU 角色卡的配套 SillyTavern UI 扩展。软件层承担推荐、线上短文本私聊、匹配、群组浏览、角色创作与面基约定；现实见面、约会及复杂长文本剧情仍由酒馆正文推进。

当前成果已通过本地静态检查与 Node 回归，尚未完成 SillyTavern 真机验收，不得据此宣称已在酒馆内发布可用。

> 连接预设、提示词预设和功能绑定可保存在本浏览器；API Key 只在当前扩展会话解锁，不保存、导出、写入 MVU 或回显。真实认证、CORS、模型接口与扩展生命周期仍待目标酒馆版本验证。

## 当前已实现

- 悬浮圆形入口、可关闭且支持鼠标/触摸拖动的小手机窗口，以及首页 / 匹配 / 消息 / 群组 / 我的五导航。
- SFW / NSFW 五击解锁门：连续点击“关于软件”五次只显示右侧点击式开关，实际切换由开关通过受控 MVU 管线完成；内容尺度不替代明确同意、成年人校验或边界记录。
- 首页只保留毛玻璃候选角色卡：公开资料、关键词与喜欢 / 不喜欢 / 收藏 / 刷新四个操作；空池卡片的刷新调用 `recommendation_refresh` 绑定的快速模型。
- 角色创建入口已迁移到“我的”；首页候选卡预留 `candidate-background` 图片背景槽和关键词权重数据口，但当前不创建图片元素、不读取头像 URL、不发图片请求。
- 公开标签长期偏好、本地双层匹配、匹配会话与短文本私聊；模型只提出受限关系变化，程序校验并提交。
- 个性化内容推荐设置位于“设置 → 隐私权限设置 → 个性化内容推荐管理 → 个性化内容偏好”；关键词权重只保存当前设备偏好。灵魂匹配和语音匹配仅以该权重生成内存中的公开候选档案，不写入 MVU；语音匹配产生的同名临时权重优先于本地权重，原始输入不会持久化或显示。
- 群组以小程序中心提供聊天群与论坛：均只读取明确成年对象的公开投影，并分别调用独立绑定生成内存草稿；无发布按钮、无 MVU 写入。“进入已有私聊”也只做本地导航。
- 面基在已匹配前提下生成并保存约定记录，再仅填入 `#send_textarea`；扩展不会自动点击或发送，玩家发送后由正文推进现实剧情。
- “我的”提供恋爱氛围的角色创建界面与模板库：手动创建、导入导出、占位 / URL / 本地压缩头像、AI 完善补全与 AI 完整创作。AI 只返回内存草稿，玩家审核并点击“验证并登记”后才进入受控 Patch。
- OpenAI-compatible 非机密连接预设、提示词预设（`depth / order / position / enabled / content`）、模型拉取及按功能绑定。连接预设与提示词预设字段相互隔离；API Key 仅模块内存解锁。
- 首页、灵魂匹配、语音匹配、消息、聊天群、论坛、AI 补全与完整创作均可通过右上角“选项”分别绑定连接／提示词预设；旧角色创作绑定会兼容迁移到两个新入口。
- 提示词预设使用 Prompt Manager 风格的条目树：根节点是预设，下面按 `before_character_definition` / `after_character_definition` 分支展示条目；叶节点显示启用状态、depth、order 和正文摘要，可直接编辑、启停、上下移动。导入导出格式保持兼容。
- 连接预设支持 `json` 普通响应、`stream` SSE 真流式和 `pseudo_stream` 假流式。拉取模型列表使用独立的宽松探测校验，Model 可留空；正式保存和对话请求仍要求已选模型。SSE 会处理跨 chunk 分行、`[DONE]`、文本数组、超时、取消和 2 MiB 响应上限；假流式只改变完整响应后的展示元数据，不能绕过服务端输出上限。
- AI 操作处理中、成功、失败提示均提供右上角 `×` 和底部关闭按钮；关闭后迟到的进度、成功或失败不会重新弹窗，成功/失败也会自动收起。

## 状态、隐私与写入边界

- 所有可注册、匹配、私聊和面基对象必须明确成年；NSFW 不自动等于同意。
- 普通推荐、匹配、群组只读公开资料；私聊仅在已匹配时读取允许的仅好友资料；隐藏资料、实际年龄、内部阈值、关系分、私密草稿和 API Key 不得进入普通 DOM、导出预览或模型错误信息。
- UI 不能直接写 MVU 状态。唯一提交链为：

```text
readLatestState → build…Patch → validateControlledPatchAgainstState
→ Mvu.parseMessage → Mvu.replaceMvuData → VARIABLE_UPDATE_ENDED
```

- 空卡刷新、普通刷新、角色登记、匹配、私聊和面基记录均使用受控 RFC 6902 JSONPatch；禁止任意 UI/模型提供 JSON Pointer、UID 或 Patch。

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

## 本地验证（2026-07-20）

```powershell
Set-Location 'D:\Dev\AI制卡\约了吗\约了吗小手机'
npm run check
node --test
node --input-type=module -e "await import('./index.js'); console.log('production import graph resolves')"
```

实际结果（阶段 24）：`npm run check`、全量 `node --test`、生产 ESM import 图与 `git diff --check` 均通过；全量 Node 回归 **189/189** 通过。

定向 DOM 回归还覆盖：子页面左上角返回、问号浮窗视口夹紧、AI 加载/成功/失败弹窗及其关闭生命周期、手机窗口拖动、首页毛玻璃候选卡四按钮、图片背景预留槽、创建角色迁移到“我的”、提示词条目树、连接 Model 为空时的模型列表探测、三种传输模式设置，以及个性化内容推荐设置。该结果不等同于 SillyTavern 真机通过。

## 仍待 SillyTavern 真机验证

1. MVU 初始化、Zod Schema、中文 JSON Pointer、对象 `add` / 数组 `/-` / `move` 与 `parseMessage → replaceMvuData → VARIABLE_UPDATE_ENDED` 的实际持久化、刷新、切聊天隔离。
2. 新开聊天空池 → 会话 Key 解锁 → 快速模型 → 滑屏/候选显示；失败、取消、CORS、模型未绑定和重复点击时不得半写入或写错聊天。
3. 私聊、群组、角色 AI 草稿、面基输入框填充、悬浮窗口、安全区、软键盘、扩展卸载/重载的真实 DOM 与移动端表现。
4. Prompt Viewer、控制台、错误面板、导出、最终 DOM 和请求上下文中的 API Key、隐藏层、仅好友层、关系分、阈值、会话内部数据零泄露。
5. 连接预设分别验证 Model 留空拉取 / 单模型自动选择 / 多模型选择、JSON、SSE 分块与 `[DONE]`、假流式渐显、长输出、超时与取消；确认服务商 CORS 和响应格式兼容。
6. 提示词树在窄屏与触控设备上的分支线、叶节点操作区、编辑器滚动和按钮可达性；所有操作弹窗手动关闭、自动关闭和页面切换后的迟到结果防重弹。
7. 本次仅同步 GitHub 仓库，尚未同步安装副本 `D:\SillyTavern\data\default-user\extensions\yuelema-phone-extension\`；待宿主重载前同步并核对哈希后，再确认“关于软件”显示 0.1.3。





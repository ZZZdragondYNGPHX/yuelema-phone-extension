# 设计系统 2.0 基础组件 API 与 class 合同

> 本文是 **style.css 分区重写的唯一依据**（策划书 §3.5、§3.6）。组件只定 DOM 结构、class 名与行为；
> 尺寸、配色、圆角、动效全部由 style.css 的 `components` 分区按本合同提供，**JS 不写任何内联样式**。
>
> 通用约定：
> - 所有工厂函数签名的 options 都接受 `documentRef?: Document`（缺省 `globalThis.document`），供 MiniDOM 测试注入。
> - class 命名：`yl-` 前缀 + BEM（块 `yl-x`、元素 `yl-x__y`、修饰 `yl-x--z`）；状态一律 `is-*`。
> - 参数校验 fail fast：抛 `TypeError`，message 为 snake_case 错误码（下表逐组件列出）。
> - 回调（onClick/onChange/onContextMenu/onRequestClose）内部 try/catch，宿主异常不破坏组件。
> - 手机端/电脑端形态差异**完全由 CSS 按 `.yl-phone-extension[data-ui-layout="…"]` 门禁决定**，本目录任何组件都不读布局状态（铁律：布局切换只翻 data 属性不重渲）。
> - 无 innerHTML / 无网络 / 无持久化 / 无 console；SVG 经 `createElementNS` 本地内联。

---

## 1. Button — `src/ui/button.js`

```js
createButton({
  documentRef?, 
  variant?: 'primary'|'tonal'|'ghost'|'icon'|'danger',   // 缺省 'primary'
  label?: string,        // 非 icon 变体必填（非空）
  icon?: string|null,    // 图标名（icon.js 在册名）；icon 变体必填
  onClick?: (event) => void,
  disabled?: boolean,    // 之后可直接读写返回节点的 .disabled
  ariaLabel?: string,    // icon 变体必填
}) => HTMLButtonElement
```

DOM 结构：

```
button.yl-btn.yl-btn--{variant} [type=button] [aria-label?]
├─ svg.yl-ui-icon.yl-btn__icon [data-icon={icon}]     ← 仅当传 icon
└─ span.yl-btn__label                                  ← 仅非 icon 变体
```

class 清单：

| class | 含义 / CSS 期望 |
|---|---|
| `yl-btn` | 基类：inline-flex、居中、pill 圆角、120ms 按压反馈、disabled 降透明 |
| `yl-btn--primary` | 品牌渐变胶囊，高 48px，白字 |
| `yl-btn--tonal` | 主色 10% 底、主色文字 |
| `yl-btn--ghost` | 无底、主文色，hover 轻底 |
| `yl-btn--icon` | 纯图标钮：**44×44 热区**，图标 20px 居中，无 label |
| `yl-btn--danger` | danger 语义色 |
| `yl-btn__icon` | 按钮内图标（与 `yl-ui-icon` 并存） |
| `yl-btn__label` | 文本 span |

状态：原生 `:disabled`（无 is-* class）。行为：click 触发 onClick，`disabled` 时显式拦截（MiniDOM 下也成立）。

错误码：`yl_button_document_required` / `yl_button_variant_invalid` / `yl_button_label_required` / `yl_button_icon_aria_label_required` / `yl_button_icon_name_required`。

a11y：真实 `<button type="button">`（原生焦点与 Enter/Space）；icon 变体强制 `aria-label`。

---

## 2. ListRow — `src/ui/list-row.js`

```js
createListRow({
  documentRef?,
  avatar?: Node|null,          // 头像节点（如 avatar-view 产物），null 不渲染头像槽
  title: string,               // 必填非空
  subtitle?: string,
  meta?: {
    time?: string,             // 右上时间文本
    badge?: number,            // 未读数，<=0 不渲染；>99 显示 99+
    chevron?: boolean,         // 右侧箭头
    chips?: Array<string|Node> // 字符串自动包 createTagChip；节点原样透传
  } | null,
  onClick?: (event) => void,
  onContextMenu?: (event) => void,  // 触发前 preventDefault（供置顶/已读菜单）
}) => HTMLDivElement
```

DOM 结构（可选项不满足时**整个容器不渲染**，无空壳）：

```
div.yl-row [role=button] [tabindex=0] (.is-unread ← badge>0)
├─ div.yl-row__avatar                 ← 仅当 avatar
│  └─ {avatar 节点原样}
├─ div.yl-row__main
│  ├─ div.yl-row__title
│  └─ div.yl-row__subtitle            ← 仅当 subtitle 非空
└─ div.yl-row__meta                   ← 仅当 time/chips/badge/chevron 至少一项
   ├─ span.yl-row__time               ← 仅当 time
   ├─ span.yl-row__chips              ← 仅当 chips 非空
   │  └─ span.yl-chip.yl-chip--tag …（或透传节点）
   ├─ span.yl-badge.yl-badge--unread  ← 仅当 badge>=1
   └─ svg.yl-ui-icon.yl-row__chevron [data-icon=chevron_right] ← 仅当 chevron
```

class 清单：`yl-row` / `yl-row__avatar` / `yl-row__main` / `yl-row__title` / `yl-row__subtitle` / `yl-row__meta` / `yl-row__time` / `yl-row__chips` / `yl-row__chevron`；状态 `is-unread`（CSS 期望：title/subtitle 加粗、徽章可见）。

CSS 期望：横向 flex，main 弹性收缩、单行截断；meta 纵向右对齐（time 上、badge/chevron 下）；头像槽 52px（消息）/48px（通用）由页面区块细化。

行为 / a11y：`div[role=button][tabindex=0]`，自管 Enter 与空格激活（preventDefault）。**刻意不用原生 `<button>`**：行内含块级头像/徽章子树（button 仅允许 phrasing content），且避免"原生 Enter→click"与自管 keydown 双通道重复激活。`contextmenu` 仅在提供 onContextMenu 时注册并 preventDefault。

错误码：`yl_list_row_document_required` / `yl_list_row_title_required`。

---

## 3. Badge / Chip — `src/ui/badge.js`

```js
createUnreadBadge(count, { documentRef? }) => HTMLSpanElement | null
createStatusChip({ documentRef?, text, tone?: 'success'|'warning'|'danger'|'info'|'brand'|'neutral' }) => HTMLSpanElement
createTagChip(text, { documentRef? }) => HTMLSpanElement
```

- 未读徽章：`count` 非有限数或 <1 → 返回 **null**（调用方不渲染）；小数向下取整；>99 → 文本 `99+`。带 `aria-label="{n} 条未读"`。
  结构：`span.yl-badge.yl-badge--unread`（CSS 期望：渐变底白字、pill、min-width 圆点扩展）。
- 状态 chip：`span.yl-chip.yl-chip--status.yl-chip--{tone}`，tone 缺省 `neutral`，未知 tone 抛错。
- 标签 chip：`span.yl-chip.yl-chip--tag`，纯文本无子元素。

class 清单：`yl-badge`、`yl-badge--unread`、`yl-chip`、`yl-chip--status`、`yl-chip--tag`、`yl-chip--success|warning|danger|info|brand|neutral`。

错误码：`yl_badge_document_required` / `yl_chip_text_required` / `yl_chip_tone_invalid`。

---

## 4. SegmentedControl — `src/ui/segmented-control.js`

```js
createSegmentedControl({
  documentRef?,
  segments: Array<{ id: string, label: string }>,  // 非空、id 唯一
  activeId?: string|null,      // 未知/缺省 → 第一段
  onChange?: (id: string) => void,  // 仅用户交互且值变化时触发
  ariaLabel?: string,
}) => { root, element /*=root*/, getActiveId(): string, setActive(id): boolean }
```

`setActive` 为程序式切换：更新视觉与 roving tabindex，但**不触发 onChange**；未知 id 返回 false 不变更。

DOM 结构：

```
div.yl-seg [role=radiogroup] [aria-label?]
└─ ×N button.yl-seg__item [type=button] [role=radio]
        [aria-checked=true|false] [tabindex=0|-1] [data-segment-id]
        (.is-active ← 当前段)
   └─ span.yl-seg__label
```

语义选型说明（radiogroup 而非 tablist）：工厂只持有「N 选 1」的选中值，不拥有各页自行渲染的内容面板；tablist 要求每个 tab 以 `aria-controls` 指向真实 `role=tabpanel` 节点，工厂无法保证该配对成立。radio 组无此外部依赖，且「方向键漫游即选中 + roving tabindex」正是原生 radio 的标准键盘模型，与本组件行为一致。

键盘：`ArrowRight/ArrowDown` 下一段、`ArrowLeft/ArrowUp` 上一段（首尾环绕）、`Home/End` 跳边界；漫游即选中并移动焦点，均 preventDefault；无关按键不拦截。点击同样选中。重复选择当前段不重复通知。

class 清单：`yl-seg` / `yl-seg__item` / `yl-seg__label`；状态 `is-active`（CSS 期望：胶囊底滑块、激活段渐变或主色底）。

错误码：`yl_seg_document_required` / `yl_seg_segments_required` / `yl_seg_segment_invalid` / `yl_seg_segment_duplicate`。

---

## 5. BottomSheet — `src/ui/bottom-sheet.js`

```js
createBottomSheet({
  documentRef?,
  title: string,               // 必填非空；同时作面板 aria-label
  content?: Node|null,         // 内容节点，进入 yl-sheet__body
  onRequestClose?: () => void, // 提供时：关闭钮/遮罩/Esc 只发「请求」，由调用方决定何时 close()
  dialogController?: 控制器|null, // src/ui/dialog-controller.js 单例
}) => { root, element /*=root*/, open({ opener? }), close({ restoreFocus?=true }), isOpen(): boolean }
```

DOM 结构（root 由调用方挂载，初始 `hidden`）：

```
div.yl-sheet [hidden] (.is-open ← 打开期间)
├─ div.yl-sheet__scrim                       ← 点击 = 请求关闭
└─ section.yl-sheet__panel [role=dialog] [aria-modal=true] [aria-label={title}]
   ├─ header.yl-sheet__titlebar
   │  ├─ h2.yl-sheet__title
   │  └─ button.yl-btn.yl-btn--icon.yl-sheet__close [aria-label=关闭]
   │     └─ svg[data-icon=close]
   └─ div.yl-sheet__body                     ← content 原样进入
```

**布局铁律**：手机端"底部滑出"、电脑端"居中 Dialog"两种形态完全由 CSS 按
`.yl-phone-extension[data-ui-layout="phone|desktop"] .yl-sheet__panel` 决定（位移/圆角/最大宽度/动画方向），JS 不感知布局、不重渲。CSS 期望：`.yl-sheet` 为全窗覆盖层；phone 下 panel 吸底、上圆角 sheet(24)；desktop 下 panel 居中、卡圆角、max-width ~480px；进出 320ms、reduced-motion 降级。

行为：
- **有控制器**：`open()` → root 显示 + `controller.open(panel, { opener, onRequestClose: 请求关闭 })`（控制器负责 aria-modal、聚焦面板首个可聚焦元素=关闭钮、Tab 焦点环、Escape 关栈顶）；`close()` → `controller.close(panel, { restoreFocus })`（礼貌回焦 opener）后隐藏 root。controller.close 不回调 onRequestClose，与 close() 无递归（范式同 image-manager-panel）。
- **无控制器**：降级为 root.hidden / `is-open` 切换；无焦点陷阱与 Esc（由调用方自理）。
- 关闭路由统一：关闭钮 / 遮罩点击 /（控制器）Escape → 有 onRequestClose 只通知；否则直接 close()。open/close 幂等；已关闭状态下遮罩/关闭钮不再发请求。

错误码：`yl_sheet_document_required` / `yl_sheet_title_required`。

---

## 6. EmptyState — `src/ui/empty-state.js`

```js
createEmptyState({
  documentRef?,
  variant?: 'inbox'|'search'|'heart',   // 缺省 'inbox'
  title: string,                        // 必填非空
  hint?: string,
  action?: { label, onClick?, variant?='tonal', icon?, ariaLabel? } | null,  // 透传 createButton
}) => HTMLDivElement
```

DOM 结构：

```
div.yl-empty.yl-empty--{variant}
├─ div.yl-empty__art
│  └─ svg.yl-empty__svg [viewBox="0 0 96 96"] [stroke=currentColor] [stroke-width=3]
│       [aria-hidden=true] [focusable=false] [data-illustration={variant}]
├─ h3.yl-empty__title
├─ p.yl-empty__hint                          ← 仅当 hint 非空
└─ button.yl-btn.yl-btn--{v}.yl-empty__action ← 仅当 action
```

内置本地插画（全部内联 path，无网络）：`inbox`=收件托盘+飘落线、`search`=放大镜+星芒、`heart`=大心+两颗星芒。插画 96 viewBox / stroke 3，取 currentColor，CSS 可用 `yl-empty__art` 控制尺寸与次文色。

class 清单：`yl-empty`、`yl-empty--inbox|search|heart`、`yl-empty__art`、`yl-empty__svg`、`yl-empty__title`、`yl-empty__hint`、`yl-empty__action`。CSS 期望：垂直居中大留白、title 用 title 级字号、hint 用 caption 次文色。

错误码：`yl_empty_document_required` / `yl_empty_variant_invalid` / `yl_empty_title_required`。

---

## 7. Skeleton — `src/ui/skeleton.js`

```js
createSkeleton({
  documentRef?,
  variant?: 'candidate-card'|'post'|'list-row',  // 缺省 'list-row'
  count?: number,   // 整数 >=1，>12 收敛为 12
}) => HTMLDivElement   // 根节点 aria-hidden="true"
```

DOM 结构：

```
div.yl-skeleton.yl-skeleton--{variant} [aria-hidden=true]
└─ ×count div.yl-skeleton__item.yl-skeleton__item--{variant}
   ├─ (candidate-card) media → avatar → lines[line, line, line--short]
   ├─ (post)           avatar → lines[line--half, line, line, line--short] → media
   └─ (list-row)       avatar → lines[line, line--short]
```

原子块：

| class | 含义 |
|---|---|
| `yl-skeleton` | 容器；CSS 提供闪烁/呼吸动画（reduced-motion 降级为静态） |
| `yl-skeleton--candidate-card` / `--post` / `--list-row` | 变体布局 |
| `yl-skeleton__item`（+ `__item--{variant}`） | 单条占位卡 |
| `yl-skeleton__avatar` | 头像圆占位 |
| `yl-skeleton__lines` | 文本条组容器 |
| `yl-skeleton__line` | 全宽文本条 |
| `yl-skeleton__line--short`（≈40%）/ `yl-skeleton__line--half`（≈55%） | 短条修饰 |
| `yl-skeleton__media` | 媒体块占位（候选卡大图 / 帖子配图） |

错误码：`yl_skeleton_document_required` / `yl_skeleton_variant_invalid` / `yl_skeleton_count_invalid`。

---

## 8. Icon 追加 — `src/ui/icon.js`（既有 API 未动）

`createUiIcon(documentRef, name, { className='yl-ui-icon', size=20, strokeWidth=1.8 })` 保持不变；
所有图标 24 viewBox / stroke 1.8 / currentColor / `fill=none` / `aria-hidden` / `data-icon={name}`；未知名回退 `profile`。

本轮**新增**图标名（策划书 §3.4）：

| 名称 | 用途 |
|---|---|
| `logo` | 心形对话气泡，替代 launcher 文字「约」与品牌位 |
| `grip` | 六点拖动柄，替代 ⠿ |
| `pin` | 置顶图钉（消息置顶标记/菜单） |
| `search` | 搜索（消息页头、XP 搜索） |
| `plus` | 私聊输入区「+」、通用新增 |
| `hearts` | 双心（匹配成功/恋爱动画基元，替代 ♥∿∿∿） |

§3.4 其余需求已有在册名，直接复用：`more_vertical`（⋮）、`send`（纸飞机）、`close`（失败 ×/关闭）、`chevron_left/right`、`refresh`。空态插画 3 款不在 icon.js（尺度不同），由 EmptyState 内置。

---

## 9. 全量 class 名索引（style.css components 分区速查）

```
yl-btn  yl-btn--primary  yl-btn--tonal  yl-btn--ghost  yl-btn--icon  yl-btn--danger
yl-btn__icon  yl-btn__label
yl-row  yl-row__avatar  yl-row__main  yl-row__title  yl-row__subtitle
yl-row__meta  yl-row__time  yl-row__chips  yl-row__chevron        [状态] is-unread
yl-badge  yl-badge--unread
yl-chip  yl-chip--status  yl-chip--tag
yl-chip--success  yl-chip--warning  yl-chip--danger  yl-chip--info  yl-chip--brand  yl-chip--neutral
yl-seg  yl-seg__item  yl-seg__label                                [状态] is-active
yl-sheet  yl-sheet__scrim  yl-sheet__panel  yl-sheet__titlebar
yl-sheet__title  yl-sheet__close  yl-sheet__body                   [状态] is-open（root，另有 [hidden]）
yl-empty  yl-empty--inbox  yl-empty--search  yl-empty--heart
yl-empty__art  yl-empty__svg  yl-empty__title  yl-empty__hint  yl-empty__action
yl-skeleton  yl-skeleton--candidate-card  yl-skeleton--post  yl-skeleton--list-row
yl-skeleton__item  yl-skeleton__item--candidate-card  yl-skeleton__item--post  yl-skeleton__item--list-row
yl-skeleton__avatar  yl-skeleton__lines  yl-skeleton__line
yl-skeleton__line--short  yl-skeleton__line--half  yl-skeleton__media
yl-ui-icon（既有，图标默认类）
```

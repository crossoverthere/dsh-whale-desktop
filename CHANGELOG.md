# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.1] - 2026-09-27

### 变更

- **托盘菜单恢复原有内容，并保留新增的「设置…」。**
  0.4.0 里我把托盘精简成"显示桌宠 / 设置… / 退出"，理由是"避免配置在两处各有一套状态"。
  **这个理由站不住**：所有改动都走 `setScale` / `setAlwaysOnTop` / `setAutoLaunch` /
  `setFollowDsh` / `setVisible` 这些 setter，而它们末尾都会调用 `refreshTrayMenu()`，
  托盘菜单每次重建都重新读 `config` —— 同步本来就是成立的。

  现在托盘为：显示桌宠 / **设置…** / 总是置顶 / 跟随 DSH 工作状态 / 开机自启 /
  大小 ▸ / 重置到默认位置 / 重新加载页面 / 打开数据目录 / 打开日志 / 退出。
  设置窗口内容不变。

- `settings:probe` 增加一条断言：**从设置窗口改「总是置顶」后，托盘菜单对象的
  `checked` 必须同步**——直接读 `trayMenu.items` 里那一项，而不是重新构建模板来比对
  （后者只能证明 config 变了，证明不了托盘刷新了）。现在共 13 项断言。

## [0.4.0] - 2026-09-27

### 变更：三处入口按职责重新划分

| 入口 | 只放什么 |
| --- | --- |
| 桌宠右键菜单 | **只放"对她做的事"**：投喂 / 戳一下 / 夸夸 / 两个小游戏 / 回到原位 |
| 托盘右键菜单 | **全局动作**：显示桌宠 / 设置… / 退出 |
| 设置窗口 | **所有可配置项**，按 4 类展示 |

- **「打开看板娘设置」从桌宠菜单里摘掉了。** 它属于应用级配置，不是"和她互动"。
  壳层在菜单出现时移除该项（`stripNonInteractionItems`）；只有当页面上**确实存在
  DSH 的设置入口**时才不摘 —— 将来若把页面嵌回 DSH，行为自动回到上游原样。
- **托盘新增「设置…」**，点击打开独立设置窗口。
- **托盘不再重复放置顶 / 跟随 DSH / 开机自启 / 缩放 / 重置位置** —— 它们统一进设置窗口。
  同一项在两处各有一套状态，迟早对不上（而且托盘的勾选状态不会随设置窗口变化刷新）。

### 新增：设置窗口分类化

| 分类 | 项 |
| --- | --- |
| 看板娘 | 看板娘 / 台词气泡 / 粒子效果（走 localStorage） |
| 窗口与状态 | 总是置顶 / 跟随 DSH 工作状态 / 开机自启 |
| 大小与位置 | 大小（80%–150%）/ 重置到默认位置 |
| 维护 | 重新加载页面 / 打开数据目录 / 打开运行日志 |

- 窗口改为**双列布局**（564×586）：单列排下来接近 900px，太高了。
- 壳配置经新增的 `src/settings-preload.js` 走 IPC（`shell:get-config` /
  `shell:set-config` / `shell:reset-position` / `shell:open-path` / `shell:app-info`）；
  桌宠偏好仍然只靠同源 `localStorage`。
- 页脚显示版本与 Electron 版本。

### 验证

`npm run settings:probe` 扩到 **12 项断言**：菜单分工 2 项、托盘入口 2 项、
设置窗口结构 3 项、渲染 3 项（含像素级白屏回归）、配置往返 1 项、面板关闭 1 项。

## [0.3.1] - 2026-09-27

### 修复

- **设置窗口打开后一片空白，点一下窗口才显示内容。**

  根因：桌宠窗口是**整屏 + 置顶**的，Windows 上 Chromium 的"原生窗口遮挡检测"
  会把设置窗口判定为**被完全遮住**，于是**停止为它出帧** —— 直到出现交互强制重绘。
  这是"桌面挂件类 Electron 应用再开一个窗口"的典型踩坑。

  三处一起改：

  1. 启动时追加 `--disable-features=CalculateNativeWinOcclusion`。
     **追加而非覆盖**，避免踩掉 Electron/Chromium 自己设的 disable-features。
  2. 设置窗口改为 `show: false` + `ready-to-show` 后再显示（等首帧就绪），
     并 `setAlwaysOnTop(true, 'screen-saver')` 压在整屏桌宠之上；
     失焦时自动撤掉置顶，免得一直浮在别的应用上面。
  3. 显示后主动 `webContents.invalidate()` 再要求重绘一次。

- `npm run settings:probe` 增加两条**像素级断言**：窗口首帧必须非空白、
  失去焦点后仍必须非空白（统计暗像素/彩色像素占比；白屏时两者都接近 0）。
  共 7 项断言。

## [0.3.0] - 2026-09-27

### 新增

- **独立的设置窗口。** 右键 →「打开看板娘设置」现在弹出一个真正的应用窗口
  （`src/pet/settings.html` + `settings.js` + `settings.css`），当前提供三个开关：
  看板娘 / 台词气泡 / 粒子效果。

  它和桌宠页面**同源**（都由 `http://127.0.0.1:<port>` 提供），所以直接共用同一份
  `localStorage`（`whale-moe:*`）—— 页面侧监听 `storage` 事件，再派发上游认识的
  `whale-moe-prefs-change` 让它重新 reconcile，**不需要任何额外 IPC 同步偏好**。

  窗口高度在 `did-finish-load` 后按 `document.body.scrollHeight` 自适应，
  免得不同字体/显示缩放下第三个开关被截断。

- **页面内偏好面板终于关得掉了。** 上游那个浮层只能靠齿轮 ⚙ 开合，而齿轮在台词气泡里、
  气泡 4.5 秒后自动隐藏（`bubbleHideAt`），于是面板一旦打开就**没有可点的关闭入口**。
  壳层补了三条退路：
  1. 注入一个 × 按钮（必须用内联样式，上游给 `[data-dsh-whale-prefs] button`
     定了 flex 行样式，会把它撑成一条开关）
  2. 点击面板外关闭 —— 上游给 rootNode 挂了 `stopPropagation`，
     所以"能冒泡到 document 的点击"天然就等于"点在桌宠之外"
  3. Esc 关闭

### 变更

- `npm run menu:probe` 第二阶段断言从"打开页面内面板"改为"弹出独立设置窗口"
- 新增 `npm run settings:probe`：5 项断言（窗口弹出 / 含三个开关 / 高度容得下内容 /
  设置写入被桌宠页面读到 / 页面内面板可关闭），并带截图重试
- 截图助手 `captureTo()`：窗口刚 `setContentSize` 时合成器还没出新帧，
  `capturePage()` 会抛 `UnknownVizError`，现在自动重试，不再中断整条断言链

## [0.2.1] - 2026-09-27

### 修复

- **右键菜单「打开看板娘设置」在桌面模式下点了没反应。**
  上游那一项是去找 **DSH 页面**的设置入口
  （`[data-slot="sidebar.settings"] button` → `[data-slot="settings.trigger"]`
  → 文本"设置"兜底），独立桌面版没有 DSH 页面，必然找不到，于是静默无反应。

  现在壳层在**捕获阶段**判定：页面上确实没有 DSH 入口时，改为打开桌宠
  **自带的偏好面板**（`[data-dsh-whale-prefs]`，也就是齿轮 ⚙ 那个，功能等价）；
  若真有 DSH 入口则不抢，仍交给上游处理。`vendor/whale` 依旧零改动。

- `npm run menu:probe` 增加第二阶段断言：点击该项后偏好面板必须**真的可见**
  （实测 `hidden=false, display=flex, 218x139`），并另存一张截图。

## [0.2.0] - 2026-09-27

### 新增

- **DSH 工作状态联动（恢复上游原有功能）。**
  桌面版不在 DSH 页面里，拿不到上游原本依赖的 DOM 信号，因此改为
  **读取 DSH 会话文件** `~/.dsh/sessions/**/session.vN.jsonl.zstd`
  （多帧拼接的 zstd，只增量解压新增帧），映射为：

  | 会话记录 | 桌宠状态 | 立绘 |
  | --- | --- | --- |
  | `turn/start` `step/start` `assistant/message` `tool/result` `approval/*` | 思考中 | `thinking` |
  | `tool/call` | 工作中（含工具名） | 按工具选 `work-*` |
  | `turn/end` + `reason.kind=completed` | 完成 | `success` |
  | `turn/end` 其它 reason / `tool/result` 带 `data.error` | 出错 | `failure` |
  | 其余 / 忙态下 3 分钟无写入 | 空闲 | `idle-cute` |

  工具名会喂给上游的 `detectToolPose()`，从而按类型换姿势：
  `pwsh/bash → work-slack-phone`、`write/edit → work-meeting`、
  `grep/glob/read → work-idea`、`todo_write → work-idea`，未识别的工具回落到通用 `tool`。

  页面侧由壳层**合成上游认识的 DOM 信号**（`[data-running]` 等），
  `vendor/whale` 依旧一个字不改。

### 新增（可选）

- 托盘菜单「跟随 DSH 工作状态」开关；关掉即刻回到空闲姿势
- `npm run dsh:probe`：验证「状态 → 页面信号 → 上游状态机」整条链，
  打印每一步上游自己认成的 `state`/`pose`/状态签/立绘
- `/__shell/state` 增加 `dsh` 字段（当前读取到的 DSH 状态）

### 修复

- 状态读取器的"忙态超时兜底"曾经**写坏持久状态**：启动时只吃到前若干帧时，
  记录的 `time` 还很旧 → 判定 stale → 把"处在 turn 内"永久清成 false，
  而那个 `turn/start` 早已被消费，后续全是 turn 内记录，再没有东西能恢复它，
  于是永远报空闲。现在 stale 只作为本次判定的派生量，绝不回写状态；
  单轮解帧上限也从 400 提到 4000，启动时一次追平历史。

## [0.1.1] - 2026-09-27

### 修复

- **右键菜单贴屏幕右下角时溢出屏幕。**
  上游 `showContextMenu` 用写死的 180×160 估算菜单尺寸来夹取位置
  （`vendor/whale/dsh-whale-moe.js` 第 610-611 行），但菜单高度随项目数变化，
  实测 8 项就有 292px。
  现在在壳层用**实测 `getBoundingClientRect()`** 把菜单夹回视口内。
  实测（1920×1032 视口）：修复前右溢 14px / 下溢 132px → 修复后均为 **0**。
  修在壳层而不是改上游素材，否则 `npm run sync:upstream` 会把它冲掉。

- **点击穿透判定不再依赖 Windows 的鼠标事件转发。**
  `setIgnoreMouseEvents(true, { forward: true })` 的转发不可靠：实测指针移到
  桌宠身上时页面收不到任何 `mousemove`，导致"压到桌宠才接管鼠标"永远不成立，
  桌宠点不动。改为主进程每 80ms 轮询 `screen.getCursorScreenPoint()` 推给页面。
  回归验证 3/3 PASS。

### 新增

- `npm run menu:probe`：右键菜单越界探针，量出溢出像素并打印 PASS/FAIL + 截图
- `--standalone` / `--port=<n>`：自检实例可跳过单实例锁并使用独立端口，
  避免与常驻桌宠抢锁而**测错对象**（这个坑踩过）
- `/__shell/state` 增加 `petRect.interactive` 与 `petRect.lastMouse` 诊断字段，
  用于区分"鼠标事件没送到"和"DOM 命中判定失灵"

## [0.1.0] - 2026-09-27

### 新增

- 首个可用版本：把 `dsh-whale-musume` 的桌宠本体从 DSH 网页里解放出来，
  做成独立的 Electron 桌面挂件
- 整屏透明置顶窗口 + 点击穿透 + 托盘常驻（显示/隐藏、置顶、开机自启、缩放、重置位置）
- `vendor/whale` 原样保存上游素材，本地服务器把 `/assets/*` 直接映射过去，
  不做字符串替换，上游升级只需覆盖该目录
- `npm run shot`：截图 + DOM 状态 + 位图 alpha 探针
- `npm run verify:shell`：点击穿透自动化验证
- `npm run sync:upstream`：从上游 tag 同步素材（codeload + Node 自带 zlib，无需 git）
- 文档：`README.md`、`docs/DEVELOPMENT.md`、`THIRD-PARTY.md`（上游 MIT 署名）

# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

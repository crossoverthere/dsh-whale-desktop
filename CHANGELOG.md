# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

# 开发文档

## 1. 核心取舍：为什么是"整屏透明窗口"

上游 `dsh-whale-musume` 的桌宠本体是这样工作的（读 `vendor/whale/dsh-whale-moe.js` 可验证）：

- `ensureRoot()` 直接 `document.body.appendChild(rootNode)`，根节点 CSS 是
  `position: fixed; z-index: 60; pointer-events: none`
- 位置来自 `localStorage` 的 `whale-moe:floatX` / `floatY`，**用的是视口坐标**
- 拖拽、右键菜单、齿轮设置面板、天气画布等全在它自己手里

由此有两条路：

| 方案 | 做法 | 问题 |
| --- | --- | --- |
| 窗口 = 桌宠大小 | 窗口跟着桌宠走，用 `setPosition` 模拟拖拽 | 上游把位置存在视口坐标里、拖拽逻辑也在它内部，一拖就被窗口边缘裁掉；要接管它的拖拽等于改上游 |
| **窗口 = 整个工作区（本项目）** | 铺满工作区，保持透明，默认点击穿透 | 需要一个可靠的"指针压到桌宠时才接管鼠标"的判定 |

选了后者：**上游一个字都不用改**，定位、拖拽、菜单、存档全部保持原行为。

## 2. 数据流

```
Electron 主进程 (src/main.js)
  ├─ 启动本地服务器 (src/server.js)  http://127.0.0.1:38911
  │    ├─ /                → src/pet/index.html
  │    ├─ /assets/*        → vendor/whale/*      ← 上游原样
  │    ├─ /pet/*           → src/pet/*
  │    └─ /__shell/state   → 自检端点（JSON）
  ├─ 创建铺满工作区的透明置顶窗口，默认 setIgnoreMouseEvents(true, {forward:true})
  └─ 托盘 / 全局快捷键 / IPC

渲染进程
  ├─ index.html 按顺序引入：上游 CSS → 壳 CSS → 上游状态机 → 上游桌宠 → 壳胶水
  └─ shell.js 用 elementFromPoint 判定指针是否压到桌宠，
             变化时 ipcRenderer.send('shell:interactive', v)
```

## 3. 为什么不需要改上游

上游脚本里的资源路径是写死的绝对路径：

```js
var ASSET_ROOT = "/assets/generated/";
var ANIM_ROOT  = "/assets/anim/";
fetch("/assets/peek-calibration.json")
```

上游 DSH 插件的做法是：取脚本文本 → 字符串替换路径 → 注入页面。
本项目换了个思路：**让本地服务器把这些路径原样映射到 `vendor/whale/`**，于是：

- 不需要字符串替换，也就不会因为上游改了变量名/格式而失效
- 上游升级 = 覆盖 `vendor/whale/`，壳不动
- 走 `http://127.0.0.1:38911` 而不是 `file://`：`file://` 是不透明源，
  `localStorage` 不可靠，而养成存档全在 `localStorage` 里

## 4. 点击穿透是怎么做到的

窗口默认 `setIgnoreMouseEvents(true, { forward: true })`，鼠标事件全部穿到桌面，
只在指针压到桌宠身上时才临时切回"接收鼠标"。

**判定信号来自主进程轮询，不是页面的 `mousemove`。** 这是踩坑后的结论：

> Windows 上 `forward: true` 的鼠标转发并不可靠。实测把指针移到桌宠身上，
> 页面**收不到任何 `mousemove`**（`/__shell/state` 里的 `petRect.lastMouse`
> 始终为空），于是"压到桌宠才接管鼠标"永远不成立 —— 点击穿透看起来正常，
> 但桌宠永远点不动。
> 注：真实物理鼠标有时能触发（低层鼠标钩子），合成移动（`SetCursorPos`）不行，
> 所以这个 bug 时有时无，极难复现。**不要依赖它。**

现在的实现（`src/main.js` 的 `startCursorPolling`）：

```js
// 每 80ms 把「屏幕光标 - 窗口原点」推给页面
const point = screen.getCursorScreenPoint();
const bounds = win.getBounds();
win.webContents.send('shell:cursor', { x: point.x - bounds.x, y: point.y - bounds.y });
```

页面侧（`src/pet/shell.js`）拿到坐标后做一次命中判定：

```js
const el = document.elementFromPoint(x, y);
const hit = el && el !== document.documentElement && el !== document.body;
```

能这么写，是因为上游 CSS 已经把容器设成 `pointer-events: none`、
可交互部件设成 `auto`，所以"命中到 html/body 以外"就等价于"压到桌宠了"。

页面的 `mousemove` 监听仍保留（能工作时更灵敏），但**只是快路径**，
两条路径都汇进同一个 `applyCursor()`；判定正确性完全由轮询保证。

> 注意：`shell.css` **绝不能**给 `body` 设 `pointer-events: none`。
> 该属性会被子元素继承，上游弹到 body 上的菜单会一起变成不可点。

### 自检实例是封闭的

`--standalone` 跳过单实例锁，`--port=<n>` 覆盖监听端口。
`npm run verify:shell` 用独立端口起自己的实例 —— 否则若你已经开着一只常驻桌宠，
新实例会被单实例锁顶掉，脚本就会**误测到那只旧的**并给出假结论（这个坑也踩过）。

## 4.5 右键菜单越界修正（壳层修补上游 bug）

上游 `showContextMenu` 用**写死的估算尺寸**夹取菜单位置
（`vendor/whale/dsh-whale-moe.js` 第 610-611 行）：

```js
menu.style.left = Math.min(x, root.innerWidth - 180) + "px";
menu.style.top  = Math.min(y, root.innerHeight - 160) + "px";
```

宽度 180 恰好等于菜单 CSS 的 `width`，但**高度不是常数**：菜单项数量随
"小游戏"开关变化，实测 8 项就有 **292px** 高。同一文件里其它浮层
（第 473、2078 行）用的是实测 `offsetWidth/offsetHeight`，这处是漏改的。

后果：把鲸鱼娘放到屏幕右下角再右键，菜单位置被夹到 `(innerWidth-180, innerHeight-160)`，
右下两侧同时溢出。实测数据（1920x1032 视口、8 项菜单）：

| | left | top | right | bottom | 右溢 | 下溢 |
| --- | --- | --- | --- | --- | --- | --- |
| 修复前 | 1740 | 872 | 1934 | 1164 | 14px | 132px |
| 修复后 | 1718 | 732 | 1912 | 1024 | 0 | 0 |

**修在壳层（`src/pet/shell.js`）而不是改上游素材**：改 `vendor/whale/` 会被
`npm run sync:upstream` 冲掉。壳里用 `MutationObserver` 盯住
`[data-dsh-whale-context]` 的出现与后续 `style` 变化，再用 **实测 `getBoundingClientRect()`**
把菜单夹回视口内（保留 8px 边距）；视口比菜单还小时退化为贴左上角，
不会产生负坐标。

回归验证：

```bash
npm run menu:probe   # 在右下角模拟右键，量出溢出像素并打印 PASS/FAIL
```

## 5. 调试手段（看不到屏幕时靠这些）

```bash
npm run shot        # 启动 → 等 5 秒 → 截图 → 打印 DOM 状态 → 退出
npm run shot -- --shot-delay=8000 --shot=D:\tmp\a.png
npm run menu:probe  # 右键菜单越界探针（打印溢出像素 + PASS/FAIL + 截图）
npm run verify:shell   # 自动验证点击穿透（会真的移动指针，跑完还原）
```

- 截图：`tmp/shot.png`；同时日志里会打印
  - `[shot] alpha probe` —— **直接读原始位图的 alpha**。
    透明窗口用 `capturePage()` 存出来的 PNG，用看图软件打开常常显示成白底，
    那只合成显示，不代表窗口不透明；`a=0` 才是真相。
  - `[shot] dom` —— 根节点模式、矩形、立绘路径、是否加载成功、localStorage 键
- 运行时状态：`GET http://127.0.0.1:38911/__shell/state`
  返回 `interactive / ignoreMouseEvents / petRect / cursor / workArea` 等
- 日志文件：`%APPDATA%\dsh-whale-desktop\shell.log`
  （主进程 + 渲染进程 console + 页面 error 都会汇总到这里）
  托盘菜单 →「打开日志」可直接打开

### 已知环境坑

- **Windows PowerShell 5.1 读 `.ps1` 按 ANSI**：含中文的脚本必须存成
  **UTF-8 with BOM**，否则直接解析失败。`scripts/verify-shell.ps1` 就是 BOM 存法。
- **npm 11+ 默认拦截依赖的生命周期脚本**：Electron 的二进制不会自动下载，
  表现为 `node_modules/electron/dist` 不存在。手动补：
  `node node_modules/electron/install.js`
- **Electron 二进制在国内直连 GitHub 常卡死**（缓存里只有 0 字节的
  `electron-download-*`）。用镜像重下：
  ```powershell
  $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  node node_modules/electron/install.js
  ```
- **`git push` 会被重置**，而 `api.github.com` / `codeload` 直连正常：
  push 走的是 `git-receive-pack`，该端点在国内常被掐。
  用 `scripts/push.ps1`（自动判断本机代理），或
  `git -c http.proxy=http://127.0.0.1:7890 push origin main`。
  不要把它写进全局 `git config`，否则代理一关 git 就全废。

## 6. 上游同步

```bash
npm run sync:upstream                 # 取上游最新 release tag
npm run sync:upstream -- v2.1.0       # 指定 tag
npm run sync:upstream -- --from-local # 从已安装的 DSH 插件目录复制（离线）
npm run check:vendor                  # 校验素材完整性
```

同步记录写在 `vendor/upstream.json`。同步脚本用 codeload 压缩包 + Node 自带 zlib
解 tar.gz，**不需要 git、不需要第三方依赖**。

同步后请跑一次 `npm run shot`，确认立绘仍能加载（上游若改了变量名，
`layerLoaded: true` 这条会立刻暴露问题）。

## 7. 打包（待做）

目前是开发态运行。要出免安装 exe 需要加 `electron-builder`：

```bash
npm i -D electron-builder
```

并在 `package.json` 增加 `build` 段（`win.target: portable` / `nsis`）。
注意 `vendor/` 必须打进 asar 或作为 extraResource 一起分发。

## 8. 路线图 / 已知限制

- **工作状态联动**：上游靠 `MutationObserver` 观察 DSH 页面 DOM 来判断"正在跑工具"。
  独立宿主没有那个 DOM，需要另接信号源（DSH 事件流、或本地钩子）。
  壳已预留通道：`preload.js` 暴露了 `onBusy`，主进程可向页面推 `shell:busy`。
- **多显示器**：当前只铺主显示器工作区。
- **全屏应用**：窗口是 `alwaysOnTop` 的整屏透明层，看全屏视频/游戏时建议
  用 `Alt+Shift+W` 或托盘临时隐藏。
- **不参与 DSH 的设置面板**：上游的设置面板是 DSH 客户端插件（`lib/client.js`），
  独立运行时用桌宠自带的齿轮菜单 ⚙，功能覆盖开关/大小/天气/养成数据。

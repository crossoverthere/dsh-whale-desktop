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
npm run menu:probe   # 1) 右下角模拟右键，量出溢出像素并打印 PASS/FAIL
                     # 2) 点「打开看板娘设置」，断言偏好面板真的打开
```

### 4.6 右键菜单「打开看板娘设置」的桌面替代

上游那一项的行动是去找 **DSH 页面**的设置入口：

```js
var btn = doc.querySelector('[data-slot="sidebar.settings"] button');
// 依次回落到 [data-slot="settings.trigger"] → 文本"设置"的按钮
if (btn) btn.click();
```

独立桌面版没有 DSH 页面，三个回落全部落空，于是**点了毫无反应**（不是报错，是静默）。

壳层在**捕获阶段**挂一个 `click` 监听（此时右键菜单还在 DOM 上，判定最可靠）：

- 目标是 `[data-dsh-whale-context] button` 且文本等于「打开看板娘设置」
- 且 `hasDshSettingsEntry()` 为假（页面里确实没有 DSH 入口）
- → `setTimeout(openPetPrefs, 0)`

不 `preventDefault`、不 `stopPropagation`：上游的 handler 仍要跑，它负责把右键菜单移除；
我们只是在它之后再打开桌宠自带的偏好面板 `[data-dsh-whale-prefs]`（等价于点击齿轮 ⚙）。
真有 DSH 入口时（例如将来把它嵌回 DSH 页面）则不抢，行为回到上游原样。

### 4.7 独立设置窗口 & 页面内面板的关闭入口

**为什么设置要做成独立窗口**：上游的偏好面板是页面内浮层，只能靠齿轮 ⚙ 开合，
而齿轮在台词气泡里、气泡 4.5 秒后自动隐藏（`bubbleHideAt`）——
面板一旦打开就**没有可点的关闭入口**。独立窗口有原生标题栏，这个问题自然消失，
而且"看板娘开关关掉后还能把她打开"（页面内面板做不到这点）。

窗口实现在 `src/main.js` 的 `openSettingsWindow()`，页面是 `src/pet/settings*.{html,css,js}`。

**偏好如何跨窗口同步**：不写 IPC，靠**同源 localStorage**。

```
设置窗口  localStorage.setItem('whale-moe:chat','0')
   ↓ 同源 → 另一个文档收到 storage 事件
桌宠页面  window.addEventListener('storage', …)
   ↓ 派发上游本来就监听的事件
上游      root.addEventListener('whale-moe-prefs-change', schedule) → reconcile
```

所以 `shell.js` 里那条 `storage` 监听是这套机制的**关键一环**，
`onWhaleShellApi.openSettings` 只负责开窗。

**窗口高度**：三个开关 + 页脚的高度随字体/显示缩放而变，写死高度会截断第三项。
`did-finish-load` 后读 `document.body.scrollHeight` 再 `setContentSize()`。

**页面内面板仍然保留**（齿轮 ⚙ 还能打开它），所以壳层给它补了三条关闭退路：

1. 注入 × 按钮 —— 必须用**内联样式**：上游有 `[data-dsh-whale-prefs] button { display:flex; … }`
   这条规则，普通按钮会被撑成一行开关。
2. 点面板外关闭 —— 上游在 `rootNode` 上挂了 `stopPropagation`，
   于是"能冒泡到 `document` 的点击"天然就是"点在桌宠之外"，不需要额外判定。
3. Esc 关闭。

注入时机用 `MutationObserver` 盯 `document.body`，并用 `panelCloseTarget.isConnected`
做短路（桌宠 DOM 变动很频繁，不能让每次 mutation 都跑选择器）。

### 4.8 坑：新窗口在"整屏置顶"宿主下会白屏

桌宠窗口是**整屏 + 置顶**的。Windows 上 Chromium 有一个"原生窗口遮挡检测"
（`CalculateNativeWinOcclusion`）：它按**窗口矩形**判断可见性，不看透明度，
于是会把设置窗口判定为"被完全遮住" → **停止为该窗口出帧** →
表现就是**窗口打开后一片空白，点一下才出现内容**。

三处修（缺一不可）：

```js
// 1) 启动前追加，别覆盖（Electron/Chromium 自己也会设 disable-features）
const existing = app.commandLine.getSwitchValue('disable-features');
app.commandLine.appendSwitch('disable-features',
  existing ? `${existing},CalculateNativeWinOcclusion` : 'CalculateNativeWinOcclusion');
```

```js
// 2) 等首帧就绪再显示；并且要压在整屏桌宠之上
show: false,
alwaysOnTop: true,
win.once('ready-to-show', () => { win.show(); win.focus(); win.webContents.invalidate(); });
```

```
3) 失焦时 setAlwaysOnTop(false)，避免它一直浮在别的应用上面
```

验证方式见 `settings:probe` 里的 **像素级断言**：截图统计暗像素/彩色像素占比，
白屏时两者都接近 0（实测正常值 `darkRatio≈0.052`、`coloredRatio≈0.020`）。

> 注意：`capturePage()` 本身会强制要一帧，所以它**不总能复现**屏幕上的白屏；
> 它能证明"内容确实渲染了"，但用户侧观感仍需人工确认一次。

### 4.9 三处入口的职责划分

| 入口 | 放什么 | 为什么 |
| --- | --- | --- |
| 桌宠右键菜单 | **只放对她做的事**（投喂/戳/夸/小游戏/回到原位） | 右键她时的心智是"我要逗她" |
| 托盘右键菜单 | 高频全局动作 + 快速开关（显示桌宠 / 设置… / 置顶 / 跟随 DSH / 自启 / 大小 / 重置位置 / 重载 / 数据目录 / 日志 / 退出） | 她藏起来时唯一还能点到的入口，顺手的开关不必进窗口 |
| 设置窗口 | 完整可配置项，分 4 类 | 需要解释的项集中一处，带说明文字 |

**托盘与设置窗口是同一份 `config` 的两个入口，不会打架。** 机制很简单：
所有改动都走 `setScale` / `setAlwaysOnTop` / `setAutoLaunch` / `setFollowDsh` /
`setVisible` 这些 setter，而它们末尾**都调用 `refreshTrayMenu()`** —— 托盘菜单
每次重建都重新读 `config`，所以勾选状态一定是当前值。

> 这一点我在 0.4.0 判断错过一次：当时以为"托盘勾选是构建时快照、不会刷新"，
> 把托盘精简成了三项。实际上同步早就成立，于是 0.4.1 又把内容加了回来。
> 教训：**先读代码再下"会有两套状态"的结论**。

维护时的**不变量**：新增任何能改 `config` 的 setter，末尾必须带上
`refreshTrayMenu()`，否则托盘勾选会滞后。`settings:probe` 里有一条断言专门守它 ——
从设置窗口改「总是置顶」后，直接读 `trayMenu.items` 里那一项的 `checked`
必须已经同步（不是重新构建模板来比对，那只能证明 config 变了）。

**摘掉上游菜单项比改上游代码划算。** 上游 `showContextMenu` 里写死了
「打开看板娘设置」，我们没有改 `vendor/whale`，而是在菜单挂载时移除该项
（`stripNonInteractionItems`，跑在 `watchMenu` 里）。注意时机：菜单是
`appendChild` 后才设 `left/top`，而 MutationObserver 回调是**微任务**，
所以移除发生在菜单已完整构建之后 —— 探针里读标签前要等一拍也是这个原因。

判断"要不要摘"用的是 `hasDshSettingsEntry()`：页面上真有 DSH 设置入口时不摘，
这样把页面嵌回 DSH 时行为自动回到上游原样。

## 5. DSH 工作状态联动

上游会在"思考中/工作中/完成/出错"时切换立绘与状态签，判断依据是页面里的
DOM 信号（`SIGNAL_BANKS`，只看存在性、不读业务文本）。桌面版不在 DSH 页面里，
所以这套信号必须换个来源。

### 5.1 信号源：DSH 会话文件

`~/.dsh/sessions/<workspace>/session-<id>/session.v3.jsonl.zstd`，形态是
**多帧拼接的 zstd**（每次追加一帧，帧间以 magic `28 B5 2F FD` 分隔），
每帧解压后是若干行 `{type, seq, time, data}`。

所以可以只解压**新增的帧**：记住 `offset`，每次只读新增字节，按 magic 切帧。
正在写入的最后一帧解压会失败 —— 那就**不推进 offset**，下一轮重试。

实测记录类型：`turn/start`、`step/start`、`assistant/message`、`tool/call`、
`tool/result`、`step/end`、`turn/end`、`approval/asked|decided`、`command/run|done` 等。

状态映射见 `CHANGELOG.md` 的 0.2.0 小节；实现在 `src/dsh-state.js`。

### 5.2 页面侧：合成上游信号

`src/pet/shell.js` 按主进程推来的状态，动态创建/删除几个 `<i>` 元素：

| 桌宠状态 | 合成信号 | 上游对应 bank |
| --- | --- | --- |
| 思考中 | `data-status="pending"` | thinking |
| 工作中 | `data-running`（`textContent` = 工具关键词） | tool |
| 完成 | `data-state="success"` | success |
| 出错 | `data-status="error"` | error |

两个必须遵守的约束（都来自上游 `isVisible()` 的实现）：

1. 合成节点**盒子必须 > 1px、必须与视口相交、`opacity` 不能正好是 `"0"`**。
   所以宿主是 `2x2 + opacity:0.01 + pointer-events:none`，贴在 `(0,0)`。
2. 上游对 error 节点有**基线机制**：首次 reconcile（含启动后的 settle 窗口）时
   已存在的错误节点会被当作历史记录忽略。因此 **error 节点必须按需新建、闪完即删**，
   不能开机就摆在那里 —— 否则真实的出错永远不会被识别。
   其他三类没有这个限制，但实现上统一按需创建。

`textContent` 会被上游 `detectToolPose()` 读取并按关键词选具体姿势，
所以壳层做了一张 DSH 工具名 → 关键词的表（`TOOL_HINTS`）。
注意上游的关键词表**顺序敏感**：`deploy → test → debug → search → write → bash → review → plan`，
首个命中即返回，写关键词时别让不相关的词先命中。

### 5.3 踩过的坑：兜底逻辑不要写持久状态

`src/dsh-state.js` 里有一条"忙态下 3 分钟没有新记录就认为 DSH 挂了"的兜底。
第一版把它写成 `if (stale) this.inTurn = false` —— 结果启动时只吃到前 400 帧
（那一批还在几十个 turn 之前），`lastRecordAt` 很旧 → 判定 stale →
`inTurn` 被永久清掉；而最后那个 `turn/start` 早已在前一批被消费，
后面全是 turn 内的记录，再没有 `turn/start` 来恢复它 —— **永远报空闲**。

现在 `busy = inTurn && !idleTooLong` 是**派生量**，stale 绝不回写 `inTurn`。
另外单轮解帧上限提到 4000，启动时一次追平历史，避免用中间态做判断。

### 5.4 验证

```bash
npm run dsh:probe    # 走真实 IPC 推状态，读上游 __dshWhaleMoeDebug 看它认成什么
```

`dsh:probe` 会依次注入 idle/thinking/tool×3/success/failure/idle，
并打印上游自己的 `state`/`pose`/状态签/立绘。**步进必须大于 4.5 秒**：
上游对"工作中"有 goneHold 防抖（home 视图 4s），间隔太短下一步会被上一步盖住。

实时数据源可以直接看：

```bash
curl http://127.0.0.1:38911/__shell/state   # 其中 dsh 字段即会话文件读到的状态
```

## 6. 调试手段（看不到屏幕时靠这些）

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

## 7. 上游同步

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

## 8. 打包（待做）

目前是开发态运行。要出免安装 exe 需要加 `electron-builder`：

```bash
npm i -D electron-builder
```

并在 `package.json` 增加 `build` 段（`win.target: portable` / `nsis`）。
注意 `vendor/` 必须打进 asar 或作为 extraResource 一起分发。

## 9. 路线图 / 已知限制

- **工作状态联动**：上游靠 `MutationObserver` 观察 DSH 页面 DOM 来判断"正在跑工具"。
  独立宿主没有那个 DOM，需要另接信号源（DSH 事件流、或本地钩子）。
  壳已预留通道：`preload.js` 暴露了 `onBusy`，主进程可向页面推 `shell:busy`。
- **多显示器**：当前只铺主显示器工作区。
- **全屏应用**：窗口是 `alwaysOnTop` 的整屏透明层，看全屏视频/游戏时建议
  用 `Alt+Shift+W` 或托盘临时隐藏。
- **不参与 DSH 的设置面板**：上游的设置面板是 DSH 客户端插件（`lib/client.js`），
  独立运行时用桌宠自带的齿轮菜单 ⚙，功能覆盖开关/大小/天气/养成数据。

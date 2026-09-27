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
  │    ├─ /pet/mascot.js   → vendor/whale/dsh-whale-moe.js + 一行说话钩子（见 6.5）
  │    ├─ /pet/*           → src/pet/*
  │    └─ /__shell/state   → 自检端点（JSON）
  ├─ 读 DSH 会话文件 (src/dsh-state.js) → 工作状态 + 每个 turn 的 token 用量
  │    └─ turn 结束 → src/pricing.js 算钱 → 调页面里的说话钩子（见 6.5）
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

## 5. 养成 / 图鉴与头顶浮层

### 5.0 入口只在气泡里（不占托盘）

称号/成就**不放托盘菜单**：它们本质是"养成"的一部分，入口统一收在
气泡齿轮 ⚙ →「日常养成」里（窗口内的 5 个标签页）。托盘只留随手就要用的东西 ——
菜单每多一行，"退出"就往下挪一行，这类菜单能短则短。

换来的约束：养成窗口必须能从 HUD 打开，且窗口内必须能切到称号页/成就页。
这两点在 `growth:probe` 里各有一条断言（去掉入口时，功能不能跟着一起消失）。
### 5.1 上游的两半：算法在 assets，UI 在 client.js

上游这些功能的 **UI** 在 `lib/client.js`（DSH 设置面板那半边，本项目**没有** vendor），
但**数据与规则**全在 `vendor/whale/whale-moe-core.js` 里 —— 它是 UMD：

```js
if (typeof module === "object" && module.exports) module.exports = api;
if (root) root.DshWhaleMoeCore = api;
```

所以浏览器里是 `window.DshWhaleMoeCore`，Node 里可以直接 `require`。
导出包含 `ACHIEVEMENTS`(39) / `BOND`(称号) / `QUEST_POOL` / `computeWeekSignin` /
`refreshQuests` / `claimQuest` / `bondUnlocks` / `weatherText` / `formatBalance` …

**结论：不重写任何养成算法**，只写 UI（`src/pet/growth.*`）。

### 5.2 数据怎么拿：能同源就别用 IPC

| 需求 | 通道 |
| --- | --- |
| 读养成状态（等级/成就/任务/签到/日记） | **直接读 `localStorage`**（同源） |
| 统计规则（成就表、等级、里程碑） | `window.DshWhaleMoeCore` |
| 领取任务 / 佩戴称号 | **IPC 回到桌宠页面**调 `__dshWhaleMoeClaimQuest` / `__dshWhaleMoeApplyBadge` |
| 偏好类设置（开关/城市…） | 写 `localStorage`，页面收 `storage` 事件后派发 `whale-moe-prefs-change` |

为什么领取得回页面：`claimQuestById` 里有 `applyGrowth`（好感/心情）、成就算、
`burst()` 粒子、`announceUnlocks()` 台词 —— 这些都是页面里的副作用。
主进程直接 `executeJavaScript` 调那个 hook 即可，不需要为它再搭一套消息协议。

### 5.3 头顶浮层与天气预取

齿轮 ⚙ 原本开合的是上游那个三开关面板，而开关已经进了设置窗口，
于是壳层把这块位置改成"状态 + 入口"（`#dsh-whale-shell-hud`，挂在桌宠根节点下，
沿用上游那套 `position:absolute; bottom:calc(100% + 10px)` 的贴头顶定位）。
上游面板用一行 `display:none !important` 藏掉，齿轮的点击照旧 toggle，无副作用。

**天气为什么要壳层自己拉**：上游只在 `idleChatTick` 里 `weatherEnsure()`，
间隔 `IDLE_CHAT_MIN..MAX`（分钟级）且要求她正闲着、气泡空着 —— 设置里改完城市可能要等很久。
壳层于是拉同一个 Open-Meteo 接口，并把结果写回 `window.__dshWhaleMoeWeather`：

```js
// root.__dshWhaleMoeWeather = weatherState  —— 同一个对象引用
window.__dshWhaleMoeWeather.current = { temp, code, wind, humidity };
window.__dshWhaleMoeWeather.fetchedAt = Date.now();
```

因为是同一引用，她的**天气特效、天气台词、浮层显示会一起用上**这份数据。
上游自己到点也会照常刷新，两边不冲突。

> 触发点是 `storage` 事件（城市是在**设置窗口**里改的）。
> 注意：**同文档写 localStorage 不会触发自己的 storage 事件** ——
> 写测试时必须在另一个窗口里写，否则会误判成功能坏了。

### 5.4 余额接口为什么要 fetch 垫片

上游把地址写死成 `http://127.0.0.1:3020/balance`，而桌面版希望它可配置。
`src/pet/preshim.js` 在**上游脚本之前**加载，只拦截这一个 URL 并重写到
`whale-moe:balanceEndpoint`，其它请求原样放行 —— `vendor/whale` 依旧零改动。

### 5.5 余额为什么需要一个本地代理

上游要的形状与 DeepSeek 官方接口不同：

```
官方 GET https://api.deepseek.com/user/balance
  → { is_available, balance_infos: [ { currency, total_balance, granted_balance, topped_up_balance } ] }
上游 { ok: true, balances: [ { currency, totalBalance } ] }
```

所以 src/balance-proxy.js 做三件事：取 Key、转字段、**补 CORS 头**。

CORS 是硬要求，不是可选项：桌宠页面源是 `http://127.0.0.1:<port>`，代理在 3020，
**端口不同就是跨源**，少了 `Access-Control-Allow-Origin` 浏览器会静默拦掉 ——
表现是"余额不可用"，只有控制台会说原因。做这个功能时最容易卡在这里。

Key 的取法按优先级：`DEEPSEEK_API_KEY` 环境变量 →
`~/.dsh/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`（实测是明文）→
用户数据目录的 `balance-key.txt`。只在内存里用，不落盘、不打日志。

> 顺带一个结论：**localStorage 不跨进程共享**（即使同一个 userData、同一个 origin）。
> 所以"从外部进程替用户改设置"这条路走不通，设置必须由页面自己写。
> 同理，主进程想断言浮层内容，只能让页面把结果报上来（见 `petRect.hud`）。

## 6. DSH 工作状态联动

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

## 6.5 任务花费播报：运行时注入一个"说话"钩子

需求：每个任务结束时她开口报"这次花了多少 tokens、约多少钱"。
这件事有三段，分别落在三个文件里。

### 6.5.1 用量：会话文件里已经有了

会话文件每条 `assistant/message` 都带 `usage`：

```json
{ "inputTokens": 352, "cacheReadTokens": 1540992, "outputTokens": 5164, "reasoningTokens": 4132 }
```

两个**必须**记住的点（写错都不会报错，只是数字不对）：

1. `totalTokens = inputTokens + cacheReadTokens + outputTokens`（实测精确成立）
2. `reasoningTokens` 是 `outputTokens` 的**子集**，再加一遍就重复计费

`src/dsh-state.js` 按 `turn/start` … `turn/end` 累加，`turn/end` 时通过 `onTurnEnd` 回调
交给主进程（历史 turn 也回调，带 `historical: true`，见 6.5.6）。

### 6.5.2 单价从哪来（`src/price-table.js`）+ 怎么乘（`src/pricing.js`）

这两件事**刻意分开**：`pricing.js` 只做"用量 × 已定好的单价"，
"此刻该用哪一档价、哪个模型的价"全在 `price-table.js`。
（第一版把峰谷判断放在 `costOf` 内部，接入价目表后就会出现"两处都决定时段"的隐患。）

**单价来源是本地文件 `pricing.json`，运行时只读、不联网。**
理由：DeepSeek 没有价格 API，官网只有一张给人看的网页表格；爬页面一旦结构变化就
静默失效，而计费算错是最难发现的一类 bug（她照样说话，只是数字不对）。
所以刷新是**人工动作**：`npm run refresh:prices` 抓页面 → 解析 → **打印 diff** → 写文件，
确认后提交，价目表随版本走。

```bash
npm run refresh:prices                      # 抓官网
npm run refresh:prices -- --dry-run         # 只看结果
npm run refresh:prices -- --from-file x.html  # 用已保存的页面（没网/被墙时）
```

两个实现要点：

1. **表里逐项写明 idle/peak**，不靠"高峰 = 空闲 × 2"推导 —— 关系变了不用改代码，
   也免得把官方"空闲价 = 高峰价的一半"这句说明当成算法。
2. **解析不出完整表格就报错退出、不写文件**。宁可人工核对后手改，也不要写半张表。

解析器有个中文正则坑值得记下来：判"模型"表头时**不能用 `/^模型\b/`** ——
`\b` 只认 `[A-Za-z0-9_]`，中文后面跟制表符不构成词边界，那个正则永远匹配不上。
第一版就栽在这里（报"结构可能变了"）。另外价格行的第一个格子不一定是说明文字
（真实页面是 `价格(2) | 百万tokens输入（缓存命中） | 空闲时段 | 0.02元 | …`），
所以要在**行内找**说明格与时段格，不能假定列号。

取价规则（`resolveRates`）：

| 情况 | 用哪套价 |
| --- | --- |
| 当前模型在表里（含别名） | 表里该模型的 idle 或 peak 价 |
| 当前模型不在表里 | 手动配置那三个数（高峰 ×2） |

**当前模型怎么知道**：会话记录 `request/header` 里有
`data.header.config.model`（`assistant/message` 里没有模型名，只有这处有），
`dsh-state.js` 顺手记下来随 `onTurnEnd` 交出去；会话还没给出模型时，
兜底读 `~/.dsh/settings.yaml` 的 `agent-default-model.model`。
所以中途换模型不用重启桌宠。

峰谷判定只按周一至周五 + 时段，**不处理法定节假日**（官方说节假日全天按空闲计价，
那几天我们会高估一倍，已知限制）。缓存命中与未命中相差 50 倍，**必须分开算**；
混算会把 5 分钱算成两块多。

### 6.5.3 说话：上游没有对外的入口，所以注入一行

上游内部只有 `showLineNow(line)`，没有任何 `window.__dshWhaleMoeSay` 之类的出口
（`__dshWhaleMoeDebug / Weather / Balance / IdleChat / ClaimQuest / ApplyBadge` 都有，
就是没有说话）。三条路：

| 方案 | 结论 |
| --- | --- |
| ① 运行时在返回脚本时注入一行，暴露 `showLineNow` | **采用** |
| ② 壳自己画一个气泡 | 会与上游气泡打架（两套定位/动画/隐藏时机） |
| ③ 直接改 `vendor/whale/dsh-whale-moe.js` | 否决：`npm run sync:upstream` 会把它冲掉 |

做法在 `src/server.js`：`/pet/mascot.js` 与 `/assets/dsh-whale-moe.js` 是**同一份文件**，
只是前者返回前做一次字符串替换：

```js
root.__dshWhaleMoeSay = showLineNow;   // 插在 root.__dshWhaleMoeStarted = true; 之前
```

这与上游 DSH 插件自己的做法一致（取文本 → 替换 → 注入），但**磁盘上的 vendor 文件不动**，
所以 vendor 校验与上游同步都不受影响。锚点缺失时注入失败：打警告日志、原样返回、
`X-Shell-Say-Hook: 0`，页面上没有钩子，主进程据此降级成"只写日志"。

### 6.5.4 说话钩子的两个细节：打完字再计时、点一下就收

上游 `showLineNow(line)` 在**开口那一刻**就把气泡到期时间设成 `now + 4500`，
而它是逐字打的（`typeBubble`：标点 260ms、每 5 字 130ms、其余 64ms）。
短句没问题（十来个字打 1 秒左右，还剩 3 秒多可读），
但余额播报那种四十多字的句子光打字就 4 秒多 —— 打完正好到点，等于全文只闪一下。
**问题不是 4.5 秒太短，而是计时起点不对。**

所以注入的钩子带一个停留参数，并且把起点挪到打字结束：

```js
root.__dshWhaleMoeSay = function (line, holdMs) {
  showLineNow(line);
  var hold = Number(holdMs) > 0 ? Number(holdMs) : 4500;
  if (root.__dshWhaleMoeBubbleHold) root.clearInterval(root.__dshWhaleMoeBubbleHold);
  root.__dshWhaleMoeBubbleHold = root.setInterval(function () {
    if (typingTimer) return;                    // 还在逐字打字
    root.clearInterval(root.__dshWhaleMoeBubbleHold);
    memory.bubbleHideAt = Date.now() + hold;    // 打完之后才开始算停留
  }, 120);
};
```

`typingTimer` 与 `memory` 都是上游闭包里的变量，锚点在 `start()` 里 ——
同一作用域，所以读得到；`vendor/whale` 的磁盘文件依然一字未改。

用户看完想提前收：壳在 `document` 上挂一个 click 监听，用**上游自己那套淡出动画**
（加 `dsh-whale-out`，200ms 后 `hidden`）把气泡收起 —— 只是把"到点收起"提前。
不需要操心传播：上游给桌宠根节点挂了 `click → stopPropagation`（vendor 第 417 行），
所以能冒泡到 `document` 的点击一定落在她以外；点她身上另算互动，会把气泡换成互动台词。

`say:probe` 里这三条断言是配套的：**打完字 3 秒后仍可见**（旧行为此时已收起）、
**到点自动消失**、**点击后立刻消失**。

### 6.5.5 防刷屏与重启友好

- **历史 turn 一律不播报**：启动时会把整份历史读一遍，里面全是旧的 `turn/end`。
  加了一道 `primed` 闸门 —— 只有 `offset` 追平过文件尾之后到达的 `turn/end` 才播报。
  切换会话文件时 `primed` 会重置（新文件里的旧账同样不能播）。
- **中途重启不漏账**：`turnUsage` 在每次 `turn/start` 与 `turn/end` 后归零，
  所以"追平历史"结束时它恰好等于**当前进行中 turn** 已累计的用量，直接保留即可。
- **阈值**：低于 `costThreshold`（默认 0.01 元）不播报，连日志都只留一行。

### 6.5.6 今日消耗账本：为什么要落盘 + 回放 + 去重

"今天一共烧了多少"和"这个 turn 花了多少"是两道题。后者在内存里累加就行，
前者不行：桌宠每次升级都要重启，一重启清零的话数字会明显偏小；而 DSH 的会话文件里
**本来就有当天早些时候的 turn**，没有理由不利用。

`src/usage-today.js` 因此做了四件事：

| 做法 | 为什么 |
| --- | --- |
| 落盘 `userData/usage-today.json` | 重启不丢 |
| 按**本地日期**分区、读写时顺手归零 | 跨天不必等定时器；用本地日期而不是 UTC（东八区凌晨会算到前一天） |
| 启动时回放当天历史 turn（`historical: true`） | 当天中途才把她叫起来也能补上账 |
| 按 `会话#turn` 去重 | 每次重启都会回放，没去重就会把同一天的账算两遍 |
| **只收今天**的 turn | 一个 DSH 会话文件跨天，回放里必然夹着昨天及更早的 turn；直接丢弃，**不能让账本跟着翻页**（否则一次回放就能把今天的账清成昨天的） |

配套改动：`DshStateWatcher.onTurnEnd` 对历史 turn 也回调，附 `historical` 标记 ——
补账与播报是两件事，由调用方（`main.js` 的 `handleTurnEnd`）分开处理：
**记账无条件做，播报只做实时且达到阈值的**。

### 6.5.7 气泡「余额查询」念的那句话

```
当前余额为 CNY 41.11，状态为充裕，今日共计消耗 35.2 万 tokens，消费 0.53 元
```

数据是拼出来的，两个来源各管一半：

- **余额与状态**：页面里的 `window.__dshWhaleMoeBalance`（上游自己 60 秒刷一次），
  状态词用上游 `DshWhaleMoeCore.formatBalance(amount, currency, false)`
- **今日消耗**：主进程账本，经 `shell:usage-today` 取回**已经格式化好的字符串**
  （万/亿、小数位规则只应存在于 `src/pricing.js` 一处，页面里再写一遍迟早对不上）

按钮布局：两个入口放在 `.hud-actions` 里，各自 `flex: 1` —— 等宽靠 flex 而不是写死宽度，
文案改长改短都不用动 CSS（顺序：日常养成在左、余额查询在右）。`growth:probe` 会量它们的
**实际渲染尺寸**（必须等浮层可见才量得到，隐藏时 `getBoundingClientRect()` 全是 0）。

浮层的开合：齿轮 ⚙ 开合、点桌宠外面收起，**点任一选项也收起**。
最后这条是补的坑：选项原本只 `stopPropagation`（避免被"点外面收起"的监听收掉），
于是点完菜单还杵在头顶 —— 而两个入口都会打开别的窗口或冒出台词，菜单留着既挡视线
又像没反应。现在统一"先收起、再执行动作"，四个可点元素（天气 / 余额 / 日常养成 /
余额查询）行为一致；探针里"日常养成"与"余额查询"各有一条断言，
覆盖同步点击与异步播报两条路径。

### 6.5.8 验证

```bash
npm run test:cost    # 33 项离线断言：计价/峰谷/阈值/格式化/turn 累加/闸门/今日账本/价目表与刷新解析器
npm run say:probe    # 8 项端到端断言：可见气泡的完整文本 + 停留时长 + 点击收起 + 低阈值不播报
```

`say:probe` 断言的是**气泡里可见的完整文本**，而不是"window 上有个函数" ——
钩子存在 ≠ 话说得出来（气泡节点可能没建、台词可能被 `localizeLine` 改写、
气泡可能没被取消隐藏）。台词是逐字打出来的，所以探针会轮询到文本打满为止；
"打完字 3 秒后仍可见"这条则把"计时起点在开口还是在打字结束"区分开。

## 6.6 设置窗口：二级菜单与"量出来的高度"

设置项到了二十多个，全铺一屏既长又难找。现在左侧一级分类、右侧对应设置。

两条实现约定（都是为了避免"加了东西忘同步"）：

1. **左侧导航由 section 生成**：HTML 里只写
   `<section data-panel="env"><h2>天气与余额</h2>…</section>`，
   导航项文案取 h2。加一屏就自动多一个导航项，不存在漏加或文案不一致。
2. **高度由页面量、报给主进程**（`shell:settings-size`）。两栏布局下
   "最高的一屏"只有页面知道；主进程读不到渲染进程的布局。

量高度这件事有个坑值得记下来：**不能用 `body.scrollHeight`**。
它的下限是可视高度 —— 窗口偏高时量到的就是窗口高度本身，于是永远缩不回去。
所以按"外层留白 + 标题 + 最高的一屏 + 底栏"逐项相加
（`settings.js` 的 `naturalHeight`）。为此 CSS 里 `.shell / .pane / .rail`
**刻意不留纵向 margin**，否则那个和就对不上了。

取"最高的一屏"而不是"当前这一屏"，是为了让窗口高度固定：切分类时窗口忽高忽低很晃眼。
另外主进程套用时会 +4px 余量：`offsetHeight` 不含子元素的下外边距，
少这几像素就会平白多出一条滚动条。

## 7. 调试手段（看不到屏幕时靠这些）

```bash
npm run shot        # 启动 → 等 5 秒 → 截图 → 打印 DOM 状态 → 退出
npm run shot -- --shot-delay=8000 --shot=D:\tmp\a.png
npm run menu:probe  # 右键菜单越界探针（打印溢出像素 + PASS/FAIL + 截图）
npm run say:probe   # 让她说一句样本并断言气泡文本（花费播报链路）
npm run test:cost   # 计价 / 账本 / 价目表与刷新解析器 单测（不需要 Electron）
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

## 8. 上游同步

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

## 9. 打包（待做）

目前是开发态运行。要出免安装 exe 需要加 `electron-builder`：

```bash
npm i -D electron-builder
```

并在 `package.json` 增加 `build` 段（`win.target: portable` / `nsis`）。
注意 `vendor/` 必须打进 asar 或作为 extraResource 一起分发。

## 10. 路线图 / 已知限制

- **花费播报的估算误差**：不处理中国法定节假日（那几天会按高峰价高估一倍）；
  跨峰谷的长任务只给一个估算值；一个 turn 内的全部记录都计入，**包括子代理**。
- **多显示器**：当前只铺主显示器工作区。
- **全屏应用**：窗口是 `alwaysOnTop` 的整屏透明层，看全屏视频/游戏时建议
  用 `Alt+Shift+W` 或托盘临时隐藏。
- **不参与 DSH 的设置面板**：上游的设置面板是 DSH 客户端插件（`lib/client.js`），
  独立运行时用桌宠自带的齿轮菜单 ⚙ 与壳的独立设置窗口。
- **`main.js` 里 `openSettingsWindow` 没走 `createAuxWindow` helper**：
  逻辑等价但重复了一份，下次改设置窗口时顺手迁移，别让两份实现漂移。

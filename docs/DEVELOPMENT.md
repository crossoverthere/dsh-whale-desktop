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

``
官方 GET https://api.deepseek.com/user/balance
  → { is_available, balance_infos: [ { currency, total_balance, granted_balance, topped_up_balance } ] }
上游 { ok: true, balances: [ { currency, totalBalance } ] }
``

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
交给主进程。

### 6.5.2 计价：`src/pricing.js`（纯函数）

| 项 | 单价（元/百万 tokens） |
| --- | --- |
| 输入·缓存命中 | 0.02 |
| 输入·缓存未命中 | 1 |
| 输出 | 4 |

工作日 9:00-12:00、14:00-18:00（北京时间）**翻倍**。
缓存命中与未命中相差 50 倍，**必须分开算**；混算会把 5 分钱算成两块多。
峰谷判定只按周一至周五 + 时段，**不处理法定节假日**（那几天会高估一倍，已知限制）。

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

### 6.5.4 防刷屏与重启友好

- **历史 turn 一律不播报**：启动时会把整份历史读一遍，里面全是旧的 `turn/end`。
  加了一道 `primed` 闸门 —— 只有 `offset` 追平过文件尾之后到达的 `turn/end` 才播报。
  切换会话文件时 `primed` 会重置（新文件里的旧账同样不能播）。
- **中途重启不漏账**：`turnUsage` 在每次 `turn/start` 与 `turn/end` 后归零，
  所以"追平历史"结束时它恰好等于**当前进行中 turn** 已累计的用量，直接保留即可。
- **阈值**：低于 `costThreshold`（默认 0.01 元）不播报，连日志都只留一行。

### 6.5.5 验证

```bash
npm run test:cost    # 17 项离线断言：计价/峰谷/阈值/格式化/turn 累加/闸门
npm run say:probe    # 5 项端到端断言：可见气泡里的完整文本 + 低阈值不播报
```

`say:probe` 断言的是**气泡里可见的完整文本**，而不是"window 上有个函数" ——
钩子存在 ≠ 话说得出来（气泡节点可能没建、台词可能被 `localizeLine` 改写、
气泡可能没被取消隐藏）。台词是逐字打出来的，所以探针会轮询到文本打满为止。

## 7. 调试手段（看不到屏幕时靠这些）

```bash
npm run shot        # 启动 → 等 5 秒 → 截图 → 打印 DOM 状态 → 退出
npm run shot -- --shot-delay=8000 --shot=D:\tmp\a.png
npm run menu:probe  # 右键菜单越界探针（打印溢出像素 + PASS/FAIL + 截图）
npm run say:probe   # 让她说一句样本并断言气泡文本（花费播报链路）
npm run test:cost   # 计价与播报闸门单测（不需要 Electron）
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

# 交接文档（给下一个维护它的对话看）

> 目标是让你**在不问原作者的前提下**接手这个仓库：知道它现在是什么状态、哪些事绝对不能做、
> 改完怎么自证、以及踩过的坑长什么样。
>
> 阅读顺序建议：第 1 节（现状）→ 第 2 节（铁律）→ 第 3 节（自检矩阵）→ 需要动手时再查后面的地图。
> 架构细节在 [`DEVELOPMENT.md`](./DEVELOPMENT.md)（更细、更"为什么"），本文件负责"怎么接手"。

---

## 1. 现状一页纸

| 项 | 值 |
| --- | --- |
| 仓库 | `D:\DSWorkspace\dsh-whale-desktop`（工作区根是 `D:\DSWorkspace`） |
| 远端 | https://github.com/crossoverthere/dsh-whale-desktop （分支 `main`） |
| 版本 | `0.12.3` —— 一切以 `package.json` 为准，别信文档里的数字 |
| 形态 | **独立 Electron 桌面挂件**（不是 DSH 插件）。透明、置顶、点击穿透 |
| 上游 | [dsh-whale-musume](https://github.com/Sutera-Diffusus/dsh-whale-musume) v2.1.0，素材在 `vendor/whale/`，**一个字都没改** |
| 常驻实例 | 桌宠监听 `127.0.0.1:38911`，DSH 网页在 `127.0.0.1:3080`，内置余额代理在 `127.0.0.1:3020` |
| 用户数据 | `%APPDATA%\dsh-whale-desktop\`（`config.json` / `shell.log` / `dsh-web.log` / `usage-today.json`） |
| DSH 本体 | `C:\Users\cross\.dsh`（`profiles/`、`sessions/`、`settings.yaml`、`.credentials.yaml`）；CLI 在 `%APPDATA%\npm` |
| 环境事实 | Windows + PowerShell 5.1（**没有** pwsh 7）、node `C:\Program Files\nodejs\node.exe`、GitHub 推送需走本机 Clash 代理 |

**功能地图**（每个功能落在哪）：

| 功能 | 主进程 | 页面 | 细节文档 |
| --- | --- | --- | --- |
| 点击穿透 / 头顶浮层 / 右键菜单 | `src/main.js`（光标轮询、窗口） | `src/pet/shell.js` | DEVELOPMENT 4 |
| 养成 / 图鉴窗口 | `main.js` + `src/growth-preload.js` | `src/pet/growth.*` | DEVELOPMENT 5 |
| 独立设置窗口（6 个分类） | `main.js` + `src/settings-preload.js` | `src/pet/settings.*` | DEVELOPMENT 6.6 |
| DSH 工作状态联动 | `src/dsh-state.js` | `shell.js`（合成上游信号） | DEVELOPMENT 6 |
| 花费播报 / 单价 | `src/pricing.js` + `src/price-table.js` + `pricing.json` | `settings.js`（花费播报屏） | DEVELOPMENT 6.5 |
| 今日消耗账本 / 余额查询 | `src/usage-today.js` + `src/balance-proxy.js` | `shell.js`（气泡按钮） | DEVELOPMENT 6.5.6 |
| 「打开DSH」 | `src/open-dsh.js` + `main.js` | `shell.js`（注入菜单项） | DEVELOPMENT 6.7 |

---

## 2. 铁律（违反会静默坏掉）

1. **绝不改 `vendor/whale/`。** `npm run sync:upstream` 会用它覆盖，改动全丢。
   要改行为就在壳层做：`src/pet/shell.js`（DOM 后处理）、`src/server.js`（运行时注入，
   见 `MASCOT_PATCH`，磁盘文件不动）。
2. **绝不重启正在跑的 DSH。** 它每次启动换一个浏览器信任 token，重启等于把用户正在聊的
   会话连同页面一起打断。「打开DSH」这条路是**唤起优先**，别"顺手优化"成重启。
3. **不要用 PowerShell 命令改仓库里的文本文件**（`Get-Content -Raw` + `Set-Content`）。
   PS 5.1 按 GBK 读无 BOM 的 UTF-8，再按 ANSI 写回，中文会成片变成 `?`（真发生过：
   `docs/DEVELOPMENT.md` 被毁掉 350 行）。用编辑器/`edit` 工具，或用 node 脚本。
4. **`.ps1` 含中文必须存成 UTF-8 with BOM**，否则 PS 5.1 直接解析失败。新建的
   `scripts/*.ps1` 一律写成**纯 ASCII**（省掉这条规则，注释用英文）。
   仓库里已经有两个 BOM 文件：`scripts/push.ps1`、`scripts/verify-shell.ps1` ——
   **编辑它们之后要确认 BOM 还在**（编辑工具会丢，见第 7 节）。
5. **改断言就要同步改 `expected` 计数。** 每个探针里有一个 `const expected = N`，
   与实际断言数不符会报"断言数不符"并失败 —— 这是故意的，防止你以为跑绿了其实少跑了几项。
6. **探针不能有副作用**：不弹浏览器、不改用户配置、不写用户账本。
   自检实例用独立端口 + `--standalone`（跳过单实例锁），账本用 `usage-today-probe.json`。
   需要"演练"的动作走 dry-run 开关（如 `OPEN_DSH_DRY`）。
7. **不要替用户决定启停**：桌宠对 DSH 只做只读观察（读会话文件）与"唤起"。
8. **提交前跑完第 3 节的自检矩阵**；跑不动要说明原因（见 3.3 的桌面可驱动性），
   不能默认"应该是好的"。

---

## 3. 自检矩阵（改完就按这个跑）

### 3.1 一次跑完

```bash
npm run test:cost        # 33 项：计价 / 峰谷 / 账本 / 价目表 / 刷新解析器（不需要 Electron）
npm run check:vendor     # 上游素材完整性（4 文件 + 92 立绘，v2.1.0）
npm run open-dsh:probe   # 11 项：「打开DSH」全链路（全程 dry-run）
npm run settings:probe   # 20 项：右键菜单构成 + 设置窗口（6 分类 / 高度 / 往返 / 单价区）
npm run growth:probe     # 20 项：养成窗口 5 个标签页 + 领取 + 佩戴
npm run say:probe        #  8 项：气泡文本（说话钩子）+ 停留时长 + 点击收起
npm run menu:probe       # 右键菜单不越界（打印实测像素 + PASS/FAIL + 截图）
npm run dsh:probe        # 工作状态联动的"日记"（观察用，没有 PASS/FAIL 计数）
```

### 3.2 需要"可驱动的桌面"的两条

```bash
npm run verify:shell     # 3 项：真的移动鼠标，验证点击穿透（跑完还原指针）
npm run e2e:open-dsh     # 端到端：DSH 没在跑时真的把它拉起来（真鼠标点菜单项）
```

它们会**真的移动系统指针**，所以只能在"有活动输入桌面"时跑。

### 3.3 先问一句"桌面能不能驱动"

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-desktop-input.ps1
```

- 退出码 0 = 指针能动，上面两条可以跑。
- 退出码 3 = `SetCursorPos` 被拒（锁屏 / RDP 断开 / 快速用户切换 / 别的进程占着输入桌面）。
  **这不是代码问题**：曾经出现过同一份代码 `verify:shell` 先过、十分钟后不过的情况，
  排查半天才发现桌面不可驱动了。这时只跑 3.1 的无头探针，并在结论里写明原因。

### 3.4 冷启动真机检查（不动你在跑的会话）

```bash
npm run cold:start       # 独立 DSH_HOME + 空闲端口，真起一个 dsh web，6 秒左右就绪
```

它会打印 `plan`（走哪条路）、`ready=?s`、`token=?s`、日志尾巴，跑完按端口收拾干净。
预计输出形如：`ready=5.9s  token=6.5s` + `token url = http://127.0.0.1:3094/?token=…`。

### 3.5 看截图（没有屏幕时）

```bash
npm run shot                                   # 等 5 秒 → tmp/shot.png + DOM 状态
npm run shot -- --shot-delay=8000 --shot=D:\tmp\a.png
```

`tmp/` 整个被 gitignore（探针截图、临时脚本都在里面，不会进仓库）。

### 3.6 跑探针前先确认 `ELECTRON_RUN_AS_NODE` 没被设上

**在 DSH 会话里（被 agent 工具调起来的 shell）它是 `1`**，于是
`node_modules\electron\dist\electron.exe .` 会**当成纯 Node 跑 `src/main.js`**，
直接死在第一行：

```
TypeError: Cannot read properties of undefined (reading 'setName')
    at Object.<anonymous> (src/main.js:60:5)
```

看到这个报错**不是项目坏了**，是环境把 Electron 降级成 Node 了。清掉再跑：

```powershell
$env:ELECTRON_RUN_AS_NODE = $null     # 或 cmd /c "set ELECTRON_RUN_AS_NODE=&& …"
npm run settings:probe
```

同一个变量还会让 `npm run <probe>` 静默产出**空输出 + exit 1**（重定向到文件时最容易误判成"探针没跑"）。
另外：常驻实例在跑时，探针里的 `[shortcut] register failed Alt+Shift+W` 是**正常的**
（热键已被常驻实例占用）。

### 3.7 实测底账（0.12.2 的代码，随 0.12.3 提交）

> 说明：下面这一批是在 `0.12.2` 的代码上跑的；之后只改了**文档**与
> `scripts/sync-upstream.mjs`（并用 `node --check` 复核过），没有动任何被探针覆盖的运行时代码。

| 命令 | 结果 | 备注 |
| --- | --- | --- |
| `npm run test:cost` | **33/33 PASS** | exit 0 |
| `npm run check:vendor` | **OK** | 4 个文件 + 92 张立绘（v2.1.0） |
| `npm run open-dsh:probe` | **11/11 PASS** | 全程 dry-run，未弹浏览器 |
| `npm run settings:probe` | **20/20 PASS** | content 704x382、`darkRatio=0.0528` |
| `npm run growth:probe` | **20/20 PASS** | |
| `npm run say:probe` | **8/8 PASS** | |
| `npm run menu:probe` | **PASS** | 菜单 194x292、8 项、四向溢出全 0 |
| `npm run dsh:probe` | 跑完（无 PASS/FAIL 计数） | 见下方那条观察 |

`dsh:probe` 里 `tool/write` 那一步打印的立绘仍是上一步的
`dsh-whale-state-work-slack-phone.webp`（期望 `work-meeting`）——
这是**探针注释里已经写明的 goneHold 消抖**（home 视图 4s，探针步进 4.5s 只比它多一点），
不是姿势映射坏了：同一次运行里 `tool/grep` 正确切到了 `work-idea`。
真要收紧断言，把 `HOLD_MS`（`main.js` 的 `runDshProbe`）提到 6000 以上再跑。

> `DEVELOPMENT.md` 4.8 节写的参考值是 `darkRatio≈0.052` / `coloredRatio≈0.020`；
> 本次实测是 `0.0528` / `0.0431`。**两处不必对齐**：这条断言看的是"别接近 0"（白屏），
> 阈值留了余量，而暗像素/彩色像素占比本来就随主题、字体渲染与当时那一屏的内容浮动。
> 只要两个数都明显大于 0 就是正常的。

---

## 4. 代码地图

```
src/
├─ main.js          2847 行，主进程：窗口/托盘/IPC/自检探针/「打开DSH」编排
├─ preload.js        桌宠页面的桥（window.whaleShell）
├─ settings-preload.js  设置窗口的桥（window.whaleSettings）
├─ growth-preload.js    养成窗口的桥（window.whaleGrowth）
├─ server.js         本地静态服务器：/pet/* → src/pet/*、/assets/* → vendor/whale/*
│                    + 运行时注入说话钩子（MASCOT_PATCH，锚点是 __dshWhaleMoeStarted）
├─ dsh-state.js      读 DSH 会话文件（zstd 多帧）→ 工作状态 + turn 用量 + 当前模型
├─ pricing.js        纯函数：costOf / 峰谷 / 阈值 / 格式化
├─ price-table.js    读 pricing.json，按模型 + 别名 + 峰谷取价；读 DSH 默认模型
├─ usage-today.js    今日账本：落盘、跨天归零、按 `会话#turn` 去重
├─ open-dsh.js       纯 node：「打开DSH」的探活 / token / 启动计划 / 交接起进程
├─ balance-proxy.js  内置余额代理（3020），自动读 ~/.dsh 里的 DeepSeek Key
└─ pet/
   ├─ index.html     按顺序引入上游三个文件 + preshim
   ├─ preshim.js     上游脚本运行前的最小垫片（fetch 等）
   ├─ shell.js       903 行，点击穿透判定 + 右键菜单补丁 + 头顶浮层 + 气泡按钮
   ├─ shell.css      透明画布与宿主适配（**别给 body 设 pointer-events: none**）
   ├─ settings.*     独立设置窗口（HTML/CSS/JS）
   └─ growth.*       养成 / 图鉴窗口
scripts/
├─ test-cost.mjs        无头单测（node）
├─ open-dsh-e2e.ps1     端到端真鼠标验证（见 3.2）
├─ cold-start-check.mjs 真机冷启动检查（见 3.4）
├─ check-desktop-input.ps1  桌面能不能驱动（见 3.3）
├─ verify-shell.ps1     点击穿透验证（真鼠标）
├─ refresh-prices.mjs   刷新 pricing.json（人工触发）
├─ sync-upstream.mjs    同步上游素材（会覆盖 vendor/whale）
├─ check-vendor.mjs     素材完整性
└─ push.ps1             走代理推送
```

---

## 5. 数据与接口清单

### 5.1 壳配置 `%APPDATA%\dsh-whale-desktop\config.json`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `port` | 38911 | 桌宠本地服务器端口（页面 + `/__shell/state`） |
| `scale` / `alwaysOnTop` / `autoLaunch` / `visible` / `followDsh` | 1 / true / false / true / true | 托盘与设置窗口共用的开关 |
| `costSay` / `costThreshold` | true / 0.01 | 花费播报开关与阈值（元） |
| `costPriceHit` / `costPriceMiss` / `costPriceOutput` | 0.02 / 1 / 4 | **手动单价**，只在模型不在价目表里时使用（高峰 ×2） |
| `dshUrl` | `http://127.0.0.1:3080` | 「打开DSH」要打开的地址 |
| `dshCommand` | `""` | 拉起 DSH 的命令/脚本；留空 = 自动（启动脚本 → node+bin.js → cmd+dsh.cmd → npx） |

改配置的**唯一正路**是 `setConfig`（`main.js` 里有白名单），它会 `saveConfig()` 并刷新托盘。

### 5.2 IPC 通道（全部 `shell:` 前缀）

`interactive`（鼠标穿透开关）· `pet-rect`（页面报矩形）· `get-config` / `set-config` ·
`app-info` · `settings-size`（页面报高度）· `price-info` · `reload` · `reset-position` ·
`open-path`（data/log）· `open-settings` · `open-growth` · `open-dsh` · `dsh-plan` ·
`say` · `usage-today` · `claim-quest` · `equip-badge` · `quit` · `log`

### 5.3 HTTP

| 路径 | 说明 |
| --- | --- |
| `GET /__shell/state` | **排查第一站**：`interactive` / `ignoreMouseEvents` / `petRect`（含页面自己的 `lastMouse`、`hud`、`sayHook`）/ `dsh` / `openDsh` / `openDshPlan` / `cursor` / `workArea` |
| `GET /pet/*`, `/assets/*` | 页面与上游素材（`/pet/mascot.js` 是注入过说话钩子的版本） |
| `GET http://127.0.0.1:3020/balance` | 内置余额代理（上游写死的接口） |
| `GET http://127.0.0.1:3080/` | DSH 网页；**没有 cookie 时必然 401**（browser-trust），这不是故障 |

### 5.4 页面存储（localStorage，键前缀 `whale-moe:`）

壳层自己用的：`settingsTab`（设置窗口停在哪个分类）· `weatherCity` / `weatherKey` /
`weatherLat` / `weatherLon` · `balance` / `balanceEndpoint`。
上游用的（**别改语义**，只是别被它们吓到）：`quests` / `signinStreak` / `weekSignin` /
`affinity` / `level` / `badge` / `title` / `achievements` / `journal` / `floatX` / `floatY` /
`satiety` / `mood` / `chat` / `game` / `night` / `pet` …

注意：**不同端口 = 不同 origin = 不同 localStorage**。所以 `--standalone --port=xxxxx`
的自检实例看到的是"全新的一只"（位置、偏好都是默认值）—— 自检里想验证"共享存储"，
必须用同一个端口。

### 5.5 日志

| 文件 | 内容 |
| --- | --- |
| `%APPDATA%\dsh-whale-desktop\shell.log` | 主进程 + 页面 `console` + 页面 `error` 全在这里（托盘 →「打开日志」） |
| `…\dsh-web.log` / `…\dsh-web.err.log` | 「打开DSH」自己拉起来的服务输出（stdout / stderr 分开，`Start-Process` 不允许同文件） |
| `<启动脚本目录>\dsh-web.log` | 走工作空间启动脚本那条路时，日志在**脚本旁边**（例如 `D:\DSWorkspace\dsh-web.log`），token 地址也在里面 |
| `…\usage-today.json` | 今日账本（自检实例用 `usage-today-probe.json`，避免动用户的账） |

---

## 6. 环境事实（这台机器）

- **工作区** `D:\DSWorkspace`，仓库 `dsh-whale-desktop\`。旁边是用户的 DSH 启动脚本：
  `Start-DSH-Web-Background.bat`（后台，不开浏览器，供自启）、`Start-DSH-Web.bat`（前台）、
  `restart-dsh-web.ps1`（重启助手）、`dsh-web.log`。
- **重启用户桌宠**（改完代码要让它生效）：
  ```powershell
  $exe = 'D:\DSWorkspace\dsh-whale-desktop\node_modules\electron\dist\electron.exe'
  & taskkill /PID <旧pid> /T /F
  ([wmiclass]'Win32_Process').Create('"' + $exe + '" "D:\DSWorkspace\dsh-whale-desktop"', 'D:\DSWorkspace\dsh-whale-desktop')
  ```
  用 WMI 是为了让父进程不是你的 shell（否则 shell 一退它可能被牵连）。
- **重启 DSH**：`D:\DSWorkspace\restart-dsh-web.ps1`。它按 `bin.js web` 命令行**杀所有**
  这类 node 进程 —— 包括桌宠刚拉起来的那个（这条踩过：14:12 那次"拉不起来"就是它被
  重启助手顺带杀掉，退出码 0xC000013A 是控制台事件的痕迹）。
- **推送**：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\push.ps1`
  （检测到 Clash `127.0.0.1:7890` 就走代理，只对本次生效）。
  **它的退出码经常是 1，那是 PowerShell 把 git 的进度输出当错误** —— 以
  `git ls-remote origin refs/heads/main` 的 SHA 为准。
- **npm 11+ 会拦 Electron 的安装脚本**：`node node_modules/electron/install.js` 补下载。
- `pwsh`（PowerShell 7）**不存在**，脚本一律用 `powershell`（5.1）。
- **`ELECTRON_RUN_AS_NODE` 在 DSH 会话里是 `1`**：被 agent 工具调起来的 shell 会继承它，
  于是 `electron.exe .` 被当成纯 Node 跑，探针**静默死在 `main.js:60 app.setName`**
  （重定向输出时表现为空文件 + exit 1）。跑任何 `npm run <probe>` 之前先清掉 —— 见 3.6 节。
- **文件策略是 workspace-write 时，本工作区（`D:\DSWorkspace`）上所有 pwsh 命令都会失败**：
  `SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\DSWorkspace)`，连 `Write-Output hi` 都不例外。
  这不是代码问题，是沙箱给工作区根目录改 ACL 被拒（目录属主/权限所致）；
  切到 full-access，或把工作区换到可写的目录即可。**遇到它别去怀疑项目。**

---

## 7. 血泪坑清单（现象 → 根因 → 规矩）

| 现象 | 根因 | 规矩 |
| --- | --- | --- |
| 中文文件被写坏成 `?` | PS 5.1 按 GBK 读无 BOM UTF-8，再按 ANSI 写回 | 别用 PowerShell 改仓库文本（铁律 3） |
| `.ps1` 解析报"字符串缺少终止符" | 无 BOM UTF-8 里的中文被当成 GBK | 新脚本写纯 ASCII，或存 BOM（铁律 4） |
| 改了 `scripts/push.ps1` 之后中文输出变成乱码 / git 警告 `LF will be replaced by CRLF` | **编辑工具会丢掉 BOM**，而且会写成 LF；`.gitattributes` 要求 `*.ps1` 是 UTF-8 BOM + CRLF | 改完补 BOM 并把行尾换成 CRLF（`node -e` 一行搞定），再用 `Parser::ParseFile` 复核 |
| JS 突然 `SyntaxError: Invalid or unexpected token` | 块注释里写了 `**/xxx`，`**/` 提前结束了注释 | 注释里提到路径时别用 `**/…**` 包粗体 |
| `ReferenceError` 只在探针里出现、平时没事 | 探针的 try/catch 把错误吞了，只报"断言数不符" | 探针报数不符时，先看紧邻的 `failed <msg>` 行 |
| 探针 3/5 项就结束 | 调用了**后来才声明的** `const`（TDZ） | `shell.js` 里常量声明放在使用点之前 |
| 设置窗口高一点就多出滚动条 | 异步填入的文字让那一屏变高，但高度只在初始化量过一次 | 内容变化后重新 `reportHeight()`（DEVELOPMENT 6.6） |
| 「断电」般的白屏（另有窗口时） | Chromium 原生遮挡检测把整屏置顶窗口判成"完全遮挡" | 启动时 `--disable-features=CalculateNativeWinOcclusion`（别删） |
| 右键菜单贴屏幕边溢出 | 上游用写死的 180×160 估算菜单尺寸，实际 194×292（8 项） | 壳层用实测矩形夹回视口，见 `shell.js` + `npm run menu:probe` |
| `taskkill /PID <父> /T /F` 之后服务还活着 | 父进程先退出，树枚举没抓到子进程 | **按端口收**：`Get-NetTCPConnection -LocalPort N` 拿 OwningProcess 再杀 |
| 冷启动测试"起来了但日志是空的" | 上一个用例的残留服务占着端口，探活探到的是它 | 同上：跑前跑后都按端口确认 |
| `{...process.env}` 之后 `env.PATH` 是 undefined | Windows 环境变量名不分大小写，`process.env` 是特例对象，拷成普通对象就没了 | 用 `envGet()`（`open-dsh.js`）做大小写不敏感读取 |
| DSH 401 被当成"没在跑" | browser-trust 会拒绝无 cookie 请求 | **401 = 在跑**（`probeDshWeb` 只看有没有应答） |
| 打开的是能 401 的裸地址 | `dsh web:` 那行 token 日志比"能应答"晚约 1 秒 | 探活成功后再给最多 2 秒补 token（已实现） |
| 拉起来的服务死得莫名其妙（`^C` + 0xC000013A） | 直接 spawn 的子进程和桌宠共用一个隐藏控制台 | 交给 shell 起：`Start-Process -WindowStyle Hidden`（DEVELOPMENT 6.7.3） |
| `verify:shell` 时过时不过 | 桌面不可驱动（锁屏/RDP），`SetCursorPos` 返回 False | 先跑 `check-desktop-input.ps1`（第 3.3 节） |
| localStorage 里没有用户的偏好 | 自检实例换了端口 = 换了 origin | 见 5.4 的注意 |

---

## 8. 常见维护动作（照着做就行）

**加一条右键菜单项**：在 `src/pet/shell.js` 的 `watchMenu` 里做（`stripNonInteractionItems`
之后、`clampIntoViewport` 之前），参考 `injectOpenDshItem`：自己建 `<button>`、插到
「关闭菜单」前面、点击时 `stopPropagation()` + `menu.remove()`。
**别改 `vendor/whale/dsh-whale-moe.js`**。加完在 `settings:probe` 里补一条断言。

**加一个设置项**：① `settings.html` 里放进对应 `<section data-panel="…">` 的分组
（导航是页面按 h2 自动生成的，加屏就多一项）；② `settings.js` 里用 `row(label, hint, control)`
追加；③ 主进程 `DEFAULT_CONFIG` + `set-config` 白名单；④ `settings:probe` 的
`expectedRows` 加上这个 label；⑤ 文档（README 表格 + CHANGELOG）。

**加一个自检探针**：`argValue('xxx-probe')` 开关 → 加进 `PROBE_MODE`（这样它会与常驻实例
并存）→ `did-finish-load` 里分发 → 写 `runXxxProbe()`（末尾 `expected` 计数）→
`package.json` 加脚本 → 文档第 3 节。

**改价目表**：`npm run refresh:prices`（抓官方页面 → 解析 → 打印 diff → 写文件）。
解析不出完整表格就会报错且不写文件。`--dry-run` 只看结果，`--from-file x.html` 用离线页面。
加模型/别名直接编辑 `pricing.json`（`models` / `aliases`），改完 `npm run test:cost` 会
帮你核对 flash 的官方价与"未知模型回落手动配置"。

**发版**：`package.json` 版本 + `CHANGELOG.md`（新增/变更/修复分开写，附上**现场证据**
和取舍理由）+ 需要时更新 `README.md` / `docs/DEVELOPMENT.md` 的对应章节 →
第 3 节自检 → 重启常驻实例 → 提交（标题 `feat:` / `fix:` + 一行结论，正文写清取舍与验证）
→ `scripts/push.ps1`。

---

## 9. 已知限制与待办

**限制**（都写在文档/注释里了，不要当成 bug 修）：

- 只铺满**主显示器**工作区，多屏未支持。
- 花费用量按 turn 累加，**子代理（subagent）的 token 也计入**；账本只覆盖**当前正在跟的
  那个会话**（换会话前的账在旧文件里）。
- 计费**不处理中国法定节假日**（那几天官方按空闲价，我们会高估最多一倍）。
- 余额查询依赖上游的余额状态（页面每 60 秒刷新）+ 内置代理；代理端口被占时不启动。
- 「打开DSH」不会替你重启正在跑的 DSH（设计如此）。
- 未打包：`electron-builder` 还没接（路线图第 2 项）。

**路线图**（README 末尾同步维护）：多显示器 / 打包免安装 exe / 全局快捷键自定义 /
每屏一只 / 花费播报的节假日与主-子代理区分。

**如果想继续做的两件小事**：① 设置窗口里给 `dshCommand` 一个输入框（现在只能改 config.json，
`dshPlan` IPC 已经把"当前会走哪条路"暴露出来了，接上去很直接）；② `main.js` 里
`openSettingsWindow` 还没复用 `createAuxWindow` 辅助函数（成长窗口用了）。

---

## 10. 交接待办检查单

新对话开工前，逐条打勾：

- [ ] `git log --oneline -5` + `git status` 看清本地与远端是否同步（`npm run` 之前先确认版本号）
- [ ] `npm run test:cost` 与 `npm run check:vendor` 绿（证明代码与素材都没坏）
- [ ] `npm run open-dsh:probe` / `settings:probe` 绿（探针数与文档一致）
- [ ] `scripts/check-desktop-input.ps1` 的退出码知道是 0 还是 3（决定能不能跑真鼠标那两条）
- [ ] 常驻桌宠在跑吗？端口 `38911` 有应答吗？`GET /__shell/state` 能读到吗？
- [ ] 用户数据目录里的 `shell.log` 看一眼最近 50 行 —— 上一个对话留下的线索常常就在里面
- [ ] 动手前想清楚：这属于"和她互动"（右键菜单）/ "高频开关"（托盘）/ "需要解释的配置"
      （设置窗口）/ "唤起 DSH"（右键菜单里那一条）——四处的职责划分见 DEVELOPMENT 4.9
- [ ] 改完：第 3 节自检 → 重启常驻实例 → 文档与版本同步 → 提交并推送（用 `ls-remote` 确认）

---

## 11. 一句话交代

这是一个**壳层适配**项目：上游素材原样复用，所有适配都在 `src/` 里，靠"注入 + DOM 后处理"
而不是改素材；每个功能都配了可复现的探针，**证据优先于感觉**（谁死在哪一行、
哪个像素溢出、哪个进程还在监听）。维护它的正确姿势是：先读 `shell.log` 与 `/__shell/state`，
再动代码；改完把探针跑绿、把常驻实例重启、把文档和版本一起更新。

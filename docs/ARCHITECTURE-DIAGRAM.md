# 项目框架图 · dsh-whale-desktop

> 一页看完这个项目长什么样。**带排版的版本**见 [`ARCHITECTURE-DIAGRAM.html`](./ARCHITECTURE-DIAGRAM.html)（浏览器打开，图更清楚）。
> 分工：本文件与 HTML 回答「**整体长什么样**」，[`HANDOVER.md`](./HANDOVER.md) 回答「**怎么接手**」，
> [`DEVELOPMENT.md`](./DEVELOPMENT.md) 回答「**为什么这样设计**」。行号与行数取自当前工作副本（0.12.3）。

---

## 1. 一句话定性

**壳层适配**项目：上游桌宠素材（`vendor/whale/`）**一个字都不改**，所有适配都在 `src/` 里，
靠**运行时注入 + DOM 后处理**（不是改素材、也不是字符串替换源码）把它从 DSH 网页里搬成独立 Electron 挂件。

---

## 2. 总览拓扑

```
┌─ 宿主环境（不属于本仓库）──────────────────────────────────────────────────────┐
│  DSH 网页 127.0.0.1:3080 (browser-trust)   ~/.dsh (sessions/settings/credentials) │
│  工作区启动脚本 Start-DSH-Web-Background.bat    api.deepseek.com/user/balance      │
└────────────▲ 只读观察 / 唤起（绝不重启）──────────│ 读会话文件·拉起服务·代理余额 ──┘
             │
┌─ ① 主进程 src/main.js (2847 行) ─────────────────────────────────────────────┐
│  createWindow L224   整屏透明置顶 + 默认 setIgnoreMouseEvents(true,{forward})  │
│  startCursorPolling L311   每 80ms 推「屏幕光标 - 窗口原点」→ 穿透判定的命门     │
│  registerIpc L2515   24 条 shell:* 通道（唯一决策层）                          │
│  DEFAULT_CONFIG L134 + setter L650-705（末尾一律 refreshTrayMenu()）           │
│  startDshWatcher L333 · handleTurnEnd L417 · openDshWeb L2415 · 7 个探针 L790+ │
└────────────▲ preload 桥 (whaleShell) ──────────│ webContents.send 推送 ────────┘
             │
┌─ ② 渲染进程：三个同源文档 src/pet/* ────────────────────────────────────────┐
│  index.html 桌宠页 · settings.* 设置窗口(6 分类) · growth.* 养成/图鉴(5 标签页)  │
│  同源 ⇒ 共享 localStorage(whale-moe:*) ⇒ 设置窗口写、桌宠页收 storage 事件       │
│  再派发上游的 whale-moe-prefs-change —— 跨窗口同步不写 IPC 的全部秘密           │
└────────────▲ HTTP ────────────────────────│ 静态资源 + 运行时注入 ───────────┘
             │
┌─ ③ 本地服务器 src/server.js (195 行) ───────────────────────────────────────┐
│  /                 → src/pet/index.html                                      │
│  /assets/*         → vendor/whale/*（上游写死的绝对路径，原样映射）             │
│  /pet/*            → src/pet/*                                               │
│  /pet/mascot.js    → 同一份上游文件 + 注入 __dshWhaleMoeSay（磁盘文件不动）      │
│  /__shell/state    → 自检端点（排查第一站）                                    │
└────────────▲ 只读素材，永不写入 ─────────────────────────────────────────────┘
             │
┌─ ④ 上游素材 vendor/whale/ (MIT, v2.1.0, 零改动) ────────────────────────────┐
│  dsh-whale-moe.js 桌宠本体 · whale-moe-core.js UMD 纯状态机(39 成就/称号/任务)  │
│  dsh-whale-moe.css（容器 pointer-events:none、可交互件 auto）· 92 张立绘       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 核心机制：点击穿透

| 问题 | 做法 |
| --- | --- |
| 窗口为什么铺满整个工作区 | 上游把位置存在 `floatX/floatY`（**视口坐标**）、拖拽逻辑在它内部；窗口只有桌宠大就会一拖就被裁 |
| 怎么知道指针压到她 | `elementFromPoint` 命中 html/body 之外 ⇒ 命中（吃上游 CSS 的 none/auto 结构） |
| **为什么不靠页面的 mousemove** | Windows 上 `forward:true` 转发不可靠，实测收不到 `mousemove` → 她永远点不动；改用**主进程 80ms 轮询**（确定性） |
| 两条路径 | 轮询（主通道）与页内 `mousemove`（快通道）都汇进 `applyCursor()`；判定正确性由轮询保证 |
| 兜底 | `blur` / `mouseleave` 回穿透；有右键菜单时不抢 |
| **不变量** | **绝不能给 body 设 `pointer-events:none`** —— 会被子元素继承，上游弹到 body 上的菜单全变不可点 |

---

## 4. 数据流 A：DSH 工作状态（只读会话文件）

```
~/.dsh/sessions/<ws>/session-<id>/session.v3.jsonl.zstd   ← 多帧拼接 zstd（magic 28 B5 2F FD）
  │ 只读新增字节、按 magic 切帧；正在写的最后一帧解压失败 ⇒ 不推进 offset，下轮重试
  ▼
src/dsh-state.js  ingest() L275
  turn/start → inTurn · tool/call → lastType=tool · turn/end → flash(success|failure)
  tool/result(error) → failure · request/header → 当前模型
  │ recompute() L357：busy = inTurn && !idleTooLong（**stale 绝不回写 inTurn**）
  ▼
shell:dsh-state ──► src/pet/shell.js applyDshState() L851
  按需创建/删除 <i>：thinking=data-status=pending · tool=data-running(工具关键词)
                    success=data-state=success · failure=data-status=error
  │ 上游状态机据此选立绘与姿势（textContent 经 detectToolPose 按关键词表顺序敏感匹配）
  ▼
上游 __dshWhaleMoeDebug（探针读它断言"上游认成了什么"）
```

两条硬约束：合成节点必须 **>1px / 与视口相交 / opacity 不能正好是 "0"**；**error 节点必须按需新建、闪完即删**
（上游把启动 settle 窗口内已存在的错误节点当历史忽略）。

---

## 5. 数据流 B：花费播报与今日账本

```
turn/end ──┬─► costOf(usage, rates)          单价：pricing.json → price-table.resolveRates()
           │     缓存命中/未命中**分开算**；reasoningTokens 是 outputTokens 子集**不再加**
           ├─► 记账（无条件）UsageLedger：落盘、本地日期归零、`会话#turn` 去重、只收今天
           └─► 播报（有条件）实时 turn + costSay + ≥ costThreshold(0.01 元)
                  └─► sayToPet() → executeJavaScript → __dshWhaleMoeSay(text, 5000)
```

| 模块 | 只回答一个问题 |
| --- | --- |
| `pricing.json` | 官方价目表（运行时**只读、不联网**，人工 `npm run refresh:prices` 刷新） |
| `price-table.js` | **此刻该用哪一档价**（模型 + 别名 + 峰谷）；不在表里 ⇒ 回落手动配置（高峰 ×2） |
| `pricing.js` | **怎么乘**（纯函数 `costOf` / `isPeak` / 格式化），不判断时段 |
| `usage-today.js` | **今天一共多少**（落盘 + 回放当天历史 + 去重 + 跨天归零） |

余额链路：官方接口形状 ≠ 上游要的形状 ⇒ `balance-proxy.js`（3020）取 Key、转字段、**补 CORS**（端口不同就是跨源，缺头会静默失败）；
上游把地址写死 ⇒ `preshim.js` 在**上游脚本之前**加载，只拦那一个 URL 重写到 `whale-moe:balanceEndpoint`。

---

## 6. 数据流 C：「打开DSH」启动决策

```
probeDshWeb()  ── 401 也算「在跑」（只看有没有应答）
   ├─ 在跑 ⇒ 只 shell.openExternal，一个进程都不动（token 每次启动都换，重启会打断用户会话）
   └─ 没跑 ⇒ resolveLaunchPlan() 挑路
              1 用户配置 dshCommand
              2 工作空间启动脚本（**仅当地址是默认 3080**，脚本不接受 --port）
              3a node <dsh>/lib/bin.js web --no-open --port P
              3b cmd /c <dsh.cmd> web …        3c npx --yes @deepseek-ai/dsh web …
        ⇒ buildHandoffScript() 交给 PowerShell `Start-Process -WindowStyle Hidden -PassThru`
          （**不能 spawn 到自己身上**：GUI 进程的隐藏控制台被 Ctrl+C 就整串带走）
          ⇒ 回传 DSHLAUNCHPID，轮询等应答（60s），每轮捞 token 地址 + 看进程是否早死
          ⇒ 探活成功后再给最多 2 秒补齐 token（否则退化成打开裸地址 → 无 cookie 者 401）
拉起前摘掉 DSH_SHELL / DSH_SESSION_ID / DSH_WEB_URL（保留 DSH_HOME）；一律 --no-open。
```

---

## 7. 入口职责划分

| 入口 | 放什么 | 关键约束 |
| --- | --- | --- |
| 右键桌宠 | **只放对她做的事 + 唤起 DSH**（投喂/戳/夸/小游戏/回到原位/打开DSH） | 壳层在此摘掉上游「打开看板娘设置」并补进「打开DSH」——**先摘后补**；再用实测矩形夹回视口（上游写死 180×160，实测 8 项是 194×292） |
| 托盘 | 高频全局动作 + 快速开关（显示/置顶/跟随/自启/大小/重置/重载/数据目录/日志/设置…/退出） | 与设置窗口共用同一份 config；**新增改 config 的 setter 末尾必须 `refreshTrayMenu()`** |
| 设置窗口 | 需要解释的配置项，6 分类 | 导航由 `<section data-panel>` 的 `<h2>` 自动生成；高度由**页面**量后经 `shell:settings-size` 上报（**不能用 `body.scrollHeight`**） |
| 气泡 ⚙ 浮层 | 状态（天气/余额）+ 入口（日常养成/余额查询） | 四个可点元素统一「**先收起、再执行**」 |

---

## 8. 上游契约层（壳与上游之间只有这几根线）

**全局对象**：`DshWhaleMoeCore`（UMD 纯状态机）· `__dshWhaleMoeSay`（server.js 注入）·
`__dshWhaleMoeWeather` / `__dshWhaleMoeBalance`（上游闭包引用，壳层写回被上游共用）·
`__dshWhaleMoeClaimQuest` / `__dshWhaleMoeApplyBadge`（主进程 `executeJavaScript` 直调，副作用留在页面）·
`__dshWhaleMoeDebug`（探针断言用）。

**DOM 钩子**：`[data-dsh-whale-root|frame|layer|context|prefs|bubble|gear|gear-mini]`。

**两根必须记住的依赖**：
① 上游 CSS 是**容器 `pointer-events:none` / 可交互件 `auto`** —— 穿透判定成立的前提；
② 上游给 rootNode 的 click **全部 `stopPropagation`** —— 所以"能冒泡到 `document` 的点击"天然等于"点在她之外"。

**IPC 通道**（全部 `shell:` 前缀）：`interactive` · `pet-rect` · `cursor` · `dsh-state` · `get-config` / `set-config`（白名单）·
`app-info` · `price-info` · `settings-size` · `open-settings` · `open-growth` · `open-dsh` · `dsh-plan` ·
`say` · `usage-today` · `claim-quest` · `equip-badge` · `reload` · `reset-position` · `open-path` · `log` · `quit`。

**HTTP**：`/__shell/state`（**排查第一站**）· `/pet/mascot.js`（注入版）· `/assets/*` · `/pet/*` ·
`127.0.0.1:3020/balance` · `127.0.0.1:3080/`（**无 cookie 必然 401，不是故障**）。

---

## 9. 启动时序（`app.whenReady`）

1. 模块装载：`app.setName` → 追加 `--disable-features=CalculateNativeWinOcclusion`（**别删**，否则新窗口白屏）
2. 参数解析 → `PROBE_MODE`（任一 `--xxx-probe`/`--standalone`/`--port=` ⇒ 跳过单实例锁 + 强制 dry-run）
3. 单实例锁 → `loadConfig()` → `registerIpc()` → `startPetServer()`（失败 `app.exit(1)`）
4. `createWindow()` + `createTray()`；`did-finish-load` 里按模式分发探针
5. 价目表 → **6. 账本（必须先于 watcher，否则启动回放的那批账会丢）** → 7. `startDshWatcher()` → 8. 余额代理 → 9. 自启校正 + `Alt+Shift+W`

退出：`will-quit` 依次关 快捷键 / watcher / 两个辅助窗口 / 代理 / server。

---

## 10. 自检矩阵

| 命令 | 断言数 | 验什么 | 真鼠标 |
| --- | --- | --- | --- |
| `npm run test:cost` | 33 | 计价 / 峰谷 / 阈值 / 格式化 / turn 累加 / primed 闸门 / 今日账本 / 价目表 / 刷新解析器（不需要 Electron） | 否 |
| `npm run check:vendor` | — | 上游素材完整性（4 文件 + ≥50 张立绘，实际 92） | 否 |
| `npm run open-dsh:probe` | 11 | 地址归一化 / token 解析 / 四条启动分支 / 环境摘标记 / 已跑不起进程 / 交接起进程 / token 地址 / **进程不在桌宠进程树里** / 早死即报错 / 超时 / 菜单项链路（全程 dry-run） | 否 |
| `npm run settings:probe` | 20 | 右键菜单构成 + 设置窗口（6 分类 / 高度 / 往返 / 单价区 / 与托盘勾选同步 / 像素级白屏断言） | 否 |
| `npm run growth:probe` | 20 | 养成窗口 5 标签页 + 领取 + 佩戴 + HUD 两按钮实测尺寸 | 否 |
| `npm run say:probe` | 8 | 气泡可见完整文本 + 打完字 3 秒仍可见 + 到点消失 + 点击立刻收起 + 低阈值不播报 | 否 |
| `npm run menu:probe` | — | 菜单不越界（打印实测像素 + PASS/FAIL + 截图） | 否 |
| `npm run dsh:probe` | — | 状态联动"日记"（步进必须 >4.5s，上游有 goneHold 防抖） | 否 |
| `npm run verify:shell` | 3 | 真的移动指针验证点击穿透 | **是** |
| `npm run e2e:open-dsh` | — | 端到端真鼠标点菜单项把 DSH 拉起来（隔离 `DSH_HOME`） | **是** |
| `npm run cold:start` | — | 真机冷启动 `dsh web`（打印 plan / ready=?s / token=?s） | 否 |
| `npm run shot` | — | 无屏幕时看截图 + DOM 状态 + **原始位图 alpha** | 否 |

真鼠标那两条先跑 `scripts/check-desktop-input.ps1`：退出码 **0** = 能跑，**3** = 环境不可驱动（锁屏/RDP，**不是代码问题**）。
每个探针有 `const expected = N`（main.js L1244=20 / L1405=8 / L1819=11 / L2192=20），**改断言就要同步改它**。

---

## 11. 维护地图

| 要加的东西 | 动哪些文件 |
| --- | --- |
| 一条右键菜单项 | `src/pet/shell.js` 的 `watchMenu`（摘项之后、夹取之前，参考 `injectOpenDshItem`）→ `settings:probe` 补断言。**别改 vendor** |
| 一个设置项 | ① `settings.html` 对应 `<section data-panel>` → ② `settings.js` 的 `row()` → ③ 主进程 `DEFAULT_CONFIG` + `set-config` 白名单 → ④ `settings:probe` 的 `expectedRows` → ⑤ 文档 |
| 一个自检探针 | `argValue('xxx-probe')` → 加进 `PROBE_MODE` → `did-finish-load` 分发 → `runXxxProbe()`（末尾 `expected`）→ `package.json` → 文档第 3 节 |
| 改价目表 | `npm run refresh:prices`（解析不出完整表格就报错且**不写文件**）；加模型/别名直接编辑 `pricing.json` |
| 同步上游 | `npm run sync:upstream [-- vX.Y.Z \| --from-local]` → `npm run shot` 确认 `layerLoaded: true` → `npm run check:vendor` |
| 发版 | `package.json` + `CHANGELOG.md`（附**现场证据**与取舍）→ 自检 → **重启常驻实例** → 提交 → `scripts/push.ps1` |

**重启常驻实例**（用 WMI 是为了让父进程不是当前 shell）：

```powershell
$exe = 'D:\DSWorkspace\dsh-whale-desktop\node_modules\electron\dist\electron.exe'
& taskkill /PID <旧pid> /T /F
([wmiclass]'Win32_Process').Create('"' + $exe + '" "D:\DSWorkspace\dsh-whale-desktop"', 'D:\DSWorkspace\dsh-whale-desktop')
```

收进程**按端口**（`Get-NetTCPConnection -LocalPort N` 拿 OwningProcess），不要只靠 `taskkill /T`。

---

## 12. 铁律（违反会静默坏掉）

1. **绝不改 `vendor/whale/`** —— `sync:upstream` 会覆盖；改行为走注入 / DOM 后处理 / 垫片
2. **绝不重启正在跑的 DSH** —— 每次启动换 token，会打断用户正在聊的会话
3. **不要用 PowerShell 改仓库文本文件** —— PS 5.1 按 GBK 读无 BOM UTF-8、按 ANSI 写回，中文成片变 `?`
4. **`.ps1` 含中文必须 UTF-8 with BOM**（新脚本写纯 ASCII 更省事；编辑工具会丢 BOM 并写成 LF）
5. **改断言同步改 `expected`** —— 否则"跑绿了"其实是少跑了
6. **探针不许有副作用** —— 不弹浏览器、不改用户配置、不写用户账本
7. **不替用户决定启停** —— 对 DSH 只做只读观察与唤起
8. **注释里别写 `**/xxx`** —— `**/` 会提前结束块注释

**已知限制**：只铺主显示器 · 子代理 token 也计入且账本只覆盖当前会话 · 不处理法定节假日 ·
余额依赖上游 60s 刷新与内置代理 · 未打包（`electron-builder` 待接）· `openSettingsWindow` 尚未复用 `createAuxWindow`。

---

## 13. 核对记录：真偏差 / 已修 / 我自己搞错过的

> 这一节是**修正后**的版本。初稿里有两条"偏差"其实是**我用错命令读出行数**得出的假结论，
> 留着记录是因为那条命令在这个环境里还会骗别人（见第 2 条）。

### 13.1 真偏差（已修）

| # | 偏差 | 处理 |
| --- | --- | --- |
| 1 | `docs/HANDOVER.md` 第 1 节写版本 **0.12.1**，实际 `package.json` = **0.12.2** | 已改 HANDOVER（它自己也写了"以 package.json 为准"） |
| 2 | `docs/DEVELOPMENT.md` 4.9 节表格写设置窗口"**分 4 类**" | 已改为 **6 类**并列出名称（README / HANDOVER 写的 6 类一直是对的，`settings.html` 实测 6 个 `data-panel`） |
| 3 | `scripts/sync-upstream.mjs` 写 `vendor/upstream.json` 时只写 `{upstream,tag,syncedAt}`，**覆盖**掉首次 vendor 留下的 `method` / `packageVersion` | **已修**：改成 `readMeta()` + `writeMeta(patch)` **合并写**，两个字段实测保留（`--from-local` 条路原先根本不写这个文件，现在也写） |

### 13.2 两条"行数偏差"是假结论 —— 是我读错了

初稿说 HANDOVER 的 `main.js` 2628 行 / `shell.js` 819 行"过时"。**错的是我的命令，不是文档。**

- 我用 `Get-Content <file>).Count` 数行，在本机得到 `main.js = 2628`、`shell.js = 819`；
- 换成按 **LF 字节数**（Node `fs.readFileSync`）与 **git blob** 数，两个来源一致给出
  `main.js = 2847`、`shell.js = 903`，工作区是 **LF**（不是 CRLF），提交里的 blob 也是同一份内容；
- 也就是说 **HANDOVER 的 2628 / 819 本来就不对**（它记的是更早版本的行数），
  而我用 `Get-Content` 数出来的那个数**碰巧和它一样** —— 两边都不对，我却据此宣布"文档漂移 + 我的图是对的"。

**结论：以 `git show HEAD:<file>` 或 Node 的 LF 计数为准；这份框架图里的行数已按此复核过一遍。**
`Get-Content | Measure-Object -Line` 在这台机器上会少报（原因未深究，可能与该 cmdlet 对 LF 结尾的处理有关），
**别用它数行**。

### 13.3 环境坑（不是项目问题，但会咬到维护者）

| # | 现象 | 说明 |
| --- | --- | --- |
| 1 | 在 DSH 会话里跑 `npm run <probe>` 直接死在 `main.js:60 app.setName` | `ELECTRON_RUN_AS_NODE=1` 被继承了，`electron.exe` 被当成**纯 Node** 跑。清掉即可：`cmd /c "set ELECTRON_RUN_AS_NODE=&& …"`。重定向输出时表现为"空文件 + exit 1"，极易误判成"探针没跑" |
| 2 | DSH 沙箱在本工作区报 `SetNamedSecurityInfoW failed (Win32 5)` | 快照里文件策略为 workspace-write 时，**任何** pwsh 命令都会失败（连 `Write-Output hi` 都不行）；切到 full-access 后正常。与项目无关 |
| 3 | 探针日志里 `[shortcut] register failed Alt+Shift+W` | 常驻实例占着热键，正常现象 |

### 13.4 本次实测底账（跑的是 0.12.2 的代码，随 0.12.3 提交）

> 之后只改了**文档**与 `scripts/sync-upstream.mjs`（`node --check` 复核过），
> 没有动任何被探针覆盖的运行时代码。

| 命令 | 结果 |
| --- | --- |
| `npm run test:cost` | **33/33 PASS** |
| `npm run check:vendor` | **OK** — 4 个文件 + 92 张立绘（v2.1.0） |
| `npm run open-dsh:probe` | **11/11 PASS**（dry-run，未弹浏览器） |
| `npm run settings:probe` | **20/20 PASS** |
| `npm run growth:probe` | **20/20 PASS** |
| `npm run say:probe` | **8/8 PASS** |
| `npm run menu:probe` | **PASS** — 194×292、8 项、四向溢出 0 |
| `npm run dsh:probe` | 跑完（无计数）。`tool/write` 那步的立绘仍是上一步的 `work-slack-phone`，属**探针注释已写明的 goneHold 消抖**（步进 4.5s 只比 4s 多一点），同一次运行里 `tool/grep → work-idea` 是对的 |

> `verify:shell` / `e2e:open-dsh` 这两条**真鼠标**的没有跑（它们会真的移动系统指针）。
> 要跑先看 `scripts/check-desktop-input.ps1` 的退出码：`0` = 能跑，`3` = 环境不可驱动。

### 13.5 另外两条容易踩但不显眼的约束

- `shell.css` L19-22：**绝不给 `body` 设 `pointer-events:none`**（会被子元素继承，上游弹到 body 上的菜单全变不可点）。
- `settings.css` L63-68：`.shell` / `.pane` / `.rail` **不能有纵向 margin**（否则 `naturalHeight()` 量出来少几像素，平白多一条滚动条）。
- 附带：`shell.js` L337-340 有个 TDZ 调用时序约束（那里不能同步调 `ensureHud()`，`HUD_ID` 是后声明的 `const`），与 HANDOVER 第 7 节"探针 3/5 项就结束 = TDZ"是同一类坑。

# 更新日志

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号遵循语义化版本。

## [1.0.2] — 2026-11-20

断线重连终于不再依赖用户手工修地址。

### 修正

- **扩展每次 DSH 重启都会掉线，而且再也连不回来。** 桥接原本挂在 DSH 自己的 Web 服务器上，
  而那个端口是 `port: 0` 由系统分配的——今天 57232，明天 50949。扩展里存的是上一次的地址，
  于是重启之后它拨一个已经不存在的端口，退避循环再努力也没用，只能由用户去选项页改 URL。
  现在插件自己占一个固定回环端口（默认 `8971`）跑同一套握手和同一道令牌闸门；
  Web 服务器上那条路由保留为「端口被别的进程占住」时的退路，并在日志里说清楚。
- 已经装过扩展的用户不用手动改：拨号失败且存的地址不是默认端口时，会自动回退到固定端口、
  写回 `chrome.storage`，状态栏标明「moved to the fixed bridge port」。
- 拨号失败但地址已经是默认端口时（DSH 还没起来），会主动排一次退避重连。
  之前只有 socket 打开过才会有 close 事件驱动重试，冷启动时等于什么都不发生。

### 新增

- `lib/listener.js`：独立回环监听器。端口被占只降级不报错，普通 HTTP 请求得到 404，
  `close()` 幂等并关闭残留连接（否则插件重载的 disposer 会卡住）。
- 插件配置新增 `port` / `host` 两项，并能在插件页的「桥接端口」卡片里改；
  `port` 用 Standard Schema 校验（1–65535），因为非法端口的唯一症状是挂载时的一行警告。
- `test/listener.test.mjs`：绑定、端口被占降级、幂等关闭、关闭后端口可复用，10 项。

### 测试

`node _work/run-tests.mjs` → 7 个文件全 PASS（actions 27 / bundle-shape 8 / dialog /
listener 10 / settings 36 / tool-contract 40 / ws-bridge）。

## [1.0.1] — 2026-11-19

在真实 Chrome 157 上把 v1.0.0 的工具面逐项跑了一遍，修掉四个只有跑真浏览器才会暴露的缺陷。
桩测试看不到它们，因为问题都出在 Chrome 怎么应答 CDP，而不是调用的形状。

### 修正

- `windowState` 在同时传 `focused: false` 和 `state` 时被 Chrome 整体拒绝（`Invalid value for state`）。
  `focused` 现在只在真要聚焦时才发出去，结果等价：窗口照样变，桌面照样不被抢。
- `drag` 会死锁。按下之后浏览器进程扣住后续每个鼠标事件的 ack 直到手势结束，
  逐条 await 中间移动就把该标签页的队列占死了。更糟的是按压标志是进程级的：
  一次卡住的 press 会让**所有标签页**的点击被静默吞掉（hover 还正常）。
  现在中间移动并发发出不等 ack，抬起有自己的截止时间，失败时用
  `Input.cancelDragging` + 视口中心释放来复位（`(0,0)` 会被判越界，反而清不掉标志）。
- `fill` 缺少逐字段前置校验，坏选择器会把文本送进当前获得焦点的字段。
  现在每个字段先探一次，分别报「找不到 / 只读 / 文件输入 / checkbox 等无文本可填 / select 需要 kind」。
- `geolocation` 单靠 `Emulation.setGeolocationOverride` 不生效：权限停在 `prompt`，
  `getCurrentPosition` 直接超时。必须先按站点写一条 `chrome.contentSettings.location`
  （类型名是 `location` 不是 `geolocation`）的 allow。
- `timezone` 用不了 CDP 的时区覆盖（`only available to trusted clients`），
  改为页面级 Date/Intl shim + `Page.addScriptToEvaluateOnNewDocument`，跨导航存活。

### 新增

- `chrome_use_interact` 新增 `reset`：`Input.cancelDragging` + 视口中心释放，解掉卡住的按压态。
- 扩展权限新增 `contentSettings`、`geolocation`（只服务 `action geolocation`）。
- `_work/api-push.mjs`：`github.com:443` 不通时用 Git Data API 推出**同一个** commit sha。

### 实测

夹具页 `http://127.0.0.1:4599/`，Chrome 157：独立窗口（background + minimized）、
windowState normal/minimized/maximized、closeWindow、drag 真实 drop、fill 拒绝文件输入、
handoff 由人点击后继续、slow3g 447ms vs 3ms、offline、network clear、
geolocation 35.6762/139.6503、timezone Asia/Tokyo 跨导航、markdown 35 chars、
table Pricing、metrics、元素截图 320x120、reloadExtension。

## [1.0.0] — 2026-11-19

第一个可用于日常的版本：七个工具覆盖「读页面 / 点东西 / 抓证据 / 换环境 / 无人值守」，
插件页把这七个工具和它们的开关摆在明面上。

### 新增

**工具面**

- `chrome_use_tabs` 新增 `window` / `windowState` / `closeWindow`：`chrome.windows.create({focused:false})` 开一个不抢焦点的新窗口，自动化在里面跑，人和模型各用各的窗口。
- `chrome_use_interact` 新增 `drag`（按下—12 步插值—抬起）、`fill`（一次填完整张表单，逐字段容错）、`handoff`（在页面底部画一条提示栏，等人登录或确认支付后再继续）、`network`（`offline`/`slow3g`/`fast3g`/`slow4g` 预设或显式延迟与带宽）、`geolocation`、`timezone`。
- `chrome_use_read` 新增 `markdown`（readability-lite 正文抽取，比快照便宜得多）、`table`（表头 + 行）、`metrics`（DOM 节点数、JS 堆、layout/recalc 次数、脚本与任务耗时、CLS）。
- `chrome_use_capture` 新增 `ref` / `selector`：只截一个元素，长页上比整页截图可读。
- 所有模拟类动作接受 `clear: true`，还原真实值。

**可靠性**

- `chrome_use_status` 打印扩展的 build stamp，并支持 `reloadExtension: true` 让扩展自己重载——「自动重连」和「真的换了代码」从此可以区分。
- 字段级错误隔离：`fill` 的每一项都单独报告成功或失败，不因为一个坏选择器丢掉整张表单。
- 输入类命令在看门狗或 `Page.javascriptDialogOpening` 触发时返回 `ABANDONED`（动作已发生）而不是报错，避免模型重复点击。

**插件页**

- 「功能清单」新增「功能 / Does」列，每个工具一句中英文简述，数据来自 `/dsh-chrome-use/state` 的 `tools[].summary`。

### 修正

- 插件设置写入曾经绕过 schema 校验：Cordis loader 只读 `default` 导出，`Config` 必须挂在 `default` 对象上，否则 `resolveConfig` 直接放行，非法值会被写进 `cordis.patch.yml`。现在未知键与非法值一律 400。
- Shadow DOM 里的控件曾被自己的宿主误判为「被遮挡」，点击被拒绝；改为按穿透后的最上层元素判定。
- 作用域快照重置 `ref` 编号后可能匹配到上一次快照的残留节点；每次快照先清掉旧的 `data-dsh-ref`。
- 扩展曾在宿主断开后永不重连（把 close code 1000 当正常断开），并可能在拨号无响应时永久卡在 `connecting`。
- JS 对话框会锁死按标签页的命令队列；现在回答对话框走旁路队列，并区分「事件没送到」与「确实被弹窗挡住」。

### 修正（v1.0.0 实测阶段追加）

- `windowState` 传 `focused: false` 与 `state` 会被 Chrome 整体拒绝（`Invalid value for state`）；改为只在真要聚焦时才带 `focused` 字段。
- `drag` 逐条等待中间的 `mouseMoved` 会死锁：按下后浏览器进程扣住 ack 直到手势结束。而且按压标志是进程级的，一次卡住的 press 会让所有标签页的点击被静默吞掉。改为并发发出中间移动、旁路释放、`Input.cancelDragging` 兜底，并在卡住时主动复位指针。
- `fill` 增加逐字段前置校验：坏选择器不再把文本送进上一个焦点字段，文件输入、只读控件、checkbox/radio、select 都会给出具体原因。
- `geolocation` 需要 `chrome.contentSettings.location`（类型名是 `location`，不是 `geolocation`）配合 `Emulation.setGeolocationOverride`，否则权限停在 `prompt`。
- `timezone` 的 `Emulation.setTimezoneOverride` 对扩展客户端不可用（`Timezone override is only available to trusted clients`）；改为页面级 shim + `Page.addScriptToEvaluateOnNewDocument`，跨导航存活。

### 已知边界

- 只能驱动 Chromium 系浏览器。
- 跨源 iframe 只报 `src`，需要单独开标签页操作。
- 命令队列按标签页串行，不同标签页天然并行。
- 插件页依赖浏览器登录 cookie 或本地调用方的 `?token=`；直接开新标签页访问 `127.0.0.1:<port>` 会被 401 挡住。

## [0.1.0]

内部原型：`status` / `tabs` / `navigate` / `snapshot` / `interact` / `read` / `capture` 七个工具，
WebSocket 直连桥（不走 native messaging），CDP 全能力，Shadow DOM 与同源 iframe 穿透，
截图走 attachments 服务，插件页提供连接状态与功能开关。

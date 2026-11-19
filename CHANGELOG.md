# 更新日志

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号遵循语义化版本。

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

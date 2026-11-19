# DSH Chrome Use

让 DSH 直接操作**你自己的 Chrome**：读页面、点按钮、填表单、切标签页、抓截图、看控制台和网络请求。

Codex 有一个官方 Chrome 插件；这个项目是给 DeepSeek Harness 的等价物，走的是另一条更省事的路：**不需要 native messaging 宿主、不写注册表、不开第二个端口**。DSH 本来就在本地跑一个 HTTP 服务，插件在那个服务上认领一条 WebSocket upgrade 路径，浏览器扩展主动拨回来，配对令牌握手成功后，通道就通了。

```
DSH (host bundle)                         Chrome
┌──────────────────────────┐             ┌───────────────────────────┐
│ ctx.webServer            │  WebSocket  │ MV3 extension             │
│  /dsh-chrome-use/bridge  │◀────────────│  background.js (service   │
│  /dsh-chrome-use/state   │  拨出 + token│  worker)                  │
│  /dsh-chrome-use/settings│◀────────────│                           │
│                          │  插件页轮询  │      │                    │
│ lib/tools.js             │             │      ▼                    │
│  chrome_use_*  ×7        │             │ chrome.debugger (CDP)     │
│ lib/client.js            │             │ chrome.tabs / scripting   │
│  （插件设置页）           │             │                           │
└──────────────────────────┘             └───────────────────────────┘
```

## 为什么是 WebSocket 直连

| 方案 | 代价 |
| --- | --- |
| Native messaging 宿主 | 要在 `HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts` 写注册表、装一个原生可执行文件、维护 manifest 路径 |
| 扩展自己开 `ws://` 监听 | 扩展不能监听端口；只能有内容脚本往页面里注入 |
| **认领 DSH 已有的 loopback 升级路径** | 零安装负担，随 DSH 一起起停，令牌可轮换 |

配对令牌是唯一的凭据：`chrome_use_status` 把它打印出来，用户粘贴进扩展的选项页。换令牌就等于踢掉所有已连接浏览器。

## 功能面

七个工具，全部是模型可见的：

| 工具 | 干什么 |
| --- | --- |
| `chrome_use_status` | 连接状态、配对令牌（可轮换）、扩展自报的浏览器信息 |
| `chrome_use_tabs` | `list` / `open` / `close` / `activate` / `resize` / `group` / `window` / `windowState` / `closeWindow` |
| `chrome_use_navigate` | 打开 URL，或 `back` / `forward` |
| `chrome_use_snapshot` | 把页面读成带 `ref` 的大纲（可只要可交互元素、可附带截图） |
| `chrome_use_interact` | `click` `hover` `type` `press` `select` `scroll` `focus` `wait` `drag` `fill` `upload` `dialog` `waitIdle` `handoff` `viewport` `media` `network` `geolocation` `timezone` |
| `chrome_use_read` | `evaluate` / `console` / `network` / `responseBody` / `storage` / `cookies` / `dialog` / `markdown` / `table` / `metrics` |
| `chrome_use_capture` | `screenshot`（整页 / 视口 / 单个元素） / `pdf` / `download` |

### 无人值守：独立子窗口

`chrome_use_tabs action window` 用 `chrome.windows.create({focused: false})` 开一个**新窗口**，它不抢焦点、不打断你正在做的事——模型在里面点击和输入，你的鼠标和键盘仍然归你。`action windowState`（`state` + `focused`）可以最小化、还原或把窗口调到前台；`action closeWindow` 关掉它（只剩一个窗口时拒绝，避免把浏览器关掉）。同一个任务里先用 `action tabs list` 拿到窗口里的 `tabId`，其余工具照常接受 `tabId`。

### 批量与人工接力

- `action fill`：一次传 `fields: [{ref|selector, text|value, replace?, kind?, submit?}]` 填完整个表单，比逐字段 `type` 少 n 次往返。逐项容错，返回值里每个字段都有自己的 `ok` / 错误。
- `action handoff`：在页面底部画一条提示栏，等你亲手登录或确认支付，点按钮后模型继续。**不要在需要密码或验证码的地方硬试**——交给这条动作。
- `action drag`：从 `ref` 拖到 `toRef`，发完整鼠标按下／移动／抬起序列（12 步插值），排序、滑块、拖放上传都能用。

### 省钱地读页面

- `action markdown`：把正文转成 markdown（readability-lite：先按文字密度挑主容器，再渲染标题／段落／列表／代码块／表格）。只想要文字时它比快照便宜得多。
- `action table`：把页面里的表格直接读成「表头 + 行」，最多 8 张表、每张 200 行。
- `action metrics`：DOM 节点数、JS 堆、layout／recalc 次数、脚本与任务耗时、CLS。排查「为什么这页卡」时先看它。
- `chrome_use_capture` 传 `ref` 或 `selector` 只截那一个元素，整页截图在长页上会糊到看不清。

### 设备与网络模拟

`action viewport`（宽高、`deviceScaleFactor`、`mobile`）、`action media`（`colorScheme`、`media`）、`action network`（`preset: offline|slow3g|fast3g|slow4g`，或 `latency`/`downloadKbps`/`uploadKbps`；`offline: true` 直接断网）、`action geolocation`（经纬度 + 精度）、`action timezone`（IANA 名）。每一项都接受 `clear: true` 还原真实值。

设计取舍：
- **`ref` 而不是 CSS 选择器**。快照给每个可见的可交互元素盖一个 `data-dsh-ref`，交互工具只认这个。页面重排、类名混淆、Shadow DOM 都不影响——而且模型不必猜选择器。导航会失效所有 `ref`，所以改完页面要重新快照。
- **快照是"用户看得见的东西"**。可见性按 `display`/`visibility`/`opacity`/非零 rect 判定，`aria-hidden="true"` 子树整棵跳过。不会把整页 HTML 倒给模型。
- **快照穿 Shadow DOM 与同源 iframe**。开放的 shadow root 会展开成 `#shadow-root` 段落，同源 frame 展开成 `[frame]` 段落并继承坐标系偏移；跨源 frame 只报出 `src`，提示把它当独立标签页打开。`ref` 的解析走页面内的 registry（`window.__dshRefs`），所以 shadow 里的控件也能点到。
- **交互走 CDP 的 `Input.*`**，不是 `element.click()`。真实的鼠标事件序列才能触发现有前端框架的事件链；被浮层遮挡时会明确报 `element is covered by …`，而不是静默失败。遮挡判定按 shadow 穿透后的最上层元素算，否则 shadow 里的控件会被自己的宿主误判为被遮挡。
- **JS 对话框不会把工具卡死**。弹窗会暂停渲染进程，开弹窗的那条 CDP 命令永远不返回，`Page.handleJavaScriptDialog` 又排在同一条队列后面。所以带 `releaseOnDialog` 的命令在收到 `Page.javascriptDialogOpening` 或 12 秒看门狗到期时被放弃（返回 `ABANDONED` 而不是错误——动作确实发生了），回答对话框走旁路队列。
- **截图走 attachments 服务**。图片是 DSH 的 `image` content block，不是 base64 文本塞进上下文。
- **页面内脚本是 `Runtime.evaluate` 的 IIFE 字符串**，不是持久注入。绕开页面 CSP，也不在用户页面里留任何东西。


## 安装

### 1. Host 插件

在 DSH 里（用 `plugin_manager` 工具）：

```
install_bundle  →  D:\文档\deepseek-harness\dsh-chrome-use
```

这是一个本地 bundle（`package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`），装完在设置里能看到「DSH Chrome Use」。

装好后日志里会有两行：

```
dsh-chrome-use: bridge listening at ws://127.0.0.1:<port>/dsh-chrome-use/bridge (token generated)
dsh-chrome-use: load the extension from …\dsh-chrome-use\extension — chrome://extensions → Developer mode → Load unpacked
```

### 2. 浏览器扩展

1. 打开 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. **加载已解压的扩展程序** → 选 `dsh-chrome-use\extension`
4. 打开扩展的**选项**页，粘贴 token（从 `chrome_use_status` 拿），确认桥接地址，点连接

Edge 走 `edge://extensions`，步骤一样。

### 3. 插件页

装完之后，**设置 → 插件 → 已安装**里找到「DSH Chrome Use」，点开卡片标题，描述与行列表之间就是本插件自己的页面：

- **浏览器连接**：桥接地址、版本、连接状态；配对令牌默认打码，可显示 / 复制 / 轮换；令牌来源（`config` / `file` / `generated`）与落盘路径。
- **运行状态**：每个已连接浏览器的 clientId、标签、浏览器版本、接入时间、在途命令数；能力位与「设置是否已写入 profile」。
- **功能开关**：`注册工具` / `系统提示词段落` / `只读模式` / `允许 evaluate` 四个总闸，加每个工具一个开关；改动要按「保存开关」才写盘，回到默认值会自动删掉配置行。
- **功能清单**：七个工具各占一行——工具名、一句功能简述、当前是否可用，以及不可用时是哪一条规则挡住的。

页面每 4 秒轮询 `/dsh-chrome-use/state`。它读的是 host 侧的真实现状，不是自己记的镜像。

### 4. 验证

问 DSH「用 chrome_use_status 看看」——应该看到 `connected: true` 和一行浏览器信息。

## 配置

`cordis.patch.yml` 里的 `config`：

```yaml
- insert:
    - id: chrome-use
      name: dsh-chrome-use
      config:
        token: ''          # 留空 = 首次启动随机生成后落盘复用
        tools: true        # false = 只连桥，不注册工具
        prompt: true       # false = 不注入系统提示段
        readOnly: false    # true = 只留观察者工具（status/tabs/snapshot/read/capture）
        allowEvaluation: true  # false = chrome_use_read 的 evaluate 被拒
        disabledTools: []  # 逐工具关掉
```

`token` 固定下来适合反复重启的场景；留空则首次生成后写进 `~/.dsh/dsh-chrome-use/token`，之后复用——否则每次重载插件都会让已经配好的扩展连不上。

这一行也可以完全由插件页写：`POST /dsh-chrome-use/settings` 走 `configEditor`，由它改写 patch 行、跑 schema 校验、原子写盘、再触发本 bundle 重载。未知键和非法值一律 400，不会被静默丢弃。


## 扩展权限

manifest 申请了 `debugger`、`tabs`、`tabGroups`、`scripting`、`storage`、`cookies`、`downloads`、`history`、`webNavigation`、`alarms`、`notifications` 和 `<all_urls>`。

`debugger` 是核心：没有它就没有 CDP，也就没有真实输入事件、网络缓冲、截图。装的时候 Chrome 会顶一条「调试此浏览器」的警告条——这是 CDP 的固有代价，Codex 的扩展同样如此。

## 安全模型

- 桥只绑在 DSH 已经在监听的 loopback 上，不额外监听。
- 握手要令牌 + 协议版本，令牌用 `timingSafeEqual` 比对。
- 令牌只在 `chrome_use_status` 的输出里出现一次；轮换后旧连接不会被主动踢，但新握手会失败。
- 插件页的三个路由先跑 DSH 自己的 `connection.requestRejection`：跨源 403、没有浏览器登录 cookie 401。持有配对令牌的本地调用方可以用 `?token=` 旁路 cookie 这一关（令牌本来就是它们手里的凭据），但跨源请求即使带对了令牌也仍然是 403。
- `POST` 的请求体有 16 KiB 上限，只收 JSON 对象。
- 扩展端不落任何站点凭据：cookie 读写都是转发给 CDP，不在本地留存。
- `chrome://`、`about:`、`devtools:`、扩展页本身拒绝自动化（Chrome 自己也不允许）。

## 开发

```
node _work/run-tests.mjs          # 全部测试（_work/ 不在仓库里，直接跑 test/ 下的文件）
node test/ws-bridge.test.mjs      # 协议层：握手/令牌/超时/大帧/断线
node test/bundle-shape.test.mjs   # loader 看到的是 default 导出，Config 必须在上面
node test/settings.test.mjs       # 设置归一化、写盘、拒绝语义、路由栅栏
node test/tool-contract.test.mjs  # host 发的方法名与扩展的 case 双向对齐
node test/dialog.test.mjs         # 看门狗放弃命令、对话框旁路
node scripts/make-icons.mjs       # 从几何描述重建 PNG 图标
```

`lib/ws.js` 是一份不依赖第三方包的 RFC 6455 服务端实现（故意不支持 `permessage-deflate`）。原因很实际：`ws` 在 profile 的 `node_modules` 里能被解析到纯属依赖提升的巧合，而一个本地 bundle 不能建立在巧合上。

改完代码要**禁用再启用** bundle 才会重载（改文件不触发热更）。

扩展这边有个坑：**自动重连和真的换代码看起来一模一样**——service worker 被回收后靠 `chrome.alarms` 重连，连接状态照样是「已连接」，但跑的还是旧代码。所以：

- `chrome_use_status` 会打印 `build 2026-11-19.2` 这样的戳（`extension/background.js` 顶部的 `BUILD` 常量，改代码时顺手改一下）。
- 扩展这边第一次换代码仍然要在 `chrome://extensions` 点一次刷新；之后就可以用 `chrome_use_status {reloadExtension: true}`——它让 worker 自己 `chrome.runtime.reload()`，再等一个**不同的 clientId** 回来，20 秒内没回来就明说要去手动点。

版本历史见 `CHANGELOG.md`。

## 目录

```
dsh-chrome-use/
├── lib/
│   ├── index.js      插件入口：认领升级路径、注册工具、注入提示段、挂路由
│   ├── bridge.js     连接注册表、令牌握手、命令/应答编解码
│   ├── tools.js      七个工具的定义（纯对象，自校验参数）
│   ├── validate.js   参数校验（DSH 只校验 output.schema）
│   ├── ws.js         RFC 6455 服务端
│   ├── settings.js   设置归一化 + Config（Standard Schema）
│   ├── control.js    快照与写盘，设置页的唯一数据源
│   ├── routes.js     /state /settings /token 三个 loopback 路由
│   └── client.js     插件页（浏览器端 React 组件）
├── extension/
│   ├── manifest.json MV3
│   ├── background.js 拨出、重连、命令分发
│   ├── lib/cdp.js    debugger 会话、控制台/网络环形缓冲、对话框看门狗
│   ├── lib/actions.js 方法实现
│   ├── lib/page-scripts.js 页面内 IIFE（快照/定位/存储/等待）
│   ├── popup.*       状态与开关
│   └── options.*     桥接地址、令牌、标签
├── locale/           插件卡片文案
├── test/             协议层、设置、契约、对话框测试
└── scripts/          图标生成
```


## 已知边界

- 只能驱动 Chromium 系（Chrome / Edge / Brave 等）。Firefox 的 `browser.debugger` 协议不同。
- 一个 DSH 可以连多个浏览器（多台机器、多个 profile），工具参数 `browser` 按 id 或标签选。
- 控制台和网络缓冲是按标签页的环形缓冲，上限 400 / 300 条，读了就清不掉的会覆盖最旧的。
- PDF 用 `Page.printToPDF`，无头和有头行为在部分站点上不同。
- 队列是**按标签页**串行的。同一个标签页上的命令互相排队（否则对话框、导航、点击会互相踩），不同标签页之间天然并行。
- 跨源 iframe 只报出 `src`，不进去。要操作它就在独立标签页打开——`chrome.debugger` 是按标签页 attach 的，跨源 frame 的坐标系也不属于当前文档。
- 独立子窗口里的标签页和普通标签页一样受「按标签页串行」约束；窗口本身不抢焦点，但它里面的页面仍然可能弹系统级对话框（下载、权限），这些只能由用户在本机点。
- `action handoff` 等的是**人**，不是模型：超时（默认 10 分钟）后返回 `resumed: false`，页面上的提示栏会被移除。
- `action markdown` / `action table` 是页面内的一次性抽取，不执行页面的路由跳转；SPA 里只渲染了一屏的内容，需要先滚动或点开再抽。
- 插件页依赖浏览器的登录 cookie（或本地调用方持令牌时的 `?token=`）。在 DSH 桌面窗口里它随应用一起加载；用新标签页直接访问 `127.0.0.1:<port>` 会被 401 挡住，因为签 cookie 需要只存在于 host 内存里的 launch token。

## License

MIT

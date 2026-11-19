# DSH Chrome Use

让 DSH 直接操作**你自己的 Chrome**：读页面、点按钮、填表单、切标签页、抓截图、看控制台和网络请求。

Codex 有一个官方 Chrome 插件；这个项目是给 DeepSeek Harness 的等价物，走的是另一条更省事的路：**不需要 native messaging 宿主、不写注册表、不开第二个端口**。DSH 本来就在本地跑一个 HTTP 服务，插件在那个服务上认领一条 WebSocket upgrade 路径，浏览器扩展主动拨回来，配对令牌握手成功后，通道就通了。

```
DSH (host bundle)                         Chrome
┌──────────────────────────┐             ┌───────────────────────────┐
│ ctx.webServer            │  WebSocket  │ MV3 extension             │
│  /dsh-chrome-use/bridge  │◀────────────│  background.js (service   │
│                          │  拨出 + token│  worker)                  │
│ lib/tools.js             │             │      │                    │
│  chrome_use_*  ×7        │             │      ▼                    │
│                          │             │ chrome.debugger (CDP)     │
└──────────────────────────┘             │ chrome.tabs / scripting   │
                                          └───────────────────────────┘
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
| `chrome_use_tabs` | `list` / `open` / `close` / `activate` / `resize` / `group` |
| `chrome_use_navigate` | 打开 URL，或 `back` / `forward` |
| `chrome_use_snapshot` | 把页面读成带 `ref` 的大纲（可只要可交互元素、可附带截图） |
| `chrome_use_interact` | `click` `hover` `type` `press` `select` `scroll` `focus` `wait`，用快照给的 `ref` 定位 |
| `chrome_use_read` | `evaluate` 表达式 / `console` / `network` / `responseBody` / `storage` / `cookies` |
| `chrome_use_capture` | `screenshot` / `pdf` / `download` |

设计取舍：
- **`ref` 而不是 CSS 选择器**。快照给每个可见的可交互元素盖一个 `data-dsh-ref`，交互工具只认这个。页面重排、类名混淆、Shadow DOM 都不影响——而且模型不必猜选择器。导航会失效所有 `ref`，所以改完页面要重新快照。
- **快照是"用户看得见的东西"**。可见性按 `display`/`visibility`/`opacity`/非零 rect 判定，`aria-hidden="true"` 子树整棵跳过。不会把整页 HTML 倒给模型。
- **交互走 CDP 的 `Input.*`**，不是 `element.click()`。真实的鼠标事件序列才能触发现有前端框架的事件链；被浮层遮挡时会明确报 `element is covered by …`，而不是静默失败。
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

### 3. 验证

问 DSH「用 chrome_use_status 看看」——应该看到 `connected: true` 和一行浏览器信息。

## 配置

`cordis.patch.yml` 里的 `config`：

```yaml
- insert:
    - id: chrome-use
      name: dsh-chrome-use
      config:
        token: ''        # 留空 = 每次启动随机生成
        tools: true      # false = 只连桥，不注册工具
        prompt: true     # false = 不注入系统提示段
```

`token` 固定下来适合反复重启的场景；留空则每次启动换一个，安全性更好。

## 扩展权限

manifest 申请了 `debugger`、`tabs`、`tabGroups`、`scripting`、`storage`、`cookies`、`downloads`、`history`、`webNavigation`、`alarms`、`notifications` 和 `<all_urls>`。

`debugger` 是核心：没有它就没有 CDP，也就没有真实输入事件、网络缓冲、截图。装的时候 Chrome 会顶一条「调试此浏览器」的警告条——这是 CDP 的固有代价，Codex 的扩展同样如此。

## 安全模型

- 桥只绑在 DSH 已经在监听的 loopback 上，不额外监听。
- 握手要令牌 + 协议版本，令牌用 `timingSafeEqual` 比对。
- 令牌只在 `chrome_use_status` 的输出里出现一次；轮换后旧连接不会被主动踢，但新握手会失败。
- 扩展端不落任何站点凭据：cookie 读写都是转发给 CDP，不在本地留存。
- `chrome://`、`about:`、`devtools:`、扩展页本身拒绝自动化（Chrome 自己也不允许）。

## 开发

```
node test/ws-bridge.test.mjs     # 协议层：握手/令牌/超时/大帧/断线
node scripts/make-icons.mjs      # 从几何描述重建 PNG 图标
node --check lib/tools.js        # 任一模块的语法检查
```

`lib/ws.js` 是一份不依赖第三方包的 RFC 6455 服务端实现（故意不支持 `permessage-deflate`）。原因很实际：`ws` 在 profile 的 `node_modules` 里能被解析到纯属依赖提升的巧合，而一个本地 bundle 不能建立在巧合上。

## 目录

```
dsh-chrome-use/
├── lib/
│   ├── index.js      插件入口：认领升级路径、注册工具、注入提示段
│   ├── bridge.js     连接注册表、令牌握手、命令/应答编解码
│   ├── tools.js      七个工具的定义（纯对象，自校验参数）
│   ├── validate.js   参数校验（DSH 只校验 output.schema）
│   └── ws.js         RFC 6455 服务端
├── extension/
│   ├── manifest.json MV3
│   ├── background.js 拨出、重连、命令分发
│   ├── lib/cdp.js    debugger 会话、控制台/网络环形缓冲
│   ├── lib/actions.js 方法实现
│   ├── lib/page-scripts.js 页面内 IIFE（快照/定位/存储/等待）
│   ├── popup.*       状态与开关
│   └── options.*     桥接地址、令牌、标签
├── locale/           插件卡片文案
├── test/             协议层测试
└── scripts/          图标生成
```

## 已知边界

- 只能驱动 Chromium 系（Chrome / Edge / Brave 等）。Firefox 的 `browser.debugger` 协议不同。
- 一个 DSH 可以连多个浏览器（多台机器、多个 profile），工具参数 `browser` 按 id 或标签选。
- 控制台和网络缓冲是按标签页的环形缓冲，上限 400 / 300 条，读了就清不掉的会覆盖最旧的。
- PDF 用 `Page.printToPDF`，无头和有头行为在部分站点上不同。

## License

MIT

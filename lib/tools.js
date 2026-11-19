/**
 * The model-facing tool surface.
 *
 * Every definition here is a plain object. It imports nothing from
 * `@deepseek-ai/*`: a local bundle cannot resolve those packages, and the
 * registration path used by `ctx.tools.register` validates only `output.schema`
 * — the model's arguments arrive in `execute` verbatim. So each tool validates
 * its own arguments through `./validate.js` before using them.
 *
 * The surface is deliberately seven tools rather than one per command: a model
 * reads every description on every turn, and a cohesive verb list with an
 * `action` discriminator costs a fraction of that budget.
 *
 * @module dsh-chrome-use/tools
 */
import {
  ArgsError,
  assertArguments,
  readArray,
  readBoolean,
  readEnum,
  readInteger,
  readNumber,
  readObject,
  readString,
} from './validate.js'

const CSS_HINT = 'CSS selector, or the ref from chrome_use_snapshot'
const TAB_HINT = 'tab id from chrome_use_tabs, or a url/title fragment to match'

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    endpoint: { type: 'string' },
    token: { type: 'string' },
    connected: { type: 'boolean' },
    browsers: { type: 'array', items: { type: 'object', additionalProperties: true } },
    commands: { type: 'array', items: { type: 'string' } },
    extension: { type: 'object', additionalProperties: true },
  },
}

const TAB_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    tabId: { type: 'integer' },
    windowId: { type: 'integer' },
    url: { type: 'string' },
    title: { type: 'string' },
    tabs: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
}

const SNAPSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    tabId: { type: 'integer' },
    url: { type: 'string' },
    title: { type: 'string' },
    refCount: { type: 'integer' },
    truncated: { type: 'boolean' },
    outline: { type: 'string' },
    refs: { type: 'array', items: { type: 'object', additionalProperties: true } },
    image: { type: 'object', additionalProperties: true },
  },
}

const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    tabId: { type: 'integer' },
    action: { type: 'string' },
    target: { type: 'string' },
    detail: { type: 'string' },
    typed: { type: 'integer' },
  },
}

const READ_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    tabId: { type: 'integer' },
    kind: { type: 'string' },
    value: {},
    entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
    requests: { type: 'array', items: { type: 'object', additionalProperties: true } },
    body: { type: 'string' },
    items: { type: 'object', additionalProperties: true },
    cookies: { type: 'array', items: { type: 'object', additionalProperties: true } },
    truncated: { type: 'boolean' },
  },
}

const CAPTURE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    tabId: { type: 'integer' },
    url: { type: 'string' },
    title: { type: 'string' },
    format: { type: 'string' },
    bytes: { type: 'integer' },
    fullPage: { type: 'boolean' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    downloadId: { type: 'integer' },
    image: { type: 'object', additionalProperties: true },
  },
}

/** One line of text; every tool renders at least this. */
function text(value) {
  return [{ type: 'text', text: value }]
}

/** Render a tab row list. */
function renderTabs(value) {
  const rows = value.tabs ?? []
  if (rows.length === 0) {
    if (typeof value.tabId === 'number') {
      const where = value.url || value.title ? ` ${value.url ?? value.title}` : ''
      return text(`${value.action ?? 'done'}: tab ${value.tabId}${where}`)
    }
    if (Array.isArray(value.closed)) return text(`closed ${value.closed.length} tab(s): ${value.closed.join(', ')}`)
    if (typeof value.groupId === 'number') return text(`group ${value.groupId} now holds ${(value.tabIds ?? []).length} tab(s)`)
    return text(value.action ? `${value.action}: done` : 'no matching tabs')
  }
  const lines = rows.map((tab) => {
    const marks = [tab.active ? 'active' : null, tab.attached ? 'attached' : null, tab.pinned ? 'pinned' : null]
      .filter(Boolean)
      .join(', ')
    return `  [${tab.tabId}] ${tab.title || '(untitled)'} — ${tab.url}${marks ? ` (${marks})` : ''}`
  })
  return text(`${rows.length} tab(s):\n${lines.join('\n')}`)
}

/** Resolve `tab` (id or fragment) to a concrete tab id by asking the browser. */
async function resolveTabId(client, selector, tool) {
  if (selector.tabId !== undefined) return selector.tabId
  if (selector.tab === undefined) return undefined
  const listing = await client.call('tabs.list', {})
  const needle = String(selector.tab).toLowerCase()
  const match = (listing.tabs ?? []).find(
    (tab) => String(tab.url ?? '').toLowerCase().includes(needle) || String(tab.title ?? '').toLowerCase().includes(needle),
  )
  if (!match) {
    throw new ArgsError(`${tool}: no open tab matches ${JSON.stringify(selector.tab)}; call chrome_use_tabs with action list to see them`)
  }
  return match.tabId
}

/** Merge the resolved tab id into extension parameters. */
function withTab(params, tabId) {
  return tabId === undefined ? params : { ...params, tabId }
}

/**
 * Build every tool definition.
 *
 * @param {{
 *   bridge: import('./bridge.js').Bridge,
 *   token: () => string,
 *   rotateToken: () => string,
 *   endpoint: () => string,
 *   ctx: any,
 *   log: { warn: (message: string) => void },
 * }} deps
 */
export function createTools(deps) {
  const { bridge, token, rotateToken, endpoint, ctx, log, settings } = deps

  /**
   * Read the switches at call time, not at mount time.
   *
   * The bundle reloads when a switch is saved, so a stale read would only ever
   * be visible for the moment between the write and the reload; reading live
   * keeps the guard honest even then.
   */
  function currentSettings() {
    return typeof settings === 'function' ? settings() : {}
  }

  /** Connect, then send one command to the browser the caller named. */
  async function call(args, method, params, exec, timeoutMs) {
    const wanted = typeof args.browser === 'string' ? args.browser : undefined
    const client = bridge.require(wanted)
    return client.call(method, params, { signal: exec?.signal, timeoutMs })
  }

  /** Persist a base64 image as an attachment block, or degrade to a note. */
  async function imageBlock(base64, mediaType, name) {
    const attachments = ctx.get('attachments')
    if (!attachments) return undefined
    try {
      const ref = await attachments.saveImage({ data: Buffer.from(base64, 'base64'), mediaType, name })
      return {
        attachment: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...ref.name === undefined ? {} : { name: ref.name },
        },
      }
    } catch (error) {
      log.warn(`dsh-chrome-use: could not attach ${name}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  const status = {
    name: 'chrome_use_status',
    description:
      'Check the DSH-Chrome-Use bridge and pair a browser. Returns the loopback WebSocket endpoint and the pairing token the extension needs, plus every connected browser. Call this first whenever a chrome_use_* tool reports that no browser is connected, or when the user asks whether the extension is hooked up. Set rotate to mint a new token, which disconnects nothing but makes the old token unusable for the next handshake.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rotate: { type: 'boolean', description: 'Mint a new pairing token and return it. The old token stops working for new handshakes.' },
        probe: { type: 'boolean', description: 'Also ask each connected browser for its open tabs and attached debugger targets.' },
        browser: { type: 'string', description: 'Narrow the probe to one connected browser by client id or label.' },
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(rawArgs) {
      const args = rawArgs ?? {}
      assertArguments(args, { tool: 'chrome_use_status', allowed: ['rotate', 'probe', 'browser'] })
      const rotate = readBoolean(args, 'rotate', { tool: 'chrome_use_status', fallback: false })
      const probe = readBoolean(args, 'probe', { tool: 'chrome_use_status', fallback: false })
      const wanted = readString(args, 'browser', { tool: 'chrome_use_status' })
      if (rotate) rotateToken()

      const browsers = bridge.describe()
      const value = {
        endpoint: endpoint(),
        token: token(),
        connected: browsers.length > 0,
        browsers,
        commands: [
          'chrome_use_status', 'chrome_use_tabs', 'chrome_use_navigate', 'chrome_use_snapshot',
          'chrome_use_interact', 'chrome_use_read', 'chrome_use_capture',
        ],
      }
      if (probe && browsers.length > 0) {
        const client = bridge.require(wanted)
        const [remote, tabs] = await Promise.all([
          client.call('status', {}).catch((error) => ({ error: String(error?.message ?? error) })),
          client.call('tabs.list', {}).catch((error) => ({ error: String(error?.message ?? error) })),
        ])
        const extension = { ...remote, tabs: tabs.tabs ?? [] }
        if (tabs.error !== undefined) extension.tabsError = tabs.error
        value.extension = extension
      }
      return value
    },
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => {
        const lines = [
          `bridge: ${value.endpoint}`,
          `token: ${value.token}`,
          value.connected ? `connected: ${value.browsers.length} browser(s)` : 'connected: no browser',
        ]
        for (const browser of value.browsers ?? []) {
          const b = browser.browser ?? {}
          lines.push(`  ${browser.clientId} "${browser.label}" ${b.product ?? ''} ${b.major ?? ''} since ${browser.connectedAt}`.trimEnd())
        }
        if (!value.connected) {
          lines.push('next: load the extension in chrome://extensions, open its options page, paste the token above, press connect')
        }
        if (value.extension?.tabs?.length) {
          lines.push(`tabs: ${value.extension.tabs.length}`)
          for (const tab of value.extension.tabs.slice(0, 25)) lines.push(`  [${tab.tabId}] ${tab.title || tab.url}`)
        }
        return text(lines.join('\n'))
      },
    },
  }

  const tabs = {
    name: 'chrome_use_tabs',
    description:
      'Inspect and manage the user real browser tabs. action list shows every automatable tab with the tabId the other chrome_use_* tools accept; open creates one; close removes it; activate focuses it; resize changes the window; group collects tabs into a Chrome tab group so the user can see what the agent is doing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'open', 'close', 'activate', 'resize', 'group'], description: 'Operation to perform.' },
        tab: { type: 'string', description: TAB_HINT },
        tabId: { type: 'integer', description: 'Exact tab id, bypassing tab matching.' },
        url: { type: 'string', description: 'open: address to load. A bare domain is upgraded to https, a bare phrase becomes a search.' },
        active: { type: 'boolean', description: 'open: focus the new tab (default true).' },
        waitForLoad: { type: 'boolean', description: 'open: wait until the tab reports complete (default true).' },
        tabIds: { type: 'array', items: { type: 'integer' }, description: 'close/group: explicit tab ids.' },
        includeBrowserPages: { type: 'boolean', description: 'list: include chrome:// and extension pages that cannot be automated.' },
        width: { type: 'integer', description: 'resize: window width in pixels (default 1280).' },
        height: { type: 'integer', description: 'resize: window height in pixels (default 800).' },
        title: { type: 'string', description: 'group: visible group title.' },
        color: { type: 'string', description: 'group: chrome tab group colour (grey, blue, red, yellow, green, pink, purple, cyan, orange).' },
        groupId: { type: 'integer', description: 'group: extend an existing group.' },
        browser: { type: 'string', description: 'Which connected browser to use; omit when only one is attached.' },
      },
    },
    timeoutMs: 90_000,
    async execute(rawArgs, exec) {
      const tool = 'chrome_use_tabs'
      const args = rawArgs ?? {}
      assertArguments(args, {
        tool,
        allowed: ['action', 'tab', 'tabId', 'url', 'active', 'waitForLoad', 'tabIds', 'includeBrowserPages', 'width', 'height', 'title', 'color', 'groupId', 'browser'],
        required: ['action'],
      })
      const action = readEnum(args, 'action', { tool, values: ['list', 'open', 'close', 'activate', 'resize', 'group'] })
      const selector = {
        tabId: readInteger(args, 'tabId', { tool, min: 0 }),
        tab: readString(args, 'tab', { tool }),
      }
      const client = bridge.require(readString(args, 'browser', { tool }))

      switch (action) {
        case 'list': {
          const result = await client.call('tabs.list', {
            includeBrowserPages: readBoolean(args, 'includeBrowserPages', { tool, fallback: false }),
          }, { signal: exec?.signal })
          return { ...result, action }
        }
        case 'open': {
          const url = readString(args, 'url', { tool, maxLength: 8000 })
          const result = await client.call('tabs.open', {
            url,
            active: readBoolean(args, 'active', { tool, fallback: true }),
            waitForLoad: readBoolean(args, 'waitForLoad', { tool, fallback: true }),
          }, { signal: exec?.signal, timeoutMs: 60_000 })
          return { ...result, action }
        }
        case 'close': {
          const ids = readArray(args, 'tabIds', { tool, of: 'number' }) ?? []
          const tabId = await resolveTabId(client, selector, tool)
          const list = ids.length > 0 ? ids : tabId === undefined ? [] : [tabId]
          if (list.length === 0) throw new ArgsError(`${tool}: close needs tabIds or tabId`)
          const result = await client.call('tabs.close', { tabIds: list }, { signal: exec?.signal })
          return { ...result, action }
        }
        case 'activate': {
          const tabId = await resolveTabId(client, selector, tool)
          const result = await client.call('tabs.activate', withTab({}, tabId), { signal: exec?.signal })
          return { ...result, action }
        }
        case 'resize': {
          const tabId = await resolveTabId(client, selector, tool)
          const result = await client.call('browser.resize', withTab({
            width: readInteger(args, 'width', { tool, min: 200, fallback: 1280 }),
            height: readInteger(args, 'height', { tool, min: 200, fallback: 800 }),
          }, tabId), { signal: exec?.signal })
          return { ...result, action }
        }
        case 'group': {
          const ids = readArray(args, 'tabIds', { tool, of: 'number' }) ?? []
          const tabId = await resolveTabId(client, selector, tool)
          const params = withTab({
            tabIds: ids.length > 0 ? ids : tabId === undefined ? [] : [tabId],
            title: readString(args, 'title', { tool }),
            color: readString(args, 'color', { tool }),
            groupId: readInteger(args, 'groupId', { tool, min: 0 }),
          }, undefined)
          const result = await client.call('browser.group', params, { signal: exec?.signal })
          return { ...result, action }
        }
        default:
          throw new ArgsError(`${tool}: unreachable action ${action}`)
      }
    },
    output: { schema: TAB_SCHEMA, render: (_args, value) => renderTabs(value) },
  }

  const navigate = {
    name: 'chrome_use_navigate',
    description:
      'Drive one tab. Give url to load it (replacing the current document), or direction back/forward to move through this tab history. Waits for the new document to finish loading unless waitForLoad is false, then reports the final url and title. Read the page afterwards with chrome_use_snapshot.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Address to load. A bare domain is upgraded to https, a bare phrase becomes a web search.' },
        direction: { type: 'string', enum: ['back', 'forward'], description: 'History move instead of a url.' },
        tab: { type: 'string', description: TAB_HINT },
        tabId: { type: 'integer', description: 'Exact tab id, bypassing tab matching. Omit to use the focused tab.' },
        waitForLoad: { type: 'boolean', description: 'Wait until the tab reports complete (default true).' },
        timeoutMs: { type: 'integer', description: 'Load budget in milliseconds (default 30000).' },
        browser: { type: 'string', description: 'Which connected browser to use; omit when only one is attached.' },
      },
    },
    timeoutMs: 120_000,
    async execute(rawArgs, exec) {
      const tool = 'chrome_use_navigate'
      const args = rawArgs ?? {}
      assertArguments(args, { tool, allowed: ['url', 'direction', 'tab', 'tabId', 'waitForLoad', 'timeoutMs', 'browser'] })
      const url = readString(args, 'url', { tool, maxLength: 8000 })
      const direction = readString(args, 'direction', { tool })
      if (url === undefined && direction === undefined) throw new ArgsError(`${tool}: give url or direction`)
      if (url !== undefined && direction !== undefined) throw new ArgsError(`${tool}: give url or direction, not both`)
      const client = bridge.require(readString(args, 'browser', { tool }))
      const selector = {
        tabId: readInteger(args, 'tabId', { tool, min: 0 }),
        tab: readString(args, 'tab', { tool }),
      }
      const tabId = await resolveTabId(client, selector, tool)
      const common = {
        waitForLoad: readBoolean(args, 'waitForLoad', { tool, fallback: true }),
        timeoutMs: readInteger(args, 'timeoutMs', { tool, min: 100, max: 180_000, fallback: 30_000 }),
      }
      const result = direction === undefined
        ? await client.call('page.navigate', withTab({ ...common, url }, tabId), { signal: exec?.signal, timeoutMs: common.timeoutMs + 30_000 })
        : await client.call('page.history', withTab({ ...common, direction }, tabId), { signal: exec?.signal, timeoutMs: common.timeoutMs + 30_000 })
      return { ...result, action: direction ?? 'url' }
    },
    output: {
      schema: TAB_SCHEMA,
      render: (_args, value) => text(`[${value.tabId}] ${value.title || '(untitled)'} — ${value.url}`),
    },
  }

  const snapshot = {
    name: 'chrome_use_snapshot',
    description:
      'Read the current page as a compact outline plus a ref for every interactive element. This is the primary way to see a page: it survives shadow pages, frames of one document and non-semantic markup that a raw HTML dump hides. Every ref (e1, e2, …) stays valid until the next snapshot or a navigation, and the interaction tools accept it directly. Set screenshot when the visual layout matters — the image is attached beside the outline.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tab: { type: 'string', description: TAB_HINT },
        tabId: { type: 'integer', description: 'Exact tab id. Omit to use the focused tab.' },
        selector: { type: 'string', description: 'Limit the outline to one CSS selector subtree.' },
        interactiveOnly: { type: 'boolean', description: 'Emit only interactive elements, dropping headings and text (default false).' },
        maxNodes: { type: 'integer', description: 'Element budget for the walk (default 2500).' },
        maxText: { type: 'integer', description: 'Per-element text clip in characters (default 160).' },
        frames: { type: 'boolean', description: 'Walk same-origin iframes too, so refs reach their contents (default true). Cross-origin frames are reported but not entered.' },
        screenshot: { type: 'boolean', description: 'Attach a screenshot beside the outline (default false).' },
        fullPage: { type: 'boolean', description: 'screenshot: capture the whole scrollable page instead of the viewport.' },
        browser: { type: 'string', description: 'Which connected browser to use; omit when only one is attached.' },
      },
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(rawArgs, exec) {
      const tool = 'chrome_use_snapshot'
      const args = rawArgs ?? {}
      assertArguments(args, { tool, allowed: ['tab', 'tabId', 'selector', 'interactiveOnly', 'maxNodes', 'maxText', 'frames', 'screenshot', 'fullPage', 'browser'] })
      const client = bridge.require(readString(args, 'browser', { tool }))
      const selector = {
        tabId: readInteger(args, 'tabId', { tool, min: 0 }),
        tab: readString(args, 'tab', { tool }),
      }
      const tabId = await resolveTabId(client, selector, tool)
      const result = await client.call('page.snapshot', withTab({
        selector: readString(args, 'selector', { tool, maxLength: 2000 }),
        interactiveOnly: readBoolean(args, 'interactiveOnly', { tool, fallback: false }),
        maxNodes: readInteger(args, 'maxNodes', { tool, min: 50, max: 20_000, fallback: 2500 }),
        maxText: readInteger(args, 'maxText', { tool, min: 20, max: 2000, fallback: 160 }),
        frames: readBoolean(args, 'frames', { tool, fallback: true }),
      }, tabId), { signal: exec?.signal })
      if (readBoolean(args, 'screenshot', { tool, fallback: false })) {
        const shot = await client.call('page.screenshot', withTab({
          fullPage: readBoolean(args, 'fullPage', { tool, fallback: false }),
          format: 'png',
        }, tabId), { signal: exec?.signal, timeoutMs: 90_000 })
        const block = await imageBlock(shot.base64, 'image/png', `chrome-snapshot-${shot.tabId}.png`)
        if (block) result.image = block.attachment
      }
      return result
    },
    output: {
      schema: SNAPSHOT_SCHEMA,
      render: (_args, value) => {
        const header = `[${value.tabId}] ${value.title || '(untitled)'} — ${value.url}\nrefs: ${value.refCount ?? 0}${value.truncated ? ' (outline truncated)' : ''}`
        const blocks = [{ type: 'text', text: `${header}\n\n${value.outline ?? ''}` }]
        if (value.image) blocks.push({ type: 'image', attachment: value.image })
        return blocks
      },
    },
  }

  const interact = {
    name: 'chrome_use_interact',
    description:
      'Act on the page with real input events, so framework event handlers fire exactly as they do for the user. Targets come from chrome_use_snapshot refs or a CSS selector; omit both to use whatever already has focus. action click presses and releases at the element centre and refuses when another element covers it; hover moves the pointer; type inserts text (set replace to clear the field first, submit to press Enter after); press sends one key; select chooses option values; scroll wheels the page or the element; focus moves keyboard focus; wait polls for a selector, a text fragment, or document readiness. Four page-level actions need no target: upload sets files on a file input (a browser dialog cannot be driven, this is the only way); dialog accepts or dismisses the alert/confirm/prompt blocking the page (every other call on that tab hangs until it is gone, so check with chrome_use_read action dialog); waitIdle waits until in-flight requests settle; viewport overrides the window size so a mobile layout becomes reachable, and media forces prefers-color-scheme or print styles.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['click', 'hover', 'type', 'press', 'select', 'scroll', 'focus', 'wait', 'upload', 'dialog', 'waitIdle', 'viewport', 'media'], description: 'Operation to perform.' },
        ref: { type: 'string', description: `Element ref from chrome_use_snapshot, e.g. e12. Takes precedence over selector.` },
        selector: { type: 'string', description: CSS_HINT },
        tab: { type: 'string', description: TAB_HINT },
        tabId: { type: 'integer', description: 'Exact tab id. Omit to use the focused tab.' },
        text: { type: 'string', description: 'type: the text to insert. dialog: the text to answer a prompt with.' },
        replace: { type: 'boolean', description: 'type: clear the field before inserting (default false).' },
        submit: { type: 'boolean', description: 'type/press: press Enter after typing or as the action (default false for type).' },
        key: { type: 'string', description: 'press: one character, or Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click: mouse button (default left).' },
        clickCount: { type: 'integer', description: 'click: 1 or 2 for a double click (default 1).' },
        values: { type: 'array', items: { type: 'string' }, description: 'select: option values or visible labels to choose.' },
        value: { type: 'string', description: 'select: single option value or label.' },
        files: { type: 'array', items: { type: 'string' }, description: 'upload: absolute local paths, as the browser reads them.' },
        accept: { type: 'boolean', description: 'dialog: true accepts, false dismisses (default true).' },
        promptText: { type: 'string', description: 'dialog: the answer for a prompt; alias of text.' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'scroll: wheel direction (default down).' },
        deltaY: { type: 'integer', description: 'scroll: vertical pixels; negative scrolls up (default 600).' },
        deltaX: { type: 'integer', description: 'scroll: horizontal pixels (default 0).' },
        kind: { type: 'string', enum: ['selector', 'text', 'ready'], description: 'wait: what to poll for (default selector).' },
        expected: { type: 'string', description: 'wait: selector or text fragment to wait for.' },
        timeoutMs: { type: 'integer', description: 'wait/waitIdle: poll budget in milliseconds (default 10000 / 15000).' },
        idleMs: { type: 'integer', description: 'waitIdle: how long the network must stay quiet (default 500).' },
        width: { type: 'integer', description: 'viewport: width in CSS pixels; 390 is a phone.' },
        height: { type: 'integer', description: 'viewport: height in CSS pixels; 844 is a phone.' },
        deviceScaleFactor: { type: 'number', description: 'viewport: device pixel ratio (default 1).' },
        mobile: { type: 'boolean', description: 'viewport: emulate a mobile viewport (default false).' },
        clear: { type: 'boolean', description: 'viewport: drop the override instead of setting one.' },
        colorScheme: { type: 'string', enum: ['light', 'dark'], description: 'media: force prefers-color-scheme.' },
        media: { type: 'string', description: 'media: media type to emulate, e.g. print or screen.' },
        browser: { type: 'string', description: 'Which connected browser to use; omit when only one is attached.' },
      },
    },
    timeoutMs: 120_000,
    async execute(rawArgs, exec) {
      const tool = 'chrome_use_interact'
      const args = rawArgs ?? {}
      assertArguments(args, {
        tool,
        allowed: ['action', 'ref', 'selector', 'tab', 'tabId', 'text', 'promptText', 'replace', 'submit', 'key', 'button', 'clickCount', 'values', 'value', 'files', 'accept', 'direction', 'deltaY', 'deltaX', 'kind', 'expected', 'timeoutMs', 'idleMs', 'width', 'height', 'deviceScaleFactor', 'mobile', 'clear', 'colorScheme', 'media', 'browser'],
        required: ['action'],
      })
      const action = readEnum(args, 'action', { tool, values: ['click', 'hover', 'type', 'press', 'select', 'scroll', 'focus', 'wait', 'upload', 'dialog', 'waitIdle', 'viewport', 'media'] })
      const client = bridge.require(readString(args, 'browser', { tool }))
      const selector = {
        tabId: readInteger(args, 'tabId', { tool, min: 0 }),
        tab: readString(args, 'tab', { tool }),
      }
      const tabId = await resolveTabId(client, selector, tool)
      const ref = readString(args, 'ref', { tool, maxLength: 64 })
      const css = readString(args, 'selector', { tool, maxLength: 2000 })
      const target = { ref, selector: css }

      switch (action) {
        case 'click': {
          const result = await client.call('page.click', withTab({
            ...target,
            button: readEnum(args, 'button', { tool, values: ['left', 'right', 'middle'], fallback: 'left' }),
            clickCount: readInteger(args, 'clickCount', { tool, min: 1, max: 3, fallback: 1 }),
          }, tabId), { signal: exec?.signal })
          return { ...result, action, target: ref ?? css }
        }
        case 'hover': {
          const result = await client.call('page.hover', withTab(target, tabId), { signal: exec?.signal })
          return { ...result, action, target: ref ?? css }
        }
        case 'type': {
          const value = readString(args, 'text', { tool, maxLength: 200_000, fallback: '' })
          const submit = readBoolean(args, 'submit', { tool, fallback: false })
          const result = await client.call('page.type', withTab({
            ...target,
            text: value,
            replace: readBoolean(args, 'replace', { tool, fallback: false }),
          }, tabId), { signal: exec?.signal })
          if (submit) await client.call('page.press', withTab({ key: 'Enter' }, tabId), { signal: exec?.signal })
          return { ...result, action, detail: submit ? 'typed then pressed Enter' : 'typed' }
        }
        case 'press': {
          const key = readString(args, 'key', { tool, maxLength: 32 })
          const result = await client.call('page.press', withTab({ ...target, key: key ?? 'Enter' }, tabId), { signal: exec?.signal })
          return { ...result, action, target: ref ?? css }
        }
        case 'select': {
          const values = readArray(args, 'values', { tool, of: 'string' }) ?? []
          const single = readString(args, 'value', { tool })
          const list = values.length > 0 ? values : single === undefined ? [] : [single]
          if (list.length === 0) throw new ArgsError(`${tool}: select needs value or values`)
          const result = await client.call('page.select', withTab({ ...target, values: list }, tabId), { signal: exec?.signal })
          return { ...result, action, target: ref ?? css }
        }
        case 'scroll': {
          const result = await client.call('page.scroll', withTab({
            ...target,
            direction: readEnum(args, 'direction', { tool, values: ['up', 'down'], fallback: 'down' }),
            deltaY: readInteger(args, 'deltaY', { tool, min: -20_000, max: 20_000 }),
            deltaX: readInteger(args, 'deltaX', { tool, min: -20_000, max: 20_000 }),
          }, tabId), { signal: exec?.signal })
          return { ...result, action, target: ref ?? css ?? 'viewport' }
        }
        case 'focus': {
          const result = await client.call('page.focus', withTab(target, tabId), { signal: exec?.signal })
          return { ...result, action, target: ref ?? css }
        }
        case 'wait': {
          const kind = readEnum(args, 'kind', { tool, values: ['selector', 'text', 'ready'] })
          const wanted = readString(args, 'expected', { tool, maxLength: 2000 }) ?? readString(args, 'text', { tool, maxLength: 2000 }) ?? ''
          const timeoutMs = readInteger(args, 'timeoutMs', { tool, min: 100, max: 180_000, fallback: 10_000 })
          if (kind !== 'ready' && wanted === '') throw new ArgsError(`${tool}: wait needs expected (a selector or text fragment)`)
          const result = await client.call('page.waitFor', withTab({ kind, value: wanted, timeoutMs }, tabId), {
            signal: exec?.signal,
            timeoutMs: timeoutMs + 15_000,
          })
          return { ...result, action, detail: `${kind} ${JSON.stringify(wanted)}` }
        }
        case 'upload': {
          const files = readArray(args, 'files', { tool, of: 'string' }) ?? []
          if (files.length === 0) throw new ArgsError(`${tool}: upload needs files (absolute local paths)`)
          if (!ref && !css) throw new ArgsError(`${tool}: upload needs ref or selector naming the file input`)
          const result = await client.call('page.upload', withTab({ ...target, files }, tabId), { signal: exec?.signal })
          return { ...result, action, target: ref ?? css, detail: `${files.length} file(s)` }
        }
        case 'dialog': {
          // `text` is the shared string slot every other action already uses, so
          // it stays the documented name; `promptText` is the CDP-side name and
          // is accepted as an alias because that is what the errors used to say.
          const promptText = readString(args, 'promptText', { tool, maxLength: 4000 })
            ?? readString(args, 'text', { tool, maxLength: 4000 })
          const result = await client.call('page.handleDialog', withTab({
            accept: readBoolean(args, 'accept', { tool, fallback: true }),
            promptText,
          }, tabId), { signal: exec?.signal })
          return { ...result, action, detail: `${result.accepted ? 'accepted' : 'dismissed'} ${result.type ?? 'dialog'}` }
        }
        case 'waitIdle': {
          const idleMs = readInteger(args, 'idleMs', { tool, min: 50, max: 10_000, fallback: 500 })
          const timeoutMs = readInteger(args, 'timeoutMs', { tool, min: 100, max: 180_000, fallback: 15_000 })
          const result = await client.call('page.waitForNetworkIdle', withTab({ idleMs, timeoutMs }, tabId), {
            signal: exec?.signal,
            timeoutMs: timeoutMs + 15_000,
          })
          return { ...result, action, detail: `quiet for ${idleMs}ms` }
        }
        case 'viewport': {
          if (readBoolean(args, 'clear', { tool, fallback: false })) {
            const result = await client.call('page.clearViewport', withTab({}, tabId), { signal: exec?.signal })
            return { ...result, action, detail: 'viewport override cleared' }
          }
          const width = readInteger(args, 'width', { tool, min: 100, max: 10_000, fallback: 390 })
          const height = readInteger(args, 'height', { tool, min: 100, max: 10_000, fallback: 844 })
          const result = await client.call('page.setViewport', withTab({
            width,
            height,
            deviceScaleFactor: readNumber(args, 'deviceScaleFactor', { tool, min: 0.1, max: 10, fallback: 1 }),
            mobile: readBoolean(args, 'mobile', { tool, fallback: false }),
          }, tabId), { signal: exec?.signal })
          return { ...result, action, detail: `${width}x${height}` }
        }
        case 'media': {
          const result = await client.call('page.emulateMedia', withTab({
            colorScheme: readEnum(args, 'colorScheme', { tool, values: ['light', 'dark'] }),
            media: readString(args, 'media', { tool, maxLength: 40 }),
          }, tabId), { signal: exec?.signal })
          const applied = (result.features ?? []).map((feature) => `${feature.name}=${feature.value}`)
          const labels = [...(result.media ? [`media=${result.media}`] : []), ...applied]
          return { ...result, action, detail: labels.length === 0 ? 'emulation reset' : labels.join(' ') }
        }
        default:
          throw new ArgsError(`${tool}: unreachable action ${action}`)
      }
    },
    output: {
      schema: ACTION_SCHEMA,
      render: (_args, value) => {
        if (value.dialogOpened) {
          const dialog = value.dialog ?? {}
          const described = dialog.type ? `${dialog.type} "${dialog.message}"` : 'a javascript dialog'
          return text(
            `tab ${value.tabId}: the action ran but the page opened ${described} and is paused. ` +
              'Call chrome_use_interact action dialog with accept true or false (add promptText for a prompt) to continue.',
          )
        }
        const bits = [value.action]
        if (value.target) bits.push(`on ${value.target}`)
        if (value.detail) bits.push(value.detail)
        if (value.waitedMs !== undefined) bits.push(`after ${value.waitedMs}ms`)
        if (value.clicked !== undefined) bits.push(`clicked ${value.clicked}`)
        if (value.typed !== undefined) bits.push(`${value.typed} chars`)
        if (value.chosen) bits.push(`chose ${value.chosen.join(', ')}`)
        if (value.focused !== undefined) bits.push(`focused=${value.focused}`)
        return text(`tab ${value.tabId}: ${bits.join(' ')}`)
      },
    },
  }

  const read = {
    name: 'chrome_use_read',
    description:
      'Read what the page already produced without touching it. evaluate runs one expression in the page and returns its JSON value; console returns buffered console and exception entries; network lists buffered requests with status and timing; responseBody returns the body of the last matching response; storage reads or writes localStorage/sessionStorage; cookies lists or sets document cookies. Buffers are per attached tab and capped, so call right after the interaction that generated the traffic.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['evaluate', 'console', 'network', 'responseBody', 'storage', 'cookies', 'dialog'], description: 'Operation to perform.' },
        expression: { type: 'string', description: 'evaluate: JavaScript expression; a trailing expression value is returned.' },
        awaitPromise: { type: 'boolean', description: 'evaluate: await the result when it is a promise (default false).' },
        level: { type: 'string', enum: ['all', 'error', 'warning', 'info', 'verbose', 'log'], description: 'console: minimum level (default all).' },
        urlContains: { type: 'string', description: 'network/responseBody: only entries whose url contains this fragment.' },
        limit: { type: 'integer', description: 'console/network: how many newest entries to return (default 100).' },
        clear: { type: 'boolean', description: 'console/network: drop the buffer after reading (default false).' },
        operation: { type: 'string', enum: ['get', 'set', 'clear'], description: 'storage: what to do (default get).' },
        area: { type: 'string', enum: ['local', 'session'], description: 'storage: which storage area (default local).' },
        keys: { type: 'array', items: { type: 'string' }, description: 'storage: keys to read or clear; omit to read everything.' },
        entries: { type: 'object', additionalProperties: true, description: 'storage set: key/value pairs to write.' },
        name: { type: 'string', description: 'cookies: cookie name to filter or set.' },
        value: { type: 'string', description: 'cookies set: cookie value.' },
        url: { type: 'string', description: 'cookies: document url the cookie belongs to (default the tab url).' },
        path: { type: 'string', description: 'cookies set: cookie path (default /).' },
        domain: { type: 'string', description: 'cookies set: cookie domain.' },
        secure: { type: 'boolean', description: 'cookies set: mark the cookie Secure.' },
        httpOnly: { type: 'boolean', description: 'cookies set: mark the cookie HttpOnly.' },
        tab: { type: 'string', description: TAB_HINT },
        tabId: { type: 'integer', description: 'Exact tab id. Omit to use the focused tab.' },
        browser: { type: 'string', description: 'Which connected browser to use; omit when only one is attached.' },
      },
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(rawArgs, exec) {
      const tool = 'chrome_use_read'
      const args = rawArgs ?? {}
      assertArguments(args, {
        tool,
        allowed: ['action', 'expression', 'awaitPromise', 'level', 'urlContains', 'limit', 'clear', 'operation', 'area', 'keys', 'entries', 'name', 'value', 'url', 'path', 'domain', 'secure', 'httpOnly', 'tab', 'tabId', 'browser'],
        required: ['action'],
      })
      const action = readEnum(args, 'action', { tool, values: ['evaluate', 'console', 'network', 'responseBody', 'storage', 'cookies', 'dialog'] })
      const client = bridge.require(readString(args, 'browser', { tool }))
      const selector = {
        tabId: readInteger(args, 'tabId', { tool, min: 0 }),
        tab: readString(args, 'tab', { tool }),
      }
      const tabId = await resolveTabId(client, selector, tool)

      switch (action) {
        case 'evaluate': {
          const expression = readString(args, 'expression', { tool, maxLength: 500_000 })
          if (expression === undefined) throw new ArgsError(`${tool}: evaluate needs expression`)
          if (currentSettings().allowEvaluation === false) {
            throw new ArgsError(`${tool}: evaluation is switched off for this bundle. Turn on "Allow evaluate" on the DSH-Chrome-Use plugin page, or read the page with chrome_use_snapshot instead.`)
          }
          const result = await client.call('page.evaluate', withTab({
            expression,
            awaitPromise: readBoolean(args, 'awaitPromise', { tool, fallback: false }),
          }, tabId), { signal: exec?.signal })
          return { ...result, kind: 'evaluate' }
        }
        case 'console': {
          const result = await client.call('page.console', withTab({
            level: readEnum(args, 'level', { tool, values: ['all', 'error', 'warning', 'info', 'verbose', 'log'], fallback: 'all' }),
            limit: readInteger(args, 'limit', { tool, min: 1, max: 400, fallback: 100 }),
            clear: readBoolean(args, 'clear', { tool, fallback: false }),
          }, tabId), { signal: exec?.signal })
          return { ...result, kind: 'console' }
        }
        case 'network': {
          const result = await client.call('page.network', withTab({
            urlContains: readString(args, 'urlContains', { tool, maxLength: 2000 }),
            limit: readInteger(args, 'limit', { tool, min: 1, max: 300, fallback: 100 }),
            clear: readBoolean(args, 'clear', { tool, fallback: false }),
          }, tabId), { signal: exec?.signal })
          return { ...result, kind: 'network' }
        }
        case 'responseBody': {
          const result = await client.call('page.responseBody', withTab({
            urlContains: readString(args, 'urlContains', { tool, maxLength: 2000 }),
            limit: readInteger(args, 'limit', { tool, min: 200, max: 200_000, fallback: 20_000 }),
          }, tabId), { signal: exec?.signal })
          return { ...result, kind: 'responseBody' }
        }
        case 'storage': {
          const operation = readEnum(args, 'operation', { tool, values: ['get', 'set', 'clear'], fallback: 'get' })
          const result = await client.call('storage', withTab({
            operation,
            area: readEnum(args, 'area', { tool, values: ['local', 'session'], fallback: 'local' }),
            keys: readArray(args, 'keys', { tool, of: 'string' }),
            entries: readObject(args, 'entries', { tool, fallback: {} }),
          }, tabId), { signal: exec?.signal })
          return { ...result, kind: 'storage', action: operation }
        }
        case 'cookies': {
          const name = readString(args, 'name', { tool, maxLength: 400 })
          const url = readString(args, 'url', { tool, maxLength: 8000 })
          if (name !== undefined && args.value !== undefined) {
            const result = await client.call('cookies.set', withTab({
              url,
              name,
              value: readString(args, 'value', { tool, maxLength: 8000, fallback: '' }),
              path: readString(args, 'path', { tool }),
              domain: readString(args, 'domain', { tool }),
              secure: readBoolean(args, 'secure', { tool, fallback: false }),
              httpOnly: readBoolean(args, 'httpOnly', { tool, fallback: false }),
            }, tabId), { signal: exec?.signal })
            return { ...result, kind: 'cookies', action: 'set' }
          }
          const result = await client.call('cookies.get', withTab({ url, name }, tabId), { signal: exec?.signal })
          return { ...result, kind: 'cookies', action: 'get' }
        }
        case 'dialog': {
          const result = await client.call('page.pendingDialog', withTab({}, tabId), { signal: exec?.signal })
          return { ...result, kind: 'dialog' }
        }
        default:
          throw new ArgsError(`${tool}: unreachable action ${action}`)
      }
    },
    output: {
      schema: READ_SCHEMA,
      render: (_args, value) => {
        if (value.kind === 'dialog') {
          if (!value.dialog) return text('no javascript dialog is open on this tab')
          return text(`dialog is blocking the page: ${value.dialog.type} ${JSON.stringify(value.dialog.message ?? '')}\nanswer it with chrome_use_interact action dialog, accept true or false`)
        }
        if (value.kind === 'evaluate') {
          if (value.ok === false) return text(`evaluate failed: ${value.error}`)
          return text(`evaluate → ${value.type ?? typeof value.value}\n${formatValue(value.value)}`)
        }
        if (value.kind === 'console') {
          if (!value.entries?.length) return text('console buffer is empty')
          return text(value.entries.map((entry) => `[${entry.level}] ${entry.text}`).join('\n'))
        }
        if (value.kind === 'network') {
          if (!value.requests?.length) return text('network buffer is empty')
          return text(value.requests.map((request) => {
            const status = request.failed ? 'FAILED' : (request.status ?? '…')
            return `${status} ${request.method ?? ''} ${request.url}`.trimEnd()
          }).join('\n'))
        }
        if (value.kind === 'responseBody') {
          return text(`${value.status ?? ''} ${value.url ?? ''}\n${value.body ?? ''}`.trim())
        }
        if (value.kind === 'storage') {
          const keys = Object.keys(value.items ?? {})
          if (keys.length === 0) return text(`storage ${value.area}: empty`)
          return text(keys.map((key) => `  ${key} = ${formatValue(value.items[key])}`).join('\n'))
        }
        if (value.kind === 'cookies') {
          if (value.action === 'set') return text(`cookie set: ${value.set} on ${value.domain}`)
          if (!value.cookies?.length) return text(`no cookies for ${value.url}`)
          return text(value.cookies.map((cookie) => `  ${cookie.name}${cookie.httpOnly ? ' (httpOnly)' : ''} @ ${cookie.domain}${cookie.path}`).join('\n'))
        }
        return text(JSON.stringify(value, null, 2).slice(0, 4000))
      },
    },
  }

  const capture = {
    name: 'chrome_use_capture',
    description:
      'Produce files from the page. screenshot returns the viewport or the full scrollable page as an attached image the model can read; pdf prints the page; download saves a url through the browser download manager. Prefer chrome_use_snapshot for understanding a page and this tool when a human needs to look at it or when layout itself is the question.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['screenshot', 'pdf', 'download'], description: 'Operation to perform.' },
        fullPage: { type: 'boolean', description: 'screenshot: capture the whole scrollable page (default false).' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'screenshot: image format (default png).' },
        quality: { type: 'integer', description: 'screenshot: jpeg quality 1-100 (default 80).' },
        printBackground: { type: 'boolean', description: 'pdf: print background graphics (default true).' },
        landscape: { type: 'boolean', description: 'pdf: landscape orientation.' },
        url: { type: 'string', description: 'download: address to save (default the tab url).' },
        filename: { type: 'string', description: 'download: suggested path relative to the download directory.' },
        tab: { type: 'string', description: TAB_HINT },
        tabId: { type: 'integer', description: 'Exact tab id. Omit to use the focused tab.' },
        browser: { type: 'string', description: 'Which connected browser to use; omit when only one is attached.' },
      },
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => true,
    async execute(rawArgs, exec) {
      const tool = 'chrome_use_capture'
      const args = rawArgs ?? {}
      assertArguments(args, {
        tool,
        allowed: ['action', 'fullPage', 'format', 'quality', 'printBackground', 'landscape', 'url', 'filename', 'tab', 'tabId', 'browser'],
        required: ['action'],
      })
      const action = readEnum(args, 'action', { tool, values: ['screenshot', 'pdf', 'download'] })
      const client = bridge.require(readString(args, 'browser', { tool }))
      const selector = {
        tabId: readInteger(args, 'tabId', { tool, min: 0 }),
        tab: readString(args, 'tab', { tool }),
      }
      const tabId = await resolveTabId(client, selector, tool)

      if (action === 'download') {
        const result = await client.call('browser.download', withTab({
          url: readString(args, 'url', { tool, maxLength: 8000 }),
          filename: readString(args, 'filename', { tool, maxLength: 1000 }),
        }, tabId), { signal: exec?.signal })
        return { ...result, action }
      }
      if (action === 'pdf') {
        const result = await client.call('page.pdf', withTab({
          printBackground: readBoolean(args, 'printBackground', { tool, fallback: true }),
          landscape: readBoolean(args, 'landscape', { tool, fallback: false }),
        }, tabId), { signal: exec?.signal, timeoutMs: 120_000 })
        const block = await imageBlock(result.base64, 'application/pdf', `chrome-page-${result.tabId}.pdf`)
        return { ...result, action, format: 'pdf', bytes: Math.round((result.base64?.length ?? 0) * 0.75), ...(block ? { image: block.attachment } : {}) }
      }
      const format = readEnum(args, 'format', { tool, values: ['png', 'jpeg'], fallback: 'png' })
      const result = await client.call('page.screenshot', withTab({
        fullPage: readBoolean(args, 'fullPage', { tool, fallback: false }),
        format,
        quality: readInteger(args, 'quality', { tool, min: 1, max: 100, fallback: 80 }),
      }, tabId), { signal: exec?.signal, timeoutMs: 120_000 })
      const block = await imageBlock(result.base64, format === 'jpeg' ? 'image/jpeg' : 'image/png', `chrome-capture-${result.tabId}.${format === 'jpeg' ? 'jpg' : 'png'}`)
      const value = {
        tabId: result.tabId,
        url: result.url,
        title: result.title,
        action,
        format,
        fullPage: result.fullPage,
        bytes: Math.round((result.base64?.length ?? 0) * 0.75),
        ...(block ? { image: block.attachment } : {}),
      }
      if (!block) return { ...value, base64: result.base64 }
      return value
    },
    output: {
      schema: CAPTURE_SCHEMA,
      render: (_args, value) => {
        const head = value.action === 'download'
          ? `downloaded ${value.url} (id ${value.downloadId})`
          : `${value.action} ${value.format ?? ''} ${value.bytes ?? 0} bytes from [${value.tabId}] ${value.title || value.url || ''}`.trim()
        const blocks = text(head)
        if (value.image) blocks.push({ type: 'image', attachment: value.image })
        return blocks
      },
    },
  }

  return [status, tabs, navigate, snapshot, interact, read, capture].map(losslessOutput)
}

/**
 * Wrap one definition so its result is lossless JSON.
 * DSH rejects any tool result that survives no JSON round trip, and an
 * `undefined` property is the usual culprit when a live frame omits a field.
 */
function losslessOutput(definition) {
  const execute = definition.execute
  return {
    ...definition,
    async execute(args, exec) {
      const value = await execute(args, exec)
      const json = JSON.stringify(value, (_key, entry) => (entry === undefined ? undefined : entry))
      return json === undefined ? value : JSON.parse(json)
    },
  }
}

/** Format an arbitrary JSON value for one line of tool output. */
function formatValue(value) {
  if (value === undefined) return '(undefined)'
  try {
    const json = JSON.stringify(value, null, 2)
    if (json === undefined) return String(value)
    return json.length > 8000 ? `${json.slice(0, 8000)}\n… [${json.length} chars]` : json
  } catch {
    return String(value)
  }
}

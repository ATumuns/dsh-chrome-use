/**
 * DSH-Chrome-Use — let DSH drive the user's real Chrome through an extension.
 *
 * Shape: this package is a DSH host bundle. It claims one WebSocket upgrade
 * path on the loopback server DSH already runs, so the browser extension has a
 * stable endpoint with no second port, no native-messaging host and no registry
 * key. The extension dials out with a pairing token; this side turns the
 * connection into seven model-facing tools and one plugin page.
 *
 * Self-contained on purpose: no `@deepseek-ai/*` value import appears here or
 * in any module it loads, because a locally installed bundle cannot resolve
 * those packages from the profile's node_modules. Tool definitions are plain
 * objects validated by `./validate.js`, and services are reached through
 * `ctx.get(name)`.
 *
 * @module dsh-chrome-use
 */
import { Bridge, createToken, BRIDGE_PATH } from './bridge.js'
import { createControl } from './control.js'
import { createListener } from './listener.js'
import { createRoutes } from './routes.js'
import { activeToolNames, Config, normalizeSettings } from './settings.js'
import { createTools } from './tools.js'
import { readToken, tokenFilePath, writeToken } from './token-store.js'

/** Cordis plugin name. */
export const name = 'dsh-chrome-use'

/** Services this plugin needs before it can start. */
export const inject = ['tools', 'webServer']

// Named export for tests and for callers that import the module directly; the
// loader itself only ever reads `default`, which carries the same object.
export { Config }


/** Model-facing section that tells the agent when to reach for these tools. */
const PROMPT_SECTION = `You can drive the user's real Chrome browser through the DSH-Chrome-Use extension. The browser is the user's own: tabs they have open, sessions they are signed into, and windows they are looking at.

Reach for these tools when the task needs the live web rather than a static fetch: a page that requires the user's login, a JavaScript application that renders client-side, a form or flow that has to be operated step by step, a page whose layout or screenshot matters, or traffic and console errors that only exist while the page runs. For one-off static reading of a public URL, the built-in web fetch is cheaper.

How to work:
- chrome_use_status first when anything reports that no browser is connected; it returns the pairing token the user pastes into the extension. Its profile line says whether the windows you drive share the cookies the person is signed in with.
- chrome_use_tabs lists what is open, and returns the tabId every other tool accepts. Pass tabId rather than relying on which tab happens to be focused once more than one tab matters. Tabs opened here live in the same browser profile as the person's own, so their sign-ins keep working; a tab marked incognito is the exception, because an incognito window has its own empty cookie jar.
- chrome_use_tabs action window opens a separate browser window that never steals focus. Use it for unattended runs, so your clicks and the person's typing do not fight over the same surface; windowState lowers or restores it, closeWindow removes it.
- chrome_use_navigate loads a URL or moves through history, then chrome_use_snapshot reads the page as an outline with a ref per interactive element. Prefer a snapshot over a raw HTML dump: it shows what the user can actually see and act on.
- chrome_use_read action markdown converts the page body once and is far cheaper than a snapshot when you only need the prose, a table or a code block; action table returns every table as header plus rows; action metrics reports DOM size, JS heap and layout cost when performance is the question.
- chrome_use_interact takes those refs for click, hover, type, press, select, scroll, focus, drag, fill, upload and wait. Refs are invalidated by navigation and by the next snapshot, so snapshot again after the page changes.
- chrome_use_interact action fill types a whole form in one call (entries of ref or selector plus text), which is cheaper than one round trip per field. action handoff paints a bar into the page and waits for the person to finish signing in or confirming a payment — use it instead of typing credentials yourself.
- chrome_use_interact action network throttles or cuts the connection, geolocation and timezone move the page somewhere else, viewport and media emulate a phone or a dark theme. Each of them accepts clear true to restore the real value.
- chrome_use_read evaluates an expression or returns buffered console, network, storage and cookie state. Buffers are capped and per tab, so read them soon after the interaction that produced them.
- chrome_use_capture produces a screenshot, a PDF, or a download. Give it a ref or selector to capture one element when a full-page image would be unreadable. A full-page capture scrolls the document to its bottom first, so images and infinite lists that load on scroll are actually in the image; pass lazy false to see the page as the person first does.
- After changing something the user cares about, say which tab you touched and what changed. Group tabs with chrome_use_tabs action group when a task spans several pages, so the user can see the workspace you are using.`

/** Log sink that never becomes the reason a command fails. */
function makeLog(ctx) {
  const wrap = (level) => (message) => {
    try {
      ctx.logger?.[level]?.(message)
    } catch {
      // Logging must never be the reason a command fails.
    }
  }
  return { warn: wrap('warn'), info: wrap('info') }
}

/**
 * Resolve the directory this package lives in, for the install hint.
 * @returns {string}
 */
function packageRoot() {
  try {
    return new URL('..', import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1')
  } catch {
    return '(the dsh-chrome-use package directory)'
  }
}

/**
 * Plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ token?: string, tools?: boolean, prompt?: boolean, readOnly?: boolean, allowEvaluation?: boolean, disabledTools?: string[], port?: number, host?: string }} config
 */
export async function apply(ctx, rawConfig = {}) {
  const log = makeLog(ctx)
  const config = rawConfig ?? {}

  // The switches live in this bundle's configuration row. `configEditor` is the
  // only writer that reconciles the patch, validates against `Config` and lets
  // the loader reload us, so the plugin page saves through it and never edits
  // YAML itself.
  const settings = normalizeSettings(config)

  // The token outlives a plugin reload: the extension keeps its copy in
  // chrome.storage, so regenerating on every mount would silently strand a
  // working connection. Configuration wins, then the persisted file, then a
  // fresh token that is written for next time.
  const configuredToken = typeof config.token === 'string' && config.token.length > 0 ? config.token : undefined
  const persistedToken = configuredToken === undefined ? readToken() : undefined
  let token = configuredToken ?? persistedToken ?? createToken()
  let tokenSource = configuredToken !== undefined ? 'config' : persistedToken !== undefined ? 'file' : 'generated'
  if (tokenSource === 'generated') {
    try {
      writeToken(token)
    } catch (error) {
      log.warn(`dsh-chrome-use: could not persist the pairing token to ${tokenFilePath()}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const bridge = new Bridge({ token: () => token, log })

  const webServer = ctx.get('webServer')
  if (!webServer) {
    throw new Error('dsh-chrome-use needs the host web server: no WebSocket upgrade path can be claimed without it')
  }
  const origin = webServer.getOrigin()
  // The host server's port is OS-assigned, so this address dies with every DSH
  // restart. It stays as the fallback endpoint when the fixed port is taken.
  const ephemeralEndpoint = `${origin.replace(/^http/, 'ws')}${BRIDGE_PATH}`
  let endpoint = ephemeralEndpoint

  // A fixed loopback port is what makes an unattended reconnect possible: the
  // extension keeps one address across DSH restarts instead of going stale
  // whenever the host picks a new port. Failure to bind is reported, not fatal.
  ctx.effect(() => {
    let listener
    let disposed = false
    void createListener({
      port: settings.port,
      host: settings.host,
      router: bridge.upgradeRouter,
      log,
    }).then((bound) => {
      if (disposed) {
        void bound.close()
        return
      }
      listener = bound
      if (bound.listening) {
        endpoint = `${bound.url}${BRIDGE_PATH}`
        log.info(`dsh-chrome-use: bridge listening on ${endpoint}`)
        return
      }
      log.warn(
        `dsh-chrome-use: could not claim port ${settings.port} (${bound.reason}); ` +
          `the bridge stays on the DSH web server at ${ephemeralEndpoint}, which changes port on restart`,
      )
    })
    return () => {
      disposed = true
      bridge.close()
      void listener?.close()
    }
  }, 'dsh-chrome-use/listener')

  // The route is claimed for this plugin's lifetime. `ctx.effect` ties the
  // disposer to plugin teardown, so a reload drops the route instead of
  // tripping the duplicate-path guard on the next mount.
  ctx.effect(() => {
    const release = webServer.registerUpgrade({
      path: BRIDGE_PATH,
      handler: (request, socket) => {
        bridge.upgradeRouter.handleUpgrade(request, socket)
      },
    })
    return () => {
      release()
      bridge.close()
    }
  }, 'dsh-chrome-use/bridge-route')

  // The router emits `connection` after a successful handshake; adopting here
  // keeps the client registry in one place instead of inside the route.
  ctx.effect(() => {
    const onConnection = (connection) => {
      bridge.adopt(connection)
    }
    bridge.upgradeRouter.on('connection', onConnection)
    return () => {
      bridge.upgradeRouter.off('connection', onConnection)
    }
  }, 'dsh-chrome-use/bridge-clients')

  const rotateToken = () => {
    token = createToken()
    tokenSource = 'generated'
    try {
      writeToken(token)
    } catch (error) {
      log.warn(`dsh-chrome-use: could not persist the rotated token: ${error instanceof Error ? error.message : String(error)}`)
    }
    log.info('dsh-chrome-use: pairing token rotated; the extension must reconnect with the new token')
    return token
  }

  // Capabilities are a property of the extension build, not of this host, so
  // they stay a constant here and reach the page through the control snapshot.
  const capabilities = { cdp: true, input: true, network: true, screenshots: true }

  const control = createControl({
    ctx,
    bridge,
    log,
    settings: () => settings,
    token: () => token,
    tokenSource: () => tokenSource,
    rotateToken,
    endpoint: () => endpoint,
    capabilities,
  })

  const definitions = createTools({
    bridge,
    token: () => token,
    rotateToken,
    endpoint: () => endpoint,
    ctx,
    log,
    settings: () => settings,
  })

  // Which tools exist is decided here rather than inside each tool, so a
  // disabled tool disappears from the model surface entirely instead of
  // appearing and then refusing.
  const active = new Set(activeToolNames(settings))
  for (const definition of definitions) {
    if (!active.has(definition.name)) continue
    ctx.effect(
      () => ctx.tools.register(definition),
      `dsh-chrome-use/tool/${definition.name}`,
    )
  }

  const systemPrompt = ctx.get('systemPrompt')
  if (settings.prompt !== false && systemPrompt?.section) {
    ctx.effect(
      () => systemPrompt.section({
        name: 'tool:chrome_use',
        order: systemPrompt.getSectionOrder?.('TOOL_WEB_FETCH') ?? 2101,
        text: PROMPT_SECTION,
      }),
      'dsh-chrome-use/prompt',
    )
  }

  // Three loopback routes serve the plugin page. They are fenced by the same
  // Host/Origin gate the rest of the harness uses, so a page from another
  // origin cannot read the pairing token out of a local port.
  const routes = createRoutes({ ctx, control, log })
  for (const [label, route] of [['state', routes.state], ['settings', routes.settings], ['token', routes.token]]) {
    ctx.effect(() => webServer.register(route), `dsh-chrome-use/route/${label}`)
  }

  // The listener binds asynchronously and logs its own address once it knows
  // which path won, so this line must not name one. It used to print the
  // ephemeral endpoint, which was already wrong a moment later.
  log.info(`dsh-chrome-use: pairing token source is ${tokenSource}; chrome_use_status reports the live bridge address`)
  log.info(
    `dsh-chrome-use: load the extension from ${packageRoot()}/extension — chrome://extensions → Developer mode → Load unpacked`,
  )
}

// The loader applies `default` and drops every named export, so `Config` has to
// ride on this object. Left off, `runtime.Config` is undefined, the loader skips
// validation entirely, and an invalid settings patch reaches the plugin.
export default { name, inject, Config, apply }

/**
 * DSH-Chrome-Use — let DSH drive the user's real Chrome through an extension.
 *
 * Shape: this package is a DSH host bundle. It claims one WebSocket upgrade
 * path on the loopback server DSH already runs, so the browser extension has a
 * stable endpoint with no second port, no native-messaging host and no registry
 * key. The extension dials out with a pairing token; this side turns the
 * connection into seven model-facing tools.
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
import { createTools } from './tools.js'
import { readToken, tokenFilePath, writeToken } from './token-store.js'

/** Cordis plugin name. */
export const name = 'dsh-chrome-use'

/** Services this plugin needs before it can start. */
export const inject = ['tools', 'webServer']

/** Model-facing section that tells the agent when to reach for these tools. */
const PROMPT_SECTION = `You can drive the user's real Chrome browser through the DSH-Chrome-Use extension. The browser is the user's own: tabs they have open, sessions they are signed into, and windows they are looking at.

Reach for these tools when the task needs the live web rather than a static fetch: a page that requires the user's login, a JavaScript application that renders client-side, a form or flow that has to be operated step by step, a page whose layout or screenshot matters, or traffic and console errors that only exist while the page runs. For one-off static reading of a public URL, the built-in web fetch is cheaper.

How to work:
- chrome_use_status first when anything reports that no browser is connected; it returns the pairing token the user pastes into the extension.
- chrome_use_tabs lists what is open, and returns the tabId every other tool accepts. Pass tabId rather than relying on which tab happens to be focused once more than one tab matters.
- chrome_use_navigate loads a URL or moves through history, then chrome_use_snapshot reads the page as an outline with a ref per interactive element. Prefer a snapshot over a raw HTML dump: it shows what the user can actually see and act on.
- chrome_use_interact takes those refs for click, hover, type, press, select, scroll, focus and wait. Refs are invalidated by navigation and by the next snapshot, so snapshot again after the page changes.
- chrome_use_read evaluates an expression or returns buffered console, network, storage and cookie state. Buffers are capped and per tab, so read them soon after the interaction that produced them.
- chrome_use_capture produces a screenshot or PDF when a human needs to see the result or when layout itself is the question.
- After changing something the user cares about, say which tab you touched and what changed. Group tabs with chrome_use_tabs action group when a task spans several pages, so the user can see the workspace you are using.`

/**
 * Resolve the directory this package lives in, for the install hint.
 * @returns {string}
 */
function packageRoot() {
  try {
    return new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  } catch {
    return '(the dsh-chrome-use package directory)'
  }
}

/**
 * Plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ token?: string, endpointNote?: string, tools?: boolean, prompt?: boolean }} config
 */
export async function apply(ctx, config = {}) {
  const log = {
    warn: (message) => {
      try {
        ctx.logger?.warn?.(message)
      } catch {
        // Logging must never be the reason a command fails.
      }
    },
    info: (message) => {
      try {
        ctx.logger?.info?.(message)
      } catch {
        // Same.
      }
    },
  }

  // The token outlives a plugin reload: the extension keeps its copy in
  // chrome.storage, so regenerating on every mount would silently strand a
  // working connection. Configuration wins, then the persisted file, then a
  // fresh token that is written for next time.
  const configuredToken = typeof config.token === 'string' && config.token.length > 0 ? config.token : undefined
  let token = configuredToken ?? readToken() ?? createToken()
  const tokenSource = configuredToken ? 'config' : readToken() ? 'file' : 'generated'
  if (!configuredToken && tokenSource === 'generated') {
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
  const endpoint = `${origin.replace(/^http/, 'ws')}${BRIDGE_PATH}`

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
    try {
      writeToken(token)
    } catch (error) {
      log.warn(`dsh-chrome-use: could not persist the rotated token: ${error instanceof Error ? error.message : String(error)}`)
    }
    log.info('dsh-chrome-use: pairing token rotated; the extension must reconnect with the new token')
    return token
  }

  const definitions = createTools({
    bridge,
    token: () => token,
    rotateToken,
    endpoint: () => endpoint,
    ctx,
    log,
  })

  if (config.tools !== false) {
    for (const definition of definitions) {
      ctx.effect(
        () => ctx.tools.register(definition),
        `dsh-chrome-use/tool/${definition.name}`,
      )
    }
  }

  const systemPrompt = ctx.get('systemPrompt')
  if (config.prompt !== false && systemPrompt?.section) {
    ctx.effect(
      () => systemPrompt.section({
        name: 'tool:chrome_use',
        order: systemPrompt.getSectionOrder?.('TOOL_WEB_FETCH') ?? 2101,
        text: PROMPT_SECTION,
      }),
      'dsh-chrome-use/prompt',
    )
  }

  log.info(`dsh-chrome-use: bridge listening at ${endpoint} (token ${tokenSource})`)
  log.info(
    `dsh-chrome-use: load the extension from ${packageRoot()}/extension — chrome://extensions → Developer mode → Load unpacked`,
  )
}

export default { name, inject, apply }

/**
 * The loopback bridge between DSH and the browser extension.
 *
 * DSH already serves a loopback HTTP server for its Web UI. This module claims
 * one WebSocket upgrade path on it, so the extension has a stable endpoint with
 * no extra port, no native-messaging host, and no registry key.
 *
 * The extension dials out, so the token is the only credential: it is read from
 * the handshake query string and compared in constant time before the socket is
 * promoted to a WebSocket. A wrong token ends the HTTP connection with 401 and
 * never reaches the protocol layer.
 *
 * @module dsh-chrome-use/bridge
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { WebSocketRouter } from './ws.js'

/** Absolute pathname claimed on the host's web server. */
export const BRIDGE_PATH = '/dsh-chrome-use/bridge'

/** Protocol revision the extension must announce. */
export const PROTOCOL_VERSION = 1

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
const PING_INTERVAL_MS = 25_000

/** A random token; 32 hex characters is plenty for a loopback handshake. */
export function createToken() {
  return randomBytes(16).toString('hex')
}

function equalToken(given, expected) {
  if (typeof given !== 'string' || given.length !== expected.length) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Compare two tokens without leaking how many leading bytes match.
 *
 * Exported because the plugin's HTTP routes accept the same pairing token the
 * bridge handshake does: one credential, one comparison.
 *
 * @param {string} given
 * @param {string} expected
 * @returns {boolean}
 */
export function tokensEqual(given, expected) {
  return equalToken(given, expected)
}

/** One connected browser. */
class Client {
  /**
   * @param {string} id
   * @param {import('./ws.js').WebSocketConnection} connection
   * @param {Record<string, unknown>} hello
   */
  constructor(id, connection, hello) {
    this.id = id
    this.connection = connection
    this.hello = hello
    this.browser = hello.browser ?? {}
    this.label = typeof hello.agent === 'string' && hello.agent ? hello.agent : 'chrome'
    this.connectedAt = Date.now()
    /** @type {Map<string, { resolve: (value: unknown) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>} */
    this.pending = new Map()
    this.nextId = 1
    this.lastSeen = Date.now()

    connection.on('message', (buffer) => this.#onMessage(buffer))
    connection.on('close', () => this.#onClose())
  }

  /**
   * Send one command and settle on the matching reply.
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<unknown>}
   */
  call(method, params, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    const id = `${this.id}:${this.nextId++}`
    return new Promise((resolve, reject) => {
      if (!this.connection.open) {
        reject(new Error('the browser extension disconnected; ask the user to reopen the extension popup and reconnect'))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`the browser did not answer ${method} within ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      const onAbort = () => {
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        reject(new Error(`${method} was cancelled`))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        this.connection.sendJSON({ id, method, params })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  ping() {
    try {
      this.connection.sendJSON({ type: 'ping' })
    } catch {
      // The close handler reports the disconnect; a failed ping is not worth a throw.
    }
  }

  close() {
    this.connection.close(1000, 'host closing')
  }

  describe() {
    return {
      clientId: this.id,
      label: this.label,
      browser: this.browser,
      connectedAt: new Date(this.connectedAt).toISOString(),
      commands: this.pending.size,
    }
  }

  #onMessage(buffer) {
    this.lastSeen = Date.now()
    let frame
    try {
      frame = JSON.parse(buffer.toString('utf8'))
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'pong') return
    if (frame.type === 'ping') {
      this.connection.sendJSON({ type: 'pong' })
      return
    }
    if (frame.type === 'hello') {
      this.hello = frame
      this.browser = frame.browser ?? this.browser
      if (typeof frame.agent === 'string' && frame.agent) this.label = frame.agent
      return
    }
    if (typeof frame.id !== 'string') return
    const entry = this.pending.get(frame.id)
    if (!entry) return
    this.pending.delete(frame.id)
    clearTimeout(entry.timer)
    if (frame.ok) entry.resolve(frame.result)
    else entry.reject(new Error(frame.error?.message ?? 'the browser reported a failure'))
  }

  #onClose() {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('the browser extension disconnected before answering'))
    }
    this.pending.clear()
  }
}

/**
 * Owns the upgrade route, the token, and the set of connected browsers.
 */
export class Bridge {
  /**
   * @param {{ token: () => string, log?: { warn: (message: string) => void } }} options
   */
  constructor(options) {
    this.currentToken = options.token
    this.log = options.log
    /** @type {Map<string, Client>} */
    this.clients = new Map()
    this.router = new WebSocketRouter((request) => this.#handshake(request))
    this.router.on('connection', (connection) => {
      this.log?.warn?.(`dsh-chrome-use: bridge connection ${connection.id} opened`)
    })
    this.pinger = setInterval(() => {
      for (const client of this.clients.values()) client.ping()
    }, PING_INTERVAL_MS)
    this.pinger.unref?.()
  }

  /** @returns {import('./ws.js').WebSocketRouter} */
  get upgradeRouter() {
    return this.router
  }

  /**
   * Validate the handshake; the token decides.
   * @param {import('node:http').IncomingMessage} request
   */
  #handshake(request) {
    let url
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1')
    } catch {
      return { rejection: 'malformed request target' }
    }
    const token = url.searchParams.get('token') ?? ''
    if (!equalToken(token, this.currentToken())) {
      return { rejection: 'pairing token mismatch; copy the current token from chrome_use_status' }
    }
    const version = Number(url.searchParams.get('v') ?? '0')
    if (version !== PROTOCOL_VERSION) {
      return { rejection: `protocol version ${version} is not supported; this build speaks ${PROTOCOL_VERSION}` }
    }
    const label = url.searchParams.get('agent') ?? 'chrome'
    return { context: { label } }
  }

  /**
   * Take ownership of a freshly upgraded socket.
   *
   * The router emits `connection` synchronously after this returns, so the
   * client record is created here and the first `hello` frame only fills in
   * browser details.
   * @param {import('./ws.js').WebSocketConnection} connection
   */
  adopt(connection) {
    const label = typeof connection.context?.label === 'string' ? connection.context.label : 'chrome'
    const id = createHash('sha256').update(`${connection.id}:${Date.now()}`).digest('hex').slice(0, 12)
    const client = new Client(id, connection, { agent: label })
    this.clients.set(id, client)
    connection.sendJSON({
      type: 'welcome',
      sessionId: id,
      protocol: PROTOCOL_VERSION,
      caps: { cdp: true, input: true, network: true, screenshots: true },
    })
    connection.on('close', () => {
      this.clients.delete(id)
      this.log?.warn?.(`dsh-chrome-use: bridge connection ${id} closed`)
    })
    return client
  }

  /** @returns {Client[]} Connected browsers, most recent first. */
  list() {
    return [...this.clients.values()].sort((a, b) => b.connectedAt - a.connectedAt)
  }

  /**
   * The browser a command should target.
   * @param {string | undefined} wanted
   * @returns {Client}
   */
  require(wanted) {
    const all = this.list()
    if (all.length === 0) {
      throw new Error(
        'no browser is connected. Install the DSH-Chrome-Use extension, open its options page, paste the token from chrome_use_status, and press connect',
      )
    }
    if (!wanted) return all[0]
    const found = all.find((client) => client.id === wanted || client.label === wanted)
    if (!found) {
      throw new Error(`no connected browser matches ${JSON.stringify(wanted)}; connected: ${all.map((client) => client.label).join(', ')}`)
    }
    return found
  }

  describe() {
    return this.list().map((client) => client.describe())
  }

  close() {
    clearInterval(this.pinger)
    for (const client of this.clients.values()) client.close()
    this.clients.clear()
    this.router.closeAll(1001, 'plugin unloading')
  }
}

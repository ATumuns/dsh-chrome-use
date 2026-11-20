/**
 * A loopback listener owned by this plugin, so the extension has one address
 * that outlives a DSH restart.
 *
 * Why this exists: the host web server binds an OS-assigned port (`port: 0`),
 * so its origin changes on every start — 57232 one day, 50949 the next. An
 * extension that dials `http://127.0.0.1:<that port>` therefore goes stale on
 * every restart and the user has to paste a new URL by hand. Claiming an
 * upgrade path on that server keeps the handshake code in one place, but it
 * cannot give the extension a stable address, which is the part that matters
 * for unattended reconnects.
 *
 * So this module owns a second socket on a fixed loopback port. It is the same
 * handshake and the same token gate — a second door into one router, not a
 * second protocol.
 *
 * Failing to bind is not fatal: another DSH instance may already hold the port,
 * and in that case the caller keeps the web-server route and reports the
 * ephemeral endpoint instead of refusing to start.
 *
 * @module dsh-chrome-use/listener
 */
import { createServer } from 'node:http'

/** Default port. High, unprivileged, and not used by anything DSH ships. */
export const DEFAULT_BRIDGE_PORT = 8971

/** Bound to loopback unless someone deliberately widens it. */
export const DEFAULT_BRIDGE_HOST = '127.0.0.1'

/**
 * @typedef {object} ListenerOptions
 * @property {number} [port]      Port to bind; 0 asks the OS for one.
 * @property {string} [host]      Interface to bind.
 * @property {{ handleUpgrade(request: import('node:http').IncomingMessage, socket: import('node:stream').Duplex): void }} router
 * @property {{ info(message: string): void, warn(message: string): void }} log
 */

/**
 * Bind the bridge on its own port.
 *
 * Rejects only when the socket cannot listen for a reason other than the port
 * being taken — `EADDRINUSE` resolves to `{ listening: false, reason }` so the
 * caller can fall back instead of taking the whole plugin down.
 *
 * @param {ListenerOptions} options
 * @returns {Promise<{ listening: boolean, port?: number, host?: string, url?: string, reason?: string, close: () => Promise<void> }>}
 */
export async function createListener(options) {
  const { router, log } = options
  const host = options.host ?? DEFAULT_BRIDGE_HOST
  const port = options.port ?? DEFAULT_BRIDGE_PORT

  const server = createServer((request, response) => {
    // Nothing but the bridge lives here, and the bridge is an upgrade. A plain
    // request is a client that guessed the address; it should not learn
    // anything about the machine beyond "not here".
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    response.end('dsh-chrome-use: this port only speaks the bridge websocket\n')
  })

  server.on('upgrade', (request, socket, head) => {
    try {
      router.handleUpgrade(request, socket, head)
    } catch (error) {
      log.warn(`dsh-chrome-use: bridge upgrade failed: ${error instanceof Error ? error.message : String(error)}`)
      socket.destroy()
    }
  })

  server.on('clientError', (_error, socket) => {
    // A half-open connection is routine on a loopback port that a browser
    // probes; destroying it is the whole handling.
    socket.destroy()
  })

  const close = () =>
    new Promise((resolve) => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close(() => resolve())
      // `close` waits for open sockets. The router already closes its own
      // connections on teardown, but a probe can still be mid-handshake, and a
      // hanging disposer would block the plugin reload.
      server.closeAllConnections?.()
    })

  const listening = await new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      server.removeListener('error', onError)
      resolve(value)
    }
    const onError = (error) => {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code
      if (code === 'EADDRINUSE') {
        finish({ listening: false, reason: `port ${port} is already taken by another process` })
        return
      }
      finish({ listening: false, reason: error instanceof Error ? error.message : String(error) })
    }
    server.on('error', onError)
    server.listen(port, host, () => {
      const address = server.address()
      const bound = typeof address === 'object' && address !== null ? address.port : port
      finish({ listening: true, port: bound, host })
    })
  })

  if (!listening.listening) {
    await close()
    return { ...listening, close }
  }

  const boundPort = /** @type {number} */ (listening.port)
  return {
    listening: true,
    port: boundPort,
    host,
    url: `ws://${host}:${boundPort}`,
    close,
  }
}

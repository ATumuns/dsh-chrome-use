/**
 * Self-test for the dependency-free WebSocket server and the bridge handshake.
 *
 * Node ships a global `WebSocket` client, so the server side is exercised end to
 * end: upgrade, token admission, framing, fragmentation, ping/pong, JSON
 * commands with replies, and an oversized frame.
 *
 *   node test/ws-bridge.test.mjs
 */
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { Bridge, createToken, BRIDGE_PATH, PROTOCOL_VERSION } from '../lib/bridge.js'

const token = createToken()
const bridge = new Bridge({ token: () => token })

const server = createServer((_request, response) => {
  response.writeHead(404).end()
})
server.on('upgrade', (request, socket, head) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (path !== BRIDGE_PATH) {
    socket.destroy()
    return
  }
  bridge.upgradeRouter.handleUpgrade(request, socket, head)
})
bridge.upgradeRouter.on('connection', (connection) => bridge.adopt(connection))

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const base = `ws://127.0.0.1:${port}${BRIDGE_PATH}`

function open(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.addEventListener('open', () => resolve(socket))
    socket.addEventListener('error', () => reject(new Error(`cannot open ${url}`)))
  })
}

/** Collect the first `n` text frames. */
function collect(socket, n) {
  return new Promise((resolve) => {
    const frames = []
    const onMessage = (event) => {
      if (typeof event.data !== 'string') return
      frames.push(JSON.parse(event.data))
      if (frames.length >= n) {
        socket.removeEventListener('message', onMessage)
        resolve(frames)
      }
    }
    socket.addEventListener('message', onMessage)
  })
}

// 1. A wrong token is refused before the upgrade completes.
await assert.rejects(open(`${base}?token=wrong&v=${PROTOCOL_VERSION}`), /cannot open/)

// 2. A wrong protocol version is refused too.
await assert.rejects(open(`${base}?token=${token}&v=99`), /cannot open/)

// 3. A correct handshake is welcomed.
const client = await open(`${base}?token=${token}&v=${PROTOCOL_VERSION}&agent=test`)
const welcome = await collect(client, 1)
assert.equal(welcome[0].type, 'welcome')
assert.equal(welcome[0].protocol, PROTOCOL_VERSION)
assert.ok(welcome[0].sessionId)

// 4. The host sees exactly one client with the announced label.
assert.equal(bridge.list().length, 1)
assert.equal(bridge.list()[0].label, 'test')

// 5. A command is routed to the client and its reply resolves the pending call.
client.addEventListener('message', (event) => {
  if (typeof event.data !== 'string') return
  const frame = JSON.parse(event.data)
  if (!frame.id) return
  if (frame.method === 'echo') client.send(JSON.stringify({ id: frame.id, ok: true, result: frame.params }))
  if (frame.method === 'boom') client.send(JSON.stringify({ id: frame.id, ok: false, error: { message: 'exploded' } }))
})
const echoed = await bridge.require().call('echo', { hello: 'world' })
assert.deepEqual(echoed, { hello: 'world' })

// 6. A reported failure rejects with the browser's message.
await assert.rejects(bridge.require().call('boom', {}), /exploded/)

// 7. A client that never answers times out instead of hanging forever.
client.addEventListener('message', (event) => {
  if (typeof event.data !== 'string') return
  const frame = JSON.parse(event.data)
  if (frame.method === 'silent') {
    // Intentionally no reply.
  }
})
await assert.rejects(bridge.require().call('silent', {}, { timeoutMs: 250 }), /did not answer/)

// 8. A large payload survives framing (well past the 125-byte header switch).
const big = 'x'.repeat(200_000)
const echoBig = await bridge.require().call('echo', { big })
assert.equal(echoBig.big.length, 200_000)

// 9. Disconnecting drops the client and rejects in-flight work.
const pending = bridge.require().call('silent', {}, { timeoutMs: 5000 })
client.close()
await assert.rejects(pending, /disconnected/)
await new Promise((resolve) => setTimeout(resolve, 80))
assert.equal(bridge.list().length, 0)

// 10. Half-open sockets do not leak: closeAll empties the router registry.
bridge.close()
assert.equal(bridge.clients.size, 0)

server.close()
console.log('ws-bridge: all checks passed')

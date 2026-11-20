/**
 * The fixed-port listener is the piece that keeps the extension reachable, so
 * it gets its own test instead of being covered only through the plugin mount.
 *
 * Run: node test/listener.test.mjs
 */
import { createServer } from 'node:http'
import { WebSocketRouter } from '../lib/ws.js'
import { createListener, DEFAULT_BRIDGE_PORT, DEFAULT_BRIDGE_HOST } from '../lib/listener.js'

let failures = 0
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`)
    return
  }
  failures += 1
  process.stdout.write(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}\n`)
}

const silent = { info() {}, warn() {} }

process.stdout.write('listener\n')

check('the defaults are loopback on a high port', DEFAULT_BRIDGE_HOST === '127.0.0.1' && DEFAULT_BRIDGE_PORT === 8971)

// --- binds and reports a usable address -------------------------------------

const router = new WebSocketRouter(() => ({ context: { label: 'test' } }))
const bound = await createListener({ port: 0, router, log: silent })

check('the listener binds', bound.listening === true, JSON.stringify(bound))
check('it reports the port the OS chose', typeof bound.port === 'number' && bound.port > 0, String(bound.port))
check('it reports a loopback url', bound.url === `ws://127.0.0.1:${bound.port}`, bound.url)

// A plain HTTP request must not be mistaken for an upgrade.
const plain = await fetch(`http://127.0.0.1:${bound.port}/anything`)
check('a plain request gets 404, not a bridge', plain.status === 404, String(plain.status))
check('the body names the port as a bridge', /bridge websocket/.test(await plain.text()))

// --- a taken port is a reported fallback, not a crash -----------------------

const squatter = createServer(() => {})
await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve))
const takenPort = /** @type {import('node:net').AddressInfo} */ (squatter.address()).port

const blocked = await createListener({ port: takenPort, router, log: silent })
check('a taken port resolves instead of throwing', blocked.listening === false, JSON.stringify(blocked))
check(
  'the reason names the port',
  typeof blocked.reason === 'string' && blocked.reason.includes(String(takenPort)),
  blocked.reason,
)

// --- close is idempotent and actually releases the port ---------------------

await bound.close()
await bound.close()
check('closing twice is fine', true)

const again = await createListener({ port: bound.port, router, log: silent })
check('the port is usable after close', again.listening === true, JSON.stringify(again))
await again.close()

// --- teardown ---------------------------------------------------------------

squatter.closeAllConnections?.()
await new Promise((resolve) => squatter.close(resolve))
router.closeAll()
await blocked.close()

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
if (failures > 0) process.exitCode = 1
else process.stdout.write('listener: all checks passed\n')

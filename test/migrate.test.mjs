/**
 * Upgrade path: an install from before 1.0.2 holds the host web server's
 * OS-assigned port in `chrome.storage`, an address that stopped resolving the
 * first time DSH restarted. The worker must rewrite it to the fixed port and
 * keep the pairing token, because nobody is going to edit the options page to
 * recover a connection they never knew they had.
 *
 * Only environment-independent facts are asserted here: whether the fixed port
 * happens to be listening depends on whether DSH is running.
 *
 * Run: node test/migrate.test.mjs
 */
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const store = new Map()
const alarms = new Map()
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return store.has(key) ? { [key]: store.get(key) } : {}
        return Object.fromEntries(store)
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store.set(k, v)
      },
    },
  },
  alarms: {
    async create(name, info) { alarms.set(name, info) },
    async get(name) { return alarms.has(name) ? { name } : undefined },
    onAlarm: { addListener() {} },
  },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  runtime: {
    getManifest: () => ({ version: '1.0.2' }),
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener() {} },
  },
  tabs: { onRemoved: { addListener() {} } },
  debugger: { onDetach: { addListener() {} } },
}
// Node 26 exposes `navigator` as a getter, so a plain assignment throws.
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 Chrome/157.0.0.0' },
  configurable: true,
})

// What a pre-1.0.2 install persisted: the ephemeral host web server port.
store.set('dsh-chrome-use/settings', {
  bridgeUrl: 'ws://127.0.0.1:57232/dsh-chrome-use/bridge',
  token: 'harness-token',
  autoConnect: true,
  agentLabel: 'harness',
})

await import(pathToFileURL(join(root, 'extension/background.js')).href)
await new Promise((resolve) => setTimeout(resolve, 1200))

const settings = store.get('dsh-chrome-use/settings') ?? {}
const results = []
const check = (label, ok, detail) => results.push({ label, ok, detail })

check(
  'a stale address is rewritten to the fixed port',
  settings.bridgeUrl === 'ws://127.0.0.1:8971/dsh-chrome-use/bridge',
  `bridgeUrl=${settings.bridgeUrl}`,
)
check('the pairing token survives the rewrite', settings.token === 'harness-token', `token=${settings.token}`)
check('the rest of the settings survive too', settings.agentLabel === 'harness' && settings.autoConnect === true, JSON.stringify(settings))
check(
  'the keepalive alarm is armed so a revival is possible',
  alarms.has('dsh-chrome-use/keepalive'),
  `alarms=${[...alarms.keys()].join(',') || 'none'}`,
)

let failures = 0
for (const r of results) {
  if (!r.ok) failures += 1
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.label}${r.ok ? '' : `\n       ${r.detail}`}`)
}
console.log(`\n${failures === 0 ? `migrate: all ${results.length} checks passed` : `migrate: ${failures} check(s) failed`}`)
process.exit(failures > 0 ? 1 : 0)

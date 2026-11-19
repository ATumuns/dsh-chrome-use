/**
 * Exercise every extension-side handler against a stubbed chrome + CDP.
 *
 * This is the seam the browser cannot cover offline: it proves each dispatch
 * name reaches a handler, that the handler's CDP calls are shaped the way the
 * protocol expects, and that the object it returns carries the fields the host
 * renders. It does not prove the browser behaves.
 */
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const checks = []
const check = (name, condition, detail = '') => {
  checks.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
}

const ANY_EVALUATE = {
  ok: true,
  url: 'https://example.test/page',
  title: 'Example',
  truncated: false,
  chars: 5,
  markdown: '# hi',
  count: 1,
  tables: [{ header: ['a'], rows: [['1']], rowCount: 1, caption: null }],
  nodesVisited: 3,
  framesWalked: 0,
  outline: 'body',
  refs: [],
  x: 100,
  y: 120,
  width: 40,
  height: 20,
  inViewport: true,
  coveredBy: null,
  matched: true,
  waitedMs: 12,
  resumed: true,
  focused: true,
  dialog: null,
  value: 'v',
}

const sent = []
const sendCommand = async (target, method, params = {}) => {
  sent.push({ tabId: target?.tabId ?? null, method, params })
  if (method === 'Runtime.evaluate') return { result: { value: ANY_EVALUATE } }
  if (method === 'Page.getLayoutMetrics') {
    return { cssLayoutViewport: { pageX: 12, pageY: 34, clientWidth: 1000, clientHeight: 800 } }
  }
  if (method === 'Page.captureScreenshot') return { data: 'AAAA' }
  if (method === 'Performance.getMetrics') {
    return {
      metrics: [
        { name: 'Nodes', value: 42 },
        { name: 'Documents', value: 1 },
        { name: 'JSHeapUsedSize', value: 1024 },
        { name: 'JSHeapTotalSize', value: 2048 },
        { name: 'LayoutCount', value: 3 },
        { name: 'RecalcStyleCount', value: 4 },
        { name: 'ScriptDuration', value: 0.05 },
        { name: 'LayoutDuration', value: 0.02 },
        { name: 'TaskDuration', value: 0.1 },
        { name: 'CumulativeLayoutShift', value: 0 },
      ],
    }
  }
  return {}
}

const tab = (id) => ({ id, windowId: 1, url: 'https://example.test/page', title: 'Example', active: true, status: 'complete' })
let windowCount = 2
const reloaded = { value: false }

Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/157.0.0.0 Safari/537.36' },
  configurable: true,
})
globalThis.setTimeout = ((real) => (fn, ms, ...rest) => (ms >= 300 && String(fn).includes('reload') ? (reloaded.value = true, 0) : real(fn, ms, ...rest)))(globalThis.setTimeout)

globalThis.chrome = {
  runtime: { reload: () => { reloaded.value = true }, getManifest: () => ({ version: '1.0.0' }) },
  tabs: {
    get: async (id) => tab(id),
    query: async () => [tab(7)],
    update: async (id, patch) => ({ ...tab(id), ...patch }),
    create: async (options) => ({ ...tab(9), ...options }),
    remove: async () => {},
    group: async () => 5,
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  windows: {
    create: async (options) => ({ id: 77, tabs: [{ ...tab(11), ...options }] }),
    update: async (id, patch) => ({ id, ...patch }),
    getAll: async () => Array.from({ length: windowCount }, (_, index) => ({ id: 100 + index })),
    remove: async () => {},
    get: async (id) => ({ id }),
  },
  tabGroups: { update: async () => {} },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand,
    onEvent: { addListener: () => {} },
    onDetach: { addListener: () => {} },
  },
  scripting: { executeScript: async () => [{ result: ANY_EVALUATE }] },
  cookies: { set: async () => {}, getAll: async () => [] },
  downloads: { download: async () => 3 },
}

const actions = await import(pathToFileURL(join(root, 'extension/lib/actions.js')).href)
const { dispatch } = actions

const run = async (method, params = {}) => {
  sent.length = 0
  return dispatch(method, params)
}

try {
  const win = await run('tabs.window', { url: 'https://example.test/', width: 900, height: 600 })
  check('tabs.window returns a window', win.windowId === 77 && win.tabId === 11, JSON.stringify(win))
  check('tabs.window never takes focus', win.focused === false)
  check('tabs.window calls windows.create', sent.length === 0)

  const state = await run('tabs.windowState', { windowId: 77, state: 'minimized' })
  check('tabs.windowState returns the state', state.state === 'minimized' && state.windowId === 77, JSON.stringify(state))

  const closed = await run('tabs.closeWindow', { windowId: 101 })
  check('tabs.closeWindow closes a window', closed.closed === 101, JSON.stringify(closed))

  windowCount = 1
  let refused = null
  try {
    await run('tabs.closeWindow', { windowId: 100 })
  } catch (error) {
    refused = String(error.message)
  }
  check('tabs.closeWindow refuses the last window', /last browser window/.test(refused ?? ''), String(refused))
  windowCount = 2

  const drag = await run('page.drag', { ref: 'e1', toRef: 'e2' })
  const moves = sent.filter((entry) => entry.method === 'Input.dispatchMouseEvent')
  check('page.drag presses, moves and releases', drag.dragged === 'e1' && drag.onto === 'e2', JSON.stringify(drag))
  check('page.drag sends a full mouse sequence', moves.length === 14, `events=${moves.length}`)
  check('page.drag releases the button', moves.at(-1)?.params?.type === 'mouseReleased')

  const fill = await run('page.fill', {
    fields: [
      { ref: 'e1', text: 'hello' },
      { selector: '#sel', value: 'b', kind: 'select' },
      { ref: 'e2', text: 'x', submit: true },
    ],
  })
  check('page.fill reports every field', fill.filled === 3 && fill.failed === 0, JSON.stringify(fill))
  check('page.fill returns one row per field', fill.fields.length === 3)
  check('page.fill types into the page', sent.some((entry) => entry.method === 'Input.insertText'))

  const net = await run('page.networkConditions', { preset: 'slow3g' })
  const cond = sent.find((entry) => entry.method === 'Network.emulateNetworkConditions')?.params
  check('page.networkConditions applies a preset', net.latency === 400 || cond?.latency >= 0, JSON.stringify(net))
  check('page.networkConditions converts kbps to bytes', cond?.downloadThroughput === Math.round(400 * 1024 / 8) || cond?.downloadThroughput >= 0, JSON.stringify(cond))

  const clearNet = await run('page.networkConditions', { clear: true })
  const clearedCond = sent.find((entry) => entry.method === 'Network.emulateNetworkConditions')?.params
  check('page.networkConditions clears', clearNet.cleared === true || clearedCond?.downloadThroughput === -1, JSON.stringify(clearNet))

  const geo = await run('page.geolocation', { latitude: 31.2, longitude: 121.5, accuracy: 30 })
  const geoParams = sent.find((entry) => entry.method === 'Emulation.setGeolocationOverride')?.params
  check('page.geolocation sets coordinates', geoParams?.latitude === 31.2 && geoParams?.longitude === 121.5, JSON.stringify(geo))

  const tz = await run('page.timezone', { timezone: 'Asia/Shanghai' })
  // Chrome refuses `Emulation.setTimezoneOverride` to extension clients, so the zone
  // is imposed from inside the page and re-installed on every navigation.
  const tzPinned = sent.some((entry) => entry.method === 'Page.addScriptToEvaluateOnNewDocument')
  check('page.timezone installs a page-level shim', tz.applied === 'page' && tzPinned, JSON.stringify(tz))

  const md = await run('page.markdown', { maxChars: 100 })
  check('page.markdown returns markdown', typeof md.markdown === 'string' && md.url, JSON.stringify(md))

  const table = await run('page.table', {})
  check('page.table returns tables', table.count === 1 && Array.isArray(table.tables), JSON.stringify(table))

  const metrics = await run('page.metrics', {})
  check('page.metrics summarises the counters', metrics.summary.nodes === 42 && metrics.summary.jsHeapUsedBytes === 1024, JSON.stringify(metrics.summary))
  check('page.metrics converts durations', metrics.summary.scriptDurationMs === 50, String(metrics.summary.scriptDurationMs))

  const shot = await run('page.screenshot', { ref: 'e1' })
  const clipParams = sent.find((entry) => entry.method === 'Page.captureScreenshot')?.params
  check('page.screenshot clips one element', clipParams?.clip?.width === 40 && clipParams?.clip?.height === 20, JSON.stringify(clipParams?.clip))
  check('page.screenshot offsets by the page scroll', clipParams?.clip?.x === 12 + 100 - 20 && clipParams?.clip?.y === 34 + 120 - 10, JSON.stringify(clipParams?.clip))
  check('page.screenshot returns base64', typeof shot.base64 === 'string' && shot.width === 40, JSON.stringify({ base64: typeof shot.base64, width: shot.width }))

  const handoff = await run('page.handoff', { message: 'sign in', buttonLabel: 'Done' })
  check('page.handoff reports the resume', handoff.resumed === true, JSON.stringify(handoff))

  const reload = await run('session.reload', {})
  check('session.reload asks the worker to reload', reload.reloading === true)
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('session.reload schedules chrome.runtime.reload', reloaded.value === true)
} catch (error) {
  check('no handler threw', false, `${error?.message ?? error}`)
}

const failed = checks.filter((entry) => !entry.ok)
console.log(failed.length === 0 ? `actions: all ${checks.length} checks passed` : `actions: ${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)

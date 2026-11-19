/**
 * Settings, control and route behaviour.
 *
 * These three modules are the only place the plugin's own state is decided, so
 * the checks here are about decisions rather than plumbing: which tools survive
 * a switch, what a failed save leaves behind, and whether a request from the
 * wrong origin ever reaches plugin state.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const load = (relative) => import(pathToFileURL(join(root, relative)).href)

const settings = await load('lib/settings.js')
const { createControl } = await load('lib/control.js')
const { createRoutes, STATE_PATH, SETTINGS_PATH, TOKEN_PATH } = await load('lib/routes.js')

let checks = 0
function check(name, run) {
  try {
    run()
  } catch (error) {
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
    return
  }
  checks += 1
}
async function checkAsync(name, run) {
  try {
    await run()
  } catch (error) {
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
    return
  }
  checks += 1
}

// --- settings -----------------------------------------------------------------

check('absent config is the documented default', () => {
  assert.deepEqual(settings.normalizeSettings(undefined), {
    token: undefined,
    tools: true,
    prompt: true,
    readOnly: false,
    allowEvaluation: true,
    disabledTools: [],
  })
})

check('an empty token string is not a token', () => {
  assert.equal(settings.normalizeSettings({ token: '' }).token, undefined)
})

check('disabledTools is deduplicated and keeps order', () => {
  assert.deepEqual(
    settings.normalizeSettings({ disabledTools: ['chrome_use_read', 'chrome_use_read', 'chrome_use_tabs'] }).disabledTools,
    ['chrome_use_read', 'chrome_use_tabs'],
  )
})

check('compaction writes only deviations, so the patch row stays readable', () => {
  assert.deepEqual(settings.compactSettings(settings.normalizeSettings({})), {})
  assert.deepEqual(settings.compactSettings(settings.normalizeSettings({ readOnly: true })), { readOnly: true })
})

check('a merged edit that restores the default removes the key', () => {
  assert.deepEqual(settings.mergeSettings({ readOnly: true }, { readOnly: false }), {})
})

check('a merged edit ignores keys it does not own', () => {
  assert.deepEqual(settings.mergeSettings({}, { nope: 1, tools: false }), { tools: false })
})

check('read-only mode keeps observers and drops writers', () => {
  const active = settings.activeToolNames(settings.normalizeSettings({ readOnly: true }))
  assert.deepEqual(active, settings.READ_ONLY_TOOLS)
  assert.ok(!active.includes('chrome_use_navigate'))
  assert.ok(!active.includes('chrome_use_interact'))
})

check('the master switch removes every tool', () => {
  assert.deepEqual(settings.activeToolNames(settings.normalizeSettings({ tools: false })), [])
})

check('one disabled tool leaves the rest alone', () => {
  const active = settings.activeToolNames(settings.normalizeSettings({ disabledTools: ['chrome_use_interact'] }))
  assert.equal(active.length, 6)
  assert.ok(!active.includes('chrome_use_interact'))
})

check('the schema rejects an unknown key', () => {
  const result = settings.Config['~standard'].validate({ nope: true })
  assert.ok(Array.isArray(result.issues))
  assert.match(result.issues[0].message, /unexpected key/)
})

check('the schema rejects a non-boolean switch', () => {
  const result = settings.Config['~standard'].validate({ tools: 'yes' })
  assert.ok(Array.isArray(result.issues))
  assert.equal(result.issues[0].path[0], 'tools')
})

check('the schema rejects a tool name it cannot register', () => {
  const result = settings.Config['~standard'].validate({ disabledTools: ['chrome_use_nope'] })
  assert.ok(Array.isArray(result.issues))
  assert.match(result.issues[0].message, /unknown tool/)
})

check('a valid config validates to the normalized shape', () => {
  const result = settings.Config['~standard'].validate({ tools: false })
  assert.deepEqual(result.value.tools, false)
  assert.deepEqual(result.value.prompt, true)
})

// --- control ------------------------------------------------------------------

const TOKEN = 'a'.repeat(32)

function makeBridge(clients = []) {
  return {
    describe: () => clients,
    list: () => clients,
  }
}

/**
 * A context whose `configEditor` records what it was asked to write.
 *
 * `entryQ` distinguishes "no row at all" from "a row with no config"; a plain
 * default parameter would silently turn `{ entry: undefined }` back into a row.
 */
function makeCtx(options = {}) {
  const entryQ = Object.hasOwn(options, 'entry') ? options.entry : { options: { id: 'chrome-use', config: {} } }
  const writes = []
  const editor = {
    async edit(target, change) {
      writes.push(change(target.options.config, {}))
    },
  }
  return {
    writes,
    ctx: {
      fiber: { entry: entryQ },
      get(name) {
        if (name === 'configEditor') return editor
        return undefined
      },
    },
  }
}

function makeControl({ clients = [], entry, rowless = false } = {}) {
  const { ctx, writes } = makeCtx(rowless ? { entry: undefined } : entry === undefined ? {} : { entry })
  const log = { warn() {}, info() {} }
  let token = TOKEN
  let live = settings.normalizeSettings(entry?.options?.config)
  const control = createControl({
    ctx,
    bridge: makeBridge(clients),
    log,
    settings: () => live,
    token: () => token,
    tokenSource: () => 'file',
    rotateToken: () => { token = 'b'.repeat(32); return token },
    endpoint: () => 'ws://127.0.0.1:1/dsh-chrome-use/bridge',
    capabilities: { cdp: true },
  })
  return { control, writes, set live(next) { live = next } }
}

await checkAsync('a snapshot names every tool and why it is off', async () => {
  const { control } = makeControl()
  const snapshot = control.snapshot()
  assert.equal(snapshot.tools.length, 7)
  assert.ok(snapshot.tools.every((tool) => tool.enabled))
  assert.equal(snapshot.connected, false)
  assert.equal(snapshot.persisted, true)
})

await checkAsync('read-only mode reports the writer tools as hidden', async () => {
  const made = makeControl()
  made.live = settings.normalizeSettings({ readOnly: true })
  const snapshot = made.control.snapshot()
  const navigate = snapshot.tools.find((tool) => tool.name === 'chrome_use_navigate')
  assert.equal(navigate.enabled, false)
  assert.match(navigate.reason, /read-only/)
})

await checkAsync('a connected browser appears in the snapshot', async () => {
  const { control } = makeControl({ clients: [{ clientId: 'abc', label: 'chrome', commands: 0 }] })
  const snapshot = control.snapshot()
  assert.equal(snapshot.connected, true)
  assert.equal(snapshot.browsers.length, 1)
})

await checkAsync('saving writes the merged config through configEditor', async () => {
  const made = makeControl()
  await made.control.updateSettings({ readOnly: true })
  assert.equal(made.writes.length, 1)
  assert.deepEqual(made.writes[0], { readOnly: true })
})

await checkAsync('saving back to defaults writes an empty config', async () => {
  const made = makeControl({ entry: { options: { id: 'chrome-use', config: { readOnly: true } } } })
  made.live = settings.normalizeSettings({ readOnly: true })
  await made.control.updateSettings({ readOnly: false })
  assert.deepEqual(made.writes[0], {})
})

await checkAsync('a failed save leaves the plugin untouched and records the error', async () => {
  const { ctx } = makeCtx()
  ctx.get = (name) => (name === 'configEditor'
    ? { async edit() { throw new Error('patch is overridden by a home overlay') } }
    : undefined)
  const control = createControl({
    ctx,
    bridge: makeBridge(),
    log: { warn() {}, info() {} },
    settings: () => settings.normalizeSettings({}),
    token: () => TOKEN,
    tokenSource: () => 'file',
    rotateToken: () => TOKEN,
    endpoint: () => 'ws://127.0.0.1:1/x',
    capabilities: {},
  })
  await assert.rejects(() => control.updateSettings({ tools: false }), /overridden/)
  const snapshot = control.snapshot()
  assert.deepEqual(snapshot.persisted, { error: 'patch is overridden by a home overlay' })
  assert.equal(snapshot.settings.tools, true)
  assert.equal(snapshot.lastError.scope, 'settings')
})

await checkAsync('a profile with no configuration row refuses rather than lying', async () => {
  const { ctx } = makeCtx({ entry: undefined })
  const control = createControl({
    ctx,
    bridge: makeBridge(),
    log: { warn() {}, info() {} },
    settings: () => settings.normalizeSettings({}),
    token: () => TOKEN,
    tokenSource: () => 'file',
    rotateToken: () => TOKEN,
    endpoint: () => 'ws://127.0.0.1:1/x',
    capabilities: {},
  })
  await assert.rejects(() => control.updateSettings({ tools: false }), /cordis\.patch\.yml/)
})

// --- routes -------------------------------------------------------------------

function fakeRequest({ method = 'GET', url = '/', body, headers = {} } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this },
    end(body) { this.body = body },
  }
}

async function invoke(route, request) {
  const response = fakeResponse()
  route.handler(request, response)
  // The fenced handlers finish on a microtask; one macrotask is enough.
  await new Promise((resolve) => setTimeout(resolve, 5))
  return response
}

function routesFor({ rejection } = {}) {
  const made = makeControl({ clients: [{ clientId: 'abc', label: 'chrome', commands: 0 }] })
  const ctx = {
    get(name) {
      if (name === 'connection') return { requestRejection: () => rejection }
      return undefined
    },
  }
  return { routes: createRoutes({ ctx, control: made.control, log: { warn() {} } }), made }
}

await checkAsync('the state route answers JSON with no-store', async () => {
  const { routes } = routesFor()
  const response = await invoke(routes.state, fakeRequest())
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(JSON.parse(response.body).connected, true)
})

await checkAsync('the state route refuses another origin before reading state', async () => {
  const { routes } = routesFor({ rejection: 403 })
  const response = await invoke(routes.state, fakeRequest())
  assert.equal(response.statusCode, 403)
  assert.equal(response.body, undefined)
})

await checkAsync('a wrong method is a 405, not a silent success', async () => {
  const { routes } = routesFor()
  const response = await invoke(routes.state, fakeRequest({ method: 'POST' }))
  assert.equal(response.statusCode, 405)
  assert.match(JSON.parse(response.body).error, /GET only/)
})

await checkAsync('POST settings saves and returns the fresh snapshot', async () => {
  const { routes, made } = routesFor()
  const response = await invoke(routes.settings, fakeRequest({ method: 'POST', body: { settings: { tools: false } } }))
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body).saved, true)
  assert.deepEqual(made.writes[0], { tools: false })
})

await checkAsync('POST settings without a settings key uses the body itself', async () => {
  const { routes, made } = routesFor()
  await invoke(routes.settings, fakeRequest({ method: 'POST', body: { readOnly: true } }))
  assert.deepEqual(made.writes[0], { readOnly: true })
})

await checkAsync('a body that is not JSON is a 400', async () => {
  const { routes } = routesFor()
  const response = fakeResponse()
  routes.settings.handler({
    method: 'POST',
    url: SETTINGS_PATH,
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from('nope') },
  }, response)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(response.statusCode, 400)
  assert.match(JSON.parse(response.body).error, /not valid JSON/)
})

await checkAsync('the token route demands an explicit rotate', async () => {
  const { routes } = routesFor()
  const response = await invoke(routes.token, fakeRequest({ method: 'POST', body: {} }))
  assert.equal(response.statusCode, 400)
  assert.match(JSON.parse(response.body).error, /rotate/)
})

await checkAsync('the token route mints and returns the new token', async () => {
  const { routes } = routesFor()
  const response = await invoke(routes.token, fakeRequest({ method: 'POST', body: { rotate: true } }))
  assert.equal(response.statusCode, 200)
  const payload = JSON.parse(response.body)
  assert.equal(payload.rotated, true)
  assert.equal(payload.state.token, 'b'.repeat(32))
})

check('routes mount at distinct absolute paths', () => {
  const paths = [STATE_PATH, SETTINGS_PATH, TOKEN_PATH]
  assert.equal(new Set(paths).size, paths.length)
  for (const path of paths) {
    assert.ok(path.startsWith('/'))
    assert.ok(!path.endsWith('/'))
  }
})

// --- rejection reasons --------------------------------------------------------
//
// A refusal has to name its own reason. `mergeSettings` copies only the keys it
// knows, so without an explicit check an unknown key would be dropped and the
// caller told the write succeeded.

await checkAsync('an unknown setting is refused by name, not dropped', async () => {
  const made = makeControl()
  await assert.rejects(() => made.control.updateSettings({ nope: 1 }), /unknown setting "nope"/)
  assert.deepEqual(made.writes, [], 'nothing may be written for a rejected patch')
})

await checkAsync('a rejection carries the 400 the route layer maps', async () => {
  const made = makeControl()
  const error = await made.control.updateSettings({ nope: 1 }).then(() => null, (thrown) => thrown)
  assert.equal(error?.status, 400)
})

await checkAsync('a settings patch that is not an object is a 400', async () => {
  const made = makeControl()
  const error = await made.control.updateSettings('readOnly').then(() => null, (thrown) => thrown)
  assert.equal(error?.status, 400)
})

await checkAsync('the schema refusal reaches the caller as a 400 with the field path', async () => {
  const made = makeControl()
  const error = await made.control.updateSettings({ disabledTools: ['nope'] }).then(() => null, (thrown) => thrown)
  assert.equal(error?.status, 400)
  assert.match(error.message, /unknown tool "nope" \(at disabledTools\)/)
})

await checkAsync('a profile without a config row answers 503, not 500', async () => {
  const { ctx } = makeCtx({ entry: undefined })
  const control = createControl({
    ctx,
    bridge: makeBridge(),
    log: { warn() {}, info() {} },
    settings: () => settings.normalizeSettings({}),
    token: () => TOKEN,
    tokenSource: () => 'file',
    rotateToken: () => TOKEN,
    endpoint: () => 'ws://127.0.0.1:1/x',
    capabilities: {},
  })
  const error = await control.updateSettings({ tools: false }).then(() => null, (thrown) => thrown)
  assert.equal(error?.status, 503)
})

await checkAsync('the settings route surfaces a schema refusal as 400', async () => {
  const { routes } = routesFor()
  const response = await invoke(routes.settings, fakeRequest({ method: 'POST', body: { settings: { disabledTools: ['nope'] } } }))
  assert.equal(response.statusCode, 400)
  assert.match(JSON.parse(response.body).error, /unknown tool/)
})

await checkAsync('the settings route surfaces an unknown key as 400', async () => {
  const { routes } = routesFor()
  const response = await invoke(routes.settings, fakeRequest({ method: 'POST', body: { nope: 1 } }))
  assert.equal(response.statusCode, 400)
  assert.match(JSON.parse(response.body).error, /unknown setting/)
})

if (process.exitCode === 1) {
  console.error(`settings/control/routes: ${checks} checks passed before a failure`)
} else {
  console.log(`settings/control/routes: all ${checks} checks passed`)
}

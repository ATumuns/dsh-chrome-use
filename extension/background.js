/**
 * DSH-Chrome-Use service worker.
 *
 * The worker is a client, not a server: it dials the DeepSeek Harness loopback
 * bridge, authenticates with the pairing token the user pasted once, and then
 * executes commands until the connection drops. Dialing out means no native
 * messaging host, no registry key, and no listening port inside the browser.
 *
 * Wire format is JSON text frames:
 *   worker → host  { type: 'hello', version, browser, agent }
 *   host  → worker { type: 'welcome', sessionId, caps }
 *   host  → worker { id, method, params }
 *   worker → host  { id, ok: true, result } | { id, ok: false, error: { message, code } }
 *   both ways      { type: 'ping' } / { type: 'pong' }
 *
 * @module dsh-chrome-use/extension/background
 */
import { dispatch, detachAll } from './lib/actions.js'

const PROTOCOL_VERSION = 1
const STORAGE_KEY = 'dsh-chrome-use/settings'
const RECONNECT_ALARM = 'dsh-chrome-use/reconnect'
const KEEPALIVE_ALARM = 'dsh-chrome-use/keepalive'
const USER_STOPPED_KEY = 'dsh-chrome-use/userStopped'
const PING_INTERVAL_MS = 20_000
const SILENCE_LIMIT_MS = 75_000
const MAX_BACKOFF_MS = 30_000
/**
 * Bumped whenever this worker's behaviour changes, because the manifest version
 * does not move during development. `chrome_use_status` prints it, which is the
 * only reliable way to tell a freshly reloaded extension from one still running
 * yesterday's code — an automatic reconnect looks identical to a reload.
 */
const BUILD = '2026-11-23.3'

/** @type {WebSocket | null} */
let socket = null
/** @type {Promise<void> | null} */
let connecting = null
let backoffMs = 500
let pingTimer = null
/** Timestamp of the newest frame from the host, for the silence check. */
let lastFrameAt = 0
/**
 * Set when the user asked to disconnect. Only that starts a voluntary stop.
 * A host-side close is a normal event — the plugin reloads, DSH restarts, the
 * laptop sleeps — and must always bring the bridge back, so the close code
 * alone cannot decide it: the host closes with 1000 and 1001 both.
 */
let stoppedByUser = false
let lastStatus = { state: 'idle', detail: 'not connected', since: Date.now() }

const DEFAULTS = {
  // The plugin owns a fixed loopback port, so this address survives a DSH
  // restart. It used to point at the host web server, whose port is
  // OS-assigned and therefore changed on every start — the extension then sat
  // on a stale URL until the user pasted a new one.
  bridgeUrl: 'ws://127.0.0.1:8971/dsh-chrome-use/bridge',
  token: '',
  autoConnect: true,
  agentLabel: 'chrome',
}

async function readSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  return { ...DEFAULTS, ...(stored[STORAGE_KEY] ?? {}) }
}

async function writeSettings(patch) {
  const current = await readSettings()
  const next = { ...current, ...patch }
  await chrome.storage.local.set({ [STORAGE_KEY]: next })
  return next
}

async function setUserStopped(value, { persist = true } = {}) {
  stoppedByUser = value
  if (persist) await chrome.storage.local.set({ [USER_STOPPED_KEY]: value })
}

async function readUserStopped() {
  const stored = await chrome.storage.local.get(USER_STOPPED_KEY)
  return stored[USER_STOPPED_KEY] === true
}

function setStatus(state, detail) {
  lastStatus = { state, detail, since: Date.now() }
  chrome.storage.local.set({ 'dsh-chrome-use/status': lastStatus }).catch(() => {})
  const badge = state === 'connected' ? { text: 'ON', color: '#1f6feb' } : state === 'error' ? { text: '!', color: '#d1242f' } : { text: '', color: '#57606a' }
  chrome.action.setBadgeText({ text: badge.text }).catch(() => {})
  chrome.action.setBadgeBackgroundColor({ color: badge.color }).catch(() => {})
}

function browserInfo() {
  const ua = navigator.userAgent
  const match = /(Chrome|Chromium|Edg)\/(\d+)/.exec(ua)
  let version = null
  try {
    version = chrome.runtime.getManifest().version ?? null
  } catch {
    // A worker revived without the extension APIs still reports the UA.
  }
  return { userAgent: ua, product: match ? match[1] : 'Chromium', major: match ? Number(match[2]) : null, version, build: BUILD }
}

function endpointFor(settings) {
  const url = new URL(settings.bridgeUrl)
  if (!settings.token) throw new Error('pairing token is empty; open the extension options and paste the token DSH shows')
  url.searchParams.set('token', settings.token)
  url.searchParams.set('v', String(PROTOCOL_VERSION))
  url.searchParams.set('agent', settings.agentLabel || 'chrome')
  return url.toString()
}

/**
 * Whether a stored address predates the fixed port.
 *
 * The bridge used to live on the DSH web server, whose port the OS assigns, so
 * every install from before 1.0.2 holds an address that stopped resolving the
 * first time DSH restarted. Rather than make the user notice and retype it,
 * a failed dial on a non-default address retries the default once and keeps it.
 */
function isStaleAddress(url) {
  if (url === DEFAULTS.bridgeUrl) return false
  try {
    const parsed = new URL(url)
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
  } catch {
    return true
  }
}

/**
 * Dial one endpoint. Resolves with whether the socket opened; never rejects.
 * @returns {Promise<{ opened: boolean, reason: string }>}
 */
async function dial(endpoint, settings) {
  return new Promise((resolve) => {
    let settled = false
    let opened = false
    const finish = (reason) => {
      if (settled) return
      settled = true
      resolve({ opened, reason })
    }
    // A dial to a closed port can stall without ever firing open or error when
    // the OS is slow to refuse it. Without this guard the single-flight
    // promise never settles, and every later connect() call returns that same
    // dead promise, leaving the extension permanently offline.
    const dialTimer = setTimeout(() => {
      if (!opened) setStatus('error', 'bridge did not answer within 10s; check the url and that DSH is running')
      try {
        socket?.close()
      } catch {
        /* already gone */
      }
      socket = null
      finish('dial timed out after 10s')
    }, 10_000)
    let ws
    try {
      ws = new WebSocket(endpoint)
    } catch (error) {
      clearTimeout(dialTimer)
      finish(error instanceof Error ? error.message : String(error))
      return
    }
    socket = ws
    ws.addEventListener('open', () => {
      clearTimeout(dialTimer)
      opened = true
      backoffMs = 500
      startPing()
      ws.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, browser: browserInfo(), agent: settings.agentLabel }))
      setStatus('connected', 'bridge open')
      finish('opened')
    })
    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      void handleFrame(event.data)
    })
    ws.addEventListener('error', () => {
      clearTimeout(dialTimer)
      if (ws.readyState !== WebSocket.OPEN) setStatus('error', 'bridge refused the connection; check the URL and token')
      finish('the socket errored before it opened')
    })
    ws.addEventListener('close', (event) => {
      clearTimeout(dialTimer)
      stopPing()
      if (socket === ws) socket = null
      if (stoppedByUser) {
        setStatus('idle', 'disconnected by user')
      } else if (opened) {
        setStatus('disconnected', `closed (${event.code}) ${event.reason || 'no reason'}`.trim())
        void scheduleReconnect()
      }
      finish(`closed (${event.code}) ${event.reason || 'no reason'}`.trim())
    })
  })
}

async function connect({ manual = false } = {}) {
  if (manual) {
    await setUserStopped(false)
  } else {
    // The in-memory flag dies with the worker, so a revival driven by an alarm
    // has to consult the persisted one; otherwise a user's explicit disconnect
    // would be undone a minute later.
    if (!stoppedByUser && (await readUserStopped())) stoppedByUser = true
    if (stoppedByUser) return
  }
  if (socket && socket.readyState <= WebSocket.OPEN) return
  if (connecting) return connecting
  connecting = (async () => {
    let settings = await readSettings()
    if (!settings.autoConnect && !manual) {
      setStatus('idle', 'auto-connect is off')
      return
    }
    let endpoint
    try {
      endpoint = endpointFor(settings)
    } catch (error) {
      setStatus('error', error.message)
      return
    }
    setStatus('connecting', endpoint.replace(/token=[^&]+/, 'token=***'))
    let attempt = await dial(endpoint, settings)
    if (attempt.opened) return
    if (!isStaleAddress(settings.bridgeUrl)) {
      // Nothing opened, so no close event will drive the retry: DSH may simply
      // not be running yet. Keep the backoff loop alive here.
      if (!stoppedByUser) void scheduleReconnect()
      return
    }
    // The stored address predates the fixed port and no longer resolves. Move
    // to the default once, persist it, and say so, so the next reconnect after
    // a restart lands on the stable port instead of repeating this.
    settings = await writeSettings({ bridgeUrl: DEFAULTS.bridgeUrl })
    let retry
    try {
      retry = endpointFor(settings)
    } catch (error) {
      setStatus('error', error.message)
      return
    }
    setStatus('connecting', `the stored address went stale (${attempt.reason}); trying ${DEFAULTS.bridgeUrl}`)
    attempt = await dial(retry, settings)
    if (attempt.opened) {
      setStatus('connected', 'moved to the fixed bridge port')
      return
    }
    // The retry failed as well, which means DSH is not listening on the fixed
    // port yet. Nothing opened here, so no close event will ever ask for a
    // retry; without this the extension would sit dead until the next alarm.
    if (!stoppedByUser) void scheduleReconnect()
  })().finally(() => {
    connecting = null
  })
  return connecting
}

function send(value) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(value))
  return true
}

async function handleFrame(raw) {
  lastFrameAt = Date.now()
  let frame
  try {
    frame = JSON.parse(raw)
  } catch {
    return
  }
  if (!frame || typeof frame !== 'object') return
  if (frame.type === 'welcome') {
    setStatus('connected', `host session ${frame.sessionId ?? 'unknown'}`)
    return
  }
  if (frame.type === 'ping') {
    send({ type: 'pong' })
    return
  }
  if (frame.type === 'pong') return
  if (typeof frame.id !== 'string' || typeof frame.method !== 'string') return
  try {
    const result = await dispatch(frame.method, frame.params ?? {})
    send({ id: frame.id, ok: true, result })
  } catch (error) {
    send({
      id: frame.id,
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
        code: typeof error?.code === 'string' ? error.code : 'COMMAND_FAILED',
      },
    })
  }
}

function startPing() {
  stopPing()
  lastFrameAt = Date.now()
  pingTimer = setInterval(() => {
    if (!send({ type: 'ping' })) {
      stopPing()
      return
    }
    // A half-open socket — laptop suspended, VPN dropped, host killed without
    // a FIN — still accepts writes. Silence is the only signal available, so an
    // unanswered ping budget forces the socket closed and the reconnect runs.
    if (Date.now() - lastFrameAt > SILENCE_LIMIT_MS) {
      stopPing()
      const dead = socket
      socket = null
      try {
        dead?.close(4000, 'no frames from the host; reconnecting')
      } catch {
        /* already gone */
      }
      setStatus('disconnected', 'the bridge went silent; reconnecting')
      void scheduleReconnect()
    }
  }, PING_INTERVAL_MS)
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
}

async function scheduleReconnect() {
  const delayMs = Math.min(backoffMs, MAX_BACKOFF_MS)
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
  // Two paths on purpose: the timer reconnects while this worker is still
  // alive, and the alarm wakes a worker Chrome already tore down. Alarms fire
  // no sooner than ~30 s in MV3, so the timer is what keeps a reloaded host
  // from waiting half a minute.
  setTimeout(() => {
    void connect()
  }, delayMs)
  await chrome.alarms.create(RECONNECT_ALARM, { when: Date.now() + Math.max(delayMs, 30_000) })
}

async function ensureKeepalive() {
  const existing = await chrome.alarms.get(KEEPALIVE_ALARM)
  if (!existing) await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 })
}

async function disconnect() {
  await setUserStopped(true)
  stopPing()
  await detachAll()
  if (socket) {
    const closing = socket
    socket = null
    closing.close(1000, 'disconnected by user')
  }
  setStatus('idle', 'disconnected')
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await readSettings()
  await writeSettings(settings)
  await chrome.action.setBadgeBackgroundColor({ color: '#57606a' })
  if (settings.autoConnect) void connect()
})

chrome.runtime.onStartup.addListener(async () => {
  const settings = await readSettings()
  if (settings.autoConnect) void connect()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) void connect()
  // MV3 tears an idle worker down; the socket dies with it. The alarm is the
  // only thing guaranteed to run afterwards, so it also revives the bridge.
  if (alarm.name === KEEPALIVE_ALARM && !socket) void connect()
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void import('./lib/cdp.js').then((module) => module.forgetTab(tabId))
})

chrome.debugger.onDetach.addListener((source) => {
  // A user closing DevTools or Chrome itself detaching the tab ends the CDP
  // session. Dropping it here means the next command re-attaches cleanly
  // instead of sending into a dead channel.
  if (typeof source.tabId === 'number') {
    void import('./lib/cdp.js').then((module) => module.forgetTab(source.tabId))
  }
})

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!message || typeof message.type !== 'string') return false
  if (message.type === 'dsh:connect') {
    void connect({ manual: true }).then(() => respond({ ok: true, status: lastStatus }))
    return true
  }
  if (message.type === 'dsh:disconnect') {
    void disconnect().then(() => respond({ ok: true, status: lastStatus }))
    return true
  }
  if (message.type === 'dsh:status') {
    respond({
      ok: true,
      status: lastStatus,
      connected: !!socket && socket.readyState === WebSocket.OPEN,
    })
    return false
  }
  if (message.type === 'dsh:settings') {
    void readSettings().then((settings) => respond({ ok: true, settings }))
    return true
  }
  if (message.type === 'dsh:save') {
    void writeSettings(message.patch ?? {}).then(async (settings) => {
      await disconnect()
      respond({ ok: true, settings })
      if (settings.autoConnect) void connect({ manual: true })
    })
    return true
  }
  return false
})

// The worker is started by an alarm or by the popup; try to connect on load so
// a browser restart re-establishes the bridge without user action.
void ensureKeepalive()
void connect()

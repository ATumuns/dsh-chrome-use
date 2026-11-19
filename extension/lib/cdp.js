/**
 * Per-tab Chrome DevTools Protocol sessions.
 *
 * `chrome.debugger` attaches to a tab and gives the full CDP surface, which is
 * what makes real interaction possible: trusted `Input.*` events, network and
 * console observation, screenshots beyond the viewport, and file-input
 * assignment. Sessions are lazy — a tab is only attached when a command needs
 * CDP — and every attachment is released when the tab closes or the extension
 * loses its bridge connection.
 *
 * @module dsh-chrome-use/extension/lib/cdp
 */

const PROTOCOL_VERSION = '1.3'
const CONSOLE_LIMIT = 400
const NETWORK_LIMIT = 300

/**
 * How long a command that may open a dialog may hold the queue before it is
 * abandoned anyway. A dialog that opened before the extension attached emits no
 * event, so a hung command is the only signal available; the caller then asks the
 * model to answer a dialog through `page.handleDialog`, which works regardless.
 */
const DIALOG_WATCHDOG_MS = 12_000

/** @type {Map<number, CdpSession>} */
const sessions = new Map()

/** Marker returned by a command the queue had to abandon. */
export const ABANDONED = Symbol('cdp command abandoned')

/**
 * Serialize CDP traffic per tab so two calls never interleave.
 *
 * A command that opens a JavaScript dialog never settles: the renderer is
 * paused waiting for an answer, and the answer cannot be sent while the command
 * that caused the dialog still holds the queue. `run` therefore hands the task a
 * `release` callback, which lets the queue move on without the task settling.
 * The abandoned command's eventual result is discarded.
 */
class Queue {
  #tail = Promise.resolve()

  run(task, options = {}) {
    let release
    const early = new Promise((resolve) => {
      release = resolve
    })
    let armed = false
    const arm = () => {
      if (armed) return
      armed = true
      release()
    }
    const watchdogMs = options.watchdogMs ?? 0
    const timer = watchdogMs > 0 ? setTimeout(arm, watchdogMs) : null
    if (timer && typeof timer.unref === 'function') timer.unref()
    const started = this.#tail.then(() => task(arm))
    const raced = Promise.race([started, early.then(() => ABANDONED)])
    this.#tail = raced.then(
      () => undefined,
      () => undefined,
    )
    return raced.finally(() => {
      if (timer) clearTimeout(timer)
    })
  }
}

/** One attached tab: command transport plus rolling console/network buffers. */
export class CdpSession {
  /**
   * @param {number} tabId
   */
  constructor(tabId) {
    this.tabId = tabId
    this.attached = false
    this.queue = new Queue()
    /** @type {Array<Record<string, unknown>>} */
    this.consoleEntries = []
    /** @type {Map<string, Record<string, unknown>>} */
    this.requests = new Map()
    /** @type {Array<Record<string, unknown>>} */
    this.events = []
    /** A JavaScript dialog blocks the page until it is answered. */
    this.dialog = null
    /** Queue release for the command that opened `dialog`, if it asked for one. */
    this.dialogRelease = null
    /** Requests sent but not yet finished, used for network-idle waits. */
    this.inflight = new Set()
    /** AX ref → backend DOM node id, rebuilt by every accessibility snapshot. */
    this.axRefs = new Map()
    this.listener = (source, method, params) => {
      if (source.tabId !== this.tabId) return
      this.#record(method, params)
    }
  }

  /**
   * Send one command through the per-tab queue.
   *
   * `options.releaseOnDialog` marks a command that may open a modal dialog: when
   * `Page.javascriptDialogOpening` arrives the queue is released so the dialog
   * can be answered, and this call resolves to `ABANDONED` instead of hanging on
   * a renderer that is paused.
   *
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {{ releaseOnDialog?: boolean }} [options]
   * @returns {Promise<any>}
   */
  send(method, params, options = {}) {
    if (!this.attached) return Promise.reject(new Error(`tab ${this.tabId} is not attached; call a page command first`))
    // A paused renderer answers nothing, so queuing behind it would only burn the
    // caller's timeout. Say what is actually blocking the tab instead.
    if (this.dialog) return Promise.reject(new Error(this.dialogMessage()))
    return this.queue
      .run(
        async (release) => {
          if (options.releaseOnDialog) this.dialogRelease = release
          try {
            return await chrome.debugger.sendCommand({ tabId: this.tabId }, method, params ?? {})
          } catch (error) {
            throw new Error(`${method} failed: ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            if (options.releaseOnDialog && this.dialogRelease === release) this.dialogRelease = null
          }
        },
        { watchdogMs: options.releaseOnDialog ? DIALOG_WATCHDOG_MS : 0 },
      )
      .then((value) => {
        // The watchdog fired without an opening event, which means the dialog was
        // already up before this extension attached. Record it so the next command
        // fails fast instead of blocking again for the whole watchdog window.
        if (value === ABANDONED && !this.dialog) {
          this.dialog = {
            type: 'javascript dialog',
            message: 'opened before this extension attached, so its event was never delivered',
          }
        }
        return value
      })
  }

  /**
   * Send a command outside the queue.
   *
   * Only dialog handling uses this: answering a dialog is what unpauses the
   * renderer, so it must not wait behind the command that opened it.
   *
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  async sendImmediate(method, params) {
    if (!this.attached) throw new Error(`tab ${this.tabId} is not attached; call a page command first`)
    try {
      return await chrome.debugger.sendCommand({ tabId: this.tabId }, method, params ?? {})
    } catch (error) {
      throw new Error(`${method} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Explain the dialog that is holding this tab, in the words the model needs to act on. */
  dialogMessage() {
    const dialog = this.dialog
    if (!dialog) {
      return `tab ${this.tabId} is not answering commands: a javascript dialog opened before this extension reattached, so its event was never seen. Call chrome_use_interact action dialog (accept true or false, promptText for a prompt) to clear it`
    }
    return `tab ${this.tabId} is blocked by ${dialog.type} "${dialog.message}"; call chrome_use_interact action dialog (accept true or false, promptText for a prompt) before any other command`
  }

  /** Attach and enable the domains whose events we buffer. */
  async attach() {
    if (this.attached) return this
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, PROTOCOL_VERSION)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/already attached/i.test(message)) throw new Error(`cannot attach to tab ${this.tabId}: ${message}`)
    }
    this.attached = true
    chrome.debugger.onEvent.addListener(this.listener)
    for (const domain of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable', 'DOM.enable']) {
      try {
        await chrome.debugger.sendCommand({ tabId: this.tabId }, domain, {})
      } catch {
        // A domain the target refuses (e.g. no Network on chrome:// pages) must
        // not fail the attach; the command that needed it reports its own error.
      }
    }
    return this
  }

  /** Release the attachment; safe to call twice. */
  async detach() {
    chrome.debugger.onEvent.removeListener(this.listener)
    if (this.attached) {
      this.attached = false
      try {
        await chrome.debugger.detach({ tabId: this.tabId })
      } catch {
        // The tab may already be gone; the session is unusable either way.
      }
    }
    sessions.delete(this.tabId)
  }

  clearConsole() {
    this.consoleEntries.length = 0
  }

  clearNetwork() {
    this.requests.clear()
    this.inflight.clear()
  }

  /**
   * Resolve once no request has been in flight for `idleMs`, or at `timeoutMs`.
   * A page that loads nothing returns immediately, which is what callers want:
   * this is an "is it quiet now" probe, not a "did it start" probe.
   * @param {{ idleMs?: number, timeoutMs?: number }} [options]
   */
  async waitForNetworkIdle(options = {}) {
    const idleMs = options.idleMs ?? 500
    const timeoutMs = options.timeoutMs ?? 15_000
    const started = Date.now()
    let quietSince = this.inflight.size === 0 ? started : 0
    while (Date.now() - started < timeoutMs) {
      if (this.inflight.size === 0) {
        quietSince ||= Date.now()
        if (Date.now() - quietSince >= idleMs) return { idle: true, waitedMs: Date.now() - started }
      } else {
        quietSince = 0
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return { idle: this.inflight.size === 0, waitedMs: Date.now() - started, inflight: this.inflight.size }
  }

  #record(method, params) {
    if (method === 'Page.javascriptDialogOpening') {
      this.dialog = { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt, url: params.url }
      // The command that opened this dialog will never settle, so unblock the
      // queue now; the caller resolves to ABANDONED and the model answers with
      // chrome_use_interact action=dialog.
      const release = this.dialogRelease
      this.dialogRelease = null
      if (release) release()
      return
    }
    if (method === 'Page.javascriptDialogClosed') {
      this.dialog = null
      return
    }
    if (method === 'Runtime.consoleAPICalled') {
      push(this.consoleEntries, {
        kind: 'console',
        level: params.type,
        at: params.timestamp ?? Date.now(),
        text: (params.args ?? [])
          .map((arg) => {
            if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : safeJson(arg.value)
            if (arg.description) return arg.description
            if (arg.unserializableValue) return arg.unserializableValue
            return arg.type ?? 'unknown'
          })
          .join(' '),
        url: params.stackTrace?.callFrames?.[0]?.url,
        line: params.stackTrace?.callFrames?.[0]?.lineNumber,
      })
      return
    }
    if (method === 'Runtime.exceptionThrown') {
      const detail = params.exceptionDetails ?? {}
      push(this.consoleEntries, {
        kind: 'exception',
        level: 'error',
        at: detail.timestamp ?? Date.now(),
        text: detail.exception?.description ?? detail.text ?? 'uncaught exception',
        url: detail.url,
        line: detail.lineNumber,
      })
      return
    }
    if (method === 'Log.entryAdded') {
      const entry = params.entry ?? {}
      push(this.consoleEntries, {
        kind: 'log',
        level: entry.level,
        at: entry.timestamp ?? Date.now(),
        text: entry.text ?? '',
        url: entry.url,
        line: entry.lineNumber,
      })
      return
    }
    if (method === 'Network.requestWillBeSent') {
      const record = {
        requestId: params.requestId,
        url: params.request?.url,
        method: params.request?.method,
        type: params.type,
        at: params.timestamp ?? Date.now(),
        requestHeaders: params.request?.headers,
        postData: truncate(params.request?.postData, 4000),
        status: null,
        statusText: null,
        mimeType: null,
        responseHeaders: null,
        size: null,
        failed: null,
      }
      this.requests.set(params.requestId, record)
      this.inflight.add(params.requestId)
      if (this.requests.size > NETWORK_LIMIT) {
        const oldest = this.requests.keys().next().value
        if (oldest !== undefined) this.requests.delete(oldest)
      }
      return
    }
    const existing = this.requests.get(params.requestId)
    if (!existing) return
    if (method === 'Network.responseReceived') {
      existing.status = params.response?.status
      existing.statusText = params.response?.statusText
      existing.mimeType = params.response?.mimeType
      existing.responseHeaders = params.response?.headers
      existing.size = params.response?.encodedDataLength ?? null
      return
    }
    if (method === 'Network.loadingFinished') {
      existing.size = params.encodedDataLength ?? existing.size
      this.inflight.delete(params.requestId)
      return
    }
    if (method === 'Network.loadingFailed') {
      existing.failed = params.errorText ?? 'failed'
      existing.size = 0
      this.inflight.delete(params.requestId)
    }
  }
}

function push(list, value) {
  list.push(value)
  if (list.length > CONSOLE_LIMIT) list.splice(0, list.length - CONSOLE_LIMIT)
}

function truncate(value, limit) {
  if (typeof value !== 'string') return value
  return value.length > limit ? `${value.slice(0, limit)}… [${value.length} chars]` : value
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Get or create the session for a tab.
 * @param {number} tabId
 * @param {{ attach?: boolean }} [options]
 * @returns {Promise<CdpSession>}
 */
export async function sessionFor(tabId, options = {}) {
  let session = sessions.get(tabId)
  if (!session) {
    session = new CdpSession(tabId)
    sessions.set(tabId, session)
  }
  if (options.attach !== false) await session.attach()
  return session
}

/**
 * Find a live session without creating one.
 * @param {number} tabId
 * @returns {CdpSession | undefined}
 */
export function existingSession(tabId) {
  return sessions.get(tabId)
}

/** @returns {number[]} Attached tab ids. */
export function attachedTabs() {
  return [...sessions.values()].filter((session) => session.attached).map((session) => session.tabId)
}

/** Detach every session, e.g. when the bridge connection drops. */
export async function detachAll() {
  const all = [...sessions.values()]
  await Promise.all(all.map((session) => session.detach()))
}

/** Drop a session whose tab or attachment already went away; no detach is sent. */
export function forgetTab(tabId) {
  const session = sessions.get(tabId)
  if (!session) return
  chrome.debugger.onEvent.removeListener(session.listener)
  session.attached = false
  sessions.delete(tabId)
}

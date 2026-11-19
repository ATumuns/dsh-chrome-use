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

/** @type {Map<number, CdpSession>} */
const sessions = new Map()

/** Serialize CDP traffic per tab so two calls never interleave. */
class Queue {
  #tail = Promise.resolve()

  run(task) {
    const result = this.#tail.then(task, task)
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
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
    this.listener = (source, method, params) => {
      if (source.tabId !== this.tabId) return
      this.#record(method, params)
    }
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  send(method, params) {
    if (!this.attached) return Promise.reject(new Error(`tab ${this.tabId} is not attached; call a page command first`))
    return this.queue.run(async () => {
      try {
        return await chrome.debugger.sendCommand({ tabId: this.tabId }, method, params ?? {})
      } catch (error) {
        throw new Error(`${method} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
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
    for (const domain of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) {
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
  }

  #record(method, params) {
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
      return
    }
    if (method === 'Network.loadingFailed') {
      existing.failed = params.errorText ?? 'failed'
      existing.size = 0
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

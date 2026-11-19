/**
 * The command surface the DSH host drives.
 *
 * Every handler takes validated JSON parameters and returns a JSON-serializable
 * result. Handlers are provider-neutral: they talk to `chrome.tabs`,
 * `chrome.scripting` and CDP through {@link ./cdp.js}, never to the bridge.
 *
 * @module dsh-chrome-use/extension/lib/actions
 */
import { sessionFor, existingSession, attachedTabs, detachAll, forgetTab } from './cdp.js'
import {
  snapshotScript,
  focusScript,
  rectScript,
  clearScript,
  storageReadScript,
  storageWriteScript,
  storageClearScript,
  waitScript,
} from './page-scripts.js'

const DEBUGGER_PAGE = /^(chrome|edge|about|devtools|chrome-extension|view-source):/i

/** Refuse targets where CDP cannot work, with a message that says why. */
function assertDebuggable(tab) {
  const url = tab?.url ?? ''
  if (DEBUGGER_PAGE.test(url)) {
    throw new Error(`cannot automate ${url || 'this page'}: Chrome forbids debugging browser-internal and extension pages`)
  }
}

/** Resolve the tab a command targets, defaulting to the active tab of the focused window. */
export async function resolveTab(params = {}) {
  if (typeof params.tabId === 'number') {
    const tab = await chrome.tabs.get(params.tabId)
    assertDebuggable(tab)
    return tab
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (active) {
    assertDebuggable(active)
    return active
  }
  const [fallback] = await chrome.tabs.query({ active: true })
  if (!fallback) throw new Error('no active tab; pass tabId explicitly')
  assertDebuggable(fallback)
  return fallback
}

async function evaluate(tabId, expression, { awaitPromise = false, timeoutMs } = {}) {
  const session = await sessionFor(tabId)
  const result = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  })
  if (result?.exceptionDetails) {
    const detail = result.exceptionDetails
    throw new Error(detail.exception?.description ?? detail.text ?? 'page evaluation failed')
  }
  return result?.result?.value
}

function formatRect(rect) {
  if (!rect) return ''
  return `${Math.round(rect.width)}x${Math.round(rect.height)} at (${Math.round(rect.x)}, ${Math.round(rect.y)})`
}

/* ------------------------------------------------------------------ tabs -- */

export async function listTabs(params = {}) {
  const query = {}
  if (params.currentWindow) query.lastFocusedWindow = true
  if (params.groupId !== undefined) query.groupId = params.groupId
  const tabs = await chrome.tabs.query(query)
  const attached = new Set(attachedTabs())
  const rows = tabs
    .filter((tab) => (params.includeBrowserPages ? true : !DEBUGGER_PAGE.test(tab.url ?? '')))
    .map((tab) => ({
      tabId: tab.id,
      windowId: tab.windowId,
      groupId: tab.groupId >= 0 ? tab.groupId : null,
      index: tab.index,
      active: !!tab.active,
      pinned: !!tab.pinned,
      status: tab.status,
      title: tab.title,
      url: tab.url,
      attached: attached.has(tab.id),
    }))
  return { count: rows.length, tabs: rows }
}

export async function openTab(params = {}) {
  const tab = await chrome.tabs.create({
    url: params.url,
    active: params.active !== false,
    ...(typeof params.windowId === 'number' ? { windowId: params.windowId } : {}),
  })
  if (params.waitForLoad) await waitForTabLoad(tab.id, params.timeoutMs ?? 20000)
  const fresh = await chrome.tabs.get(tab.id)
  return { tabId: fresh.id, windowId: fresh.windowId, url: fresh.url, title: fresh.title, status: fresh.status }
}

async function waitForTabLoad(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let tab = await chrome.tabs.get(tabId)
  while (tab.status !== 'complete' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 120))
    tab = await chrome.tabs.get(tabId)
  }
  return tab
}

export async function closeTabs(params = {}) {
  const ids = Array.isArray(params.tabIds) ? params.tabIds : [params.tabId]
  for (const id of ids) forgetTab(id)
  await chrome.tabs.remove(ids)
  return { closed: ids }
}

export async function activateTab(params = {}) {
  const tab = await resolveTab(params)
  await chrome.tabs.update(tab.id, { active: true })
  await chrome.windows.update(tab.windowId, { focused: true })
  return { tabId: tab.id, windowId: tab.windowId }
}

export async function navigate(params = {}) {
  const tab = await resolveTab(params)
  const url = normalizeUrl(params.url)
  await chrome.tabs.update(tab.id, { url })
  if (params.waitForLoad !== false) await waitForTabLoad(tab.id, params.timeoutMs ?? 30000)
  const after = await chrome.tabs.get(tab.id)
  return { tabId: after.id, url: after.url, title: after.title, status: after.status }
}

function normalizeUrl(raw) {
  const value = String(raw ?? '').trim()
  if (!value) throw new Error('url is required')
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(value)) return `https://${value}`
  const query = encodeURIComponent(value)
  return `https://www.bing.com/search?q=${query}`
}

export async function history(params = {}) {
  const direction = params.direction === 'forward' ? 'forward' : 'back'
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  const history = await session.send('Page.getNavigationHistory')
  const delta = direction === 'back' ? -1 : 1
  const entry = history.entries[history.currentIndex + delta]
  if (!entry) throw new Error(`no ${direction} entry in this tab's history`)
  await session.send('Page.navigateToHistoryEntry', { entryId: entry.id })
  if (params.waitForLoad !== false) await waitForTabLoad(tab.id, params.timeoutMs ?? 20000)
  const after = await chrome.tabs.get(tab.id)
  return { tabId: after.id, url: after.url, title: after.title }
}

/* -------------------------------------------------------------- snapshot -- */

export async function snapshot(params = {}) {
  const tab = await resolveTab(params)
  const value = await evaluate(
    tab.id,
    snapshotScript({
      maxNodes: params.maxNodes ?? 2500,
      selector: params.selector ?? null,
      interactiveOnly: params.interactiveOnly === true,
      maxText: params.maxText ?? 160,
    }),
  )
  if (!value?.ok) throw new Error(value?.error ?? 'snapshot failed')
  return {
    tabId: tab.id,
    url: value.url,
    title: value.title,
    readyState: value.readyState,
    nodesVisited: value.nodesVisited,
    truncated: value.truncated,
    refCount: value.refs.length,
    outline: value.outline,
    refs: value.refs,
  }
}

/* ------------------------------------------------------------ interaction -- */

export async function click(params = {}) {
  const tab = await resolveTab(params)
  const target = { ref: params.ref, selector: params.selector }
  if (!target.ref && !target.selector) throw new Error('click needs a ref (from snapshot) or a css selector')
  const rect = await evaluate(tab.id, rectScript(target))
  if (!rect?.ok) throw new Error(rect?.error ?? 'element not found')
  if (rect.coveredBy) {
    throw new Error(`element is covered by ${rect.coveredBy}; scroll it into view or dismiss the overlay first`)
  }
  const session = await sessionFor(tab.id)
  const clicks = params.clickCount === 2 ? 2 : 1
  const button = params.button === 'right' ? 'right' : 'left'
  for (let index = 1; index <= clicks; index += 1) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await session.send('Input.dispatchMouseEvent', {
        type,
        x: rect.x,
        y: rect.y,
        button,
        clickCount: index,
        buttons: type === 'mousePressed' ? 1 : 0,
      })
    }
  }
  return { tabId: tab.id, clicked: target.ref ?? target.selector, rect: formatRect(rect) }
}

export async function hover(params = {}) {
  const tab = await resolveTab(params)
  const target = { ref: params.ref, selector: params.selector }
  const rect = await evaluate(tab.id, rectScript(target))
  if (!rect?.ok) throw new Error(rect?.error ?? 'element not found')
  const session = await sessionFor(tab.id)
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
  return { tabId: tab.id, hovered: target.ref ?? target.selector }
}

export async function type(params = {}) {
  const tab = await resolveTab(params)
  const text = String(params.text ?? '')
  const target = { ref: params.ref, selector: params.selector }
  if (target.ref || target.selector) {
    const focused = await evaluate(tab.id, focusScript(target))
    if (!focused?.ok) throw new Error(focused?.error ?? 'element not found')
    if (params.replace) await evaluate(tab.id, clearScript(target))
  }
  const session = await sessionFor(tab.id)
  if (params.replace && !target.ref && !target.selector) {
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
  }
  if (text) await session.send('Input.insertText', { text })
  return { tabId: tab.id, typed: text.length, target: target.ref ?? target.selector ?? 'focused element' }
}

export async function press(params = {}) {
  const tab = await resolveTab(params)
  if (params.ref || params.selector) {
    const focused = await evaluate(tab.id, focusScript({ ref: params.ref, selector: params.selector }))
    if (!focused?.ok) throw new Error(focused?.error ?? 'element not found')
  }
  const session = await sessionFor(tab.id)
  const sequence = sequenceFor(params.key)
  for (const event of sequence) await session.send('Input.dispatchKeyEvent', event)
  return { tabId: tab.id, key: params.key }
}

const KEY_CODES = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { code: 'Home', windowsVirtualKeyCode: 36 },
  End: { code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { code: 'PageDown', windowsVirtualKeyCode: 34 },
  ' ': { code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
}

function sequenceFor(rawKey) {
  const key = String(rawKey ?? '')
  const named = KEY_CODES[key]
  if (named) {
    return [
      { type: 'keyDown', key, code: named.code, windowsVirtualKeyCode: named.windowsVirtualKeyCode, ...(named.text ? { text: named.text } : {}) },
      { type: 'keyUp', key, code: named.code, windowsVirtualKeyCode: named.windowsVirtualKeyCode },
    ]
  }
  if (key.length === 1) {
    const upper = key.toUpperCase()
    const code = /[a-z]/i.test(key) ? `Key${upper}` : /[0-9]/.test(key) ? `Digit${key}` : ''
    return [
      { type: 'keyDown', key, text: key, windowsVirtualKeyCode: upper.charCodeAt(0), ...(code ? { code } : {}) },
      { type: 'keyUp', key, windowsVirtualKeyCode: upper.charCodeAt(0), ...(code ? { code } : {}) },
    ]
  }
  throw new Error(`unsupported key ${JSON.stringify(key)}; use a single character or one of ${Object.keys(KEY_CODES).join(', ')}`)
}

export async function selectOption(params = {}) {
  const tab = await resolveTab(params)
  const target = { ref: params.ref, selector: params.selector }
  if (!target.ref && !target.selector) throw new Error('select needs a ref or a css selector')
  const script = `(() => {
    const el = ${target.ref ? `document.querySelector('[data-dsh-ref="${target.ref}"]')` : `document.querySelector(${JSON.stringify(target.selector)})`};
    if (!el) return { ok: false, error: 'element not found' };
    if (el.tagName !== 'SELECT') return { ok: false, error: 'element is ' + el.tagName.toLowerCase() + ', not select' };
    const wanted = ${JSON.stringify(params.values ?? [String(params.value ?? '')])};
    const options = [...el.options];
    const chosen = [];
    for (const option of options) {
      const matched = wanted.some((want) => option.value === want || option.text.trim() === want);
      option.selected = matched;
      if (matched) chosen.push(option.value);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, chosen, available: options.map((option) => ({ value: option.value, text: option.text.trim() })).slice(0, 60) };
  })()`
  const result = await evaluate(tab.id, script)
  if (!result?.ok) throw new Error(result?.error ?? 'select failed')
  if (result.chosen.length === 0) {
    throw new Error(`no option matched; available: ${result.available.map((option) => option.value).join(', ')}`)
  }
  return { tabId: tab.id, chosen: result.chosen }
}

export async function scroll(params = {}) {
  const tab = await resolveTab(params)
  const deltaX = Number(params.deltaX ?? 0)
  const deltaY = Number(params.deltaY ?? (params.direction === 'up' ? -600 : 600))
  if (params.ref || params.selector) {
    const target = { ref: params.ref, selector: params.selector }
    const rect = await evaluate(tab.id, rectScript(target))
    if (!rect?.ok) throw new Error(rect?.error ?? 'element not found')
    const session = await sessionFor(tab.id)
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: rect.x,
      y: rect.y,
      deltaX,
      deltaY,
    })
  } else {
    const session = await sessionFor(tab.id)
    const { result } = await session.send('Runtime.evaluate', {
      expression: '({ x: innerWidth / 2, y: innerHeight / 2 })',
      returnByValue: true,
    })
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: result?.value?.x ?? 10,
      y: result?.value?.y ?? 10,
      deltaX,
      deltaY,
    })
  }
  return { tabId: tab.id, scrolled: { deltaX, deltaY } }
}

export async function waitFor(params = {}) {
  const tab = await resolveTab(params)
  const value = await evaluate(
    tab.id,
    waitScript({
      kind: params.kind,
      value: params.value ?? '',
      timeoutMs: params.timeoutMs ?? 10000,
      pollMs: 150,
    }),
    { awaitPromise: true },
  )
  if (!value?.matched) throw new Error(`timed out after ${params.timeoutMs ?? 10000}ms waiting for ${params.kind} ${JSON.stringify(params.value ?? '')}`)
  return { tabId: tab.id, matched: true, waitedMs: value.waitedMs }
}

/* ------------------------------------------------------------- capture -- */

export async function screenshot(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  let data
  let width
  let height
  if (params.fullPage) {
    const metrics = await session.send('Page.getLayoutMetrics')
    const size = metrics.cssContentSize ?? metrics.contentSize
    width = Math.min(Math.ceil(size.width), 8000)
    height = Math.min(Math.ceil(size.height), 8000)
    const shot = await session.send('Page.captureScreenshot', {
      format: params.format ?? 'png',
      quality: params.format === 'jpeg' ? (params.quality ?? 80) : undefined,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    })
    data = shot.data
  } else {
    const shot = await session.send('Page.captureScreenshot', {
      format: params.format ?? 'png',
      quality: params.format === 'jpeg' ? (params.quality ?? 80) : undefined,
    })
    data = shot.data
  }
  return {
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    format: params.format ?? 'png',
    base64: data,
    fullPage: params.fullPage === true,
    ...(width && height ? { width, height } : {}),
  }
}

export async function pdf(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  const result = await session.send('Page.printToPDF', {
    printBackground: params.printBackground !== false,
    landscape: params.landscape === true,
    ...(params.scale ? { scale: params.scale } : {}),
  })
  return { tabId: tab.id, base64: result.data }
}

/* ------------------------------------------------------------ inspection -- */

export async function evaluateInPage(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  const result = await session.send('Runtime.evaluate', {
    expression: String(params.expression ?? ''),
    returnByValue: params.returnByValue !== false,
    awaitPromise: params.awaitPromise === true,
    userGesture: true,
  })
  if (result?.exceptionDetails) {
    return {
      tabId: tab.id,
      ok: false,
      error: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    }
  }
  return { tabId: tab.id, ok: true, value: result?.result?.value, type: result?.result?.type }
}

export async function consoleLogs(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  const level = params.level ?? 'all'
  const limit = Math.min(Number(params.limit ?? 100), 400)
  let entries = session.consoleEntries
  if (level !== 'all') entries = entries.filter((entry) => String(entry.level).toLowerCase() === level)
  const slice = entries.slice(-limit)
  if (params.clear) session.clearConsole()
  return { tabId: tab.id, count: slice.length, entries: slice }
}

export async function networkLogs(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  const filter = params.urlContains ? String(params.urlContains) : null
  const limit = Math.min(Number(params.limit ?? 100), 300)
  let records = [...session.requests.values()]
  if (filter) records = records.filter((record) => String(record.url ?? '').includes(filter))
  const slice = records.slice(-limit)
  if (params.clear) session.clearNetwork()
  return {
    tabId: tab.id,
    count: slice.length,
    requests: slice.map((record) => ({
      method: record.method,
      url: record.url,
      type: record.type,
      status: record.status,
      mimeType: record.mimeType,
      size: record.size,
      failed: record.failed,
      postData: record.postData,
    })),
  }
}

export async function getResponseBody(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  const records = [...session.requests.values()].filter((record) => String(record.url ?? '').includes(String(params.urlContains ?? '')))
  const record = records[records.length - 1]
  if (!record) throw new Error(`no recorded request matching ${JSON.stringify(params.urlContains ?? '')}`)
  const body = await session.send('Network.getResponseBody', { requestId: record.requestId })
  const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
  const limit = Number(params.limit ?? 20000)
  return {
    url: record.url,
    status: record.status,
    mimeType: record.mimeType,
    truncated: text.length > limit,
    body: text.length > limit ? `${text.slice(0, limit)}\n… [${text.length} chars total]` : text,
  }
}

export async function setCookie(params = {}) {
  const tab = await resolveTab(params)
  const url = params.url ?? tab.url
  const cookie = await chrome.cookies.set({
    url,
    name: params.name,
    value: params.value,
    domain: params.domain,
    path: params.path ?? '/',
    secure: params.secure === true,
    httpOnly: params.httpOnly === true,
    ...(typeof params.expirationDate === 'number' ? { expirationDate: params.expirationDate } : {}),
  })
  return { set: cookie?.name, domain: cookie?.domain }
}

export async function getCookies(params = {}) {
  const tab = await resolveTab(params)
  const url = params.url ?? tab.url
  const cookies = await chrome.cookies.getAll({ url, ...(params.name ? { name: params.name } : {}) })
  return {
    url,
    count: cookies.length,
    cookies: cookies.map((cookie) => ({ name: cookie.name, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, session: cookie.session, expiry: cookie.expirationDate })),
  }
}

export async function storage(params = {}) {
  const tab = await resolveTab(params)
  const area = params.area === 'session' ? 'session' : 'local'
  if (params.operation === 'clear') {
    const value = await evaluate(tab.id, storageClearScript(area, params.keys ?? []))
    return { tabId: tab.id, area, cleared: value?.ok === true }
  }
  if (params.operation === 'set') {
    const value = await evaluate(tab.id, storageWriteScript(area, params.entries ?? {}))
    return { tabId: tab.id, area, written: value?.written ?? 0 }
  }
  const value = await evaluate(tab.id, storageReadScript(area, params.keys ?? []))
  return { tabId: tab.id, area, items: value?.items ?? {} }
}

/* --------------------------------------------------------------- browser -- */

export async function resize(params = {}) {
  const tab = await resolveTab(params)
  const width = Number(params.width ?? 1280)
  const height = Number(params.height ?? 800)
  await chrome.windows.update(tab.windowId, { width, height, focused: true })
  return { windowId: tab.windowId, width, height }
}

export async function groupTabs(params = {}) {
  const ids = Array.isArray(params.tabIds) && params.tabIds.length > 0 ? params.tabIds : [(await resolveTab(params)).id]
  const groupId = await chrome.tabs.group({ tabIds: ids, ...(typeof params.groupId === 'number' ? { groupId: params.groupId } : {}) })
  if (params.title || params.color) {
    await chrome.tabGroups.update(groupId, {
      ...(params.title ? { title: params.title } : {}),
      ...(params.color ? { color: params.color } : {}),
    })
  }
  return { groupId, tabIds: ids }
}

export async function download(params = {}) {
  const tab = await resolveTab(params)
  const url = params.url ?? tab.url
  const downloadId = await chrome.downloads.download({ url, ...(params.filename ? { filename: params.filename } : {}) })
  return { downloadId, url }
}

export function status() {
  return {
    attachedTabs: attachedTabs(),
    sessions: attachedTabs().length,
  }
}

/**
 * Dispatch one bridge command.
 * @param {string} method
 * @param {Record<string, unknown>} params
 */
export async function dispatch(method, params) {
  switch (method) {
    case 'status':
      return status()
    case 'tabs.list':
      return listTabs(params)
    case 'tabs.open':
      return openTab(params)
    case 'tabs.close':
      return closeTabs(params)
    case 'tabs.activate':
      return activateTab(params)
    case 'page.navigate':
      return navigate(params)
    case 'page.history':
      return history(params)
    case 'page.snapshot':
      return snapshot(params)
    case 'page.click':
      return click(params)
    case 'page.hover':
      return hover(params)
    case 'page.type':
      return type(params)
    case 'page.press':
      return press(params)
    case 'page.select':
      return selectOption(params)
    case 'page.scroll':
      return scroll(params)
    case 'page.waitFor':
      return waitFor(params)
    case 'page.screenshot':
      return screenshot(params)
    case 'page.pdf':
      return pdf(params)
    case 'page.evaluate':
      return evaluateInPage(params)
    case 'page.console':
      return consoleLogs(params)
    case 'page.network':
      return networkLogs(params)
    case 'page.responseBody':
      return getResponseBody(params)
    case 'cookies.set':
      return setCookie(params)
    case 'cookies.get':
      return getCookies(params)
    case 'storage':
      return storage(params)
    case 'browser.resize':
      return resize(params)
    case 'browser.group':
      return groupTabs(params)
    case 'browser.download':
      return download(params)
    case 'session.detach':
      await detachAll()
      return { detached: true }
    case 'page.focus':
      return focusPage(params)
    default:
      throw new Error(`unknown method ${JSON.stringify(method)}`)
  }
}

async function focusPage(params = {}) {
  const tab = await resolveTab(params)
  const rect = await evaluate(
    tab.id,
    `(() => {
      const el = ${params.ref ? `document.querySelector('[data-dsh-ref="${params.ref}"]')` : `document.querySelector(${JSON.stringify(params.selector ?? 'body')})`};
      if (!el) return { ok: false, error: 'element not found' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      try { el.focus({ preventScroll: true }); } catch { el.focus(); }
      return { ok: true, focused: document.activeElement === el };
    })()`,
  )
  if (!rect?.ok) throw new Error(rect?.error ?? 'focus failed')
  return { tabId: tab.id, focused: rect.focused }
}

export { detachAll, forgetTab, existingSession }

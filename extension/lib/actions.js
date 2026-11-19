/**
 * The command surface the DSH host drives.
 *
 * Every handler takes validated JSON parameters and returns a JSON-serializable
 * result. Handlers are provider-neutral: they talk to `chrome.tabs`,
 * `chrome.scripting` and CDP through {@link ./cdp.js}, never to the bridge.
 *
 * @module dsh-chrome-use/extension/lib/actions
 */
import { sessionFor, existingSession, attachedTabs, detachAll, forgetTab, ABANDONED } from './cdp.js'
import {
  snapshotScript,
  focusScript,
  rectScript,
  clearScript,
  storageReadScript,
  storageWriteScript,
  storageClearScript,
  waitScript,
  markdownScript,
  tableScript,
  handoffScript,
  timezoneScript,
} from './page-scripts.js'

const DEBUGGER_PAGE = /^(chrome|edge|about|devtools|chrome-extension|view-source):/i

/** Start-up scripts installed per tab, so a stale one can be removed before replacing it. */
const timezoneIds = new Map()

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
  const result = await session.send(
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    },
    { releaseOnDialog: true },
  )
  if (result === ABANDONED) throw dialogOpenedError(session)
  if (result?.exceptionDetails) {
    const detail = result.exceptionDetails
    throw new Error(detail.exception?.description ?? detail.text ?? 'page evaluation failed')
  }
  return result?.result?.value
}

/** Build the error for a command that could not return because a dialog blocked the page. */
function dialogOpenedError(session) {
  return new Error(
    `${session.dialogMessage()}. Answer it with chrome_use_interact action dialog, then continue`,
  )
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
  // `window: 'new'` puts the tab in a fresh browser window, `'background'` in a
  // new window that never steals focus, `'current'` (the default) honours
  // windowId or whatever window Chrome would pick.
  if (params.window === 'new' || params.window === 'background') {
    const created = await chrome.windows.create({
      url: params.url,
      focused: params.window === 'new' && params.focused === true,
      ...(params.incognito === true ? { incognito: true } : {}),
    })
    const tabId = created.tabs?.[0]?.id
    if (params.waitForLoad && typeof tabId === 'number') await waitForTabLoad(tabId, params.timeoutMs ?? 20000)
    const fresh = typeof tabId === 'number' ? await chrome.tabs.get(tabId) : null
    return {
      tabId: fresh?.id ?? null,
      windowId: created.id,
      url: fresh?.url ?? params.url,
      title: fresh?.title ?? '',
      status: fresh?.status ?? 'loading',
      window: params.window,
    }
  }
  const tab = await chrome.tabs.create({
    url: params.url,
    active: params.active !== false,
    ...(typeof params.windowId === 'number' ? { windowId: params.windowId } : {}),
  })
  if (params.waitForLoad) await waitForTabLoad(tab.id, params.timeoutMs ?? 20000)
  const fresh = await chrome.tabs.get(tab.id)
  return { tabId: fresh.id, windowId: fresh.windowId, url: fresh.url, title: fresh.title, status: fresh.status, window: 'current' }
}

/**
 * Open a separate window for automation and leave the desktop alone.
 *
 * `focused: false` is what keeps the user's foreground window where it is; the
 * window still exists, is real, and can be driven by CDP, it just never takes
 * the keyboard away. `state: 'minimized'` goes one step further on request.
 */
export async function openWindow(params = {}) {
  const width = Number(params.width ?? 1280)
  const height = Number(params.height ?? 800)
  const created = await chrome.windows.create({
    url: params.url,
    focused: false,
    type: 'normal',
    width: Math.max(320, width),
    height: Math.max(240, height),
    ...(params.incognito === true ? { incognito: true } : {}),
  })
  const tabId = created.tabs?.[0]?.id
  if (params.minimized === true) {
    await chrome.windows.update(created.id, { state: 'minimized' })
  }
  if (params.waitForLoad && typeof tabId === 'number') await waitForTabLoad(tabId, params.timeoutMs ?? 20000)
  const fresh = typeof tabId === 'number' ? await chrome.tabs.get(tabId).catch(() => null) : null
  return {
    windowId: created.id,
    tabId: fresh?.id ?? null,
    url: fresh?.url ?? params.url,
    title: fresh?.title ?? '',
    focused: false,
    minimized: params.minimized === true,
    incognito: params.incognito === true,
  }
}

/** Raise or lower one automation window without touching the others. */
export async function windowState(params = {}) {
  const state = String(params.state ?? 'normal')
  const allowed = ['normal', 'minimized', 'maximized', 'fullscreen']
  if (!allowed.includes(state)) throw new Error(`state must be one of ${allowed.join(', ')}`)
  const windowId = Number(params.windowId)
  if (!Number.isFinite(windowId)) throw new Error('windowState needs a numeric windowId')
  // Chrome rejects the whole call with "Invalid value for state" when `focused: false`
  // travels next to a state, so the flag is only sent when it actually asks for focus.
  // Leaving it out keeps the same outcome: the window changes without taking the desktop.
  const patch = { state }
  if (params.focused === true) patch.focused = true
  await chrome.windows.update(windowId, patch)
  return { windowId, state, focused: params.focused === true }
}

/** Close one automation window and every tab in it. */
export async function closeWindow(params = {}) {
  const windowId = Number(params.windowId)
  if (!Number.isFinite(windowId)) throw new Error('closeWindow needs a numeric windowId')
  const remaining = await chrome.windows.getAll()
  if (remaining.length <= 1) throw new Error('this is the last browser window; opening a replacement first avoids closing the browser')
  await chrome.windows.remove(windowId)
  return { closed: windowId }
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
      frames: params.frames !== false,
    }),
  )
  if (!value?.ok) throw new Error(value?.error ?? 'snapshot failed')
  return {
    tabId: tab.id,
    url: value.url,
    title: value.title,
    readyState: value.readyState,
    nodesVisited: value.nodesVisited,
    framesWalked: value.framesWalked,
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
      const outcome = await session.send(
        'Input.dispatchMouseEvent',
        {
          type,
          x: rect.x,
          y: rect.y,
          button,
          clickCount: index,
          buttons: type === 'mousePressed' ? 1 : 0,
        },
        { releaseOnDialog: true },
      )
      if (outcome === ABANDONED) return dialogResult(tab.id, session, target.ref ?? target.selector)
    }
  }
  return { tabId: tab.id, clicked: target.ref ?? target.selector, rect: formatRect(rect) }
}

/**
 * Describe a click/keys action whose page opened a dialog.
 *
 * The action did happen; it is only the acknowledgement that is missing, so this
 * reports success plus the dialog instead of an error the model would retry.
 */
function dialogResult(tabId, session, target) {
  return {
    tabId,
    target,
    dialogOpened: true,
    dialog: session.dialog,
    hint: 'answer with chrome_use_interact action dialog, accept true or false',
  }
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

/**
 * Drag from one element to another.
 *
 * A synthetic drag has to look like a real one: a bare press-and-release is read
 * as a click by every pointer-events implementation, so the button is held while
 * the cursor walks to the target in small steps and the drag events fire between.
 */
/**
 * Dispatch one input event out of band, with a deadline.
 *
 * Two things make a naive `await` wrong here. A pressed button changes how Chrome
 * acknowledges input: the browser process can withhold the ack until the gesture
 * finishes, so awaiting every intermediate move deadlocks the gesture itself. And
 * the pressed-button flag lives in the browser process, not in one tab, so a press
 * whose ack never arrived makes every later click in every tab vanish.
 *
 * So each event gets its own deadline and reports `stalled` instead of throwing,
 * leaving the caller free to finish the gesture and then reset the input state.
 */
async function sendInputOutOfBand(session, event, timeoutMs = 5000) {
  const started = Date.now()
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve('stalled'), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  let outcome = 'stalled'
  try {
    outcome = await Promise.race([
      session.sendImmediate('Input.dispatchMouseEvent', event).then(() => 'sent'),
      deadline,
    ])
  } catch {
    outcome = 'failed'
  } finally {
    clearTimeout(timer)
  }
  return { outcome, ms: Date.now() - started }
}

/** Await a promise, but give up at the deadline instead of holding the queue. */
async function withinDeadline(promise, timeoutMs, fallback) {
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([promise.catch(() => fallback), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Put the browser's input state back to neutral.
 *
 * The pressed-button flag is process-wide: if a drag stalls after its press, every
 * click in every tab is silently swallowed — pages still receive moves, nothing
 * receives a press. `Input.cancelDragging` and an out-of-bounds release are what
 * clears it, so this is also the recovery step a stuck session needs.
 */
export async function resetInput(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  const cancelled = await withinDeadline(
    session.sendImmediate('Input.cancelDragging', {}).then(() => true),
    2000,
    false,
  )
  // A release at (0,0) is rejected as out of bounds on some pages, and a rejected
  // release leaves the flag set, so aim at the middle of the live viewport.
  const centre = await evaluate(
    tab.id,
    '({ x: Math.round(innerWidth / 2) || 1, y: Math.round(innerHeight / 2) || 1 })',
  ).catch(() => null)
  const x = Number(centre?.x) > 0 ? centre.x : 20
  const y = Number(centre?.y) > 0 ? centre.y : 20
  const release = await sendInputOutOfBand(
    session,
    { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 },
    4000,
  )
  return { tabId: tab.id, cancelled, released: release.outcome === 'sent' }
}

export async function drag(params = {}) {
  const tab = await resolveTab(params)
  const from = { ref: params.ref, selector: params.selector }
  const to = { ref: params.toRef, selector: params.toSelector }
  if (!from.ref && !from.selector) throw new Error('drag needs a ref or a css selector to pick up')
  if (!to.ref && !to.selector) throw new Error('drag needs toRef or toSelector to know where to drop')
  const source = await evaluate(tab.id, rectScript(from))
  if (!source?.ok) throw new Error(source?.error ?? 'drag source not found')
  const destination = await evaluate(tab.id, rectScript(to))
  if (!destination?.ok) throw new Error(destination?.error ?? 'drop target not found')
  const session = await sessionFor(tab.id)
  const steps = Math.max(1, Math.min(48, params.steps ?? 12))
  const stepMs = params.stepMs ?? 0
  const timings = []

  const press = await sendInputOutOfBand(
    session,
    {
      type: 'mousePressed',
      x: source.x,
      y: source.y,
      button: 'left',
      clickCount: 1,
      buttons: 1,
    },
    2000,
  )
  timings.push(`press ${press.outcome} in ${press.ms}ms`)

  // The moves are fired together and not awaited one by one: their positions are
  // what the page reads, and one ack withheld until the drop would stall the whole
  // gesture before it ever reaches the release.
  const moves = []
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps
    moves.push(
      session
        .sendImmediate('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(source.x + (destination.x - source.x) * ratio),
          y: Math.round(source.y + (destination.y - source.y) * ratio),
          button: 'left',
          buttons: 1,
        })
        .catch(() => {}),
    )
    if (stepMs > 0) await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  const release = await sendInputOutOfBand(
    session,
    {
      type: 'mouseReleased',
      x: destination.x,
      y: destination.y,
      button: 'left',
      clickCount: 1,
      buttons: 0,
    },
    8000,
  )
  timings.push(`release ${release.outcome} in ${release.ms}ms`)
  await withinDeadline(Promise.all(moves), 3000, null)

  if (release.outcome !== 'sent') {
    // Leaving the button down would swallow every later click in every tab, so the
    // reset is not optional; the gesture itself may still have started on the page.
    const reset = await resetInput({ tabId: tab.id }).catch(() => null)
    throw new Error(
      `the page held the drop. ${timings.join('; ')}; reset ${
        reset?.released ? 'released the pointer' : 'could not confirm a release'
      }. The drag may still have started, so look at the page before retrying`,
    )
  }
  return {
    tabId: tab.id,
    dragged: from.ref ?? from.selector,
    onto: to.ref ?? to.selector,
    distance: Math.round(Math.hypot(destination.x - source.x, destination.y - source.y)),
    steps,
    dropped: true,
    timings,
    ...(press.outcome === 'sent' ? {} : { note: 'the press ack arrived late; the gesture still completed' }),
  }
}

/**
 * Fill several fields in one call.
 *
 * A form is usually filled field by field; each round trip costs a model step, so
 * this accepts the whole list, focuses/clears/types each entry, and reports per
 * field what happened instead of aborting on the first miss.
 */
export async function fill(params = {}) {
  const tab = await resolveTab(params)
  const fields = Array.isArray(params.fields) ? params.fields : []
  if (fields.length === 0) throw new Error('fill needs at least one entry in fields')
  const session = await sessionFor(tab.id)
  const results = []
  for (const field of fields) {
    const target = { ref: field?.ref, selector: field?.selector }
    if (!target.ref && !target.selector) {
      results.push({ ok: false, error: 'entry has neither ref nor selector' })
      continue
    }
    const label = target.ref ?? target.selector
    const probe = `(() => {
      const el = ${target.ref ? `document.querySelector('[data-dsh-ref="${target.ref}"]')` : `document.querySelector(${JSON.stringify(target.selector)})`};
      if (!el) return { ok: false, error: 'element not found' };
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      const readOnly = el.readOnly === true || el.getAttribute('readonly') !== null || el.disabled === true;
      return { ok: true, tag, type, readOnly, editable: el.isContentEditable === true };
    })()`
    const shape = await evaluate(tab.id, probe)
    if (!shape?.ok) {
      results.push({ target: label, ok: false, error: shape?.error ?? 'element not found' })
      continue
    }
    if (shape.readOnly) {
      results.push({ target: label, ok: false, error: 'element is read-only or disabled' })
      continue
    }
    // Typing into a file input or a checkbox does nothing useful, and because the
    // keystrokes go wherever focus is, it silently lands in the previous field.
    if (shape.tag === 'input' && (shape.type === 'file' || shape.type === 'checkbox' || shape.type === 'radio' || shape.type === 'submit' || shape.type === 'button')) {
      results.push({
        target: label,
        ok: false,
        error:
          shape.type === 'file'
            ? 'a file input takes paths, not text: use chrome_use_interact action upload'
            : `an input of type ${shape.type} has no text to type`,
      })
      continue
    }
    if (shape.tag === 'select' && field?.kind !== 'select') {
      results.push({ target: label, ok: false, error: 'this is a select: use kind "select"' })
      continue
    }
    const focused = await evaluate(tab.id, focusScript(target))
    if (!focused?.ok) {
      results.push({ target: label, ok: false, error: focused?.error ?? 'element not found' })
      continue
    }
    const value = String(field?.text ?? field?.value ?? '')
    if (field?.replace !== false) await evaluate(tab.id, clearScript(target))
    if (field?.kind === 'select') {
      const script = `(() => {
        const el = ${target.ref ? `document.querySelector('[data-dsh-ref="${target.ref}"]')` : `document.querySelector(${JSON.stringify(target.selector)})`};
        if (!el) return { ok: false, error: 'element not found' };
        if (el.tagName !== 'SELECT') return { ok: false, error: 'element is ' + el.tagName.toLowerCase() + ', not select' };
        const wanted = ${JSON.stringify(value.split('|').filter((part) => part !== ''))};
        const chosen = [];
        for (const option of el.options) {
          const matched = wanted.some((want) => option.value === want || option.text.trim() === want);
          option.selected = matched;
          if (matched) chosen.push(option.value);
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, chosen };
      })()`
      const chosen = await evaluate(tab.id, script)
      results.push(chosen?.ok ? { target: label, ok: true, chosen: chosen.chosen } : { target: label, ok: false, error: chosen?.error ?? 'select failed' })
      continue
    }
    if (value) await session.send('Input.insertText', { text: value })
    if (field?.submit) {
      const sequence = sequenceFor('Enter')
      for (const event of sequence) {
        const outcome = await session.send('Input.dispatchKeyEvent', event, { releaseOnDialog: true })
        if (outcome === ABANDONED) {
          results.push({ target: label, ok: true, typed: value.length, dialogOpened: true })
          return { tabId: tab.id, fields: results, dialog: session.dialog }
        }
      }
    }
    results.push({ target: label, ok: true, typed: value.length })
  }
  return {
    tabId: tab.id,
    filled: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok).length,
    fields: results,
  }
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
  for (const event of sequence) {
    const outcome = await session.send('Input.dispatchKeyEvent', event, { releaseOnDialog: true })
    if (outcome === ABANDONED) return dialogResult(tab.id, session, params.key)
  }
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

/**
 * Report the JavaScript dialog that is currently blocking the page.
 *
 * A dialog blocks the renderer, so every later CDP call on that tab hangs until
 * it is dismissed. This gives the model a way to find out before it tries.
 */
export async function pendingDialog(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  return { tabId: tab.id, dialog: session.dialog ?? null }
}

/**
 * Accept or dismiss the dialog blocking the page.
 *
 * The dialog is sent even when no opening event was recorded: a dialog that was
 * already up before this extension attached emits no event, and CDP answers it
 * regardless. That is the recovery path for a tab stuck on a stale dialog.
 */
export async function handleDialog(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  const dialog = session.dialog
  const accept = params.accept !== false
  // Bypasses the per-tab queue on purpose: the command that opened this dialog
  // still holds it until the dialog is answered.
  try {
    await session.sendImmediate('Page.handleJavaScriptDialog', {
      accept,
      ...(typeof params.promptText === 'string' ? { promptText: params.promptText } : {}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/no dialog/i.test(message)) {
      session.dialog = null
      throw new Error(`no javascript dialog is open on tab ${tab.id}`)
    }
    throw error
  }
  session.dialog = null
  return { tabId: tab.id, accepted: accept, type: dialog?.type ?? 'dialog', message: dialog?.message ?? '' }
}

/** Wait until in-flight network requests settle, so the next snapshot sees the result. */
export async function waitForNetworkIdle(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  const result = await session.waitForNetworkIdle({
    idleMs: params.idleMs ?? 500,
    timeoutMs: params.timeoutMs ?? 15000,
  })
  if (!result.idle) {
    throw new Error(`network was still busy after ${result.waitedMs}ms (${result.inflight ?? '?'} requests in flight)`)
  }
  return { tabId: tab.id, idle: true, waitedMs: result.waitedMs }
}

/**
 * Set files on a file input.
 *
 * `DOM.setFileInputFiles` needs a real node id from the DOM domain, so the
 * lookup runs through the document tree rather than a page expression. Elements
 * inside a shadow root are not addressable that way; pass a selector that
 * pierces, or upload through the visible input.
 */
export async function uploadFile(params = {}) {
  const tab = await resolveTab(params)
  const files = Array.isArray(params.files) ? params.files.map(String).filter(Boolean) : []
  if (files.length === 0) throw new Error('upload needs at least one absolute path in files')
  if (!params.ref && !params.selector) throw new Error('upload needs a ref (from snapshot) or a css selector')
  const session = await sessionFor(tab.id)
  const selector = params.selector ?? `[data-dsh-ref=${JSON.stringify(params.ref)}]`
  const document_ = await session.send('DOM.getDocument', { depth: 0 })
  const found = await session.send('DOM.querySelectorAll', { nodeId: document_.root.nodeId, selector })
  const nodeId = found?.nodeIds?.[0]
  if (!nodeId) throw new Error(`no element matched ${JSON.stringify(selector)}`)
  await session.send('DOM.setFileInputFiles', { files, nodeId })
  return { tabId: tab.id, target: params.ref ?? params.selector, files }
}

/** Override the viewport, which is how a site's mobile layout becomes reachable. */
export async function setViewport(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  const width = Number(params.width ?? 0)
  const height = Number(params.height ?? 0)
  if (!(width > 0) || !(height > 0)) throw new Error('setViewport needs positive width and height')
  await session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: Number(params.deviceScaleFactor ?? 1),
    mobile: params.mobile === true,
  })
  return { tabId: tab.id, width, height, mobile: params.mobile === true }
}

/** Drop the viewport override set by {@link setViewport}. */
export async function clearViewport(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  await session.send('Emulation.clearDeviceMetricsOverride')
  return { tabId: tab.id, cleared: true }
}

/** Emulate `prefers-color-scheme`, a media type, or print media. */
export async function emulateMedia(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  const features = []
  if (params.colorScheme === 'dark' || params.colorScheme === 'light') {
    features.push({ name: 'prefers-color-scheme', value: params.colorScheme })
  }
  if (params.reducedMotion === 'reduce' || params.reducedMotion === 'no-preference') {
    features.push({ name: 'prefers-reduced-motion', value: params.reducedMotion })
  }
  await session.send('Emulation.setEmulatedMedia', {
    ...(params.media ? { media: String(params.media) } : {}),
    features,
  })
  return { tabId: tab.id, media: params.media ?? null, features }
}

/**
 * Slow the network down, or cut it, for one tab.
 *
 * `Network.emulateNetworkConditions` is the only way to make a page see a bad
 * connection without touching the OS; clearing sends the "no throttling" shape
 * rather than `Network.disable`, which would also drop the request observer.
 */
export async function emulateNetwork(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  if (params.clear === true) {
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    return { tabId: tab.id, cleared: true }
  }
  const preset = params.preset ?? null
  const shaped = preset ? PRESETS[preset] : null
  if (preset && !shaped) {
    throw new Error(`unknown preset ${JSON.stringify(preset)}; use one of ${Object.keys(PRESETS).join(', ')} or pass latency/downloadKbps`)
  }
  const offline = params.offline === true
  const latency = Number(params.latency ?? shaped?.latency ?? 0)
  const download = Number(params.downloadKbps ?? shaped?.downloadKbps ?? -1)
  const upload = Number(params.uploadKbps ?? shaped?.uploadKbps ?? -1)
  await session.send('Network.emulateNetworkConditions', {
    offline,
    latency,
    // CDP wants bytes per second; -1 means "leave it alone".
    downloadThroughput: download < 0 ? -1 : Math.round((download * 1024) / 8),
    uploadThroughput: upload < 0 ? -1 : Math.round((upload * 1024) / 8),
    ...(params.connectionType ? { connectionType: String(params.connectionType) } : {}),
  })
  return { tabId: tab.id, offline, latency, downloadKbps: download, uploadKbps: upload, preset }
}

const PRESETS = {
  offline: { latency: 0, downloadKbps: 0, uploadKbps: 0 },
  slow3g: { latency: 400, downloadKbps: 400, uploadKbps: 400 },
  fast3g: { latency: 150, downloadKbps: 1600, uploadKbps: 750 },
  slow4g: { latency: 60, downloadKbps: 4000, uploadKbps: 3000 },
}

/** Put the page in a place, or clear the override. */
export async function setGeolocation(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  if (params.clear === true) {
    await session.send('Emulation.clearGeolocationOverride')
    return { tabId: tab.id, cleared: true }
  }
  const latitude = Number(params.latitude)
  const longitude = Number(params.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('geolocation needs numeric latitude and longitude, or clear: true')
  }
  const accuracy = Number(params.accuracy ?? 100)
  // Overriding the position is not the same as being allowed to ask for it: with no
  // grant, `getCurrentPosition` sits on the permission prompt until it times out, so
  // the override would look broken. Grant for this origin only, and say if it failed.
  let granted = false
  let grantError = null
  const origin = (() => {
    try {
      return new URL(tab.url ?? '').origin
    } catch {
      return null
    }
  })()
  if (origin && origin !== 'null') {
    // The Browser domain is only reachable on a browser-level session, so granting
    // there fails from a tab-scoped debugger attach. The extension permission API is
    // the route that actually works here: it stores a real site setting, and CDP's
    // geolocation override then answers queries made under that grant. The content
    // setting for a position is named `location`, not `geolocation`.
    try {
      await chrome.contentSettings.location.set({
        primaryPattern: `${origin}/*`,
        setting: 'allow',
        scope: 'regular',
      })
      granted = true
    } catch (error) {
      grantError = error instanceof Error ? error.message : String(error)
    }
  } else {
    grantError = 'the tab has no http(s) origin to grant geolocation for'
  }
  await session.send('Emulation.setGeolocationOverride', { latitude, longitude, accuracy })
  return { tabId: tab.id, latitude, longitude, accuracy, granted, ...(grantError ? { grantError } : {}) }
}

/** Put the page in a timezone, or clear the override. */
export async function setTimezone(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  const timezone = params.clear === true ? '' : String(params.timezone ?? '')
  if (params.clear !== true && !timezone) {
    throw new Error('timezone needs an IANA name such as Asia/Shanghai, or clear: true')
  }
  // Chrome only honours `Emulation.setTimezoneOverride` for trusted clients, so the
  // zone is imposed inside the page. The same source is installed as a start-up
  // script, otherwise the next navigation silently drops back to the real zone.
  const source = timezoneScript({ timeZone: timezone })
  const key = `dsh-timezone:${tab.id}`
  const previous = timezoneIds.get(key)
  if (previous) {
    await session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: previous }).catch(() => {})
    timezoneIds.delete(key)
  }
  const result = await evaluate(tab.id, source)
  if (!result?.ok) throw new Error(result?.error ?? `could not install the ${timezone} timezone`)
  if (timezone) {
    const installed = await session.send('Page.addScriptToEvaluateOnNewDocument', { source })
    if (installed?.identifier) timezoneIds.set(key, installed.identifier)
  }
  if (params.clear === true) return { tabId: tab.id, cleared: true }
  return { tabId: tab.id, timezone, offsetMinutes: result.offsetMinutes, applied: 'page' }
}

/* ------------------------------------------------------------- capture -- */

/**
 * Screenshot one element, or the whole page.
 *
 * The element path clips `captureBeyondViewport` to the element's box, which is
 * how the model gets a legible picture of a chart or a table without a full-page
 * image it cannot read.
 */
export async function screenshot(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  let data
  let width
  let height
  if (params.ref || params.selector) {
    const box = await evaluate(tab.id, rectScript({ ref: params.ref, selector: params.selector }))
    if (!box?.ok) throw new Error(box?.error ?? 'element not found')
    const page = await session.send('Page.getLayoutMetrics')
    const offsetX = page.cssLayoutViewport?.pageX ?? 0
    const offsetY = page.cssLayoutViewport?.pageY ?? 0
    // rectScript reports a viewport-relative box; the clip is page-relative.
    width = Math.max(1, Math.ceil(box.width))
    height = Math.max(1, Math.ceil(box.height))
    const shot = await session.send('Page.captureScreenshot', {
      format: params.format ?? 'png',
      quality: params.format === 'jpeg' ? (params.quality ?? 80) : undefined,
      captureBeyondViewport: true,
      clip: {
        x: Math.max(0, box.x - box.width / 2 + offsetX),
        y: Math.max(0, box.y - box.height / 2 + offsetY),
        width,
        height,
        scale: 1,
      },
    })
    data = shot.data
  } else if (params.fullPage) {
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

/**
 * The page as markdown.
 *
 * Snapshots cost a token per node; a model that only needs the prose, a table or
 * a code block is better served by the main content converted once, with links
 * and inline code preserved.
 */
export async function markdown(params = {}) {
  const tab = await resolveTab(params)
  const value = await evaluate(tab.id, markdownScript({ selector: params.selector ?? null, maxChars: params.maxChars ?? 20000 }))
  if (!value?.ok) throw new Error(value?.error ?? 'could not read the page')
  return {
    tabId: tab.id,
    url: value.url,
    title: value.title,
    truncated: value.truncated === true,
    chars: value.chars,
    markdown: value.markdown,
  }
}

/** Every table on the page, as header + rows. */
export async function tables(params = {}) {
  const tab = await resolveTab(params)
  const value = await evaluate(tab.id, tableScript({ selector: params.selector ?? null, maxTables: params.maxTables ?? 8, maxRows: params.maxRows ?? 200 }))
  if (!value?.ok) throw new Error(value?.error ?? 'could not read the tables')
  return { tabId: tab.id, url: value.url, count: value.count, tables: value.tables }
}

/**
 * Performance counters for the tab: DOM size, layout, task time, JS heap.
 *
 * Numbers are raw CDP metrics; the ratios that usually matter (nodes, JS heap,
 * cumulative layout shift) are surfaced first so a report does not need the
 * whole table.
 */
export async function metrics(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  await session.send('Performance.enable').catch(() => {})
  const result = await session.send('Performance.getMetrics')
  const fields = new Map((result.metrics ?? []).map((entry) => [entry.name, entry.value]))
  const pick = (name) => (fields.has(name) ? fields.get(name) : null)
  const summary = {
    nodes: pick('Nodes'),
    documents: pick('Documents'),
    jsHeapUsedBytes: pick('JSHeapUsedSize'),
    jsHeapTotalBytes: pick('JSHeapTotalSize'),
    layoutCount: pick('LayoutCount'),
    recalcStyleCount: pick('RecalcStyleCount'),
    scriptDurationMs: pick('ScriptDuration') === null ? null : Math.round(pick('ScriptDuration') * 1000),
    layoutDurationMs: pick('LayoutDuration') === null ? null : Math.round(pick('LayoutDuration') * 1000),
    taskDurationMs: pick('TaskDuration') === null ? null : Math.round(pick('TaskDuration') * 1000),
    cumulativeLayoutShift: pick('CumulativeLayoutShift'),
  }
  if (params.clear) await session.send('Performance.disable').catch(() => {})
  return { tabId: tab.id, summary, metrics: params.raw === true ? [...fields.entries()].map(([name, value]) => ({ name, value })) : undefined }
}

/**
 * Hand the browser back to the person at the keyboard.
 *
 * Some steps — signing in, a payment confirmation, a captcha — must not be done
 * by the agent. This paints a bar into the page, waits for the user to press
 * Continue, and returns whether they resumed or the wait timed out.
 */
export async function handoff(params = {}) {
  const tab = await resolveTab(params)
  const session = await sessionFor(tab.id)
  const timeoutMs = Math.min(Math.max(Number(params.timeoutMs ?? 300000), 1000), 600000)
  const script = handoffScript({
    message: params.message ?? 'Take over in the browser, then press continue',
    buttonLabel: params.buttonLabel ?? 'Continue',
    timeoutMs,
  })
  const value = await session.send(
    'Runtime.evaluate',
    { expression: script, returnByValue: true, awaitPromise: true, userGesture: true },
    { releaseOnDialog: true },
  )
  const payload = value?.result?.value
  return {
    tabId: tab.id,
    url: tab.url,
    resumed: payload?.resumed === true,
    timedOut: payload?.resumed !== true,
  }
}

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
    case 'tabs.window':
      return openWindow(params)
    case 'tabs.windowState':
      return windowState(params)
    case 'tabs.closeWindow':
      return closeWindow(params)
    case 'page.navigate':
      return navigate(params)
    case 'page.history':
      return history(params)
    case 'page.snapshot':
      return snapshot(params)
    case 'page.markdown':
      return markdown(params)
    case 'page.table':
      return tables(params)
    case 'page.metrics':
      return metrics(params)
    case 'page.handoff':
      return handoff(params)
    case 'page.click':
      return click(params)
    case 'page.drag':
      return drag(params)
    case 'page.resetInput':
      return resetInput(params)
    case 'page.fill':
      return fill(params)
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
    case 'page.waitForNetworkIdle':
      return waitForNetworkIdle(params)
    case 'page.pendingDialog':
      return pendingDialog(params)
    case 'page.handleDialog':
      return handleDialog(params)
    case 'page.upload':
      return uploadFile(params)
    case 'page.setViewport':
      return setViewport(params)
    case 'page.clearViewport':
      return clearViewport(params)
    case 'page.emulateMedia':
      return emulateMedia(params)
    case 'page.networkConditions':
      return emulateNetwork(params)
    case 'page.geolocation':
      return setGeolocation(params)
    case 'page.timezone':
      return setTimezone(params)
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
    case 'session.reload':
      return reloadExtension()
    case 'page.focus':
      return focusPage(params)
    default:
      throw new Error(`unknown method ${JSON.stringify(method)}`)
  }
}

/**
 * Reload this extension so a freshly edited worker takes effect.
 *
 * The answer is written to the socket before the worker dies — the delay is
 * what makes that true — but the connection still drops, so the caller has to
 * wait for the new client to appear rather than for a second reply.
 * @returns {{ reloading: true }}
 */
function reloadExtension() {
  setTimeout(() => {
    try {
      chrome.runtime.reload()
    } catch {
      // Nothing to report: the socket is about to close either way, and the
      // caller learns the outcome from whether a new client shows up.
    }
  }, 300)
  return { reloading: true }
}

async function focusPage(params = {}) {  const tab = await resolveTab(params)
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

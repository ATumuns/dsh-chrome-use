/**
 * Dialog regression test.
 *
 * A JavaScript dialog pauses the renderer, so the CDP command that opened it
 * never settles. Two failure modes came out of that, and both are silent: the
 * per-tab queue stays locked forever, and a later `Page.handleJavaScriptDialog`
 * queues behind the very command it is supposed to unblock. Both are covered
 * here against a stub `chrome.debugger` that behaves like a paused renderer.
 *
 * Run: node test/dialog.test.mjs
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Import a module from this project by relative path (Windows-safe). */
const load = (relative) => import(pathToFileURL(join(root, relative)).href)

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

/**
 * Install a `chrome` stub whose debugger pauses the renderer after the command
 * that opens a dialog: that command never resolves, and every later command on
 * the same tab stays unanswered until the dialog is handled.
 */
function installStub() {
  const listeners = new Set()
  const state = {
    paused: false,
    commands: [],
    dialogsAnswered: [],
  }
  const never = () => new Promise(() => {})

  globalThis.chrome = {
    tabs: {
      get: async (tabId) => ({ id: tabId, url: 'http://stub/', title: 'stub' }),
      query: async () => [],
    },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      onEvent: {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener),
      },
      sendCommand: async (target, method, params) => {
        state.commands.push(method)
        if (method === 'Page.handleJavaScriptDialog') {
          state.dialogsAnswered.push({ accept: params?.accept, promptText: params?.promptText })
          state.paused = false
          for (const listener of listeners) {
            listener(target, 'Page.javascriptDialogClosed', { result: params?.accept })
          }
          return {}
        }
        if (state.paused) return never()
        if (method === 'Runtime.evaluate' && typeof params?.expression === 'string' && params.expression.includes('__openDialog')) {
          state.paused = true
          queueMicrotask(() => {
            for (const listener of listeners) {
              listener(target, 'Page.javascriptDialogOpening', {
                type: 'alert',
                message: 'stub dialog',
                url: 'http://stub/',
              })
            }
          })
          return never()
        }
        return {}
      },
    },
  }
  return state
}

process.stdout.write('dialog handling\n')

const state = installStub()
const { sessionFor, ABANDONED } = await load('extension/lib/cdp.js')
const { handleDialog } = await load('extension/lib/actions.js')

const session = await sessionFor(7)

// --- 1. The opening command abandons instead of hanging ----------------------
const opening = await session.send(
  'Runtime.evaluate',
  { expression: 'window.__openDialog()', returnByValue: true },
  { releaseOnDialog: true },
)
check('command that opens a dialog resolves to ABANDONED', opening === ABANDONED, `got ${String(opening)}`)
check('the dialog is recorded on the session', session.dialog?.type === 'alert', JSON.stringify(session.dialog))

// --- 2. A queued command is refused rather than blocked ----------------------
const started = Date.now()
let blockedMessage = ''
try {
  await session.send('Runtime.evaluate', { expression: '1 + 1', returnByValue: true })
} catch (error) {
  blockedMessage = error instanceof Error ? error.message : String(error)
}
const elapsed = Date.now() - started
check('a command issued while the dialog is up fails fast', elapsed < 2000, `${elapsed}ms`)
check('that failure names the dialog and the way out', /chrome_use_interact action dialog/.test(blockedMessage), blockedMessage)

// --- 3. Answering succeeds even though the opener still holds the queue -----
await handleDialog({ tabId: 7, accept: true })
check('the dialog was answered', state.dialogsAnswered.length === 1, JSON.stringify(state.dialogsAnswered))
check('the answer carried accept=true', state.dialogsAnswered[0]?.accept === true)
check('the session no longer reports a dialog', session.dialog === null)

// --- 4. Recovery: a dialog that opened before the extension attached ---------
// No event ever arrives for it, so the queue is released by the watchdog. One
// timeout is not proof, though: a big page answers slowly too. Only a tab that
// has answered nothing and keeps not answering is treated as dialog-blocked.
//
// The watchdog timer is unref'd so it never keeps the service worker alive. Node
// would exit on the pending await instead of waiting for it, so the test holds a
// referenced timer of its own for the duration.
function keepAlive() {
  const timer = setInterval(() => {}, 500)
  return () => clearInterval(timer)
}

const silent = await sessionFor(8)
state.paused = true
let release = keepAlive()
const firstTry = await silent.send(
  'Runtime.evaluate',
  { expression: 'window.__openDialog()', returnByValue: true },
  { releaseOnDialog: true },
)
release()
check('a watchdog-abandoned command still resolves', firstTry === ABANDONED, `got ${String(firstTry)}`)
check('one timeout does not convict the tab of having a dialog', silent.dialog === null, JSON.stringify(silent.dialog))

release = keepAlive()
const secondTry = await silent.send(
  'Runtime.evaluate',
  { expression: 'window.__openDialog()', returnByValue: true },
  { releaseOnDialog: true },
)
release()
check('the second silent timeout in a row is treated as a dialog', silent.dialog !== null, JSON.stringify(silent.dialog))

// --- 5. A slow page is not a dialog -----------------------------------------
// The same watchdog fires, but this tab answered normally before, so the page is
// alive and merely slow. Refusing later commands would wedge it for good: the
// model would be told to answer a dialog that does not exist, and `action dialog`
// would answer "no dialog is open", leaving no way out.
// The stub pauses every tab globally, so un-pause the renderer before attaching:
// this tab's slowness is driven by `busy` alone.
state.paused = false
const slow = await sessionFor(9)
let busy = false
const normalSend = globalThis.chrome.debugger.sendCommand
globalThis.chrome.debugger.sendCommand = async (target, method, params) => {
  if (busy) return new Promise(() => {})
  return normalSend(target, method, params)
}
await slow.send('Runtime.evaluate', { expression: '1 + 1', returnByValue: true })
busy = true
let abandonRelease = keepAlive()
const slowAnswer = await slow.send(
  'Runtime.evaluate',
  { expression: '1 + 1', returnByValue: true },
  { releaseOnDialog: true },
)
abandonRelease()
check('a slow page abandons the command instead of hanging', slowAnswer === ABANDONED, `got ${String(slowAnswer)}`)
check('a slow page is not reported as a dialog', slow.dialog === null, JSON.stringify(slow.dialog))
busy = false
globalThis.chrome.debugger.sendCommand = normalSend
const afterSlow = await slow.send('Runtime.evaluate', { expression: '2 + 2', returnByValue: true })
check('the tab works again once it catches up', afterSlow !== undefined, String(afterSlow))

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
if (failures > 0) {
  process.stdout.write('dialog: FAILED\n')
  process.exitCode = 1
} else {
  process.stdout.write('dialog: all checks passed\n')
}

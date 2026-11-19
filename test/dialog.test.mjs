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
// No event ever arrives for it, so the queue is released by the watchdog and the
// session records a synthetic dialog the model can still answer.
const silent = await sessionFor(8)
state.paused = true
// The watchdog timer is unref'd so it never keeps the service worker alive. Node
// would exit on the pending await instead of waiting for it, so the test holds a
// referenced timer of its own for the duration.
const keepAlive = setInterval(() => {}, 500)
const watchdogStart = Date.now()
const recovered = await silent.send(
  'Runtime.evaluate',
  { expression: 'window.__openDialog()', returnByValue: true },
  { releaseOnDialog: true },
)
clearInterval(keepAlive)
const watchdogElapsed = Date.now() - watchdogStart
check('a watchdog-abandoned command still resolves', recovered === ABANDONED, `got ${String(recovered)}`)
check('the watchdog fires inside its window', watchdogElapsed >= 11_000 && watchdogElapsed < 16_000, `${watchdogElapsed}ms`)
check('a synthetic dialog is recorded so the next call fails fast', silent.dialog !== null, JSON.stringify(silent.dialog))

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
if (failures > 0) {
  process.stdout.write('dialog: FAILED\n')
  process.exitCode = 1
} else {
  process.stdout.write('dialog: all checks passed\n')
}

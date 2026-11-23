/**
 * Contract test: every bridge method the host tools can send must have a case
 * in the extension's dispatch table, and every tool definition must survive the
 * harness schema gate.
 *
 * The two halves of this project live in separate runtimes — the host bundle in
 * Node and the extension in a service worker — so nothing at load time catches
 * a method name that only one side knows. This test is that check.
 *
 * Run: node test/tool-contract.test.mjs
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

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

/** Method names the host side sends, read from the source the tools actually use. */
async function hostMethods() {
  const source = await readFile(join(root, 'lib', 'tools.js'), 'utf8')
  const found = new Set()
  for (const match of source.matchAll(/'((?:tabs|page|browser|cookies|session)\.[a-zA-Z]+)'/g)) found.add(match[1])
  // Two methods carry no namespace: the status handshake and the storage family,
  // which the extension routes by its own `area` parameter.
  for (const bare of ['status', 'storage']) {
    if (source.includes(`'${bare}'`)) found.add(bare)
  }
  return found
}

/** Method names the extension answers, read from its dispatch switch. */
async function extensionMethods() {
  const source = await readFile(join(root, 'extension', 'lib', 'actions.js'), 'utf8')
  const found = new Set()
  for (const match of source.matchAll(/case '([a-zA-Z.]+)':/g)) found.add(match[1])
  return found
}

process.stdout.write('tool contract\n')

const host = await hostMethods()
const extension = await extensionMethods()

check('host sends a non-empty method set', host.size > 0, `got ${host.size}`)
check('extension answers a non-empty method set', extension.size > 0, `got ${extension.size}`)

const unanswered = [...host].filter((name) => !extension.has(name)).sort()
check(
  'every host method has an extension case',
  unanswered.length === 0,
  `unanswered: ${unanswered.join(', ')}`,
)

const unused = [...extension].filter((name) => !host.has(name) && name !== 'session.detach').sort()
check('no extension case is unreachable from a tool', unused.length === 0, `unused: ${unused.join(', ')}`)

// --- tool definitions -------------------------------------------------------

const { createTools } = await import('../lib/tools.js')

const stubBridge = {
  list: () => [],
  require: () => {
    throw new Error('no browser connected')
  },
  describe: () => ({ clients: [] }),
}
const ctx = { get: () => undefined }

let definitions
try {
  definitions = createTools({
    bridge: stubBridge,
    token: () => 'test-token',
    rotateToken: () => 'test-token',
    endpoint: 'ws://127.0.0.1:0/dsh-chrome-use/bridge',
    ctx,
    log: { info() {}, warn() {}, error() {} },
  })
} catch (error) {
  check('createTools() returns definitions', false, String(error))
  definitions = []
}

check('createTools() returns seven tools', definitions.length === 7, `got ${definitions.length}`)

const expectedNames = [
  'chrome_use_status',
  'chrome_use_tabs',
  'chrome_use_navigate',
  'chrome_use_snapshot',
  'chrome_use_interact',
  'chrome_use_read',
  'chrome_use_capture',
]
check(
  'tool names and order are stable',
  definitions.map((tool) => tool.name).join(',') === expectedNames.join(','),
  definitions.map((tool) => tool.name).join(','),
)

for (const tool of definitions) {
  check(`${tool.name} has a description`, typeof tool.description === 'string' && tool.description.length > 40)
  check(`${tool.name} declares an object parameter schema`, tool.parameters?.type === 'object')
  check(`${tool.name} renders text`, typeof tool.output?.render === 'function')
  check(`${tool.name} executes`, typeof tool.execute === 'function')
}

// The harness rejects tool names reserved by the PTC presentation transport.
check('no tool claims the reserved name run_code', !definitions.some((tool) => tool.name === 'run_code'))

// --- dialog answer field ----------------------------------------------------
//
// Chrome's Page.handleJavaScriptDialog names the answer `promptText`. `text` is
// the `type` action's field, so action dialog must refuse it loudly instead of
// dropping it and leaving the prompt empty.

const sentCalls = []
const answeringBridge = {
  list: () => [],
  describe: () => ({ clients: [] }),
  require: () => ({
    call: async (method, params) => {
      sentCalls.push({ method, params })
      return { tabId: 1, accepted: true, type: 'prompt', message: '' }
    },
  }),
}
const interact = createTools({
  bridge: answeringBridge,
  token: () => 'test-token',
  rotateToken: () => 'test-token',
  endpoint: 'ws://127.0.0.1:0/dsh-chrome-use/bridge',
  ctx,
  log: { info() {}, warn() {}, error() {} },
}).find((tool) => tool.name === 'chrome_use_interact')

const dialogSchema = interact.parameters.properties
check('action dialog documents promptText as its answer field', /promptText/.test(dialogSchema.promptText?.description ?? ''))
check(
  'the text field points dialog answers at promptText',
  /promptText/.test(dialogSchema.text?.description ?? ''),
  dialogSchema.text?.description,
)

await interact.execute({ action: 'dialog', accept: true, promptText: 'DSH' }, {})
check(
  'action dialog forwards promptText to Chrome',
  sentCalls.at(-1)?.params?.promptText === 'DSH',
  JSON.stringify(sentCalls.at(-1)?.params),
)

let refusedText = null
try {
  await interact.execute({ action: 'dialog', accept: true, text: 'DSH' }, {})
} catch (error) {
  refusedText = error
}
check(
  'action dialog refuses the type field instead of ignoring it',
  refusedText !== null && /promptText/.test(String(refusedText)),
  refusedText === null ? 'it was accepted silently' : String(refusedText),
)
check(
  'the refusal leaves the prompt unanswered',
  sentCalls.at(-1)?.params?.promptText === 'DSH',
  JSON.stringify(sentCalls.at(-1)?.params),
)

// The options page tells the user which tool to run; it drifted once already
// (it named eight tools that never existed and a retired fixed port), and a
// wrong instruction there is invisible until someone is already stuck.
const optionsHtml = await readFile(join(root, 'extension', 'options.html'), 'utf8')
const namedTools = [...new Set(optionsHtml.match(/chrome_use_[a-z_]+/g) ?? [])]
const toolNames = definitions.map((definition) => definition.name)
check('the options page names at least one tool', namedTools.length > 0, namedTools.join(', '))
check(
  'every tool the options page names actually exists',
  namedTools.every((name) => toolNames.includes(name)),
  `not defined: ${namedTools.filter((name) => !toolNames.includes(name)).join(', ')}`,
)
// 1.0.2 moved the bridge to a fixed port; the page kept advertising the
// pre-1.0.2 one that only ever answered on the DSH web server.
const { SETTINGS_DEFAULTS } = await import('../lib/settings.js')
check(
  'the options page advertises the port the bridge really listens on',
  optionsHtml.includes(`127.0.0.1:${SETTINGS_DEFAULTS.port}/dsh-chrome-use/bridge`),
  `expected 127.0.0.1:${SETTINGS_DEFAULTS.port}; page says ${/ws:\/\/[^<\s]+/.exec(optionsHtml)?.[0] ?? 'nothing'}`,
)

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
if (failures > 0) process.exitCode = 1
else process.stdout.write('tool-contract: all checks passed\n')

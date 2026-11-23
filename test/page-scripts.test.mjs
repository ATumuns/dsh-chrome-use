/**
 * Page-script regression tests.
 *
 * These scripts are strings evaluated inside the page, so the failures that hurt
 * are the ones a stub cannot see: an algorithmic blow-up that only shows on a
 * real document, and a null document mid-navigation. Both were found by driving
 * a real Chrome against a large fixture, and both are cheap to lock down here by
 * inspecting the generated source.
 *
 * Run: node test/page-scripts.test.mjs
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
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

process.stdout.write('page scripts\n')

const { markdownScript, snapshotScript, lazyScrollScript, tableScript } = await load('extension/lib/page-scripts.js')

const md = markdownScript({ selector: null, maxChars: 20_000 })

// --- 1. markdown must stay linear in the number of emitted lines -------------
// Rebuilding the joined string on every push made the walk quadratic: fine on a
// five-line page, and long past any sane timeout on a real one.
check('markdown keeps a running character count', /outChars \+= /.test(md), 'no running count found')
check(
  'markdown does not re-join the buffer inside push',
  !/out\.push\(trimmed\);\s*\n\s*if \(out\.join\(/.test(md),
  'push still rebuilds the string to measure it',
)
check(
  'markdown stops the walk once the budget is spent',
  /if \(outChars > OPT\.maxChars\) \{ truncated = true; return; \}/.test(md),
  'the walk no longer short-circuits on the character budget',
)

// --- 2. A document that is still navigating is a state, not a crash ----------
check('markdown tolerates a missing documentElement', /if \(!document\.documentElement\) return null;/.test(md))
check('markdown says the page is still navigating', /still navigating/.test(md))
check('markdown still reports a selector that matched nothing', /selector matched nothing/.test(md))

const snap = snapshotScript({ selector: null, interactiveOnly: false, maxNodes: 100, maxText: 80, frames: true })
check('snapshot says the page is still navigating', /still navigating/.test(snap))
check('snapshot still reports a selector that matched nothing', /selector matched nothing/.test(snap))

// --- 3. The lazy-scroll pass keeps its stop condition ------------------------
// "Reached the bottom" is not the same as "nothing new appeared": an infinite
// list grows after the last scroll, so the pass has to settle once more and see
// no growth before it may stop.
const lazy = lazyScrollScript({ settleMs: 100, maxSteps: 10 })
check('lazy scroll scrolls the window', /window\.scrollTo\(0,/.test(lazy))
check('lazy scroll re-reads the document height after each step', /scrollHeight/.test(lazy))
check('lazy scroll requires a settled height before stopping', /!grew/.test(lazy), 'no growth check found')
// The cap is baked in as a literal, so assert the interpolation reached the source.
check('lazy scroll bakes in the step cap', /if \(steps >= 10\)/.test(lazy), 'cap literal missing from the emitted source')

// --- 4. The table reader keeps its caps in the emitted source ----------------
const tables = tableScript({ selector: null, maxTables: 3, maxRows: 5 })
check('table honours maxTables', /OPT\.maxTables/.test(tables))
check('table honours maxRows', /OPT\.maxRows/.test(tables))

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
if (failures > 0) {
  process.stdout.write('page-scripts: FAILED\n')
  process.exitCode = 1
} else {
  process.stdout.write('page-scripts: all checks passed\n')
}

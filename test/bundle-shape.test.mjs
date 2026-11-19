/**
 * The bundle's export shape, as the loader sees it.
 *
 * `cordis-plugin-loader` imports the package and then calls `unwrapExports`,
 * which resolves `exports.default ?? exports` and keeps only that object. Every
 * named export is discarded. That makes a schema reachable by name but not by
 * `default` invisible to Cordis: `runtime.Config` ends up undefined, the loader
 * skips validation, and an invalid settings patch is written to the profile.
 *
 * This file pins the shape so that mistake cannot come back.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const namespace = await import(pathToFileURL(join(root, 'lib/index.js')).href)

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

/** Mirrors Loader#unwrapExports at cordis-plugin-loader/lib/index.js:811-818. */
function unwrapExports(exports) {
  if (exports === null || exports === undefined) return exports
  let value = exports.default ?? exports
  if (!value.__esModule) return value
  return value.default ?? value
}

const plugin = unwrapExports(namespace)

check('the loader finds apply on the unwrapped plugin', () => {
  assert.equal(typeof plugin.apply, 'function')
})

check('the loader finds the name the patch row depends on', () => {
  assert.equal(plugin.name, 'dsh-chrome-use')
})

check('the loader finds the required services', () => {
  assert.deepEqual(plugin.inject, ['tools', 'webServer'])
})

check('the unwrapped plugin carries Config, or the loader skips validation', () => {
  assert.notEqual(plugin.Config, undefined, 'default export must carry Config; the loader drops named exports')
  assert.equal(typeof plugin.Config['~standard'].validate, 'function')
})

check('the schema rejects an unknown tool name', () => {
  const result = plugin.Config['~standard'].validate({ disabledTools: ['nope'] })
  assert.ok(Array.isArray(result.issues), 'expected issues for an unknown tool name')
  assert.match(result.issues[0].message, /unknown tool/)
})

check('the schema rejects an unknown key', () => {
  const result = plugin.Config['~standard'].validate({ nope: 1 })
  assert.ok(Array.isArray(result.issues), 'expected issues for an unknown key')
  assert.match(result.issues[0].message, /unexpected key/)
})

check('the schema accepts a valid config', () => {
  const result = plugin.Config['~standard'].validate({ readOnly: true, disabledTools: ['chrome_use_capture'] })
  assert.equal(result.issues, undefined)
  assert.equal(result.value.readOnly, true)
})

check('the named export matches the default for callers that import it directly', () => {
  assert.equal(namespace.Config, plugin.Config)
})

if (process.exitCode === 1) {
  console.error(`bundle-shape: ${checks} checks passed before a failure`)
} else {
  console.log(`bundle-shape: all ${checks} checks passed`)
}

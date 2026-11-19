/**
 * Plugin settings: the same values the DSH plugin page edits, the tools read,
 * and the bundle patch persists.
 *
 * The schema is a hand-written Standard Schema instead of a `schemastery`
 * import, because a locally installed bundle cannot resolve `@deepseek-ai/*`
 * from the profile's node_modules. `resolveConfig` only requires the
 * `'~standard'.validate` entry point, so this shape is enough for the loader
 * to reject a bad patch row and for `configEditor.edit` to refuse a bad write.
 *
 * @module dsh-chrome-use/settings
 */

/** Every tool this bundle can register, in surface order. */
export const TOOL_NAMES = [
  'chrome_use_status',
  'chrome_use_tabs',
  'chrome_use_navigate',
  'chrome_use_snapshot',
  'chrome_use_interact',
  'chrome_use_read',
  'chrome_use_capture',
]

/** Tools that cannot change anything, so read-only mode keeps them. */
export const READ_ONLY_TOOLS = [
  'chrome_use_status',
  'chrome_use_tabs',
  'chrome_use_snapshot',
  'chrome_use_read',
  'chrome_use_capture',
]

/** Effective values when the patch row carries no config. */
export const SETTINGS_DEFAULTS = Object.freeze({
  token: undefined,
  tools: true,
  prompt: true,
  readOnly: false,
  allowEvaluation: true,
  disabledTools: Object.freeze([]),
})

/**
 * Coerce one patch row's raw config into the effective shape.
 * @param {unknown} raw
 * @returns {{ token?: string, tools: boolean, prompt: boolean, readOnly: boolean, allowEvaluation: boolean, disabledTools: string[] }}
 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const disabled = Array.isArray(source.disabledTools)
    ? source.disabledTools.filter((name) => typeof name === 'string' && name.length > 0)
    : []
  return {
    token: typeof source.token === 'string' && source.token.length > 0 ? source.token : undefined,
    tools: source.tools !== false,
    prompt: source.prompt !== false,
    readOnly: source.readOnly === true,
    allowEvaluation: source.allowEvaluation !== false,
    disabledTools: [...new Set(disabled)],
  }
}

/**
 * Drop every value that already equals its default, so the patch row stays a
 * record of deviations instead of a snapshot of the whole config.
 * @param {ReturnType<typeof normalizeSettings>} values
 * @returns {Record<string, unknown>}
 */
export function compactSettings(values) {
  const out = {}
  if (typeof values.token === 'string' && values.token.length > 0) out.token = values.token
  if (values.tools === false) out.tools = false
  if (values.prompt === false) out.prompt = false
  if (values.readOnly === true) out.readOnly = true
  if (values.allowEvaluation === false) out.allowEvaluation = false
  if (Array.isArray(values.disabledTools) && values.disabledTools.length > 0) {
    out.disabledTools = [...values.disabledTools]
  }
  return out
}

/**
 * Merge an edit from the plugin page onto the current raw config.
 * @param {unknown} current raw config of the patch row
 * @param {unknown} patch partial values from the page
 * @returns {Record<string, unknown>} the next raw config
 */
export function mergeSettings(current, patch) {
  const before = normalizeSettings(current)
  const incoming = patch !== null && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const next = { ...before }
  for (const key of ['token', 'tools', 'prompt', 'readOnly', 'allowEvaluation', 'disabledTools']) {
    if (Object.hasOwn(incoming, key)) next[key] = incoming[key]
  }
  return compactSettings(normalizeSettings(next))
}

/** Tool names that survive the current settings. */
export function activeToolNames(settings) {
  if (!settings.tools) return []
  const allowed = settings.readOnly ? new Set(READ_ONLY_TOOLS) : new Set(TOOL_NAMES)
  return TOOL_NAMES.filter((name) => allowed.has(name) && !settings.disabledTools.includes(name))
}

const KNOWN_KEYS = new Set(['token', 'tools', 'prompt', 'readOnly', 'allowEvaluation', 'disabledTools'])

/**
 * Validate one raw config value.
 * @param {unknown} value
 * @returns {{ value: ReturnType<typeof normalizeSettings> } | { issues: Array<{ message: string, path?: string[] }> }}
 */
function validate(value) {
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    return { issues: [{ message: 'expected an object' }] }
  }
  const source = value ?? {}
  const issues = []
  for (const key of Object.keys(source)) {
    if (!KNOWN_KEYS.has(key)) issues.push({ message: `unexpected key ${JSON.stringify(key)}`, path: [key] })
  }
  if (source.token !== undefined && typeof source.token !== 'string') {
    issues.push({ message: 'expected a string', path: ['token'] })
  }
  for (const key of ['tools', 'prompt', 'readOnly', 'allowEvaluation']) {
    if (source[key] !== undefined && typeof source[key] !== 'boolean') {
      issues.push({ message: 'expected a boolean', path: [key] })
    }
  }
  if (source.disabledTools !== undefined) {
    if (!Array.isArray(source.disabledTools)) {
      issues.push({ message: 'expected an array of tool names', path: ['disabledTools'] })
    } else {
      for (const name of source.disabledTools) {
        if (typeof name !== 'string') issues.push({ message: 'expected a string', path: ['disabledTools'] })
        else if (!TOOL_NAMES.includes(name)) issues.push({ message: `unknown tool ${JSON.stringify(name)}`, path: ['disabledTools'] })
      }
    }
  }
  if (issues.length > 0) return { issues }
  return { value: normalizeSettings(source) }
}

/** Standard Schema entry point consumed by the Cordis loader. */
export const Config = { '~standard': { version: 1, vendor: 'dsh-chrome-use', validate } }

/**
 * Argument validation for plain-object tool definitions.
 *
 * `ctx.tools.register` with a hand-built definition validates only
 * `output.schema`; the model's arguments reach `execute` verbatim. Every tool
 * therefore validates its own input here, using errors that name the offending
 * field so a retrying model can correct itself without guessing.
 *
 * Absent arguments are OPTIONAL by default and yield the reader's `fallback`
 * (usually `undefined`). A reader only throws when its spec says
 * `required: true`, because most tool parameters are conditional: `url` and
 * `direction` are exclusive in a navigate, `value` only exists for a select,
 * and `browser` is omitted whenever one browser is attached. Treating every
 * parameter as mandatory would reject those perfectly valid calls.
 *
 * @module dsh-chrome-use/lib/validate
 */

/** Raised when a tool receives arguments it cannot honor. */
export class ArgsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ArgsError'
    this.code = 'INVALID_ARGS'
  }
}

/**
 * Decide what an absent argument means for one reader.
 * @param {Record<string, unknown>} args
 * @param {string} key
 * @param {{ tool: string, required?: boolean, fallback?: unknown }} spec
 * @returns {{ absent: true, value: unknown } | { absent: false }}
 */
function absent(args, key, spec) {
  if (args[key] !== undefined) return { absent: false }
  if (spec.required === true) throw new ArgsError(`${spec.tool}: missing required argument "${key}".`)
  return { absent: true, value: spec.fallback }
}

/**
 * Reject unknown keys, then check required ones.
 * @param {unknown} args Parsed model arguments.
 * @param {{ allowed: string[], required?: string[], tool: string }} spec
 * @returns {Record<string, unknown>} The argument bag as a plain object.
 */
export function assertArguments(args, spec) {
  if (args === undefined || args === null) args = {}
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new ArgsError(`${spec.tool}: arguments must be an object.`)
  }
  const allowed = new Set(spec.allowed)
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new ArgsError(
        `${spec.tool}: unknown argument "${key}". Allowed: ${spec.allowed.length === 0 ? '(none)' : spec.allowed.join(', ')}.`,
      )
    }
  }
  for (const key of spec.required ?? []) {
    if (args[key] === undefined) throw new ArgsError(`${spec.tool}: missing required argument "${key}".`)
  }
  return args
}

/**
 * Require a string argument inside an optional enumeration.
 * @param {Record<string, unknown>} args
 * @param {string} key
 * @param {{ tool: string, values?: readonly string[], fallback?: string, required?: boolean }} spec
 */
export function readEnum(args, key, spec) {
  const missing = absent(args, key, spec)
  if (missing.absent) return missing.value
  const raw = args[key]
  if (typeof raw !== 'string') throw new ArgsError(`${spec.tool}: "${key}" must be a string.`)
  if (spec.values && !spec.values.includes(raw)) {
    throw new ArgsError(`${spec.tool}: "${key}" must be one of ${spec.values.join(', ')} (got "${raw}").`)
  }
  return raw
}

/**
 * Require a string argument.
 * @returns {string | undefined}
 */
export function readString(args, key, spec) {
  const missing = absent(args, key, spec)
  if (missing.absent) return missing.value
  const raw = args[key]
  if (typeof raw !== 'string') throw new ArgsError(`${spec.tool}: "${key}" must be a string.`)
  if (spec.maxLength !== undefined && raw.length > spec.maxLength) {
    throw new ArgsError(`${spec.tool}: "${key}" exceeds ${spec.maxLength} characters.`)
  }
  return raw
}

/** Require an integer argument, optionally bounded. */
export function readInteger(args, key, spec) {
  const missing = absent(args, key, spec)
  if (missing.absent) return missing.value
  const raw = args[key]
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new ArgsError(`${spec.tool}: "${key}" must be an integer.`)
  }
  if (spec.min !== undefined && raw < spec.min) {
    throw new ArgsError(`${spec.tool}: "${key}" must be >= ${spec.min}.`)
  }
  if (spec.max !== undefined && raw > spec.max) {
    throw new ArgsError(`${spec.tool}: "${key}" must be <= ${spec.max}.`)
  }
  return raw
}

/** Require a boolean argument. */
export function readBoolean(args, key, spec) {
  const missing = absent(args, key, spec)
  if (missing.absent) return missing.value
  const raw = args[key]
  if (typeof raw !== 'boolean') throw new ArgsError(`${spec.tool}: "${key}" must be a boolean.`)
  return raw
}

/** Require a number argument, optionally bounded. */
export function readNumber(args, key, spec) {
  const missing = absent(args, key, spec)
  if (missing.absent) return missing.value
  const raw = args[key]
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new ArgsError(`${spec.tool}: "${key}" must be a number.`)
  if (spec.min !== undefined && raw < spec.min) throw new ArgsError(`${spec.tool}: "${key}" must be >= ${spec.min}.`)
  if (spec.max !== undefined && raw > spec.max) throw new ArgsError(`${spec.tool}: "${key}" must be <= ${spec.max}.`)
  return raw
}

/** Require a plain object argument, passed through unchanged. */
export function readObject(args, key, spec) {
  const missing = absent(args, key, spec)
  if (missing.absent) return missing.value
  const raw = args[key]
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ArgsError(`${spec.tool}: "${key}" must be an object.`)
  }
  return raw
}

/** Require an array argument, optionally of strings. */
export function readArray(args, key, spec) {
  const missing = absent(args, key, spec)
  if (missing.absent) return missing.value
  const raw = args[key]
  if (!Array.isArray(raw)) throw new ArgsError(`${spec.tool}: "${key}" must be an array.`)
  if (spec.of === 'string' && raw.some((item) => typeof item !== 'string')) {
    throw new ArgsError(`${spec.tool}: "${key}" must contain only strings.`)
  }
  if (spec.of === 'number' && raw.some((item) => typeof item !== 'number' || !Number.isInteger(item))) {
    throw new ArgsError(`${spec.tool}: "${key}" must contain only integers.`)
  }
  return raw
}

/** Resolve a tab selector from `tabId` (preferred) or `tab` (id/url/title match). */
export function readTabSelector(args, spec) {
  const tabId = args.tabId
  const tab = args.tab
  if (tabId !== undefined) {
    return { tabId: readInteger(args, 'tabId', { tool: spec.tool, min: 0 }) }
  }
  if (tab !== undefined) {
    if (typeof tab === 'number' && Number.isInteger(tab) && tab >= 0) return { tabId: tab }
    if (typeof tab === 'string' && tab.length > 0) return { tab }
    throw new ArgsError(`${spec.tool}: "tab" must be a tab id (integer) or a url/title substring.`)
  }
  return {}
}

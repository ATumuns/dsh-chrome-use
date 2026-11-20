/**
 * The one place that answers "what is this plugin doing right now", for both
 * the browser-extension tools and the DSH plugin page.
 *
 * Settings live in this bundle's configuration row and nowhere else. A change
 * is persisted through `configEditor`, which rewrites the patch row, validates
 * against `Config`, and lets the loader reload this bundle; the reloaded plugin
 * is what the page sees on its next poll. Nothing is mutated optimistically — a
 * failed write leaves the running plugin exactly as it was.
 *
 * @module dsh-chrome-use/control
 */
import { readFileSync, statSync } from 'node:fs'
import { tokensEqual } from './bridge.js'
import { activeToolNames, Config, mergeSettings, normalizeSettings, TOOL_NAMES, TOOL_SUMMARIES } from './settings.js'
import { tokenFilePath } from './token-store.js'

/** Settings keys a patch may carry, in the order the page shows them. */
const PATCH_KEYS = new Set(['token', 'tools', 'prompt', 'readOnly', 'allowEvaluation', 'disabledTools', 'port', 'host'])

/** An error the route layer turns into a specific status code. */
function refusal(status, message) {
  return Object.assign(new Error(message), { status })
}

/**
 * Read the package version without a JSON import assertion.
 *
 * This cannot be a module constant: a bundle reload re-runs `apply` but not the
 * ESM module bodies, so a value captured at import time keeps reporting the
 * version that was on disk when the process started. It is cached against the
 * file's mtime instead, so an upgrade shows up on the next snapshot without
 * paying a read every four seconds.
 */
let versionCache = { mtimeMs: -1, version: '0.0.0' }

function packageVersion() {
  try {
    const url = new URL('../package.json', import.meta.url)
    const { mtimeMs } = statSync(url)
    if (mtimeMs !== versionCache.mtimeMs) {
      versionCache = { mtimeMs, version: JSON.parse(readFileSync(url, 'utf8')).version ?? '0.0.0' }
    }
    return versionCache.version
  } catch {
    return '0.0.0'
  }
}

/**
 * Build the controller for one plugin instance.
 *
 * @param {{
 *   ctx: any,
 *   bridge: import('./bridge.js').Bridge,
 *   log: { warn: (message: string) => void, info: (message: string) => void },
 *   settings: () => ReturnType<typeof normalizeSettings>,
 *   token: () => string,
 *   tokenSource: () => string,
 *   rotateToken: () => string,
 *   endpoint: () => string,
 *   capabilities: Record<string, unknown>,
 * }} deps
 */
export function createControl(deps) {
  const { ctx, bridge, log, settings, token, tokenSource, rotateToken, endpoint, capabilities } = deps

  /** @type {{ scope: string, message: string, at: string } | undefined} */
  let lastError
  /** @type {boolean | 'pending' | { error: string }} */
  let persisted = true

  /** Locate this bundle's own profile patch row, if the profile has one. */
  function ownEntry() {
    const editor = ctx.get('configEditor')
    if (!editor) return { editor: undefined, entry: undefined }
    const entry = ctx.fiber?.entry
    return { editor, entry }
  }

  /**
   * Persist a settings patch through the profile, which reloads this bundle.
   *
   * The patch is checked here before the profile is touched, for two reasons.
   * `mergeSettings` copies only the keys it knows, so an unknown key would be
   * dropped silently and the caller would be told the write succeeded. And the
   * schema that actually guards this row is `Config`, reached through the
   * loader — a value it rejects must come back as a client error, not as the
   * 500 an unhandled throw would produce.
   *
   * @param {Record<string, unknown>} patch
   */
  async function updateSettings(patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw refusal(400, 'settings must be a JSON object')
    }
    const unexpected = Object.keys(patch).filter((key) => !PATCH_KEYS.has(key))
    if (unexpected.length > 0) {
      throw refusal(400, `unknown setting ${unexpected.map((key) => JSON.stringify(key)).join(', ')}; known settings are ${[...PATCH_KEYS].join(', ')}`)
    }
    const { editor, entry } = ownEntry()
    if (!editor || !entry) {
      throw refusal(503, 'this profile does not expose its configuration rows, so settings cannot be saved; set them in the profile cordis.patch.yml instead')
    }
    const current = normalizeSettings({ ...settings(), ...entry.options?.config })
    const next = mergeSettings(current, patch)
    const checked = Config['~standard'].validate(next)
    if (checked.issues) {
      const detail = checked.issues
        .map((issue) => `${issue.message}${issue.path === undefined ? '' : ` (at ${issue.path.join('.')})`}`)
        .join('; ')
      throw refusal(400, `invalid config: ${detail}`)
    }
    persisted = 'pending'
    try {
      await editor.edit(entry, () => next)
      persisted = true
      lastError = undefined
      log.info('dsh-chrome-use: settings saved; the plugin reloads with them')
      return next
    } catch (error) {
      persisted = { error: error instanceof Error ? error.message : String(error) }
      lastError = { scope: 'settings', message: String(persisted.error), at: new Date().toISOString() }
      // The editor runs the row through the same schema, and it can also refuse
      // a row a home patch overrides; both are the caller's problem, not a bug.
      throw refusal(400, String(persisted.error))
    }
  }

  /** A snapshot the plugin page renders; cheap enough to poll. */
  function snapshot() {
    const live = settings()
    const browsers = bridge.describe()
    const active = new Set(activeToolNames(live))
    return {
      version: packageVersion(),
      endpoint: endpoint(),
      token: token(),
      tokenSource: tokenSource(),
      tokenPath: tokenFilePath(),
      connected: browsers.length > 0,
      browsers,
      settings: {
        tools: live.tools,
        prompt: live.prompt,
        readOnly: live.readOnly,
        allowEvaluation: live.allowEvaluation,
        disabledTools: [...live.disabledTools],
        port: live.port,
        host: live.host,
        tokenConfigured: typeof live.token === 'string' && live.token.length > 0,
      },
      tools: TOOL_NAMES.map((name) => ({
        name,
        summary: TOOL_SUMMARIES[name] ?? null,
        enabled: active.has(name),
        reason: active.has(name)
          ? null
          : live.tools === false
            ? 'tools are off for this bundle'
            : live.disabledTools.includes(name)
              ? 'disabled in settings'
              : 'hidden because read-only mode keeps only observers',
      })),
      capabilities,
      persisted,
      ...(lastError === undefined ? {} : { lastError }),
    }
  }

  return {
    snapshot,
    updateSettings,
    rotateToken,
    settings,
    /**
     * Compare a presented pairing token against the live one.
     *
     * The route layer uses this to let a local caller that holds the pairing
     * token read and change the same state the plugin page shows. Comparison
     * goes through the bridge's constant-time helper so a wrong token leaks no
     * timing signal about the matching prefix.
     *
     * @param {string} presented
     * @returns {boolean}
     */
    tokenMatches(presented) {
      const expected = token()
      if (typeof presented !== 'string' || typeof expected !== 'string') return false
      if (presented.length !== expected.length) return false
      return tokensEqual(presented, expected)
    },
    get lastError() { return lastError },
  }
}

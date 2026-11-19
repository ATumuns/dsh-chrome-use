/**
 * Pairing-token persistence.
 *
 * The token has to survive plugin reloads: the extension stores it in
 * `chrome.storage`, so a freshly generated token would silently break a
 * working connection every time this bundle is re-enabled. The file lives
 * under `$DSH_HOME/dsh-chrome-use/token`, created with owner-only permissions.
 *
 * @module dsh-chrome-use/token-store
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const FILE_MODE = 0o600

/** Resolve the DSH home the same way the harness does. */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return join(homedir(), '.dsh')
}

/** Absolute path of the persisted token file. */
export function tokenFilePath() {
  return join(dshHome(), 'dsh-chrome-use', 'token')
}

/**
 * Read the persisted token.
 * @returns {string | undefined} the stored token, or undefined when absent or unreadable.
 */
export function readToken() {
  try {
    const text = readFileSync(tokenFilePath(), 'utf8').trim()
    return text.length > 0 ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist a token, replacing any previous value.
 * A filesystem failure is reported to the caller, which decides whether the
 * in-memory token is still good enough to serve this session.
 * @param {string} token
 */
export function writeToken(token) {
  const path = tokenFilePath()
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${token}\n`, { mode: FILE_MODE })
  try {
    chmodSync(path, FILE_MODE)
  } catch {
    // Windows ignores POSIX modes; the write already happened.
  }
}

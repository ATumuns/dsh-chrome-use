/**
 * The plugin page's three endpoints.
 *
 * They exist because the page is a browser component: it cannot read the
 * profile's patch file or ask the bridge anything, so it polls one route and
 * posts two. Every handler runs the host's own request fence first — the same
 * `connection.requestRejection` the DSH API runs — so a request from another
 * origin, or one without the browser's login cookie, is refused before any
 * plugin state is read.
 *
 * Bodies are bounded and JSON-only. Nothing here writes a file directly:
 * settings changes go through `configEditor`, which owns the patch row, the
 * schema check, the atomic write and the reload.
 *
 * @module dsh-chrome-use/routes
 */

/** Path of the state endpoint the page polls. */
export const STATE_PATH = '/dsh-chrome-use/state'

/** Path that accepts a settings patch. */
export const SETTINGS_PATH = '/dsh-chrome-use/settings'

/** Path that mints a new pairing token. */
export const TOKEN_PATH = '/dsh-chrome-use/token'

const MAX_BODY_BYTES = 16 * 1024

function sendJson(res, status, payload, headOnly = false) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(headOnly ? undefined : body)
}

/**
 * Read a bounded JSON body.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJson(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('request body is too large'), { status: 413 })
    chunks.push(chunk)
  }
  if (total === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw Object.assign(new Error('request body must be a JSON object'), { status: 400 })
    }
    return parsed
  } catch (error) {
    if (error.status !== undefined) throw error
    throw Object.assign(new Error(`request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`), { status: 400 })
  }
}

/**
 * Build the three route handlers.
 *
 * @param {{ ctx: any, control: ReturnType<import('./control.js').createControl>, log: { warn: (message: string) => void } }} deps
 */
export function createRoutes(deps) {
  const { ctx, control, log } = deps

  /** Refuse anything the host's own API would refuse. */
  function rejectionOf(req) {
    const connection = ctx.get('connection')
    const gate = connection?.requestRejection
    if (typeof gate !== 'function') return undefined
    try {
      return gate.call(connection, req)
    } catch {
      return 401
    }
  }

  /**
   * A local process holding the pairing token may read the state without the
   * browser's login cookie.
   *
   * The cookie route is what the plugin page itself uses: it runs inside the
   * Harness web app, so the browser attaches the session cookie automatically.
   * Everything else that legitimately wants this state — a verification
   * script, the extension's own options page, a terminal — has no cookie, and
   * minting one needs a launch token that only exists in the host's memory.
   * The pairing token is the credential those callers already hold: it is
   * written to the profile home with owner-only permissions, it gates the
   * bridge the extension dials out to, and it grants exactly the read this
   * route returns plus the two writes below. It is not a session credential
   * for the rest of the Harness API, and it cannot reach any other route.
   *
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean}
   */
  function tokenAccepted(req) {
    let presented
    try {
      presented = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token')
    } catch {
      return false
    }
    if (typeof presented !== 'string' || presented.length === 0) return false
    try {
      return control.tokenMatches(presented)
    } catch {
      return false
    }
  }

  function fenced(req, res, method, run) {
    const rejection = rejectionOf(req)
    if (rejection !== undefined && !tokenAccepted(req)) {
      res.writeHead(rejection, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    const asked = req.method ?? 'GET'
    if (asked !== method && !(method === 'GET' && asked === 'HEAD')) {
      sendJson(res, 405, { error: `${method} only` })
      return
    }
    Promise.resolve()
      .then(() => run(asked === 'HEAD'))
      .catch((error) => {
        const status = typeof error?.status === 'number' ? error.status : 500
        if (status >= 500) log.warn(`dsh-chrome-use: ${req.url} failed: ${error instanceof Error ? error.message : String(error)}`)
        sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
      })
  }

  return {
    state: {
      kind: 'exact',
      path: STATE_PATH,
      handler: (req, res) => fenced(req, res, 'GET', (headOnly) => {
        sendJson(res, 200, control.snapshot(), headOnly)
      }),
    },
    settings: {
      kind: 'exact',
      path: SETTINGS_PATH,
      handler: (req, res) => fenced(req, res, 'POST', async () => {
        const body = await readJson(req)
        const patch = body.settings !== null && typeof body.settings === 'object' ? body.settings : body
        await control.updateSettings(patch)
        sendJson(res, 200, { saved: true, state: control.snapshot() })
      }),
    },
    token: {
      kind: 'exact',
      path: TOKEN_PATH,
      handler: (req, res) => fenced(req, res, 'POST', async () => {
        const body = await readJson(req)
        if (body.rotate !== true) throw Object.assign(new Error('send {"rotate": true} to mint a new token'), { status: 400 })
        control.rotateToken()
        sendJson(res, 200, { rotated: true, state: control.snapshot() })
      }),
    },
  }
}

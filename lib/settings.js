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

/**
 * One plain-language sentence per tool, for the plugin page.
 *
 * The tool descriptions the model sees are long on purpose — they have to carry
 * every caveat. A human scanning the plugin page needs the opposite, so this
 * table is the short version and lives beside `TOOL_NAMES` to stay in sync.
 */
export const TOOL_SUMMARIES = Object.freeze({
  chrome_use_status: {
    zh: '看浏览器有没有连上、配对令牌是多少、扩展自报的浏览器版本。',
    en: 'Whether a browser is attached, the pairing token, and the browser version the extension reports.',
  },
  chrome_use_tabs: {
    zh: '列出、打开、关闭、切换标签页；改窗口大小、把标签收进标签组，或开一个不抢焦点的后台窗口。',
    en: 'List, open, close and switch tabs; resize windows, group tabs, or open a background window that does not steal focus.',
  },
  chrome_use_navigate: {
    zh: '让指定标签页打开一个网址，或在这页的历史里前进 / 后退。',
    en: 'Load a URL in one tab, or move back / forward through that tab history.',
  },
  chrome_use_snapshot: {
    zh: '把页面读成带 ref 的大纲——标题、按钮、输入框都在里面，影子 DOM 和同源 iframe 也会走进去；后续点击和输入用这些 ref 定位。',
    en: 'Read the page into a ref-annotated outline of headings and controls, including shadow roots and same-origin frames; later actions target those refs.',
  },
  chrome_use_interact: {
    zh: '用真实输入事件操作页面：点击、悬停、输入、按键、下拉、滚动、拖放、批量填表、上传文件、处理弹窗、等待网络空闲、模拟视口 / 网络 / 定位 / 时区，或在需要人工时把控制权交还给你。',
    en: 'Drive the page with real input: click, hover, type, press, select, scroll, drag, batch fill, upload, answer dialogs, wait for idle, emulate viewport / network / location / timezone, or hand control back to you.',
  },
  chrome_use_read: {
    zh: '读页面已经产生的东西：执行表达式、控制台、网络请求与响应体、Storage、Cookie；也能把正文转成 markdown、把表格转成行数据、取性能指标。',
    en: 'Read what the page already produced: evaluate, console, network and response bodies, storage, cookies — plus markdown extraction, table rows and performance metrics.',
  },
  chrome_use_capture: {
    zh: '产出文件：视口 / 整页 / 单个元素的截图、PDF，或让浏览器下载管理器存一个网址。',
    en: 'Produce files: viewport, full-page or single-element screenshots, PDFs, or a download through the browser download manager.',
  },
})

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

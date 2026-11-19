/**
 * The plugin page for DSH-Chrome-Use.
 *
 * Rendered inside the Plugins page by the `plugins.bundle.config` slot, keyed
 * by this package's name. It answers one question the tools cannot: is the
 * bridge actually paired right now, and what is this bundle doing?
 *
 * Three sources, one owner:
 *   - GET  /dsh-chrome-use/state    the live snapshot (bridge, browsers, tools)
 *   - POST /dsh-chrome-use/settings the feature switches
 *   - POST /dsh-chrome-use/token    rotate the pairing token
 *
 * The switches are saved through `configEditor`, which rewrites this bundle's
 * patch row and reloads it. The page therefore never mutates its own snapshot;
 * it re-reads until the reloaded plugin answers with the new values.
 *
 * Self-contained by necessity: a locally installed bundle may only `require`
 * what the browser module table exposes, so this file uses `react` alone, no
 * Harness UI package, no CSS file, and no locale service — the two dictionaries
 * below are selectable from the document language.
 */
window.__ModuleLoader__.load({
  id: 'dsh-chrome-use',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement
    const { useCallback, useEffect, useRef, useState } = react

    const NAME = 'dsh-chrome-use'
    const STATE_ROUTE = '/dsh-chrome-use/state'
    const SETTINGS_ROUTE = '/dsh-chrome-use/settings'
    const TOKEN_ROUTE = '/dsh-chrome-use/token'
    const POLL_MS = 4000

    const TEXT = {
      zh: {
        title: '浏览器连接',
        subtitle: 'DSH 通过本插件驱动你自己的 Chrome。扩展拨入下面的回环地址，配对令牌是唯一凭据。',
        refresh: '刷新',
        saving: '保存中…',
        saved: '已保存，插件正在重载',
        saveFailed: '保存失败',
        stateFailed: '读不到插件状态',
        connected: '已连接',
        offline: '未连接',
        offlineHint: '在 chrome://extensions 加载 extension/ 目录，打开其选项页，粘贴下面的令牌后点连接。',
        endpoint: '桥接地址',
        token: '配对令牌',
        reveal: '显示',
        hide: '隐藏',
        copy: '复制',
        copied: '已复制',
        copyFailed: '复制失败',
        rotate: '换一个令牌',
        rotateHint: '换令牌不会断开现有连接，只让旧令牌无法再完成握手。',
        rotateConfirm: '换一个新令牌？扩展需要重新粘贴才能再次连接。',
        tokenSource: '令牌来源',
        gateTitle: '功能开关',
        toolsMaster: '注册工具',
        toolsMasterHint: '关掉后本插件的七个工具全部从模型面前消失，桥接仍然保持。',
        prompt: '系统提示词段落',
        promptHint: '告诉模型什么时候该用浏览器。关掉后工具仍在，但模型不会被告知。',
        readOnly: '只读模式',
        readOnlyHint: '只保留观察类工具（status / tabs / snapshot / read / capture），去掉导航与交互。',
        allowEvaluation: '允许 evaluate',
        allowEvaluationHint: '关掉后 chrome_use_read evaluate 会拒绝执行，其余读取不受影响。',
        perTool: '单个工具',
        inventoryTitle: '功能清单',
        does: '功能',
        statusTitle: '运行状态',
        browsers: '已连接浏览器',
        noBrowser: '尚无浏览器接入',
        lastSeen: '接入时间',
        commands: '在途命令',
        version: '版本',
        capabilities: '扩展能力',
        persisted: '配置状态',
        persistedTrue: '已写入 profile',
        persistedPending: '等待写入',
        lastError: '最近错误',
        tokenPath: '令牌文件',
        on: '开',
        off: '关',
        enabled: '可用',
        disabled: '已关闭',
        save: '保存开关',
        reset: '还原',
        unsaved: '有未保存的改动',
      },
      en: {
        title: 'Browser connection',
        subtitle: 'DSH drives your own Chrome through this bundle. The extension dials the loopback address below; the pairing token is the only credential.',
        refresh: 'Refresh',
        saving: 'Saving…',
        saved: 'Saved — the plugin is reloading',
        saveFailed: 'Save failed',
        stateFailed: 'Could not read plugin state',
        connected: 'Connected',
        offline: 'Not connected',
        offlineHint: 'Load the extension/ folder in chrome://extensions, open its options page, paste the token below and press connect.',
        endpoint: 'Bridge endpoint',
        token: 'Pairing token',
        reveal: 'Show',
        hide: 'Hide',
        copy: 'Copy',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        rotate: 'Rotate token',
        rotateHint: 'Rotating does not drop a live connection; it only retires the old token for future handshakes.',
        rotateConfirm: 'Mint a new token? The extension must be re-paired to reconnect.',
        tokenSource: 'Token source',
        gateTitle: 'Feature switches',
        toolsMaster: 'Register tools',
        toolsMasterHint: 'Off removes all seven tools from the model surface. The bridge stays up.',
        prompt: 'System prompt section',
        promptHint: 'Tells the model when to reach for the browser. Off keeps the tools but stops the guidance.',
        readOnly: 'Read-only mode',
        readOnlyHint: 'Keeps only observers (status / tabs / snapshot / read / capture) and drops navigation and interaction.',
        allowEvaluation: 'Allow evaluate',
        allowEvaluationHint: 'Off makes chrome_use_read evaluate refuse; every other read still works.',
        perTool: 'Individual tools',
        inventoryTitle: 'Feature inventory',
        does: 'Does',
        statusTitle: 'Runtime state',
        browsers: 'Connected browsers',
        noBrowser: 'No browser attached yet',
        lastSeen: 'since',
        commands: 'commands in flight',
        version: 'Version',
        capabilities: 'Extension capabilities',
        persisted: 'Config state',
        persistedTrue: 'written to the profile',
        persistedPending: 'waiting for the write',
        lastError: 'Last error',
        tokenPath: 'Token file',
        on: 'on',
        off: 'off',
        enabled: 'available',
        disabled: 'disabled',
        save: 'Save switches',
        reset: 'Revert',
        unsaved: 'Unsaved changes',
      },
    }

    function pickLocale() {
      const lang = (document.documentElement && document.documentElement.lang) || navigator.language || 'en'
      return /^zh/i.test(lang) ? 'zh' : 'en'
    }

    function token() {
      pickLocale.cached = pickLocale.cached || pickLocale()
      return TEXT[pickLocale.cached]
    }

    async function getState(signal) {
      const response = await fetch(STATE_ROUTE, {
        signal,
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return await response.json()
    }

    async function post(route, body) {
      const response = await fetch(route, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`)
      return payload
    }

    const CARD = {
      border: '1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,0.14))',
      borderRadius: 10,
      padding: '14px 16px',
      background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.03))',
      marginBottom: 12,
    }
    const LABEL = { color: 'var(--dsw-alias-label-secondary, #a9a9a9)', fontSize: 12, marginBottom: 4 }
    const VALUE = { color: 'var(--dsw-alias-label-primary, #e9e9e9)', fontSize: 13, wordBreak: 'break-all' }
    const MONO = { ...VALUE, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
    const BUTTON = {
      border: '1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,0.18))',
      borderRadius: 7,
      padding: '5px 11px',
      font: 'inherit',
      fontSize: 12,
      cursor: 'pointer',
      color: 'var(--dsw-alias-label-primary, #e9e9e9)',
      background: 'var(--dsw-alias-bg-secondary, rgba(255,255,255,0.06))',
    }
    const PRIMARY = {
      ...BUTTON,
      border: '1px solid transparent',
      color: '#fff',
      background: 'var(--dsw-alias-label-brand, #4f8cff)',
    }
    const ROW = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }
    const PILL = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      borderRadius: 999,
      padding: '2px 10px',
      fontSize: 12,
      border: '1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,0.18))',
    }
    const DOT = (ok) => ({
      width: 8,
      height: 8,
      borderRadius: 999,
      background: ok ? 'var(--dsw-alias-state-business-primary, #3fb950)' : 'var(--dsw-alias-state-error-primary, #d1242f)',
    })

    function Field(props) {
      return h('div', { style: { marginBottom: 10 } },
        h('div', { style: LABEL }, props.label),
        h('div', { style: props.mono ? MONO : VALUE }, props.children))
    }

    function Switch(props) {
      const disabled = props.disabled === true
      return h('label', {
        style: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1 },
        title: props.hint || '',
      },
      h('input', {
        type: 'checkbox',
        checked: props.checked === true,
        disabled,
        onChange: (event) => props.onChange(event.target.checked),
        style: { marginTop: 2 },
      }),
      h('span', null,
        h('span', { style: { ...VALUE, display: 'block' } }, props.label),
        props.hint ? h('span', { style: { ...LABEL, marginBottom: 0, display: 'block' } }, props.hint) : null))
    }

    function Panel() {
      const t = token()
      const locale = pickLocale.cached
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [draft, setDraft] = useState(null)
      const [revealed, setRevealed] = useState(false)
      const [copied, setCopied] = useState(false)
      const alive = useRef(true)

      const load = useCallback(async () => {
        try {
          const next = await getState()
          if (!alive.current) return
          setData(next)
          setError(null)
        } catch (failure) {
          if (!alive.current) return
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        void load()
        const timer = setInterval(() => { void load() }, POLL_MS)
        return () => { alive.current = false; clearInterval(timer) }
      }, [load])

      // The draft starts as a copy of the saved switches and is replaced when a
      // fresh snapshot disagrees with it and nothing is pending — that is how a
      // completed reload reaches the form without wiping an in-progress edit.
      useEffect(() => {
        if (data === null) return
        setDraft((current) => current === null ? { ...data.settings, disabledTools: [...data.settings.disabledTools] } : current)
      }, [data])

      const dirty = data !== null && draft !== null && (
        draft.tools !== data.settings.tools
        || draft.prompt !== data.settings.prompt
        || draft.readOnly !== data.settings.readOnly
        || draft.allowEvaluation !== data.settings.allowEvaluation
        || draft.disabledTools.length !== data.settings.disabledTools.length
        || draft.disabledTools.some((name) => !data.settings.disabledTools.includes(name))
      )

      const save = useCallback(async () => {
        if (draft === null) return
        setBusy('save')
        setNotice(null)
        try {
          await post(SETTINGS_ROUTE, { settings: draft })
          setNotice({ kind: 'ok', text: t.saved })
          setTimeout(() => { void load() }, 1200)
        } catch (failure) {
          setNotice({ kind: 'error', text: `${t.saveFailed}: ${failure instanceof Error ? failure.message : String(failure)}` })
        } finally {
          setBusy('')
        }
      }, [draft, load, t])

      const rotate = useCallback(async () => {
        if (!window.confirm(t.rotateConfirm)) return
        setBusy('token')
        setNotice(null)
        try {
          const payload = await post(TOKEN_ROUTE, { rotate: true })
          if (payload.state) setData(payload.state)
          setRevealed(true)
        } catch (failure) {
          setNotice({ kind: 'error', text: failure instanceof Error ? failure.message : String(failure) })
        } finally {
          setBusy('')
        }
      }, [t])

      const copy = useCallback(async () => {
        if (!data) return
        try {
          await navigator.clipboard.writeText(data.token)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          setNotice({ kind: 'error', text: t.copyFailed })
        }
      }, [data, t])

      const toggleTool = useCallback((name, enabled) => {
        setDraft((current) => {
          if (current === null) return current
          const others = current.disabledTools.filter((entry) => entry !== name)
          return { ...current, disabledTools: enabled ? others : [...others, name] }
        })
      }, [])

      if (data === null && error === null) {
        return h('div', { style: { ...VALUE, padding: 8 } }, `${t.stateFailed}…`)
      }
      if (data === null) {
        return h('div', { style: { ...CARD, borderColor: 'var(--dsw-alias-state-error-primary, #d1242f)' } },
          h('div', { style: { ...VALUE, marginBottom: 8 } }, `${t.stateFailed}: ${error}`),
          h('button', { type: 'button', style: BUTTON, onClick: () => { void load() } }, t.refresh))
      }

      const settings = draft ?? data.settings
      const browsers = data.browsers || []

      return h('div', null,
        h('div', { style: { ...ROW, justifyContent: 'space-between', marginBottom: 10 } },
          h('div', null,
            h('div', { style: { ...VALUE, fontSize: 15, fontWeight: 600 } }, t.title),
            h('div', { style: { ...LABEL, marginBottom: 0, maxWidth: 620 } }, t.subtitle)),
          h('div', { style: ROW },
            h('span', { style: PILL }, h('span', { style: DOT(data.connected) }), data.connected ? t.connected : t.offline),
            h('button', { type: 'button', style: BUTTON, disabled: busy !== '', onClick: () => { void load() } }, t.refresh))),

        h('div', { style: CARD },
          h('div', { style: { ...ROW, marginBottom: 8 } },
            h('div', { style: { flex: '1 1 260px' } }, h(Field, { label: t.endpoint, mono: true }, data.endpoint)),
            h('div', { style: { flex: '1 1 260px' } }, h(Field, { label: t.version, mono: true }, data.version))),
          h('div', { style: { marginBottom: 8 } },
            h('div', { style: LABEL }, t.token),
            h('div', { style: { ...ROW } },
              h('code', { style: { ...MONO, flex: '1 1 240px' } }, revealed ? data.token : '•'.repeat(Math.min(32, data.token.length))),
              h('button', { type: 'button', style: BUTTON, onClick: () => setRevealed((value) => !value) }, revealed ? t.hide : t.reveal),
              h('button', { type: 'button', style: BUTTON, onClick: () => { void copy() } }, copied ? t.copied : t.copy),
              h('button', { type: 'button', style: BUTTON, disabled: busy !== '', onClick: () => { void rotate() } }, t.rotate)),
            h('div', { style: { ...LABEL, marginTop: 6, marginBottom: 0 } }, t.rotateHint)),
          h('div', { style: ROW },
            h('div', { style: { flex: '1 1 240px' } }, h(Field, { label: t.tokenSource, mono: true }, data.tokenSource)),
            h('div', { style: { flex: '1 1 240px' } }, h(Field, { label: t.tokenPath, mono: true }, data.tokenPath))),
          data.connected ? null : h('div', { style: { ...LABEL, marginTop: 8, marginBottom: 0 } }, t.offlineHint)),

        h('div', { style: CARD },
          h('div', { style: { ...VALUE, fontWeight: 600, marginBottom: 6 } }, t.statusTitle),
          h('div', { style: LABEL }, t.browsers),
          browsers.length === 0
            ? h('div', { style: { ...VALUE, marginBottom: 10 } }, t.noBrowser)
            : h('div', { style: { marginBottom: 10 } }, browsers.map((browser) => {
              const meta = browser.browser || {}
              const bits = [browser.clientId, browser.label, [meta.product, meta.major].filter(Boolean).join(' ')].filter(Boolean).join(' · ')
              return h('div', { key: browser.clientId, style: { ...MONO, marginBottom: 4 } },
                `${bits} — ${t.lastSeen} ${browser.connectedAt} · ${browser.commands} ${t.commands}`)
            })),
          h('div', { style: ROW },
            h('div', { style: { flex: '1 1 240px' } }, h(Field, { label: t.capabilities, mono: true }, Object.entries(data.capabilities || {}).map(([key, value]) => `${key}=${String(value)}`).join(' ') || '—')),
            h('div', { style: { flex: '1 1 240px' } }, h(Field, { label: t.persisted, mono: true },
              data.persisted === true ? t.persistedTrue : data.persisted === 'pending' ? t.persistedPending : `error: ${data.persisted && data.persisted.error}`))),
          data.lastError
            ? h('div', { style: { ...LABEL, color: 'var(--dsw-alias-state-error-primary, #d1242f)', marginTop: 8, marginBottom: 0 } },
              `${t.lastError}: ${data.lastError.scope} — ${data.lastError.message}`)
            : null),

        h('div', { style: CARD },
          h('div', { style: { ...VALUE, fontWeight: 600, marginBottom: 4 } }, t.gateTitle),
          h(Switch, {
            label: t.toolsMaster,
            hint: t.toolsMasterHint,
            checked: settings.tools === true,
            onChange: (value) => setDraft((current) => ({ ...current, tools: value })),
          }),
          h(Switch, {
            label: t.prompt,
            hint: t.promptHint,
            checked: settings.prompt === true,
            onChange: (value) => setDraft((current) => ({ ...current, prompt: value })),
          }),
          h(Switch, {
            label: t.readOnly,
            hint: t.readOnlyHint,
            checked: settings.readOnly === true,
            onChange: (value) => setDraft((current) => ({ ...current, readOnly: value })),
          }),
          h(Switch, {
            label: t.allowEvaluation,
            hint: t.allowEvaluationHint,
            checked: settings.allowEvaluation === true,
            onChange: (value) => setDraft((current) => ({ ...current, allowEvaluation: value })),
          }),
          h('div', { style: { ...LABEL, marginTop: 10, marginBottom: 2 } }, t.perTool),
          data.tools.map((tool) => h(Switch, {
            key: tool.name,
            label: tool.name,
            hint: tool.enabled ? null : tool.reason,
            disabled: settings.tools !== true,
            checked: !settings.disabledTools.includes(tool.name) && tool.enabled,
            onChange: (value) => toggleTool(tool.name, value),
          })),
          h('div', { style: { ...ROW, marginTop: 10 } },
            h('button', { type: 'button', style: PRIMARY, disabled: busy !== '' || !dirty, onClick: () => { void save() } }, busy === 'save' ? t.saving : t.save),
            h('button', {
              type: 'button',
              style: BUTTON,
              disabled: busy !== '' || !dirty,
              onClick: () => setDraft({ ...data.settings, disabledTools: [...data.settings.disabledTools] }),
            }, t.reset),
            dirty ? h('span', { style: { ...LABEL, marginBottom: 0 } }, t.unsaved) : null),
          notice
            ? h('div', {
              style: {
                ...LABEL,
                marginTop: 8,
                marginBottom: 0,
                color: notice.kind === 'error' ? 'var(--dsw-alias-state-error-primary, #d1242f)' : 'var(--dsw-alias-label-secondary, #a9a9a9)',
              },
            }, notice.text)
            : null),

        h('div', { style: CARD },
          h('div', { style: { ...VALUE, fontWeight: 600, marginBottom: 6 } }, t.inventoryTitle),
          h('div', { style: { overflowX: 'auto' } },
            h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } },
              h('thead', null, h('tr', null,
                h('th', { style: { ...LABEL, textAlign: 'left', padding: '4px 8px' } }, 'tool'),
                h('th', { style: { ...LABEL, textAlign: 'left', padding: '4px 8px' } }, t.does),
                h('th', { style: { ...LABEL, textAlign: 'left', padding: '4px 8px' } }, t.on),
                h('th', { style: { ...LABEL, textAlign: 'left', padding: '4px 8px' } }, 'note'))),
              h('tbody', null, data.tools.map((tool) => h('tr', { key: tool.name },
                h('td', { style: { ...MONO, padding: '4px 8px', verticalAlign: 'top', whiteSpace: 'nowrap' } }, tool.name),
                h('td', { style: { ...VALUE, padding: '4px 8px', verticalAlign: 'top', color: 'var(--dsw-alias-label-secondary, #a9a9a9)' } },
                  (tool.summary && (tool.summary[locale] || tool.summary.zh || tool.summary.en)) || '—'),
                h('td', { style: { ...VALUE, padding: '4px 8px', whiteSpace: 'nowrap', verticalAlign: 'top' } }, tool.enabled ? t.enabled : t.disabled),
                h('td', { style: { ...LABEL, padding: '4px 8px', marginBottom: 0, verticalAlign: 'top' } }, tool.reason || '—'))))))) 
      )
    }

    const name = NAME
    const inject = ['slots']

    function apply(ctx) {
      const mount = () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: NAME,
        locale: NAME,
        order: 20,
      }, Panel)
      if (typeof ctx.slots.inject === 'function') ctx.slots.inject('plugins.bundle.config', mount)
      else mount()
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})

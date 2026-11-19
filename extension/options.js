/**
 * Options page controller: edits the persisted bridge settings.
 * @module dsh-chrome-use/extension/options
 */

const el = (id) => document.getElementById(id)
const fields = {
  bridgeUrl: el('bridgeUrl'),
  token: el('token'),
  agentLabel: el('agentLabel'),
  autoConnect: el('autoConnect'),
}

function setStatus(text, kind = '') {
  const node = el('status')
  node.textContent = text
  node.className = kind
}

async function load() {
  const response = await chrome.runtime.sendMessage({ type: 'dsh:settings' })
  if (!response?.ok) {
    setStatus('读取设置失败', 'bad')
    return
  }
  const settings = response.settings
  fields.bridgeUrl.value = settings.bridgeUrl ?? ''
  fields.token.value = settings.token ?? ''
  fields.agentLabel.value = settings.agentLabel ?? ''
  fields.autoConnect.checked = settings.autoConnect !== false
  await refreshStatus()
}

async function refreshStatus() {
  const status = await chrome.runtime.sendMessage({ type: 'dsh:status' })
  if (!status?.ok) return
  const state = status.status?.state ?? 'idle'
  el('state').textContent = `${state}${status.status?.detail ? ` · ${status.status.detail}` : ''}`
  el('state').style.color = status.connected ? 'var(--ok)' : state === 'error' ? 'var(--bad)' : ''
  const browser = await chrome.runtime.getBrowserInfo?.().catch(() => null)
  el('browser').textContent = browser ? `${browser.name} ${browser.version}` : navigator.userAgent.replace(/^.*(Chrome\/[\d.]+).*$/, '$1')
  const debuggee = await chrome.debugger.getTargets()
  const attached = debuggee.filter((target) => target.attached).length
  el('tabs').textContent = `${attached} 个标签已附加`
}

el('reveal').addEventListener('click', () => {
  const input = fields.token
  input.type = input.type === 'password' ? 'text' : 'password'
  el('reveal').textContent = input.type === 'password' ? '显示' : '隐藏'
})

el('save').addEventListener('click', async () => {
  const patch = {
    bridgeUrl: fields.bridgeUrl.value.trim(),
    token: fields.token.value.trim(),
    agentLabel: fields.agentLabel.value.trim() || 'chrome',
    autoConnect: fields.autoConnect.checked,
  }
  if (!patch.bridgeUrl) {
    setStatus('桥接地址不能为空', 'bad')
    return
  }
  setStatus('保存中…')
  const response = await chrome.runtime.sendMessage({ type: 'dsh:save', patch })
  if (response?.ok) {
    setStatus('已保存，正在重连', 'ok')
    setTimeout(() => void refreshStatus(), 600)
  } else {
    setStatus('保存失败', 'bad')
  }
})

el('connect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'dsh:connect' })
  setTimeout(() => void refreshStatus(), 500)
})

el('disconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'dsh:disconnect' })
  setTimeout(() => void refreshStatus(), 300)
})

el('refresh').addEventListener('click', () => void refreshStatus())

void load()

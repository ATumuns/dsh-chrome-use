/**
 * Popup controller: shows connection state and toggles the bridge.
 * @module dsh-chrome-use/extension/popup
 */

const dot = document.getElementById('dot')
const detail = document.getElementById('detail')
const endpointEl = document.getElementById('endpoint')
const tabinfoEl = document.getElementById('tabinfo')

function paint(status, connected) {
  const state = status?.state ?? 'idle'
  dot.className = `dot${connected ? ' ok' : state === 'error' ? ' bad' : ''}`
  const since = status?.since ? new Date(status.since).toLocaleTimeString() : ''
  detail.textContent = `${state}${status?.detail ? ` · ${status.detail}` : ''}${since ? ` (${since})` : ''}`
}

async function refresh() {
  const [status, settings] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'dsh:status' }),
    chrome.runtime.sendMessage({ type: 'dsh:settings' }),
  ])
  if (status?.ok) paint(status.status, status.connected)
  if (settings?.ok) {
    const url = settings.settings?.bridgeUrl ?? '—'
    endpointEl.textContent = url.replace(/(token=)[^&]+/, '$1***')
    if (!settings.settings?.token) {
      detail.textContent = '还没有配对令牌，点「设置与配对令牌」'
      dot.className = 'dot bad'
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  tabinfoEl.textContent = tab ? `#${tab.id} ${tab.title?.slice(0, 40) ?? ''}` : '—'
}

document.getElementById('connect').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'dsh:connect' })
  if (response?.status) paint(response.status, response.status.state === 'connected')
  setTimeout(refresh, 400)
})

document.getElementById('disconnect').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'dsh:disconnect' })
  if (response?.status) paint(response.status, false)
})

document.getElementById('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
})

void refresh()
setInterval(refresh, 2000)

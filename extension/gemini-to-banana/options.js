const DEFAULT_API_ORIGIN = 'http://localhost:3333'

async function restoreOptions() {
  const stored = await chrome.storage.sync.get({ bananaApiOrigin: DEFAULT_API_ORIGIN })
  document.querySelector('#bananaApiOrigin').value = stored.bananaApiOrigin
}

async function saveOptions() {
  const input = document.querySelector('#bananaApiOrigin')
  const value = input.value.trim().replace(/\/+$/, '') || DEFAULT_API_ORIGIN
  await chrome.storage.sync.set({ bananaApiOrigin: value })
  document.querySelector('#status').textContent = '已保存'
}

document.addEventListener('DOMContentLoaded', () => {
  void restoreOptions()
  document.querySelector('#save').addEventListener('click', () => {
    void saveOptions()
  })
})

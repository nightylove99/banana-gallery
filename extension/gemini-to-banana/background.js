importScripts('capture-utils.js')

const DEFAULT_API_ORIGIN = 'http://localhost:3333'
const captureUtils = globalThis.BananaGeminiCaptureUtils

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false

  if (message.type === 'BANANA_FETCH_IMAGE_DATA_URL') {
    fetchImageAsDataUrl(message.url)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : '图片读取失败',
      }))

    return true
  }

  if (message.type !== 'BANANA_SAVE_GEMINI_CAPTURE') return false

  saveGeminiCapture(message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : '保存失败',
    }))

  return true
})

async function saveGeminiCapture(payload) {
  const apiOrigin = await getApiOrigin()
  const form = new FormData()
  form.append('metadata', JSON.stringify(payload.metadata))
  const imageBlob = dataUrlToBlob(payload.image.dataUrl)
  form.append(
    'image',
    imageBlob,
    captureUtils.filenameForMimeType(payload.image.name || 'gemini-result', imageBlob.type),
  )

  for (const reference of payload.references || []) {
    const referenceBlob = dataUrlToBlob(reference.dataUrl)
    form.append(
      'references',
      referenceBlob,
      captureUtils.filenameForMimeType(reference.name || 'gemini-reference', referenceBlob.type),
    )
  }

  const response = await fetch(`${apiOrigin}/api/external/gemini-web/import`, {
    method: 'POST',
    body: form,
    credentials: 'include',
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(typeof body.error === 'string' ? body.error : `保存失败：HTTP ${response.status}`)
  }

  const entry = await response.json()
  return {
    entry,
    galleryUrl: deriveGalleryUrl(apiOrigin),
  }
}

async function getApiOrigin() {
  const stored = await chrome.storage.sync.get({ bananaApiOrigin: DEFAULT_API_ORIGIN })
  return String(stored.bananaApiOrigin || DEFAULT_API_ORIGIN).replace(/\/+$/, '')
}

function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl)
  if (!match) throw new Error('图片数据格式无效')
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: match[1] })
}

async function fetchImageAsDataUrl(url) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('图片地址为空')
  const response = await fetch(url, { credentials: 'include' })
  if (!response.ok) throw new Error(`图片读取失败：HTTP ${response.status}`)
  const blob = await response.blob()
  const mimeType = blob.type || response.headers.get('content-type') || 'image/png'
  const buffer = await blob.arrayBuffer()
  return `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function deriveGalleryUrl(apiOrigin) {
  try {
    const url = new URL(apiOrigin)
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      url.port = '5173'
    }
    return url.toString().replace(/\/$/, '')
  } catch {
    return apiOrigin
  }
}

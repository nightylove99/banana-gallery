(function installBananaGeminiPageProbe() {
  const CONTENT_SOURCE = 'banana-gemini-content'
  const PAGE_SOURCE = 'banana-gemini-page-probe'

  if (window.__bananaGeminiPageProbeInstalled) {
    window.postMessage({ source: PAGE_SOURCE, type: 'READY' }, '*')
    return
  }

  window.__bananaGeminiPageProbeInstalled = true

  const state = {
    armed: false,
    captureId: '',
  }

  const originalFetch = window.fetch
  const originalCreateObjectURL = URL.createObjectURL

  window.fetch = async function bananaGeminiFetchProbe(...args) {
    const response = await originalFetch.apply(this, args)
    try {
      if (state.armed) {
        const requestUrl = extractFetchUrl(args[0])
        void reportResponseBlob(response.clone(), {
          id: state.captureId,
          via: 'fetch',
          url: requestUrl,
          status: response.status,
        }).catch(() => {})
      }
    } catch {
      // Probe failures must not affect Gemini itself.
    }
    return response
  }

  URL.createObjectURL = function bananaGeminiCreateObjectURLProbe(object) {
    try {
      if (state.armed && object instanceof Blob) {
        void reportBlob(object, {
          id: state.captureId,
          via: 'createObjectURL',
          url: '',
          status: 0,
        }).catch(() => {})
      }
    } catch {
      // Keep native behavior intact.
    }
    return originalCreateObjectURL.apply(this, arguments)
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== CONTENT_SOURCE) return

    if (event.data.type === 'START_PROBE') {
      state.armed = true
      state.captureId = String(event.data.captureId || '')
      window.postMessage({ source: PAGE_SOURCE, type: 'PROBE_STARTED', captureId: state.captureId }, '*')
      return
    }

    if (event.data.type === 'STOP_PROBE') {
      state.armed = false
      state.captureId = ''
      window.postMessage({ source: PAGE_SOURCE, type: 'PROBE_STOPPED' }, '*')
      return
    }

    if (event.data.type === 'FETCH_IMAGE_URLS') {
      const captureId = String(event.data.captureId || state.captureId || '')
      const items = Array.isArray(event.data.items) ? event.data.items : []
      for (const item of items) {
        void fetchImageUrl(item, captureId)
      }
    }
  })

  window.postMessage({ source: PAGE_SOURCE, type: 'READY' }, '*')

  async function fetchImageUrl(item, captureId) {
    const url = String(item?.url || '')
    if (!url) return
    try {
      const response = await originalFetch(url, { credentials: 'include' })
      await reportResponseBlob(response, {
        id: String(item.id || captureId),
        via: 'page-fetch',
        url,
        status: response.status,
      })
    } catch (error) {
      reportError({
        id: String(item.id || captureId),
        via: 'page-fetch',
        url,
        message: messageFromError(error),
      })
    }
  }

  async function reportResponseBlob(response, meta) {
    const contentType = response.headers?.get?.('content-type') || ''
    const url = response.url || meta.url || ''
    if (!response.ok) {
      reportError({ ...meta, url, message: `HTTP ${response.status}` })
      return
    }
    if (!looksLikeImage(contentType, url)) return
    const blob = await response.blob()
    await reportBlob(blob, { ...meta, url, contentType })
  }

  async function reportBlob(blob, meta) {
    const contentType = blob.type || meta.contentType || ''
    if (!looksLikeImage(contentType, meta.url)) return
    const dataUrl = await blobToDataUrl(blob)
    window.postMessage({
      source: PAGE_SOURCE,
      type: 'IMAGE_CAPTURED',
      captureId: state.captureId,
      itemId: meta.id || '',
      dataUrl,
      meta: {
        via: meta.via || '',
        url: meta.url || '',
        status: meta.status || 0,
        contentType,
        size: blob.size || 0,
      },
    }, '*')
  }

  function reportError(error) {
    window.postMessage({
      source: PAGE_SOURCE,
      type: 'PROBE_ERROR',
      captureId: state.captureId,
      itemId: error.id || '',
      error: {
        via: error.via || '',
        url: error.url || '',
        message: error.message || '图片读取失败',
      },
    }, '*')
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  }

  function extractFetchUrl(input) {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.toString()
    return input?.url || ''
  }

  function looksLikeImage(contentType, url) {
    if (/^image\//i.test(contentType || '')) return true
    if (/^application\/octet-stream/i.test(contentType || '') && /(?:googleusercontent|gstatic|blob:)/i.test(url || '')) return true
    return !contentType && /(?:googleusercontent|gstatic|blob:)/i.test(url || '')
  }

  function messageFromError(error) {
    return error instanceof Error && error.message ? error.message : '图片读取失败'
  }
})()

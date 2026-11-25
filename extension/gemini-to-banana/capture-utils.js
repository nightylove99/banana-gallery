(function initBananaGeminiCaptureUtils(globalScope) {
  function selectCachedReferences(cache, scope) {
    const saved = cache?.scope
    if (!saved || !scope?.turn || saved.turn !== scope.turn
      || saved.conversationUrl !== scope.conversationUrl
      || saved.resultUrl !== scope.resultUrl || saved.prompt !== scope.prompt
      || cache.references.length !== scope.attachments.length
      || saved.attachments.length !== scope.attachments.length) return []

    const sameAttachments = saved.attachments.every((attachment, index) => {
      const current = scope.attachments[index]
      return attachment.element === current.element && attachment.url === current.url
    })
    return sameAttachments ? cache.references : []
  }

  function filenameForMimeType(name, mimeType) {
    const extension = extensionForMimeType(mimeType)
    const fallbackName = `image.${extension}`
    const candidate = String(name || fallbackName).trim() || fallbackName
    const stem = candidate.replace(/\.(?:avif|gif|jpe?g|png|webp)$/i, '') || 'image'
    return `${stem}.${extension}`
  }

  function extensionForMimeType(mimeType) {
    const normalized = String(mimeType || '').toLowerCase().split(';', 1)[0].trim()
    if (normalized === 'image/jpeg') return 'jpg'
    if (normalized === 'image/webp') return 'webp'
    if (normalized === 'image/avif') return 'avif'
    if (normalized === 'image/gif') return 'gif'
    return 'png'
  }

  globalScope.BananaGeminiCaptureUtils = {
    selectCachedReferences,
    filenameForMimeType,
  }
})(globalThis)

(function initGeminiToBananaContent() {
  const extractor = globalThis.BananaGeminiExtractor
  const captureUtils = globalThis.BananaGeminiCaptureUtils
  const PAGE_PROBE_SCRIPT_ID = 'banana-gemini-page-probe-script'
  const PAGE_PROBE_CONTENT_SOURCE = 'banana-gemini-content'
  const PAGE_PROBE_SOURCE = 'banana-gemini-page-probe'
  let pageProbeReadyPromise = null
  // Only cache attachments read from a known rendered turn in this document.
  // File-input events precede turn creation and cannot prove which files were sent.
  let referenceCache = null
  let legacyCacheCleanupStarted = false

  if (!extractor || !captureUtils) return

  const observer = new MutationObserver(() => mountFloatingButton())
  observer.observe(document.documentElement, { childList: true, subtree: true })
  mountFloatingButton()

  function mountFloatingButton() {
    if (document.querySelector('.banana-save-gemini-button')) return
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'banana-save-gemini-button'
    button.textContent = '保存到 Banana'
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void openConfirmPanel().catch((error) => openErrorPanel(error))
    })
    document.body.append(button)
  }

  async function openConfirmPanel() {
    removeExistingPanel()

    const draft = await buildDraft()
    const panel = document.createElement('div')
    panel.className = 'banana-save-panel'
    panel.innerHTML = `
      <div class="banana-save-panel__header">
        <strong>保存到 Banana Gallery</strong>
        <button type="button" class="banana-save-panel__close" aria-label="关闭">×</button>
      </div>
      <div class="banana-save-panel__section">
        <span>生成图</span>
        <img class="banana-save-panel__preview" alt="Gemini result preview">
      </div>
      <div class="banana-save-panel__section">
        <span>参考图</span>
        <div class="banana-save-panel__references"></div>
      </div>
      <label>提示词<textarea class="banana-save-panel__prompt"></textarea></label>
      <label>类型<select class="banana-save-panel__asset-type"><option value="recipe">配方</option><option value="work">作品</option></select></label>
      <label>标签<input class="banana-save-panel__tags" value="gemini-web"></label>
      <p class="banana-save-panel__status"></p>
      <div class="banana-save-panel__actions">
        <button type="button" class="banana-save-panel__save">确认保存</button>
        <button type="button" class="banana-save-panel__skip" hidden>跳过这次保存</button>
        <button type="button" class="banana-save-panel__capture-original">捕获原图</button>
        <button type="button" class="banana-save-panel__diagnostics">复制诊断信息</button>
      </div>
    `

    document.body.append(panel)
    const status = panel.querySelector('.banana-save-panel__status')
    const preview = panel.querySelector('.banana-save-panel__preview')
    if (draft.image) {
      preview.src = draft.image.dataUrl
    } else {
      preview.hidden = true
    }
    renderReferencePreviews(panel.querySelector('.banana-save-panel__references'), draft.references)
    const promptInput = panel.querySelector('.banana-save-panel__prompt')
    promptInput.value = draft.prompt
    status.textContent = summarizeDraftStatus(draft)
    const saveButton = panel.querySelector('.banana-save-panel__save')
    const refreshSaveButton = () => {
      saveButton.disabled = !isDraftSavable(draft, promptInput.value)
    }
    refreshSaveButton()
    promptInput.addEventListener('input', refreshSaveButton)
    const captureButton = panel.querySelector('.banana-save-panel__capture-original')
    captureButton.hidden = !draft.resultImage
    captureButton.addEventListener('click', async () => {
      captureButton.disabled = true
      status.textContent = '正在通过 Gemini 原生下载链路捕获原图...'
      try {
        const recovered = await recoverOriginalImages(draft)
        if (recovered.image) {
          draft.image = recovered.image
          preview.hidden = false
          preview.src = recovered.image.dataUrl
        }
        if (recovered.references.length > 0) {
          draft.references = recovered.references
          renderReferencePreviews(panel.querySelector('.banana-save-panel__references'), draft.references)
        }
        draft.diagnostics.lastOriginalProbe = summarizeProbeResult(recovered)
        status.textContent = summarizeRecovery(recovered, draft)
        refreshSaveButton()
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : '原图捕获失败'
      } finally {
        captureButton.disabled = false
      }
    })
    panel.querySelector('.banana-save-panel__diagnostics').addEventListener('click', async () => {
      try {
        await copyText(JSON.stringify(draft.diagnostics, null, 2))
        status.textContent = '诊断信息已复制'
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : '诊断信息复制失败'
      }
    })

    panel.querySelector('.banana-save-panel__close').addEventListener('click', removeExistingPanel)
    let pendingPayload = null
    let allowDuplicate = false
    panel.querySelector('.banana-save-panel__skip').addEventListener('click', removeExistingPanel)
    saveButton.addEventListener('click', async () => {
      saveButton.disabled = true
      status.textContent = '正在保存...'
      try {
        if (!draft.image) throw new Error('没有识别到 Gemini 结果图')
        const prompt = promptInput.value.trim()
        if (!prompt) throw new Error('请提供提示词')
        pendingPayload ||= structuredClone({
          image: draft.image,
          references: draft.references,
          metadata: {
            requestId: crypto.randomUUID(), checkDuplicates: true,
            prompt,
            assetType: panel.querySelector('.banana-save-panel__asset-type').value,
            tags: panel.querySelector('.banana-save-panel__tags').value.split(',').map((tag) => tag.trim()).filter(Boolean),
            sourceUrl: location.href,
            capturedAt: new Date().toISOString(),
          },
        })
        promptInput.readOnly = true
        panel.querySelector('.banana-save-panel__asset-type').disabled = true
        panel.querySelector('.banana-save-panel__tags').disabled = true
        const result = await sendSaveMessage({...pendingPayload,metadata:{...pendingPayload.metadata,allowDuplicate}})
        if (result.entry?.requiresConfirmation) {
          const candidates = result.entry.candidates || []
          status.textContent = `已收过或可能相似：${candidates.slice(0,3).map(item => `${item.title}${item.deleted ? '（在回收站）' : ''}：${item.evidence.join('、')}`).join('；')}。可以跳过，或保留独立新条目。`
          allowDuplicate = true
          saveButton.textContent = '仍然保存为新条目'
          saveButton.disabled = false
          panel.querySelector('.banana-save-panel__skip').hidden = false
          return
        }
        const link = document.createElement('a')
        link.href = result.galleryUrl; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = '打开 Banana Gallery'
        status.replaceChildren(document.createTextNode('已保存。'),link)
        panel.querySelector('.banana-save-panel__skip').hidden = true
        if (referenceCache?.references === draft.references) referenceCache = null
        discardLegacyReferenceCache()
      } catch (error) {
        saveButton.disabled = false
        status.textContent = `${error instanceof Error ? error.message : '保存失败'}${pendingPayload ? '；本次采集内容已固定，可用相同标识重试。要改内容请关闭面板后重新打开。' : ''}`
      }
    })
  }

  async function buildDraft() {
    const resultImage = extractor.selectCurrentResultImage(document.querySelectorAll('img'))
    const prompt = resultImage ? extractor.findPromptForImage(resultImage) : ''
    const visibleReferenceImages = resultImage ? extractor.findVisibleReferenceImages(resultImage) : []
    const scope = {
      conversationUrl: location.href,
      turn: resultImage,
      resultUrl: resultImage ? imageElementUrl(resultImage) : '',
      prompt,
      attachments: visibleReferenceImages.map(candidate => ({
        candidate, element: candidate.element || candidate, url: imageElementUrl(candidate),
      })),
    }
    const selectedCachedReferences = captureUtils.selectCachedReferences(referenceCache, scope)
    const imageResult = resultImage
      ? await captureImageDataUrl(resultImage, 'gemini-result.png')
      : { item: null, error: '' }
    const recoveredReferenceResults = selectedCachedReferences.length > 0
      ? []
      : await Promise.all(
        visibleReferenceImages.map((refImg, index) => captureImageDataUrl(refImg, `gemini-reference-${index + 1}.png`)),
      )
    const recoveredReferences = recoveredReferenceResults
      .map((result) => result.item)
      .filter(Boolean)
    const recoveredReferenceErrors = recoveredReferenceResults
      .map((result) => result.error)
      .filter(Boolean)

    if (location.href !== scope.conversationUrl
      || (resultImage && (!resultImage.isConnected || imageElementUrl(resultImage) !== scope.resultUrl))
      || scope.attachments.some(({ candidate, element, url }) => !element.isConnected || imageElementUrl(candidate) !== url)) {
      throw new Error('当前会话或附件已变化，请重新打开采集面板')
    }

    const useCached = selectedCachedReferences.length > 0
    const references = useCached ? selectedCachedReferences : recoveredReferences
    if (!useCached) {
      referenceCache = references.length && references.length === scope.attachments.length
        ? { scope, references }
        : null
    }
    let classification = extractor.classifyCapture({
      resultPresent: Boolean(resultImage),
      prompt,
      visibleReferenceCount: visibleReferenceImages.length,
      cachedReferenceCount: 0,
      recoveredReferenceCount: references.length,
    })
    if (imageResult.error) {
      classification = {
        complete: false,
        reason: `结果图读取失败：${imageResult.error}`,
      }
    } else if (!useCached && recoveredReferenceErrors.length > 0 && visibleReferenceImages.length > 0) {
      classification = {
        complete: false,
        reason: `参考图读取失败：${recoveredReferenceErrors[0]}`,
      }
    }
    const diagnostics = buildDiagnostics({
      resultImage,
      prompt,
      visibleReferenceImages,
      imageError: imageResult.error,
      referenceErrors: recoveredReferenceErrors,
      classification,
    })

    return {
      image: imageResult.item,
      prompt,
      references,
      resultImage,
      visibleReferenceImages,
      classification,
      diagnostics,
    }
  }

  async function recoverOriginalImages(draft) {
    const captureId = `capture-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const items = []
    const resultUrl = imageElementUrl(draft.resultImage)
    if (resultUrl) items.push({ id: 'result', url: resultUrl })
    draft.visibleReferenceImages.forEach((img, index) => {
      const url = imageElementUrl(img)
      if (url) items.push({ id: `reference-${index}`, url })
    })

    const probeResult = await runPageProbeCapture({
      captureId,
      items,
      resultImage: draft.resultImage,
    })

    const resultCapture = findCapture(probeResult.captures, 'result')
      || findCapture(probeResult.captures, captureId)
      || findLargestCapture(probeResult.captures.filter((capture) => !capture.itemId.startsWith('reference-')))
    const references = []
    const extraCaptures = []
    const extraErrors = []
    const referenceProbes = []
    for (const [index, referenceImage] of draft.visibleReferenceImages.entries()) {
      const directCapture = findCaptureByPrefix(probeResult.captures, `reference-${index}`)
      if (directCapture) {
        references.push({
          name: `gemini-reference-${index + 1}.png`,
          dataUrl: directCapture.dataUrl,
        })
        continue
      }

      const referenceProbe = await runReferenceProbeCapture({
        captureId: `${captureId}-reference-${index}`,
        resultImage: draft.resultImage,
        referenceImage,
        referenceIndex: index,
      })
      extraCaptures.push(...referenceProbe.captures)
      extraErrors.push(...referenceProbe.errors)
      referenceProbes.push({
        index,
        clickedReference: referenceProbe.clickedReference,
        clickedDownload: referenceProbe.clickedDownload,
        captureCount: referenceProbe.captures.length,
        errorCount: referenceProbe.errors.length,
      })
      const referenceCapture = findCaptureByPrefix(referenceProbe.captures, `reference-${index}`)
        || findLargestCapture(referenceProbe.captures)
      if (referenceCapture) {
        references.push({
          name: `gemini-reference-${index + 1}.png`,
          dataUrl: referenceCapture.dataUrl,
        })
      }
    }

    return {
      image: resultCapture ? { name: 'gemini-result.png', dataUrl: resultCapture.dataUrl } : null,
      references,
      captures: [...probeResult.captures, ...extraCaptures],
      errors: [...probeResult.errors, ...extraErrors],
      clickedDownload: probeResult.clickedDownload,
      referenceProbes,
    }
  }

  async function runPageProbeCapture(input) {
    await ensurePageProbe()

    return new Promise((resolve) => {
      const captures = []
      const errors = []
      let clickedDownload = false
      const timeout = window.setTimeout(finish, 9000)

      function onMessage(event) {
        if (event.source !== window || event.data?.source !== PAGE_PROBE_SOURCE) return
        if (event.data.captureId && event.data.captureId !== input.captureId) return

        if (event.data.type === 'IMAGE_CAPTURED') {
          captures.push({
            itemId: String(event.data.itemId || ''),
            dataUrl: String(event.data.dataUrl || ''),
            meta: event.data.meta || {},
          })
          return
        }

        if (event.data.type === 'PROBE_ERROR') {
          errors.push({
            itemId: String(event.data.itemId || ''),
            error: event.data.error || {},
          })
        }
      }

      function finish() {
        window.clearTimeout(timeout)
        window.removeEventListener('message', onMessage)
        window.postMessage({ source: PAGE_PROBE_CONTENT_SOURCE, type: 'STOP_PROBE' }, '*')
        resolve({ captures, errors, clickedDownload })
      }

      window.addEventListener('message', onMessage)
      window.postMessage({ source: PAGE_PROBE_CONTENT_SOURCE, type: 'START_PROBE', captureId: input.captureId }, '*')
      if (input.items.length > 0) {
        window.postMessage({
          source: PAGE_PROBE_CONTENT_SOURCE,
          type: 'FETCH_IMAGE_URLS',
          captureId: input.captureId,
          items: input.items,
        }, '*')
      }
      window.setTimeout(() => {
        if (captures.some((capture) => capture.itemId === 'result')) return
        const downloadButton = findDownloadButtonNear(input.resultImage)
        if (downloadButton) {
          clickedDownload = true
          downloadButton.click()
        }
      }, 1800)
    })
  }

  async function runReferenceProbeCapture(input) {
    await ensurePageProbe()

    return new Promise((resolve) => {
      const captures = []
      const errors = []
      let clickedReference = false
      let clickedDownload = false
      const timeout = window.setTimeout(finish, 9000)

      function onMessage(event) {
        if (event.source !== window || event.data?.source !== PAGE_PROBE_SOURCE) return
        if (event.data.captureId && event.data.captureId !== input.captureId) return

        if (event.data.type === 'IMAGE_CAPTURED') {
          captures.push({
            itemId: String(event.data.itemId || ''),
            dataUrl: String(event.data.dataUrl || ''),
            meta: event.data.meta || {},
          })
          return
        }

        if (event.data.type === 'PROBE_ERROR') {
          errors.push({
            itemId: String(event.data.itemId || ''),
            error: event.data.error || {},
          })
        }
      }

      function sendItems(items) {
        if (items.length === 0) return
        window.postMessage({
          source: PAGE_PROBE_CONTENT_SOURCE,
          type: 'FETCH_IMAGE_URLS',
          captureId: input.captureId,
          items,
        }, '*')
      }

      function finish() {
        window.clearTimeout(timeout)
        window.removeEventListener('message', onMessage)
        window.postMessage({ source: PAGE_PROBE_CONTENT_SOURCE, type: 'STOP_PROBE' }, '*')
        closeGeminiOverlay()
        resolve({ captures, errors, clickedReference, clickedDownload })
      }

      window.addEventListener('message', onMessage)
      window.postMessage({ source: PAGE_PROBE_CONTENT_SOURCE, type: 'START_PROBE', captureId: input.captureId }, '*')
      const referenceUrl = imageElementUrl(input.referenceImage)
      if (referenceUrl) {
        sendItems([{ id: `reference-${input.referenceIndex}`, url: referenceUrl }])
      }

      window.setTimeout(() => {
        const trigger = findReferencePreviewTrigger(input.referenceImage)
        if (trigger) {
          clickedReference = true
          trigger.click()
        }
      }, 250)

      window.setTimeout(() => {
        sendItems(collectReferencePreviewImageItems({
          referenceImage: input.referenceImage,
          resultImage: input.resultImage,
          referenceIndex: input.referenceIndex,
        }))
      }, 1400)

      window.setTimeout(() => {
        const downloadButton = findReferenceDownloadButton(input.referenceImage, input.resultImage)
        if (downloadButton) {
          clickedDownload = true
          downloadButton.click()
        }
      }, 2000)

      window.setTimeout(() => {
        sendItems(collectReferencePreviewImageItems({
          referenceImage: input.referenceImage,
          resultImage: input.resultImage,
          referenceIndex: input.referenceIndex,
        }))
      }, 3200)
    })
  }

  function ensurePageProbe() {
    if (pageProbeReadyPromise) return pageProbeReadyPromise

    pageProbeReadyPromise = new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener('message', onReady)
        reject(new Error('Gemini 页面探针加载超时'))
      }, 3000)

      function onReady(event) {
        if (event.source !== window || event.data?.source !== PAGE_PROBE_SOURCE || event.data.type !== 'READY') return
        window.clearTimeout(timeout)
        window.removeEventListener('message', onReady)
        resolve()
      }

      window.addEventListener('message', onReady)
      if (!document.getElementById(PAGE_PROBE_SCRIPT_ID)) {
        const script = document.createElement('script')
        script.id = PAGE_PROBE_SCRIPT_ID
        script.src = chrome.runtime.getURL('page-probe.js')
        script.async = false
        ;(document.head || document.documentElement).append(script)
      }
    })

    return pageProbeReadyPromise
  }

  function findCapture(captures, itemId) {
    return captures.filter((capture) => capture.itemId === itemId).sort((a, b) => imageDataSize(b) - imageDataSize(a))[0] || null
  }

  function findCaptureByPrefix(captures, itemIdPrefix) {
    return captures
      .filter((capture) => capture.itemId === itemIdPrefix || capture.itemId.startsWith(`${itemIdPrefix}-`))
      .sort((a, b) => imageDataSize(b) - imageDataSize(a))[0] || null
  }

  function findLargestCapture(captures) {
    return captures.slice().sort((a, b) => imageDataSize(b) - imageDataSize(a))[0] || null
  }

  function imageDataSize(capture) {
    return Number(capture?.meta?.size || 0) || String(capture?.dataUrl || '').length
  }

  function summarizeRecovery(recovered, draft) {
    const referenceNeed = draft.visibleReferenceImages.length
    const referenceCount = draft.references.length
    if (recovered.image && referenceNeed === 0) return '已捕获生成图原始数据，可以保存'
    if (recovered.image && referenceNeed > 0 && referenceCount === referenceNeed) {
      return `已捕获生成图原始数据和 ${referenceCount} 张参考图数据，可以保存`
    }
    if (recovered.image && referenceNeed > 0) {
      return `已捕获生成图，但参考图仍不完整：需要 ${referenceNeed} 张，当前 ${referenceCount} 张；仍可保存`
    }
    if (recovered.clickedDownload) return '已触发 Gemini 下载链路，但没有捕获到原始图片数据'
    return '未找到可触发的 Gemini 原图下载链路'
  }

  function summarizeProbeResult(recovered) {
    return {
      capturedAt: new Date().toISOString(),
      clickedDownload: recovered.clickedDownload,
      referenceProbes: recovered.referenceProbes || [],
      captures: recovered.captures.map((capture) => ({
        itemId: capture.itemId,
        meta: capture.meta,
        dataUrlLength: capture.dataUrl.length,
      })),
      errors: recovered.errors,
    }
  }

  function summarizeDraftStatus(draft) {
    if (!draft.image || !draft.prompt || draft.classification.complete) {
      return draft.classification.reason
    }

    const referenceCount = draft.references?.length || 0
    const referenceSummary = referenceCount > 0
      ? `当前 ${referenceCount} 张参考图`
      : '不带参考图'
    return `${draft.classification.reason}；仍可保存结果图和提示词，${referenceSummary}`
  }

  function isDraftSavable(draft, prompt = draft.prompt) {
    return Boolean(draft.image && String(prompt || '').trim())
  }

  function imageElementUrl(img) {
    return img?.currentSrc || img?.src || img?.getAttribute?.('src') || ''
  }

  function findDownloadButtonNear(resultImage) {
    if (!resultImage) return null
    const root = resultImage.closest?.('model-response, [data-test-id], [data-testid]')?.parentElement || document.body
    const resultBox = resultImage.getBoundingClientRect()
    return Array.from(root.querySelectorAll('button,a'))
      .filter(isRendered)
      .filter((element) => {
        const label = `${element.getAttribute('aria-label') || ''} ${element.innerText || element.textContent || ''}`
        return /下载完整尺寸|下载.*图片|download.*image|download/i.test(label)
      })
      .map((element) => ({
        element,
        distance: rectDistance(resultBox, element.getBoundingClientRect()),
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.element || null
  }

  function findReferencePreviewTrigger(referenceImage) {
    let current = referenceImage
    for (let i = 0; current && i < 7; i += 1) {
      if (current.matches?.('button,a,[role="button"],[tabindex]')) return current
      current = current.parentElement
    }
    return referenceImage
  }

  function collectReferencePreviewImageItems(input) {
    const referenceUrl = imageElementUrl(input.referenceImage)
    const seenUrls = new Set()
    return Array.from(document.querySelectorAll('img'))
      .filter(isRendered)
      .filter((img) => img !== input.resultImage)
      .filter((img) => {
        const url = imageElementUrl(img)
        if (!url || seenUrls.has(url)) return false
        if (!/googleusercontent\.com/i.test(url)) return false
        if (url.includes('/a/') || url.includes('/ogw/')) return false
        if (img.alt && !/上传|upload|image|图片|预览/i.test(img.alt)) return false
        const box = img.getBoundingClientRect()
        const isReferencePreview = img === input.referenceImage || url === referenceUrl
        const isExpandedPreview = box.width >= 180 || box.height >= 180 || img.naturalWidth > input.referenceImage.naturalWidth
        if (!isReferencePreview && !isExpandedPreview) return false
        seenUrls.add(url)
        return true
      })
      .map((img, candidateIndex) => ({
        id: `reference-${input.referenceIndex}-preview-${candidateIndex}`,
        url: imageElementUrl(img),
      }))
  }

  function findReferenceDownloadButton(referenceImage, resultImage) {
    const resultBox = resultImage?.getBoundingClientRect?.()
    const referenceBox = referenceImage.getBoundingClientRect()
    return Array.from(document.querySelectorAll('button,a'))
      .filter(isRendered)
      .filter((element) => {
        const label = `${element.getAttribute('aria-label') || ''} ${element.innerText || element.textContent || ''}`
        return /下载|download/i.test(label)
      })
      .filter((element) => {
        if (!resultBox) return true
        return !rectIntersects(expandRect(resultBox, 72), element.getBoundingClientRect())
      })
      .map((element) => ({
        element,
        distance: rectDistance(referenceBox, element.getBoundingClientRect()),
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.element || null
  }

  function closeGeminiOverlay() {
    const closeButton = Array.from(document.querySelectorAll('button'))
      .filter(isRendered)
      .find((button) => /关闭|close/i.test(`${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`))
    closeButton?.click()
    const eventOptions = { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }
    document.dispatchEvent(new KeyboardEvent('keydown', eventOptions))
    window.dispatchEvent(new KeyboardEvent('keydown', eventOptions))
  }

  function rectIntersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  }

  function expandRect(rect, amount) {
    return {
      top: rect.top - amount,
      left: rect.left - amount,
      right: rect.right + amount,
      bottom: rect.bottom + amount,
      width: rect.width + amount * 2,
      height: rect.height + amount * 2,
    }
  }

  function rectDistance(a, b) {
    const ax = a.left + a.width / 2
    const ay = a.top + a.height / 2
    const bx = b.left + b.width / 2
    const by = b.top + b.height / 2
    return Math.hypot(ax - bx, ay - by)
  }

  async function captureImageDataUrl(img, name) {
    try {
      return {
        item: {
          name,
          dataUrl: await imageElementToDataUrl(img),
        },
        error: '',
      }
    } catch (error) {
      return {
        item: null,
        error: error instanceof Error ? error.message : '图片读取失败',
      }
    }
  }

  function renderReferencePreviews(container, references) {
    container.textContent = ''
    if (references.length === 0) {
      const empty = document.createElement('span')
      empty.className = 'banana-save-panel__empty'
      empty.textContent = '未检测到参考图'
      container.append(empty)
      return
    }

    for (const reference of references) {
      const img = document.createElement('img')
      img.alt = reference.name || 'Gemini reference'
      img.src = reference.dataUrl
      container.append(img)
    }
  }

  function sendSaveMessage(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'BANANA_SAVE_GEMINI_CAPTURE', payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }
        if (!response?.ok) {
          reject(new Error(response?.error || '保存失败'))
          return
        }
        resolve(response.result)
      })
    })
  }

  async function imageElementToDataUrl(img) {
    const src = img.currentSrc || img.src
    if (!src) throw new Error('图片地址为空')
    if (src.startsWith('data:')) return src

    try {
      const response = await fetch(src)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      return blobToDataUrl(blob)
    } catch (error) {
      if (src.startsWith('http://') || src.startsWith('https://')) {
        try {
          return await fetchImageDataUrlInBackground(src)
        } catch (backgroundError) {
          throw new Error(messageFromError(backgroundError, '图片读取失败'))
        }
      }
      throw new Error(messageFromError(error, '图片读取失败'))
    }
  }

  function messageFromError(error, fallback) {
    return error instanceof Error && error.message ? error.message : fallback
  }

  function fetchImageDataUrlInBackground(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'BANANA_FETCH_IMAGE_DATA_URL', url }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }
        if (!response?.ok) {
          reject(new Error(response?.error || '图片读取失败'))
          return
        }
        resolve(response.dataUrl)
      })
    })
  }

  function discardLegacyReferenceCache() {
    if (legacyCacheCleanupStarted || !globalThis.indexedDB) return
    legacyCacheCleanupStarted = true
    // Migrate away from the old shared, unscoped uploads. No current capture writes here.
    const request = indexedDB.open('banana-gemini-capture')
    request.onupgradeneeded = () => request.transaction.abort()
    request.onsuccess = () => {
      const db = request.result
      try {
        db.transaction('references', 'readwrite').objectStore('references').clear()
      } finally {
        db.close?.()
      }
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  }

  function removeExistingPanel() {
    document.querySelector('.banana-save-panel')?.remove()
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    document.body.append(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    textarea.remove()
    if (!ok) throw new Error('无法复制诊断信息')
  }

  function buildDiagnostics(input) {
    return {
      url: location.href,
      capturedAt: new Date().toISOString(),
      devicePixelRatio: globalThis.devicePixelRatio || 1,
      viewport: {
        width: globalThis.innerWidth,
        height: globalThis.innerHeight,
      },
      classification: input.classification,
      promptLength: input.prompt.length,
      resultImage: summarizeElement(input.resultImage),
      imageError: input.imageError,
      visibleReferences: input.visibleReferenceImages.map(summarizeElement),
      referenceErrors: input.referenceErrors,
      visibleImages: Array.from(document.querySelectorAll('img'))
        .filter(isRendered)
        .map(summarizeElement)
        .slice(0, 40),
      nearbyActions: collectNearbyActions(input.resultImage),
      imageResources: collectImageResources(),
    }
  }

  function summarizeElement(element) {
    if (!element) return null
    const box = element.getBoundingClientRect?.()
    return {
      tag: element.tagName,
      alt: element.getAttribute?.('alt') || '',
      ariaLabel: element.getAttribute?.('aria-label') || '',
      role: element.getAttribute?.('role') || '',
      src: summarizeUrl(element.currentSrc || element.src || element.getAttribute?.('src') || ''),
      currentSrc: summarizeUrl(element.currentSrc || ''),
      naturalWidth: element.naturalWidth || 0,
      naturalHeight: element.naturalHeight || 0,
      rect: box ? {
        top: Math.round(box.top),
        left: Math.round(box.left),
        width: Math.round(box.width),
        height: Math.round(box.height),
      } : null,
      parentText: (element.parentElement?.innerText || '').slice(0, 200),
      outerHTML: (element.outerHTML || '').slice(0, 600),
    }
  }

  function isRendered(element) {
    const box = element.getBoundingClientRect?.()
    return Boolean(box && box.width > 0 && box.height > 0)
  }

  function collectNearbyActions(resultImage) {
    const root = resultImage?.closest?.('model-response, [data-test-id], [data-testid], div')?.parentElement || document.body
    return Array.from(root.querySelectorAll('button,a'))
      .filter(isRendered)
      .map((element) => ({
        tag: element.tagName,
        text: (element.innerText || element.textContent || '').trim().slice(0, 120),
        ariaLabel: element.getAttribute('aria-label') || '',
        href: summarizeUrl(element.href || element.getAttribute('href') || ''),
        rect: summarizeRect(element),
      }))
      .slice(0, 80)
  }

  function collectImageResources() {
    return performance.getEntriesByType('resource')
      .filter((entry) => entry.initiatorType === 'img' || /image|googleusercontent|blob:/.test(entry.name))
      .map((entry) => ({
        name: summarizeUrl(entry.name),
        initiatorType: entry.initiatorType,
        transferSize: entry.transferSize || 0,
        encodedBodySize: entry.encodedBodySize || 0,
        decodedBodySize: entry.decodedBodySize || 0,
      }))
      .slice(-80)
  }

  function summarizeRect(element) {
    const box = element.getBoundingClientRect?.()
    return box ? {
      top: Math.round(box.top),
      left: Math.round(box.left),
      width: Math.round(box.width),
      height: Math.round(box.height),
    } : null
  }

  function summarizeUrl(url) {
    if (!url) return ''
    if (url.startsWith('data:')) return `${url.slice(0, 64)}...`
    return url
  }

  function openErrorPanel(error) {
    removeExistingPanel()
    const panel = document.createElement('div')
    panel.className = 'banana-save-panel'
    panel.innerHTML = `
      <div class="banana-save-panel__header">
        <strong>保存到 Banana Gallery</strong>
        <button type="button" class="banana-save-panel__close" aria-label="关闭">×</button>
      </div>
      <p class="banana-save-panel__status"></p>
    `
    panel.querySelector('.banana-save-panel__status').textContent = error instanceof Error
      ? `读取当前会话失败：${error.message}`
      : '读取当前会话失败'
    panel.querySelector('.banana-save-panel__close').addEventListener('click', removeExistingPanel)
    document.body.append(panel)
  }
})()

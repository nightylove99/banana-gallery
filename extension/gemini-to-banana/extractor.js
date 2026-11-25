(function initBananaGeminiExtractor(globalScope) {
  const MIN_RESULT_EDGE = 160
  const REFERENCE_RENDERED_EDGE_MAX = 520
  const PROMPT_UI_LABEL_SELECTOR = '.screen-reader-user-query-label'
  const MESSAGE_ROOT_SELECTOR = [
    '[data-test-id]',
    '[data-testid]',
    '[data-message-author-role]',
    'message-content',
    'user-query',
    'model-response',
    '.conversation-container',
  ].join(', ')
  const PROMPT_ROOT_SELECTOR = [
    'user-query',
    '[data-message-author-role="user"]',
    '[data-test-id*="user"]',
    '[data-testid*="user"]',
    '[class*="user-query"]',
    '[class*="userQuery"]',
    '[class*="query-text"]',
    '[class*="queryText"]',
  ].join(', ')
  const PROMPT_BLOCK_TAGS = new Set([
    'ARTICLE',
    'BLOCKQUOTE',
    'DIV',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'LI',
    'MESSAGE-CONTENT',
    'OL',
    'P',
    'PRE',
    'SECTION',
    'UL',
    'USER-QUERY',
  ])

  function isUsableImage(img) {
    if (!img || !img.src) return false
    const src = img.currentSrc || img.src
    if (!src || src.startsWith('chrome-extension:')) return false
    if (src.includes('googleusercontent.com/ogw') || src.includes('profile')) return false
    if (img.naturalWidth < 24 || img.naturalHeight < 24) return false
    return true
  }

  function isResultImage(img) {
    if (!isUsableImage(img)) return false
    return img.naturalWidth >= MIN_RESULT_EDGE && img.naturalHeight >= MIN_RESULT_EDGE
  }

  function selectCurrentResultImage(images, viewportHeight) {
    const candidates = Array.from(images || []).filter(isResultImage)
    if (candidates.length === 0) return null

    const height = typeof viewportHeight === 'number'
      ? viewportHeight
      : globalScope.innerHeight || 0

    return candidates
      .map((img, index) => ({
        img,
        index,
        score: scoreResultImage(img, height),
      }))
      .sort((a, b) => b.score - a.score || b.index - a.index)[0].img
  }

  function scoreResultImage(img, viewportHeight) {
    const rect = img.getBoundingClientRect?.() || { top: 0, bottom: 0, width: 0, height: 0 }
    const visibleTop = Math.max(rect.top, 0)
    const visibleBottom = viewportHeight > 0 ? Math.min(rect.bottom, viewportHeight) : rect.bottom
    const visibleHeight = Math.max(visibleBottom - visibleTop, 0)
    const visibleArea = visibleHeight * Math.max(rect.width, 0)
    const naturalArea = img.naturalWidth * img.naturalHeight
    return visibleArea > 0 ? visibleArea * 10 + naturalArea / 1000 : naturalArea / 1000
  }

  function isLikelyReferenceImage(img, resultImage) {
    if (!isUsableImage(img) || img === resultImage) return false
    const box = img.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) return false
    if (box.width > REFERENCE_RENDERED_EDGE_MAX || box.height > REFERENCE_RENDERED_EDGE_MAX) return false
    return true
  }

  function findMessageRoot(node) {
    let current = node
    for (let i = 0; current && i < 8; i += 1) {
      if (current.matches?.(MESSAGE_ROOT_SELECTOR)) {
        return current
      }
      current = current.parentElement
    }
    return node?.closest?.('div') || null
  }

  function findPromptForImage(img) {
    const promptRoot = findNearestPromptRootBeforeImage(img)
    const promptRootText = promptRoot ? cleanPromptText(promptRoot) : ''
    if (promptRootText) return promptRootText

    const root = findMessageRoot(img)
    const candidates = []
    let current = root
    for (let i = 0; current && i < 10; i += 1) {
      const text = cleanPromptText(current)
      if (text) candidates.push(text)
      let previous = current.previousElementSibling
      while (previous) {
        const previousText = cleanPromptText(previous)
        if (previousText && !looksLikeGeminiChrome(previousText)) {
          candidates.push(previousText)
          break
        }
        previous = previous.previousElementSibling
      }
      current = current.parentElement
    }

    const legacyPrompt = candidates
      .map(cleanPromptString)
      .find(Boolean)
    if (legacyPrompt) return legacyPrompt

    return findNearestPromptTextBeforeImage(img)
  }

  function findVisibleReferenceImages(img) {
    const promptRoot = findNearestPromptRootBeforeImage(img)
    const turn = img.closest?.('.conversation-container')
    if (!promptRoot || (turn && !turn.contains(promptRoot))) return []
    const references = collectReferenceCandidates(promptRoot, img)
    return references.length ? references : findPromptScopeReferenceImages(promptRoot, img)
  }

  function classifyCapture(input) {
    if (!input.resultPresent) {
      return {
        complete: false,
        reason: '没有识别到 Gemini 结果图',
      }
    }

    if (!input.prompt) {
      return {
        complete: false,
        reason: '没有识别到当前轮提示词',
      }
    }

    if (input.visibleReferenceCount === 0) {
      if (input.cachedReferenceCount > 0) {
        return {
          complete: false,
          reason: '检测到缓存参考图，但无法确认它们属于当前结果',
        }
      }
      return {
        complete: true,
        reason: '未检测到参考图，将只保存结果图和提示词',
      }
    }

    if (input.cachedReferenceCount === input.visibleReferenceCount) {
      return {
        complete: true,
        reason: `已捕获 ${input.cachedReferenceCount} 张原始参考图`,
      }
    }

    if (input.recoveredReferenceCount === input.visibleReferenceCount) {
      return {
        complete: true,
        reason: `已从当前页面恢复 ${input.recoveredReferenceCount} 张参考图`,
      }
    }

    return {
      complete: false,
      reason: `参考图不完整：页面显示 ${input.visibleReferenceCount} 张，当前可保存 ${Math.max(input.cachedReferenceCount, input.recoveredReferenceCount)} 张`,
    }
  }

  function cleanPromptText(element) {
    const extracted = extractPromptDomText(element)
    const domText = cleanPromptString(extracted.text)
    // 结构化遍历已经选定正文时，不能再用含预览副本的 innerText 覆盖它。
    if (extracted.removedVariants) return domText
    const renderedText = cleanPromptString(element?.innerText || element?.textContent || '')
    if (!domText) return renderedText
    if (isTruncatedPreview(domText, renderedText)) return renderedText
    return domText
  }

  function comparablePrompt(text) {
    return stripUiText(normalizePromptWhitespace(text || '')).replace(/\s/g, '')
  }

  function isTruncatedPreview(preview, fullText) {
    const prefix = comparablePrompt(preview).replace(/(?:…+|\.{3,})$/, '')
    const full = comparablePrompt(fullText).replace(/(?:…+|\.{3,})$/, '')
    return /(?:…+|\.{3,})\s*$/.test(preview)
      && prefix.length >= 16
      && full.length > prefix.length
      && full.startsWith(prefix)
  }

  function isPromptBodyVariant(element) {
    // query-text-line / 普通 p 是正文段落，不能当成重复的整份正文。
    return element.matches?.('.query-text, .queryText, [data-test-id="query-text"], [data-testid="query-text"]')
      || element.hasAttribute?.('hidden')
      || element.getAttribute?.('aria-hidden') === 'true'
  }

  function mirroredPromptChildren(element) {
    const candidates = Array.from(element.children || [])
      .filter((child) => !child.matches?.(PROMPT_UI_LABEL_SELECTOR)
        && !child.matches?.('user-query, model-response, [data-message-author-role]')
        && !child.querySelector?.('user-query, model-response, [data-message-author-role]'))
      .map((child) => ({ child, text: stripUiText(normalizePromptWhitespace(child.textContent || '')) }))
      .filter((candidate) => candidate.text.length > 0)
    const skipped = new Set()
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      for (let otherIndex = 0; otherIndex < candidates.length; otherIndex += 1) {
        if (index === otherIndex) continue
        const other = candidates[otherIndex]
        const sameBody = comparablePrompt(candidate.text) === comparablePrompt(other.text)
        const hasVariantEvidence = isPromptBodyVariant(candidate.child) || isPromptBodyVariant(other.child)
        const duplicateVariant = sameBody && otherIndex < index && hasVariantEvidence
        if (hasVariantEvidence && (duplicateVariant || isTruncatedPreview(candidate.text, other.text))) {
          skipped.add(candidate.child)
          break
        }
      }
    }
    return skipped
  }

  function extractPromptDomText(element) {
    if (!element?.childNodes?.length) return { text: '', removedVariants: false }
    let output = ''
    let removedVariants = false

    function appendLineBreak(force = false) {
      if (!output) return
      if (force || !output.endsWith('\n')) output += '\n'
    }

    function visit(node) {
      if (node.nodeType === 3) {
        const value = String(node.nodeValue || '').replace(/\u00a0/g, ' ')
        if (!value.trim()) {
          if (!/[\r\n]/.test(value) && output && !/[ \n]$/.test(output)) output += ' '
          return
        }
        output += value
        return
      }

      if (node.nodeType !== 1) return
      // Gemini embeds a visually hidden summary inside query-text. It is UI
      // metadata, not a prompt paragraph; innerText includes it as well.
      if (node.matches?.(PROMPT_UI_LABEL_SELECTOR)) {
        removedVariants = true
        return
      }
      if (node.tagName === 'BR') {
        appendLineBreak(true)
        return
      }

      const before = output.length
      const skipped = mirroredPromptChildren(node)
      if (skipped.size > 0) removedVariants = true
      for (const child of Array.from(node.childNodes || [])) {
        if (!skipped.has(child)) visit(child)
      }
      if (PROMPT_BLOCK_TAGS.has(node.tagName)) {
        appendLineBreak(output.length === before)
      }
    }

    visit(element)
    return { text: output, removedVariants }
  }

  function cleanPromptString(text) {
    const cleaned = stripUiText(normalizePromptWhitespace(text || ''))
    if (cleaned.length < 2 || cleaned.length > 8000) return ''
    if (looksLikeGeminiChrome(cleaned)) return ''
    return cleaned
  }

  function normalizePromptWhitespace(text) {
    return text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  function stripUiText(text) {
    return text
      .replace(/^\s*(你说|You said)\s*(?:[:：]|\n)?\s*/i, '')
      .replace(/^\s*(Save to Banana|保存到 Banana|Share|Export|Download|Copy|Like|Dislike|Retry|Edit|More|Show more|Show less|展开|显示更多|收起)\s*$/gim, '')
      .replace(/Gemini can make mistakes[\s\S]*$/i, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  function looksLikeGeminiChrome(text) {
    return /^(Gemini|Apps|Help|Settings|New chat|Recent|Extensions|Image|Video|Canvas|Deep Research)$/i.test(text)
  }

  function findNearestPromptRootBeforeImage(img) {
    const doc = img?.ownerDocument || globalScope.document
    if (!doc) return null
    const imageBox = img.getBoundingClientRect?.()
    if (!imageBox) return null

    const nearest = Array.from(doc.querySelectorAll(PROMPT_ROOT_SELECTOR))
      .map((element) => {
        const candidate = promptRootCandidate(element, imageBox)
        return candidate ? { ...candidate, element } : null
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance)[0]?.element || null

    return nearest ? findMostCompletePromptRoot(nearest, imageBox) : null
  }

  function findMostCompletePromptRoot(element, imageBox) {
    const candidates = []
    let current = element
    for (let depth = 0; current && depth < 8; depth += 1) {
      if (current.matches?.(PROMPT_ROOT_SELECTOR)) {
        const candidate = promptRootCandidate(current, imageBox)
        if (candidate) {
          candidates.push({
            element: current,
            priority: promptRootPriority(current),
            depth,
          })
        }
      }
      current = current.parentElement
    }

    return candidates
      .sort((a, b) => b.priority - a.priority || a.depth - b.depth)[0]?.element || element
  }

  function promptRootCandidate(element, imageBox) {
    const box = element.getBoundingClientRect?.()
    const text = cleanPromptText(element)
    if (!box || !text) return null
    const distance = Math.max(imageBox.top - box.bottom, 0)
    const overlapsAbove = box.bottom <= imageBox.top + 24
    return overlapsAbove ? { text, distance } : null
  }

  function promptRootPriority(element) {
    if (element.matches?.('user-query, [data-message-author-role="user"]')) return 3
    if (element.matches?.('[data-test-id*="user"], [data-testid*="user"]')) return 2
    return 1
  }

  function findNearestPromptTextBeforeImage(img) {
    const doc = img?.ownerDocument || globalScope.document
    if (!doc) return ''
    const imageBox = img.getBoundingClientRect?.()
    if (!imageBox) return ''

    const searchRoot = doc.querySelector('main') || doc.body
    return Array.from(searchRoot.querySelectorAll('div, p, span, message-content'))
      .map((element) => {
        if (element.contains?.(img)) return null
        const box = element.getBoundingClientRect?.()
        const text = cleanPromptText(element)
        if (!box || !text || box.bottom > imageBox.top + 24) return null
        if (element.querySelector?.('img')) return null
        return {
          text,
          distance: Math.max(imageBox.top - box.bottom, 0),
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance)[0]?.text || ''
  }

  function findPromptScopeReferenceImages(promptRoot, resultImage) {
    let current = promptRoot.parentElement
    const messages = PROMPT_ROOT_SELECTOR + ', model-response, [data-message-author-role]'
    for (let i = 0; current && i < 5; i += 1) {
      // Thumbnails may be siblings of the prompt text, but not in another turn.
      if (current.matches('main, body') || Array.from(current.querySelectorAll(messages)).some(message =>
        !message.contains(promptRoot) && !promptRoot.contains(message) && !message.contains(resultImage),
      )) break
      const refs = collectReferenceCandidates(current, resultImage)
        .filter((candidate) => isAboveResult(candidate, resultImage))
      if (refs.length > 0) return refs
      current = current.parentElement
    }
    return []
  }

  function isAboveResult(candidate, resultImage) {
    const candidateBox = candidate.getBoundingClientRect?.()
    const resultBox = resultImage.getBoundingClientRect?.()
    if (!candidateBox || !resultBox) return true
    return candidateBox.bottom <= resultBox.top + 48
  }

  function collectReferenceCandidates(scope, resultImage) {
    if (!scope) return []
    const candidates = []
    for (const img of Array.from(scope.querySelectorAll?.('img') || [])) {
      if (isLikelyReferenceImage(img, resultImage)) candidates.push(img)
    }

    for (const element of Array.from(scope.querySelectorAll?.('*') || [])) {
      const url = extractBackgroundImageUrl(element)
      if (!url) continue
      const box = element.getBoundingClientRect?.()
      if (!box || box.width <= 0 || box.height <= 0) continue
      if (box.width > REFERENCE_RENDERED_EDGE_MAX || box.height > REFERENCE_RENDERED_EDGE_MAX) continue
      candidates.push({
        element,
        get src() {
          const source = extractBackgroundImageUrl(element)
          return source ? absoluteUrl(source, element.ownerDocument) : ''
        },
        naturalWidth: Math.max(Math.round(box.width), 24),
        naturalHeight: Math.max(Math.round(box.height), 24),
        getBoundingClientRect: () => box,
      })
    }

    return uniqueImageCandidates(candidates)
  }

  function extractBackgroundImageUrl(element) {
    const style = globalScope.getComputedStyle?.(element)
    const value = style?.backgroundImage || ''
    const match = /^url\((['"]?)(.*?)\1\)$/.exec(value.trim())
    return match?.[2] || ''
  }

  function absoluteUrl(url, doc) {
    try {
      return new URL(url, doc?.location?.href || globalScope.location?.href).href
    } catch {
      return url
    }
  }

  function uniqueImageCandidates(candidates) {
    const seen = new Set()
    return candidates.filter((candidate) => {
      const src = candidate.currentSrc || candidate.src
      if (!src || seen.has(src)) return false
      seen.add(src)
      return true
    })
  }

  globalScope.BananaGeminiExtractor = {
    isResultImage,
    selectCurrentResultImage,
    findPromptForImage,
    findVisibleReferenceImages,
    classifyCapture,
  }
})(globalThis)

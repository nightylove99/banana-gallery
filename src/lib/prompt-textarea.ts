export const PROMPT_DEFAULT_HEIGHT = 200

interface PromptTextareaResizeOptions {
  collapsed?: boolean
  collapsedHeight?: number
  scrollContainer?: Pick<HTMLElement, 'scrollTop'> | null
}

// 在浏览器绘制前重算高度，同时保留外层页面和输入框自身的滚动位置。
export function resizePromptTextarea(
  el: Pick<
    HTMLTextAreaElement,
    | 'scrollHeight'
    | 'scrollTop'
    | 'selectionStart'
    | 'selectionEnd'
    | 'setSelectionRange'
    | 'style'
  >,
  {
    collapsed = false,
    collapsedHeight = PROMPT_DEFAULT_HEIGHT,
    scrollContainer = null,
  }: PromptTextareaResizeOptions = {},
) {
  const outerScrollTop = scrollContainer?.scrollTop
  const innerScrollTop = el.scrollTop
  const selectionStart = el.selectionStart
  const selectionEnd = el.selectionEnd
  const previousHeight = el.style.height
  const previousOverflow = el.style.overflowY

  el.style.height = 'auto'
  el.style.overflowY = 'hidden'

  const contentHeight = Math.max(PROMPT_DEFAULT_HEIGHT, el.scrollHeight)
  const targetHeight = collapsed ? collapsedHeight : contentHeight
  const targetHeightValue = `${targetHeight}px`
  const targetOverflow = collapsed && el.scrollHeight >= targetHeight - 2
    ? 'auto'
    : 'hidden'

  if (previousHeight !== targetHeightValue) {
    el.style.height = targetHeightValue
  } else {
    el.style.height = previousHeight
  }
  if (previousOverflow !== targetOverflow) {
    el.style.overflowY = targetOverflow
  } else {
    el.style.overflowY = previousOverflow
  }

  if (
    el.selectionStart !== selectionStart ||
    el.selectionEnd !== selectionEnd
  ) {
    el.setSelectionRange(selectionStart, selectionEnd)
  }
  el.scrollTop = innerScrollTop
  if (scrollContainer && outerScrollTop !== undefined) {
    scrollContainer.scrollTop = outerScrollTop
  }

  return contentHeight
}

/**
 * 将 API 失败映射为生成页等场景用的标题 + 可选正文（与标题完全相同时省略正文）。
 */

export function presentationForHttpActionError(
  status: number | undefined,
  detail: string,
): { title: string; detail: string | null } {
  const title =
    status !== undefined ? titleForHttpStatus(status) : fallbackTitleWithoutStatus(detail)
  const normalized = detail.trim()
  if (!normalized || normalized === title) {
    return { title, detail: null }
  }
  return { title, detail: normalized }
}

function titleForHttpStatus(status: number): string {
  if (status === 400) return '请求无效'
  if (status === 401) return '需要重新登录'
  if (status === 403) return '无法完成操作'
  if (status === 404) return '未找到资源'
  if (status === 422) return '内容无法处理'
  if (status === 408 || status === 504) return '请求超时'
  if (status === 429) return '请求过于频繁'
  if (status === 502) return '网关异常'
  if (status === 503) return '服务暂时不可用'
  if (status >= 500) return '服务异常，请稍后重试'
  return '操作未成功'
}

function fallbackTitleWithoutStatus(detail: string): string {
  const d = detail.toLowerCase()
  if (
    d.includes('failed to fetch') ||
    d.includes('networkerror') ||
    d.includes('load failed') ||
    d.includes('network request failed')
  ) {
    return '网络连接失败'
  }
  return '操作未成功'
}

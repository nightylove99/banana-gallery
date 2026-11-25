// 图库用于匹配图片尺寸的常见宽高比
export const SUPPORTED_ASPECT_RATIOS = [
  { label: '1:1', w: 1, h: 1 },
  { label: '2:3', w: 2, h: 3 },
  { label: '3:2', w: 3, h: 2 },
  { label: '3:4', w: 3, h: 4 },
  { label: '4:3', w: 4, h: 3 },
  { label: '4:5', w: 4, h: 5 },
  { label: '5:4', w: 5, h: 4 },
  { label: '9:16', w: 9, h: 16 },
  { label: '16:9', w: 16, h: 9 },
  { label: '21:9', w: 21, h: 9 },
] as const

export type AspectRatioLabel = (typeof SUPPORTED_ASPECT_RATIOS)[number]['label']

export const SUPPORTED_RESOLUTIONS = ['1K', '1.5K', '2K', '3K', '4K'] as const
export type Resolution = (typeof SUPPORTED_RESOLUTIONS)[number]

/**
 * 根据实际像素宽高，匹配最接近的 Gemini 支持宽高比。
 * 使用比值差的对数距离比较，对极端比例更鲁棒。
 */
export function matchAspectRatio(width: number, height: number): AspectRatioLabel {
  if (width <= 0 || height <= 0) return '1:1'
  const actual = width / height
  // 明确标注为任一候选项，避免被推断成第一个固定比例。
  let best: (typeof SUPPORTED_ASPECT_RATIOS)[number] = SUPPORTED_ASPECT_RATIOS[0]
  let bestDist = Infinity
  for (const r of SUPPORTED_ASPECT_RATIOS) {
    const dist = Math.abs(Math.log(actual) - Math.log(r.w / r.h))
    if (dist < bestDist) {
      bestDist = dist
      best = r
    }
  }
  return best.label
}

/**
 * 根据像素总数判断分辨率档位。
 * Gemini 2K 档总像素约 400~500 万，4K 档约 1600~1700 万，
 * 以 800 万像素为分界线。
 */
export function classifyResolution(width: number, height: number): Resolution {
  if (width <= 0 || height <= 0) return '2K'
  const pixels = width * height
  return pixels > 8_000_000 ? '4K' : '2K'
}

/**
 * 格式化尺寸信息为简短字符串，如 "2K 2:3"
 */
export function formatImageSpec(width: number, height: number): string {
  if (width <= 0 || height <= 0) return ''
  return `${classifyResolution(width, height)} ${matchAspectRatio(width, height)}`
}

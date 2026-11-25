// Input capacity allows PNG normalization; the stored asset limit stays unchanged.
export const IMAGE_FINAL_MAX_BYTES = 25 * 1024 * 1024
export const PNG_INPUT_MAX_BYTES = 100 * 1024 * 1024
export const IMAGE_INPUT_LIMIT_MESSAGE = 'PNG 原图最多 100 MiB，JPG / WebP 最多 25 MiB；转换后每张图片须不超过 25 MiB'

export function imageInputMaxBytes(mimeType: string) {
  return mimeType === 'image/png' ? PNG_INPUT_MAX_BYTES : IMAGE_FINAL_MAX_BYTES
}

import { readFile } from 'node:fs/promises'

/** Keep libvips from holding a Windows file mapping after decoding WebP. */
export async function readSharpInput(source: string | Buffer): Promise<string | Buffer> {
  if (process.platform === 'win32' && typeof source === 'string') return readFile(source)
  return source
}

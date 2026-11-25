import sharp from 'sharp'
import type { GenerateImageProviderInput, ImageGenerationProvider } from './image-generation-provider.ts'

export class DemoImageGenerationProvider implements ImageGenerationProvider {
  async generateImage({ aspectRatio }: GenerateImageProviderInput) {
    const [horizontal, vertical] = aspectRatio.split(':').map(Number)
    if (!(horizontal > 0 && vertical > 0 && Number.isFinite(horizontal) && Number.isFinite(vertical))) {
      throw new Error('演示渠道需要有效的宽高比')
    }
    const longest = Math.max(horizontal, vertical)
    const width = Math.max(1, Math.round(1024 * (horizontal / longest)))
    const height = Math.max(1, Math.round(1024 * (vertical / longest)))

    const artwork = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1024 1024" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="sky" x2="1" y2="1">
          <stop stop-color="#171431"/><stop offset="1" stop-color="#56365e"/>
        </linearGradient>
        <linearGradient id="sun" x2=".7" y2="1">
          <stop stop-color="#fff6b2"/><stop offset="1" stop-color="#f98768"/>
        </linearGradient>
        <linearGradient id="hills" x2="1" y2="1">
          <stop stop-color="#b86885"/><stop offset="1" stop-color="#453b72"/>
        </linearGradient>
      </defs>
      <path fill="url(#sky)" d="M0 0H1024V1024H0Z"/>
      <circle cx="512" cy="472" r="164" fill="url(#sun)"/>
      <circle cx="512" cy="472" r="201" fill="none" stroke="#f7bb9c" stroke-opacity=".42"/>
      <circle cx="512" cy="472" r="220" fill="none" stroke="#f7bb9c" stroke-opacity=".22"/>
      <path fill="url(#hills)" d="M0 601L222 462l192 141 160-71 450 177v315H0Z"/>
      <path fill="#18172f" d="M0 745l250-101 188 33 206-86 380 160v273H0Z"/>
      <path fill="none" stroke="#ffd5a0" stroke-opacity=".5" d="M445 650h134m-109 13h84m-62 13h40"/>
    </svg>`

    return { buffer: await sharp(Buffer.from(artwork)).png().toBuffer(), mimeType: 'image/png' }
  }
}

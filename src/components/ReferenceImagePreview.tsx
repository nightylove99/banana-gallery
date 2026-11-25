import { referenceAssetUrl } from '@/api'
import type { GalleryImage } from '@/types'
import type { ReactNode } from 'react'

type ReferencePreview = { src: string; alt: string; width?: number; height?: number }
export type PreviewReferenceImage = (image: ReferencePreview) => void

export function ReferenceImageThumbnail({ src, index, onPreview }: {
  src: string
  index: number
  onPreview: PreviewReferenceImage
}) {
  return <button type="button" className="relative block aspect-square w-full overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 hover:opacity-80" aria-label={`放大参考图 ${index + 1}`}
    onClick={event => {
      const img = event.currentTarget.querySelector('img')
      onPreview({ src, alt: '参考图', width: img?.naturalWidth, height: img?.naturalHeight })
    }}>
    <img src={src} alt={`Reference ${index + 1}`} draggable={false} className="h-full w-full object-cover" />
    <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">{index + 1}</span>
  </button>
}

export function ReferenceImageSection({ count, actions, children }: {
  count: number
  actions?: ReactNode
  children: ReactNode
}) {
  return <section className="border-b border-[#1E2336] px-4 py-4 space-y-3" aria-label="参考图片">
    <div className="flex items-center justify-between">
      <h3 className="text-sm font-semibold text-zinc-200">参考图片{count > 0 && <span className="ml-2 text-xs font-normal text-zinc-500">{count} 张</span>}</h3>
      {actions}
    </div>
    {children}
  </section>
}

export function ReferenceImageNote({ note }: { note?: string }) {
  return note ? <p className="mt-1 break-words text-xs text-zinc-400">{note}</p> : null
}

export function ReferenceImagePreview({ image, onPreview }: {
  image: Pick<GalleryImage, 'referenceImages' | 'referenceNotes'>
  onPreview: PreviewReferenceImage
}) {
  return <ReferenceImageSection count={image.referenceImages.length}>
    {image.referenceImages.length ? <div className="grid grid-cols-3 gap-2">
      {image.referenceImages.map((filename, index) => <div key={`${index}:${filename}`}>
        <ReferenceImageThumbnail src={referenceAssetUrl(filename)} index={index} onPreview={onPreview} />
        <ReferenceImageNote note={image.referenceNotes?.[index]} />
      </div>)}
    </div> : <p className="py-3 text-center text-xs text-zinc-500">暂无参考图</p>}
  </ReferenceImageSection>
}

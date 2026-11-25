import { useState, type ComponentProps } from 'react'

type Props = Omit<ComponentProps<'img'>, 'src' | 'onError'> & { src: string }

export function RetryableImage(props: Props) {
  return <ImageRequest key={props.src} {...props} />
}

function ImageRequest({ src, ...props }: Props) {
  const [retry, setRetry] = useState(0)
  const [failed, setFailed] = useState(false)
  if (failed) return (
    <div className="flex flex-wrap items-center justify-center gap-2 rounded-lg bg-zinc-900 p-4 text-sm text-zinc-300" role="status">
      图片加载失败
      <button type="button" className="rounded border border-zinc-600 px-3 py-1 hover:bg-zinc-800" onClick={() => {
        setRetry(Date.now())
        setFailed(false)
      }}>重新加载图片</button>
    </div>
  )
  return <img {...props} src={retry ? `${src}${src.includes('?') ? '&' : '?'}retry=${retry}` : src} onError={() => setFailed(true)} />
}

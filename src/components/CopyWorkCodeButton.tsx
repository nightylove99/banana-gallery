import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

export function CopyWorkCodeButton({ code, className, showIcon = true, iconOnly = false }: {
  code: string
  className?: string
  showIcon?: boolean
  iconOnly?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={`复制图片编号 ${code}`}
      title={`复制图片编号 ${code}`}
      className={cn('inline-flex w-max shrink-0 items-center gap-1 whitespace-nowrap rounded font-mono focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300', className)}
      onClick={async event => {
        event.stopPropagation()
        try {
          await navigator.clipboard.writeText(code)
          toast.success('已复制图片编号')
        } catch {
          toast.error('复制图片编号失败')
        }
      }}
    >
      {iconOnly ? <span aria-hidden>#</span> : <>{code}{showIcon && <Copy size={12} aria-hidden />}</>}
    </button>
  )
}

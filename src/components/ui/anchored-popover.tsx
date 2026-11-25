import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { cn } from '@/lib/utils'

interface Props {
  label: string
  trigger: ReactNode
  children: (close: () => void) => ReactNode
  className?: string
  above?: RefObject<HTMLElement | null>
  align?: 'start' | 'end'
  disabled?: boolean
  triggerRef?: RefObject<HTMLButtonElement | null>
}

/** A nonmodal disclosure for ordinary form controls and action buttons. */
export function AnchoredPopover({ label, trigger, children, className, above, align = 'start', disabled, triggerRef }: Props) {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const localButton = useRef<HTMLButtonElement>(null)
  const button = triggerRef ?? localButton
  const panel = useRef<HTMLDivElement>(null)
  const [disclosure, setDisclosure] = useState<'closed' | 'open' | 'restoreFocus'>('closed')
  const [position, setPosition] = useState<CSSProperties>()
  const expanded = disclosure === 'open' && !disabled

  useLayoutEffect(() => {
    if (disclosure === 'restoreFocus') button.current?.focus({ preventScroll: true })
  }, [disclosure, button])

  useLayoutEffect(() => {
    if (!expanded) return
    const layout = () => {
      const anchor = button.current?.getBoundingClientRect()
      if (!anchor) return
      const width = Math.min(256, window.innerWidth - 16)
      const below = window.innerHeight - anchor.bottom - 16
      const upperEdge = above?.current?.getBoundingClientRect().top ?? anchor.top
      const top = upperEdge - 16
      const left = align === 'end' ? anchor.right - width : anchor.left
      const desiredHeight = Math.min(panel.current?.scrollHeight || 0, 280)
      const placeAbove = above ? top >= desiredHeight || top >= below : below < desiredHeight && top > below
      setPosition({
        width,
        left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
        ...(placeAbove ? { bottom: window.innerHeight - upperEdge + 8 } : { top: anchor.bottom + 8 }),
        maxHeight: Math.max(0, Math.min(280, placeAbove ? top : below)),
      })
    }
    const onOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setDisclosure('closed')
    }
    layout()
    const first = panel.current?.querySelector<HTMLElement>(
      'input[type=radio]:checked:not([disabled]), [data-autofocus]',
    ) || panel.current?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])')
    const focusTarget = first || panel.current
    focusTarget?.focus({ preventScroll: true })
    document.addEventListener('pointerdown', onOutside)
    window.addEventListener('resize', layout)
    window.addEventListener('scroll', layout, true)
    return () => {
      document.removeEventListener('pointerdown', onOutside)
      window.removeEventListener('resize', layout)
      window.removeEventListener('scroll', layout, true)
    }
  }, [expanded, above, align, button])

  const close = () => setDisclosure('restoreFocus')
  return <div ref={root} className="shrink-0" onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setDisclosure('closed')
  }} onKeyDown={event => {
    if (!expanded || event.key !== 'Escape' || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    close()
  }}>
    <button ref={button} type="button" aria-label={label} aria-expanded={expanded} aria-controls={expanded ? id : undefined}
      disabled={disabled} className={cn('focus-visible:outline-2 focus-visible:outline-indigo-400', className)}
      onClick={() => expanded ? close() : setDisclosure('open')}>
      {trigger}
    </button>
    {expanded && <div ref={panel} id={id} tabIndex={-1} role="group" aria-label={label} style={position}
      className="fixed z-40 w-64 overflow-y-auto overscroll-contain rounded-xl border border-[#292d42] bg-[#151520] p-1.5 text-sm text-zinc-200 shadow-xl shadow-black/40 focus:outline-none">
      {children(close)}
    </div>}
  </div>
}

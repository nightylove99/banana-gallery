import type { ReactNode, RefObject } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { AnchoredPopover } from './anchored-popover'

export function ActionMenu({ label, children, above, className, disabled, triggerRef }: {
  label: string; children: ReactNode; above?: RefObject<HTMLElement | null>; className?: string; disabled?: boolean; triggerRef?: RefObject<HTMLButtonElement | null>
}) {
  return <AnchoredPopover label={label} align="end" above={above} disabled={disabled} triggerRef={triggerRef}
    className={className || 'flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/5 hover:text-zinc-100'}
    trigger={<MoreHorizontal size={18} aria-hidden="true" />}>
    {close => <div
      className="[&_button]:flex [&_button]:w-full [&_button]:items-center [&_button]:gap-2 [&_button]:rounded-md [&_button]:px-3 [&_button]:py-2 [&_button]:text-left [&_button]:text-xs [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-indigo-400 [&_button:hover]:bg-white/5 [&_button[aria-disabled=true]]:text-zinc-500"
      onChange={event => { if (event.target instanceof HTMLSelectElement) close() }}
      onClick={event => {
        const action = (event.target as Element).closest('button')
        if (action && action.getAttribute('aria-disabled') !== 'true') close()
      }}>
      {children}
    </div>}
  </AnchoredPopover>
}

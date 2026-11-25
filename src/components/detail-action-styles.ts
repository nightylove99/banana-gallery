const primaryAction = 'flex min-h-9 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-1.5 py-1 text-xs font-medium leading-tight disabled:opacity-40 [&>svg]:shrink-0'

export const mainDetailAction = primaryAction + ' bg-indigo-500 text-white hover:bg-indigo-400'
export const alternateDetailAction = primaryAction + ' bg-indigo-500/15 text-indigo-100 hover:bg-indigo-500/25'
export const iconAction = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/10'
export const secondaryAction = 'flex h-8 min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-1 text-xs text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 disabled:opacity-40 [&>svg]:shrink-0'
export const relatedDetailAction = 'max-w-full break-words rounded-md bg-zinc-800 px-2 py-1 text-zinc-300 hover:bg-zinc-700'

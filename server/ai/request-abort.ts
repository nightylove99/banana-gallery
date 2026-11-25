import { setTimeout as delay } from 'node:timers/promises'

export function stepSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([timeout, signal]) : timeout
}

export function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return delay(milliseconds, undefined, { signal })
}

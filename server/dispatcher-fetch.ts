import { FormData as UndiciFormData, fetch as undiciFetch, type Dispatcher } from 'undici'

export function fetchWithDispatcher(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  dispatcher: Dispatcher,
): Promise<Response> {
  // Node's built-in FormData and the installed undici can have different brands.
  let body: unknown = init?.body
  if (body instanceof FormData) {
    const multipart = new UndiciFormData()
    for (const [name, value] of body.entries()) {
      if (typeof value === 'string') multipart.append(name, value)
      else multipart.append(name, value, value.name)
    }
    body = multipart
  }
  return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...init, body, dispatcher,
  } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>
}

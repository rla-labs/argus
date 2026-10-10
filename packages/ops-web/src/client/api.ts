// == ARGUS AGENT PROJECT ==
/** The server's API, as the page uses it. */

/** Thrown when the session is gone; the page shows how to sign in again. */
export class SignedOut extends Error {}

/** GET a JSON resource. */
export async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin' })
  if (response.status === 401) throw new SignedOut()
  if (!response.ok) throw new Error(`${response.status}`)
  return (await response.json()) as T
}

/** POST JSON; the header is what a cross-site form cannot send. */
export async function post<T>(path: string, body: unknown): Promise<{ ok: boolean; status: number; body: T }> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-argus': '1' },
    body: JSON.stringify(body),
  })
  if (response.status === 401) throw new SignedOut()
  const text = await response.text()
  return { ok: response.ok, status: response.status, body: (text.length === 0 ? {} : JSON.parse(text)) as T }
}

/** A command's outcome. */
export interface CommandOutcome {
  readonly text: string
  readonly error: boolean
  readonly buttons: ReadonlyArray<{ label: string; command: string }>
}

/** Run a command line as the signed-in person. */
export async function command(line: string): Promise<CommandOutcome> {
  return (await post<CommandOutcome>('/api/command', { line })).body
}

/**
 * Listen for "something changed".
 *
 * @param onTopic called with `overview`, `settings` or `chat`.
 * @param onState called with whether the stream is connected.
 * @returns the stop function.
 */
export function listen(onTopic: (topic: string) => void, onState: (connected: boolean) => void): () => void {
  const source = new EventSource('/api/events')
  source.addEventListener('changed', (event) => onTopic((event as MessageEvent<string>).data))
  source.onopen = () => onState(true)
  source.onerror = () => onState(false)
  return () => source.close()
}

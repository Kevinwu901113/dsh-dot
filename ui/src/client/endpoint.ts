/** Where the computer's web services listen on the user's machine. */
export interface ComputerEndpoint {
  readonly host: string
  readonly port: number
}

/**
 * entry page of the computer's live view, relayed by dsh-dot/computer on dsh's own web server
 * (same origin, behind dsh's login); it sends the frame on to noVNC with a socket ticket. The gateway port is never addressed.
 * @param _endpoint - unused; the live view is same-origin.
 * @returns the live view URL.
 */
export function liveViewUrl(_endpoint: ComputerEndpoint): string {
  const base = (() => { try { return window.location.origin } catch { return '' } })()
  return `${base}/dsh-dot/computer/`
}

/**
 * Whether the computer's desktop answers: its status, served by the relay for the signed-in owner.
 * @param _endpoint - unused; the status is same-origin.
 * @param signal - aborts the probe.
 * @returns `true` when the computer's web services are ready.
 */
export async function probe(_endpoint: ComputerEndpoint, signal: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(3000)
  try {
    const res = await fetch('/dsh-dot/computer/status', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.any([signal, timeout]) })
    if (!res.ok) return false
    return ((await res.json()) as { state?: string }).state === 'ready'
  } catch {
    // Not signed in, timed out, or aborted: the computer is not answering.
    return false
  }
}

/** The dot panel, served by dsh-dot/dot on dsh's own web server (same origin as the client). */
export function panelUrl(): string {
  try { return `${window.location.origin}/dsh-dot/panel/` } catch { return '/dsh-dot/panel/' }
}

/**
 * Whether the panel answers (dsh-dot/dot is loaded and its route is mounted).
 * @param _endpoint - unused; the panel is same-origin.
 * @param signal - aborts the probe.
 * @returns `true` when `/dsh-dot/api/state` answered 200.
 */
export async function probePanel(_endpoint: ComputerEndpoint, signal: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(3000)
  try {
    const res = await fetch(`${panelUrl()}api/state`, { cache: 'no-store', signal: AbortSignal.any([signal, timeout]) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * The phone's live view page, served by dsh-dot/phone on dsh's own web server (same origin,
 * behind dsh's login).
 * @param _endpoint - unused; the live view is same-origin.
 * @returns the page URL.
 */
export function phoneLiveViewUrl(_endpoint: ComputerEndpoint): string {
  try { return `${window.location.origin}/dsh-dot/phone/` } catch { return '/dsh-dot/phone/' }
}

/**
 * Whether the phone answers (its live view reports `ready`).
 * @param _endpoint - unused; the live view is same-origin.
 * @param signal - aborts the probe.
 * @returns `true` when the phone is booted.
 */
export async function probePhone(_endpoint: ComputerEndpoint, signal: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(3000)
  try {
    const res = await fetch(`${phoneLiveViewUrl(_endpoint)}status`, { cache: 'no-store', signal: AbortSignal.any([signal, timeout]) })
    const body = await res.json() as { ready?: boolean }
    return body.ready === true
  } catch {
    // Refused, timed out, aborted, or not JSON: the phone is not answering.
    return false
  }
}

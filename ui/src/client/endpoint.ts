/** Where the computer's web services listen on the user's machine. */
export interface ComputerEndpoint {
  readonly host: string
  readonly port: number
}

/**
 * noVNC page that scales the remote desktop to the panel and reconnects after VM restarts.
 * @param endpoint - computer host and port.
 * @returns the live view URL.
 */
export function liveViewUrl(endpoint: ComputerEndpoint): string {
  return `http://${endpoint.host}:${endpoint.port}/vnc/index.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=2000`
}

/**
 * Whether the computer's sandbox API accepts a connection. An opaque `no-cors`
 * response still proves the listener is up; a refused connection rejects.
 * @param endpoint - computer host and port.
 * @param signal - aborts the probe.
 * @returns `true` when the computer answered within three seconds.
 */
export async function probe(endpoint: ComputerEndpoint, signal: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(3000)
  try {
    await fetch(`http://${endpoint.host}:${endpoint.port}/v1/sandbox`, {
      mode: 'no-cors', cache: 'no-store', signal: AbortSignal.any([signal, timeout]),
    })
    return true
  } catch {
    // Refused, timed out, or aborted: the computer is not answering.
    return false
  }
}

/** The dot panel, served by dsh-dot/dot on dsh's own web server (same origin as the client). */
export function panelUrl(): string {
  try { return `${window.location.origin}/dsh-dot/` } catch { return '/dsh-dot/' }
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
 * The phone's live view page served by dsh-dot/phone.
 * @param endpoint - live view host and port.
 * @returns the page URL.
 */
export function phoneLiveViewUrl(endpoint: ComputerEndpoint): string {
  return `http://${endpoint.host}:${endpoint.port}/`
}

/**
 * Whether the phone answers (its live view reports `ready`).
 * @param endpoint - live view host and port.
 * @param signal - aborts the probe.
 * @returns `true` when the phone is booted.
 */
export async function probePhone(endpoint: ComputerEndpoint, signal: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(3000)
  try {
    const res = await fetch(`http://${endpoint.host}:${endpoint.port}/status`, { cache: 'no-store', signal: AbortSignal.any([signal, timeout]) })
    const body = await res.json() as { ready?: boolean }
    return body.ready === true
  } catch {
    // Refused, timed out, aborted, or not JSON: the phone is not answering.
    return false
  }
}

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

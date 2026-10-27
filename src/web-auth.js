// One identity root for every web surface dsh-dot exposes (the phone's live view and controls, the
// dot panel): dsh's own `connection` service. Its `requestRejection` applies the Host/Origin fence
// (defeats DNS rebinding and cross-site calls) and dsh's browser login — the same gate dsh's own
// routes stand behind — and it never trusts a forwarded header. dsh-dot adds no auth of its own:
// no tokens, no origin heuristics, no port that answers to anyone who can reach it.

/**
 * Reject a request unless dsh recognises the caller as the signed-in owner. Returns true when the
 * response has been ended with 401/403 (or 503 while the connection service is missing).
 */
export function rejectUnlessOwner(connection, req, res) {
  if (!connection || typeof connection.requestRejection !== 'function') {
    res.writeHead(503, { 'cache-control': 'no-store' }).end('dsh connection service unavailable');
    return true;
  }
  let rejection;
  try { rejection = connection.requestRejection(req); } catch (error) { void error; rejection = 403; }
  if (rejection === undefined) return false;
  res.writeHead(rejection === 401 ? 401 : 403, { 'cache-control': 'no-store' }).end();
  return true;
}

/** The URL a browser on this machine uses for a path on dsh's web server ('' when unknown yet). */
export function localUrl(webServer, path) {
  try { return `${webServer.getOrigin()}${path}`; } catch (error) { void error; return ''; }
}

/** The same path on a public origin the user configured (their own dsh exposure, e.g. tailscale serve). */
export function publicUrlOf(publicOrigin, path) {
  const base = String(publicOrigin ?? '').trim().replace(/\/+$/, '');
  return base ? `${base}${path}` : undefined;
}

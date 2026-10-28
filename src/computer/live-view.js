// dsh-computer/live-view: the computer's desktop (noVNC) behind dsh's own login. The gateway port
// is keyed (see key.js) and nothing hands that key to a browser: this mounts /dsh-dot/computer on
// dsh's web server, rejects anyone dsh does not recognise as the owner (web-auth.js), and relays
// what remains to the gateway with the key attached — static noVNC files over HTTP, the VNC stream
// over one WebSocket upgrade. The client tab and approval messages point here, never at the port.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { rejectUnlessOwner } from '../web-auth.js';
import { keyHeaders } from './key.js';

export const LIVE_VIEW_PATH = '/dsh-dot/computer';
/** Upgrade routes are exact-path: noVNC is told to open its socket here (`path=` in the page URL). */
export const WEBSOCKIFY_PATH = `${LIVE_VIEW_PATH}/websockify`;
/** What a browser opens (relative to dsh's origin): a tiny page that sends it on to noVNC with a socket ticket. */
export const LIVE_VIEW_PAGE = `${LIVE_VIEW_PATH}/`;
/** How long a socket ticket lives, and how many may be outstanding (one per page load). */
const TICKET_MS = 120_000;
const TICKET_MAX = 32;

/**
 * The noVNC page URL for one visit. `origin` is dsh's HTTP origin: the desktop app shows its UI from
 * its own scheme and carries HTTP over a bridge, which a WebSocket cannot ride, so noVNC is told the
 * real host and port and given a single-use ticket (`?t=`) in place of the cookie it will not have.
 */
export function vncPageUrl(origin, ticket) {
  let host = '127.0.0.1', port = '';
  try { const u = new URL(origin); host = u.hostname; port = u.port || (u.protocol === 'https:' ? '443' : '80'); } catch {}
  const path = `${WEBSOCKIFY_PATH.slice(1)}?t=${ticket}`;
  const q = new URLSearchParams({ autoconnect: 'true', resize: 'scale', reconnect: 'true', reconnect_delay: '2000', host, port, encrypt: String(origin.startsWith('https:')), path });
  return `${LIVE_VIEW_PATH}/vnc/index.html?${q}`;
}

/** A peer address as one string: IPv4-mapped IPv6 (::ffff:127.0.0.1) and plain IPv4 compare equal. */
const peer = (addr) => String(addr ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

/**
 * Socket tickets: single use, short life, and bound to the address that loaded the page — a ticket
 * that leaks (it rides in the socket URL; noVNC can pass nothing else) is useless from elsewhere.
 */
export function createTicketStore({ ttlMs = TICKET_MS, max = TICKET_MAX, now = Date.now } = {}) {
  const tickets = new Map(); // ticket → { exp, addr }
  return {
    mint(addr) {
      const t0 = now();
      for (const [t, v] of tickets) if (v.exp < t0) tickets.delete(t);
      while (tickets.size >= max) tickets.delete(tickets.keys().next().value);
      const t = randomBytes(24).toString('hex');
      tickets.set(t, { exp: t0 + ttlMs, addr: peer(addr) });
      return t;
    },
    // A page served over the desktop app's bridge has no TCP peer (addr ''): such a ticket is not
    // bound, since the socket it unlocks will arrive on a real loopback connection.
    redeem(t, addr) { const v = tickets.get(t); tickets.delete(t); return Boolean(v) && v.exp >= now() && (v.addr === '' || v.addr === peer(addr)); },
  };
}

/** Only what the desktop view needs is relayed; the gateway's API, MCP, CDP and terminal are not. */
const ALLOWED = [/^\/vnc\//, /^\/websockify$/];
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie', 'authorization', 'x-aio-api-key']);

function upstreamHeaders(req, key, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && !k.startsWith('sec-websocket-') && v !== undefined) out[k] = v;
  return { ...out, ...keyHeaders(key), ...extra };
}

/**
 * Mount the relay. `gateway` is `{ host, port }` of the VM gateway on this machine, `key()` returns
 * the current gateway key, `status()` the computer's status snapshot (served at /status for the tab).
 * Returns `{ close }`.
 */
export function mountComputerView({ webServer, connection, gateway, key, status, origin, logger = {} }) {
  const log = (level, msg) => logger[level]?.(msg);
  const disposers = [];
  const sockets = new Set();
  // Socket tickets: minted only for a page request dsh already recognised as the owner's; one use, short life.
  const tickets = createTicketStore();
  const currentOrigin = () => { try { return origin?.() || webServer.getOrigin?.() || ''; } catch { return ''; } };

  const route = webServer.register({
    kind: 'prefix',
    path: LIVE_VIEW_PATH,
    handler: (req, res) => {
      if (rejectUnlessOwner(connection, req, res)) return;
      const url = new URL(req.url, 'http://x');
      const rest = url.pathname.slice(LIVE_VIEW_PATH.length) || '/';
      if (rest === '/' || rest === '') {
        // The owner (dsh said so): a page that sends the browser on to noVNC with a fresh ticket.
        // The ticket is in the URL: no caching, and no Referer carrying it anywhere.
        const next = vncPageUrl(currentOrigin(), tickets.mint(req.socket?.remoteAddress));
        const html = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>computer</title><meta http-equiv="refresh" content="0;url=${next}"><script>location.replace(${JSON.stringify(next)})</script>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(html);
        return;
      }
      if (rest === '/status') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(status?.() ?? {}));
        return;
      }
      if (!ALLOWED.some((r) => r.test(rest)) || (req.method !== 'GET' && req.method !== 'HEAD')) {
        res.writeHead(404, { 'cache-control': 'no-store' }).end();
        return;
      }
      const up = http.request({ host: gateway.host, port: gateway.port, method: req.method, path: `${rest}${url.search}`, headers: upstreamHeaders(req, key()) }, (r) => {
        const headers = { ...r.headers, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }; // noVNC's page URL holds the ticket too
        delete headers['set-cookie'];
        res.writeHead(r.statusCode ?? 502, headers);
        r.pipe(res);
      });
      up.on('error', (err) => { log('debug', `live view relay: ${err.message}`); if (!res.headersSent) res.writeHead(502, { 'cache-control': 'no-store' }); res.end(); });
      req.pipe(up);
    },
  });
  disposers.push(route);

  if (typeof webServer.registerUpgrade === 'function') {
    disposers.push(webServer.registerUpgrade({
      path: WEBSOCKIFY_PATH,
      handler: (req, socket, head) => {
        // A valid ticket (from a page load dsh admitted) or dsh's own recognition of the caller.
        const ticket = new URL(req.url, 'http://x').searchParams.get('t');
        const admitted = ticket ? tickets.redeem(ticket, req.socket?.remoteAddress) : false;
        const rejection = admitted ? undefined : (() => { try { return connection?.requestRejection?.(req) ?? (connection ? undefined : 503); } catch { return 403; } })();
        if (rejection !== undefined) { socket.end(`HTTP/1.1 ${rejection === 401 ? '401 Unauthorized' : '403 Forbidden'}\r\nconnection: close\r\n\r\n`); return; }
        const headers = upstreamHeaders(req, key(), { connection: 'Upgrade', upgrade: 'websocket' });
        for (const [k, v] of Object.entries(req.headers)) if (k.startsWith('sec-websocket-')) headers[k] = v;
        const up = http.request({ host: gateway.host, port: gateway.port, method: 'GET', path: '/websockify', headers });
        let upSocket = null;
        const drop = () => { sockets.delete(socket); try { socket.destroy(); } catch {} try { upSocket?.destroy(); } catch {} try { up.destroy(); } catch {} };
        up.on('upgrade', (r, s, upHead) => {
          upSocket = s;
          sockets.add(socket);
          const lines = [`HTTP/1.1 101 Switching Protocols`];
          for (const [k, v] of Object.entries(r.headers)) if (k !== 'set-cookie') lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
          socket.write(`${lines.join('\r\n')}\r\n\r\n`);
          if (upHead?.length) socket.write(upHead);
          if (head?.length) upSocket.write(head);
          upSocket.pipe(socket).pipe(upSocket);
          upSocket.on('error', drop); socket.on('error', drop);
          upSocket.on('close', drop); socket.on('close', drop);
        });
        up.on('response', (r) => { socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage ?? ''}\r\nconnection: close\r\n\r\n`); up.destroy(); });
        up.on('error', (err) => { log('debug', `live view socket relay: ${err.message}`); socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n'); });
        up.end();
      },
    }));
  } else {
    log('warn', 'this dsh web server has no upgrade routes; the computer tab cannot show the desktop (the gateway port stays closed to browsers)');
  }

  return {
    close() {
      for (const s of sockets) { try { s.destroy(); } catch {} }
      sockets.clear();
      for (const d of disposers.splice(0)) { try { d(); } catch {} }
    },
  };
}

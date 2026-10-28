import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computerApiKey, KEY_HEADER } from '../src/computer/key.js';
import { mountComputerView, LIVE_VIEW_PATH, WEBSOCKIFY_PATH } from '../src/computer/live-view.js';

test('gateway key: generated once per machine, owner-only file, explicit value wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dot-key-'));
  const file = join(dir, 'k');
  try {
    const a = computerApiKey('', file);
    assert.match(a, /^[0-9a-f]{48}$/);
    assert.equal(readFileSync(file, 'utf8').trim(), a);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(computerApiKey(undefined, file), a, 'reused');
    assert.equal(computerApiKey('given', file), 'given');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** A stand-in for the VM gateway: records what reaches it, insists on the key, echoes on websockify. */
function fakeGateway() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.headers[KEY_HEADER.toLowerCase()] !== 'secret') { res.writeHead(401).end('no key'); return; }
    if (req.url.startsWith('/vnc/')) { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'leak=1' }).end(`<html>${req.url}</html>`); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"open":true}');
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, headers: req.headers, upgrade: true });
    if (req.headers[KEY_HEADER.toLowerCase()] !== 'secret') { socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n'); return; }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: x\r\n\r\n');
    socket.on('data', (d) => socket.write(d)); // echo
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, seen })));
}

/** dsh's web server, reduced to what the relay uses: prefix routes, upgrade routes, an origin. */
function fakeDsh() {
  const routes = [], upgrades = [];
  const server = http.createServer((req, res) => {
    const r = routes.find((x) => req.url === x.path || req.url.startsWith(`${x.path}/`));
    if (!r) { res.writeHead(404).end(); return; }
    r.handler(req, res);
  });
  server.on('upgrade', (req, socket, head) => {
    const u = upgrades.find((x) => new URL(req.url, 'http://x').pathname === x.path);
    if (!u) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    u.handler(req, socket, head);
  });
  const webServer = {
    register: (r) => { routes.push(r); return () => routes.splice(routes.indexOf(r), 1); },
    registerUpgrade: (r) => { upgrades.push(r); return () => upgrades.splice(upgrades.indexOf(r), 1); },
    getOrigin: () => `http://127.0.0.1:${server.address().port}`,
  };
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, webServer })));
}

const shut = (...servers) => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } };

const owner = { requestRejection: (req) => (/\bdsh=owner\b/.test(String(req.headers.cookie ?? '')) ? undefined : 401) };

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = ''; res.on('data', (d) => (body += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

test('computer live view: only the signed-in owner reaches the relay, and only the desktop paths', async () => {
  const gw = await fakeGateway();
  const dsh = await fakeDsh();
  const view = mountComputerView({ webServer: dsh.webServer, connection: owner, gateway: { host: '127.0.0.1', port: gw.port }, key: () => 'secret', status: () => ({ state: 'ready' }), logger: {} });
  try {
    // No dsh login → 401, nothing reaches the gateway. Forwarded headers change nothing.
    assert.equal((await get(dsh.port, `${LIVE_VIEW_PATH}/vnc/index.html`)).status, 401);
    assert.equal((await get(dsh.port, `${LIVE_VIEW_PATH}/vnc/index.html`, { 'x-forwarded-host': '127.0.0.1', 'x-forwarded-for': '127.0.0.1' })).status, 401);
    assert.equal(gw.seen.length, 0);
    // The owner gets the page; the gateway saw the key and not the dsh cookie; the gateway's cookie is not relayed.
    const page = await get(dsh.port, `${LIVE_VIEW_PATH}/vnc/index.html?autoconnect=true`, { cookie: 'dsh=owner' });
    assert.equal(page.status, 200);
    assert.equal(page.body, '<html>/vnc/index.html?autoconnect=true</html>');
    assert.equal(page.headers['set-cookie'], undefined);
    assert.equal(gw.seen[0].headers[KEY_HEADER.toLowerCase()], 'secret');
    assert.equal(gw.seen[0].headers.cookie, undefined);
    // Status for the tab; the gateway's API is not reachable through the relay.
    assert.deepEqual(JSON.parse((await get(dsh.port, `${LIVE_VIEW_PATH}/status`, { cookie: 'dsh=owner' })).body), { state: 'ready' });
    assert.equal((await get(dsh.port, `${LIVE_VIEW_PATH}/v1/sandbox`, { cookie: 'dsh=owner' })).status, 404);
    assert.equal((await get(dsh.port, `${LIVE_VIEW_PATH}/mcp`, { cookie: 'dsh=owner' })).status, 404);
    assert.equal(gw.seen.length, 1);
    // The bare path is a page that sends the owner on to noVNC with dsh's real host/port and a socket ticket.
    const entry = await get(dsh.port, `${LIVE_VIEW_PATH}/`, { cookie: 'dsh=owner' });
    assert.equal(entry.status, 200);
    assert.match(entry.body, new RegExp(`host=127\\.0\\.0\\.1&port=${dsh.port}&encrypt=false&path=dsh-dot%2Fcomputer%2Fwebsockify%3Ft%3D[0-9a-f]{48}`));
    assert.equal((await get(dsh.port, `${LIVE_VIEW_PATH}/`)).status, 401, 'no ticket without login');
  } finally { view.close(); shut(dsh.server, gw.server); }
});

function upgrade(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'abc', 'sec-websocket-version': '13', ...headers } });
    req.on('upgrade', (res, socket, head) => resolve({ status: res.statusCode, socket, head }));
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', reject);
    req.end();
  });
}

test('computer live view: the VNC socket is relayed for the owner with the key, refused otherwise', async () => {
  const gw = await fakeGateway();
  const dsh = await fakeDsh();
  const view = mountComputerView({ webServer: dsh.webServer, connection: owner, gateway: { host: '127.0.0.1', port: gw.port }, key: () => 'secret', status: () => ({}), logger: {} });
  try {
    assert.equal((await upgrade(dsh.port, WEBSOCKIFY_PATH)).status, 401);
    assert.equal(gw.seen.length, 0);
    const ok = await upgrade(dsh.port, WEBSOCKIFY_PATH, { cookie: 'dsh=owner' });
    assert.equal(ok.status, 101);
    assert.equal(gw.seen[0].url, '/websockify');
    assert.equal(gw.seen[0].headers[KEY_HEADER.toLowerCase()], 'secret');
    assert.equal(gw.seen[0].headers.cookie, undefined);
    const echoed = await new Promise((r) => { ok.socket.once('data', (d) => r(String(d))); ok.socket.write('ping'); });
    assert.equal(echoed, 'ping');
    ok.socket.destroy();
    // A ticket from an admitted page load opens the socket without a cookie (the desktop app's case) — once.
    const page = await get(dsh.port, `${LIVE_VIEW_PATH}/`, { cookie: 'dsh=owner' });
    const t = /%3Ft%3D([0-9a-f]{48})/.exec(page.body)[1];
    const byTicket = await upgrade(dsh.port, `${WEBSOCKIFY_PATH}?t=${t}`);
    assert.equal(byTicket.status, 101);
    byTicket.socket.destroy();
    assert.equal((await upgrade(dsh.port, `${WEBSOCKIFY_PATH}?t=${t}`)).status, 401, 'single use');
    assert.equal((await upgrade(dsh.port, `${WEBSOCKIFY_PATH}?t=${'0'.repeat(48)}`)).status, 401, 'unknown ticket');
  } finally { view.close(); shut(dsh.server, gw.server); }
});

test('computer live view: close() releases routes and open sockets', async () => {
  const gw = await fakeGateway();
  const dsh = await fakeDsh();
  const view = mountComputerView({ webServer: dsh.webServer, connection: owner, gateway: { host: '127.0.0.1', port: gw.port }, key: () => 'secret', status: () => ({}), logger: {} });
  const ok = await upgrade(dsh.port, WEBSOCKIFY_PATH, { cookie: 'dsh=owner' });
  assert.equal(ok.status, 101);
  const closed = new Promise((r) => ok.socket.on('close', r));
  view.close();
  await closed;
  assert.equal((await get(dsh.port, `${LIVE_VIEW_PATH}/status`, { cookie: 'dsh=owner' })).status, 404);
  shut(dsh.server, gw.server);
});

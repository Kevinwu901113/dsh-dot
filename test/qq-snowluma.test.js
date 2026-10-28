import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { apply, qqToolGate, snowlumaConfig } from '../src/qq/qq.js';
import { QQ_TOOL_PREFIX } from '../src/tool-prefixes.js';

class FakeSocket extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.readyState = 1; this.sent = []; FakeSocket.last = this; setTimeout(() => this.emit('open'), 0); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.emit('close'); }
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function harness(config = {}, { installed = true, running = false, shell = () => '' } = {}) {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-'));
  const shells = [], effects = [], plugins = [];
  let cmd, onReady, disposed = 0;
  const computer = { port: 18080, authHeaders: () => ({ 'X-AIO-API-Key': 'gw-key-1' }), keyHeader: 'X-AIO-API-Key', backend: { rootShell: async () => '' }, ready: new Promise((r) => { onReady = r; }) };
  const rootShell = async (script) => { shells.push(script); const o = shell(script); if (o) return o; if (script.includes('test -x')) return installed ? 'yes\n' : 'no\n'; if (script.includes('pgrep -f')) return running ? 'yes\n' : 'no\n'; return ''; };
  const ctx = {
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    effect(fn) { effects.push(fn()); },
    on(name, fn) { ctx.handlers[name] = fn; },
    handlers: {},
    plugin(p, c) { plugins.push({ p, c }); return { dispose() { disposed++; } }; },
    provide(n, v) { ctx[n] = v; },
    inject(deps, fn) { if (deps.every((d) => ctx.get(d))) fn({ ...ctx, ...Object.fromEntries(deps.map((d) => [d, ctx.get(d)])) }); },
    get: (n) => ({ dshComputer: computer, tools: { register: () => () => {} }, systemPrompt: { section: () => () => {} }, commands: { register: (c) => { cmd = c; return () => {} } } }[n]),
  };
  apply(ctx, { qq: '10001', ...config }, { WebSocket: FakeSocket, rootShell, mcpClient: { name: 'fake-mcp' }, pollMs: 5 });
  return { ctx, shells, plugins, disposed: () => disposed, cmd: () => cmd, ready: () => onReady(), stop: () => effects.forEach((d) => typeof d === 'function' && d()) };
}

test('snowlumaConfig: loopback WS with the OneBot token, loopback HTTP with its own (gateway) token', () => {
  const c = snowlumaConfig({ port: 3001, token: 'tok', httpToken: 'key' });
  assert.deepEqual(c.runtime, { webuiPort: 5099, hookAutoLoad: true });
  const ws = c.onebot.networks.wsServers[0], http = c.onebot.networks.httpServers[0];
  assert.deepEqual([ws.host, ws.port, ws.role, ws.accessToken, ws.messageFormat], ['127.0.0.1', 3001, 'Universal', 'tok', 'array']);
  assert.deepEqual([http.host, http.port, http.accessToken, http.path], ['127.0.0.1', 3000, 'key', '/']);
  assert.equal(snowlumaConfig({ port: 1, token: 't' }).onebot.networks.httpServers[0].accessToken, 't');
});

test('qqToolGate: docs and reads run; sends follow sendGate; secrets, account, people and groups ask', () => {
  const now = Date.now();
  const opt = [{ owner: '20002' }, { recent: (k) => (k === 'group:7777777' ? now - 60_000 : 0), now }];
  const g = (tool, args) => qqToolGate(`${QQ_TOOL_PREFIX}${tool}`, args, ...opt);
  for (const t of ['list_actions', 'search_actions', 'get_action', 'list_categories', 'get_runtime_info']) assert.equal(g(t, {}), null, t);
  // query_action* is judged by the action it names, like invoke_action*.
  assert.equal(g('query_action', { action: 'get_group_list' }), null);
  assert.match(g('query_action', { action: 'set_group_kick' }), /set_group_kick/);
  assert.match(g('query_action', {}), /without a readable action/);
  for (const a of ['get_friend_list', 'get_group_msg_history', 'fetch_custom_face', 'can_send_image', 'ocr_image', 'download_file', 'get_qzone_feeds']) assert.equal(g('invoke_action', { action: a, params: {} }), null, a);
  for (const a of ['send_packet', 'get_cookies', 'get_csrf_token', 'get_rkey', 'set_qq_avatar', 'delete_friend', 'set_group_kick', 'set_group_ban', 'set_restart', 'send_qzone_post', 'delete_qzone_feed', 'delete_msg', 'set_friend_add_request']) assert.match(g('invoke_action', { action: a, params: {} }), new RegExp(`QQ action ${a}`), a);
  assert.equal(g('invoke_action', { action: 'send_private_msg', params: { user_id: 20002, message: 'hi' } }), null, 'the owner');
  assert.equal(g('invoke_action_with_input', { action: 'send_group_msg', input: JSON.stringify({ group_id: 7777777, message: [{ type: 'text', data: { text: '哈' } }] }) }), null, 'a live group');
  assert.match(g('invoke_action', { action: 'send_private_msg', params: { user_id: 99999, message: '你好' } }), /not written to her recently: 你好/);
  assert.match(g('invoke_action', { action: 'send_group_msg', params: { group_id: 7777777, message: [{ type: 'image', data: { file: 'file:///root/x.png' } }] } }), /with a file/);
  assert.match(g('invoke_action', { action: 'send_msg', params: { message: 'x' } }), /without a clear recipient/);
  assert.match(g('invoke_action', { params: { user_id: 1 } }), /without a readable action/);
  assert.match(g('something_new', {}), /unknown QQ tool/);
});

test('snowluma backend: configures both config dirs (HTTP token = gateway key), starts QQ GUI + SnowLuma on the desktop display, routes /dsh-dot/onebot/, mounts the MCP once connected, gates it, disposes on stop', async () => {
  const h = harness({ backend: 'snowluma' });
  h.ready(); await tick(30);
  const conf = h.shells.find((s) => s.includes('/root/snowluma/config/onebot.json'));
  assert.ok(conf && conf.includes('/root/snowluma/data/config/onebot.json'), 'both config locations');
  assert.match(conf, /"accessToken": "gw-key-1"/, 'HTTP adapter takes the gateway key');
  const token = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'dsh-qq.json'), 'utf8')).token;
  assert.ok(conf.includes(`"accessToken": "${token}"`), 'WS adapter keeps the OneBot token');
  const start = h.shells.find((s) => s.includes('node "$SL"/index.mjs'));
  assert.ok(start, 'SnowLuma started');
  assert.match(start, /ptrace_scope/); assert.match(start, /qqpatch\.gtimg\.cn/);
  assert.match(start, /pkill -f "\[s\]nowluma\/index\.mjs"[^\n]*pkill -f "\[o\]pt\/QQ\/qq"/, 'NapCat (and any QQ) stopped first');
  assert.match(start, /export DISPLAY=\$D/); assert.match(start, /--disable-gpu-compositing/);
  assert.ok(!h.shells.some((s) => s.includes('xvfb-run -a')), 'NapCat not launched');
  const route = h.shells.find((s) => s.includes('dsh-dot-napcat.conf'));
  assert.match(route, /location \/dsh-dot\/onebot\/ \{\n    proxy_pass http:\/\/127\.0\.0\.1:3000\/;/);
  assert.equal(FakeSocket.last.url, 'ws://127.0.0.1:18080/dsh-dot/napcat/');
  assert.equal(h.plugins.length, 0, 'no MCP before the socket says connected');
  FakeSocket.last.emit('message', JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: 10001 }));
  await tick(5);
  assert.equal(h.plugins.length, 1);
  const c = h.plugins[0].c;
  assert.deepEqual([c.transport, c.serverName, c.command, c.args], ['stdio', 'dot-qq', 'npx', ['-y', '@snowluma/mcp']]);
  assert.deepEqual(c.env, { SNOWLUMA_MCP_ENDPOINT: 'http://127.0.0.1:18080/dsh-dot/onebot/', SNOWLUMA_MCP_TOKEN: 'gw-key-1', SNOWLUMA_MCP_MODE: 'write', SNOWLUMA_MCP_EVENTS_URL: '' });
  const pre = (name, input) => h.ctx.handlers['tools/pre-execute']({ name, input }, async () => 'ran');
  assert.equal(await pre(`${QQ_TOOL_PREFIX}invoke_action`, { action: 'get_friend_list', params: {} }), 'ran');
  assert.equal((await pre(`${QQ_TOOL_PREFIX}invoke_action`, { action: 'set_group_kick', params: { group_id: 1, user_id: 2 } })).kind, 'ask');
  assert.equal(h.ctx.dshQq.status().backend, 'snowluma');
  assert.match((await h.cmd().handler({ rawInput: '' })).text, /backend: snowluma · mcp: mounted/);
  await h.ctx.dshQq.stop();
  assert.equal(h.disposed(), 1);
  h.stop();
});

test('napcat backend never mounts the MCP and stops SnowLuma before starting', async () => {
  const h = harness();
  h.ready(); await tick(30);
  assert.ok(h.shells.some((s) => s.includes('pkill -f "[s]nowluma/index.mjs"') && s.includes('xvfb-run -a')));
  FakeSocket.last.emit('message', JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: 10001 }));
  await tick(5);
  assert.equal(h.plugins.length, 0);
  h.stop();
});

test('/qq backend persists; /qq install snowluma runs the detached SnowLuma installer; installed() answers per backend; qr is a screen picture', async () => {
  const h = harness({}, { installed: false, shell: (s) => (s.includes('snowluma-install.done 2>/dev/null') ? '0\n' : s.includes('import -window root') ? 'UE5H\n' : '') });
  h.ready(); await tick(30);
  let out = await h.cmd().handler({ rawInput: 'backend snowluma' });
  assert.match(out.text, /backend: snowluma; \/qq start/);
  assert.equal(JSON.parse(readFileSync(join(process.env.DSH_HOME, 'dsh-qq.json'), 'utf8')).backend, 'snowluma');
  assert.match((await h.cmd().handler({ rawInput: 'backend nope' })).text, /backend: snowluma \(napcat \| snowluma\)/);
  out = await h.cmd().handler({ rawInput: 'install snowluma' });
  assert.match(out.text, /installing snowluma/);
  await tick(40);
  const script = h.shells.find((s) => s.includes('snowluma-install-run.sh'));
  assert.match(script, /api\.github\.com\/repos\/SnowLuma\/SnowLuma\/releases\/latest/);
  assert.match(script, /SnowLuma-\$tag-linux-\$arch-lite\.tar\.gz/);
  assert.match(script, /"https:\/\/ghfast\.top\/\$asset"/, 'mirrors as with NapCat');
  assert.match(script, /sha256sum -c -/);
  assert.match(script, /releases\/latest \| sed -n 's#\.\*\/releases\/tag\/##p'/, 'tag from the release redirect, not only the rate-limited API');
  { const { execFileSync } = await import('node:child_process'); const body = script.slice(script.indexOf('\n') + 1, script.lastIndexOf('DOT_RUN_EOF')); execFileSync('bash', ['-n'], { input: body }); }
  assert.doesNotMatch(script, /Napcat\/opt\/QQ/, "never the NapCat-patched QQ");
  assert.match(script, /<<'DOT_RUN_EOF'/, 'the outer heredoc does not end at the config heredocs');
  assert.equal(h.ctx.dshQq.state, 'installed');
  await h.ctx.dshQq.installed('snowluma');
  assert.match(h.shells.at(-1), /test -f \/root\/snowluma\/index\.mjs/);
  const qr = await h.ctx.dshQq.qr();
  assert.equal(String(qr.png), 'PNG'); assert.equal(qr.ageS, 0);
  h.stop();
});

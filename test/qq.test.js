import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { apply, segmentsToText, groupWanted, parseTarget, onebotConfig, imageSource } from '../src/qq/qq.js';

test('segmentsToText, groupWanted, parseTarget, onebotConfig', () => {
  assert.equal(segmentsToText([{ type: 'at', data: { qq: '111' } }, { type: 'text', data: { text: ' 在吗' } }, { type: 'image', data: {} }], '111'), '@我 在吗[图片]');
  assert.equal(segmentsToText('plain'), 'plain');
  assert.ok(groupWanted({ message: [{ type: 'at', data: { qq: '111' } }] }, 'mention', '111'));
  assert.ok(!groupWanted({ message: [{ type: 'text', data: { text: 'hi' } }] }, 'mention', '111'));
  assert.ok(groupWanted({ message: [] }, 'all', '111') && !groupWanted({ message: [] }, 'none', '111'));
  assert.deepEqual(parseTarget('user:12345', ''), { user_id: 12345 });
  assert.deepEqual(parseTarget('group:67890', ''), { group_id: 67890 });
  assert.deepEqual(parseTarget('owner', '555555'), { user_id: 555555 });
  assert.equal(parseTarget('owner', ''), null);
  assert.deepEqual(parseTarget('123456', ''), { user_id: 123456 });
  assert.equal(parseTarget('nonsense', ''), null);
  assert.equal(segmentsToText([{ type: 'image', data: { url: 'https://img/x.jpg' } }]), '[图片 https://img/x.jpg]');
  assert.deepEqual(imageSource('https://a/b.png'), { kind: 'url', ref: 'https://a/b.png' });
  assert.deepEqual(imageSource('phone:screen'), { kind: 'phone-screen', ref: 'phone:screen' });
  assert.deepEqual(imageSource('phone:latest'), { kind: 'phone-latest', ref: 'phone:latest' });
  assert.deepEqual(imageSource('/sdcard/DCIM/a.jpg'), { kind: 'phone', ref: '/sdcard/DCIM/a.jpg' });
  assert.deepEqual(imageSource('phone:/storage/emulated/0/x.png'), { kind: 'phone', ref: '/storage/emulated/0/x.png' });
  assert.deepEqual(imageSource('/root/pic.png'), { kind: 'computer', ref: '/root/pic.png' });
  assert.equal(imageSource('cat.png'), null);
  const c = onebotConfig({ port: 3001, token: 't' });
  assert.equal(c.network.websocketServers[0].host, '127.0.0.1');
  assert.equal(c.network.websocketServers[0].token, 't');
});

class FakeSocket extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.readyState = 1; this.sent = []; FakeSocket.last = this; setTimeout(() => this.emit('open'), 0); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.emit('close'); }
}

function harness({ installed = true, running = false } = {}) {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-'));
  const shells = [], effects = [], tools = [], sections = [];
  let cmd, onReady;
  const computer = { port: 18080, backend: { rootShell: async () => '', execArgv: ({ argv }) => ['msb', 'exec', '-u', 'root', 'vm', '--', ...argv] }, ready: new Promise((r) => { onReady = r; }) };
  const rootShell = async (script) => { shells.push(script); if (script.includes('test -x')) return installed ? 'yes\n' : 'no\n'; if (script.includes('pgrep -f')) return running ? 'yes\n' : 'no\n'; if (script.includes('base64 -w0')) return 'age=3\nerr=\nUE5H\n'; return ''; };
  const ctx = {
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    effect(fn) { effects.push(fn()); },
    on(name, fn) { ctx.handlers[name] = fn; },
    handlers: {},
    provide(n, v) { ctx[n] = v; },
    inject(deps, fn) { if (deps.every((d) => ctx.get(d))) fn({ ...ctx, ...Object.fromEntries(deps.map((d) => [d, ctx.get(d)])) }); },
    get: (n) => ({ dshComputer: computer, tools: { register: (t) => { tools.push(t); return () => {}; } }, systemPrompt: { section: (c) => { sections.push(c); return () => {}; } }, commands: { register: (c) => { cmd = c; return () => {}; } } }[n]),
  };
  apply(ctx, { qq: '10001' }, { WebSocket: FakeSocket, rootShell });
  return { ctx, shells, tools, sections, cmd: () => cmd, ready: () => onReady(), stop: () => effects.forEach((d) => typeof d === 'function' && d()) };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('qq: boots with the computer — configures, starts NapCat, connects through an exec tunnel; messages wake listeners; qq_send answers; owner learned', async () => {
  const h = harness();
  const got = [];
  h.ctx.dshQq.onMessage((m) => got.push(m));
  h.ready(); await tick(30);
  assert.ok(h.shells.some((s) => s.includes('onebot11_10001.json')), 'OneBot config written for the account');
  assert.ok(h.shells.some((s) => s.includes('xvfb-run -a') && s.includes('-q 10001')), 'NapCat started for the account');
  const sock = FakeSocket.last;
  assert.equal(sock.url, 'ws://napcat/');
  assert.equal(sock.opts.headers.Host, undefined, 'no gateway hop');
  assert.equal(typeof sock.opts.createConnection, 'function', 'an exec tunnel into the VM carries the socket');
  assert.equal(sock.opts.headers.Authorization, `Bearer ${JSON.parse(readFileSync(join(process.env.DSH_HOME, 'dsh-qq.json'), 'utf8')).token}`);
  assert.match(sock.opts.headers.Authorization, /^Bearer [0-9a-f]{48}$/);
  sock.emit('message', JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: 10001 }));
  assert.equal(h.ctx.dshQq.connected, true);
  assert.match(h.sections[0].text(), /qq_send/);
  // a private message from the owner-to-be
  sock.emit('message', JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 20002, self_id: 10001, message: [{ type: 'text', data: { text: '在吗' } }], sender: { nickname: '宽' } }));
  assert.deepEqual(got.map((m) => [m.kind, m.who, m.text, m.fromOwner]), [['private', '宽', '在吗', false]]);
  assert.equal(h.ctx.dshQq.owner, '', 'the owner is never learned from whoever writes first');
  await h.cmd().handler({ rawInput: 'owner 20002' });
  sock.emit('message', JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 20002, self_id: 10001, message: [{ type: 'text', data: { text: '是我' } }], sender: { nickname: '宽' } }));
  assert.equal(got.at(-1).fromOwner, true, 'the owner, once set, is marked');
  got.splice(1);
  // own messages and un-mentioned group chatter are ignored; an @ wakes
  sock.emit('message', JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10001, message: [{ type: 'text', data: { text: 'me' } }] }));
  sock.emit('message', JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 777, user_id: 30003, self_id: 10001, message: [{ type: 'text', data: { text: 'noise' } }], sender: { card: '路人' } }));
  sock.emit('message', JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 777, user_id: 30003, self_id: 10001, message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 来看这个' } }], sender: { card: '路人' } }));
  assert.equal(got.length, 2);
  assert.deepEqual([got[1].kind, got[1].groupId, got[1].text], ['group', '777', '@我 来看这个']);
  // sending: the tool → OneBot action with echo; bubbles split
  const tool = h.tools.find((t) => t.name === 'qq_send');
  const p = tool.execute({ to: 'owner', text: '在<sep/>刚看到' });
  await tick(5);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].action, 'send_private_msg');
  assert.deepEqual(sock.sent[0].params, { user_id: 20002, message: [{ type: 'text', data: { text: '在' } }] });
  sock.emit('message', JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: sock.sent[0].echo }));
  await tick(5);
  assert.equal(sock.sent.length, 2);
  sock.emit('message', JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 2 }, echo: sock.sent[1].echo }));
  assert.deepEqual(await p, { sent: 2 });
  // images: a URL goes as-is, a phone screenshot as base64, each its own message
  h.ctx.dshPhone = { isReady: true, screenshot: async () => Buffer.from('PNGDATA'), shell: async () => '', adbExec: async () => ({ stdout: Buffer.from('JPG') }) };
  const get0 = h.ctx.get; h.ctx.get = (n) => (n === 'dshPhone' ? h.ctx.dshPhone : get0(n));
  const pi = tool.execute({ to: 'owner', images: ['https://example.com/cat.jpg', 'phone:screen'] });
  await tick(5);
  assert.deepEqual(sock.sent[2].params.message, [{ type: 'image', data: { file: 'https://example.com/cat.jpg' } }]);
  sock.emit('message', JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 3 }, echo: sock.sent[2].echo }));
  await tick(5);
  assert.deepEqual(sock.sent[3].params.message, [{ type: 'image', data: { file: `base64://${Buffer.from('PNGDATA').toString('base64')}` } }]);
  sock.emit('message', JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 4 }, echo: sock.sent[3].echo }));
  assert.deepEqual(await pi, { sent: 2 });
  h.ctx.get = get0; delete h.ctx.dshPhone;
  // /qq qr pushes the QR to the phone album when the phone is up
  const pushed = [];
  let shown = null;
  h.ctx.dshPhone = { isReady: true, adbExec: async (a) => { pushed.push(a); return { stdout: '' }; }, shell: async (c) => { pushed.push(c); return ''; }, showToCamera: (png) => { shown = png; return '/avd/poster.png'; } };
  const orig = h.ctx.get; h.ctx.get = (n) => (n === 'dshPhone' ? h.ctx.dshPhone : orig(n));
  const out = await h.cmd().handler({ rawInput: 'qr' });
  assert.match(out.text, /QR saved: .*qq-login-\d{6}\.png \(drawn 3s ago/);
  assert.match(out.text, /in front of her camera: .*扫一扫 \(camera view\)/);
  assert.equal(String(shown), 'PNG', 'the login code is what her camera looks at');
  assert.ok(pushed.some((a) => Array.isArray(a) && a[0] === 'push' && /qq-login-\d{6}\.png$/.test(a[2])));
  // reconnect after close
  sock.close();
  await tick(10);
  assert.equal(h.ctx.dshQq.connected, false);
  h.stop();
});

test('qq: not installed → state says so; /qq account sets the number', async () => {
  const h = harness({ installed: false });
  h.ready(); await tick(30);
  assert.equal(h.ctx.dshQq.state, 'not-installed');
  const out = await h.cmd().handler({ rawInput: 'account 10002' });
  assert.match(out.text, /account set: 10002/);
  assert.equal(h.ctx.dshQq.qq, '10002');
  h.stop();
});

test('qq_send gate: owner free; replies to live conversations free; new contacts, silent groups and device files ask', async () => {
  const { sendGate } = await import('../src/qq/qq.js');
  const now = Date.now();
  const recent = (k) => ({ 'user:30003': now - 5 * 60_000, 'group:7777777': now - 2 * 60_000, 'user:40004': now - 2 * 3_600_000 })[k] ?? 0;
  const opt = { owner: '20002', recent, now };
  assert.equal(sendGate({ to: 'owner', text: 'hi' }, opt), null);
  assert.equal(sendGate({ to: 'user:20002', images: ['/home/gem/.ssh/id_rsa'] }, opt), null, 'the owner may receive anything');
  assert.equal(sendGate({ to: 'user:30003', text: '在' }, opt), null, 'answering someone who just wrote');
  assert.equal(sendGate({ to: 'group:7777777', text: '哈哈', images: ['https://x/y.png'] }, opt), null, 'web image into a live group');
  assert.match(sendGate({ to: 'user:40004', text: '在' }, opt), /not written to her recently/);
  assert.match(sendGate({ to: 'user:99999', text: '你好' }, opt), /not written to her recently/);
  assert.match(sendGate({ to: 'user:30003', images: ['phone:screen'] }, opt), /file\(s\) from her devices/);
  assert.match(sendGate({ to: 'group:7777777', images: ['/home/gem/notes.png'] }, opt), /file\(s\) from her devices/);
  assert.match(sendGate({ to: 'user:30003', text: '在' }, { ...opt, policy: 'always' }), /message to user:30003/);
  assert.equal(sendGate({ to: 'user:99999', images: ['phone:latest'] }, { ...opt, policy: 'off' }), null);
});

test('qq_send gate is wired: a tool call to a stranger becomes an ask, one to the owner runs', async () => {
  const h = harness();
  h.ctx.dshQq.setOwner('20002');
  const gate = (args) => h.ctx.handlers['tools/pre-execute']({ name: 'qq_send', input: args, agent: { session: { id: 's' } } }, async () => 'ran');
  assert.equal(await gate({ to: 'owner', text: 'x' }), 'ran');
  assert.equal((await gate({ to: 'user:55555', text: 'x' })).kind, 'ask');
  assert.equal(await h.ctx.handlers['tools/pre-execute']({ name: 'bash', input: {} }, async () => 'ran'), 'ran');
  h.stop();
});

test('the exec tunnel really carries a WebSocket: a real ws server behind `bash -c` stdio', async () => {
  const { WebSocketServer, WebSocket } = await import('ws');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.on('listening', r));
  const seen = [];
  wss.on('connection', (s, req) => { seen.push(req.headers.authorization); s.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: 10001 })); });
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-'));
  const effects = [];
  let onReady;
  // execArgv hands the VM-side argv back unchanged, so `bash -c <tunnel script>` runs here against the test server.
  const computer = { port: 1, backend: { rootShell: async () => '', execArgv: ({ argv }) => argv }, ready: new Promise((r) => { onReady = r; }) };
  const rootShell = async (script) => (script.includes('test -x') ? 'yes\n' : script.includes('pgrep -f') ? 'yes\n' : '');
  const ctx = {
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }), effect(fn) { effects.push(fn()); }, on() {}, provide(n, v) { ctx[n] = v; },
    inject(deps, fn) { if (deps.every((d) => ctx.get(d))) fn({ ...ctx, ...Object.fromEntries(deps.map((d) => [d, ctx.get(d)])) }); },
    get: (n) => ({ dshComputer: computer, tools: { register: () => () => {} }, systemPrompt: { section: () => () => {} }, commands: { register: () => () => {} } }[n]),
  };
  apply(ctx, { qq: '10001', wsPort: wss.address().port }, { WebSocket, rootShell });
  onReady(true);
  for (let i = 0; i < 100 && !ctx.dshQq.connected; i++) await tick(50);
  try {
    assert.equal(ctx.dshQq.connected, true, 'connected through the tunnel');
    assert.match(seen[0], /^Bearer [0-9a-f]{48}$/, 'the OneBot token travelled in Authorization');
  } finally {
    effects.forEach((d) => typeof d === 'function' && d());
    wss.clients.forEach((c) => c.terminate());
    wss.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { apply, segmentsToText, groupWanted, parseTarget, onebotConfig } from '../src/qq/qq.js';

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
  const computer = { port: 18080, backend: { rootShell: async () => '' }, ready: new Promise((r) => { onReady = r; }) };
  const rootShell = async (script) => { shells.push(script); if (script.includes('test -x')) return installed ? 'yes\n' : 'no\n'; if (script.includes('pgrep -f')) return running ? 'yes\n' : 'no\n'; if (script.includes('base64 -w0')) return 'UE5H\n'; return ''; };
  const ctx = {
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    effect(fn) { effects.push(fn()); },
    provide(n, v) { ctx[n] = v; },
    inject(deps, fn) { if (deps.every((d) => ctx.get(d))) fn({ ...ctx, ...Object.fromEntries(deps.map((d) => [d, ctx.get(d)])) }); },
    get: (n) => ({ dshComputer: computer, tools: { register: (t) => { tools.push(t); return () => {}; } }, systemPrompt: { section: (c) => { sections.push(c); return () => {}; } }, commands: { register: (c) => { cmd = c; return () => {}; } } }[n]),
  };
  apply(ctx, { qq: '10001' }, { WebSocket: FakeSocket, rootShell });
  return { ctx, shells, tools, sections, cmd: () => cmd, ready: () => onReady(), stop: () => effects.forEach((d) => typeof d === 'function' && d()) };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('qq: boots with the computer — configures, starts NapCat, connects through the gateway; messages wake listeners; qq_send answers; owner learned', async () => {
  const h = harness();
  const got = [];
  h.ctx.dshQq.onMessage((m) => got.push(m));
  h.ready(); await tick(30);
  assert.ok(h.shells.some((s) => s.includes('onebot11_10001.json')), 'OneBot config written for the account');
  assert.ok(h.shells.some((s) => s.includes('xvfb-run -a') && s.includes('-q 10001')), 'NapCat started for the account');
  const sock = FakeSocket.last;
  assert.equal(sock.url, 'ws://127.0.0.1:18080/');
  assert.equal(sock.opts.headers.Host, '3001-napcat', 'the gateway routes by Host to the VM port');
  assert.match(sock.opts.headers.Authorization, /^Bearer [0-9a-f]{48}$/);
  sock.emit('message', JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: 10001 }));
  assert.equal(h.ctx.dshQq.connected, true);
  assert.match(h.sections[0].text(), /qq_send/);
  // a private message from the owner-to-be
  sock.emit('message', JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 20002, self_id: 10001, message: [{ type: 'text', data: { text: '在吗' } }], sender: { nickname: '宽' } }));
  assert.deepEqual(got.map((m) => [m.kind, m.who, m.text]), [['private', '宽', '在吗']]);
  assert.equal(h.ctx.dshQq.owner, '20002', 'owner learned from the first private message');
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
  // /qq qr pushes the QR to the phone album when the phone is up
  const pushed = [];
  h.ctx.dshPhone = { isReady: true, adbExec: async (a) => { pushed.push(a); return { stdout: '' }; }, shell: async (c) => { pushed.push(c); return ''; } };
  const orig = h.ctx.get; h.ctx.get = (n) => (n === 'dshPhone' ? h.ctx.dshPhone : orig(n));
  const out = await h.cmd().handler({ rawInput: 'qr' });
  assert.match(out.text, /QR saved/);
  assert.match(out.text, /扫一扫 → 相册/);
  assert.ok(pushed.some((a) => Array.isArray(a) && a[0] === 'push'));
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

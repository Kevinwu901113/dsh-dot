import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, classify, hiddenFor, findRoot, readBridge, botUins, doctor, isDotTool, isDeviceTool, BRIDGE_ID_RE, BRIDGE_TOOL_PREFIXES } from '../src/compat/qq-bridge.js';
import { DOT_TOOLS, DOT_TOOL_PREFIXES, DEVICE_TOOL_PREFIXES, PHONE_ZOOM_TOOL } from '../src/tool-prefixes.js';
import DshComputerSubprocess from '../src/computer/subprocess.js';

/** A qq-bridge checkout: config.json, state/mode.json, its bundles linked into a fake ~/.dsh. */
function fakeBridge({ mode = 'reserved2', ownerQQ = 20002, groups = [111, 222], uins = ['30003'], sessionCwd = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qq-bridge-'));
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'bridge.js'), '');
  writeFileSync(join(root, 'package.json'), '{}');
  const sl = join(root, 'snowluma', 'config'); mkdirSync(sl, { recursive: true });
  for (const u of uins) writeFileSync(join(sl, `onebot_${u}.json`), '{}');
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ownerQQ, sessionCwd, allow: { groups, private: [] }, snowluma: { homeDir: join(root, 'snowluma') }, consolePort: 3100 }));
  mkdirSync(join(root, 'state', 'agents'), { recursive: true });
  writeFileSync(join(root, 'state', 'mode.json'), JSON.stringify({ mode, closedAgentPreset: '' }));
  mkdirSync(join(root, 'plugins', 'qq-agent-presets'), { recursive: true });
  const dsh = mkdtempSync(join(tmpdir(), 'dsh-'));
  mkdirSync(join(dsh, 'plugins'));
  symlinkSync(join(root, 'plugins', 'qq-agent-presets'), join(dsh, 'plugins', 'qq-agent-presets'));
  process.env.DSH_HOME = dsh;
  return { root, dsh };
}

const TOOLS = ['bash', 'read', 'memory', 'recall', 'account', 'doings', 'tell_him', 'qq_send', 'qq_sticker_keep', 'phone_zoom',
  'mcp__dot-phone__mobile_take_screenshot', 'mcp__dot-vm__browser_navigate', 'mcp__dot-qq__send_group_msg',
  'mcp__snowluma__send_private_msg', 'mcp__snowluma-host__x', 'mcp__web-search-safe__search', 'todo_write'];

test('tool-prefixes: every tool src/ registers is classified as dot\'s own or a device tool', () => {
  const names = new Set();
  const walk = (dir) => { for (const f of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) for (const m of readFileSync(p, 'utf8').matchAll(/tools\.register\(\{\s*name:\s*(?:'([^']+)'|([A-Z_]+))/g)) names.add(m[1] ?? m[2]); } };
  walk('src');
  names.delete('PHONE_ZOOM_TOOL'); names.add(PHONE_ZOOM_TOOL);
  assert.ok(names.size >= 8, `found ${[...names]}`);
  for (const n of names) assert.ok(isDotTool(n) || isDeviceTool(n) || n === PHONE_ZOOM_TOOL, `${n} is in neither DOT_TOOLS nor a device prefix (src/tool-prefixes.js)`);
  for (const n of DOT_TOOLS) assert.ok(names.has(n), `DOT_TOOLS lists ${n}, which nothing registers any more`);
  assert.ok(DOT_TOOL_PREFIXES.length && DEVICE_TOOL_PREFIXES.length);
});

test('findRoot / readBridge / botUins: the checkout behind ~/.dsh/plugins/qq-agent-presets, its config, mode and bot accounts', () => {
  const { root, dsh } = fakeBridge({ uins: ['30003', '30004'] });
  assert.equal(findRoot({ home: dsh }), root);
  assert.equal(findRoot({ home: mkdtempSync(join(tmpdir(), 'empty-')) }), '');
  assert.equal(findRoot({ root }), root);
  assert.equal(findRoot({ root: join(root, 'nope') }), '');
  // a checkout without config.json is not a running qq-bridge (its loadConfig() is fail-fast): not found
  const bare = fakeBridge(); rmSync(join(bare.root, 'config.json'));
  assert.equal(findRoot({ home: bare.dsh }), '');
  assert.equal(findRoot({ root: bare.root }), '');
  process.env.DSH_HOME = dsh;
  const b = readBridge(root);
  assert.equal(b.mode, 'reserved2');
  assert.equal(b.ownerQQ, '20002');
  assert.deepEqual(b.groups, ['111', '222']);
  assert.deepEqual(b.botUins, ['30003', '30004']);
  assert.equal(b.sessionCwd, join(root, 'state', 'agents'));
  assert.equal(b.consolePort, 3100);
  assert.deepEqual(botUins({ snowluma: {} }, {}), []);
  // the stamp changes when its files do
  writeFileSync(join(root, 'state', 'mode.json'), JSON.stringify({ mode: 'closed-agent' }));
  const b2 = readBridge(root);
  assert.equal(b2.mode, 'closed-agent');
});

test('classify: hers, qq-bridge sandbox, qq-bridge owner chat, everyone else', () => {
  const { root } = fakeBridge();
  const bridge = readBridge(root);
  const hers = (id, cwd) => String(cwd ?? '').startsWith('/home/me/dot');
  assert.match('qqb-g-123456-' + 'a'.repeat(32), BRIDGE_ID_RE);
  assert.equal(classify({ id: 's1', cwd: '/home/me/dot' }, bridge, hers), 'dot');
  assert.equal(classify({ id: 's2', cwd: '/home/me/code' }, bridge, hers), 'other');
  assert.equal(classify({ id: 'qqb-g-123-' + 'a'.repeat(32), cwd: bridge.sessionCwd }, bridge, hers), 'qqb-sandbox');
  // a private chat in chat/reserved mode: the whitelist preset
  assert.equal(classify({ id: 'qqb-p-20002-' + 'a'.repeat(32), cwd: bridge.sessionCwd, preset: 'qq-chat-v2' }, bridge, hers), 'qqb-sandbox');
  assert.equal(classify({ id: 'qqb-p-20002', cwd: bridge.sessionCwd }, bridge, hers), 'qqb-sandbox'); // no preset known, mode reserved2
  // closed-agent: the owner's full chat
  const closed = { ...bridge, mode: 'closed-agent' };
  assert.equal(classify({ id: 'qqb-p-20002', cwd: bridge.sessionCwd }, closed, hers), 'qqb-owner');
  assert.equal(classify({ id: 'qqb-p-20002', cwd: bridge.sessionCwd, preset: 'standard' }, bridge, hers), 'qqb-owner'); // the recorded preset wins over the mode file
  // the bridge's own preset names (its config: agentPreset / socialV2.agentPreset) are the whitelist, whatever they are called
  assert.deepEqual(bridge.sandboxPresets, ['qq-chat', 'qq-chat-v2']);
  const renamed = { ...bridge, sandboxPresets: ['my-chat', 'qq-chat', 'qq-chat-v2'] };
  assert.equal(classify({ id: 'qqb-p-20002', cwd: bridge.sessionCwd, preset: 'my-chat' }, renamed, hers), 'qqb-sandbox');
  assert.equal(classify({ id: 'qqb-p-20002', cwd: bridge.sessionCwd, preset: 'qq-chat-v3' }, renamed, hers), 'qqb-sandbox', 'qq-chat* by name still counts');
  assert.equal(classify({ id: 'qqb-g-1', cwd: bridge.sessionCwd }, closed, hers), 'qqb-sandbox');
  // its slang learner: a dsh id, cwd under its state/
  assert.equal(classify({ id: 'session-abc', cwd: join(bridge.stateDir, 'slang-agent') }, bridge, hers), 'qqb-sandbox');
  // a qqb id is never hers even when scope would say so; without the bridge it is still not ours
  assert.equal(classify({ id: 'qqb-g-1', cwd: '/home/me/dot' }, bridge, () => true), 'qqb-sandbox');
  assert.equal(classify({ id: 'qqb-g-1', cwd: '/x' }, null, hers), 'qqb-sandbox');
  assert.equal(classify({ id: 'qqb-p-1', cwd: '/x', preset: 'standard' }, null, hers), 'qqb-owner');
  assert.equal(classify({ id: 's3', cwd: '/x' }, null, hers), 'other');
});

test('hiddenFor: what each kind of session does not see', () => {
  assert.deepEqual(hiddenFor('dot', TOOLS), ['mcp__snowluma__send_private_msg', 'mcp__snowluma-host__x', 'mcp__web-search-safe__search']);
  assert.deepEqual(hiddenFor('dot', TOOLS, { hideBridgeTools: false }), []);
  const sandbox = hiddenFor('qqb-sandbox', TOOLS);
  assert.ok(!sandbox.includes('bash') && !sandbox.includes('todo_write') && !sandbox.includes('mcp__snowluma__send_private_msg'), 'only ours are touched');
  for (const n of ['memory', 'recall', 'account', 'doings', 'tell_him', 'qq_send', 'qq_sticker_keep', 'phone_zoom', 'mcp__dot-phone__mobile_take_screenshot', 'mcp__dot-vm__browser_navigate', 'mcp__dot-qq__send_group_msg']) assert.ok(sandbox.includes(n), `${n} hidden from a sandbox session`);
  const owner = hiddenFor('qqb-owner', TOOLS);
  assert.ok(owner.includes('account') && owner.includes('qq_send') && owner.includes('mcp__dot-qq__send_group_msg'), 'her account store and her QQ stay hers');
  assert.ok(!owner.includes('phone_zoom') && !owner.includes('mcp__dot-phone__mobile_take_screenshot') && !owner.includes('mcp__dot-vm__browser_navigate'), 'the owner chat gets her phone and computer');
  assert.ok(hiddenFor('qqb-owner', TOOLS, { ownerDevices: false }).includes('mcp__dot-vm__browser_navigate'));
  const other = hiddenFor('other', TOOLS);
  assert.ok(other.includes('account') && other.includes('memory') && !other.includes('mcp__dot-phone__mobile_take_screenshot'), 'another plugin\'s session: her tools no, her devices as before');
  for (const p of BRIDGE_TOOL_PREFIXES) assert.ok(other.every((n) => !n.startsWith(p)));
});

/** A ctx with a tools registry: schemas() lists `names`, agents created through `create()` get restrict/guard captured. */
function harness({ names = TOOLS, bridge = {}, config = {} } = {}) {
  const { root } = fakeBridge(bridge);
  const handlers = {}, effects = [], warns = [];
  const tools = { schemas: () => names.map((name) => ({ name })) };
  const ctx = {
    logger: () => ({ debug() {}, info() {}, warn: (m) => warns.push(String(m)), error() {} }),
    effect: (fn) => effects.push(fn()),
    on: (n, fn) => { handlers[n] = fn; return () => {}; },
    provide: (n, v) => { ctx[n] = v; },
    inject: (deps, fn) => fn({ ...ctx, tools }),
    get: (n) => ({ dshDot: { hers: (id, cwd) => String(cwd ?? '').startsWith('/home/me/dot') }, tools })[n],
  };
  const api = apply(ctx, { refreshMs: 0, ...config });
  const create = (id, cwd, agentPreset) => {
    const agent = { id, session: { header: { cwd, agentPreset } }, restricts: [], guards: [], ctx: { tools: { restrict: (f) => { agent.restricts.push(f); return () => agent.restricts.pop(); }, guard: (g) => { agent.guards.push(g); return () => {}; } } } };
    handlers['agent/created']({ agent });
    return agent;
  };
  return { ctx, api, root, handlers, create, warns, names };
}

test('compat service: finds qq-bridge, restricts each new agent by owner, guards execution, re-applies when tools change', () => {
  const h = harness({ bridge: { mode: 'closed-agent', uins: ['30003'] } });
  assert.equal(h.api.bridge().root, h.root);
  assert.deepEqual(h.api.ignoredUins(), ['30003']);
  assert.equal(h.api.owner('qqb-p-20002', h.api.bridge().sessionCwd), 'qqb-owner');
  assert.equal(h.api.ownerOfCwd(h.api.bridge().sessionCwd), 'qqb-owner', 'closed-agent: the one folder is the owner\'s');
  assert.equal(h.api.ownerOfCwd(h.api.bridge().slangCwd), 'qqb-sandbox');
  assert.equal(h.api.ownerOfCwd('/home/me/dot/x'), 'dot');
  const hers = h.create('s1', '/home/me/dot');
  assert.deepEqual(hers.restricts, [{ deny: ['mcp__snowluma__send_private_msg', 'mcp__snowluma-host__x', 'mcp__web-search-safe__search'] }]);
  const group = h.create('qqb-g-111-' + 'b'.repeat(32), h.api.bridge().sessionCwd, 'qq-chat-v2');
  assert.ok(group.restricts[0].deny.includes('mcp__dot-vm__browser_navigate') && group.restricts[0].deny.includes('qq_send'));
  assert.equal(group.guards[0]({ name: 'qq_send' }), 'dsh-dot: qq_send is not available in this session (qqb-sandbox)');
  assert.equal(group.guards[0]({ name: 'mcp__snowluma__send_group_msg' }), undefined);
  const owner = h.create('qqb-p-20002-' + 'c'.repeat(32), h.api.bridge().sessionCwd);
  assert.ok(!owner.restricts[0].deny.includes('mcp__dot-vm__browser_navigate') && owner.restricts[0].deny.includes('account'));
  assert.equal(owner.guards[0]({ name: 'mcp__dot-phone__mobile_take_screenshot' }), undefined);
  assert.equal(owner.guards[0]({ name: 'account' }), 'dsh-dot: account is not available in this session (qqb-owner)');
  // a tool mounted later (her VM booted): the restriction is recomputed
  h.names.push('mcp__dot-vm__desktop_click');
  h.handlers['tools/change']();
  assert.ok(group.restricts[0].deny.includes('mcp__dot-vm__desktop_click'), 'the new tool is hidden from the sandbox');
  assert.equal(group.restricts.length, 1, 'the old restriction was lifted, one stands');
  assert.ok(!owner.restricts[0].deny.includes('mcp__dot-vm__desktop_click'));
  h.handlers['agent/disposed']({ agent: group });
  assert.equal(group.restricts.length, 0);
  // nothing to hide: no restrict call (restrict() rejects an empty filter)
  const plain = harness({ names: ['bash', 'read'], bridge: {} });
  const o = plain.create('s9', '/elsewhere');
  assert.deepEqual(o.restricts, []);
  assert.equal(plain.warns.length, 0, plain.warns.join('\n'));
});

test('compat service: compat.qqBridge = false switches it off; a wrong qqBridgeRoot is said once', () => {
  const h = harness({ config: { qqBridge: false } });
  assert.equal(h.api.bridge(), null);
  assert.equal(h.api.owner('qqb-g-1', '/x'), 'qqb-sandbox', 'a qqb id is still never hers');
  const h2 = harness({ config: { qqBridge: true, qqBridgeRoot: '/nonexistent/qq-bridge' } });
  assert.equal(h2.api.bridge(), null);
  assert.equal(h2.warns.filter((w) => /not found/.test(w)).length, 1);
});

test('computer subprocess: a qq-bridge session never shares its folder in; the owner chat can run on the host', () => {
  const h = harness({ bridge: { mode: 'reserved2' } });
  const shared = [];
  const vm = { isReady: true, error: null, lockFile: '/nonexistent/lock', mounts: ['/home/me/code'], isShared: (d) => vm.mounts.some((m) => d.startsWith(m)), ensureShared: (d) => { shared.push(d); vm.mounts.push(d); return null; }, backend: { kind: 'test', toGuestPath: (p) => p } };
  const sp = Object.create(DshComputerSubprocess.prototype);
  sp.vm = vm; sp.backend = vm.backend; sp.compat = () => h.api;
  const bridgeCwd = h.api.bridge().sessionCwd;
  assert.equal(sp.routeFor('/home/me/code/x'), 'vm');
  assert.equal(sp.routeFor('/home/me/dot'), 'vm');
  assert.equal(sp.routeFor(bridgeCwd), 'vm-noshare');
  assert.equal(sp.vmCwd('/home/me/new'), '/home/me/new'); assert.deepEqual(shared, ['/home/me/new']);
  assert.equal(sp.vmCwd(bridgeCwd), '/home/gem'); assert.deepEqual(shared, ['/home/me/new'], 'qq-bridge\'s state/ was not shared');
  // closed-agent mode: that folder is the owner's chat; 'vm' keeps it in her computer (still unshared), 'host' runs on this machine
  const closed = harness({ bridge: { mode: 'closed-agent' } });
  sp.compat = () => closed.api;
  assert.equal(sp.routeFor(closed.api.bridge().sessionCwd), 'vm-noshare');
  assert.equal(sp.vmCwd(closed.api.bridge().sessionCwd), '/home/gem'); assert.deepEqual(shared, ['/home/me/new']);
  const hh = harness({ bridge: { mode: 'closed-agent' }, config: { ownerComputer: 'host' } });
  sp.compat = () => hh.api;
  assert.equal(sp.routeFor(hh.api.bridge().sessionCwd), 'host');
  assert.equal(sp.routeFor('/home/me/code'), 'vm');
  assert.deepEqual(sp.hostArgv(['/no/such/bash', '-lc', 'ls']), ['bash', '-lc', 'ls']);
  assert.deepEqual(sp.hostArgv([process.execPath, '-v']), [process.execPath, '-v']);
});

test('doctor: same account, owner account, shared groups, missing bot number', () => {
  const b = { root: '/r', mode: 'reserved2', botUins: ['30003'], ownerQQ: '20002', groups: ['111', '222'] };
  const ok = doctor({ bridge: b, qq: { selfId: '10001' }, groupsOf: () => ['333'] });
  assert.deepEqual(ok.map((i) => i.level), ['ok']);
  const same = doctor({ bridge: b, qq: { selfId: '30003' } });
  assert.ok(same.some((i) => i.level === 'bad' && /挤下线/.test(i.detail)));
  const owner = doctor({ bridge: b, qq: { qq: '20002' } });
  assert.ok(owner.some((i) => i.level === 'bad' && /ownerQQ/.test(i.detail)));
  const shared = doctor({ bridge: b, qq: { selfId: '10001' }, groupsOf: () => ['222', '333'] });
  assert.ok(shared.some((i) => i.level === 'warn' && i.detail.includes('222') && !i.detail.includes('333')));
  const nobot = doctor({ bridge: { ...b, botUins: [] }, qq: { selfId: '10001' } });
  assert.ok(nobot.some((i) => i.level === 'warn' && /机器人号/.test(i.name)));
  assert.deepEqual(doctor({ bridge: null }), []);
});

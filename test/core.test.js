import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function harness({ blocked = [], state = {}, budget = true } = {}) {
  const dsh = mkdtempSync(join(tmpdir(), 'dsh-'));
  process.env.DSH_HOME = dsh;
  writeFileSync(join(dsh, 'dsh-dot-state.json'), JSON.stringify(state));
  const home = join(mkdtempSync(join(tmpdir(), 'home-')), 'dot');
  const effects = [], followups = [], audit = [], hooks = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { hooks.push(JSON.parse(b)); res.end('ok'); }); }).listen(0);
  const budgetSvc = { blockedScopes: [...blocked], status() { return { blockedScopes: this.blockedScopes }; }, unblock(s) { this.blockedScopes = this.blockedScopes.filter((x) => x !== s); } };
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    on() {},
    effect(fn) { effects.push(fn()); },
    get: (name) => (name === 'budget' && budget ? budgetSvc : name === 'schedule' ? {} : undefined),
    sessionController: { resolveAgent: async (id) => ({ agent: { session: { id }, followup: (m) => followups.push({ id, text: m.content[0].text }) } }) },
    sessions: { flush: async () => true },
    dshComputer: { audit: (e) => audit.push(e), status: () => ({ state: 'ready' }), onStatus: () => () => {} },
  };
  return { ctx, home, effects, followups, audit, hooks, budgetSvc, server, dsh,
    config: { home, mainSession: 's-main', quietHours: '', budgetPollSeconds: 0.05, precheckSeconds: 3600, notifyWebhook: `http://127.0.0.1:${server.address().port}/` } };
}
const stop = (h) => { for (const d of h.effects) if (typeof d === 'function') d(); h.server.close(); };

test('creates home with templates, never overwrites', async () => {
  const { apply } = await import('../src/core.js');
  const h = harness();
  apply(h.ctx, h.config);
  assert.ok(existsSync(join(h.home, 'AGENTS.md')) && existsSync(join(h.home, 'watch.json')));
  writeFileSync(join(h.home, 'AGENTS.md'), 'mine');
  apply(h.ctx, h.config);
  assert.equal(readFileSync(join(h.home, 'AGENTS.md'), 'utf8'), 'mine');
  stop(h);
});

test('budget block: notifies, holds wake-ups; unblock delivers them', async () => {
  const { apply } = await import('../src/core.js');
  const h = harness({ blocked: ['daily'], state: { blockedOn: undefined, pending: [] } });
  apply(h.ctx, h.config);
  await wait(200);
  assert.match(h.hooks[0]?.title ?? '', /预算已用完/);
  // a held item, then the user lifts the block
  const st = join(h.dsh, 'dsh-dot-state.json');
  h.budgetSvc.blockedScopes = [];
  await wait(200);
  assert.ok(h.hooks.some((x) => /已解除/.test(x.title)));
  stop(h);
});

test('midnight: yesterday\'s daily block is lifted automatically and held items delivered', async () => {
  const { apply } = await import('../src/core.js');
  const h = harness({ blocked: ['daily'], state: { blockedOn: '2000-1-1', pending: [{ key: 'k', text: 'held item', at: 'x' }] } });
  apply(h.ctx, h.config);
  await wait(250);
  assert.deepEqual(h.budgetSvc.blockedScopes, []);
  assert.ok(h.hooks.some((x) => /新的一天/.test(x.title)), JSON.stringify(h.hooks));
  assert.deepEqual(h.followups, [{ id: 's-main', text: 'held item' }]);
  assert.ok(h.audit.some((e) => e.event === 'budget-auto-unblock'));
  stop(h);
});

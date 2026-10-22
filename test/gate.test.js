import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/gate.js';

function harness(config = {}) {
  const handlers = {};
  const ctx = {
    on: (name, fn) => { handlers[name] = fn; },
    dshComputer: { audit() {}, liveViewUrl: 'http://127.0.0.1:18080/vnc', publicLiveViewUrl: 'https://mac.ts.net/vnc' },
  };
  apply(ctx, config);
  const gate = (name, input) => (handlers['tools/pre-execute'] ?? ((_e, next) => next()))({ name, input, agent: { session: { id: 's' } } }, async () => 'ran');
  return { gate };
}

test('risky shell commands are gated on every VM shell tool, not only bash', async () => {
  const { gate } = harness();
  for (const tool of ['bash', 'mcp__vm__sandbox_execute_bash', 'mcp__vm__sandbox_execute_code']) {
    const r = await gate(tool, { command: 'rm -rf /tmp/x' });
    assert.equal(r.kind, 'ask', tool);
    assert.match(r.reason, /https:\/\/mac\.ts\.net\/vnc/);
    assert.equal(await gate(tool, { command: 'ls -la' }), 'ran', tool);
  }
});

test('sensitive browser actions are gated; read-only ones are not', async () => {
  const { gate } = harness();
  assert.equal((await gate('mcp__vm__browser_click', { selector: '#login' })).kind, 'ask');
  assert.equal(await gate('mcp__vm__browser_get_text', { selector: '#login' }), 'ran');
  assert.equal(await gate('mcp__vm__browser_click', { selector: '#next' }), 'ran');
});

test('mode off never asks', async () => {
  const { gate } = harness({ mode: 'off' });
  assert.equal(await gate('mcp__vm__sandbox_execute_bash', { command: 'sudo rm -rf /' }), 'ran');
});

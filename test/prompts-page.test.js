// /dot prompts: the editor page (scripts/prompts.mjs) runs as a child process on 127.0.0.1, edits her
// <home>, answers the same URL when asked again, and stops on /dot prompts stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/dot/core.js';

test('/dot prompts: start → page reachable → same URL again → stop', { timeout: 60000 }, async () => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-'));
  const home = join(mkdtempSync(join(tmpdir(), 'home-')), 'dot');
  const port = 17000 + Math.floor(Math.random() * 2000);
  const effects = [];
  let cmd;
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }), on() {}, effect(fn) { effects.push(fn()); },
    systemPrompt: { context() {}, section() { return () => {}; }, getSectionOrder: () => 0 },
    inject(deps, fn) { if (deps.every((d) => this.get(d))) fn({ ...this, ...Object.fromEntries(deps.map((d) => [d, this.get(d)])) }); },
    get: (n) => ({ budget: { status: () => ({ blockedScopes: [] }) }, schedule: {}, systemPrompt: ctx.systemPrompt, commands: { register: (c) => { cmd = c; return () => {}; } } }[n]),
  };
  try {
    apply(ctx, { home, promptsPort: port, budgetPollSeconds: 0 });
    const url = `http://127.0.0.1:${port}/`;
    const first = await cmd.handler({ rawInput: 'prompts' });
    assert.ok(first.text.includes(url), first.text);
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /dot 提示词/);
    const list = await (await fetch(`${url}api/file?id=canon.characterName`)).json();
    assert.ok(list.path.startsWith(join(home, 'interlude', 'canon.json')), list.path); // her home, not ~/dot
    assert.ok((await cmd.handler({ rawInput: 'prompts' })).text.includes(url));
    assert.match((await cmd.handler({ rawInput: 'prompts stop' })).text, /stopped/);
    await assert.rejects(fetch(url));
    assert.match((await cmd.handler({ rawInput: 'prompts stop' })).text, /not running/);
  } finally {
    for (const d of effects) if (typeof d === 'function') d();
  }
});

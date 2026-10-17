import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageText, focus, createPrechecker, readWatches } from '../src/precheck.js';
import { inQuietHours } from '../src/core.js';
import { createIm } from '../src/im.js';

const at = (h, m) => new Date(2026, 9, 17, h, m);

test('quiet hours wrap midnight', () => {
  assert.equal(inQuietHours('23:00-08:00', at(23, 30)), true);
  assert.equal(inQuietHours('23:00-08:00', at(7, 59)), true);
  assert.equal(inQuietHours('23:00-08:00', at(8, 0)), false);
  assert.equal(inQuietHours('12:00-13:00', at(12, 30)), true);
  assert.equal(inQuietHours('', at(3, 0)), false);
});

test('pageText strips scripts, tags, entities', () => {
  assert.equal(pageText('<html><script>x()</script><style>a{}</style><p>Hi&nbsp;<b>there</b></p></html>'), 'Hi there');
});

test('focus keeps only sentences with keywords', () => {
  assert.equal(focus('苹果发布了新品。 DeepSeek 发布了 V5。 天气不错。', ['DeepSeek']), 'DeepSeek 发布了 V5。');
});

test('readWatches validates and defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dot-'));
  writeFileSync(join(dir, 'w.json'), JSON.stringify({ watches: [{ url: 'https://a.example' }, { url: 'ftp://x' }, { name: 'B', url: 'http://b.example', everyMinutes: 1 }] }));
  const w = readWatches(join(dir, 'w.json'));
  assert.equal(w.length, 2);
  assert.equal(w[0].everyMinutes, 60);
  assert.equal(w[1].everyMinutes, 5);
});

test('precheck: baseline, no change, change', async () => {
  let body = '<p>v1</p>';
  const server = http.createServer((req, res) => { res.end(body); }).listen(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const dir = mkdtempSync(join(tmpdir(), 'dot-'));
  writeFileSync(join(dir, 'watch.json'), JSON.stringify({ watches: [{ name: 'T', url, everyMinutes: 5 }] }));
  const data = {}; const changes = [];
  const pre = createPrechecker({ file: join(dir, 'watch.json'), store: { get: (k) => data[k], set: (k, v) => { data[k] = v; } }, logger: console, onChange: (w, c) => changes.push(c) });
  await pre.tick(0);            // baseline
  await pre.tick(60_000);       // too early
  await pre.tick(6 * 60_000);   // same content
  body = '<p>v2</p>';
  await pre.tick(12 * 60_000);  // changed
  server.close();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].before, 'v1');
  assert.equal(changes[0].after, 'v2');
});

test('bridge link: silence, binding, notify (real dsh-bridge class)', async (t) => {
  const im = createIm({ logger: { info() {}, warn() {} } });
  await im.ready;
  if (!im.status().linked) { t.skip(`dsh-bridge not available: ${im.status().error}`); return; }
  const { ConversationBridge } = await import(process.env.BRIDGE_MODULE);
  const ctx = { on: () => () => {}, get: () => undefined, approval: undefined, sessions: undefined, agents: undefined };
  const sent = [];
  class FakeNode extends ConversationBridge { async _sendTextNow(text) { sent.push(text); } }
  const node = new FakeNode({ ctx, logger: console, platform: { id: 'fake', status: 'online', capabilities: {} }, config: { activeSessionId: 's-1', allowFrom: ['u1'] } });
  await node.sendText('DOT_SILENT');
  await node.sendText('**DOT_SILENT**');
  await node.sendText('有更新：A\n\nDOT_SILENT');
  assert.deepEqual(sent, ['有更新：A']);
  assert.deepEqual(im.boundSessions(), [{ platform: 'fake', sessionId: 's-1' }]);
  const channels = await im.notify('title', 'body');
  assert.deepEqual(channels, ['fake']);
  assert.equal(sent.at(-1), 'title\nbody');
});

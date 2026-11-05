// bench/chat-memory-benchmark.mjs: the model adapter memory.js consumes (event shape, retries, no fishing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createModel } from '../bench/chat-memory-benchmark.mjs';

function server(replies) {
  const seen = [];
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push(JSON.parse(body));
      const [status, json] = replies.shift() ?? [500, {}];
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json));
    });
  });
  return new Promise((r) => { s.listen(0, '127.0.0.1', () => r({ s, seen, url: `http://127.0.0.1:${s.address().port}` })); });
}
const ok = (text) => [200, { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60, completion_tokens: 7 } }];

test('ctx.llm.stream: retries 429/5xx, then yields text-delta, usage, finish as memory.js reads them', async () => {
  const { s, seen, url } = await server([[429, {}], [503, {}], ok('{"owner":[]}')]);
  const m = createModel({ baseUrl: url, apiKey: 'k', model: 'deepseek-chat', backoffMs: 5 });
  const events = [];
  for await (const e of m.llm.stream({ maxTokens: 16384, messages: [{ role: 'user', content: [{ type: 'text', text: '整理' }] }] })) events.push(e);
  s.close();
  assert.equal(seen.length, 3);
  assert.equal(seen[2].max_tokens, 8192, 'capped');
  assert.deepEqual(seen[2].messages, [{ role: 'user', content: '整理' }]);
  assert.deepEqual(events, [{ type: 'text-delta', text: '{"owner":[]}' }, { type: 'usage', usage: { inputTokens: 60, cacheReadTokens: 40, outputTokens: 7 } }, { type: 'finish', reason: { kind: 'stop' } }]);
  assert.deepEqual(m.usage.consolidate, { calls: 1, errors: 0, hit: 40, miss: 60, out: 7 });
});

test('a returned answer is final; a 4xx is not retried and ends the stream as an error', async () => {
  const { s, seen, url } = await server([ok(''), [400, { error: 'bad' }]]);
  const m = createModel({ baseUrl: url, apiKey: 'k', model: 'deepseek-chat', backoffMs: 5 });
  const a = await m.complete([{ role: 'user', content: 'q' }], { maxTokens: 100, purpose: 'answer' });
  assert.equal(a.text, '', 'an empty reply is not asked again');
  const events = [];
  for await (const e of m.llm.stream({ messages: [] })) events.push(e);
  s.close();
  assert.equal(seen.length, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason.kind, 'error');
  assert.equal(m.usage.consolidate.errors, 1);
});

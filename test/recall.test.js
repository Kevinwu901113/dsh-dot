import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/memory/memory.js';
import { chunkTurns, openIndex, settingsFile } from '../src/memory/recall.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake embedder: character-bigram hashing, deterministic and offline. Its size differs by
// backend, so an index that mixed two backends would throw.
function fakeEmbedders({ fail = false } = {}) {
  const calls = [];
  const factory = (backend, spec) => {
    if (fail) throw new Error('no network');
    const dim = backend === 'local' ? 512 : 768;
    return {
      async embed(texts, role) {
        calls.push({ backend, model: spec.model, role, texts });
        return texts.map((t) => {
          const v = new Float32Array(dim); const s = String(t).replace(/^\[[^\]]*\]/, '').replace(/\s+/g, '');
          for (let i = 0; i + 2 <= s.length; i++) { let h = 2166136261; for (const ch of s.slice(i, i + 2)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } v[h % dim] += 1; }
          return v;
        });
      },
      rerank: spec.rerank && spec.rerank !== 'none' ? async (_q, docs, n) => docs.map((_, index) => ({ index, score: 1 - index / 100 })).slice(0, n) : null,
    };
  };
  return { factory, calls };
}

function harness(config = {}, emb = fakeEmbedders()) {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-'));
  const home = join(mkdtempSync(join(tmpdir(), 'home-')), 'dot');
  const listeners = [], contexts = [], assemble = [];
  let session = 's1';
  const services = { dshDot: { session: () => session, setSession: (id) => { session = id; }, isErrand: (id) => id === 'errand', isIm: () => false } };
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    on: (name, fn) => { if (name === 'session/event') listeners.push(fn); if (name === 'system-prompt/assemble') assemble.push(fn); },
    effect() {},
    get: (n) => services[n],
    provide(n, v) { services[n] = v; },
    inject(_deps, fn) { fn({ systemPrompt: { context: (c) => contexts.push(c) }, tools: { register: () => () => {} }, effect: (f) => f(), on: ctx.on }); },
  };
  apply(ctx, { home, consolidateEveryLines: 1000, recallEmbedder: emb.factory, recallMinScore: 0, ...config }); // the fake embedder's scores are not cosines
  const emit = (id, type, data, extra = {}) => listeners.forEach((fn) => fn({ id, header: { cwd: home } }, { type, data, ...extra }));
  let clock = new Date(2026, 9, 1, 10, 0).getTime();
  const realNow = Date.now;
  const turn = (id, user, reply) => {
    Date.now = () => (clock += 60000);
    try {
      emit(id, 'turn/start', {});
      emit(id, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: user }] }, { surfaceOp: 'append' });
      emit(id, 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } });
      emit(id, 'turn/end', {});
    } finally { Date.now = realNow; }
  };
  const recallCtx = contexts.find((c) => c.name === 'dot:recall');
  return { home, emb, emit, turn, assemble, api: () => services.dotMemory, recall: () => services.dotMemory.recall, text: (id) => recallCtx.text({ agent: { session: { id, header: { cwd: home } } } }), set session(id) { session = id; } };
}

test('chunks: one per turn (what woke her + what she said back), dated; secret lines never enter', () => {
  const at = new Date(2026, 9, 27, 14, 3).getTime();
  const c = chunkTurns([
    { at, session: 's1', who: 'owner', text: '下周六我搬家' },
    { at: at + 1, session: 's1', who: 'her', text: '搬去哪\n要帮忙吗' },
    { at: at + 2, session: 's1', who: 'her', to: 'user:9', text: '在吗' },
    { at: at + 3, session: 's1', who: 'phone', text: 'QQ 阿满：晚上打游戏吗' },
    { at: at + 4, session: 's1', who: 'owner', text: '我的密码是 hunter2hunter2' },
    { at: at + 5, session: 's2', who: 'owner', text: '换了个会话' },
  ]);
  assert.equal(c.length, 3);
  assert.equal(c[0].text, '[2026-10-27 14:03] 他：下周六我搬家\n我：搬去哪 / 要帮忙吗\n我（发给 user:9）：在吗');
  assert.match(c[1].text, /^\[2026-10-27 14:03\] \[手机\]：QQ 阿满：晚上打游戏吗$/, 'the secret line in the same turn is dropped');
  assert.doesNotMatch(c.map((x) => x.text).join(), /hunter2/);
  assert.equal(c[2].session, 's2');
});

test('index: built per turn at turn end, incrementally, survives a restart without re-embedding', async () => {
  const h = harness();
  h.turn('s0', '我家猫叫团子，橘色的', '团子好可爱');
  h.turn('s0', '下个月去成都出差', '记得带伞');
  await h.recall().sync();
  const ix = openIndex(h.recall().status().dir);
  assert.equal(ix.size, 2);
  assert.equal(statSync(join(ix.dir, 'vectors.f32')).size, 2 * 512 * 4);
  assert.match(ix.meta()[0].text, /他：我家猫叫团子[\s\S]*我：团子好可爱/);
  const embedded = h.emb.calls.filter((c) => c.role === 'passage').flatMap((c) => c.texts).length;
  h.turn('s0', '周末想吃火锅', '好呀');
  await h.recall().sync();
  assert.equal(h.recall().status().turns, 3);
  assert.equal(h.emb.calls.filter((c) => c.role === 'passage').flatMap((c) => c.texts).length, embedded + 1, 'only the new turn is embedded');
  // A restart over the same home: the index is read back, nothing is embedded again.
  const emb2 = fakeEmbedders();
  const listeners = [];
  apply({ logger: () => ({ info() {}, warn() {} }), on: (n, f) => { if (n === 'session/event') listeners.push(f); }, effect() {}, get: () => undefined, provide() {}, inject() {} }, { home: h.home, recallEmbedder: emb2.factory });
  assert.equal(openIndex(h.recall().status().dir).size, 3);
  assert.equal(emb2.calls.length, 0);
});

test('query: the waking message → top-k older turns in time order, minus her current session; only her conversation sees it', async () => {
  const h = harness({ recallTopK: 2 });
  h.turn('s0', '我家猫叫团子，橘色的', '团子好可爱');
  h.turn('s0', '下个月去成都出差', '记得带伞');
  h.turn('s0', '团子今天又把杯子推下桌了', '猫就是这样');
  h.turn('s1', '团子最近不爱吃饭', '要不要换猫粮'); // her current session: already in her window
  await h.recall().sync();
  h.emit('s1', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '团子是什么颜色来着' }] }, { surfaceOp: 'append' });
  await h.recall().pending('s1');
  const text = h.text('s1');
  assert.match(text, /^你记得的相关原话/);
  assert.match(text, /\[2026-10-01 10:0\d\] 他：我家猫叫团子[\s\S]*团子今天又把杯子推下桌了/, 'chronological, dated');
  assert.doesNotMatch(text, /不爱吃饭/, 'her current session is not repeated');
  assert.doesNotMatch(text, /成都/, 'top-k');
  assert.equal(h.text('errand'), '', 'errands are not her remembering');
  assert.equal(h.recall().status().lastQuery.hits, 2);
  // The turn ends: the result is not carried into the next wake.
  h.emit('s1', 'turn/end', {});
  assert.equal(h.text('s1'), '');
  // A host that shows only the last N turns: exactly those are skipped.
  const w = harness({ recallWindowTurns: 1, recallTopK: 8 });
  w.turn('s1', '团子是只橘猫', '记住了');
  w.turn('s1', '团子今天打翻了水杯', '哈哈');
  const r = await w.recall().query('团子', { session: 's1' });
  assert.deepEqual(r.hits.map((x) => x.text.split('\n')[0].slice(19)), ['他：团子是只橘猫']);
});

test('budget: at most recallMaxTokens, the weakest dropped first', async () => {
  const h = harness({ recallMaxTokens: 40 });
  h.turn('s0', `团子${'很'.repeat(40)}可爱`, '嗯');
  h.turn('s0', '团子是橘猫', '对');
  const r = await h.recall().query('团子是什么猫', { session: 's1' });
  assert.equal(r.hits.length, 1);
  assert.match(r.hits[0].text, /橘猫/);
});

test('secrets: not indexed, not injected, and a secret query is never sent to the embedder', async () => {
  const h = harness();
  h.turn('s0', '我的 api key 是 sk-abcdef1234567890', '收到');
  h.turn('s0', '我的 GitHub 用户名是 kevin', '好');
  await h.recall().sync();
  const meta = readFileSync(join(h.recall().status().dir, 'meta.jsonl'), 'utf8');
  assert.doesNotMatch(meta, /sk-abcdef/);
  assert.match(meta, /我：收到/, 'the rest of that turn stays');
  const before = h.emb.calls.length;
  const r = await h.recall().query('密码是 hunter2hunter2 对吧', { session: 's1' });
  assert.equal(r.text, '');
  assert.equal(h.emb.calls.length, before);
});

test('backends: each backend+model keeps its own index; switching never mixes or overwrites; off injects nothing', async () => {
  const h = harness();
  h.turn('s0', '团子是橘猫', '嗯');
  await h.recall().sync();
  const localDir = h.recall().status().dir;
  assert.match(await h.api().command('memory recall backend siliconflow'), /recall: siliconflow · BAAI\/bge-m3 \+ BAAI\/bge-reranker-v2-m3/);
  await h.recall().sync();
  const s = h.recall().status();
  assert.notEqual(s.dir, localDir);
  assert.equal(s.turns, 1);
  assert.equal(statSync(join(s.dir, 'vectors.f32')).size, 768 * 4, 'its own vector size');
  h.turn('s0', '下周去成都', '好');
  await h.recall().sync();
  const r = await h.recall().query('团子', { session: 's1' });
  assert.equal(r.mode, 'siliconflow');
  await h.api().command('memory recall backend local');
  await h.recall().sync();
  assert.equal(h.recall().status().turns, 2, 'local caught up with the turn it missed');
  assert.equal(statSync(join(localDir, 'vectors.f32')).size, 2 * 512 * 4);
  assert.equal(readdirSync(join(h.home, 'memory', 'recall')).length, 2);
  await h.api().command('memory recall backend off');
  assert.equal((await h.recall().query('团子', { session: 's1' })).text, '');
  assert.match(await h.api().command('memory recall'), /recall: off/);
});

test('commands: status, key (0600, masked), model, rerank, mirror, rebuild, test', async () => {
  const h = harness();
  h.turn('s0', '团子是橘猫', '嗯');
  await h.recall().sync();
  let out = await h.api().command('memory recall');
  assert.match(out, /recall: local · Xenova\/bge-small-zh-v1\.5 · ready/);
  assert.match(out, /index: 1 turn\(s\) through 2026-10-01/);
  assert.match(out, /mirror https:\/\/hf-mirror\.com/);
  assert.match(await h.api().command('memory'), /recall: local/, '/dot memory shows it too');
  out = await h.api().command('memory recall key siliconflow sk-1234567890abcdef');
  assert.match(out, /saved \(sk-…cdef\)/);
  assert.doesNotMatch(out, /1234567890/);
  assert.equal(statSync(settingsFile()).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(settingsFile(), 'utf8')).recall.keys.siliconflow, 'sk-1234567890abcdef');
  await h.api().command('memory recall backend siliconflow');
  assert.match(await h.api().command('memory recall'), /key sk-…cdef \(dsh-memory\.json\)/);
  assert.match(await h.api().command('memory recall rerank none'), /recall: siliconflow · BAAI\/bge-m3 · /);
  await h.api().command('memory recall backend local');
  assert.match(await h.api().command('memory recall rerank x'), /local has no reranker/);
  out = await h.api().command('memory recall model BAAI/bge-small-zh-v1.5');
  assert.match(out, /Xenova\/bge-small-zh-v1\.5/, 'the BAAI name maps to its ONNX export');
  await h.api().command('memory recall model Xenova/multilingual-e5-small');
  await h.recall().sync();
  assert.match(h.recall().status().dir, /local-Xenova_multilingual-e5-small$/);
  assert.equal(h.recall().status().turns, 1);
  await h.api().command('memory recall model default');
  assert.match(await h.api().command('memory recall mirror https://huggingface.co'), /mirror: https:\/\/huggingface\.co/);
  assert.match(await h.api().command('memory recall mirror ftp://x'), /http\(s\) URL/);
  assert.match(await h.api().command('memory recall rebuild'), /rebuilt[\s\S]*index: 1 turn/);
  assert.match(await h.api().command('memory recall test 团子什么颜色'), /^local · \d+ ms · 1 hit\(s\)[\s\S]*他：团子是橘猫/);
  assert.match(await h.api().command('memory recall backend nope'), /one of local, siliconflow, dashscope, off/);
  const panel = await h.api().panel();
  assert.equal(panel.recall.backend, 'local');
  assert.equal(panel.recall.turns, 1);
});

test('fallback: a backend that cannot load (no library, no network, no key) recalls by words and says so', async () => {
  const h = harness({}, fakeEmbedders({ fail: true }));
  h.turn('s0', '团子是橘猫', '嗯');
  h.turn('s0', '下周去成都', '好');
  const r = await h.recall().query('团子', { session: 's1' });
  assert.equal(r.mode, 'local→lexical');
  assert.match(r.text, /团子是橘猫/);
  assert.doesNotMatch(r.text, /成都/);
  assert.match((await h.api().command('memory recall')), /unavailable: no network → lexical fallback/);
  assert.equal(existsSync(join(h.home, 'memory', 'recall')), false, 'nothing indexed');
  // A cloud backend with no key says what to do.
  const c = harness({ recallBackend: 'dashscope' }, { factory: undefined, calls: [] });
  const saved = process.env.DASHSCOPE_API_KEY; delete process.env.DASHSCOPE_API_KEY;
  try {
    await c.recall().query('团子', { session: 's1' });
    await wait(5);
    assert.match(await c.api().command('memory recall'), /no key: \/dot memory recall key dashscope <key>, or set DASHSCOPE_API_KEY/);
  } finally { if (saved) process.env.DASHSCOPE_API_KEY = saved; }
});

test('prompt assembly waits (bounded) for a query still running, and puts its text in', async () => {
  const slow = fakeEmbedders();
  const factory = (b, spec) => { const e = slow.factory(b, spec); return { ...e, embed: async (t, role) => { if (role === 'query') await wait(30); return e.embed(t, role); } }; };
  const h = harness({ recallWaitMs: 1000 }, { factory, calls: slow.calls });
  h.turn('s0', '团子是橘猫', '嗯');
  await h.recall().sync();
  h.emit('s1', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '团子什么颜色' }] }, { surfaceOp: 'append' });
  const assembly = { contexts: [{ name: 'dot:recall', text: h.text('s1') }] };
  assert.equal(assembly.contexts[0].text, '', 'not ready when the contexts were read');
  const out = await h.assemble[0](assembly, { agent: { session: { id: 's1' } } }, async () => assembly);
  assert.match(out.contexts[0].text, /团子是橘猫/);
  // Nothing pending (another agent, or already done): straight through.
  const other = { contexts: [] };
  assert.equal(await h.assemble[0](other, { agent: { session: { id: 'x' } } }, async () => other), other);
});

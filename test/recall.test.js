import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/memory/memory.js';
import { SPECS, chunkTurns, contrastCut, createBm25, createRecall, lexTokens, libDir, openIndex, queryLength, renderTurns, settingsFile } from '../src/memory/recall.js';
import { annotate, dayHeading } from '../src/memory/when.js';

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

// `over`: a previous harness whose DSH_HOME and home this one boots over (a restart / an upgrade).
function harness(config = {}, emb = fakeEmbedders(), over = null) {
  if (!over) process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-'));
  const home = over?.home ?? join(mkdtempSync(join(tmpdir(), 'home-')), 'dot');
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
  apply(ctx, { home, consolidateEveryLines: 1000, recallEmbedder: emb.factory, recallMinScore: 0, recallContrast: 0, recallMinQueryLength: 0, ...config }); // the fake embedder's scores are not cosines; queries here are short
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
  assert.match(text, /— 10-01 周四 · \d+ 天前\n10:0\d 他：我家猫叫团子[\s\S]*\n10:0\d 他：团子今天又把杯子推下桌了/, 'chronological, under the day');
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
  assert.equal(r.mode, 'siliconflow+rerank');
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
  assert.match(out, /recall: local · Xenova\/multilingual-e5-small \+ Xenova\/bge-reranker-base \([^)]*\) · ready/, 'the default local models (0.20: + reranker)');
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
  assert.match(await h.api().command('memory recall rerank none'), /recall: siliconflow · BAAI\/bge-m3 · no reranker · /);
  await h.api().command('memory recall backend local');
  assert.match(await h.api().command('memory recall rerank BAAI/bge-reranker-v2-m3'), /\+ onnx-community\/bge-reranker-v2-m3-ONNX[\s\S]*the index stays as it is/, 'the BAAI name maps to its ONNX export');
  await h.api().command('memory recall rerank default');
  assert.match(h.recall().status().dir, /local-Xenova_multilingual-e5-small$/);
  out = await h.api().command('memory recall model BAAI/bge-small-zh-v1.5');
  assert.match(out, /recall: local · Xenova\/bge-small-zh-v1\.5 \+ /, 'the BAAI name maps to its ONNX export');
  await h.recall().sync();
  assert.match(h.recall().status().dir, /local-Xenova_bge-small-zh-v1\.5$/);
  assert.equal(h.recall().status().turns, 1);
  out = await h.api().command('memory recall model intfloat/multilingual-e5-small');
  assert.match(out, /recall: local · Xenova\/multilingual-e5-small \+ /, 'so does the intfloat name');
  assert.match(h.recall().status().dir, /local-Xenova_multilingual-e5-small$/);
  await h.api().command('memory recall model default');
  assert.match(await h.api().command('memory recall mirror https://huggingface.co'), /mirror: https:\/\/huggingface\.co/);
  assert.match(await h.api().command('memory recall mirror ftp://x'), /http\(s\) URL/);
  assert.match(await h.api().command('memory recall rebuild'), /rebuilt[\s\S]*index: 1 turn/);
  assert.match(await h.api().command('memory recall test 团子什么颜色'), /^local\+rerank · \d+ ms · 1 hit\(s\) of 1 candidate\(s\)[\s\S]*他：团子是橘猫/);
  assert.match(await h.api().command('memory recall backend nope'), /one of local, siliconflow, dashscope, off/);
  const panel = await h.api().panel();
  assert.equal(panel.recall.backend, 'local');
  assert.equal(panel.recall.turns, 1);
});

test('upgrade from 0.15.1: no saved model → e5, its index built from the whole transcript; the bge-small-zh index is left as it was', async () => {
  // 0.15.1: bge-small-zh was the default, and its index is on disk.
  const old = harness({ recallModel: 'Xenova/bge-small-zh-v1.5' });
  old.turn('s0', '团子是橘猫', '嗯');
  old.turn('s0', '下周去成都', '好');
  await old.recall().sync();
  const bgeDir = old.recall().status().dir;
  assert.match(bgeDir, /local-Xenova_bge-small-zh-v1\.5$/);
  const bgeVectors = readFileSync(join(bgeDir, 'vectors.f32'));
  // 0.15.2 over the same home, nothing chosen anywhere.
  const h = harness({}, fakeEmbedders(), old);
  assert.equal(h.recall().status().model, 'Xenova/multilingual-e5-small');
  assert.equal(h.recall().status().turns, 0, 'a new, empty index');
  await h.recall().warm(); // what the first wake (or the boot-time sync) sets off
  const s = h.recall().status();
  assert.match(s.dir, /local-Xenova_multilingual-e5-small$/);
  assert.equal(s.turns, 2, 'rebuilt from transcript.jsonl on first use');
  assert.equal(h.emb.calls.filter((c) => c.role === 'passage').flatMap((c) => c.texts).length, 2);
  assert.deepEqual(readFileSync(join(bgeDir, 'vectors.f32')), bgeVectors, 'the old index is not touched');
  assert.deepEqual(readdirSync(join(h.home, 'memory', 'recall')).sort(), ['local-Xenova_bge-small-zh-v1.5', 'local-Xenova_multilingual-e5-small']);
  // Switching back reuses it: nothing is embedded again.
  const passages = () => h.emb.calls.filter((c) => c.role === 'passage').length;
  const n = passages();
  await h.api().command('memory recall model BAAI/bge-small-zh-v1.5');
  await h.recall().warm();
  assert.equal(h.recall().status().dir, bgeDir);
  assert.equal(h.recall().status().turns, 2);
  assert.equal(passages(), n);
});

test('upgrade from 0.15.1: a saved bge-small-zh choice is kept (dsh-memory.json, or recallModel in dsh-dot.json)', async () => {
  const h = harness();
  h.turn('s0', '团子是橘猫', '嗯');
  await h.api().command('memory recall model BAAI/bge-small-zh-v1.5'); // what a 0.15.1 user typed
  assert.equal(JSON.parse(readFileSync(settingsFile(), 'utf8')).recall.model.local, 'BAAI/bge-small-zh-v1.5');
  await h.recall().sync();
  const up = harness({}, fakeEmbedders(), h);
  assert.equal(up.recall().status().model, 'Xenova/bge-small-zh-v1.5');
  assert.match(up.recall().status().dir, /local-Xenova_bge-small-zh-v1\.5$/);
  assert.equal(up.recall().status().turns, 1);
  await up.recall().sync();
  assert.equal(up.emb.calls.length, 0, 'its index is used as it is');
  // The same choice made in the plugin config (dsh-dot.json memory.recallModel).
  const c = harness({ recallModel: 'BAAI/bge-small-zh-v1.5' });
  assert.equal(c.recall().status().model, 'Xenova/bge-small-zh-v1.5');
});

test('model conventions: e5 mean-pools with "query: " / "passage: ", bge-small-zh cls with its instruction', () => {
  assert.deepEqual(SPECS['Xenova/multilingual-e5-small'], { pooling: 'mean', query: 'query: ', passage: 'passage: ', mb: 129 });
  assert.deepEqual(SPECS['Xenova/bge-small-zh-v1.5'], { pooling: 'cls', query: '为这个句子生成表示以用于检索相关文章：', passage: '', mb: 23 });
});

test('filters that do not depend on the model: query length (any script) and contrast against the whole index', async () => {
  assert.deepEqual(['好的', '哈哈哈哈', 'ok thanks', '在吗？', '我回来了', 'What did Caroline research?', 'Hey hey hey!!', '阿岑会修什么？', '明天 8 点 meeting'].map(queryLength), [2, 1, 2, 2, 4, 4, 1, 6, 5]);
  // Contrast: median + k·(best − median), scale-free.
  const crowd = (base, spread, top) => [...Array.from({ length: 30 }, (_, i) => base + (i % 5) * spread), ...top];
  assert.equal(contrastCut(crowd(0.4, 0.01, [0.7]), 0), -Infinity, 'k 0 is off');
  assert.equal(contrastCut([0.9, 0.5, 0.4], 0.35), -Infinity, 'too few chunks to say what stands out');
  const bge = crowd(0.40, 0.01, [0.70, 0.62]), e5 = bge.map((x) => 0.78 + x * 0.2); // same ranking, e5's squeezed scale
  const kept = (s) => s.filter((x) => x >= contrastCut(s, 0.35)).length;
  assert.equal(kept(bge), 2);
  assert.equal(kept(e5), 2, 'the same turns stand out on either scale');
  // The gate: nothing recalled, nothing embedded, not even lexically; the status says why.
  const h = harness({ recallMinQueryLength: 4 });
  h.turn('s0', '好的好的，团子是橘猫', '嗯');
  await h.recall().sync();
  const n = h.emb.calls.length;
  const r = await h.recall().query('好的', { session: 's1' });
  assert.deepEqual([r.text, r.mode, h.emb.calls.length], ['', 'local·short', n]);
  assert.match(await h.api().command('memory recall'), /0 hit\(s\) via local·short/);
  assert.match((await h.recall().query('团子是什么猫', { session: 's1' })).text, /团子是橘猫/);
});

// A stand-in for @huggingface/transformers, installed where recall.js installs the real one. Its
// model download waits for `release()`, so the status in between can be looked at.
function fakeTransformers() {
  const dir = join(libDir(), 'node_modules', '@huggingface', 'transformers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{ "name": "@huggingface/transformers", "type": "module", "main": "index.js" }\n');
  writeFileSync(join(dir, 'index.js'), `export const env = {};
export async function pipeline(task, model, opts) {
  const t = globalThis.__fakeTf;
  t.pipelines.push({ task, model, opts: { ...opts, progress_callback: Boolean(opts.progress_callback) } });
  if (opts.progress_callback) { opts.progress_callback({ status: 'progress_total', progress: 40.6 }); await t.gate; opts.progress_callback({ status: 'progress_total', progress: 100 }); opts.progress_callback({ status: 'ready', model }); }
  return async (text, o) => { t.embeds.push({ model, text, ...o }); const v = new Float32Array(8); for (const ch of text) v[ch.codePointAt(0) % 8] += 1; return { data: v }; };
}
// A cross-encoder: the share of the query's characters found in the passage.
export const AutoTokenizer = { from_pretrained: async (model) => { globalThis.__fakeTf.rerankers.push(model); return (qs, o) => ({ pairs: qs.map((q, i) => [q, o.text_pair[i]]) }); } };
export const AutoModelForSequenceClassification = { from_pretrained: async () => async ({ pairs }) => ({ logits: { sigmoid: () => ({ tolist: () => pairs.map(([q, d]) => [[...new Set(q)].filter((c) => d.includes(c)).length / new Set(q).size]) }) } }) };
`);
  let release;
  globalThis.__fakeTf = { pipelines: [], embeds: [], rerankers: [], gate: new Promise((r) => { release = r; }) };
  return { t: globalThis.__fakeTf, release };
}

test('first use: the model download is logged and shown in status (phase, %), recall is lexical meanwhile; a cached model is not re-downloaded', async () => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-'));
  const savedEndpoint = process.env.HF_ENDPOINT; delete process.env.HF_ENDPOINT;
  const alive = setInterval(() => {}, 1000); // dsh keeps the loop alive; recall's own timers are unref'd
  try {
    const { t, release } = fakeTransformers();
    const dir = mkdtempSync(join(tmpdir(), 'mem-'));
    const at = new Date(2026, 9, 1, 10, 0).getTime();
    const lines = [{ at, session: 's0', who: 'owner', text: '团子是橘猫' }, { at: at + 1, session: 's0', who: 'her', text: '嗯' }];
    const logs = [];
    const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };
    const cfg = { recallBackend: 'local', recallModel: '', recallMirror: '', recallMinScore: 0.45, recallInstall: false, recallTopK: 8, recallMaxTokens: 1500, recallChunkChars: 1200, recallCandidates: 20 };
    const r = createRecall({ cfg, dir, lines: () => lines, transcriptFile: join(dir, 'transcript.jsonl'), logger });
    assert.equal(r.status().state, 'not started');
    const q = await r.query('团子什么颜色', { session: 's1' });
    assert.equal(q.mode, 'local→lexical', 'nothing waits for the download');
    assert.match(q.text, /团子是橘猫/);
    const s = r.status();
    assert.equal(s.model, 'Xenova/multilingual-e5-small');
    assert.equal(s.mirror, 'https://hf-mirror.com', 'recallMirror default unchanged');
    assert.equal(s.state, 'downloading multilingual-e5-small (~129 MB) 40% → lexical fallback meanwhile');
    assert.match(await r.command([]), /recall: local · Xenova\/multilingual-e5-small \+ Xenova\/bge-reranker-base \(not loaded\) · downloading multilingual-e5-small \(~129 MB\) 40% → lexical fallback meanwhile[\s\S]*mirror https:\/\/hf-mirror\.com/);
    assert.ok(logs.some((m) => m === `recall: downloading Xenova/multilingual-e5-small (~129 MB, once) from https://hf-mirror.com into ${join(libDir(), 'models')}`), logs.join('\n'));
    assert.equal(t.pipelines[0].model, 'Xenova/multilingual-e5-small');
    assert.deepEqual(t.pipelines[0].opts, { dtype: 'q8', device: 'cpu', progress_callback: true });
    release();
    assert.equal(await r.warm(), true);
    assert.equal(r.status().state, 'ready');
    assert.ok(logs.some((m) => /^recall: Xenova\/multilingual-e5-small downloaded in \d+ s$/.test(m)));
    assert.deepEqual(t.embeds.map((e) => [e.text, e.pooling, e.normalize]), [['passage: [2026-10-01 10:00] 他：团子是橘猫\n我：嗯', 'mean', true]]);
    assert.deepEqual(t.rerankers, ['Xenova/bge-reranker-base'], 'the reranker loads after the embedder');
    assert.match(await r.command([]), /\+ Xenova\/bge-reranker-base \(ready\)/);
    const q2 = await r.query('团子什么颜色', { session: 's1' });
    assert.deepEqual(t.embeds.at(-1).text, 'query: 团子什么颜色');
    assert.equal(q2.mode, 'local+rerank');
    assert.equal(q2.hits[0].score, 0.333, 'scored by the cross-encoder');
    // bge-small-zh, already in the cache: loaded, not downloaded; its own pooling and prefix.
    mkdirSync(join(libDir(), 'models', 'Xenova', 'bge-small-zh-v1.5', 'onnx'), { recursive: true });
    writeFileSync(join(libDir(), 'models', 'Xenova', 'bge-small-zh-v1.5', 'onnx', 'model_quantized.onnx'), '');
    logs.length = 0;
    await r.command(['model', 'BAAI/bge-small-zh-v1.5']);
    assert.equal(await r.warm(), true);
    assert.equal(t.pipelines.at(-1).model, 'Xenova/bge-small-zh-v1.5');
    assert.equal(t.pipelines.at(-1).opts.progress_callback, false);
    assert.ok(!logs.some((m) => /downloading Xenova\/bge-small-zh/.test(m)), logs.join('\n'));
    await r.query('团子什么颜色', { session: 's1' });
    assert.deepEqual([t.embeds.at(-1).text, t.embeds.at(-1).pooling], ['为这个句子生成表示以用于检索相关文章：团子什么颜色', 'cls']);
  } finally { clearInterval(alive); if (savedEndpoint) process.env.HF_ENDPOINT = savedEndpoint; delete globalThis.__fakeTf; }
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

test('lexical: bigram tokens; BM25 weighs the rare word', () => {
  assert.deepEqual(lexTokens('阿兰修 OK 好'), ['阿', '阿兰', '兰', '兰修', '修', 'ok', '好']);
  const bm = createBm25();
  // A real transcript: many turns of chat, 咋样了 / 那事 in a few of them, the name in one.
  const topics = ['面试', '猫', '天气', '饭', '腰', '稿子', '车', '房子', '工作', '周末'];
  const docs = ['他：周末拿伞给楼下的阿兰换伞骨，伞布不用动', ...Array.from({ length: 40 }, (_, i) => `他：今天${topics[i % 10]}的事说了好多，${i % 7 === 0 ? `${topics[(i + 3) % 10]}咋样了` : '先这样吧'}，${i % 9 === 0 ? '那事再说' : '晚点聊'}`)];
  for (const t of docs) bm.add(t);
  const sc = bm.score('阿兰那事咋样了');
  assert.equal(sc.indexOf(Math.max(...sc)), 0, 'the rare name outweighs the common words');
});

test('candidates from both channels, then the reranker decides: a turn the vectors miss is found by its rare word; fewer than topK when fewer clear the bar, never padded', async () => {
  // Vectors that know nothing: every turn scores the same, so the vector list alone is the oldest ones.
  const flatVecs = { async embed(texts) { return texts.map(() => Float32Array.from([1, 0, 0, 0])); } };
  // A reranker that reads: the share of the query's characters in the turn.
  const reader = { ...flatVecs, async rerank(q, docs, n) { return docs.map((d, index) => ({ index, score: [...new Set(q)].filter((c) => d.includes(c)).length / new Set(q).size })).sort((a, b) => b.score - a.score).slice(0, n); } };
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  let at = new Date(2026, 4, 1, 10, 0).getTime();
  const lines = [];
  const say = (who, text) => lines.push({ at: (at += 60000), who, text, session: 'old' });
  for (let i = 0; i < 30; i++) { say('owner', `今天第${i}次随便聊聊天气`); say('her', '嗯嗯'); }
  say('owner', '周末拿伞给楼下的阿兰换伞骨'); say('her', '记得带伞');
  const cfg = { recallTopK: 5, recallMaxTokens: 1500, recallContrast: 0.35, recallMinScore: 0, recallMinQueryLength: 0, recallChunkChars: 1200, recallCandidates: 5, recallWindowTurns: 0, recallBackend: 'local' };
  const logger = { info() {}, warn() {} };
  const mk = (extra, emb) => createRecall({ cfg: { ...cfg, ...extra }, dir: mkdtempSync(join(dir, 'r-')), lines: () => lines, transcriptFile: join(dir, 'none'), logger, embedder: () => emb });
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-'));
  // no reranker: the BM25 channel brings it in
  let r = mk({}, flatVecs); r.turnEnded(); await r.warm();
  let q = await r.query('阿兰那事咋样了', { session: 'now' });
  assert.ok(q.hits.some((h) => /阿兰/.test(h.text)));
  r = mk({ recallLexical: false }, flatVecs); r.turnEnded(); await r.warm();
  assert.ok(!(await r.query('阿兰那事咋样了', { session: 'now' })).hits.some((h) => /阿兰/.test(h.text)), 'vectors alone miss it');
  // with a reranker: candidates are both lists (5 + 5), the reranker's order decides
  r = mk({}, reader); r.turnEnded(); await r.warm();
  q = await r.query('阿兰那事咋样了', { session: 'now' });
  assert.equal(q.mode, 'local+rerank');
  assert.ok(q.candidates.length > 5 && q.candidates.length <= 10, 'vector candidates plus BM25 candidates');
  assert.match(q.hits.sort((x, y) => y.score - x.score)[0].text, /阿兰/);
  // a bar: only what clears it, even if that is one turn
  r = mk({ recallRerankMin: 0.2 }, reader); r.turnEnded(); await r.warm();
  q = await r.query('阿兰那事咋样了', { session: 'now' });
  assert.equal(q.hits.length, 1, 'not padded to topK');
  r = mk({ recallRerankMin: 0.99 }, reader); r.turnEnded(); await r.warm();
  q = await r.query('阿兰那事咋样了', { session: 'now' });
  assert.deepEqual([q.hits.length, q.text], [0, ''], 'nothing relevant, nothing shown');
});

test('rendering: recalled turns under their day, 明天 / 下周三 dated by code, nothing in quotes or reported speech', () => {
  const mon = new Date(2026, 6, 6, 20, 15).getTime(); // a Monday
  const now = mon + 15 * 86400000;
  const out = renderTurns([
    { at: mon + 3600000, text: '[2026-07-06 21:15] 他：下周三（我记得是）之前寄\n我：好' },
    { at: mon, text: '[2026-07-06 20:15] 他：明天去，他说后天也行' },
    { at: mon - 86400000, text: '[2026-07-05 09:00] 他：“明天见”她写的' },
  ], now);
  assert.equal(out, ['— 07-05 周日 · 16 天前', '09:00 他：“明天见”她写的', '— 07-06 周一 · 15 天前', '20:15 他：明天（=07-07）去，他说后天也行', '21:15 他：下周三（=07-15）（我记得是）之前寄', '我：好'].join('\n'));
  assert.equal(dayHeading(now, now), '07-21 周二 · 今天');
  assert.equal(annotate('如果明天下雨就算了', mon), '如果明天下雨就算了', 'hypothetical');
  assert.equal(annotate('月底交，周三开会', mon), '月底交，周三开会', 'ambiguous: left as said');
  assert.equal(annotate('上周五和这周日', mon), '上周五（=07-03）和这周日（=07-12）');
  assert.equal(annotate('明天（07-07）去', mon), '明天（07-07）去', 'already written out');
});

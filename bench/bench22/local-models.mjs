#!/usr/bin/env node
// OpenAI-compatible server for dsh-dot's default LOCAL recall models, so that Bench 2.2's gateway can
// meter them (gateway env BENCH22_LOCAL_URL=http://127.0.0.1:<port>/v1, called as local:<name>).
//
//   POST /v1/embeddings  {model, input:[...]}               → {data:[{index, embedding}], usage}
//   POST /v1/rerank      {model, query, documents, top_n}   → {results:[{index, relevance_score}], usage}
//
// The models are run exactly as src/memory/recall.js runs them (transformers.js, q8, CPU; the
// embedder's pooling from recall.js SPECS with normalize; the reranker's score = sigmoid(logit),
// pairs of 8, max_length 512). Query / passage prefixes are added by the caller (the adapter's
// embedder, as recall.js's localEmbedder does). usage.prompt_tokens = the model tokenizer's count
// of what the model actually read (after truncation, without padding).
//
// node bench/bench22/local-models.mjs --port 18890 --lib <dir holding node_modules/@huggingface/transformers>
//   [--mirror https://hf-mirror.com] [--cache <model cache dir>]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { SPECS } from '../../src/memory/recall.js';

const { values: o } = parseArgs({ options: { port: { type: 'string', default: '18890' }, lib: { type: 'string' }, mirror: { type: 'string', default: process.env.HF_ENDPOINT || 'https://hf-mirror.com' }, cache: { type: 'string' }, warm: { type: 'string', multiple: true } } });
if (!o.lib) { console.error('--lib <dir> is required'); process.exit(2); }
const entry = createRequire(pathToFileURL(join(o.lib, 'package.json')).href).resolve('@huggingface/transformers');
const tf = await import(pathToFileURL(entry).href);
tf.env.cacheDir = o.cache || join(o.lib, 'models');
tf.env.allowLocalModels = false;
tf.env.remoteHost = `${o.mirror.replace(/\/+$/, '')}/`;

const embedders = new Map(), rerankers = new Map();
function embedder(model) {
  if (!embedders.has(model)) embedders.set(model, tf.pipeline('feature-extraction', model, { dtype: 'q8', device: 'cpu' }));
  return embedders.get(model);
}
function reranker(model) {
  if (!rerankers.has(model)) rerankers.set(model, (async () => ({ tok: await tf.AutoTokenizer.from_pretrained(model), net: await tf.AutoModelForSequenceClassification.from_pretrained(model, { dtype: 'q8', device: 'cpu' }) }))());
  return rerankers.get(model);
}
const sum = (t) => { let s = 0; for (const x of t.data) s += Number(x); return s; };

// one request at a time: two CPUs, and the ONNX session is not re-entrant-friendly
let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

async function embeddings(body) {
  const model = String(body.model);
  const spec = SPECS[model] ?? { pooling: 'mean' };
  const ex = await embedder(model);
  const input = [].concat(body.input ?? []);
  const data = []; let tokens = 0;
  for (let i = 0; i < input.length; i++) {
    const text = String(input[i]);
    tokens += ex.tokenizer(text, { truncation: true }).input_ids.dims.at(-1);
    const v = await ex(text, { pooling: spec.pooling, normalize: true, truncation: true });
    data.push({ object: 'embedding', index: i, embedding: Array.from(v.data) });
  }
  return { object: 'list', model, data, usage: { prompt_tokens: tokens, total_tokens: tokens } };
}

async function rerank(body) {
  const model = String(body.model);
  const { tok, net } = await reranker(model);
  const docs = [].concat(body.documents ?? []).map(String);
  const query = String(body.query ?? '');
  const out = []; let tokens = 0;
  for (let i = 0; i < docs.length; i += 8) {
    const part = docs.slice(i, i + 8);
    const inputs = tok(part.map(() => query), { text_pair: part, padding: true, truncation: true, max_length: 512 });
    tokens += sum(inputs.attention_mask);
    const { logits } = await net(inputs);
    logits.sigmoid().tolist().forEach((row, k) => out.push({ index: i + k, relevance_score: Number(row[0]) }));
  }
  out.sort((a, b) => b.relevance_score - a.relevance_score);
  const topN = Number(body.top_n) || out.length;
  return { model, results: out.slice(0, topN), usage: { prompt_tokens: tokens, total_tokens: tokens } };
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const send = (code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'bad json' }); }
    const route = req.url.replace(/^\/v1/, '');
    const fn = route === '/embeddings' ? embeddings : route === '/rerank' ? rerank : null;
    if (!fn) return send(404, { error: 'unknown route' });
    serial(() => fn(body)).then((r) => send(200, r), (err) => send(500, { error: String(err?.message ?? err).slice(0, 300) }));
  });
});
for (const m of o.warm ?? []) { if (/rerank/i.test(m)) await reranker(m); else await embedder(m); console.log(`loaded ${m}`); }
server.listen(Number(o.port), '127.0.0.1', () => console.log(`local models on 127.0.0.1:${o.port} (cache ${tf.env.cacheDir}, mirror ${o.mirror})`));

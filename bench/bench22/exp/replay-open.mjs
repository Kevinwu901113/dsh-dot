// Re-run a persona's consolidation calls (open / people only) over its stored transcript, with the
// stored replies (--stored) or fresh ones from the gateway under the repo's current rules.
//   TZ=Asia/Shanghai node replay-open.mjs <memory dir> <out.json> [--stored] [--gateway URL] [--name run]
import { readFileSync, writeFileSync } from 'node:fs';
const REPO = process.env.REPO || '/home/claude/dsh-dot';
const { applyExtraction, parseLooseJson, transcriptLine, extractPrompt } = await import(`${REPO}/src/memory/memory.js`);
const { emptyMemory, openView, renderItem, DEFAULT_LIMITS } = await import(`${REPO}/src/memory/store.js`);
const [dir, outFile, ...rest] = process.argv.slice(2);
const stored = rest.includes('--stored');
const arg = (k, d) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : d);
const gw = arg('--gateway', 'http://127.0.0.1:18886/v1'), name = arg('--name', 'replay');
const jl = (p) => readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const lines = jl(`${dir}/transcript.jsonl`).sort((a, b) => a.at - b.at);
const calls = jl(`${dir}/calls.jsonl`).filter((c) => c.reason !== 'daily');
const keep = { keepAfterDue: 3, keepIdle: 14 };
const memory = emptyMemory();
// people cards the run had (the consolidation is shown them): start from none, as the run did.
async function chat(text) {
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(`${gw}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer evaluator-gateway', 'X-Bench-Run': name, 'X-Bench-System': 'dsh-dot:replay', 'X-Bench-Phase': 'ingest', 'X-Bench-Tag': 'memory' },
        body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: text }], max_tokens: 8192, thinking: { type: 'disabled' } }), signal: AbortSignal.timeout(180000) });
      const t = await res.text();
      if (res.ok) return String(JSON.parse(t).choices?.[0]?.message?.content ?? '');
      if ([400, 402, 403, 404].includes(res.status)) throw new Error(`fatal ${res.status} ${t.slice(0, 200)}`);
    } catch (e) { if (/^fatal/.test(e.message) || a === 3) throw e; }
    await new Promise((r) => setTimeout(r, 3000 * (a + 1)));
  }
}
let cur = 0; const snaps = []; const ops = []; let short = 0;
for (const c of calls) {
  const now = Date.parse(c.at);
  const fresh = [];
  while (cur < lines.length && fresh.length < c.lines && lines[cur].at <= now) fresh.push(lines[cur++]);
  if (fresh.length !== c.lines) short++;
  if (!fresh.length) continue;
  const text = fresh.map((l) => transcriptLine(l, { now })).join('\n');
  let raw = c.reply;
  if (!stored) {
    const known = Object.values(memory.people).filter((p) => p.tier !== 'contact').map((p) => `${p.id} · ${p.names.join('/') || '(无名)'} · ${p.handles.join(', ')} · ${p.tier}${p.impression ? ` · ${p.impression}` : ''}`).join('\n');
    const view = openView(memory, { limits: DEFAULT_LIMITS, now, ...keep });
    raw = await chat(extractPrompt({ text, known, open: [...view.today, ...view.list].map((x) => `- ${renderItem(x, now)}`).join('\n') }));
  }
  const out = parseLooseJson(raw);
  if (!out) { ops.push({ at: c.at, unparsed: true }); continue; }
  const before = JSON.parse(JSON.stringify(memory.open));
  const report = applyExtraction(memory, out, { limits: DEFAULT_LIMITS, now, ...keep, segment: text });
  ops.push({ at: c.at, open: out.open ?? [], errors: report.errors, before: before.map((x) => ({ id: x.id, text: x.text, due: x.due })) });
  snaps.push({ at: now, open: JSON.parse(JSON.stringify(memory.open)) });
  if (!stored && snaps.length % 20 === 0) console.error(name, snaps.length, '/', calls.length);
}
writeFileSync(outFile, JSON.stringify({ dir, stored, short, left: lines.length - cur, snaps, ops }));
console.log(name, 'calls', calls.length, 'segments short', short, 'lines left', lines.length - cur, 'open at end', memory.open.length);

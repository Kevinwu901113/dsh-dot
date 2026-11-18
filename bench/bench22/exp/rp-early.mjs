import { readFileSync } from 'node:fs';
const { transcriptLine } = await import('/home/claude/dsh-dot/src/memory/memory.js');
const R = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const calls = readFileSync(`${R.dir}/calls.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.reason !== 'daily');
const lines = readFileSync(`${R.dir}/transcript.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).sort((a, b) => a.at - b.at);
const p2 = (n) => String(n).padStart(2, '0'); const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const grams = (s) => { const t = s.replace(/[^一-鿿]/g, ''); const g = new Set(); for (let i = 0; i + 1 < t.length; i++) g.add(t.slice(i, i + 2)); return g; };
let cur = 0; const segs = {};
for (const c of calls) { const now = Date.parse(c.at); const f = []; while (cur < lines.length && f.length < c.lines && lines[cur].at <= now) f.push(lines[cur++]); segs[c.at] = f; }
for (const o of R.ops) for (const op of o.open ?? []) if ((op.action === 'done' || op.action === 'remove') && op.oldText) {
  const hit = (o.before ?? []).find((x) => x.text.includes(op.oldText)); if (!hit?.due || hit.due <= ymd(Date.parse(o.at))) continue;
  if ((o.errors ?? []).some((e) => e.includes(hit.text.slice(0, 20)))) continue;
  console.log(`\n## ${ymd(Date.parse(o.at))} done → ${hit.text.slice(0, 90)}（到 ${hit.due}）`);
  const g = grams(hit.text);
  const rel = (segs[o.at] ?? []).filter((l) => l.who === 'owner').map((l) => { let n = 0; for (const b of grams(l.text)) if (g.has(b)) n++; return [n, l]; }).filter((x) => x[0] >= 3).sort((a, b) => b[0] - a[0]).slice(0, 3);
  for (const [, l] of rel) console.log('   他：' + l.text.replace(/\n/g, ' / ').slice(0, 170));
}

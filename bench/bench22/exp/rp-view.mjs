// What a replay's notes look like where it matters: the due-day probes, and every dated mention.
//   TZ=Asia/Shanghai node rp-view.mjs <replay.json> <persona M01|M02> [--probes] 
import { readFileSync } from 'node:fs';
const REPO = process.env.REPO || '/home/claude/dsh-dot';
const { transcriptLine } = await import(`${REPO}/src/memory/memory.js`);
const { openView, renderItem, DEFAULT_LIMITS } = await import(`${REPO}/src/memory/store.js`);
const [file, persona, ...rest] = process.argv.slice(2);
const R = JSON.parse(readFileSync(file, 'utf8'));
const keep = { keepAfterDue: 3, keepIdle: 14 };
const at = (ms) => { let s = null; for (const x of R.snaps) { if (x.at <= ms) s = x; else break; } return s ? { open: s.open } : { open: [] }; };
const probes = JSON.parse(readFileSync('rp/probes.json', 'utf8')).filter((p) => p.persona === persona);
const p2 = (n) => String(n).padStart(2, '0');
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
// 1. side effects at every probe turn
let nT = 0, sumToday = 0, withToday = 0, sumList = 0, sumOpen = 0;
for (const p of probes) { const now = Date.parse(p.time); const v = openView(at(now), { limits: DEFAULT_LIMITS, now, ...keep }); nT++; sumToday += v.today.length; withToday += v.today.length ? 1 : 0; sumList += v.list.length; sumOpen += at(now).open.length; }
console.log(`probe turns ${nT}: with a today list ${withToday}, items per today list ${(sumToday / Math.max(1, withToday)).toFixed(2)}, shown in the open list ${(sumList / nT).toFixed(1)}, stored ${(sumOpen / nT).toFixed(1)}`);
// 2. dated mentions by him -> an item due that day, alive on the morning of that day
const lines = readFileSync(`${R.dir}/transcript.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.who === 'owner');
const grams = (s) => { const t = s.replace(/[^一-鿿]/g, ''); const g = new Set(); for (let i = 0; i + 1 < t.length; i++) g.add(t.slice(i, i + 2)); return g; };
let M = 0, hasItem = 0, match = 0; const last = R.snaps.at(-1).at;
for (const l of lines) {
  const text = transcriptLine(l, { now: l.at });
  const seen = new Set();
  for (const m of text.matchAll(/[（(]=\s*(?:(\d{4})-)?(\d{1,2})-(\d{1,2})\s*[）)]/g)) {
    const y0 = new Date(l.at).getFullYear();
    let day = new Date(`${m[1] ?? y0}-${p2(m[2])}-${p2(m[3])}T09:00:00+08:00`).getTime();
    if (!m[1] && day < l.at - 200 * 86400000) day = new Date(`${y0 + 1}-${p2(m[2])}-${p2(m[3])}T09:00:00+08:00`).getTime();
    const gap = (day - l.at) / 86400000;
    if (gap < 0.5 || gap > 45 || day > last || seen.has(day)) continue;   // a day still ahead, inside the run
    seen.add(day); M++;
    const due = at(day).open.filter((x) => x.due === ymd(day));
    if (due.length) hasItem++;
    const g = grams(l.text);
    if (due.some((x) => { let n = 0; for (const b of grams(x.text)) if (g.has(b)) n++; return n >= 3; })) match++;
  }
}
console.log(`dated mentions (a day 1–45 days ahead): ${M}; that morning an item is due that day ${hasItem} (${(100 * hasItem / M).toFixed(1)}%); one that shares words with the mention ${match} (${(100 * match / M).toFixed(1)}%)`);
// 3. dones on items whose day had not come
let early = 0; const ex = [];
for (const o of R.ops) for (const op of o.open ?? []) if ((op.action === 'done' || op.action === 'remove') && op.oldText) {
  const hit = (o.before ?? []).find((x) => x.text.includes(op.oldText)); if (!hit?.due) continue;
  if (hit.due > ymd(Date.parse(o.at)) && !(o.errors ?? []).some((e) => e.includes(hit.text.slice(0, 20)))) { early++; if (ex.length < 40) ex.push(`${ymd(Date.parse(o.at))} done → ${hit.text.slice(0, 70)}（到 ${hit.due}）`); }
}
const adds = R.ops.flatMap((o) => (o.open ?? []).filter((x) => x.action === 'add')); const repl = R.ops.flatMap((o) => (o.open ?? []).filter((x) => x.action === 'replace'));
console.log(`ops: add ${adds.length} (with a day ${adds.filter((x) => x.due).length}), replace ${repl.length}, done before its day ${early}`);
if (rest.includes('--early')) console.log(ex.join('\n'));
// 4. the due-day probes
if (rest.includes('--probes')) for (const p of probes.filter((x) => x.k === 0 && ['X4', 'X8'].includes(x.subtype))) {
  const now = Date.parse(p.time); const v = openView(at(now), { limits: DEFAULT_LIMITS, now, ...keep });
  console.log(`\n## ${p.id} ${p.subtype} ${p.time.slice(0, 16)}  target: ${p.target}`);
  console.log(v.today.map((x) => `   today · ${renderItem(x, now)}`).join('\n') || '   today · (none)');
  const tom = v.list.filter((x) => x.due && x.due > ymd(now)).slice(0, 3); if (tom.length) console.log(tom.map((x) => `   next  · ${renderItem(x, now)}`).join('\n'));
}

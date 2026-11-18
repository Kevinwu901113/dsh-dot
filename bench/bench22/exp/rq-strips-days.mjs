// strips -> the days they speak of, by dsh-dot's own when.js (annotate), relative to the turn they come from
import { readFileSync, writeFileSync } from 'node:fs';
process.env.TZ = 'Asia/Shanghai';
const W = await import('../../../src/memory/when.js');
const D = process.env.BENCH22_DATASET ?? '/home/claude/chat-memory-benchmark/benchmark-2.2/dataset';
const jl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const at = new Map(jl(`${D}/histories/M01.jsonl`).map((h) => [h['轮次'], Date.parse(h['逻辑时间'])]));
const out = [];
for (const c of jl('facts_M01.jsonl')) for (const f of c.facts) {
  const ms = at.get(f.t); const a = W.annotate(String(f.text), ms);
  const days = [...a.matchAll(/（=(\d{2})-(\d{2})）/g)].map((m) => { let y = new Date(ms).getFullYear(); let d = new Date(y, Number(m[1]) - 1, Number(m[2])).getTime(); if (d < ms - 200 * 86400000) d = new Date(y + 1, Number(m[1]) - 1, Number(m[2])).getTime(); return d; });
  out.push({ ...f, avail: c.to, at: ms, days });
}
writeFileSync('strips_M01.json', JSON.stringify(out));
console.log(out.length, 'strips;', out.filter((x) => x.days.length).length, 'with a day');

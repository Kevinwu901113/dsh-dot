// The 今天到期的 / 还没了的事 lines each probe turn would be shown from a replay's notes.
//   TZ=Asia/Shanghai node rp-notes.mjs <out.json> <replay M01.json> [<replay M02.json>]
import { readFileSync, writeFileSync } from 'node:fs';
const REPO = process.env.REPO || '/home/claude/dsh-dot';
const { openView, renderItem, DEFAULT_LIMITS } = await import(`${REPO}/src/memory/store.js`);
const { table } = await import(`${REPO}/src/prompts.js`).catch(() => ({}));
const [out, ...files] = process.argv.slice(2);
const probes = JSON.parse(readFileSync('rp/probes.json', 'utf8'));
const head = Object.fromEntries(readFileSync(`${REPO}/src/prompts/memory.standing.txt`, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const res = {};
for (const f of files) {
  const R = JSON.parse(readFileSync(f, 'utf8')); const persona = /22198-1\//.test(R.dir) ? 'M01' : 'M02';
  for (const p of probes.filter((x) => x.persona === persona)) {
    const now = Date.parse(p.time); let s = null; for (const x of R.snaps) { if (x.at <= now) s = x; else break; }
    const v = openView({ open: s?.open ?? [] }, { limits: DEFAULT_LIMITS, now, keepAfterDue: 3, keepIdle: 14 });
    res[`${p.id}#${p.k}`] = { today: v.today.map((x) => `- ${renderItem(x, now)}`), list: v.list.map((x) => `- ${renderItem(x, now)}`), headToday: head.today, headOpen: head.open };
  }
}
writeFileSync(out, JSON.stringify(res)); console.log(out, Object.keys(res).length);

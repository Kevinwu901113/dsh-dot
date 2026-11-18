#!/usr/bin/env python3
"""Judge the natural-board rollouts with the benchmark's own natural.py (judge, claim check, naturalness,
fabrication confirm; its scores and aggregate).  nat_judge.py <rep>  -> natj_<rep>.jsonl and a table."""
import concurrent.futures as cf, json, os, sys, time, urllib.request, collections
sys.path.insert(0, os.environ.get('BENCH22_HARNESS', '/home/claude/chat-memory-benchmark/benchmark-2.2/harness'))
from bench22 import natural
from bench22.release import load_histories
D = os.environ.get('BENCH22_DATASET', '/home/claude/chat-memory-benchmark/benchmark-2.2/dataset'); KEY = os.environ['DEEPSEEK_API_KEY']; rep = sys.argv[1]
jl = lambda p: [json.loads(l) for l in open(p, encoding='utf-8') if l.strip()]
use = collections.Counter()
class GW:
    def chat(self, model, messages, phase, tag, temperature=0, max_tokens=500, thinking=None):
        req = json.dumps({'model': 'deepseek-flash', 'messages': messages, 'temperature': temperature, 'max_tokens': max_tokens, 'thinking': thinking or {'type': 'disabled'}}).encode()
        for a in range(5):
            try: r = json.load(urllib.request.urlopen(urllib.request.Request('https://api.deepseek.com/chat/completions', req, {'content-type': 'application/json', 'authorization': f'Bearer {KEY}'}), timeout=300)); break
            except Exception:
                if a == 4: raise
                time.sleep(5 * (a + 1))
        u = r.get('usage') or {}; use['in'] += u.get('prompt_tokens', 0); use['hit'] += u.get('prompt_cache_hit_tokens', 0); use['out'] += u.get('completion_tokens', 0)
        return r
hist = load_histories(D); probes, key = natural.load_natural(f'{D}/natural', 'dev'); byid = {p['id']: p for p in probes}
idx = {pe: natural.HistoryIndex(hist[pe]) for pe in hist}
rows = [r for P in ('M01', 'M02') for r in jl(f'nat_{P}_{rep}.jsonl')]
out = f'natj_{rep}.jsonl'; done = {(r['id'], r['k'], r['cond']) for r in jl(out)} if os.path.exists(out) else set()
groups = collections.defaultdict(list)
for r in sorted(rows, key=lambda r: (r['cond'], r['id'], r['k'])): groups[r['cond'], r['id']].append(r)
gw = GW()
def one(g):
    (cond, pid), rs = g; res = []
    for n, row in enumerate(rs):
        if (pid, row['k'], cond) in done: continue
        j = natural.judge_turn(gw, byid[pid], key[pid], rs[:n], row, idx[byid[pid]['persona']], f"{pid}#{row['k']}")
        res.append({'id': pid, 'k': row['k'], 'cond': cond, 'judge': j, 'score': natural.turn_score(key[pid], j)})
    return res
with open(out, 'a', encoding='utf-8') as f, cf.ThreadPoolExecutor(8) as ex:
    for res in ex.map(one, groups.items()):
        for r in res: f.write(json.dumps(r, ensure_ascii=False) + '\n'); f.flush()
J = jl(out)
c1 = (use['in'] - use['hit']) / 1e6 * .15 + use['hit'] / 1e6 * .003 + use['out'] / 1e6 * .6
print(f"judged {len(J)} turns | cost ${c1:.2f}–{2 * c1:.2f}")
print(f"{'':4s}{'A_nat':>7s}{'R':>7s}{'P':>7s} | {'X':>6s}{'H':>6s}{'Y':>6s}{'Z':>6s}{'N0':>6s} | {'restraint':>9s}{'fabricated':>11s}{'recall':>8s}{'natural':>8s}")
for c in sorted({r['cond'] for r in J}):
    a, sc = natural.aggregate(probes, key, [r for r in J if r['cond'] == c], n_boot=200)
    bc = a['by_class']; nf = sum(1 for r in J if r['cond'] == c and r['judge'].get('fabrication'))
    print(f"{c:4s}{a['A_nat']:7.1f}{a['R_side']:7.1f}{a['P_side']:7.1f} | " + ''.join(f"{bc.get(k, float('nan')):6.1f}" for k in ('X', 'H', 'Y', 'Z', 'N0')) + f" | {a['restraint_rate']:8.1f}% {a['fabrication_rate']:6.1f}% ({nf}) {a['recall_rate']:6.1f}% {a['naturalness_mean']:7.2f}")

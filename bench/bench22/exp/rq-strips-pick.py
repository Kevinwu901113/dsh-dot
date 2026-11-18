#!/usr/bin/env python3
"""rq-strips-pick.py M01 facts.jsonl out.jsonl : one flash call per question picks, among the strips reachable from his
message (names in it + the closest strips), the ones that bear on it; they become the extra queries."""
import concurrent.futures as cf, json, os, re, sys, urllib.request
D = __import__('os').environ.get('BENCH22_DATASET', '/home/claude/chat-memory-benchmark/benchmark-2.2/dataset')
P, ff, out = sys.argv[1:4]
KEY = os.environ['DEEPSEEK_API_KEY']
jl = lambda p: [json.loads(l) for l in open(p, encoding='utf-8') if l.strip()]
items = [r for r in jl(f'{D}/exam-inputs.jsonl') if r['persona'] == P]
hist = jl(f'{D}/histories/{P}.jsonl')
F = [dict(f, avail=c['to']) for c in jl(ff) for f in c['facts']]
byturn = {}
for f in F: byturn.setdefault(f['t'], []).append(f)
near = json.load(open(f'ks_{P}.json'))  # per question: turns of the closest strips, best first
PRI = {'别碰': 0, '约定': 1, '喜好': 2, '现状': 3}
RULES = """他刚发来一句话。下面是你以前记下的条目（每行开头是编号），都和这句话里提到的人或事沾边。
挑出接他这句话时用得上的：不知道就可能说错话、踩到他说过别碰的事、忘了答应过的事，或者能让回答更贴他的情况的。
最多挑 4 条，只输出编号，用逗号隔开；一条都用不上就输出：无"""
def cands(it):
    q = it['question']; c = it['cutoff_turn']
    named = [f for f in F if f['avail'] <= c and any(isinstance(k, str) and len(k) >= 2 and k in q for k in f['keys'])]
    named.sort(key=lambda f: (PRI.get(f['kind'], 3) > 1, -f['t']))
    seen, outl = set(), []
    for f in named[:45] + [f for t in near.get(it['id'], [])[:25] for f in byturn.get(t, []) if f['avail'] <= c]:
        if id(f) not in seen: seen.add(id(f)); outl.append(f)
    return outl[:60]
def one(it):
    cs = cands(it)
    if not cs: return {'id': it['id'], 'more': [], 'n': 0, 'usage': {}}
    h = hist[max(0, it['cutoff_turn'] - 3):it['cutoff_turn']]
    win = '\n'.join(f"他：{x['用户消息']}" for x in h)
    body = f"{RULES}\n\n【条目】\n" + '\n'.join(f"{i + 1}. [{f['kind']}] {f['text']}" for i, f in enumerate(cs)) + f"\n\n【前几句】\n{win}\n\n【他刚说】{it['question']}"
    req = json.dumps({'model': 'deepseek-flash', 'messages': [{'role': 'user', 'content': body}], 'temperature': 0, 'max_tokens': 40, 'thinking': {'type': 'disabled'}}).encode()
    for a in range(4):
        try: r = json.load(urllib.request.urlopen(urllib.request.Request('https://api.deepseek.com/chat/completions', req, {'content-type': 'application/json', 'authorization': f'Bearer {KEY}'}), timeout=120)); break
        except Exception:
            if a == 3: raise
    ids = [int(x) for x in re.findall(r'\d+', r['choices'][0]['message'].get('content') or '')][:4]
    pick = [cs[i - 1] for i in ids if 1 <= i <= len(cs)]
    return {'id': it['id'], 'more': [f['text'] for f in pick], 't': [f['t'] for f in pick], 'n': len(cs), 'usage': r.get('usage')}
with open(out, 'w', encoding='utf-8') as f, cf.ThreadPoolExecutor(8) as ex:
    for r in ex.map(one, items): f.write(json.dumps(r, ensure_ascii=False) + '\n')
R = jl(out); u = [r['usage'] or {} for r in R]
print(P, 'rows', len(R), 'none', sum(not r['more'] for r in R), 'cands/q', round(sum(r['n'] for r in R) / len(R), 1), 'in', sum(x.get('prompt_tokens', 0) for x in u), 'out', sum(x.get('completion_tokens', 0) for x in u))

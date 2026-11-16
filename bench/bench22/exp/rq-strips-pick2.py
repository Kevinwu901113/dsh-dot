#!/usr/bin/env python3
"""Candidates by the fused heads, then: A one call picks strips; B1 one call picks things (strips merged
at write time); B2 two calls: things first, then strips inside the chosen things."""
import concurrent.futures as cf, json, os, re, urllib.request, collections
import rq_strips_heads as H
KEY = os.environ['DEEPSEEK_API_KEY']
TH = {int(i): g for i, g in json.load(open('things_M01.json')).items()}
hist = H.jl(f'{H.D}/histories/M01.jsonl')
PICK = """他刚发来一句话。下面是你以前记下的{what}（每行开头是编号），都和这句话里提到的人或事沾边。
挑出接他这句话时用得上的：不知道就可能说错话、踩到他说过别碰的事、忘了答应过的事，或者能让回答更贴他的情况的。
最多挑 {n} 条，只输出编号，用逗号隔开；一条都用不上就输出：无"""
use = collections.Counter()
def chat(body, tag):
    req = json.dumps({'model': 'deepseek-flash', 'messages': [{'role': 'user', 'content': body}], 'temperature': 0, 'max_tokens': 40, 'thinking': {'type': 'disabled'}}).encode()
    for a in range(4):
        try: r = json.load(urllib.request.urlopen(urllib.request.Request('https://api.deepseek.com/chat/completions', req, {'content-type': 'application/json', 'authorization': f'Bearer {KEY}'}), timeout=120)); break
        except Exception:
            if a == 3: raise
    u = r.get('usage') or {}; use[tag, 'in'] += u.get('prompt_tokens', 0); use[tag, 'out'] += u.get('completion_tokens', 0); use[tag, 'calls'] += 1
    return [int(x) for x in re.findall(r'\d+', r['choices'][0]['message'].get('content') or '')]
def tail(it):
    h = hist[max(0, it['cutoff_turn'] - 3):it['cutoff_turn']]
    return '\n\n【前几句】\n' + '\n'.join(f"他：{x['用户消息']}" for x in h) + f"\n\n【他刚说】{it['question']}"
pairs = lambda fs: [' '.join(f['text'] for f in fs[j:j + 2]) for j in range(0, len(fs), 2)]
def one(it):
    r, _ = H.ranked(it, expire=False); out = {'id': it['id'], 'v': {}, 't': {}}
    if not r: return out
    out['v']['heads-code9'] = [' '.join(f['text'] for f in r[j:j + 3]) for j in range(0, min(9, len(r)), 3)]; out['t']['heads-code9'] = [f['t'] for f in r[:9]]
    # A: strips
    cs = r[:60]
    ids = chat(PICK.format(what='条目', n=4) + '\n\n【条目】\n' + '\n'.join(f"{i + 1}. [{f['kind']}] {f['text']}" for i, f in enumerate(cs)) + tail(it), 'A')[:4]
    p = [cs[i - 1] for i in ids if 1 <= i <= len(cs)]
    if p: out['v']['heads+pick'] = pairs(p); out['t']['heads+pick'] = [f['t'] for f in p]
    # things, best strip's place first; a thing shows its newest strip
    groups = collections.OrderedDict()
    for f in r: groups.setdefault(TH[f['i']], []).append(f)
    avail = collections.defaultdict(list)
    for f in H.F:
        if f['avail'] <= it['cutoff_turn']: avail[TH[f['i']]].append(f)
    gl = list(groups)[:60]; out['things'] = [[f['t'] for f in avail[g]] for g in gl]
    line = lambda g: f"[{max(avail[g], key=lambda f: f['t'])['kind']}] {max(avail[g], key=lambda f: f['t'])['text']}" + (f"（这件事记过 {len(avail[g])} 次）" if len(avail[g]) > 1 else '')
    body = '\n\n【记着的事】\n' + '\n'.join(f"{i + 1}. {line(g)}" for i, g in enumerate(gl)) + tail(it)
    ids = chat(PICK.format(what='事', n=3) + body, 'B1')[:3]
    p = []
    for i in ids:
        if 1 <= i <= len(gl):
            g = gl[i - 1]; best, new = groups[g][0], max(avail[g], key=lambda f: f['t']); p.append([best] if best is new else [best, new])
    if p: out['v']['things+pick'] = [' '.join(f['text'] for f in fs) for fs in p]; out['t']['things+pick'] = [f['t'] for fs in p for f in fs]
    # B2: round one on things (up to 5), round two on every strip of the chosen things
    ids = chat(PICK.format(what='事', n=5) + body, 'B2a')[:5]
    cs2 = [f for i in ids if 1 <= i <= len(gl) for f in sorted(avail[gl[i - 1]], key=lambda f: f['t'])][:40]
    if cs2:
        ids = chat(PICK.format(what='条目', n=4) + '\n\n【条目】\n' + '\n'.join(f"{i + 1}. [{f['kind']}] {f['text']}" for i, f in enumerate(cs2)) + tail(it), 'B2b')[:4]
        p = [cs2[i - 1] for i in ids if 1 <= i <= len(cs2)]
        if p: out['v']['two-rounds'] = pairs(p); out['t']['two-rounds'] = [f['t'] for f in p]
    return out
with cf.ThreadPoolExecutor(8) as ex: R = list(ex.map(one, H.items))
R = {r['id']: r for r in R}
with open('v_k3_M01.jsonl', 'w', encoding='utf-8') as o:
    for i, r in R.items(): o.write(json.dumps({'id': i, 'variants': {n: {'more': m} for n, m in r['v'].items()}}, ensure_ascii=False) + '\n')
M = list(H.misses()); print('base-miss', len(M))
print('  the right strip\'s thing within the first N things:', {N: sum(any(any(t in m for t in g) for g in R[it['id']].get('things', [])[:N]) for it, m in M) for N in (10, 20, 40, 60)})
for v in ('heads-code9', 'heads+pick', 'things+pick', 'two-rounds'): print(f'  {v}: picked a strip from a missing turn:', sum(any(t in m for t in R[it['id']]['t'].get(v, [])) for it, m in M))
for tag in ('A', 'B1', 'B2a', 'B2b'): print(' ', tag, 'calls', use[tag, 'calls'], 'in', use[tag, 'in'], 'out', use[tag, 'out'], 'usd', round(use[tag, 'in'] / 1e6 * .18 + use[tag, 'out'] / 1e6 * .72, 3))

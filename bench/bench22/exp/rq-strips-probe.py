#!/usr/bin/env python3
"""Two probes on the 124 questions the plain retrieval misses (M01):
1. the same 60 candidates, the same instructions: how often does a stronger model pick a strip from a missing turn?
2. how large is a named person's guarded card (别碰 + 约定), and is the needed strip on it?"""
import concurrent.futures as cf, json, os, re, sys, urllib.request, collections
import rq_strips_heads as H, rq_strips_heads2 as H2
KEY = os.environ['DEEPSEEK_API_KEY']
hist = H.jl(f'{H.D}/histories/M01.jsonl'); TH = H2.TH
PICK = """他刚发来一句话。下面是你以前记下的条目（每行开头是编号），都和这句话里提到的人或事沾边。
挑出接他这句话时用得上的：不知道就可能说错话、踩到他说过别碰的事、忘了答应过的事，或者能让回答更贴他的情况的。
最多挑 4 条，只输出编号，用逗号隔开；一条都用不上就输出：无"""
M = list(H.misses())
C = {it['id']: H2.ranked(it)[0][:60] for it, _ in M}
use = collections.Counter()
def ask(it, model, thinking):
    cs = C[it['id']]; h = hist[max(0, it['cutoff_turn'] - 3):it['cutoff_turn']]
    body = PICK + '\n\n【条目】\n' + '\n'.join(f"{i + 1}. [{f['kind']}] {f['text']}" for i, f in enumerate(cs)) + '\n\n【前几句】\n' + '\n'.join(f"他：{x['用户消息']}" for x in h) + f"\n\n【他刚说】{it['question']}"
    req = {'model': model, 'messages': [{'role': 'user', 'content': body}], 'max_tokens': 4000 if thinking else 40, 'thinking': {'type': 'enabled' if thinking else 'disabled'}}
    if not thinking: req['temperature'] = 0
    for a in range(4):
        try: r = json.load(urllib.request.urlopen(urllib.request.Request('https://api.deepseek.com/chat/completions', json.dumps(req).encode(), {'content-type': 'application/json', 'authorization': f'Bearer {KEY}'}), timeout=300)); break
        except Exception as e:
            if a == 3: return []
    u = r.get('usage') or {}; tag = f"{model}{'+think' if thinking else ''}"; use[tag, 'in'] += u.get('prompt_tokens', 0); use[tag, 'out'] += u.get('completion_tokens', 0)
    ids = [int(x) for x in re.findall(r'\d+', r['choices'][0]['message'].get('content') or '')][:4]
    return [cs[i - 1] for i in ids if 1 <= i <= len(cs)]
inC = [(it, m) for it, m in M if any(f['t'] in m for f in C[it['id']])]
print('base-miss', len(M), '| the needed strip is among the 60 shown:', len(inC))
for model, th in [('deepseek-flash', False), ('deepseek-flash', True), ('deepseek-v4-pro', False), ('deepseek-v4-pro', True)]:
    with cf.ThreadPoolExecutor(8) as ex: P = list(ex.map(lambda x: ask(x[0], model, th), inC))
    strict = sum(any(f['t'] in m for f in p) for p, (it, m) in zip(P, inC))
    thing = sum(any(TH[f['i']] in {TH[g['i']] for g in C[it['id']] if g['t'] in m} for f in p) for p, (it, m) in zip(P, inC))
    tag = f"{model}{'+think' if th else ''}"
    print(f'  {tag:24s} picked the needed strip: {strict}/{len(inC)}  | picked a strip of the same thing: {thing}/{len(inC)}  | in {use[tag, "in"]} out {use[tag, "out"]}', flush=True)
    json.dump([[f['i'] for f in p] for p in P], open(f'probe_{tag}.json', 'w'))
# 2. the guarded card of the names in his message
G = ('别碰', '约定'); sizes = []; on = 0; onall = 0; sizes_all = []
for it, m in M:
    q = it['question']; named = [f for f in H.F if f['avail'] <= it['cutoff_turn'] and any(k in q for k in f['keys'])]
    g = [f for f in named if f['kind'] in G]; things = {TH[f['i']] for f in g}
    sizes.append(len(things)); sizes_all.append(len({TH[f['i']] for f in named}))
    on += any(f['t'] in m for f in g); onall += any(f['t'] in m for f in named)
s = sorted(sizes); sa = sorted(sizes_all)
print(f'guarded card (别碰+约定 of the names in his message): needed strip on it {on}/{len(M)}; things on the card: median {s[len(s)//2]}, 75% {s[len(s)*3//4]}, max {s[-1]}')
print(f'whole card (all four kinds): needed strip on it {onall}/{len(M)}; things: median {sa[len(sa)//2]}, 75% {sa[len(sa)*3//4]}, max {sa[-1]}')

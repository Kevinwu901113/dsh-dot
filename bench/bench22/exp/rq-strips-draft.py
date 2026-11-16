#!/usr/bin/env python3
"""Draft as the query: flash writes, without any memory, the short reply it would give; the draft is then what
looks the strips up (and, in one variant, the turns directly)."""
import concurrent.futures as cf, json, os, urllib.request, collections, numpy as np
import rq_strips_heads as H, rq_strips_heads2 as H2
KEY = os.environ['DEEPSEEK_API_KEY']
hist = H.jl(f'{H.D}/histories/M01.jsonl')
RULES = "你是他的聊天伙伴。下面是前几句和他刚说的话。先不查任何以前的记录，照常理写出你会怎么回他，60 个字以内，只输出这句回话。"
use = collections.Counter()
def one(it):
    h = hist[max(0, it['cutoff_turn'] - 3):it['cutoff_turn']]
    body = RULES + '\n\n' + '\n'.join(f"他：{x['用户消息']}\n你：{x['助手回复']}" for x in h) + f"\n他：{it['question']}"
    req = json.dumps({'model': 'deepseek-flash', 'messages': [{'role': 'user', 'content': body}], 'temperature': 0, 'max_tokens': 120, 'thinking': {'type': 'disabled'}}).encode()
    for a in range(4):
        try: r = json.load(urllib.request.urlopen(urllib.request.Request('https://api.deepseek.com/chat/completions', req, {'content-type': 'application/json', 'authorization': f'Bearer {KEY}'}), timeout=120)); break
        except Exception:
            if a == 3: raise
    u = r.get('usage') or {}; use['in'] += u.get('prompt_tokens', 0); use['out'] += u.get('completion_tokens', 0)
    return (r['choices'][0]['message'].get('content') or '').strip()
if os.path.exists('drafts_M01.json'): DR = json.load(open('drafts_M01.json'))
else:
    with cf.ThreadPoolExecutor(8) as ex: DR = dict(zip([it['id'] for it in H.items], ex.map(one, H.items)))
    json.dump(DR, open('drafts_M01.json', 'w'), ensure_ascii=False); print('drafts: in', use['in'], 'out', use['out'], 'usd', round(use['in'] / 1e6 * .18 + use['out'] / 1e6 * .72, 3))
print(list(DR.items())[3])
DV = H.emb([DR[it['id']] for it in H.items], 'query', 'drafts')
tri = lambda fs: [' '.join(f['text'] for f in fs[j:j + 3]) for j in range(0, len(fs), 3)]
M = list(H.misses()); hit = collections.Counter(); rows = {}
qq, qv = H2.QQ.copy(), H.QV.copy()
for it in H.items:
    a = H2.ranked(it, w={'trig': 3})[0]                      # by his words
    n = H.QI[it['id']]; H2.QQ[n], H.QV[n] = DV[n], DV[n]     # the same scorers, reading the draft instead
    b = H2.ranked(dict(it, question=it['question'] + ' ' + DR[it['id']]), w={'trig': 3})[0]
    H2.QQ[n], H.QV[n] = qq[n], qv[n]
    sc = collections.Counter()
    for l in (a, b):
        for k, f in enumerate(l[:100]): sc[f['i']] += 1 / (60 + k + 1)
    both = [H.F[i] for i, _ in sc.most_common()]
    rows[it['id']] = {'draft-q': {'more': [DR[it['id']]]} if DR[it['id']] else None, 'draft-strips9': {'more': tri(b[:9])} if b else None, 'both-strips9': {'more': tri(both[:9])} if both else None, '_': ([f['t'] for f in a], [f['t'] for f in b], [f['t'] for f in both])}
for it, m in M:
    for name, ts in zip(('his words', 'draft', 'both'), rows[it['id']]['_']):
        for N in (5, 10, 20, 60): hit[name, N] += any(t in m for t in ts[:N])
print('base-miss', len(M), '— a strip from a missing turn within the first N')
for name in ('his words', 'draft', 'both'): print(f'  {name:10s}', '  '.join(f'{N}: {hit[name, N]:3d}' for N in (5, 10, 20, 60)))
with open('v_k5_M01.jsonl', 'w', encoding='utf-8') as o:
    for i, r in rows.items(): o.write(json.dumps({'id': i, 'variants': {k: v for k, v in r.items() if k != '_' and v}}, ensure_ascii=False) + '\n')

#!/usr/bin/env python3
"""rq-strips-near.py M01 facts.jsonl : strips as an index of their own. Rank strips against his message (BM25 on characters
and pairs, e5 cosine, fused by rank); the value of a strip is its turn. Where does a missing evidence turn rank?"""
import json, math, sys, collections, urllib.request, numpy as np
D = __import__('os').environ.get('BENCH22_DATASET', '/home/claude/chat-memory-benchmark/benchmark-2.2/dataset')
P, ff = sys.argv[1:3]
jl = lambda p: [json.loads(l) for l in open(p, encoding='utf-8') if l.strip()]
key = {r['id']: r for r in jl(f'{D}/review-only/answer-key.jsonl')}
items = [r for r in jl(f'{D}/exam-inputs.jsonl') if r['persona'] == P]
base = {r['id']: r for r in jl(f'base_{P}.jsonl')}  # an rq-run.py output with the plain run, in the working directory
F = [dict(f, avail=c['to']) for c in jl(ff) for f in c['facts']]
def emb(texts, role):
    out = []
    for i in range(0, len(texts), 64):
        r = json.load(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18890/embeddings', json.dumps({'model': 'Xenova/multilingual-e5-small', 'input': [f'{role}: {t}' for t in texts[i:i+64]]}).encode(), {'content-type': 'application/json'}), timeout=600))
        out += [d['embedding'] for d in sorted(r['data'], key=lambda d: d['index'])]
    return np.array(out, dtype=np.float32)
stext = [' '.join(k for k in f['keys'] if isinstance(k, str)) + ' ' + f['text'] for f in F]
SV = emb(stext, 'passage'); QV = emb([it['question'] for it in items], 'query')
tok = lambda s: [c for c in s if c.strip() and c not in '，。！？、：；（）()…~"“”'] + [s[i:i+2] for i in range(len(s) - 1) if s[i:i+2].strip() == s[i:i+2]]
ST = [collections.Counter(tok(s)) for s in stext]; SL = np.array([sum(c.values()) for c in ST])
avail = np.array([f['avail'] for f in F]); turn = np.array([f['t'] for f in F]); guarded = np.array([f['kind'] in ('别碰', '约定') for f in F])
def bm25(q, mask):
    idx = np.where(mask)[0]; n = len(idx); avg = SL[idx].mean() if n else 1; sc = np.zeros(len(F))
    for w in set(tok(q)):
        df = sum(1 for i in idx if w in ST[i])
        if not df: continue
        idf = math.log(1 + (n - df + .5) / (df + .5))
        for i in idx:
            tf = ST[i].get(w, 0)
            if tf: sc[i] += idf * tf * 2.2 / (tf + 1.2 * (.25 + .75 * SL[i] / avg))
    return sc
KS = (5, 10, 20, 30); hit = collections.Counter(); n = 0; rows = {}
for qi, it in enumerate(items):
    k = key[it['id']]; mask = avail <= it['cutoff_turn']
    if not mask.any(): rows[it['id']] = []; continue
    b = bm25(it['question'], mask); c = SV @ QV[qi]; c[~mask] = -9; b[~mask] = -9
    rb = np.argsort(-b); rc = np.argsort(-c); rrf = np.zeros(len(F))
    for r in (rb, rc): rrf[r[:200]] += 1 / (60 + np.arange(1, 201))
    rrf[~mask] = -9
    order = {'bm25': rb, 'cos': rc, 'fused': np.argsort(-rrf), 'fused+guard': np.argsort(-(rrf + 0.004 * guarded * (rrf > 0)))}
    turns = {name: list(dict.fromkeys(int(turn[i]) for i in o[:60])) for name, o in order.items()}  # distinct turns, best first
    rows[it['id']] = turns['fused']
    ev = k['evidence_turns']
    if not ev or k['probe_type'] == 'due_day' or it['id'] not in base: continue
    miss = [t for t in ev if t not in set(base[it['id']]['v']['base']['used'])]
    if not miss: continue
    n += 1
    for name, ts in turns.items():
        for K in KS: hit[name, K] += all(t in ts[:K] for t in miss)
json.dump(rows, open(f'ks_{P}.json', 'w'))
print(P, 'base-miss questions (not due):', n, '— every missing evidence turn is among the turns of the top K strips:')
for name in ('bm25', 'cos', 'fused', 'fused+guard'): print(f'  {name:12s}', '  '.join(f'top{K}: {100 * hit[name, K] / n:4.0f}%' for K in KS))

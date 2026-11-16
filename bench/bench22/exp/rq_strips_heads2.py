#!/usr/bin/env python3
"""heads.py + three more scorers: trig (his message against each strip's write-time triggers, e5 max-cosine and
BM25 fused), spread (two steps over the strip-key graph from the names in his message, each key's weight
divided by how many strips it hangs on), and one strip per thing."""
import json, math, collections, numpy as np
import rq_strips_heads as H
F = H.F; T = json.load(open('trig_M01.json')); TH = {int(i): g for i, g in json.load(open('things_M01.json')).items()}
flat = [(i, t) for i, ts in enumerate(T) for t in ts]
TV = H.emb([t for _, t in flat], 'query', 'trig'); QQ = H.emb([it['question'] for it in H.items], 'query', 'q')
own = np.array([i for i, _ in flat])
ttext = [' '.join(ts) for ts in T]
TT = [collections.Counter(H.tok(s)) for s in ttext]; TL = np.array([max(1, sum(c.values())) for c in TT])
bykey = collections.defaultdict(list)
for f in F:
    for k in f['keys']: bykey[k].append(f['i'])
def trig_scores(it):
    c = TV @ QQ[H.QI[it['id']]]; best = np.full(len(F), -1.0); np.maximum.at(best, own, c); return best
def trig_list(it, pool_idx, n=100):
    best = trig_scores(it); ps = set(pool_idx)
    rc = [i for i in np.argsort(-best) if i in ps][:n]
    q = it['question']; idx = list(pool_idx); avg = TL[idx].mean(); sc = {}
    for w in set(H.tok(q)):
        hit = [i for i in idx if w in TT[i]]
        if not hit: continue
        idf = math.log(1 + (len(idx) - len(hit) + .5) / (len(hit) + .5))
        for i in hit: tf = TT[i][w]; sc[i] = sc.get(i, 0) + idf * tf * 2.2 / (tf + 1.2 * (.25 + .75 * TL[i] / avg))
    rb = sorted(sc, key=lambda i: -sc[i])[:n]
    tp = collections.Counter()
    for r in (rc, rb):
        for k, i in enumerate(r): tp[i] += 1 / (60 + k + 1)
    return [i for i, _ in tp.most_common(n)], best
def spread_list(it, pool_idx, n=100):
    q = it['question']; ps = set(pool_idx); a = collections.Counter()
    seeds = [k for k in bykey if k in q]
    for k in seeds:
        for i in bykey[k]:
            if i not in ps: continue
            for k2 in F[i]['keys']:
                if k2 in seeds: continue
                w = 1 / len(bykey[k]) / math.sqrt(len(bykey[k2]))
                for j in bykey[k2]:
                    if j in ps and j != i: a[j] += w
    return [i for i, _ in a.most_common(n)]
def ranked(it, heads=('name', 'time', 'topic', 'guard', 'new', 'trig'), per_thing=False, only=None, w=None):
    r, L = H.ranked(it, expire=False)
    if not r: return [], {}
    pool = [f['i'] for f in F if f['avail'] <= it['cutoff_turn'] and (only is None or f['kind'] in only)]
    L['trig'], best = trig_list(it, pool); L['spread'] = spread_list(it, pool)
    sc = collections.Counter(); ps = set(pool)
    for h in heads:
        for n, i in enumerate([i for i in L[h] if i in ps][:100]): sc[i] += (w or {}).get(h, 1) / (60 + n + 1)
    out = [F[i] for i, _ in sc.most_common()]
    if per_thing:
        seen = set(); o2 = []
        for f in out:
            if TH[f['i']] not in seen: seen.add(TH[f['i']]); o2.append(f)
        out = o2
    return out, {'best': best, **L}
if __name__ == '__main__':
    M = list(H.misses()); print('base-miss', len(M), '— a strip from a missing turn within the first N')
    G = ('别碰', '约定')
    for label, kw in [('five heads (before)', dict(heads=('name', 'time', 'topic', 'guard', 'new'))), ('trig only', dict(heads=('trig',))), ('trig only, guarded kinds', dict(heads=('trig',), only=G)), ('name + trig', dict(heads=('name', 'trig'))), ('five + trig', dict()), ('five + trig×3', dict(w={'trig': 3})), ('five + trig, one per thing', dict(per_thing=True)), ('spread only', dict(heads=('spread',))), ('five + trig + spread', dict(heads=('name', 'time', 'topic', 'guard', 'new', 'trig', 'spread')))]:
        hit = collections.Counter()
        for it, m in M:
            ts = [f['t'] for f in ranked(it, **kw)[0]]
            for N in (3, 5, 10, 20, 40, 60): hit[N] += any(t in m for t in ts[:N])
        print(f'  {label:28s}', '  '.join(f'{N}: {hit[N]:3d}' for N in (3, 5, 10, 20, 40, 60)))

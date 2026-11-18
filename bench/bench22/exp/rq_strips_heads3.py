#!/usr/bin/env python3
"""A fourth scorer for the strips: where the strip's own turn stands when his message is looked up in the
turns themselves (the recall index: e5 cosine + BM25 on each turn's text). The turn is a key of its strips."""
import json, math, os, collections, numpy as np
import rq_strips_heads as H, rq_strips_heads2 as H2
P = H.P
d = [x for x in (f'/tmp/rq-homes/r16_{P}', f'/tmp/rq-homes/a_{P}') if os.path.exists(x)][0] + '/dot/memory/recall/local-Xenova_multilingual-e5-small'
meta = [json.loads(l) for l in open(f'{d}/meta.jsonl', encoding='utf-8') if l.strip()]
VT = np.fromfile(f'{d}/vectors.f32', dtype=np.float32).reshape(-1, 384)[:len(meta)]
hist = H.jl(f'{H.D}/histories/{P}.jsonl')
import datetime
tms = {int(datetime.datetime.fromisoformat(h['逻辑时间']).timestamp() * 1000): h['轮次'] for h in hist}
keys = sorted(tms)
import bisect
def turn_of(at):
    if at in tms: return tms[at]
    i = bisect.bisect_left(keys, at); c = [k for k in keys[max(0, i - 1):i + 1]]; return tms[min(c, key=lambda k: abs(k - at))]
TT = np.array([turn_of(m['at']) for m in meta])
TOK = [collections.Counter(H.tok(m['text'][:1200])) for m in meta]; TL = np.array([max(1, sum(c.values())) for c in TOK])
inv = collections.defaultdict(list)
for i, c in enumerate(TOK):
    for w in c: inv[w].append(i)
by_turn = collections.defaultdict(list)
for f in H.F: by_turn[f['t']].append(f['i'])
def turn_rank(it, n=300):
    q = it['question']; lim = it['cutoff_turn'] - 6; ok = TT <= lim
    cs = VT @ H.QV[H.QI[it['id']]]; cs[~ok] = -9; rc = np.argsort(-cs)[:n]
    N = int(ok.sum()); avg = TL[ok].mean() if N else 1; sc = collections.Counter()
    for w in set(H.tok(q)):
        hit = [i for i in inv.get(w, []) if ok[i]]
        if not hit: continue
        idf = math.log(1 + (N - len(hit) + .5) / (len(hit) + .5))
        for i in hit: tf = TOK[i][w]; sc[i] += idf * tf * 2.2 / (tf + 1.2 * (.25 + .75 * TL[i] / avg))
    rb = [i for i, _ in sc.most_common(n)]
    tp = collections.Counter()
    for r in (rc, rb):
        for k, i in enumerate(r): tp[int(TT[i])] += 1 / (60 + k + 1)
    return [t for t, _ in tp.most_common(n)]
def ranked(it, heads=('time', 'topic', 'trig', 'turn'), w=None):
    r, L = H2.ranked(it, heads=('time', 'topic', 'trig'))
    if not r: return []
    c = it['cutoff_turn']; L['turn'] = [i for t in turn_rank(it) for i in by_turn.get(t, []) if H.F[i]['avail'] <= c]
    sc = collections.Counter()
    for h in heads:
        for n, i in enumerate(L[h][:100]): sc[i] += (w or {}).get(h, 1) / (60 + n + 1)
    return [H.F[i] for i, _ in sc.most_common()]
if __name__ == '__main__':
    pk = {'M01': 'w2c5', 'M02': 'm2c5'}[P]; ids = {r['id'] for r in json.load(open(f'picks_{pk}.json'))}
    S = [it for it in H.items if it['id'] in ids]
    print(P, 'index turns', len(meta), '| of 120: every evidence turn has a strip among the first N / at least one')
    for label, kw in [('time+topic+trig (now)', dict(heads=('time', 'topic', 'trig'))), ('+ turn', dict()), ('+ turn ×2', dict(w={'turn': 2})), ('turn only', dict(heads=('turn',))), ('time + turn', dict(heads=('time', 'turn')))]:
        out = []
        for N in (60, 120):
            a = b = 0
            for it in S:
                ev = set(H.key[it['id']]['evidence_turns']); got = {f['t'] for f in ranked(it, **kw)[:N]} & ev; a += got == ev; b += bool(got)
            out.append(f'N={N}: {a:3d} / {b:3d}')
        print(f'  {label:24s}', '   '.join(out))

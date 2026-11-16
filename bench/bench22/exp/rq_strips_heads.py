#!/usr/bin/env python3
"""Several weak scorers ("heads") over the strips, fused by rank: names in his message, the day a strip
speaks of against now, closeness to his words (BM25 + e5), guarded kinds, newest. lib for the pick scripts."""
import json, math, os, collections, urllib.request, numpy as np
D = os.environ.get('BENCH22_DATASET', '/home/claude/chat-memory-benchmark/benchmark-2.2/dataset')
jl = lambda p: [json.loads(l) for l in open(p, encoding='utf-8') if l.strip()]
key = {r['id']: r for r in jl(f'{D}/review-only/answer-key.jsonl')}
items = [r for r in jl(f'{D}/exam-inputs.jsonl') if r['persona'] == 'M01']
base = {r['id']: r for r in jl('base_M01.jsonl')}
F = json.load(open('strips_M01.json'))
for i, f in enumerate(F): f['i'] = i; f['keys'] = [k for k in f['keys'] if isinstance(k, str) and len(k) >= 2]
DAY = 86400000
def emb(texts, role, tag):
    p = f'emb_{tag}.npy'
    if os.path.exists(p): return np.load(p)
    out = []
    for i in range(0, len(texts), 64):
        r = json.load(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18890/embeddings', json.dumps({'model': 'Xenova/multilingual-e5-small', 'input': [f'{role}: {t}' for t in texts[i:i+64]]}).encode(), {'content-type': 'application/json'}), timeout=600))
        out += [d['embedding'] for d in sorted(r['data'], key=lambda d: d['index'])]
    a = np.array(out, dtype=np.float32); np.save(p, a); return a
stext = [' '.join(f['keys']) + ' ' + f['text'] for f in F]
SV = emb(stext, 'passage', 'strips'); QV = emb([it['question'] for it in items], 'query', 'q')
QI = {it['id']: n for n, it in enumerate(items)}
tok = lambda s: [c for c in s if c.strip() and c not in '，。！？、：；（）()…~"“”'] + [s[i:i+2] for i in range(len(s) - 1) if s[i:i+2].strip() == s[i:i+2]]
ST = [collections.Counter(tok(s)) for s in stext]; SL = np.array([sum(c.values()) for c in ST])
def bm25(q, idx):
    n = len(idx); avg = SL[idx].mean(); sc = {}
    for w in set(tok(q)):
        hit = [i for i in idx if w in ST[i]]
        if not hit: continue
        idf = math.log(1 + (n - len(hit) + .5) / (len(hit) + .5))
        for i in hit: tf = ST[i][w]; sc[i] = sc.get(i, 0) + idf * tf * 2.2 / (tf + 1.2 * (.25 + .75 * SL[i] / avg))
    return sc
def now_ms(it):
    import datetime; return int(datetime.datetime.fromisoformat(it['now']).timestamp() * 1000)
def ranked(it, heads=('name', 'time', 'topic', 'guard', 'new'), expire=True):
    """strips available at the question's cutoff, best first by the fused heads; also the per-head lists"""
    q, c, now = it['question'], it['cutoff_turn'], now_ms(it)
    pool = [f for f in F if f['avail'] <= c]
    if expire: pool = [f for f in pool if not (f['kind'] == '约定' and f['days'] and max(f['days']) < now - 3 * DAY)]
    if not pool: return [], {}
    idx = [f['i'] for f in pool]
    nm = {f['i']: sum(k in q for k in f['keys']) for f in pool}; named = [f for f in pool if nm[f['i']]]
    L = {}
    L['name'] = [f['i'] for f in sorted(named, key=lambda f: (-nm[f['i']], -f['t']))]
    L['new'] = [f['i'] for f in sorted(named, key=lambda f: -f['t'])]
    L['guard'] = [f['i'] for f in sorted([f for f in named if f['kind'] in ('别碰', '约定')], key=lambda f: -f['t'])]
    near = [(min(abs(d - now) for d in f['days'] if d >= now - 3 * DAY), f) for f in pool if any(now - 3 * DAY <= d <= now + 14 * DAY for d in f['days'])]
    L['time'] = [f['i'] for _, f in sorted(near, key=lambda x: (x[0], -bool(nm[x[1]['i']])))]
    b = bm25(q, idx); cs = SV[idx] @ QV[QI[it['id']]]
    rb = sorted(b, key=lambda i: -b[i])[:100]; rc = [idx[j] for j in np.argsort(-cs)[:100]]
    tp = collections.Counter()
    for r in (rb, rc):
        for n, i in enumerate(r): tp[i] += 1 / (60 + n + 1)
    L['topic'] = [i for i, _ in tp.most_common(100)]
    sc = collections.Counter()
    for h in heads:
        for n, i in enumerate(L[h][:100]): sc[i] += 1 / (60 + n + 1)
    return [F[i] for i, _ in sc.most_common()], L
def misses():
    for it in items:
        k = key[it['id']]; ev = k['evidence_turns']
        if it['id'] not in base or not ev or k['probe_type'] == 'due_day': continue
        m = [t for t in ev if t not in set(base[it['id']]['v']['base']['used'])]
        if m: yield it, m
if __name__ == '__main__':
    M = list(misses()); print('base-miss questions (not due):', len(M), '— a strip from a missing turn is within the first N')
    for label, heads in [('name only (newest first)', ('name',)), ('name + guard', ('name', 'guard')), ('name + time', ('name', 'time')), ('name + topic', ('name', 'topic')), ('all five heads', ('name', 'time', 'topic', 'guard', 'new')), ('all, no expiry', None)]:
        hit = collections.Counter(); sizes = []
        for it, m in M:
            r, _ = ranked(it, heads or ('name', 'time', 'topic', 'guard', 'new'), expire=heads is not None); ts = [f['t'] for f in r]; sizes.append(len(r))
            for N in (5, 10, 20, 40, 60): hit[N] += any(t in m for t in ts[:N])
        print(f'  {label:26s}', '  '.join(f'{N}: {hit[N]:3d}' for N in (5, 10, 20, 40, 60)), ' | ranked per q', round(sum(sizes) / len(sizes)))

#!/usr/bin/env python3
"""Round 0 (no model): which scorers does the short list need? The needed strip (from a missing evidence turn)
within the first N, on the 124 questions plain retrieval misses."""
import collections, rq_strips_heads as H, rq_strips_heads2 as H2
M = list(H.misses()); ALL = ('name', 'time', 'topic', 'guard', 'new', 'trig')
rows = [('all six', ALL)] + [(f'without {h}', tuple(x for x in ALL if x != h)) for h in ALL] + [('name + topic + trig', ('name', 'topic', 'trig')), ('name + trig', ('name', 'trig')), ('topic + trig', ('topic', 'trig')), ('name + topic', ('name', 'topic'))]
print('needed strip within the first N (of 124):')
for label, heads in rows:
    hit = collections.Counter()
    for it, m in M:
        ts = [f['t'] for f in H2.ranked(it, heads=heads)[0]]
        for N in (40, 60, 120, 200): hit[N] += any(t in m for t in ts[:N])
    print(f'  {label:22s}', '  '.join(f'{N}: {hit[N]:3d}' for N in (40, 60, 120, 200)))

#!/usr/bin/env python3
"""The ceiling with a capped list and no thinking: among the N strips shown, a perfect picker takes the ones that
come from the question's evidence turns (best-ranked first, three of them, each a query). RQ_P / RQ_SFX as usual."""
import json, random, sys, rq_strips_heads as H, rq_strips_heads2 as H2
P = H.P; pk = {'M01': 'w2c5', 'M02': 'm2c5'}[P]
ids = {r['id'] for r in json.load(open(f'picks_{pk}.json'))}; real = {r['id']: r['picks'] for r in json.load(open(f'picks_{pk}.json'))}
st = {}
with open(f'v_ceil_{P}.jsonl', 'w', encoding='utf-8') as o:
    for it in H.items:
        if it['id'] not in ids: continue
        ev = set(H.key[it['id']]['evidence_turns']); r = H2.ranked(it, heads=('time', 'topic', 'trig'))[0]; v = {}
        for N in (60, 120):
            good = [f for f in r[:N] if f['t'] in ev]
            seen, pick = set(), []
            for f in good:                       # one strip per evidence turn first, so three queries reach three turns
                if f['t'] not in seen: seen.add(f['t']); pick.append(f)
            if pick: v[f'perfect{N}'] = {'more': [f['text'] for f in pick[:3]]}
            st.setdefault(N, []).append((len(ev), len({f['t'] for f in good})))
        if real[it['id']]: v['flash60'] = {'more': [H.F[x]['text'] for x in real[it['id']][:3]]}
        o.write(json.dumps({'id': it['id'], 'variants': v}, ensure_ascii=False) + '\n')
for N, xs in st.items(): print(P, f'N={N}: questions whose every evidence turn has a strip among those shown: {sum(a == b for a, b in xs)}/{len(xs)}; at least one: {sum(b > 0 for a, b in xs)}')

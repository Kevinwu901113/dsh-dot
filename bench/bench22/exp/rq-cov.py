#!/usr/bin/env python3
"""rq-cov.py out1.jsonl [out2.jsonl ...]: of the turns a question's answer rests on (the key's evidence_turns),
how many reached the prompt (recall + the last 6 turns), per query variant of rq-run.py and per question kind.
Columns: questions with every evidence turn in the prompt % / evidence turns in % / those outside the window in %."""
import json, os, sys, collections
D = os.environ.get('BENCH22_DATASET', '/home/claude/chat-memory-benchmark/benchmark-2.2/dataset')
jl = lambda p: [json.loads(l) for l in open(p, encoding='utf-8') if l.strip()]
key = {r['id']: r for r in jl(f'{D}/review-only/answer-key.jsonl')}
rows = [r for p in sys.argv[1:] for r in jl(p)]
names = list(collections.OrderedDict((n, 1) for r in rows for n in r['v']))
G = {'due': {'due_day'}, 'implicit': {'implicit'}, 'premise': {'premise_twin'}}
def stat(sel, name):
    full = turns = tot = out_in = out_tot = chars = n = 0
    for r in rows:
        k = key[r['id']]; ev = k['evidence_turns']
        if not ev or name not in r['v'] or not sel(k): continue
        v = r['v'][name]; used = set(v['used']); win = set(range(r['cutoff'] - 5, r['cutoff'] + 1))
        n += 1; full += all(t in used for t in ev); turns += sum(t in used for t in ev); tot += len(ev)
        o = [t for t in ev if t not in win]; out_tot += len(o); out_in += sum(t in used for t in o); chars += v['chars']
    return n, (100 * full / n if n else 0), (100 * turns / tot if tot else 0), (100 * out_in / out_tot if out_tot else 0), (chars / n if n else 0)
for p in ('M01', 'M02'):
    print(f'== {p}   题全证据进提示词% / 证据轮进% / 窗口外证据轮进% / 召回字数')
    for name in names:
        line = f'{name:14s}'
        for label, sel in [('all', lambda k: True)] + [(g, (lambda s: lambda k: k['probe_type'] in s)(s)) for g, s in G.items()] + [('other', lambda k: k['probe_type'] not in {'due_day', 'implicit', 'premise_twin'})]:
            n, a, b, c, ch = stat(lambda k, sel=sel: k['persona'] == p and sel(k), name)
            line += f' | {label} n={n:3d} {a:5.1f} {b:5.1f} {c:5.1f}' + (f' {ch:5.0f}' if label == 'all' else '')
        print(line)

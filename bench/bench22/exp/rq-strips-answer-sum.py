import json, sys, collections
import os
D=os.environ.get('BENCH22_DATASET', '/home/claude/chat-memory-benchmark/benchmark-2.2/dataset')
jl=lambda p:[json.loads(l) for l in open(p) if l.strip()]
key={r['id']:r for r in jl(f'{D}/review-only/answer-key.jsonl')}
reps=sys.argv[1:]
R=collections.defaultdict(lambda: collections.defaultdict(list))
for rep in reps:
    for r in jl(f'aj_{rep}.jsonl'): R[r['id']][r['c']].append(r['pass'])
ids=[i for i in R if all(len(R[i][c])==len(reps) for c in 'ABCD')]
def line(label, sel):
    s=[i for i in ids if sel(i)]
    if not s: return
    m={c: 100*sum(sum(R[i][c])/len(reps) for i in s)/len(s) for c in 'ABCD'}
    w=lambda x,y: (sum(sum(R[i][x])>sum(R[i][y]) for i in s), sum(sum(R[i][x])<sum(R[i][y]) for i in s))
    print(f"  {label:26s} n={len(s):3d} | A {m['A']:5.1f}  B {m['B']:5.1f}  C {m['C']:5.1f}  D {m['D']:5.1f} | vs A  B +{w('B','A')[0]}/-{w('B','A')[1]}  C +{w('C','A')[0]}/-{w('C','A')[1]}  D +{w('D','A')[0]}/-{w('D','A')[1]}")
print(f'pass rate per question, mean of {len(reps)} rep(s)')
line('both boards', lambda i: True); line('M01', lambda i: i.startswith('M01')); line('M02', lambda i: i.startswith('M02'))
line('implicit', lambda i: key[i]['probe_type']=='implicit'); line('2+ evidence turns', lambda i: len(key[i]['evidence_turns'])>=2); line('1 evidence turn', lambda i: len(key[i]['evidence_turns'])==1)
if len(reps)>1:
    for c in 'ABCD': print(f"  rerun flips {c}: {sum(len(set(R[i][c]))>1 for i in ids)} of {len(ids)}")

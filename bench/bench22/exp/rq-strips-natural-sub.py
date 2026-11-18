import json, sys, collections
import os
D=os.environ.get('BENCH22_DATASET', '/home/claude/chat-memory-benchmark/benchmark-2.2/dataset')
jl=lambda p:[json.loads(l) for l in open(p) if l.strip()]
key={r['id']:r for r in jl(f'{D}/natural/natural-key-dev.jsonl')}
J=[r for rep in sys.argv[1:] for r in jl(f'natj_{rep}.jsonl')]
def grp(k):
    s=k['subtype']
    return 'X4 今天到期' if s=='X4' else 'X8 她答应的事到期' if s=='X8' else 'X 其余' if k['class']=='X' else k['class']
T=collections.defaultdict(lambda: collections.defaultdict(list))
for r in J: T[grp(key[r['id']])][r['cond']].append(r['score'])
print(f"{'':20s}{'turns':>6s}{'A':>7s}{'B':>7s}{'C':>7s}")
for g in ['X4 今天到期','X8 她答应的事到期','X 其余','H','Y','Z','N0']:
    print(f"{g:20s}{len(T[g]['A']):6d}" + ''.join(f"{100*sum(T[g][c])/max(1,len(T[g][c])):7.1f}" for c in 'ABC'))
fb=collections.Counter((r['cond'], key[r['id']]['class']) for r in J if r['judge'].get('fabrication')); print('fabricated by class', dict(fb))
ov=collections.Counter(r['cond'] for r in J if key[r['id']]['class'] in ('Y','N0') and (r['judge'].get('forbidden_recalled') or (key[r['id']]['class']=='N0' and r['judge'].get('other_recalls')))); print('over-recalled turns (Y, N0)', dict(ov))

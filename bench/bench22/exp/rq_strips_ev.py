import json, sys
D = __import__('os').environ.get('BENCH22_DATASET', '/home/claude/chat-memory-benchmark/benchmark-2.2/dataset')
jl=lambda p:[json.loads(l) for l in open(p) if l.strip()]
key={r['id']:r for r in jl(f'{D}/review-only/answer-key.jsonl')}
def table(run, variants, ids=None, extra=None):
    R=jl(run); full=lambda r,v: all(t in set((r['v'].get(v) or r['v']['base'])['used']) for t in key[r['id']]['evidence_turns'])
    sub=[r for r in R if key[r['id']]['evidence_turns'] and (ids is None or r['id'] in ids)]
    print(f"n {len(sub)} | base {100*sum(full(r,'base') for r in sub)/len(sub):.1f}")
    for v in variants:
        print(f"  {v:14s} {100*sum(full(r,v) for r in sub)/len(sub):5.1f}  +{sum(full(r,v) and not full(r,'base') for r in sub)}/-{sum(full(r,'base') and not full(r,v) for r in sub)}  chars {sum((r['v'].get(v) or r['v']['base'])['chars'] for r in sub)//len(sub)}")
if __name__=='__main__':
    ids={r['id'] for r in json.load(open('picks_c1.json'))}
    table('r11_M01.jsonl',['c1-q6','c2-q6','c3-q6','c4-q6','c2-q4','c2-q8','c2-q3x1','c2-pins4','c2-pins8','c2-pins8+q6'],ids)

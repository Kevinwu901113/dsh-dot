import json,collections,sys
PER=sys.argv[1]; P={ (p['id'],p['k']):p for p in json.load(open('rp/probes.json')) if p['persona'] in PER.split(',')}
R='../runs/bench22/'
def J(run): return {(j['id'],j['k']):j for j in map(json.loads,open(R+run+'/dsh-dot/natural-dev/judgments.jsonl')) if (j['id'],j['k']) in P}
print('run        n   X     X4    X8    H     Y     N0    Z    fab  recall-like')
for r in sys.argv[2:]:
    j=J(r); by=collections.defaultdict(list)
    for k,v in j.items():
        by[P[k]['class']].append(v['score'])
        if P[k]['subtype'] in('X4','X8'): by[P[k]['subtype']].append(v['score'])
    m=lambda c: f"{sum(by[c])/len(by[c]):.3f}" if by[c] else '  -  '
    print(f"{r:10s} {len(j)}", m('X'),m('X4'),m('X8'),m('H'),m('Y'),m('N0'),m('Z'), sum(1 for v in j.values() if v['judge'].get('fabrication')))

#!/usr/bin/env python3
"""No caps: every strip available at the question (in time order, so questions share a cached prefix), the last
6 turns with her replies, as many picks as the model wants, room to think. On the questions plain retrieval misses."""
import concurrent.futures as cf, datetime, json, os, re, sys, urllib.request, collections
import rq_strips_heads as H, rq_strips_heads2 as H2
KEY = os.environ['DEEPSEEK_API_KEY']
hist = H.jl(f'{H.D}/histories/M01.jsonl'); TH = H2.TH
model, think = sys.argv[1], sys.argv[2] == 'think'
brief = sys.argv[2] == 'brief'
tag = f"{model}{'+think' if think else '+brief' if brief else ''}"
RULES = """下面是你以前记下的、关于他和他身边的人和事的全部条目，按时间先后排，每行开头是编号。最后是最近几轮聊天和他刚发来的一句话。
挑出接他这句话时用得上的条目：不知道就可能说错话、踩到他说过别碰的事、忘了答应过的事，或者能让回答更贴他的情况的。
按用得上的程度从高到低输出编号，用逗号隔开，用得上几条就列几条；一条都用不上就输出：无。只输出编号。"""
if brief: RULES = RULES.replace("按用得上的程度从高到低输出编号，用逗号隔开，用得上几条就列几条；一条都用不上就输出：无。只输出编号。", "先写一行\"想到：\"，用两三句话说清他这句话牵涉到谁、他打算做什么、以前记下的哪些事会让这个打算出岔子或者该顺着来；再写一行\"编号：\"，按用得上的程度从高到低列出最多 8 个编号，用逗号隔开，一条都用不上就写 无。")
S = sorted(H.F, key=lambda f: (f['avail'], f['t']))
day = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone(datetime.timedelta(hours=8))).strftime('%m-%d')
LINES = [f"{n + 1}. [{day(f['at'])}] [{f['kind']}] {f['text']}" for n, f in enumerate(S)]
M = sorted(H.misses(), key=lambda x: x[0]['cutoff_turn'])
if brief:
    miss = {it['id']: m for it, m in M}
    M = sorted([(it, miss.get(it['id'], [])) for it in H.items if H.key[it['id']]['evidence_turns']], key=lambda x: x[0]['cutoff_turn'])
use = collections.Counter()
def ask(x):
    it, m = x; n = sum(1 for f in S if f['avail'] <= it['cutoff_turn'])
    h = hist[max(0, it['cutoff_turn'] - 6):it['cutoff_turn']]
    body = RULES + '\n\n【条目】\n' + '\n'.join(LINES[:n]) + '\n\n【最近几轮】\n' + '\n'.join(f"他：{t['用户消息']}\n你：{t['助手回复']}" for t in h) + f"\n\n【现在 {it['now'][:16].replace('T', ' ')}，他刚说】{it['question']}"
    req = {'model': model, 'messages': [{'role': 'user', 'content': body}], 'max_tokens': 60000 if think else 600 if not brief else 400, 'thinking': {'type': 'enabled' if think else 'disabled'}}
    if not think: req['temperature'] = 0
    for a in range(3):
        try: r = json.load(urllib.request.urlopen(urllib.request.Request('https://api.deepseek.com/chat/completions', json.dumps(req).encode(), {'content-type': 'application/json', 'authorization': f'Bearer {KEY}'}), timeout=900)); break
        except Exception as e:
            if a == 2: return {'id': it['id'], 'n': n, 'picks': [], 'err': str(e)[:80]}
    u = r.get('usage') or {}; use['in'] += u.get('prompt_tokens', 0); use['hit'] += u.get('prompt_cache_hit_tokens', 0); use['out'] += u.get('completion_tokens', 0)
    c = r['choices'][0]; txt = c['message'].get('content') or ''; txt = txt.split('编号')[-1] if brief else txt; ids = [int(v) for v in re.findall(r'\d+', txt)]
    return {'id': it['id'], 'n': n, 'picks': [S[i - 1]['i'] for i in ids if 1 <= i <= n], 'finish': c.get('finish_reason')}
first = ask(M[0])  # one call ahead, so the rest find the prefix cached
with cf.ThreadPoolExecutor(8) as ex: R = [first] + list(ex.map(ask, M[1:]))
json.dump(R, open(f'nolimit_{tag}.json', 'w'))
need = lambda it, m: {f['i'] for f in H.F if f['t'] in m and f['avail'] <= it['cutoff_turn']}
st = collections.Counter()
for r, (it, m) in zip(R, M):
    nd = need(it, m); things = {TH[i] for i in nd}; st['has'] += bool(nd)
    st['any'] += bool(nd & set(r['picks'])); st['top4'] += bool(nd & set(r['picks'][:4])); st['top8'] += bool(nd & set(r['picks'][:8]))
    st['thing4'] += any(TH[i] in things for i in r['picks'][:4]); st['picks'] += len(r['picks']); st['none'] += not r['picks']; st['cut'] += r.get('finish') == 'length'; st['err'] += 'err' in r
n = len(M)
print(f"{tag}: questions {n} (a strip exists for {st['has']}) | lines shown: mean {sum(r['n'] for r in R) // n}")
print(f"  needed strip picked: anywhere {st['any']} | in the first 8 {st['top8']} | in the first 4 {st['top4']} | same thing in the first 4 {st['thing4']}")
print(f"  picks per question {st['picks'] / n:.1f} | picked nothing {st['none']} | cut off {st['cut']} | errors {st['err']} | in {use['in']} (cache hit {use['hit']}) out {use['out']}")

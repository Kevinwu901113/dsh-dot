#!/usr/bin/env python3
"""Short rounds on a fixed sample of 120 questions (seed 7): one flash call per question, no thinking mode.
  round1.py <name> --n 120 --heads time,topic,trig [--direct] [--ctx his3] [--max 8]   -> picks_<name>.json"""
import concurrent.futures as cf, datetime, json, os, random, re, sys, time, urllib.request, collections
import rq_strips_heads as H, rq_strips_heads2 as H2
KEY = os.environ['DEEPSEEK_API_KEY']; name = sys.argv[1]
arg = lambda k, d: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
N = int(arg('--n', 120)); heads = tuple(arg('--heads', 'time,topic,trig').split(',')); direct = '--direct' in sys.argv; ctx = arg('--ctx', 'both6'); MAXP = int(arg('--max', 8)); NOKIND = '--nokind' in sys.argv
hist = H.jl(f'{H.D}/histories/{H.P}.jsonl')
HEAD = """下面是你以前记下的、关于他和他身边的人和事的条目，按时间先后排，每行开头是编号。最后是最近几轮聊天和他刚发来的一句话。
挑出接他这句话时用得上的条目：不知道就可能说错话、踩到他说过别碰的事、忘了答应过的事，或者能让回答更贴他的情况的。
"""
BRIEF = f'先写一行"想到："，用两三句话说清他这句话牵涉到谁、他打算做什么、以前记下的哪些事会让这个打算出岔子或者该顺着来；再写一行"编号："，按用得上的程度从高到低列出最多 {MAXP} 个编号，用逗号隔开，一条都用不上就写 无。'
DIRECT = f'只写一行"编号："，按用得上的程度从高到低列出最多 {MAXP} 个编号，用逗号隔开，一条都用不上就写 无。不要写别的。'
day = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone(datetime.timedelta(hours=8))).strftime('%m-%d')
allq = sorted([it for it in H.items if H.key[it['id']]['evidence_turns']], key=lambda it: it['id'])
Q = random.Random(7).sample(allq, 120)
use = collections.Counter()
def ask(it):
    cs = sorted(H2.ranked(it, heads=heads)[0][:N], key=lambda f: (f['avail'], f['t']))
    if not cs: return {'id': it['id'], 'n': 0, 'picks': []}
    h = hist[max(0, it['cutoff_turn'] - (3 if ctx == 'his3' else 6)):it['cutoff_turn']]
    win = '\n'.join(f"他：{t['用户消息']}" + ('' if ctx == 'his3' else f"\n你：{t['助手回复']}") for t in h)
    body = HEAD + (DIRECT if direct else BRIEF) + '\n\n【条目】\n' + '\n'.join((f"{n + 1}. [{day(f['at'])}] {f['text']}" if NOKIND else f"{n + 1}. [{day(f['at'])}] [{f['kind']}] {f['text']}" if f['kind'] else f"{n + 1}. [{day(f['at'])}] {f['text']}") for n, f in enumerate(cs)) + '\n\n【最近几轮】\n' + win + f"\n\n【现在 {it['now'][:16].replace('T', ' ')}，他刚说】{it['question']}"
    req = {'model': 'deepseek-flash', 'messages': [{'role': 'user', 'content': body}], 'max_tokens': 400, 'temperature': 0, 'thinking': {'type': 'disabled'}}
    for a in range(4):
        try: r = json.load(urllib.request.urlopen(urllib.request.Request('https://api.deepseek.com/chat/completions', json.dumps(req).encode(), {'content-type': 'application/json', 'authorization': f'Bearer {KEY}'}), timeout=300)); break
        except Exception as e:
            if a == 3: return {'id': it['id'], 'n': len(cs), 'picks': [], 'err': str(e)[:80]}
            time.sleep(6 * (a + 1))
    u = r.get('usage') or {}; use['in'] += u.get('prompt_tokens', 0); use['hit'] += u.get('prompt_cache_hit_tokens', 0); use['out'] += u.get('completion_tokens', 0)
    txt = (r['choices'][0]['message'].get('content') or '').split('编号')[-1]
    return {'id': it['id'], 'n': len(cs), 'picks': [cs[i - 1]['i'] for i in [int(v) for v in re.findall(r'\d+', txt)] if 1 <= i <= len(cs)][:MAXP]}
with cf.ThreadPoolExecutor(6) as ex: R = list(ex.map(ask, Q))
json.dump(R, open(f'picks_{name}.json', 'w'))
miss = {it['id']: m for it, m in H.misses()}
need = sum(any(H.F[i]['t'] in miss[r['id']] for i in r['picks']) for r in R if r['id'] in miss)
cost = lambda p: (use['in'] - use['hit']) / 1e6 * 0.15 * p + use['hit'] / 1e6 * 0.003 * p + use['out'] / 1e6 * 0.6 * p
print(f"{name}: n {len(R)} (plain retrieval misses {sum(r['id'] in miss for r in R)}) | needed strip picked {need} | in/q {use['in'] / len(R):.0f} out/q {use['out'] / len(R):.0f} | err {sum('err' in r for r in R)} | cost ${cost(1):.3f}–{cost(2):.3f}", flush=True)

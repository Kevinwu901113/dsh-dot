#!/usr/bin/env python3
"""How small can the list shown to flash be? Same instructions as the uncapped run (two or three sentences of
"想到", then at most 8 numbers; no thinking mode), different lists:
  topN   the N best strips by the fused scorers (names, days, closeness, guarded kinds, newest, triggers), shown in time order
  guard  every 别碰 / 约定 strip so far    gp  those plus 喜好
  nl3.py <mode> -> picks_<mode>.json"""
import concurrent.futures as cf, datetime, json, os, re, sys, urllib.request, collections
import rq_strips_heads as H, rq_strips_heads2 as H2
KEY = os.environ['DEEPSEEK_API_KEY']; mode = sys.argv[1]
hist = H.jl(f'{H.D}/histories/M01.jsonl')
RULES = """下面是你以前记下的、关于他和他身边的人和事的条目，按时间先后排，每行开头是编号。最后是最近几轮聊天和他刚发来的一句话。
挑出接他这句话时用得上的条目：不知道就可能说错话、踩到他说过别碰的事、忘了答应过的事，或者能让回答更贴他的情况的。
先写一行"想到："，用两三句话说清他这句话牵涉到谁、他打算做什么、以前记下的哪些事会让这个打算出岔子或者该顺着来；再写一行"编号："，按用得上的程度从高到低列出最多 8 个编号，用逗号隔开，一条都用不上就写 无。"""
day = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone(datetime.timedelta(hours=8))).strftime('%m-%d')
S = sorted(H.F, key=lambda f: (f['avail'], f['t']))
KINDS = {'guard': ('别碰', '约定'), 'gp': ('别碰', '约定', '喜好')}
def shown(it):
    if mode.startswith('top'): return sorted(H2.ranked(it)[0][:int(mode[3:])], key=lambda f: (f['avail'], f['t']))
    return [f for f in S if f['avail'] <= it['cutoff_turn'] and f['kind'] in KINDS[mode]]
Q = sorted([it for it in H.items if H.key[it['id']]['evidence_turns']], key=lambda it: it['cutoff_turn'])
use = collections.Counter()
def ask(it):
    cs = shown(it)
    if not cs: return {'id': it['id'], 'n': 0, 'picks': []}
    h = hist[max(0, it['cutoff_turn'] - 6):it['cutoff_turn']]
    body = RULES + '\n\n【条目】\n' + '\n'.join(f"{n + 1}. [{day(f['at'])}] [{f['kind']}] {f['text']}" for n, f in enumerate(cs)) + '\n\n【最近几轮】\n' + '\n'.join(f"他：{t['用户消息']}\n你：{t['助手回复']}" for t in h) + f"\n\n【现在 {it['now'][:16].replace('T', ' ')}，他刚说】{it['question']}"
    req = {'model': 'deepseek-flash', 'messages': [{'role': 'user', 'content': body}], 'max_tokens': 400, 'temperature': 0, 'thinking': {'type': 'disabled'}}
    for a in range(3):
        try: r = json.load(urllib.request.urlopen(urllib.request.Request('https://api.deepseek.com/chat/completions', json.dumps(req).encode(), {'content-type': 'application/json', 'authorization': f'Bearer {KEY}'}), timeout=300)); break
        except Exception as e:
            if a == 2: return {'id': it['id'], 'n': len(cs), 'picks': [], 'err': str(e)[:120]}
            import time; time.sleep(8 * (a + 1))
    u = r.get('usage') or {}; use['in'] += u.get('prompt_tokens', 0); use['hit'] += u.get('prompt_cache_hit_tokens', 0); use['out'] += u.get('completion_tokens', 0)
    txt = (r['choices'][0]['message'].get('content') or '').split('编号')[-1]
    return {'id': it['id'], 'n': len(cs), 'picks': [cs[i - 1]['i'] for i in [int(v) for v in re.findall(r'\d+', txt)] if 1 <= i <= len(cs)][:8], 'finish': r['choices'][0].get('finish_reason')}
first = ask(Q[0])
with cf.ThreadPoolExecutor(4) as ex: R = [first] + list(ex.map(ask, Q[1:]))
json.dump(R, open(f'picks_{mode}.json', 'w'))
n = len(R); print(f"{mode}: questions {n} | lines shown mean {sum(r['n'] for r in R) / n:.0f} | input tokens per question {use['in'] / n:.0f} (cache hit {100 * use['hit'] / max(1, use['in']):.0f}%) | output per question {use['out'] / n:.0f} | cut {sum(r.get('finish') == 'length' for r in R)} err {sum('err' in r for r in R)}", flush=True)

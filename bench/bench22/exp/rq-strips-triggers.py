#!/usr/bin/env python3
"""Triggers for the strips: for each, 2-3 short situations in which it should come to mind (written in the
words he would use then, not the fact again). One flash call per 25 strips."""
import concurrent.futures as cf, json, os, re, urllib.request
KEY = os.environ['DEEPSEEK_API_KEY']
F = json.load(open('strips_M01.json'))
RULES = """下面是记下的一些事（每行开头是编号）。给每一条写 2 到 3 个"以后什么时候该想起它"的情境，每个情境一句短话（十几个字以内），写成他到时候会说的事、会做的打算，而不是把这条事实再说一遍。
要写具体会碰上它的场合：会用到它、会踩到它、会和它冲突的时候。带上这条里的人名或东西名。
例：条目"老周对花生过敏" → ["要和老周一起吃饭点菜", "想给老周带零食", "老周吃了东西不舒服"]
只输出一个 JSON 对象，键是编号，值是情境的数组。"""
def one(b):
    part = F[b:b + 25]
    body = RULES + '\n\n' + '\n'.join(f"{i + 1}. [{f['kind']}] {f['text']}" for i, f in enumerate(part))
    req = json.dumps({'model': 'deepseek-flash', 'messages': [{'role': 'user', 'content': body}], 'temperature': 0, 'max_tokens': 3000, 'thinking': {'type': 'disabled'}}).encode()
    for a in range(4):
        try: r = json.load(urllib.request.urlopen(urllib.request.Request('https://api.deepseek.com/chat/completions', req, {'content-type': 'application/json', 'authorization': f'Bearer {KEY}'}), timeout=300)); break
        except Exception:
            if a == 3: raise
    m = re.search(r'\{.*\}', r['choices'][0]['message'].get('content') or '', re.S)
    try: a = json.loads(m.group(0)) if m else {}
    except ValueError: a = {}
    return b, [[str(x) for x in (a.get(str(i + 1)) or []) if isinstance(x, str)][:3] for i in range(len(part))], r.get('usage') or {}
T = [[] for _ in F]; u = [0, 0]
with cf.ThreadPoolExecutor(8) as ex:
    for b, ts, us in ex.map(one, range(0, len(F), 25)):
        T[b:b + len(ts)] = ts; u[0] += us.get('prompt_tokens', 0); u[1] += us.get('completion_tokens', 0)
json.dump(T, open('trig_M01.json', 'w'), ensure_ascii=False)
print('strips', len(T), 'with triggers', sum(bool(t) for t in T), 'triggers', sum(len(t) for t in T), 'in', u[0], 'out', u[1], 'usd', round(u[0] / 1e6 * .18 + u[1] / 1e6 * .72, 3))
for f, t in list(zip(F, T))[:3] + [(f, t) for f, t in zip(F, T) if '房贷' in f['text']][:2]: print(' ', f['text'][:40], '→', t)

#!/usr/bin/env python3
"""Strips -> things, in time order as a write-time merge would do it: under each name (a strip's first key),
batches of new strips are attached to the things already there or open a new one. One flash call per batch."""
import concurrent.futures as cf, json, os, re, urllib.request, collections
KEY = os.environ['DEEPSEEK_API_KEY']
F = json.load(open('strips_M01.json'))
for i, f in enumerate(F): f['i'] = i
RULES = """下面是挂在同一个名字下的事。上半是已经记着的事（G 开头的编号，每件事只显示最新的一句），下半是新记下的几条（数字编号，按时间先后）。
把每条新的归到它说的那件事上：和某件已有的事是同一件（同一个约定的进展、同一个东西的新情况、同一件事的又一次提起），就写那件事的编号；是一件新的事，就写 N1、N2…（几条新的说的是同一件新事，用同一个 N 编号）。
只是同一个人、同一类，但不是同一件事的，不要归到一起。
只输出一个 JSON 对象，键是新条目的编号，值是 G 编号或 N 编号，例如 {"1": "G3", "2": "N1", "3": "N1"}"""
def chat(body):
    req = json.dumps({'model': 'deepseek-flash', 'messages': [{'role': 'user', 'content': body}], 'temperature': 0, 'max_tokens': 2500, 'thinking': {'type': 'disabled'}}).encode()
    for a in range(4):
        try: return json.load(urllib.request.urlopen(urllib.request.Request('https://api.deepseek.com/chat/completions', req, {'content-type': 'application/json', 'authorization': f'Bearer {KEY}'}), timeout=300))
        except Exception:
            if a == 3: raise
def day(f):
    import datetime; return datetime.datetime.fromtimestamp(f['at'] / 1000, datetime.timezone(datetime.timedelta(hours=8))).strftime('%m-%d')
def one(name, strips):
    things, use = [], [0, 0]   # things: lists of strip indexes, in time order
    if len(strips) < 2: return name, [[f['i']] for f in strips], use
    for b in range(0, len(strips), 40):
        new = strips[b:b + 40]
        body = RULES + '\n\n【已经记着的事】\n' + ('\n'.join(f"G{n + 1}. [{day(F[t[-1]])}] {F[t[-1]]['text']}" for n, t in enumerate(things)) or '（还没有）') + '\n\n【新记下的】\n' + '\n'.join(f"{n + 1}. [{day(f)}] {f['text']}" for n, f in enumerate(new))
        r = chat(body); u = r.get('usage') or {}; use[0] += u.get('prompt_tokens', 0); use[1] += u.get('completion_tokens', 0)
        m = re.search(r'\{.*\}', r['choices'][0]['message'].get('content') or '', re.S)
        try: a = json.loads(m.group(0)) if m else {}
        except ValueError: a = {}
        fresh = {}
        for n, f in enumerate(new):
            v = str(a.get(str(n + 1), '')).strip(); g = re.fullmatch(r'G(\d+)', v)
            if g and 1 <= int(g.group(1)) <= len(things): things[int(g.group(1)) - 1].append(f['i'])
            elif v.startswith('N') and v in fresh: things[fresh[v]].append(f['i'])
            else:
                things.append([f['i']])
                if v.startswith('N'): fresh[v] = len(things) - 1
    return name, things, use
by = collections.defaultdict(list)
for f in sorted(F, key=lambda f: f['t']): by[(f['keys'] or ['他'])[0] if isinstance((f['keys'] or ['他'])[0], str) else '他'].append(f)
thing = {}; tot = [0, 0]; n = 0
with cf.ThreadPoolExecutor(8) as ex:
    for name, things, use in ex.map(lambda kv: one(*kv), by.items()):
        tot[0] += use[0]; tot[1] += use[1]
        for t in things:
            for i in t: thing[i] = n
            n += 1
json.dump({str(i): g for i, g in thing.items()}, open('things_M01.json', 'w'))
sz = collections.Counter(thing.values()); print('strips', len(thing), 'things', n, 'largest', sorted(sz.values())[-5:], 'in', tot[0], 'out', tot[1], 'usd', round(tot[0] / 1e6 * .18 + tot[1] / 1e6 * .72, 3))
for nm in ('小赵', '高姐'):
    gs = collections.defaultdict(list)
    for f in by[nm]: gs[thing[f['i']]].append(f)
    print(nm, len(by[nm]), 'strips ->', len(gs), 'things;', ' | '.join(f"{len(v)}×{v[-1]['text'][:18]}" for v in sorted(gs.values(), key=lambda v: -len(v))[:6]))

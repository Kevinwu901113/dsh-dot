#!/usr/bin/env python3
"""Fact strips as retrieval keys: one flash call per 60 turns of his words -> [{t, keys, kind, text}].
  DEEPSEEK_API_KEY=... kx.py M01 facts_M01.jsonl [--turns 60]"""
import concurrent.futures as cf, json, os, re, sys, urllib.request
D = os.environ.get('BENCH22_DATASET', '/home/claude/chat-memory-benchmark/benchmark-2.2/dataset')
P, out = sys.argv[1], sys.argv[2]
N = int(sys.argv[sys.argv.index('--turns')+1]) if '--turns' in sys.argv else 60
KEY = os.environ['DEEPSEEK_API_KEY']
jl = lambda p: [json.loads(l) for l in open(p, encoding='utf-8') if l.strip()]
hist = jl(f'{D}/histories/{P}.jsonl')
RULES = """下面是一段聊天记录里他说的话，每行开头的 #数字 是这一轮的编号。
把这段里以后接他的话用得上的事写成事实条，输出一个 JSON 数组，每条：
{"t": 这件事出自哪一轮的编号, "keys": [以后他提到什么的时候该想起这条：人名、宠物名、地方、东西、活动，照原字，1 到 3 个], "kind": "别碰" | "约定" | "喜好" | "现状", "text": "一句话，用他的原词，带上名字、数目、日子"}
kind 怎么分：别碰 = 他说了不要提、不要做、会让谁难堪的事；约定 = 答应的、欠着的、约好的、有期限的；喜好 = 谁爱什么、不爱什么、习惯怎样；现状 = 谁现在怎么样、发生过什么值得记的事。
只记以后用得上的；寒暄、当时的心情、随口一句不记。一轮里有几件就写几条，没有就不写。
没说的不编，数目和日子照他说的写。只输出 JSON 数组。"""
def one(k):
    h = hist[k:k + N]
    body = '\n'.join(f"#{x['轮次']} [{x['逻辑时间'][5:16].replace('T', ' ')}] {x['用户消息']}" for x in h)
    req = json.dumps({'model': os.environ.get('DEEPSEEK_MODEL', 'deepseek-flash'), 'messages': [{'role': 'user', 'content': f'{RULES}\n\n{body}'}], 'temperature': 0, 'max_tokens': 4000, 'thinking': {'type': 'disabled'}}).encode()
    for a in range(4):
        try: r = json.load(urllib.request.urlopen(urllib.request.Request('https://api.deepseek.com/chat/completions', req, {'content-type': 'application/json', 'authorization': f'Bearer {KEY}'}), timeout=300)); break
        except Exception:
            if a == 3: raise
    text = r['choices'][0]['message'].get('content') or ''
    m = re.search(r'\[.*\]', text, re.S)
    try: facts = json.loads(m.group(0)) if m else []
    except ValueError: facts = []
    lo, hi = h[0]['轮次'], h[-1]['轮次']
    ok = [f for f in facts if isinstance(f, dict) and isinstance(f.get('t'), int) and lo <= f['t'] <= hi and f.get('text') and isinstance(f.get('keys'), list)]
    return {'from': lo, 'to': hi, 'facts': ok, 'dropped': len(facts) - len(ok), 'finish': r['choices'][0].get('finish_reason'), 'usage': r.get('usage')}
with open(out, 'w', encoding='utf-8') as f, cf.ThreadPoolExecutor(8) as ex:
    for r in ex.map(one, range(0, len(hist), N)): f.write(json.dumps(r, ensure_ascii=False) + '\n'); f.flush()
R = jl(out); u = [r['usage'] or {} for r in R]
print(P, 'chunks', len(R), 'facts', sum(len(r['facts']) for r in R), 'dropped', sum(r['dropped'] for r in R), 'cut', sum(r['finish'] == 'length' for r in R), 'in', sum(x.get('prompt_tokens', 0) for x in u), 'out', sum(x.get('completion_tokens', 0) for x in u))

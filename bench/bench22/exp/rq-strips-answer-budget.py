#!/usr/bin/env python3
"""Answer + judge on the stored prompts, the benchmark's own way (runner.answer_and_judge): flash, temperature 0,
no thinking, the harness's judge prompt and pass rule. The fake-model replay's "还没了的事" list (stand-in lines,
not real notes) is taken out of every prompt.
  A  plain retrieval      B  version 7: the first three picked strips each a query (original turns shown)
  C  plain retrieval + the first six picked strips shown as lines (no strip queries)
  D  B and the six lines
  ansjudge.py <rep>  -> aj_<rep>.jsonl"""
import concurrent.futures as cf, datetime, json, os, re, sys, time, urllib.request, collections
sys.path.insert(0, os.environ.get('BENCH22_HARNESS', '/home/claude/chat-memory-benchmark/benchmark-2.2/harness'))
from bench22 import runner, scoring
from bench22.release import load_items
D = os.environ.get('BENCH22_DATASET', '/home/claude/chat-memory-benchmark/benchmark-2.2/dataset'); KEY = os.environ['DEEPSEEK_API_KEY']; rep = sys.argv[1]
jl = lambda p: [json.loads(l) for l in open(p, encoding='utf-8') if l.strip()]
items = {i['id']: i for i in load_items(D) if i.get('rubric')}
day = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone(datetime.timedelta(hours=8))).strftime('%m-%d')
def clean(p): return re.sub(r'## 还没了的事（[^\n]*\n(?:- [^\n]*\n)*', '', p)
jobs = []
def strip_recall(p):
    i = p.find('你记得的相关原话（'); j = p.find('【最近的聊天】')
    return p if i < 0 or j < 0 else p[:i] + p[j:]
for P, pk in (('M01', 'w2c5'), ('M02', 'm2c5')):
    F = json.load(open(f'strips2_{P}.json')); picks = {r['id']: r['picks'] for r in json.load(open(f'picks_{pk}.json'))}
    pr = {b: {r['id']: clean(r['prompt']) for r in jl(f) if r['v'] == 'base'} for b, f in (('1500', f'a_{P}.prompts.jsonl'), ('800', f'b800_{P}.prompts.jsonl'), ('400', f'b400_{P}.prompts.jsonl'))}
    for i, p in picks.items():
        if i not in items: continue
        block = ('你记下的相关的事（你自己以前记的一句话，前面是日子；具体说过什么以原话为准，用不上就当没看见）：\n' + '\n'.join(f"- [{day(F[x]['at'])}] {F[x]['text']}" for x in p[:6]) + '\n\n') if p else ''
        add = lambda a: a.replace('【最近的聊天】', block + '【最近的聊天】', 1) if '【最近的聊天】' in a else a + '\n\n' + block
        jobs += [(i, 'A800', pr['800'][i]), (i, 'C800', add(pr['800'][i])), (i, 'C400', add(pr['400'][i])), (i, 'C0', add(strip_recall(pr['1500'][i])))]
use = collections.Counter()
def chat(content, mx):
    req = json.dumps({'model': 'deepseek-flash', 'messages': [{'role': 'user', 'content': content}], 'temperature': 0, 'max_tokens': mx, 'thinking': {'type': 'disabled'}}).encode()
    for a in range(5):
        try: r = json.load(urllib.request.urlopen(urllib.request.Request('https://api.deepseek.com/chat/completions', req, {'content-type': 'application/json', 'authorization': f'Bearer {KEY}'}), timeout=300)); break
        except Exception as e:
            if a == 4: raise
            time.sleep(5 * (a + 1))
    u = r.get('usage') or {}; use['in'] += u.get('prompt_tokens', 0); use['hit'] += u.get('prompt_cache_hit_tokens', 0); use['out'] += u.get('completion_tokens', 0)
    return r['choices'][0]['message'].get('content') or ''
out = f'aj2_{rep}.jsonl'; done = {(r['id'], r['c']) for r in jl(out)} if os.path.exists(out) else set()
def one(job):
    i, c, p = job; it = items[i]
    ans = chat(p + f"\n\n【现在】{it['now']}\n用户：{it['question']}", 700); j = None
    for _ in range(3):
        try: j = runner.parse_json(chat(runner.judge_prompt(it, ans), 700)); break
        except ValueError: pass
    if j is None: j = {'required': [], 'reason': 'judge-format-failure'}
    return {'id': i, 'c': c, 'answer': ans, 'pass': bool(scoring.judge_pass(j)), 'points': scoring.points(j), 'plen': len(p)}
todo = [j for j in jobs if (j[0], j[1]) not in done]
with open(out, 'a', encoding='utf-8') as f, cf.ThreadPoolExecutor(8) as ex:
    for n, r in enumerate(ex.map(one, todo), 1):
        f.write(json.dumps(r, ensure_ascii=False) + '\n'); f.flush()
c1 = (use['in'] - use['hit']) / 1e6 * .15 + use['hit'] / 1e6 * .003 + use['out'] / 1e6 * .6
print(f"rep {rep}: {len(todo)} answered+judged | in {use['in']} (hit {use['hit']}) out {use['out']} | cost ${c1:.2f}–{2 * c1:.2f}")

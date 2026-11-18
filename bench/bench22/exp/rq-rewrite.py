#!/usr/bin/env python3
"""One flash call per dev question: other wordings to look the wake up by (what he may have said back
then), from the last few turns and his message.  Run on 2026-11-16 with three rule texts (this one, rq-rules-statements.txt,
rq-rules-keywords.txt): +1 to +3 points of evidence in the prompt, see docs/MEMORY-ROOT-CAUSES.md.  Output rows {"id", "more": [...], "usage"}; turn them into rq-run.py variants with
  python3 -c "import json,sys; [print(json.dumps({'id':r['id'],'variants':{'q+rw':{'more':r['more']}}},ensure_ascii=False)) for r in map(json.loads,open(sys.argv[1]))]" rw.jsonl > v_rw.jsonl
  DEEPSEEK_API_KEY=... rq-rewrite.py rw.jsonl [--window 6] [--limit N] [--rules file]   (resumable; usage kept per row)
Env: BENCH22_DATASET, DEEPSEEK_MODEL (deepseek-flash)."""
import concurrent.futures as cf, json, os, sys, urllib.request
D = os.environ.get('BENCH22_DATASET', '/home/claude/chat-memory-benchmark/benchmark-2.2/dataset')
out = sys.argv[1]
W = int(sys.argv[sys.argv.index('--window')+1]) if '--window' in sys.argv else 6
LIM = int(sys.argv[sys.argv.index('--limit')+1]) if '--limit' in sys.argv else 10**9
KEY = os.environ['DEEPSEEK_API_KEY']; MODEL = os.environ.get('DEEPSEEK_MODEL', 'deepseek-flash')
jl = lambda p: [json.loads(l) for l in open(p, encoding='utf-8') if l.strip()]
hist = {p: jl(f'{D}/histories/{p}.jsonl') for p in ('M01', 'M02')}
RULES = """你在帮她翻以前的聊天记录。下面是最近几轮聊天和他刚发来的话。
想一想：要接好他这句话，以前聊过的哪些事可能用得上（他提过的人、东西、数目、日子、喜好、说定的安排、没办完的事）。
写出 1 到 3 条用来翻记录的话，每条一行，写成他当时可能会说的样子，用他会用的词；这句话里的人名、东西照原字写。
不知道的具体数目、日子不要编，只写是哪件事。
如果他这句话只是寒暄、和以前的事无关，只输出：无
只输出这几行，不要编号，不要解释。"""
if '--rules' in sys.argv: RULES = open(sys.argv[sys.argv.index('--rules')+1], encoding='utf-8').read().strip()
def prompt(it):
    h = hist[it['persona']][max(0, it['cutoff_turn'] - W):it['cutoff_turn']]
    win = '\n'.join(f"[{x['逻辑时间'][5:16].replace('T', ' ')}] 他：{x['用户消息']}\n她：{x['助手回复']}" for x in h)
    return f"{RULES}\n\n【最近几轮】\n{win}\n\n【现在 {it['now'][:16].replace('T', ' ')}】他：{it['question']}"
def one(it):
    body = json.dumps({'model': MODEL, 'messages': [{'role': 'user', 'content': prompt(it)}], 'temperature': 0, 'max_tokens': 200, 'thinking': {'type': 'disabled'}}).encode()
    for a in range(4):
        try:
            r = json.load(urllib.request.urlopen(urllib.request.Request('https://api.deepseek.com/chat/completions', body, {'content-type': 'application/json', 'authorization': f'Bearer {KEY}'}), timeout=120)); break
        except Exception as e:
            if a == 3: raise
    text = (r['choices'][0]['message'].get('content') or '').strip()
    lines = [l.strip(' -·•\t') for l in text.split('\n') if l.strip()]
    lines = [] if lines[:1] == ['无'] else [l for l in lines if l != '无'][:3]
    return {'id': it['id'], 'more': lines, 'usage': r.get('usage')}
done = {r['id'] for r in jl(out)} if os.path.exists(out) else set()
todo = [it for it in jl(f'{D}/exam-inputs.jsonl') if it['id'] not in done][:LIM]
with open(out, 'a', encoding='utf-8') as f, cf.ThreadPoolExecutor(8) as ex:
    for n, r in enumerate(ex.map(one, todo), 1):
        f.write(json.dumps(r, ensure_ascii=False) + '\n'); f.flush()
        if n % 100 == 0: print(n, len(todo), flush=True)
R = jl(out); u = [r['usage'] or {} for r in R]
print('rows', len(R), 'none', sum(not r['more'] for r in R), 'in', sum(x.get('prompt_tokens', 0) for x in u), 'cached', sum(x.get('prompt_cache_hit_tokens', 0) for x in u), 'out', sum(x.get('completion_tokens', 0) for x in u))

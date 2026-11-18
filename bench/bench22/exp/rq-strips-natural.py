#!/usr/bin/env python3
"""Natural board, one persona, three conditions per probe (each its own rollout from the same mark):
  A plain recall   B the first three picked strips each a query   C plain recall + the first six picked strips as lines
History replayed with the fake model (so no real notes: no 今天到期的, no banks); answers by flash as natural.py does.
  RQ_P=M01 RQ_SFX=2 nat_run.py <rep>  -> nat_<P>_<rep>.jsonl"""
import concurrent.futures as cf, datetime, json, os, re, subprocess, sys, time, urllib.request, numpy as np
import rq_strips_heads as H, rq_strips_heads2 as H2
P = H.P; rep = sys.argv[1]; KEY = os.environ['DEEPSEEK_API_KEY']
D = H.D; W = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'worker.mjs')
CHAT_NOTE = "（这是日常聊天，像平时一样回复，通常一到四句。）"
hist = H.jl(f'{D}/histories/{P}.jsonl')
probes = sorted([p for p in H.jl(f'{D}/natural/natural-probes-dev.jsonl') if p['persona'] == P], key=lambda p: (p['cutoff_turn'], p['id']))
use = {'in': 0, 'hit': 0, 'out': 0}
def chat(content, mx):
    req = json.dumps({'model': 'deepseek-flash', 'messages': [{'role': 'user', 'content': content}], 'temperature': 0, 'max_tokens': mx, 'thinking': {'type': 'disabled'}}).encode()
    for a in range(5):
        try: r = json.load(urllib.request.urlopen(urllib.request.Request('https://api.deepseek.com/chat/completions', req, {'content-type': 'application/json', 'authorization': f'Bearer {KEY}'}), timeout=300)); break
        except Exception:
            if a == 4: raise
            time.sleep(5 * (a + 1))
    u = r.get('usage') or {}; use['in'] += u.get('prompt_tokens', 0); use['hit'] += u.get('prompt_cache_hit_tokens', 0); use['out'] += u.get('completion_tokens', 0)
    return r['choices'][0]['message'].get('content') or ''
def embed(text):
    r = json.load(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18890/embeddings', json.dumps({'model': 'Xenova/multilingual-e5-small', 'input': [f'query: {text}']}).encode(), {'content-type': 'application/json'}), timeout=600))
    return np.array(r['data'][0]['embedding'], dtype=np.float32)
day = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone(datetime.timedelta(hours=8))).strftime('%m-%d')
HEAD = """下面是你以前记下的、关于他和他身边的人和事的条目，按时间先后排，每行开头是编号。最后是最近几轮聊天和他刚发来的一句话。
挑出接他这句话时用得上的条目：不知道就可能说错话、踩到他说过别碰的事、忘了答应过的事，或者能让回答更贴他的情况的。
只写一行"编号："，按用得上的程度从高到低列出最多 8 个编号，用逗号隔开，一条都用不上就写 无。不要写别的。"""
nq = [0]
def pick(text, now_iso, cutoff, recent):
    v = embed(text); H.QV = np.vstack([H.QV, v]); H2.QQ = np.vstack([H2.QQ, v]); fid = f'nat{nq[0]}'; nq[0] += 1; H.QI[fid] = len(H.QV) - 1
    cs = sorted(H2.ranked({'id': fid, 'question': text, 'cutoff_turn': cutoff, 'now': now_iso}, heads=('time', 'topic', 'trig'))[0][:60], key=lambda f: (f['avail'], f['t']))
    if not cs: return []
    body = HEAD + '\n\n【条目】\n' + '\n'.join(f"{n + 1}. [{day(f['at'])}] {f['text']}" for n, f in enumerate(cs)) + '\n\n【最近几轮】\n' + '\n'.join(f"他：{u}\n你：{a}" for u, a in recent[-6:]) + f"\n\n【现在 {now_iso[:16].replace('T', ' ')}，他刚说】{text}"
    txt = chat(body, 400).split('编号')[-1]
    return [cs[i - 1] for i in [int(x) for x in re.findall(r'\d+', txt)] if 1 <= i <= len(cs)][:8]
clean = lambda p: re.sub(r'## 还没了的事（[^\n]*\n(?:- [^\n]*\n)*', '', p)
def block(ps): return ('你记下的相关的事（你自己以前记的一句话，前面是日子；具体说过什么以原话为准，用不上就当没看见）：\n' + '\n'.join(f"- [{day(f['at'])}] {f['text']}" for f in ps[:6]) + '\n\n') if ps else ''
tag = f'nat_{P}_{rep}'; home = f'/tmp/rq-homes/{tag}'; os.makedirs('/tmp/rq-homes', exist_ok=True)
w = subprocess.Popen(['node', W], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(f'/tmp/rq-homes/{tag}.err', 'w'), text=True)
def call(o):
    w.stdin.write(json.dumps(o, ensure_ascii=False) + '\n'); w.stdin.flush(); r = json.loads(w.stdout.readline())
    if not r['ok']: raise SystemExit(r['error'])
    return r['result']
call({'cmd': 'init', 'home': home + '/dot', 'dshHome': home + '/dsh-home', 'gateway': 'http://127.0.0.1:18890', 'fake': True, 'memory': {}})
out = open(f'{tag}.jsonl', 'w', encoding='utf-8'); pool = cf.ThreadPoolExecutor(6); futs = []; pos = 0; t0 = time.time()
def finish(row, prompt):
    row['answer'] = chat(prompt + f"\n\n【现在】{row['time']}\n用户：{row['user']}\n{CHAT_NOTE}", 500); return row
for n, p in enumerate(probes, 1):
    if p['cutoff_turn'] > pos:
        call({'cmd': 'ingest', 'turns': [{'turn': h['轮次'], 'time': h['逻辑时间'], 'user': h['用户消息'], 'assistant': h['助手回复']} for h in hist[pos:p['cutoff_turn']]], 'run': tag, 'system': 'x'}); pos = p['cutoff_turn']
    base_recent = [(h['用户消息'], h['助手回复']) for h in hist[max(0, pos - 6):pos]] + [(t['user'], t['assistant']) for t in (p.get('tail') or [])]
    turns = [p['probe']] if p['tier'] == 'A' else p['script']; shared = {}
    for cond in 'ABC':
        tok = call({'cmd': 'mark'})['token']; seq = pos; recent = list(base_recent)
        for tt in p.get('tail') or []:
            seq += 1; call({'cmd': 'ingest', 'turns': [{'turn': seq, 'time': tt['time'], 'user': tt['user'], 'assistant': tt['assistant']}]})
        for k, t in enumerate(turns):
            ps = []
            if cond != 'A':
                if p['tier'] == 'A' and k in shared: ps = shared[k]
                else: ps = pick(t['user'], t['time'], pos, recent); shared[k] = ps
            r = call({'cmd': 'retrieve', 'question': t['user'], 'now': t['time'], 'cutoff': seq, 'more': [f['text'] for f in ps[:3]] if cond == 'B' else []})
            prompt = clean(r['prompt'])
            if cond == 'C' and ps: prompt = prompt.replace('【最近的聊天】', block(ps) + '【最近的聊天】', 1) if '【最近的聊天】' in prompt else prompt + '\n\n' + block(ps)
            row = {'id': p['id'], 'k': k, 'cond': cond, 'persona': P, 'cutoff_turn': p['cutoff_turn'], 'visible_until': seq, 'user': t['user'], 'time': t['time'], 'picks': [f['text'] for f in ps[:6]], 'plen': len(prompt)}
            if p['tier'] == 'A': futs.append(pool.submit(finish, row, prompt))
            else:
                finish(row, prompt); out.write(json.dumps(row, ensure_ascii=False) + '\n'); out.flush()
                seq += 1; call({'cmd': 'ingest', 'turns': [{'turn': seq, 'time': t['time'], 'user': t['user'], 'assistant': row['answer']}]}); recent.append((t['user'], row['answer']))
        call({'cmd': 'rewind', 'token': tok})
    if n % 10 == 0: print(P, n, len(probes), round(time.time() - t0), 's', flush=True)
for f in futs: out.write(json.dumps(f.result(), ensure_ascii=False) + '\n')
out.close(); w.stdin.write('{"cmd":"exit"}\n'); w.stdin.flush()
c1 = (use['in'] - use['hit']) / 1e6 * .15 + use['hit'] / 1e6 * .003 + use['out'] / 1e6 * .6
print(f"done {P} {round(time.time() - t0)} s | in {use['in']} (hit {use['hit']}) out {use['out']} | cost ${c1:.2f}–{2 * c1:.2f}", flush=True)

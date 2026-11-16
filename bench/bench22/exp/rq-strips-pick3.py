#!/usr/bin/env python3
"""Round three: triggers. Code-only variants, a local reranker picking, and the flash pick on the new candidates."""
import concurrent.futures as cf, json, os, re, urllib.request, collections
import rq_strips_heads as H, rq_strips_heads2 as H2
KEY = os.environ['DEEPSEEK_API_KEY']
hist = H.jl(f'{H.D}/histories/M01.jsonl')
key = H.key
PICK = """他刚发来一句话。下面是你以前记下的条目（每行开头是编号），都和这句话里提到的人或事沾边。
挑出接他这句话时用得上的：不知道就可能说错话、踩到他说过别碰的事、忘了答应过的事，或者能让回答更贴他的情况的。
最多挑 4 条，只输出编号，用逗号隔开；一条都用不上就输出：无"""
use = collections.Counter()
def post(url, body, headers, timeout):
    for a in range(4):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(url, json.dumps(body).encode(), {'content-type': 'application/json', **headers}), timeout=timeout))
        except Exception:
            if a == 3: raise
tri = lambda fs: [' '.join(f['text'] for f in fs[j:j + 3]) for j in range(0, len(fs), 3)]
def code(it):
    out = {'id': it['id'], 'v': {}, 'c': []}
    r, L = H2.ranked(it, w={'trig': 3})
    if not r: return out
    out['v']['trig-code9'] = tri(r[:9])
    out['v']['trig-12sep'] = [f['text'] for f in H2.ranked(it, w={'trig': 3}, per_thing=True)[0][:12]]
    out['v']['trig-thing9'] = tri(H2.ranked(it, w={'trig': 3}, per_thing=True)[0][:9])
    t = H2.ranked(it, heads=('trig',))[0]; out['v']['trigonly-6'] = tri(t[:6])
    g = H2.ranked(it, heads=('trig',), only=('别碰', '约定'))[0]
    if g: out['v']['trigonly-guard6'] = tri(g[:6])
    out['c'] = H2.ranked(it)[0][:60]
    return out
R = {it['id']: code(it) for it in H.items}
def llm(it):
    cs = R[it['id']]['c']
    if not cs: return
    h = hist[max(0, it['cutoff_turn'] - 3):it['cutoff_turn']]
    body = PICK + '\n\n【条目】\n' + '\n'.join(f"{i + 1}. [{f['kind']}] {f['text']}" for i, f in enumerate(cs)) + '\n\n【前几句】\n' + '\n'.join(f"他：{x['用户消息']}" for x in h) + f"\n\n【他刚说】{it['question']}"
    r = post('https://api.deepseek.com/chat/completions', {'model': 'deepseek-flash', 'messages': [{'role': 'user', 'content': body}], 'temperature': 0, 'max_tokens': 40, 'thinking': {'type': 'disabled'}}, {'authorization': f'Bearer {KEY}'}, 120)
    u = r.get('usage') or {}; use['in'] += u.get('prompt_tokens', 0); use['out'] += u.get('completion_tokens', 0)
    ids = [int(x) for x in re.findall(r'\d+', r['choices'][0]['message'].get('content') or '')][:4]
    p = [cs[i - 1] for i in ids if 1 <= i <= len(cs)]
    if p: R[it['id']]['v']['trig+pick'] = [' '.join(f['text'] for f in p[j:j + 2]) for j in range(0, len(p), 2)]
with cf.ThreadPoolExecutor(8) as ex: list(ex.map(llm, H.items))
print('flash pick: in', use['in'], 'out', use['out'], 'usd', round(use['in'] / 1e6 * .18 + use['out'] / 1e6 * .72, 3), flush=True)
rt = 0
for n, it in enumerate(H.items):   # the local reranker reads his message against the first 30 candidates
    cs = R[it['id']]['c'][:30]
    if not cs or not key[it['id']]['evidence_turns']: continue
    r = post('http://127.0.0.1:18890/rerank', {'model': 'onnx-community/bge-reranker-v2-m3-ONNX', 'query': it['question'], 'documents': [f['text'] for f in cs], 'top_n': 4}, {}, 600)
    rt += r['usage']['prompt_tokens']; p = [cs[x['index']] for x in r['results']]
    R[it['id']]['v']['trig+rerank'] = [' '.join(f['text'] for f in p[j:j + 2]) for j in range(0, len(p), 2)]
print('reranker tokens', rt, flush=True)
with open('v_k4_M01.jsonl', 'w', encoding='utf-8') as o:
    for i, r in R.items(): o.write(json.dumps({'id': i, 'variants': {n: {'more': m} for n, m in r['v'].items()}}, ensure_ascii=False) + '\n')

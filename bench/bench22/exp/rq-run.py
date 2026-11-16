#!/usr/bin/env python3
"""Retrieval only: one persona's history replayed through the real memory code with the fake model (no
paid call; the two banks and 还没了的事 are not real here, recall is), and at every dev question's cutoff
one retrieve per query variant.  Writes which turns reached the prompt; rq-cov.py reads it.
Needs local-models.mjs on :18890 (--embed-cache makes a second replay about twice as fast).
  rq-run.py M01 out.jsonl [variants.jsonl] [--memory '{"recallTopK":40}']
  variants.jsonl rows: {"id": ..., "variants": {"name": "query text" | {"q": "...", "more": ["...", ...]}}}
  ("more": other wordings fused with his words, recall.js query(more); "base" = the question, always run)
Env: BENCH22_DATASET (benchmark-2.2/dataset), RQ_HOMES (scratch), RQ_GATEWAY."""
import json, os, subprocess, sys, time
D = os.environ.get('BENCH22_DATASET', '/home/claude/chat-memory-benchmark/benchmark-2.2/dataset')
W = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'worker.mjs')
HOMES = os.environ.get('RQ_HOMES', '/tmp/rq-homes'); os.makedirs(HOMES, exist_ok=True)
persona, out = sys.argv[1], sys.argv[2]
vfile = sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].startswith('--') else None
mem = json.loads(sys.argv[sys.argv.index('--memory')+1]) if '--memory' in sys.argv else {}
jl = lambda p: [json.loads(l) for l in open(p, encoding='utf-8') if l.strip()]
key = {r['id']: r for r in jl(f'{D}/review-only/answer-key.jsonl')}
items = sorted([r for r in jl(f'{D}/exam-inputs.jsonl') if r['persona'] == persona], key=lambda r: (r['cutoff_turn'], r['id']))
hist = jl(f'{D}/histories/{persona}.jsonl')
variants = {r['id']: r['variants'] for r in jl(vfile)} if vfile else {}
tag = os.path.basename(out).replace('.jsonl', '')
home = f'{HOMES}/{tag}'
p = subprocess.Popen(['node', W], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(f'{HOMES}/{tag}.err', 'w'), text=True)
def call(o):
    p.stdin.write(json.dumps(o, ensure_ascii=False) + '\n'); p.stdin.flush()
    r = json.loads(p.stdout.readline())
    if not r['ok']: raise SystemExit(r['error'])
    return r['result']
print(call({'cmd': 'init', 'home': home + '/dot', 'dshHome': home + '/dsh-home', 'gateway': os.environ.get('RQ_GATEWAY', 'http://127.0.0.1:18890'), 'fake': True, 'memory': mem}).get('recall'), flush=True)
done, t0 = 0, time.time()
f = open(out, 'w', encoding='utf-8')
for n, it in enumerate(items, 1):
    c = it['cutoff_turn']
    if c > done:
        call({'cmd': 'ingest', 'turns': [{'turn': h['轮次'], 'time': h['逻辑时间'], 'user': h['用户消息'], 'assistant': h['助手回复']} for h in hist[done:c]], 'run': tag, 'system': 'x'}); done = c
    vs = {'base': it['question'], **variants.get(it['id'], {})}
    row = {'id': it['id'], 'cutoff': c, 'v': {}}
    for name, q in vs.items():
        more = []
        if isinstance(q, dict): q, more = q.get('q') or it['question'], q.get('more', [])
        r = call({'cmd': 'retrieve', 'question': q, 'now': it['now'], 'cutoff': c, 'more': more})
        row['v'][name] = {'recall': r['meta']['recall_turns'], 'used': r['used_turns'], 'chars': r['meta']['recall_chars'], 'cand': r['meta']['recall_candidates'], 'mode': r['meta']['recall_mode']}
    f.write(json.dumps(row, ensure_ascii=False) + '\n'); f.flush()
    if n % 40 == 0: print(persona, n, len(items), 'turn', done, round(time.time() - t0), 's', flush=True)
call({'cmd': 'status'}); p.stdin.write('{"cmd":"exit"}\n'); p.stdin.flush()
print('done', persona, round(time.time() - t0), 's', flush=True)

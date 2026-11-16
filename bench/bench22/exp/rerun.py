#!/usr/bin/env python3
"""Answer-only rerun: the stored prompts of a finished run (optionally with one piece of text changed,
see transforms.py) -> answer -> judge.  No ingest, no retrieval, so one condition costs a fraction of a
full run and two conditions differ only in the changed text.  The answering model is not deterministic
at temperature 0: the same prompts asked again flipped 15% of 269 verdicts (x0), so read differences
against a `--t base` rerun, not against the original answers alone.
Env: BENCH22_HARNESS (benchmark-2.2/harness), BENCH22_DATASET (benchmark-2.2/dataset), BENCH22_RUNS (.../runs/bench22).
  rerun.py main --src varE-short,varE-long --name X --t nosup --ids ids.json --gateway URL
  rerun.py nat  --src varE-nat --name X --t nosup [--ids ids.json] --gateway URL
"""
import argparse, concurrent.futures as cf, hashlib, json, os, sys, time
H = os.environ.get('BENCH22_HARNESS', os.path.expanduser('~/chat-memory-benchmark/benchmark-2.2/harness'))
sys.path.insert(0, H); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bench22 import runner, natural, scoring
from bench22.release import jl, load_histories, load_items
from bench22.systems import Gateway
import transforms
D = os.environ.get('BENCH22_DATASET', os.path.expanduser('~/chat-memory-benchmark/benchmark-2.2/dataset'))
RUNS = os.environ.get('BENCH22_RUNS', os.path.join(H, 'runs', 'bench22'))
def app(path, row):
    with open(path, 'a', encoding='utf-8') as f: f.write(json.dumps(row, ensure_ascii=False) + '\n')
def chat(gw, model, prompt, phase, tag, mx):
    for a in range(4):
        try: return gw.chat(model, [{"role": "user", "content": prompt}], phase, tag, temperature=0, max_tokens=mx, thinking={"type": "disabled"})
        except RuntimeError:
            if a == 3: raise
            time.sleep(5)

def main_(a):
    items = {i['id']: i for i in load_items(D) if i.get('split') == 'dev'}
    ids = set(json.load(open(a.ids))) if a.ids else None
    out = os.path.join(RUNS, a.name, 'dsh-dot', 'dev'); os.makedirs(out, exist_ok=True)
    ctx = {}
    for s in a.src.split(','):
        for r in jl(os.path.join(RUNS, s, 'dsh-dot', 'dev', 'contexts.jsonl')):
            if ids is None or r['id'] in ids: ctx[r['id']] = r
    ap, jp = os.path.join(out, 'answers.jsonl'), os.path.join(out, 'judgments.jsonl')
    done = {r['id'] for r in jl(jp)} if os.path.exists(jp) else set()
    def one(i):
        it, c = items[i], ctx[i]
        gw = Gateway(a.gateway, a.name, f"dsh-dot:{it['persona']}:dev", evaluator=True)
        p = transforms.apply(a.t, c['prompt'])
        r = chat(gw, runner.ANSWER_MODEL, p + f"\n\n【现在】{it['now']}\n用户：{it['question']}", 'answer', i, 700)
        ans = r["choices"][0]["message"].get("content") or ""
        j = None
        for _ in range(3):
            r2 = chat(gw, runner.JUDGE_MODEL, runner.judge_prompt(it, ans), 'judge', i, 700)
            try: j = runner.parse_json(r2["choices"][0]["message"].get("content")); break
            except ValueError: pass
        if j is None: j = {"required": [], "reason": "judge-format-failure"}
        app(ap, {"id": i, "answer": ans, "prompt_tokens": r["usage"]["prompt_tokens"], "prompt_len": len(p)})
        app(jp, {"id": i, "judge": j, "pass": scoring.judge_pass(j), "points": scoring.points(j)})
    todo = [i for i in ctx if i not in done and items[i].get('rubric')]
    with cf.ThreadPoolExecutor(a.workers) as ex:
        for n, f in enumerate(cf.as_completed([ex.submit(one, i) for i in todo]), 1):
            f.result()
            if n % 50 == 0: print(a.name, n, '/', len(todo), flush=True)
    J = jl(jp); print(a.name, 'done', len(J), 'pass', round(sum(r['pass'] for r in J) / max(1, len(J)), 3), flush=True)

def nat_(a):
    hist = load_histories(D)
    probes, key = natural.load_natural(D + '/natural', 'dev', 0)
    byid = {p['id']: p for p in probes}
    ids = set(json.load(open(a.ids))) if a.ids else None
    out = os.path.join(RUNS, a.name, 'dsh-dot', 'natural-dev'); os.makedirs(out, exist_ok=True)
    tp, jp = os.path.join(out, 'turns.jsonl'), os.path.join(out, 'judgments.jsonl')
    src = [r for r in jl(os.path.join(RUNS, a.src, 'dsh-dot', 'natural-dev', 'turns.jsonl')) if r['id'] in byid and (ids is None or r['id'] in ids)]
    by = {}
    for r in sorted(src, key=lambda r: (r['id'], r['k'])): by.setdefault(r['id'], []).append(r)
    done = {(r['id'], r['k']) for r in jl(jp)} if os.path.exists(jp) else set()
    idx = {pe: natural.HistoryIndex(hist[pe]) for pe in hist}
    def one(i):
        p, k = byid[i], key[i]; rows = []
        gw = Gateway(a.gateway, a.name, f"dsh-dot:{p['persona']}:natural-dev")
        gj = Gateway(a.gateway, a.name, "dsh-dot:judge:natural-dev")
        for n, r0 in enumerate(by[i]):
            row = dict(r0); row['prompt'] = transforms.apply(a.t, r0['prompt'])
            if (i, row['k']) in done: rows.append(row); continue
            r = chat(gw, natural.ANSWER_MODEL, natural.answer_prompt(row['prompt'], row['time'], row['user']), 'answer', f"{i}#{row['k']}", 500)
            row['answer'] = r["choices"][0]["message"].get("content") or ""
            j = natural.judge_turn(gj, p, k, rows, row, idx[p['persona']], f"{i}#{row['k']}")
            app(tp, row); app(jp, {"id": i, "k": row['k'], "judge": j, "score": natural.turn_score(k, j)})
            rows.append(row)
    with cf.ThreadPoolExecutor(a.workers) as ex: list(ex.map(one, list(by)))
    if ids is None:
        agg, sc = natural.aggregate(probes, key, jl(jp), jl(tp))
        s = {k: agg[k] for k in ('A_nat', 'R_side', 'P_side', 'by_class', 'recall_rate', 'restraint_rate', 'fabrication_rate')}
        json.dump(agg, open(os.path.join(out, 'summary.json'), 'w'), ensure_ascii=False); print(a.name, json.dumps(s, ensure_ascii=False), flush=True)
    else: print(a.name, 'done', flush=True)

ap = argparse.ArgumentParser(); ap.add_argument('mode'); ap.add_argument('--src'); ap.add_argument('--name'); ap.add_argument('--t', default='base')
ap.add_argument('--ids'); ap.add_argument('--gateway', default='http://127.0.0.1:18885/v1'); ap.add_argument('--workers', type=int, default=6)
a = ap.parse_args(); (main_ if a.mode == 'main' else nat_)(a)

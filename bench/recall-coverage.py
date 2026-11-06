"""Recall coverage on Ornn8/chat-memory-benchmark, from a run made with --save-prompts (no grading, no model).

For every question, each evidence turn (answer-key anchors[].last_turn) is classed as
  window   — one of the last WINDOW turns the exam shows anyway,
  injected — in the recalled turns put in front of her,
  cand     — in the candidate pool (vector + BM25) but not injected (cut by the reranker / budget),
  miss     — not even a candidate.
Rows written by bench/chat-memory-benchmark.mjs ≥ 0.20 carry the recalled and candidate turn times
("recall": {"hits": [ms], "candidates": [ms]}); older runs are matched by the evidence text in the
recalled block (candidates unknown).

Groups: every content tag of the answer key, multi-evidence questions (≥ 2 anchors), and
"low overlap": evidence turns whose user message shares the fewest character bigrams with the
question (bottom quarter) — a proxy for aliases and paraphrase, which word matching cannot bridge.

usage: python3 -I bench/recall-coverage.py <dataset dir> <run dir> [<run dir> …] [--window 6]
       (a run dir holds prompts.jsonl, or personas whose dirs hold one)
"""
import collections as C
import datetime as dt
import glob
import json
import os
import re
import sys

args = [a for a in sys.argv[1:] if not a.startswith('--')]
WINDOW = 6
if '--window' in sys.argv:
    WINDOW = int(sys.argv[sys.argv.index('--window') + 1])
    args = [a for a in args if a != str(WINDOW)]
ds, runs = args[0], args[1:]

key = {}
for l in open(os.path.join(ds, 'review-only/answer-key.jsonl'), encoding='utf-8'):
    j = json.loads(l)
    key[j['id']] = j
exam = {}
for l in open(os.path.join(ds, 'exam-inputs.jsonl'), encoding='utf-8'):
    j = json.loads(l)
    exam[j['id']] = j
hist = {}
for f in glob.glob(os.path.join(ds, 'histories/*.jsonl')):
    p = os.path.basename(f)[:-6]
    hist[p] = {}
    for l in open(f, encoding='utf-8'):
        r = json.loads(l)
        r['ms'] = int(dt.datetime.fromisoformat(r['逻辑时间']).timestamp() * 1000)
        hist[p][r['轮次']] = r

norm = lambda s: re.sub(r'\s+', '', s)
def bigrams(s):
    s = re.sub(r'[^\w]', '', s)
    return {s[i:i + 2] for i in range(len(s) - 1)}
def overlap(q, t):
    a, b = bigrams(q), bigrams(t)
    return len(a & b) / max(1, len(a))

# The low-overlap group: bottom quarter of (question, evidence) overlap over the whole key.
ov = {}
for qid, k in key.items():
    p = qid[:3]
    for a in k['anchors']:
        t = hist[p].get(a['last_turn'])
        if t:
            ov[(qid, a['last_turn'])] = overlap(exam[qid]['question'], t['用户消息'])
cut = sorted(ov.values())[len(ov) // 4] if ov else 0
HDR = '你记得的相关原话'

def text(m):
    c = m['content']
    return c if isinstance(c, str) else ''.join(x.get('text', '') for x in c)

def classify(run):
    files = sorted(glob.glob(os.path.join(run, 'prompts.jsonl')) + glob.glob(os.path.join(run, '*/prompts.jsonl')))
    out = []  # (qid, anchor turn, class)
    for f in files:
        for l in open(f, encoding='utf-8'):
            r = json.loads(l)
            qid = r['id']
            k, e = key[qid], exam[qid]
            p = qid[:3]
            cutoff = e['cutoff_turn']
            rec = r.get('recall')
            sysm = text(r['messages'][0])
            i = sysm.rfind(HDR)
            block = norm(sysm[i:]) if i >= 0 else ''
            for a in k['anchors']:
                t = hist[p].get(a['last_turn'])
                if not t:
                    continue
                if a['last_turn'] > cutoff - WINDOW:
                    cls = 'window'
                elif rec is not None:
                    cls = 'injected' if t['ms'] in set(rec.get('hits', [])) else ('cand' if t['ms'] in set(rec.get('candidates', [])) else 'miss')
                else:
                    cls = 'injected' if norm(t['用户消息'])[:30] in block else 'miss?'
                out.append((qid, a['last_turn'], cls))
    return out

def rate(rows):
    n = len(rows)
    if not n:
        return '-'
    c = C.Counter(x[2] for x in rows)
    got = c['window'] + c['injected']
    cand = got + c['cand']
    s = f"{100 * got / n:5.1f}%"
    if any(x[2] in ('cand', 'miss') for x in rows):
        s += f" (cand {100 * cand / n:5.1f}%)"
    return s + f" n={n}"

for run in runs:
    rows = classify(run)
    if not rows:
        print(f'\n== {run}: no prompts.jsonl'); continue
    byq = C.defaultdict(list)
    for r in rows:
        byq[r[0]].append(r)
    c = C.Counter(r[2] for r in rows)
    print(f"\n== {os.path.basename(run.rstrip('/'))}: {len(byq)} questions, {len(rows)} evidence turns · " + ' · '.join(f'{k} {v}' for k, v in sorted(c.items())))
    print(f"  all evidence covered (window+injected): {rate(rows)}")
    outside = [r for r in rows if r[2] != 'window']
    print(f"  outside the window only:              {rate(outside)}")
    full = sum(1 for q, rs in byq.items() if all(x[2] in ('window', 'injected') for x in rs))
    print(f"  questions with every anchor covered:  {100 * full / len(byq):5.1f}%")
    groups = C.defaultdict(list)
    for r in outside:
        for g in key[r[0]]['content_tags']:
            groups[g].append(r)
        if len(key[r[0]]['anchors']) >= 2:
            groups['[multi-evidence]'].append(r)
        if ov.get((r[0], r[1]), 1) <= cut:
            groups['[low overlap]'].append(r)
        groups[f"[{key[r[0]]['interval_days']} 天]"].append(r)
    for g, rs in sorted(groups.items(), key=lambda x: (not x[0].startswith('['), x[0])):
        print(f"    {g:<14} {rate(rs)}")

#!/usr/bin/env python3
"""One write call per 60 turns of his words: each fact strip with the situations it should come to mind in.
No keys, no kinds. Lines out, not JSON:  #turn｜fact in one sentence｜situation；situation；situation
  write2.py M01 [--both]  -> w2_<P>.jsonl   (--both: her replies are read too)"""
import concurrent.futures as cf, json, os, re, sys, time, urllib.request
D = __import__('os').environ.get('BENCH22_DATASET', '/home/claude/chat-memory-benchmark/benchmark-2.2/dataset'); P = sys.argv[1]; BOTH = '--both' in sys.argv
KEY = os.environ['DEEPSEEK_API_KEY']
jl = lambda p: [json.loads(l) for l in open(p, encoding='utf-8') if l.strip()]
hist = jl(f'{D}/histories/{P}.jsonl')
RULES = """下面是一段聊天记录里他说的话，每行开头的 #数字 是这一轮的编号。
把这段里以后接他的话用得上的事写成事实条，每条一行，三段用"｜"隔开：
#出自哪一轮的编号｜一句话，用他的原词，带上名字、数目、日子｜以后什么时候该想起这条：2 到 3 个情境，用"；"隔开，每个十几个字以内
只记以后用得上的：他说了别提、别做的事，答应的、欠着的、约好的、有期限的事，谁爱什么不爱什么、习惯怎样，谁现在怎么样、发生过什么值得记的事。寒暄、当时的心情、随口一句不记。一轮里有几件就写几行，没有就不写。
情境写成他到时候会说的事、会做的打算（会用到它、会踩到它、会和它冲突的场合），带上这条里的人名或东西名，不要把事实再说一遍。
例：#12｜老周对花生过敏｜要和老周一起吃饭点菜；想给老周带零食；老周吃了东西不舒服
没说的不编，数目和日子照他说的写。只输出这些行。"""
def one(k):
    h = hist[k:k + 60]
    body = '\n'.join(f"#{x['轮次']} [{x['逻辑时间'][5:16].replace('T', ' ')}] {x['用户消息']}" + (f"\n（她回：{x['助手回复']}）" if BOTH else '') for x in h)
    req = json.dumps({'model': 'deepseek-flash', 'messages': [{'role': 'user', 'content': f'{RULES}\n\n{body}'}], 'temperature': 0, 'max_tokens': 6000, 'thinking': {'type': 'disabled'}}).encode()
    for a in range(4):
        try: r = json.load(urllib.request.urlopen(urllib.request.Request('https://api.deepseek.com/chat/completions', req, {'content-type': 'application/json', 'authorization': f'Bearer {KEY}'}), timeout=300)); break
        except Exception:
            if a == 3: raise
            time.sleep(6 * (a + 1))
    lo, hi = h[0]['轮次'], h[-1]['轮次']; out = []
    for line in (r['choices'][0]['message'].get('content') or '').split('\n'):
        m = re.match(r'\s*#(\d+)\s*[｜|]\s*(.+?)\s*[｜|]\s*(.+)$', line)
        if m and lo <= int(m.group(1)) <= hi: out.append({'t': int(m.group(1)), 'text': m.group(2), 'trig': [x.strip() for x in re.split(r'[；;]', m.group(3)) if x.strip()][:3]})
    return {'from': lo, 'to': hi, 'facts': out, 'finish': r['choices'][0].get('finish_reason'), 'usage': r.get('usage')}
with cf.ThreadPoolExecutor(8) as ex: R = list(ex.map(one, range(0, len(hist), 60)))
with open(f'w2_{P}.jsonl', 'w', encoding='utf-8') as f:
    for r in R: f.write(json.dumps(r, ensure_ascii=False) + '\n')
u = [r['usage'] or {} for r in R]; i, o, hit = (sum(x.get(k, 0) for x in u) for k in ('prompt_tokens', 'completion_tokens', 'prompt_cache_hit_tokens'))
print(P, 'calls', len(R), 'strips', sum(len(r['facts']) for r in R), 'cut', sum(r['finish'] == 'length' for r in R), '| in', i, 'out', o, f"| cost ${(i - hit) / 1e6 * .15 + hit / 1e6 * .003 + o / 1e6 * .6:.3f}–{(i - hit) / 1e6 * .3 + hit / 1e6 * .006 + o / 1e6 * 1.2:.3f}", '| at the benchmark list price the output alone: ¥%.2f' % (o / 1e6 * .72 * 7.2))

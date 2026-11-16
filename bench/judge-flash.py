# A stand-in for the Codex judging of chat-memory-benchmark 1.0: one deepseek-flash call per packet (no thinking).
# python3 bench/judge-flash.py packets.jsonl reviews.jsonl [ids.json]   then grading/grade.py score as usual.
# On 152 answers Codex had judged (dsh-neo4j, 2026-11-05) it agreed on 137; it failed 11 of 120 Codex passes and passed 4 of 32 Codex fails.
import json, sys, os, time, concurrent.futures as cf, urllib.request
KEY=os.environ['DEEPSEEK_API_KEY']
PROMPT=open(os.environ['CMB_JUDGE_PROMPT'],encoding='utf-8').read()   # …/chat-memory-benchmark/grading/judge-prompt.md
FLAGS=['错认','错否','越界','编造日期','不当私事披露']; LISTS=['违反禁止','未知当事实','无关旧事']
def call(packet):
    body={"model":"deepseek-flash","temperature":0,"max_tokens":1200,"thinking":{"type":"disabled"},"response_format":{"type":"json_object"},
          "messages":[{"role":"system","content":PROMPT+"\n\n这次只给一道题，只输出这一题的一个 JSON 对象。"},{"role":"user","content":json.dumps(packet,ensure_ascii=False)}]}
    for attempt in range(4):
        try:
            req=urllib.request.Request('https://api.deepseek.com/chat/completions',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+KEY,'Content-Type':'application/json'})
            r=json.load(urllib.request.urlopen(req,timeout=120))
            j=json.loads(r['choices'][0]['message']['content'])
            req_=j.get('required')
            n_=len(packet['rubric']['required'])
            if isinstance(req_,list) and req_ and all(type(v) is bool for v in req_) and len(req_)!=n_ and (n_==1 or attempt>=2):
                j['required']=req_=[all(req_)]*n_      # an item split or merged by the judge: passing needs every part anyway
            if not (isinstance(req_,list) and len(req_)==n_ and all(type(v) is bool for v in req_)): raise ValueError('required')
            for k in FLAGS:
                if type(j.get(k)) is not bool: raise ValueError(k)
            for k in LISTS:
                v=j.get(k)
                if not isinstance(v,list): raise ValueError(k)
                j[k]=[str(x) for x in v if str(x).strip()]
            if not str(j.get('reason','')).strip(): raise ValueError('reason')
            j['id'],j['answer_sha256'],j['rubric_sha256']=packet['id'],packet['answer_sha256'],packet['rubric_sha256']
            return j, r.get('usage',{})
        except Exception as e:
            err=e; time.sleep(2+3*attempt)
    raise RuntimeError(f"{packet['id']}: {err}")
def main(packets, out, only=None):
    ps=[json.loads(l) for l in open(packets,encoding='utf-8')]
    if only: ids=set(json.load(open(only))); ps=[p for p in ps if p['id'] in ids]
    done=set()
    if os.path.exists(out): done={json.loads(l)['id'] for l in open(out,encoding='utf-8')}
    todo=[p for p in ps if p['id'] not in done]; tin=tout=0
    with cf.ThreadPoolExecutor(10) as ex, open(out,'a',encoding='utf-8') as f:
        for n,(j,u) in enumerate(ex.map(call,todo),1):
            f.write(json.dumps(j,ensure_ascii=False)+'\n'); f.flush(); tin+=u.get('prompt_tokens',0); tout+=u.get('completion_tokens',0)
            if n%100==0: print(n,len(todo),flush=True)
    print('judged',len(todo),'in',tin,'out',tout)
main(*sys.argv[1:])

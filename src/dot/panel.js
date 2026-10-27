// dsh-dot/dot panel: one read-only page about her — devices, where her life stands, today's
// numbers, what she remembers, her diary, the last two passages of her script — served on dsh's
// own web server (`/dsh-dot/panel/`), so the "dot" sidebar tab is an iframe of the same origin and
// nothing new listens on a port. The page is one file with no dependencies, like the phone's live
// view; it polls `/dsh-dot/panel/api/state` every 3 s while visible. The layout follows what the
// companion consoles around dsh show (NimuQDock's overview row, qq-bridge's number tiles,
// companion-core's diary list); nothing here can change her — actions stay in /dot, /interlude.

import { rejectUnlessOwner } from '../web-auth.js';

export const PANEL_PATH = '/dsh-dot/panel'; // the phone's live view is /dsh-dot/phone; prefixes must not nest

/** Everything the page shows, gathered from the services that exist right now. */
export async function collectState(ctx) {
  const get = (n) => { try { return ctx.get(n); } catch (error) { void error; return undefined; } };
  const dot = get('dshDot');
  const phone = get('dshPhone');
  const qq = get('dshQq');
  const computer = get('dshComputer');
  const interlude = get('dshInterlude');
  const memory = get('dotMemory');
  const safe = async (fn) => { try { return await fn(); } catch (error) { return { error: String(error?.message ?? error) }; } };
  return {
    at: Date.now(),
    devices: {
      phone: phone ? await safe(() => phone.status()) : null,
      qq: qq ? await safe(() => qq.status()) : null,
      computer: computer ? await safe(() => computer.status()) : null,
    },
    dot: dot ? { session: dot.session?.() || '', errand: dot.errandId?.() || '', today: dot.stats?.() ?? null } : null,
    interlude: interlude ? await safe(() => interlude.status()) : null,
    memory: memory ? await safe(() => memory.panel()) : null,
  };
}

/** The page. */
export function pageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dot</title>
<style>
:root{color-scheme:light dark;--fg:#222;--mute:#777;--bg:#fafafa;--card:#fff;--line:#e3e3e3;--ok:#2e9e5b;--warn:#d98a1a;--bad:#c94a4a;--bar:#4a7fd6}
@media (prefers-color-scheme:dark){:root{--fg:#ddd;--mute:#888;--bg:#161616;--card:#1f1f1f;--line:#333;--bar:#6a9bea}}
html,body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
main{padding:10px;display:grid;gap:10px;max-width:720px;margin:0 auto}
.row{display:flex;flex-wrap:wrap;gap:6px}
.badge{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border:1px solid var(--line);border-radius:999px;background:var(--card);white-space:nowrap}
.dotc{width:8px;height:8px;border-radius:50%;background:var(--mute)}.ok .dotc{background:var(--ok)}.warn .dotc{background:var(--warn)}.bad .dotc{background:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
h2{font-size:12px;font-weight:600;color:var(--mute);margin:0 0 6px;letter-spacing:.04em}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:8px}
.tile{text-align:center}.tile b{display:block;font-size:20px;font-weight:600;line-height:1.1}.tile span{color:var(--mute);font-size:11px}
.bar{height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin:4px 0}.bar i{display:block;height:100%;background:var(--bar)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px}.kv span:first-child{color:var(--mute);white-space:nowrap}
.mute{color:var(--mute)}.pre{white-space:pre-wrap;word-break:break-word}
ul{margin:4px 0;padding-left:18px}li{margin:2px 0}
details summary{cursor:pointer;color:var(--mute)}
#err{color:var(--bad)}
</style></head><body><main>
<div class="row" id="badges"></div>
<div class="card"><h2>她现在</h2><div id="now"></div></div>
<div class="card"><h2>今天</h2><div class="tiles" id="today"></div></div>
<div class="card"><h2>记忆</h2><div id="memory"></div></div>
<div class="card"><h2>日记</h2><div id="diary"></div></div>
<div class="card"><h2>剧本</h2><div id="script"></div></div>
<div class="mute" id="foot"></div><div id="err"></div>
</main>
<script>
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s??'').replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=(n)=>Number(n??0).toLocaleString('zh-CN');
const ago=(ms)=>{if(!ms)return '';const d=Date.now()-ms;const m=Math.round(d/60000);if(m<1)return '刚才';if(m<60)return m+' 分钟前';const h=Math.round(m/60);if(h<48)return h+' 小时前';return Math.round(h/24)+' 天前'};
const at=(ms)=>ms?new Date(ms).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
const badge=(cls,label,text)=>'<span class="badge '+cls+'"><i class="dotc"></i>'+esc(label)+(text?' <span class="mute">'+esc(text)+'</span>':'')+'</span>';
const tile=(n,label)=>'<div class="tile"><b>'+esc(n)+'</b><span>'+esc(label)+'</span></div>';
const bar=(v,max)=>'<div class="bar"><i style="width:'+Math.min(100,Math.round(100*(v||0)/(max||1)))+'%"></i></div>';
function render(s){
  const d=s.devices||{}, it=s.interlude, m=s.memory, dot=s.dot;
  let b='';
  if(d.phone) b+=badge(d.phone.state==='ready'?'ok':d.phone.error?'bad':'warn','手机',d.phone.state==='ready'?'就绪':(d.phone.state||''));
  if(d.qq) b+=badge(d.qq.connected?'ok':d.qq.error?'bad':'warn','电脑 QQ',d.qq.connected?(d.qq.selfId||'在线'):(d.qq.state||'离线'));
  const cstate={ready:'就绪',starting:'启动中',remounting:'换绑中','shell-only':'只有 shell',error:'出错'};
  if(d.computer) b+=badge(d.computer.state==='ready'?'ok':d.computer.state==='error'?'bad':'warn','电脑',cstate[d.computer.state]||d.computer.state||'');
  if(m&&m.conversation) b+=badge(m.conversation.session?'ok':'warn','她的对话','第 '+m.gen+' 段 · '+fmt(m.conversation.tokens)+' / '+fmt(m.conversation.handoffAt)+' token');
  $('badges').innerHTML=b||'<span class="mute">没有组件在线</span>';
  if(it){
    const st=it.state||{};
    let h='<div class="kv">';
    h+='<span>此刻</span><span>'+esc(st.current||'（还没有幕间）')+'</span>';
    if(st.salient&&st.salient.length) h+='<span>挂念</span><span>'+st.salient.map(esc).join('；')+'</span>';
    if(it.intents&&it.intents.length) h+='<span>打算</span><span><ul>'+it.intents.map(i=>'<li>'+esc(at(Date.parse(i.at)))+' · '+esc(i.text)+'</li>').join('')+'</ul></span>';
    h+='<span>上一幕</span><span>'+esc(ago(it.cursor))+(it.nextAdvanceAt?' <span class="mute">· 下一次独立推进约 '+esc(at(it.nextAdvanceAt))+'</span>':'')+'</span>';
    h+='</div>';
    $('now').innerHTML=h;
  } else $('now').innerHTML='<span class="mute">幕间未加载</span>';
  let t='';
  if(it){t+=tile(it.today.rounds+(it.today.maxRounds?'/'+it.today.maxRounds:''),'幕间轮')+tile(it.today.plays,'玩')+tile(it.today.browses,'去看')+tile(it.today.contacts,'找你');}
  if(dot&&dot.today){t+=tile(dot.today.woke,'通知叫醒')+tile(dot.today.owner,'你的消息');}
  const tin=(it?it.today.tokensIn:0)+(m?m.ledger.in:0), tout=(it?it.today.tokensOut:0)+(m?m.ledger.out:0);
  t+=tile(fmt(tin),'token 入')+tile(fmt(tout),'token 出');
  $('today').innerHTML=t;
  if(m){
    let h='<div class="kv">';
    h+='<span>关于你</span><span>'+m.owner.entries.length+' 条 · '+m.owner.chars+'/'+m.owner.limit+' 字'+bar(m.owner.chars,m.owner.limit)+'</span>';
    h+='<span>她自己</span><span>'+m.self.entries.length+' 条 · '+m.self.chars+'/'+m.self.limit+' 字'+bar(m.self.chars,m.self.limit)+'</span>';
    h+='<span>认识的人</span><span>'+m.people+(m.contacts?' <span class="mute">(+'+m.contacts+' 好友没说过话)</span>':'')+(m.pending?' · 待核实 '+m.pending:'')+(m.merges?' · 待确认合并 '+m.merges:'')+'</span>';
    h+='<span>碎片</span><span>'+m.fragments+' · 距下次整理还有 '+m.sinceCursor+' 条 · 整理过 '+m.consolidations+' 次</span>';
    h+='</div>';
    if(m.self.entries.length) h+='<details><summary>她自己记下的</summary><ul>'+m.self.entries.map(e=>'<li>'+esc(e)+'</li>').join('')+'</ul></details>';
    $('memory').innerHTML=h;
    if(m.diary&&m.diary.length){
      const [first,...rest]=m.diary;
      let dh='<div><b>'+esc(first.day)+'</b><div class="pre">'+esc(first.text)+'</div></div>';
      if(rest.length) dh+='<details><summary>往前翻 '+rest.length+' 篇</summary>'+rest.map(e=>'<div style="margin-top:8px"><b>'+esc(e.day)+'</b><div class="pre">'+esc(e.text)+'</div></div>').join('')+'</details>';
      $('diary').innerHTML=dh;
    } else $('diary').innerHTML='<span class="mute">还没有日记（每天 '+esc(m.dailyAt)+' 写）</span>';
  } else {$('memory').innerHTML='<span class="mute">记忆未加载</span>';$('diary').innerHTML='';}
  if(it&&it.script&&it.script.length){
    $('script').innerHTML=it.script.slice().reverse().map(e=>'<div style="margin-bottom:8px"><b class="mute">'+esc(e.head)+'</b><div class="pre">'+esc(e.text)+'</div></div>').join('');
  } else $('script').innerHTML='<span class="mute">还没有剧本</span>';
  $('foot').textContent='更新于 '+new Date(s.at).toLocaleTimeString('zh-CN');
}
async function tick(){
  if(document.hidden) return;
  try{const r=await fetch('api/state',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);render(await r.json());$('err').textContent='';}
  catch(e){$('err').textContent='读取状态失败：'+e.message}
}
tick();setInterval(tick,3000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick()});
</script></body></html>`;
}

/** Mount the page and its JSON on dsh's web server. Returns the dispose function. */
export function mountPanel(ctx, webServer, logger, connection = ctx.get?.('connection')) {
  const html = pageHtml();
  return webServer.register({
    kind: 'prefix', path: PANEL_PATH,
    handler: async (req, res) => {
      // dsh's own login and Host/Origin fence decide who may read about her (src/web-auth.js).
      if (rejectUnlessOwner(connection, req, res)) return;
      let url;
      try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch (error) { void error; res.writeHead(400).end(); return; }
      const sub = url.pathname.slice(PANEL_PATH.length);
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      if (sub === '' || sub === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html); return; }
      if (sub === '/api/state') {
        try { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(await collectState(ctx))); }
        catch (err) { logger?.warn?.(`panel state failed: ${err.message}`); res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message })); }
        return;
      }
      res.writeHead(404).end();
    },
  });
}

// dsh-dot/phone live view: a small HTTP page on 127.0.0.1 that shows the phone's screen as it
// changes and lets a person tap, swipe, type and press keys — the phone's noVNC. It is how you log
// her into an app from the dsh "Phone" tab (or from your own phone over tailscale) without the
// emulator window, and how you see what she is doing. Frames are PNG screencaps over adb, pushed as
// a multipart stream a few times a second; input goes back through `adb shell input`.
import http from 'node:http';

export const LIVE_VIEW_PATH = '/';

/** HTML of the page. One file, no dependencies; the stream and input endpoints are relative. */
export function pageHtml({ name = 'dot', fps = 2 }) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} · phone</title>
<style>
html,body{margin:0;height:100%;background:#111;color:#ddd;font:13px/1.4 system-ui,sans-serif}
#wrap{display:flex;flex-direction:column;height:100%}
#bar{display:flex;gap:6px;align-items:center;padding:6px 8px;background:#1c1c1c;border-bottom:1px solid #333}
#bar button,#bar input{background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px 8px;font:inherit}
#bar input{flex:1;min-width:60px}
#stage{flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative}
#screen{max-width:100%;max-height:100%;object-fit:contain;touch-action:none;cursor:crosshair;user-select:none;-webkit-user-drag:none}
#status{color:#888;margin-left:auto;white-space:nowrap}
</style></head><body><div id="wrap">
<div id="bar">
<button data-key="KEYCODE_BACK" title="返回">←</button><button data-key="KEYCODE_HOME" title="主页">●</button><button data-key="KEYCODE_APP_SWITCH" title="最近">▭</button>
<input id="text" placeholder="输入文字后回车发送到手机"><button id="send">发送</button><button id="enter" title="回车">⏎</button>
<span id="status">connecting…</span>
</div>
<div id="stage"><img id="screen" src="stream?fps=${fps}" alt="phone screen" draggable="false"></div>
</div>
<script>
const img=document.getElementById('screen'),status=document.getElementById('status'),text=document.getElementById('text');
const post=(path,body)=>fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.ok?status.textContent='ok':status.textContent='error '+r.status).catch(()=>status.textContent='offline');
const norm=(e)=>{const r=img.getBoundingClientRect();return {x:Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),y:Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))}};
let down=null;
img.addEventListener('pointerdown',(e)=>{down={...norm(e),t:Date.now()};img.setPointerCapture(e.pointerId);e.preventDefault()});
img.addEventListener('pointerup',(e)=>{if(!down)return;const up=norm(e);const dt=Date.now()-down.t;const dist=Math.hypot(up.x-down.x,up.y-down.y);
 if(dist<0.02){post('tap',{x:down.x,y:down.y,ms:dt>500?dt:0})}else{post('swipe',{from:down,to:up,ms:Math.max(100,Math.min(dt,1500))})}down=null;e.preventDefault()});
document.querySelectorAll('[data-key]').forEach(b=>b.addEventListener('click',()=>post('key',{key:b.dataset.key})));
const sendText=()=>{if(!text.value)return;post('text',{text:text.value});text.value=''};
document.getElementById('send').addEventListener('click',sendText);
document.getElementById('enter').addEventListener('click',()=>post('key',{key:'KEYCODE_ENTER'}));
text.addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();sendText()}});
img.addEventListener('load',()=>status.textContent='live');img.addEventListener('error',()=>{status.textContent='reconnecting…';setTimeout(()=>{img.src='stream?fps=${fps}&r='+Date.now()},2000)});
</script></body></html>`;
}

/**
 * Start the live view server.
 * @param {object} o
 * @param {number} o.port - listen port on 127.0.0.1.
 * @param {() => Promise<Buffer>} o.screenshot - PNG of the screen now.
 * @param {(cmd: string) => Promise<string>} o.shell - `adb shell <cmd>`.
 * @param {() => boolean} o.ready - whether the phone answers.
 * @param {object} o.logger
 * @param {string} [o.name]
 * @returns {{ url: string, close: () => void }}
 */
export function startLiveView({ port, screenshot, shell, ready, logger, name = 'dot' }) {
  let size = null; // { w, h } in pixels, read once from the device
  const screenSize = async () => {
    if (size) return size;
    const m = /(\d+)x(\d+)/.exec(await shell('wm size'));
    size = m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1080, h: 2400 };
    return size;
  };
  const px = async ({ x, y }) => { const s = await screenSize(); return [Math.round(x * s.w), Math.round(y * s.h)]; };
  const json = (req) => new Promise((resolve, reject) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 65536) reject(new Error('too large')); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } }); });
  // Only the page itself may post input (same-origin fetch); nothing else on the machine should drive her phone.
  const sameOrigin = (req) => { const o = req.headers.origin ?? req.headers.referer ?? ''; return !o || o.startsWith(`http://127.0.0.1:${port}`) || o.startsWith(`http://localhost:${port}`) || Boolean(req.headers['x-forwarded-host']); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(pageHtml({ name })); }
      if (req.method === 'GET' && url.pathname === '/status') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ ready: ready(), size })); }
      if (req.method === 'GET' && url.pathname === '/screenshot.png') { const png = await screenshot(); res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); return res.end(png); }
      if (req.method === 'GET' && url.pathname === '/stream') {
        const fps = Math.min(5, Math.max(0.5, Number(url.searchParams.get('fps')) || 2));
        res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame', 'cache-control': 'no-store', connection: 'keep-alive' });
        let open = true;
        req.on('close', () => { open = false; });
        while (open) {
          const started = Date.now();
          if (ready()) {
            try { const png = await screenshot(); if (!open) break; res.write(`--frame\r\ncontent-type: image/png\r\ncontent-length: ${png.length}\r\n\r\n`); res.write(png); res.write('\r\n'); } catch (err) { logger.debug?.(`live view frame failed: ${err.message}`); }
          }
          await new Promise((r) => setTimeout(r, Math.max(50, 1000 / fps - (Date.now() - started))));
        }
        return res.end();
      }
      if (req.method === 'POST') {
        if (!sameOrigin(req)) { res.writeHead(403); return res.end(); }
        if (!ready()) { res.writeHead(503); return res.end('phone not ready'); }
        const body = await json(req);
        if (url.pathname === '/tap') { const [x, y] = await px(body); await shell(body.ms > 0 ? `input swipe ${x} ${y} ${x} ${y} ${Math.round(body.ms)}` : `input tap ${x} ${y}`); }
        else if (url.pathname === '/swipe') { const [x1, y1] = await px(body.from); const [x2, y2] = await px(body.to); await shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${Math.round(body.ms ?? 300)}`); }
        else if (url.pathname === '/key') { if (!/^KEYCODE_[A-Z0-9_]+$/.test(String(body.key))) { res.writeHead(400); return res.end(); } await shell(`input keyevent ${body.key}`); }
        else if (url.pathname === '/text') { await shell(`input text ${shellQuote(String(body.text ?? ''))}`); }
        else { res.writeHead(404); return res.end(); }
        res.writeHead(204); return res.end();
      }
      res.writeHead(404); res.end();
    } catch (err) { logger.warn?.(`live view: ${err.message}`); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  server.listen(port, '127.0.0.1');
  server.on('error', (err) => logger.warn?.(`live view port ${port}: ${err.message}`));
  return { url: `http://127.0.0.1:${port}${LIVE_VIEW_PATH}`, close: () => server.close() };
}

/** `adb shell input text` wants spaces as %s and shell metacharacters escaped. ASCII only reaches the device reliably; CJK goes through the clipboard route the model uses. */
export function shellQuote(text) {
  return `'${text.replace(/'/g, `'\\''`).replace(/ /g, '%s')}'`;
}

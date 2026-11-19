// dsh-dot/phone live view: a page that shows the phone's screen as it changes and lets a person
// tap, swipe, type and press keys — the phone's noVNC. It is how you log her into an app from the
// dsh "Phone" tab (or from your own phone, through your own dsh exposure) without the emulator
// window, and how you see what she is doing. Input goes back through `adb shell input`.
//
// Frames are pulled, never pushed: the page asks for "a frame newer than the one I have"
// (GET frame?after=<seq>) and asks again only after it has drawn the answer. One request carries one
// whole picture and ends. So the page holds one frame at a time, a connection buffers one frame at
// most, and a slow or hidden page simply asks less often — nothing can pile up on either side.
// (Through 0.24.0 this was a multipart/x-mixed-replace stream into an <img>. One part that was not a
// picture — screencap answering with nothing while the emulator was offline — made Chromium keep
// every later byte of the stream in memory without telling the page, until the renderer of the
// whole dsh window died at 2 GB.)
//
// Where frames come from is this module's own business, behind that one request:
//   - the phone's screen stream (mobilecli `screencapture --format mjpeg`, JPEG frames as the screen
//     changes) when the phone gives one — smooth;
//   - else whole-screen PNG screencaps over adb, paced by how long a capture takes.
// Either source runs only while somebody is asking for frames, and only pictures are published.
//
// It is mounted on dsh's own web server at /dsh-dot/phone/ and every request — the page, each
// frame, each tap — is gated by dsh's connection service (src/web-auth.js): the signed-in owner
// of this dsh, on dsh's own origin, and nobody else. There is no port of its own and no
// same-origin guesswork; a forwarded header buys nothing.
import { rejectUnlessOwner } from '../web-auth.js';

export const LIVE_VIEW_PATH = '/dsh-dot/phone';

/** How long a frame request waits for a newer frame before it is answered "nothing new" (204). */
const WAIT_MS = 25_000;
/** A source keeps running this long after the last frame request, so a page between two requests does not stop it. */
const IDLE_MS = 5_000;
/** A screen stream that has shown no picture this long after starting is not one; screencaps take over. */
const STREAM_FIRST_FRAME_MS = 8_000;
/** After a screen stream failed, it is tried again this much later (the phone may have been restarting). */
const STREAM_RETRY_MS = 120_000;
/** The largest single picture taken from a screen stream; more than this without a whole picture is not a picture stream. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** `image/png` / `image/jpeg` when `buf` starts as that kind of picture with a size, else ''. */
export function pictureType(buf) {
  if (!Buffer.isBuffer(buf)) return '';
  if (buf.length >= 33 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString('latin1', 12, 16) === 'IHDR' && buf.readUInt32BE(16) > 0 && buf.readUInt32BE(20) > 0) return 'image/png';
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9) return 'image/jpeg';
  return '';
}

/**
 * Cut whole JPEG pictures out of a byte stream, whatever stands between them (multipart boundaries
 * and headers, or nothing). A picture is found by its own structure — SOI, the marker segments by
 * their lengths, then the scan up to EOI — so bytes that merely look like a marker inside a segment
 * do not end it early.
 * @param {(jpeg: Buffer) => void} onFrame
 * @returns {{ push: (chunk: Buffer) => void, pending: () => number }}
 */
export function jpegSplitter(onFrame, { maxBytes = MAX_FRAME_BYTES } = {}) {
  let buf = Buffer.alloc(0);
  /** End offset (exclusive) of the JPEG starting at `start`, -1 when more bytes are needed, -2 when it is not a JPEG. */
  const endOf = (start) => {
    let o = start + 2;
    for (;;) {
      if (o + 4 > buf.length) return -1;
      if (buf[o] !== 0xff) return -2;
      const m = buf[o + 1];
      if (m === 0xff) { o++; continue; }                 // fill byte
      if (m === 0xd9) return o + 2;                      // EOI with no scan
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; } // markers without a length
      const len = buf.readUInt16BE(o + 2);
      if (len < 2) return -2;
      if (m !== 0xda) { o += 2 + len; continue; }
      // Start of scan: entropy-coded data follows; in it 0xFF is always followed by 0x00 or RSTn,
      // so the first other marker is the next segment (progressive files) or EOI.
      let p = o + 2 + len;
      for (;;) {
        const f = buf.indexOf(0xff, p);
        if (f < 0 || f + 1 >= buf.length) return -1;
        const n = buf[f + 1];
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) { p = f + (n === 0xff ? 1 : 2); continue; }
        if (n === 0xd9) return f + 2;
        o = f; break;
      }
    }
  };
  return {
    pending: () => buf.length,
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const soi = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
        if (soi < 0) { buf = buf.subarray(Math.max(0, buf.length - 2)); return; }
        if (soi) buf = buf.subarray(soi);
        const end = endOf(0);
        if (end === -1) { if (buf.length > maxBytes) buf = Buffer.alloc(0); return; }
        if (end === -2) { buf = buf.subarray(2); continue; }
        onFrame(Buffer.from(buf.subarray(0, end)));
        buf = buf.subarray(end);
      }
    },
  };
}

/** HTML of the page. One file, no dependencies; the frame and input endpoints are relative. */
export function pageHtml({ name = 'dot' }) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} · phone</title>
<style>
html,body{margin:0;height:100%;background:#111;color:#ddd;font:13px/1.4 system-ui,sans-serif}
#wrap{display:flex;flex-direction:column;height:100%}
#bar{display:flex;gap:6px;align-items:center;padding:6px 8px;background:#1c1c1c;border-bottom:1px solid #333}
#bar button,#bar input{background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px 8px;font:inherit}
#bar input{flex:1;min-width:60px}
#stage{flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;min-height:0}
#screen{max-width:100%;max-height:100%;touch-action:none;cursor:crosshair;user-select:none}
#status{color:#888;margin-left:auto;white-space:nowrap}
</style></head><body><div id="wrap">
<div id="bar">
<button data-key="KEYCODE_BACK" title="返回">←</button><button data-key="KEYCODE_HOME" title="主页">●</button><button data-key="KEYCODE_APP_SWITCH" title="最近">▭</button>
<input id="text" placeholder="输入文字后回车发送到手机"><button id="send">发送</button><button id="enter" title="回车">⏎</button>
<span id="status">connecting…</span>
</div>
<div id="stage"><canvas id="screen" width="1" height="1"></canvas></div>
</div>
<script>
const screen=document.getElementById('screen'),ctx=screen.getContext('2d'),status=document.getElementById('status'),text=document.getElementById('text');
const say=(s)=>{if(status.textContent!==s)status.textContent=s};
const post=(path,body)=>fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>{if(!r.ok)say('error '+r.status)}).catch(()=>say('offline'));
const norm=(e)=>{const r=screen.getBoundingClientRect();return {x:Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),y:Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))}};
let down=null;
screen.addEventListener('pointerdown',(e)=>{down={...norm(e),t:Date.now()};screen.setPointerCapture(e.pointerId);e.preventDefault()});
screen.addEventListener('pointerup',(e)=>{if(!down)return;const up=norm(e);const dt=Date.now()-down.t;const dist=Math.hypot(up.x-down.x,up.y-down.y);
 if(dist<0.02){post('tap',{x:down.x,y:down.y,ms:dt>500?dt:0})}else{post('swipe',{from:down,to:up,ms:Math.max(100,Math.min(dt,1500))})}down=null;e.preventDefault()});
document.querySelectorAll('[data-key]').forEach(b=>b.addEventListener('click',()=>post('key',{key:b.dataset.key})));
const sendText=()=>{if(!text.value)return;post('text',{text:text.value});text.value=''};
document.getElementById('send').addEventListener('click',sendText);
document.getElementById('enter').addEventListener('click',()=>post('key',{key:'KEYCODE_ENTER'}));
text.addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();sendText()}});
// One frame at a time: ask for a frame newer than the one shown, draw it, let go of it, ask again.
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let seq=0,asking=null,fails=0;
document.addEventListener('visibilitychange',()=>{if(document.hidden&&asking)asking.abort()});
(async()=>{for(;;){
 if(document.hidden){say('paused');await new Promise(r=>document.addEventListener('visibilitychange',r,{once:true}));continue}
 asking=new AbortController();const timer=setTimeout(()=>asking.abort(),${WAIT_MS + 10_000});
 try{
  const r=await fetch('frame?after='+seq,{signal:asking.signal,cache:'no-store'});
  if(r.status===204){say('live');fails=0;continue}
  if(!r.ok)throw new Error('HTTP '+r.status);
  const next=Number(r.headers.get('x-frame-seq'))||0;
  const bmp=await createImageBitmap(await r.blob());
  if(screen.width!==bmp.width||screen.height!==bmp.height){screen.width=bmp.width;screen.height=bmp.height}
  ctx.drawImage(bmp,0,0);bmp.close();
  seq=next;fails=0;say('live');
 }catch(e){
  if(document.hidden)continue;
  fails++;say(fails>1?'reconnecting…':'live');await sleep(Math.min(15000,250*2**fails));
 }finally{clearTimeout(timer);asking=null}
}})();
</script></body></html>`;
}

/**
 * Mount the live view on dsh's web server.
 * @param {object} o
 * @param {object} o.webServer - dsh's `webServer` service (register prefix routes).
 * @param {object} o.connection - dsh's `connection` service (requestRejection).
 * @param {() => Promise<Buffer>} o.screenshot - PNG of the screen now.
 * @param {(() => { stdout: import('node:stream').Readable, kill: () => void, on: Function }) | undefined} [o.openStream] -
 *   start the phone's own screen stream (JPEG pictures on stdout); absent = screencaps only.
 * @param {(cmd: string) => Promise<string>} o.shell - `adb shell <cmd>`.
 * @param {() => boolean} o.ready - whether the phone answers.
 * @param {object} o.logger
 * @param {string} [o.name]
 * @returns {{ close: () => void }}
 */
export function mountLiveView({ webServer, connection, screenshot, openStream, shell, ready, logger, name = 'dot', timing = {} }) {
  const waitMs = timing.waitMs ?? WAIT_MS, idleMs = timing.idleMs ?? IDLE_MS;
  const firstFrameMs = timing.firstFrameMs ?? STREAM_FIRST_FRAME_MS, streamRetryMs = timing.streamRetryMs ?? STREAM_RETRY_MS;
  const backoff = (fails) => Math.min(30_000, (timing.backoffMs ?? 1000) * 2 ** fails);
  let size = null; // { w, h } in pixels, read once from the device
  const screenSize = async () => {
    if (size) return size;
    const m = /(\d+)x(\d+)/.exec(await shell('wm size'));
    size = m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1080, h: 2400 };
    return size;
  };
  const px = async ({ x, y }) => { const s = await screenSize(); return [Math.round(x * s.w), Math.round(y * s.h)]; };
  const json = (req) => new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) { reject(new Error('json body required')); return; }
    let b = ''; req.on('data', (d) => { b += d; if (b.length > 65536) reject(new Error('too large')); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
  });
  const html = pageHtml({ name });

  // ── The newest frame, and who waits for a newer one ───────────────────────────────────────────
  let closed = false;
  let latest = null;            // { seq, buf, type }
  let seq = Date.now() % 1e9;   // starts apart from a previous mount's numbers
  const waiters = new Set();    // () => void, called when a frame is published or on close
  let lastAsked = 0;            // when a frame was last asked for
  let source = 'none';          // 'stream' | 'screencap' | 'none': what gave the latest frame
  const stats = { frames: 0, since: Date.now() };
  const told = { at: Date.now(), frames: 0, bytes: 0 }; // what is written to the log about the flow, twice a minute while frames flow
  /** Publish a frame; anything that is not a picture is dropped here, whatever source it came from. */
  const publish = (buf, from) => {
    const type = pictureType(buf);
    if (!type) { logger.debug?.(`live view: ${from} gave ${buf?.length ?? 0} bytes that are not a picture; dropped`); return false; }
    if (latest && latest.buf.length === buf.length && latest.buf.equals(buf)) return true; // the same screen: nobody needs it again
    latest = { seq: ++seq, buf, type };
    if (source !== from) { source = from; logger.info?.(`live view: frames from ${from === 'stream' ? "the phone's screen stream" : 'screencaps'}`); }
    stats.frames++;
    if (!told.frames) told.at = Date.now(); // counted from the first frame of a run, not from the quiet before it
    told.frames++; told.bytes += buf.length;
    if (Date.now() - told.at >= 30_000) {
      const secs = (Date.now() - told.at) / 1000;
      logger.debug?.(`live view: ${told.frames} frames in ${Math.round(secs)} s from ${from} (${(told.frames / secs).toFixed(1)}/s, ${Math.round(told.bytes / told.frames / 1024)} KB each)`);
      told.at = Date.now(); told.frames = 0; told.bytes = 0;
    }
    for (const wake of [...waiters]) wake();
    return true;
  };
  const wanted = () => !closed && (waiters.size > 0 || Date.now() - lastAsked < idleMs);

  // ── Source 1: the phone's own screen stream ───────────────────────────────────────────────────
  let stream = null;            // the running process
  let streamOkAt = 0;           // when it last gave a picture
  let streamRetryAt = 0;        // not tried again before this
  const stopStream = () => { const p = stream; stream = null; streamOkAt = 0; if (p) { try { p.kill(); } catch (error) { void error; } } };
  const startStream = () => {
    if (!openStream || stream || Date.now() < streamRetryAt || !ready()) return;
    let proc;
    try { proc = openStream(); } catch (err) { streamRetryAt = Date.now() + streamRetryMs; logger.debug?.(`live view: screen stream did not start: ${err.message}`); return; }
    stream = proc;
    const startedAt = Date.now();
    let got = 0;
    const fail = (why) => {
      if (stream !== proc) return;
      stopStream();
      streamRetryAt = Date.now() + streamRetryMs;
      streamOkAt = 0;
      if (!closed) logger.info?.(`live view: no screen stream (${why}); using screencaps`);
      void captureLoop();
    };
    const split = jpegSplitter((jpeg) => { if (stream !== proc) return; got++; streamOkAt = Date.now(); publish(jpeg, 'stream'); });
    proc.stdout.on('data', (d) => { try { split.push(d); } catch (err) { fail(err.message); } });
    proc.on('error', (err) => fail(err.message));
    proc.on('exit', (code) => { if (stream === proc) { if (wanted() || !got) fail(`ended${code == null ? '' : ` with ${code}`} after ${got} frames`); else stream = null; } });
    const first = setTimeout(() => { if (stream === proc && !got) fail(`no picture in ${Math.round((Date.now() - startedAt) / 1000)} s`); }, firstFrameMs);
    first.unref?.();
    // Nobody asking any more: the stream stops, so an unwatched phone is not encoding its screen.
    const idle = setInterval(() => { if (stream !== proc) { clearInterval(idle); return; } if (!wanted()) { clearInterval(idle); stopStream(); } }, 1000);
    idle.unref?.();
  };
  const streaming = () => stream && streamOkAt > 0;

  // ── Source 2: screencaps ──────────────────────────────────────────────────────────────────────
  // One loop however many pages ask. Each screencap is a full recomposite, and on a
  // software-rendered emulator (API 35 + -gpu auto on a Mac) that runs on the host CPU;
  // back-to-back captures stalled the VM past the emulator's 15 s hang detector, which killed it
  // (2026-11-06). So capturing takes at most ~1/4 of the time, and failures back off.
  let capturing = false;
  const captureLoop = async () => {
    if (capturing) return;
    capturing = true;
    let fails = 0;
    while (wanted() && !streaming()) {
      const started = Date.now();
      let wait = 500;
      if (ready()) {
        try {
          const png = await screenshot();
          if (streaming()) break; // the stream gave a picture meanwhile: this capture is the older one
          const ok = publish(png, 'screencap');
          const took = Date.now() - started;
          if (ok) { fails = 0; wait = Math.max(took * 3, 50); } else { fails++; wait = backoff(fails); }
        } catch (err) { fails++; wait = backoff(fails); logger.debug?.(`live view frame failed: ${err.message}`); }
      }
      await new Promise((r) => { const t = setTimeout(r, wait); t.unref?.(); });
    }
    capturing = false;
  };
  /** Somebody asked for a frame: make sure something is producing them. */
  const demand = () => {
    lastAsked = Date.now();
    startStream();
    // While a stream is still proving itself the screencaps carry the view; once it gives pictures they stop.
    if (!streaming()) void captureLoop();
  };

  const sendFrame = (res, f) => {
    res.writeHead(200, { 'content-type': f.type, 'content-length': f.buf.length, 'x-frame-seq': String(f.seq), 'cache-control': 'no-store' });
    res.end(f.buf);
  };
  const handler = async (req, res) => {
    // dsh decides who this is; nothing below runs for anyone else.
    if (rejectUnlessOwner(connection, req, res)) return;
    let url;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch (error) { void error; res.writeHead(400); return res.end(); }
    const sub = url.pathname.slice(LIVE_VIEW_PATH.length);
    try {
      if (req.method === 'GET' && sub === '') { res.writeHead(302, { location: `${LIVE_VIEW_PATH}/` }); return res.end(); }
      if (req.method === 'GET' && sub === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(html); }
      if (req.method === 'GET' && sub === '/status') {
        const secs = Math.max(1, (Date.now() - stats.since) / 1000);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ ready: ready(), size, source, fps: Math.round((stats.frames / secs) * 10) / 10 }));
      }
      if (req.method === 'GET' && sub === '/screenshot.png') { const png = await screenshot(); res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); return res.end(png); }
      if (req.method === 'GET' && sub === '/frame') {
        // One answer per request: a frame newer than `after`, or 204 when none came in time.
        const after = Number(url.searchParams.get('after')) || 0;
        demand();
        // Numbers only grow while this view is mounted, so "not the one you have" is "newer" — and a page that
        // outlived a restart of the view (its number is from the old one) gets the current frame at once.
        if (latest && latest.seq !== after) return sendFrame(res, latest);
        await new Promise((done) => {
          let timer = null;
          const finish = (answer) => { if (!waiters.delete(wake)) return; clearTimeout(timer); req.off('close', gone); answer(); done(); };
          const wake = () => finish(() => (closed || !latest ? (res.writeHead(204), res.end()) : sendFrame(res, latest)));
          const gone = () => finish(() => { try { res.destroy(); } catch (error) { void error; } });
          timer = setTimeout(() => finish(() => { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); }), waitMs);
          timer.unref?.();
          waiters.add(wake);
          req.on('close', gone);
        });
        lastAsked = Date.now();
        return undefined;
      }
      if (req.method === 'POST') {
        if (!ready()) { res.writeHead(503); return res.end('phone not ready'); }
        const body = await json(req);
        if (sub === '/tap') { const [x, y] = await px(body); await shell(body.ms > 0 ? `input swipe ${x} ${y} ${x} ${y} ${Math.round(body.ms)}` : `input tap ${x} ${y}`); }
        else if (sub === '/swipe') { const [x1, y1] = await px(body.from); const [x2, y2] = await px(body.to); await shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${Math.round(body.ms ?? 300)}`); }
        else if (sub === '/key') { if (!/^KEYCODE_[A-Z0-9_]+$/.test(String(body.key))) { res.writeHead(400); return res.end(); } await shell(`input keyevent ${body.key}`); }
        else if (sub === '/text') { await shell(`input text ${shellQuote(String(body.text ?? ''))}`); }
        else { res.writeHead(404); return res.end(); }
        res.writeHead(204); return res.end();
      }
      res.writeHead(404); res.end();
    } catch (err) { logger.warn?.(`live view: ${err.message}`); if (!res.headersSent) res.writeHead(err.message === 'json body required' ? 415 : 500); res.end(); }
  };
  const unregister = webServer.register({ kind: 'prefix', path: LIVE_VIEW_PATH, handler });
  return { close: () => {
    // Nothing of ours outlives close(): waiting requests are answered, the stream process is ended, the loop stops.
    closed = true;
    for (const wake of [...waiters]) wake();
    stopStream();
    unregister();
  } };
}

/** `adb shell input text` wants spaces as %s and shell metacharacters escaped. ASCII only reaches the device reliably; CJK goes through the clipboard route the model uses. */
export function shellQuote(text) {
  return `'${text.replace(/'/g, `'\\''`).replace(/ /g, '%s')}'`;
}

// The dot page (left sidebar → "dot 设置"): one self-contained HTML file served same-origin at
// /dsh-dot/page/ behind dsh's login, talking to /dsh-dot/api. Plain DOM, no dependencies, like the
// panel and the phone's live view. Tabs: 设置 · 体检 · 诊断. (开始/引导 and 危险区 come next.)

export const PAGE_PATH = '/dsh-dot/page';

export function pageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dot 设置</title>
<style>
:root{color-scheme:light dark;--fg:#222;--mute:#777;--bg:#fafafa;--card:#fff;--line:#e3e3e3;--ok:#2e9e5b;--warn:#d98a1a;--bad:#c94a4a;--acc:#4a7fd6;--chg:#fff6dc}
@media (prefers-color-scheme:dark){:root{--fg:#ddd;--mute:#888;--bg:#161616;--card:#1f1f1f;--line:#333;--acc:#6a9bea;--chg:#3a3320}}
html,body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.55 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
main{padding:16px 20px 60px;max-width:860px;margin:0 auto;display:grid;gap:12px}
h1{font-size:18px;margin:0}h2{font-size:13px;font-weight:600;margin:0 0 8px}
.row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.badge{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px solid var(--line);border-radius:999px;background:var(--card);white-space:nowrap}
.dotc{width:8px;height:8px;border-radius:50%;background:var(--mute)}.ok .dotc{background:var(--ok)}.warn .dotc{background:var(--warn)}.bad .dotc{background:var(--bad)}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line)}
.tabs button{border:0;background:none;color:var(--mute);padding:8px 12px;font:inherit;cursor:pointer;border-bottom:2px solid transparent}
.tabs button.on{color:var(--fg);border-bottom-color:var(--acc)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.banner{border-color:var(--bad);color:var(--bad)}
.mute{color:var(--mute)}.small{font-size:11px}
.set{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,260px);gap:4px 14px;padding:8px 0;border-top:1px solid var(--line);align-items:center}
.set:first-of-type{border-top:0}.set.changed{background:var(--chg);margin:0 -8px;padding:8px}
.set label{min-width:0}.set .key{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--mute)}
.set input[type=text],.set input[type=number],.set select{width:100%;box-sizing:border-box;font:inherit;padding:4px 6px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg)}
.tag{display:inline-block;font-size:10px;padding:0 6px;border-radius:999px;border:1px solid var(--line);color:var(--mute);margin-left:6px;white-space:nowrap}
.tag.create{border-color:var(--warn);color:var(--warn)}
details.group>summary{cursor:pointer;font-weight:600;padding:2px 0}
button.btn{font:inherit;padding:5px 12px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.btn.primary{background:var(--acc);border-color:var(--acc);color:#fff}button.btn:disabled{opacity:.5;cursor:default}
.bar{position:sticky;bottom:0;background:var(--bg);padding:10px 0;border-top:1px solid var(--line);display:flex;gap:8px;align-items:center}
.item{display:grid;grid-template-columns:20px 1fr auto;gap:8px;padding:8px 0;border-top:1px solid var(--line)}.item:first-child{border-top:0}
.fix{white-space:pre-wrap;color:var(--mute);margin-top:2px}
.msg{min-height:1.5em}.msg.err{color:var(--bad)}.msg.ok{color:var(--ok)}
textarea{width:100%;box-sizing:border-box;min-height:160px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px}
[hidden]{display:none!important}
</style></head><body><main>
<div class="row" style="justify-content:space-between"><h1>dot 设置</h1><span class="mute small" id="ver"></span></div>
<div class="row" id="badges"></div>
<div class="row" id="power" style="margin-top:8px"></div><div class="msg" id="powerMsg"></div>
<div class="card banner" id="fileErr" hidden></div>
<div class="tabs" role="tablist"><button data-tab="setup">开始</button><button data-tab="status">状态</button><button data-tab="settings" class="on">设置</button><button data-tab="doctor">体检</button><button data-tab="diag">诊断</button></div>
<section id="tab-setup" hidden><div id="steps" class="mute">加载中…</div></section>
<section id="tab-status" hidden><div id="statusCards" class="mute">加载中…</div></section>
<section id="tab-settings"><div id="groups" class="mute">加载中…</div>
<details class="card" style="margin-top:12px"><summary style="cursor:pointer;color:var(--bad)">危险区</summary>
<div class="item" style="grid-template-columns:1fr auto"><div><b>重建手机</b><div class="mute">删掉现在这台手机，用当前的存储和内存设置新建一台。她装的 App、登录、照片全部没了；已下载的系统不用重下，几分钟就好。</div>
<div class="row" style="margin-top:6px">新存储 <select id="rbGb"><option value="">不变</option><option>8</option><option>16</option><option>32</option><option>64</option></select> GB · 输入 <b>dot</b> 确认 <input type="text" id="rbConfirm" style="width:70px"></div><div class="msg" id="rbMsg"></div></div><div><button class="btn" id="rb" style="color:var(--bad);border-color:var(--bad)">重建手机</button></div></div>
<div class="item" style="grid-template-columns:1fr auto"><div><b>清理手机下载缓存</b><div class="mute">安装时下载的压缩包。手机已装好的话可以删。</div><div class="msg" id="clMsg"></div></div><div><button class="btn" id="cl">清理</button></div></div>
</details>
<div class="bar"><button class="btn primary" id="save" disabled>保存</button><button class="btn" id="revert" disabled>撤销修改</button><span class="msg" id="saveMsg"></span></div></section>
<section id="tab-doctor" hidden><div class="card"><div class="row" style="justify-content:space-between"><h2>这台电脑能不能跑她的手机和电脑</h2><button class="btn primary" id="runDoctor">开始体检</button></div><div id="doctor" class="mute">还没体检。</div></div></section>
<section id="tab-diag" hidden><div class="card"><h2>导出诊断包</h2>
<p class="mute">日志、体检结果、打码后的设置和版本信息，打包成 zip。密钥、令牌、密码、邮箱、手机号都会打码；默认不含她的记忆、日记和聊天。</p>
<label class="row"><input type="checkbox" id="priv"> 附带她的记忆和 QQ 记录（排查人格、QQ 问题时才需要）</label>
<p class="row"><button class="btn primary" id="dl">下载诊断包</button><button class="btn" id="save2">保存到本机文件夹</button><span class="msg" id="dlMsg"></span></p></div>
<div class="card"><h2>复制摘要</h2><p class="mute">几行文字：版本、各组件状态、体检的问题。适合贴到 issue 或群里。</p>
<p class="row"><button class="btn" id="sum">生成并复制</button><span class="msg" id="sumMsg"></span></p><textarea id="sumText" hidden readonly></textarea></div></section>
</main>
<script>
const API = location.pathname.replace(/\\/page\\/?$/, '') + '/api';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(method, path, body) {
  const r = await fetch(API + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
const NAMES = { phone: '手机', computer: '电脑', gate: '审批', qq: 'QQ', dot: 'dot', interlude: '幕间', compat: '兼容', llm: '模型请求' };
const APPLY = { live: '即时生效', 'restart-phone': '重启手机生效', 'restart-dsh': '重启 dsh 生效', create: '只对新建生效' };
function level(s) { if (!s || s.state === 'off') return ''; if (/ready|on/.test(s.state)) return 'ok'; if (s.state === 'error') return 'bad'; return 'warn'; }
function stateText(name, s) {
  if (!s) return '关';
  if (s.progress && s.progress.text) return s.progress.text + (s.progress.pct != null ? ' · ' + s.progress.pct + '%' : '');
  if (s.slowBoot) return '开机较慢，还在开';
  if (name === 'qq' && s.connected) return '已登录';
  return ({ off: '已关机', ready: '就绪', on: '开着', 'needs-license': '等待安装', downloading: '下载中', booting: '开机中', starting: '准备中', error: '出错', 'shell-only': '部分就绪', stopped: '没在运行', idle: '没在运行', installing: '安装中', 'not-installed': '没装', connecting: '连接中', 'needs-account': '没填她的 QQ 号', connected: '已连接', installed: '已安装', reconnecting: '重连中', blocked: '被拦下', cooling: '被限流，后台在等' })[s.state] || s.state || '';
}
async function loadStatus() {
  try {
    const j = await api('GET', '/status');
    $('ver').textContent = 'dsh-dot ' + j.version;
    $('badges').innerHTML = Object.entries(j.status).map(([k, s]) => '<span class="badge ' + level(s) + '" title="' + esc(s && s.error || '') + '"><span class="dotc"></span>' + NAMES[k] + '：' + esc(stateText(k, s)) + '</span>').join('');
    renderPower(j.status);
    showFileErr(j.fileError);
  } catch (e) { $('badges').innerHTML = '<span class="badge bad"><span class="dotc"></span>' + esc(e.message) + '</span>'; }
}
// The power switches: her phone and her computer, on or off at once; the choice survives dsh restarts.
// Both are watched here in dsh (the live views), not in windows of their own.
let powerBusy = '';
function renderPower(st) {
  const one = (k, label) => {
    const x = st[k];
    if (!x) return '';
    const on = x.state !== 'off';
    return '<span class="badge">' + label + ' <button class="btn" data-power="' + k + '" data-on="' + (on ? '0' : '1') + '"' + (powerBusy === k ? ' disabled' : '') + '>' + (powerBusy === k ? '…' : on ? '关机' : '开机') + '</button>'
      + (on && x.liveViewUrl ? ' <a href="' + esc(x.liveViewUrl) + '" target="_blank" rel="noopener">看画面</a>' : '') + '</span>';
  };
  $('power').innerHTML = one('phone', '手机') + one('computer', '电脑');
  for (const b of document.querySelectorAll('[data-power]')) b.onclick = async () => {
    const k = b.dataset.power, on = b.dataset.on === '1';
    if (!on && k === 'computer' && st.qq && !confirm('关掉电脑，她的 QQ 也会下线（QQ 跑在这台电脑里）。继续？')) return;
    powerBusy = k; renderPower(st);
    try { const j = await api('POST', '/action/' + k + '-power', { on }); $('powerMsg').className = 'msg ok'; $('powerMsg').textContent = j.message; }
    catch (e) { $('powerMsg').className = 'msg err'; $('powerMsg').textContent = e.message; }
    powerBusy = ''; loadStatus();
  };
}
function showFileErr(err) {
  const b = $('fileErr');
  if (!err) { b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = '~/.dsh/dsh-dot.json 格式不对，整个文件都没生效：' + esc(err) + '<br><button class="btn" id="overwrite">备份后用默认值重建</button> <span class="mute small">或手动修好再刷新</span>';
  $('overwrite').onclick = async () => { if (!confirm('原文件会备份为 dsh-dot.json.broken-时间，然后清空设置。继续？')) return; try { await api('PUT', '/settings', { patch: {}, overwriteBroken: true }); await loadSettings(); await loadStatus(); } catch (e) { alert(e.message); } };
}

// ---- settings
let entries = [], components = {}, changes = {};
const id = (e) => e.section + '.' + e.key;
function shown(v) { return v === undefined ? '' : v; }
function control(e) {
  const cur = changes[id(e)] !== undefined ? changes[id(e)] : e.value;
  const def = e.default;
  const k = 'in-' + id(e).replace('.', '-');
  if (e.type === 'bool') return '<input type="checkbox" id="' + k + '"' + ((cur === undefined ? def : cur) ? ' checked' : '') + '>';
  if (e.type === 'int') return '<input type="number" id="' + k + '" value="' + esc(shown(cur)) + '" placeholder="' + esc(def) + '"' + (e.min != null ? ' min="' + e.min + '"' : '') + (e.max != null ? ' max="' + e.max + '"' : '') + '>';
  if (e.type === 'enum' || e.type === 'enum-or-text') {
    const v = cur === undefined ? def : cur;
    const custom = e.type === 'enum-or-text' && v !== undefined && !e.values.includes(v);
    const opts = e.values.map((x) => '<option value="' + esc(x) + '"' + (!custom && x === v ? ' selected' : '') + '>' + esc(x === '' ? '（空）' : x) + (x === def ? '（默认）' : '') + '</option>').join('')
      + (e.type === 'enum-or-text' ? '<option value="__custom"' + (custom ? ' selected' : '') + '>自定义…</option>' : '');
    return '<select id="' + k + '">' + opts + '</select>' + (e.type === 'enum-or-text' ? '<input type="text" id="' + k + '-c" value="' + esc(custom ? v : '') + '" placeholder="自定义值"' + (custom ? '' : ' hidden') + ' style="margin-top:4px">' : '');
  }
  return '<input type="text" id="' + k + '" value="' + esc(shown(cur)) + '" placeholder="' + esc(def === '' ? '（空）' : def) + '">';
}
function readControl(e) {
  const k = 'in-' + id(e).replace('.', '-'), el = $(k);
  if (e.type === 'bool') return el.checked;
  if (e.type === 'int') return el.value === '' ? null : Number(el.value);
  if (e.type === 'enum-or-text') { if (el.value === '__custom') { $(k + '-c').hidden = false; return $(k + '-c').value.trim(); } $(k + '-c').hidden = true; return el.value; }
  if (e.type === 'enum') return el.value;
  return el.value.trim() === '' ? null : el.value.trim();
}
function renderSettings() {
  const groups = {};
  for (const e of entries) (groups[e.group] ||= []).push(e);
  $('groups').className = '';
  $('groups').innerHTML = Object.entries(groups).map(([g, list]) => {
    const sec = list[0].section, on = components[sec] !== false;
    return '<div class="card" style="margin-bottom:12px"><details class="group"' + (on ? ' open' : '') + '><summary>' + esc(g) + (on ? '' : ' <span class="mute small">（' + NAMES[sec] + '组件没开：在 dsh 的插件页打开）</span>') + '</summary>'
      + list.map((e) => '<div class="set' + (changes[id(e)] !== undefined ? ' changed' : '') + '" data-id="' + id(e) + '"><label for="in-' + id(e).replace('.', '-') + '">' + esc(e.zh)
        + '<span class="tag' + (e.apply === 'create' ? ' create' : '') + '">' + APPLY[e.apply] + '</span><br><span class="key">' + id(e) + ' · 默认 ' + esc(JSON.stringify(e.default)) + (e.value !== undefined ? ' · 已设 ' + esc(JSON.stringify(e.value)) : '') + '</span></label><div>' + control(e) + '</div></div>').join('')
      + '</details></div>';
  }).join('');
  for (const e of entries) {
    const k = 'in-' + id(e).replace('.', '-');
    const onChange = () => {
      const v = readControl(e);
      const eff = v === null ? e.default : v, curEff = e.value === undefined ? e.default : e.value;
      if (JSON.stringify(eff) === JSON.stringify(curEff)) delete changes[id(e)];
      else changes[id(e)] = JSON.stringify(eff) === JSON.stringify(e.default) ? null : v; // back to the default = remove the key
      document.querySelector('[data-id="' + id(e) + '"]').classList.toggle('changed', changes[id(e)] !== undefined);
      $('save').disabled = $('revert').disabled = !Object.keys(changes).length;
      $('saveMsg').textContent = ''; $('saveMsg').className = 'msg';
    };
    $(k).addEventListener('change', onChange); $(k).addEventListener('input', onChange);
    if ($(k + '-c')) $(k + '-c').addEventListener('input', onChange);
  }
}
async function loadSettings() {
  const j = await api('GET', '/settings');
  entries = j.entries; components = j.components; changes = {};
  showFileErr(j.fileError);
  renderSettings();
  $('save').disabled = $('revert').disabled = true;
}
$('revert').onclick = () => { changes = {}; renderSettings(); $('save').disabled = $('revert').disabled = true; };
$('save').onclick = async () => {
  const patch = {}, applies = new Set();
  for (const [k, v] of Object.entries(changes)) {
    const [s, key] = k.split('.');
    (patch[s] ||= {})[key] = v;
    applies.add(entries.find((e) => id(e) === k).apply);
  }
  try {
    await api('PUT', '/settings', { patch });
    await loadSettings();
    const notes = [];
    if (applies.has('restart-phone')) notes.push('<button class="btn" id="rp">现在重启手机</button>');
    if (applies.has('restart-dsh')) notes.push('有的改动要重启 dsh 才生效');
    if (applies.has('create')) notes.push('标"只对新建生效"的项，已建好的手机/电脑不受影响');
    $('saveMsg').className = 'msg ok'; $('saveMsg').innerHTML = '已保存。' + notes.join('；');
    if ($('rp')) $('rp').onclick = () => act('phone-restart', $('saveMsg'));
  } catch (e) { $('saveMsg').className = 'msg err'; $('saveMsg').textContent = e.message; }
};
async function act(name, msgEl, body) {
  try { const j = await api('POST', '/action/' + name, body); msgEl.className = 'msg ok'; msgEl.textContent = j.message; setTimeout(loadStatus, 800); }
  catch (e) { msgEl.className = 'msg err'; msgEl.textContent = e.message; }
}

// ---- doctor
const MARK = { ok: '✅', warn: '⚠️', bad: '❌' };
async function runDoctor() {
  $('runDoctor').disabled = true; $('doctor').className = 'mute'; $('doctor').textContent = '体检中…（下载源要测连通，可能要十几秒）';
  try {
    const { items } = await api('POST', '/doctor');
    const order = { bad: 0, warn: 1, ok: 2 };
    items.sort((a, b) => order[a.level] - order[b.level]);
    const bad = items.filter((i) => i.level === 'bad').length, warn = items.filter((i) => i.level === 'warn').length;
    $('doctor').className = '';
    $('doctor').innerHTML = '<p>' + (bad ? '<b style="color:var(--bad)">' + bad + ' 项会导致装不上或用不了</b>' : warn ? '能用，' + warn + ' 项要留意' : '<b style="color:var(--ok)">都没问题</b>') + '</p>'
      + items.map((i, n) => '<div class="item"><span>' + MARK[i.level] + '</span><div><b>' + esc(i.name) + '</b>：' + esc(i.detail) + (i.fix && i.level !== 'ok' ? '<div class="fix">→ ' + esc(i.fix) + '</div>' : '') + '<div class="msg small" id="fx' + n + 'm"></div></div>'
        + '<div>' + (i.action && i.level !== 'ok' ? '<button class="btn primary" id="fx' + n + '" data-fix="' + esc(i.action.id) + '">' + esc(i.action.label) + '</button>' : '') + '</div></div>').join('');
    items.forEach((i, n) => {
      const b = $('fx' + n); if (!b) return;
      b.onclick = async () => {
        b.disabled = true;
        try {
          const r = await api('POST', '/fix/' + b.dataset.fix);
          const m = $('fx' + n + 'm'); m.className = 'msg small ok';
          m.innerHTML = '已改好（' + esc(r.label) + '）。' + (r.apply === 'restart-phone' ? '<button class="btn" id="fx' + n + 'r">现在重启手机</button>' : '重启 dsh 后生效。');
          if ($('fx' + n + 'r')) $('fx' + n + 'r').onclick = () => act('phone-restart', m);
          loadSettings();
        } catch (e) { b.disabled = false; $('fx' + n + 'm').className = 'msg small err'; $('fx' + n + 'm').textContent = e.message; }
      };
    });
  } catch (e) { $('doctor').className = 'msg err'; $('doctor').textContent = e.message; }
  $('runDoctor').disabled = false;
}
$('runDoctor').onclick = runDoctor;

// ---- diagnostics
$('dl').onclick = () => { location.href = API + '/diag' + ($('priv').checked ? '?private=1' : ''); };
$('save2').onclick = async () => {
  $('dlMsg').className = 'msg'; $('dlMsg').textContent = '生成中…';
  try { const j = await api('POST', '/diag/save', { private: $('priv').checked }); $('dlMsg').className = 'msg ok'; $('dlMsg').textContent = '已保存：' + j.file; }
  catch (e) { $('dlMsg').className = 'msg err'; $('dlMsg').textContent = e.message; }
};
$('sum').onclick = async () => {
  $('sumMsg').className = 'msg'; $('sumMsg').textContent = '生成中…';
  try {
    const { text } = await api('GET', '/summary');
    const ta = $('sumText'); ta.hidden = false; ta.value = text;
    try { await navigator.clipboard.writeText(text); $('sumMsg').className = 'msg ok'; $('sumMsg').textContent = '已复制'; }
    catch { ta.select(); document.execCommand('copy'); $('sumMsg').className = 'msg ok'; $('sumMsg').textContent = '已选中，按 Ctrl/⌘+C 复制'; }
  } catch (e) { $('sumMsg').className = 'msg err'; $('sumMsg').textContent = e.message; }
};

// ---- danger zone
$('rb').onclick = async () => {
  if ($('rbConfirm').value.trim() !== 'dot') { $('rbMsg').className = 'msg err'; $('rbMsg').textContent = '先在框里输入 dot'; return; }
  if (!confirm('确定删掉现在这台手机并新建？她手机里的一切都会没有。')) return;
  await act('phone-rebuild', $('rbMsg'), { gb: $('rbGb').value || undefined });
};
$('cl').onclick = () => act('phone-cleanup', $('clMsg'));

// ---- status
function renderStatus(st) {
  const DETAIL = {
    phone: (x) => [x.serial && '设备 ' + x.serial, x.api && 'Android API ' + x.api + (x.abi ? ' (' + x.abi + ')' : ''), x.storage && x.storage.gb && '存储 ' + x.storage.gb + ' GB'],
    computer: (x) => [x.backend && '后端 ' + x.backend, x.stage && '阶段 ' + x.stage],
    qq: (x) => [x.connected ? '已连接' : '未连接', x.qq && '她的号 ' + x.qq, x.owner && '你的号 ' + x.owner],
    llm: (x) => [x.pacing ? '后台每分钟最多 ' + x.backgroundRpm + ' 次' : '后台不限速'].concat((x.providers || []).map((p) => p.provider + '：近一分钟 ' + p.lastMinute + ' 次，后台上限 ' + p.cap + (p.coolingUntil ? '，等到 ' + new Date(p.coolingUntil).toLocaleTimeString() : '') + (p.waiting ? '，' + p.waiting + ' 个在等' : '') + '，压后过 ' + p.delayed + ' 次，429 共 ' + p.rateLimited + ' 次')),
    compat: (x) => [x.qqBridge ? 'qq-bridge：' + x.qqBridge.root + '（模式 ' + x.qqBridge.mode + (x.qqBridge.bots && x.qqBridge.bots.length ? '，机器人 ' + x.qqBridge.bots.join('/') : '') + '）' : '没发现 qq-bridge'],
  };
  $('statusCards').className = '';
  $('statusCards').innerHTML = Object.entries(st).map(([k, x]) => '<div class="card" style="margin-bottom:12px"><div class="row" style="justify-content:space-between"><h2><span class="badge ' + level(x) + '"><span class="dotc"></span>' + NAMES[k] + '：' + esc(stateText(k, x)) + '</span></h2>'
    + (k === 'phone' && x ? '<span class="row"><button class="btn" data-act="phone-restart">重启手机</button></span>' : '') + '</div>'
    + (!x ? '<p class="mute">组件没开。在 dsh 的插件页（dsh-dot-life）打开。</p>' : '')
    + (x && DETAIL[k] ? '<p class="mute">' + esc(DETAIL[k](x).filter(Boolean).join(' · ')) + '</p>' : '')
    + (x && x.error ? '<pre class="fix" style="color:var(--bad)">' + esc(x.error) + '</pre>' : '')
    + '<div class="msg" id="st-' + k + '"></div></div>').join('');
  for (const b of document.querySelectorAll('[data-act]')) b.onclick = () => act(b.dataset.act, $('st-phone'));
}

// ---- setup
let stepSig = '';
const ICON = { done: '✅', todo: '⬜', working: '⏳', blocked: '❌', skip: '➖' };
function stepBody(x) {
  if (x.state === 'skip') return '<p class="mute">' + esc(x.detail) + '，跳过。</p>';
  if (x.id === 'doctor') return x.state === 'done' ? '' : '<p class="mute">先看看这台电脑能不能跑她的手机和电脑：虚拟化、磁盘、内存、端口、下载源。有问题的项能一键修的直接修。</p><p class="row"><button class="btn primary" data-go="doctor">开始体检</button><button class="btn" data-ack="doctorAck">我看过了，继续</button></p>';
  if (x.id === 'components') return x.state === 'done' ? '' : '<p class="mute">dsh-dot 由几个组件组成，在 dsh 的「插件」页里 dsh-dot-life 下面开关，改完重启 dsh：</p><ul class="mute small">'
    + '<li><b>phone</b> 她的手机（安卓模拟器，约 2 GB 下载）</li><li><b>computer + subprocess + gate</b> 她的电脑（Linux 虚拟机）和审批；QQ 需要它。不要电脑请设环境变量 DSH_DOT_COMPUTER=off，<b>别只关 subprocess</b>（dsh 会没法执行命令）</li>'
    + '<li><b>qq</b> 她自己的 QQ</li><li><b>dot / memory / interlude</b> 她这个人：对话、记忆、幕间生活。只想要手机和电脑（自己的 agent 用）可以关掉这三个</li></ul><p class="row"><button class="btn primary" data-ack="componentsAck">就这样，继续</button></p>';
  if (x.id === 'phone') {
    if (x.state === 'todo') return '<p class="mute">要下载约 2 GB（模拟器 + 安卓 15 系统），常见 10–30 分钟。需要接受 <a href="https://developer.android.com/studio/terms" target="_blank">Android SDK 许可</a>。</p><p class="row">存储 <select id="phGb"><option>8</option><option selected>16</option><option>32</option><option>64</option></select> GB（建好后不能改）<button class="btn primary" id="phGo">接受许可并安装</button></p><div class="msg" id="phMsg"></div>';
    if (x.state === 'working') return '<p>' + esc(x.detail) + '</p><p class="mute small">装的过程中可以关掉这页，照常用 dsh。</p>';
    if (x.state === 'blocked') return '<pre class="fix" style="color:var(--bad)">' + esc(x.detail) + '</pre><p class="row"><button class="btn" data-go="doctor">去体检</button><button class="btn" id="phRetry">重试</button></p><div class="msg" id="phMsg"></div>';
    return '<p class="mute">' + esc(x.detail) + '</p>';
  }
  if (x.id === 'computer') {
    if (x.state === 'working') return '<p>' + esc(({ downloading: '下载镜像中（第一次几 GB）', installing: '创建中', starting: '开机中' })[x.detail] || x.detail || '准备中') + '</p><p class="mute small">电脑在 dsh 启动时自动安装，不用点什么。</p>';
    if (x.state === 'blocked') return '<pre class="fix" style="color:var(--bad)">' + esc(x.detail) + '</pre><p class="row"><button class="btn primary" id="cmCn">改用国内镜像</button><button class="btn" data-go="doctor">去体检</button></p><div class="msg" id="cmMsg"></div>';
    return '<p class="mute">' + esc(x.detail) + '</p>';
  }
  if (x.id === 'persona') return x.state === 'done' ? '<p class="mute">' + esc(x.detail) + '</p>' : '<p class="mute">她是谁：从 <a href="https://typ0.space" target="_blank">HDSI 预设站</a> 挑一个角色，复制分享码粘到这里。</p><p class="row"><input type="text" id="pcCode" placeholder="分享码" style="width:180px"><button class="btn primary" id="pcGo">导入</button><button class="btn" data-ack="personaSkip">先用内置人设</button></p><div class="msg" id="pcMsg"></div>';
  if (x.id === 'qq') return x.state === 'done' ? '<p class="mute">' + esc(x.detail) + '</p>' : '<p class="mute">她用自己的 QQ 小号。先填号码，再安装并扫码登录（用她手机上的 QQ 扫，或你自己的手机）。</p>'
    + '<div class="set"><label>你的 QQ 号<br><span class="key">你的私聊算你本人说的话</span></label><div class="row"><input type="text" id="qqOwner" value="' + esc(x.owner) + '" style="width:140px"><button class="btn" id="qqOwnerGo">保存</button></div></div>'
    + '<div class="set"><label>她的 QQ 号</label><div class="row"><input type="text" id="qqAcc" value="' + esc(x.account) + '" style="width:140px"><button class="btn" id="qqAccGo">保存</button></div></div>'
    + '<div class="set"><label>安装并启动<br><span class="key">在她的电脑里装 QQ（几分钟）；状态 ' + esc(x.qqState || '-') + '</span></label><div class="row"><select id="qqBe"><option value="napcat">napcat</option><option value="snowluma">snowluma</option></select><button class="btn primary" id="qqInst">安装</button></div></div>'
    + '<div class="set"><label>登录二维码</label><div><button class="btn" id="qqQr">显示二维码</button><div id="qqQrBox"></div></div></div>'
    + '<div class="msg" id="qqMsg"></div><p class="row"><button class="btn" data-ack="qqSkip">先不接 QQ</button></p>';
  return '';
}
async function loadSetup(force) {
  let j;
  try { j = await api('GET', '/setup'); } catch (e) { $('steps').className = 'msg err'; $('steps').textContent = e.message; return; }
  // Re-render only when a step changes state: inputs he is typing in must survive the 3 s poll.
  const sig = JSON.stringify(j.steps.map((x) => [x.id, x.state]));
  if (!force && sig === stepSig) { // only the progress lines move
    for (const x of j.steps) if (x.state === 'working') { const el = document.querySelector('[data-step="' + x.id + '"] .stepbody p'); if (el) el.textContent = x.id === 'computer' ? (({ downloading: '下载镜像中（第一次几 GB）', installing: '创建中', starting: '开机中' })[x.detail] || x.detail) : x.detail; }
    return;
  }
  stepSig = sig;
  $('steps').className = '';
  $('steps').innerHTML = (j.done ? '<div class="card" style="margin-bottom:12px;border-color:var(--ok)"><b style="color:var(--ok)">都准备好了。</b> <span class="mute">以后要改什么在「设置」里改；出问题先跑「体检」。</span></div>' : '')
    + j.steps.map((x, n) => '<div class="card" style="margin-bottom:12px" data-step="' + x.id + '"><h2>' + ICON[x.state] + ' ' + (n + 1) + '. ' + esc(x.title) + '</h2><div class="stepbody">' + stepBody(x) + '</div></div>').join('');
  for (const b of document.querySelectorAll('[data-ack]')) b.onclick = async () => { await api('PUT', '/setup', { [b.dataset.ack]: true }); loadSetup(true); };
  for (const b of document.querySelectorAll('[data-go]')) b.onclick = () => openTab(b.dataset.go);
  const on = (id, f) => { if ($(id)) $(id).onclick = f; };
  on('phGo', () => act('phone-accept', $('phMsg'), { gb: Number($('phGb').value) }).then(() => setTimeout(() => loadSetup(true), 800)));
  on('phRetry', () => act('phone-retry', $('phMsg')));
  on('cmCn', async () => { try { await api('POST', '/fix/computer-image-cn'); $('cmMsg').className = 'msg ok'; $('cmMsg').textContent = '已改成国内镜像。完全退出 dsh 再打开，电脑会重新下载。'; } catch (e) { $('cmMsg').className = 'msg err'; $('cmMsg').textContent = e.message; } });
  on('pcGo', () => act('persona-import', $('pcMsg'), { code: $('pcCode').value }).then(() => setTimeout(() => loadSetup(true), 500)));
  on('qqOwnerGo', () => act('qq-owner', $('qqMsg'), { number: $('qqOwner').value.trim() }));
  on('qqAccGo', () => act('qq-account', $('qqMsg'), { number: $('qqAcc').value.trim() }));
  on('qqInst', () => act('qq-install', $('qqMsg'), { backend: $('qqBe').value }));
  on('qqQr', () => {
    $('qqQrBox').innerHTML = '<p class="mute small" id="qqQrNote">取二维码中（QQ 要在跑；可能要半分钟）…</p><img id="qqQrImg" alt="" style="max-width:220px;display:block;margin-top:6px">';
    $('qqQrImg').onerror = () => { $('qqQrNote').textContent = '二维码还没出来：先点安装，等 QQ 启动后再点一次'; };
    $('qqQrImg').onload = () => { $('qqQrNote').textContent = '用她手机上的 QQ 扫（二维码一两分钟过期，过期再点一次）'; };
    $('qqQrImg').src = API + '/qq/qr?t=' + Date.now();
  });
}

// ---- tabs
let tab = 'settings';
function openTab(name) {
  tab = name;
  for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x.dataset.tab === name);
  for (const t of ['setup', 'status', 'settings', 'doctor', 'diag']) $('tab-' + t).hidden = t !== name;
  if (name === 'doctor' && !$('doctor').dataset.ran) { $('doctor').dataset.ran = '1'; runDoctor(); }
  if (name === 'setup') loadSetup(true);
  if (name === 'status') refreshStatus();
}
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => openTab(b.dataset.tab);
let lastStatus = null;
async function refreshStatus() { try { const j = await api('GET', '/status'); lastStatus = j; renderStatus(j.status); } catch (e) { $('statusCards').className = 'msg err'; $('statusCards').textContent = e.message; } }
(async () => {
  await loadStatus();
  loadSettings().catch((e) => { $('groups').className = 'msg err'; $('groups').textContent = e.message; });
  // First run: open on 开始 until every step is done (or he said "later"); ?tab= wins.
  const want = new URLSearchParams(location.search).get('tab');
  try { const j = await api('GET', '/status'); openTab(want || (j.setup.done || j.setup.dismissed ? 'settings' : 'setup')); } catch { openTab(want || 'settings'); }
})();
setInterval(() => { if (document.hidden) return; loadStatus(); if (tab === 'setup') loadSetup(false); if (tab === 'status') refreshStatus(); }, 3000);
</script></body></html>`;
}

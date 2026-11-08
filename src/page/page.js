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
<div class="card banner" id="fileErr" hidden></div>
<div class="tabs" role="tablist"><button data-tab="settings" class="on">设置</button><button data-tab="doctor">体检</button><button data-tab="diag">诊断</button></div>
<section id="tab-settings"><div id="groups" class="mute">加载中…</div>
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
const NAMES = { phone: '手机', computer: '电脑', qq: 'QQ', dot: 'dot', interlude: '幕间' };
const APPLY = { live: '即时生效', 'restart-phone': '重启手机生效', 'restart-dsh': '重启 dsh 生效', create: '只对新建生效' };
const SECTION_OF_GROUP = (g) => g.startsWith('手机') ? 'phone' : g === '电脑' ? 'computer' : g === 'QQ' ? 'qq' : g === 'dot' ? 'dot' : g === '审批' ? 'computer' : '';
function level(s) { if (!s) return ''; if (/ready|on/.test(s.state)) return 'ok'; if (s.state === 'error') return 'bad'; return 'warn'; }
function stateText(name, s) {
  if (!s) return '关';
  if (s.progress && s.progress.text) return s.progress.text + (s.progress.pct != null ? ' · ' + s.progress.pct + '%' : '');
  if (s.slowBoot) return '开机较慢，还在开';
  return ({ ready: '就绪', on: '开着', 'needs-license': '等待安装', downloading: '下载中', booting: '开机中', starting: '准备中', error: '出错', 'shell-only': '部分就绪' })[s.state] || s.state || '';
}
async function loadStatus() {
  try {
    const j = await api('GET', '/status');
    $('ver').textContent = 'dsh-dot ' + j.version;
    $('badges').innerHTML = Object.entries(j.status).map(([k, s]) => '<span class="badge ' + level(s) + '" title="' + esc(s && s.error || '') + '"><span class="dotc"></span>' + NAMES[k] + '：' + esc(stateText(k, s)) + '</span>').join('');
    showFileErr(j.fileError);
  } catch (e) { $('badges').innerHTML = '<span class="badge bad"><span class="dotc"></span>' + esc(e.message) + '</span>'; }
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
    const sec = SECTION_OF_GROUP(g), on = !sec || components[sec] !== false;
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

// ---- tabs
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => {
  for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x === b);
  for (const t of ['settings', 'doctor', 'diag']) $('tab-' + t).hidden = t !== b.dataset.tab;
  if (b.dataset.tab === 'doctor' && !$('doctor').dataset.ran) { $('doctor').dataset.ran = '1'; runDoctor(); }
};
loadStatus(); loadSettings().catch((e) => { $('groups').className = 'msg err'; $('groups').textContent = e.message; });
setInterval(() => { if (!document.hidden) loadStatus(); }, 3000);
</script></body></html>`;
}

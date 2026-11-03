#!/usr/bin/env node
// npm run prompts — every prompt dsh-dot puts in front of the model, on one local page:
// rendered with sample inputs through the real code, the source beside it, plain literals editable
// in place (node --check after each save, reverted if it fails). A developer tool; not shipped behaviour.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, statSync, mkdtempSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// dsh's own packages are peer dependencies: present where the plugin runs, usually absent in a bare
// source checkout. The prompts never need them, so a missing one is replaced by a stub.
{
  const { register } = await import('node:module');
  const stubs = {
    '@deepseek-ai/dsh-llm': 'export const createUserMessage = (m) => m;',
    '@deepseek-ai/dsh-subprocess': 'export class SubprocessExecutableNotFoundError extends Error {}',
    '@deepseek-ai/dsh-subprocess-local': 'export class LocalSubprocessRuntime {}',
    '@deepseek-ai/dsh-mcp-client': '',
  };
  const missing = Object.fromEntries(Object.entries(stubs).filter(([n]) => { try { import.meta.resolve(n); return false; } catch { return true; } }));
  if (Object.keys(missing).length) {
    const hook = `export const resolve = (s, c, next) => (STUBS[s] ? { url: 'data:text/javascript,' + encodeURIComponent(STUBS[s]), shortCircuit: true } : next(s, c));`;
    register(`data:text/javascript,${encodeURIComponent(`const STUBS=${JSON.stringify(missing)};${hook}`)}`);
  }
}
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
// Fresh module per file version, so a saved edit shows on the next render.
const mod = (f) => import(`${pathToFileURL(join(ROOT, f)).href}?v=${statSync(join(ROOT, f)).mtimeMs}`);

// ── samples ──
const CANON = { storyDefaults: { characterName: '小点', characterProfile: '二十三岁，刚毕业，在广州租房住。\n话少，直接，有自己的看法；熟了以后会吐槽。', perspective: '第三人称限知，贴着她。', relationship: '他是她大学时认识的朋友，现在每天都会聊几句。', userProfile: '宽，做 AI agent 开发，常熬夜。', world: '现实中国，2026 年。', location: '广州天河的一间合租房。', replyRules: '一句话一行；不用敬语。' }, blacklist: ['作为一个 AI', '我理解你的感受'], examples: '他：在吗\n她：在 怎么了' };
const T0 = Date.parse('2026-10-28T21:00:00+08:00');
const LINES = [
  { at: T0, session: 'old', who: 'owner', text: '周五前要把 benchmark 跑完' },
  { at: T0 + 6e4, session: 'old', who: 'her', text: '那你今晚别熬太晚' },
  { at: T0 + 864e5, session: 'old', who: 'owner', text: '我感冒了，嗓子疼' },
  { at: T0 + 864e5 + 6e4, session: 'old', who: 'her', text: '多喝水 别硬撑 benchmark 晚一天也行' },
];
const STATE = { current: '在出租屋里改简历，有点困', recent: ['下午去楼下买了杯咖啡'], salient: ['周五他要交 benchmark'] };
const C = { agent: { session: { id: 's1', header: { cwd: '/home/dot' } } } };
const fakeScope = (got) => ({ effect: (f) => f(), systemPrompt: { section: (o) => got.push(o), context: (o) => got.push(o), getSectionOrder: () => 0 } });
const variant = (pairs) => pairs.map(([k, v]) => `━━ ${k} ━━\n${v}`).join('\n\n');

async function sampleMemory() {
  const s = await mod('src/memory/store.js');
  const m = s.emptyMemory();
  m.owner = ['他叫宽，在广州做 AI agent 开发', '不喜欢被叫"亲"'];
  m.self = ['装了小黑盒，常在晚上逛', '学会了在 B 站发弹幕'];
  m.pending = [{ id: 'p0001', person: '阿满', text: '阿满下个月搬去深圳' }];
  s.observeFragment(m, { text: '10-31 他说这周要赶一个 benchmark，周五前交', tag: 2, kind: 'plan', gen: 1 });
  s.observeFragment(m, { text: '11-02 他感冒了，嗓子疼，说话很少', tag: 1, kind: 'event', gen: 1 });
  return { s, m };
}
let dshHome = '';
async function recallText() {
  if (!dshHome) process.env.DSH_HOME = dshHome = mkdtempSync(join(tmpdir(), 'dot-prompts-')); // no real recall settings
  const { createRecall } = await mod('src/memory/recall.js');
  const r = createRecall({ cfg: { recallBackend: 'local', recallTopK: 3, recallChunkChars: 1200, recallMaxTokens: 800, recallWindowTurns: 0 }, dir: dshHome, lines: () => LINES, logger: { info() {}, warn() {} }, embedder: () => Promise.reject(new Error('preview')) });
  return (await r.query('你 benchmark 跑完了吗', { session: 's1', record: false })).text;
}
// Run a region of the real source with the given fakes in scope; a section/context registration yields its text.
function run(reg, vars, tail = '') {
  const got = [];
  const v = { scope: fakeScope(got), ...vars };
  const r = new Function(...Object.keys(v), reg.code + tail)(...Object.values(v));
  return tail ? r : got[0].text(C);
}

// ── inventory: [file, line, identifier on that line, { back: region starts n lines up, line: that line only, readonly, note }] ──
const I = 'src/interlude/core.js', D = 'src/dot/core.js', M = 'src/memory/memory.js', Q = 'src/qq/qq.js', P = 'src/phone/phone.js';
const sec = { back: 1 };
export const inventory = [
  { id: 'canon', group: 'A', name: 'interlude:canon', purpose: '人设 Canon，系统提示词里紧跟部署人设的第一段', at: [[I, 898, "name: 'interlude:canon'", sec], [I, 471, 'export function renderCanon']],
    render: async (R) => { const { renderCanon } = await mod(I); return run(R[0], { inHome: () => true, canonText: () => renderCanon(CANON) }); } },
  { id: 'rules', group: 'A', name: 'dot:rules', purpose: 'dot 的工作方式：电脑、手机、定时任务、静默、审批、长任务', at: [[D, 396, "name: 'dot:rules'", sec], [D, 91, 'export const workingRules']],
    render: async (R) => run(R[0], { inHome: () => true, workingRules: (await mod(D)).workingRules, computer: () => true, phone: () => true }) },
  { id: 'phone', group: 'A', name: 'phone:device', purpose: '她有一部 Android 手机、怎么用、什么时候停下交给他', at: [[P, 592, "name: 'phone:device'", sec]],
    render: async (R) => run(R[0], { phone: { state: 'ready' }, serial: 'emulator-5554', PHONE_TOOL_PREFIX: (await mod('src/tool-prefixes.js')).PHONE_TOOL_PREFIX }) },
  { id: 'qq', group: 'A', name: 'qq:channel', purpose: '她的电脑 QQ：谁是他、怎么回、群聊、表情包', at: [[Q, 1020, "name: 'qq:channel'", sec], ['src/qq/stickers.js', 78, 'prompt(n = 12)']],
    render: async (R) => run(R[0], { qq: { connected: true, qq: '123456789', owner: '987654321' }, cfg: { groupPolicy: 'score' }, stickers: { prompt: () => '你存的表情包（images 里写 sticker:<id> 就能发）：a1b2c3d4e5（无语）、f6e5d4c3b2（偷笑 ×3）' } }) },
  { id: 'memory', group: 'A', name: 'dot:memory', purpose: '每轮都看得到的记忆：关于他、她自己记下的、最近的事', at: [[M, 540, "name: 'dot:memory'", sec], ['src/memory/store.js', 464, 'export function renderStanding']],
    render: async (R) => { const { s, m } = await sampleMemory(); return run(R[0], { dot: () => ({ isErrand: () => false }), isConversation: () => true, renderStanding: s.renderStanding, memory: m, cfg: { fragmentBudgetTokens: 600 }, peopleOnly: () => false }); } },
  { id: 'recall', group: 'A', name: 'dot:recall', purpose: '叫醒时自动翻出的旧对话原话（样例走词法回退）', at: [[M, 551, "name: 'dot:recall'", sec], ['src/memory/recall.js', 347, 'res.text = picked.length']],
    render: async (R) => { const t = await recallText(); return run(R[0], { dot: () => ({ isErrand: () => false }), isConversation: () => true, recall: { textFor: () => t } }); } },
  { id: 'interlude', group: 'A', name: 'interlude', purpose: '幕间连续性：此刻、最近、打算（JSON，历史之后的动态上下文）', at: [[I, 912, "name: 'interlude',", sec], [I, 415, 'export function renderContext']],
    render: async (R) => run(R[0], { inHome: () => true, renderContext: (await mod(I)).renderContext, state: STATE, readScript: () => ['11-03 14:00：她把窗帘拉开一半，靠在床头改简历，咖啡放凉了。'], files: { script: '' }, cfg: { scriptEntriesInPrompt: 3 }, intents: [{ at: new Date(Date.now() + 3 * 36e5).toISOString(), kind: 'contact', text: '问他感冒好点没' }], meta: { cursor: Date.now() - 90 * 6e4 }, startedAt: Date.now() - 5 * 36e5 }) },
  { id: 'scheduled', group: 'A', name: 'dot:scheduled-turn', purpose: '只在定时任务叫醒的那一轮：没新东西就静默', at: [[D, 401, "name: 'dot:scheduled-turn'", sec], [D, 87, 'export const SCHEDULED_RULE']],
    render: async (R) => run(R[0], { turns: new Map([['s1', { scheduled: true }]]), SCHEDULED_RULE: (await mod(D)).SCHEDULED_RULE }) },

  { id: 'notification', group: 'B', name: 'notificationText', purpose: '手机通知叫醒她的那条消息（+ 未验证身份的提醒）', at: [[D, 68, 'export function notificationText'], [D, 466, 'createUserMessage({ content: [{ type: \'text\', text: items.some'], [D, 509, '（未验证身份）']],
    render: async (R) => {
      const { notificationText } = await mod(D);
      const qqOne = [{ pkg: 'qq', title: '宽(2条新消息)', text: '在吗' }, { pkg: 'qq', title: '宽', text: '帮我看个东西' }];
      const mixed = [{ pkg: 'com.max.xiaoheihe', title: '暮看云', text: '回复了你的评论' }, { pkg: 'qq', title: '宽（未验证身份）', text: '在吗' }];
      let sent = null;
      run(R[1], { found: { agent: { followup: (m) => { sent = m; } } }, createUserMessage: (x) => x, items: [{ unverifiedOwner: true }], text: notificationText(mixed), PHONE_NOTIFICATION_SOURCE: {} }, ';');
      return variant([['一个 QQ 对话', notificationText(qqOne)], ['她忙时来的', notificationText(qqOne[0], { whileBusy: true })], ['两个 App + 未验证身份', sent.content[0].text]]);
    } },
  { id: 'phonecheck', group: 'B', name: 'PHONE_CHECK_TEXT', purpose: '没事也隔一阵拿起手机看一眼', at: [[D, 42, 'export const PHONE_CHECK_TEXT']], render: async () => (await mod(D)).PHONE_CHECK_TEXT },
  { id: 'errand', group: 'B', name: 'errandNote', purpose: '跑腿会话做完后，留在她对话里的一句', at: [[D, 126, 'export function errandNote']],
    render: async () => { const { errandNote } = await mod(D); return variant(['phone-check', 'notification', 'play', 'other'].map((o) => [o, errandNote(o, '小黑盒上暮看云回了我的评论，说他也觉得低频糊。')])); } },
  { id: 'handoff', group: 'B', name: 'renderHandoff', purpose: '15 万 token 交班后，新会话开头的交接', at: [[M, 214, 'export function renderHandoff']],
    render: async () => (await mod(M)).renderHandoff({ now: '窝在床上改简历，有点困', inFlight: ['帮他查广州降温'], promises: ['周五提醒他交 benchmark'], openQuestions: ['他感冒好了没'] }, LINES.slice(-2), 3) },
  { id: 'observation', group: 'B', name: 'observationPrompt', purpose: '幕间「去看」：只读地看一眼', at: [[I, 160, 'export function observationPrompt']],
    render: async () => { const { observationPrompt } = await mod(I); return variant([['电脑浏览器 · 搜索', observationPrompt({ mode: 'search', query: '广州 本周 降温', purpose: '他感冒了，看看天气' }, 'vm')], ['手机 App', observationPrompt({ mode: 'search', query: '新番', purpose: '看看有没有新番' }, 'phone', 'tv.danmaku.bili')]]); } },
  { id: 'play', group: 'B', name: 'playPrompt + PLAY_RULES', purpose: '幕间「玩」：去 App 里点赞、评论、攒表情包', at: [[I, 120, 'export function playPrompt'], [I, 104, 'export const PLAY_RULES']],
    render: async () => { const { playPrompt } = await mod(I); return variant([['comment', playPrompt({ app: '小黑盒', action: 'comment', target: '那篇耳机测评', text: '低频确实糊', why: '她也用这副耳机' }, 'com.max.xiaoheihe')], ['collect', playPrompt({ app: 'B站', action: 'collect', target: '表情包', why: '表情包太少了' }, 'tv.danmaku.bili')]]); } },

  { id: 'extract', group: 'C', name: 'EXTRACT_RULES', purpose: '记忆整理：记录 → owner / self / 人物 / 碎片 / 交班 / 日记（JSON）', at: [[M, 115, 'export const EXTRACT_RULES'], [M, 423, 'const prompt = [']],
    render: async (R) => {
      const mm = await mod(M); const { m } = await sampleMemory();
      return run(R[1], { recent: LINES.slice(0, 2).map(mm.transcriptLine).join('\n'), clip: (s) => s, text: LINES.slice(2).map(mm.transcriptLine).join('\n'), bankless: false, memory: m, known: 'u0002 · 阿满 · qq:42 · talked', frags: m.fragments.map((f) => `${f.id} | ${f.text}`).join('\n'), EXTRACT_RULES: mm.EXTRACT_RULES, withHandoff: true, withDiary: false, dayLabel: mm.dayLabel }, '\nreturn prompt;');
    } },
  { id: 'round', group: 'C', name: 'buildPrompt', purpose: '幕间一轮：HDSI lite 组装的 system + JSON 载荷', at: [[I, 276, 'export function buildPrompt'], [I, 249, 'export const DOT'], [I, 201, 'export const HDSI', { readonly: true, note: 'HDSI 原文（HDS-Interlude 上游逐字照搬，只读）' }]],
    render: async () => {
      const { buildPrompt, renderCanon } = await mod(I);
      const r = buildPrompt({ phase: 'advance', identity: renderCanon(CANON), state: STATE, script: '11-03 14:00：她把窗帘拉开一半，靠在床头改简历。', cursor: Date.now() - 90 * 6e4, now: new Date(), speak: true, model: 'deepseek-chat', entries: [{ owner: 'user', at: '11-03 15:10', content: '在吗' }], browser: 'deferred', play: true, playApps: ['小黑盒', 'B站'], playActions: ['like', 'comment', 'follow', 'collect'], stickers: 2, memories: ['他叫宽，在广州做 AI agent 开发'], herLife: ['装了小黑盒，常在晚上逛'] });
      return variant([['system', r.system], ['user', r.user]]);
    } },
  { id: 'score', group: 'C', name: 'scorePrompt', purpose: '群消息打分（groupPolicy score）：值不值得她插一句', at: [[Q, 255, 'export function scorePrompt']],
    render: async () => { const r = (await mod(Q)).scorePrompt({ who: '小点：二十三岁，话少、直接', recent: '阿满：今晚谁打瓦\n老王：我', message: '小点你上次说的那个耳机多少钱', group: '123456' }); return variant([['system', r.system], ['user', r.user]]); } },

  ...[['memory 工具', M, 576, "description: '你自己的长期记忆"], ['recall 工具', M, 600, "description: '想不起来的时候"], ['qq_send', Q, 1001, "description: '用你的 QQ"], ['qq_sticker_keep', Q, 1011, "description: '把一张图存成"],
    ['interval 工具', I, 348, "description: 'Write this interval"], ['/dot', D, 565, "description: 'dot status"], ['/qq', Q, 1032, "description: 'her QQ on the computer"], ['/phone', P, 603, "description: 'the phone: status"], ['/interlude', I, 925, "description: '幕间 status"]]
    .map(([name, f, line, find]) => ({ id: `d-${name.replace(/\W/g, '') || line}`, group: 'D', name, purpose: name.startsWith('/') ? '命令说明（给人看，模型也会见到）' : '工具说明（模型据此决定怎么调用）', at: [[f, line, find, { line: true, readonly: true }]],
      render: async (R) => R[0].pieces[0]?.value ?? '' })),
];
export const GROUPS = { A: 'A. 系统提示词', B: 'B. 注入的用户消息', C: 'C. 独立模型调用', D: 'D. 工具说明（只读）' };
const FULL = [['canon', 'section · 部署人设 +1'], ['rules', 'section · 部署人设 +2'], ['phone', 'section · 60'], ['qq', 'section · 61'], ['scheduled', 'context · 900（只在定时任务那一轮）'], ['memory', 'context · 904'], ['recall', 'context · 905'], ['interlude', 'context · 905']];

// ── a small JS scanner: string / template literals (with ${} parts), comments, regexes, brackets ──
function lit(s, i, out) {
  const q = s[i];
  let j = i + 1;
  if (q !== '`') { while (s[j] !== q) j += s[j] === '\\' ? 2 : 1; out.push({ start: i, end: j + 1, parts: null }); return j + 1; }
  const parts = [];
  let a = j;
  while (s[j] !== '`') {
    if (s[j] === '\\') j += 2;
    else if (s[j] === '$' && s[j + 1] === '{') { parts.push([a, j]); j = walk(s, j + 2, out, true); a = j; } else j++;
  }
  parts.push([a, j]);
  out.push({ start: i, end: j + 1, parts });
  return j + 1;
}
/** From `i`, the end of one statement (or, with `expr`, of the `${…}` it is inside); literals go to `out`. */
function walk(s, i, out, expr = false) {
  let depth = 0, prev = '(';
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') { i = lit(s, i, out) - 1; prev = 'x'; continue; }
    if (c === '/' && s[i + 1] === '/') { i = s.indexOf('\n', i) - 1; continue; }
    if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i) + 1; continue; }
    if (c === '/' && '(,=:[!&|?{};+'.includes(prev)) {
      let k = i + 1, cls = false;
      for (; s[k] !== '/' || cls; k++) { if (s[k] === '\\') k++; else if (s[k] === '[') cls = true; else if (s[k] === ']') cls = false; }
      for (i = k; /[a-z]/.test(s[i + 1]); i++);
      prev = 'x'; continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) return expr ? i + 1 : i; depth--; } else if (!expr && depth === 0 && c === ';') return i + 1;
    else if (!expr && depth === 0 && c === '\n' && !'=+,(:?&|.'.includes(prev) && !/^\s*[+.?:|&]/.test(s.slice(i + 1, i + 40))) return i;
    if (!/\s/.test(c)) prev = c;
  }
  return i;
}
const lineAt = (s, at) => s.slice(0, at).split('\n').length;
const decode = (raw, kind) => new Function(`return ${kind === 'q' ? `\`${raw}\`` : raw}`)();
const encT = (v) => v.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const encode = (v, kind, q) => (kind === 'q' ? encT(v) : kind === 'tpl' ? `\`${encT(v)}\``
  : q + v.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), `\\${q}`).replace(/\n/g, '\\n').replace(/\r/g, '\\r') + q);
const worth = (v) => v.length >= 4 && (/[　-鿿＀-￯]/.test(v) || (v.length >= 30 && / /.test(v)));

export function locate([file, line, find]) {
  const ls = read(file).split('\n');
  const at = ls[line - 1]?.includes(find) ? line : ls.findIndex((l) => l.includes(find)) + 1;
  if (!at) throw new Error(`${file}: 找不到「${find}」`);
  return { line: at, drift: at !== line };
}
function region(anchor) {
  const [file, , , o = {}] = anchor;
  const src = read(file);
  const { line, drift } = locate(anchor);
  const start = line - (o.back ?? 0);
  const a = src.split('\n').slice(0, start - 1).join('\n').length + (start > 1 ? 1 : 0);
  const a2 = a + /^\s*/.exec(src.slice(a))[0].length;
  const out = [];
  let end;
  if (o.line) { end = src.indexOf('\n', a); for (let i = a2; i < end; i++) if (`'"\``.includes(src[i])) i = lit(src, i, out) - 1; } else end = walk(src, a2, out);
  const readonly = Boolean(o.readonly);
  const pieces = [];
  for (const l of out.sort((x, y) => x.start - y.start)) {
    const spans = !l.parts ? [[l.start, l.end, 'str']] : l.parts.length === 1 ? [[l.start, l.end, 'tpl']] : l.parts.map(([x, y]) => [x, y, 'q']);
    for (const [x, y, kind] of spans) {
      const raw = src.slice(x, y);
      let value;
      try { value = decode(raw, kind); } catch { continue; }
      if (!worth(value)) continue;
      const n = src.split(raw).length - 1;
      pieces.push({ line: lineAt(src, x), raw, kind, quote: kind === 'str' ? raw[0] : '`', value, editable: !readonly && n === 1, why: readonly ? '只读' : n === 1 ? '' : `源文件里出现 ${n} 次，不能原地改` });
    }
  }
  return { file, line, drift, start, end: lineAt(src, end), text: src.slice(a, end), code: src.slice(a2, end), readonly, note: o.note ?? '', pieces };
}
const byId = (id) => inventory.find((x) => x.id === id);
export async function renderItem(it) {
  const regions = it.at.map(region);
  let rendered;
  try { rendered = String(await it.render(regions)); } catch (err) { rendered = `（渲染失败：${err.stack}）`; }
  return { regions, rendered };
}
async function full() {
  const parts = [];
  for (const [id, where] of FULL) { const it = byId(id); parts.push(`━━━━ ${it.name} · ${where} ━━━━\n${(await renderItem(it)).rendered || '（空）'}`); }
  return parts.join('\n\n');
}
function save({ id, r, p, raw, value }) {
  const it = byId(id);
  if (!it) throw new Error('没有这一项');
  const reg = region(it.at[r]);
  const piece = reg.pieces[p];
  if (!piece || piece.raw !== raw) throw new Error('源文件已经变了，刷新后再改');
  if (!piece.editable) throw new Error(piece.why);
  const path = join(ROOT, reg.file), before = readFileSync(path, 'utf8');
  const n = before.split(raw).length - 1;
  if (n !== 1) throw new Error(`原文在 ${reg.file} 里找到 ${n} 处（要恰好 1 处），没改`);
  if (value === piece.value) return '没有变化';
  writeFileSync(path, before.replace(raw, () => encode(value, piece.kind, piece.quote)));
  try { execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' }); } catch (err) {
    writeFileSync(path, before);
    throw new Error(`node --check 没过，已还原：\n${String(err.stderr || err.message).trim()}`);
  }
  return `已保存 ${reg.file}:${piece.line}`;
}
function open({ file, line }) {
  if (!inventory.some((it) => it.at.some((a) => a[0] === file))) throw new Error('不在清单里的文件');
  const target = `${join(ROOT, file)}:${Number(line) || 1}`;
  return new Promise((ok) => {
    const child = spawn('code', ['-g', target], { stdio: 'ignore', detached: true });
    child.on('error', () => { console.log(`open: ${target}`); ok(`没找到 code 命令，路径：${target}`); });
    child.on('spawn', () => { child.unref(); ok(`已在编辑器里打开 ${file}:${line}`); });
  });
}

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dot 提示词</title><style>
:root{--bg:#fafaf9;--fg:#1c1917;--mute:#78716c;--line:#e7e5e4;--card:#fff;--acc:#4f46e5;--warn:#b45309;--code:#f5f5f4}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#e7e5e4;--mute:#a8a29e;--line:#292524;--card:#1c1917;--acc:#818cf8;--warn:#f59e0b;--code:#141210}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;display:grid;grid-template-columns:300px 1fr;height:100vh}
nav{border-right:1px solid var(--line);overflow:auto;padding:12px}main{overflow:auto;padding:20px 28px}
nav h3{font-size:12px;color:var(--mute);margin:16px 0 4px}nav a{display:block;padding:6px 8px;border-radius:6px;cursor:pointer;color:inherit;text-decoration:none}
nav a:hover,nav a.on{background:var(--code)}nav a b{font-weight:600}nav a small{display:block;color:var(--mute);font-size:12px}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px;white-space:pre-wrap;word-break:break-word;font:13px/1.55 ui-monospace,Menlo,Consolas,monospace;margin:6px 0 16px}
h2{margin:0 0 4px}h4{margin:20px 0 4px}.mute{color:var(--mute)}.warn{color:var(--warn)}
button{background:var(--acc);color:#fff;border:0;border-radius:6px;padding:4px 12px;cursor:pointer;font:inherit}button.ghost{background:none;color:var(--acc);border:1px solid var(--line)}
textarea{width:100%;min-height:60px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px;font:13px/1.55 ui-monospace,Menlo,Consolas,monospace}
.piece{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:8px 0;background:var(--card)}.row{display:flex;gap:8px;align-items:center;margin:4px 0}#msg{position:fixed;right:16px;bottom:16px;max-width:520px;white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;display:none}
</style></head><body><nav id="nav"></nav><main id="main"><p class="mute">选左边一项。</p></main><div id="msg"></div><script>
const $ = (t, a = {}, ...kids) => { const e = document.createElement(t); for (const [k, v] of Object.entries(a)) k.startsWith('on') ? e.addEventListener(k.slice(2), v) : e.setAttribute(k, v); for (const c of kids.flat()) c != null && e.append(c); return e; };
const api = (p, body) => fetch(p, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-prompts': '1' }, body: JSON.stringify(body) } : {}).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; });
const say = (t, bad) => { const m = document.getElementById('msg'); m.textContent = t; m.className = bad ? 'warn' : ''; m.style.display = 'block'; clearTimeout(say.t); say.t = setTimeout(() => { m.style.display = 'none'; }, bad ? 9000 : 3000); };
const openBtn = (file, line) => $('button', { class: 'ghost', onclick: () => api('/api/open', { file, line }).then((r) => say(r.text), (e) => say(e.message, true)) }, '在编辑器里打开');
let cur = '';
async function nav() {
  const { items, groups } = await api('/api/items');
  const n = document.getElementById('nav');
  n.replaceChildren($('a', { onclick: () => full(), id: 'n-full' }, $('b', {}, '全貌'), $('small', {}, '她对话的系统提示词，从上到下')));
  for (const [g, title] of Object.entries(groups)) {
    n.append($('h3', {}, title));
    for (const it of items.filter((x) => x.group === g)) n.append($('a', { id: 'n-' + it.id, onclick: () => show(it.id) }, $('b', {}, it.name), $('small', {}, it.at.map((a) => a.file.replace('src/', '') + ':' + a.line + (a.drift ? '（行号已漂移）' : '')).join(' · ')), $('small', {}, it.purpose)));
  }
}
const mark = (id) => document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.id === 'n-' + id));
async function full() { cur = ''; mark('full'); const { text } = await api('/api/full'); document.getElementById('main').replaceChildren($('h2', {}, '全貌'), $('p', { class: 'mute' }, '她的对话里，系统提示词按顺序拼起来的样子（样例输入）。dsh 自己的段落不在这里。'), $('pre', {}, text)); }
async function show(id) {
  cur = id; mark(id);
  const it = await api('/api/item?id=' + id);
  const main = document.getElementById('main');
  main.replaceChildren($('h2', {}, it.name), $('p', { class: 'mute' }, it.purpose), $('h4', {}, '模型看到的（样例输入）'), $('pre', {}, it.rendered || '（空）'));
  it.regions.forEach((r, ri) => {
    main.append($('h4', {}, r.file + ':' + r.start + '–' + r.end + ' ', r.drift ? $('span', { class: 'warn' }, '（清单里的行号已漂移，按标识找到 ' + r.line + ' 行）') : '', r.note ? $('span', { class: 'warn' }, r.note) : ''), $('div', { class: 'row' }, openBtn(r.file, r.line)));
    const editable = r.pieces.filter((p) => p.editable).length;
    if (r.pieces.length) main.append($('p', { class: 'mute' }, r.readonly ? '只读。' : '文字片段 ' + r.pieces.length + ' 段，可原地改 ' + editable + ' 段；其余是代码拼接，用编辑器改。'));
    if (!r.readonly) r.pieces.forEach((p, pi) => {
      const ta = $('textarea', { rows: Math.min(14, p.value.split('\\n').length + Math.ceil(p.value.length / 90)) }); ta.value = p.value;
      if (!p.editable) ta.readOnly = true;
      main.append($('div', { class: 'piece' }, $('div', { class: 'row mute' }, r.file + ':' + p.line + ' · ' + { str: '字符串', tpl: '模板字符串', q: '模板里的一段（\${…} 之间）' }[p.kind], p.why ? $('span', { class: 'warn' }, ' · ' + p.why) : ''), ta,
        p.editable ? $('div', { class: 'row' }, $('button', { onclick: () => api('/api/save', { id, r: ri, p: pi, raw: p.raw, value: ta.value }).then((x) => { say(x.text); show(id); }, (e) => say(e.message, true)) }, '保存')) : null));
    });
    main.append($('pre', {}, r.text));
  });
}
nav();
</script></body></html>`;

export function serve(port = Number(process.env.PORT) || 7870) {
  const okHost = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const server = createServer(async (req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    // Loopback only, and writes need a header a cross-site page cannot send without a preflight.
    if (!okHost.has(req.headers.host)) return send(403, { error: 'host' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(200, PAGE, 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/items') return send(200, { groups: GROUPS, items: inventory.map((it) => ({ id: it.id, group: it.group, name: it.name, purpose: it.purpose, at: it.at.map((a) => ({ file: a[0], ...locate(a) })) })) });
      if (req.method === 'GET' && url.pathname === '/api/item') { const it = byId(url.searchParams.get('id')); if (!it) return send(404, { error: '没有这一项' }); return send(200, { id: it.id, name: it.name, purpose: it.purpose, ...(await renderItem(it)) }); }
      if (req.method === 'GET' && url.pathname === '/api/full') return send(200, { text: await full() });
      if (req.method === 'POST' && req.headers['x-prompts'] === '1') {
        let body = '';
        for await (const c of req) body += c;
        const args = JSON.parse(body || '{}');
        if (url.pathname === '/api/save') return send(200, { text: save(args) });
        if (url.pathname === '/api/open') return send(200, { text: await open(args) });
      }
      send(404, { error: 'not found' });
    } catch (err) { send(400, { error: err.message }); }
  });
  server.listen(port, '127.0.0.1', () => console.log(`dot 提示词: http://127.0.0.1:${port}/`));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();

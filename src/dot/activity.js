// dsh-dot/dot activity: the panel's "last N scenes" — one row per time something woke her (his
// message, a QQ message, a phone notification, picking up her phone, a 幕间 round, a scheduled task,
// a play) until that turn ended, with what she did in it, in her own words, and what it cost.
//
// Nothing new is written for this: every scene is read back from records that already exist —
//   $DSH_HOME/dsh-computer-audit.jsonl, dsh-phone-audit.jsonl   kind dot / interlude / memory / tool / approval-asked
//   $DSH_HOME/dsh-qq-audit.jsonl                               message / sent / sticker-kept / approval-asked
//   <home>/memory/transcript.jsonl                             his words, scheduled tasks, notes her errands left, her replies
//   <home>/memory/calls.jsonl + diary.md                       the daily call and the diary it wrote
//   <home>/interlude/calls.jsonl + script.md                   each 幕间 round: tokens, and the passage it wrote
// Only the tail of each file is read (the last few days, a bounded number of bytes), and a file is
// parsed again only when its size or mtime changed, so the panel's 3-second poll stays cheap.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_SCENES = 30;
const DAY = 86400000;
const WINDOW = 10 * 60000; // an event belongs to a scene that saw something this recently
const MERGE = 20000;      // two records of one wake (audit line + transcript line) are this close
const CLIP = 80;

const clip = (s, n = CLIP) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const timeOf = (v) => (typeof v === 'number' ? v : Date.parse(v ?? '')) || 0;

/** The last `maxBytes` of a file as lines (a partial first line dropped); `.1` (rotated audit) fills up what is left. */
export function tailLines(file, maxBytes = 1 << 20) {
  const read = (f, budget) => {
    let fd;
    try {
      const size = statSync(f).size;
      if (!size || budget <= 0) return { lines: [], size };
      const len = Math.min(size, budget);
      const buf = Buffer.alloc(len);
      fd = openSync(f, 'r');
      readSync(fd, buf, 0, len, size - len);
      let text = buf.toString('utf8');
      if (len < size) text = text.slice(text.indexOf('\n') + 1);
      return { lines: text.split('\n').filter(Boolean), size };
    } catch (error) { void error; return { lines: [], size: 0 }; } finally { if (fd !== undefined) try { closeSync(fd); } catch (error) { void error; } }
  };
  const cur = read(file, maxBytes);
  if (cur.size >= maxBytes || !file.endsWith('.jsonl')) return cur.lines;
  return [...read(`${file}.1`, maxBytes - cur.size).lines, ...cur.lines];
}

const parseJsonl = (lines) => lines.map((l) => { try { return JSON.parse(l); } catch (error) { void error; return null; } }).filter(Boolean);

/** "## <head>\n<body>" sections (script.md, diary.md). */
export function sections(text) {
  return String(text ?? '').split(/^## /m).filter((x) => x.trim()).map((x) => { const [head, ...body] = x.split('\n'); return { head: head.trim(), text: body.join('\n').trim() }; });
}
/** "2026-11-03 14:05 星期二 下午 · advance" → local ms (to the minute). */
const headTime = (head) => { const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(head); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : 0; };
/** First sentence of a passage. */
export const firstSentence = (text) => { const line = String(text ?? '').trim().split('\n')[0]; return clip(/^.*?[。！？!?…]+[”」』]?/.exec(line)?.[0] ?? line); };
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const APP = { qq: 'QQ', 'com.tencent.mobileqq': 'QQ', 'com.tencent.mm': '微信', 'com.max.xiaoheihe': '小黑盒', 'tv.danmaku.bili': 'B站', 'com.sina.weibo': '微博', 'com.xingin.xhs': '小红书', 'com.zhihu.android': '知乎', 'com.ss.android.ugc.aweme': '抖音', 'com.coolapk.market': '酷安', 'com.baidu.tieba': '贴吧', 'com.douban.frodo': '豆瓣', 'com.taobao.taobao': '淘宝', 'com.eg.android.AlipayGphone': '支付宝', 'org.telegram.messenger': 'Telegram', 'com.android.chrome': 'Chrome' };
const appName = (pkg) => APP[pkg] ?? String(pkg ?? '').split('.').pop() ?? '';
const PLAY_KEY = { like: 'like', comment: 'comment', follow: 'follow', collect: 'sticker', post: 'post' };
const PHASE = { advance: 'advance', 'follow-up': 'follow-up', intent: 'intent', seed: 'seed' };

/**
 * Turn the records into scenes, newest first.
 * @param {object} src - parsed records: audit (computer+phone audit), qq, transcript, interludeCalls, script, memoryCalls, diary.
 * @param {object} opts - now, limit, days, busy(session) → bool, isErrand(session) → bool,
 *   turnOf(session) → { state: 'running'|'stalled'|'approval'|'timed-out', idleMs, waitMs? } for an open turn.
 * Each scene: { at, end, session, source: { kind, name? }, status: 'running'|'stalled'|'approval'|'timed-out'|'done'|'failed',
 *   minutes? (stalled: since the last event; approval: waiting), trigger?,
 *   actions: [{ k, text, via? }], stats: { tools, model, in, out } }. Action and source kinds are keys;
 *   the page words them (zh/en).
 */
export function buildScenes(src, { now = Date.now(), limit = DEFAULT_SCENES, days = 3, busy = () => false, isErrand = () => false, turnOf = () => null } = {}) {
  const since = now - days * DAY;
  const ev = [];
  const push = (t, type, e) => { if (t >= since && t <= now + 60000) ev.push({ t, type, e }); };
  for (const e of src.audit ?? []) push(timeOf(e.ts), e.kind === 'dot' || e.kind === 'interlude' || e.kind === 'memory' ? `${e.kind}:${e.event}` : e.kind, e);
  for (const e of src.qq ?? []) push(timeOf(e.ts), `qq:${e.kind}`, e);
  for (const e of src.transcript ?? []) push(timeOf(e.at), `tr:${e.who}`, e);
  for (const e of src.interludeCalls ?? []) push(timeOf(e.ts), String(e.phase ?? '').endsWith(':refresh') ? 'ic:refresh' : 'ic:round', e);
  for (const e of src.memoryCalls ?? []) if (/daily|diary/.test(String(e.reason ?? ''))) push(timeOf(e.at), 'mc:diary', e);
  ev.sort((a, b) => a.t - b.t);
  const qqAudited = (src.qq ?? []).length > 0;
  // qq.js audits a message as { kind: 'message', ...msg }: msg.kind wins, so the line's kind is private / group.
  const qqMessages = ev.filter((x) => ['qq:private', 'qq:group', 'qq:message'].includes(x.type));
  const phoneNotes = ev.filter((x) => x.type === 'notification');
  const scripts = (src.script ?? []).map((s) => ({ t: headTime(s.head), text: s.text, phase: s.head.split('·').pop().trim() }));
  const diary = new Map((src.diary ?? []).map((d) => [d.head.slice(0, 10), d.text]));

  const scenes = [];
  const open = (t, session, source, extra = {}) => {
    const s = { at: t, end: t, session: session || '', source, status: 'done', trigger: '', actions: [], stats: { tools: 0, model: 0, in: 0, out: 0 }, ...extra };
    scenes.push(s); return s;
  };
  const recent = (t, pred = () => true, win = WINDOW) => { for (let i = scenes.length - 1; i >= 0; i--) { const s = scenes[i]; if (s.at <= t + 3000 && t - s.end <= win && pred(s)) return s; if (t - s.end > DAY) break; } return null; };
  const sameWake = (t, session, kinds) => recent(t, (s) => s.session === session && kinds.includes(s.source.kind) && Math.abs(t - s.at) <= MERGE, MERGE);
  const act = (s, k, text, extra = {}) => {
    if (!s) return;
    const body = clip(text);
    const key = body.replace(/[\s/·，。,.!?！？]/g, '').slice(0, 24);
    if (key && s.actions.some((a) => a.key === key)) return; // one thing seen in two records (QQ relay + transcript)
    s.actions.push({ k, text: body, key, ...extra });
  };
  const touch = (s, t) => { if (s && t > s.end) s.end = t; };
  const nearBefore = (list, t, pred, win = 120000) => { for (let i = list.length - 1; i >= 0; i--) { const x = list[i]; if (x.t > t + 2000) continue; if (t - x.t > win) return null; if (pred(x.e)) return x.e; } return null; };
  const qqSource = (m) => (m.kind === 'group' ? { kind: 'qq', name: `群 ${m.groupId} · ${m.who}` } : { kind: 'qq', name: m.who || m.userId });

  for (const { t, type, e } of ev) {
    switch (type) {
      // ── wakes ──
      case 'tr:owner': case 'dot:owner-message': {
        const s = sameWake(t, e.session, ['owner']) ?? open(t, e.session, { kind: 'owner' });
        if (type === 'tr:owner') s.trigger ||= clip(e.text);
        else { const m = nearBefore(qqMessages, t, (x) => x.fromOwner); if (m) { s.viaQq = true; s.trigger ||= clip(m.text); } }
        touch(s, t); break;
      }
      case 'dot:notification-woke': {
        const pkgs = [].concat(e.pkgs ?? []);
        let s = sameWake(t, e.session, ['notify']);
        if (!s) {
          const qqMsg = pkgs.includes('qq') ? nearBefore(qqMessages, t, (x) => !x.fromOwner) : null;
          const note = !qqMsg ? nearBefore(phoneNotes, t, (x) => pkgs.includes(x.pkg)) : null;
          s = open(t, e.session, qqMsg ? qqSource(qqMsg) : { kind: 'phone', name: appName(pkgs[0]) });
          s.source.kind = qqMsg ? 'qq' : 'phone';
          s.wakeKind = 'notify';
          if (qqMsg) { s.trigger = clip(qqMsg.text); s.viaQq = true; } else if (note) s.trigger = clip(`${note.title ? `${note.title}：` : ''}${note.text ?? ''}`);
          if (e.count > 1) s.count = e.count;
        }
        touch(s, t); break;
      }
      case 'tr:phone': {
        // The notification as her conversation read it; joins the wake it belongs to.
        const s = recent(t, (x) => x.session === e.session && x.wakeKind === 'notify' && Math.abs(t - x.at) <= MERGE, MERGE);
        const text = String(e.text ?? '').replace(/^\[手机通知\]\s*/, '');
        if (s) { s.trigger ||= clip(text); touch(s, t); break; }
        const m = /^(\S+?)\s*·\s*([^：:]+)[：:]/.exec(text);
        const n = open(t, e.session, m?.[1] === 'QQ' ? { kind: 'qq', name: m[2].trim() } : { kind: 'phone', name: m?.[1] ?? '' }, { wakeKind: 'notify' });
        n.trigger = clip(m ? text.slice(m[0].length) : text); break;
      }
      case 'dot:phone-check': open(t, e.session, { kind: 'check' }); break;
      case 'tr:schedule': { const s = open(t, e.session, { kind: 'schedule' }); s.trigger = clip(e.text); break; }
      case 'ic:round': {
        const sc = scripts.find((x) => Math.abs(x.t - Math.floor(t / 60000) * 60000) < 60000 && (!x.phase || x.phase === e.phase)) ?? scripts.find((x) => Math.abs(x.t - t) < 120000);
        const s = open(t, 'interlude', { kind: 'interlude', name: PHASE[e.phase] ?? e.phase ?? '' }, { round: true, roundOpen: true });
        s.stats.model = 1; s.stats.in = (e.usage?.in ?? 0) + (e.usage?.cached ?? 0); s.stats.out = e.usage?.out ?? 0;
        if (sc) act(s, 'interlude', firstSentence(sc.text));
        break;
      }
      case 'interlude:play': {
        const s = open(t, e.session, { kind: 'play', name: e.app ?? '' });
        s.trigger = clip(e.why ?? '');
        act(s, PLAY_KEY[e.action] ?? 'play', `${e.app ?? ''} · ${e.target ?? ''}`);
        break;
      }
      case 'interlude:try': {
        const s = open(t, e.session ?? '', { kind: 'play', name: '试点新的' });
        s.trigger = clip(e.why ?? '');
        act(s, 'try', e.what ?? '');
        break;
      }
      case 'mc:diary': {
        const text = diary.get(localDay(t));
        if (!text) break;
        const s = open(t, 'memory', { kind: 'schedule', name: 'diary' });
        s.stats.model = 1; s.stats.in = e.usage?.in ?? 0; s.stats.out = e.usage?.out ?? 0;
        act(s, 'diary', text);
        break;
      }
      // ── what she did ──
      case 'ic:refresh': { const s = recent(t, (x) => x.round, 30 * 60000); if (s) { s.stats.model++; s.stats.in += (e.usage?.in ?? 0) + (e.usage?.cached ?? 0); s.stats.out += e.usage?.out ?? 0; } break; }
      case 'interlude:round': { const s = recent(t, (x) => x.roundOpen, 30 * 60000); if (s) { s.roundOpen = false; touch(s, t); } break; }
      case 'interlude:round-failed': { const s = recent(t, (x) => x.roundOpen, 30 * 60000); if (s) { s.roundOpen = false; s.status = 'failed'; touch(s, t); } break; }
      case 'interlude:browse': {
        const s = recent(t, (x) => x.round, 30 * 60000) ?? recent(t);
        act(s, 'look', e.query ?? '', { via: e.via === 'web' ? 'web' : e.via === 'phone' ? 'phone' : 'computer' }); touch(s, t); break;
      }
      case 'qq:sent': {
        const s = recent(t, (x) => x.roundOpen, 30 * 60000) ?? recent(t, (x) => !x.round && !isErrand(x.session)) ?? open(t, '', { kind: 'qq', name: e.to?.group_id ? `群 ${e.to.group_id}` : String(e.to?.user_id ?? '') });
        const images = [].concat(e.images ?? []);
        if (e.text) act(s, s.round ? 'contact' : 'qq', e.text);
        if (images.length) act(s, 'image', images.join(' '));
        touch(s, t); break;
      }
      case 'qq:sticker-kept': {
        const s = recent(t, (x) => !x.round) ?? open(t, '', { kind: 'qq', name: e.from === 'self' ? '' : e.from });
        act(s, 'sticker', e.from === 'self' ? (e.note || e.id) : `${e.from} · ${e.id}`); touch(s, t); break;
      }
      case 'tr:note': {
        // What an errand found, left in her conversation: belongs to the errand scene that just ended.
        const s = recent(t, (x) => (isErrand(x.session) || ['check', 'play'].includes(x.source.kind) || (x.wakeKind === 'notify' && x.session !== e.session)) && x.session !== e.session, 15 * 60000)
          ?? recent(t, (x) => x.session === e.session);
        act(s, 'saw', String(e.text ?? '').replace(/^\[[^\]]*\]\s*/, '')); touch(s, t); break;
      }
      case 'tr:her': {
        if (e.to && qqAudited) break; // her qq_send: the QQ audit has it
        const s = recent(t, (x) => x.session === e.session);
        act(s, s?.viaQq || e.to ? 'qq' : 'reply', e.text); touch(s, t); break;
      }
      case 'tool': { const s = recent(t, (x) => x.session === e.session); if (s) { s.stats.tools++; touch(s, t); } break; }
      case 'approval-asked': case 'qq:approval-asked': {
        const s = recent(t, (x) => x.session === e.session) ?? recent(t);
        const tool = String(e.tool ?? '');
        if (/install_app/.test(tool)) act(s, 'install', tool.replace(/^.*__/, ''));
        else act(s, 'approval', `${tool.replace(/^.*__/, '')}${e.reason ? ` · ${String(e.reason).split('\n')[0]}` : ''}`);
        touch(s, t); break;
      }
      case 'dot:silent': { const s = recent(t, (x) => x.session === e.session); if (s) { s.quiet = true; touch(s, t); } break; }
      default:
    }
  }
  // Status: a scene is running while its session is in a turn and it is that session's latest, or while its round has not closed.
  const latest = new Map();
  for (const s of scenes) latest.set(s.session, s);
  for (const s of scenes) {
    if (s.status === 'failed') continue;
    if (s.round ? s.roundOpen && now - s.at < 15 * 60000 : s.session && latest.get(s.session) === s && busy(s.session)) s.status = 'running';
    // Her open turn as the watchdog sees it: stalled, waiting on an approval, or stalled after one expired.
    const t = s.status === 'running' && !s.round ? turnOf(s.session) : null;
    if (t && t.state !== 'running') { s.status = t.state; s.minutes = Math.floor((t.state === 'approval' ? t.waitMs : t.idleMs) / 60000); }
  }
  return scenes.slice(-limit).reverse().map(({ at, end, session, source, status, minutes, trigger, actions, stats, quiet, count }) => ({
    at, end, session, source, status, ...(minutes !== undefined ? { minutes } : {}), ...(trigger ? { trigger } : {}), ...(quiet && !actions.length ? { quiet: true } : {}), ...(count ? { count } : {}),
    actions: actions.slice(0, 20).map(({ key, ...a }) => { void key; return a; }), stats,
  }));
}

/** Reads the records (tails, cached by size+mtime) and builds the scenes. */
export function createActivity({ dshHome, home, maxBytes = 1 << 20, days = 3 }) {
  const cache = new Map();
  const load = (file, parse, bytes = maxBytes) => {
    let st;
    try { st = statSync(file); } catch (error) { void error; cache.delete(file); return parse([]); }
    let rot = 0;
    try { rot = statSync(`${file}.1`).mtimeMs; } catch (error) { void error; }
    const sig = `${st.size}:${st.mtimeMs}:${rot}`;
    const hit = cache.get(file);
    if (hit?.sig === sig) return hit.value;
    const value = parse(tailLines(file, bytes));
    cache.set(file, { sig, value });
    return value;
  };
  const dsh = (n) => join(dshHome, n);
  const md = (lines) => sections(lines.join('\n'));
  return {
    read() {
      return {
        audit: [...load(dsh('dsh-computer-audit.jsonl'), parseJsonl), ...load(dsh('dsh-phone-audit.jsonl'), parseJsonl)],
        qq: load(dsh('dsh-qq-audit.jsonl'), parseJsonl),
        transcript: load(join(home, 'memory', 'transcript.jsonl'), parseJsonl),
        memoryCalls: load(join(home, 'memory', 'calls.jsonl'), parseJsonl, maxBytes / 4),
        diary: load(join(home, 'memory', 'diary.md'), md, 64 << 10),
        interludeCalls: load(join(home, 'interlude', 'calls.jsonl'), parseJsonl),
        script: load(join(home, 'interlude', 'script.md'), md, 256 << 10),
      };
    },
    scenes(opts = {}) { return buildScenes(this.read(), { days, ...opts }); },
  };
}

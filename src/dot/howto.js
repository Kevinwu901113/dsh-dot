// dsh-dot/howto: the know-how book (手艺簿) — what her hands learn using her phone and computer, written after a
// thing from what was actually done, read back the next time they are there. 越用越快、越准、越省.
//
// Places: 'phone' (the phone itself: home screen, settings, notification shade, keyboard, system dialogs),
// 'computer', and each app on the phone. The unit is a thing (dot/ledger.js): every device call her hands make
// while a thing runs is a step of that thing in the place it happened (the app in front after it; a batch counts
// its steps), with the short error type of a step that failed.
//   record   when the thing ends: one line per place in <home>/her/howto/_log.jsonl — steps, errors, the thing's
//            outcome (the book's, not anyone's report), its time and cost, and its share of the thing's steps
//   reflect  a place worth learning from (real errors, clearly more steps than usual, a first long run, or a run
//            that broke off): one small call reads the calls made there (never the screen's text), the outcome,
//            the notes, and the runs before, and rewrites the notes — pitfalls, and the short ways that worked
//            (only from a run that was done). It also names the task, so the same task's runs line up: done how
//            often, in how many steps, at what cost. A call one of her own rules refused (src/refusals.js) is
//            marked ⊘ and is no lesson. Notes from before refusals were told apart (no _meta.json) are read over
//            once (`review`) before they are given again. One reflection per place at a time; at most one per
//            place per hour and a few a day.
//   recall   the first time her hands are in a place in a thing, its notes come along with the call's result,
//            with how the tasks there went — as reference, not instructions
// The notes are plain files (<home>/her/howto/<place>.md): she, or he, can edit them.
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { wasRefused } from '../refusals.js';
import { head } from '../cut.js';

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${head(t, n)}…` : t; };
const read = (f) => { try { return readFileSync(f, 'utf8'); } catch (error) { void error; return ''; } };
/** Write whole, or not at all (tmp + rename). */
const writeAtomic = (f, text) => { const tmp = `${f}.tmp`; writeFileSync(tmp, text); renameSync(tmp, f); };
/** A file name for a place: no path separators or oddities. */
export const fileOf = (app) => `${String(app || 'phone').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)}.md`;
/** Web addresses never go into the notes. */
const noUrls = (s) => String(s ?? '').replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '（链接）');
/** An error as a short type: the first line, no addresses, no quoted text from the screen. */
export const errorType = (e) => clip(noUrls(String(e ?? '').split('\n')[0]).replace(/[「“"].{12,}?[」”"]/g, '"…"'), 100);
/** Refusals (gates, his yes, the phone busy) are not mistakes in the app. */
export const isRefusal = (e) => wasRefused(e) || /denied|rejected|not allowed|approval|审批|批准|拒绝|被拦|用不了|lease|另一个会话|同一件事已经试了|要先问过他|要他本人来|这一步不做|dsh-interlude:|dsh-dot/i.test(String(e ?? ''));
/** What a place is called where it is read: the phone itself and the computer have no app name. */
export const placeName = (app) => (app === 'phone' ? '这台手机（桌面、设置、通知栏、输入法、系统弹窗）' : app === 'computer' ? '这台电脑' : app);
/** Outcomes that are a run that broke off: worth a lesson even when short. */
const BROKE = new Set(['failed', 'timeout']);

/** One call as it is read back: "launch_app(com.max.xiaoheihe)", "click(421,428)", "type(浮游世界)". */
export function callLine(tool, input) {
  const short = String(tool).replace(/^.*__/, '').replace(/^mobile_/, '');
  const a = input && typeof input === 'object' ? input : {};
  const bits = [];
  for (const k of ['packageName', 'text', 'button', 'direction', 'url', 'command', 'x', 'y']) if (a[k] !== undefined && a[k] !== '') bits.push(k === 'x' || k === 'y' ? a[k] : clip(k === 'url' ? noUrls(a[k]) : a[k], 30));
  const list = batchSteps(a);
  if (list) bits.push(list.map((s) => String(s?.name ?? s?.tool ?? '').replace(/^mobile_/, '')).join('+'));
  return `${short}(${bits.join(',')})`;
}
/** The steps of a mobile_batch_commands call, or null. */
export const batchSteps = (a) => { const l = a?.steps ?? a?.commands; return Array.isArray(l) ? l : null; };
/** The app a batch opens, if it does. */
export const batchLaunch = (a) => (batchSteps(a) ?? []).map((s) => s?.arguments?.packageName ?? s?.args?.packageName ?? s?.packageName).find(Boolean) ?? '';
/** Failed steps reported inside a batch's text result ("Step 3 (…) failed: …"). */
export const batchFailures = (text) => [...String(text ?? '').matchAll(/Step \d+[^\n]*?\) failed:([^\n]*)/g)].map((m) => m[1].trim());

/** The reply tool of the reflection: provider-validated JSON. */
export function howtoTool() {
  return {
    name: 'howto',
    description: 'The rewritten notes for this place. Call it exactly once.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '这次在这里做的事的短名（八个字以内，如「登录」「发帖」「看消息」）；和 knownTasks 里某个是同一件事，就用那个名字' },
        notes: { type: 'string', description: '这里的经验笔记全文（Markdown，中文）' },
      },
      required: ['notes'],
    },
  };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const day = (at) => `${new Date(at).getMonth() + 1}-${new Date(at).getDate()}`;

export function createHowto({ dir, minSteps = 12, maxChars = 800, keepRuns = 400, cooldownMs = 3600000, dailyReflections = 8, now = () => Date.now() } = {}) {
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, '_log.jsonl');
  const runs = new Map();    // session id → Map(place → { steps, errors: [], calls: [], refused })
  const shown = new Map();   // session id → Set(places whose notes it has been given)
  const lastReflect = new Map(); // place → when
  const lines = () => read(logFile).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (error) { void error; return null; } }).filter(Boolean);
  // A log from before things had outcomes said "worked" (the reflection's judgement): read once as an outcome.
  { const all = lines(); if (all.some((r) => 'worked' in r)) { try { writeAtomic(logFile, `${all.map(({ worked, ...r }) => JSON.stringify(r.outcome || worked === undefined ? r : { ...r, outcome: worked ? 'done' : 'failed' })).join('\n')}\n`); } catch (error) { void error; } } }
  // Notes written before refusals were told apart from the app's own errors may teach ways around a rule
  // of ours: each is read over once before it is given again. A new folder has nothing to read over.
  const metaFile = join(dir, '_meta.json');
  let meta = null;
  try { meta = JSON.parse(readFileSync(metaFile, 'utf8')); } catch (error) { void error; }
  if (!meta || !Array.isArray(meta.review)) {
    let old = [];
    try { old = readdirSync(dir).filter((f) => f.endsWith('.md') && read(join(dir, f)).trim()).map((f) => f.slice(0, -3)); } catch (error) { void error; }
    meta = { rules: 2, review: old };
    try { writeAtomic(metaFile, `${JSON.stringify(meta)}\n`); } catch (error) { void error; }
  }
  const reviewed = (app) => { const f = fileOf(app).slice(0, -3); if (!meta.review.includes(f)) return; meta.review = meta.review.filter((a) => a !== f); try { writeAtomic(metaFile, `${JSON.stringify(meta)}\n`); } catch (error) { void error; } };
  let today = '', reflectedToday = 0;
  const runsOf = (app) => lines().filter((r) => r.app === app);
  let seq = 0;
  const api = {
    dir,
    notes: (app) => read(join(dir, fileOf(app))).trim(),
    /** Whether the notes for `app` are still to be read over (see above). */
    needsReview: (app) => meta.review.includes(fileOf(app).slice(0, -3)),
    /** How each task named in `app` went, oldest first: [{ task, runs, done, steps: [n, …], tokens: [n, …] }] (steps and cost of the runs that were done). */
    tasks(app) {
      const by = new Map();
      for (const r of runsOf(app)) {
        if (!r.task) continue;
        const t = by.get(r.task) ?? { task: r.task, runs: 0, done: 0, steps: [], tokens: [] };
        t.runs++;
        if (r.outcome === 'done') { t.done++; t.steps.push(r.steps); if (r.tokens) t.tokens.push(Math.round(r.tokens * (r.share ?? 1))); }
        by.set(r.task, t);
      }
      return [...by.values()];
    },
    /** The last few runs in `app`: [{ id, at, thing, steps, errors, outcome, task, ms, tokens, share }]. */
    recent: (app, n = 5) => runsOf(app).slice(-n),
    /** Places with notes or runs. */
    apps() {
      let names = [];
      try { names = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)); } catch (error) { void error; }
      return [...new Set([...names, ...lines().map((r) => r.app)])].sort();
    },
    /** A device call of a thing under way in this session, after it ran, in `app` ('phone' for the phone itself). → app */
    step(sessionId, app, tool, input, { isError = false, error = '' } = {}) {
      if (!sessionId) return '';
      const run = runs.get(sessionId) ?? new Map();
      runs.set(sessionId, run);
      const a = run.get(app) ?? { steps: 0, errors: [], calls: [], refused: 0 };
      const batch = batchSteps(input);
      a.steps += batch ? Math.max(1, batch.length) : 1;
      const failures = [...(isError ? [error] : []), ...(batch ? batchFailures(error) : [])].filter((e) => e && !isRefusal(e)).map(errorType);
      a.errors.push(...failures);
      const refused = isError && !failures.length && isRefusal(error);
      if (refused) a.refused++;
      if (a.calls.length < 60) a.calls.push(`${callLine(tool, input)}${failures.length ? ` ✗ ${failures.join('；')}` : refused ? ' ⊘' : ''}`);
      run.set(app, a);
      return app;
    },
    /** The first time this session is in `app` and it has notes: them, and how its tasks went; else null. */
    take(sessionId, app) {
      if (!sessionId || !app) return null;
      const seen = shown.get(sessionId) ?? new Set();
      if (seen.has(app)) return null;
      const notes = api.notes(app);
      if (!notes) return null; // nothing learned here yet: try again next time
      const tasks = api.tasks(app), last = api.recent(app, 3).filter((r) => !r.task);
      if (api.needsReview(app)) return null;   // old notes, not read over yet: not given as they are
      seen.add(app); shown.set(sessionId, seen);
      const said = [
        ...tasks.slice(-6).map((t) => `「${t.task}」做成 ${t.done}/${t.runs} 次${t.steps.length ? `，步数 ${t.steps.slice(-4).join('→')}` : ''}`),
        ...last.map((r) => `${day(r.at)} ${r.steps} 步${r.errors ? `、错 ${r.errors} 次` : ''}${r.outcome && r.outcome !== 'done' ? '、没做成' : ''}`),
      ];
      return { app, notes, recent: said.join('；') };
    },
    /**
     * The thing in this session ended: log each place's run; a place worth learning from comes back as
     * { id, app, task, outcome, steps, errors, calls, tokens } for the reflection. Worth it: real errors, a run
     * that broke off, or clearly more steps than usual there (≥ minSteps and above 1.5× the median), or a first
     * long run in a place with no notes yet — and the place not reflected on within cooldownMs, and the day's cap not hit.
     * @param end.task the thing as it was given  @param end.outcome the book's  @param end.ms, end.tokens the whole thing's
     */
    end(sessionId, { thing = '', task = '', outcome = '', ms = 0, tokens = 0 } = {}) {
      const run = runs.get(sessionId);
      runs.delete(sessionId); shown.delete(sessionId);
      if (!run) return [];
      const out = [];
      const d = new Date(now()).toDateString();
      if (d !== today) { today = d; reflectedToday = 0; }
      const total = [...run.values()].reduce((n, a) => n + a.steps, 0) || 1;
      for (const [app, a] of run) {
        const before = runsOf(app).map((r) => r.steps);
        const id = `${now().toString(36)}${(seq++).toString(36)}`;
        const share = Math.round((a.steps / total) * 100) / 100;
        try { appendFileSync(logFile, `${JSON.stringify({ id, at: now(), ...(thing ? { thing } : {}), app, steps: a.steps, errors: a.errors.length, ...(outcome ? { outcome } : {}), ms: Math.round(ms), tokens: Math.round(tokens), share })}\n`); } catch (error) { void error; }
        const long = a.steps >= minSteps && (!before.length || !api.notes(app) || a.steps > 1.5 * median(before.slice(-8)));
        const broke = BROKE.has(outcome) && a.steps >= 3;
        if (!(long || broke || a.errors.length)) continue;
        if (now() - (lastReflect.get(app) ?? 0) < cooldownMs || reflectedToday >= dailyReflections) continue;
        lastReflect.set(app, now()); reflectedToday++;
        out.push({ id, app, task: clip(noUrls(task), 160), outcome, steps: a.steps, errors: a.errors, calls: a.calls, tokens: Math.round(tokens * share) });
      }
      try { const all = read(logFile).split('\n').filter(Boolean); if (all.length > keepRuns) writeAtomic(logFile, `${all.slice(-keepRuns).join('\n')}\n`); } catch (error) { void error; }
      return out;
    },
    /** What the reflection reads (the notes as they are when it starts). */
    input(r) {
      if (r.review) return { place: placeName(r.app), notesNow: api.notes(r.app) || null, limits: { notesMaxChars: maxChars } };
      return {
        place: placeName(r.app), thingWas: r.task, outcome: r.outcome || 'unknown', steps: r.steps, tokens: r.tokens, errors: r.errors, calls: r.calls,
        notesNow: api.notes(r.app) || null, knownTasks: api.tasks(r.app).map(({ task, runs, done, steps }) => ({ task, runs, done, steps: steps.slice(-4) })),
        recentRuns: api.recent(r.app, 8).map(({ steps, errors, outcome, task, tokens, share }) => ({ steps, errors, outcome, ...(task ? { task } : {}), ...(tokens ? { tokens: Math.round(tokens * (share ?? 1)) } : {}) })),
        limits: { notesMaxChars: maxChars },
      };
    },
    /** Keep a reflection's result: the notes (no addresses, capped), and the task's name onto that run's log line. */
    keep(app, { notes, task } = {}, runId = '') {
      const text = noUrls(notes).trim();
      if (!text) return false;
      const name = clip(noUrls(task), 12);
      writeAtomic(join(dir, fileOf(app)), `${text.length > maxChars ? text.slice(0, maxChars) : text}\n`);
      for (const seen of shown.values()) seen.delete(app); // new notes: given again on the next visit
      reviewed(app);
      if (runId && name) {
        try {
          const all = read(logFile).split('\n').filter(Boolean).map((l) => { try { const j = JSON.parse(l); if (j.id === runId) return JSON.stringify({ ...j, task: name }); } catch (error) { void error; } return l; });
          writeAtomic(logFile, `${all.join('\n')}\n`);
        } catch (error) { void error; }
      }
      return true;
    },
    /** For the panel: each place, whether it has notes, how its tasks went. */
    summary: () => api.apps().map((app) => ({ app, notes: Boolean(api.notes(app)), tasks: api.tasks(app), last: api.recent(app, 10).map((r) => r.steps) })),
    forget(sessionId) { runs.delete(sessionId); shown.delete(sessionId); },
  };
  return api;
}

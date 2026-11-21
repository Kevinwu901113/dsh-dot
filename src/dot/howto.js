// dsh-dot/howto: what she learns from using her phone, written by her, read back when she opens the app again.
//
// The phone section only says how the phone works. How to get things done in each app she learns
// herself, the way Mobile-Agent-E keeps Tips and Shortcuts and Agent Workflow Memory keeps the routines
// that worked:
//   record   every turn that used her phone: which apps (the app in front after each call), how many
//            steps (a batch counts its steps), which failed, in <home>/her/howto/_log.jsonl — code only
//   reflect  a run that took clearly more steps than usual, or hit real errors (not refusals): one
//            small call reads what she did (her calls and short error types, never the screen's text)
//            and her notes for that app, and rewrites them: lessons, and the short ways that worked;
//            it also names what she was doing there (登录, 发帖), so the same task's steps line up over time.
//            A call one of her own rules refused (src/refusals.js) is marked ⊘ and is no lesson: rules change,
//            and a refusal says itself what to do instead. Notes from before this was told apart
//            (no _meta.json) are read over once (`review`) before she is given them again.
//            One reflection per app at a time; at most one per app per hour and a few a day.
//   recall   the first time she is in that app in a session, her notes come along with the result,
//            with how many steps it took her the last few times — as reference, not instructions
// The notes are plain files in her own folder (<home>/her/howto/<app>.md): she, or he, can edit them.
// Nothing here touches dsh-dot/memory.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wasRefused } from '../refusals.js';
import { head } from '../cut.js';

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${head(t, n)}…` : t; };
const read = (f) => { try { return readFileSync(f, 'utf8'); } catch (error) { void error; return ''; } };
/** Write whole, or not at all (tmp + rename). */
const writeAtomic = (f, text) => { const tmp = `${f}.tmp`; writeFileSync(tmp, text); renameSync(tmp, f); };
/** A file name for an app label: no path separators or oddities. */
export const fileOf = (app) => `${String(app || 'phone').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)}.md`;
/** Web addresses never go into her notes. */
const noUrls = (s) => String(s ?? '').replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '（链接）');
/** An error as a short type: the first line, no addresses, no quoted text from the screen. */
export const errorType = (e) => clip(noUrls(String(e ?? '').split('\n')[0]).replace(/[「“"].{12,}?[」”"]/g, '"…"'), 100);
/** Refusals (approvals, gates, the phone busy) are not her mistakes in the app. */
export const isRefusal = (e) => wasRefused(e) || /denied|rejected|not allowed|approval|审批|批准|拒绝|被拦|用不了|lease|另一个会话|同一件事已经试了|dsh-interlude:|dsh-dot/i.test(String(e ?? ''));

/** One call as she would read it back: "launch_app(com.max.xiaoheihe)", "click(421,428)", "type(浮游世界)". */
export function callLine(tool, input) {
  const short = String(tool).replace(/^.*__/, '').replace(/^mobile_/, '');
  const a = input && typeof input === 'object' ? input : {};
  const bits = [];
  for (const k of ['packageName', 'text', 'button', 'direction', 'x', 'y']) if (a[k] !== undefined && a[k] !== '') bits.push(k === 'x' || k === 'y' ? a[k] : clip(a[k], 30));
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
    description: 'Her rewritten notes for this app. Call it exactly once.',
    parameters: {
      type: 'object',
      properties: {
        worked: { type: 'boolean', description: '这次要做的事做成了没有' },
        task: { type: 'string', description: '这次在这个 App 里做的事的短名（八个字以内，如「登录」「发帖」「看消息」）；和 knownTasks 里某个是同一件事，就用那个名字' },
        notes: { type: 'string', description: '这个 App 的经验笔记全文（Markdown，中文）' },
      },
      required: ['worked', 'notes'],
    },
  };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

export function createHowto({ dir, minSteps = 12, maxChars = 800, keepRuns = 400, cooldownMs = 3600000, dailyReflections = 8, now = () => Date.now() } = {}) {
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, '_log.jsonl');
  const open = new Set();    // sessions with a turn open (steps outside one are late results of an ended turn)
  const runs = new Map();    // session id → { startedAt, apps: Map(app → { steps, errors: [], calls: [] }) }
  const shown = new Map();   // session id → Set(apps whose notes she has been given)
  const lastReflect = new Map(); // app → when
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
  let day = '', reflectedToday = 0;
  const lines = () => read(logFile).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (error) { void error; return null; } }).filter(Boolean);
  const runsOf = (app) => lines().filter((r) => r.app === app);
  let seq = 0;
  const api = {
    dir,
    notes: (app) => read(join(dir, fileOf(app))).trim(),
    /** Whether her notes for `app` are still to be read over (see above). */
    needsReview: (app) => meta.review.includes(fileOf(app).slice(0, -3)),
    /** The same task's runs in `app`, oldest first: [{ task, steps: [n, …] }] — is she getting quicker at it? */
    tasks(app) {
      const by = new Map();
      for (const r of runsOf(app)) if (r.task) by.set(r.task, [...(by.get(r.task) ?? []), r.steps]);
      return [...by].map(([task, steps]) => ({ task, steps }));
    },
    /** Her last few runs in `app`: [{ id, at, steps, errors, worked, task }]. */
    recent: (app, n = 5) => runsOf(app).slice(-n),
    /** Apps she has notes or runs for. */
    apps() {
      let names = [];
      try { names = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)); } catch (error) { void error; }
      return [...new Set([...names, ...lines().map((r) => r.app)])].filter((a) => a !== 'phone').sort();
    },
    turnStarted(sessionId) { open.add(sessionId); },
    /**
     * A phone call in a session's open turn, after it ran. `app` is the app in front after the call
     * ('phone' on the home screen or unknown). Returns the app, or '' when not counted.
     */
    step(sessionId, app, tool, input, { isError = false, error = '' } = {}) {
      if (!sessionId || !open.has(sessionId)) return '';
      const run = runs.get(sessionId) ?? { startedAt: now(), apps: new Map() };
      runs.set(sessionId, run);
      const a = run.apps.get(app) ?? { steps: 0, errors: [], calls: [], refused: 0 };
      const batch = batchSteps(input);
      a.steps += batch ? Math.max(1, batch.length) : 1;
      const failures = [...(isError ? [error] : []), ...(batch ? batchFailures(error) : [])].filter((e) => e && !isRefusal(e)).map(errorType);
      a.errors.push(...failures);
      const refused = isError && !failures.length && isRefusal(error);
      if (refused) a.refused++;
      if (a.calls.length < 60) a.calls.push(`${callLine(tool, input)}${failures.length ? ` ✗ ${failures.join('；')}` : refused ? ' ⊘' : ''}`);
      run.apps.set(app, a);
      return app;
    },
    /** The first time she is in `app` in a session and there is something to give: her notes and recent runs, else null. */
    take(sessionId, app) {
      if (!sessionId || !app || app === 'phone') return null;
      const seen = shown.get(sessionId) ?? new Set();
      if (seen.has(app)) return null;
      const notes = api.notes(app);
      const last = api.recent(app, 5);
      if (!notes && !last.length) return null; // nothing yet: try again next time she comes
      if (api.needsReview(app)) return null;   // old notes, not read over yet: not given as they are
      seen.add(app); shown.set(sessionId, seen);
      return { app, notes, recent: last.map((r) => `${new Date(r.at).getMonth() + 1}-${new Date(r.at).getDate()} ${r.task ? `${r.task} ` : ''}${r.steps} 步${r.errors ? `、错 ${r.errors} 次` : ''}${r.worked === false ? '、没做成' : ''}`).join('；') };
    },
    /**
     * The turn ended: log each app's run; a run worth learning from comes back as
     * { id, app, steps, errors, calls, said } for the reflection. Worth it: real errors, or clearly more
     * steps than she usually takes there (≥ minSteps and above 1.5× her median), or her first long run
     * in an app with no notes yet — and the app not reflected on within cooldownMs, and the day's cap not hit.
     */
    end(sessionId, said = '') {
      open.delete(sessionId);
      const run = runs.get(sessionId);
      runs.delete(sessionId);
      if (!run) return [];
      const out = [];
      const today = new Date(now()).toDateString();
      if (today !== day) { day = today; reflectedToday = 0; }
      for (const [app, a] of run.apps) {
        const before = runsOf(app).map((r) => r.steps);
        const id = `${now().toString(36)}${(seq++).toString(36)}`;
        try { appendFileSync(logFile, `${JSON.stringify({ id, at: run.startedAt, app, steps: a.steps, errors: a.errors.length })}\n`); } catch (error) { void error; }
        if (app === 'phone') continue;
        const long = a.steps >= minSteps && (!before.length || !api.notes(app) || a.steps > 1.5 * median(before.slice(-8)));
        if (!(long || a.errors.length)) continue;
        if (now() - (lastReflect.get(app) ?? 0) < cooldownMs || reflectedToday >= dailyReflections) continue;
        lastReflect.set(app, now()); reflectedToday++;
        out.push({ id, app, steps: a.steps, errors: a.errors, calls: a.calls, said: clip(noUrls(said), 120) });
      }
      try { const all = read(logFile).split('\n').filter(Boolean); if (all.length > keepRuns) writeAtomic(logFile, `${all.slice(-keepRuns).join('\n')}\n`); } catch (error) { void error; }
      return out;
    },
    /** What the reflection reads (her notes as they are when it starts). */
    input(r) {
      if (r.review) return { app: r.app, notesNow: api.notes(r.app) || null, limits: { notesMaxChars: maxChars } };
      return { app: r.app, steps: r.steps, errors: r.errors, yourCalls: r.calls, youSaidAfter: r.said, notesNow: api.notes(r.app) || null, knownTasks: api.tasks(r.app).map((t) => t.task), recentRuns: api.recent(r.app, 8).map(({ steps, errors, worked, task }) => ({ steps, errors, worked, ...(task ? { task } : {}) })), limits: { notesMaxChars: maxChars } };
    },
    /** Keep a reflection's result: the notes (no addresses, capped), and whether it worked onto that run's log line. */
    keep(app, { notes, worked, task } = {}, runId = '') {
      const text = noUrls(notes).trim();
      if (!text) return false;
      const name = clip(noUrls(task), 12);
      writeAtomic(join(dir, fileOf(app)), `${text.length > maxChars ? text.slice(0, maxChars) : text}\n`);
      for (const seen of shown.values()) seen.delete(app); // new notes: given again on her next visit
      reviewed(app);
      try {
        const all = read(logFile).split('\n').filter(Boolean).map((l) => { try { const j = JSON.parse(l); if (runId && j.id === runId) { j.worked = Boolean(worked); if (name) j.task = name; return JSON.stringify(j); } } catch (error) { void error; } return l; });
        writeAtomic(logFile, `${all.join('\n')}\n`);
      } catch (error) { void error; }
      return true;
    },
    forget(sessionId) { runs.delete(sessionId); shown.delete(sessionId); open.delete(sessionId); },
  };
  return api;
}

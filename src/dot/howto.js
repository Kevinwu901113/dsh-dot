// dsh-dot/howto: what she learns from using her phone, written by her, read back when she opens the app again.
//
// The manual (manuals.js) only says how the phone works. How to get things done in each app she learns
// herself, the way Mobile-Agent-E keeps Tips and Shortcuts and Agent Workflow Memory keeps the routines
// that worked:
//   record   every turn that used her phone: which apps, how many steps, which failed, what it cost
//            (<home>/her/howto/_log.jsonl; code only, nothing is asked of the model)
//   reflect  a turn that took many steps or hit errors: one small call reads what she did (her calls
//            and their errors, never the screen's text) and her notes for that app, and rewrites them:
//            lessons, and the short ways that worked (with when they apply)
//   recall   the first time she opens that app in a session, her notes come along with the result,
//            with how many steps it took her the last few times
// The notes are plain files in her own folder (<home>/her/howto/<app>.md): she, or he, can edit them.
// Nothing here touches dsh-dot/memory.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const read = (f) => { try { return readFileSync(f, 'utf8'); } catch (error) { void error; return ''; } };
/** A file name for an app label: no path separators or oddities. */
export const fileOf = (app) => `${String(app || 'phone').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)}.md`;

/** One call as she would read it back: "launch_app(com.max.xiaoheihe)", "click(421,428)", "type(浮游世界)". */
export function callLine(tool, input) {
  const short = String(tool).replace(/^.*__/, '').replace(/^mobile_/, '');
  const a = input && typeof input === 'object' ? input : {};
  const bits = [];
  for (const k of ['packageName', 'text', 'button', 'direction', 'x', 'y']) if (a[k] !== undefined && a[k] !== '') bits.push(k === 'x' || k === 'y' ? a[k] : clip(a[k], 30));
  if (Array.isArray(a.commands ?? a.steps)) bits.push(`${(a.commands ?? a.steps).length} 步`);
  return `${short}(${bits.join(',')})`;
}

/** The reply tool of the reflection: provider-validated JSON. */
export function howtoTool() {
  return {
    name: 'howto',
    description: 'Her rewritten notes for this app. Call it exactly once.',
    parameters: {
      type: 'object',
      properties: {
        worked: { type: 'boolean', description: '这次要做的事做成了没有' },
        notes: { type: 'string', description: '这个 App 的经验笔记全文（Markdown，中文）' },
      },
      required: ['worked', 'notes'],
    },
  };
}

export function createHowto({ dir, labelOf = (p) => p, minSteps = 12, maxChars = 800, keepRuns = 400, now = () => Date.now() } = {}) {
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, '_log.jsonl');
  const runs = new Map();  // session id → { startedAt, app, apps: Map(app → { steps, errors: [] }), calls: [] }
  const shown = new Map(); // session id → Set(apps whose notes she has been given)
  const current = new Map(); // session id → the app last opened there (survives turns)
  const runsOf = (app) => read(logFile).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (error) { void error; return null; } }).filter((r) => r && r.app === app);
  const api = {
    dir,
    notes: (app) => read(join(dir, fileOf(app))).trim(),
    write(app, text) { writeFileSync(join(dir, fileOf(app)), `${String(text).trim()}\n`); },
    /** Her last few runs in `app`: [{ at, steps, errors, worked }]. */
    recent: (app, n = 5) => runsOf(app).slice(-n),
    /** Apps she has notes or runs for. */
    apps() {
      let names = [];
      try { names = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)); } catch (error) { void error; }
      const logged = new Set(read(logFile).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).app; } catch (error) { void error; return null; } }).filter(Boolean));
      return [...new Set([...names, ...logged])].sort();
    },
    /** A phone call in a session's turn (after it ran). Returns the app it was in. */
    step(sessionId, tool, input, { isError = false, error = '' } = {}) {
      if (!sessionId) return '';
      const run = runs.get(sessionId) ?? { startedAt: now(), apps: new Map(), calls: [] };
      runs.set(sessionId, run);
      if (/mobile_launch_app$/.test(tool) && input?.packageName) current.set(sessionId, labelOf(String(input.packageName)));
      const app = current.get(sessionId) ?? 'phone';
      const a = run.apps.get(app) ?? { steps: 0, errors: [] };
      a.steps++;
      if (isError) a.errors.push(clip(error, 160));
      run.apps.set(app, a);
      if (run.calls.length < 80) run.calls.push(`[${app}] ${callLine(tool, input)}${isError ? ` ✗ ${clip(error, 120)}` : ''}`);
      return app;
    },
    /** The first time she is in `app` in a session: her notes and recent runs, or null (nothing yet, or already given). */
    take(sessionId, app) {
      if (!sessionId || !app || app === 'phone') return null;
      const seen = shown.get(sessionId) ?? new Set();
      if (seen.has(app)) return null;
      seen.add(app); shown.set(sessionId, seen);
      const notes = api.notes(app);
      const last = api.recent(app, 5);
      if (!notes && !last.length) return null;
      return { app, notes, recent: last.map((r) => `${new Date(r.at).getMonth() + 1}-${new Date(r.at).getDate()} ${r.steps} 步${r.errors ? `、错 ${r.errors} 次` : ''}${r.worked === false ? '、没做成' : ''}`).join('；') };
    },
    /**
     * The turn ended: log each app's run; a run worth learning from (≥ minSteps steps, or errors) comes
     * back as { app, steps, errors, calls, said } for the reflection. `said` is her last words of the turn.
     */
    end(sessionId, said = '') {
      const run = runs.get(sessionId);
      runs.delete(sessionId);
      if (!run) return [];
      const out = [];
      for (const [app, a] of run.apps) {
        try { appendFileSync(logFile, `${JSON.stringify({ at: run.startedAt, app, steps: a.steps, errors: a.errors.length })}\n`); } catch (error) { void error; }
        if (app !== 'phone' && (a.steps >= minSteps || a.errors.length)) out.push({ app, steps: a.steps, errors: a.errors, calls: run.calls.filter((c) => c.startsWith(`[${app}]`)).map((c) => c.slice(app.length + 3)), said: clip(said, 400) });
      }
      // keep the log bounded
      try { const lines = read(logFile).split('\n').filter(Boolean); if (lines.length > keepRuns) writeFileSync(logFile, `${lines.slice(-keepRuns).join('\n')}\n`); } catch (error) { void error; }
      return out;
    },
    /** What the reflection reads. */
    input(r) {
      return { app: r.app, steps: r.steps, errors: r.errors, yourCalls: r.calls, youSaidAfter: r.said, notesNow: api.notes(r.app) || null, recentRuns: api.recent(r.app, 8), limits: { notesMaxChars: maxChars } };
    },
    /** Keep a reflection's result: the notes (capped), and whether it worked onto the last log line of that app. */
    keep(app, { notes, worked } = {}) {
      const text = String(notes ?? '').trim();
      if (!text) return false;
      api.write(app, text.length > maxChars ? text.slice(0, maxChars) : text);
      try {
        const lines = read(logFile).split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) { const j = JSON.parse(lines[i]); if (j.app === app) { j.worked = Boolean(worked); lines[i] = JSON.stringify(j); break; } }
        writeFileSync(logFile, `${lines.join('\n')}\n`);
      } catch (error) { void error; }
      return true;
    },
    forget(sessionId) { runs.delete(sessionId); shown.delete(sessionId); current.delete(sessionId); },
  };
  return api;
}

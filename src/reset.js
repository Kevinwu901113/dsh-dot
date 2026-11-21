// Reset her, in levels. Nothing is deleted: what a level covers is moved into
// $DSH_HOME/dsh-dot-resets/<time>/ — outside her home, so she cannot read her old memory back — and
// moving it back undoes it. Her persona (interlude/canon.json*), the settings file and what is
// installed on her phone and computer are never touched (the phone has its own rebuild).
//
// A reset is not done while dsh runs: memory, the interlude and dot keep their state in RAM and would
// write it straight back. The dot page schedules it ($DSH_HOME/dsh-dot-reset.json); it is carried out
// at the next start of dsh, by whichever component is applied first, before any of them reads its
// files (runPendingReset at the top of each apply). "Next start" is enforced: a request made in this
// process is never carried out by this process (a component re-applied while the others are alive
// would otherwise run it under them), and one process carries out at most one.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { dshHome } from './settings.js';

// When this process started, and whether it has carried a reset out — kept on the process, not on this module,
// so a host that loads the plugin again (a second copy of the module) still sees one process.
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
const RAN = Symbol.for('dsh-dot.reset.ran');

/** A note left in <home>/memory by a reset: memory does not read the old conversation back in (backfill). */
export const NO_BACKFILL = 'no-backfill';

/** The levels, each including the ones before it. */
export const RESET_LEVELS = [
  { id: 'memory', name: '只清记忆', what: '聊天记录、关于你和她自己的笔记、没了的事、认识的人、日记、召回索引（这一级和下一级不换对话：她当前对话的上下文里还留着旧聊天）' },
  { id: 'life', name: '记忆 + 幕间', what: '幕间：生活剧本、打算、做过的事、「我现在的样子」' },
  { id: 'fresh', name: '记忆 + 幕间 + 新对话', what: '换一段新对话：旧对话还在列表里，但不再是她的对话，里面的聊天不再跟着她（你下一条 QQ 消息会开出新的一段）' },
  { id: 'all', name: '全部从零', what: '她学会的 App 用法笔记、存下的表情包（手机相册里同步过去的那些也会被清掉）、面板上的活动记录（三份运行日志）和今天的计数' },
];
const rank = (id) => RESET_LEVELS.findIndex((l) => l.id === id);
const markerPath = () => join(dshHome(), 'dsh-dot-reset.json');
const lastPath = () => join(dshHome(), 'dsh-dot-reset.last.json');
const readJson = (file) => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; } };
/** Where the backups go: next to dsh's own state, not in her home. */
export const resetsDir = () => join(dshHome(), 'dsh-dot-resets');

/** The reset waiting for the next start ({ level, home, requestedAt }), or null. */
export const pendingReset = () => { const p = readJson(markerPath()); return p && rank(p.level) >= 0 ? p : null; };
/** The last reset carried out ({ level, at, backup, moved, error? }), or null. */
export const lastReset = () => readJson(lastPath());
/** Schedule a reset of `level` for the next start. `home` is her home as the running dot sees it. */
export function scheduleReset(level, home) {
  if (rank(level) < 0) throw new Error(`unknown reset level "${level}"`);
  mkdirSync(dshHome(), { recursive: true });
  const p = { level, home: home || process.env.DSH_DOT_HOME || join(homedir(), 'dot'), requestedAt: new Date().toISOString() };
  writeFileSync(markerPath(), `${JSON.stringify(p, null, 2)}\n`);
  return p;
}
/** Drop a scheduled reset. True when there was one. */
export function cancelReset() { const had = existsSync(markerPath()); rmSync(markerPath(), { force: true }); return had; }

/**
 * Carry out the scheduled reset, if any. Call first thing in a component's apply.
 * @param {number} [opts.startedAt] - when this process started (tests pass their own).
 * @returns the record written to dsh-dot-reset.last.json, or null when nothing was carried out.
 */
export function runPendingReset({ logger, now = new Date(), startedAt = PROCESS_STARTED_AT, again = false } = {}) {
  const p = pendingReset();
  if (!p) { if (existsSync(markerPath())) rmSync(markerPath(), { force: true }); return null; }
  // Scheduled by this very process, or this process already carried one out: the others are alive. Leave it for the next start.
  const asked = Date.parse(p.requestedAt); // a marker without a readable time (written by hand) is taken as an old one
  if ((Number.isFinite(asked) && asked >= startedAt) || (globalThis[RAN] && !again)) return null;
  globalThis[RAN] = true;
  const r = rank(p.level), dsh = dshHome(), home = p.home;
  const backup = join(resetsDir(), now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-'));
  const moved = [], undo = [];
  const mv = (from, to) => {
    if (!existsSync(from)) return;
    mkdirSync(dirname(to), { recursive: true });
    try { renameSync(from, to); undo.push(() => { mkdirSync(dirname(from), { recursive: true }); renameSync(to, from); }); } catch (err) {
      if (err.code !== 'EXDEV') throw err; // another volume: copy, then remove
      cpSync(from, to, { recursive: true });
      // Registered before the removal: one that stops half-way (a file in use) leaves a partial source, and putting
      // back means clearing what is left of it and copying the whole backup over.
      undo.push(() => { rmSync(from, { recursive: true, force: true }); mkdirSync(dirname(from), { recursive: true }); cpSync(to, from, { recursive: true }); rmSync(to, { recursive: true, force: true }); });
      rmSync(from, { recursive: true, force: true });
    }
    moved.push(from);
  };
  const record = { level: p.level, at: now.toISOString(), requestedAt: p.requestedAt, home, backup, moved };
  try {
    mv(join(home, 'memory'), join(backup, 'memory'));
    // Her memory starts empty on purpose: the old conversation is not read back into it (see NO_BACKFILL).
    undo.push(() => rmSync(join(home, 'memory'), { recursive: true, force: true })); // before it is made: put back even if making it fails
    mkdirSync(join(home, 'memory'), { recursive: true });
    writeFileSync(join(home, 'memory', NO_BACKFILL), `${record.at} reset (${p.level})\n`);
    if (r >= rank('life')) {
      const dir = join(home, 'interlude');
      for (const name of existsSync(dir) ? readdirSync(dir) : []) if (!/^canon\.json/.test(name)) mv(join(dir, name), join(backup, 'interlude', name));
    }
    if (r >= rank('all')) {
      mv(join(home, 'her', 'howto'), join(backup, 'her', 'howto'));
      mv(join(dsh, 'stickers'), join(backup, 'stickers'));
      mv(join(dsh, 'dsh-qq-stickers.json'), join(backup, 'dsh-qq-stickers.json'));
      for (const log of ['dsh-computer-audit.jsonl', 'dsh-phone-audit.jsonl', 'dsh-qq-audit.jsonl']) for (const f of [log, `${log}.1`]) mv(join(dsh, f), join(backup, 'logs', f));
    }
    if (r >= rank('fresh')) {
      // Last, and in one rename: her conversation pointer. The old session stays in dsh; it is retired
      // (pastConversations), so a turn ending in it does not make it hers again. Keys of older state files
      // (errandSession, pastErrands) are folded into the same list.
      const file = join(dsh, 'dsh-dot-state.json'), s = readJson(file);
      if (existsSync(file) && !s) throw new Error(`${file} cannot be read: her conversation pointers were not cleared`);
      if (s) {
        mkdirSync(backup, { recursive: true }); copyFileSync(file, join(backup, 'dsh-dot-state.json'));
        s.pastConversations = [...new Set([...(s.pastConversations ?? []), ...(s.pastErrands ?? []), s.errandSession, s.lastSession].filter(Boolean))].slice(-50);
        s.lastSession = ''; delete s.errandSession; delete s.pastErrands;
        delete s.handsThing; delete s.things; // what was in her hands belonged to the conversation that is gone
        if (r >= rank('all')) delete s.stats; // today's counters on the panel (messages, wakes): from zero too
        const tmp = `${file}.tmp-${process.pid}`;
        writeFileSync(tmp, JSON.stringify(s, null, 2)); renameSync(tmp, file);
        moved.push(`${file} (lastSession${r >= rank('all') ? ', stats' : ''})`);
      }
    }
    logger?.info?.(`reset (${p.level}): ${moved.length} item(s) moved to ${backup}`);
  } catch (err) {
    // Half a reset is worse than none: put back what was moved.
    record.error = err.message;
    let restored = 0;
    for (const back of undo.reverse()) { try { back(); restored++; } catch (error) { void error; } }
    record.rolledBack = restored === undo.length;
    logger?.warn?.(`reset (${p.level}) failed: ${err.message} — ${record.rolledBack ? 'everything was put back' : `could not put everything back; see ${backup}`}`);
  } finally {
    // One attempt per request: a reset that failed is reported on the page, not retried at every start.
    rmSync(markerPath(), { force: true });
    try { writeFileSync(lastPath(), `${JSON.stringify(record, null, 2)}\n`); } catch (error) { void error; }
  }
  return record;
}

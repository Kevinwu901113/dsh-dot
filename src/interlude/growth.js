// dsh-interlude/growth: who she is becoming — a portrait she writes of herself, once a week, kept as history.
//
// The Canon is who she was made to be, and only he changes it. Her portrait ("她现在的样子") is who she
// is now: what she cares about lately, what she has taken to, the habits her words have picked up,
// where she and he stand, what she can do. Once a week (after the diary) one call reads that week —
// her diary, her own notes, what she did on her own and what he said about it — and she rewrites the
// portrait, changing only part of it, and says what changed. Every version is kept in
// <home>/her/growth/ so the change can be looked back on, and rolled back.
//
// Nothing here writes to dsh-dot/memory: her notes are read through its service (herLife) and the
// diary file is read as it is. What the review thinks is stale in her notes goes to her next free
// time (`tidy`): she changes her notes herself, with her own memory tool.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mondayMs } from '../clock.js';

const clip = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const read = (f, d = '') => { try { return readFileSync(f, 'utf8'); } catch (error) { void error; return d; } };

/** ISO-like week id of `ms` (local time, weeks start on Monday): "2026-W45". */
export function weekId(ms = Date.now()) {
  const monday = new Date(mondayMs(ms));
  const thursday = new Date(monday); thursday.setDate(monday.getDate() + 3);
  const year = thursday.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const week1 = mondayMs(jan4.getTime());
  return `${year}-W${String(Math.round((mondayMs(ms) - week1) / (7 * 86400000)) + 1).padStart(2, '0')}`;
}

/** How much of `a` changed in `b`, 0..1, by character bigrams (order-free, cheap; good enough for "about a third"). */
export function changeRatio(a, b) {
  const grams = (s) => { const t = String(s ?? '').replace(/\s+/g, ''); const m = new Map(); for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const A = grams(a), B = grams(b);
  let same = 0, total = 0;
  for (const [g, n] of A) { same += Math.min(n, B.get(g) ?? 0); total += n; }
  for (const [, n] of B) total += n;
  return total ? 1 - (2 * same) / total : 0;
}

/** The last `n` "## <day>" sections of a diary file. */
export function lastDiaryDays(text, n = 7) {
  return String(text ?? '').split(/^## /m).filter((s) => s.trim()).slice(-n).map((s) => { const [head, ...body] = s.split('\n'); return { day: head.trim(), text: body.join('\n').trim() }; });
}

/** The review's reply as a tool: provider-validated JSON. */
export function growthTool() {
  const str = { type: 'string' };
  return {
    name: 'growth',
    description: 'Her portrait of herself after this week, what changed, and notes of hers she thinks are stale. Call it exactly once.',
    parameters: {
      type: 'object',
      properties: {
        portrait: { ...str, description: '她现在的样子，第一人称，中文' },
        changes: { ...str, description: '这周她变了什么，几句话；没变就说没怎么变' },
        tidy: { type: 'array', maxItems: 5, items: str, description: '她自己笔记里过时或矛盾、下次想改的条目（原文的一小段），没有就 []' },
      },
      required: ['portrait', 'changes', 'tidy'],
    },
  };
}

export function createGrowth({ home, maxChars = 900, maxChange = 0.35, now = () => Date.now() } = {}) {
  const dir = join(home, 'her', 'growth');
  mkdirSync(dir, { recursive: true });
  const files = { current: join(dir, 'current.md'), meta: join(dir, 'growth.json') };
  let meta = { week: '', at: 0, tidy: [], ...(() => { try { return JSON.parse(read(files.meta, '{}')); } catch (error) { void error; return {}; } })() };
  const saveMeta = () => { try { writeFileSync(files.meta, JSON.stringify(meta, null, 1)); } catch (error) { void error; } };
  const portrait = () => read(files.current).trim();
  const archive = (week) => join(dir, `${week}.md`);
  return {
    dir, files,
    portrait,
    /** Notes of hers the last review thought stale: for her next free time. */
    tidy: () => [...(meta.tidy ?? [])],
    clearTidy() { meta.tidy = []; saveMeta(); },
    lastWeek: () => meta.week,
    /** Is a review due: not yet done this week, and this week's moment (`at`, e.g. 'Sun 21:00') has passed. */
    due(at = 'Sun 21:00', ms = now()) {
      const m = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2}):(\d{2})$/i.exec(String(at).trim());
      if (!m || meta.week === weekId(ms)) return false;
      const offset = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(m[1].toLowerCase());
      const moment = new Date(mondayMs(ms)); moment.setDate(moment.getDate() + offset); moment.setHours(+m[2], +m[3], 0, 0);
      return ms >= moment.getTime();
    },
    /** What the review reads. */
    input({ canon = '', herLife = [], owner = [], diaryText = '', doings = null } = {}) {
      return {
        week: weekId(now()),
        canon: clip(canon, 4000),
        portraitNow: portrait() || null,
        yourNotes: herLife,
        aboutHim: owner,
        diaryThisWeek: lastDiaryDays(diaryText, 7),
        yourDoings: doings,
        limits: { portraitMaxChars: maxChars, changeAtMost: `${Math.round(maxChange * 100)}%` },
      };
    },
    /**
     * Keep a review's result: { portrait, changes, tidy }. The first portrait is free; later ones may
     * change at most `maxChange` of the last (else { ok: false, why, ratio }, nothing kept).
     */
    keep(r, { force = false } = {}) {
      const text = clip(r?.portrait, maxChars + 200);
      if (!text) return { ok: false, why: 'empty portrait' };
      const before = portrait();
      const ratio = before ? changeRatio(before, text) : 1;
      if (before && ratio > maxChange && !force) return { ok: false, why: 'changed too much', ratio };
      const week = weekId(now());
      writeFileSync(files.current, `${text}\n`);
      writeFileSync(archive(week), `# ${week}\n\n## 她现在的样子\n${text}\n\n## 这周变了什么\n${String(r.changes ?? '').trim() || '（没写）'}\n`);
      meta = { ...meta, week, at: now(), tidy: [].concat(r.tidy ?? []).map((x) => clip(x, 120)).filter(Boolean).slice(0, 5) };
      saveMeta();
      return { ok: true, week, ratio };
    },
    /** Mark this week done without a new portrait (nothing to review, or the change was refused twice). */
    skip(why = '') { meta = { ...meta, week: weekId(now()), at: now(), skipped: why }; saveMeta(); },
    /** Versions kept: [{ week, changes }], oldest first. */
    history() {
      let names = [];
      try { names = readdirSync(dir).filter((f) => /^\d{4}-W\d{2}\.md$/.test(f)).sort(); } catch (error) { void error; }
      return names.map((f) => { const t = read(join(dir, f)); return { week: f.slice(0, -3), portrait: (/## 她现在的样子\n([\s\S]*?)\n\n## /.exec(t)?.[1] ?? '').trim(), changes: (/## 这周变了什么\n([\s\S]*)$/.exec(t)?.[1] ?? '').trim() }; });
    },
    /** Make the portrait of `week` the current one again. */
    rollback(week) {
      if (!existsSync(archive(week))) return false;
      const p = this.history().find((h) => h.week === week)?.portrait;
      if (!p) return false;
      writeFileSync(files.current, `${p}\n`);
      meta = { ...meta, rolledBackTo: week, rolledBackAt: now() }; saveMeta();
      return true;
    },
  };
}

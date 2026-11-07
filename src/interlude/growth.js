// dsh-interlude/growth: who she is becoming — a portrait she writes of herself, once a week, kept as history.
//
// The Canon is who she was made to be, and only he changes it. Her portrait ("她现在的样子") is who she
// is now: what she cares about lately, what she has taken to, the habits her words have picked up,
// where she and he stand, what she can do. Once a week (after the diary) one call reads that week —
// her diary, her own notes, what she did on her own and what he said about it — and she rewrites the
// portrait, changing only part of it, and says what changed. Every version is kept (by default in
// <home>/interlude/growth, outside her own folder, so only the review changes it) and can be rolled back.
//
// Nothing here writes to dsh-dot/memory: her notes are read through its service (herLife) and the
// diary file is read as it is. What the review thinks is stale in her notes goes to her next free
// time (`tidy`): she changes her notes herself, with her own memory tool.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mondayMs } from '../clock.js';

const DAY = 86400000;
const clip = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const read = (f, d = '') => { try { return readFileSync(f, 'utf8'); } catch (error) { void error; return d; } };
const OPEN = '<!-- portrait -->', CLOSE = '<!-- /portrait -->';

/** ISO-like week id of `ms` (local time, weeks start on Monday): "2026-W45". */
export function weekId(ms = Date.now()) {
  const monday = new Date(mondayMs(ms));
  const thursday = new Date(monday); thursday.setDate(monday.getDate() + 3);
  const week1 = mondayMs(new Date(thursday.getFullYear(), 0, 4).getTime());
  return `${thursday.getFullYear()}-W${String(Math.round((mondayMs(ms) - week1) / (7 * DAY)) + 1).padStart(2, '0')}`;
}

/**
 * How much of portrait `a` changed in `b`, 0..1: 1 − (longest common subsequence of characters) /
 * (the longer text). Appending as much again, cutting half, or reordering whole sentences all count.
 */
export function changeRatio(a, b) {
  const x = String(a ?? '').replace(/\s+/g, ''), y = String(b ?? '').replace(/\s+/g, '');
  if (x === y) return 0;
  if (!x.length || !y.length) return 1;
  let prev = new Uint16Array(y.length + 1), cur = new Uint16Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

/** The "## YYYY-MM-DD …" sections of a diary file (dsh-dot/memory's format) since `since`, at most `n`. */
export function lastDiaryDays(text, n = 7, since = 0) {
  return String(text ?? '').split(/^## /m).filter((s) => s.trim()).map((s) => { const [head, ...body] = s.split('\n'); return { day: head.trim(), text: body.join('\n').trim() }; })
    .filter((d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d.day); return !since || !m || new Date(+m[1], +m[2] - 1, +m[3]).getTime() >= since; })
    .slice(-n);
}

/** The latest moment `at` ('Sun 21:00') that is not after `ms`. */
export function lastMoment(at, ms) {
  const m = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2}):(\d{2})$/i.exec(String(at).trim());
  if (!m) return 0;
  const offset = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(m[1].toLowerCase());
  const moment = new Date(mondayMs(ms)); moment.setDate(moment.getDate() + offset); moment.setHours(+m[2], +m[3], 0, 0);
  if (moment.getTime() > ms) moment.setDate(moment.getDate() - 7);
  return moment.getTime();
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

export function createGrowth({ dir, at = 'Sun 21:00', maxChars = 900, maxChange = 0.35, now = () => Date.now() } = {}) {
  mkdirSync(dir, { recursive: true });
  const files = { current: join(dir, 'current.md'), meta: join(dir, 'growth.json') };
  let meta = { week: '', at: 0, tidy: [], ...(() => { try { return JSON.parse(read(files.meta, '{}')); } catch (error) { void error; return {}; } })() };
  const saveMeta = () => { try { writeFileSync(files.meta, JSON.stringify(meta, null, 1)); } catch (error) { void error; } };
  const portrait = () => read(files.current).trim();
  /** The week a review now belongs to: the week of the latest review moment (a missed one is caught up). */
  const reviewWeek = () => weekId(lastMoment(at, now()) || now());
  const history = () => {
    let names = [];
    try { names = readdirSync(dir).filter((f) => /^\d{4}-W\d{2}(-\d+)?\.md$/.test(f)); } catch (error) { void error; }
    const key = (f) => { const m = /^(\d{4}-W\d{2})(?:-(\d+))?\.md$/.exec(f); return [m[1], +(m[2] ?? 1)]; };
    names.sort((a, b) => { const [wa, na] = key(a), [wb, nb] = key(b); return wa === wb ? na - nb : wa < wb ? -1 : 1; });
    return names.map((f) => {
      const t = read(join(dir, f));
      const i = t.indexOf(OPEN), j = t.indexOf(CLOSE);
      return { week: f.slice(0, -3), portrait: i >= 0 && j > i ? t.slice(i + OPEN.length, j).trim() : '', changes: (/## 这周变了什么\n([\s\S]*)$/.exec(t.slice(j > 0 ? j : 0))?.[1] ?? '').trim() };
    });
  };
  return {
    dir, files, portrait, history,
    /** Notes of hers the last review thought stale: for her next free time. */
    tidy: () => [...(meta.tidy ?? [])],
    clearTidy() { meta.tidy = []; saveMeta(); },
    lastWeek: () => meta.week,
    /** Is a review due: none since the latest review moment (so a missed Sunday is caught up later). */
    due(ms = now()) { const m = lastMoment(at, ms); return Boolean(m) && (meta.at ?? 0) < m; },
    /** What the review reads: the diary of the last seven days, her notes, and the rest. */
    input({ canon = '', herLife = [], owner = [], diaryText = '', doings = null } = {}) {
      return {
        week: reviewWeek(),
        canon: clip(canon, 4000),
        portraitNow: portrait() || null,
        yourNotes: herLife,
        aboutHim: owner,
        diaryThisWeek: lastDiaryDays(diaryText, 7, now() - 7 * DAY),
        yourDoings: doings,
        limits: { portraitMaxChars: maxChars, changeAtMost: `${Math.round(maxChange * 100)}%` },
      };
    },
    /**
     * Keep a review's result: { portrait, changes, tidy }. Longer than maxChars → refused ('too long');
     * after the first portrait, more than `maxChange` of the last one changed → refused ('changed too much')
     * unless `force`. Nothing is kept when refused.
     */
    keep(r, { force = false } = {}) {
      const text = String(r?.portrait ?? '').trim();
      if (!text) return { ok: false, why: 'empty portrait' };
      if (text.length > maxChars) return { ok: false, why: 'too long', length: text.length };
      const before = portrait();
      const ratio = before ? changeRatio(before, text) : 1;
      if (before && ratio > maxChange && !force) return { ok: false, why: 'changed too much', ratio };
      const week = reviewWeek();
      let name = `${week}.md`;
      for (let n = 2; existsSync(join(dir, name)); n++) name = `${week}-${n}.md`; // a second review of a week keeps the first
      writeFileSync(files.current, `${text}\n`);
      writeFileSync(join(dir, name), `# ${name.slice(0, -3)}\n\n## 她现在的样子\n${OPEN}\n${text}\n${CLOSE}\n\n## 这周变了什么\n${String(r.changes ?? '').trim() || '（没写）'}\n`);
      meta = { ...meta, week: name.slice(0, -3), at: now(), tidy: [].concat(r.tidy ?? []).map((x) => clip(x, 120)).filter(Boolean).slice(0, 5) };
      saveMeta();
      return { ok: true, week: name.slice(0, -3), ratio };
    },
    /** This review is done without a new portrait (nothing to review, or refused twice). */
    skip(why = '') { meta = { ...meta, at: now(), skipped: why }; saveMeta(); },
    /** Make the portrait of `version` (a week id, or "2026-W46-2") the current one again; its tidy list goes with it. */
    rollback(version) {
      const p = history().find((h) => h.week === version)?.portrait;
      if (!p) return false;
      writeFileSync(files.current, `${p}\n`);
      meta = { ...meta, tidy: [], rolledBackTo: version, rolledBackAt: now() }; saveMeta();
      return true;
    },
  };
}

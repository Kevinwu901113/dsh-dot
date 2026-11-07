// dsh-interlude/doings: what she did on her own, what each one cost, and what he said about it.
//
// Every play, look and try the interlude hands out is one entry in <home>/interlude/doings.json:
//   { id, at, kind, what, why, app, action, status, doneAt, result, cost: { in, cached, out }, feedback: [{ at, from, text }] }
// The round sees a view of it (`yourDoings`): what she has kept doing these seven days and what it
// cost, the last few with their results and his reactions, and today's total. Whether something was
// worth it is hers to judge — nothing here scores it.
import { readFileSync, writeFileSync } from 'node:fs';

const DAY = 86400000;
const KEEP = 200;
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Tokens of one cost record (fresh input + cached input + output). */
export const tokensOf = (c) => (c ? (c.in ?? 0) + (c.cached ?? 0) + (c.out ?? 0) : 0);
/** Yuan for a cost record at `price` (yuan per million: { in, cached, out }), or null without a price. */
export function yuanOf(c, price) {
  if (!c || !price) return null;
  return ((c.in ?? 0) * (price.in ?? 0) + (c.cached ?? 0) * (price.cached ?? price.in ?? 0) + (c.out ?? 0) * (price.out ?? 0)) / 1e6;
}
/** Add dsh-llm usage records into a cost record. */
export function addUsage(cost, u) {
  if (!u) return cost;
  const c = cost ?? { in: 0, cached: 0, out: 0 };
  // dsh-llm TokenUsage (inputTokens without the cached reads, cacheReadTokens, outputTokens) or a cost record.
  c.in += Number(u.inputTokens ?? u.in ?? 0) || 0;
  c.cached += Number(u.cacheReadTokens ?? u.cached ?? 0) || 0;
  c.out += Number(u.outputTokens ?? u.out ?? 0) || 0;
  return c;
}

/** The short name of a doing, as she would say it: "小红书 点赞", "去看（手机）", "试：…". */
export function labelOf(d) {
  if (d.kind === 'play') return `${d.app ?? ''} ${{ like: '点赞', comment: '评论', follow: '关注', collect: '收表情', post: '发帖' }[d.action] ?? d.action ?? ''}`.trim();
  if (d.kind === 'look') return `去看${d.device ? `（${d.device === 'phone' ? '手机' : '电脑'}）` : ''}`;
  if (d.kind === 'try') return '试点新的';
  return d.kind;
}

/** Queued longer than this at load (dsh restarted under it, its task is gone): 'lost'. */
const LOST_AFTER = 2 * 3600000;

export function createDoings(file, { now = () => Date.now() } = {}) {
  let list = [];
  try { const j = JSON.parse(readFileSync(file, 'utf8')); if (Array.isArray(j)) list = j; } catch (error) { void error; }
  for (const d of list) if (d.status === 'queued' && now() - d.at > LOST_AFTER) { d.status = 'lost'; d.doneAt = now(); }
  const save = () => { try { writeFileSync(file, JSON.stringify(list.slice(-KEEP), null, 1)); } catch (error) { void error; } };
  let seq = 0;
  const find = (ref) => {
    const r = String(ref ?? '').trim().replace(/^#/, '');
    if (!r) return [...list].reverse().find((d) => d.status === 'done') ?? list.at(-1) ?? null;
    return list.find((d) => d.id === r) ?? [...list].reverse().find((d) => `${d.what} ${d.result ?? ''}`.includes(r)) ?? null;
  };
  return {
    /** A new doing ({ kind, what, why, app, action, device }); its id. */
    add(d) {
      const at = now();
      const id = `${(at % 1e8).toString(36)}${(seq++ % 36).toString(36)}`;
      list.push({ id, at, status: 'queued', ...d, what: clip(d.what, 160), why: clip(d.why, 120), feedback: [] });
      if (list.length > KEEP) list = list.slice(-KEEP);
      save();
      return id;
    },
    /** Settle one: { status, result, cost (usage-like or cost record), doneAt }. */
    settle(id, { status, result = '', usage = null, doneAt = now() } = {}) {
      const d = list.find((x) => x.id === id);
      if (!d) return null;
      d.status = status; d.doneAt = doneAt; d.result = clip(result, 300);
      if (usage) d.cost = addUsage(d.cost, usage);
      save();
      return d;
    },
    /** His reaction (from 'owner') or her own afterthought (from 'her') on a doing: `ref` is its id, a bit of its text, or '' for the latest; `exact`: the id only. */
    feedback(ref, text, from = 'owner', { exact = false } = {}) {
      const d = exact ? list.find((x) => x.id === String(ref ?? '').replace(/^#/, '')) ?? null : find(ref);
      const t = clip(text, 200);
      if (!d || !t) return null;
      d.feedback = [...(d.feedback ?? []), { at: now(), from, text: t }].slice(-4);
      save();
      return d;
    },
    find,
    all: () => list,
    /**
     * What the round shows her. `rounds` is today's round cost ({ in, cached, out }); `apps` the apps she
     * could play in, so the ones she has left alone this week can be named; `price` turns tokens into yuan.
     */
    view({ rounds = null, apps = [], price = null, recent = 8 } = {}) {
      const t = now();
      const week = list.filter((d) => d.at >= t - 7 * DAY);
      const groups = new Map();
      for (const d of week) {
        const k = labelOf(d);
        const g = groups.get(k) ?? { what: k, times: 0, done: 0, tokens: 0, reactions: 0 };
        g.times++; if (d.status === 'done') g.done++;
        g.tokens += tokensOf(d.cost); g.reactions += (d.feedback ?? []).filter((f) => f.from === 'owner').length;
        groups.set(k, g);
      }
      const today = list.filter((d) => d.at >= startOfDay(t));
      const todayCost = today.reduce((c, d) => addUsage(c, d.cost), { in: 0, cached: 0, out: 0 });
      const spent = addUsage({ ...todayCost }, rounds);
      const touched = new Set(week.filter((d) => d.kind === 'play').map((d) => d.app));
      const money = (c) => { const y = yuanOf(c, price); return y === null ? {} : { yuan: Math.round(y * 1000) / 1000 }; };
      return {
        today: { doings: today.length, tokens: tokensOf(spent), livingTokens: tokensOf(rounds), ...money(spent) },
        last7Days: [...groups.values()].sort((a, b) => b.times - a.times),
        leftAloneThisWeek: apps.filter((a) => !touched.has(a)),
        recent: list.slice(-recent).map((d) => ({
          id: d.id, at: hhmm(d.at), what: `${labelOf(d)}：${d.what}`, status: d.status,
          ...(d.result ? { result: d.result } : {}),
          ...(d.cost ? { tokens: tokensOf(d.cost), ...money(d.cost) } : {}),
          ...(d.feedback?.length ? { feedback: d.feedback.map((f) => `${f.from === 'owner' ? '他' : '我'}：${f.text}`) } : {}),
        })),
      };
    },
  };
}

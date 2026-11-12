// dsh-dot/clock: how time is written for her — one format everywhere (local time, no deps).
//   dayMark   MM-DD this year, YYYY-MM-DD from another (transcript lines, standing memory, stamps)
//   stamp     MM-DD HH:MM (year rule as dayMark) — the stamp every message that wakes her carries
//   describeNow  YYYY-MM-DD HH:MM 星期X 时段 (the interlude's nowLocal; her `dot:now` line)
//   ago       "3 小时 12 分" since a moment; '' under a minute
//   calendar  whole weeks around a span, one line per week (Monday first), for turning 下周三 into a date
//   mondayOf  MM-DD of the Monday of a moment's week
//   unstamp   a stamped wake line back to what it said (the transcript keeps its own time)

const p2 = (n) => String(n).padStart(2, '0');

export function dayMark(ms, now = Date.now()) {
  const d = new Date(ms);
  const md = `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/** "11-04 04:51", or "2025-11-04 04:51" when `ms` is in another year than `now`. */
export function stamp(ms = Date.now(), now = Date.now()) {
  const d = new Date(Number.isFinite(ms) ? ms : now);
  return `${dayMark(d.getTime(), now)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** The part of the day, named next to nowLocal. */
export const periodOf = (h) => (h < 5 ? '深夜' : h < 9 ? '清晨' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 20 ? '傍晚' : '夜里');

/** nowLocal with weekday and part of day: the clock a round is written against. */
export function describeNow(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  const h = d.getHours();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(h)}:${p2(d.getMinutes())} 星期${'日一二三四五六'[d.getDay()]} ${periodOf(h)}`;
}

/** How long since `ms`: "5 分钟", "3 小时 12 分", "2 天 4 小时"; '' when unknown, in the future or under a minute. */
export function ago(ms, now = Date.now()) {
  const min = Math.floor((now - Number(ms)) / 60000);
  if (!ms || !Number.isFinite(min) || min < 1) return '';
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${d} 天 ${hh} 小时` : `${d} 天`;
}

const STAMP = String.raw`(?:\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}`;
/** "[11-04 04:51] 在吗" → "在吗"; "[11-04 04:52 手机通知] …" → "[手机通知] …"; anything else as is. */
export const unstamp = (text) => String(text ?? '').replace(new RegExp(`^\\[${STAMP}\\] `), '').replace(new RegExp(`^\\[${STAMP} `), '[');

const WEEKDAY = '日一二三四五六';
const DAY = 86400000;
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** Midnight of the Monday of `ms`'s week (local time). */
export function mondayMs(ms) {
  const d = new Date(startOfDay(ms));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}
/** "06-29" (dayMark rule) of the Monday of `ms`'s week. */
export const mondayOf = (ms, now = ms) => dayMark(mondayMs(ms), now);
/**
 * Whole weeks from `before` days before `from` to `after` days after `to`, a line per week, Monday
 * first: "06-29一 06-30二 07-01三 … 07-05日". Dates follow dayMark (another year → YYYY-MM-DD).
 */
export function calendar(from, to, { before = 7, after = 21, now = to } = {}) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '';
  const lines = [];
  // Step by calendar days (setDate), not by 24 h, so a DST change never skips or repeats a day.
  const end = startOfDay(to + after * DAY);
  for (let d = new Date(mondayMs(from - before * DAY)); d.getTime() <= end;) {
    const week = [];
    for (let i = 0; i < 7; i++) { week.push(`${dayMark(d.getTime(), now)}${WEEKDAY[d.getDay()]}`); d.setDate(d.getDate() + 1); }
    lines.push(week.join(' '));
  }
  return lines.join('\n');
}

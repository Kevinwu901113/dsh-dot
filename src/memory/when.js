// dsh-dot/memory/when: dates for what she remembers, worked out by code, never by the model.
//
//   dayHeading  "06-22 周一 · 15 天前" — the anchor above a group of recalled turns
//   annotate    "明天 / 后天 / 下周三 …" in a line said on a known day → "明天（=06-23）"
//
// Only expressions with one meaning are converted: 今天 明天 后天 大后天 昨天 前天 大前天, and
// 这周X / 下周X / 上周X (weeks start on Monday). "月底", "X 号", "周末", a bare "周三" are left as
// said: they need context the code does not have. So is anything in quotes, reported (他说 / 听说 …)
// or hypothetical (如果 / 要是 …) in its clause — a wrong exact date misleads more than the words do.
import { dayMark, mondayMs } from '../clock.js';

const DAY = 86400000;
const WEEKDAY = '日一二三四五六';
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** `ms` moved by whole calendar days (setDate, so DST never skips a day). */
const addDays = (ms, n) => { const d = new Date(startOfDay(ms)); d.setDate(d.getDate() + n); return d.getTime(); };
/** Whole calendar days from `a` to `b` (b later → positive). */
export const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);

/** "06-22 周一 · 15 天前" (今天 / 昨天 / 前天 for the last three days); the year when it is not `now`'s. */
export function dayHeading(ms, now = Date.now()) {
  const d = new Date(ms);
  const n = daysBetween(ms, now);
  const rel = n <= 0 ? '今天' : n === 1 ? '昨天' : n === 2 ? '前天' : `${n} 天前`;
  return `${dayMark(ms, now)} 周${WEEKDAY[d.getDay()]} · ${rel}`;
}

const DAYWORD = { 大前天: -3, 前天: -2, 昨天: -1, 昨晚: -1, 昨儿: -1, 明天: 1, 明早: 1, 明晚: 1, 明儿: 1, 后天: 2, 大后天: 3 };
const WD = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
// Longest first, so 大后天 is not read as 后天, 下个周三 not as 周三.
const EXPR = new RegExp(`(${Object.keys(DAYWORD).sort((a, b) => b.length - a.length).join('|')})|(这个?|本|下个?|上个?)(?:周|星期|礼拜)([一二三四五六日天])`, 'g');
const QUOTES = { '“': '”', '「': '」', '『': '』', '"': '"', '‘': '’' };
// A clause that reports or imagines: its dates are not the speaker's.
const REPORTED = /(说|讲|听说|据说|告诉我|问我|写着|提到|以为|如果|假如|要是|万一|假设|梦到|梦见|的话)/;
const CLAUSE_END = /[，。！？；,.!?;\n]/;

/** The day an expression in a line said at `at` means, or null. */
function resolve(m, at) {
  if (m[1]) return addDays(at, DAYWORD[m[1]]);
  const which = m[2][0], wd = WD[m[3]];
  const monday = mondayMs(at);
  const weeks = which === '下' ? 1 : which === '上' ? -1 : 0;
  return addDays(monday, weeks * 7 + wd - 1);
}

/**
 * The line with an exact date after each unambiguous relative day in it: "明天（=06-23）".
 * `at` is when the line was said; `now` decides whether a year is written (dayMark).
 */
export function annotate(text, at, now = at) {
  const s = String(text ?? '');
  if (!Number.isFinite(at) || !s) return s;
  // Where quotes are open, and where each clause starts.
  const quoted = new Array(s.length).fill(false);
  let close = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (close) { if (ch === close) close = ''; else quoted[i] = true; }
    else if (QUOTES[ch]) close = QUOTES[ch];
  }
  let out = '', last = 0;
  for (const m of s.matchAll(EXPR)) {
    const i = m.index, end = i + m[0].length;
    if (quoted[i]) continue;
    let c = i; while (c > 0 && !CLAUSE_END.test(s[c - 1])) c--;
    let e = end; while (e < s.length && !CLAUSE_END.test(s[e])) e++;
    if (REPORTED.test(s.slice(c, i)) || REPORTED.test(s.slice(end, e))) continue;
    // Already written out by whoever said it ("明天（06-23）", "明天 6 月 23 号"): leave it.
    if (/^\s*[（(]?\s*(\d{1,4}[-/月.])/.test(s.slice(end, end + 8))) continue;
    out += s.slice(last, end) + `（=${dayMark(resolve(m, at), now)}）`;
    last = end;
  }
  return out + s.slice(last);
}

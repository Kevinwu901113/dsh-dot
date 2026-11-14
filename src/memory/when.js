// dsh-dot/memory/when: dates for what she remembers, worked out by code, never by the model.
//
//   dayHeading  "06-22 周一 · 15 天前" — the anchor above a group of recalled turns
//   annotate    "明天 / 下周三 / 腊月十二 / 月底 …" in a line said on a known day → "明天（=06-23）"
//
// Only expressions with one meaning are converted, relative to the day the line was said:
//   今天 明天 后天 大后天 昨天 前天 大前天; 这周X / 下周X / 上周X (weeks start on Monday);
//   月底 / 下个月底 / 上个月底 (the month's last day); X号 / X日 (this month if not yet passed, else
//   next, left as said when it passed a week ago or less; 这个月 / 下个月 / 上个月 X号 as said);
//   lunar dates: 正月 / 冬月 / 腊月 + a day, 一…十二月 + 初N / 廿N, any month after 农历 / 阴历,
//   闰X月 for a leap month; 大年初N; 除夕 / 大年三十; 春节 / 过年 / 元旦 / 除夕 前N天 · 后N天;
//   a bare 初N only within 40 days before to 15 days after the Spring Festival (正月初N).
// A lunar date or festival is the one at most 15 days back, else the next one. The lunar calendar is
// Node's own (Intl, -u-ca-chinese), searched day by day, with the few days it gets wrong set right
// (LUNAR_TRUE). "周末", a bare "周三", "八月十五", "春节后第三天"
// are left as said: they need context the code does not have. So is anything in quotes, imagined
// (如果 / 要是 …) or heard (听说 / 写着 …) in its clause, and what someone 说 when the clause says it
// was said another day (昨天他说明天来) — a wrong exact date misleads more than the words do.
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

// ── the lunar calendar ──
let LUNAR = null;
const lunarCache = new Map();
// Where ICU's Chinese calendar is a day off (Node 22 / ICU 78; checked day by day against a
// table-based reference for 2015–2045): the true lunar month there, as [its first day, the last day
// to set, month]. Set, not shifted, so it stays right if a later ICU gets these right.
const LUNAR_TRUE = [['2027-02-06', '2027-03-07', '1'], ['2030-01-04', '2030-02-02', '12'], ['2030-02-03', '2030-03-03', '1']];
/** The lunar month ("12", or "6bis" for a leap month) and day of a local day. */
function lunarOf(ms) {
  const key = startOfDay(ms);
  let v = lunarCache.get(key);
  if (!v) {
    LUNAR ??= new Intl.DateTimeFormat('en-u-ca-chinese', { month: 'numeric', day: 'numeric' });
    const p = LUNAR.formatToParts(key + 12 * 3600000);
    v = { m: p.find((x) => x.type === 'month').value, d: Number(p.find((x) => x.type === 'day').value) };
    const dt = new Date(key), ymd = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const fix = LUNAR_TRUE.find(([a, b]) => ymd >= a && ymd <= b);
    if (fix) v = { m: fix[2], d: daysBetween(new Date(`${fix[0]}T00:00:00`).getTime(), key) + 1 };
    if (lunarCache.size > 5000) lunarCache.clear();
    lunarCache.set(key, v);
  }
  return v;
}
/** The first day from `back` days before `at` on which `hit(lunar)` is true (about a year ahead at most), or null. */
function findDay(at, hit, back = 15, ahead = 400) {
  for (let k = -back; k <= ahead; k++) { const ms = addDays(at, k); if (hit(lunarOf(ms))) return ms; }
  return null;
}
/** Lunar month `m` ("12" / "6bis") day `d`: at most 15 days back, else the next; null when that month has no such day. */
function lunarDay(at, m, d) {
  let inside = false;
  for (let k = -15; k <= 400; k++) {
    const ms = addDays(at, k), l = lunarOf(ms);
    if (l.m === m) { if (l.d === d) return ms; if (l.d < d) inside = true; } else if (inside) return null;
  }
  return null;
}
/** 正月初一 such that `off` days from it is at most 15 days back from `at`. */
const springFestival = (at, off) => findDay(addDays(at, -off), (l) => l.m === '1' && l.d === 1);

// ── numbers ──
const DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** "28" / "二十八" / "廿八" / "十" → 28 / 28 / 28 / 10; NaN when not a number. */
function num(s) {
  if (/^\d+$/.test(s)) return Number(s);
  const t = s.replace(/^廿/, '二十').replace(/^卅/, '三十');
  const m = /^([一二三四五六七八九两])?(十)?([一二三四五六七八九])?$/.exec(t);
  if (!m || (!m[2] && m[1] && m[3])) return NaN;
  if (!m[2]) return DIGIT[m[1] ?? m[3]] ?? NaN;
  return (m[1] ? DIGIT[m[1]] : 1) * 10 + (m[3] ? DIGIT[m[3]] : 0);
}
const N = '\\d{1,2}|[一二三四五六七八九十两]{1,3}';
const LMONTH = '正|冬|腊|十一|十二|十|[一二三四五六七八九]';
const LDAY = '初[一二三四五六七八九十]|二十[一二三四五六七八九]?|廿[一二三四五六七八九]?|三十|十[一二三四五六七八九]?|[一二三四五六七八九](?![十\\d])';
const LMNUM = { 正: 1, 冬: 11, 腊: 12 };
const lday = (s) => num(s.replace(/^初/, ''));

// Each rule: a pattern, and the day a match means (null: left as said). Matched longest-first where
// they overlap (大年初二 is not read as 初二, 下个月底 not as 月底).
const DAYWORD = { 大前天: -3, 前天: -2, 昨天: -1, 昨晚: -1, 昨儿: -1, 明天: 1, 明早: 1, 明晚: 1, 明儿: 1, 后天: 2, 大后天: 3 };
const WD = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const RULES = [
  // 明天 / 下周三: plain relative days. Not 上上周 / 下下周 (two weeks off), and not the words that only
  // start like a day: 下周天气, 这周一直, 下周一起, 后天性.
  { re: new RegExp(`(${Object.keys(DAYWORD).sort((a, b) => b.length - a.length).join('|')})(?!性)`, 'g'), day: (m, at) => addDays(at, DAYWORD[m[1]]) },
  { re: /(?<![上下])(这个?|本|下个?|上个?)(?:周|星期|礼拜)(天(?![气空])|一(?![直起下样些共点])|[二三四五六日])/g,
    day: (m, at) => addDays(mondayMs(at), (m[1][0] === '下' ? 7 : m[1][0] === '上' ? -7 : 0) + WD[m[2]] - 1) },
  // 月底 / 下个月底 (not 每月底, not 十二月底: which year it is needs context).
  { re: /(?<![每\d一二三四五六七八九十])(这个?|本|下个?|上个?)?月底/g,
    day: (m, at) => { const d = new Date(startOfDay(at)); const k = m[1]?.[0] === '下' ? 2 : m[1]?.[0] === '上' ? 0 : 1; return new Date(d.getFullYear(), d.getMonth() + k, 0).getTime(); } },
  // 28号 / 下个月10号 / 二十七号 / 28日: this month if not yet passed, else next month; left as said when
  // it passed a week ago or less. Not 12月28号 (already a date), 3号楼, 第三号, 生日, and not a lone
  // 一号 / 三号 (三号窗口, 大一号, 梁一号: mostly a label) unless 这个月 / 下个月 is said.
  { re: new RegExp(`(?<![\\d月一二三四五六七八九十两廿零〇第几每初])(这个?月|本月|下个?月|上个?月)?(?:(${N})号(?![楼线院房室门窗口位床车台机码子人球种字元店馆铺柜箱桌选节])|(\\d{1,2})日(?![子常本元记志程后内前游里]))`, 'g'),
    day: (m, at) => {
      const n = num(m[2] ?? m[3]); const d = new Date(startOfDay(at));
      if (!(n >= 1 && n <= 31) || (!m[1] && /^[一二三四五六七八九两]$/.test(m[2] ?? ''))) return null;
      // Passed a few days ago: as likely the one just gone as next month's.
      if (!m[1] && n < d.getDate() && n >= d.getDate() - 7) return null;
      const k = m[1] ? (m[1][0] === '下' ? 1 : m[1][0] === '上' ? -1 : 0) : n >= d.getDate() ? 0 : 1;
      const t = new Date(d.getFullYear(), d.getMonth() + k, n);
      return t.getDate() === n ? t.getTime() : null;
    } },
  // 春节前十天 / 元旦前两天 / 除夕后三天 (not 春节后第三天: whether 初一 counts is not said).
  { re: new RegExp(`(春节|过年|元旦|除夕|大年三十)(前|后)(${N})天(?![内里左])`, 'g'),
    day: (m, at) => { const n = num(m[3]); return Number.isFinite(n) ? festival(at, m[1], m[2] === '前' ? -n : n) : null; } },
  // 除夕 / 大年三十 / 大年初二.
  { re: /除夕|大年三十/g, day: (m, at) => festival(at, '除夕', 0) },
  { re: /大年(初[一二三四五六七八九十])/g, day: (m, at) => festival(at, '春节', lday(m[1]) - 1) },
  // 农历八月十五 / 腊月十二 / 三月初三 / 闰六月初一.
  { re: new RegExp(`(?<!反)(农历|阴历|旧历)?的?(闰)?(${LMONTH})月(${LDAY})`, 'g'),
    day: (m, at) => {
      const mo = LMNUM[m[3]] ?? num(m[3]), d = lday(m[4]);
      if (!m[1] && !LMNUM[m[3]] && !/^[初廿]/.test(m[4])) return null; // 八月十五 / 十月二十: could be either calendar
      if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 30)) return null;
      return lunarDay(at, `${mo}${m[2] ? 'bis' : ''}`, d);
    } },
  // A bare 初四: 正月初四 near the Spring Festival only (not 最初 / 年初 / 月初, not 初三的学生 / 上初二).
  { re: /(?<![最当起年月正腊冬闰上读念])初([一二三四五六七八九十])(?![中高级学生班年])/g,
    day: (m, at) => { const sf = findDay(at, (l) => l.m === '1' && l.d === 1, 15, 40); return sf == null ? null : addDays(sf, num(m[1]) - 1); } },
];
/** The day `off` days from a festival, the one at most 15 days back from `at` or else the next. */
function festival(at, name, off) {
  if (name === '元旦') {
    const y = new Date(at).getFullYear();
    for (const yy of [y, y + 1]) { const t = addDays(new Date(yy, 0, 1).getTime(), off); if (daysBetween(at, t) >= -15) return t; }
    return null;
  }
  const o = name === '春节' || name === '过年' ? off : off - 1; // 除夕 / 大年三十: the day before 正月初一
  const sf = springFestival(at, o);
  return sf == null ? null : addDays(sf, o);
}

const QUOTES = { '“': '”', '「': '」', '『': '』', '"': '"', '‘': '’' };
// A clause that imagines or hears: its dates are not the speaker's.
const NOT_MINE = /(听说|据说|写着|以为|如果|假如|要是|万一|假设|梦到|梦见|的话)/;
// Someone 说 / 讲: the date is still the line's day, unless the clause says it was said another day.
const SAID = /(说|讲|告诉我|问我|提到)/;
const SAID_BEFORE = /(昨|前天|第二天|隔天|次日|上周|上个?星期|上个?礼拜|上次|上回|那天|那会|当时|之前|以前|早先|早就|上个?月|去年|周[一二三四五六日天]|\d+号)/;
const CLAUSE_END = /[，。！？；,.!?;\n]/;

/**
 * The line with an exact date after each unambiguous day in it: "明天（=06-23）".
 * `at` is when the line was said; `now` decides whether a year is written (dayMark).
 */
export function annotate(text, at, now = at) {
  const s = String(text ?? '');
  if (!Number.isFinite(at) || !s) return s;
  // Where quotes are open.
  const quoted = new Array(s.length).fill(false);
  let close = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (close) { if (ch === close) close = ''; else quoted[i] = true; }
    else if (QUOTES[ch]) close = QUOTES[ch];
  }
  // Every rule's matches; where two overlap, the earlier, then the longer one.
  const found = [];
  for (const rule of RULES) for (const m of s.matchAll(rule.re)) found.push({ m, rule, i: m.index, end: m.index + m[0].length });
  found.sort((a, b) => a.i - b.i || b.end - a.end);
  let out = '', last = 0, taken = 0;
  for (const { m, rule, i, end } of found) {
    if (i < taken || quoted[i]) continue;
    taken = end;
    let c = i; while (c > 0 && !CLAUSE_END.test(s[c - 1])) c--;
    let e = end; while (e < s.length && !CLAUSE_END.test(s[e])) e++;
    const before = s.slice(c, i), after = s.slice(end, e);
    if (NOT_MINE.test(before) || NOT_MINE.test(after)) continue;
    if ((SAID.test(before) || SAID.test(after)) && SAID_BEFORE.test(before)) continue;
    // Already written out by whoever said it ("明天（06-23）", "明天 6 月 23 号"): leave it.
    if (/^\s*[（(]?\s*(\d{1,4}[-/月.])/.test(s.slice(end, end + 8))) continue;
    const day = rule.day(m, at);
    if (day == null) continue;
    out += s.slice(last, end) + `（=${dayMark(day, now)}）`;
    last = end;
  }
  return out + s.slice(last);
}

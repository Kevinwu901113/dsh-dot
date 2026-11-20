// Her day: one range of hours she is awake in ('HH:MM-HH:MM', may wrap midnight). Everything that depends on the
// time of day reads it from here — when notifications reach her, when she has time of her own, when the day ends
// and her memory is gone over — so there is one rhythm, not three clocks set separately.
export const DEFAULT_AWAKE = '08:00-23:00';
const parse = (spec) => {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec || '').trim());
  if (!m) return null;
  const start = +m[1] * 60 + +m[2], end = +m[3] * 60 + +m[4];
  return start < 1440 && end <= 1440 && start !== end ? { start, end } : null; // '00:00-24:00' = the whole day
};
export const validHours = (spec) => Boolean(parse(spec));
const at = (date, minutes, addDays = 0) => { const d = new Date(date); d.setHours(0, minutes, 0, 0); d.setDate(d.getDate() + addDays); return d.getTime(); };
/** Is `date` inside the range? A spec that is not a range = always. */
export function inHours(spec, date = new Date()) {
  const h = parse(spec);
  if (!h) return true;
  const now = date.getHours() * 60 + date.getMinutes();
  return h.start < h.end ? now >= h.start && now < h.end : now >= h.start || now < h.end;
}
/** Milliseconds until the range ends; 0 outside it, Infinity when the spec is not a range. */
export function msLeftInHours(spec, date = new Date()) {
  const h = parse(spec);
  if (!h) return Infinity;
  if (!inHours(spec, date)) return 0;
  const end = at(date, h.end);
  return (end > date.getTime() ? end : at(date, h.end, 1)) - date.getTime();
}
/** Milliseconds until the range next starts; 0 inside it or when the spec is not a range. */
export function msUntilHours(spec, date = new Date()) {
  const h = parse(spec);
  if (!h || inHours(spec, date)) return 0;
  const start = at(date, h.start);
  return (start > date.getTime() ? start : at(date, h.start, 1)) - date.getTime();
}
/** When the range last started (the morning of the day she is in, or has just ended); midnight when the spec is not a range. */
export function lastStart(spec, date = new Date()) {
  const h = parse(spec);
  if (!h) return at(date, 0);
  const start = at(date, h.start);
  return start <= date.getTime() ? start : at(date, h.start, -1);
}
/** When the range last ended (when she last fell asleep); midnight when the spec is not a range. */
export function lastEnd(spec, date = new Date()) {
  const h = parse(spec);
  if (!h) return at(date, 0);
  const end = at(date, h.end);
  return end <= date.getTime() ? end : at(date, h.end, -1);
}

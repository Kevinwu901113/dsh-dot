// dsh-dot/price: what a model call costs — one price table, one way to count it.
//
// Every model call's usage ({ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens } from dsh-llm, or a cost
// record { in, cached, out }) comes out as two numbers:
//   yuan   what it cost at the official price at the time of the call (costOf). DeepSeek charges double in its
//          peak hours (Beijing time, Monday to Friday 9:00–12:00 and 14:00–18:00), so the same call costs twice as
//          much at 10:00 as at 22:00;
//   units  折算 token (unitsOf): the same call at the idle price, in tokens of uncached input. On deepseek-flash a
//          cache hit is 0.02 of one, an output token (thinking included) 4. It does not change with the hour, so a
//          cap counted in it (dot.thingCostCap, interlude.freeTokenCap / freeDailyTokens) stops the same work at
//          10:00 and at 22:00; a million of them is 1 yuan at idle prices, 2 at peak hours.
// The things on the book, her own time and what the panel and /dot show are all counted here (charge), and nowhere
// else: there is no weight written down anywhere but in PRICES.
//
// A model the table does not know (and no price of his own, interlude.price) is counted without a discount: every
// token one unit, no yuan; it is logged once and /dot says so (unknownRoutes) — not priced as something it is not.
// Legal holidays that fall on a weekday are counted at peak prices (there is no holiday calendar here): an
// overestimate, never an underestimate.

/** Yuan per million tokens. `providers`: the routes this row is for (dsh's provider name); `models`: model ids. */
export const PRICES = [
  // DeepSeek-V4.1-Flash at DeepSeek's official prices (checked 11-26). deepseek-account is the DeepSeek account
  // route (dsh-llm-deepseek-account); deepseek the API-key route (dsh-llm-deepseek), same model, same price list.
  { providers: ['deepseek-account', 'deepseek'], models: ['deepseek-flash'], idle: { cached: 0.02, in: 1, out: 4 }, peak: { cached: 0.04, in: 2, out: 8 }, hours: 'deepseek' },
];
// Peak hours by name: [weekdays (0 = Sunday), [start, end) in minutes, in the zone's time].
const HOURS = { deepseek: { offsetMs: 8 * 3600000, days: [1, 2, 3, 4, 5], spans: [[9 * 60, 12 * 60], [14 * 60, 18 * 60]] } }; // Asia/Shanghai: no DST
const NO_DISCOUNT = Object.freeze({ cached: 1, in: 1, out: 1 });

/** Is `at` in the peak hours named `hours` (DeepSeek's by default)? */
export function isPeak(at = Date.now(), hours = 'deepseek') {
  const h = HOURS[hours];
  if (!h) return false;
  const d = new Date(Number(at) + h.offsetMs); // its UTC fields are the zone's wall clock
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return h.days.includes(d.getUTCDay()) && h.spans.some(([a, b]) => m >= a && m < b);
}

/** A usage as a cost record: { in (uncached input, cache writes included), cached (cache hits), out (thinking included) }. */
export function usageOf(u) {
  if (!u || typeof u !== 'object') return { in: 0, cached: 0, out: 0 };
  const n = (v) => Number(v ?? 0) || 0;
  if ('inputTokens' in u || 'outputTokens' in u || 'cacheReadTokens' in u) return { in: n(u.inputTokens) + n(u.cacheWriteTokens), cached: n(u.cacheReadTokens), out: n(u.outputTokens) };
  return { in: n(u.in), cached: n(u.cached), out: n(u.out) };
}

// His own price (interlude.price: { in, cached, out } yuan per million), when he gave one: it is used for every model,
// at every hour, in place of the table. Set by the components when they start (configure).
let own = null, warn = () => {};
const unknown = new Map(); // "provider/model" → first seen (ms)
/** { price: his own price or null, warn: (message) => void for the once-per-model notice }; both optional. */
export function configure({ price, warn: w } = {}) {
  if (price !== undefined) {
    const p = price && typeof price === 'object' ? price : null;
    const ok = p && Number(p.in) > 0;
    own = ok ? { in: Number(p.in), cached: Number(p.cached ?? p.in) || 0, out: Number(p.out ?? p.in) || 0 } : null;
    if (p && !ok) (w ?? warn)(`interlude.price ignored: needs "in" (yuan per million input tokens) above 0, got ${JSON.stringify(price)}`);
  }
  if (typeof w === 'function') warn = w;
}

const keyOf = (route) => `${route?.provider ?? '?'}/${route?.model ?? '?'}`;
/** The row of the table for a route ({ provider, model }), or null. */
export function rowOf(route) {
  return PRICES.find((r) => r.providers.includes(String(route?.provider ?? '')) && r.models.includes(String(route?.model ?? ''))) ?? null;
}

/**
 * The price of a call on `route` at `at`: { cached, in, out } yuan per million, `peak`, and `source` ('own' — his
 * interlude.price; 'table'; 'unknown' — no price, the numbers are null).
 */
export function priceOf(route, at = Date.now()) {
  if (own) return { ...own, peak: false, source: 'own' };
  const row = rowOf(route);
  if (!row) return { cached: null, in: null, out: null, peak: false, source: 'unknown' };
  const peak = isPeak(at, row.hours);
  return { ...(peak ? row.peak : row.idle), peak, source: 'table' };
}

/** What one unit is worth for a route, relative to uncached input at the idle price: { cached, in, out }. */
export function weightsOf(route) {
  const p = own ?? rowOf(route)?.idle;
  return p ? { cached: p.cached / p.in, in: 1, out: p.out / p.in } : NO_DISCOUNT;
}

/** The yuan a call cost (usage at `at` on `route`), or null when its price is not known. */
export function costOf(usage, at = Date.now(), route = null) {
  const p = priceOf(route, at);
  if (p.source === 'unknown') return null;
  const c = usageOf(usage);
  return (c.in * p.in + c.cached * p.cached + c.out * p.out) / 1e6;
}

/** 折算 token of a usage on `route`: the same at every hour (unknown model: every token one unit). */
export function unitsOf(usage, route = null) {
  const c = usageOf(usage), w = weightsOf(route);
  return c.in * w.in + c.cached * w.cached + c.out * w.out;
}

/**
 * One call counted: { units, yuan } (yuan null when its price is not known — that model is then noted once:
 * unknownRoutes, and logged through configure's warn).
 */
export function charge(usage, { at = Date.now(), route = null } = {}) {
  const yuan = costOf(usage, at, route);
  if (yuan === null && !unknown.has(keyOf(route))) {
    unknown.set(keyOf(route), at);
    try { warn(`no price for ${keyOf(route)}: its calls are counted without a cache discount (every token one unit) and shown without yuan; set interlude.price for your own`); } catch { /* never in the way */ }
  }
  return { units: unitsOf(usage, route), yuan };
}

/** Yuan added up: null once any part was not priced. */
export const addYuan = (a, b) => (a === null || b === null ? null : (Number(a) || 0) + (Number(b) || 0));

/** The models seen without a price: ["provider/model", …]. */
export const unknownRoutes = () => [...unknown.keys()];
/** For tests: forget what was seen and his price. */
export function resetPrices() { unknown.clear(); own = null; warn = () => {}; }

// Which model a session's calls go to: the route its last request header named (session event `request/header`),
// else the default selection. The header is the exact one; the selection is right whenever she uses one model.
const routes = new Map(); // session id → { provider, model }
const ROUTES_KEPT = 200;
/** Note a session event: a `request/header` says which model the session's calls go to. */
export function noteRoute(sessionId, event) {
  if (event?.type !== 'request/header' || !sessionId) return;
  const c = event.data?.header?.config;
  if (!c?.provider || !c?.model) return;
  routes.delete(sessionId); routes.set(sessionId, { provider: String(c.provider), model: String(c.model) });
  if (routes.size > ROUTES_KEPT) routes.delete(routes.keys().next().value);
}
/** The route of a session's calls: { provider, model } or null. */
export function routeFor(ctx, sessionId) {
  const r = sessionId ? routes.get(sessionId) : null;
  if (r) return r;
  try { const s = ctx?.get?.('agentDefaultModel')?.currentSelection?.(); return s?.provider && s?.model ? { provider: s.provider, model: s.model } : null; } catch { return null; }
}

/** "¥1.16", "¥0.082", "¥0.0041" (cents from 0.1 yuan up, three significant-ish places under it); '' for null. */
export function yuanText(y) {
  if (y === null || y === undefined || !Number.isFinite(Number(y))) return '';
  const v = Number(y);
  return `¥${v >= 0.1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v > 0 ? v.toFixed(4) : '0'}`;
}

/** What `units` 折算 token cost on `route`: { idle, peak } yuan (the same twice under his own price), or null. */
export function unitsYuan(units, route = null) {
  const n = Number(units) || 0;
  if (own) return { idle: (n * own.in) / 1e6, peak: (n * own.in) / 1e6 };
  const row = rowOf(route);
  return row ? { idle: (n * row.idle.in) / 1e6, peak: (n * row.peak.in) / 1e6 } : null;
}

/** One line for /dot: the price in use, and the models without one. */
export function priceLine(route, at = Date.now()) {
  const p = priceOf(route, at), m = unitsYuan(1e6, route);
  const per = (x) => `${x.cached}/${x.in}/${x.out} yuan per million (cached/in/out)`;
  const head = p.source === 'own' ? `price: your own (interlude.price) ${per(p)}; caps in 折算 token, 1M = ${yuanText(m.idle)}`
    : p.source === 'table' ? `price: ${keyOf(route)} at the official price, now ${p.peak ? 'peak' : 'idle'} ${per(p)}; caps in 折算 token at idle prices, 1M = ${yuanText(m.idle)} idle, ${yuanText(m.peak)} peak`
      : `price: none known for ${keyOf(route)} — counted without a cache discount, no yuan (interlude.price sets your own)`;
  const others = unknownRoutes().filter((k) => k !== keyOf(route));
  return others.length ? `${head} · no price for ${others.join(', ')}` : head;
}

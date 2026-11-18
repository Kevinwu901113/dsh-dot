// dsh-dot: calls her own rules refused. A gate answers a call with deny(reason); what was refused is
// remembered here by its reason, so the rest of dsh-dot can tell "a rule stopped this call" from "the
// app or the tool failed" without matching wording (dot/howto.js: a refusal is not a lesson about the app).
const reasons = new Set();
const key = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** The answer of a `tools/pre-execute` gate that refuses the call. */
export function deny(reason) {
  const k = key(reason);
  if (k) { reasons.add(k); if (reasons.size > 500) reasons.delete(reasons.values().next().value); }
  return { kind: 'deny', reason };
}
/** Whether `text` (a tool result's error) is one of the refusals given this run. */
export function wasRefused(text) {
  const t = key(text);
  if (!t) return false;
  for (const r of reasons) if (t.includes(r)) return true;
  return false;
}

// dsh-dot/llm-call: the one way a hand-built model call is made (callModel), and how its reply is read.
// How a call ended is said by outcomeOf (llm-gate.js, which sees every call's end).
import { background as markBackground, effortFor, outcomeOf } from './llm-gate.js';

/**
 * Read a model reply from an llm stream: its text, the arguments of the first tool call (the `interval` tool carries
 * the round's fields as provider-validated JSON), the token usage, every tool call in order (`calls`: [{ name, args }])
 * and the finish reason. Never throws for how the call ended: that is the finish.
 */
export async function readReply(stream) {
  let text = '';
  const calls = new Map(); // tool-call index → arguments so far
  const names = new Map(); // tool-call index → tool name
  let usage = null;
  let finish = null;
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'tool-call-delta') { calls.set(chunk.index, (calls.get(chunk.index) ?? '') + (chunk.argumentsDelta ?? '')); if (chunk.name) names.set(chunk.index, chunk.name); }
    else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') { if (chunk.block.arguments) calls.set(chunk.index, chunk.block.arguments); if (chunk.block.name) names.set(chunk.index, chunk.block.name); }
    else if (chunk.type === 'usage') usage = chunk.usage ?? null;
    else if (chunk.type === 'finish') finish = chunk.reason;
  }
  const args = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).find(Boolean) ?? '';
  // Every call, in order, by name (a replay of her conversation compares which tools each run chose).
  const all = [...new Set([...calls.keys(), ...names.keys()])].sort((a, b) => a - b).map((i) => ({ name: names.get(i) ?? '', args: calls.get(i) ?? '' }));
  return { text, args, usage, finish, calls: all };
}

/** readReply, and an aborted or failed call thrown (FinishReason kinds: stop | tool-calls | max-tokens | aborted | error). */
export async function collectReply(stream) {
  const r = await readReply(stream);
  if (r.finish && (r.finish.kind === 'aborted' || r.finish.kind === 'error')) {
    throw new Error(`interlude model call ended with ${r.finish.kind}: ${r.finish.failure?.message ?? r.finish.failure?.code ?? ''}`);
  }
  return r;
}

// A component that did not inject a service (dot) may not read it off ctx: each way is tried on its own.
const service = (ctx, name) => {
  try { const s = ctx?.get?.(name); if (s) return s; } catch { /* next */ }
  try { return ctx?.[name]; } catch { return undefined; }
};
/** The default model and the llm service: { sel, llm }, either undefined when there is none. */
export function modelOf(ctx) {
  let sel;
  try { sel = service(ctx, 'agentDefaultModel')?.currentSelection?.(); } catch { sel = undefined; }
  const llm = service(ctx, 'llm');
  return { sel: sel?.model ? sel : undefined, llm: llm?.stream ? llm : undefined };
}

/** `effort` for callModel: the reasoning effort of her background work (llm.workEffort, llm-gate.js). */
export const WORK = 'work';

/**
 * One hand-built model call with the default model: every call of ours that is not a step of an agent loop.
 * @param ctx
 * @param {object} o
 * @param {string} [o.effort] - WORK: the effort of her background work; another string: that effort when the model
 *   has it (else the selector's); undefined: the selector's own
 * @param {boolean} [o.background] - the request is background work (llm-gate: paced, held while the account is)
 * @param {string} [o.system] @param {object[]} [o.tools] @param {number} o.maxTokens @param {object[]} o.messages - sent as given
 * @returns {Promise<{ ok: boolean, outcome: object, text: string, args: string, calls: object[], usage: object|null, finish: object|null, effort?: string, route?: { provider, model } }>}
 *   outcome.kind 'no-model' when there is no model to ask (nothing was sent)
 */
export async function callModel(ctx, { effort, background = false, system, tools, maxTokens, messages } = {}) {
  const { sel, llm } = modelOf(ctx);
  if (!sel || !llm) return { ok: false, outcome: { kind: 'no-model', code: 'no-model', message: 'no model to ask', retryable: false }, text: '', args: '', calls: [], usage: null, finish: null };
  const e = effort === undefined ? sel.reasoningEffort : (await effortFor(ctx, sel, effort === WORK ? undefined : effort)).effort;
  const options = { provider: sel.provider, model: sel.model, ...(e ? { reasoningEffort: e } : {}), ...(system !== undefined ? { system } : {}), ...(tools ? { tools } : {}), maxTokens, messages };
  let r;
  try { r = await readReply(llm.stream(background ? markBackground(options) : options)); } catch (err) {
    r = { text: '', args: '', usage: null, calls: [], finish: { kind: 'error', failure: { code: String(err?.code ?? 'UNKNOWN'), message: String(err?.message ?? err) } } };
  }
  const outcome = outcomeOf(r.finish, r);
  return { ...r, ok: outcome.kind === 'ok', outcome, effort: e, route: { provider: sel.provider, model: sel.model } }; // route: what it cost is priced by (src/price.js)
}

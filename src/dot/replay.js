// dsh-dot/replay: how she decides, measured on kept inputs. Each step of her conversation is a model request; with
// dot.replayKeep > 0 the request is kept as it went into the `llm/stream` waterfall — the last point a plugin sees,
// after the agent loop has put the system prompt, the history, the turn notes (agent/pre-step) and the tool list
// together; next() takes no argument there, so no listener can change it afterwards. `/dot replay` sends a kept one
// again a few times and only writes down what came back: the text and the tool calls (name and arguments), and the
// tokens. Nothing of it is carried out, sent, or put into her conversation, her memory or the book of things.
//
//   kept    <dsh home>/dot-replay/decide/<time>-<n>.json, one line of JSON:
//           { v, at, session, systemSha, systemChars, toolsSha, tools, requestSha, request }
//           request: the fields of the request as it was (provider, model, reasoningEffort, messages, system, tools,
//           toolHistory, maxTokens…); not its abort signal. The newest `keep` stay; the rest go, with their .out.json.
//   replay  <file>.out.json beside it: { at, file, times, sent: fingerprint of what was sent again, same, runs }
//
// The shas are the say-call's (12 hex of sha256): the system text (a hand-built request's `system`, or the agent
// loop's leading system-role messages) and the tool declarations as JSON. Two requests with the same shas had the
// same system prompt and tool list byte for byte: what a refactor of her deciding side must not change.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { collectReply } from '../llm-call.js';
import { background } from '../llm-gate.js';
import { SAY_TOOL } from '../tool-prefixes.js';
import { contentText, spokenOf } from './text.js';

export const REPLAY_TIMES = 3;
export const REPLAY_MAX = 10;
// What of a request is kept and sent again. Not `signal` (the step's own), `sessionId` (kept as `session`: sent again
// it would be one more request of her live conversation to the adapter), or `purpose` (such requests are not kept).
const FIELDS = ['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens', 'stop', 'system', 'messages', 'tools', 'toolHistory'];

const sha = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12);

/** The system text of a request: its `system`, then the leading system-role messages (how the agent loop sends it). */
export function systemOf(req) {
  const parts = typeof req?.system === 'string' ? [req.system] : [];
  for (const m of Array.isArray(req?.messages) ? req.messages : []) { if (m?.role !== 'system') break; parts.push(contentText(m.content)); }
  return parts.join('\n\n');
}

/** The shas a refactor compares: the system text and the tool declarations, each with its size. */
export function fingerprint(req) {
  const system = systemOf(req);
  return { systemSha: sha(system), systemChars: system.length, toolsSha: sha(JSON.stringify(req?.tools ?? [])), tools: Array.isArray(req?.tools) ? req.tools.length : 0 };
}

/** The request's own fields, as they are (the same objects: only read, then serialized). */
const fieldsOf = (options) => Object.fromEntries(FIELDS.filter((k) => options[k] !== undefined).map((k) => [k, options[k]]));

/** The kept requests in `dir`, oldest first (file names). */
export function keptFiles(dir) {
  try { return readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.out.json')).sort(); } catch { return []; }
}

/**
 * Keep her conversation's requests. `hers(sessionId)`: is this a step of her conversation (not her hands, not a
 * conversation she left). `keep`: how many stay. observe() never throws and never touches the request.
 */
export function createRecorder({ dir, keep, hers, audit = () => {}, logger = {} }) {
  let chain = Promise.resolve(), last = '', seq = 0;
  async function write(name, text, meta) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), `${text}\n`);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.endsWith('.out.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      await rm(join(dir, f), { force: true });
      await rm(join(dir, `${f}.out.json`), { force: true });
    }
    audit('decide-kept', { file: name, ...meta });
  }
  return {
    observe(options) {
      try {
        if (!(keep > 0) || !options || options.purpose) return;
        const session = options.sessionId ? String(options.sessionId) : '';
        if (!session || !hers(session)) return;
        const request = fieldsOf(options);
        const body = JSON.stringify(request);
        const requestSha = sha(body);
        if (requestSha === last) return; // the host's retry of the same request
        last = requestSha;
        const fp = fingerprint(request);
        const at = new Date().toISOString();
        const name = `${at.replace(/[:.]/g, '-')}-${String(++seq).padStart(4, '0')}.json`;
        const meta = { session, ...fp, requestSha };
        const text = `${JSON.stringify({ v: 1, at, ...meta }).slice(0, -1)},"request":${body}}`;
        chain = chain.then(() => write(name, text, meta)).catch((err) => { try { logger.debug?.(`decide request not kept: ${err.message}`); } catch { /* ignore */ } });
      } catch (err) { try { logger.debug?.(`decide request not kept: ${err.message}`); } catch { /* ignore */ } }
    },
    /** Resolves when what was observed so far is on disk (tests). */
    idle: () => chain,
  };
}

/** `latest`, an absolute path, or a name in `dir` (then in `base`, where files copied out to stay are put). */
export function resolveFile(dir, base, file) {
  if (file === 'latest') {
    const f = keptFiles(dir).at(-1);
    if (!f) throw new Error(`nothing kept in ${dir} (dot.replayKeep is 0?)`);
    return join(dir, f);
  }
  if (isAbsolute(file)) return file;
  return [join(dir, file), join(base, file)].find((p) => existsSync(p)) ?? join(dir, file);
}

const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const spoke = (calls) => calls.some((c) => c.name === SAY_TOOL || Boolean(spokenOf(c.name, parse(c.args))));

/** One line per run: the tools it called, whether it said anything, its tokens. */
export function summary(runs) {
  return runs.map((r, i) => (r.error ? `#${i + 1}: !! ${r.error}` : `#${i + 1}: ${r.calls.map((c) => c.name).join(', ') || 'no tool'} · ${r.said ? 'said' : 'silent'}${r.text ? ` · text ${r.text.length} chars` : ''} · tokens in ${r.usage.in} (cached ${r.usage.cached}) out ${r.usage.out}${r.usage.reasoning ? ` (reasoning ${r.usage.reasoning})` : ''} · ${r.finish}`)).join('\n');
}

/**
 * Send a kept request again `times` times (at most REPLAY_MAX) and write what came back beside it. `llm`: the llm
 * service; `sel`: the model selection, used only when the file names no provider. Each request is a new object marked
 * background (src/llm-gate.js), so replays wait behind his conversation and are never mistaken for hers.
 */
export async function replay({ dir, base, file = 'latest', times = REPLAY_TIMES, llm, sel, audit = () => {} }) {
  if (!llm?.stream) return 'no model service';
  const f = resolveFile(dir, base, file);
  const kept = JSON.parse(readFileSync(f, 'utf8'));
  const request = fieldsOf(kept?.request ?? kept);
  if (!request.provider && sel) Object.assign(request, { provider: sel.provider, model: sel.model, ...(sel.reasoningEffort && !request.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}) });
  if (!request.provider || !Array.isArray(request.messages)) return `${f}: not a kept request`;
  const n = Math.max(1, Math.min(REPLAY_MAX, Number.parseInt(times, 10) || REPLAY_TIMES));
  const sent = fingerprint(request);
  const runs = await Promise.all(Array.from({ length: n }, async () => {
    try {
      const r = await collectReply(llm.stream(background({ ...request })));
      const u = r.usage ?? {};
      const calls = r.calls ?? [];
      return { text: r.text, calls, said: spoke(calls), usage: { in: u.inputTokens ?? 0, cached: u.cacheReadTokens ?? 0, out: u.outputTokens ?? 0, ...(u.reasoningTokens ? { reasoning: u.reasoningTokens } : {}) }, finish: r.finish?.kind ?? '' };
    } catch (error) { return { error: String(error?.message ?? error) }; }
  }));
  const same = kept?.systemSha === undefined ? null : kept.systemSha === sent.systemSha && kept.toolsSha === sent.toolsSha;
  writeFileSync(`${f}.out.json`, `${JSON.stringify({ at: Date.now(), file: f, times: n, model: `${request.provider}/${request.model}`, effort: request.reasoningEffort ?? '', sent, same, runs }, null, 1)}\n`);
  audit('replay', { file: f, times: n, said: runs.filter((r) => r.said).length, failed: runs.filter((r) => r.error).length });
  return `${n} run(s) of ${f} → ${f}.out.json${same === false ? ' (system or tools differ from the kept fingerprint)' : ''}\n${summary(runs)}`;
}

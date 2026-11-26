// dsh-dot/status: what /dot reports and runs again (taken out of core.js as it was): the status lines and her
// liveness, the voice run again on kept inputs (voicetest), her deciding run again on kept requests (replay), and the
// prompts page (scripts/prompts.mjs in a child process). Holds no state of its own beyond the replay recorder.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { homedir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { effortFor, outcomeText, statusLine as llmGateLine } from '../llm-gate.js';
import { callModel, modelOf } from '../llm-call.js';
import { drift } from '../integrity.js';
import { KINDS } from './gates.js';
import { createRecorder, replay as replayKept } from './replay.js';

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const answers = (url) => new Promise((r) => {
  const q = httpGet(url, { agent: false, timeout: 1000 }, (res) => { res.resume(); r(res.statusCode === 200); });
  q.on('error', () => r(false)).on('timeout', () => q.destroy());
});
/**
 * /dot prompts: scripts/prompts.mjs in a child process (it rewrites process.env.DSH_HOME and the
 * prompt home when imported, which must not happen inside the dsh host). Same <home> as hers.
 */
export function promptsPage({ home, port, timeoutMs = 20000 }) {
  const url = `http://127.0.0.1:${port}/`;
  const log = join(dshHome(), 'dsh-dot-prompts.log');
  let child = null, starting = null;
  async function start() {
    if (child && child.exitCode === null) return url;
    mkdirSync(dshHome(), { recursive: true });
    try { if (statSync(log).size > 1_000_000) rmSync(log, { force: true }); } catch {}
    const fd = openSync(log, 'a');
    let failed = '';
    try {
      // dsh may be Electron: ELECTRON_RUN_AS_NODE makes its executable a plain Node.
      child = spawn(process.execPath, [join(PACKAGE_ROOT, 'scripts', 'prompts.mjs')], {
        cwd: PACKAGE_ROOT, stdio: ['ignore', fd, fd, 'ipc'], windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_DOT_HOME: home, PORT: String(port) },
      });
    } finally { closeSync(fd); }
    const c = child;
    c.unref(); c.channel?.unref(); // the channel only lets the page know when dsh is gone (see prompts.mjs)
    c.on('error', (err) => { failed = err.message; });
    c.on('exit', (code, sig) => { failed ||= `exited (${sig ?? code})`; if (child === c) child = null; });
    for (const until = Date.now() + timeoutMs; Date.now() < until && !failed;) {
      if (await answers(url)) return url;
      await new Promise((r) => setTimeout(r, 200));
    }
    stop();
    throw new Error(`${failed || `no answer within ${timeoutMs / 1000} s`} — log: ${log}`);
  }
  function stop() {
    const c = child; child = null;
    if (!c || c.exitCode !== null) return Promise.resolve(false);
    return new Promise((r) => { c.once('exit', () => r(true)); c.kill(); });
  }
  return {
    url,
    start: () => (starting ??= start().finally(() => { starting = null; })),
    stop,
  };
}

/**
 * @param dot  the plugin's parts (core.js apply): ctx, cfg, audit, logger, im, home, phone, computer, sessions, turns,
 *             arrive; read when used: hands, consent, checkup, budget, llmGate
 * → { voicetest, replayObserver, replay, statusLiveness, statusText }
 */
export function createStatus(dot) {
  const { ctx, cfg, audit, logger, im, home, phone, computer, sessions, turns, arrive } = dot;
  const { retired, isDotSession, imSessions } = sessions;
  const { turnInfo } = turns;
  // The voice, run again on inputs kept in a file: what it says of the same facts, several times over — how often it
  // says more than the facts do is measured this way, not guessed from one message (11-24: "发了" of a thing just
  // begun). The file: { times, cases: [{ name, text }] }; what came back is written beside it (.out.json). Nothing is sent.
  async function voicetest(file) {
    const f = isAbsolute(file) ? file : join(dshHome(), 'dot-replay', file);
    const spec = JSON.parse(readFileSync(f, 'utf8'));
    const system = String(ctx.get('dshInterlude')?.cardText?.() ?? '').trim();
    const { sel, llm } = modelOf(ctx);
    if (!system || !sel || !llm) return 'no card or no model';
    const effort = cfg.sayEffort ? (await effortFor(ctx, sel, cfg.sayEffort)).effort : sel.reasoningEffort;
    const out = [];
    for (const k of spec.cases ?? []) {
      const said = await Promise.all(Array.from({ length: Math.min(20, spec.times ?? 5) }, async () => {
        const r = await callModel(ctx, { effort: k.effort || cfg.sayEffort || undefined, system: k.system || system, maxTokens: k.effort ? 4000 : cfg.sayMaxTokens, messages: [createUserMessage({ content: [{ type: 'text', text: k.text }], source: { kind: 'dsh-dot', form: 'say-test' } })] });
        return r.ok ? r.text : `!! ${outcomeText(r.outcome)}${r.text ? `｜${r.text}` : ''}`; // cut short or nothing back is measured as that
      }));
      out.push({ name: k.name, said });
    }
    writeFileSync(`${f}.out.json`, `${JSON.stringify({ at: Date.now(), model: `${sel.provider}/${sel.model}`, effort: effort ?? '', out }, null, 1)}\n`);
    audit('voicetest', { file: f, cases: out.length });
    return `${out.length} case(s) → ${f}.out.json`;
  }
  const replayDir = join(dshHome(), 'dot-replay', 'decide');
  /** The llm/stream observer that keeps her conversation's requests (only made with replayKeep > 0). */
  const replayObserver = () => {
    const herStep = (id) => { const s = ctx.get('agents')?.get?.(id)?.session; return !retired(id) && !dot.hands?.isHands(id, s?.header?.cwd) && (id === sessions.last() || isDotSession(id, s?.header?.cwd)); };
    const recorder = createRecorder({ dir: replayDir, keep: cfg.replayKeep, hers: herStep, audit, logger });
    return (options, next) => { recorder.observe(options); return next(); };
  };
  const replay = (file, times) => replayKept({ dir: replayDir, base: join(dshHome(), 'dot-replay'), file, times, llm: ctx.get('llm'), sel: ctx.get('agentDefaultModel')?.currentSelection?.(), audit });

  // /dot: what is waiting and what is stuck, one line each.
  const mins = (ms) => `${Math.floor(ms / 60000)} min`;
  const statusLiveness = (now = Date.now()) => {
    const who = (id) => `${retired(id) ? 'retired' : id === sessions.last() ? 'her conversation' : 'session'} ${id.slice(0, 16)}`;
    const out = [...dot.consent.asking().map((a) => `waiting for his yes: ${a.what} · ${mins(now - a.at)}`), ...dot.consent.standing().map((g) => `his standing yes: ${KINDS[g.kind] ?? g.kind}${g.subject ? ` (${g.subject})` : ''} · 「${g.words}」`)];
    for (const id of turns.keys()) {
      const t = turnInfo(id, now);
      if (t && t.state === 'stalled') out.push(`stalled turn: ${who(id)} · no event for ${mins(t.idleMs)} · last: ${t.doing} · not cancelled`);
    }
    const d = drift();
    if (d) out.push(`plugin files changed on disk since dsh started: running ${d.loaded || '?'}, on disk ${d.disk || '?'}, ${d.missing.length} prompt file(s) gone · quit dsh and open it again`);
    if (turns.lastFailure() && now - turns.lastFailure().at < 3600000) out.push(`last failed turn: ${who(turns.lastFailure().session)} · ${mins(now - turns.lastFailure().at)} ago · ${turns.lastFailure().lost ? 'his words were not taken · ' : ''}${turns.lastFailure().error}`);
    return out.length ? out : [`liveness: nothing waits for his yes, no stalled or failed turn (stalled after ${mins(cfg.turnStallMs)})`];
  };

  // /dot (command.js): the command's surface; what it reports of her state is said here.
  const statusText = async (arg) => {
    const t = await im.target();
    let test = '';
    if (arg === 'test') test = `\ntest message: ${(await im.send('👋 dot 测试消息：IM 通道正常。', 'plain')) ? 'sent' : 'FAILED'}`;
    const vm = computer()?.status?.();
    const ph = phone()?.status?.();
    const lines = [
      `computer: ${vm ? `${vm.state}${vm.publicLiveViewUrl ? ` · ${vm.publicLiveViewUrl}` : ''}` : 'not installed (optional)'} · phone: ${ph ? `${ph.state}${ph.error ? ` (${ph.error})` : ''}` : 'not installed (optional)'}`,
      `IM: ${t.error ? `not ready (${t.error})` : `${t.name ?? t.target} via ${t.bot}`}`,
      ...(dot.checkup.last() && (dot.checkup.last().bad || dot.checkup.last().warn) ? [`doctor: ${dot.checkup.last().bad} problem(s), ${dot.checkup.last().warn} warning(s) — /dot doctor`] : []),
      `scope: ${cfg.scope} · home: ${home} · im sessions seen: ${imSessions.size}`,
      // Where his next message goes: when she "does not answer", look here first.
      `her conversation: ${sessions.last() ? `${sessions.last()}${turns.has(sessions.last()) ? ' (in a turn)' : ''}` : '(none yet: his first words or her own time open one)'}`,
      `his messages: wait ${cfg.ownerQuietMs} ms of quiet, at most ${cfg.ownerMaxWaitMs} ms (${cfg.ownerTypingMaxMs} ms while typing) · mid-turn: steered · her words give way to his unread ones ≤${cfg.ownerPreemptMax}× in a row${arrive.ownerPending() ? ` · ${arrive.ownerPending()} waiting` : ''}`,
      ...statusLiveness(),
      `budget: ${ctx.get('budget') ? (dot.budget.blocked().length ? `BLOCKED (${dot.budget.blocked().join(', ')})` : 'ok') : 'not installed (optional)'}`,
      (() => { try { return llmGateLine(dot.llmGate?.status()); } catch (err) { return `model requests: ${err.message}`; } })(),
      `schedule: ${ctx.get('schedule') ? 'ok' : 'not installed'}`,
    ];
    return lines.join('\n') + test;
  };
  return { voicetest, replayObserver, replay, statusLiveness, statusText };
}

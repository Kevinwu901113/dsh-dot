// dsh-dot/hands-wiring: her hands (hands.js) wired into the host (taken out of core.js as it was).
// Holds: the hands themselves (made by makeHands, also set on dot.hands), the know-how book (howto.js) and what is
// learned from it (reflections, the night's check), the calls waiting for his yes (askedCalls), the phone's way back to
// its home screen. What is counted per thing — the same error, the same screen, when her hands last did something,
// whether a step that reaches someone was let through — is kept on the thing itself (hands.keptOf) and goes with it.
// Every hook of a hands session asks for that session's thing (hands.thingOf), never for "the" thing. Its hooks:
// approval/request, tools/post-execute, the device sections of system-prompt/assemble, and the gates of tools/pre-execute.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { deny } from '../refusals.js';
import { HANDS_ASK_TOOL, HANDS_DONE_TOOL, SAY_TOOL, PHONE_TOOL_PREFIX, PHONE_TYPE_TOOL, VM_TOOL_PREFIX, isHerTool, HANDS_PRESETS, handsPlaceOf, HANDS_WAIT_TOOL, PHONE_LOOK_TOOLS } from '../tool-prefixes.js';
import { VM_SCREENSHOT } from '../qq/qq.js';
import { batchLaunch, createHowto, errorType, howtoTool, isRefusal, placeName } from './howto.js';
import { HANDS_SOURCE, createHands } from './hands.js';
import { checkInput, checkTool, settle as settleCheck, report as checkReport, hashOf } from './nightcheck.js';
import { approvalKind, classify, classifyComputer, classifyHost, HIM_KINDS } from './gates.js';
import { REACHES } from './consent.js';
import { KNOWN_APPS, collectReply } from '../interlude/core.js';
import { background, workEffort } from '../llm-gate.js';
import { prompt } from '../prompts.js';
import { stamp } from '../clock.js';
import { head } from '../cut.js';
import { screenLines } from '../phone/typing.js';
import { costOf, sameName } from './things.js';
import { shortTool } from './turns.js';
import { handsStatus, ownWords, replyCheckText, spokenOf, isOwnerTarget, ownerUnread, loopKey, conversationTitle, contentText, ownerInterruptText } from './text.js';

/** Calls that look or scroll: the same call again is how one reads a changing screen, not a loop. */
export const LOOP_EXEMPT = /(?:mobile_list_elements_on_screen|mobile_take_screenshot|mobile_get_screen_size|mobile_get_orientation|mobile_list_apps|mobile_list_available_devices|mobile_swipe_on_screen|mobile_press_button|browser_snapshot|browser_take_screenshot|browser_scroll|screenshot)$/;
const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');

/**
 * @param dot  the plugin's parts (core.js apply): ctx, cfg, audit, logger, store, phone, computer, home, sessions,
 *             turns, voice, arrive; read when used: ledger, consent, sleep (stir)
 * → { hands(), makeHands, howto, onApproval, onPostExecute, assemble, nightcheck, nightly, disposePhoneHome,
 *     cancelPhoneHome, restartCut, handsPlace, handsOf, askTool, waitTool, doneTool, preExecute }
 */
export function createHandsWiring(dot) {
  const { ctx, cfg, audit, logger, store, phone, computer, home, sessions, turns, voice, arrive } = dot;
  const { isDotSession, retired, thinkAt, resolveLive, noteToConversation } = sessions;
  let hands = null; // her hands (hands.js), set once sessions can be made
  const askedCalls = new Map(); // callId → what of it needs his yes: its tool result says so (tools/post-execute)

  // 2. What of hers needs him (gates.js): nothing waits on a button. A request the host or a plugin gates in her
  // sessions is let through when his yes covers it (consent.js), and otherwise refused at once: in her hands' session
  // the thing ends there as a question for him; in her conversation she is told to ask him first.
  const hers = (agent) => { const s = agent?.session; return Boolean(s?.id) && (isDotSession(s.id, s.header?.cwd) || retired(s.id) || turns.has(s.id) || Boolean(hands?.isHands(s.id, s.header?.cwd))); };
  const onApproval = async (req, next) => {
    if (!hers(req.agent)) return next();
    const s = req.agent.session;
    const k = approvalKind(req.toolName, req.reason);
    const theirs = Boolean(hands?.isHands(s.id, s.header?.cwd));
    const thing = theirs ? hands.thingOf(s.id)?.id ?? '' : '';
    if (dot.consent.allows({ kind: k.kind, subject: k.subject, thing })) { audit('consent-used', { session: s.id, kind: k.kind, thing }); return 'approved'; }
    if (theirs) hands.ask(prompt('dot.gates.ask.q', { what: k.what }), { for: 'him', kind: k.kind, subject: k.subject, tier: 'ask', what: k.what }, { session: s.id });
    else dot.consent.ask(k);
    if (req.callId !== undefined) askedCalls.set(req.callId, { what: k.what, theirs });
    audit('consent-asked', { session: s.id, kind: k.kind, tool: req.toolName, thing });
    return 'rejected';
  };
  // dsh words a refusal as "the user rejected tool …": one that waits for his yes says so instead.
  const onPostExecute = async (exec, result, next) => {
    // Typed into her phone's QQ (a chat there, not its search or sign-in): said, as much as a qq_send is. The QQ on her
    // computer does not report what her account sends from elsewhere, so it is recorded here, where the words go in.
    if (exec?.name === PHONE_TYPE_TOOL && !result?.isError) {
      try {
        const fg = String((await phone()?.foreground?.()) ?? '');
        const text = String((exec.input ?? exec.args ?? exec.arguments)?.text ?? '').trim();
        if (text && /^com\.tencent\.mobileqq\//i.test(fg) && !/search|login|register|verify/i.test(fg)) { ctx.get('dotMemory')?.herSaid?.({ session: sessions.last(), text, to: '手机QQ' }); audit('said-on-phone', { chars: text.length }); }
      } catch (err) { logger.debug?.(`phone words not recorded: ${err.message}`); }
    }
    const asked = askedCalls.get(exec?.callId);
    const notes = [cfg.howto && exec?.name ? await howtoFor(exec, result) : null, exec?.name ? sameErrorFor(exec, result) : null, exec?.name ? sameScreenFor(exec, result) : null].filter(Boolean);
    const note = notes.join('\n\n');
    if (asked === undefined && !note) return next();
    if (asked !== undefined) askedCalls.delete(exec.callId);
    const d = await next();
    const contexts = [...(d?.additionalContexts ?? []), ...(note ? [createUserMessage({ content: [{ type: 'text', text: note }], source: { kind: 'dsh-dot', form: 'manual' } })] : [])];
    const out = asked !== undefined ? { kind: 'block', feedback: [{ type: 'text', text: prompt(asked.theirs ? 'dot.gates.ask' : 'dot.gates.asked.her', { what: asked.what }) }] } : { ...d };
    if (contexts.length) out.additionalContexts = contexts; else delete out.additionalContexts;
    return out;
  };

  // The know-how book (howto.js): every device call her hands make while a thing runs is a step of that thing, in
  // the place it happened; the first time they are in a place in that thing, its notes come along (in the
  // post-execute hook above). The thing's end (hands onDone, below) logs it and picks what is worth learning from.
  const appLabels = { ...Object.fromEntries(Object.entries(KNOWN_APPS.labels).map(([label, pkg]) => [pkg, label])), 'com.tencent.mobileqq': 'QQ', 'com.tencent.mm': '微信' };
  // The phone itself: the home screen, settings, the shade, the keyboard, the system's own dialogs.
  const SYSTEM = /launcher|\.home$|^com\.android\.(systemui|settings|packageinstaller|permissioncontroller|documentsui|intentresolver)$|^com\.google\.android\.(permissioncontroller|packageinstaller|documentsui|inputmethod\..*)$|inputmethod|keyboard/i;
  const labelOf = (pkg) => (!pkg || SYSTEM.test(pkg) ? 'phone' : appLabels[pkg] ?? pkg);
  const howto = createHowto({ dir: join(home, 'her', 'howto'), minSteps: cfg.howtoMinSteps, maxChars: cfg.howtoMaxChars });
  const howtoFor = async (exec, result) => {
    const onPhone = exec.name.startsWith(PHONE_TOOL_PREFIX) || exec.name === PHONE_TYPE_TOOL;
    if (!onPhone && !exec.name.startsWith(VM_TOOL_PREFIX)) return null;
    const s = exec.agent?.session;
    if (!s?.id || !hands?.thingOf(s.id)) return null; // a late result of a thing that is over
    const input = exec.arguments ?? exec.input;
    let app = 'computer';
    if (onPhone) {
      // The app this call happened in: the one in front after it (a launch, inside a batch too, says so directly).
      let pkg = input?.packageName ?? batchLaunch(input);
      try { pkg = String((await phone()?.foreground?.()) ?? '').split('/')[0] || pkg; } catch (error) { void error; }
      app = labelOf(pkg);
    }
    howto.step(s.id, app, exec.name, input, { isError: Boolean(result?.isError), error: contentText(result?.content ?? []) });
    const given = [];
    for (const place of onPhone && app !== 'phone' ? ['phone', app] : [app]) {
      if (howto.needsReview(place)) { void reflectHowto({ review: true, app: place }); continue; }
      const got = howto.take(s.id, place);
      if (!got) continue;
      audit('howto-given', { session: s.id, app: place });
      given.push(prompt('dot.howto.given', { app: placeName(place), notes: got.notes, recent: got.recent || '—' }).trim());
    }
    return given.join('\n\n') || null;
  };
  // The same error over and over (11-22: nine tries at a page the browser could not reach): counted by code, per thing,
  // by its type (addresses left out); anything that goes through, or a refusal of ours, starts the count again. At
  // sameErrorNudge the hands are told to change course or end it as not reached; at sameErrorStop the code ends it.
  // The count is kept on the thing (hands.keptOf(id).errorRun: { type, n }).
  const sameErrorFor = (exec, result) => {
    const sid = exec.agent?.session?.id, t = sid ? hands?.thingOf(sid) : null;
    if (!t || exec.name === HANDS_DONE_TOOL || exec.name === HANDS_ASK_TOOL) return null;
    const kept = hands.keptOf(t.id);
    const raw = result?.isError ? contentText(result?.content ?? []) || String(result?.error?.message ?? result?.error ?? '') : '';
    const type = raw && !isRefusal(raw) ? errorType(raw) : '';
    if (!type) { delete kept.errorRun; return null; }
    const before = kept.errorRun, run = { type, n: before?.type === type ? before.n + 1 : 1 };
    kept.errorRun = run;
    if (cfg.sameErrorStop > 0 && run.n >= cfg.sameErrorStop) {
      delete kept.errorRun;
      audit('same-error-stop', { session: sid, thing: t.id, n: run.n, error: type });
      hands.fail({ cause: 'same-error', error: type }, { session: sid });
      return null;
    }
    if (cfg.sameErrorNudge > 0 && run.n === cfg.sameErrorNudge) {
      audit('same-error-nudge', { session: sid, thing: t.id, n: run.n, error: type });
      return prompt('dot.hands.same-error', { n: run.n, error: type, max: Math.max(1, cfg.sameErrorStop - run.n) });
    }
    return null;
  };
  // Looking again at a screen that has not changed (11-23: 24 of a thing's 39 steps were looks, waiting for a text
  // message to be answered): counted by code, per thing. A look that shows what the look before it showed, with no
  // action in between, is told so — to wait with wait_for, or to end the thing if what it waits for is someone's answer.
  // Kept on the thing (hands.keptOf(id)): lookRun { seen: { tool: text }, n }, and actedAt — when its hands last did
  // something (its wait_for counts notifications from then on).
  const sameScreenFor = (exec, result) => {
    const sid = exec.agent?.session?.id, t = sid ? hands?.thingOf(sid) : null;
    if (!t) return null;
    const kept = hands.keptOf(t.id);
    const name = shortTool(exec.name);
    if (!PHONE_LOOK_TOOLS.includes(name) || name === 'phone_zoom') { if (exec.name !== HANDS_WAIT_TOOL) kept.actedAt = Date.now(); delete kept.lookRun; return null; }
    const text = result?.isError ? '' : contentText(result?.content ?? []);
    const run = kept.lookRun ?? { seen: {}, n: 0 };
    run.n = text && run.seen[name] === text ? run.n + 1 : 0;
    run.seen[name] = text;
    kept.lookRun = run;
    if (run.n < 1) return null;
    audit('same-screen', { session: sid, thing: t.id, tool: name, n: run.n + 1 });
    return prompt('dot.hands.same-screen', { n: run.n + 1 });
  };
  /** The thing in her hands is over: its steps go into the book, with what the ledger has of it. */
  const learnFrom = (job) => {
    if (!cfg.howto || !job?.session) return;
    const e = dot.ledger.get(job.id);
    for (const r of howto.end(job.session, { thing: job.id, task: job.task, name: e?.name ?? '', outcome: e?.outcome ?? '', ms: (e?.endedAt ?? Date.now()) - (e?.startedAt ?? e?.openedAt ?? Date.now()), tokens: costOf(e) })) reflectHowto(r);
  };
  // One small call per run worth learning from: what she did (her calls and short error types, not the
  // screen's text), her notes for the app, her last runs → the notes rewritten. One app at a time:
  // a second run of the same app waits for the first reflection and reads the notes it wrote.
  const reflecting = new Map(); // app → the promise of its last reflection
  function reflectHowto(r) {
    const prev = reflecting.get(r.app) ?? Promise.resolve();
    const p = prev.then(() => reflectOnce(r)).finally(() => { if (reflecting.get(r.app) === p) reflecting.delete(r.app); });
    reflecting.set(r.app, p);
    return p;
  }
  async function reflectOnce(r) {
    let seen = null; // what the call gave back, for the audit when it cannot be read
    try {
      if (r.review && !howto.needsReview(r.app)) return; // read over meanwhile
      // Not injected into dsh-dot (it would wait on them): taken when needed.
      const sel = ctx.get('agentDefaultModel')?.currentSelection?.();
      const llm = ctx.get('llm');
      if (!sel || !llm?.stream) return;
      const effort = await workEffort(ctx, sel);
      const reply = await collectReply(llm.stream(background({
        provider: sel.provider, model: sel.model, ...(effort ? { reasoningEffort: effort } : {}),
        system: prompt(r.review ? 'dot.howto.review' : 'dot.howto.reflect', { maxChars: cfg.howtoMaxChars }), tools: [howtoTool()], maxTokens: 12000, // thinking counts too: cut short, the notes came back as half a JSON (howto-failed, "Unexpected end of JSON input")
        messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify(howto.input(r), null, 1) }], source: { kind: 'dsh-dot', form: 'howto' } })],
      })));
      seen = { text: String(reply.text ?? ''), args: String(reply.args ?? '') };
      const out = JSON.parse(reply.args || reply.text.slice(reply.text.indexOf('{'), reply.text.lastIndexOf('}') + 1));
      if (r.review) { if (howto.keep(r.app, { notes: out.notes })) audit('howto-reviewed', { app: r.app }); return; }
      if (howto.keep(r.app, out, r.id)) audit('howto-learned', { app: r.app, steps: r.steps, errors: r.errors.length, outcome: r.outcome, ...(out.task ? { task: String(out.task).slice(0, 12) } : {}) });
    } catch (error) { logger.warn(`howto reflection (${r.app}) failed: ${error.message}`); audit('howto-failed', { app: r.app, error: String(error.message).slice(0, 200), ...(seen ? { chars: seen.text.length, args: seen.args.length } : {}) }); }
  }
  // Her notes held against the records (nightcheck.js). The check writes what it would do to a file and changes
  // nothing; applying is asked for separately, and only where the notes are still the ones that were checked.
  const nightFile = () => join(howto.dir, '_nightcheck.json');
  async function nightcheck({ apply = false } = {}) {
    if (apply) {
      let last = null;
      try { last = JSON.parse(readFileSync(nightFile(), 'utf8')); } catch (error) { void error; }
      if (!last?.places?.length) return '还没有核对过：先 /dot nightcheck';
      const done = [];
      for (const p of last.places) {
        if (!p.changed) continue;
        if (hashOf(howto.notes(p.app)) !== p.hash) { done.push(`${p.app}：笔记在核对之后变过，没动（再核对一次）`); continue; }
        howto.amend(p.app, p.notes);
        audit('nightcheck-applied', { app: p.app, ops: p.ops.length });
        done.push(`${p.app}：改了 ${p.ops.length} 条`);
      }
      return done.length ? done.join('\n') : '上次核对没有要改的';
    }
    const sel = ctx.get('agentDefaultModel')?.currentSelection?.();
    const llm = ctx.get('llm');
    const places = [], said = [];
    for (const app of howto.apps()) {
      const notes = howto.notes(app);
      if (!notes || app.startsWith('_')) continue; // files of the book's own keeping are not places
      const records = howto.records(app), input = checkInput({ place: placeName(app), notes, records });
      let judged = [], failed = '', seen = null; // seen: what the call gave back, said when it cannot be read
      if (input.lessons.length && sel && llm?.stream) {
        try {
          const effort = await workEffort(ctx, sel);
          const reply = await collectReply(llm.stream(background({
            provider: sel.provider, model: sel.model, ...(effort ? { reasoningEffort: effort } : {}),
            system: prompt('dot.howto.nightcheck'), tools: [checkTool()], maxTokens: 12000, // what it thinks counts too: at 4000 the answer for a place with eight lessons was cut mid-JSON
            messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify(input, null, 1) }], source: { kind: 'dsh-dot', form: 'nightcheck' } })],
          })));
          seen = { finish: reply.finish?.kind ?? '', text: String(reply.text ?? '').length, args: String(reply.args ?? '').length, out: reply.usage?.outputTokens ?? 0 };
          const out = JSON.parse(reply.args || reply.text.slice(reply.text.indexOf('{'), reply.text.lastIndexOf('}') + 1));
          judged = Array.isArray(out?.lines) ? out.lines : [];
        } catch (error) { failed = `${String(error.message).slice(0, 120)}${seen ? `（finish ${seen.finish || '?'}，正文 ${seen.text} 字，参数 ${seen.args} 字，输出 ${seen.out} token）` : ''}`; }
      }
      const r = settleCheck({ notes, judged, records });
      places.push({ app, hash: hashOf(notes), changed: r.changed, ops: r.ops, notes: r.notes, ...(failed ? { failed } : {}) });
      audit('nightcheck', { app, lessons: input.lessons.length, records: records.length, judged: judged.length, reword: r.ops.filter((o) => o.op === 'reword').length, drop: r.ops.filter((o) => o.op === 'drop').length, unsupported: r.unsupported, ...(failed ? { failed } : {}) });
      said.push(checkReport(app, r) + (failed ? `\n  （这一处的教训没判成：${failed}）` : ''));
    }
    try { writeFileSync(nightFile(), `${JSON.stringify({ at: Date.now(), places }, null, 1)}\n`); } catch (error) { logger.warn(`nightcheck not written: ${error.message}`); }
    return places.length ? `${said.join('\n')}\n\n什么都还没改：这是会做的改动，记在 ${nightFile()}。要照着改：/dot nightcheck apply` : '手艺簿里还没有笔记';
  }
  // Each night, once she is asleep: checked, then amended where the check would change something. What was there
  // before stays in the check's file (each op carries the line as it was), and every change is in the audit log.
  const nightly = () => {
    if (!cfg.nightcheck) return;
    void (async () => { try { await nightcheck(); const done = await nightcheck({ apply: true }); audit('nightcheck-night', { done: String(done).slice(0, 300) }); } catch (error) { logger.warn(`nightcheck failed: ${error.message}`); audit('nightcheck-failed', { error: String(error.message).slice(0, 200) }); } })();
  };
  // system-prompt/assemble: device instructions go to the hands.
  const assemble = async (_a, c, next) => {
    const assembly = await next();
    // Her conversation when her hands hold the device tools: the tools' own instructions (the MCP servers')
    // are for whoever presses the screen. The phone says what it is to her itself (phone:device); the computer gets one line.
    let held = true;
    try { held = !ctx.get('dshDotCompat')?.hiddenFor?.('dot', [`${VM_TOOL_PREFIX}browser_click`])?.length; } catch { /* no compat */ }
    if (held || !turns.inHome(c) || hands?.isHands(c.agent?.session?.id, c.agent?.session?.header?.cwd)) return assembly;
    const sections = assembly.sections.flatMap((sec) => (sec.name === 'mcp:dot-phone' ? [] : sec.name === 'mcp:dot-vm' ? (String(sec.text ?? '').trim() ? [{ ...sec, text: prompt('dot.computer.hers').trim() }] : []) : [sec]));
    return { ...assembly, sections };
  };

  // Her hands (hands.js): their own session, outside her home, with the device tools and nothing else of hers.
  const handsAgent = async (id) => {
    try {
      const live = ctx.get('agents')?.get?.(id);
      const found = typeof live?.followup === 'function' ? { agent: live } : await ctx.get('sessionController')?.resolveAgent(id);
      if (!found || 'error' in found) return null;
      await thinkAt(found.agent, cfg.handsEffort);
      return found.agent;
    } catch (error) { void error; return null; }
  };
  // Her phone, put down: a while after her last step on it, it is back on its home screen — an app left open in front
  // shows no notifications, and whether she is "done" is not something she has to say (she used to spend a whole
  // round of her hands on pressing HOME after everything she did). Like a screen that locks itself; a new step on the
  // phone before that keeps it where it is. The app is not closed: opened again, it is on the page it was left on.
  let phoneHomeTimer = null;
  const armPhoneHome = (afterMs = cfg.phoneHomeAfterMs) => {
    clearTimeout(phoneHomeTimer); phoneHomeTimer = null;
    if (!(cfg.phoneHomeAfterMs > 0)) return;
    phoneHomeTimer = setTimeout(() => {
      phoneHomeTimer = null;
      if (hands?.busy() || !phone()?.isReady) return;
      Promise.resolve(phone().adbExec?.(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])).then(() => audit('phone-home', { afterMs })).catch((err) => logger.debug?.(`phone home: ${err.message}`));
    }, afterMs);
    phoneHomeTimer.unref?.();
  };
  const disposePhoneHome = () => clearTimeout(phoneHomeTimer);
  /** A thing given on the phone: it stays where it is (the hands tool). */
  const cancelPhoneHome = () => { clearTimeout(phoneHomeTimer); phoneHomeTimer = null; };
  // Which place a session of her hands is for is written on the session itself: the preset it was made with (dsh keeps
  // it as header.agentPreset from the start), one a place, carrying only that place's host tools (tool-prefixes.js
  // HANDS_PRESETS). A thing on this machine itself (device 'host') is also done from its own folder under the hands': a
  // command is routed by the folder it comes from (computer/subprocess.js), and that folder says "here, not in her
  // computer" — by the folder alone it is known as 'host' too. Anything else is not known: '' (compat: no device tools).
  const handsHostDir = resolve(join(dshHome(), 'dsh-dot-hands', 'host'));
  const atHandsHost = (cwd) => { if (!cwd) return false; const p = resolve(String(cwd)); return p === handsHostDir || p.startsWith(handsHostDir + sep); };
  const handsPlace = (cwd, preset) => (atHandsHost(cwd) ? 'host' : handsPlaceOf(preset));
  /** Make her hands (once the ledger and consent are there): → the hands, also set on dot.hands. */
  const makeHands = () => {
    hands = dot.hands = createHands({
      dir: join(dshHome(), 'dsh-dot-hands'),
      create: async (dir, device = '') => {
        const cwd = device === 'host' ? handsHostDir : dir;
        if (device === 'host') { try { mkdirSync(cwd, { recursive: true }); } catch (error) { void error; } }
        const controller = ctx.get('sessionController');
        const agentPreset = HANDS_PRESETS[device];
        if (!controller || !agentPreset) return '';
        // Only with the place's own preset. A host that refuses it gets no session: made without one, the session would
        // have the host's whole default surface (11-24: a thing given to look something up had a shell).
        let made = null;
        try { made = await controller.create({ cwd, agentPreset }); } catch (err) { audit('hands-preset-refused', { preset: agentPreset, why: String(err?.message ?? err).slice(0, 200) }); logger.warn(`hands session not created: ${err.message}`); return ''; }
        const { sessionId } = made ?? {};
        try { await controller.rename?.({ sessionId, title: 'dot · 手' }); } catch (error) { void error; }
        return sessionId ?? '';
      },
      agentFor: handsAgent,
      onEvent: (fn) => ctx.on('session/event', fn),
      message: (text) => createUserMessage({ content: [{ type: 'text', text }], source: HANDS_SOURCE }),
      textOf: contentText,
      store, ledger: dot.ledger,
      done: () => prompt('dot.hands.done-missing'),
      overCap: (e) => (cfg.thingCostCap > 0 && costOf(e) > cfg.thingCostCap && !dot.consent.allows({ kind: 'spend', thing: e.id }) ? prompt('dot.gates.spend.q', { tokens: Math.round(costOf(e) / 1000) }) : ''),
      // A session her hands are done with is put away: one per thing, so they pile up otherwise.
      retire: async (id) => { try { await ctx.get('workspaceRegistry')?.archiveSession?.(id); } catch (err) { logger.debug?.(`hands session not archived: ${err.message}`); } },
      audit, maxMs: cfg.handsMaxMs,
      // The thing is over, or her hands need her: what they said, and the screen as it is now for her own eyes, come
      // to her conversation and wake her. Nothing else of theirs does. What she makes of it — and whether he hears of
      // it — is hers: on his business the message says whose it is, and she tells him with qq_send.
      // A thing stopped on someone's word wakes nobody: whoever said stop knows, and the ledger has how far it got.
      onDone: (r, job) => {
        learnFrom(job);
        if (job.device === 'phone') armPhoneHome(r.outcome === 'stuck' ? cfg.handsStuckHoldMs : cfg.phoneHomeAfterMs);
        if (r.outcome !== 'stopped') return handsBack(r, job);
        audit('hands-result', { thing: job.id, status: 'stopped', forHim: Boolean(job.forHim), steps: r.steps, rounds: r.rounds, woke: false });
        // He stopped it from outside her conversation (/dot stop): she finds a line about it the next time she is up, no more.
        if (r.cause === 'command') void noteToConversation('hands-stopped', `${prompt('dot.hands.result', { stamp: stamp(Date.now(), Date.now()), task: job.task, status: handsStatus(r, job.device), text: resultText(r) }).trim()}`);
        return undefined;
      },
    });
    return hands;
  };
  /** What came of a thing, for her: the hands' summary, then their details. */
  const resultText = (r) => [r.summary, r.detail].map((x) => String(x ?? '').trim()).filter(Boolean).join('\n') || '（没说什么）';
  async function handsBack(r, job) {
    dot.sleep.stir();
    try {
      await arrive.moved(); // her conversation is being handed over: it goes to the new one
      const found = sessions.last() && await resolveLive(sessions.last());
      if (!found || 'error' in found) { audit('hands-result-dropped', { why: 'no conversation' }); return; }
      const lead = r.question && r.ask?.for === 'him'
        ? prompt('dot.hands.ask.him', { stamp: stamp(Date.now(), Date.now()), task: job.task, question: r.question, text: r.detail && r.detail !== r.question ? r.detail : '' })
        : r.question
        ? prompt('dot.hands.ask', { stamp: stamp(Date.now(), Date.now()), task: job.task, question: r.question, text: r.detail && r.detail !== r.question ? r.detail : '' })
        : prompt('dot.hands.result', { stamp: stamp(Date.now(), Date.now()), task: job.task, status: handsStatus(r, job.device), text: resultText(r) });
      const owed = job.id ? dot.ledger.get(job.id)?.awaiting : null;
      const owes = !owed?.from ? '' : `\n${prompt(owed.answeredAt ? 'dot.hands.result.answered' : 'dot.hands.result.awaiting', { from: owed.from, text: owed.text ?? '' }).trim()}`;
      const content = [{ type: 'text', text: lead.trim() + owes + (job.forHim && r.ask?.for !== 'him' ? `\n${prompt(r.question ? 'dot.hands.ask.his' : 'dot.hands.result.his').trim()}` : '') }];
      if (r.outcome !== 'failed' && job.device !== 'web' && job.device !== 'host') { // looking something up, or a shell on this machine, leaves no screen to show
        try {
          const images = ctx.get('attachments');
          const png = typeof images?.saveImages !== 'function' ? null : job.device === 'phone' ? (phone()?.isReady ? await phone().screenshot() : null) : await computerScreen();
          if (png?.length && job.id) { try { const dir = join(dshHome(), 'dsh-dot-things'); mkdirSync(dir, { recursive: true }); const shot = join(dir, `${job.id}.png`); writeFileSync(shot, png); dot.ledger.note(job.id, { shot }); const kept = new Set(dot.ledger.recent(100).map((e) => `${e.id}.png`)); for (const f of readdirSync(dir)) if (!kept.has(f)) rmSync(join(dir, f), { force: true }); } catch (err) { logger.debug?.(`thing ${job.id}: screen not kept: ${err.message}`); } }
          if (png?.length) { const [image] = await images.saveImages([{ data: new Uint8Array(png), mediaType: 'image/png', name: `${job.device}-screen` }]); if (image) content.push({ type: 'text', text: prompt(job.device === 'computer' ? 'dot.hands.screen.computer' : 'dot.hands.screen').trim() }, { type: 'image', attachment: image }); }
        } catch (err) { logger.debug?.(`hands: no screenshot: ${err.message}`); }
      }
      found.agent.followup(createUserMessage({ content, source: { kind: 'dsh-dot', form: 'hands-result', ...(job.forHim ? { for: 'him' } : {}), ...(job.id ? { thing: job.id } : {}) } }));
      if (job.id) dot.ledger.note(job.id, { back: Date.now() }); // in front of her; `told` is when he heard it (tellHim)
      audit('hands-result', { thing: job.id, session: sessions.last(), outcome: r.outcome, forHim: Boolean(job.forHim), steps: r.steps, rounds: r.rounds });
    } catch (err) { logger.warn(`hands result not delivered: ${err.message}`); }
  }
  // A thing a restart cut off is told to her once, when her conversation can be reached (an effect: → its disposer).
  const restartCut = () => { const t = setTimeout(() => { for (const cut of hands.interrupted()) void handsBack({ outcome: 'failed', by: 'code', cause: 'restart', steps: 0, rounds: 0 }, { id: cut.id, device: cut.device, task: cut.task, forHim: cut.asker === 'him' }); }, 20000); t.unref?.(); return () => clearTimeout(t); };
  /** A picture of her computer's desktop right now (PNG), or null when the computer has no way to take one. */
  const computerScreen = async () => {
    const sh = computer()?.backend?.rootShell;
    if (typeof sh !== 'function') return null;
    const out = String(await sh([VM_SCREENSHOT, '[ -s $f ] && base64 -w0 $f; rm -f $f'].join('\n'))).trim().split('\n').pop() ?? '';
    return out.length > 100 ? Buffer.from(out, 'base64') : null;
  };

  // Her hands' own tools act on the thing of the session that calls them (exec, the host's second argument). Called
  // with no session (directly, not by the host): on the one under way — there is only one while one is done at a time.
  const callerOf = (exec) => { const sid = exec?.agent?.session?.id; return sid ? { session: sid } : undefined; };
  const thingFor = (which) => (which ? hands.thingOf(which.session) : hands.doing());
  // Her hands' one way of coming back with a question (hands.js): a choice that is hers, words that have to be hers.
  // Said with a tool, so "they need her" is a fact the code has and not something read out of a report.
  const askTool = () => ({
    name: HANDS_ASK_TOOL,
    description: prompt('dot.hands.ask-tool'),
    parameters: { type: 'object', properties: { question: { type: 'string', description: '要定的事，一两句说清；要选的东西一条一条列出来' }, for: { type: 'string', enum: ['her', 'him'], description: 'her：她来定（默认）；him：只有他能做的一步（发到他手机上的验证码、扫码、人脸、付款最后一步）' }, screen: { type: 'boolean', description: '要把现在的屏幕一起给他看（比如二维码）' } }, required: ['question'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: prompt(v?.status === 'asked' ? 'dot.hands.asked' : 'dot.hands.idle') }] },
    async execute(args, exec) { return { status: hands.ask(args?.question, { for: args?.for, kind: args?.for === 'him' ? (/验证码|校验码|动态码/.test(String(args?.question ?? '')) ? 'code' : 'him') : undefined, screen: args?.screen }, callerOf(exec)) ? 'asked' : 'idle' }; },
  });
  // Her hands' one way of waiting (11-23): what they wait for is said as a condition the code can see — words that
  // come onto the screen, words that leave it, a notification — with a limit. The code looks; they pay one step,
  // and get the screen as it is when the wait ends. Someone's answer (a reply, a receipt) is not waited for here:
  // it reaches her as a notification, whenever it comes.
  const waitTool = () => ({
    name: HANDS_WAIT_TOOL,
    description: prompt('dot.hands.wait-tool', { max: Math.round(cfg.waitMaxMs / 1000) }),
    parameters: { type: 'object', properties: { text: { type: 'string', description: '等屏幕上出现这几个字' }, gone: { type: 'string', description: '等屏幕上这几个字消失（"加载中""下载中"）' }, notification: { type: 'string', description: '等一条通知：填 App 名、标题或内容里的几个字' }, seconds: { type: 'number', description: '最多等多少秒；只填它就是单纯等这么久' } }, additionalProperties: false },
    output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v?.status === 'idle' ? prompt('dot.hands.idle') : prompt(v?.status === 'met' ? 'dot.hands.wait.met' : v?.status === 'waited' ? 'dot.hands.wait.waited' : 'dot.hands.wait.timeout', { what: v?.what ?? '', seconds: v?.seconds ?? 0, screen: v?.screen || '（屏幕上的字读不出来）' }) }] },
    async execute(args, exec) {
      const mine = thingFor(callerOf(exec));
      if (!mine) return { status: 'idle' };
      const want = { text: String(args?.text ?? '').trim(), gone: String(args?.gone ?? '').trim(), note: String(args?.notification ?? '').trim() };
      const any = Boolean(want.text || want.gone || want.note);
      const limit = Math.max(1000, Math.min(cfg.waitMaxMs, (Number(args?.seconds) > 0 ? Number(args.seconds) * 1000 : any ? cfg.waitMaxMs : 5000)));
      // What came since they last did something counts: the notification may be here before the wait is asked for.
      const since = hands.keptOf(mine.id)?.actedAt || Date.now(), began = Date.now();
      const onPhone = mine.device === 'phone' && Boolean(phone()?.isReady);
      const look = async () => { try { return onPhone ? await phone().screenItems() : []; } catch { return []; } };
      const words = (items) => items.map((it) => it.words ?? '').join('\n');
      let items = [], met = '';
      for (;;) {
        if (!hands.thingById(mine.id)) return { status: 'idle' }; // the thing was stopped meanwhile
        if (want.note) { const n = arrive.seenNotes().find((x) => x.at >= since && `${x.pkg}\n${x.title}\n${x.text}`.toLowerCase().includes(want.note.toLowerCase())); if (n) met = `来了一条通知：${[n.title, n.text].filter(Boolean).join('：').slice(0, 200)}`; }
        if (!met && (want.text || want.gone) && onPhone) { items = await look(); const w = words(items); if (want.text && w.includes(want.text)) met = `屏幕上出现了「${want.text}」`; else if (want.gone && items.length && !w.includes(want.gone)) met = `屏幕上没有「${want.gone}」了`; }
        if (met || Date.now() - began >= limit) break;
        await new Promise((r) => setTimeout(r, Math.min(cfg.waitPollMs, Math.max(50, limit - (Date.now() - began)))));
      }
      if (!items.length) items = await look();
      const seconds = Math.round((Date.now() - began) / 1000);
      // How long a thing spent waiting, and whether what was waited for came, is kept on it.
      if (mine?.id) { const e = dot.ledger.get(mine.id); dot.ledger.note(mine.id, { waited: { n: (e?.waited?.n ?? 0) + 1, seconds: (e?.waited?.seconds ?? 0) + seconds, met: (e?.waited?.met ?? 0) + (met ? 1 : 0) } }); }
      audit('hands-wait', { thing: mine.id, met: Boolean(met), seconds, ...(want.text ? { text: true } : {}), ...(want.gone ? { gone: true } : {}), ...(want.note ? { notification: true } : {}) });
      return { status: met ? 'met' : any ? 'timeout' : 'waited', what: met || [want.text && `「${want.text}」出现`, want.gone && `「${want.gone}」消失`, want.note && `「${want.note}」的通知`].filter(Boolean).join('、'), seconds, screen: onPhone ? screenLines(items) : '' };
    },
  });
  // Her hands' one way of saying a thing is done (hands.js): what came of it, as a line and as details. The book keeps
  // both; each reader words them for itself (the voice gets the line, she gets both with the screen).
  const doneTool = () => ({
    name: HANDS_DONE_TOOL,
    description: prompt('dot.hands.done-tool'),
    parameters: { type: 'object', properties: { summary: { type: 'string', description: '一句话的结果，不超过 40 个字，写事实，不用「我」' }, detail: { type: 'string', description: '给她看的细节：做成了什么、屏幕上现在是什么、卡在哪，最多五六行' }, task: { type: 'string', description: '这件事的短名，八个字以内（如「看消息」「装App」「搜商品」）；同一件事每次用同一个名字' }, awaiting: { type: 'string', description: '这件事里给谁发了东西（短信、消息、申请）就要填：还在等对方回，填对方在屏幕上显示的名字或号码（会话标题那样）——回了会带着这件事叫她，不用守着；不用等谁回（对方已经回了、或者本来就不会回），填空字符串' }, reached: { type: 'boolean', description: '要的那个样子到了没有：到了 true，没到 false' } }, required: ['summary', 'reached'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: prompt(v?.status === 'done' ? 'dot.hands.done' : v?.status === 'unsaid' ? 'dot.hands.done.unsaid' : v?.status === 'unsaid-awaiting' ? 'dot.hands.done.unsaid-awaiting' : 'dot.hands.idle') }] },
    // Whether what was wanted was reached is theirs to say and nobody's to guess: left out, the thing is not ended either way.
    async execute(args, exec) {
      if (typeof args?.reached !== 'boolean') return { status: 'unsaid' };
      // Sent, and an answer is owed: written on the thing before it ends (its end is told from the book). Whoever
      // has answered meanwhile — a notification since the thing began — is on the record as the answer.
      const which = callerOf(exec), doing = thingFor(which), from = String(args?.awaiting ?? '').trim().slice(0, 60);
      if (doing?.id && args.reached && hands.keptOf(doing.id)?.reached && typeof args?.awaiting !== 'string') return { status: 'unsaid-awaiting' };
      if (doing?.id && from && args.reached) {
        const began = dot.ledger.get(doing.id)?.startedAt ?? Date.now();
        const got = [...arrive.seenNotes()].reverse().find((n) => n.at >= began && sameName(from, conversationTitle(n.title)));
        dot.ledger.note(doing.id, { awaiting: { from, since: Date.now(), until: Date.now() + cfg.awaitMs, ...(got ? { answeredAt: got.at, text: head(got.text, 300) } : {}) } });
        audit('awaiting', { thing: doing.id, from, answered: Boolean(got) });
      }
      const ended = hands.finish({ summary: args?.summary, detail: args?.detail, task: args?.task, reached: args.reached }, which);
      if (!ended && doing?.id && from) dot.ledger.note(doing.id, { awaiting: null });
      return { status: ended ? 'done' : 'idle' };
    },
  });

  // Read before you speak: a qq_send to him while he has said something she has not read yet (still in
  // the buffer, or steered but not reached by the model) is held back once or twice per turn; the
  // buffer goes in right away, so her next step has it.
  // Also: a loop (the same call over and over in one turn) is stopped, and an errand never talks to him.
  /** A call of her hands one of the gates stopped (gates.js): ended as a question for him, refused; null when it goes on. */
  // Things in which a step that reaches someone was let through (a text, a call, a message, a request to be added):
  // whether an answer is owed is then a fact of the thing, and only her hands know it — like whether what was wanted
  // was reached, it is theirs to say and nobody's to guess (11-24: told how, they still left it out, and the reply
  // would again have been tied to nothing). Kept on the thing: hands.keptOf(id).reached.
  const gateHands = (g, id, device) => {
    if (!g) return null;
    const thing = hands.thingOf(id)?.id ?? '';
    if (g.tier === 'forbid') { audit('gate-forbid', { session: id, device, kind: g.kind, what: g.what, thing }); return deny(prompt('dot.gates.forbid', { what: g.what })); }
    // Not done the way it was asked (a batch that has to be cut shorter): said back to her hands, nobody is asked.
    if (g.tier === 'refuse') { audit('gate-refuse', { session: id, device, kind: g.kind, thing }); return deny(prompt('dot.gates.refuse', { what: g.what })); }
    if (g.tier === 'him') {
      const what = HIM_KINDS[g.kind] ?? g.what;
      hands.ask(prompt('dot.gates.him.q', { what }), { for: 'him', kind: g.kind, tier: 'him', what, ...(g.screen ? { screen: true } : {}) }, { session: id });
      audit('gate-him', { session: id, device, kind: g.kind, what: g.what, thing });
      return deny(prompt('dot.gates.him', { what }));
    }
    if (!dot.consent.allows({ kind: g.kind, subject: g.subject, thing })) {
      hands.ask(prompt('dot.gates.ask.q', { what: g.what }), { for: 'him', kind: g.kind, tier: 'ask', what: g.what, ...(g.subject ? { subject: g.subject } : {}) }, { session: id });
      audit('consent-asked', { session: id, device, kind: g.kind, what: g.what, thing });
      return deny(prompt('dot.gates.ask', { what: g.what }));
    }
    audit('consent-used', { session: id, device, kind: g.kind, thing });
    if (thing && REACHES.has(g.kind)) hands.keptOf(thing).reached = true;
    return null;
  };
  // The computer's own gate (computer/gate.js) leaves her hands' calls to the gates here, whichever hook runs first.
  const calls = new WeakMap(); // turn → how often each call (loopKey) was made in it
  const handsOf = (exec) => Boolean(hands?.isHands(exec?.agent?.session?.id, exec?.agent?.session?.header?.cwd));
  const preExecute = async (exec, next) => {
    const id = exec.agent?.session?.id;
    const args = exec.input ?? exec.args ?? exec.arguments ?? {};
    const t = turns.get(id);
    // Looking and scrolling repeat by nature (the screen changes, the call does not): never a loop.
    if (t && cfg.loopRepeat > 0 && !LOOP_EXEMPT.test(exec.name)) {
      if (!calls.has(t)) calls.set(t, new Map());
      const key = loopKey(exec.name, args), times = calls.get(t).get(key) ?? 0;
      if (times >= cfg.loopRepeat) { audit('loop-stopped', { session: id, tool: exec.name, times }); return deny(prompt('dot.loop-stopped', { times })); }
      calls.get(t).set(key, times + 1);
    }
    // hand_off is hers to use in her conversation only; and in a turn of his words she talks and hands off —
    // her phone and computer are operated by her errand, not here.
    if (exec.name === 'hands' && id !== sessions.last()) return deny(prompt('dot.hands.instead'));
    // Her hands: asking her is theirs alone, and once they have asked, this stretch of theirs is over — nothing more is done until she answers.
    const theirs = Boolean(hands?.isHands(id, exec.agent?.session?.header?.cwd));
    if ((exec.name === HANDS_ASK_TOOL || exec.name === HANDS_DONE_TOOL || exec.name === HANDS_WAIT_TOOL) && !theirs) return deny(prompt('dot.lean.not-hers', { tool: exec.name }));
    if (theirs && exec.name !== HANDS_ASK_TOOL && hands.asked({ session: id })) return deny(prompt('dot.hands.asked'));
    // A tool that is not the place's (compat's set for this session) is not theirs to call, and not a question for him:
    // refused here, before the gates below would judge it as if it were (11-24: a shell call of a thing on the web was
    // asked of him as deleting in a shared folder). compat's guard refuses it too, but after this hook.
    if (theirs) {
      const compat = ctx.get('dshDotCompat'), s = exec.agent?.session;
      const place = compat?.owner?.(id, s?.header?.cwd, s?.header?.agentPreset);
      if (place && compat.hiddenFor?.(place, [exec.name])?.length) { audit('hands-not-theirs', { session: id, tool: exec.name, place }); return deny(`dsh-dot: ${exec.name} is not available in this session (${place})`); }
    }
    // Her phone is reached with its own tools, where the gates look: not through the shell.
    if (theirs && exec.name === 'bash' && /\b(?:adb|emulator|am\s+start|input\s+(?:tap|text|keyevent))\b/.test(String(args?.command ?? ''))) { audit('gate-shell', { session: id }); return deny(prompt('dot.gates.shell')); }
    // What her hands do on her phone, by the gates' four tiers (gates.js): code decides, from the screen as it was last read.
    if (theirs && (exec.name.startsWith(PHONE_TOOL_PREFIX) || exec.name === PHONE_TYPE_TOOL)) {
      // Which app is in front, and what is on the screen: what could not be found out is passed on as not known
      // (null), and the gates ask about a press they cannot judge — nothing is let through for want of a reading.
      let fg = null;
      try { fg = String((await phone()?.foreground?.()) ?? '') || null; } catch (error) { void error; }
      // A tap is judged by the words under it now: a screen read more than a few seconds ago (or never: her hands
      // looked with the phone's own listing tool) is read again first.
      let seen = phone()?.lastScreen ?? null;
      if (/click|tap|press|batch/.test(exec.name) && (!seen || Date.now() - (seen.at ?? 0) > cfg.gateScreenMs)) { try { await phone()?.screenItems?.(); seen = phone()?.lastScreen ?? null; } catch (error) { void error; seen = null; } }
      const stop = gateHands(classify({ tool: exec.name, input: args, screen: seen, fg }), id, 'phone');
      if (stop) return stop;
    }
    // On her computer the same tiers (gates.js classifyComputer), from what the computer's own rules find in the call
    // (computer/gate.js, which then asks nothing of its own for it) and the page her browser is on now.
    // On this machine itself (a thing given with device 'host'): only looking is theirs; anything else is asked of him
    // (gates.js classifyHost). Every call of theirs there is judged, whatever the tool.
    const onHost = theirs && handsPlace(exec.agent?.session?.header?.cwd, exec.agent?.session?.header?.agentPreset) === 'host';
    if (onHost) {
      exec.dotGated = true;
      const stop = gateHands(classifyHost({ tool: exec.name, input: args }), id, 'host');
      if (stop) return stop;
    }
    if (theirs && !onHost && (exec.name === 'bash' || exec.name.startsWith(VM_TOOL_PREFIX))) {
      const pc = computer();
      const doing = Boolean(pc?.gate?.acts?.(exec.name));
      const page = doing ? (await pc?.page?.()) ?? null : null;
      exec.dotGated = true;
      const stop = gateHands(classifyComputer({ tool: exec.name, input: args, risk: pc?.gate?.riskOf?.(exec) ?? null, acts: doing, page }), id, 'computer');
      if (stop) return stop;
    }
    // A lean conversation of hers has her own tools only; one the host still answers to by name is not run.
    if (sessions.isLean(id) && !isHerTool(exec.name)) { audit('lean-refused', { session: id, tool: exec.name }); return deny(prompt('dot.lean.not-hers', { tool: exec.name })); }
    // From here on it is about what she is saying, whichever way it goes out (spokenOf).
    const spoken = exec.name === SAY_TOOL ? { via: 'qq', to: String(args?.to ?? '').trim() || 'owner', text: '' } : spokenOf(exec.name, args);
    if (!spoken) return next();
    // One way out for her words: a send of the QQ backend's own tools (or qq_send, by name) from her conversation would be words nobody wrote as her.
    if (spoken.via === 'qq' && exec.name !== SAY_TOOL && isDotSession(id, exec.agent?.session?.header?.cwd)) return deny(prompt('dot.say.instead'));
    // Her hands do not write. What they type on her phone is hers (in the task she gave them) or was shown to them
    // (the screen, an account) — an address is not words. Anything else goes back to her to be said.
    const round = hands?.isHands(id, exec.agent?.session?.header?.cwd) ? hands.thingOf(id) : null;
    if (round && spoken.via === 'phone') {
      const own = ownWords(spoken.text, (line) => hands.has(line, { session: id }));
      if (own.length) { hands.note('own-words', { session: id }); audit('hands-own-words', { session: id, chars: own.join('').length }); return deny(prompt('dot.hands.own-words', { text: own[0].slice(0, 60) })); }
    }
    const toOwner = spoken.via === 'qq' && isOwnerTarget(spoken.to, ctx.get('dshQq')?.owner);
    // Her words can still be handed back, to anyone and anywhere: him, someone else, a group, a comment typed on
    // her phone. Once a turn — a second draft goes out as it is, so a phrase list that is wrong costs one call.
    // Typed by her hands, the words are still hers: the line goes back to her, through them.
    const c = spoken.text && (round || t) ? voice.handBack(spoken.text, { strict: true }) : null;
    if (c) {
      const why = c.hits.length ? prompt('dot.reply-check.phrases', { phrases: c.hits.slice(0, 3).map((h) => `「${h}」`).join('') }) : prompt('dot.reply-check.stage');
      if (round) hands.note('reply-check', { session: id });
      audit('reply-check', { session: id, via: round ? 'hands' : exec.name === 'qq_send' ? 'qq_send' : spoken.via === 'phone' ? 'phone' : 'qq-tool', ...(toOwner ? {} : { to: spoken.to || 'app' }), stripped: c.stripped, hits: c.hits, denied: true });
      return deny(round ? prompt('dot.hands.reply-check', { why }) : replyCheckText(c));
    }
    if (round) return next();
    if (!toOwner) return next();
    const buffered = Boolean(id) && id === sessions.last() && arrive.ownerPending() > 0;
    if (!buffered && !ownerUnread(exec.agent)) return next();
    if (voice.preempts() >= cfg.ownerPreemptMax) { audit('owner-gate-passed', { session: id, preempts: voice.preempts() }); return next(); }
    const n = voice.preempted();
    const flushed = buffered ? arrive.flushOwner(exec.agent) : 0;
    audit('owner-gate-denied', { session: id, flushed, deny: n + 1 });
    return deny(ownerInterruptText());
  };

  return {
    /** Her hands (hands.js), or null before makeHands. */
    hands: () => hands,
    makeHands, howto, onApproval, onPostExecute, assemble, nightcheck, nightly, disposePhoneHome, cancelPhoneHome,
    restartCut, handsPlace, handsOf, askTool, waitTool, doneTool, preExecute,
  };
}

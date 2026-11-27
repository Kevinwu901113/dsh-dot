// dsh-dot/voice: her side of the conversation with him (taken out of core.js as it was).
// Holds: the times she wrote to him unasked (reaches, remembered), the one check's "just handed back" flag, the
// answer held for a moment after his words opened a thing (ackHold), how often in a row her words gave way to his
// (preempts), what went out since she was last up (saidNote), and the outlet and the voice (say.js) themselves.
import { createHash } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { checkReply } from '../persona/card.js';
import { saysHowToTalk } from '../persona/parts.js';
import { sayingsPlace } from './sayings.js';
import { callModel } from '../llm-call.js';
import { prompt } from '../prompts.js';
import { ago } from '../clock.js';
import { headTail } from './ledger.js';
import { createOutlet } from './outlet.js';
import { createSay } from './say.js';
import { nameOf, titleOf } from './things.js';
import { atHisWindow, forHim, heSpoke, overQq } from './turns.js';
import { reachText, voiceHow } from './text.js';

/**
 * @param dot  the plugin's parts (core.js apply): ctx, cfg, audit, logger, store, im, sessions, things, turns;
 *             read when used: ledger, arrive (hisUnread)
 * → { handBack, reachLine, answerReaches, noteUnanswered, dropAck, readFirst, preempts, herSaid, replyChecks, planFor,
 *     factsFor, outlet, say, saidText, tellHim, turnEnded, saidNoteText, saidElsewhere }
 */
export function createVoice(dot) {
  const { ctx, cfg, audit, logger, store, im, sessions, things, turns, home } = dot;
  const sayingsHere = sayingsPlace(home);
  let noVoiceTold = false; // he was told her card has no part on how she talks
  // The one check of what she says, whichever way it goes out (her answer, qq_send, a line her hands type). A line
  // that is handed back is followed by one that goes out as written — so a phrase list that is wrong costs one call,
  // and nothing she says can be held for good. `strict` also hands back a line that only had stage directions in it
  // (a tool's text cannot be tidied on its way out; her answer's can).
  let wordsJustBack = false;
  const handBack = (text, { strict = false } = {}) => {
    if (!cfg.replyCheck || !String(text ?? '').trim()) return null;
    const c = checkReply(text, replyChecks());
    const back = Boolean(c.hits.length || (strict && c.stripped)) && !wordsJustBack;
    wordsJustBack = back;
    return back ? c : null;
  };
  // The times she wrote to him unasked, of the last two days: [{ at, answeredAt?, noted? }] (see reachText).
  let reaches = (store.get('reaches') ?? []).filter((r) => r && Date.now() - r.at < 2 * 86400000);
  const saveReaches = () => { reaches = reaches.slice(-40); store.set('reaches', reaches); };
  const reachedIn = new WeakSet(); // the turns in which she has written to him unasked (once a turn)
  const answerReaches = () => { let n = 0; for (const r of reaches) if (!r.answeredAt) { r.answeredAt = Date.now(); n++; } if (n) saveReaches(); };
  // One she wrote and he has left unanswered for reachUnansweredMs: said once, as a note in her conversation — her
  // record then holds what came of it, and what she makes of that is hers.
  const noteUnanswered = (now = Date.now()) => {
    for (const r of reaches) {
      if (r.answeredAt || r.noted || !(cfg.reachUnansweredMs > 0) || now - r.at < cfg.reachUnansweredMs) continue;
      r.noted = true; saveReaches();
      const time = new Date(r.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      audit('reach-unanswered', { at: r.at });
      dot.arrive.note('other', prompt('dot.reach.unanswered', { time, hours: Math.round((now - r.at) / 3600000) }).trim());
    }
  };

  // ── her side of the conversation with him ──
  // Writing (a turn of his words is open, `turns`), sending (her bubbles are going out, outlet.busy()), or neither.
  // One rule for both: what has not reached him yet gives way to what he just said; what has reached him stands.
  let ackHold = null;   // the answer to his turn that opened a thing, held for a moment (see the voice at a turn's end)
  const dropAck = (why) => { if (!ackHold) return; clearTimeout(ackHold.timer); ackHold = null; audit('ack-dropped', { why }); };
  let preempts = 0;     // her words in a row that gave way before anything of hers reached him (see defaults.ownerPreemptMax)
  // Read before you speak, one rule for every way her words go to him (the voice, her say, a turn started over): hers
  // that have not reached him give way to his unread ones (arrive.hisUnread), at most ownerPreemptMax times in a row.
  // → 'clear' · 'gave-way' (counted; the caller holds hers back) · 'past' (hers go out: he cannot keep her silent).
  const readFirst = (unread) => { if (!unread) return 'clear'; if (preempts >= cfg.ownerPreemptMax) return 'past'; preempts++; return 'gave-way'; };
  /** Her transcript gets what reached him, not what she wrote (dsh-dot/memory). */
  const herSaid = (id, text) => { try { if (String(text ?? '').trim()) ctx.get('dotMemory')?.herSaid?.({ session: id, text }); } catch (err) { logger.warn(`transcript: ${err.message}`); } };
  const replyChecks = () => { try { return cfg.replyCheck ? ctx.get('dshInterlude')?.checks?.() ?? [] : []; } catch { return []; } };
  // What the voice is given comes in two shapes, by what the book has for this turn.
  // A report (planFor): a thing of this turn ended, was stopped, or was begun — the book's own sentences, plain and in
  // the first person, which the voice says her way and to which it adds nothing (say.js reportInput). `must` is what
  // is said; `may` is the thing's detail, given when it is what he asked for.
  // Talk (factsFor): nothing of this turn is in the book — she is talking with him; the voice has the conversation,
  // and is told what is in her hands so that it does not make up doings.
  const { owedToHim } = things;
  const planFor = (t) => {
    const must = [], may = [], things = [];
    // The ends of his things he has not heard: the one that woke this turn among them, whichever turn this is.
    const ends = owedToHim();
    const stopped = new Set(t?.stopped ?? []);
    for (const about of ends) {
      if (stopped.has(about.id)) continue; // said below, as stopped in this turn
      things.push(about.id);
      const what = nameOf(about.task);
      if (about.ask?.tier && about.ask.what) must.push(prompt(about.ask.tier === 'him' ? 'dot.plain.gate.him' : 'dot.plain.gate.ask', { what, step: about.ask.what }));
      else if (about.question) must.push(prompt('dot.plain.stuck', { what, question: about.question }));
      else if (about.outcome === 'done') must.push(about.summary ? prompt('dot.plain.done', { what, summary: about.summary }) : prompt('dot.plain.done.bare', { what }));
      else must.push(prompt('dot.plain.notdone', { what, how: voiceHow(about), summary: about.summary ? prompt('dot.plain.summary', { summary: about.summary }).trim() : '' }));
      if (about.detail && !about.question) may.push(headTail(about.detail, cfg.sayDetailChars));
      if (about.awaiting?.from) must.push(prompt(about.awaiting.answeredAt ? 'dot.plain.answered' : 'dot.plain.awaiting', { from: about.awaiting.from, text: about.awaiting.text ?? '' }));
    }
    for (const id of t?.stopped ?? []) { const e = dot.ledger.get(id); if (e) { things.push(id); must.push(prompt('dot.plain.stopped', { what: nameOf(e.task), how: voiceHow(e) || prompt('dot.plain.how.stopped.her').trim() })); } }
    // Of things just given to her hands nothing is said but that they are being done — not even what they are: he has
    // just said it himself, and with the task in front of it the voice told it as done (11-24: 12 of 20 with the task
    // named, 1 of 20 without).
    const said = must.length;
    const going = (t?.opened ?? []).map((id) => dot.ledger.get(id)).filter((e) => e && e.state !== 'ended');
    if (going.length > 1) must.push(prompt('dot.plain.opened.many', { n: going.length }));
    else if (going.length) must.push(prompt('dot.plain.opened'));
    // One thing, begun: the progress has sayings of hers to be said in (say.js leadInput). Otherwise the sentence itself.
    const sayings = !said && going.length === 1 ? prompt('dot.plain.opened.sayings').split('\n').map((x) => x.trim()).filter(Boolean) : [];
    return must.length ? { his: t?.hisWords ?? '', must: must.map((x) => x.trim()), may, underway: !said, sayings, things } : null;
  };
  const factsFor = (t) => {
    const out = [];
    const mine = new Set([...(t?.opened ?? []), ...(t?.stopped ?? []), t?.by.thing].filter(Boolean));
    const rest = dot.ledger.unfinished().filter((e) => !mine.has(e.id));
    for (const e of rest) out.push(prompt('dot.say.fact.running', { what: titleOf(e.task), since: ago(e.startedAt ?? e.openedAt, Date.now()) ? `（${ago(e.startedAt ?? e.openedAt, Date.now())}前开始的）` : '' }));
    if (!out.length) out.push(prompt('dot.say.fact.none'));
    return out.map((x) => x.trim());
  };
  const outlet = createOutlet({
    qq: () => ctx.get('dshQq'), im,
    here: () => atHisWindow(turns.get(sessions.last())),
    herSaid: (text) => herSaid(sessions.last(), text),
  });
  // What she says (say.js): written by a call that is only her card, checked once, and carried out from here —
  // to his QQ or anyone's (her bubbles one after another; qq.send stops between them when he speaks), to her own
  // window when that is where he is talking to her (the tool's output is what he reads there), or over the IM
  // channel when her QQ is not connected.
  const say = createSay({
    card: () => { try { return ctx.get('dshInterlude')?.cardText?.() ?? ''; } catch { return ''; } },
    call: async ({ system, text }) => {
      // What this side sends (compare with the model gate's say-request: the same system, nothing added on the way).
      audit('say-call', { systemChars: system.length, systemSha: createHash('sha256').update(system).digest('hex').slice(0, 12), userChars: text.length });
      const reply = await callModel(ctx, { effort: cfg.sayEffort || undefined, system, maxTokens: cfg.sayMaxTokens, messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'dsh-dot', form: 'say' } })] });
      if (reply.outcome.kind === 'no-model') throw new Error('no model to say it with');
      return reply;
    },
    recent: (n) => { try { return ctx.get('dotMemory')?.recent?.(n) ?? []; } catch { return []; } },
    stickers: () => { try { return ctx.get('dshQq')?.stickerList?.() ?? []; } catch { return []; } },
    check: (text) => (cfg.replyCheck ? checkReply(text, replyChecks()) : { lines: String(text).split('\n').map((l) => l.trim()).filter(Boolean), hits: [] }),
    unread: (to) => to === 'owner' && readFirst(dot.arrive.hisUnread()) === 'gave-way',
    lines: cfg.sayLines,
    // How she talks comes from her card alone; only a card that does not say gets the plugin's few lines after it.
    // A card that has said it and no longer does (a heading renamed): he is told once — which part goes where is by
    // the headings, and a renamed one moves to both steps without a word (11-27).
    style: () => {
      try {
        const card = ctx.get('dshInterlude')?.cardText?.() ?? '';
        const talks = saysHowToTalk(card);
        if (card && !talks && !noVoiceTold) { noVoiceTold = true; audit('card-no-voice'); void im.send(prompt('dot.card.no-voice').trim(), 'plain'); }
        if (talks) noVoiceTold = false;
        return talks ? '' : prompt('dot.say.style');
      } catch { return ''; }
    },
    // How she answered him before on the same kind of thing (memory.js sayings): dot.sayPast of them, 0 = none.
    past: async (q, o) => { const n = Number(cfg.sayPast) || 0; if (!n) return []; return (await ctx.get('dotMemory')?.sayings?.(q, { ...o, n, choices: sayingsHere.choices() })) ?? []; },
    // Which ones went with which reply: written down in her place, for her to look back at (sayings.js).
    used: (o) => sayingsHere.record(o),
    pastWaitMs: cfg.sayPastWaitMs,
    audit: (event, data) => audit(event, { session: sessions.last(), ...data }),
    send: (m) => outlet.send(m),
  });
  /** What went out, told back to her: the lines and pictures as they were sent. */
  let saidNote = '';
  const saidText = (r) => `${prompt(r.interrupted ? 'dot.say.interrupted' : 'dot.say.said', { said: [...(r.said ?? []), ...(r.images ?? []).map((i) => `[${i}]`)].join('\n') || '（只发了图）', unsent: (r.unsent ?? []).join('\n') })}${r.failed?.length ? `\n${prompt('dot.say.failed-images', { failed: r.failed.map((f) => `[${f.image}]${f.error ? `（${String(f.error).slice(0, 60)}）` : ''}`).join('\n') })}` : ''}`;
  /**
   * Something of hers for him, in turn `t` (the open one, or the one that just ended): what she knows that bears on it
   * (`about`, from the say tool) or what she wrote she means to tell him (`meant`, a turn's closing words). The same
   * call writes it either way; here is what the turn and the day keep of it.
   */
  async function tellHim(t, { about = '', images = [], again = false } = {}) {
    // Nothing of his is waiting for an answer when the turn was not opened by his words (her hands came back, a notification, her own time).
    const plan = planFor(t), facts = plan ? [] : factsFor(t);
    audit('say-facts', { facts: (plan ? plan.must : facts).map((f) => f.slice(0, 160)), about: String(about ?? '').slice(0, 160), ...(plan ? { report: true, may: plan.may.length } : {}) });
    // A question for him that needs the screen (a QR code to scan): it goes with what she says.
    const ended = t?.by.thing ? dot.ledger.get(t.by.thing) : null;
    const shots = ended?.outcome === 'stuck' && ended.ask?.screen && (ended.device === 'phone' || ended.device === 'computer') ? [`${ended.device}:screen`] : [];
    const r = await say.speak({ to: 'owner', about, facts, plan, images: [...[].concat(images ?? []), ...shots], unprompted: !heSpoke(t), again });
    if (r.status !== 'said') return r;
    preempts = 0; // something of hers reached him
    turns.spoke(t);
    // The ends it was given are told: written on each thing now, when all of it went out (cut short by his words, the
    // turn those words open says it). A screen he was to see (a QR code to scan) that did not go is not told: the words
    // went, the picture is still owed, and the thing stays among what he has not heard (11-26: say.js dropped `failed`).
    const pictureOwed = shots.some((s) => (r.failed ?? []).some((f) => f.image === s));
    if (pictureOwed) audit('told-without-picture', { session: sessions.last(), thing: ended?.id, failed: r.failed.map((f) => f.image) });
    if (plan?.things?.length && !r.unsent?.length && !pictureOwed) for (const id of plan.things) dot.ledger.note(id, { told: Date.now() });
    saidNote = saidText(r); // hers to know: shown with whatever reaches her next
    // She wrote to him in a turn that is not on his business: kept as a fact of the day (reachText), with what came of it.
    if (t && !heSpoke(t) && !forHim(t) && !reachedIn.has(t)) { reachedIn.add(t); reaches.push({ at: Date.now() }); saveReaches(); audit('reached-out', { session: sessions.last(), origin: t.by.form ?? (t.by.whose === 'schedule' ? 'schedule' : '') }); }
    return r;
  }
  // Nothing she writes leaves, and nothing she writes is read: a turn he is in that ends — his words, or a thing of
  // his that came to its end — is answered by the voice (say.js) from their conversation and the facts of the book.
  // What she herself has for him (a view, a question, something that does not match the picture) she gives with
  // say's `about`, a field, in that turn. Until 11-23 the turn's closing words were passed on as "what she knows":
  // she was asked to write them every turn, wrote "发出去了" before her hands had moved, and 0.25.1 then had to drop
  // them whenever a thing had just ended — taking her real questions with them.
  // (At her window what she wrote is on his screen as it is; nothing more goes out from here.)
  // Called by turns.js for a turn on his business that ended (forHim).
  const turnEnded = (id, t, event, broke) => {
    if (t.startedOver) { audit('owner-turn-restarted', { session: id, aborted: event.data?.reason?.kind === 'aborted' }); return; }
    if (broke) return;
    // A turn his words did not open (a thing of his came back, an answer it waited for) has something for him when the
    // book has an end of his he has not heard (planFor's `things`): not when it was already said in an earlier turn,
    // nor when she carries the thing on (a later thing `after` it: that one's end is told). What else she did in the
    // turn does not decide it (11-24: she added a line to another thing, and the end that woke the turn was not said).
    const news = overQq(t) || Boolean(planFor(t)?.things?.length);
    const speak = !t.spoke && news && !atHisWindow(t) && event.data?.reason?.kind !== 'aborted';
    const over = () => { if (!t.spoke) { preempts = 0; audit('silent', { session: id }); } };
    // The call that writes her words failed: that is not her choosing to say nothing.
    const told = (r) => { if (r?.status === 'failed') { preempts = 0; turns.turnFailed(id, `替她写话的那次调用没成：${r.why ?? ''}`, { outcome: r.outcome }); } else over(); };
    if (!speak) { over(); return; }
    // His words opened a thing: the answer waits a moment (ackHoldMs). When nothing of his is under way by then, what
    // came of it is told once, by the turn its end wakes; while something is, he gets word that it is under way.
    // His next words call the wait off (that turn answers all of it).
    if (overQq(t) && t.opened?.length && cfg.ackHoldMs > 0) {
      dropAck('another turn');
      const ack = { timer: null };
      ack.timer = setTimeout(() => {
        if (ackHold !== ack) return;
        ackHold = null;
        if (!things.hisUnderWay()) { audit('ack-folded', { session: id }); return; } // told by the turn the result woke
        void tellHim(t).then(told, over);
      }, cfg.ackHoldMs);
      ack.timer.unref?.();
      ackHold = ack;
      audit('ack-held', { session: id, things: t.opened });
      return;
    }
    void tellHim(t).then(told, over);
  };
  // What went out to him since she was last up, as it was sent: the voice's words, not hers (turn note dot:said).
  const saidNoteText = ({ agent }) => { if (!saidNote || agent.session.id !== sessions.last()) return ''; const n = saidNote; saidNote = ''; return n; };
  // What she said on QQ some other way than qq_send (the backend's own tools, her phone's QQ): on record all the same.
  const saidElsewhere = (m) => {
    audit('said-elsewhere', { to: m.to, chars: m.text.length });
    try { ctx.get('dotMemory')?.herSaid?.({ session: sessions.last(), text: m.text, to: m.to, at: Date.parse(m.at) || Date.now() }); } catch (err) { logger.warn(`transcript: ${err.message}`); }
  };
  return {
    handBack,
    /** The day's times she wrote to him unasked, as a line for her turn (text.js reachText). */
    reachLine: () => reachText(reaches),
    answerReaches, noteUnanswered, dropAck,
    readFirst,
    /** Her words in a row that gave way to his (readFirst). */
    preempts: () => preempts,
    herSaid, replyChecks, planFor, factsFor, outlet, say, saidText, tellHim, turnEnded, saidNoteText, saidElsewhere,
  };
}

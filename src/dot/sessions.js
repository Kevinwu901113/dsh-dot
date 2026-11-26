// dsh-dot/sessions: which sessions are hers, and which one is her conversation (taken out of core.js as it was).
// Holds: the IM sessions seen, her conversation (`lastSession`, remembered across restarts), the conversations she
// has left (retired), the ones that are lean. Opens a conversation for her, resolves her agent at its effort, leaves a note in it.
import { relative, isAbsolute } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { BRIDGE_ID_RE } from '../compat/qq-bridge.js';
import { HER_PRESET } from '../tool-prefixes.js';
import { effortFor } from '../llm-gate.js';

/** Source of a note left in her conversation (injected; it does not wake her: arrive.js note). The form and the prompt ids keep the name they had when errands left them: installed overrides go by it. */
export const ERRAND_NOTE_SOURCE = Object.freeze({ kind: 'dsh-dot', form: 'errand-note' });
/** dsh-im tags messages it relays with an rpcId of `<channel>-<uuid>`; the desktop UI does not. */
export const IM_RPC = /^(weixin|wechat|qq|feishu|lark|dingtalk|wecom|wework|telegram|discord|slack|whatsapp|email|office)-/i;
// "qq-dot-…" is our own tag (ownerSource): his QQ words relayed by dot, not a dsh-im bot session —
// counting those made her conversation an "IM bot session", which the memory handoff leaves alone
// (11-03: 456k tokens, no handoff since 10-29).
export const isImMessage = (m) => { const r = String(m?.source?.rpcId ?? ''); return IM_RPC.test(r) && !r.startsWith('qq-dot-'); };
const inside = (root, p) => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

/**
 * @param dot  the plugin's parts (core.js apply): ctx, cfg, store, audit, logger, home
 * → { last, setLast, wantIm, imSessions, isDotSession, retired, lean, isLean, selfCheck, thinkAt, resolveLive,
 *     createConversation, openConversation, setSession }
 */
export function createSessions(dot) {
  const { ctx, cfg, store, audit, logger, home } = dot;
  // What her conversation is. It is one session, and the plugin is the only one that makes it: openConversation (the
  // first thing that reaches her when she has none) and setSession (a handoff), both through createConversation — with
  // her own preset (HER_PRESET) whenever lean is on and the host takes it. A session is hers when it is that one, or one
  // she has left (retired). Nothing else makes a session hers: not its folder (a session opened by hand in her home),
  // not who opened it (an IM bot), not a turn that ends in it. Until 11-26 a turn ending in any session under her home
  // made that session her conversation: one opened by hand in the desktop's dot workspace became hers with the host's
  // 52 tools (bash, the web, subagents), and her own time ran in it with no hands in between.
  // The IM sessions seen are still kept (a handoff leaves an IM bot's session to its bot); they do not make a session hers.
  const imSessions = new Set();
  let lastSession = store.get('lastSession') || ''; // her conversation: where phone notifications wake her (remembered across restarts)
  // Every change goes through here, called only where the plugin made her conversation (and by the self-check, to
  // clear it).
  const point = (id) => { if (id === lastSession) return; lastSession = id; store.set('lastSession', id); };
  /** A turn of hers ended in `id` (turns.js): that is her conversation already — no other session becomes it this way. */
  const setLast = (id) => { if (!id || id === lastSession) return; audit('not-her-conversation', { session: id, conversation: lastSession }); };
  const wantIm = cfg.scope === 'all' || String(cfg.scope).includes('im');

  // Sessions that were hers and are not any more: conversations a reset or a handover retired (src/reset.js,
  // setSession), and — read from older state files, nothing adds to it — the second session she had before there was
  // one of her. A turn ending in one of them does not make it hers again.
  const pastConversations = new Set([...(store.get('pastConversations') ?? []), ...(store.get('pastErrands') ?? []), store.get('errandSession')].filter(Boolean));
  const retired = (id) => Boolean(id) && pastConversations.has(id);
  // While the plugin is making her conversation (createConversation), the session coming up in her home is that one:
  // dsh may announce it (agent/created, where compat fixes whose a session is for good) before it has an id we know.
  let making = 0;
  // qq-bridge's sessions (`qqb-…`, see src/compat/qq-bridge.js) are never hers. Where a session is does not make it hers.
  const isDotSession = (id, cwd) => Boolean(id) && !BRIDGE_ID_RE.test(String(id))
    && (id === lastSession || retired(id) || (making > 0 && Boolean(cwd) && inside(home, cwd)));
  // Her conversations that are lean (told by api.lean, which the compat layer and the prompt trim both ask). A lean
  // conversation is one made with her own agent preset (HER_PRESET): the host's tools come with a session's preset
  // and nothing a plugin can do afterwards takes them out of its requests — not tools.restrict() (it does not reach
  // what the agent's own layer registers), not llm/stream (next() takes no argument), not system-prompt/assemble
  // (0.2.2 re-attaches the tool list after the waterfall). The preset decides; the rest follows it.
  const leanIds = new Set(), notLeanTold = new Set();
  /** Does this conversation of hers start lean (see defaults.lean)? One begun at or after the moment lean was first on. */
  const lean = (id, preset) => {
    const yes = Boolean(cfg.lean) && Boolean(id) && !retired(id) && preset === HER_PRESET;
    if (yes) leanIds.add(id);
    // Her conversation not made with her preset while lean is on: one remembered from before (a state file pointing at a
    // session that became hers some other way), or one the host would not make with the preset. Said once a session.
    else if (cfg.lean && id && id === lastSession && !notLeanTold.has(id)) {
      notLeanTold.add(id);
      audit('conversation-not-lean', { session: id, preset: preset ?? '' });
      logger.warn(`her conversation ${id} was not made with her preset (${preset || 'none'}): it carries the host's tools — /dot memory handoff moves her to one that is`);
    }
    return yes;
  };
  // Startup self-check: the remembered pointer must be a live conversation of hers. An old state file
  // can point at a retired session or at one archived since (11-03: his QQ messages went into an
  // archived session and nobody answered). What dsh cannot tell us (no registry yet, no title) is skipped.
  const staleWhy = (id) => {
    if (!id) return '';
    if (retired(id)) return 'retired';
    try { const ids = ctx.get('workspaceRegistry')?.archivedSessionIds; if ((Array.isArray(ids) || ids instanceof Set) && [...ids].includes(id)) return 'archived'; } catch (error) { void error; }
    return '';
  };
  const selfCheck = () => {
    const why = staleWhy(lastSession);
    if (!why) return;
    audit('last-session-cleared', { session: lastSession, why });
    logger.warn(`her remembered conversation ${lastSession} is ${why}: cleared (the next message to her picks a new one)`);
    point('');
  };
  // Her conversation and her hands think at their own effort (defaults.herEffort, handsEffort), whatever the model
  // selector was last set to. It is the session's own selection, set through the agent before anything is sent into
  // it: recorded for that session only, kept, and nothing is done when it already says so. The host fixes a step's
  // selection before the step runs and fails the whole turn when the `agent/request` waterfall proposes another
  // effort (11-17, and again 11-21: three of his messages went unanswered), so it is never changed there. A host
  // without agent.model.select, or a model that does not offer the effort: the session follows the selector.
  const thinkAt = async (agent, want) => {
    if (!want) return;
    try {
      const m = agent?.model;
      if (typeof m?.select !== 'function') return;
      const cur = (typeof m.current === 'function' ? m.current() : null) ?? ctx.get('agentDefaultModel')?.currentSelection?.();
      if (!cur?.provider || !cur?.model) return;
      const { effort, why } = await effortFor(ctx, { provider: cur.provider, model: cur.model, reasoningEffort: cur.reasoningEffort }, want);
      if (!effort || effort === cur.reasoningEffort) return;
      m.select({ provider: cur.provider, model: cur.model, reasoningEffort: effort });
      audit('effort-set', { session: agent.session?.id, model: `${cur.provider}/${cur.model}`, was: cur.reasoningEffort ?? 'default', effort, why });
    } catch (err) { logger.warn(`reasoning effort not set: ${err.message}`); }
  };
  /**
   * Her agent for a session: the live agent loop from ctx.agents (steer/inject/cancel) when it is
   * running; otherwise the session controller's resolveAgent — the client API layer, whose handle on
   * the desktop host only offers followup — which also loads a session that is not live.
   */
  const resolveLive = async (id) => {
    const live = ctx.get('agents')?.get?.(id);
    const found = typeof live?.followup === 'function' ? { agent: live } : await ctx.get('sessionController')?.resolveAgent(id);
    if (found && !('error' in found) && !retired(id)) await thinkAt(found.agent, cfg.herEffort);
    return found;
  };
  /**
   * Make a session in her home for her conversation: with her own preset when lean is on. A host that does not know
   * the preset (the plugin's patch row did not load, an older dsh) refuses it — then the session is made as before.
   */
  const createConversation = async (controller) => {
    let made;
    making++;
    try {
      if (cfg.lean) {
        try { made = await controller.create({ cwd: home, agentPreset: HER_PRESET }); audit('conversation-preset', { session: made?.sessionId, preset: made?.agentPreset ?? HER_PRESET }); }
        catch (err) { audit('conversation-preset-refused', { why: String(err?.message ?? err).slice(0, 200) }); }
      }
      made ??= await controller.create({ cwd: home });
      // Its effort is set now, whoever is first to send into it (his words typed in its window, her own time).
      try { await resolveLive(made?.sessionId); } catch (err) { logger.debug?.(`new conversation not resolved: ${err.message}`); }
    } finally { making--; }
    return made;
  };
  /** A new conversation of hers in her home; '' when dsh cannot make one. */
  const openConversation = async (controller) => {
    try {
      const { sessionId } = await createConversation(controller);
      try { await controller.rename?.({ sessionId, title: 'dot' }); } catch (error) { void error; }
      point(sessionId); audit('conversation-opened', { session: sessionId });
      return sessionId;
    } catch (err) { logger.warn(`could not open a conversation for her: ${err.message}`); return ''; }
  };
  /** dshDot.setSession: her conversation moves on (memory's handoff). */
  const setSession = (id) => {
    if (!id || id === lastSession) return;
    if (lastSession) {
      pastConversations.add(lastSession); store.set('pastConversations', [...pastConversations].slice(-50));
      // The one she leaves stops here: a turn still running in it and whatever waits in its inbox are not carried on
      // by a second her (11-20: it went on for two minutes — 38 turns, 16 messages to him — after she had moved).
      // What is in her hands is not its: that comes back to wherever she is (handsBack).
      try { ctx.get('agents')?.get?.(lastSession)?.cancel?.({ kind: 'hook', reason: 'dot: her conversation moved on' }); audit('conversation-left', { session: lastSession }); } catch (err) { logger.debug?.(`leaving ${lastSession}: ${err.message}`); }
    }
    pastConversations.delete(id);
    point(id);
  };
  return {
    /** Her conversation's session id ('' when there is none yet). */
    last: () => lastSession,
    setLast, wantIm, imSessions, isDotSession, retired, lean,
    /** Was this conversation told it is lean (lean above)? */
    isLean: (id) => leanIds.has(id),
    selfCheck, thinkAt, resolveLive,
    createConversation, openConversation, setSession,
  };
}

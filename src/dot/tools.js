// dsh-dot/tools: her own tools as the host is given them (taken out of core.js as it was): hands (what she gives
// her hands), say (her one way of saying something), his_ok (his yes, in his words), and her hands' ask_her, wait_for
// and done (defined in hands-wiring.js) — registered in this order. Holds no state of its own.
import { approvalKind, KINDS } from './gates.js';
import { HIS_OK_TOOL, SAY_TOOL } from '../tool-prefixes.js';
import { prompt } from '../prompts.js';
import { head } from '../cut.js';
import { isOwnerTarget } from './text.js';
import { forHim as onHisBusiness, heSpoke } from './turns.js';

/**
 * @param dot  the plugin's parts (core.js apply): ctx, audit, sessions, turns, voice, hw; read when used: hands, ledger, consent
 * → { register(scope) } — scope: the host's tools scope (ctx.inject(['tools'], …))
 */
export function createTools(dot) {
  const { ctx, audit, sessions, turns, voice, hw } = dot;
  const { say, saidText, tellHim } = voice;
  const register = (scope) => {
    scope.effect(() => scope.tools.register({
      name: 'hands',
      description: prompt('dot.hands-tool'),
      parameters: { type: 'object', properties: { device: { type: 'string', enum: ['phone', 'computer', 'web', 'host'], description: 'phone / computer：在你的那台设备上做；web：查资料，不碰设备；host：在他这台电脑本机上用命令行做（他开口要的才交）' }, do: { type: 'string', description: '要做成的事，说完整；要打的字原样写上。手上的事停在要你拿主意的地方时，这里写你的回答' }, say: { type: 'string', description: '这件事里要打给别人看的话（评论、回帖、在 App 里回人）：写你想说的意思，原话会替你写好、照着打上去' }, add: { type: 'string', description: '给正在做的那件事补一句（他又加了要求、你想起一点）：它下一步之前就看到，接着做' }, stop: { type: 'boolean', description: '手上的事不做了' }, after: { type: 'boolean', description: '接着这台设备上一件停下的事做（它停在要他来、要你定的地方，现在可以接着了）：屏幕还停在那里' } }, additionalProperties: false },
      output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v?.status === 'started' ? prompt('dot.hands.started') : v?.status === 'added' ? prompt('dot.hands.added') : v?.status === 'queued' ? prompt('dot.hands.queued', { task: v.doing?.task ?? '' }) : v?.status === 'stopped' ? prompt('dot.hands.stopped') : v?.status === 'idle' ? prompt(_a?.add ? 'dot.hands.add.idle' : 'dot.hands.idle') : `没开始：${v?.why ?? ''}` }] },
      async execute(args) {
        // Which of her things she means by stop and add. She does not say (there is one under way at a time): stop is
        // everything, add is the one under way. Once she can say which, it goes here as { thing } and nothing else changes.
        const which = undefined;
        if (args?.stop) { const open = dot.ledger.unfinished().map((e) => e.id); const t = turns.get(sessions.last()); const stopped = dot.hands.stop({ by: heSpoke(t) ? 'him' : 'her', ...which }); if (stopped && t) t.stopped = [...(t.stopped ?? []), ...open]; return { status: stopped ? 'stopped' : 'idle' }; }
        // Words her hands are to type for someone to read are hers to mean and the card's to write (say.js): they go
        // into what her hands are given, as the words to type.
        let words = '';
        if (String(args?.say ?? '').trim()) {
          try { words = await say.compose({ about: args.say, where: String(args?.do ?? '').trim() }); } catch (err) { return { status: 'failed', why: `要打的话没写出来：${err.message}` }; }
          if (!words) return { status: 'failed', why: '这句话她不想说，没有交出去' };
        }
        const given = [String(args?.do ?? '').trim(), words ? prompt('dot.hands.words', { words }).trim() : ''].filter(Boolean).join('\n');
        // One more thing for the hands at work: read between two of their steps.
        if (String(args?.add ?? '').trim()) { return dot.hands.add([String(args.add).trim(), words ? prompt('dot.hands.words', { words }).trim() : ''].filter(Boolean).join('\n'), which); }
        const device = args?.device === 'computer' ? 'computer' : args?.device === 'web' ? 'web' : args?.device === 'host' ? 'host' : 'phone';
        // Whose business this is: his (a turn his words opened, or one her hands came back to on his business) or her own.
        const t = turns.get(sessions.last());
        const forHim = onHisBusiness(t);
        // This machine is his: her hands go there on his business only, never in her own time.
        if (device === 'host' && !forHim) { audit('hands-host-refused', { session: sessions.last() }); return { status: 'failed', why: prompt('dot.hands.host.his').trim() }; }
        if (device === 'phone') hw.cancelPhoneHome();
        // Given in the turn a thing came back to: it carries on from where that one stopped — the device is as it was left.
        // Or, asked for, the last thing on that device that stopped short (his yes came in a later turn of his).
        const before = t?.by.thing ? dot.ledger.get(t.by.thing) : args?.after ? dot.ledger.recent(10).find((e) => e.device === device) : null;
        const after = before?.state === 'ended' && before.outcome !== 'done' ? `\n${prompt('dot.hands.after', { task: before.task, where: before.question ? `问过：${before.question}` : before.summary || before.detail ? `停下时说的是：${head(before.summary || before.detail, 300)}` : '没有留下话' }).trim()}` : '';
        const started = await dot.hands.start({ device, task: `${prompt(device === 'computer' ? 'dot.hands.where.computer' : device === 'web' ? 'dot.hands.where.web' : device === 'host' ? 'dot.hands.where.host' : 'dot.hands.where.phone').trim()}${given}${after}`, forHim, ...(before && after ? { after: before.id } : {}) });
        if (started?.id && t) t.opened = [...(t.opened ?? []), started.id];
        return started;
      },
    }), 'dsh-dot: hands tool');
    // Her one way of saying something to anyone (say.js). She gives what she knows that bears on it — or nothing —
    // and the words are written by a call that is only her card; what went out comes back to her as the result.
    scope.effect(() => scope.tools.register({
      name: SAY_TOOL,
      description: prompt('dot.say-tool'),
      parameters: { type: 'object', properties: { to: { type: 'string', description: '说给谁：不填就是他；别人填 user:<QQ号>，群里填 group:<群号>' }, about: { type: 'string', description: '这次要让对方知道的事，一句话；手上那件事的结果不用复述（会照记录给到），写你的看法、打算或要他做的；只是接他的话、没有要告诉他的事，就不填' }, context: { type: 'string', description: '说给别人时：对方刚说了什么、在哪说的' }, images: { type: 'array', items: { type: 'string' }, description: '要一起发的图："phone:screen"、"computer:screen"、"phone:latest"、图片网址。表情包不用填，会自己挑' } }, additionalProperties: false },
      output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v?.status === 'needs-ok' ? prompt('dot.gates.asked.her', { what: v.what ?? '' }) : v?.status === 'said' ? saidText(v) : v?.status === 'silent' ? prompt('dot.say.silent') : v?.status === 'held' ? prompt('dot.owner-interrupt') : `没说成：${v?.why ?? ''}` }] },
      async execute(args) {
        const to = String(args?.to ?? '').trim() || 'owner';
        if (isOwnerTarget(to, ctx.get('dshQq')?.owner)) return tellHim(turns.get(sessions.last()), { about: args?.about, images: args?.images });
        // Someone she does not talk with, a group gone quiet, a file off her devices: his yes first (gates.js).
        const why = ctx.get('dshQq')?.gateFor?.({ to, images: args?.images ?? [] });
        if (why) {
          const k = approvalKind('qq_send', why);
          if (!dot.consent.allows({ kind: k.kind, subject: k.subject })) { dot.consent.ask(k); audit('consent-asked', { session: sessions.last(), kind: k.kind, to }); return { status: 'needs-ok', what: k.what }; }
          audit('consent-used', { session: sessions.last(), kind: k.kind, to });
        }
        return say.speak({ to, about: args?.about, context: args?.context, images: args?.images });
      },
    }), 'dsh-dot: say tool');
    // His yes, in his own words (dot.consent.js): only in a turn his words opened, kept with the kind of thing it is for.
    scope.effect(() => scope.tools.register({
      name: HIS_OK_TOOL,
      description: prompt('dot.gates.ok-tool'),
      parameters: { type: 'object', properties: { kind: { type: 'string', enum: Object.keys(KINDS), description: Object.entries(KINDS).map(([k, v]) => `${k}：${v}`).join('；') }, always: { type: 'boolean', description: '他明说以后这种都行才填 true' } }, required: ['kind'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: prompt(v?.status === 'ok' ? 'dot.gates.ok' : 'dot.gates.ok.refused', { what: KINDS[v?.kind] ?? '' }) }] },
      async execute(args) {
        const t = turns.get(sessions.last());
        const kind = String(args?.kind ?? '');
        if (!KINDS[kind] || !heSpoke(t)) { audit('consent-refused', { session: sessions.last(), kind }); return { status: 'refused', kind }; }
        // A yes answers a question: the newest thing of this kind that stopped to ask him, or that she was told to ask
        // him about. With none waiting there is nothing for it to be a yes to.
        const since = Date.now() - 6 * 3600_000;
        const waiting = [
          ...dot.ledger.recent(10).filter((e) => e.outcome === 'stuck' && e.ask?.for === 'him' && e.ask.tier !== 'him' && e.ask.kind === kind && !e.askSettled && (e.endedAt ?? 0) >= since).map((e) => ({ at: e.endedAt, subject: e.ask.subject ?? '' })),
          ...dot.consent.asking().filter((a) => a.kind === kind).map((a) => ({ at: a.at, subject: a.subject ?? '' })),
        ].sort((a, b) => b.at - a.at)[0];
        // Nothing has stopped to ask him: he asked for this himself, in the words of this turn. That counts as his yes
        // (11-23, his decision) — for the next thing of this kind, once. Whether his words do ask for it is her reading:
        // the code has his words on record with it, not a check of them — except for a step that reaches someone else,
        // where the one it reaches has to be in those words (dot.consent.js, 11-25).
        if (!waiting) {
          const g = dot.consent.grant({ kind, words: t.hisWords ?? '', ahead: true });
          audit('consent-granted', { session: sessions.last(), kind, subject: '', always: false, ahead: true, words: g.words.slice(0, 80) });
          return { status: 'ok', kind };
        }
        const g = dot.consent.grant({ kind, subject: waiting.subject, words: t.hisWords ?? '', always: Boolean(args?.always) });
        audit('consent-granted', { session: sessions.last(), kind, subject: g.subject, always: g.always });
        return { status: 'ok', kind };
      },
    }), 'dsh-dot: his yes');
    scope.effect(() => scope.tools.register(hw.askTool()), 'dsh-dot: hands ask tool');
    scope.effect(() => scope.tools.register(hw.waitTool()), 'dsh-dot: hands wait tool');
    scope.effect(() => scope.tools.register(hw.doneTool()), 'dsh-dot: hands done tool');
  };
  return { register };
}

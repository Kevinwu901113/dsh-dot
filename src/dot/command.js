// dsh-dot/command: /dot — his commands on her (stop what is in her hands, the doctor, her know-how book, the prompts
// page, memory's own) and her status. What the status says of her state is given by dot (core.js).
import { overrideNotes, rebase } from '../prompts.js';

/**
 * @param deps.stop     () => text — stop what is in her hands, on his word
 * @param deps.memory   () => dsh-dot/memory's service (its /dot memory and /dot people) or null
 * @param deps.howto    the know-how book (howto.js)
 * @param deps.nightcheck async ({ apply }) => text — her notes held against the records (nightcheck.js)
 * @param deps.checkup  checkup.js
 * @param deps.prompts  the prompts page ({ start, stop })
 * @param deps.status   async (arg) => text — her status ('test' also sends a test message to his IM)
 * @param deps.replay   async (file, times) => text — a kept request of her conversation sent again, only written down (replay.js)
 */
export function dotCommand({ stop, memory, howto, checkup, prompts, status, nightcheck = async () => 'nightcheck is not available', voicetest = async () => 'voicetest is not available', replay = async () => 'replay is not available' }) {
  const ok = (text) => ({ kind: 'success', text });
  const book = (app) => {
    if (app) {
      const tasks = howto.tasks(app).map((t) => `${t.task} done ${t.done}/${t.runs}${t.steps.length ? `, steps ${t.steps.join(' → ')}` : ''}${t.tokens.length ? `, tokens ${t.tokens.map((n) => `${Math.round(n / 1000)}k`).join(' → ')}` : ''}`).join(' · ');
      const runs = howto.recent(app, 10).map((r) => `${r.steps}${r.errors ? `(${r.errors}✗)` : ''}${r.outcome && r.outcome !== 'done' ? `[${r.outcome}]` : ''}`).join(' → ');
      return `${app}\n${howto.notes(app) || '(no notes yet)'}${howto.needsReview(app) ? '\n(old notes: read over before they are given again)' : ''}\n\ntasks, oldest first: ${tasks || '-'}\nlast runs: ${runs || '-'}`;
    }
    const rows = howto.apps().map((a) => `${a}: ${howto.recent(a, 10).map((x) => x.steps).join(' → ') || '-'}${howto.notes(a) ? ' · notes' : ''}`);
    return `steps per run, oldest first (notes in ${howto.dir})\n${rows.join('\n') || '(nothing yet)'}`;
  };
  return {
    name: 'dot',
    description: 'dot status; "doctor" checks this machine for her phone and computer (virtualization, disk, memory, ports, downloads); "test" sends a test message to your IM; "memory" / "people" show what she remembers; "prompts" opens the prompt and persona editor page; "howto" shows what she has learned in each app and how many steps it takes her ("howto <app>" her notes for it); "replay <file|latest> [n]" sends a kept request of her conversation again n times and only writes down what came back (dot.replayKeep)',
    input: { hint: '[stop | doctor | test | howto [<app>] | nightcheck [apply] | replay <file|latest> [n] | prompts [stop | rebase <id> [--reset]] | memory [now|diary|handoff|recall [backend|key|model|rerank|mirror|rebuild|test]] | people [approve|drop <id> | forget <name>]]' },
    handler: async ({ rawInput }) => {
      const arg = String(rawInput ?? '').trim();
      if (arg === 'stop') return ok(stop());
      // /dot memory … and /dot people … belong to dsh-dot/memory.
      if (/^(memory|people)\b/.test(arg)) { const mem = memory(); return ok(mem ? await mem.command(arg) : 'dsh-dot/memory is not loaded'); }
      if (/^howto\b/.test(arg)) return ok(book(arg.slice(5).trim()));
      // The voice run again on inputs kept in a file (for measuring what it says of the same facts); nothing is sent.
      const vt = /^voicetest (\S+)$/.exec(arg);
      if (vt) { try { return ok(await voicetest(vt[1])); } catch (err) { return ok(`voicetest failed: ${err.message}`); } }
      // A kept request of her conversation sent again (how she decides, measured): nothing is carried out or sent.
      const rp = /^replay (\S+)(?: (\d+))?$/.exec(arg);
      if (rp) { try { return ok(await replay(rp[1], rp[2])); } catch (err) { return ok(`replay failed: ${err.message}`); } }
      // Her notes held against the records: what would change (nothing is changed), or — apply — the changes of the last check.
      if (/^nightcheck\b/.test(arg)) { try { return ok(await nightcheck({ apply: /\bapply$/.test(arg) })); } catch (err) { return ok(`nightcheck failed: ${err.message}`); } }
      if (arg === 'doctor') { try { return ok(await checkup.text()); } catch (err) { return ok(`doctor failed: ${err.message}`); } }
      if (arg === 'prompts stop') return ok((await prompts.stop()) ? 'prompts page stopped' : 'prompts page was not running');
      const rb = /^prompts rebase (\S+)( --reset)?$/.exec(arg);
      if (rb) { try { return ok(rebase(rb[1], Boolean(rb[2]))); } catch (err) { return ok(err.message); } }
      if (arg === 'prompts') {
        try { return { kind: 'success', text: [`提示词和人设页面：${await prompts.start()}\n（只在本机打开；/dot prompts stop 关掉）`, ...overrideNotes().map((n) => `提示词覆盖 ${n}（/dot prompts rebase <id>）`)].join('\n') }; } catch (err) { return { kind: 'success', text: `prompts page failed: ${err.message}` }; }
      }
      return ok(await status(arg));
    },
  };
}

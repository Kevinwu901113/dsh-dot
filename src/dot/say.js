// dsh-dot/say: the one way her words leave her.
//
// She thinks in her conversation — with her tools, her rules, what she remembers — and what she writes there is
// read by no one. What she says is written by a call of its own that is nothing but her: the system prompt is her
// card, there are no tools, no working rules, no clock. It is given what a person has in front of them when they
// type a line: the last of the conversation, what she is in the middle of, what she knows that bears on it (said by
// her thinking, in a line, or nothing), and the stickers she has. What it writes is what goes out — text, a sticker
// or a face by a marker on a line of its own, or nothing at all ([不回]).
//
// Until 11-21 her words left by eight ways (the answer of a turn of his, qq_send, the QQ backend's own send, a
// scheduled turn, the desktop, another IM, what her hands typed, a handed-back line), checked four different ways
// and held back for his unread words by three. Here it is one: written by speak(), checked once, held once when he
// has said something she has not read, sent by whoever carries it to where it is going.
//
// What she is in the middle of comes from the code (her hands' own state), never from what her thinking says it
// is doing: "我去翻翻" with nothing in her hands was 19 of 25 replays, and a call told only "这就去找" will say so.
import { prompt } from '../prompts.js';

const STICKER = /\[表情包?\s*sticker:([a-f0-9]{6,12})[^\]]*\]/gi;
const FACE = /\[face:(\d{1,3})\]/gi;
const SILENT = /^\[\s*不回\s*\]$/;
const FENCE = /^```[\w-]*$/;
/** A line break inside one message: everything on the way out counts a message a line, so it travels as this and is put back where it is sent (qq.js). */
export const WITHIN = '\u2028';
/** One message as it is read: its line breaks back in place. */
export const unfold = (text) => String(text ?? '').replaceAll(WITHIN, '\n');
/** A line that is only a marker gone wrong ("[表情包 [sticker:…"): nothing to say and nothing to send. */
const BROKEN = /^\[[^\]]*(sticker|face|表情)[\s\S]*$/i;

/**
 * What the call wrote, as what goes out: { lines, images, silent }. A sticker she does not have is dropped; a
 * marker inside a line is taken out of it; "[不回]" alone is silence, beside other lines it is nothing.
 * @param {string} text
 * @param {{ has?: (id: string) => boolean, pictures?: boolean }} o - which stickers are hers; false: this place takes words only
 */
export function parseSaid(text, { has = () => true, pictures = true } = {}) {
  const lines = [], images = [];
  let silent = false, block = null;
  for (const raw of String(text ?? '').split('\n')) {
    // Several lines that are one message (a report, a list, a table) stand between two fence lines: they go out as
    // one bubble, as written. Everything else is a line a bubble.
    if (FENCE.test(raw.trim())) { if (block) { const body = block.join('\n').replace(/^\n+|\n+$/g, ''); if (body.trim()) lines.push(body.replace(/\n/g, WITHIN)); block = null; } else block = []; continue; }
    if (block) { block.push(raw.replace(/\s+$/, '')); continue; }
    let line = raw.trim();
    if (!line) continue;
    if (SILENT.test(line)) { silent = true; continue; }
    line = line.replace(STICKER, (_m, id) => { if (pictures && has(id)) images.push(`sticker:${id}`); return ''; });
    line = line.replace(FACE, (_m, n) => { if (pictures) images.push(`face:${Number(n)}`); return ''; }).trim();
    if (!line || BROKEN.test(line)) continue;
    lines.push(line);
  }
  if (block) { const body = block.join('\n').replace(/^\n+|\n+$/g, ''); if (body.trim()) lines.push(body.replace(/\n/g, WITHIN)); } // a fence never closed: what follows it is the block
  return { lines, images, silent: silent && !lines.length && !images.length };
}

/**
 * What the call is given, as one message: her stickers (when this place takes pictures), the last of the
 * conversation, what she is in the middle of, what she knows, and what is asked of her now.
 * @param {object} o
 * @param {{ who: 'owner' | 'her', text: string }[]} [o.dialogue] - the conversation with him, oldest first
 * @param {{ id: string, note: string }[] | null} [o.stickers] - hers; null: no pictures here
 * @param {string} [o.state] - what is in her hands, as the code has it
 * @param {string} [o.about] - what she knows that bears on this, in her thinking's words ('' = nothing)
 * @param {string} [o.where] - where the words go when not to him over QQ (a comment box, a group …)
 * @param {boolean} [o.unprompted] - she speaks first: nothing of his is waiting for an answer
 */
/**
 * What is written, made fit to go out: in a line of chat what stands in brackets is a stage direction or a thought and
 * is not said (in a block she fenced, brackets are part of what she wrote); at most one sticker. How much she says is
 * hers to judge (11-23: no count here — a list he asked for lost its last line to one).
 */
export function tidy(parsed) {
  const lines = parsed.lines.map((l) => (l.includes(WITHIN) ? l : l.replace(/[（(][^（()）]*[)）]/g, '').trim())).filter(Boolean);
  let sticker = false;
  const images = parsed.images.filter((i) => (!String(i).startsWith('sticker:') ? true : sticker ? false : (sticker = true)));
  return { lines, images, silent: parsed.silent || (!lines.length && !images.length) };
}

export function sayInput({ dialogue = [], stickers = null, facts = [], about = '', where = '', unprompted = false } = {}) {
  const parts = [];
  if (stickers) parts.push(stickers.length ? prompt('dot.say.stickers', { list: stickers.map((s) => `sticker:${s.id} ${s.note || '没起名'}`).join('；'), faces: prompt('dot.say.faces').trim() }) : prompt('dot.say.stickers.none', { faces: prompt('dot.say.faces').trim() }));
  const said = dialogue.filter((l) => String(l.text ?? '').trim()).map((l) => `${l.who === 'her' ? '你' : '他'}：${String(l.text).replace(/\s*\n+\s*/g, ' / ')}`);
  if (said.length && !where) parts.push(`${prompt(unprompted ? 'dot.say.dialogue.unprompted' : 'dot.say.dialogue').trim()}\n${said.join('\n')}`);
  const notes = [];
  for (const f of [].concat(facts ?? []).map((x) => String(x ?? '').trim()).filter(Boolean)) notes.push(prompt('dot.say.fact', { fact: f }).trim());
  if (String(about).trim()) notes.push(prompt('dot.say.about', { about: String(about).trim() }).trim());
  notes.push(prompt(where ? 'dot.say.end.where' : unprompted ? 'dot.say.end.unprompted' : 'dot.say.end', { where }).trim());
  parts.push(notes.join('\n'));
  return parts.map((p) => p.trim()).join('\n\n');
}

/**
 * A report from the book, to be said in her voice. What is said is the code's: `must` are plain sentences made from
 * the book (ledger.js) — complete, true, and sayable as they are; `may` is the thing's detail, hers to give when it is
 * what he asked for. How it is said is the card's. The call is given his last words and these sentences, not the
 * conversation: 11-24, measured on one input — written as "the next line of this conversation" with the fact beside it,
 * the voice said a thing just begun was done in 5 of 10 tries (9 of 10 at worst, whatever the wording of the fact);
 * asked to say a given sentence its own way, without the conversation, it added something in 3 of 160.
 */
export function reportInput({ his = '', must = [], may = [], about = '', stickers = null, unprompted = false } = {}) {
  const parts = [];
  if (stickers) parts.push(stickers.length ? prompt('dot.say.stickers', { list: stickers.map((x) => `sticker:${x.id} ${x.note || '没起名'}`).join('；'), faces: prompt('dot.say.faces').trim() }) : prompt('dot.say.stickers.none', { faces: prompt('dot.say.faces').trim() }));
  const notes = [String(his).trim() && !unprompted ? prompt('dot.say.report.his', { his: String(his).trim().replace(/\s*\n+\s*/g, ' / ') }).trim() : prompt('dot.say.report.unprompted').trim()];
  if (String(about).trim()) notes.push(prompt('dot.say.report.about', { about: String(about).trim() }).trim());
  notes.push(prompt('dot.say.report').trim());
  if (may.length) notes.push(prompt('dot.say.report.may').trim());
  notes.push(`【${must.join('\n')}】`);
  if (may.length) notes.push(`〔${may.join('\n')}〕`);
  parts.push(notes.join('\n'));
  return parts.map((p) => p.trim()).join('\n\n');
}

/** A figure in what is written (a time, a count, a hash, a version): anything with a digit in it. */
const FIGURE = /[A-Za-z0-9._:\/-]*\d[A-Za-z0-9._:\/-]*/g;
/**
 * What code can hold a report against its sentences: every figure in it is one it was given (in the sentences, the
 * detail, his words or hers). → the figures that are not. Wording cannot be checked by code — and a model asked to
 * judge it missed 14 of 50 claims of "done" (11-24) — so this is the part that is checked, and no more is claimed.
 */
export function unfounded(lines, given) {
  const strip = (f) => f.replace(/^[._:\/-]+|[._:\/-]+$/g, '');
  const src = (String(given ?? '').toLowerCase().match(FIGURE) ?? []).map(strip);
  const out = [];
  for (const f of unfold(lines.join('\n')).toLowerCase().match(FIGURE) ?? []) {
    const x = strip(f);
    // The same figure, or a good part of a longer one (the head of a hash): a "2" inside "2c7" is not it.
    if (x && !src.includes(x) && !(x.length >= 4 && src.some((g) => g.includes(x))) && !out.includes(x)) out.push(x);
  }
  return out;
}

/**
 * Of things still being done, what she writes is not the progress. Said in her own words, a thing just begun was told
 * as done in 21 of 80 tries (11-24, the task: send a text), and nothing read afterwards could tell which: a list of
 * surface marks made from one day's replies caught 23 of 38 on the next day's, the same model asked about it 9 of 38
 * (shown the facts), 17 of 38 (not shown them), 30 of 38 with 14 of 62 wrongly caught. So the progress is not hers to
 * word here: it is one of the sayings she has for this (dot.plain.opened.sayings — hers, each read once when it went
 * into the file, none read again), or the book's own sentence when there is none; she picks the saying, and writes
 * only the line before it, which answers what he said (2 of 80 said more than that; picked: 80 of 80).
 */
export function leadInput({ his = '', sayings = [], status = [], about = '', stickers = null } = {}) {
  const parts = [];
  if (stickers) parts.push(stickers.length ? prompt('dot.say.stickers', { list: stickers.map((x) => `sticker:${x.id} ${x.note || '没起名'}`).join('；'), faces: prompt('dot.say.faces').trim() }) : prompt('dot.say.stickers.none', { faces: prompt('dot.say.faces').trim() }));
  const notes = [prompt('dot.say.report.his', { his: String(his).trim().replace(/\s*\n+\s*/g, ' / ') }).trim()];
  if (String(about).trim()) notes.push(prompt('dot.say.report.about', { about: String(about).trim() }).trim());
  notes.push(sayings.length ? prompt('dot.say.lead.pick', { list: sayings.map((x, i) => `${i + 1}. ${x}`).join('\n') }).trim() : prompt('dot.say.lead', { status: status.join(' ') }).trim());
  parts.push(notes.join('\n'));
  return parts.map((p) => p.trim()).join('\n\n');
}
/** What came back for leadInput: the number she picked (-1: none that is one of n), and the rest, which is her line. */
export function parseLead(text, n) {
  let pick = -1;
  const rest = String(text ?? '').split('\n').filter((l) => { const m = /^\s*#\s*(\d+)\s*$/.exec(l); if (!m) return true; const k = Number(m[1]) - 1; if (pick < 0 && k >= 0 && k < n) pick = k; return false; }).join('\n');
  return { pick, rest };
}

/**
 * @param {object} deps
 * @param {() => string} deps.card - her card, as she reads it ('' = none: nothing can be said)
 * @param {(o: { system: string, text: string }) => Promise<string>} deps.call - one model call: that system, that message, no tools
 * @param {(n: number) => { who: string, text: string }[]} deps.recent - the last lines between her and him
 * @param {() => string} deps.state - what is in her hands right now, as a line
 * @param {() => { id: string, note: string }[]} deps.stickers - the stickers she has
 * @param {(text: string) => { lines: string[], hits: string[] }} deps.check - her card's check of what she says
 * @param {(to: string) => boolean} deps.unread - has the one this goes to said something she has not read?
 * @param {(o: { to: string, text: string, images: string[] }) => Promise<{ said?: string[], images?: string[], interrupted?: boolean, unsent?: string[] }>} deps.send
 */
export function createSay({ card, call, recent, stickers, check, unread = () => false, send, audit = () => {}, lines: historyLines = 12 }) {
  /** Write it: the card and what is in front of her. A line the check catches is written once more; the second goes as it is. */
  async function write(input, { has, pictures, pre = (t) => t }) {
    const system = String(card() ?? '').trim();
    if (!system) throw new Error('no persona card');
    let out = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const parsed = tidy(parseSaid(pre(await call({ system, text: input })), { has, pictures }));
      // Her card's check reads chat a line at a time; a block she fenced goes as she wrote it.
      const lines = [], hits = [];
      for (const l of parsed.lines) { if (l.includes(WITHIN)) { lines.push(l); continue; } const c = check(l); lines.push(...c.lines); hits.push(...c.hits); }
      out = { ...parsed, lines, silent: parsed.silent || (!lines.length && !parsed.images.length) };
      if (!hits.length) break;
      audit('say-rewritten', { hits, attempt });
    }
    return out;
  }
  return {
    /**
     * Say something to someone. → { status: 'said', said, images, interrupted?, unsent? } · 'silent' (she chose not
     * to) · 'held' (he has said something she has not read: nothing went out, she reads him first) · 'failed'.
     * @param {object} o
     * @param {string} [o.to] - 'owner' (default), user:<n>, group:<n>
     * @param {string} [o.about] - what she knows that bears on it
     * @param {string[]} [o.images] - pictures her thinking wants sent with it (a screenshot, a file): not the call's to choose
     * @param {boolean} [o.unprompted] - nothing of his is waiting for an answer
     * @param {{ his: string, must: string[], may?: string[], underway?: boolean, sayings?: string[] }} [o.plan] - a report from the book: said from these sentences (reportInput), or, of things just begun, her line and then a saying of hers (leadInput)
     * @param {string} [o.context] - for someone else than him: what they said, where
     */
    async speak({ to = 'owner', about = '', facts = [], plan = null, images = [], unprompted = false, context = '' } = {}) {
      const his = to === 'owner';
      if (unread(to)) return { status: 'held' };
      try {
        const mine = stickers();
        const has = (id) => mine.some((s) => s.id === id);
        let out;
        if (his && plan?.underway && plan.must?.length) {
          // Things just begun: her line to what he said, then the progress in a saying of hers or the book's sentence.
          const sayings = plan.sayings ?? [];
          let pick = -1;
          out = await write(leadInput({ his: plan.his, sayings, status: plan.must, about, stickers: mine }), { has, pictures: true, pre: (t) => { const r = parseLead(t, sayings.length); pick = r.pick; return r.rest; } });
          if (sayings.length && pick < 0) pick = 0;
          const status = tidy(parseSaid((sayings.length ? sayings[pick].split(' / ') : plan.must).join('\n'), { has, pictures: false })).lines;
          const lead = out.silent ? [] : out.lines.filter((l) => !status.includes(l));
          audit('say-lead', { lead: lead.length, pick, of: sayings.length });
          out = { ...out, lines: [...lead, ...status], silent: false };
        } else if (his && plan?.must?.length) {
          // A report: the book's sentences in her voice. A figure nobody gave it is written once more; the second
          // time the sentences go as they are — plain, and true.
          const input = reportInput({ his: plan.his, must: plan.must, may: plan.may ?? [], about, stickers: mine, unprompted });
          const given = [plan.his, about, ...plan.must, ...(plan.may ?? [])].join('\n');
          for (let attempt = 0; attempt < 2; attempt++) {
            out = await write(input, { has, pictures: true });
            const extra = out.silent ? ['(nothing)'] : unfounded(out.lines, given);
            if (!extra.length) break;
            audit('say-unfounded', { extra: extra.slice(0, 8), attempt });
            if (attempt === 1) { out = tidy(parseSaid(plan.must.join('\n'), { has, pictures: false })); audit('say-plain', { lines: out.lines.length }); }
          }
        } else {
          const input = sayInput({ dialogue: his ? recent(historyLines) : [], stickers: mine, facts: his ? facts : [], about: [context, about].filter(Boolean).join('\n'), unprompted });
          out = await write(input, { has, pictures: true });
        }
        const pictures = [...out.images, ...[].concat(images ?? []).filter(Boolean)];
        if (out.silent && !pictures.length) { audit('say-silent', { to }); return { status: 'silent' }; }
        if (unread(to)) { audit('say-held', { to, lines: out.lines.length }); return { status: 'held' }; }
        const r = await send({ to, text: out.lines.join('\n'), images: pictures });
        audit('said', { to, lines: (r?.said ?? out.lines).length, images: (r?.images ?? pictures).length, ...(r?.interrupted ? { interrupted: true } : {}) });
        return { status: 'said', said: r?.said ?? out.lines, images: r?.images ?? pictures, ...(r?.interrupted ? { interrupted: true, unsent: r.unsent ?? [] } : {}) };
      } catch (err) { audit('say-failed', { to, error: String(err?.message ?? err).slice(0, 200) }); return { status: 'failed', why: String(err?.message ?? err) }; }
    },
    /** Words for her hands to type somewhere (a comment, a post, a reply in an app): the text only, '' when she would rather not. */
    async compose({ about = '', where = '' } = {}) {
      const out = await write(sayInput({ about, where: where || '手机上的一个输入框' }), { has: () => false, pictures: false });
      return out.silent ? '' : unfold(out.lines.join('\n'));
    },
  };
}

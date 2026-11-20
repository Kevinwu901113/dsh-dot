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
  let silent = false;
  for (const raw of String(text ?? '').split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    if (SILENT.test(line)) { silent = true; continue; }
    line = line.replace(STICKER, (_m, id) => { if (pictures && has(id)) images.push(`sticker:${id}`); return ''; });
    line = line.replace(FACE, (_m, n) => { if (pictures) images.push(`face:${Number(n)}`); return ''; }).trim();
    if (!line || BROKEN.test(line)) continue;
    lines.push(line);
  }
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
export function sayInput({ dialogue = [], stickers = null, state = '', about = '', where = '', unprompted = false } = {}) {
  const parts = [];
  if (stickers) parts.push(stickers.length ? prompt('dot.say.stickers', { list: stickers.map((s) => `sticker:${s.id} ${s.note || '没起名'}`).join('；'), faces: prompt('dot.say.faces').trim() }) : prompt('dot.say.stickers.none', { faces: prompt('dot.say.faces').trim() }));
  const said = dialogue.filter((l) => String(l.text ?? '').trim()).map((l) => `${l.who === 'her' ? '你' : '他'}：${String(l.text).replace(/\s*\n+\s*/g, ' / ')}`);
  if (said.length && !where) parts.push(`${prompt(unprompted ? 'dot.say.dialogue.unprompted' : 'dot.say.dialogue').trim()}\n${said.join('\n')}`);
  const notes = [];
  if (state) notes.push(prompt('dot.say.state', { state }).trim());
  if (String(about).trim()) notes.push(prompt('dot.say.about', { about: String(about).trim() }).trim());
  notes.push(prompt(where ? 'dot.say.end.where' : unprompted ? 'dot.say.end.unprompted' : 'dot.say.end', { where }).trim());
  parts.push(notes.join('\n'));
  return parts.map((p) => p.trim()).join('\n\n');
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
export function createSay({ card, call, recent, state, stickers, check, unread = () => false, send, audit = () => {}, lines: historyLines = 12 }) {
  /** Write it: the card and what is in front of her. A line the check catches is written once more; the second goes as it is. */
  async function write(input, { has, pictures }) {
    const system = String(card() ?? '').trim();
    if (!system) throw new Error('no persona card');
    let out = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const parsed = parseSaid(await call({ system, text: input }), { has, pictures });
      const checked = check(parsed.lines.join('\n'));
      out = { ...parsed, lines: checked.lines, silent: parsed.silent || (!checked.lines.length && !parsed.images.length) };
      if (!checked.hits.length) break;
      audit('say-rewritten', { hits: checked.hits, attempt });
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
     * @param {string} [o.context] - for someone else than him: what they said, where
     */
    async speak({ to = 'owner', about = '', images = [], unprompted = false, context = '' } = {}) {
      const his = to === 'owner';
      if (unread(to)) return { status: 'held' };
      try {
        const mine = stickers();
        const input = sayInput({ dialogue: his ? recent(historyLines) : [], stickers: mine, state: his ? state() : '', about: [context, about].filter(Boolean).join('\n'), unprompted });
        const out = await write(input, { has: (id) => mine.some((s) => s.id === id), pictures: true });
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
      return out.silent ? '' : out.lines.join('\n');
    },
  };
}

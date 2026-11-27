// Her sticker collection: images people send her that QQ marks as stickers (image sub_type 1), and
// ones she keeps herself (qq_sticker_keep: saved on her phone, or a web image). Files live in
// $DSH_HOME/stickers/<id>.img (QQ's URLs expire), the list in $DSH_HOME/dsh-qq-stickers.json.
// `onChange` fires when the set of saved ones changes (sticker-sync.js mirrors them to her phone).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { prompt } from '../prompts.js';

const MAX = 300;
export const STICKER_MAX_BYTES = 4 * 1024 * 1024;

/**
 * An image segment's data → is it a sticker? NapCat and SnowLuma both set sub_type 1 on 表情包; QQ's
 * own big stickers (mface) come as images whose summary is a short bracketed name — `[？]`, `[doge]`
 * — without the word 表情. A plain picture's `[图片]` is not one.
 */
export const isSticker = (d) => {
  const summary = String(d?.summary ?? '').trim();
  return String(d?.sub_type ?? '') === '1' || /表情/.test(summary) || (/^\[.{1,8}\]$/u.test(summary) && !/^\[(图片|image|picture|photo)\]$/i.test(summary));
};

export function createStickers(file, { fetch = globalThis.fetch, onChange = () => {} } = {}) {
  const dir = join(dirname(file), 'stickers');
  let list = [];
  try { list = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  const save = () => { try { mkdirSync(dir, { recursive: true }); writeFileSync(file, JSON.stringify(list)); } catch {} };
  const path = (id) => join(dir, `${id}.img`);
  const digest = (buf) => createHash('sha1').update(buf).digest('hex');
  const sumOf = (id) => { try { return digest(readFileSync(path(id))); } catch { return ''; } };
  const own = (id) => { let s = list.find((x) => x.id === id); for (let k = 0; s?.same && k < 4; k++) s = list.find((x) => x.id === s.same) ?? s; return s; };
  const add = (entry) => {
    list.push(entry);
    let gone = false;
    while (list.length > MAX) { const old = list.shift(); gone ||= Boolean(old.saved); try { rmSync(path(old.id), { force: true }); } catch {} }
    save();
    if (gone) onChange();
  };
  const stickers = {
    list: () => list,
    count: () => list.filter((s) => s.saved).length,
    get: (id) => list.find((s) => s.id === id),
    path,
    /** Bytes of a kept sticker, or null (one that turned out to be the same picture as another: that one's). */
    read: (id) => { const s = own(id); if (!s?.saved) return null; try { return readFileSync(path(s.id)); } catch { return null; } },
    /** The entry an id stands for: itself, or the one it is the same picture as. */
    own,
    /**
     * A sticker seen in a message: noted by its QQ file name (one entry per picture), downloaded
     * once in the background. Returns { id, isNew }.
     */
    note({ file: name, url, from }) {
      const key = String(name || url || '').replace(/[?#].*$/, '');
      if (!key || !url) return null;
      const id = createHash('sha1').update(key).digest('hex').slice(0, 10);
      let s = stickers.get(id);
      if (s) { s.seen = (s.seen ?? 1) + 1; if (!s.saved) s.url = url; save(); return { id, isNew: false }; }
      s = { id, url, from: String(from ?? ''), at: new Date().toISOString().slice(0, 10), seen: 1, saved: false };
      add(s);
      return { id, isNew: true };
    },
    /** Download a noted sticker (its QQ URL) into the collection; true when it is there. */
    async fetch(id) {
      const s = stickers.get(id);
      if (!s) return false;
      if (s.saved && existsSync(path(id))) return true;
      if (!s.url) return false;
      const res = await fetch(s.url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > STICKER_MAX_BYTES) throw new Error(`${buf.length} bytes`);
      // The same picture sent again under another QQ file name is the one she has (11-27: two of nine were twice).
      const sum = digest(buf);
      const twin = list.find((x) => x.saved && x.id !== id && !x.same && (x.sum ?? sumOf(x.id)) === sum);
      if (twin) { twin.seen = (twin.seen ?? 1) + 1; twin.sum = sum; s.same = twin.id; delete s.url; save(); return true; }
      mkdirSync(dir, { recursive: true }); writeFileSync(path(id), buf);
      s.saved = true; s.sum = sum; delete s.url; save();
      onChange();
      return true;
    },
    /** Keep an image she chose herself (bytes): one entry per picture (by content). Returns { id, isNew }. */
    keep(buf, { from = '自己存的', note = '' } = {}) {
      if (!buf?.length || buf.length > STICKER_MAX_BYTES) throw new Error(`sticker must be 1 byte – ${STICKER_MAX_BYTES / 1048576} MB`);
      const id = createHash('sha1').update(buf).digest('hex').slice(0, 10);
      const s = stickers.get(id) ?? list.find((x) => x.saved && !x.same && (x.sum ?? sumOf(x.id)) === digest(buf));
      if (s) { if (note) s.note = String(note).slice(0, 40); s.picked = true; s.pickedAt = Date.now(); save(); return { id: s.id, isNew: false }; }
      mkdirSync(dir, { recursive: true }); writeFileSync(path(id), buf);
      add({ id, from: String(from), note: String(note).slice(0, 40), at: new Date().toISOString().slice(0, 10), seen: 1, saved: true, picked: true, pickedAt: Date.now(), sum: digest(buf) });
      onChange();
      return { id, isNew: true };
    },
    /**
     * One she has already (sent to her, kept on its own) that she picks as hers: her name for it, if she gives one,
     * and that she picked it — the ones she picked are shown first when her words are written. Returns { id, isNew }.
     */
    async pick(ref, note = '') {
      const s = own(String(ref ?? '').toLowerCase());
      if (!s) throw new Error(`no sticker ${ref} in her collection (ids come from [表情包 sticker:…] in messages)`);
      if (!s.saved && !(await stickers.fetch(s.id).catch(() => false))) throw new Error(`sticker ${ref} could not be downloaded`);
      const kept = own(s.id);
      if (note) kept.note = String(note).slice(0, 40);
      kept.picked = true; kept.pickedAt = Date.now(); save();
      return { id: kept.id, isNew: false };
    },
    /**
     * The ones she has (what the call that writes her words is shown — src/dot/say.js), at most `n`: the ones she
     * picked (the last picked first), then the ones with a name, then the rest (newest first). Not only the newest `n` (11-27: past
     * twelve, the old favourites fell off the list). [{ id, note, looks, from, seen, picked }]
     */
    saved(n = 12) {
      const have = list.filter((s) => s.saved && !s.same);
      const rank = (s) => (s.picked ? 0 : s.note ? 1 : 2);
      return have.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || (b.s.pickedAt ?? 0) - (a.s.pickedAt ?? 0) || b.i - a.i).slice(0, n)
        .map(({ s }) => ({ id: s.id, note: s.note || '', looks: s.looks || '', from: s.from || '', seen: s.seen ?? 1, picked: Boolean(s.picked) }));
    },
    /** One line for her prompt: the same ones. */
    prompt(n = 12) {
      const got = stickers.saved(n);
      return got.length ? prompt('qq.stickers', { list: got.map((s) => `${s.id}（${s.note || `${s.from} 发的`}${s.looks ? `，画面：${s.looks}` : ''}${s.seen > 1 ? ` ×${s.seen}` : ''}）`).join('、') }) : '';
    },
  };
  return stickers;
}

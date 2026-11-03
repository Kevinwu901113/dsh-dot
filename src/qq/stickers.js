// Her sticker collection: images people send her that QQ marks as stickers (image sub_type 1), and
// ones she keeps herself (qq_sticker_keep: saved on her phone, or a web image). Files live in
// $DSH_HOME/stickers/<id>.img (QQ's URLs expire), the list in $DSH_HOME/dsh-qq-stickers.json.
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

export function createStickers(file, { fetch = globalThis.fetch } = {}) {
  const dir = join(dirname(file), 'stickers');
  let list = [];
  try { list = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  const save = () => { try { mkdirSync(dir, { recursive: true }); writeFileSync(file, JSON.stringify(list)); } catch {} };
  const path = (id) => join(dir, `${id}.img`);
  const add = (entry) => {
    list.push(entry);
    while (list.length > MAX) { const old = list.shift(); try { rmSync(path(old.id), { force: true }); } catch {} }
    save();
  };
  const stickers = {
    list: () => list,
    count: () => list.filter((s) => s.saved).length,
    get: (id) => list.find((s) => s.id === id),
    path,
    /** Bytes of a kept sticker, or null. */
    read: (id) => { const s = stickers.get(id); if (!s?.saved) return null; try { return readFileSync(path(id)); } catch { return null; } },
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
      mkdirSync(dir, { recursive: true }); writeFileSync(path(id), buf);
      s.saved = true; delete s.url; save();
      return true;
    },
    /** Keep an image she chose herself (bytes): one entry per picture (by content). Returns { id, isNew }. */
    keep(buf, { from = '自己存的', note = '' } = {}) {
      if (!buf?.length || buf.length > STICKER_MAX_BYTES) throw new Error(`sticker must be 1 byte – ${STICKER_MAX_BYTES / 1048576} MB`);
      const id = createHash('sha1').update(buf).digest('hex').slice(0, 10);
      const s = stickers.get(id);
      if (s) { if (note) s.note = String(note).slice(0, 40); save(); return { id, isNew: false }; }
      mkdirSync(dir, { recursive: true }); writeFileSync(path(id), buf);
      add({ id, from: String(from), note: String(note).slice(0, 40), at: new Date().toISOString().slice(0, 10), seen: 1, saved: true });
      return { id, isNew: true };
    },
    /** One line for her prompt: the newest ones, newest last. */
    prompt(n = 12) {
      const got = list.filter((s) => s.saved).slice(-n);
      return got.length ? prompt('qq.stickers', { list: got.map((s) => `${s.id}（${s.note || `${s.from} 发的`}${s.seen > 1 ? ` ×${s.seen}` : ''}）`).join('、') }) : '';
    },
  };
  return stickers;
}

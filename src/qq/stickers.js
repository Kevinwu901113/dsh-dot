// Her sticker collection: the images people send her that QQ marks as stickers (image sub_type 1).
// The list lives in $DSH_HOME/dsh-qq-stickers.json; each file is downloaded into her computer
// (STICKER_DIR) because QQ's image URLs expire, and sent again from there as "sticker:<id>".
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const STICKER_DIR = '/root/dot-stickers';
const MAX = 300;

/** An image segment's data → is it a sticker? (NapCat and SnowLuma both set sub_type 1 on 表情包.) */
export const isSticker = (d) => String(d?.sub_type ?? '') === '1' || /表情/.test(String(d?.summary ?? ''));

export function createStickers(file) {
  let list = [];
  try { list = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  const save = () => { try { writeFileSync(file, JSON.stringify(list)); } catch {} };
  const stickers = {
    list: () => list,
    get: (id) => list.find((s) => s.id === id),
    path: (id) => `${STICKER_DIR}/${id}.img`,
    /** Note a sticker seen in a message; returns { id, isNew }. The same file (by md5-ish name) is one entry. */
    note({ file: name, url, from }) {
      const key = String(name || url || '').replace(/[?#].*$/, '');
      if (!key || !url) return null;
      const id = createHash('sha1').update(key).digest('hex').slice(0, 10);
      let s = stickers.get(id);
      if (s) { s.seen = (s.seen ?? 1) + 1; s.url = url; save(); return { id, isNew: false }; }
      s = { id, url, from: String(from ?? ''), at: new Date().toISOString().slice(0, 10), seen: 1, saved: false };
      list.push(s); while (list.length > MAX) list.shift(); save();
      return { id, isNew: true };
    },
    markSaved(id) { const s = stickers.get(id); if (s) { s.saved = true; delete s.url; save(); } },
    /** Shell that downloads one sticker into the computer (the URL single-quoted; a quote in it refuses). */
    fetchScript(id) {
      const s = stickers.get(id);
      if (!s?.url || /['\n\r]/.test(s.url)) return '';
      return `mkdir -p ${STICKER_DIR}; [ -s ${stickers.path(id)} ] || curl -fsSL --max-time 60 -o ${stickers.path(id)} '${s.url}'; [ -s ${stickers.path(id)} ] && echo ok`;
    },
    /** One line for her prompt: the newest ones, newest last. */
    prompt(n = 12) {
      const got = list.filter((s) => s.saved).slice(-n);
      return got.length ? `你存的表情包（images 里写 sticker:<id> 就能发）：${got.map((s) => `${s.id}（${s.from} 发的${s.seen > 1 ? ` ×${s.seen}` : ''}）`).join('、')}` : '';
    },
  };
  return stickers;
}

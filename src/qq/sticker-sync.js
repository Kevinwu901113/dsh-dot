// Her sticker collection, mirrored to her phone's album: every saved sticker as
// /sdcard/Pictures/dot-stickers/<id>.<ext>, so any app there can pick it from the gallery. The host
// store is the truth: what is missing (or a different size) is pushed, what aged out is deleted, and
// the media scanner is told about both (the same broadcast /qq qr relies on for the album).
import { closeSync, openSync, readSync, statSync } from 'node:fs';

export const PHONE_STICKER_DIR = '/sdcard/Pictures/dot-stickers';
const OURS = /^[0-9a-f]{10}\.(png|jpg|gif|webp)$/;

/** Image type from the first bytes: png | jpg | gif | webp, or '' (not shown in an album → not synced). */
export function stickerExt(head) {
  const b = Buffer.from(head ?? []);
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 4 && b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return '';
}

/**
 * What to do so the phone holds exactly `want`: push what is missing or has another size, remove
 * our files (<id>.<ext>) that are no longer wanted. Anything else in the folder is left alone.
 * want / have: [{ name, size }].
 */
export function syncPlan(want, have) {
  const there = new Map(have.map((f) => [f.name, f.size]));
  const wanted = new Set(want.map((f) => f.name));
  return {
    push: want.filter((f) => there.get(f.name) !== f.size).map((f) => f.name),
    remove: have.filter((f) => !wanted.has(f.name) && OURS.test(f.name)).map((f) => f.name),
  };
}

/** `stat -c '%s %n'` lines → [{ name, size }] (basenames). */
export const parseListing = (out) => String(out ?? '').split('\n').map((l) => /^(\d+) (.*\/)?([^/]+)$/.exec(l.trim())).filter(Boolean).map((m) => ({ name: m[3], size: Number(m[1]) }));

function head(path) {
  const fd = openSync(path, 'r');
  try { const b = Buffer.alloc(12); const n = readSync(fd, b, 0, 12, 0); return b.subarray(0, n); } finally { closeSync(fd); }
}

/**
 * @param {{ stickers, phone: () => any, logger?, audit?, debounceMs? }} o — stickers: the store
 *   (stickers.js); phone: returns dshPhone (isReady, shell, adbExec) or undefined.
 */
export function createStickerSync({ stickers, phone, logger = { warn() {} }, audit = () => {}, debounceMs = 2000, dir = PHONE_STICKER_DIR }) {
  let last = null; // { synced, total, at, error? } of the last run
  let timer = null;
  let chain = Promise.resolve();
  /** The saved stickers as files: [{ name, size, path }]. */
  const wanted = () => stickers.list().filter((s) => s.saved).flatMap((s) => {
    const path = stickers.path(s.id);
    try { const ext = stickerExt(head(path)); return ext ? [{ name: `${s.id}.${ext}`, size: statSync(path).size, path }] : []; } catch { return []; }
  });
  async function run() {
    const p = phone();
    const want = wanted();
    if (!p?.isReady) return { ready: false, total: want.length };
    const have = parseListing(await p.shell(`mkdir -p ${dir}; stat -c '%s %n' ${dir}/* 2>/dev/null; true`));
    const plan = syncPlan(want, have);
    const byName = new Map(want.map((f) => [f.name, f]));
    const pushed = [];
    for (const name of plan.push) {
      try { await p.adbExec(['push', byName.get(name).path, `${dir}/${name}`]); pushed.push(name); } catch (err) { logger.warn(`sticker ${name} not pushed to the phone: ${err.message}`); }
    }
    if (plan.remove.length) await p.shell(`rm -f ${plan.remove.map((n) => `${dir}/${n}`).join(' ')}`);
    const touched = [...pushed, ...plan.remove];
    // The scanner adds a new file to the album and drops a deleted one.
    if (touched.length) await p.shell(`for f in ${touched.join(' ')}; do am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://${dir}/$f" >/dev/null 2>&1; done; true`);
    const synced = want.length - plan.push.length + pushed.length;
    last = { synced, total: want.length, at: Date.now() };
    if (touched.length) audit({ kind: 'stickers-synced', pushed: pushed.length, removed: plan.remove.length, synced, total: want.length });
    return { ready: true, pushed, removed: plan.remove, synced, total: want.length };
  }
  const sync = () => {
    const r = chain.then(run, run);
    chain = r.catch((err) => { last = { ...(last ?? { synced: 0, total: 0 }), error: err.message, at: Date.now() }; logger.warn(`stickers to the phone: ${err.message}`); });
    return r;
  };
  return {
    sync,
    /** Coalesce a burst of changes (a keep, a few fetches) into one run. */
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void sync().catch(() => {}); }, debounceMs);
      timer.unref?.();
    },
    stop() { if (timer) clearTimeout(timer); timer = null; },
    /** "phone: 10/12 synced" (+ why, when the phone is not up or the last run failed). */
    statusLine() {
      const total = wanted().length;
      const synced = last ? Math.min(last.synced, total) : 0;
      const why = !phone()?.isReady ? ' (phone not ready)' : last?.error ? ` (last sync failed: ${last.error})` : !last ? ' (not synced yet)' : '';
      return `phone: ${synced}/${total} synced${why}`;
    },
  };
}

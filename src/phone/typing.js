import { head } from '../cut.js';
// dsh-dot/phone typing: text goes into the focused field through an input method, and is checked.
//
// mobile-mcp's own typing puts non-ASCII text on the clipboard and sends a paste key, and says "typed" whether or
// not anything arrived (11-18: three "Typed text: 鲸鱼娘" in a row with nothing in the box; she and her hands had
// long since taken to clipboard + long-press + 粘贴 by hand). ADB Keyboard (github.com/senzhk/ADBKeyBoard, the
// input method Open-AutoGLM and others install) commits text through the input connection, like a keyboard does:
// no clipboard, any script. It is installed on her phone once and stays her phone's input method.
//   type(text)  a few characters at a time (it appears as typing, not all at once), then the focused field is
//               read back (uiautomator) and compared — so "typed" means it is there.
export const KEYBOARD = Object.freeze({
  pkg: 'com.android.adbkeyboard',
  ime: 'com.android.adbkeyboard/.AdbIME',
  urls: ['https://github.com/senzhk/ADBKeyBoard/releases/download/v2.4-dev/keyboardservice-debug.apk', 'https://raw.githubusercontent.com/senzhk/ADBKeyBoard/master/ADBKeyboard.apk'],
});

/** `text` in pieces of `size` characters (code points, so an emoji is never cut in two). */
export const chunks = (text, size = 3) => { const cp = [...String(text ?? '')], out = []; for (let i = 0; i < cp.length; i += size) out.push(cp.slice(i, i + size).join('')); return out; };

// What is on the screen, as a list of things with words on them: [{ words, x, y, w?, h?, focused, password }] (x, y: where
// to tap it; w, h: how big it is, when the reader says). Two ways to get it, the same shape from both: the phone server's own reader (mobilecli `dump ui`, what
// mobile_list_elements_on_screen shows) and, where that is not there, uiautomator's XML.
const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&') : undefined; };
/** From a `uiautomator dump`. */
export function itemsFromXml(xml) {
  const out = [];
  for (const m of String(xml ?? '').matchAll(/<node\b[^>]*>/g)) {
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(m[0]);
    const focused = attr(m[0], 'focused') === 'true';
    const words = (attr(m[0], 'text') || attr(m[0], 'content-desc') || '').replace(/\s+/g, ' ').trim();
    if (!words && !focused) continue;
    out.push({ words, x: b ? Math.round((Number(b[1]) + Number(b[3])) / 2) : 0, y: b ? Math.round((Number(b[2]) + Number(b[4])) / 2) : 0, ...(b ? { w: Number(b[3]) - Number(b[1]), h: Number(b[4]) - Number(b[2]) } : {}), focused, password: attr(m[0], 'password') === 'true' });
  }
  return out;
}
/** From mobilecli's `dump ui` (`data.elements`, each with children). */
export function itemsFromElements(elements) {
  const out = [];
  const walk = (e) => {
    if (!e || typeof e !== 'object') return;
    const words = String(e.text || e.value || e.label || e.name || '').replace(/\s+/g, ' ').trim();
    const r = e.rect ?? {};
    const focused = e.focused === true;
    if (words || focused) out.push({ words, x: Math.round((Number(r.x) || 0) + (Number(r.width) || 0) / 2), y: Math.round((Number(r.y) || 0) + (Number(r.height) || 0) / 2), ...(Number(r.width) > 0 && Number(r.height) > 0 ? { w: Number(r.width), h: Number(r.height) } : {}), focused, password: /password|secure/i.test(String(e.type ?? '')) });
    for (const c of Array.isArray(e.children) ? e.children : []) walk(c);
  };
  for (const e of Array.isArray(elements) ? elements : []) walk(e);
  return out;
}
/** The uiautomator way of reading the screen: written to a file on the phone and read back (`adb shell` has no terminal for /dev/tty). */
export const UI_DUMP = 'uiautomator dump /data/local/tmp/dot-ui.xml >/dev/null 2>&1; cat /data/local/tmp/dot-ui.xml 2>/dev/null; rm -f /data/local/tmp/dot-ui.xml';
export async function dumpUi(shell) { try { const xml = String(await shell(UI_DUMP)); return xml.includes('<hierarchy') ? itemsFromXml(xml) : []; } catch { return []; } }

/** The screen as lines for her hands: 「words」(x, y), top to bottom, the same words at the same place once, at most `max`. */
export function screenLines(items, { max = 70, chars = 60, top = 100 } = {}) {
  const out = [], seen = new Set();
  for (const it of items ?? []) {
    if (!it.words || it.y < top) continue; // the status bar (signal, battery, clock) is not what she is looking at
    const key = `${it.words}@${Math.round(it.x / 20)},${Math.round(it.y / 20)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...it, line: `「${it.words.length > chars ? `${head(it.words, chars)}…` : it.words}」(${it.x}, ${it.y})${it.focused ? ' ←光标在这' : ''}` });
  }
  out.sort((p, q) => p.y - q.y || p.x - q.x);
  return out.slice(0, max).map((o) => o.line).join('\n');
}
const squash = (s) => String(s ?? '').replace(/\s+/g, '');

/**
 * @param deps.shell     async (cmd) => stdout of `adb shell cmd`
 * @param deps.install   async () => void — gets the keyboard's apk onto the phone (download + adb install)
 * @param deps.read      async () => the screen's items ([] when it cannot be read)
 */
export function createTyping({ shell, install, read = () => dumpUi(shell), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), audit = () => {}, msPerChunk = 110, chunkSize = 3 }) {
  let ready = false;
  async function ensure() {
    if (ready) return;
    if (!String(await shell(`pm list packages ${KEYBOARD.pkg}`)).includes(KEYBOARD.pkg)) { await install(); audit({ kind: 'keyboard-installed' }); }
    await shell(`ime enable ${KEYBOARD.ime}`);
    if (!String(await shell('settings get secure default_input_method')).includes(KEYBOARD.ime)) { await shell(`ime set ${KEYBOARD.ime}`); await sleep(600); }
    ready = true;
  }
  const safeRead = async () => { try { return (await read()) ?? []; } catch { return []; } };
  return {
    ensure,
    /**
     * Type `text` into the focused field. → { typed, verified: true | false | null, field? } — verified: the field
     * (the focused thing on the screen, when the reader sees one) holds the text, or, with no focused thing, the text
     * is on the screen where it was not before. null: nothing could be told (a password box, a screen that cannot be
     * read), so nothing is claimed.
     */
    async type(text, { submit = false } = {}) {
      const t = String(text ?? '');
      if (!t) return { typed: 0, verified: null };
      await ensure();
      const before = await safeRead();
      for (const part of chunks(t, chunkSize)) {
        await shell(`am broadcast -a ADB_INPUT_B64 --es msg ${Buffer.from(part, 'utf8').toString('base64')}`);
        await sleep(msPerChunk);
      }
      await sleep(250);
      const after = await safeRead();
      const field = after.find((i) => i.focused), was = before.find((i) => i.focused);
      const times = (items) => items.reduce((n, i) => n + (squash(i.words).split(squash(t)).length - 1), 0);
      let verified = null;
      if (field?.password) verified = null;
      else if (field && squash(field.words).includes(squash(t))) verified = true;
      else if (times(after) > times(before)) verified = true;
      else if (field && was && squash(field.words) === squash(was.words)) verified = false;
      if (submit && verified !== false) await shell('input keyevent 66');
      audit({ kind: 'typed', chars: [...t].length, verified, submit: Boolean(submit && verified !== false), read: after.length });
      return { typed: [...t].length, verified, ...(field && !field.password && field.words ? { field: field.words.slice(0, 200) } : {}), ...(submit ? { submitted: verified !== false } : {}) };
    },
  };
}

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

const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&') : undefined; };
/** The focused node of a `uiautomator dump`: { text, password } or null (nothing focused, or no dump). */
export function focusedField(xml) {
  for (const m of String(xml ?? '').matchAll(/<node\b[^>]*>/g)) {
    if (attr(m[0], 'focused') !== 'true') continue;
    return { text: attr(m[0], 'text') ?? '', password: attr(m[0], 'password') === 'true' };
  }
  return null;
}
const squash = (s) => String(s ?? '').replace(/\s+/g, '');

/**
 * @param deps.shell     async (cmd) => stdout of `adb shell cmd`
 * @param deps.install   async () => void — gets the keyboard's apk onto the phone (download + adb install)
 */
export function createTyping({ shell, install, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), audit = () => {}, msPerChunk = 110, chunkSize = 3 }) {
  let ready = false;
  async function ensure() {
    if (ready) return;
    if (!String(await shell(`pm list packages ${KEYBOARD.pkg}`)).includes(KEYBOARD.pkg)) { await install(); audit({ kind: 'keyboard-installed' }); }
    await shell(`ime enable ${KEYBOARD.ime}`);
    if (!String(await shell('settings get secure default_input_method')).includes(KEYBOARD.ime)) { await shell(`ime set ${KEYBOARD.ime}`); await sleep(600); }
    ready = true;
  }
  return {
    ensure,
    /**
     * Type `text` into the focused field. → { typed, verified: true | false | null, field? } — verified null: the
     * field could not be read (a password box, or nothing the screen reader sees as focused), so nothing is claimed.
     */
    async type(text, { submit = false } = {}) {
      const t = String(text ?? '');
      if (!t) return { typed: 0, verified: null };
      await ensure();
      const dumpBefore = await shell('uiautomator dump /dev/tty').catch(() => '');
      const before = focusedField(dumpBefore);
      for (const part of chunks(t, chunkSize)) {
        await shell(`am broadcast -a ADB_INPUT_B64 --es msg ${Buffer.from(part, 'utf8').toString('base64')}`);
        await sleep(msPerChunk);
      }
      await sleep(250);
      const dumpAfter = await shell('uiautomator dump /dev/tty').catch(() => '');
      const after = focusedField(dumpAfter);
      // No focused field in the dump (a web page's box often is not one): the text showing up on the screen where it
      // was not before is as good; its not showing up proves nothing (a password box shows dots).
      const times = (xml) => squash(String(xml).replace(/&[a-z#0-9]+;/g, '')).split(squash(t)).length - 1;
      const verified = !after ? (times(dumpAfter) > times(dumpBefore) ? true : null) : after.password ? null : squash(after.text).includes(squash(t)) ? true : (before && squash(before.text) === squash(after.text)) ? false : squash(after.text).length > squash(before?.text).length ? true : false;
      if (submit && verified !== false) await shell('input keyevent 66');
      audit({ kind: 'typed', chars: [...t].length, verified, submit: Boolean(submit && verified !== false) });
      return { typed: [...t].length, verified, ...(after && !after.password ? { field: after.text.slice(0, 200) } : {}), ...(submit ? { submitted: verified !== false } : {}) };
    },
  };
}

/**
 * What is on the screen, from a `uiautomator dump`: one line per thing with words on it — 「words」 (x, y), the point
 * to tap — top to bottom, the same words at the same place once, at most `max` lines. '' when the dump has nothing.
 */
export function screenLines(xml, { max = 70, chars = 60 } = {}) {
  const out = [], seen = new Set();
  for (const m of String(xml ?? '').matchAll(/<node\b[^>]*>/g)) {
    const words = (attr(m[0], 'text') || attr(m[0], 'content-desc') || '').replace(/\s+/g, ' ').trim();
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(m[0]);
    if (!words || !b) continue;
    const x = Math.round((Number(b[1]) + Number(b[3])) / 2), y = Math.round((Number(b[2]) + Number(b[4])) / 2);
    const key = `${words}@${Math.round(x / 20)},${Math.round(y / 20)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ y, x, line: `「${words.length > chars ? `${words.slice(0, chars)}…` : words}」(${x}, ${y})${attr(m[0], 'focused') === 'true' ? ' ←光标在这' : ''}` });
  }
  out.sort((p, q) => p.y - q.y || p.x - q.x);
  return out.slice(0, max).map((o) => o.line).join('\n');
}

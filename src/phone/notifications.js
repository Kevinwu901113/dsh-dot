// dsh-dot/phone notifications: what her phone shows her, as events.
//
// Android gives a NotificationListenerService to apps, not to adb. Without installing an app of
// our own on her phone, the shade is observable two ways, and this module uses both together:
//   events — the system logs every post/update to the events log buffer (`notification_enqueue`);
//            tailing it says *that* something happened, within milliseconds, but not what.
//   state  — `dumpsys notification --noredact` says *what* is on the shade right now (title, text,
//            package, key), but is a snapshot: a notification an app cancels quickly, or rewrites
//            in place, is only caught if the snapshot is taken at the right moment.
// So: an event triggers an immediate snapshot; a slow periodic snapshot reconciles anything the
// tail missed. The watcher keeps one map, key → last content, and emits:
//   posted  — a key not seen before
//   updated — a known key whose title or text changed (a chat app rewrites one notification per
//             conversation as messages arrive; QQ shows "[2条]" and the latest line)
//   removed — a key that disappeared
// The first snapshot after start only fills the map: what was already there is not news.
// Policy (which packages count, which are muted) is applied by the caller through `wanted`.

/** Packages whose notifications are the system talking to itself, never her life. */
export const SYSTEM_PKG = /^(android|com\.android\.|com\.google\.android\.)/;

/**
 * Parse `dumpsys notification --noredact` into the active notifications (archive excluded).
 * @param {string} dump
 * @returns {{key: string, pkg: string, title: string, text: string}[]}
 */
export function parseShade(dump) {
  // Everything after the archive marker is history, not the shade.
  const active = String(dump).split(/\n\s*(?:mArchive|Notification Archive|Archive)\b/)[0];
  const out = [];
  for (const block of active.split(/(?=NotificationRecord\()/).slice(1)) {
    const head = block.split('\n')[0];
    const pkg = /\bpkg=(\S+)/.exec(head)?.[1];
    const key = /\bkey=(\S+?):?(?=\s|$)/.exec(head)?.[1];
    if (!pkg || !key) continue;
    const field = (name) => { const m = new RegExp(`\\b${name.replace(/\./g, '\\.')}=(?:String|CharSequence|SpannableString|SpannedString) \\(([^\\n]*)\\)`).exec(block); return m ? m[1].trim() : ''; };
    const title = field('android.title') || field('android.conversationTitle');
    let text = field('android.text') || field('android.bigText') || field('android.subText');
    if (!text) { const m = /android\.messages=[^\n]*?text=([^,\]]+)/.exec(block); if (m) text = m[1].trim(); }
    if (!text) { const m = /android\.textLines=[^\n]*?\(([^)]*)\)/.exec(block); if (m) text = m[1].trim(); }
    if (!title && !text) continue;
    // mUpdateTimeMs: when the app last posted or rewrote it — against our clock this is the detection lag.
    const postedAt = Number(/\bmUpdateTimeMs=(\d+)/.exec(block)?.[1] ?? /\bmCreationTimeMs=(\d+)/.exec(block)?.[1] ?? 0) || undefined;
    out.push({ key, pkg, title, text, postedAt });
  }
  return out;
}

/**
 * Watch the shade and report changes.
 * @param {object} o
 * @param {() => Promise<string>} o.readShade - runs `dumpsys notification --noredact`, returns stdout.
 * @param {(onEvent: () => void) => (() => void)} [o.tailEvents] - starts the events-log tail; calls
 *   onEvent for every enqueue line; returns a stop function. Omit to rely on polling alone.
 * @param {number} o.pollMs - reconcile interval; 0 disables the periodic snapshot.
 * @param {(n: {pkg: string}) => boolean} o.wanted - policy: does this notification count?
 * @param {(kind: 'posted'|'updated'|'removed', n: object) => void} o.onChange
 * @param {{warn?: Function, debug?: Function}} [o.logger]
 * @param {number} [o.settleMs=150] - delay between an event and its snapshot, so the app has written.
 * @returns {{ start: () => void, stop: () => void, snapshot: () => Promise<void>, known: () => object[] }}
 */
export function createShadeWatch({ readShade, tailEvents, pollMs, wanted, onChange, logger = {}, settleMs = 150 }) {
  const known = new Map(); // key → { pkg, title, text }
  let primed = false, running = false, timer = null, soon = null, stopTail = null, inFlight = null;

  async function snapshot() {
    if (!running) return;
    if (inFlight) return inFlight; // one dumpsys at a time; a burst collapses into the next read
    inFlight = (async () => {
      let dump;
      try { dump = await readShade(); } catch (err) { logger.debug?.(`shade read failed: ${err.message}`); return; }
      const now = new Map(parseShade(dump).map((n) => [n.key, n]));
      for (const [key, n] of now) {
        const before = known.get(key);
        known.set(key, n);
        if (!primed) continue;
        if (!before) { if (wanted(n)) emit('posted', n); continue; }
        if (before.title !== n.title || before.text !== n.text || (n.postedAt && before.postedAt && n.postedAt !== before.postedAt)) { if (wanted(n)) emit('updated', n); }
      }
      for (const [key, n] of known) if (!now.has(key)) { known.delete(key); if (primed && wanted(n)) emit('removed', n); }
      primed = true;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  const emit = (kind, n) => { const now = Date.now(); try { onChange(kind, { ...n, at: new Date(now).toISOString(), lagMs: n.postedAt ? Math.max(0, now - n.postedAt) : undefined }); } catch (err) { logger.warn?.(`notification listener: ${err.message}`); } };
  const onEvent = () => { if (soon || !running) return; soon = setTimeout(() => { soon = null; void snapshot(); }, settleMs); };

  return {
    start() {
      if (running) return;
      running = true;
      void snapshot().then(() => { if (running && tailEvents) stopTail = tailEvents(onEvent); });
      if (pollMs > 0) timer = setInterval(() => { void snapshot(); }, pollMs);
    },
    stop() {
      running = false;
      if (timer) clearInterval(timer); timer = null;
      if (soon) clearTimeout(soon); soon = null;
      stopTail?.(); stopTail = null;
    },
    snapshot,
    known: () => [...known.values()],
  };
}

/**
 * Per-app policy, like the phone's own notification settings: every non-system app counts, apps she
 * installs later included, unless muted; `only` narrows to a list.
 * @param {{only?: string[], muted?: Iterable<string>}} o
 */
export function createPolicy({ only = [], muted = [] } = {}) {
  const mutedSet = new Set(muted);
  const seenApps = new Map(); // pkg → notifications counted since start
  return {
    wanted(n) {
      if (!SYSTEM_PKG.test(n.pkg)) seenApps.set(n.pkg, (seenApps.get(n.pkg) ?? 0) + 1);
      if (mutedSet.has(n.pkg)) return false;
      return only.length ? only.includes(n.pkg) : !SYSTEM_PKG.test(n.pkg);
    },
    set(pkg, policy) { if (policy === 'mute') mutedSet.add(pkg); else mutedSet.delete(pkg); },
    muted: () => [...mutedSet],
    apps: () => [...seenApps.entries()].map(([pkg, count]) => ({ pkg, count, policy: mutedSet.has(pkg) ? 'mute' : 'wake' })),
  };
}

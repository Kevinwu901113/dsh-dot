// dsh-dot/dot — her ears and mouth keep one account: what he said to her that has no word back yet.
//
// She is one conversation; her hands work her phone and computer for her and come back to it. What she
// writes in a turn of his goes to him as she writes it. The gap this closes: a round of her hands comes
// back, she tells him what she will do next ("我换个源看看，等着"), calls nothing, and the turn ends —
// her hands are free, nothing is scheduled, and nobody is left holding what he asked (11-19: he waited
// for a match time that never came). One request in seven went that way in the first two days of hands.
//
// The account is kept by what happened, never by what her words mean:
//   - he speaks                       → a matter is open (his words on it; a new thing of his starts it over)
//   - her hands start a round for him → it is being worked on
//   - a round ends, its result is on its way to her → still being worked on
//   - a turn of his ends with her hands free and no result on its way:
//       her hands were never in it        → closed (she answered him herself; this is every chat turn)
//       she said nothing                  → closed (her silence is her saying it is done)
//       she spoke, her hands were in it   → she is asked once, in fixed words, with three ways out:
//                                           give her hands the next step / tell him / say nothing
//   - that asked turn ends without her hands starting → closed, whatever she said. It is asked once.
// The asking never speaks to him and never decides what her words were; it only puts the facts in front
// of her again. It waits while he is typing, while her bubbles are still going out, while her
// conversation is busy, and it is dropped the moment he speaks (his words open the matter anew).
//
// Nothing here is stored: a restart in the middle loses the round of her hands with it, and there is no
// one to take the matter up. Nothing here is shown to her outside the one asking message.

/**
 * @param {object} o
 * @param {() => boolean} o.canWake - nothing of hers or his is in the way right now (sync, cheap).
 * @param {(m: { his: string, last: string, at: number }) => Promise<boolean> | boolean} o.wake - ask her; true when it went in.
 * @param {(event: object) => void} [o.audit]
 * @param {number} [o.max] - how many times one matter is asked about (1).
 * @param {number} [o.ttlMs] - a matter nobody touched this long is let go.
 * @param {number} [o.settleMs] - after the turn ends, this long before asking (her bubbles, his typing).
 */
export function createTalk({ canWake, wake, audit = () => {}, max = 1, ttlMs = 30 * 60_000, settleMs = 5000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let open = null; // { at, his, rounds, pending, last, asked, due, lastAt }
  let timer = null;
  const disarm = () => { if (timer) { clearTimer(timer); timer = null; } };
  const close = (how) => { if (!open) return; disarm(); audit({ event: 'open-closed', how, rounds: open.rounds, asked: open.asked, ms: now() - open.at }); open = null; };
  const expired = () => open && now() - open.lastAt > ttlMs;
  let asking = false;
  const tryWake = async () => {
    if (!open?.due || asking) return false;
    if (expired()) { close('expired'); return false; }
    if (open.asked >= max) { close('asked'); return false; }
    if (open.pending || !canWake()) return false; // stays due: the next tick looks again
    const mine = open;
    asking = true;
    let went = false;
    try { went = Boolean(await wake({ his: mine.his, last: mine.last, at: mine.at })); } catch { went = false; } finally { asking = false; }
    if (open !== mine) return false; // he spoke meanwhile
    if (went) { mine.asked++; mine.due = false; mine.lastAt = now(); audit({ event: 'open-nudged', rounds: mine.rounds, ms: now() - mine.at }); }
    return went;
  };
  return {
    /** He said something to her (the words as she gets them). A matter that was open is his new one now. */
    heSaid(text) {
      disarm();
      const said = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!open) { open = { at: now(), his: said, rounds: 0, pending: false, last: '', asked: 0, due: false, lastAt: now() }; audit({ event: 'open-opened' }); return; }
      Object.assign(open, { his: said || open.his, rounds: 0, asked: 0, due: false, lastAt: now() });
    },
    /** A round of her hands started on his business. */
    handsStarted() { if (open) { open.rounds++; open.due = false; open.lastAt = now(); disarm(); } },
    /** That round is over and its result is on its way to her conversation. */
    handsDone() { if (open) { open.pending = true; open.lastAt = now(); } },
    /** The result reached her (the turn it wakes has started), or was dropped on the way. */
    resultArrived() { if (open) open.pending = false; },
    /** A line of hers went out to him. */
    sheSaid(line) { if (open && line) { open.last = String(line).trim().slice(0, 120); open.lastAt = now(); } },
    /**
     * A turn on his business ended.
     * @param {object} t
     * @param {boolean} t.spoke - something of hers went to him in it.
     * @param {boolean} t.asked - the turn was the asking itself.
     * @param {boolean} t.busy - her hands are on a round right now.
     */
    turnEnded({ spoke = false, asked = false, busy = false } = {}) {
      if (!open) return;
      if (asked) audit({ event: 'open-nudge-outcome', outcome: busy ? 'hands' : spoke ? 'spoke' : 'silent' });
      if (busy || open.pending) return;       // being worked on: the result will wake her
      if (!open.rounds) return close('answered');
      if (!spoke) return close('silent');
      if (asked) return close('after-nudge');
      if (open.asked >= max) return close('asked');
      open.due = true;
      disarm();
      timer = setTimer(() => { timer = null; void tryWake(); }, settleMs);
      timer?.unref?.();
    },
    /** The minute tick: a matter left too long is let go; one that could not be asked about yet is tried again. */
    tick() { if (!open) return; if (expired()) return close('expired'); if (open.due && !timer) void tryWake(); },
    tryWake,
    /** Her conversation was replaced or reset: what was open belonged to the old one. */
    drop(how = 'dropped') { close(how); },
    state: () => (open ? { ...open } : null),
    close: () => { disarm(); open = null; },
  };
}

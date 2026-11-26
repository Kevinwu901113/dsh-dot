// Her sleep is a state, not a time of day. awakeHours is her habit: outside it she is falling asleep, and is asleep
// once it has been quiet for sleepAfterQuietMinutes — so a night she is still talking is a night she is still up, and
// what arrives just as she dozes off still reaches her. Asleep, only he wakes her (his words, or any turn of her
// conversation); what her phone and her QQ show waits. She wakes at her usual hour, or when woken; either way what
// waited is shown to her then, and her next turn is told how long she slept — how she takes that is hers.
// Her clock (core.js) ticks it. Its quiet runs the other way from her own time's (interlude): anything of hers — a
// turn, a notification reaching her — starts the quiet over (stir); her own time counts only from his words and the
// start of her day, so what she does herself does not put it off.
// Falling asleep is the night's one event (onSleep: the day's end in memory, the nightcheck). The night is offered
// to each listener once per run: when she falls asleep, or — dsh restarted while she sleeps, or the listener came up
// later — at the next tick. A listener that must not do the night twice keeps which night it did (asleepSince).
import { inHours, msUntilHours } from '../hours.js';
import { prompt } from '../prompts.js';

const span = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}`; };

/**
 * @param deps.quiet   () => is nothing of hers going on right now
 * @param deps.onWake  (by) => she just woke ('morning' | 'him' | 'turn'): show her what waited
 * → { tick (her clock calls it), awake, wakeUp, stir, asleepSince, onSleep, wokeNote }
 */
export function createSleep({ cfg, store, audit, logger, quiet, onWake = () => {} }) {
  let asleepSince = Number(store.get('asleepSince') || 0), lastStir = Date.now(), woke = null;
  const sleepListeners = new Set();
  const offered = new Map(); // listener → the night (asleepSince) it was given in this run
  const offerNight = () => {
    if (!asleepSince) return;
    for (const fn of [...sleepListeners]) {
      if (offered.get(fn) === asleepSince) continue;
      offered.set(fn, asleepSince);
      try { fn(asleepSince); } catch (err) { logger.warn(`onSleep failed: ${err.message}`); }
    }
  };
  const stir = () => { lastStir = Date.now(); };
  const wakeUp = (by) => {
    if (!asleepSince) { stir(); return; }
    woke = { by, at: Date.now(), sleptMs: Date.now() - asleepSince, untilUsualMs: msUntilHours(cfg.awakeHours) };
    asleepSince = 0; store.set('asleepSince', 0); stir();
    audit('woke', { by, sleptMs: woke.sleptMs });
    onWake(by);
  };
  const tick = () => {
    const usual = inHours(cfg.awakeHours);
    if (asleepSince) { if (usual) wakeUp('morning'); else offerNight(); return; }
    if (usual) return;
    if (!quiet() || Date.now() - lastStir < cfg.sleepAfterQuietMinutes * 60000) return;
    asleepSince = Date.now(); store.set('asleepSince', asleepSince); woke = null;
    audit('asleep', { quietMs: asleepSince - lastStir });
    offerNight();
  };
  return {
    tick,
    awake: () => !asleepSince,
    wakeUp,
    /** Something of hers just happened: she is not dozing off yet. */
    stir,
    asleepSince: () => asleepSince,
    onSleep: (fn) => { sleepListeners.add(fn); return () => sleepListeners.delete(fn); },
    /** How long she slept, said once in the turn after she woke; '' when she did not just wake. */
    wokeNote() {
      if (!woke) return '';
      const w = woke; woke = null;
      if (Date.now() - w.at > 3600000) return ''; // long since: no longer "just woke"
      return w.by === 'morning' ? prompt('dot.woke.morning', { slept: span(w.sleptMs) }) : prompt('dot.woke', { slept: span(w.sleptMs), left: span(w.untilUsualMs) });
    },
  };
}

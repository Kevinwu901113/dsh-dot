// Her sleep is a state, not a time of day. awakeHours is her habit: outside it she is falling asleep, and is asleep
// once it has been quiet for sleepAfterQuietMinutes — so a night she is still talking is a night she is still up, and
// what arrives just as she dozes off still reaches her. Asleep, only he wakes her (his words, or any turn of her
// conversation); what her phone and her QQ show waits. She wakes at her usual hour, or when woken; either way what
// waited is shown to her then, and her next turn is told how long she slept — how she takes that is hers.
// (Taken out of core.js as it was.)
import { inHours, msUntilHours } from '../hours.js';
import { prompt } from '../prompts.js';

const span = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}`; };

/**
 * @param deps.quiet   () => is nothing of hers going on right now
 * @param deps.onWake  () => she just woke: show her what waited
 * @param deps.effect  (fn, label) => register a disposable with the host
 */
export function createSleep({ cfg, store, audit, logger, effect, quiet, onWake = () => {} }) {
  let asleepSince = Number(store.get('asleepSince') || 0), lastStir = Date.now(), woke = null;
  const sleepListeners = new Set();
  const stir = () => { lastStir = Date.now(); };
  const wakeUp = (by) => {
    if (!asleepSince) { stir(); return; }
    woke = { by, at: Date.now(), sleptMs: Date.now() - asleepSince, untilUsualMs: msUntilHours(cfg.awakeHours) };
    asleepSince = 0; store.set('asleepSince', 0); stir();
    audit('woke', { by, sleptMs: woke.sleptMs });
    onWake();
  };
  const sleepTick = () => {
    const usual = inHours(cfg.awakeHours);
    if (asleepSince) { if (usual) wakeUp('morning'); return; }
    if (usual) return;
    if (!quiet() || Date.now() - lastStir < cfg.sleepAfterQuietMinutes * 60000) return;
    asleepSince = Date.now(); store.set('asleepSince', asleepSince); woke = null;
    audit('asleep', { quietMs: asleepSince - lastStir });
    for (const fn of sleepListeners) { try { fn(asleepSince); } catch (err) { logger.warn(`onSleep failed: ${err.message}`); } }
  };
  effect(() => { const t = setInterval(sleepTick, 30000); t.unref?.(); return () => clearInterval(t); }, 'dsh-dot: her sleep');
  return {
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

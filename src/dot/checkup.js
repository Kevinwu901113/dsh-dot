// dsh-dot/checkup: what the host gives her phone and computer (doctor.js). Run on /dot doctor, once a start when
// something still has to be installed, and when a device fails; problems go to the log and his IM.
import { doctorFor, report } from '../doctor.js';

/**
 * @param deps.items  () => what doctorFor reads: { phone, computer, compat, home }
 * @param deps.im     { send(text, kind) } his IM channel
 */
export function createCheckup({ items, im, audit = () => {}, logger }) {
  let last = null;
  const run = async () => {
    const found = await doctorFor(items());
    last = { at: Date.now(), bad: found.filter((i) => i.level === 'bad').length, warn: found.filter((i) => i.level === 'warn').length };
    audit('doctor', { bad: last.bad, warn: last.warn, problems: found.filter((i) => i.level !== 'ok').map((i) => i.name) });
    return found;
  };
  return {
    run,
    /** The whole report, as /dot doctor prints it. */
    text: async () => report(await run()),
    /** Run it and, when something is broken, tell him why it was run and what is wrong. */
    async tell(why) {
      try {
        const found = await run();
        if (!found.some((i) => i.level === 'bad')) return;
        const text = report(found, { onlyProblems: true });
        logger.warn(`${why}\n${text}`);
        void im.send(`🩺 ${why}\n${text}\n（完整结果：在 dsh 里发 /phone doctor，或打开左侧栏的 dot 页面）`, 'plain');
      } catch (err) { logger.warn(`doctor failed: ${err.message}`); }
    },
    /** The last run's counts ({ at, bad, warn }) or null. */
    last: () => last,
  };
}

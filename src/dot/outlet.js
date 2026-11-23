// dsh-dot/outlet: the one way her words leave, once the voice has written them (say.js). To his QQ or anyone's, her
// bubbles one after another (qq.send stops between them when he speaks); to her own window when that is where he is
// talking to her (the say tool's output is what he reads there); over the IM channel when her QQ is not connected.
// What reached him goes into her transcript as it was sent (a QQ send is recorded by the QQ side itself).
/**
 * @param deps.qq       () => the QQ service ({ connected, send(to, text, images) → { said, images, … } }) or null
 * @param deps.im       { send(text) → Promise<boolean> } the IM channel to him
 * @param deps.here     () => true when he is talking to her in her own window (not over QQ)
 * @param deps.herSaid  (text) — her transcript gets what reached him
 */
import { unfold } from './say.js';

export function createOutlet({ qq, im, here, herSaid }) {
  let chain = Promise.resolve(), out = 0;
  // A message of several lines (say.js WITHIN) is one entry of `said`, with its line breaks back in place.
  const whole = (text) => ({ said: String(text).split('\n').filter(Boolean).map(unfold), images: [] });
  return {
    /** Her bubbles are going out right now. */
    busy: () => out > 0,
    /** Resolves once what is going out now is out. */
    settled: () => chain,
    /** → { said: [lines], images: [names], interrupted?, unsent? }; throws when there is no way to reach them. */
    async send({ to, text, images = [] }) {
      if (to === 'owner' && here()) { herSaid(unfold(text)); return whole(text); }
      const q = qq();
      if (q?.connected) {
        out++;
        const job = chain.then(() => q.send(to, text, images));
        chain = job.catch(() => {});
        try { return await job; } finally { out--; }
      }
      if (to !== 'owner') throw new Error('her QQ is not connected');
      if (!(await im.send(unfold(text)))) throw new Error('no way to reach him: her QQ is not connected and there is no IM target');
      herSaid(unfold(text));
      return whole(text);
    },
  };
}

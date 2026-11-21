// His words as he typed them, out of the message that reported them to her (dot.owner-words): the inverse of
// dot/text.js ownerWords, read off the templates themselves, so an override of them is undone the same way.
// Used by memory (his lines in the transcript) and by dot (his words that a turn keeps, his yes).
import { prompt } from './prompts.js';

/** His words as he typed them: without what dot puts around them (the 他说： it reports them with, the line it adds when they were steered into a running turn). */
export const ownerSaid = (raw) => {
  // dot.owner-words reports his words ("[stamp] 他说：…"); the stamp is gone already (unstamp), what follows it up to his text is cut.
  const shape = prompt('dot.owner-words', { stamp: '\u0000', text: '\u0001', busy: '', unsent: '' });
  const lead = shape.includes('\u0000') && shape.includes('\u0001') ? shape.slice(shape.indexOf('\u0000') + 1, shape.indexOf('\u0001')).replace(/^\]\s*/, '') : '';
  const text = lead.trim() && raw.startsWith(lead) ? raw.slice(lead.length) : raw;
  // …and without the note about lines of hers that did not reach him (dot.owner-words.unsent), which comes last.
  const head = `\n${prompt('dot.owner-words.unsent', { lines: '\u0000' }).split('\u0000')[0]}`;
  // (A template someone rewrote to start with the lines themselves leaves no head to recognise: then nothing is cut.)
  const i = head.trim().length >= 4 ? text.indexOf(head) : -1;
  const t = i >= 0 ? text.slice(0, i) : text;
  const busy = `\n${prompt('dot.owner-words.busy')}`;
  return t.endsWith(busy) ? t.slice(0, -busy.length) : t;
};

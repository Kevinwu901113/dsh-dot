// dsh-dot/precheck: decide WITHOUT the model whether there is anything to wake the dot for.
// Reads <home>/watch.json, fetches each watched page on its own interval, reduces it to text,
// and compares a hash with the last run. Only a real change produces a wake-up.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const MAX_TEXT = 200_000;

/** HTML → visible text, roughly: enough to tell "the page changed" from "a timestamp changed". */
export function pageText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<!--[\s\S]*?-->/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

/** Keep only the parts the user cares about: sentences/lines containing one of the keywords. */
export function focus(text, contains) {
  const words = [].concat(contains ?? []).map(String).filter(Boolean);
  if (!words.length) return text;
  return text.split(/(?<=[。！？.!?])\s+|\s{2,}/).filter((part) => words.some((w) => part.includes(w))).join('\n');
}

export function readWatches(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.watches;
    return (Array.isArray(list) ? list : [])
      .filter((w) => w && typeof w.url === 'string' && /^https?:\/\//.test(w.url))
      .map((w) => ({
        name: String(w.name || w.url),
        url: w.url,
        everyMinutes: Math.max(5, Number(w.everyMinutes) || 60),
        contains: w.contains,
        prompt: typeof w.prompt === 'string' ? w.prompt : '',
      }));
  } catch {
    return [];
  }
}

/**
 * @param {object} o
 * @param {string} o.file - watch.json path.
 * @param {object} o.store - { get(key), set(key, value) } persisted state.
 * @param {(watch, change) => void} o.onChange - called once per detected change.
 * @param {object} o.logger
 * @param {typeof fetch} [o.fetchImpl]
 */
export function createPrechecker({ file, store, onChange, logger, fetchImpl = fetch }) {
  let running = false;

  async function checkOne(w, now) {
    const key = `watch:${w.url}`;
    const prev = store.get(key) ?? {};
    if (prev.at && now - prev.at < w.everyMinutes * 60_000) return;
    let text;
    try {
      const res = await fetchImpl(w.url, {
        headers: { 'user-agent': 'Mozilla/5.0 (dsh-dot precheck)', accept: 'text/html,text/plain,*/*' },
        signal: AbortSignal.timeout(20_000), redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = focus(pageText(await res.text()), w.contains);
    } catch (err) {
      store.set(key, { ...prev, at: now, error: err.message });
      logger.warn(`precheck ${w.name}: ${err.message}`);
      return;
    }
    const hash = createHash('sha256').update(text).digest('hex');
    store.set(key, { at: now, hash, length: text.length, excerpt: text.slice(0, 600) });
    // The first look only records a baseline.
    if (prev.hash && prev.hash !== hash) {
      onChange(w, { before: prev.excerpt ?? '', after: text.slice(0, 600), at: new Date(now).toISOString() });
    }
  }

  /** One pass over every watch whose interval has elapsed. Never overlaps itself. */
  async function tick(now = Date.now()) {
    if (running) return;
    running = true;
    try {
      for (const w of readWatches(file)) await checkOne(w, now);
    } finally {
      running = false;
    }
  }

  return { tick, watches: () => readWatches(file) };
}

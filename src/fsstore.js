// dsh-dot/fsstore: how the plugin keeps its files. Two rules, the same for every file it owns:
//   1. a write never leaves a half file: written beside, flushed, then renamed over (a crash keeps the old whole);
//   2. a file that cannot be read is never written over unseen: it is copied aside as <file>.broken-<time> first,
//      and only then is a fresh one started; if it cannot even be copied aside, nothing is written to it at all
//      (the same rule memory.json kept alone before, 11-26: dsh-dot-state.json read as {} on a bad read and was
//      then overwritten with one key — her conversation, the book of things and his yeses gone, without a word).
// JSON lines are read line by line: a bad line is skipped and counted, not the end of the file.
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write `text` to `file` whole or not at all. */
export function writeText(file, text, { mode } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', mode);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}
export const writeJson = (file, value, { indent = 2, mode } = {}) => writeText(file, `${JSON.stringify(value, null, indent)}\n`, { mode });

/**
 * Read a JSON file. → { value, state, keptAs?, error? }; state: 'ok' · 'missing' (fallback) · 'broken' (copied aside as
 * keptAs, fallback returned: writing may go on) · 'stuck' (not readable and not copied aside: do not write it).
 * `valid(value)` may reject a parse that is not the expected shape (counted as broken).
 */
export function readJson(file, fallback, { valid } = {}) {
  if (!existsSync(file)) return { value: fallback, state: 'missing' };
  let error;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!valid || valid(value)) return { value, state: 'ok' };
    error = 'not the expected shape';
  } catch (err) { error = err.message; }
  const keptAs = `${file}.broken-${Date.now()}`;
  try { copyFileSync(file, keptAs); return { value: fallback, state: 'broken', keptAs, error }; } catch (err) { return { value: fallback, state: 'stuck', error: `${error}; not copied aside: ${err.message}` }; }
}

/** Read a JSON-lines file. → { rows, bad } (bad: lines that did not parse, skipped). */
export function readJsonl(file) {
  if (!existsSync(file)) return { rows: [], bad: 0 };
  const rows = []; let bad = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { bad++; }
  }
  return { rows, bad };
}

/**
 * A key-value JSON file kept whole on every change (the plugin's state). `onBroken(info)` is told when the file on disk
 * could not be read (info.state 'broken' or 'stuck'); a stuck store keeps working in memory and writes nothing.
 */
export function createJsonStore(file, { onBroken, onWriteError } = {}) {
  const got = readJson(file, {}, { valid: (v) => v && typeof v === 'object' && !Array.isArray(v) });
  const data = got.value;
  const stuck = got.state === 'stuck';
  if (got.state === 'broken' || stuck) onBroken?.(got);
  return {
    get: (k) => data[k],
    set: (k, v) => {
      data[k] = v;
      if (stuck) return;
      try { writeJson(file, data); } catch (err) { onWriteError?.(err); }
    },
    /** 'ok' · 'missing' · 'broken' · 'stuck': how the file was when this store opened it. */
    opened: got.state,
  };
}

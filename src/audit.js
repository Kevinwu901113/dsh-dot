// dsh-computer/audit: append-only JSONL record of what the agent did on its computer — every
// process started in the VM, every VM tool call and its result, approvals asked, folder changes.
// One file per DSH_HOME; rotated to `.1` past 10 MB. Never throws into the caller.
import { appendFileSync, renameSync, statSync } from 'node:fs';

const MAX_BYTES = 10 * 1024 * 1024;

/** Cut long values so one entry stays readable. */
export function clip(value, max = 500) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > max ? `${text.slice(0, max)}…(+${text.length - max})` : text;
}

/**
 * @param {string} file - absolute path of the audit log.
 * @returns {(entry: object) => void} writer that stamps `ts` and appends one line.
 */
export function createAudit(file) {
  let checked = 0;
  return (entry) => {
    try {
      // Size checks are cheap but not free; look every 200 entries.
      if (++checked % 200 === 1) {
        try { if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`); } catch {}
      }
      appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    } catch {}
  };
}

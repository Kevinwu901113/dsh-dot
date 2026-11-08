// dsh-dot/manuals: her operating manuals are handed over when she first reaches for the tools, not
// carried in every system prompt.
//
// The phone section, the phone's and the computer's MCP instructions are long how-to text. In every
// turn of her conversation they sat between who she is (the Canon) and what she says, and outweighed
// it. Now, in her sessions, each of those sections is replaced by one line (what she has, and that the
// manual comes when she first uses it); the first call of one of its tools in a session runs as usual and
// the manual comes along with its result (not as a refusal: an error made her stop and think in circles).
// The one line keeps what a first call needs (the device). The prompt of a session stays the
// same from its first step to its last (the cached prefix holds); a new session (handoff, a fresh
// errand) gets the manual again on first use.

/** Default routes: section names → the capability they explain, and the tools that need it. */
export function defaultManuals({ phonePrefix, vmPrefix, phoneZoom }) {
  return [
    { key: 'phone', sections: ['phone:device', 'mcp:dot-phone'], tools: [phonePrefix, 'account', phoneZoom] },
    { key: 'computer', sections: ['mcp:dot-vm'], tools: [vmPrefix] },
  ];
}

const matches = (name, patterns) => patterns.some((p) => p && (p.endsWith('__') ? name.startsWith(p) : name === p));

/**
 * routes: [{ key, sections: [section names], tools: [tool names, or prefixes ending in "__"] }]
 * hint(key): the one line that stands in for the manual in the system prompt
 * given(key, manual): the note that carries the manual, after the first call's result
 */
export function createManuals({ routes = [], hint, given }) {
  const stash = new Map();     // session id → Map(key → [section texts])
  const delivered = new Map(); // session id → Set(keys)
  const routeOf = (section) => routes.find((r) => r.sections.includes(section));
  return {
    /** For her sessions: the routed sections become one line each (once per key), their text kept for later. */
    assemble(assembly, sessionId) {
      if (!sessionId || !routes.length) return assembly;
      const kept = new Map();
      const hinted = new Set();
      let changed = false;
      const sections = [];
      for (const sec of assembly.sections) {
        const r = routeOf(sec.name);
        if (!r || !String(sec.text ?? '').trim()) { sections.push(sec); continue; }
        changed = true;
        kept.set(r.key, [...(kept.get(r.key) ?? []), String(sec.text).trim()]);
        if (!hinted.has(r.key)) { hinted.add(r.key); sections.push({ ...sec, text: hint(r.key) }); }
      }
      if (!changed) return assembly;
      stash.set(sessionId, kept);
      return { ...assembly, sections };
    },
    /** The first call of a routed tool in a session: the note with its manual (to go with the result), else null. */
    take(toolName, sessionId) {
      if (!sessionId) return null;
      const r = routes.find((x) => matches(toolName, x.tools));
      if (!r) return null;
      const done = delivered.get(sessionId) ?? new Set();
      if (done.has(r.key)) return null;
      const texts = stash.get(sessionId)?.get(r.key);
      if (!texts?.length) return null; // never routed in this session (not hers, or the section was empty)
      done.add(r.key); delivered.set(sessionId, done);
      return given(r.key, texts.join('\n\n'));
    },
    /** Has this session been handed the manual for `key`. */
    has: (sessionId, key) => Boolean(delivered.get(sessionId)?.has(key)),
    forget(sessionId) { stash.delete(sessionId); delivered.delete(sessionId); },
  };
}

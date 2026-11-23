// dsh-dot/consent: what he said yes to. A yes is a line of his, kept with the kind of thing it is for; the gates let
// that kind through while it holds — for the one thing it was given for (bound to it the first time it is used), or,
// when he said "以后这种都行", always. Nothing is asked with a button: she asks him in words and records his yes
// (his_ok), only in a turn his own words opened.
/**
 * @param deps.store   { get, set } kept across restarts (only standing yeses are kept)
 * @param deps.holdMs  a yes not used within this long is let go
 * @param deps.thingMs a yes given to a thing is let go this long after it was given (a thing never runs that long)
 */
export function createConsent({ store, holdMs = 30 * 60_000, thingMs = 6 * 3600_000, now = () => Date.now() }) {
  let grants = (Array.isArray(store.get('consent')) ? store.get('consent') : []).filter((g) => g?.always);
  const asks = []; // what she has to ask him about with no thing to hang it on (a message to someone she does not know)
  const save = () => store.set('consent', grants.filter((g) => g.always));
  const fresh = (g) => g.always || now() - g.at <= (g.thing ? thingMs : holdMs);
  // A yes is for the kind of thing and for whom or what it was asked about: one given about user:1 says nothing of
  // user:2, and one given with nothing named covers only what names nothing.
  const fits = (g, kind, subject) => g.kind === kind && g.subject === String(subject ?? '');
  return {
    /** His yes: { kind, subject?, words, always? }. */
    grant({ kind, subject = '', words = '', always = false }) {
      const g = { kind, subject: String(subject ?? ''), words: String(words ?? '').slice(0, 200), at: now(), always: Boolean(always), thing: '' };
      grants = [...grants.filter(fresh), g];
      for (let i = asks.length - 1; i >= 0; i--) if (fits(g, asks[i].kind, asks[i].subject)) asks.splice(i, 1);
      save();
      return g;
    },
    /** Does a yes of his cover this, for this thing ('' = no thing)? A yes used for a thing stays with it. */
    allows({ kind, subject = '', thing = '' }) {
      const g = grants.find((x) => fresh(x) && fits(x, kind, subject) && (x.always || !x.thing || x.thing === thing));
      if (!g) return false;
      if (!g.always && !g.thing && thing) g.thing = thing;
      return true;
    },
    /** Something to ask him about that has no thing (yet). */
    ask({ kind, subject = '', what = '' }) { if (!asks.some((a) => a.kind === kind && a.subject === subject)) asks.push({ kind, subject, what, at: now() }); },
    /** What is waiting for his yes (the last hour). */
    asking: () => asks.filter((a) => now() - a.at <= 3600000).map((a) => ({ ...a })),
    /** His standing yeses. */
    standing: () => grants.filter((g) => g.always).map((g) => ({ ...g })),
    /** Forget his standing yeses (all, or of a kind). → how many */
    forget(kind = '') { const n = grants.length; grants = grants.filter((g) => kind && g.kind !== kind); save(); return n - grants.length; },
  };
}

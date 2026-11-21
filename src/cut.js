// Cutting a text short without cutting a character in half. A JavaScript string counts an emoji as two units; a
// slice that ends between them leaves half a character, which the model API refuses as malformed JSON — the whole
// request, so the turn it belonged to dies (11-21: a post title cut at 60 ended a thing of her hands mid-way).

/** The first n units of s, never ending on half a character. */
export const head = (s, n) => { const t = String(s ?? '').slice(0, n); return /[\ud800-\udbff]$/.test(t) ? t.slice(0, -1) : t; };
/** The last n units of s, never starting on half a character. */
export const tail = (s, n) => { const t = n > 0 ? String(s ?? '').slice(-n) : ''; return /^[\udc00-\udfff]/.test(t) ? t.slice(1) : t; };

// dsh-dot/persona: her card, and what code checks in what she says.
//
// The card is one Markdown file, <home>/persona.md: who she is, the people and places around her, how
// she talks, what talking looks like. It is hers (the user's) and fixed: nothing here rewrites it. A
// canon.json in HDS-Interlude's storyDefaults form (the preset hub's) is turned into a card once, its
// sentences moved as they are (canonToCard).
//
// What a card used to forbid in words (the blacklist) is checked in code instead (parseBlacklist,
// checkReply): a phrase list she never reads cannot teach her the phrase, and a rule about brackets is
// kept by taking the brackets out. Length and form are code's; who she is stays in the card.
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CARD_FILE = 'persona.md';
export const CHECKS_FILE = 'persona.checks.txt';

const text = (v) => String(v ?? '').trim();
const part = (title, ...vs) => { const body = vs.map(text).filter(Boolean).join('\n\n'); return body ? `## ${title}\n${body}` : ''; };

/** canon.json (storyDefaults) → the card. Every sentence is the canon's own; only the headings are ours. The blacklist is not part of a card. */
export function canonToCard(canon) {
  const sd = canon?.storyDefaults ?? canon ?? {};
  const name = text(sd.characterName);
  if (!name && !text(sd.characterProfile)) return '';
  return [
    `# 你是 ${name || '主角'}`,
    part('你是谁', sd.characterProfile, sd.perspective),
    part('和他的关系', sd.relationship, sd.userProfile),
    part('身边的人和地方', sd.supportingCast, sd.world, sd.location),
    part('怎么说话', sd.replyRules ?? canon?.replyRules),
    part('说话的样子', canon?.examples),
  ].filter(Boolean).join('\n\n') + '\n';
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** One phrase → a pattern: 「……」 and 「...」 inside a phrase stand for a short stretch of the same sentence. */
export function phrasePattern(phrase) {
  const parts = String(phrase).split(/…{1,2}|\.{3,}/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  return new RegExp(parts.map(esc).join('[^。！？!?\\n]{0,40}'));
}

/**
 * A canon's blacklist (lines like `公文套话：「首先」「其次」`) or a checks file (one phrase a line, `#` comments)
 * → [{ phrase, re }]. Only what is quoted in 「」 counts in a canon line: the rest is its heading.
 */
export function parseBlacklist(source) {
  const lines = Array.isArray(source) ? source.map(String) : String(source ?? '').split('\n');
  const phrases = [];
  for (const line of lines) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const quoted = [...l.matchAll(/「([^」]+)」/g)].map((m) => m[1].trim());
    for (const p of quoted.length ? quoted : Array.isArray(source) ? [] : [l]) { const one = p.split('/')[0].trim(); if (one && !phrases.includes(one)) phrases.push(one); } // 「A/B」: B is a variant of A's ending, not a phrase of its own
  }
  return phrases.map((phrase) => ({ phrase, re: phrasePattern(phrase) })).filter((p) => p.re);
}

/** Too short to check by itself: 「最后」「我认」「呢」 are in half of what anyone says. Three characters of fixed text, or it is not checked. */
export const tooShort = (phrase) => String(phrase).replace(/…{1,2}|\.{3,}|[\s，。！？!?、~～]/g, '').length < 3;

/**
 * The checks file a canon's blacklist becomes: one phrase a line, hers (the user's) to edit. A phrase too
 * short to be told from ordinary speech is written commented out: it was a rule about how often, not a phrase.
 */
export const checksText = (canon) => {
  const phrases = parseBlacklist(Array.isArray(canon?.blacklist) ? canon.blacklist : String(canon?.blacklist ?? '').split('\n').filter((l) => /「/.test(l))).map((p) => p.phrase);
  if (!phrases.length) return '';
  const on = phrases.filter((p) => !tooShort(p)), off = phrases.filter(tooShort);
  return [
    '# 她说出这些就算 AI 味（一行一个；…… 代表中间隔了几个字）。代码检查，不进她的提示词。',
    ...on,
    ...(off.length ? ['# 下面这些太短，平常说话也会带到，默认不查；要查就去掉行首的 #', ...off.map((p) => `# ${p}`)] : []),
  ].join('\n') + '\n';
};

const CJK = /[㐀-鿿]/;
const CODEY = /[=;{}<>]|=>|\w\(/;
/**
 * Stage directions out of one line: a bracketed stretch (（…） (…) *…*) that opens or closes the line, or is
 * the whole of it, with Chinese inside and nothing code-like. A bracket in the middle of a sentence is part
 * of what she says and stays. '' when nothing is left.
 */
export function stripStage(line) {
  let s = String(line);
  if (CODEY.test(s.replace(/[（(]([^（）()]*)[）)]/g, (m, inner) => (CJK.test(inner) ? '' : m)))) return s; // a line of code or a command: left alone
  const stage = (inner) => CJK.test(inner) && !CODEY.test(inner) && inner.length <= 40;
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(/^\s*(?:（([^（）]*)）|\(([^()]*)\)|\*([^*\n]+)\*)\s*/, (m, a, b, c) => (stage(a ?? b ?? c ?? '') ? '' : m));
    s = s.replace(/\s*(?:（([^（）]*)）|\(([^()]*)\)|\*([^*\n]+)\*)\s*$/, (m, a, b, c) => (stage(a ?? b ?? c ?? '') ? '' : m));
    if (s === before) break;
  }
  return s.trim();
}

/**
 * What she is about to say, checked: stage directions taken out (unless `strip` is false), and which
 * blacklisted phrases are in what is left. → { text, lines, stripped, hits: [phrase] }.
 */
export function checkReply(reply, patterns = [], { strip = true } = {}) {
  const raw = String(reply ?? '').split('\n');
  let stripped = 0;
  const lines = [];
  for (const line of raw) {
    if (!line.trim()) continue;
    const kept = strip ? stripStage(line) : line.trim();
    if (kept !== line.trim()) stripped++;
    if (kept) lines.push(kept);
  }
  const body = lines.join('\n');
  const hits = patterns.filter((p) => p.re.test(body)).map((p) => p.phrase);
  return { text: body, lines, stripped, hits };
}

/** <home>/persona.md, or '' when there is none (or it is empty). */
export function readCard(home) {
  const file = join(home, CARD_FILE);
  try { return statSync(file).isFile() ? readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim() : ''; } catch { return ''; }
}

/** <home>/persona.checks.txt as patterns ([] when there is none). */
export function readChecks(home) {
  try { return parseBlacklist(readFileSync(join(home, CHECKS_FILE), 'utf8')); } catch { return []; }
}

const SOURCE_FILE = 'persona.source.json';
const sha = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
/** What of a canon the card and the checks are made from, as one string (key order does not matter). */
const canonKey = (canon) => { const sd = canon?.storyDefaults ?? canon ?? {}; return sha(JSON.stringify([Object.keys(sd).sort().map((k) => [k, sd[k]]), canon?.replyRules ?? null, canon?.examples ?? null, canon?.blacklist ?? null])); };
const readRaw = (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };

/**
 * Keep the card and the checks file in step with the canon — without ever writing over what the user wrote.
 * <home>/persona.source.json remembers which canon they were made from and what was written (hashes):
 *   - a home with a canon and no card (and no record of one): both are written;
 *   - the canon changed (another canon.json put in its place) and the file is still exactly what was written
 *     from the old one: it is written again from the new canon, the old one kept beside it (.bak-<time>);
 *   - the file was edited, or deleted, since it was written: it is left alone (`kept`), whatever the canon says.
 * `force` (a persona imported on purpose) writes both whatever is there, keeping the old ones beside them.
 * → { card, checks: 'written' | 'rewritten' | 'kept' | 'same' | 'none' }.
 */
export function syncCard(home, canon, { force = false, now = new Date() } = {}) {
  const out = { card: 'none', checks: 'none' };
  if (!canon) return out;
  const sourceFile = join(home, SOURCE_FILE);
  let source = null;
  try { source = JSON.parse(readFileSync(sourceFile, 'utf8')); } catch { source = null; }
  const key = canonKey(canon);
  const tag = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const next = { canon: key, card: source?.card ?? null, checks: source?.checks ?? null };
  for (const [name, file, body] of [['card', CARD_FILE, canonToCard(canon)], ['checks', CHECKS_FILE, checksText(canon)]]) {
    const path = join(home, file), have = readRaw(path), was = source?.[name] ?? null;
    const write = (how) => {
      if (have !== null) writeFileSync(`${path}.bak-${tag}`, have);
      if (body) { writeFileSync(path, body); next[name] = sha(body); out[name] = how; } else { next[name] = null; out[name] = 'none'; }
    };
    if (force) { write(have === null ? 'written' : 'rewritten'); continue; }
    if (have === null) { if (was === null && !source) write('written'); else out[name] = was === null ? 'none' : 'kept'; continue; }
    if (was === null) { // a file nobody recorded: taken as written from this canon only when it is exactly that
      if (body && have === body) { next[name] = sha(body); out[name] = 'same'; } else out[name] = 'kept';
      continue;
    }
    if (sha(have) !== was) { out[name] = 'kept'; continue; } // edited since it was written
    if (source.canon === key) { out[name] = 'same'; continue; }
    write('rewritten');
  }
  if (!source || JSON.stringify(source) !== JSON.stringify(next)) { try { writeFileSync(sourceFile, `${JSON.stringify(next, null, 2)}\n`); } catch { /* read-only home: nothing is remembered */ } }
  return out;
}

// dsh-dot/persona/parts: her card in parts, and who reads which.
//
// <home>/persona/ holds one file per part and a list (parts.json) that says who each part is for: the one who decides
// ('decide': her conversation, which has the tools) and the one who speaks ('say': the call that writes her words and
// has nothing but the card). Who she is goes to both; how she talks and what her lines look like go to the voice
// alone — with them in front of it, the deciding side writes lines instead of deciding (11-21).
// Nothing else in the plugin reads these files or knows how many parts there are: adding a part is a file and a line
// in the list; changing who reads a part is one word in the list.
// The folder is made once from <home>/persona.md, by its headings; persona.md stays as it is. When persona.md is newer
// than the list (edited by hand, or written again from a canon), the parts are cut from it again and the list's
// choices of who reads what are kept.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PARTS_DIR = 'persona';
const LIST = 'parts.json';
/** Headings that are about speaking; everything else is who she is. */
const VOICE = [[/怎么说话|说话方式|语气|口吻/, 'voice.md'], [/说话的样子|例句|示例|对话示例/, 'examples.md']];
/** Does a card say how she talks: a `## ` heading about speaking (a canon's 回复规则 counts). */
export function saysHowToTalk(card) {
  return String(card ?? '').split('\n').some((l) => { const h = /^##\s+(.*)$/.exec(l); return h && (VOICE[0][0].test(h[1]) || /回复规则/.test(h[1])); });
}
const DEFAULT_FOR = { 'who.md': ['decide', 'say'], 'voice.md': ['say'], 'examples.md': ['say'] };
const read = (file) => { try { return readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim(); } catch { return ''; } };
const mtime = (file) => { try { return statSync(file).mtimeMs; } catch { return 0; } };

/** A card cut by its `## ` headings into { 'who.md', 'voice.md'?, 'examples.md'? }. A card with no such headings is all who she is. */
export function cutCard(card) {
  const out = { 'who.md': [] };
  let into = 'who.md';
  for (const line of String(card ?? '').split('\n')) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) into = (VOICE.find(([re]) => re.test(h[1])) ?? [null, 'who.md'])[1];
    (out[into] ??= []).push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim()]).filter(([, v]) => v));
}

/**
 * Her card for a reader. → the parts meant for them, in the list's order, as one text ('' when there is no card).
 * @param {string} home
 * @param {'decide' | 'say'} reader
 * @param {string} card  <home>/persona.md as it is now (what the parts are cut from)
 */
export function cardFor(home, reader, card) {
  const dir = join(home, PARTS_DIR), list = join(dir, LIST);
  if (!String(card ?? '').trim() && !existsSync(list)) return '';
  let parts = null;
  try { parts = JSON.parse(readFileSync(list, 'utf8')); } catch { parts = null; }
  // First time, or the card was edited since: cut it again. Who reads what stays as the list had it.
  if (String(card ?? '').trim() && (!Array.isArray(parts) || mtime(join(home, 'persona.md')) > mtime(list))) {
    try {
      const cut = cutCard(card);
      const kept = new Map((Array.isArray(parts) ? parts : []).map((p) => [p.file, p.for]));
      const own = (Array.isArray(parts) ? parts : []).filter((p) => !(p.file in DEFAULT_FOR)); // parts he added himself
      parts = [...Object.keys(cut).map((file) => ({ file, for: kept.get(file) ?? DEFAULT_FOR[file] })), ...own];
      mkdirSync(dir, { recursive: true });
      for (const [file, text] of Object.entries(cut)) writeFileSync(join(dir, file), `${text}\n`);
      writeFileSync(list, `${JSON.stringify(parts, null, 2)}\n`);
    } catch { return reader === 'say' ? String(card).trim() : cutCard(card)['who.md'] ?? String(card).trim(); }
  }
  if (!Array.isArray(parts)) return String(card ?? '').trim();
  return parts.filter((p) => Array.isArray(p?.for) && p.for.includes(reader)).map((p) => read(join(dir, String(p.file)))).filter(Boolean).join('\n\n');
}

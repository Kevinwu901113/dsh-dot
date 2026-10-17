// dsh-dot/im: reach the user over IM.
//
// dsh-bridge forwards every assistant message of its bound session to the IM chat, but exposes
// no API. dot needs three things it lacks, so it wraps two methods of the bridge's base
// conversation class (feature-detected; disabled with a warning if the shape changes):
//   1. silence  — an assistant reply that is only `DOT_SILENT` is not forwarded;
//   2. binding  — which session each connected IM chat is bound to (the dot's main session);
//   3. notify   — send a line to the chat without the model (e.g. while the budget is blocked).
// A webhook (Feishu / WeCom bot, ServerChan, or any JSON endpoint) is the fallback channel.
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export const SILENT = 'DOT_SILENT';

// Tolerate markdown decoration around the marker: `DOT_SILENT`, **DOT_SILENT**, "DOT_SILENT。".
const isSilent = (text) => typeof text === 'string' && text.replace(/[`*\s。."'“”]/g, '').replace(/^_+|_+$/g, '') === SILENT;

/** Find dsh-bridge's conversation module from the dsh profiles (it is a sibling plugin, not our dependency). */
function locateBridge() {
  const bases = [import.meta.url];
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  try {
    for (const p of readdirSync(join(dshHome, 'profiles'))) bases.push(pathToFileURL(join(dshHome, 'profiles', p, 'package.json')).href);
  } catch {}
  for (const base of bases) {
    try {
      const pkg = createRequire(base).resolve('@wenbin_wb/dsh-bridge/package.json');
      const file = join(dirname(pkg), 'lib', 'platform', 'conversation-bridge.js');
      if (existsSync(file)) return file;
    } catch {}
  }
  return null;
}

// One patch per process, shared by every dot instance (plugin reloads re-use it).
const REGISTRY = Symbol.for('dsh-dot.bridges');
const state = (globalThis[REGISTRY] ??= { patched: false, bridges: new Set(), error: null });

async function patchBridge(logger) {
  if (state.patched || state.error) return state;
  const file = locateBridge();
  if (!file) { state.error = 'dsh-bridge not installed'; return state; }
  try {
    const { ConversationBridge } = await import(pathToFileURL(file).href);
    const proto = ConversationBridge?.prototype;
    if (typeof proto?.sendText !== 'function' || typeof proto?._attachOutbound !== 'function') {
      throw new Error('unexpected ConversationBridge shape');
    }
    const { sendText, _attachOutbound } = proto;
    proto._attachOutbound = function (...args) {
      state.bridges.add(this);
      return _attachOutbound.apply(this, args);
    };
    proto.sendText = function (text, opts) {
      state.bridges.add(this);
      if (isSilent(text)) return Promise.resolve();
      // A reply that ends with the marker after real content: drop the marker only.
      const clean = typeof text === 'string' ? text.replace(new RegExp(`\\s*${SILENT}\\s*$`), '') : text;
      if (typeof clean === 'string' && !clean.trim()) return Promise.resolve();
      return sendText.call(this, clean, opts);
    };
    state.patched = true;
    logger.info('dsh-bridge linked (silence, session binding, direct notify)');
  } catch (err) {
    state.error = err.message;
    logger.warn(`dsh-bridge link disabled: ${err.message}`);
  }
  return state;
}

const online = (b) => b.platform?.status !== 'idle' && b.platform?.status !== 'offline' && !b._disposed;

/**
 * @param {{ logger: object, webhook?: string }} options
 */
export function createIm({ logger, webhook }) {
  const ready = patchBridge(logger);

  /** Sessions currently bound to a connected IM chat, most useful first. */
  function boundSessions() {
    return [...state.bridges].filter((b) => online(b) && b.activeSessionId).map((b) => ({
      platform: b.platform?.id ?? 'im', sessionId: b.activeSessionId,
    }));
  }

  async function postWebhook(title, text) {
    if (!webhook) return false;
    const body = /open\.feishu\.cn|larksuite\.com/.test(webhook)
      ? { msg_type: 'text', content: { text: `${title}\n${text}` } }
      : /qyapi\.weixin\.qq\.com/.test(webhook)
        ? { msgtype: 'text', text: { content: `${title}\n${text}` } }
        : /sctapi\.ftqq\.com/.test(webhook)
          ? { title, desp: text }
          : { title, text };
    try {
      const res = await fetch(webhook, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (err) {
      logger.warn(`notify webhook failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Tell the user something without the model. IM chats first, webhook as fallback.
   * @returns {Promise<string[]>} channels that accepted the message.
   */
  async function notify(title, text) {
    await ready;
    const sent = [];
    for (const b of state.bridges) {
      if (!online(b) || !(b.peerId || b.config?.allowFrom?.length)) continue;
      try { await b.sendText(`${title}\n${text}`); sent.push(b.platform?.id ?? 'im'); } catch (err) { logger.warn(`IM notify failed: ${err.message}`); }
    }
    if (!sent.length && (await postWebhook(title, text))) sent.push('webhook');
    if (!sent.length) logger.warn(`no channel reached the user: ${title}`);
    return sent;
  }

  return {
    ready,
    notify,
    boundSessions,
    status: () => ({ linked: state.patched, error: state.error, chats: boundSessions().length, webhook: Boolean(webhook) }),
  };
}

// How a model call ended (outcomeOf), and the one way a hand-built call is made (callModel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeOf, outcomeText, createGate } from '../src/llm-gate.js';
import { callModel, collectReply, readReply, WORK } from '../src/llm-call.js';
import { collectReply as fromInterlude } from '../src/interlude/core.js';

const err = (code, extra = {}) => ({ kind: 'error', failure: { code, message: `m ${code}`, ...extra } });
const stream = (chunks) => (async function* () { yield* chunks; })();

test('outcome: every failure code dsh names, every finish kind, and an empty stop', () => {
  const kinds = {
    RATE_LIMIT: 'rate-limit', QUOTA: 'quota', ACCOUNT_QUOTA: 'quota',
    AUTH: 'auth', INVALID_CREDENTIAL: 'auth', MISSING_CREDENTIAL: 'auth', ACCOUNT_SIGN_IN_REQUIRED: 'auth', ACCOUNT_TOKEN_INVALID: 'auth',
    CONTEXT_WINDOW_EXCEEDED: 'context', EMPTY_RESPONSE: 'empty',
    SERVER: 'transient', TIMEOUT: 'transient', TRANSPORT: 'transient', STREAM_CLOSED: 'transient', MALFORMED_RESPONSE: 'transient', HTTP_502: 'transient',
    INVALID_REQUEST: 'other', NO_ADAPTER: 'other', UNKNOWN: 'other', HTTP_404: 'other',
  };
  for (const [code, kind] of Object.entries(kinds)) assert.equal(outcomeOf(err(code)).kind, kind, code);
  assert.deepEqual(outcomeOf(err('RATE_LIMIT', { providerRetryAfterMs: 5000 })), { kind: 'rate-limit', code: 'RATE_LIMIT', message: 'm RATE_LIMIT', retryable: true, retryAfterMs: 5000 });
  assert.equal(outcomeOf(err('QUOTA')).retryable, false);
  assert.equal(outcomeOf({ kind: 'aborted', failure: { code: 'ABORTED', message: 'x' } }).kind, 'aborted');
  assert.equal(outcomeOf({ kind: 'max-tokens' }, { text: '{"a":' }).kind, 'truncated');
  assert.equal(outcomeOf({ kind: 'stop' }, { text: '  \n' }).kind, 'empty', 'no words is not a reply');
  assert.equal(outcomeOf({ kind: 'tool-calls' }, { calls: [{ name: 'howto', args: '{}' }] }).kind, 'ok');
  assert.equal(outcomeOf({ kind: 'stop' }, { text: '好' }).kind, 'ok');
  // a turn that ended carries the same failure under `error`
  assert.equal(outcomeOf({ kind: 'error', error: { code: 'QUOTA', message: 'Insufficient Balance' } }).kind, 'quota');
  assert.equal(outcomeOf({ kind: 'completed' }, { text: 'x' }).kind, 'ok');
  assert.equal(outcomeText(outcomeOf(err('QUOTA'))), 'quota (QUOTA): m QUOTA');
});

test('collectReply moved: one function, still importable where it was, still throwing on an error finish', async () => {
  assert.equal(fromInterlude, collectReply);
  await assert.rejects(collectReply(stream([{ type: 'finish', reason: err('SERVER') }])), /ended with error: m SERVER/);
  const r = await readReply(stream([{ type: 'text-delta', text: 'a' }, { type: 'finish', reason: err('SERVER') }]));
  assert.equal(r.text, 'a');
  assert.equal(r.finish.failure.code, 'SERVER');
});

test('callModel: the default model, the effort asked for, background marked, the request as given; its outcome', async () => {
  const sent = [];
  let reply = [{ type: 'text-delta', text: '好' }, { type: 'finish', reason: { kind: 'stop' } }];
  const ctx = {
    get: (n) => ({
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }) },
      llm: { resolveCallConfig: async (c) => c, stream: (o) => { sent.push(o); return stream(reply); } },
    }[n]),
  };
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }];
  const a = await callModel(ctx, { system: 's', maxTokens: 9, messages });
  assert.deepEqual(Object.keys(sent[0]), ['provider', 'model', 'reasoningEffort', 'system', 'maxTokens', 'messages']);
  assert.equal(sent[0].reasoningEffort, 'low', 'no effort asked: the selector\'s own');
  assert.equal(sent[0].messages, messages, 'the very messages');
  assert.deepEqual([a.ok, a.text, a.outcome.kind], [true, '好', 'ok']);
  await callModel(ctx, { effort: WORK, background: true, tools: [{ name: 't' }], maxTokens: 9, messages });
  assert.deepEqual(Object.keys(sent[1]), ['provider', 'model', 'reasoningEffort', 'tools', 'maxTokens', 'messages']);
  assert.equal(sent[1].reasoningEffort, 'high', 'llm.workEffort');
  const gate = createGate({});
  assert.deepEqual([gate.classify(sent[0]), gate.classify(sent[1])], ['foreground', 'background']);
  reply = [{ type: 'finish', reason: err('QUOTA') }];
  const q = await callModel(ctx, { maxTokens: 9, messages });
  assert.deepEqual([q.ok, q.outcome.kind], [false, 'quota']);
  ctx.get = () => undefined;
  assert.equal((await callModel(ctx, { maxTokens: 9, messages })).outcome.kind, 'no-model');
  // a component that injected them has them on ctx
  const own = { llm: { stream: (o) => { sent.push(o); return stream([{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }]); } }, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } };
  assert.equal((await callModel(own, { maxTokens: 9, messages })).text, 'x');
  assert.equal('reasoningEffort' in sent.at(-1), false);
});

// dsh-dot/price: one price table, one way to count a call — yuan at the price of its hour, 折算 token at idle prices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addYuan, charge, configure, costOf, isPeak, noteRoute, priceLine, priceOf, resetPrices, routeFor, unitsOf, unitsYuan, unknownRoutes, usageOf, weightsOf, yuanText } from '../src/price.js';

const FLASH = { provider: 'deepseek-account', model: 'deepseek-flash' };
// Beijing wall clock → ms (UTC+8, no DST).
const bj = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('price: a cache hit is 0.02 of an uncached input token, an output token 4 — in 折算 token and in yuan', () => {
  resetPrices();
  assert.deepEqual(weightsOf(FLASH), { cached: 0.02, in: 1, out: 4 });
  close(unitsOf({ cacheReadTokens: 1e6 }, FLASH), 20000);
  close(unitsOf({ inputTokens: 1e6 }, FLASH), 1e6);
  close(unitsOf({ outputTokens: 1e6 }, FLASH), 4e6);
  // a cache write is billed as input (DeepSeek has none; dsh-llm reports it apart when a provider does)
  close(unitsOf({ inputTokens: 100, cacheWriteTokens: 50 }, FLASH), 150);
  // a cost record counts the same as the usage it was made from
  assert.deepEqual(usageOf({ inputTokens: 3, cacheReadTokens: 2, outputTokens: 1, cacheWriteTokens: 4 }), { in: 7, cached: 2, out: 1 });
  close(unitsOf({ in: 28000, cached: 678000, out: 10000 }, FLASH), unitsOf({ inputTokens: 28000, cacheReadTokens: 678000, outputTokens: 10000 }, FLASH));
  const idle = bj(2026, 11, 26, 22);
  close(costOf({ cacheReadTokens: 1e6 }, idle, FLASH), 0.02);
  close(costOf({ inputTokens: 1e6 }, idle, FLASH), 1);
  close(costOf({ outputTokens: 1e6 }, idle, FLASH), 4);
  // 11-23「看安卓版本」: 67.8 万 cache hits, 2.8 万 uncached input, 1 万 output (the split is an estimate)
  close(unitsOf({ in: 28000, cached: 678000, out: 10000 }, FLASH), 81560);
  close(costOf({ in: 28000, cached: 678000, out: 10000 }, idle, FLASH), 0.08156);
});

test('price: peak hours are Beijing weekdays 9–12 and 14–18; the rest, weekends whole, is idle — yuan doubles, 折算 token does not', () => {
  resetPrices();
  // Thursday 2026-11-26
  for (const [h, m, peak] of [[8, 59, false], [9, 0, true], [11, 59, true], [12, 0, false], [13, 59, false], [14, 0, true], [17, 59, true], [18, 0, false], [23, 0, false], [3, 0, false]]) {
    assert.equal(isPeak(bj(2026, 11, 26, h, m)), peak, `Thu ${h}:${m}`);
  }
  // Saturday and Sunday: idle all day; Monday morning and Friday afternoon: peak
  for (const d of [28, 29]) for (const h of [9, 10, 15, 17]) assert.equal(isPeak(bj(2026, 11, d, h)), false, `11-${d} ${h}:00`);
  assert.equal(isPeak(bj(2026, 11, 30, 9)), true, 'Monday 9:00');
  assert.equal(isPeak(bj(2026, 11, 27, 17, 30)), true, 'Friday 17:30');
  // the zone is Beijing's whatever the machine's: 10:00 Beijing is 02:00 UTC
  assert.equal(isPeak(Date.UTC(2026, 10, 26, 2)), true);
  assert.equal(isPeak(Date.UTC(2026, 10, 26, 10)), false, '18:00 Beijing');
  const u = { inputTokens: 1000, cacheReadTokens: 50000, outputTokens: 500 };
  const peak = bj(2026, 11, 26, 10), idle = bj(2026, 11, 28, 10);
  assert.equal(priceOf(FLASH, peak).peak, true);
  assert.deepEqual([priceOf(FLASH, peak).cached, priceOf(FLASH, peak).in, priceOf(FLASH, peak).out], [0.04, 2, 8]);
  close(costOf(u, peak, FLASH), 2 * costOf(u, idle, FLASH));
  assert.deepEqual(charge(u, { at: peak, route: FLASH }).units, charge(u, { at: idle, route: FLASH }).units);
  close(charge(u, { at: idle, route: FLASH }).yuan, charge(u, { at: idle, route: FLASH }).units / 1e6);
  assert.deepEqual(unitsYuan(1e6, FLASH), { idle: 1, peak: 2 });
});

test('price: a model the table does not know is counted without a discount and without yuan, and said once', () => {
  resetPrices();
  const warned = [];
  configure({ warn: (m) => warned.push(m) });
  const other = { provider: 'openrouter', model: 'some-model' };
  const c = charge({ inputTokens: 100, cacheReadTokens: 1000, outputTokens: 10 }, { route: other });
  assert.deepEqual(c, { units: 1110, yuan: null });
  charge({ inputTokens: 1 }, { route: other });
  assert.equal(warned.length, 1, 'logged once');
  assert.match(warned[0], /no price for openrouter\/some-model/);
  assert.deepEqual(unknownRoutes(), ['openrouter/some-model']);
  assert.match(priceLine(FLASH), /no price for openrouter\/some-model/);
  assert.match(priceLine(other), /^price: none known for openrouter\/some-model/);
  // no route at all (no model selected): the same, never a made-up price
  assert.equal(charge({ outputTokens: 5 }).yuan, null);
  assert.equal(unitsYuan(1e6, other), null);
  assert.equal(addYuan(0.1, null), null);
  close(addYuan(undefined, 0.1), 0.1);
  resetPrices();
});

test('price: his own price (interlude.price) is used for every model and every hour, the weights follow it', () => {
  resetPrices();
  configure({ price: { in: 2, cached: 0.5, out: 3 } });
  const other = { provider: 'x', model: 'y' };
  assert.deepEqual(weightsOf(other), { cached: 0.25, in: 1, out: 1.5 });
  close(costOf({ inputTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 1e6 }, bj(2026, 11, 26, 10), FLASH), 5.5);
  assert.equal(priceOf(FLASH, bj(2026, 11, 26, 10)).peak, false);
  assert.match(priceLine(FLASH), /your own/);
  // no cached price: a cache hit costs what input does
  configure({ price: { in: 1 } });
  assert.deepEqual(weightsOf(other), { cached: 1, in: 1, out: 1 });
  // null: back to the table; a price without "in" is ignored and said
  const warned = [];
  configure({ price: { out: 2 }, warn: (m) => warned.push(m) });
  assert.deepEqual(weightsOf(FLASH), { cached: 0.02, in: 1, out: 4 });
  assert.match(warned[0], /interlude\.price ignored/);
  resetPrices();
});

test('price: a session\'s calls go to the model its last request header named, else the default selection', () => {
  const ctx = { get: (n) => (n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' }) } : undefined) };
  assert.deepEqual(routeFor(ctx, 'h9'), FLASH);
  noteRoute('h9', { type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'deepseek-pro' } } } });
  assert.deepEqual(routeFor(ctx, 'h9'), { provider: 'deepseek', model: 'deepseek-pro' });
  noteRoute('h9', { type: 'assistant/message', data: {} });
  assert.deepEqual(routeFor(ctx, 'h9'), { provider: 'deepseek', model: 'deepseek-pro' });
  assert.equal(routeFor({ get: () => undefined }, 'none'), null);
  assert.equal(yuanText(null), '');
  assert.equal(yuanText(1.157), '¥1.16');
  assert.equal(yuanText(0.08156), '¥0.082');
  assert.equal(yuanText(0.00408), '¥0.0041');
});

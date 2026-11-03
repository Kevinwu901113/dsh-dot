import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inventory, renderItem } from '../scripts/prompts.mjs';

// npm run prompts points at file:line; when code moves, this fails until the inventory is updated.
test('prompts inventory: every file:line anchor still holds its identifier', () => {
  for (const it of inventory) {
    for (const [file, line, find] of it.at) {
      const got = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split('\n')[line - 1] ?? '';
      assert.ok(got.includes(find), `${it.name}: ${file}:${line} should contain ${find}, has: ${got.trim().slice(0, 80)}`);
    }
  }
});

test('prompts inventory: every item renders through the real code with its samples', async () => {
  for (const it of inventory) {
    const { rendered, regions } = await renderItem(it);
    assert.ok(rendered && !rendered.startsWith('（渲染失败'), `${it.name}: ${rendered.slice(0, 200)}`);
    assert.ok(regions.every((r) => !r.drift && r.code.length), it.name);
  }
});

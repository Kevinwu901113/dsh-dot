// dsh-dot/manuals: her phone and computer manuals come on first use, not in every prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createManuals, defaultManuals } from '../src/dot/manuals.js';

const routes = defaultManuals({ phonePrefix: 'mcp__dot-phone__', vmPrefix: 'mcp__dot-vm__', phoneZoom: 'phone_zoom' });
const make = () => createManuals({ routes, hint: (k) => `[${k} hint]`, given: (k, m) => `first ${k}:\n${m}` });
const assembly = () => ({ sections: [
  { name: 'interlude:canon', text: '# 你是小点' },
  { name: 'phone:device', text: 'PHONE MANUAL' },
  { name: 'qq:channel', text: 'QQ' },
  { name: 'mcp:dot-phone', text: 'PHONE MCP' },
  { name: 'mcp:dot-vm', text: 'VM MCP' },
], contexts: [], tools: [] });

test('manuals: routed sections become one line each in the prompt, the same every step of a session', () => {
  const m = make();
  const a = m.assemble(assembly(), 's1');
  assert.deepEqual(a.sections.map((s) => [s.name, s.text]), [['interlude:canon', '# 你是小点'], ['phone:device', '[phone hint]'], ['qq:channel', 'QQ'], ['mcp:dot-vm', '[computer hint]']]);
  assert.deepEqual(m.assemble(assembly(), 's1').sections, a.sections, 'stable prefix');
  // not routed: no session, or nothing to route
  assert.equal(m.assemble(assembly(), '').sections.length, 5);
  const plain = { sections: [{ name: 'x', text: 'y' }] };
  assert.equal(m.assemble(plain, 's2'), plain);
  // an empty section (phone not up) is left alone and no hint stands in for it
  const empty = m.assemble({ sections: [{ name: 'phone:device', text: '' }] }, 's3');
  assert.deepEqual(empty.sections, [{ name: 'phone:device', text: '' }]);
});

test('manuals: the first call of a routed tool in a session brings the whole manual along (once per session); later calls and other tools bring nothing', () => {
  const m = make();
  m.assemble(assembly(), 's1');
  assert.equal(m.take('mcp__dot-phone__mobile_list_apps', 's1'), 'first phone:\nPHONE MANUAL\n\nPHONE MCP');
  assert.equal(m.take('mcp__dot-phone__mobile_list_apps', 's1'), null);
  assert.equal(m.take('account', 's1'), null, 'same manual');
  assert.equal(m.take('mcp__dot-vm__browser_navigate', 's1'), 'first computer:\nVM MCP');
  assert.equal(m.take('qq_send', 's1'), null);
  assert.equal(m.take('mcp__dot-phone__mobile_list_apps', 'other'), null, 'a session whose prompt was never routed (not hers)');
  assert.equal(m.has('s1', 'phone'), true);
  // a new session gets the manual again
  m.assemble(assembly(), 's2');
  assert.match(m.take('phone_zoom', 's2'), /^first phone/);
  m.forget('s2');
  assert.equal(m.take('phone_zoom', 's2'), null);
});

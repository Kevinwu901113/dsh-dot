import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildScenes, createActivity, firstSentence, tailLines } from '../src/dot/activity.js';

const pad = (n) => String(n).padStart(2, '0');
const head = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} 星期二 上午`; };
const iso = (ms) => new Date(ms).toISOString();

/** One day of her life, written the way the components write their records. */
function day() {
  const now = Date.now();
  const base = Math.floor((now - 8 * 3600000) / 60000) * 60000;
  const at = (min, sec = 0) => base + min * 60000 + sec * 1000;
  const dsh = mkdtempSync(join(tmpdir(), 'dsh-act-'));
  const home = mkdtempSync(join(tmpdir(), 'home-act-'));
  mkdirSync(join(home, 'memory')); mkdirSync(join(home, 'interlude'));
  const audit = [], qq = [], tr = [], ic = [], mc = [];
  // 1. his QQ message: qq audit + dot owner-message + transcript; she answers with qq_send; two VM tools
  qq.push({ ts: iso(at(0)), kind: 'private', userId: '20002', groupId: '', who: '宽', text: '在吗，今天干嘛了', fromOwner: true }); // qq.js: { kind: 'message', ...msg } — msg.kind wins
  audit.push({ ts: iso(at(0, 2)), kind: 'dot', event: 'owner-message', session: 's1', count: 1 });
  tr.push({ at: at(0, 3), who: 'owner', session: 's1', text: '在吗，今天干嘛了' });
  audit.push({ ts: iso(at(0, 20)), kind: 'tool', tool: 'bash', session: 's1', ok: true });
  audit.push({ ts: iso(at(0, 25)), kind: 'tool', tool: 'mcp__dot-vm__browser_navigate', session: 's1', ok: true });
  qq.push({ ts: iso(at(0, 40)), kind: 'sent', to: { user_id: 20002 }, text: '在的 / 刚睡醒', images: [] });
  tr.push({ at: at(0, 40), who: 'her', session: 's1', to: 'owner', text: '在的 / 刚睡醒' });
  // 2. 小黑盒 notification → errand; the errand's conclusion lands in her conversation as a note
  audit.push({ ts: iso(at(30)), kind: 'notification', change: 'posted', pkg: 'com.max.xiaoheihe', title: '小黑盒', text: '有人赞了你的帖子' });
  audit.push({ ts: iso(at(30, 2)), kind: 'dot', event: 'notification-woke', session: 'e1', count: 1, pkgs: ['com.max.xiaoheihe'] });
  tr.push({ at: at(31), who: 'note', session: 's1', text: '[刚才手机响了，你去看了] 是阿满给我点了个赞' });
  // 3. a 幕间 round: tokens, the passage, a look on her phone, a message to him, the round audit
  ic.push({ ts: iso(at(60)), phase: 'advance', acts: 1, model: 'deepseek/x', usage: { in: 1000, out: 200, cached: 500 } });
  ic.push({ ts: iso(at(60, 50)), phase: 'advance:refresh', usage: { in: 100, out: 20, cached: 0 } });
  qq.push({ ts: iso(at(60, 30)), kind: 'sent', to: { user_id: 20002 }, text: '午饭吃了吗', images: [] });
  audit.push({ ts: iso(at(61)), kind: 'interlude', event: 'browse', phase: 'advance', via: 'phone', mode: 'visit', query: 'https://www.xiaoheihe.cn/x' });
  audit.push({ ts: iso(at(61, 5)), kind: 'interlude', event: 'play', phase: 'advance', app: '小黑盒', action: 'like', target: '那篇攻略', why: '写得好', session: 'e1' });
  audit.push({ ts: iso(at(61, 6)), kind: 'interlude', event: 'round', phase: 'advance', said: true });
  tr.push({ at: at(64), who: 'note', session: 's1', text: '[刚才在手机上玩了会儿] 给那篇攻略点了赞' });
  // 4. she picks up her phone; installs an app (approval)
  audit.push({ ts: iso(at(120)), kind: 'dot', event: 'phone-check', session: 'e1', errand: true });
  audit.push({ ts: iso(at(121)), kind: 'approval-asked', tool: 'mcp__dot-phone__mobile_install_app', session: 'e1', reason: 'dsh-dot/phone: mobile_install_app' });
  // 5. a group message from 阿满 with a sticker; she sends a sticker back
  qq.push({ ts: iso(at(180)), kind: 'group', userId: '30003', groupId: '777', who: '阿满', text: '[表情包 sticker:abcdef0123] 哈哈', fromOwner: false });
  audit.push({ ts: iso(at(180, 2)), kind: 'dot', event: 'notification-woke', session: 's1', count: 1, pkgs: ['qq'] });
  qq.push({ ts: iso(at(180, 4)), kind: 'sticker-kept', id: 'abcdef0123', from: '阿满' });
  qq.push({ ts: iso(at(181)), kind: 'sent', to: { group_id: 777 }, text: '', images: ['sticker:abcdef0123'] });
  // 6. a scheduled task
  tr.push({ at: at(240), who: 'schedule', session: 's1', text: '看看今天的天气' });
  tr.push({ at: at(241), who: 'her', session: 's1', text: '今天晴，最高 22 度。' });
  // 7. the daily consolidation wrote her diary
  mc.push({ at: iso(at(300)), reason: 'daily', lines: 12, usage: { in: 3000, out: 150 } });
  mc.push({ at: iso(at(200)), reason: 'lines', lines: 20, usage: { in: 2000, out: 100 } });
  // 8. his next message, still being answered
  tr.push({ at: at(400), who: 'owner', session: 's1', text: '晚安' });
  writeFileSync(join(dsh, 'dsh-computer-audit.jsonl'), audit.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(dsh, 'dsh-qq-audit.jsonl'), qq.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(home, 'memory', 'transcript.jsonl'), tr.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(home, 'memory', 'calls.jsonl'), mc.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const d = new Date(at(300));
  writeFileSync(join(home, 'memory', 'diary.md'), `## ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 周二\n今天阿满给我点了赞，我也给他的攻略点了一个。\n\n`);
  writeFileSync(join(home, 'interlude', 'calls.jsonl'), ic.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(home, 'interlude', 'script.md'), `## ${head(at(60))} · advance\n她把手机翻过来看了一眼。窗外有点阴。\n\n`);
  return { dsh, home, at, now };
}

test('activity: one scene per wake, with what she did in her own words and what it cost', () => {
  const { dsh, home, at } = day();
  const act = createActivity({ dshHome: dsh, home });
  const scenes = act.scenes({ busy: (id) => id === 's1', isErrand: (id) => id === 'e1' });
  const byAt = (min) => scenes.find((s) => s.at === at(min) || Math.abs(s.at - at(min)) < 5000);

  const owner = byAt(0);
  assert.equal(owner.source.kind, 'owner');
  assert.equal(owner.trigger, '在吗，今天干嘛了');
  assert.deepEqual(owner.actions.map((a) => [a.k, a.text]), [['qq', '在的 / 刚睡醒']], 'qq_send once: the transcript line of the same send is not a second action');
  assert.equal(owner.stats.tools, 2);
  assert.equal(owner.status, 'done');

  const ring = byAt(30);
  assert.deepEqual(ring.source, { kind: 'phone', name: '小黑盒' });
  assert.equal(ring.trigger, '小黑盒：有人赞了你的帖子');
  assert.deepEqual(ring.actions.map((a) => [a.k, a.text]), [['saw', '是阿满给我点了个赞']], 'the errand note, bracket dropped, no signature');

  const round = byAt(60);
  assert.deepEqual(round.source, { kind: 'interlude', name: 'advance' });
  assert.deepEqual(round.actions.map((a) => a.k), ['interlude', 'contact', 'look']);
  assert.equal(round.actions[0].text, '她把手机翻过来看了一眼。', 'first sentence of the passage');
  assert.equal(round.actions[1].text, '午饭吃了吗');
  assert.equal(round.actions[2].via, 'phone');
  assert.deepEqual(round.stats, { tools: 0, model: 2, in: 1600, out: 220 });

  const play = scenes.find((s) => s.source.kind === 'play');
  assert.equal(play.source.name, '小黑盒');
  assert.deepEqual(play.actions.map((a) => [a.k, a.text]), [['like', '小黑盒 · 那篇攻略'], ['saw', '给那篇攻略点了赞']]);

  const check = byAt(120);
  assert.equal(check.source.kind, 'check');
  assert.deepEqual(check.actions.map((a) => a.k), ['install']);

  const group = byAt(180);
  assert.deepEqual(group.source, { kind: 'qq', name: '群 777 · 阿满' });
  assert.deepEqual(group.actions.map((a) => a.k), ['sticker', 'image']);

  const sched = byAt(240);
  assert.equal(sched.source.kind, 'schedule');
  assert.deepEqual(sched.actions.map((a) => [a.k, a.text]), [['reply', '今天晴，最高 22 度。']]);

  const diary = byAt(300);
  assert.deepEqual(diary.actions.map((a) => a.k), ['diary']);
  assert.match(diary.actions[0].text, /点了赞/);
  assert.equal(diary.stats.in, 3000);
  assert.ok(!scenes.some((s) => Math.abs(s.at - at(200)) < 5000), 'an ordinary consolidation is not a scene');

  const last = scenes[0];
  assert.equal(last.trigger, '晚安');
  assert.equal(last.status, 'running', 'her conversation is in a turn and this is its latest scene');
  assert.ok(scenes.every((s, i) => i === 0 || s.at <= scenes[i - 1].at), 'newest first');
});

test('activity: quotes are cut at ~80 characters; limit and day window hold', () => {
  const now = Date.now();
  const long = '啊'.repeat(200);
  const tr = [
    { at: now - 5 * 86400000, who: 'owner', session: 's1', text: '五天前' },
    ...Array.from({ length: 40 }, (_, i) => ({ at: now - (40 - i) * 60000 * 20, who: 'owner', session: 's1', text: i === 39 ? long : `第 ${i} 条` })),
  ];
  const scenes = buildScenes({ transcript: tr }, { now, limit: 30, days: 3 });
  assert.equal(scenes.length, 30);
  assert.equal(scenes[0].trigger.length, 81);
  assert.ok(scenes[0].trigger.endsWith('…'));
  assert.ok(!scenes.some((s) => s.trigger === '五天前'));
  assert.equal(firstSentence('他说：“走吧。”然后就走了。'), '他说：“走吧。”');
});

test('activity: only the tail of a file is read, and it is parsed again only when the file changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tail-'));
  const f = join(dir, 'a.jsonl');
  writeFileSync(f, Array.from({ length: 5000 }, (_, i) => JSON.stringify({ i })).join('\n') + '\n');
  const lines = tailLines(f, 4096);
  assert.ok(lines.length < 400 && lines.length > 100);
  assert.equal(JSON.parse(lines.at(-1)).i, 4999);
  assert.doesNotThrow(() => JSON.parse(lines[0]), 'the cut first line is dropped');
  writeFileSync(`${f.replace('a.jsonl', 'b.jsonl')}.1`, '{"old":1}\n');
  writeFileSync(f.replace('a.jsonl', 'b.jsonl'), '{"new":1}\n');
  assert.deepEqual(tailLines(f.replace('a.jsonl', 'b.jsonl'), 4096), ['{"old":1}', '{"new":1}'], 'a rotated audit fills the budget');

  const { dsh, home } = day();
  const act = createActivity({ dshHome: dsh, home });
  const a = act.read(); const b = act.read();
  assert.equal(a.transcript, b.transcript, 'unchanged file: the cached parse');
  appendFileSync(join(home, 'memory', 'transcript.jsonl'), `${JSON.stringify({ at: Date.now(), who: 'owner', session: 's1', text: '又一条' })}\n`);
  assert.notEqual(act.read().transcript, a.transcript);
  assert.equal(createActivity({ dshHome: join(dsh, 'nope'), home: join(home, 'nope') }).scenes().length, 0, 'no records, no scenes, no throw');
});

test('panel state carries the scenes; the page has the section in both languages', async () => {
  const { dsh, home } = day();
  const { collectState, pageHtml } = await import('../src/dot/panel.js');
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dsh;
  try {
    const ctx = { get: (n) => (n === 'dshDot' ? { home, busy: () => false, isErrand: (id) => id === 'e1', session: () => 's1', stats: () => null } : undefined) };
    const s = await collectState(ctx, { scenes: '5' });
    assert.equal(s.activity.scenes.length, 5);
    assert.equal(s.activity.scenes[0].trigger, '晚安');
  } finally { process.env.DSH_HOME = prev; }
  const page = pageHtml();
  assert.match(page, /最近 '\+n\+' 场/);
  assert.match(page, /Last '\+n\+' scenes/);
  assert.match(page, /api\/state\?scenes=/);
});

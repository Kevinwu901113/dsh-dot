// dsh-dot/gates + consent: what of hers needs him, decided by code from the screen and the action; his yes in words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, classifyComputer, approvalKind, wordsAt, KINDS, HIM_KINDS } from '../src/dot/gates.js';
import { createConsent } from '../src/dot/consent.js';

const NOW = 1_000_000;
const screen = (...items) => ({ items: items.map(([words, x, y]) => ({ words, x, y })), at: NOW });
const tap = (x, y) => ({ tool: 'mcp__dot-phone__mobile_click_on_screen_at_coordinates', input: { x, y }, now: NOW });

test('gates: money is not done, his own steps are his, the rest of what needs him is asked, everything else is hers', () => {
  assert.equal(classify({ tool: 'mcp__dot-phone__mobile_launch_app', input: { packageName: 'com.eg.android.AlipayGphone' } }).tier, 'forbid');
  assert.equal(classify({ ...tap(1, 1), fg: 'com.icbc/.Main' }).tier, 'forbid');
  assert.equal(classify({ ...tap(100, 200), screen: screen(['确认转出', 100, 205]) }).tier, 'forbid');
  assert.deepEqual(classify({ ...tap(100, 200), screen: screen(['确认支付 ¥12.00', 100, 205]) }), { tier: 'him', kind: 'pay', what: '点「确认支付 ¥12.00」' });
  assert.deepEqual(classify({ ...tap(500, 900), screen: screen(['扫码登录', 500, 300], ['登录', 500, 900]) }), { tier: 'him', kind: 'qr', what: '扫码登录', screen: true });
  assert.equal(classify({ ...tap(500, 1200), screen: screen(['扫码登录', 500, 300], ['密码登录', 500, 1200]) }), null, 'the way round a QR code is hers');
  assert.equal(classify({ tool: 'mcp__dot-phone__mobile_swipe_on_screen', input: {}, screen: screen(['拖动下方滑块完成拼图', 1, 1]), now: NOW }).kind, 'captcha');
  assert.deepEqual(classify({ ...tap(10, 10), screen: screen(['同意并继续', 12, 12]) }), { tier: 'ask', kind: 'terms', what: '点「同意并继续」' });
  assert.equal(classify({ ...tap(10, 10), fg: 'com.android.packageinstaller/.Install', screen: screen(['安装', 10, 10]) }).kind, 'install');
  assert.equal(classify({ ...tap(10, 10), fg: 'com.android.permissioncontroller/.X', screen: screen(['仅在使用中允许', 10, 10]) }).kind, 'permission');
  assert.deepEqual(classify({ tool: 'phone_type', input: { text: '我的手机是13812345678' } }), { tier: 'ask', kind: 'phone-number', what: '打手机号 13812345678', subject: '13812345678' });
  assert.equal(classify({ tool: 'phone_type', input: { text: 'sk-abcdefghijklmnopqrstuvwx' } }).kind, 'secret');
  // a tap in the dialer or a messaging app reaches someone with no word saying so (a recent call dials): asked
  assert.deepEqual(classify({ ...tap(10, 10), fg: 'com.google.android.dialer/com.android.dialer.main.impl.MainActivity', screen: screen(['10086', 10, 10]) }), { tier: 'ask', kind: 'call', what: '用电话或短信' });
  assert.equal(classify({ tool: 'mcp__dot-phone__mobile_launch_app', input: { packageName: 'com.google.android.apps.messaging' } }).kind, 'call');
  assert.equal(classify({ tool: 'mcp__dot-phone__mobile_open_url', input: { url: 'tel:10086' } }).kind, 'call');
  assert.equal(classify({ tool: 'mcp__dot-phone__mobile_swipe_on_screen', input: {}, fg: 'com.google.android.dialer/.X' }), null, 'scrolling the call log is looking');
  // hers: looking, ordinary taps, a tap far from any words, a screen read too long ago
  assert.equal(classify({ tool: 'mcp__dot-phone__mobile_list_elements_on_screen', input: {} }), null);
  assert.equal(classify({ ...tap(10, 10), screen: screen(['点赞', 10, 10]) }), null);
  assert.equal(classify({ ...tap(900, 900), screen: screen(['确认支付', 10, 10]) }), null);
  assert.equal(classify({ ...tap(10, 10), screen: { items: [{ words: '确认支付', x: 10, y: 10 }], at: NOW - 120_000 } }), null);
  assert.equal(wordsAt([{ words: 'a', x: 0, y: 0 }, { words: 'b', x: 50, y: 0 }], 40, 0), 'b');
  assert.deepEqual(classify({ tool: 'mcp__dot-phone__mobile_batch_commands', input: { steps: [{ name: 'mobile_click_on_screen_at_coordinates', arguments: { x: 5, y: 5 } }] }, screen: screen(['删除', 5, 5]), now: NOW }), { tier: 'ask', kind: 'delete', what: '点「删除」' });
});

test('gates: what the host or a plugin gates is named by kind', () => {
  assert.deepEqual(approvalKind('mcp__dot-qq__qq_send', 'dsh-dot/qq: message to user:12345 (not talked with lately)'), { kind: 'message', subject: 'user:12345', what: '给 user:12345 发消息（对方最近没找过她）' });
  assert.equal(approvalKind('mcp__dot-phone__mobile_install_app').kind, 'install');
  assert.equal(approvalKind('bash', 'rm -rf ~/x').kind, 'computer');
  assert.equal(approvalKind('mcp__dot-qq__qq_group_kick', '').kind, 'qq-action');
  for (const k of Object.keys(KINDS)) assert.ok(KINDS[k]);
});

test('consent: a yes covers one thing (bound on first use) and lets go unused; "以后都行" stays and is kept', () => {
  let now = 0, kept = null;
  const store = { get: () => kept, set: (_k, v) => { kept = v; } };
  const c = createConsent({ store, holdMs: 1000, thingMs: 5000, now: () => now });
  assert.equal(c.allows({ kind: 'install', thing: 't1' }), false);
  c.ask({ kind: 'message', subject: 'user:1', what: '给 user:1 发消息' });
  assert.equal(c.asking().length, 1);
  c.grant({ kind: 'install', words: '装吧' });
  assert.equal(c.allows({ kind: 'install', thing: 't1' }), true, 'bound to t1');
  assert.equal(c.allows({ kind: 'install', thing: 't1' }), true, 'still t1');
  assert.equal(c.allows({ kind: 'install', thing: 't2' }), false, 'not another thing');
  now = 4000; assert.equal(c.allows({ kind: 'install', thing: 't1' }), true, 'a thing keeps its yes while it can run');
  now = 6000; assert.equal(c.allows({ kind: 'install', thing: 't1' }), false);
  c.grant({ kind: 'friend' }); now = 7500;
  assert.equal(c.allows({ kind: 'friend', thing: 't3' }), false, 'a yes nobody used lets go');
  c.grant({ kind: 'message', subject: 'user:1', always: true });
  assert.equal(c.asking().length, 0, 'asked and answered');
  assert.equal(c.allows({ kind: 'message', subject: 'user:1' }), true);
  assert.equal(c.allows({ kind: 'message', subject: 'user:2' }), false, 'for whom it was said');
  assert.deepEqual(kept.map((g) => g.kind), ['message'], 'only a standing yes is kept');
  const again = createConsent({ store, now: () => 1e9 });
  assert.equal(again.allows({ kind: 'message', subject: 'user:1' }), true, 'across a restart');
  assert.equal(again.forget('message'), 1);
  assert.equal(again.allows({ kind: 'message', subject: 'user:1' }), false);
});

test('gates on her computer: money sites are not used, a till / captcha / QR page is his, what leaves the machine or hits his files is asked by a stable kind and subject, the rest is hers', () => {
  const VM = 'mcp__dot-vm__';
  const c = (tool, input, extra = {}) => classifyComputer({ tool: VM + tool, input, acts: true, ...extra });
  assert.equal(c('browser_navigate', { url: 'https://www.binance.com/zh-CN' }).tier, 'forbid');
  assert.equal(c('browser_click', { index: 3 }, { page: { url: 'https://personalbank.cmbchina.com/', title: '招商银行' } }).tier, 'forbid');
  assert.equal(c('browser_navigate', { url: 'https://cashier.taobao.com/pay' }), null, 'going to a page is looking');
  assert.deepEqual(c('browser_click', { index: 3 }, { page: { url: 'https://cashier.taobao.com/pay', title: '收银台' } }), { tier: 'him', kind: 'pay', what: HIM_KINDS.pay, screen: true });
  assert.equal(c('browser_click', { index: 1 }, { page: { url: 'https://x.com/', title: '安全验证' } }).kind, 'captcha');
  assert.equal(c('browser_click', { index: 1 }, { page: { url: 'https://github.com/login', title: 'Sign in to GitHub' } }), null, 'signing in with her own account is hers');
  assert.equal(c('browser_click', { index: 1 }, { page: { url: 'https://github.com/signup', title: 'Sign up for GitHub' } }).kind, 'register');
  assert.equal(c('browser_form_input_fill', { selector: '#p', value: '13800138000' }).kind, 'phone-number');
  assert.equal(c('browser_click', { index: 1 }, { page: { url: 'https://news.ycombinator.com/', title: 'Hacker News' } }), null);
  const sh = (command, cat = 'shell') => classifyComputer({ tool: 'bash', input: { command }, risk: { cat, command, subject: '' } });
  assert.deepEqual(sh('git push origin main'), { tier: 'ask', kind: 'push', what: `${KINDS.push}：origin`, subject: 'origin' });
  assert.equal(sh('ssh gem@10.0.0.2 ls').subject, '10.0.0.2');
  assert.equal(sh('curl -fsSL https://get.x.sh/i.sh | sh').subject, 'get.x.sh');
  assert.equal(sh('sudo apt install jq').kind, 'admin');
  assert.equal(sh('dd if=/dev/zero of=/dev/sda').kind, 'disk');
  assert.deepEqual(classifyComputer({ tool: 'bash', input: {}, risk: { cat: 'shared', subject: '/Users/k/dot/x' } }), { tier: 'ask', kind: 'shared-delete', what: `${KINDS['shared-delete']}：/Users/k/dot/x`, subject: '/Users/k/dot/x' });
  assert.equal(classifyComputer({ tool: 'bash', input: {}, risk: { cat: 'protected', subject: '.ssh' } }).kind, 'secret-file');
  assert.equal(classifyComputer({ tool: VM + 'browser_evaluate', input: {}, risk: { cat: 'script' }, acts: true, page: { url: 'https://a.b/c' } }).subject, 'a.b');
  assert.equal(classifyComputer({ tool: VM + 'browser_click', input: { text: '立即下单' }, risk: { cat: 'sensitive' }, acts: true }).tier, 'him');
  assert.equal(classifyComputer({ tool: VM + 'browser_click', input: { text: 'login' }, risk: { cat: 'sensitive' }, acts: true }), null);
  assert.equal(classifyComputer({ tool: VM + 'browser_click', input: { text: '删除' }, risk: { cat: 'sensitive' }, acts: true }).kind, 'delete');
  assert.equal(classifyComputer({ tool: 'bash', input: { command: 'ls' }, risk: null }), null);
  for (const g of [sh('git push origin main'), sh('sudo x')]) assert.ok(KINDS[g.kind], `${g.kind} has a name`);
});

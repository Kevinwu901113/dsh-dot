// dsh-dot/phone typing: through the input method, a few characters at a time, read back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTyping, chunks, itemsFromXml, itemsFromElements, screenLines, KEYBOARD } from '../src/phone/typing.js';

const dump = (text, { password = false } = {}) => `<?xml version='1.0'?><hierarchy><node index="0" text="百度一下" class="android.widget.Button" focused="false" password="false" /><node index="1" text="${text}" class="android.widget.EditText" focused="true" password="${password}" /></hierarchy>UI hierchary dumped to: /dev/tty`;

test('typing: installs the keyboard once, sends the text in pieces through it, and says whether it arrived', async () => {
  assert.deepEqual(chunks('鲸鱼娘 贴吧😀x', 3), ['鲸鱼娘', ' 贴吧', '😀x']);
  assert.deepEqual(itemsFromXml(dump('a &amp; b')).find((i) => i.focused), { words: 'a & b', x: 0, y: 0, focused: true, password: false });
  assert.deepEqual(itemsFromElements([{ type: 'View', children: [{ type: 'EditText', text: '鲸鱼娘', focused: true, rect: { x: 100, y: 300, width: 400, height: 100 }, children: [] }, { label: '百度一下', rect: { x: 800, y: 300, width: 200, height: 100 } }] }]), [{ words: '鲸鱼娘', x: 300, y: 350, w: 400, h: 100, focused: true, password: false }, { words: '百度一下', x: 900, y: 350, w: 200, h: 100, focused: false, password: false }]);
  const cmds = []; let field = '', installed = 0, hasPkg = false, ime = 'com.google.android.inputmethod.latin/.LatinIME', works = true;
  const shell = async (cmd) => {
    cmds.push(cmd);
    if (cmd.startsWith('pm list packages')) return hasPkg ? `package:${KEYBOARD.pkg}\n` : '';
    if (cmd.startsWith('settings get secure default_input_method')) return ime;
    if (cmd.startsWith('ime set')) { ime = KEYBOARD.ime; return ''; }
    if (cmd.startsWith('am broadcast -a ADB_INPUT_B64')) { if (works) field += Buffer.from(cmd.split(' ').pop(), 'base64').toString('utf8'); return ''; }
    if (cmd.startsWith('uiautomator')) return dump(field);
    return '';
  };
  const audits = [];
  const typing = createTyping({ shell, install: async () => { installed++; hasPkg = true; }, sleep: async () => {}, audit: (e) => audits.push(e) });
  const r = await typing.type('鲸鱼娘 贴吧', { submit: true });
  assert.deepEqual(r, { typed: 6, verified: true, field: '鲸鱼娘 贴吧', submitted: true });
  assert.equal(installed, 1);
  assert.ok(cmds.includes(`ime set ${KEYBOARD.ime}`) && cmds.at(-1) === 'input keyevent 66');
  assert.equal(cmds.filter((c) => c.startsWith('am broadcast')).length, 2, 'two pieces');
  // nothing arrives: said so, and Enter is not pressed
  works = false; cmds.length = 0;
  const bad = await typing.type('再来一句', { submit: true });
  assert.deepEqual([bad.verified, bad.submitted], [false, false]);
  assert.ok(!cmds.includes('input keyevent 66') && !cmds.some((c) => c.startsWith('pm list')), 'the keyboard is checked once');
  assert.deepEqual(audits.map((e) => e.kind), ['keyboard-installed', 'typed', 'typed']);
});

test('typing: a field that cannot be read back (a password) claims nothing', async () => {
  const shell = async (cmd) => (cmd.startsWith('pm list') ? `package:${KEYBOARD.pkg}` : cmd.startsWith('settings get') ? KEYBOARD.ime : cmd.startsWith('uiautomator') ? dump('••••', { password: true }) : '');
  const r = await createTyping({ shell, install: async () => { throw new Error('not needed'); }, sleep: async () => {} }).type('hunter2');
  assert.deepEqual(r, { typed: 7, verified: null });
});

test('typing: no focused field in the dump (a web page) — the text newly on the screen counts; its absence claims nothing', async () => {
  let page = '<hierarchy><node text="百度一下" focused="false" /><node text="" class="android.widget.EditText" focused="false" /></hierarchy>';
  let lands = true;
  const shell = async (cmd) => {
    if (cmd.startsWith('pm list')) return `package:${KEYBOARD.pkg}`;
    if (cmd.startsWith('settings get')) return KEYBOARD.ime;
    if (cmd.startsWith('am broadcast') && lands) page = page.replace('text="" class', 'text="鲸鱼娘" class');
    return cmd.startsWith('uiautomator') ? page : '';
  };
  const typing = createTyping({ shell, install: async () => {}, sleep: async () => {}, chunkSize: 10 });
  assert.equal((await typing.type('鲸鱼娘')).verified, true);
  lands = false;
  assert.equal((await typing.type('别的字')).verified, null);
});

test('screenLines: the words on the screen and where to tap them, top to bottom, once each', () => {
  const xml = '<hierarchy><node text="" content-desc="" bounds="[0,0][1080,2400]" /><node text="百度一下" bounds="[800,300][1000,400]" focused="false" /><node text="" content-desc="语音搜索" bounds="[600,300][700,400]" /><node text="鲸鱼娘" class="android.widget.EditText" bounds="[100,300][500,400]" focused="true" /><node text="鲸鱼娘" bounds="[100,300][500,400]" /><node text="新闻" bounds="[0,900][200,1000]" /></hierarchy>';
  assert.equal(screenLines(itemsFromXml(xml)), '「鲸鱼娘」(300, 350) ←光标在这\n「语音搜索」(650, 350)\n「百度一下」(900, 350)\n「新闻」(100, 950)');
  assert.equal(screenLines([]), '');
  assert.equal(screenLines(itemsFromXml(xml), { max: 1 }).split('\n').length, 1);
});

test('computer gate: > | ; inside quotes are text — a script handed to a tool is not a redirect into a shared folder', async () => {
  const { sharedTouch } = await import('../src/computer/gate.js');
  const o = { shared: ['/Users/k/dot'], cwd: '/Users/k/dot', home: '/home/gem' };
  assert.equal(sharedTouch(`agent-browser eval "(()=>{const t=document.body.innerText;return t.slice(0,9)})()" 2>&1 | tail -40`, o), '');
  assert.equal(sharedTouch('echo hi > notes.txt', o), '/Users/k/dot/notes.txt');
  assert.equal(sharedTouch('echo "a > b" > "my file.txt"', o), '/Users/k/dot/my file.txt');
  assert.equal(sharedTouch("grep 'x;rm -rf her' log.txt", o), '');
});

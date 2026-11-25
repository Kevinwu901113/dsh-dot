// dsh-dot/gates: what of hers needs him. Four tiers, decided by code from what is on the screen and what is about to
// be done — never from her own report (an agent asked about a risk spots it far more often than it does while acting).
//   forbid  not done, and not asked about: moving money, finance apps
//   him     he does it himself: paying at the last step, a face or ID check, a captcha, a QR login (she sends him the
//           screen); a code sent to his phone comes from him (her hands type only words she was given)
//   ask     she asks him in her own words, and goes on once he says yes (his_ok)
//   (her)   everything else, a password from her account book included
// On her phone the list that is kept is of what only looks (PHONE_LOOK_TOOLS): any other tool is an action, judged
// here — one this file has no rule for is asked about, never let through for being unknown. A press at a point is
// judged by the words under it; when the screen cannot be read, or the app in front is not known, it is asked about
// too. A batch is its steps, each judged the same way.
// The lists are here and nowhere else: a word added to a list is the whole change.
import { PHONE_LOOK_TOOLS, PHONE_PASTE_TOOLS, PHONE_HANDS_TOOLS, PHONE_TYPE_TOOL } from '../tool-prefixes.js';

export const KINDS = {
  message: '给不熟的人或群发消息', 'send-file': '把设备上的文件发给别人', install: '在手机上装 App', delete: '删除、清空或卸载',
  register: '注册账号', terms: '同意条款或协议', friend: '加好友、进群', call: '打电话、发短信', account: '改密码、绑定或解绑',
  permission: '给 App 开权限', 'phone-number': '打一个手机号', secret: '打密钥、口令一类的字', computer: '电脑上要他点头的操作',
  spend: '一件事花得比上限多', 'qq-action': 'QQ 上的其他操作', other: '要他点头的操作',
  blind: '在看不清的屏幕上点按', 'phone-tool': '手机上不常用的操作',
  // her computer (classifyComputer)
  remote: '让电脑连到别的机器（ssh、scp）', push: '把代码推出去（git push）', 'fetch-run': '下载一段东西直接跑', admin: '用管理员权限（sudo）',
  disk: '动整块磁盘', 'secret-file': '碰密钥、登录信息所在的文件', 'shared-delete': '删改他共享过来的文件夹', 'page-script': '在网页里跑脚本、直接按键',
  browser: '电脑浏览器上的操作',
  // the machine dsh runs on (classifyHost)
  host: '在他这台电脑本机上改动、安装或联网',
};
export const HIM_KINDS = { pay: '付款、下单的最后一步', identity: '实名、人脸或身份证', captcha: '人机验证（滑块、点图）', qr: '扫码登录', code: '发到他手机上的验证码' };

const FORBIDDEN_APPS = /alipay|unionpay|bank|icbc|chinamworld|cmb\.pb|bankcomm|jrapp|eastmoney|hexin|dazhihui|securities|stock|futu|tigerbrokers|binance|okex|okinc|bitget|coinbase|huobi|gateio|bybit|wallet/i;
const FORBIDDEN_WORDS = /转账|发红包|塞钱进红包|确认转出|提现/;
const HIM_CLICK = [[/确认支付|立即支付|确认付款|立即付款|去支付|提交订单|立即购买|确认购买|确认下单/, 'pay'], [/开始认证|人脸识别|刷脸|活体检测|开始验证身份|上传身份证/, 'identity']];
const HIM_SCREEN = [[/拖动.{0,6}滑块|滑动验证|安全验证|请完成.{0,8}验证|人机验证|依次点击|按顺序点击/, 'captcha'], [/扫码登录|二维码登录|扫一扫登录|使用.{0,10}扫码/, 'qr']];
const ASK_CLICK = [[/同意并继续|同意协议|已阅读并同意|同意并登录|接受并继续|同意并注册/, 'terms'], [/注册/, 'register'], [/删除|清空|卸载/, 'delete'],
  [/加好友|添加好友|加为好友|申请加群|加入群聊|加入该群|申请入群/, 'friend'], [/拨打|呼叫|发送短信|发短信/, 'call'], [/修改密码|重置密码|绑定手机|解绑|换绑/, 'account']];
// Apps where a tap reaches someone and can cost money with no word on the button saying so (a recent call dials, a
// thread's send arrow sends): anything done in them is asked about, once a thing.
const ASK_APPS = [[/dialer|incallui|\.telecom|\.contacts$/, 'call'], [/messaging|\.mms$/, 'call']];
const ASK_URL = /^(?:tel|sms|smsto|mms|mmsto):/i;
const PHONE_NUMBER = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const SECRET = /\b(?:sk|ak|pk|ghp|gho|xox[bp]|AKIA)[-_]?[A-Za-z0-9_-]{16,}|\b[A-Za-z0-9+/_-]{36,}\b/;
const STALE_MS = 60_000;

const short = (name) => String(name ?? '').replace(/^mcp__.+?__/, '');
const argsOf = (input) => { if (typeof input !== 'string') return input ?? {}; try { return JSON.parse(input); } catch { return {}; } };
/**
 * The words under a finger at (x, y): of the smallest thing with words that the point is inside, when the screen's
 * reader said how big things are; else of the nearest thing with words, within reach of a finger.
 */
export function wordsAt(items, x, y, reach = 120) {
  let inside = null, area = Infinity, best = null, bd = Infinity;
  for (const it of items ?? []) {
    if (!it?.words) continue;
    const cx = it.x ?? 0, cy = it.y ?? 0;
    if (it.w > 0 && it.h > 0 && Math.abs(x - cx) <= it.w / 2 && Math.abs(y - cy) <= it.h / 2 && it.w * it.h < area) { inside = it; area = it.w * it.h; }
    const d = Math.hypot(cx - x, cy - y);
    if (d < bd) { bd = d; best = it; }
  }
  return inside ? String(inside.words) : best && bd <= reach ? String(best.words) : '';
}
const match = (rules, text) => { for (const [re, kind] of rules) if (re.test(text)) return kind; return ''; };

const POINT = /^mobile_(click_on_screen_at_coordinates|double_tap_on_screen|long_press_on_screen_at_coordinates)$/;
const LEAVES = /^(BACK|HOME)$/i; // the buttons that only take her out of where she is
const PAY_URL = /^(?:alipays?|alipayqr|weixin|wxp|upwrp|uppay|unionpay|mqqwallet|bitcoin|ethereum):/i;
const SEVERITY = { forbid: 0, him: 1, refuse: 2, ask: 3 };

/** One action on her phone (a tool that is not a batch). `seen`: { items, fg } as they are now; null where not known. */
function judge(t, args, { items, fg, onScreen, moved }) {
  if (PHONE_LOOK_TOOLS.includes(t)) return null;
  const pkg = String(args.packageName ?? args.package ?? args.appId ?? '');
  const app = String(fg ?? '').split('/')[0];
  const leaving = (t === 'mobile_press_button' && LEAVES.test(String(args.button ?? ''))) || t === 'mobile_terminate_app';
  if (t === 'mobile_launch_app' && FORBIDDEN_APPS.test(pkg)) return { tier: 'forbid', kind: 'finance', what: `打开 ${pkg}` };
  if (t === 'mobile_open_url' && (PAY_URL.test(String(args.url ?? '')) || FORBIDDEN_SITES.test(hostOf(args.url)))) return { tier: 'forbid', kind: 'finance', what: '打开一个付款或理财的链接' };
  if (FORBIDDEN_APPS.test(app) && !leaving && t !== 'mobile_launch_app') return { tier: 'forbid', kind: 'finance', what: `在 ${app} 里操作` };
  // The number a tel: / sms: link goes to is whom it reaches: named in the question, and what a yes of his is matched to.
  if (t === 'mobile_open_url' && ASK_URL.test(String(args.url ?? ''))) { const to = (/^[a-z]+:\/{0,2}([+\d][\d\s-]*)/i.exec(String(args.url))?.[1] ?? '').replace(/[\s-]/g, ''); return { tier: 'ask', kind: 'call', what: to ? `打电话、发短信（${to}）` : '打电话、发短信', ...(to ? { subject: to } : {}) }; }
  const askApp = (t === 'mobile_launch_app' && match(ASK_APPS, pkg)) || (!leaving && t !== 'mobile_swipe_on_screen' && t !== 'mobile_launch_app' && match(ASK_APPS, app));
  if (askApp) return { tier: 'ask', kind: askApp, what: '用电话或短信' };
  if (t === 'mobile_install_app') return { tier: 'ask', kind: 'install', what: '在手机上装 App' };
  if (t === 'mobile_uninstall_app') return { tier: 'ask', kind: 'delete', what: '在手机上卸载 App' };
  if (POINT.test(t)) {
    // What is under a press that follows another action of the same batch is not on the screen yet: it cannot be judged.
    if (moved) return { tier: 'refuse', kind: 'unseen', what: '这一批里前面的动作会让屏幕变，后面要点的地方现在还看不到：这一批只做到这一下之前，看了新的屏幕再点' };
    // The screen could not be read, or which app is in front is not known: what the press would do cannot be told.
    if (fg === null || !items?.length) return { tier: 'ask', kind: 'blind', what: '屏幕上的字读不出来，要点的地方是什么看不清' };
    const word = wordsAt(items, Number(args.x), Number(args.y));
    if (word) {
      if (FORBIDDEN_WORDS.test(word)) return { tier: 'forbid', kind: 'money', what: `点「${word}」` };
      const him = match(HIM_CLICK, word);
      if (him) return { tier: 'him', kind: him, what: `点「${word}」` };
      if (match(HIM_SCREEN, onScreen) === 'qr' && !/密码|账号|返回|取消|关闭|其他方式|换个方式/.test(word)) return { tier: 'him', kind: 'qr', what: '扫码登录', screen: true };
      if (/permissioncontroller/.test(app) && /允许/.test(word)) return { tier: 'ask', kind: 'permission', what: `给 App 开权限：「${word}」` };
      if (/packageinstaller/.test(app) && /安装/.test(word)) return { tier: 'ask', kind: 'install', what: '装一个 App' };
      const ask = match(ASK_CLICK, word);
      if (ask) return { tier: 'ask', kind: ask, what: `点「${word}」` };
    }
    return null;
  }
  if (t === 'mobile_swipe_on_screen') return match(HIM_SCREEN, onScreen) === 'captcha' ? { tier: 'him', kind: 'captcha', what: '过人机验证', screen: true } : null;
  if (t === PHONE_TYPE_TOOL || t === 'mobile_type_keys') {
    const typed = String(args.text ?? '');
    if (PHONE_NUMBER.test(typed)) return { tier: 'ask', kind: 'phone-number', what: `打手机号 ${PHONE_NUMBER.exec(typed)[0]}`, subject: PHONE_NUMBER.exec(typed)[0] };
    if (SECRET.test(typed)) return { tier: 'ask', kind: 'secret', what: '打一串像密钥的字' };
    return null;
  }
  if (/^mobile_(press_button|launch_app|open_url|terminate_app|set_orientation)$/.test(t)) return null;
  // A tool of her phone this file has no rule for (a new one of the phone server's, its cloud devices, recording …).
  return { tier: 'ask', kind: 'phone-tool', what: `在手机上用 ${t}`, subject: t };
}

/**
 * What an action of her hands on her phone is, by the four tiers. → null (hers to do) or { tier, kind, what, subject? };
 * tier 'refuse': not done as it was asked (a batch that has to be cut shorter), with `what` saying how.
 * @param {object} a
 * @param {string} a.tool   the tool's name
 * @param {any} a.input     its arguments
 * @param {{ items: object[], at: number } | null} [a.screen]  what the screen showed last (phone.lastScreen); null or read too long ago: not known
 * @param {string | null} [a.fg]   the app in front (package/activity); null: could not be told
 */
export function classify({ tool, input, screen, fg = '', now = Date.now() }) {
  const t = short(tool), args = argsOf(input);
  const items = screen && now - (screen.at ?? 0) <= STALE_MS ? screen.items ?? [] : null;
  const seen = { items, fg, onScreen: (items ?? []).map((it) => it.words ?? '').join(' '), moved: false };
  if (t !== 'mobile_batch_commands') return judge(t, args, seen);
  // A batch is its steps, in order: each is judged as if called alone. The worst of them is the batch's.
  let worst = null;
  for (const step of [].concat(args.steps ?? args.commands ?? [])) {
    const name = short(step?.name ?? step?.tool), a = argsOf(step?.arguments ?? step?.args ?? {});
    // A step is a tool they are offered when called alone: what is kept from them is not theirs inside a batch either.
    const r = PHONE_PASTE_TOOLS.includes(name) ? { tier: 'refuse', kind: 'paste', what: `${name} 不能用：打字用 phone_type，一次打一处` }
      : !PHONE_HANDS_TOOLS.includes(name) && !PHONE_LOOK_TOOLS.includes(name) ? { tier: 'refuse', kind: 'not-theirs', what: `${name || '这一步'} 不在你能用的工具里` }
      : judge(name, a, seen);
    if (r && (!worst || SEVERITY[r.tier] < SEVERITY[worst.tier])) worst = r;
    if (!PHONE_LOOK_TOOLS.includes(name)) seen.moved = true;
  }
  return worst;
}

/** What a request the host (or a plugin) gates is, by kind: { kind, subject?, what }. */
export function approvalKind(toolName, reason = '') {
  const r = String(reason ?? ''), tool = short(toolName);
  const target = /\b(user|group):\d+/.exec(r)?.[0] ?? '';
  if (/^dsh-dot\/qq: sending .*file/.test(r)) return { kind: 'send-file', subject: target, what: `把设备上的文件发给 ${target}` };
  if (/^dsh-dot\/qq: message to/.test(r)) return { kind: 'message', subject: target, what: `给 ${target} 发消息（对方最近没找过她）` };
  if (String(toolName).startsWith('mcp__dot-qq__')) return { kind: 'qq-action', subject: tool, what: `QQ 上的操作：${tool}` };
  if (tool === 'mobile_install_app') return { kind: 'install', what: '在手机上装 App' };
  if (tool === 'mobile_uninstall_app') return { kind: 'delete', what: '在手机上卸载 App' };
  if (/looks sensitive/.test(r)) return { kind: 'secret', what: '在手机上打一段敏感的字' };
  if (tool === 'bash' || String(toolName).startsWith('mcp__dot-vm__')) return { kind: 'computer', subject: r.slice(0, 80), what: `电脑上：${r.replace(/\s+/g, ' ').slice(0, 80)}` };
  return { kind: 'other', subject: tool, what: `${tool}${r ? `：${r.slice(0, 60)}` : ''}` };
}

// Her computer (the VM): the same four tiers. computer/gate.js says what a call risks (its own rules: shell, files,
// protected places, shared folders); the page the browser is on (address and title, read at call time) and the
// words in the call say the rest. A tap's own label is not known here (the VM's tools click by index): a page that
// is a till, a captcha or a QR sign-in is his as a whole.
const FORBIDDEN_SITES = /alipay|unionpay|95516|\bbank|icbc|ccb\.com|abchina|boc\.cn|cmbchina|bankcomm|psbc|spdb|cib\.com|citicbank|eastmoney|10jqka|xueqiu|futunn|futu5|tigerbrokers|binance|okx\.|okex|coinbase|huobi|htx\.|gate\.io|bybit|bitget|kraken|metamask|paypal|wise\.com|网银|银行|证券|交易所|钱包/i;
const HIM_PAGE = [[/checkout|cashier|\bpay\.|\/pay\b|payment|收银台|确认支付|确认付款|立即支付|订单支付/i, 'pay'], [/captcha|recaptcha|hcaptcha|geetest|人机验证|安全验证|滑块验证/i, 'captcha'], [/qrlogin|qrcode.?login|扫码登录|二维码登录/i, 'qr'], [/实名认证|人脸识别|身份验证|上传身份证/i, 'identity']];
const ASK_PAGE = [[/注册|sign[\s_-]?up|register|create.?account/i, 'register'], [/同意.{0,6}(条款|协议)|terms of service|user agreement/i, 'terms']];
const ASK_WORDS = [[/删除|清空|卸载|注销|delete|remove|unsubscribe/i, 'delete'], [/修改密码|重置密码|绑定手机|解绑|换绑|change.?password|reset.?password/i, 'account'], [/注册|sign[\s_-]?up|register/i, 'register'], [/同意并|accept|agree/i, 'terms']];
const SHELL_KINDS = [[/\bsudo\s+(\S+)/, 'admin'], [/\bgit\s+push\b\s*(\S*)/, 'push'], [/\b(?:ssh|scp)\b[^\n;|&]*?(?:\s|@)([\w.-]+\.[\w.-]+|\d+\.\d+\.\d+\.\d+)(?=[:\s]|$)/, 'remote'], [/\b(?:ssh|scp)\b/, 'remote'],
  [/\b(?:curl|wget)\b[^|]*?https?:\/\/([^/\s'"]+)[^|]*\|/, 'fetch-run'], [/\b(?:curl|wget|base64)\b/, 'fetch-run'], [/(?:\bdd\s+if=|\bmkfs|\bshred\b|\bwipe\b|>\s*)(\/dev\/\w+)?/, 'disk']];
const hostOf = (url) => { try { return new URL(String(url)).hostname; } catch { return ''; } };

/**
 * What a call of her hands on her computer is, by the four tiers. → null (hers) or { tier, kind, what, subject? }
 * @param {object} a
 * @param {string} a.tool
 * @param {any} a.input
 * @param {{ cat: string, subject?: string, command?: string } | null} a.risk  computer/gate.js risk(): what its rules found
 * @param {boolean} a.acts  a browser or desktop action (not only looking)
 * @param {{ url?: string, title?: string }} [a.page]  the page in front, read at call time
 */
export function classifyComputer({ tool, input, risk = null, acts = false, page = null }) {
  const t = short(tool), args = argsOf(input), text = typeof input === 'string' ? input : JSON.stringify(input ?? {});
  const to = String(args.url ?? '');
  const url = to || String(page?.url ?? ''), title = String(page?.title ?? ''), host = hostOf(url);
  const where = host || title.slice(0, 20) || '网页';
  if (acts) {
    if (FORBIDDEN_SITES.test(host) || FORBIDDEN_SITES.test(title)) return { tier: 'forbid', kind: 'finance', what: `在 ${where} 上操作` };
    if (FORBIDDEN_WORDS.test(text)) return { tier: 'forbid', kind: 'money', what: '转账、提现一类的操作' };
    // Going to a page is looking; doing something on a page of his is his.
    const him = /navigate|new_tab|go_back|go_forward|switch_tab|close_tab/.test(t) ? '' : match(HIM_PAGE, `${url} ${title}`);
    if (him) return { tier: 'him', kind: him, what: HIM_KINDS[him], screen: true };
    const typed = String(args.value ?? args.text ?? '');
    if (typed && PHONE_NUMBER.test(typed)) return { tier: 'ask', kind: 'phone-number', what: `打手机号 ${PHONE_NUMBER.exec(typed)[0]}`, subject: PHONE_NUMBER.exec(typed)[0] };
    if (typed && SECRET.test(typed)) return { tier: 'ask', kind: 'secret', what: '打一串像密钥的字' };
    const page_ = /navigate|new_tab/.test(t) ? '' : match(ASK_PAGE, title);
    if (page_) return { tier: 'ask', kind: page_, what: `${KINDS[page_]}（${where}）`, subject: host };
  }
  if (!risk) return null;
  switch (risk.cat) {
    case 'protected': return { tier: 'ask', kind: 'secret-file', what: `${KINDS['secret-file']}：${risk.subject}`, subject: risk.subject };
    case 'shell': {
      const cmd = String(risk.command ?? '');
      for (const [re, kind] of SHELL_KINDS) { const m = re.exec(cmd); if (m) { const subject = (m[1] ?? '').replace(/^-.*/, ''); return { tier: 'ask', kind, what: `${KINDS[kind]}${subject ? `：${subject}` : ''}`, subject }; } }
      return { tier: 'ask', kind: 'computer', what: `电脑上：${cmd.replace(/\s+/g, ' ').slice(0, 60)}`, subject: cmd.slice(0, 60) };
    }
    case 'shared': case 'home': return { tier: 'ask', kind: 'shared-delete', what: risk.cat === 'home' ? '删改她整个电脑的家目录' : `${KINDS['shared-delete']}：${risk.subject}`, subject: risk.subject };
    case 'file-delete': return { tier: 'ask', kind: 'delete', what: `删除或挪走 ${risk.subject || '电脑上的文件'}`, subject: risk.subject };
    case 'script': return { tier: 'ask', kind: 'page-script', what: `${KINDS['page-script']}（${where}）`, subject: host };
    case 'sensitive': {
      if (match(HIM_PAGE, text) === 'pay' || /\b(pay|checkout|purchase|order)\b|支付|付款|下单|购买|充值/i.test(text)) return { tier: 'him', kind: 'pay', what: HIM_KINDS.pay, screen: true };
      if (/wallet|bank|credit|transfer|钱包|银行|转账|红包/i.test(text)) return { tier: 'forbid', kind: 'money', what: '和钱有关的操作' };
      const kind = match(ASK_WORDS, text);
      return kind ? { tier: 'ask', kind, what: `${KINDS[kind]}（${where}）`, subject: host } : null; // signing in with her own account is hers
    }
    case 'browser': return { tier: 'ask', kind: 'browser', what: `${KINDS.browser}：${t}（${where}）`, subject: host };
    default: return { tier: 'ask', kind: 'computer', what: `电脑上：${risk.reason ?? t}`, subject: risk.cat };
  }
}


// ── the machine dsh itself runs on: his ──────────────────────────────────────────────────────────────────────────
// Her phone and her computer are hers; this machine is his, and nothing fences it off (with her computer on, the
// host's own sandbox is off). So the list kept here is of what only looks (11-23, his choice): a command that is not
// on it — or that cannot be read as a plain row of commands — is asked about, never let through for being unknown.
// One yes of his covers the thing it was given for (kind 'host' names no subject); the kinds that have their own name
// (sudo, git push, ssh, download-and-run, whole disks, files that hold keys) are asked about by that name.
const HOST_LOOK = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'fd', 'pwd', 'echo', 'printf', 'date', 'whoami', 'id', 'uname',
  'hostname', 'df', 'du', 'ps', 'pgrep', 'which', 'type', 'file', 'stat', 'uptime', 'sw_vers', 'sort', 'uniq', 'cut', 'tr', 'jq', 'tree', 'basename', 'dirname',
  'realpath', 'readlink', 'diff', 'cmp', 'md5', 'md5sum', 'shasum', 'sha256sum', 'nproc', 'free', 'vm_stat', 'column', 'nl', 'cd', 'true', 'test', '[', 'mdfind', 'mdls']);
const HOST_GIT_LOOK = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'blame', 'describe', 'shortlog']);
// git subcommands that look only in some of their forms: the form is told by its words (no name given to make, move or delete).
const HOST_GIT_FORMS = {
  branch: (w) => w.every((x) => /^(?:-a|-r|-v|-vv|-l|--all|--remotes|--list|--show-current|--merged|--no-merged|--contains|--sort=.*)$/.test(x)),
  remote: (w) => !w.length || /^(?:-v|show|get-url)$/.test(w[0]),
  stash: (w) => /^(?:list|show)$/.test(w[0] ?? ''),
  tag: (w) => w.every((x) => /^(?:-l|--list|-n\d*|--sort=.*)$/.test(x)),
  config: (w) => /^(?:--get|--get-all|--list|-l)$/.test(w[0] ?? ''),
};
const HOST_FIND_ACTS = /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;
const HOST_SECRET = /(?:^|[\s/'"=~])(\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.env(?:\.\w+)?|id_rsa\w*|id_ed25519\w*|\.dsh(?!\/dsh-dot-hands))(?=$|[\s/'"])|(credentials?|secrets?|keychains?|passwords?|tokens?|cookies)\b/i;
const HOST_FREE_TOOLS = new Set(['read', 'read_image', 'job_output', 'job_list', 'job_kill', 'web_search', 'web_fetch', 'ask_her', 'done', 'wait_for']);

/** A command line as a row of commands, each a row of words — or null when it is more than that (a redirect, a substitution, something left running). */
export function plainCommands(command) {
  const s = String(command ?? '').replace(/\d*>\s*\/dev\/null|\d*>&\d+/g, ' ');
  const rows = [[]]; let word = null, quote = '';
  const end = () => { if (word !== null) { rows[rows.length - 1].push(word); word = null; } };
  for (let i = 0; i < s.length; i++) {
    const c = s[i], two = s.slice(i, i + 2);
    if (quote) {
      if (c === quote) quote = '';
      else if (quote === '"' && (c === '`' || two === '$(')) return null;
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; word ??= ''; }
    else if (c === '\\') { if (s[i + 1] === '\n' || i + 1 >= s.length) return null; word = (word ?? '') + s[++i]; }
    else if (c === '`' || c === '<' || c === '>' || two === '$(' || two === '${') return null;
    else if (two === '&&' || two === '||') { end(); rows.push([]); i++; }
    else if (c === '&') return null;
    else if (c === ';' || c === '|' || c === '\n') { end(); rows.push([]); }
    else if (/\s/.test(c)) end();
    else word = (word ?? '') + c;
  }
  if (quote) return null;
  end();
  return rows.filter((r) => r.length);
}

/** Does this command line only look (every command in it is on the list of what only looks)? */
export function hostLooks(command) {
  const rows = plainCommands(command);
  if (!rows) return false;
  return rows.every(([head, ...rest]) => {
    if (/^\w+=/.test(head)) return false;
    const name = head.replace(/^.*\//, '');
    if (rest.length === 1 && /^(?:--version|-v|-V|version)$/.test(rest[0])) return true; // asking a program what it is
    if (name === 'git') {
      const words = [...rest];
      while (words[0] === '-C' || words[0] === '--no-pager') words.splice(0, words[0] === '-C' ? 2 : 1);
      if (HOST_GIT_FORMS[words[0]]) return HOST_GIT_FORMS[words[0]](words.slice(1));
      return HOST_GIT_LOOK.has(words[0] ?? '') && !words.some((x) => /^--output\b/.test(x));
    }
    if (name === 'find' || name === 'fd') return !rest.some((x) => HOST_FIND_ACTS.test(x) || /^(?:-x|--exec|--exec-batch|-X)$/.test(x));
    return HOST_LOOK.has(name);
  });
}

/**
 * What a call of her hands on the machine dsh runs on is. → null (looking: theirs) or { tier, kind, what, subject? }
 * @param {object} a
 * @param {string} a.tool
 * @param {any} a.input
 */
export function classifyHost({ tool, input }) {
  const t = short(tool), args = argsOf(input);
  const where = '他这台电脑本机上';
  // A command is sent to this machine or into her computer by the folder it starts in (computer/subprocess.js), and a
  // thing here starts in the hands' own host folder: one given another folder to start in would run in her computer
  // (11-23: three git commands with a workdir did, and his repository was shared into it). Where to go is in the command.
  if (args.workdir ?? args.cwd ?? args.exec_dir) return { tier: 'refuse', kind: 'elsewhere', what: '本机上的命令不填 workdir：要去的目录写进命令里（cd 那个目录 && …）' };
  if (t === 'bash') {
    const cmd = String(args.command ?? ''), shown = cmd.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (FORBIDDEN_WORDS.test(cmd)) return { tier: 'forbid', kind: 'money', what: '转账、提现一类的操作' };
    const secret = HOST_SECRET.exec(cmd);
    if (secret) { const subject = secret[1] ?? secret[2]; return { tier: 'ask', kind: 'secret-file', what: `${KINDS['secret-file']}（${where}）：${subject}`, subject }; }
    if (hostLooks(cmd)) return null;
    for (const [re, kind] of SHELL_KINDS) {
      const m = re.exec(cmd);
      if (!m || (kind === 'disk' && !m[1] && m[0].startsWith('>'))) continue; // writing to a file is not a whole disk
      const subject = (m[1] ?? '').replace(/^-.*/, '');
      return { tier: 'ask', kind, what: `${KINDS[kind]}（${where}）${subject ? `：${subject}` : ''}`, subject };
    }
    return { tier: 'ask', kind: 'host', what: `在${where}：${shown}`, subject: '' };
  }
  if (t === 'read' || t === 'read_image') {
    const secret = HOST_SECRET.exec(String(args.path ?? args.file_path ?? args.file ?? ''));
    if (secret) { const subject = secret[1] ?? secret[2]; return { tier: 'ask', kind: 'secret-file', what: `${KINDS['secret-file']}（${where}）：${subject}`, subject }; }
    return null;
  }
  if (HOST_FREE_TOOLS.has(t)) return null;
  return { tier: 'ask', kind: 'host', what: `在${where}：${t}`, subject: '' };
}

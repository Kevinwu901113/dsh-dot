// dsh-dot/gates: what of hers needs him. Four tiers, decided by code from what is on the screen and what is about to
// be done — never from her own report (an agent asked about a risk spots it far more often than it does while acting).
//   forbid  not done, and not asked about: moving money, finance apps
//   him     he does it himself: paying at the last step, a face or ID check, a captcha, a QR login (she sends him the
//           screen); a code sent to his phone comes from him (her hands type only words she was given)
//   ask     she asks him in her own words, and goes on once he says yes (his_ok)
//   (her)   everything else, a password from her account book included
// The lists are here and nowhere else: a word added to a list is the whole change.
export const KINDS = {
  message: '给不熟的人或群发消息', 'send-file': '把设备上的文件发给别人', install: '在手机上装 App', delete: '删除、清空或卸载',
  register: '注册账号', terms: '同意条款或协议', friend: '加好友、进群', call: '打电话、发短信', account: '改密码、绑定或解绑',
  permission: '给 App 开权限', 'phone-number': '打一个手机号', secret: '打密钥、口令一类的字', computer: '电脑上要他点头的操作',
  spend: '一件事花得比上限多', 'qq-action': 'QQ 上的其他操作', other: '要他点头的操作',
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
const LOOKS = /^(mobile_list_elements_on_screen|mobile_take_screenshot|mobile_get_screen_size|mobile_get_orientation|mobile_list_apps|mobile_list_available_devices|phone_zoom)$/;
const STALE_MS = 60_000;

const short = (name) => String(name ?? '').replace(/^mcp__.+?__/, '');
const argsOf = (input) => { if (typeof input !== 'string') return input ?? {}; try { return JSON.parse(input); } catch { return {}; } };
/** The words on the screen nearest to (x, y), within reach of a finger. */
export function wordsAt(items, x, y, reach = 120) {
  let best = null, bd = Infinity;
  for (const it of items ?? []) { if (!it?.words) continue; const d = Math.hypot((it.x ?? 0) - x, (it.y ?? 0) - y); if (d < bd) { bd = d; best = it; } }
  return best && bd <= reach ? String(best.words) : '';
}
const match = (rules, text) => { for (const [re, kind] of rules) if (re.test(text)) return kind; return ''; };

/**
 * What an action of her hands on her phone is, by the four tiers. → null (hers to do) or { tier, kind, what, subject? }
 * @param {object} a
 * @param {string} a.tool   the tool's name
 * @param {any} a.input     its arguments
 * @param {{ items: object[], at: number }} [a.screen]  what the screen showed last (phone.lastScreen)
 * @param {string} [a.fg]   the app in front (package/activity)
 */
export function classify({ tool, input, screen, fg = '', now = Date.now() }) {
  const t = short(tool), args = argsOf(input);
  if (LOOKS.test(t)) return null;
  const pkg = String(args.packageName ?? args.package ?? args.appId ?? '');
  if (t === 'mobile_launch_app' && FORBIDDEN_APPS.test(pkg)) return { tier: 'forbid', kind: 'finance', what: `打开 ${pkg}` };
  if (FORBIDDEN_APPS.test(fg) && !/press_button/.test(t)) return { tier: 'forbid', kind: 'finance', what: `在 ${fg.split('/')[0]} 里操作` };
  if (t === 'mobile_open_url' && ASK_URL.test(String(args.url ?? ''))) return { tier: 'ask', kind: 'call', what: '打电话、发短信' };
  const askApp = (t === 'mobile_launch_app' && match(ASK_APPS, pkg)) || (!/press_button|swipe/.test(t) && match(ASK_APPS, String(fg).split('/')[0]));
  if (askApp) return { tier: 'ask', kind: askApp, what: '用电话或短信' };
  const items = screen && now - (screen.at ?? 0) <= STALE_MS ? screen.items ?? [] : [];
  const onScreen = items.map((it) => it.words ?? '').join(' ');
  const clicks = t === 'mobile_click_on_screen_at_coordinates' ? [args] : t === 'mobile_batch_commands' ? [].concat(args.steps ?? args.commands ?? []).filter((s) => /click/.test(String(s?.name ?? s?.tool ?? ''))).map((s) => s.arguments ?? s.args ?? s) : [];
  for (const c of clicks) {
    const word = wordsAt(items, Number(c.x), Number(c.y));
    if (!word) continue;
    if (FORBIDDEN_WORDS.test(word)) return { tier: 'forbid', kind: 'money', what: `点「${word}」` };
    const him = match(HIM_CLICK, word);
    if (him) return { tier: 'him', kind: him, what: `点「${word}」` };
    if (match(HIM_SCREEN, onScreen) === 'qr' && !/密码|账号|返回|取消|关闭|其他方式|换个方式/.test(word)) return { tier: 'him', kind: 'qr', what: '扫码登录', screen: true };
    if (/permissioncontroller/.test(fg) && /允许/.test(word)) return { tier: 'ask', kind: 'permission', what: `给 App 开权限：「${word}」` };
    if (/packageinstaller/.test(fg) && /安装/.test(word)) return { tier: 'ask', kind: 'install', what: '装一个 App' };
    const ask = match(ASK_CLICK, word);
    if (ask) return { tier: 'ask', kind: ask, what: `点「${word}」` };
  }
  if (/swipe|drag/.test(t) && match(HIM_SCREEN, onScreen) === 'captcha') return { tier: 'him', kind: 'captcha', what: '过人机验证', screen: true };
  const typed = /type/.test(t) || t === 'phone_type' ? String(args.text ?? '') : t === 'mobile_batch_commands' ? [].concat(args.steps ?? args.commands ?? []).filter((s) => /type/.test(String(s?.name ?? s?.tool ?? ''))).map((s) => String((s.arguments ?? s.args ?? s)?.text ?? '')).join('\n') : '';
  if (typed && PHONE_NUMBER.test(typed)) return { tier: 'ask', kind: 'phone-number', what: `打手机号 ${PHONE_NUMBER.exec(typed)[0]}`, subject: PHONE_NUMBER.exec(typed)[0] };
  if (typed && SECRET.test(typed)) return { tier: 'ask', kind: 'secret', what: '打一串像密钥的字' };
  return null;
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

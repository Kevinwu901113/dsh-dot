// dsh-dot/compat: living next to qq-bridge (github.com/Derpyu520/qq-bridge) in the same dsh.
//
// qq-bridge is a separate process that drives dsh over its web API. From dsh's side it looks like:
//   · sessions whose id is `qqb-g-<group>-<hex>` (a group) or `qqb-p-<uin>-<hex>` (a private chat),
//     all in one cwd — its `sessionCwd`, else `<repo>/state/agents`; its slang learner lives in
//     `<repo>/state/slang-agent` with a dsh-generated id;
//   · a mode (its `state/mode.json`): chat / reserved / reserved2 run its own `qq-chat*` presets
//     (a tool whitelist, no local tools: bash, read … are restricted away); `closed-agent` is the
//     owner's private chat only, on the dsh default preset with the full tool surface;
//   · three global MCP servers it patches into the profile: `snowluma`, `snowluma-host`,
//     `web-search-safe` (so `mcp__snowluma__*` is in every session's tool list — hers included);
//   · two bundles linked at `~/.dsh/plugins/qq-agent-presets` and `~/.dsh/plugins/qq-mode-console`
//     — the link target is the repo, which is how this module finds its config.json and state/.
//
// What this component does, all of it on our side (qq-bridge is never modified):
//   1. `owner(session)`: whose session is this — hers ('dot'), a qq-bridge chat on a whitelist preset
//      ('qqb-sandbox'), the qq-bridge owner's full private chat ('qqb-owner'), or anybody else ('other').
//      Every other component asks here instead of guessing.
//   2. Tool visibility, one `agent/created` hook: dot's own tools (memory, recall, account, qq_send …)
//      only in her sessions; her phone and computer tools only in hers and in qq-bridge's owner chat
//      (which is what a qq-bridge user wants from this plugin); nothing of ours in a sandboxed
//      qq-bridge session (its whitelist would refuse them anyway, but they cost tokens on every message
//      and break its "no local capability in the schema" rule). qq-bridge's own MCP tools are hidden
//      from her sessions in return. Backed by a guard so the restriction holds even for a tool
//      registered after the agent was created.
//   3. The computer: a qq-bridge session's cwd (its state/ dir) is never shared into her VM (sharing
//      restarts the VM: her QQ inside it would drop); its commands run in the VM's own home, or on
//      the host when `computer: 'host'` is chosen.
//   4. QQ: the bridge's bot accounts are read from its SnowLuma home (config/onebot_<uin>.json) so
//      she never answers them (two bots in one group would otherwise talk forever); `/dot doctor`
//      checks the two are not the same account and not in the same groups.
//
// Settings (~/.dsh/dsh-dot.json, section "compat"): see `defaults`.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { sectionOf, dshHome } from '../settings.js';
import { DOT_TOOLS, DOT_TOOL_PREFIXES, DEVICE_TOOL_PREFIXES, PHONE_ZOOM_TOOL } from '../tool-prefixes.js';

export const name = 'dsh-dot/compat';
export const inject = [];

export const defaults = {
  // Looking for qq-bridge: 'auto' (on when its bundles are linked into ~/.dsh), true, false.
  qqBridge: 'auto',
  // Where qq-bridge is checked out, when auto-detection cannot see it (the folder with config.json).
  qqBridgeRoot: '',
  // qq-bridge's owner private chat (its closed-agent mode): give it her phone and computer tools?
  ownerDevices: true,
  // Where a qq-bridge owner-chat command runs: 'vm' (her computer, in the VM's home; nothing of
  // qq-bridge's is shared in) or 'host' (dsh's own local runner, as without this plugin).
  ownerComputer: 'vm',
  // Hide qq-bridge's MCP tools (mcp__snowluma__*, mcp__snowluma-host__*, mcp__web-search-safe__*) from her sessions.
  hideBridgeTools: true,
  // Reread qq-bridge's config.json / state/mode.json at most this often (ms).
  refreshMs: 5000,
};

/** qq-bridge's session ids: `qqb-g-<group>-<hex>` / `qqb-p-<uin>-<hex>` (its encodeSelfKey). */
export const BRIDGE_ID_RE = /^qqb-([gp])-(\d{1,20})(?:-[a-f0-9]{32})?$/;
/** The MCP servers qq-bridge patches into the dsh profile (its scripts/setup-dsh.mjs). */
export const BRIDGE_TOOL_PREFIXES = ['mcp__snowluma__', 'mcp__snowluma-host__', 'mcp__web-search-safe__'];
/** The bundles it links into ~/.dsh/plugins (name → link); the link target is inside its repo. */
const BRIDGE_BUNDLES = ['qq-agent-presets', 'qq-mode-console'];

const inside = (parent, p) => { if (!parent || !p) return false; const r = relative(parent, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const mtime = (file) => { try { return statSync(file).mtimeMs; } catch { return 0; } };

/**
 * Where qq-bridge is: the explicit root, else the repo behind `~/.dsh/plugins/qq-agent-presets`
 * or `qq-mode-console` (links into its checkout). A checkout without `config.json` is not a running
 * qq-bridge (its own loadConfig() refuses to start without one), so it does not count: ''.
 */
export function findRoot({ root = '', home = dshHome() } = {}) {
  const configured = (dir) => existsSync(join(dir, 'config.json'));
  if (root) return configured(root) ? resolve(root) : '';
  for (const bundle of BRIDGE_BUNDLES) {
    let target;
    try { target = realpathSync(join(home, 'plugins', bundle)); } catch { continue; }
    // <repo>/plugins/<bundle> or a build dir inside the repo → walk up to the repo root.
    for (let dir = target; dir !== dirname(dir); dir = dirname(dir)) {
      if (existsSync(join(dir, 'src', 'bridge.js')) && existsSync(join(dir, 'package.json'))) return configured(dir) ? dir : '';
    }
  }
  return '';
}

/** qq-bridge's bot accounts: SnowLuma's per-account files `config/onebot_<uin>.json` (its snowluma-conn.js). */
export function botUins(config, env = process.env) {
  const homes = [];
  const sl = config?.snowluma ?? {};
  if (sl.homeDir) homes.push(String(sl.homeDir));
  if (sl.launcherPath) homes.push(dirname(String(sl.launcherPath)));
  if (env.SNOWLUMA_HOME) homes.push(env.SNOWLUMA_HOME);
  const uins = new Set();
  for (const h of homes) {
    let entries = [];
    try { entries = readdirSync(join(h.replace(/^~(?=$|[\\/])/, homedir()), 'config')); } catch { continue; }
    for (const e of entries) { const m = /^onebot_(\d+)\.json$/i.exec(e); if (m) uins.add(m[1]); }
  }
  return [...uins].sort();
}

/**
 * Everything of qq-bridge's this plugin looks at, read from its files (never its network):
 * { root, configPath, config, stateDir, sessionCwd, slangCwd, mode, ownerQQ, groups, privates, botUins, consolePort, sandboxPresets }.
 */
export function readBridge(root, env = process.env) {
  const configPath = join(root, 'config.json');
  const config = readJson(configPath) ?? {};
  const stateDir = join(root, 'state');
  const modeFile = readJson(join(stateDir, 'mode.json'));
  const mode = String(modeFile?.mode ?? config.mode ?? 'reserved2').trim() || 'reserved2';
  const allow = config.allow ?? {};
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
  return {
    root, configPath, config, stateDir,
    sessionCwd: config.sessionCwd ? resolve(String(config.sessionCwd)) : join(stateDir, 'agents'),
    slangCwd: join(stateDir, 'slang-agent'),
    mode: mode === 'simulation' ? 'reserved2' : mode,
    ownerQQ: config.ownerQQ == null ? '' : String(config.ownerQQ),
    groups: list(allow.groups ?? allow.group),
    privates: list(allow.private ?? allow.privates),
    botUins: botUins(config, env),
    consolePort: Number(config.consolePort) || 3100,
    // The whitelist presets its chat modes run on (its PRESET_NAMES: qq-chat / qq-chat-v2), as configured.
    sandboxPresets: [...new Set([config.agentPreset, config.socialV2?.agentPreset, 'qq-chat', 'qq-chat-v2'].map((x) => String(x ?? '').trim()).filter(Boolean))],
    stamp: `${mtime(configPath)}:${mtime(join(stateDir, 'mode.json'))}`,
  };
}

/**
 * Whose session is this. `hers(id, cwd)` is dot's own test (ctx.dshDot.hers) when the dot
 * component is on. Returns 'dot' | 'qqb-sandbox' | 'qqb-owner' | 'other'.
 *   qqb-owner:   qq-bridge in closed-agent mode, the id is a private chat (`qqb-p-`) — the owner's
 *                full-tool session (only the owner gets a session in that mode).
 *   qqb-sandbox: any other qq-bridge session: a group, a whitelisted private chat on a qq-chat
 *                preset, or its slang learner (dsh id, cwd under its state/).
 */
export function classify({ id = '', cwd = '', preset } = {}, bridge, hers) {
  const m = BRIDGE_ID_RE.exec(String(id));
  if (!m && hers?.(id, cwd)) return 'dot';
  if (m) {
    if (m[1] !== 'p') return 'qqb-sandbox';
    // The session's preset is the truth when dsh records it: one of the bridge's chat presets (read from
    // its config; `qq-chat*` by name when the bridge is not readable) is the whitelist, anything else
    // is the owner's full chat. The bridge's mode file stands in for an older dsh that records none.
    if (preset !== undefined && preset !== null && preset !== '') {
      const p = String(preset);
      return (bridge?.sandboxPresets ?? ['qq-chat', 'qq-chat-v2']).includes(p) || /^qq-chat/.test(p) ? 'qqb-sandbox' : 'qqb-owner';
    }
    return bridge?.mode === 'closed-agent' ? 'qqb-owner' : 'qqb-sandbox';
  }
  if (!bridge) return 'other';
  // By cwd alone (the subprocess provider sees nothing else): every qq-bridge session lives in one
  // folder. In closed-agent mode only the owner's chat gets a session at all (groups are refused, and
  // a sandbox session has no shell to run anything with), so that folder is the owner's then.
  if (cwd && (inside(bridge.stateDir, cwd) || inside(bridge.sessionCwd, cwd) || inside(bridge.slangCwd, cwd))) return bridge.mode === 'closed-agent' && !inside(bridge.slangCwd, cwd) ? 'qqb-owner' : 'qqb-sandbox';
  return 'other';
}

/** Is this tool one of dot's own (hers to use, nobody else's): memory, account, qq_send, her SnowLuma actions …? */
export const isDotTool = (n) => DOT_TOOLS.includes(n) || DOT_TOOL_PREFIXES.some((p) => n.startsWith(p));
/** Is this tool her phone's or her computer's (mcp__dot-phone__*, mcp__dot-vm__*, phone_zoom)? */
export const isDeviceTool = (n) => n === PHONE_ZOOM_TOOL || DEVICE_TOOL_PREFIXES.some((p) => n.startsWith(p));
/** Is this tool qq-bridge's? */
export const isBridgeTool = (n) => BRIDGE_TOOL_PREFIXES.some((p) => n.startsWith(p));

/**
 * Which of `names` (the global tool list) a session of this owner must not see.
 * @param owner - from classify()
 * @param opts.ownerDevices - whether qq-bridge's owner chat gets the device tools
 * @param opts.hideBridgeTools - whether her sessions lose qq-bridge's MCP tools
 */
export function hiddenFor(owner, names, { ownerDevices = true, hideBridgeTools = true } = {}) {
  const out = [];
  for (const n of names) {
    if (owner === 'dot') { if (hideBridgeTools && isBridgeTool(n)) out.push(n); continue; }
    if (isDotTool(n)) { out.push(n); continue; }
    if (isDeviceTool(n) && (owner === 'qqb-sandbox' || (owner === 'qqb-owner' && !ownerDevices))) out.push(n);
  }
  return out;
}

/**
 * The compat service, `ctx.dshDotCompat`:
 *   bridge()            → the qq-bridge facts (readBridge) or null when it is not here / turned off
 *   owner(id, cwd, preset) → 'dot' | 'qqb-sandbox' | 'qqb-owner' | 'other' (preset: session.header.agentPreset)
 *   ownerOf(c)          → the same, for a system-prompt context `c` (c.agent.session)
 *   ownerOfCwd(cwd)     → the same, from the cwd alone (what the subprocess provider sees)
 *   ignoredUins()       → qq-bridge's bot accounts (strings)
 *   ownerComputer       → 'vm' | 'host' (where a qqb-owner command runs)
 *   doctor()            → Promise<[{ name, level, detail, fix }]> for /dot doctor
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger('dsh-dot/compat');
  const cfg = { ...defaults, ...config, ...sectionOf('compat', (m) => logger.warn(m)) };
  const hers = (id, cwd) => { try { return Boolean(ctx.get('dshDot')?.hers?.(id, cwd)); } catch { return false; } };

  let cached = null, cachedAt = 0, root = '', announced = false;
  const bridge = () => {
    if (cfg.qqBridge === false) return null;
    const now = Date.now();
    if (cached !== null && now - cachedAt < cfg.refreshMs) return cached || null;
    cachedAt = now;
    root ||= findRoot({ root: cfg.qqBridgeRoot });
    if (!root) { if (cfg.qqBridge === true && !announced) { announced = true; logger.warn('compat.qqBridge is on but qq-bridge was not found: set compat.qqBridgeRoot to its folder'); } cached = false; return null; }
    const next = readBridge(root);
    if (!cached || cached.stamp !== next.stamp) {
      cached = next;
      if (!announced) { announced = true; logger.info(`qq-bridge found at ${root}: mode ${next.mode}, bot ${next.botUins.join('/') || '(none seen)'}, owner ${next.ownerQQ || '(unset)'}, ${next.groups.length} group(s)`); }
    }
    return cached;
  };
  const owner = (id, cwd, preset) => classify({ id, cwd, preset }, bridge(), hers);
  const ownerOfCwd = (cwd) => classify({ cwd }, bridge(), (i, c) => hers('', c));

  /** Whose session is the one a system-prompt `text: (c) => …` is being built for. */
  const ownerOf = (c) => { const s = c?.agent?.session; return owner(s?.id ?? '', s?.header?.cwd ?? '', s?.header?.agentPreset); };
  const api = {
    bridge, owner, ownerOf, ownerOfCwd,
    ignoredUins: () => bridge()?.botUins ?? [],
    get ownerComputer() { return cfg.ownerComputer === 'host' ? 'host' : 'vm'; },
    hiddenFor: (o, names) => hiddenFor(o, names, cfg),
    doctor: async () => {
      let qq; try { qq = ctx.get('dshQq'); } catch { qq = undefined; }
      let groups = null;
      if (qq?.connected && qq.groups) { try { groups = (await qq.groups()).map((g) => g.gid); } catch (err) { logger.debug(`group list: ${err.message}`); } }
      return doctor({ bridge: bridge(), qq, groupsOf: groups ? () => groups : undefined });
    },
    settings: () => ({ ...cfg }),
  };
  ctx.provide?.('dshDotCompat', api);

  // ── tool visibility: one restriction per agent, recomputed when the global tool set changes ──
  ctx.inject(['tools'], (scope) => {
    const live = new Map(); // agent id → { agent, dispose, owner }
    const names = () => { try { return scope.tools.schemas().map((s) => s.name); } catch { return []; } };
    const applyTo = (entry) => {
      const hidden = api.hiddenFor(entry.owner, names());
      const key = hidden.join('\n');
      if (key === entry.key) return;
      try { entry.dispose?.(); } catch {}
      entry.dispose = null; entry.key = key;
      if (!hidden.length) return;
      try { entry.dispose = entry.agent.ctx.tools.restrict({ deny: hidden }); } catch (err) { logger.warn(`restrict ${entry.agent.id}: ${err.message}`); return; }
      logger.debug(`${entry.agent.id} (${entry.owner}): ${hidden.length} tool(s) hidden`);
    };
    scope.effect(() => scope.on('agent/created', ({ agent }) => {
      const s = agent?.session;
      if (!agent?.id || !agent.ctx?.tools) return;
      const o = owner(agent.id, s?.header?.cwd, s?.header?.agentPreset);
      const entry = { agent, owner: o, dispose: null, key: undefined };
      live.set(agent.id, entry);
      applyTo(entry);
      // The guard outlives any restriction gap (a tool registered later, a failed restrict): a tool
      // this session must not see is not run from it either.
      try {
        agent.ctx.tools.guard?.((exec) => (api.hiddenFor(o, [exec.name]).length ? `dsh-dot: ${exec.name} is not available in this session (${o})` : undefined));
      } catch (err) { logger.warn(`guard ${agent.id}: ${err.message}`); }
    }), 'dsh-dot/compat: per-session tool visibility');
    scope.effect(() => scope.on('agent/disposed', ({ agent }) => { const e = live.get(agent?.id); if (e) { try { e.dispose?.(); } catch {} live.delete(agent.id); } }), 'dsh-dot/compat: forget disposed agents');
    scope.effect(() => scope.on('tools/change', () => { for (const e of live.values()) applyTo(e); }), 'dsh-dot/compat: re-apply on tool changes');
  });

  logger.info(`compat ready — qq-bridge: ${cfg.qqBridge === false ? 'off' : bridge() ? 'found' : 'not found'}`);
  return api;
}

/** The /dot doctor items about living next to qq-bridge. `qq` is ctx.dshQq (her QQ) when on. */
export function doctor({ bridge, qq, groupsOf } = {}) {
  if (!bridge) return [];
  const items = [];
  const item = (name, level, detail, fix = '') => items.push({ name, level, detail, fix });
  const hers = qq?.selfId || qq?.qq || '';
  item('qq-bridge', 'ok', `在 ${bridge.root}，模式 ${bridge.mode}${bridge.botUins.length ? `，机器人 ${bridge.botUins.join('/')}` : ''}；它的会话里不会出现 dot 的工具${bridge.mode === 'closed-agent' ? '，主人私聊会话能用她的手机和电脑' : ''}`);
  if (!bridge.botUins.length) item('qq-bridge 机器人号', 'warn', '没读到 qq-bridge 的机器人号（它的 config.json 没填 snowluma.homeDir，SNOWLUMA_HOME 也没设）', '在 qq-bridge 的 config.json 里填 snowluma.homeDir，或在 dsh-dot.json 的 qq.ignore 里手动写上它的号；不然两个机器人在同一个群里会互相回复');
  if (hers && bridge.botUins.includes(String(hers))) item('QQ 账号', 'bad', `她的 QQ ${hers} 也是 qq-bridge 的机器人号：两边会互相把对方挤下线`, '给她另一个 QQ 号（/qq account <号>），qq-bridge 保留现在这个');
  if (hers && bridge.ownerQQ && String(hers) === bridge.ownerQQ) item('QQ 账号', 'bad', `她的 QQ ${hers} 是 qq-bridge 的管理员号（ownerQQ）`, '她不能用你的号；/qq account 换成她自己的');
  if (groupsOf && bridge.groups.length) {
    const shared = groupsOf().filter((g) => bridge.groups.includes(String(g)));
    if (shared.length) item('共同的群', 'warn', `她和 qq-bridge 的机器人都在：${shared.join('、')}；她不回它的消息，但它会回她的`, `想让两边都安静：在 qq-bridge 那边把她的号 ${hers || ''} 拉黑（它的 config.json 有 deny.private / deny.groups 黑名单，按它的文档填），或别让两个号进同一个群`);
  }
  return items;
}

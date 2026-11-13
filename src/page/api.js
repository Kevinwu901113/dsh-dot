// The dot page's server half: JSON routes on dsh's own web server under /dsh-dot/api, behind dsh's
// login and Host/Origin fence (src/web-auth.js) like the panel and the phone's live view. Mounted by
// the plugin's root component (dot-ui), so it works with any subset of components on: every service
// is looked up when a request comes in and is simply absent when its component is off.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { rejectUnlessOwner } from '../web-auth.js';
import { dshHome, fileError, readAll, writeSections } from '../settings.js';
import { describe, validatePatch } from '../settings-schema.js';
import { gateFor } from '../llm-gate.js';
import { doctorFor, FIXES } from '../doctor.js';
import { bundle, summary, versions } from './diag.js';
import { PAGE_PATH, pageHtml } from './page.js';

export const API_PATH = '/dsh-dot/api';
const require = createRequire(import.meta.url);
const pluginVersion = (() => { try { return require('../../package.json').version; } catch { return '?'; } })();
const dshVersion = (() => {
  for (const p of ['@deepseek-ai/dsh-core/package.json', '@deepseek-ai/cordis/package.json']) { try { return `${p.split('/')[1]} ${require(p).version}`; } catch { /* next */ } }
  return process.versions.electron ? `electron ${process.versions.electron}` : '?';
})();

const setupFile = () => join(dshHome(), 'dsh-dot-setup.json');
export function readSetup() { try { return existsSync(setupFile()) ? JSON.parse(readFileSync(setupFile(), 'utf8')) : {}; } catch { return {}; } }
function writeSetup(patch) {
  const next = { ...readSetup(), ...patch, updatedAt: new Date().toISOString() };
  mkdirSync(dirname(setupFile()), { recursive: true });
  writeFileSync(setupFile(), JSON.stringify(next, null, 2));
  return next;
}

function services(ctx) {
  const get = (n) => { try { return ctx.get(n); } catch { return undefined; } };
  return { phone: get('dshPhone'), computer: get('dshComputer'), qq: get('dshQq'), dot: get('dshDot'), interlude: get('dshInterlude'), compat: get('dshDotCompat') };
}

/** Each component's status (null = component off). */
export function statusOf(ctx) {
  const s = services(ctx);
  const st = (svc) => { try { return svc?.status?.() ?? (svc ? {} : null); } catch (err) { return { state: 'error', error: err.message }; } };
  // The model-request gate (src/llm-gate.js) is listed only when a component installed it.
  const llm = (() => { try { const g = gateFor(ctx)?.status(); return g ? { state: g.providers.some((p) => p.coolingUntil) ? 'cooling' : 'on', ...g } : undefined; } catch { return undefined; } })();
  return { phone: st(s.phone), computer: st(s.computer), qq: st(s.qq), dot: s.dot ? { state: 'on' } : null, interlude: s.interlude ? { state: 'on' } : null, compat: s.compat ? { state: 'on', qqBridge: (() => { try { const b = s.compat.bridge(); return b ? { root: b.root, mode: b.mode, bots: b.botUins } : null; } catch { return null; } })() } : null, ...(llm ? { llm } : {}) };
}

const need = (svc, what) => { if (!svc) throw new Error(`${what}组件没开（在 dsh 的插件页打开）`); return svc; };
const ACTIONS = {
  'phone-rebuild': async ({ phone }, body) => {
    await need(phone, '手机').rebuild({ gb: body?.gb ? Number(body.gb) : undefined });
    return '旧手机已删除，正在新建并开机（几分钟）';
  },
  'phone-cleanup': async ({ phone }) => { const b = need(phone, '手机').cleanup(); return `清掉了 ${Math.round(b / 1048576)} MB 下载缓存`; },
  'qq-owner': async ({ qq }, body) => { need(qq, 'QQ').setOwner(String(body?.number ?? '')); return '已设置你的 QQ 号'; },
  'qq-account': async ({ qq }, body) => { need(qq, 'QQ').setAccount(String(body?.number ?? '')); return '已设置她的 QQ 号'; },
  'qq-install': async ({ qq }, body) => {
    need(qq, 'QQ');
    const backend = body?.backend === 'snowluma' ? 'snowluma' : 'napcat';
    void qq.install(backend).then(() => qq.start?.()).catch(() => {}); // minutes; progress shows in the QQ status
    return `开始安装 ${backend}（在电脑里，要几分钟）`;
  },
  'qq-start': async ({ qq }) => { await need(qq, 'QQ').start(); return 'QQ 启动中'; },
  'persona-import': async ({ interlude }, body) => {
    const r = await need(interlude, '幕间').importPreset(String(body?.code ?? '').trim());
    return `已导入：${r.name}（${r.title}，作者 @${r.author}，${r.license}）`;
  },
  'phone-accept': async ({ phone }, body) => { need(phone, '手机'); if (body?.gb) phone.setStorage(String(body.gb)); phone.accept(); return '已接受许可，开始安装'; },
  'phone-power': async ({ phone }, body) => { await need(phone, '手机').power(body?.on === true); return body?.on === true ? '手机开机中' : '手机已关机（重启 dsh 也保持关着）'; },
  'computer-power': async ({ computer }, body) => { await need(computer, '电脑').power(body?.on === true); return body?.on === true ? '电脑开机中' : '电脑已关机（重启 dsh 也保持关着）'; },
  'phone-restart': async ({ phone }) => { await need(phone, '手机').restart(); return '手机重启中'; },
  'phone-retry': async ({ phone }) => { await need(phone, '手机').restart(); return '重试中'; },
};

/**
 * The first-run steps as they stand: each { id, title, state: done|todo|working|blocked|skip, detail }.
 * Live facts (phone ready, persona imported, QQ connected) decide; the stored file only remembers
 * the steps that are acknowledgements (the doctor read, the components chosen).
 */
export function setupSteps(ctx, stored = readSetup()) {
  const s = services(ctx), st = statusOf(ctx);
  const dev = (svc, x, okStates) => !svc ? { state: 'skip', detail: '组件没开' }
    : okStates.includes(x?.state) ? { state: 'done', detail: '就绪' }
      : x?.state === 'error' ? { state: 'blocked', detail: x.error ?? '出错' }
        : x?.state === 'off' ? { state: 'skip', detail: '已关机（页面顶部可以开机）' }
        : x?.state === 'needs-license' ? { state: 'todo', detail: '还没装' }
          : { state: 'working', detail: x?.progress?.text ?? x?.stage ?? x?.state ?? '' };
  const canon = (() => { try { return s.interlude?.canon?.(); } catch { return null; } })();
  const q = st.qq;
  const steps = [
    { id: 'doctor', title: '检查这台电脑', ...(stored.doctorAck ? { state: 'done', detail: '已看过体检结果' } : { state: 'todo', detail: '' }) },
    { id: 'components', title: '选组件', ...(stored.componentsAck ? { state: 'done', detail: '' } : { state: 'todo', detail: '' }) },
    { id: 'phone', title: '她的手机', ...dev(s.phone, st.phone, ['ready']) },
    { id: 'computer', title: '她的电脑', ...dev(s.computer, st.computer, ['ready']) },
    { id: 'persona', title: '人设', ...(!s.interlude ? { state: 'skip', detail: '幕间组件没开' } : canon?.title ? { state: 'done', detail: `${canon.name}（${canon.title}）` } : stored.personaSkip ? { state: 'done', detail: '用内置人设' } : { state: 'todo', detail: '' }) },
    { id: 'qq', title: 'QQ', ...(!s.qq ? { state: 'skip', detail: 'QQ 组件没开' } : q?.connected ? { state: 'done', detail: `已登录 ${q.selfId ?? q.qq ?? ''}` } : stored.qqSkip ? { state: 'done', detail: '先不接 QQ' } : { state: q?.state === 'error' ? 'blocked' : 'todo', detail: q?.error ?? (q?.owner ? '' : '还没填你的 QQ 号'), owner: q?.owner ?? '', account: q?.qq ?? '', qqState: q?.state ?? '' }) },
  ];
  return { steps, done: steps.every((x) => x.state === 'done' || x.state === 'skip'), dismissed: Boolean(stored.dismissed) };
}

async function readJson(req, limit = 256 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 }); chunks.push(c); }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createApi(ctx, logger) {
  const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  const doctor = () => { const s = services(ctx); return doctorFor({ phone: s.phone, computer: s.computer, compat: s.compat, home: dshHome() }); };
  const info = () => { const s = services(ctx); const st = statusOf(ctx); return versions({ pluginVersion, dshVersion, phone: s.phone ? { ...st.phone } : null, computer: s.computer ? { ...st.computer, image: s.computer.doctorInfo?.().image, backend: s.computer.doctorInfo?.().backend } : null }); };
  const dotHome = () => services(ctx).dot?.home || join(homedir(), 'dot');

  return async function handle(req, res, sub) {
    const route = `${req.method} ${sub}`;
    try {
      if (route === 'GET /status') { const su = setupSteps(ctx); return json(res, 200, { status: statusOf(ctx), fileError: fileError() || null, setup: { done: su.done, dismissed: su.dismissed }, version: pluginVersion }); }
      // components: which sections' components are on (gate exposes no service and is never listed: the page treats an unlisted section as on)
      if (route === 'GET /settings') { const s = services(ctx); return json(res, 200, { entries: describe(readAll()), fileError: fileError() || null, components: Object.fromEntries(Object.keys(s).map((k) => [k, Boolean(s[k])])) }); }
      if (route === 'PUT /settings') {
        const body = await readJson(req);
        const patch = validatePatch(body.patch);
        writeSections(patch, { overwriteBroken: body.overwriteBroken === true });
        return json(res, 200, { ok: true, entries: describe(readAll()) });
      }
      if (route === 'POST /doctor') return json(res, 200, { items: await doctor() });
      if (req.method === 'POST' && sub.startsWith('/fix/')) {
        const f = FIXES[sub.slice('/fix/'.length)];
        if (!f) return json(res, 404, { error: 'unknown fix' });
        writeSections({ [f.section]: f.values });
        return json(res, 200, { ok: true, label: f.label, apply: f.apply });
      }
      if (req.method === 'POST' && sub.startsWith('/action/')) {
        const a = ACTIONS[sub.slice('/action/'.length)];
        if (!a) return json(res, 404, { error: 'unknown action' });
        return json(res, 200, { ok: true, message: await a(services(ctx), await readJson(req)) });
      }
      if (route === 'GET /setup') return json(res, 200, setupSteps(ctx));
      if (route === 'PUT /setup') {
        const body = await readJson(req);
        const allowed = Object.fromEntries(Object.entries(body).filter(([k, v]) => ['doctorAck', 'componentsAck', 'personaSkip', 'qqSkip', 'dismissed'].includes(k) && typeof v === 'boolean'));
        writeSetup(allowed);
        return json(res, 200, setupSteps(ctx));
      }
      if (route === 'GET /qq/qr') {
        const qq = services(ctx).qq;
        if (!qq) return json(res, 404, { error: 'QQ 组件没开' });
        const r = await qq.qr();
        if (!r?.png) return json(res, 503, { error: '二维码还没出来（QQ 还在启动，稍等再刷新）' });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(r.png);
        return;
      }
      if (route === 'GET /summary') return json(res, 200, { text: summary({ status: statusOf(ctx), doctor: await doctor(), info: info() }) });
      if (route === 'POST /diag/save') {
        // The desktop app may not hand an iframe's download to the user: also write it under ~/.dsh/diag/.
        const body = await readJson(req);
        const buf = bundle({ dotHome: dotHome(), status: statusOf(ctx), doctor: await doctor(), info: info(), withPrivate: body.private === true });
        const dir = join(dshHome(), 'diag');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `dsh-dot-diag-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`);
        writeFileSync(file, buf);
        return json(res, 200, { ok: true, file });
      }
      if (req.method === 'GET' && sub.split('?')[0] === '/diag') {
        const withPrivate = new URL(req.url ?? '/', 'http://x').searchParams.get('private') === '1';
        const buf = bundle({ dotHome: dotHome(), status: statusOf(ctx), doctor: await doctor(), info: info(), withPrivate });
        const name = `dsh-dot-diag-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`;
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}"`, 'content-length': buf.length, 'cache-control': 'no-store' }).end(buf);
        return;
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      logger?.warn?.(`dot page api ${route} failed: ${err.message}`);
      return json(res, err.status ?? 400, { error: err.message });
    }
  };
}

/** Mount the page and its API on dsh's web server. Returns the unregister function. */
export function mountApi(ctx, webServer, logger, connection) {
  const handle = createApi(ctx, logger);
  const html = pageHtml();
  const offPage = webServer.register({
    kind: 'prefix', path: PAGE_PATH,
    handler: (req, res) => {
      if (rejectUnlessOwner(connection, req, res)) return;
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
    },
  });
  const offApi = webServer.register({
    kind: 'prefix', path: API_PATH,
    handler: async (req, res) => {
      if (rejectUnlessOwner(connection, req, res)) return;
      let url;
      try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { res.writeHead(400).end(); return; }
      await handle(req, res, url.pathname.slice(API_PATH.length) || '/');
    },
  });
  return () => { offPage?.(); offApi?.(); };
}

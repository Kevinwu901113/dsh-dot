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
import { doctorFor, FIXES } from '../doctor.js';
import { bundle, summary, versions } from './diag.js';

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
  return { phone: get('dshPhone'), computer: get('dshComputer'), qq: get('dshQq'), dot: get('dshDot'), interlude: get('dshInterlude') };
}

/** Each component's status (null = component off). */
export function statusOf(ctx) {
  const s = services(ctx);
  const st = (svc) => { try { return svc?.status?.() ?? (svc ? {} : null); } catch (err) { return { state: 'error', error: err.message }; } };
  return { phone: st(s.phone), computer: st(s.computer), qq: st(s.qq), dot: s.dot ? { state: 'on' } : null, interlude: s.interlude ? { state: 'on' } : null };
}

const ACTIONS = {
  'phone-accept': async ({ phone }, body) => { if (!phone) throw new Error('手机组件没开'); if (body?.gb) phone.setStorage(String(body.gb)); phone.accept(); return '已接受许可，开始安装'; },
  'phone-restart': async ({ phone }) => { if (!phone) throw new Error('手机组件没开'); await phone.restart(); return '手机重启中'; },
  'phone-retry': async ({ phone }) => { if (!phone) throw new Error('手机组件没开'); await phone.restart(); return '重试中'; },
};

async function readJson(req, limit = 256 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 }); chunks.push(c); }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createApi(ctx, logger) {
  const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  const doctor = () => { const s = services(ctx); return doctorFor({ phone: s.phone, computer: s.computer, home: dshHome() }); };
  const info = () => { const s = services(ctx); const st = statusOf(ctx); return versions({ pluginVersion, dshVersion, phone: s.phone ? { ...st.phone } : null, computer: s.computer ? { ...st.computer, image: s.computer.doctorInfo?.().image, backend: s.computer.doctorInfo?.().backend } : null }); };
  const dotHome = () => services(ctx).dot?.home || join(homedir(), 'dot');

  return async function handle(req, res, sub) {
    const route = `${req.method} ${sub}`;
    try {
      if (route === 'GET /status') return json(res, 200, { status: statusOf(ctx), fileError: fileError() || null, setup: readSetup(), version: pluginVersion });
      if (route === 'GET /settings') return json(res, 200, { entries: describe(readAll()), fileError: fileError() || null, components: Object.fromEntries(Object.entries(statusOf(ctx)).map(([k, v]) => [k, v !== null])) });
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
      if (route === 'GET /setup') return json(res, 200, readSetup());
      if (route === 'PUT /setup') return json(res, 200, writeSetup(await readJson(req)));
      if (route === 'GET /summary') return json(res, 200, { text: summary({ status: statusOf(ctx), doctor: await doctor(), info: info() }) });
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

/** Mount on dsh's web server. Returns the unregister function. */
export function mountApi(ctx, webServer, logger, connection) {
  const handle = createApi(ctx, logger);
  return webServer.register({
    kind: 'prefix', path: API_PATH,
    handler: async (req, res) => {
      if (rejectUnlessOwner(connection, req, res)) return;
      let url;
      try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { res.writeHead(400).end(); return; }
      await handle(req, res, url.pathname.slice(API_PATH.length) || '/');
    },
  });
}

// msb downloads images with reqwest, which honors HTTPS_PROXY but not the OS proxy settings that
// tools like Clash or Surge configure. Translate the system proxy into env vars for `msb pull`.
import { execFileSync } from 'node:child_process';

export function systemProxyEnv() {
  if (process.env.HTTPS_PROXY || process.env.https_proxy) return {};
  let url = '';
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 });
      const get = (k) => (new RegExp(`\\b${k} : (\\S+)`).exec(out) || [])[1];
      if (get('HTTPSEnable') === '1') url = `http://${get('HTTPSProxy')}:${get('HTTPSPort')}`;
      else if (get('HTTPEnable') === '1') url = `http://${get('HTTPProxy')}:${get('HTTPPort')}`;
    } else if (process.platform === 'win32') {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      const out = execFileSync('reg', ['query', key], { encoding: 'utf8', timeout: 3000 });
      if (/ProxyEnable\s+REG_DWORD\s+0x1/.test(out)) {
        let server = (/ProxyServer\s+REG_SZ\s+(\S+)/.exec(out) || [])[1] || '';
        server = (/https=([^;]+)/.exec(server) || /http=([^;]+)/.exec(server) || [null, server])[1];
        if (server) url = /^[a-z]+:\/\//.test(server) ? server : `http://${server}`;
      }
    }
  } catch {}
  return url ? { HTTPS_PROXY: url, HTTP_PROXY: url, NO_PROXY: 'localhost,127.0.0.1' } : {};
}

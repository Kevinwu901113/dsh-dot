// The entry dsh-dot starts mobile-mcp through (see mountMcp in phone.js).
// On Windows the server runs without a console (inside the desktop app it is Electron running as
// Node), and it calls adb with execFileSync for every tap and screenshot: a console program started
// from a console-less parent with no `windowsHide` opens its own console window each time. So every
// child this process starts is hidden by default; a caller that sets windowsHide itself keeps its choice.
'use strict';
const NAMES = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const plain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Wrap `cp`'s process starters so `windowsHide` defaults to true. Returns `cp`. */
function hideChildWindows(cp) {
  for (const name of NAMES) {
    const original = cp[name];
    if (typeof original !== 'function' || original.dshHidden) continue;
    const wrapped = function (...args) {
      const at = args.findIndex((a, i) => i > 0 && plain(a));
      if (at >= 0) args[at] = { windowsHide: true, ...args[at] };
      else { const cb = typeof args[args.length - 1] === 'function' ? args.length - 1 : args.length; args.splice(cb, 0, { windowsHide: true }); }
      return original.apply(this, args);
    };
    wrapped.dshHidden = true;
    cp[name] = wrapped;
  }
  return cp;
}
module.exports = { hideChildWindows };

if (require.main === module) {
  if (process.platform === 'win32') hideChildWindows(require('node:child_process'));
  require(process.env.DSH_DOT_MOBILE_MCP_ENTRY);
}

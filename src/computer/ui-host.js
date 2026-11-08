// Host half of the plugin's root component (dot-ui): the browser bundle (lib/client.js) adds the
// sidebar tabs, the header buttons and the dot page; on the host this mounts the dot page's API
// (/dsh-dot/api: settings, doctor, one-click fixes, diagnostics), independent of which other
// components are on.
import { mountApi } from '../page/api.js';

export const inject = [];

export function apply(ctx) {
  const logger = ctx.logger('dsh-dot/page');
  ctx.inject(['webServer', 'connection'], (c) => c.effect(() => mountApi(ctx, c.webServer, logger, c.connection), 'dsh-dot: page api'));
}

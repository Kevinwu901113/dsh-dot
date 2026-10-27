/**
 * dsh-computer client: a right-Sidebar tab showing the agent's computer (noVNC)
 * and a Session header button that shows or hides it.
 */
import { createElement, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { ComputerView, type ComputerViewProps } from './view.tsx'
import { HeaderButton } from './HeaderButton.tsx'
import { ComputerArtwork } from './icons.tsx'
import { panelUrl, phoneLiveViewUrl, probePanel, probePhone, type ComputerEndpoint } from './endpoint.ts'
import { DotArtwork, DotIcon, PhoneArtwork, PhoneIcon } from './icons.tsx'
import { en, NS, zh } from './locales.ts'

/** Services the tab and the header button use. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

const ID = 'dsh-computer'
const KIND = 'dsh-computer'
const PHONE_ID = 'dsh-phone'
const PHONE_KIND = 'dsh-phone'
const DOT_ID = 'dsh-dot-panel'
const DOT_KIND = 'dsh-dot-panel'

// The computer's live view is same-origin (relayed by dsh-dot/computer on dsh's web server); the
// gateway port is keyed and not addressed by the client. Port 0 hides the host:port in the status bar.
function endpoint(): ComputerEndpoint {
  return { host: '127.0.0.1', port: 0 }
}

// dsh-dot/phone's live view is same-origin (/dsh-dot/phone/ on dsh's web server, behind dsh's login); the endpoint
// object is kept only for ComputerView's signature. The query override is a leftover and ignored by the URL helpers.
function phoneEndpoint(): ComputerEndpoint {
  let port = 18090
  try {
    const override = Number(new URLSearchParams(window.location.search).get('dshPhonePort'))
    if (Number.isInteger(override) && override > 0 && override < 65536) port = override
  } catch {
    // No readable location (non-browser test runtime): keep the default port.
  }
  return { host: '127.0.0.1', port }
}

/** Copy accessor for the phone tab: phone-specific keys first, shared status keys as they are. */
const phoneCopy = (t: (key: string) => string) => (key: string): string => {
  const own: Record<string, string> = { title: 'phoneTitle', open: 'phoneOpen', description: 'phoneDescription', toggle: 'phoneToggle', checking: 'phoneChecking', offline: 'phoneOffline' }
  return t(own[key] ?? key)
}

/** Copy accessor for the dot panel tab. */
const dotCopy = (t: (key: string) => string) => (key: string): string => {
  const own: Record<string, string> = { title: 'dotTitle', open: 'dotOpen', description: 'dotDescription', toggle: 'dotToggle', checking: 'dotChecking', offline: 'dotOffline' }
  return t(own[key] ?? key)
}

/**
 * Register the computer tab type, its body, and the header toggle.
 * @param ctx - Client root Context with slot and sidebar services.
 */
export function apply(ctx: Context): void {
  // Services are declaration-merged across the workspace; this standalone plugin
  // only reaches the members listed in `inject`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  const c = ctx as any
  const t = c.locale.bind(NS) as (key: string) => string
  const at = endpoint()

  ctx.effect(() => c.locale.register(NS, { zh, en }), 'dsh-computer.copy')
  ctx.effect(() => c.sidebarRightTabs.register({
    id: ID, kind: KIND, priority: 'extension', keepMounted: true, title: () => t('title'),
    guide: [{ id: 'open', order: 40, title: () => t('open'), description: () => t('description'), icon: ComputerArtwork }],
  }), 'dsh-computer.type')

  const Body = (props: Omit<ComputerViewProps, 'endpoint'>): ReactNode => createElement(ComputerView, { ...props, endpoint: at })
  ctx.effect(() => c.slots.inject('sidebar.right.pane.tab', () => c.slots.register(
    { name: 'sidebar.right.pane.tab', key: ID, locale: NS }, Body,
  )), 'dsh-computer.body')

  // Show the computer tab; a second press while it is the visible active tab collapses the column.
  const toggle = (): void => {
    const sidebar = c.sidebarRight
    if (sidebar.isExpanded() && sidebar.active()?.kind === KIND) sidebar.toggleExpanded()
    else sidebar.openTab(KIND)
  }
  const Header = (props: { t: (key: string) => string }): ReactNode => createElement(HeaderButton, { t: props.t, toggle })
  ctx.effect(() => c.slots.inject('conversation.session.header.utilities', () => c.slots.register({
    name: 'conversation.session.header.utilities', id: ID, order: -20, locale: NS,
  }, Header)), 'dsh-computer.header')

  // The phone: same tab body against dsh-dot/phone's live view page.
  const tp = phoneCopy(t)
  const phoneAt: ComputerEndpoint = { host: '', port: 0 } // same-origin: nothing to show beside the status
  ctx.effect(() => c.sidebarRightTabs.register({
    id: PHONE_ID, kind: PHONE_KIND, priority: 'extension', keepMounted: true, title: () => tp('title'),
    guide: [{ id: 'open', order: 41, title: () => tp('open'), description: () => tp('description'), icon: PhoneArtwork }],
  }), 'dsh-phone.type')
  const PhoneBody = (props: Omit<ComputerViewProps, 'endpoint'>): ReactNode => createElement(ComputerView, { ...props, t: tp, endpoint: phoneAt, url: phoneLiveViewUrl(phoneAt), probe: probePhone })
  ctx.effect(() => c.slots.inject('sidebar.right.pane.tab', () => c.slots.register(
    { name: 'sidebar.right.pane.tab', key: PHONE_ID, locale: NS }, PhoneBody,
  )), 'dsh-phone.body')
  const togglePhone = (): void => {
    const sidebar = c.sidebarRight
    if (sidebar.isExpanded() && sidebar.active()?.kind === PHONE_KIND) sidebar.toggleExpanded()
    else sidebar.openTab(PHONE_KIND)
  }
  const PhoneHeader = (props: { t: (key: string) => string }): ReactNode => createElement(HeaderButton, { t: phoneCopy(props.t), toggle: togglePhone, icon: PhoneIcon })
  ctx.effect(() => c.slots.inject('conversation.session.header.utilities', () => c.slots.register({
    name: 'conversation.session.header.utilities', id: PHONE_ID, order: -19, locale: NS,
  }, PhoneHeader)), 'dsh-phone.header')

  // The dot panel: the same tab body, against dsh-dot/dot's page on dsh's own web server (same origin).
  const td = dotCopy(t)
  const panelAt: ComputerEndpoint = { host: '', port: 0 }
  ctx.effect(() => c.sidebarRightTabs.register({
    id: DOT_ID, kind: DOT_KIND, priority: 'extension', keepMounted: true, title: () => td('title'),
    guide: [{ id: 'open', order: 42, title: () => td('open'), description: () => td('description'), icon: DotArtwork }],
  }), 'dsh-dot-panel.type')
  const DotBody = (props: Omit<ComputerViewProps, 'endpoint'>): ReactNode => createElement(ComputerView, { ...props, t: td, endpoint: panelAt, url: panelUrl(), probe: probePanel })
  ctx.effect(() => c.slots.inject('sidebar.right.pane.tab', () => c.slots.register(
    { name: 'sidebar.right.pane.tab', key: DOT_ID, locale: NS }, DotBody,
  )), 'dsh-dot-panel.body')
  const toggleDot = (): void => {
    const sidebar = c.sidebarRight
    if (sidebar.isExpanded() && sidebar.active()?.kind === DOT_KIND) sidebar.toggleExpanded()
    else sidebar.openTab(DOT_KIND)
  }
  const DotHeader = (props: { t: (key: string) => string }): ReactNode => createElement(HeaderButton, { t: dotCopy(props.t), toggle: toggleDot, icon: DotIcon })
  ctx.effect(() => c.slots.inject('conversation.session.header.utilities', () => c.slots.register({
    name: 'conversation.session.header.utilities', id: DOT_ID, order: -18, locale: NS,
  }, DotHeader)), 'dsh-dot-panel.header')
}

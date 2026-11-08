/**
 * dsh-computer client: a right-Sidebar tab showing the agent's computer (noVNC)
 * and a Session header button that shows or hides it.
 */
import { createElement, useEffect, useState, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { ComputerView, type ComputerViewProps } from './view.tsx'
import { HeaderButton } from './HeaderButton.tsx'
import { ComputerArtwork } from './icons.tsx'
import { pageUrl, panelUrl, phoneLiveViewUrl, probePanel, probePhone, type ComputerEndpoint } from './endpoint.ts'
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

  // The dot page: a left-sidebar entry like Plugins, opening a full page (settings, doctor,
  // diagnostics) served same-origin by the plugin's root component, so it works with any components on.
  const PAGE_ID = 'dsh-dot'
  const PageIcon = ({ size }: { size?: number }): ReactNode => createElement(DotIcon, { size })
  const PageBody = (): ReactNode => createElement('div', { style: { position: 'relative', width: '100%', height: '100%', minHeight: 0 } },
    createElement('iframe', { src: pageUrl(), title: 'dot', style: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, display: 'block' } }))
  ctx.effect(() => c.slots.inject('main', () => c.slots.register({ name: 'main', key: PAGE_ID, locale: NS }, PageBody)), 'dsh-dot-page.main')
  ctx.effect(() => c.slots.inject('sidebar.panellist', () => c.slots.register({
    name: 'sidebar.panellist', id: PAGE_ID, order: 20, label: () => t('pageTitle'), locale: NS,
  }, PageIcon)), 'dsh-dot-page.entry')

  // First run: one small card (not a modal) pointing at the dot page until setup is done or he says later.
  const api = (): string => pageUrl().replace(/page\/$/, '') + 'api'
  const openPage = (): void => { try { (c.layout ?? c.get?.('layout'))?.selectPanel?.(PAGE_ID) } catch { /* no layout service */ } }
  const DotOnboarding = (props: { complete: () => void }): ReactNode => {
    const [show, setShow] = useState(false)
    useEffect(() => {
      let alive = true
      fetch(`${api()}/status`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((j) => {
        if (!alive) return
        if (!j || j.setup?.done || j.setup?.dismissed) props.complete()
        else setShow(true)
      }).catch(() => { if (alive) props.complete() })
      return () => { alive = false }
    }, [])
    if (!show) return null
    const later = (): void => {
      void fetch(`${api()}/setup`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dismissed: true }) }).catch(() => {})
      props.complete()
    }
    const btn = (label: string, onClick: () => void, primary: boolean): ReactNode => createElement('button', { type: 'button', onClick, style: { font: 'inherit', padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: `1px solid ${primary ? '#4a7fd6' : 'rgba(128,128,128,.4)'}`, background: primary ? '#4a7fd6' : 'transparent', color: primary ? '#fff' : 'inherit' } }, label)
    return createElement('div', { role: 'dialog', 'aria-label': t('onboardTitle'), style: { position: 'fixed', right: 20, bottom: 20, zIndex: 1000, maxWidth: 340, background: 'Canvas', color: 'CanvasText', colorScheme: 'light dark', border: '1px solid rgba(128,128,128,.3)', borderRadius: 10, padding: '14px 16px', boxShadow: '0 6px 24px rgba(0,0,0,.18)', font: "13px/1.55 system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif" } },
      createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, t('onboardTitle')),
      createElement('div', { style: { opacity: 0.75, marginBottom: 10 } }, t('onboardBody')),
      createElement('div', { style: { display: 'flex', gap: 8 } }, btn(t('onboardGo'), () => { openPage(); props.complete() }, true), btn(t('onboardLater'), later, false)))
  }
  ctx.effect(() => c.slots.inject('settings.onboarding', () => c.slots.register({
    name: 'settings.onboarding', id: PAGE_ID, order: 100, label: () => t('pageTitle'), locale: NS,
  }, DotOnboarding)), 'dsh-dot-page.onboarding')
}

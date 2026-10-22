/**
 * dsh-computer client: a right-Sidebar tab showing the agent's computer (noVNC)
 * and a Session header button that shows or hides it.
 */
import { createElement, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { ComputerView, type ComputerViewProps } from './view.tsx'
import { HeaderButton } from './HeaderButton.tsx'
import { ComputerArtwork } from './icons.tsx'
import type { ComputerEndpoint } from './endpoint.ts'
import { en, NS, zh } from './locales.ts'

/** Services the tab and the header button use. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

const ID = 'dsh-computer'
const KIND = 'dsh-computer'

// The VM host plugin publishes on 127.0.0.1:18080 unless DSH_COMPUTER_PORT changes it;
// client rows receive no Loader config, so the page may override the port by query (?dshComputerPort=).
function endpoint(): ComputerEndpoint {
  let port = 18080
  try {
    const override = Number(new URLSearchParams(window.location.search).get('dshComputerPort'))
    if (Number.isInteger(override) && override > 0 && override < 65536) port = override
  } catch {
    // No readable location (non-browser test runtime): keep the default port.
  }
  return { host: '127.0.0.1', port }
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
}

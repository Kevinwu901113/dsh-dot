/** Session header control that shows or hides the computer tab. */
import { createElement, type ReactNode } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { MonitorIcon } from './icons.tsx'

/** Copy plus the toggle bound at registration. */
export interface HeaderButtonProps {
  readonly t: (key: string) => string
  readonly toggle: () => void
  /** Glyph; default: the monitor. */
  readonly icon?: () => ReactNode
}

/**
 * One compact button beside the header utilities.
 * @param props - copy and the toggle action.
 * @returns the button.
 */
export function HeaderButton({ t, toggle, icon = MonitorIcon }: HeaderButtonProps): ReactNode {
  return (
    <Tooltip label={t('toggle')} side="bottom" delayMs={500}>
      <Button size="sm" variant="ghost" aria-label={t('toggle')} data-dsh-computer-toggle onClick={toggle}>
        {createElement(icon)}
      </Button>
    </Tooltip>
  )
}

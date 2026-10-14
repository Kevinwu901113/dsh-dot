/** Session header control that shows or hides the computer tab. */
import type { ReactNode } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { MonitorIcon } from './icons.tsx'

/** Copy plus the toggle bound at registration. */
export interface HeaderButtonProps {
  readonly t: (key: string) => string
  readonly toggle: () => void
}

/**
 * One compact button beside the header utilities.
 * @param props - copy and the toggle action.
 * @returns the button.
 */
export function HeaderButton({ t, toggle }: HeaderButtonProps): ReactNode {
  return (
    <Tooltip label={t('toggle')} side="bottom" delayMs={500}>
      <Button size="sm" variant="ghost" aria-label={t('toggle')} data-dsh-computer-toggle onClick={toggle}>
        <MonitorIcon />
      </Button>
    </Tooltip>
  )
}

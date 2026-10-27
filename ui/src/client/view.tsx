/** Sidebar tab body: the computer's live desktop (noVNC) with a status bar. */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, IconRefreshOutlineRegular, IconRightUpOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './view.module.css'
import { liveViewUrl, probe, type ComputerEndpoint } from './endpoint.ts'

type Status = 'checking' | 'ready' | 'offline'

/** Props the sidebar slot passes plus the endpoint bound at registration. */
// The slot runtime's prop types are declaration-merged across the workspace; this
// standalone plugin reads only the members it uses.
export interface ComputerViewProps {
  readonly useTabInfo: () => { tab: { visible?: boolean; actions: { openTab: (kind: string, options?: object) => void } } }
  readonly t: (key: string) => string
  readonly endpoint: ComputerEndpoint
  /** Live view URL; default: the computer's noVNC page. */
  readonly url?: string
  /** Readiness probe; default: the computer's sandbox API. */
  readonly probe?: (endpoint: ComputerEndpoint, signal: AbortSignal) => Promise<boolean>
}

/**
 * Render the live view once the computer answers; poll while it does not.
 * @param props - tab info, copy, and the computer endpoint.
 * @returns the status bar and the embedded desktop, or a waiting panel.
 */
export function ComputerView({ useTabInfo, t, endpoint, url: urlProp, probe: probeProp }: ComputerViewProps): ReactNode {
  const { tab } = useTabInfo()
  const [status, setStatus] = useState<Status>('checking')
  const [revision, setRevision] = useState(0)
  const url = urlProp ?? liveViewUrl(endpoint)
  const probeFn = probeProp ?? probe

  const check = useCallback(async (signal: AbortSignal): Promise<void> => {
    const ok = await probeFn(endpoint, signal)
    if (!signal.aborted) setStatus(ok ? 'ready' : 'offline')
  }, [endpoint, probeFn])

  useEffect(() => {
    const controller = new AbortController()
    void check(controller.signal)
    return () => { controller.abort() }
  }, [check, revision])

  // While the computer is not answering, look again every few seconds.
  useEffect(() => {
    if (status === 'ready') return
    const timer = setInterval(() => { setRevision(r => r + 1) }, 4000)
    return () => { clearInterval(timer) }
  }, [status])

  const reload = (): void => { setStatus('checking'); setRevision(r => r + 1) }
  const openBuiltin = (): void => { tab.actions.openTab('browser', { params: { url } }) }
  const openExternal = (): void => { window.open(url, '_blank', 'noopener') }

  const dotClass = status === 'ready' ? `${css.dot} ${css.dotReady}` : status === 'checking' ? `${css.dot} ${css.dotStarting}` : css.dot
  return (
    <section className={css.root} data-dsh-computer-view>
      <div className={css.bar}>
        <span className={dotClass} aria-hidden="true" />
        <span className={css.label}>{status === 'ready' ? t('ready') : t('starting')}{endpoint.port ? ` · ${endpoint.host}:${endpoint.port}` : ''}</span>
        <Tooltip label={t('reload')} side="bottom" delayMs={400}>
          <Button size="sm" variant="ghost" aria-label={t('reload')} onClick={reload}><IconRefreshOutlineRegular /></Button>
        </Tooltip>
        <Tooltip label={t('external')} side="bottom" delayMs={400}>
          <Button size="sm" variant="ghost" aria-label={t('external')} onClick={openExternal}><IconRightUpOutlineRegular /></Button>
        </Tooltip>
      </div>
      {status === 'ready'
        ? <iframe
            key={revision}
            className={css.frame}
            src={url}
            title={t('title')}
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        : <div className={css.empty} role="status">
            <p>{status === 'checking' ? t('checking') : t('offline')}</p>
            <div className={css.actions}>
              <Button size="sm" variant="outline" onClick={reload}>{t('retry')}</Button>
              <Button size="sm" variant="outline" onClick={openBuiltin}>{t('builtin')}</Button>
            </div>
          </div>}
    </section>
  )
}

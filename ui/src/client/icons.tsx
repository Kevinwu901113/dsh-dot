/** Monitor glyphs for the computer view. */
import type { ReactNode } from 'react'

/** Guide artwork: a monitor with a pointer, sized like the built-in plugin artwork. */
export const ComputerArtwork = ({ size = 36, className }: { size?: number; className?: string }): ReactNode => (
  <svg width={size} height={size} className={className} viewBox="0 0 36 36" fill="none" aria-hidden="true">
    <rect x="6.5" y="8.5" width="23" height="15" rx="2.5" stroke="#5BB98C" strokeWidth="2.5" />
    <path d="M14 28.5H22M18 23.5V28.5" stroke="#5BB98C" strokeWidth="2.5" strokeLinecap="round" />
    <path d="M16 12.5L21.5 16L18.8 16.6L17.6 19.2L16 12.5Z" fill="#5BB98C" />
  </svg>
)

/** Sixteen-pixel monitor glyph in the surrounding text color. */
export const MonitorIcon = (): ReactNode => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
    <path d="M5.5 13.75H10.5M8 11.25V13.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
)

/** Guide artwork: a phone, in the same style as the monitor. */
export const PhoneArtwork = ({ size = 36, className }: { size?: number; className?: string }): ReactNode => (
  <svg width={size} height={size} className={className} viewBox="0 0 36 36" fill="none" aria-hidden="true">
    <rect x="11.5" y="5.5" width="13" height="25" rx="3" stroke="#5BB98C" strokeWidth="2.5" />
    <path d="M16 9.5H20" stroke="#5BB98C" strokeWidth="2.5" strokeLinecap="round" />
    <circle cx="18" cy="26" r="1.5" fill="#5BB98C" />
  </svg>
)

/** Sixteen-pixel phone glyph in the surrounding text color. */
export const PhoneIcon = (): ReactNode => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="4.75" y="1.75" width="6.5" height="12.5" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
    <path d="M7 3.75H9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
)

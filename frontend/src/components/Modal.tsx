import { useEffect, useRef, type ReactNode } from 'react'
import { IconClose } from './Icons'

type Props = {
  title: string
  subtitle?: string
  onClose?: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  /** Click on the dim backdrop closes the dialog. */
  dismissible?: boolean
}

/** Centered dialog with Esc-to-close and focus moved inside on open. */
export function Modal({ title, subtitle, onClose, children, footer, wide, dismissible = true }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  useEffect(() => {
    if (!onClose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (dismissible && onClose && e.target === e.currentTarget) onClose()
      }}
    >
      <div ref={ref} tabIndex={-1} className={wide ? 'modal modal-wide' : 'modal'} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          {onClose && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <IconClose />
            </button>
          )}
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  )
}

import { useWorkspace } from '../state/workspace'
import { Modal } from './Modal'
import { IconClose } from './Icons'

/** Renders the promise-based confirm dialog requested via `useWorkspace().confirm`. */
export function ConfirmHost() {
  const req = useWorkspace((s) => s.confirmRequest)
  const answer = useWorkspace((s) => s.answerConfirm)
  if (!req) return null
  return (
    <Modal
      title={req.title}
      onClose={() => answer(false)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => answer(false)}>
            {req.cancelLabel ?? 'Cancel'}
          </button>
          <button type="button" className={req.danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={() => answer(true)} autoFocus>
            {req.okLabel}
          </button>
        </>
      }
    >
      <p>{req.body}</p>
    </Modal>
  )
}

export function Toasts() {
  const toasts = useWorkspace((s) => s.toasts)
  const dismiss = useWorkspace((s) => s.dismissToast)
  if (!toasts.length) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <span>{t.text}</span>
          <button type="button" className="icon-btn" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <IconClose />
          </button>
        </div>
      ))}
    </div>
  )
}

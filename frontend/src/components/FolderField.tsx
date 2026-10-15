import { useState } from 'react'
import { FolderPicker } from './FolderPicker'
import { IconFolder } from './Icons'

type Props = {
  label: string
  hint?: string
  value: string
  purpose: 'input' | 'output'
  onChange: (path: string) => void
}

/** Read-only path display + Browse button that opens the folder picker. */
export function FolderField({ label, hint, value, purpose, onChange }: Props) {
  const [open, setOpen] = useState(false)
  return (
    <div className="field-block">
      <span className="field-label">{label}</span>
      {hint && <span className="muted">{hint}</span>}
      <div className="folder-field">
        <button type="button" className="folder-value" onClick={() => setOpen(true)} title={value || undefined}>
          <IconFolder />
          <span className={value ? '' : 'muted'}>{value || 'Not chosen yet — click to browse'}</span>
        </button>
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Browse…
        </button>
      </div>
      {open && (
        <FolderPicker
          title={label}
          purpose={purpose}
          initialPath={value}
          onClose={() => setOpen(false)}
          onPick={(p) => {
            setOpen(false)
            onChange(p)
          }}
        />
      )}
    </div>
  )
}

import { useAppStore } from '../state/store'

/**
 * Bottom bar: Skip / Save progress (Incomplete) / Complete ▶ (Completed + next).
 */
export function ActionBar() {
  const session = useAppStore((s) => s.session)
  const busy = useAppStore((s) => s.busy)
  const loading = useAppStore((s) => s.loading)
  const error = useAppStore((s) => s.error)
  const setError = useAppStore((s) => s.setError)
  const save = useAppStore((s) => s.save)
  const saveIncomplete = useAppStore((s) => s.saveIncomplete)
  const skip = useAppStore((s) => s.skip)
  const toolMode = useAppStore((s) => s.toolMode)
  const brushMode = useAppStore((s) => s.brushMode)
  const seeds = session?.seeds.length ?? 0
  const leaves = session?.leaves.length ?? 0
  const canSave = !!session && leaves > 0 && !busy && !loading
  const modeLabel =
    toolMode === 'brush'
      ? `brush · ${brushMode === 'erase' ? 'remove' : 'add'}`
      : toolMode

  return (
    <footer className="actionbar">
      <div className="action-meta">
        <span>
          Mode: <strong>{modeLabel}</strong>
        </span>
        <span>
          Seeds: <strong>{seeds}</strong>
        </span>
        <span>
          Leaves: <strong>{leaves}</strong>
        </span>
        {error && (
          <span className="error-banner" role="alert">
            {error}
            <button type="button" className="linkish" onClick={() => setError(null)}>
              dismiss
            </button>
          </span>
        )}
      </div>
      <div className="action-buttons">
        <button
          type="button"
          className="btn"
          disabled={!session || busy || loading}
          onClick={() => void skip()}
        >
          Skip
        </button>
        <button
          type="button"
          className="btn"
          disabled={!canSave}
          title="Export crops, mark Incomplete, stay on this sample"
          onClick={() => void saveIncomplete()}
        >
          Save progress
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!canSave}
          title="Export crops, mark Completed, go to next pending sample"
          onClick={() => void save()}
        >
          Complete ▶
        </button>
      </div>
    </footer>
  )
}

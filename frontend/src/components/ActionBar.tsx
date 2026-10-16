import { useEditor } from '../state/editor'
import { useWorkspace } from '../state/workspace'

export function ActionBar() {
  const image = useEditor((s) => s.image)
  const objects = useEditor((s) => s.objects)
  const saving = useEditor((s) => s.saving)
  const busy = useEditor((s) => s.busy)
  const dirty = useEditor((s) => s.dirty)
  const save = useEditor((s) => s.save)
  const skip = useEditor((s) => s.skip)
  const outputDir = useWorkspace((s) => s.settings?.outputDir)
  const disabled = !image || saving || busy
  const none = objects.length === 0

  return (
    <footer className="actionbar">
      <div className="action-info">
        {image ? (
          <>
            <strong>{image.name}</strong>
            <span className="muted">
              {image.nativeWidth}×{image.nativeHeight}{image.nativeWidth !== image.width ? ` (working at ${image.width}×${image.height})` : ''} · {image.kind === 'cube' ? `${image.bands} bands` : 'colour image'} · {objects.length} object{objects.length === 1 ? '' : 's'}{image.rotation ? ` · rotated ${image.rotation}°` : ''}
              {dirty ? ' · unsaved changes' : image.status !== 'Pending' ? ` · ${image.status.toLowerCase()}` : ''}
            </span>
          </>
        ) : (
          <span className="muted">No image open</span>
        )}
      </div>
      <div className="action-buttons">
        <button type="button" className="btn" disabled={disabled} onClick={() => void skip()} title="Mark this image as skipped and open the next one">
          Skip image
        </button>
        <button type="button" className="btn" disabled={disabled || none} onClick={() => void save(false)} title={`Save results to ${outputDir ?? 'the output folder'} and stay on this image`}>
          Save and stay
        </button>
        <button type="button" className="btn btn-primary" disabled={disabled || none} onClick={() => void save(true)} title="Save, mark as done, and open the next image">
          {saving ? 'Saving…' : 'Save & next ▶'}
        </button>
      </div>
    </footer>
  )
}

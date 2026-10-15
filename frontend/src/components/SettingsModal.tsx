import { useMemo, useState } from 'react'
import type { ExportFormat, MetadataFormat, Settings } from '../api/client'
import { useEditor } from '../state/editor'
import { useWorkspace, type SettingsTab } from '../state/workspace'
import { EnginePanel } from './EnginePanel'
import { FolderField } from './FolderField'
import { Modal } from './Modal'

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'folders', label: 'Folders' },
  { id: 'engine', label: 'Model & GPU' },
  { id: 'display', label: 'Image display' },
  { id: 'export', label: 'Export' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'shortcuts', label: 'Shortcuts' },
]

const FORMATS: { value: ExportFormat; label: string; help: string }[] = [
  { value: 'same_as_input', label: 'Same as the original (recommended)', help: 'Photos become PNG pictures with a transparent background. Multispectral / hyperspectral files keep their own format.' },
  { value: 'png', label: 'PNG picture (transparent background)', help: 'For spectral files this saves only the colour preview, not the spectral bands.' },
  { value: 'tiff', label: 'TIFF', help: 'All bands in one TIFF file. Pixels outside the object are set to 0.' },
  { value: 'npy', label: 'NumPy (.npy)', help: 'All bands as an array, for Python users. Pixels outside the object are 0.' },
  { value: 'envi', label: 'ENVI (.hdr + .img)', help: 'Keeps band wavelengths. Opens in ENVI, QGIS and Python spectral tools.' },
]

const SHORTCUTS: [string, string][] = [
  ['P', 'Point tool (click = include, right-click or Shift+click = exclude)'],
  ['B', 'Box tool (drag a rectangle)'],
  ['V', 'Select tool (click an object)'],
  ['A / D', 'Brush: add to / erase from the selected object'],
  ['[  ]', 'Make the brush smaller / larger'],
  ['N', 'Start a new object'],
  ['Backspace', 'Remove the last point of the selected object'],
  ['Delete', 'Delete the selected object'],
  ['Ctrl/Cmd + Z', 'Undo brush stroke (add Shift to redo)'],
  ['Scroll wheel', 'Zoom in and out'],
  ['Space + drag', 'Move the picture (also middle-mouse or Ctrl/Cmd + drag)'],
  ['Esc', 'Deselect / close a window'],
]

export function SettingsModal() {
  const settings = useWorkspace((s) => s.settings)!
  const tab = useWorkspace((s) => s.settingsTab)
  const openSettings = useWorkspace((s) => s.openSettings)
  const closeSettings = useWorkspace((s) => s.closeSettings)
  const saveSettings = useWorkspace((s) => s.saveSettings)
  const appearance = useWorkspace((s) => s.appearance)
  const toast = useWorkspace((s) => s.toast)
  const confirm = useWorkspace((s) => s.confirm)
  const image = useEditor((s) => s.image)

  const [draft, setDraft] = useState<Settings>(settings)
  const [saving, setSaving] = useState(false)

  const changed = useMemo(() => JSON.stringify(draft) !== JSON.stringify(settings), [draft, settings])
  const displayChanged = useMemo(
    () => JSON.stringify([draft.display, draft.orientation]) !== JSON.stringify([settings.display, settings.orientation]),
    [draft, settings],
  )

  const upd = <K extends keyof Settings>(key: K, patch: Partial<Settings[K]> | Settings[K]) =>
    setDraft((d) => ({ ...d, [key]: typeof patch === 'object' && patch !== null && !Array.isArray(patch) ? { ...(d[key] as object), ...patch } : patch }))

  const save = async () => {
    setSaving(true)
    try {
      const reopen = displayChanged && image
      if (reopen && useEditor.getState().objects.length) {
        const ok = await confirm({
          title: 'Re-open this image?',
          body: 'The display settings changed, so the current image has to be reopened. Objects that are not saved will be lost.',
          okLabel: 'Save and re-open',
          danger: true,
        })
        if (!ok) return
      }
      await saveSettings({
        inputDir: draft.inputDir,
        outputDir: draft.outputDir,
        recursive: draft.recursive,
        display: draft.display,
        orientation: draft.orientation,
        export: draft.export,
      })
      toast('success', 'Settings saved.')
      if (reopen) await useEditor.getState().openSample(image.sampleKey, { force: true })
      closeSettings()
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const bandMax = image?.bands ?? 999

  return (
    <Modal
      title="Settings"
      onClose={closeSettings}
      wide
      footer={
        <>
          <span className="muted grow">{changed ? 'You have unsaved changes.' : ''}</span>
          <button type="button" className="btn" onClick={closeSettings}>
            {changed ? 'Cancel' : 'Close'}
          </button>
          <button type="button" className="btn btn-primary" disabled={!changed || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }
    >
      <div className="settings">
        <nav className="tabs" role="tablist" aria-orientation="vertical">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => openSettings(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="tab-panel" role="tabpanel">
          {tab === 'folders' && (
            <>
              <FolderField label="Input folder" hint="Images in this folder and (optionally) all sub-folders are listed." purpose="input" value={draft.inputDir} onChange={(p) => upd('inputDir', p)} />
              <FolderField label="Output folder" hint="Results are saved here, in the same folder layout as the input." purpose="output" value={draft.outputDir} onChange={(p) => upd('outputDir', p)} />
              <label className="check">
                <input type="checkbox" checked={draft.recursive} onChange={(e) => upd('recursive', e.target.checked)} />
                Include images in sub-folders
              </label>
              <p className="muted">Supported: PNG, JPG, BMP, WebP, TIFF (including multi-band), ENVI (.hdr), NumPy (.npy/.npz) and MATLAB (.mat). Specim IQ capture folders count as one image.</p>
            </>
          )}

          {tab === 'engine' && <EnginePanel />}

          {tab === 'display' && (
            <>
              <p className="muted">How spectral images are turned into the colour picture you click on. Photos are shown as they are. These settings apply when an image is opened.</p>
              <h3>Colours (spectral images)</h3>
              <label className="field">
                <span>Bands</span>
                <select value={draft.display.bandMode} onChange={(e) => upd('display', { bandMode: e.target.value as 'auto' | 'manual' })}>
                  <option value="auto">Automatic (red / green / blue wavelengths)</option>
                  <option value="manual">Choose bands myself</option>
                </select>
              </label>
              {draft.display.bandMode === 'manual' && (
                <div className="band-row">
                  {(['Red', 'Green', 'Blue'] as const).map((name, i) => (
                    <label key={name} className="field compact">
                      <span>{name} band</span>
                      <input
                        type="number"
                        min={0}
                        max={bandMax - 1}
                        value={draft.display.bands[i] ?? 0}
                        onChange={(e) => {
                          const bands = [...draft.display.bands]
                          bands[i] = Math.max(0, Math.min(bandMax - 1, Number(e.target.value) || 0))
                          upd('display', { bands })
                        }}
                      />
                    </label>
                  ))}
                  {image && <span className="muted">This image has {image.bands} bands (0–{image.bands - 1}).</span>}
                </div>
              )}
              <label className="slider-field">
                <span>
                  Contrast stretch <strong>{draft.display.stretchLow}% – {draft.display.stretchHigh}%</strong>
                </span>
                <div className="range-pair">
                  <input type="range" min={0} max={20} step={0.5} value={draft.display.stretchLow} onChange={(e) => upd('display', { stretchLow: Number(e.target.value) })} aria-label="Dark clip" />
                  <input type="range" min={80} max={100} step={0.5} value={draft.display.stretchHigh} onChange={(e) => upd('display', { stretchHigh: Number(e.target.value) })} aria-label="Bright clip" />
                </div>
              </label>
              <h3>Orientation</h3>
              <label className="field">
                <span>Rotate</span>
                <select value={draft.orientation.rotate} onChange={(e) => upd('orientation', { rotate: Number(e.target.value) as 0 | 90 | 180 | 270 })}>
                  <option value={0}>None</option>
                  <option value={90}>90° clockwise</option>
                  <option value={180}>180°</option>
                  <option value={270}>90° counter-clockwise</option>
                </select>
              </label>
              <label className="check">
                <input type="checkbox" checked={draft.orientation.autoUpright} onChange={(e) => upd('orientation', { autoUpright: e.target.checked })} />
                Turn Specim IQ captures upright automatically
              </label>
              <label className="check">
                <input type="checkbox" checked={draft.orientation.flipH} onChange={(e) => upd('orientation', { flipH: e.target.checked })} />
                Mirror left ↔ right
              </label>
              <label className="check">
                <input type="checkbox" checked={draft.orientation.flipV} onChange={(e) => upd('orientation', { flipV: e.target.checked })} />
                Mirror top ↔ bottom
              </label>
              <p className="muted">Exported files use the same orientation you see on screen.</p>
            </>
          )}

          {tab === 'export' && (
            <>
              <label className="field">
                <span>File format of each cut-out</span>
                <select value={draft.export.format} onChange={(e) => upd('export', { format: e.target.value as ExportFormat })}>
                  {FORMATS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted">{FORMATS.find((f) => f.value === draft.export.format)?.help}</p>
              <label className="check">
                <input type="checkbox" checked={draft.export.cropToBBox} onChange={(e) => upd('export', { cropToBBox: e.target.checked })} />
                Crop each cut-out to the object (otherwise keep the full image size)
              </label>
              <label className="check">
                <input type="checkbox" checked={draft.export.saveMask} onChange={(e) => upd('export', { saveMask: e.target.checked })} />
                Also save a black-and-white mask picture of each object
              </label>
              <label className="check">
                <input type="checkbox" checked={draft.export.savePreview} onChange={(e) => upd('export', { savePreview: e.target.checked })} />
                Also save a colour preview picture next to spectral files
              </label>
              <p className="muted indent">Spectral files can't be opened in a normal picture viewer, so a small preview PNG makes results easy to check. Photos don't need it.</p>
              <label className="field">
                <span>Table of objects</span>
                <select value={draft.export.metadata} onChange={(e) => upd('export', { metadata: e.target.value as MetadataFormat })}>
                  <option value="csv">CSV spreadsheet (objects.csv)</option>
                  <option value="coco">COCO JSON (for machine learning)</option>
                  <option value="none">None</option>
                </select>
              </label>
            </>
          )}

          {tab === 'appearance' && (
            <>
              <p className="muted">These only change how things look on your screen, not the exported files.</p>
              <label className="field">
                <span>Outline colour</span>
                <input type="color" value={appearance.maskColor} onChange={(e) => useWorkspace.getState().setMaskColor(e.target.value)} />
              </label>
              <label className="slider-field">
                <span>
                  Outline strength <strong>{Math.round(appearance.maskOpacity * 100)}%</strong>
                </span>
                <input type="range" min={0.05} max={1} step={0.05} value={appearance.maskOpacity} onChange={(e) => useWorkspace.getState().setMaskOpacity(Number(e.target.value))} />
              </label>
              <label className="slider-field">
                <span>
                  Picture brightness <strong>{appearance.exposure.toFixed(2)}×</strong>
                </span>
                <input type="range" min={0.5} max={3} step={0.05} value={appearance.exposure} onChange={(e) => useWorkspace.getState().setExposure(Number(e.target.value))} />
              </label>
            </>
          )}

          {tab === 'shortcuts' && (
            <table className="shortcuts">
              <tbody>
                {SHORTCUTS.map(([k, d]) => (
                  <tr key={k}>
                    <th>
                      <kbd>{k}</kbd>
                    </th>
                    <td>{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Modal>
  )
}

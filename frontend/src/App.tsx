/**
 * App shell.
 *
 * ┌─────────────────────────────────────────────────────┐
 * │ TopBar   image · progress · tools · settings · help │
 * ├───────────────────────────────────┬─────────────────┤
 * │ SegmentationCanvas                │ ObjectRail      │
 * ├───────────────────────────────────┴─────────────────┤
 * │ ActionBar   Skip · Save and stay · Save & next      │
 * └─────────────────────────────────────────────────────┘
 *
 * First run (no folders chosen, or SAM not installed) shows the setup wizard.
 * Everything else lives in `state/workspace.ts` and `state/editor.ts`.
 */
import { useEffect, useRef, useState } from 'react'
import { SegmentationCanvas } from './canvas/SegmentationCanvas'
import { ActionBar } from './components/ActionBar'
import { ConfirmHost, Toasts } from './components/Feedback'
import { HelpDrawer } from './components/HelpDrawer'
import { ImageDrawer } from './components/ImageDrawer'
import { ObjectEditor } from './components/ObjectEditor'
import { ObjectRail } from './components/ObjectRail'
import { SettingsModal } from './components/SettingsModal'
import { SetupWizard } from './components/SetupWizard'
import { TopBar } from './components/TopBar'
import { useShortcuts } from './hooks/useShortcuts'
import { useEditor } from './state/editor'
import { useWorkspace } from './state/workspace'
import './App.css'

function EmptyCanvas() {
  const samples = useWorkspace((s) => s.samples)
  const firstPending = useWorkspace((s) => s.firstPendingKey)
  const setImagesOpen = useWorkspace((s) => s.setImagesOpen)
  const openSettings = useWorkspace((s) => s.openSettings)
  const openSample = useEditor((s) => s.openSample)
  const loading = useEditor((s) => s.loading)
  if (loading) return <div className="canvas-empty">Opening image…</div>
  return (
    <div className="canvas-empty">
      {samples.length === 0 ? (
        <>
          <h2>No images found</h2>
          <p className="muted">Check the input folder in Settings.</p>
          <button type="button" className="btn btn-primary" onClick={() => openSettings('folders')}>
            Open settings
          </button>
        </>
      ) : (
        <>
          <h2>Ready when you are</h2>
          <p className="muted">{samples.length} image{samples.length === 1 ? '' : 's'} found.</p>
          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={() => void openSample(firstPending ?? samples[0].key)}>
              {firstPending ? 'Open the next image' : 'Open the first image'}
            </button>
            <button type="button" className="btn" onClick={() => setImagesOpen(true)}>
              Choose an image
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default function App() {
  const booted = useWorkspace((s) => s.booted)
  const bootError = useWorkspace((s) => s.bootError)
  const wizardOpen = useWorkspace((s) => s.wizardOpen)
  const settingsOpen = useWorkspace((s) => s.settingsOpen)
  const helpOpen = useWorkspace((s) => s.helpOpen)
  const imagesOpen = useWorkspace((s) => s.imagesOpen)
  const image = useEditor((s) => s.image)
  const [editingId, setEditingId] = useState<number | null>(null)
  const autoOpened = useRef(false)

  useShortcuts()

  useEffect(() => {
    void useWorkspace.getState().boot()
  }, [])

  // after setup is done, open the first image that still needs work
  useEffect(() => {
    if (!booted || wizardOpen || autoOpened.current) return
    autoOpened.current = true
    const { firstPendingKey, samples } = useWorkspace.getState()
    const key = firstPendingKey ?? samples[0]?.key
    if (key) void useEditor.getState().openSample(key, { force: true })
  }, [booted, wizardOpen])

  // warn before closing the tab with unsaved work
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      const s = useEditor.getState()
      if (s.dirty && s.objects.length) e.preventDefault()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  if (!booted) {
    return (
      <div className="splash">
        {bootError ? (
          <>
            <h1>Can't reach the app</h1>
            <p className="muted">{bootError}</p>
            <button type="button" className="btn btn-primary" onClick={() => void useWorkspace.getState().boot()}>
              Try again
            </button>
          </>
        ) : (
          <>
            <span className="spinner" aria-hidden />
            <p className="muted">Starting up… the first launch checks your computer and can take a few seconds.</p>
          </>
        )}
        <Toasts />
      </div>
    )
  }

  return (
    <div className="app-shell">
      <TopBar />
      <div className="workspace">
        {image ? <SegmentationCanvas /> : <EmptyCanvas />}
        <ObjectRail onEdit={setEditingId} />
      </div>
      <ActionBar />

      {imagesOpen && <ImageDrawer />}
      {helpOpen && <HelpDrawer />}
      {settingsOpen && <SettingsModal />}
      {editingId != null && <ObjectEditor objectId={editingId} onClose={() => setEditingId(null)} />}
      {wizardOpen && <SetupWizard onFinish={() => useWorkspace.getState().closeWizard()} />}
      <ConfirmHost />
      <Toasts />
    </div>
  )
}

/**
 * App shell layout.
 *
 * ┌──────────────────────────────────────────────┐
 * │ TopBar  vine/sample · main label · tools     │
 * ├────────────────────────────┬─────────────────┤
 * │ SegmentationCanvas         │ LeafRail        │
 * │ (seeds / select / brush)   │ (thumbs+labels) │
 * ├────────────────────────────┴─────────────────┤
 * │ ActionBar  Skip / Save                       │
 * └──────────────────────────────────────────────┘
 *
 * All mutable curation state lives in `state/store.ts` (Zustand).
 * On boot, `init()` loads vine catalog then the first pending sample.
 */
import { useEffect } from 'react'
import { SegmentationCanvas } from './canvas/SegmentationCanvas'
import { ActionBar } from './components/ActionBar'
import { LeafRail } from './components/LeafRail'
import { TopBar } from './components/TopBar'
import { useAppStore } from './state/store'
import './App.css'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export default function App() {
  const loading = useAppStore((s) => s.loading)

  useEffect(() => {
    void useAppStore.getState().init()
  }, [])

  // Ctrl/Cmd+A outside text fields selects the whole page and can freeze
  // interaction (especially in the fullscreen leaf editor). Keep select-all
  // only where typing happens.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      if (e.key.toLowerCase() !== 'a' && e.code !== 'KeyA') return
      if (isEditableTarget(e.target)) return
      e.preventDefault()
      window.getSelection()?.removeAllRanges()
    }
    const clearSelectionOnPointer = () => {
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) sel.removeAllRanges()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('pointerdown', clearSelectionOnPointer, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('pointerdown', clearSelectionOnPointer, true)
    }
  }, [])

  return (
    <div className="app-shell">
      <TopBar />
      <div className="workspace">
        <SegmentationCanvas />
        <LeafRail />
      </div>
      <ActionBar />
      {loading && <div className="boot-overlay">Loading sample…</div>}
    </div>
  )
}

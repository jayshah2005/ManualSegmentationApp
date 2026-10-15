import { useCallback, useEffect, useMemo, useState } from 'react'
import { SegmentationCanvas, type ViewportApi } from '../canvas/SegmentationCanvas'
import { maskBounds, visibleMask } from '../canvas/visible'
import type { Region } from '../hooks/useViewport'
import { useEditor } from '../state/editor'
import { useWorkspace } from '../state/workspace'
import { IconRedo, IconUndo } from './Icons'

const MARGIN = 48

/** Zoomed-in editor locked around one object, with everything else dimmed. */
export function ObjectEditor({ objectId, onClose }: { objectId: number; onClose: () => void }) {
  const object = useEditor((s) => s.objects.find((o) => o.id === objectId))
  const number = useEditor((s) => s.objects.findIndex((o) => o.id === objectId) + 1)
  const image = useEditor((s) => s.image)
  const brushMode = useEditor((s) => s.brushMode)
  const brushSize = useEditor((s) => s.brushSize)
  const setBrushMode = useEditor((s) => s.setBrushMode)
  const setBrushSize = useEditor((s) => s.setBrushSize)
  const setLabel = useEditor((s) => s.setLabel)
  const setShrink = useEditor((s) => s.setShrink)
  const resetMask = useEditor((s) => s.resetMask)
  const undoBrush = useEditor((s) => s.undoBrush)
  const redoBrush = useEditor((s) => s.redoBrush)
  const toast = useWorkspace((s) => s.toast)
  const [vp, setVp] = useState<ViewportApi | null>(null)

  // Lock the crop around the object when the editor opens (painting must not reframe the view).
  const region = useMemo<Region | undefined>(() => {
    const st = useEditor.getState()
    const o = st.objects.find((x) => x.id === objectId)
    if (!o || !st.image) return undefined
    const { width: w, height: h } = st.image
    const b = maskBounds(visibleMask(o, w, h, st.revs[o.id] ?? 0), w, h)
    if (!b) return { x0: 0, y0: 0, w, h }
    const x0 = Math.max(0, b.x0 - MARGIN)
    const y0 = Math.max(0, b.y0 - MARGIN)
    const x1 = Math.min(w, b.x1 + 1 + MARGIN)
    const y1 = Math.min(h, b.y1 + 1 + MARGIN)
    return { x0, y0, w: x1 - x0, h: y1 - y0 }
  }, [objectId])

  useEffect(() => {
    const prev = useEditor.getState().tool
    useEditor.getState().select(objectId)
    useEditor.getState().setTool('brush')
    return () => useEditor.getState().setTool(prev === 'brush' ? 'point' : prev)
  }, [objectId])

  const close = useCallback(async () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    try {
      await useEditor.getState().flushPending()
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e))
    }
    onClose()
  }, [onClose, toast])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        void close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [close])

  if (!object || !image) return null

  return (
    <div className="fullscreen-backdrop" role="dialog" aria-modal="true" aria-label={`Fine-tune object ${number}`}>
      <div className="fullscreen-panel">
        <header className="fullscreen-header">
          <div className="grow">
            <h2>Fine-tune object {number}</h2>
            <p className="muted">Paint with the brush to add or erase. Scroll to zoom, hold Space and drag to move. Esc closes.</p>
          </div>
          <input className="label-input" type="text" value={object.label} placeholder={`object_${String(object.id).padStart(3, '0')}`} onChange={(e) => setLabel(object.id, e.target.value)} aria-label="Object name" />
          <span className="pill">{vp?.zoomPct ?? 100}%</span>
          <button type="button" className="btn btn-small" onClick={() => vp?.zoomIn()}>
            Zoom +
          </button>
          <button type="button" className="btn btn-small" onClick={() => vp?.zoomOut()}>
            Zoom −
          </button>
          <button type="button" className="btn btn-small" onClick={() => vp?.reset()}>
            Reset view
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void close()}>
            Done
          </button>
        </header>

        <SegmentationCanvas region={region} focusId={objectId} className="fullscreen-stage" onViewport={setVp} />

        <footer className="fullscreen-controls">
          <div className="mode-toggle" role="group" aria-label="Brush mode">
            <button type="button" className={brushMode === 'add' ? 'btn active' : 'btn'} onClick={() => setBrushMode('add')} title="Add (A)">
              Add (A)
            </button>
            <button type="button" className={brushMode === 'erase' ? 'btn active' : 'btn'} onClick={() => setBrushMode('erase')} title="Erase (D)">
              Erase (D)
            </button>
          </div>
          <label className="slider-field">
            <span>
              Brush size <strong>{brushSize}</strong> px
            </span>
            <input type="range" min={2} max={60} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} />
          </label>
          <div className="btn-row">
            <button type="button" className="btn btn-small" onClick={() => undoBrush(objectId)} disabled={!object.undo.canUndo()}>
              <IconUndo /> Undo
            </button>
            <button type="button" className="btn btn-small" onClick={() => redoBrush(objectId)} disabled={!object.undo.canRedo()}>
              <IconRedo /> Redo
            </button>
            <button type="button" className="btn btn-small" onClick={() => void resetMask(objectId)}>
              Reset to automatic outline
            </button>
          </div>
          <label className="slider-field">
            <span>
              Trim edge <strong>{object.shrink}</strong> px
            </span>
            <input type="range" min={0} max={50} value={object.shrink} onChange={(e) => setShrink(objectId, Number(e.target.value))} />
          </label>
        </footer>
      </div>
    </div>
  )
}

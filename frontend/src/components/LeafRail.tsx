/**
 * Right rail: leaf thumbs, per-leaf labels, border sliders, brush size, fullscreen.
 * Tool mode (Seeds / Select / Brush) and mask color live in the TopBar.
 *
 * Labeling: Select mode → click a centroid → card focuses its Label input.
 * Borders default to 0; edit on the card slider, in Full screen, or Suggest borders.
 */
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../state/store'
import { LeafFullscreen } from './LeafFullscreen'
import { LeafThumb } from './LeafThumb'

const LABEL_DEBOUNCE_MS = 300
const BORDER_DEBOUNCE_MS = 150

export function LeafRail() {
  const session = useAppStore((s) => s.session)
  const selectedDisplayIndex = useAppStore((s) => s.selectedDisplayIndex)
  const selectLeaf = useAppStore((s) => s.selectLeaf)
  const setLeafLabel = useAppStore((s) => s.setLeafLabel)
  const setShrink = useAppStore((s) => s.setShrink)
  const resuggestBorders = useAppStore((s) => s.resuggestBorders)
  const brushSize = useAppStore((s) => s.brushSize)
  const setBrushSize = useAppStore((s) => s.setBrushSize)
  const undo = useAppStore((s) => s.undo)
  const redo = useAppStore((s) => s.redo)
  const resetActiveMask = useAppStore((s) => s.resetActiveMask)
  const toolMode = useAppStore((s) => s.toolMode)
  const setToolMode = useAppStore((s) => s.setToolMode)
  const setShowPreview = useAppStore((s) => s.setShowPreview)
  const showPreview = useAppStore((s) => s.showPreview)
  const undoStacks = useAppStore((s) => s.undoStacks)
  const busy = useAppStore((s) => s.busy)
  const setDraftLeafLabel = useAppStore((s) => s.setDraftLeafLabel)

  const [fullscreenIndex, setFullscreenIndex] = useState<number | null>(null)
  const [draftLabels, setDraftLabels] = useState<Record<number, string>>({})
  const [draftShrinks, setDraftShrinks] = useState<Record<number, number>>({})
  const labelTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({})
  const shrinkTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({})
  const labelInputRefs = useRef<Record<number, HTMLInputElement | null>>({})
  const cardRefs = useRef<Record<number, HTMLDivElement | null>>({})

  // Reset drafts only when the sample changes — not on every leaves reference churn.
  useEffect(() => {
    const nextLabels: Record<number, string> = {}
    const nextShrinks: Record<number, number> = {}
    for (const leaf of session?.leaves ?? []) {
      nextLabels[leaf.displayIndex] = leaf.label
      nextShrinks[leaf.displayIndex] = Math.max(0, leaf.shrink ?? 0)
    }
    setDraftLabels(nextLabels)
    setDraftShrinks(nextShrinks)
  }, [session?.sampleKey])

  // Keep shrink drafts in sync when Suggest borders (or server) updates shrink values.
  useEffect(() => {
    if (!session?.leaves) return
    setDraftShrinks((prev) => {
      const next = { ...prev }
      let changed = false
      for (const leaf of session.leaves) {
        const pending = shrinkTimers.current[leaf.displayIndex]
        if (pending) continue // user is mid-drag
        if (next[leaf.displayIndex] !== leaf.shrink) {
          next[leaf.displayIndex] = Math.max(0, leaf.shrink ?? 0)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [session?.leaves])

  // Drop pending label/border API calls when switching samples.
  useEffect(() => {
    for (const t of Object.values(labelTimers.current)) clearTimeout(t)
    for (const t of Object.values(shrinkTimers.current)) clearTimeout(t)
    labelTimers.current = {}
    shrinkTimers.current = {}
  }, [session?.sampleKey])

  // Close fullscreen editor when the sample changes so crop/mask state cannot leak.
  useEffect(() => {
    setFullscreenIndex(null)
  }, [session?.sampleKey])

  useEffect(() => {
    const labelTs = labelTimers.current
    const shrinkTs = shrinkTimers.current
    return () => {
      for (const t of Object.values(labelTs)) clearTimeout(t)
      for (const t of Object.values(shrinkTs)) clearTimeout(t)
    }
  }, [])

  // After picking a centroid (Select mode), scroll the card into view and focus its label.
  useEffect(() => {
    if (selectedDisplayIndex == null || fullscreenIndex != null) return
    const card = cardRefs.current[selectedDisplayIndex]
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    if (toolMode !== 'select') return
    const input = labelInputRefs.current[selectedDisplayIndex]
    if (!input || document.activeElement === input) return
    // Defer so canvas click does not immediately steal focus back.
    const t = window.setTimeout(() => {
      input.focus()
      input.select()
    }, 0)
    return () => window.clearTimeout(t)
  }, [selectedDisplayIndex, toolMode, fullscreenIndex])

  const scheduleLabel = (displayIndex: number, value: string) => {
    setDraftLabels((prev) => ({ ...prev, [displayIndex]: value }))
    setDraftLeafLabel(displayIndex, value)
    selectLeaf(displayIndex)
    const prev = labelTimers.current[displayIndex]
    if (prev) clearTimeout(prev)
    labelTimers.current[displayIndex] = setTimeout(() => {
      void setLeafLabel(displayIndex, value)
    }, LABEL_DEBOUNCE_MS)
  }

  const scheduleShrink = (displayIndex: number, value: number) => {
    const next = Math.max(0, Math.min(50, Math.round(value)))
    setDraftShrinks((prev) => ({ ...prev, [displayIndex]: next }))
    selectLeaf(displayIndex)
    // Live preview on main canvas / thumbs before the debounced API write.
    const cur = useAppStore.getState().session
    if (cur?.leaves[displayIndex]) {
      const leaves = cur.leaves.map((l) =>
        l.displayIndex === displayIndex ? { ...l, shrink: next } : l,
      )
      useAppStore.setState({ session: { ...cur, leaves } })
    }
    const prev = shrinkTimers.current[displayIndex]
    if (prev) clearTimeout(prev)
    shrinkTimers.current[displayIndex] = setTimeout(() => {
      void setShrink(displayIndex, next)
    }, BORDER_DEBOUNCE_MS)
  }

  const activeLeaf =
    session && selectedDisplayIndex != null
      ? session.leaves[selectedDisplayIndex]
      : null
  const stack = activeLeaf ? undoStacks[activeLeaf.maskIndex] : null

  return (
    <aside className="leaf-rail">
      <div className="rail-section">
        <div className="rail-title">Leaves</div>
        <p className="hint">
          Select mode: click a centroid, then set its label. Edit Border on the
          card or in Full screen (defaults to 0). Suggest borders fills heuristics.
        </p>
        <button
          type="button"
          className="btn ghost full"
          disabled={busy || !session?.leaves.length}
          onClick={() => void resuggestBorders()}
        >
          Suggest borders
        </button>
        <div className="leaf-list">
          {(session?.leaves ?? []).map((leaf) => (
            <div
              key={`${session?.sampleKey ?? 'none'}-${leaf.maskIndex}`}
              ref={(el) => {
                cardRefs.current[leaf.displayIndex] = el
              }}
              className={
                selectedDisplayIndex === leaf.displayIndex
                  ? 'leaf-card selected'
                  : 'leaf-card'
              }
            >
              <button
                type="button"
                className="leaf-card-main"
                onClick={() => {
                  selectLeaf(leaf.displayIndex)
                  setToolMode('select')
                }}
              >
                <LeafThumb
                  maskIndex={leaf.maskIndex}
                  displayIndex={leaf.displayIndex}
                  size={220}
                  shrink={draftShrinks[leaf.displayIndex] ?? leaf.shrink}
                />
              </button>
              <div className="leaf-meta">
                <label
                  className="label-field"
                  onClick={(e) => e.stopPropagation()}
                >
                  Label
                  <input
                    ref={(el) => {
                      labelInputRefs.current[leaf.displayIndex] = el
                    }}
                    type="text"
                    placeholder="Leaf label"
                    value={draftLabels[leaf.displayIndex] ?? leaf.label}
                    disabled={busy}
                    onFocus={() => selectLeaf(leaf.displayIndex)}
                    onChange={(e) =>
                      scheduleLabel(leaf.displayIndex, e.target.value)
                    }
                    onBlur={() =>
                      void setLeafLabel(
                        leaf.displayIndex,
                        draftLabels[leaf.displayIndex] ?? leaf.label,
                      )
                    }
                  />
                </label>
                <label
                  className="slider-field rail-border"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span>
                    Border <strong>{draftShrinks[leaf.displayIndex] ?? leaf.shrink}</strong>{' '}
                    px
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={50}
                    value={draftShrinks[leaf.displayIndex] ?? leaf.shrink}
                    disabled={busy}
                    onFocus={() => selectLeaf(leaf.displayIndex)}
                    onChange={(e) =>
                      scheduleShrink(leaf.displayIndex, Number(e.target.value))
                    }
                    onPointerUp={() => {
                      const v = draftShrinks[leaf.displayIndex] ?? leaf.shrink
                      void setShrink(leaf.displayIndex, v)
                    }}
                  />
                </label>
              </div>
              <button
                type="button"
                className="btn full leaf-fullscreen-btn"
                disabled={busy}
                onClick={() => {
                  selectLeaf(leaf.displayIndex)
                  setFullscreenIndex(leaf.displayIndex)
                }}
              >
                Full screen / edit
              </button>
            </div>
          ))}
          {!session?.leaves.length && (
            <p className="hint">Place seeds to generate masks.</p>
          )}
        </div>
      </div>

      <div className="rail-section brush-controls">
        <div className="rail-title">Brush size</div>
        <label className="slider-field">
          <span>
            Size <strong>{brushSize}</strong> px diameter
          </span>
          <input
            type="range"
            min={2}
            max={60}
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
          />
        </label>
        <p className="hint">
          Tool + Add/Remove are in the top bar. Circle matches the stamp; [ ] resize.
        </p>
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            disabled={!stack?.canUndo()}
            onClick={() => undo()}
          >
            Undo
          </button>
          <button
            type="button"
            className="btn"
            disabled={!stack?.canRedo()}
            onClick={() => redo()}
          >
            Redo
          </button>
        </div>
        <button
          type="button"
          className="btn full"
          disabled={!activeLeaf || busy}
          onClick={() => void resetActiveMask()}
        >
          Reset to SAM
        </button>
        <label className="check-row">
          <input
            type="checkbox"
            checked={showPreview}
            onChange={(e) => setShowPreview(e.target.checked)}
          />
          Emphasize selected leaf
        </label>
      </div>

      {fullscreenIndex != null && (
        <LeafFullscreen
          displayIndex={fullscreenIndex}
          onClose={() => setFullscreenIndex(null)}
        />
      )}
    </aside>
  )
}

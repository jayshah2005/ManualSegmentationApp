import { useCallback, useEffect, useRef, useState } from 'react'
import { brushRadius, hexToRgb, stampLine, type BrushMode } from '../canvas/brush'
import { useAppStore } from '../state/store'

export type BrushCursor = { x: number; y: number }

type UseBrushEditorOptions = {
  /** When false, skip global keybinds (e.g. main canvas while fullscreen is open). */
  bindKeys?: boolean
  /** When set, Ctrl+Z / redo target this mask (fullscreen leaf) instead of selection. */
  undoMaskIndex?: number | null
}

/**
 * Shared brush painting, cursor, and undo/size keybinds.
 *
 * Used by both SegmentationCanvas and LeafFullscreen so shortcuts stay consistent:
 * `A` add / `D` erase (delete), `[` / `]` brush size, Ctrl+Z / Ctrl+Shift+Z undo/redo,
 * live circle under the cursor.
 *
 * Cursor radius is always `brushRadius(size) * viewScale` so it matches the
 * image-space stamp (brushSize = diameter in image pixels).
 */
export function useBrushEditor(options: UseBrushEditorOptions = {}) {
  const { bindKeys = true, undoMaskIndex = null } = options

  const brushMode = useAppStore((s) => s.brushMode)
  const brushSize = useAppStore((s) => s.brushSize)
  const setBrushSize = useAppStore((s) => s.setBrushSize)
  const setBrushMode = useAppStore((s) => s.setBrushMode)
  const setToolMode = useAppStore((s) => s.setToolMode)
  const maskOverlayColor = useAppStore((s) => s.maskOverlayColor)
  const beginStroke = useAppStore((s) => s.beginStroke)
  const touchMask = useAppStore((s) => s.touchMask)
  const undo = useAppStore((s) => s.undo)
  const redo = useAppStore((s) => s.redo)

  const paintingRef = useRef(false)
  const lastImgPtRef = useRef<{ x: number; y: number } | null>(null)
  const [cursor, setCursor] = useState<BrushCursor | null>(null)
  const undoMaskIndexRef = useRef(undoMaskIndex)
  undoMaskIndexRef.current = undoMaskIndex

  const runUndo = useCallback(() => {
    const idx = undoMaskIndexRef.current
    undo(idx ?? undefined)
  }, [undo])

  const runRedo = useCallback(() => {
    const idx = undoMaskIndexRef.current
    redo(idx ?? undefined)
  }, [redo])

  useEffect(() => {
    if (!bindKeys) return
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return
      // Ignore when typing shortcuts with modifiers (except bare A/D).
      if (e.ctrlKey || e.metaKey || e.altKey) {
        if (
          (e.ctrlKey || e.metaKey) &&
          !e.altKey &&
          (e.key.toLowerCase() === 'z' || e.code === 'KeyZ')
        ) {
          e.preventDefault()
          e.stopPropagation()
          if (e.shiftKey) runRedo()
          else runUndo()
        }
        return
      }
      const key = e.key.toLowerCase()
      if (key === 'a') {
        e.preventDefault()
        setToolMode('brush')
        setBrushMode('add')
      } else if (key === 'd') {
        e.preventDefault()
        setToolMode('brush')
        setBrushMode('erase')
      } else if (e.key === '[') {
        e.preventDefault()
        setBrushSize(useAppStore.getState().brushSize - 2)
      } else if (e.key === ']') {
        e.preventDefault()
        setBrushSize(useAppStore.getState().brushSize + 2)
      }
    }
    // Capture so fullscreen / dialog handlers cannot swallow undo first.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [bindKeys, setBrushSize, setBrushMode, setToolMode, runUndo, runRedo])

  const startStroke = useCallback(
    (
      maskIndex: number,
      mask: Uint8Array,
      width: number,
      height: number,
      x: number,
      y: number,
      mode: BrushMode = brushMode,
      size: number = brushSize,
    ) => {
      beginStroke(maskIndex)
      paintingRef.current = true
      lastImgPtRef.current = { x, y }
      const keep = useAppStore.getState().brushKeeps[maskIndex] ?? null
      stampLine(mask, width, height, x, y, x, y, size, mode, keep)
      touchMask(maskIndex)
    },
    [beginStroke, touchMask, brushMode, brushSize],
  )

  const continueStroke = useCallback(
    (
      maskIndex: number,
      mask: Uint8Array,
      width: number,
      height: number,
      x: number,
      y: number,
      mode: BrushMode = brushMode,
      size: number = brushSize,
    ) => {
      if (!paintingRef.current) return
      const last = lastImgPtRef.current ?? { x, y }
      const keep = useAppStore.getState().brushKeeps[maskIndex] ?? null
      stampLine(mask, width, height, last.x, last.y, x, y, size, mode, keep)
      lastImgPtRef.current = { x, y }
      touchMask(maskIndex)
    },
    [touchMask, brushMode, brushSize],
  )

  const endStroke = useCallback(() => {
    paintingRef.current = false
    lastImgPtRef.current = null
  }, [])

  const drawBrushCursor = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      cur: BrushCursor | null,
      /** Display pixels per image pixel (fit.scale or fullscreen fit*zoom). */
      viewScale: number,
      mode: BrushMode = brushMode,
      size: number = brushSize,
    ) => {
      if (!cur || viewScale <= 0) return
      const rImg = brushRadius(size)
      const rDisp = rImg * viewScale
      const lineW = Math.min(2, Math.max(1, rDisp * 0.15))
      // Stroke sits inside the geometric circle so the outer edge = stamp edge.
      const strokeR = Math.max(0.5, rDisp - lineW * 0.5)
      const [r, g, b] = hexToRgb(maskOverlayColor)
      const stroke =
        mode === 'erase' ? 'rgba(255,70,70,0.95)' : `rgba(${r},${g},${b},0.95)`
      const fill =
        mode === 'erase' ? 'rgba(255,70,70,0.18)' : `rgba(${r},${g},${b},0.18)`
      ctx.beginPath()
      ctx.arc(cur.x, cur.y, strokeR, 0, Math.PI * 2)
      ctx.fillStyle = fill
      ctx.fill()
      ctx.strokeStyle = stroke
      ctx.lineWidth = lineW
      ctx.stroke()
    },
    [brushMode, brushSize, maskOverlayColor],
  )

  return {
    cursor,
    setCursor,
    paintingRef,
    brushMode,
    brushSize,
    setBrushSize,
    startStroke,
    continueStroke,
    endStroke,
    drawBrushCursor,
    undo: runUndo,
    redo: runRedo,
  }
}

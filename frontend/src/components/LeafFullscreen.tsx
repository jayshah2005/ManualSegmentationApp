/**
 * Near-fullscreen leaf editor: locked crop, zoom/pan, brush trim, border slider.
 *
 * Opens from a LeafRail card. Crop region is frozen at open so painting does not
 * reframe the view. Scroll zooms in toward the cursor and out toward center;
 * pan with space / Ctrl|Cmd+drag or middle-click. Brush: **A** add, **D** erase;
 * size via slider or `[` `]`.
 *
 * Display pipeline (always, including while painting):
 * SAM → border shrink on SAM only → brush strokes on top (unaffected by border).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { rgbUrl } from '../api/client'
import { hexToRgb } from '../canvas/brush'
import {
  isKeptAfterShrinkPreservingEdits,
  maskBBox,
  type MaskRegion,
} from '../canvas/maskRegion'
import { useBrushEditor } from '../hooks/useBrushEditor'
import { useAppStore } from '../state/store'

type Props = {
  displayIndex: number
  onClose: () => void
}

export function LeafFullscreen({ displayIndex, onClose }: Props) {
  const session = useAppStore((s) => s.session)
  const busy = useAppStore((s) => s.busy)
  const setShrink = useAppStore((s) => s.setShrink)
  const setLeafLabel = useAppStore((s) => s.setLeafLabel)
  const syncMasksToServer = useAppStore((s) => s.syncMasksToServer)
  const setError = useAppStore((s) => s.setError)
  const setBrushMode = useAppStore((s) => s.setBrushMode)
  const resetActiveMask = useAppStore((s) => s.resetActiveMask)
  const undoStacks = useAppStore((s) => s.undoStacks)
  const localMasks = useAppStore((s) => s.localMasks)
  const samMasks = useAppStore((s) => s.samMasks)
  const brushKeeps = useAppStore((s) => s.brushKeeps)
  const rgbCacheKey = useAppStore((s) => s.rgbCacheKey)
  const selectLeaf = useAppStore((s) => s.selectLeaf)
  const maskOverlayColor = useAppStore((s) => s.maskOverlayColor)

  const leaf = session?.leaves[displayIndex]
  const mask = leaf ? localMasks[leaf.maskIndex] : null
  const samMask = leaf ? samMasks[leaf.maskIndex] : null
  const brushKeep = leaf ? brushKeeps[leaf.maskIndex] : null
  const stack = leaf ? undoStacks[leaf.maskIndex] : null

  const {
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
    undo,
    redo,
  } = useBrushEditor({
    bindKeys: true,
    undoMaskIndex: leaf?.maskIndex ?? null,
  })

  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rgbRef = useRef<HTMLImageElement | null>(null)
  const regionRef = useRef<MaskRegion | null>(null)
  const viewRef = useRef({ zoom: 1, panX: 0, panY: 0, fit: 1 })
  const panningRef = useRef(false)
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)
  const spaceDownRef = useRef(false)
  /** Ctrl (Win/Linux) or Cmd (macOS) held — drag pans like space. */
  const modPanRef = useRef(false)

  const [shrink, setLocalShrink] = useState(leaf?.shrink ?? 0)
  const [leafLabel, setLocalLabel] = useState(leaf?.label ?? '')
  const [zoomLabel, setZoomLabel] = useState(100)
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 })
  const shrinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const labelTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setDraftLeafLabel = useAppStore((s) => s.setDraftLeafLabel)

  useEffect(() => {
    selectLeaf(displayIndex)
  }, [displayIndex, selectLeaf])

  useEffect(() => {
    setLocalShrink(leaf?.shrink ?? 0)
    setLocalLabel(leaf?.label ?? '')
  }, [leaf?.shrink, leaf?.label, displayIndex])

  useEffect(() => {
    return () => {
      if (shrinkTimer.current) clearTimeout(shrinkTimer.current)
      if (labelTimer.current) clearTimeout(labelTimer.current)
    }
  }, [])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (cr) setStageSize({ w: Math.floor(cr.width), h: Math.floor(cr.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!session) {
      rgbRef.current = null
      return
    }
    const sampleKey = session.sampleKey
    let cancelled = false
    const img = new Image()
    img.src = rgbUrl(sampleKey, rgbCacheKey)
    img.onload = () => {
      if (cancelled) return
      if (useAppStore.getState().session?.sampleKey !== sampleKey) return
      rgbRef.current = img
      redraw()
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.sampleKey, rgbCacheKey])

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !session || !mask || !leaf || stageSize.w <= 0 || stageSize.h <= 0)
      return
    if (mask.length !== session.width * session.height) return

    // Keep the crop frame fixed while editing so the view does not grow/shrink
    // as the mask bbox changes. Region is locked when the editor opens / sample changes.
    if (!regionRef.current) {
      regionRef.current = maskBBox(mask, session.width, session.height, 48)
    }
    const region = regionRef.current

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.floor(stageSize.w * dpr)
    canvas.height = Math.floor(stageSize.h * dpr)
    canvas.style.width = `${stageSize.w}px`
    canvas.style.height = `${stageSize.h}px`
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#07090c'
    ctx.fillRect(0, 0, stageSize.w, stageSize.h)

    const fit = Math.min(
      stageSize.w / region.width,
      stageSize.h / region.height,
    )
    viewRef.current.fit = fit
    const { zoom, panX, panY } = viewRef.current
    const scale = fit * zoom

    const drawW = region.width * scale
    const drawH = region.height * scale
    const ox = (stageSize.w - drawW) / 2 + panX
    const oy = (stageSize.h - drawH) / 2 + panY

    ctx.imageSmoothingEnabled = false
    const rgb = rgbRef.current
    const imgW = session.width
    const imgH = session.height
    const rShrink = Math.max(0, shrink)

    // Dim the whole crop so context stays visible but de-emphasized.
    const OUTSIDE_ALPHA = 0.22
    if (rgb) {
      ctx.globalAlpha = OUTSIDE_ALPHA
      ctx.drawImage(
        rgb,
        region.x0,
        region.y0,
        region.width,
        region.height,
        ox,
        oy,
        drawW,
        drawH,
      )
      ctx.globalAlpha = 1
    }

    // Leaf cutout: border on original SAM + brush on top (consistent while painting).
    if (rgb) {
      const cut = document.createElement('canvas')
      cut.width = region.width
      cut.height = region.height
      const cctx = cut.getContext('2d')!
      cctx.drawImage(
        rgb,
        region.x0,
        region.y0,
        region.width,
        region.height,
        0,
        0,
        region.width,
        region.height,
      )
      const pixels = cctx.getImageData(0, 0, region.width, region.height)
      const data = pixels.data
      for (let y = 0; y < region.height; y++) {
        for (let x = 0; x < region.width; x++) {
          const ix = region.x0 + x
          const iy = region.y0 + y
          const o = (y * region.width + x) * 4
          if (
            !isKeptAfterShrinkPreservingEdits(
              mask,
              samMask,
              ix,
              iy,
              imgW,
              imgH,
              rShrink,
              brushKeep,
            )
          ) {
            data[o + 3] = 0
          }
        }
      }
      cctx.putImageData(pixels, 0, 0)
      ctx.drawImage(cut, 0, 0, region.width, region.height, ox, oy, drawW, drawH)
    }

    // Thin outline of the selected mask for edge clarity.
    const [r, g, b] = hexToRgb(maskOverlayColor)
    ctx.strokeStyle = `rgba(${r},${g},${b},0.85)`
    ctx.lineWidth = 2
    ctx.strokeRect(ox + 0.5, oy + 0.5, drawW - 1, drawH - 1)

    drawBrushCursor(ctx, cursor, scale)
  }, [
    session,
    mask,
    samMask,
    brushKeep,
    leaf,
    stageSize,
    cursor,
    drawBrushCursor,
    shrink,
    maskOverlayColor,
  ])

  const bumpZoomLabel = () => {
    setZoomLabel(Math.round(viewRef.current.zoom * 100))
  }

  /** Zoom in toward (cx, cy); zoom out toward stage center / default view. */
  const zoomAt = useCallback(
    (cx: number, cy: number, factor: number) => {
      const region = regionRef.current
      if (!region || stageSize.w <= 0 || stageSize.h <= 0) return
      const v = viewRef.current
      const oldZoom = v.zoom
      const newZoom = Math.min(16, Math.max(0.5, oldZoom * factor))
      if (newZoom === oldZoom) return

      if (factor < 1) {
        // Zoom out: always settle toward centered default (not toward cursor/side).
        if (oldZoom <= 1 || newZoom <= 1) {
          v.zoom = newZoom
          v.panX = 0
          v.panY = 0
        } else {
          // Shrink pan with remaining zoom-above-fit so pan → 0 as zoom → 1.
          const t = (newZoom - 1) / (oldZoom - 1)
          v.zoom = newZoom
          v.panX *= t
          v.panY *= t
        }
      } else {
        // Zoom in: keep the image point under the cursor fixed.
        const oldScale = v.fit * oldZoom
        const newScale = v.fit * newZoom
        const ox = (stageSize.w - region.width * oldScale) / 2 + v.panX
        const oy = (stageSize.h - region.height * oldScale) / 2 + v.panY
        const lx = (cx - ox) / oldScale
        const ly = (cy - oy) / oldScale
        v.panX = cx - (stageSize.w - region.width * newScale) / 2 - lx * newScale
        v.panY = cy - (stageSize.h - region.height * newScale) / 2 - ly * newScale
        v.zoom = newZoom
      }
      bumpZoomLabel()
      redraw()
    },
    [stageSize.w, stageSize.h, redraw],
  )

  useEffect(() => {
    // Lock crop to the mask at open time; clear when switching leaves or samples
    regionRef.current = null
    viewRef.current = { zoom: 1, panX: 0, panY: 0, fit: 1 }
    setZoomLabel(100)
  }, [displayIndex, session?.sampleKey])

  useEffect(() => {
    const setOpen = useAppStore.getState().setLeafEditorOpen
    setOpen(true)
    return () => setOpen(false)
  }, [])

  useEffect(() => {
    redraw()
  }, [redraw, localMasks, samMasks, brushKeeps, shrink])

  // Native wheel: zoom in toward cursor; zoom out toward center / default view
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const factor = e.deltaY > 0 ? 0.9 : 1.1
      zoomAt(cx, cy, factor)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const syncAndClose = useCallback(async () => {
    try {
      if (shrinkTimer.current) {
        clearTimeout(shrinkTimer.current)
        shrinkTimer.current = null
        await setShrink(displayIndex, shrink)
      }
      if (labelTimer.current) {
        clearTimeout(labelTimer.current)
        labelTimer.current = null
        await setLeafLabel(displayIndex, leafLabel)
      }
      await syncMasksToServer()
    } catch (e) {
      setError(String(e))
    }
    onClose()
  }, [
    syncMasksToServer,
    setError,
    onClose,
    setShrink,
    setLeafLabel,
    displayIndex,
    shrink,
    leafLabel,
  ])

  // Fullscreen-only keys: Escape, space / Ctrl|Cmd (pan), zoom shortcuts
  // Brush size / undo handled by useBrushEditor
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'Escape') {
        e.preventDefault()
        void syncAndClose()
        return
      }
      // Block browser Select-All; it highlights the whole dialog and can
      // freeze clicks until refresh. Allow it only inside label inputs.
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        (e.key.toLowerCase() === 'a' || e.code === 'KeyA')
      ) {
        if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
          e.preventDefault()
          window.getSelection()?.removeAllRanges()
        }
        return
      }
      if (e.key === ' ') {
        spaceDownRef.current = true
        e.preventDefault()
      }
      if (e.key === 'Control' || e.key === 'Meta') {
        modPanRef.current = true
      }
      // Also catch Ctrl/Cmd held with other keys (e.g. already down before focus)
      if (e.ctrlKey || e.metaKey) {
        modPanRef.current = true
      }
      if (e.key === '=' || e.key === '+') {
        const c = cursor ?? { x: stageSize.w / 2, y: stageSize.h / 2 }
        zoomAt(c.x, c.y, 1.25)
      }
      if (e.key === '-' || e.key === '_') {
        const c = cursor ?? { x: stageSize.w / 2, y: stageSize.h / 2 }
        zoomAt(c.x, c.y, 1 / 1.25)
      }
      if (e.key === '0') {
        viewRef.current = { ...viewRef.current, zoom: 1, panX: 0, panY: 0 }
        bumpZoomLabel()
        redraw()
      }
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.key === ' ') spaceDownRef.current = false
      if (e.key === 'Control' || e.key === 'Meta') {
        // Only clear when neither modifier is still held
        modPanRef.current = e.ctrlKey || e.metaKey
      }
      if (!e.ctrlKey && !e.metaKey) {
        modPanRef.current = false
      }
    }
    const onBlur = () => {
      spaceDownRef.current = false
      modPanRef.current = false
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [syncAndClose, redraw, zoomAt, cursor, stageSize.w, stageSize.h])

  const displayToImage = (dx: number, dy: number) => {
    const region = regionRef.current
    if (!region || !session) return null
    const { zoom, panX, panY, fit } = viewRef.current
    const scale = fit * zoom
    const drawW = region.width * scale
    const drawH = region.height * scale
    const ox = (stageSize.w - drawW) / 2 + panX
    const oy = (stageSize.h - drawH) / 2 + panY
    const lx = (dx - ox) / scale
    const ly = (dy - oy) / scale
    return {
      x: region.x0 + lx,
      y: region.y0 + ly,
    }
  }

  const pointerPos = (e: React.PointerEvent) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const wantsPan = (e: React.PointerEvent) =>
    e.button === 1 ||
    e.button === 2 ||
    spaceDownRef.current ||
    modPanRef.current ||
    e.ctrlKey ||
    e.metaKey

  const onPointerDown = (e: React.PointerEvent) => {
    if (!session || !leaf || !mask) return
    // Leave label inputs so Ctrl+Z undoes brush strokes, not text.
    if (document.activeElement instanceof HTMLElement) {
      const tag = document.activeElement.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') document.activeElement.blur()
    }
    const canvas = canvasRef.current!
    canvas.setPointerCapture(e.pointerId)
    const d = pointerPos(e)
    setCursor(d)

    if (wantsPan(e)) {
      panningRef.current = true
      lastPointerRef.current = d
      return
    }

    const imgPt = displayToImage(d.x, d.y)
    if (!imgPt || !session) return
    const pt = {
      x: Math.max(0, Math.min(session.width - 1e-4, imgPt.x)),
      y: Math.max(0, Math.min(session.height - 1e-4, imgPt.y)),
    }
    startStroke(
      leaf.maskIndex,
      mask,
      session.width,
      session.height,
      pt.x,
      pt.y,
    )
    redraw()
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = pointerPos(e)
    setCursor(d)

    if (panningRef.current && lastPointerRef.current) {
      viewRef.current.panX += d.x - lastPointerRef.current.x
      viewRef.current.panY += d.y - lastPointerRef.current.y
      lastPointerRef.current = d
      redraw()
      return
    }

    if (!paintingRef.current || !session || !leaf || !mask) {
      if (!paintingRef.current) redraw()
      return
    }
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const native = e.nativeEvent as PointerEvent
    const coalesced =
      typeof native.getCoalescedEvents === 'function'
        ? native.getCoalescedEvents()
        : []
    const events = coalesced.length > 0 ? coalesced : [native]
    for (const ev of events) {
      const dx = ev.clientX - rect.left
      const dy = ev.clientY - rect.top
      const imgPt = displayToImage(dx, dy)
      if (!imgPt) continue
      const pt = {
        x: Math.max(0, Math.min(session.width - 1e-4, imgPt.x)),
        y: Math.max(0, Math.min(session.height - 1e-4, imgPt.y)),
      }
      continueStroke(
        leaf.maskIndex,
        mask,
        session.width,
        session.height,
        pt.x,
        pt.y,
      )
    }
    redraw()
  }

  const onPointerUp = (e: React.PointerEvent) => {
    endStroke()
    panningRef.current = false
    lastPointerRef.current = null
    // Re-apply border preview now that painting has ended.
    redraw()
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const applyShrink = (value: number) => {
    const next = Math.max(0, Math.min(50, Math.round(value)))
    setLocalShrink(next)
    // Optimistic session patch so main canvas + rail update immediately.
    const cur = useAppStore.getState().session
    if (cur?.leaves[displayIndex]) {
      const leaves = cur.leaves.map((l) =>
        l.displayIndex === displayIndex ? { ...l, shrink: next } : l,
      )
      useAppStore.setState({ session: { ...cur, leaves } })
    }
    if (shrinkTimer.current) clearTimeout(shrinkTimer.current)
    shrinkTimer.current = setTimeout(() => {
      void setShrink(displayIndex, next)
    }, 150)
  }

  const applyLabel = (value: string) => {
    setLocalLabel(value)
    setDraftLeafLabel(displayIndex, value)
    if (labelTimer.current) clearTimeout(labelTimer.current)
    labelTimer.current = setTimeout(() => {
      void setLeafLabel(displayIndex, value)
    }, 300)
  }

  if (!leaf || !session) return null

  return (
    <div className="fullscreen-backdrop" role="dialog" aria-modal="true">
      <div className="fullscreen-panel">
        <header className="fullscreen-header">
          <div>
            <h2>{leaf.label || 'Unlabeled leaf'}</h2>
            <p className="hint">
              Selected leaf is full brightness; surroundings are dim. Zoom in:
              scroll toward cursor · Zoom out: toward center · Pan: Ctrl/Cmd+drag,
              space+drag, or middle-click · Brush: drag · Border on SAM only · Esc
              closes
            </p>
            <label className="label-field fullscreen-label">
              Leaf label
              <input
                type="text"
                value={leafLabel}
                placeholder="Leaf label"
                disabled={busy}
                onChange={(e) => applyLabel(e.target.value)}
              />
            </label>
          </div>
          <div className="fullscreen-header-actions">
            <span className="zoom-pill">{zoomLabel}%</span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const c = cursor ?? { x: stageSize.w / 2, y: stageSize.h / 2 }
                zoomAt(c.x, c.y, 1.25)
              }}
            >
              Zoom +
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const c = cursor ?? { x: stageSize.w / 2, y: stageSize.h / 2 }
                zoomAt(c.x, c.y, 1 / 1.25)
              }}
            >
              Zoom −
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                viewRef.current = { ...viewRef.current, zoom: 1, panX: 0, panY: 0 }
                bumpZoomLabel()
                redraw()
              }}
            >
              Reset view
            </button>
            <button type="button" className="btn" onClick={() => void syncAndClose()}>
              Close
            </button>
          </div>
        </header>

        <div ref={stageRef} className="fullscreen-stage">
          <canvas
            ref={canvasRef}
            className="fullscreen-canvas"
            style={{ cursor: 'none' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              if (!paintingRef.current) setCursor(null)
            }}
            onContextMenu={(e) => e.preventDefault()}
          />
        </div>

        <footer className="fullscreen-controls">
          <div className="mode-toggle">
            <button
              type="button"
              className={brushMode === 'add' ? 'btn mode active' : 'btn mode'}
              onClick={() => setBrushMode('add')}
              title="Add brush (A)"
            >
              Add (A)
            </button>
            <button
              type="button"
              className={brushMode === 'erase' ? 'btn mode active' : 'btn mode'}
              onClick={() => setBrushMode('erase')}
              title="Erase / delete brush (D)"
            >
              Erase (D)
            </button>
          </div>
          <label className="slider-field brush-inline">
            <span>
              Brush <strong>{brushSize}</strong> px diameter
            </span>
            <input
              type="range"
              min={2}
              max={60}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
            />
          </label>
          <div className="btn-row compact-row">
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
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void resetActiveMask()}
            >
              Reset SAM
            </button>
          </div>
          <label className="slider-field fullscreen-border">
            <span>
              Border remove <strong>{shrink}</strong> px
            </span>
            <input
              type="range"
              min={0}
              max={50}
              value={shrink}
              disabled={busy}
              onChange={(e) => applyShrink(Number(e.target.value))}
              onPointerUp={() => {
                if (shrinkTimer.current) {
                  clearTimeout(shrinkTimer.current)
                  shrinkTimer.current = null
                }
                void setShrink(displayIndex, shrink)
              }}
            />
          </label>
        </footer>
      </div>
    </div>
  )
}

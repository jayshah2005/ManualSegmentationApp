/**
 * Main image canvas: RGB + mask overlays + seed markers + centroids.
 *
 * Tool modes (from TopBar / store.toolMode):
 * - seeds  — click empty → add seed; click green dot → remove; SAM re-runs
 * - select — click near a centroid (or inside a mask) to pick that leaf
 * - brush  — paint the selected leaf; hover shows live brush circle
 *
 * Coordinates: pointer CSS px → `displayToImage` → integer image pixels.
 * Masks are full-resolution `Uint8Array` (0/255) from the store.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { rgbUrl } from '../api/client'
import { hexToRgb } from './brush'
import {
  clampImagePoint,
  clampImagePointFloat,
  displayToImage,
  fitImage,
  imageToDisplay,
  type FitRect,
} from './coords'
import { isKeptAfterShrinkPreservingEdits } from './maskRegion'
import { useBrushEditor } from '../hooks/useBrushEditor'
import { useAppStore } from '../state/store'

const SEED_HIT = 22

type Props = {
  className?: string
}

export function SegmentationCanvas({ className }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rgbRef = useRef<HTMLImageElement | null>(null)
  const fitRef = useRef<FitRect>({
    offsetX: 0,
    offsetY: 0,
    drawW: 0,
    drawH: 0,
    scale: 1,
  })
  const [size, setSize] = useState({ w: 0, h: 0 })

  const session = useAppStore((s) => s.session)
  const rgbCacheKey = useAppStore((s) => s.rgbCacheKey)
  const toolMode = useAppStore((s) => s.toolMode)
  const selectedDisplayIndex = useAppStore((s) => s.selectedDisplayIndex)
  const localMasks = useAppStore((s) => s.localMasks)
  const samMasks = useAppStore((s) => s.samMasks)
  const brushKeeps = useAppStore((s) => s.brushKeeps)
  const maskRevisions = useAppStore((s) => s.maskRevisions)
  const showPreview = useAppStore((s) => s.showPreview)
  const maskOverlayColor = useAppStore((s) => s.maskOverlayColor)
  const maskOverlayOpacity = useAppStore((s) => s.maskOverlayOpacity)
  const busy = useAppStore((s) => s.busy)
  const loading = useAppStore((s) => s.loading)
  const setSeeds = useAppStore((s) => s.setSeeds)
  const selectLeaf = useAppStore((s) => s.selectLeaf)
  const leafEditorOpen = useAppStore((s) => s.leafEditorOpen)
  const blocked = busy || loading

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
  } = useBrushEditor({ bindKeys: !leafEditorOpen })

  // Keep latest cursor in a ref so mask overlays are not rebuilt on every mousemove.
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor

  // Resize observer
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (cr) setSize({ w: Math.floor(cr.width), h: Math.floor(cr.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || size.w <= 0 || size.h <= 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.floor(size.w * dpr)
    canvas.height = Math.floor(size.h * dpr)
    canvas.style.width = `${size.w}px`
    canvas.style.height = `${size.h}px`

    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)
    ctx.fillStyle = '#1a1d21'
    ctx.fillRect(0, 0, size.w, size.h)

    const sessionNow = useAppStore.getState().session
    if (!sessionNow) return

    const fit = fitImage(sessionNow.width, sessionNow.height, size.w, size.h)
    fitRef.current = fit

    const rgb = rgbRef.current
    if (rgb) {
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(rgb, fit.offsetX, fit.offsetY, fit.drawW, fit.drawH)
    }

    const state = useAppStore.getState()
    // Never paint masks from a different generation than the current RGB/session.
    if (state.session?.sampleKey !== sessionNow.sampleKey) return
    const masks = state.localMasks
    const samMasks = state.samMasks
    const brushKeeps = state.brushKeeps
    const leaves = sessionNow.leaves
    const sel = state.selectedDisplayIndex
    const preview = state.showPreview
    const [r, g, b] = hexToRgb(state.maskOverlayColor)
    const baseOpacity = state.maskOverlayOpacity
    const imgW = sessionNow.width
    const imgH = sessionNow.height

    // Composite at display resolution so we do not allocate full-HSI ImageData per leaf.
    const ow = Math.max(1, Math.round(fit.drawW))
    const oh = Math.max(1, Math.round(fit.drawH))
    const overlay = document.createElement('canvas')
    overlay.width = ow
    overlay.height = oh
    const octx = overlay.getContext('2d')!
    const imgData = octx.createImageData(ow, oh)
    const d = imgData.data

    for (const leaf of leaves) {
      const mask = masks[leaf.maskIndex]
      if (!mask) continue
      // Guard against wrong-sized buffers left over from a prior sample.
      if (mask.length !== imgW * imgH) continue
      const sam = samMasks[leaf.maskIndex]
      const keep = brushKeeps[leaf.maskIndex]
      const isSel = sel === leaf.displayIndex
      const alpha = preview
        ? isSel
          ? Math.min(1, baseOpacity * 1.35)
          : baseOpacity * 0.35
        : isSel
          ? Math.min(1, baseOpacity * 1.15)
          : baseOpacity
      const a = Math.round(255 * alpha)
      const rShrink = Math.max(0, leaf.shrink)
      for (let py = 0; py < oh; py++) {
        const iy = Math.min(imgH - 1, Math.floor((py / oh) * imgH))
        const row = iy * imgW
        for (let px = 0; px < ow; px++) {
          const ix = Math.min(imgW - 1, Math.floor((px / ow) * imgW))
          if (mask[row + ix] === 0) continue
          // Pixels the border would remove: leave transparent so RGB shows through
          // (no dark fringe outline — erased/edge areas blend with the environment).
          if (
            !isKeptAfterShrinkPreservingEdits(
              mask,
              sam,
              ix,
              iy,
              imgW,
              imgH,
              rShrink,
              keep,
            )
          ) {
            continue
          }
          const o = (py * ow + px) * 4
          d[o] = r
          d[o + 1] = g
          d[o + 2] = b
          d[o + 3] = a
        }
      }
    }
    octx.putImageData(imgData, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(overlay, fit.offsetX, fit.offsetY, fit.drawW, fit.drawH)

    for (const leaf of leaves) {
      const isSel = sel === leaf.displayIndex
      const c = imageToDisplay(leaf.centroid.x, leaf.centroid.y, fit)
      ctx.beginPath()
      ctx.arc(c.x, c.y, isSel ? 7 : 5, 0, Math.PI * 2)
      ctx.fillStyle = '#fff'
      ctx.fill()
      ctx.strokeStyle = `rgb(${r},${g},${b})`
      ctx.lineWidth = 2
      ctx.stroke()
      if (leaf.label) {
        ctx.font = '600 13px "IBM Plex Sans", system-ui, sans-serif'
        ctx.fillStyle = '#fff'
        ctx.strokeStyle = 'rgba(0,0,0,0.55)'
        ctx.lineWidth = 3
        ctx.strokeText(leaf.label, c.x + 10, c.y + 4)
        ctx.fillText(leaf.label, c.x + 10, c.y + 4)
      }
    }

    // Seeds
    for (const seed of sessionNow.seeds) {
      const p = imageToDisplay(seed.x, seed.y, fit)
      ctx.beginPath()
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(0, 220, 90, 0.9)'
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
    }

    // Brush cursor circle (read from ref — do not depend on cursor state here)
    if (state.toolMode === 'brush') {
      drawBrushCursor(
        ctx,
        cursorRef.current,
        fit.scale,
        state.brushMode,
        state.brushSize,
      )
    }
  }, [size, drawBrushCursor])

  // Load RGB image when session changes; cancel stale onloads so old JPEGs cannot paint.
  useEffect(() => {
    if (!session) {
      rgbRef.current = null
      redraw()
      return
    }
    const sampleKey = session.sampleKey
    let cancelled = false
    const img = new Image()
    img.decoding = 'async'
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
  }, [session, rgbCacheKey, redraw])

  // Redraw when masks / selection / mode change (not on every cursor move)
  useEffect(() => {
    redraw()
  }, [
    redraw,
    localMasks,
    samMasks,
    brushKeeps,
    maskRevisions,
    selectedDisplayIndex,
    toolMode,
    brushMode,
    brushSize,
    showPreview,
    maskOverlayColor,
    maskOverlayOpacity,
    session,
    busy,
    loading,
  ])

  const pointerToDisplay = (e: React.PointerEvent) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!session || blocked) return
    const canvas = canvasRef.current!
    canvas.setPointerCapture(e.pointerId)
    const d = pointerToDisplay(e)
    setCursor(d)
    const fit = fitRef.current
    const imgPt = displayToImage(d.x, d.y, fit)
    if (!imgPt) return
    if (
      imgPt.x < 0 ||
      imgPt.y < 0 ||
      imgPt.x >= session.width ||
      imgPt.y >= session.height
    )
      return
    const clamped = clampImagePoint(imgPt.x, imgPt.y, session.width, session.height)

    if (toolMode === 'seeds') {
      const seeds = [...session.seeds]
      const hit = seeds.findIndex(
        (s) => Math.hypot(s.x - clamped.x, s.y - clamped.y) <= SEED_HIT,
      )
      if (hit >= 0) seeds.splice(hit, 1)
      else seeds.push(clamped)
      void setSeeds(seeds)
      return
    }

    if (toolMode === 'select') {
      // Prefer a nearby centroid; fall back to mask hit under the click.
      let best: number | null = null
      let bestD = Infinity
      for (const leaf of session.leaves) {
        const dist = Math.hypot(
          leaf.centroid.x - clamped.x,
          leaf.centroid.y - clamped.y,
        )
        if (dist < bestD) {
          bestD = dist
          best = leaf.displayIndex
        }
      }
      // Generous hit radius so clicking the painted centroid / label works.
      if (best != null && bestD < 120) {
        selectLeaf(best)
        return
      }
      for (const leaf of session.leaves) {
        const mask = localMasks[leaf.maskIndex]
        if (
          mask &&
          mask[clamped.y * session.width + clamped.x] === 255
        ) {
          selectLeaf(leaf.displayIndex)
          return
        }
      }
      return
    }

    if (toolMode === 'brush') {
      const sel = selectedDisplayIndex
      if (sel == null) return
      const leaf = session.leaves[sel]
      if (!leaf) return
      const mask = localMasks[leaf.maskIndex]
      if (!mask) return
      const pt = clampImagePointFloat(
        imgPt.x,
        imgPt.y,
        session.width,
        session.height,
      )
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
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (blocked) return
    const d = pointerToDisplay(e)
    cursorRef.current = d
    setCursor(d)
    // Brush cursor: cheap full redraw at display-res is OK; skip when not brushing.
    if (toolMode === 'brush' && !paintingRef.current) {
      redraw()
    }
    if (!paintingRef.current || !session || toolMode !== 'brush') return
    const sel = selectedDisplayIndex
    if (sel == null) return
    const leaf = session.leaves[sel]
    const mask = localMasks[leaf.maskIndex]
    if (!mask) return
    const fit = fitRef.current
    const paintPoints: { x: number; y: number }[] = []
    const native = e.nativeEvent as PointerEvent
    const coalesced =
      typeof native.getCoalescedEvents === 'function'
        ? native.getCoalescedEvents()
        : []
    const events = coalesced.length > 0 ? coalesced : [native]
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    for (const ev of events) {
      const dx = ev.clientX - rect.left
      const dy = ev.clientY - rect.top
      const imgPt = displayToImage(dx, dy, fit)
      if (!imgPt) continue
      paintPoints.push(
        clampImagePointFloat(imgPt.x, imgPt.y, session.width, session.height),
      )
    }
    for (const pt of paintPoints) {
      continueStroke(
        leaf.maskIndex,
        mask,
        session.width,
        session.height,
        pt.x,
        pt.y,
      )
    }
    if (paintPoints.length) redraw()
  }

  const onPointerUp = (e: React.PointerEvent) => {
    endStroke()
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const onPointerLeave = () => {
    if (!paintingRef.current) setCursor(null)
  }

  const onWheel = (e: React.WheelEvent) => {
    if (leafEditorOpen) return
    if (toolMode !== 'brush') return
    e.preventDefault()
    const delta = e.deltaY > 0 ? -2 : 2
    setBrushSize(brushSize + delta)
  }

  const cursorStyle =
    toolMode === 'brush' ? 'none' : toolMode === 'seeds' ? 'crosshair' : 'pointer'

  return (
    <div ref={wrapRef} className={className ?? 'canvas-wrap'}>
      <canvas
        ref={canvasRef}
        style={{ cursor: cursorStyle, touchAction: 'none', width: '100%', height: '100%' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onWheel={onWheel}
      />
      {!session && !blocked && (
        <div className="canvas-empty">Load a sample to begin</div>
      )}
      {blocked && (
        <div className="canvas-busy">
          {loading ? 'Loading sample…' : 'Working…'}
        </div>
      )}
    </div>
  )
}

/**
 * The image canvas: picture + object overlays + prompts + tools.
 *
 * Used twice: as the main view (whole image) and inside the focused object
 * editor (`region` locked around one object, everything else dimmed).
 *
 * Tools (from the editor store):
 * - point  — click = include, right-click / Shift+click = exclude. Refines the
 *            active object, or creates a new one when none is active.
 * - box    — drag a rectangle (same active/new rule)
 * - select — click an object to make it active
 * - brush  — paint the active object (A = add, D = erase)
 *
 * Zoom: mouse wheel. Pan: Space+drag, middle-drag, Ctrl/Cmd+drag.
 * Heavy per-object bitmaps are cached and only rebuilt for the object that changed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { rgbUrl } from '../api/client'
import { useViewport, computeTransform, type Region } from '../hooks/useViewport'
import { useEditor, type EditObject } from '../state/editor'
import { useWorkspace } from '../state/workspace'
import { brushRadius, stampLine } from './brush'
import { cutoutFor, overlayFor, overlayBounds, resetCanvasCaches } from './bitmaps'
import { objectColor } from './colors'
import { visibleMask } from './visible'

const POINT_HIT_PX = 10
const MIN_BOX_PX = 5

type Props = {
  /** Lock the view to this region of the image (focused editor). */
  region?: Region
  /** Dim everything except this object (focused editor). */
  focusId?: number | null
  className?: string
  /** Called with the viewport controls so a parent can render zoom buttons. */
  onViewport?: (api: ViewportApi) => void
}

export type ViewportApi = { zoomPct: number; zoomIn: () => void; zoomOut: () => void; reset: () => void }

export function SegmentationCanvas({ region: regionProp, focusId = null, className, onViewport }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const cursorRef = useRef<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const panRef = useRef<{ x: number; y: number } | null>(null)
  const paintingRef = useRef(false)
  const lastPtRef = useRef<{ x: number; y: number } | null>(null)
  const spaceRef = useRef(false)
  const rafRef = useRef(0)
  const [size, setSize] = useState({ w: 0, h: 0 })

  const image = useEditor((s) => s.image)
  const objects = useEditor((s) => s.objects)
  const revs = useEditor((s) => s.revs)
  const activeId = useEditor((s) => s.activeId)
  const tool = useEditor((s) => s.tool)
  const brushMode = useEditor((s) => s.brushMode)
  const brushSize = useEditor((s) => s.brushSize)
  const emphasize = useEditor((s) => s.emphasize)
  const rgbKey = useEditor((s) => s.rgbKey)
  const busy = useEditor((s) => s.busy)
  const loading = useEditor((s) => s.loading)
  const appearance = useWorkspace((s) => s.appearance)

  const imgW = image?.width ?? 0
  const imgH = image?.height ?? 0
  const region = useMemo<Region>(
    () => regionProp ?? { x0: 0, y0: 0, w: Math.max(1, imgW), h: Math.max(1, imgH) },
    [regionProp, imgW, imgH],
  )

  // ---- drawing ----

  const drawRef = useRef<() => void>(() => undefined)
  const schedule = useCallback(() => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(() => drawRef.current())
  }, [])
  const { viewRef, zoomPct, reset, panBy, zoomAt } = useViewport(schedule)

  const draw = useCallback(() => {
    rafRef.current = 0
    const canvas = canvasRef.current
    if (!canvas || size.w <= 0 || size.h <= 0) return
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.floor(size.w * dpr) || canvas.height !== Math.floor(size.h * dpr)) {
      canvas.width = Math.floor(size.w * dpr)
      canvas.height = Math.floor(size.h * dpr)
      canvas.style.width = `${size.w}px`
      canvas.style.height = `${size.h}px`
    }
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = focusId != null ? '#07090c' : '#14171c'
    ctx.fillRect(0, 0, size.w, size.h)

    const ed = useEditor.getState()
    const img = imgRef.current
    if (!ed.image || !img) return
    const ap = useWorkspace.getState().appearance
    const t = computeTransform(region, size.w, size.h, viewRef.current)
    const dw = region.w * t.scale
    const dh = region.h * t.scale
    const exposure = ap.exposure !== 1 ? `brightness(${ap.exposure})` : 'none'

    // picture (dimmed when a single object is focused)
    ctx.imageSmoothingEnabled = t.scale < 1
    ctx.filter = exposure
    ctx.globalAlpha = focusId != null ? 0.22 : 1
    ctx.drawImage(img, region.x0, region.y0, region.w, region.h, t.ox, t.oy, dw, dh)
    ctx.globalAlpha = 1
    ctx.filter = 'none'
    ctx.imageSmoothingEnabled = false

    const list = ed.objects
    if (focusId != null) {
      const o = list.find((x) => x.id === focusId)
      if (o) {
        const cut = cutoutFor(o, ed.revs[o.id] ?? 0, ed.image.width, ed.image.height, img, ed.rgbKey)
        if (cut) {
          ctx.filter = exposure
          ctx.drawImage(cut.canvas, 0, 0, cut.canvas.width, cut.canvas.height, t.ox + (cut.x0 - region.x0) * t.scale, t.oy + (cut.y0 - region.y0) * t.scale, cut.canvas.width * t.scale, cut.canvas.height * t.scale)
          ctx.filter = 'none'
        }
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth = 1
      ctx.strokeRect(t.ox + 0.5, t.oy + 0.5, dw - 1, dh - 1)
    } else {
      list.forEach((o, i) => {
        const ov = overlayFor(o, i, ed.revs[o.id] ?? 0, ed.image!.width, ed.image!.height, ap.maskColor)
        if (!ov) return
        const isActive = o.id === ed.activeId
        const alpha = ed.emphasize
          ? isActive ? Math.min(1, ap.maskOpacity * 1.35) : ap.maskOpacity * 0.3
          : isActive ? Math.min(1, ap.maskOpacity * 1.2) : ap.maskOpacity
        ctx.globalAlpha = alpha
        ctx.drawImage(ov.canvas, 0, 0, ov.canvas.width, ov.canvas.height, t.ox + (ov.x0 - region.x0) * t.scale, t.oy + (ov.y0 - region.y0) * t.scale, ov.canvas.width * t.scale, ov.canvas.height * t.scale)
      })
      ctx.globalAlpha = 1
      list.forEach((o, i) => drawBadge(ctx, o, i, ed.activeId === o.id, region, t, ap.maskColor))
    }

    // prompts of the active object
    const active = list.find((o) => o.id === ed.activeId)
    if (active && ed.tool !== 'brush') {
      if (active.box) drawBox(ctx, active.box, region, t, '#ffffff', false)
      for (const p of active.points) drawPoint(ctx, (p.x + 0.5 - region.x0) * t.scale + t.ox, (p.y + 0.5 - region.y0) * t.scale + t.oy, p.label === 1)
    }
    const drag = dragRef.current
    if (drag) drawBox(ctx, { x0: drag.x0, y0: drag.y0, x1: drag.x1, y1: drag.y1 }, region, t, '#4eb8d9', true)

    // brush cursor
    const cur = cursorRef.current
    if (ed.tool === 'brush' && cur) {
      const r = brushRadius(ed.brushSize) * t.scale
      const erase = ed.brushMode === 'erase'
      ctx.beginPath()
      ctx.arc(cur.x, cur.y, Math.max(1, r), 0, Math.PI * 2)
      ctx.fillStyle = erase ? 'rgba(255,70,70,0.18)' : 'rgba(78,184,217,0.18)'
      ctx.fill()
      ctx.strokeStyle = erase ? 'rgba(255,70,70,0.95)' : 'rgba(78,184,217,0.95)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }, [size, region, focusId, viewRef])

  useEffect(() => {
    drawRef.current = draw
  })

  useEffect(() => {
    onViewport?.({
      zoomPct,
      zoomIn: () => zoomAt(size.w / 2, size.h / 2, 1.25, region, size.w, size.h),
      zoomOut: () => zoomAt(size.w / 2, size.h / 2, 1 / 1.25, region, size.w, size.h),
      reset,
    })
  }, [onViewport, zoomPct, zoomAt, reset, size, region])

  // reset the view when the image or the focused region changes
  useEffect(() => {
    resetCanvasCaches()
    reset()
  }, [image?.sampleKey, regionProp, reset])

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

  // load the display picture
  useEffect(() => {
    if (!image) {
      imgRef.current = null
      schedule()
      return
    }
    const key = image.sampleKey
    let cancelled = false
    const el = new Image()
    el.decoding = 'async'
    el.src = rgbUrl(key, rgbKey)
    el.onload = () => {
      if (cancelled || useEditor.getState().image?.sampleKey !== key) return
      imgRef.current = el
      resetCanvasCaches()
      schedule()
    }
    return () => {
      cancelled = true
    }
  }, [image?.sampleKey, rgbKey, schedule]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    schedule()
  }, [schedule, size, objects, revs, activeId, tool, brushMode, brushSize, emphasize, appearance, busy, loading, focusId, region])

  // wheel zoom (needs a non-passive listener to stop page scroll)
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY > 0 ? 0.9 : 1.1, region, size.w, size.h)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt, region, size])

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === ' ' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        spaceRef.current = true
        e.preventDefault()
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') spaceRef.current = false
    }
    const blur = () => (spaceRef.current = false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // ---- pointer handling ----

  const posOf = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }
  const toImage = (d: { x: number; y: number }) => {
    const t = computeTransform(region, size.w, size.h, viewRef.current)
    return { x: region.x0 + (d.x - t.ox) / t.scale, y: region.y0 + (d.y - t.oy) / t.scale, scale: t.scale }
  }
  const inside = (p: { x: number; y: number }) => p.x >= 0 && p.y >= 0 && p.x < imgW && p.y < imgH

  /** Is (x, y) on or close to the object (its box grown by 25%, at least 16 px)? */
  const nearObject = (o: EditObject, x: number, y: number) => {
    const b = overlayBounds(o.id)
    if (!b) return true
    const pad = Math.max(16, 0.25 * Math.max(b.x1 - b.x0, b.y1 - b.y0))
    const near = x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad
    return near || o.points.some((q) => Math.hypot(q.x - x, q.y - y) < pad)
  }

  const objectAt = (x: number, y: number): EditObject | null => {
    const ed = useEditor.getState()
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    if (!ed.image || ix < 0 || iy < 0 || ix >= imgW || iy >= imgH) return null
    for (let i = ed.objects.length - 1; i >= 0; i--) {
      const o = ed.objects[i]
      if (visibleMask(o, imgW, imgH, ed.revs[o.id] ?? 0)[iy * imgW + ix] !== 0) return o
    }
    return null
  }

  const startStroke = (o: EditObject, x: number, y: number) => {
    const ed = useEditor.getState()
    ed.beginStroke(o.id)
    paintingRef.current = true
    lastPtRef.current = { x, y }
    stampLine(o.mask, imgW, imgH, x, y, x, y, ed.brushSize, ed.brushMode, o.keep)
    ed.touchMask(o.id)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!image || loading) return
    const canvas = canvasRef.current!
    canvas.setPointerCapture(e.pointerId)
    const d = posOf(e)
    cursorRef.current = d
    const ed = useEditor.getState()

    const wantsPan = e.button === 1 || spaceRef.current || e.ctrlKey || e.metaKey || (e.button === 2 && (ed.tool === 'brush' || ed.tool === 'select'))
    if (wantsPan) {
      panRef.current = d
      return
    }
    const p = toImage(d)
    const activeObj = ed.objects.find((o) => o.id === ed.activeId) ?? null

    if (focusId != null && ed.tool !== 'brush') return

    if (ed.tool === 'point') {
      if (busy || !inside(p)) return
      if (activeObj) {
        const hit = activeObj.points.findIndex((q) => Math.hypot((q.x + 0.5 - p.x) * p.scale, (q.y + 0.5 - p.y) * p.scale) <= POINT_HIT_PX)
        if (hit >= 0) {
          void ed.removePoint(hit)
          return
        }
      }
      const other = objectAt(p.x, p.y)
      if (other && other.id !== ed.activeId) {
        ed.select(other.id)
        return
      }
      const exclude = e.button === 2 || e.shiftKey
      // An include click well away from the active object means "next object": people
      // forget to press N, and refining would silently change the wrong object.
      if (!exclude && activeObj && !nearObject(activeObj, p.x, p.y)) {
        ed.newObject()
        useWorkspace.getState().toast('info', 'Started a new object. Click inside an object to add to it instead.')
      }
      void ed.placePrompt({ point: { x: Math.floor(p.x), y: Math.floor(p.y), label: exclude ? 0 : 1 } })
      return
    }

    if (ed.tool === 'box') {
      if (busy || !inside(p)) return
      dragRef.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }
      return
    }

    if (ed.tool === 'select') {
      const hit = objectAt(p.x, p.y)
      if (hit) ed.select(hit.id)
      else {
        let best: EditObject | null = null
        let bestD = 36 / p.scale
        for (const o of ed.objects) {
          if (!o.centroid) continue
          const dist = Math.hypot(o.centroid.x - p.x, o.centroid.y - p.y)
          if (dist < bestD) {
            bestD = dist
            best = o
          }
        }
        ed.select(best ? best.id : null)
      }
      return
    }

    if (ed.tool === 'brush') {
      let target = activeObj
      if (!target) {
        target = objectAt(p.x, p.y)
        if (!target) {
          useWorkspace.getState().toast('info', 'Pick an object first (Select tool), then paint on it.')
          return
        }
        ed.select(target.id)
      }
      const x = Math.max(0, Math.min(imgW - 1e-4, p.x))
      const y = Math.max(0, Math.min(imgH - 1e-4, p.y))
      startStroke(target, x, y)
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = posOf(e)
    cursorRef.current = d
    if (panRef.current) {
      panBy(d.x - panRef.current.x, d.y - panRef.current.y)
      panRef.current = d
      return
    }
    const ed = useEditor.getState()
    if (dragRef.current) {
      const p = toImage(d)
      dragRef.current = { ...dragRef.current, x1: Math.max(0, Math.min(imgW - 1, p.x)), y1: Math.max(0, Math.min(imgH - 1, p.y)) }
      schedule()
      return
    }
    if (paintingRef.current && ed.tool === 'brush') {
      const o = ed.objects.find((x) => x.id === ed.activeId)
      if (!o) return
      const native = e.nativeEvent
      const events = typeof native.getCoalescedEvents === 'function' && native.getCoalescedEvents().length ? native.getCoalescedEvents() : [native]
      for (const ev of events) {
        const p = toImage(posOf(ev))
        const x = Math.max(0, Math.min(imgW - 1e-4, p.x))
        const y = Math.max(0, Math.min(imgH - 1e-4, p.y))
        const last = lastPtRef.current ?? { x, y }
        stampLine(o.mask, imgW, imgH, last.x, last.y, x, y, ed.brushSize, ed.brushMode, o.keep)
        lastPtRef.current = { x, y }
      }
      ed.touchMask(o.id)
      return
    }
    if (ed.tool === 'brush') schedule()
  }

  const onPointerUp = (e: React.PointerEvent) => {
    panRef.current = null
    paintingRef.current = false
    lastPtRef.current = null
    const drag = dragRef.current
    dragRef.current = null
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    if (drag) {
      const t = computeTransform(region, size.w, size.h, viewRef.current)
      const w = Math.abs(drag.x1 - drag.x0) * t.scale
      const h = Math.abs(drag.y1 - drag.y0) * t.scale
      if (w >= MIN_BOX_PX && h >= MIN_BOX_PX) {
        const ed = useEditor.getState()
        const activeObj = ed.objects.find((o) => o.id === ed.activeId)
        const cx = (drag.x0 + drag.x1) / 2
        const cy = (drag.y0 + drag.y1) / 2
        if (activeObj && !nearObject(activeObj, cx, cy)) ed.newObject() // box centred elsewhere = new object
        void useEditor.getState().placePrompt({
          box: { x0: Math.round(Math.min(drag.x0, drag.x1)), y0: Math.round(Math.min(drag.y0, drag.y1)), x1: Math.round(Math.max(drag.x0, drag.x1)), y1: Math.round(Math.max(drag.y0, drag.y1)) },
        })
      }
    }
    schedule()
  }

  const onPointerLeave = () => {
    if (!paintingRef.current) {
      cursorRef.current = null
      schedule()
    }
  }

  const cursorStyle = tool === 'brush' ? 'none' : tool === 'select' ? 'pointer' : 'crosshair'
  const active = objects.find((o) => o.id === activeId)
  const activeNumber = active ? objects.indexOf(active) + 1 : 0

  return (
    <div ref={wrapRef} className={className ?? 'canvas-wrap'}>
      <canvas
        ref={canvasRef}
        className="main-canvas"
        style={{ cursor: cursorStyle }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onContextMenu={(e) => e.preventDefault()}
      />
      {image && focusId == null && !loading && (
        <div className="canvas-hint">
          {tool === 'point' &&
            (active
              ? `Refining object ${activeNumber} — click to include, right-click to exclude. Press N for a new object.`
              : 'Click on an object to outline it.')}
          {tool === 'box' && 'Drag a box around an object.'}
          {tool === 'select' && 'Click an object to select it.'}
          {tool === 'brush' && (active ? `Painting object ${activeNumber} — ${brushMode === 'add' ? 'adding' : 'erasing'}.` : 'Select an object, then paint.')}
        </div>
      )}
      {(busy || loading) && <div className="canvas-busy">{loading ? 'Opening image…' : 'Outlining…'}</div>}
    </div>
  )
}

// ---------- small draw helpers ----------

type T = { ox: number; oy: number; scale: number }

function drawPoint(ctx: CanvasRenderingContext2D, x: number, y: number, include: boolean) {
  ctx.beginPath()
  ctx.arc(x, y, 8, 0, Math.PI * 2)
  ctx.fillStyle = include ? 'rgba(40,200,110,0.95)' : 'rgba(235,70,70,0.95)'
  ctx.fill()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x - 4, y)
  ctx.lineTo(x + 4, y)
  if (include) {
    ctx.moveTo(x, y - 4)
    ctx.lineTo(x, y + 4)
  }
  ctx.stroke()
}

function drawBox(ctx: CanvasRenderingContext2D, b: { x0: number; y0: number; x1: number; y1: number }, region: Region, t: T, color: string, dashed: boolean) {
  const x = (Math.min(b.x0, b.x1) - region.x0) * t.scale + t.ox
  const y = (Math.min(b.y0, b.y1) - region.y0) * t.scale + t.oy
  const w = Math.abs(b.x1 - b.x0) * t.scale
  const h = Math.abs(b.y1 - b.y0) * t.scale
  ctx.save()
  ctx.setLineDash(dashed ? [6, 4] : [])
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'
  ctx.lineWidth = 4
  ctx.strokeRect(x, y, w, h)
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.strokeRect(x, y, w, h)
  ctx.restore()
}

function drawBadge(ctx: CanvasRenderingContext2D, o: EditObject, index: number, isActive: boolean, region: Region, t: T, baseColor: string) {
  if (!o.centroid) return
  const x = (o.centroid.x - region.x0) * t.scale + t.ox
  const y = (o.centroid.y - region.y0) * t.scale + t.oy
  const [r, g, b] = objectColor(baseColor, index)
  const text = o.label || String(index + 1)
  ctx.font = '600 12px "IBM Plex Sans", system-ui, sans-serif'
  const w = Math.max(20, ctx.measureText(text).width + 12)
  ctx.beginPath()
  ctx.roundRect(x - w / 2, y - 10, w, 20, 10)
  ctx.fillStyle = isActive ? '#ffffff' : 'rgba(10,13,17,0.82)'
  ctx.fill()
  ctx.strokeStyle = `rgb(${r},${g},${b})`
  ctx.lineWidth = isActive ? 3 : 2
  ctx.stroke()
  ctx.fillStyle = isActive ? '#10141a' : '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y + 0.5)
  ctx.textAlign = 'start'
  ctx.textBaseline = 'alphabetic'
}

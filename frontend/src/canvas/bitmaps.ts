/**
 * Cached per-object bitmaps shared by the canvas and the thumbnails.
 * Keyed by object id and invalidated by a signature (mask revision, border, colour).
 */
import type { EditObject } from '../state/editor'
import { objectColor } from './colors'
import { maskBounds, visibleMask } from './visible'

export type Overlay = { canvas: HTMLCanvasElement; x0: number; y0: number; sig: string }

export function overlayFor(o: EditObject, index: number, rev: number, w: number, h: number, baseColor: string): Overlay | null {
  const store = overlaysOf()
  const sig = `${rev}|${o.shrink}|${baseColor}|${index}|${o.mask.length}`
  const cached = store.get(o.id)
  if (cached && cached.sig === sig) return cached
  const vis = visibleMask(o, w, h, rev)
  const b = maskBounds(vis, w, h)
  if (!b) {
    store.delete(o.id)
    return null
  }
  const bw = b.x1 - b.x0 + 1
  const bh = b.y1 - b.y0 + 1
  const c = cached?.canvas ?? document.createElement('canvas')
  c.width = bw
  c.height = bh
  const ctx = c.getContext('2d')!
  const data = ctx.createImageData(bw, bh)
  const [r, g, bl] = objectColor(baseColor, index)
  for (let y = 0; y < bh; y++) {
    const src = (b.y0 + y) * w + b.x0
    for (let x = 0; x < bw; x++) {
      if (vis[src + x] === 0) continue
      const k = (y * bw + x) * 4
      data.data[k] = r
      data.data[k + 1] = g
      data.data[k + 2] = bl
      data.data[k + 3] = 255
    }
  }
  ctx.putImageData(data, 0, 0)
  const ov = { canvas: c, x0: b.x0, y0: b.y0, sig }
  store.set(o.id, ov)
  return ov
}

// Bitmap caches shared by every canvas/thumbnail; keyed by object id, invalidated by signature.
let overlayStore = new Map<number, Overlay>()
let cutoutStore = new Map<number, { sig: string; canvas: HTMLCanvasElement; x0: number; y0: number }>()
function overlaysOf() {
  return overlayStore
}

export function cutoutFor(o: EditObject, rev: number, w: number, h: number, img: HTMLImageElement, rgbKey: number) {
  const sig = `${rev}|${o.shrink}|${rgbKey}`
  const cached = cutoutStore.get(o.id)
  if (cached && cached.sig === sig) return cached
  const vis = visibleMask(o, w, h, rev)
  const b = maskBounds(vis, w, h)
  if (!b) return null
  const bw = b.x1 - b.x0 + 1
  const bh = b.y1 - b.y0 + 1
  const c = document.createElement('canvas')
  c.width = bw
  c.height = bh
  const ctx = c.getContext('2d')!
  ctx.drawImage(img, b.x0, b.y0, bw, bh, 0, 0, bw, bh)
  const alpha = ctx.createImageData(bw, bh)
  for (let y = 0; y < bh; y++) {
    const src = (b.y0 + y) * w + b.x0
    for (let x = 0; x < bw; x++) if (vis[src + x] !== 0) alpha.data[(y * bw + x) * 4 + 3] = 255
  }
  const m = document.createElement('canvas')
  m.width = bw
  m.height = bh
  m.getContext('2d')!.putImageData(alpha, 0, 0)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(m, 0, 0)
  const out = { sig, canvas: c, x0: b.x0, y0: b.y0 }
  cutoutStore.set(o.id, out)
  return out
}

/** Drop all cached bitmaps (when the image or picture changes). */
/** Pixel bounds of an object's current overlay (null until it has been drawn). */
export function overlayBounds(id: number) {
  const ov = overlayStore.get(id)
  return ov ? { x0: ov.x0, y0: ov.y0, x1: ov.x0 + ov.canvas.width - 1, y1: ov.y0 + ov.canvas.height - 1 } : null
}

export function resetCanvasCaches() {
  overlayStore = new Map()
  cutoutStore = new Map()
}


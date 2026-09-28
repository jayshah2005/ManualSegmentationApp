/**
 * Bounding box helpers for binary masks (0/255).
 * Used by LeafThumb / LeafFullscreen to crop the view around one leaf.
 *
 * Layer order (matches export ``apply_shrink_preserving_edits``):
 * 1. Original SAM mask
 * 2. Border shrink applied to SAM only
 * 3. Brush strokes on top (``brushKeep`` + outside-SAM additions; erasures honored)
 */
export type MaskRegion = {
  x0: number
  y0: number
  x1: number
  y1: number
  width: number
  height: number
}

export function maskBBox(
  mask: Uint8Array,
  imgW: number,
  imgH: number,
  margin = 32,
): MaskRegion {
  let ymin = imgH
  let ymax = -1
  let xmin = imgW
  let xmax = -1
  for (let y = 0; y < imgH; y++) {
    const row = y * imgW
    for (let x = 0; x < imgW; x++) {
      if (mask[row + x] === 0) continue
      if (y < ymin) ymin = y
      if (y > ymax) ymax = y
      if (x < xmin) xmin = x
      if (x > xmax) xmax = x
    }
  }
  if (ymax < 0) {
    return { x0: 0, y0: 0, x1: imgW - 1, y1: imgH - 1, width: imgW, height: imgH }
  }
  const x0 = Math.max(0, xmin - margin)
  const y0 = Math.max(0, ymin - margin)
  const x1 = Math.min(imgW - 1, xmax + margin)
  const y1 = Math.min(imgH - 1, ymax + margin)
  return {
    x0,
    y0,
    x1,
    y1,
    width: x1 - x0 + 1,
    height: y1 - y0 + 1,
  }
}

/**
 * True if (ix, iy) survives a ``shrinkPx`` border erode on ``mask``.
 * Disk of radius shrinkPx must stay inside the mask
 * (``dx*dx + dy*dy <= r*r`` — matched by backend ``disk_kernel`` / ``erode_mask``).
 */
export function isKeptAfterShrink(
  mask: Uint8Array,
  ix: number,
  iy: number,
  imgW: number,
  imgH: number,
  shrinkPx: number,
): boolean {
  if (ix < 0 || iy < 0 || ix >= imgW || iy >= imgH) return false
  if (mask[iy * imgW + ix] === 0) return false
  const r = Math.max(0, Math.floor(shrinkPx))
  if (r <= 0) return true
  const rr = r * r
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > rr) continue
      const nx = ix + dx
      const ny = iy + dy
      if (nx < 0 || ny < 0 || nx >= imgW || ny >= imgH) return false
      if (mask[ny * imgW + nx] === 0) return false
    }
  }
  return true
}

/**
 * Whether a pixel is visible after border + brush, matching export.
 *
 * Pipeline: border erodes the *original SAM* mask; brush-owned pixels
 * (``brushKeep``) and outside-SAM additions always stay; erasures always go.
 * Changing border never re-fringes brush paint — including reclaiming the
 * SAM fringe after shrink.
 */
export function isKeptAfterShrinkPreservingEdits(
  edited: Uint8Array,
  sam: Uint8Array | null | undefined,
  ix: number,
  iy: number,
  imgW: number,
  imgH: number,
  shrinkPx: number,
  brushKeep?: Uint8Array | null,
): boolean {
  if (ix < 0 || iy < 0 || ix >= imgW || iy >= imgH) return false
  const i = iy * imgW + ix
  if (edited[i] === 0) return false
  // Explicit brush paint is the final layer — never fringed by border.
  if (brushKeep && brushKeep.length === edited.length && brushKeep[i] !== 0) {
    return true
  }
  if (!sam || sam.length !== edited.length) {
    return isKeptAfterShrink(edited, ix, iy, imgW, imgH, shrinkPx)
  }
  if (sam[i] === 0) {
    // Brush addition outside original SAM — border does not apply.
    return true
  }
  // Still SAM foreground (and not brush-owned): border tests original SAM only.
  return isKeptAfterShrink(sam, ix, iy, imgW, imgH, shrinkPx)
}

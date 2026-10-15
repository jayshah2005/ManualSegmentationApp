/**
 * What is actually part of an object after border + brush edits.
 *
 * Mirrors the backend export (`apply_shrink_preserving_edits`):
 *   1. start from the original SAM mask
 *   2. erode it by `shrink` px (a disk of that radius must fit inside the mask)
 *   3. keep brush additions and brush-owned pixels; honour erasures
 *
 * The erosion test "disk of radius r fits" is equivalent to "squared distance to
 * the nearest background pixel (or image edge) is > r²", so one exact distance
 * transform per SAM mask makes any border value a single O(n) pass.
 */
import type { EditObject } from '../state/editor'

const INF = 1e12

/** Felzenszwalb–Huttenlocher 1-D squared-distance transform (in place on `f`). */
function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let s: number
    for (;;) {
      const p = v[k]
      s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p)
      if (s <= z[k] && k > 0) k--
      else break
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
  }
}

/** Squared distance from each pixel to the nearest zero pixel, over a `w`×`h` array. */
export function edt2(fg: Uint8Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  const n = Math.max(w, h)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  // columns
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = fg[y * w + x] ? INF : 0
    dt1d(f, h, d, v, z)
    for (let y = 0; y < h; y++) out[y * w + x] = d[y]
  }
  // rows
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x]
    dt1d(f, w, d, v, z)
    for (let x = 0; x < w; x++) out[y * w + x] = d[x]
  }
  return out
}

/**
 * Distances measured only inside the mask's bounding box plus a 1 px ring of
 * background. That is exact: everything outside the box is background anyway, and
 * the ring is also what makes the image edge count as background. For a small
 * object in a 24 MP photo this is a few KB instead of ~100 MB.
 */
type BoxDistance = { x0: number; y0: number; pw: number; e: Float32Array }
const edtCache = new WeakMap<Uint8Array, BoxDistance | null>()

function samDistance(sam: Uint8Array, w: number, h: number): BoxDistance | null {
  if (edtCache.has(sam)) return edtCache.get(sam)!
  const b = maskBounds(sam, w, h)
  let result: BoxDistance | null = null
  if (b) {
    const bw = b.x1 - b.x0 + 1
    const bh = b.y1 - b.y0 + 1
    const pw = bw + 2
    const ph = bh + 2
    const padded = new Uint8Array(pw * ph)
    for (let y = 0; y < bh; y++) {
      const src = (b.y0 + y) * w + b.x0
      padded.set(sam.subarray(src, src + bw), (y + 1) * pw + 1)
    }
    result = { x0: b.x0, y0: b.y0, pw, e: edt2(padded, pw, ph) }
  }
  edtCache.set(sam, result)
  return result
}

type Cached = { rev: number; shrink: number; mask: Uint8Array; vis: Uint8Array }
const visCache = new Map<number, Cached>()

/** Drop cached visibility masks (call when the open image changes). */
export function clearVisibleCache() {
  visCache.clear()
}

/**
 * 0/255 mask of the pixels that will be exported. The returned array is cached
 * per object and must be treated as read-only.
 */
export function visibleMask(obj: EditObject, w: number, h: number, rev: number): Uint8Array {
  const hit = visCache.get(obj.id)
  if (hit && hit.rev === rev && hit.shrink === obj.shrink && hit.mask === obj.mask) return hit.vis
  const { mask, sam, keep, shrink } = obj
  const r = Math.max(0, Math.floor(shrink))
  let vis: Uint8Array
  if (r === 0) {
    vis = mask
  } else {
    vis = new Uint8Array(mask.length)
    const dist = samDistance(sam, w, h)
    const rr = r * r
    for (let y = 0; y < h; y++) {
      const row = y * w
      for (let x = 0; x < w; x++) {
        const i = row + x
        if (mask[i] === 0) continue
        if (keep[i] !== 0 || sam[i] === 0 || !dist) {
          vis[i] = 255 // brush additions and brush-owned pixels are never trimmed
          continue
        }
        if (dist.e[(y - dist.y0 + 1) * dist.pw + (x - dist.x0 + 1)] > rr) vis[i] = 255
      }
    }
  }
  visCache.set(obj.id, { rev, shrink: obj.shrink, mask: obj.mask, vis })
  return vis
}

export type Bounds = { x0: number; y0: number; x1: number; y1: number }

/** Tight pixel bounds of non-zero pixels, or null when empty. */
export function maskBounds(mask: Uint8Array, w: number, h: number): Bounds | null {
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (mask[row + x] === 0) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y1 < y) y1 = y
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}

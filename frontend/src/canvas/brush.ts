/**
 * Circular brush stamping and undo stacks for binary masks.
 *
 * Masks are row-major `Uint8Array` of length width*height with 0 / 255.
 * `brushSize` is diameter in **image pixels**. Strokes stamp disks in image
 * space; the on-screen cursor must use `diameter * viewScale` so it matches.
 */
const MAX_UNDO = 40

export type BrushMode = 'add' | 'erase'

export function createMask(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height)
}

export function cloneMask(mask: Uint8Array): Uint8Array {
  return new Uint8Array(mask)
}

/** Brush size slider value → radius in image pixels. */
export function brushRadius(diameterPx: number): number {
  return Math.max(0.5, diameterPx * 0.5)
}

/**
 * Stamp a hard disk centered at (cx, cy) in image pixel coordinates.
 *
 * Uses pixel-center distance with a half-pixel inset so the discrete stamp
 * does not spill outside the geometric circle the cursor shows.
 *
 * When ``brushKeep`` is provided, ADD marks those pixels as brush-owned
 * (immune to border) and ERASE clears ownership.
 */
export function stampCircle(
  mask: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  diameterPx: number,
  mode: BrushMode,
  brushKeep?: Uint8Array | null,
): void {
  const radius = brushRadius(diameterPx)
  // Inset so corner pixels of the rasterized disk stay inside the smooth circle.
  const rEff = Math.max(0.25, radius - 0.5)
  const r2 = rEff * rEff
  const x0 = Math.max(0, Math.floor(cx - radius))
  const x1 = Math.min(width - 1, Math.ceil(cx + radius))
  const y0 = Math.max(0, Math.floor(cy - radius))
  const y1 = Math.min(height - 1, Math.ceil(cy + radius))
  const value = mode === 'add' ? 255 : 0
  const keep = brushKeep && brushKeep.length === mask.length ? brushKeep : null
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy
    const dy2 = dy * dy
    if (dy2 > r2) continue
    const row = y * width
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx
      if (dx * dx + dy2 <= r2) {
        const i = row + x
        mask[i] = value
        if (keep) keep[i] = value
      }
    }
  }
}

export function stampLine(
  mask: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  diameterPx: number,
  mode: BrushMode,
  brushKeep?: Uint8Array | null,
): void {
  // Dense stamps so fast moves stay continuous without thickening the stroke.
  const dist = Math.hypot(x1 - x0, y1 - y0)
  const radius = brushRadius(diameterPx)
  const step = Math.max(0.35, radius * 0.2)
  const n = Math.max(1, Math.ceil(dist / step))
  for (let i = 0; i <= n; i++) {
    const t = i / n
    stampCircle(
      mask,
      width,
      height,
      x0 + (x1 - x0) * t,
      y0 + (y1 - y0) * t,
      diameterPx,
      mode,
      brushKeep,
    )
  }
}

/** One undo/redo frame: edited mask + brush-owned layer. */
export type StrokeSnapshot = {
  mask: Uint8Array
  brushKeep: Uint8Array
}

export class MaskUndoStack {
  private undo: StrokeSnapshot[] = []
  private redo: StrokeSnapshot[] = []

  push(mask: Uint8Array, brushKeep: Uint8Array) {
    this.undo.push({ mask: cloneMask(mask), brushKeep: cloneMask(brushKeep) })
    if (this.undo.length > MAX_UNDO) this.undo.shift()
    this.redo = []
  }

  canUndo() {
    return this.undo.length > 0
  }

  canRedo() {
    return this.redo.length > 0
  }

  undoOnce(currentMask: Uint8Array, currentKeep: Uint8Array): StrokeSnapshot | null {
    if (!this.undo.length) return null
    this.redo.push({
      mask: cloneMask(currentMask),
      brushKeep: cloneMask(currentKeep),
    })
    return this.undo.pop()!
  }

  redoOnce(currentMask: Uint8Array, currentKeep: Uint8Array): StrokeSnapshot | null {
    if (!this.redo.length) return null
    this.undo.push({
      mask: cloneMask(currentMask),
      brushKeep: cloneMask(currentKeep),
    })
    return this.redo.pop()!
  }

  clear() {
    this.undo = []
    this.redo = []
  }
}

/** Encode a binary mask (0/255) to PNG base64 via OffscreenCanvas or DOM canvas. */
export async function maskToPngBase64(
  mask: Uint8Array,
  width: number,
  height: number,
): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const imageData = ctx.createImageData(width, height)
  const data = imageData.data
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i]
    const o = i * 4
    data[o] = v
    data[o + 1] = v
    data[o + 2] = v
    data[o + 3] = 255
  }
  ctx.putImageData(imageData, 0, 0)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  )
  if (!blob) throw new Error('Failed to encode mask PNG')
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

export async function pngBase64ToMask(
  b64: string,
  expectedW: number,
  expectedH: number,
): Promise<Uint8Array> {
  const img = new Image()
  img.src = `data:image/png;base64,${b64}`
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = expectedW
  canvas.height = expectedH
  const ctx = canvas.getContext('2d')!
  // Nearest-neighbor — never stretch soft edges into false mask pixels.
  ctx.imageSmoothingEnabled = false
  if (img.naturalWidth !== expectedW || img.naturalHeight !== expectedH) {
    throw new Error(
      `Mask PNG size ${img.naturalWidth}x${img.naturalHeight} != expected ${expectedW}x${expectedH}`,
    )
  }
  ctx.drawImage(img, 0, 0)
  const { data } = ctx.getImageData(0, 0, expectedW, expectedH)
  const mask = new Uint8Array(expectedW * expectedH)
  for (let i = 0; i < mask.length; i++) {
    mask[i] = data[i * 4] > 127 ? 255 : 0
  }
  return mask
}

/** Parse `#rgb` / `#rrggbb` into 0–255 channels. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '').trim()
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h.padEnd(6, '0').slice(0, 6)
  const n = Number.parseInt(full, 16)
  if (Number.isNaN(n)) return [61, 154, 106]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** @deprecated Prefer store `maskOverlayColor` + `hexToRgb`. */
export function leafColor(_index: number, hex = '#3d9a6a'): [number, number, number] {
  return hexToRgb(hex)
}

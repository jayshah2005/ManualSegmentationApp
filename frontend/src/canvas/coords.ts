/**
 * Map between display (canvas CSS) coords and image pixel coords.
 *
 * The RGB is letterboxed into the canvas (`fitImage`). Always convert through
 * these helpers so brush/seed hits land on the correct HSI pixels.
 */
export type FitRect = {
  offsetX: number
  offsetY: number
  drawW: number
  drawH: number
  scale: number
}

export function fitImage(
  imgW: number,
  imgH: number,
  canvasW: number,
  canvasH: number,
): FitRect {
  if (imgW <= 0 || imgH <= 0 || canvasW <= 0 || canvasH <= 0) {
    return { offsetX: 0, offsetY: 0, drawW: 0, drawH: 0, scale: 1 }
  }
  const scale = Math.min(canvasW / imgW, canvasH / imgH)
  const drawW = imgW * scale
  const drawH = imgH * scale
  const offsetX = (canvasW - drawW) / 2
  const offsetY = (canvasH - drawH) / 2
  return { offsetX, offsetY, drawW, drawH, scale }
}

export function displayToImage(
  dx: number,
  dy: number,
  fit: FitRect,
): { x: number; y: number } | null {
  const ix = (dx - fit.offsetX) / fit.scale
  const iy = (dy - fit.offsetY) / fit.scale
  return { x: ix, y: iy }
}

export function imageToDisplay(
  ix: number,
  iy: number,
  fit: FitRect,
): { x: number; y: number } {
  return {
    x: fit.offsetX + ix * fit.scale,
    y: fit.offsetY + iy * fit.scale,
  }
}

export function clampImagePoint(
  x: number,
  y: number,
  imgW: number,
  imgH: number,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(imgW - 1, Math.round(x))),
    y: Math.max(0, Math.min(imgH - 1, Math.round(y))),
  }
}

/** Clamp for brush stamps — keep sub-pixel centers so the cursor and stamp align. */
export function clampImagePointFloat(
  x: number,
  y: number,
  imgW: number,
  imgH: number,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(imgW - 1e-4, x)),
    y: Math.max(0, Math.min(imgH - 1e-4, y)),
  }
}

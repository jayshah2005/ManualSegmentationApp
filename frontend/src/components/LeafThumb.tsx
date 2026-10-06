import { useEffect, useRef } from 'react'
import { rgbUrl } from '../api/client'
import { isKeptAfterShrinkPreservingEdits, maskBBox } from '../canvas/maskRegion'
import { useAppStore } from '../state/store'

type Props = {
  maskIndex: number
  displayIndex: number
  size?: number
  /** Live border value (draft) so the thumb updates while dragging the slider. */
  shrink?: number
}

/**
 * Sidebar thumbnail: leaf cutout only (RGB inside the mask, dark elsewhere).
 * Respects border shrink on the original SAM only; brush additions are kept.
 */
export function LeafThumb({
  maskIndex,
  displayIndex,
  size = 168,
  shrink: shrinkProp,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const session = useAppStore((s) => s.session)
  const mask = useAppStore((s) => s.localMasks[maskIndex])
  const maskRev = useAppStore((s) => s.maskRevisions[maskIndex] ?? 0)
  const samMask = useAppStore((s) => s.samMasks[maskIndex])
  const brushKeep = useAppStore((s) => s.brushKeeps[maskIndex])
  const rgbCacheKey = useAppStore((s) => s.rgbCacheKey)
  const viewExposure = useAppStore((s) => s.viewExposure)
  const sessionShrink = useAppStore(
    (s) => s.session?.leaves.find((l) => l.maskIndex === maskIndex)?.shrink ?? 0,
  )
  const shrink = shrinkProp ?? sessionShrink

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !session || !mask) return
    if (mask.length !== session.width * session.height) return

    const sampleKey = session.sampleKey
    const imgW = session.width
    const imgH = session.height
    let cancelled = false

    const img = new Image()
    img.src = rgbUrl(sampleKey, rgbCacheKey)
    img.onload = () => {
      if (cancelled) return
      if (useAppStore.getState().session?.sampleKey !== sampleKey) return
      const liveMask = useAppStore.getState().localMasks[maskIndex]
      const liveSam = useAppStore.getState().samMasks[maskIndex]
      const liveKeep = useAppStore.getState().brushKeeps[maskIndex]
      if (!liveMask || liveMask.length !== imgW * imgH) return

      const region = maskBBox(liveMask, imgW, imgH, 8)
      const ctx = canvas.getContext('2d')!
      canvas.width = size
      canvas.height = size
      ctx.imageSmoothingEnabled = false
      ctx.fillStyle = '#0a0d11'
      ctx.fillRect(0, 0, size, size)

      const scale = Math.min(size / region.width, size / region.height)
      const dw = Math.max(1, Math.round(region.width * scale))
      const dh = Math.max(1, Math.round(region.height * scale))
      const ox = Math.floor((size - dw) / 2)
      const oy = Math.floor((size - dh) / 2)

      const cut = document.createElement('canvas')
      cut.width = region.width
      cut.height = region.height
      const cctx = cut.getContext('2d')!
      cctx.drawImage(
        img,
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
      const rShrink = Math.max(0, shrink)
      for (let y = 0; y < region.height; y++) {
        for (let x = 0; x < region.width; x++) {
          const ix = region.x0 + x
          const iy = region.y0 + y
          const o = (y * region.width + x) * 4
          if (
            !isKeptAfterShrinkPreservingEdits(
              liveMask,
              liveSam,
              ix,
              iy,
              imgW,
              imgH,
              rShrink,
              liveKeep,
            )
          ) {
            data[o] = 0
            data[o + 1] = 0
            data[o + 2] = 0
            data[o + 3] = 0
          }
        }
      }
      cctx.putImageData(pixels, 0, 0)
      const exposure = useAppStore.getState().viewExposure
      if (exposure !== 1) ctx.filter = `brightness(${exposure})`
      ctx.drawImage(cut, 0, 0, region.width, region.height, ox, oy, dw, dh)
      if (exposure !== 1) ctx.filter = 'none'
      void displayIndex
    }

    return () => {
      cancelled = true
    }
  }, [
    session,
    mask,
    maskRev,
    samMask,
    brushKeep,
    rgbCacheKey,
    maskIndex,
    displayIndex,
    size,
    shrink,
    viewExposure,
  ])

  return (
    <canvas
      ref={canvasRef}
      className="leaf-thumb"
      width={size}
      height={size}
      aria-hidden
    />
  )
}

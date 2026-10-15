import { useCallback, useRef, useState } from 'react'

export type Region = { x0: number; y0: number; w: number; h: number }
export type View = { zoom: number; panX: number; panY: number }

export type Transform = {
  /** Display position of the region's top-left corner. */
  ox: number
  oy: number
  /** Display pixels per image pixel. */
  scale: number
}

export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 32

/** Where `region` lands on a canvas of `cw`×`ch` for the given zoom/pan (fit, centered). */
export function computeTransform(region: Region, cw: number, ch: number, view: View): Transform {
  const fit = Math.min(cw / region.w, ch / region.h)
  const scale = fit * view.zoom
  return {
    scale,
    ox: (cw - region.w * scale) / 2 + view.panX,
    oy: (ch - region.h * scale) / 2 + view.panY,
  }
}

/**
 * Zoom/pan state kept in a ref (the canvas redraws imperatively) with a small
 * state mirror for the zoom label. Zoom-in keeps the point under the cursor
 * fixed; zoom-out eases back toward the centered fit.
 */
export function useViewport(onChange: () => void) {
  const viewRef = useRef<View>({ zoom: 1, panX: 0, panY: 0 })
  const [zoomPct, setZoomPct] = useState(100)

  const commit = useCallback(() => {
    setZoomPct(Math.round(viewRef.current.zoom * 100))
    onChange()
  }, [onChange])

  const reset = useCallback(() => {
    viewRef.current = { zoom: 1, panX: 0, panY: 0 }
    commit()
  }, [commit])

  const panBy = useCallback(
    (dx: number, dy: number) => {
      viewRef.current.panX += dx
      viewRef.current.panY += dy
      onChange()
    },
    [onChange],
  )

  const zoomAt = useCallback(
    (cx: number, cy: number, factor: number, region: Region, cw: number, ch: number) => {
      const v = viewRef.current
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor))
      if (next === v.zoom) return
      if (factor < 1) {
        if (v.zoom <= 1 || next <= 1) {
          v.panX = 0
          v.panY = 0
        } else {
          const t = (next - 1) / (v.zoom - 1)
          v.panX *= t
          v.panY *= t
        }
        v.zoom = next
      } else {
        const old = computeTransform(region, cw, ch, v)
        const lx = (cx - old.ox) / old.scale
        const ly = (cy - old.oy) / old.scale
        v.zoom = next
        const fresh = computeTransform(region, cw, ch, { ...v, panX: 0, panY: 0 })
        v.panX = cx - lx * fresh.scale - fresh.ox
        v.panY = cy - ly * fresh.scale - fresh.oy
      }
      commit()
    },
    [commit],
  )

  return { viewRef, zoomPct, reset, panBy, zoomAt }
}

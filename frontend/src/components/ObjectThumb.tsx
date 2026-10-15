import { useEffect, useRef } from 'react'
import { cutoutFor } from '../canvas/bitmaps'
import { useDisplayImage } from '../hooks/useDisplayImage'
import { useEditor, type EditObject } from '../state/editor'
import { useWorkspace } from '../state/workspace'

/** Cut-out preview of one object (picture pixels inside its mask, border applied). */
export function ObjectThumb({ object, size = 150 }: { object: EditObject; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const img = useDisplayImage()
  const image = useEditor((s) => s.image)
  const rev = useEditor((s) => s.revs[object.id] ?? 0)
  const rgbKey = useEditor((s) => s.rgbKey)
  const exposure = useWorkspace((s) => s.appearance.exposure)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !img || !image) return
    const ctx = canvas.getContext('2d')!
    canvas.width = size
    canvas.height = size
    ctx.fillStyle = '#0a0d11'
    ctx.fillRect(0, 0, size, size)
    const cut = cutoutFor(object, rev, image.width, image.height, img, rgbKey)
    if (!cut) return
    const c = cut.canvas
    const scale = Math.min(size / c.width, size / c.height)
    const w = Math.max(1, Math.round(c.width * scale))
    const h = Math.max(1, Math.round(c.height * scale))
    ctx.imageSmoothingEnabled = scale < 1
    if (exposure !== 1) ctx.filter = `brightness(${exposure})`
    ctx.drawImage(c, 0, 0, c.width, c.height, Math.floor((size - w) / 2), Math.floor((size - h) / 2), w, h)
    ctx.filter = 'none'
  }, [img, image, object, rev, rgbKey, exposure, size, object.shrink])

  return <canvas ref={ref} className="object-thumb" width={size} height={size} aria-hidden />
}

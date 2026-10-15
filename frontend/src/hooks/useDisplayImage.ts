import { useEffect, useState } from 'react'
import { rgbUrl } from '../api/client'
import { useEditor } from '../state/editor'

const cache = new Map<string, HTMLImageElement>()

/** The decoded display picture of the open image (shared by thumbnails and canvases). */
export function useDisplayImage(): HTMLImageElement | null {
  const key = useEditor((s) => s.image?.sampleKey)
  const rgbKey = useEditor((s) => s.rgbKey)
  const id = key ? `${key}|${rgbKey}` : ''
  const [loaded, setLoaded] = useState<{ id: string; img: HTMLImageElement } | null>(null)

  useEffect(() => {
    if (!key || cache.has(id)) return
    let cancelled = false
    const el = new Image()
    el.decoding = 'async'
    el.src = rgbUrl(key, rgbKey)
    el.onload = () => {
      if (cancelled) return
      if (cache.size > 3) cache.clear()
      cache.set(id, el)
      setLoaded({ id, img: el })
    }
    return () => {
      cancelled = true
    }
  }, [key, rgbKey, id])

  if (!id) return null
  return cache.get(id) ?? (loaded?.id === id ? loaded.img : null)
}

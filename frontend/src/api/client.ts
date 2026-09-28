/**
 * Typed fetch helpers for the FastAPI backend (`/api/...`, proxied by Vite in dev).
 *
 * Indexing (must match backend):
 * - `displayIndex` — UI leaf order (rail cards, labels, shrinks)
 * - `maskIndex` — index into mask PNG arrays / local `Uint8Array`s
 *
 * Most mutations return a full `SessionPayload`; the Zustand store decides
 * whether to re-hydrate masks or keep local brush edits.
 *
 * Mutating calls pass `sampleKey` so the server can reject stale requests after
 * the user has already switched samples (HTTP 409).
 */
export type Point = { x: number; y: number }

export type LeafInfo = {
  displayIndex: number
  maskIndex: number
  label: string
  centroid: Point
  shrink: number
  maskPngBase64: string
  /** Original SAM mask for this leaf (border preview preserves brush additions). */
  samMaskPngBase64?: string
  /** Brush-owned pixels (immune to border). Optional for older servers. */
  brushKeepPngBase64?: string
  thumbnailJpegBase64: string | null
}

export type SessionPayload = {
  vineType: string
  folder: string
  sampleKey: string
  status: string
  width: number
  height: number
  seeds: Point[]
  mainLabel: string
  sublabels: string[]
  ocrMeta: Record<string, unknown>
  ndviThresh: number
  minDistance: number
  maxAutoCentroids: number
  leaves: LeafInfo[]
  hasMasks: boolean
}

export type VineInfo = {
  name: string
  folderCount: number
  completedCount: number
  folders: { folder: string; status: string }[]
  firstPending: string | null
}

/** Thrown when the server sample no longer matches the client's sampleKey. */
export class StaleSampleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleSampleError'
  }
}

/** Thrown when Save would overwrite existing leaf export folders. */
export class OverwriteConflictError extends Error {
  labels: string[]
  constructor(labels: string[]) {
    super(
      labels.length
        ? `Would overwrite: ${labels.join(', ')}`
        : 'Would overwrite existing exports',
    )
    this.name = 'OverwriteConflictError'
    this.labels = labels
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail: unknown = res.statusText
    try {
      const body = await res.json()
      detail = body.detail ?? body
    } catch {
      /* ignore */
    }
    if (res.status === 409) {
      if (
        detail &&
        typeof detail === 'object' &&
        !Array.isArray(detail) &&
        (detail as { code?: string }).code === 'would_overwrite'
      ) {
        const labels = (detail as { labels?: unknown }).labels
        throw new OverwriteConflictError(
          Array.isArray(labels) ? labels.map(String) : [],
        )
      }
      const msg = typeof detail === 'string' ? detail : JSON.stringify(detail)
      throw new StaleSampleError(msg)
    }
    const msg = typeof detail === 'string' ? detail : JSON.stringify(detail)
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export async function fetchVines(): Promise<VineInfo[]> {
  const data = await json<{ vines: VineInfo[] }>(await fetch('/api/vines'))
  return data.vines
}

export async function loadSession(
  vineType: string,
  folder: string,
  ndviThresh = 0.4,
  minDistance = 30,
  mainLabel?: string | null,
): Promise<SessionPayload> {
  return json(
    await fetch('/api/session/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vineType,
        folder,
        ndviThresh,
        minDistance,
        ...(mainLabel?.trim() ? { mainLabel: mainLabel.trim() } : {}),
      }),
    }),
  )
}

export function rgbUrl(
  sampleKey?: string | null,
  cacheBust?: number | string,
): string {
  const params = new URLSearchParams()
  if (sampleKey) params.set('sampleKey', sampleKey)
  if (cacheBust != null) params.set('t', String(cacheBust))
  const q = params.toString()
  return q ? `/api/session/rgb?${q}` : '/api/session/rgb'
}

export function leafPreviewUrl(
  displayIndex: number,
  shrink?: number,
  cacheBust?: number | string,
): string {
  const params = new URLSearchParams()
  params.set('displayIndex', String(displayIndex))
  if (shrink != null) params.set('shrink', String(shrink))
  if (cacheBust != null) params.set('t', String(cacheBust))
  return `/api/session/leaf-preview?${params.toString()}`
}

export async function updateSeeds(
  seeds: Point[],
  runSam = true,
  sampleKey?: string | null,
): Promise<SessionPayload> {
  return json(
    await fetch('/api/session/seeds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seeds, runSam, sampleKey: sampleKey ?? undefined }),
    }),
  )
}

export async function resetSeeds(
  ndviThresh?: number,
  minDistance?: number,
  sampleKey?: string | null,
): Promise<SessionPayload> {
  const params = new URLSearchParams()
  if (ndviThresh != null) params.set('ndviThresh', String(ndviThresh))
  if (minDistance != null) params.set('minDistance', String(minDistance))
  if (sampleKey) params.set('sampleKey', sampleKey)
  const q = params.toString() ? `?${params}` : ''
  return json(await fetch(`/api/session/reset-seeds${q}`, { method: 'POST' }))
}

export async function updateOcr(body: {
  mainLabel?: string
  sublabels?: string[]
  redetect?: boolean
  sampleKey?: string | null
}): Promise<SessionPayload> {
  return json(
    await fetch('/api/session/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

export async function updateShrink(body: {
  displayIndex?: number
  shrink?: number
  resuggest?: boolean
  sampleKey?: string | null
}): Promise<SessionPayload> {
  return json(
    await fetch('/api/session/shrink', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

export async function pushMasks(
  masks: {
    maskIndex: number
    maskPngBase64: string
    brushKeepPngBase64?: string
  }[],
  sampleKey?: string | null,
): Promise<SessionPayload> {
  return json(
    await fetch('/api/session/masks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masks, sampleKey: sampleKey ?? undefined }),
    }),
  )
}

export async function resetMask(
  maskIndex: number,
  sampleKey?: string | null,
): Promise<SessionPayload> {
  const params = new URLSearchParams({ maskIndex: String(maskIndex) })
  if (sampleKey) params.set('sampleKey', sampleKey)
  return json(
    await fetch(`/api/session/reset-mask?${params.toString()}`, {
      method: 'POST',
    }),
  )
}

export async function saveSession(body: {
  mainLabel?: string
  sublabels?: string[]
  shrinks?: number[]
  masks?: {
    maskIndex: number
    maskPngBase64: string
    brushKeepPngBase64?: string
  }[]
  sampleKey?: string | null
  /** True (default): mark Completed and advance. False: mark Incomplete, stay. */
  complete?: boolean
  /** True: overwrite existing leaf export folders. False: 409 if they exist. */
  forceOverwrite?: boolean
}): Promise<{
  savedCount: number
  nextFolder: string | null
  vineType: string
  status: string
}> {
  return json(
    await fetch('/api/session/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

export async function skipSession(): Promise<{
  nextFolder: string | null
  vineType: string
}> {
  return json(await fetch('/api/session/skip', { method: 'POST' }))
}

/**
 * Typed client for the backend (`/api/...`). Vite proxies to uvicorn in dev; in
 * production FastAPI serves this app, so relative URLs always work.
 *
 * Mutations return only what changed (see backend/api/session.py), so callers
 * merge the result into their own state instead of replacing everything.
 */

// ---------- shared types ----------

export type SamModel = 'tiny' | 'small' | 'base_plus' | 'large'
export type DeviceChoice = 'auto' | 'cuda' | 'mps' | 'cpu'
export type ExportFormat = 'same_as_input' | 'png' | 'tiff' | 'npy' | 'envi'
export type MetadataFormat = 'none' | 'csv' | 'coco'

export type Settings = {
  inputDir: string
  outputDir: string
  recursive: boolean
  samModel: SamModel
  device: DeviceChoice
  display: {
    bandMode: 'auto' | 'manual'
    bands: number[]
    stretchLow: number
    stretchHigh: number
    maxSize: number
  }
  orientation: { rotate: 0 | 90 | 180 | 270; flipH: boolean; flipV: boolean; autoUpright: boolean }
  export: {
    format: ExportFormat
    cropToBBox: boolean
    saveMask: boolean
    savePreview: boolean
    metadata: MetadataFormat
  }
}

export type SampleStatus = 'Pending' | 'Incomplete' | 'Completed' | 'Skipped'

export type SampleRow = {
  key: string
  name: string
  parent: string
  format: string
  isFolder: boolean
  status: SampleStatus
}

export type SamplesResponse = {
  configured: boolean
  inputDir?: string
  outputDir?: string
  samples: SampleRow[]
  counts: Partial<Record<SampleStatus, number>>
  firstPendingKey?: string | null
}

export type SystemProblem = {
  code: string
  message: string
  fix: 'install_torch' | 'install_sam2' | 'download_model'
  severity: 'blocking' | 'warning'
}

export type SystemStatus = {
  os: string
  machine: string
  python: string
  nvidiaGpu: { name: string; driver: string; memoryMb: number; cudaVersion?: string } | null
  torch: {
    installed: boolean
    version?: string
    cudaBuild?: string | null
    cudaAvailable?: boolean
    mpsAvailable?: boolean
  }
  gpu?: { name: string; memoryMb: number }
  sam2Installed: boolean
  models: { name: SamModel; label: string; sizeMb: number; note: string; downloaded: boolean }[]
  selectedModel: SamModel
  recommendedTorch: { tag: string; label: string; reason: string }
  device: string
  problems: SystemProblem[]
  ready: boolean
}

export type SetupJob = {
  id: string
  kind: string
  status: 'running' | 'done' | 'error'
  step: string
  progress: number | null
  error: string
  restartRequired: boolean
  lines: string[]
  next: number
}

export type FsListing = {
  path: string
  parent: string | null
  folders: { name: string; path: string }[]
  imageCount: number
  writable: boolean
  roots: { name: string; path: string }[]
}

export type Point = { x: number; y: number; label: 0 | 1 }
export type Box = { x0: number; y0: number; x1: number; y1: number }

export type ObjectPayload = {
  id: number
  label: string
  shrink: number
  points: Point[]
  box: Box | null
  centroid: { x: number; y: number } | null
  maskPngBase64: string | null
  samMaskPngBase64: string | null
  brushKeepPngBase64: string | null
}

export type SessionInfo = {
  sampleKey: string
  name: string
  status: SampleStatus
  width: number
  height: number
  nativeWidth: number
  nativeHeight: number
  kind: 'rgb' | 'cube'
  format: string
  bands: number
  bandsUsed: number[]
  objects: ObjectPayload[]
}

export type SaveResult = {
  savedCount: number
  outputDir: string
  files: string[]
  nextSampleKey: string | null
  status: SampleStatus
}

export type MaskUpload = { objectId: number; maskPngBase64: string; brushKeepPngBase64: string }

// ---------- errors ----------

export class ApiError extends Error {
  status: number
  code?: string
  detail: unknown
  constructor(status: number, message: string, detail: unknown, code?: string) {
    super(message)
    this.status = status
    this.detail = detail
    this.code = code
  }
}

/** Save found existing files; the UI asks before overwriting. */
export class OverwriteConflictError extends Error {
  names: string[]
  constructor(names: string[], message: string) {
    super(message)
    this.names = names
  }
}

/** The server moved to another image than this request targeted. */
export class StaleImageError extends Error {}

function describe(detail: unknown): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d) => (typeof d === 'object' && d && 'msg' in d ? String((d as { msg: unknown }).msg) : String(d)))
      .join('; ')
  }
  if (detail && typeof detail === 'object' && 'message' in detail) return String((detail as { message: unknown }).message)
  return 'Request failed'
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'Cannot reach the app. Is it still running?', null)
  }
  if (res.ok) return (await res.json()) as T
  let payload: { detail?: unknown; code?: string } = {}
  try {
    payload = await res.json()
  } catch {
    /* non-JSON error body */
  }
  const detail = payload.detail
  if (res.status === 409) {
    if (detail && typeof detail === 'object' && (detail as { code?: string }).code === 'would_overwrite') {
      const d = detail as { names?: string[]; message?: string }
      throw new OverwriteConflictError(d.names ?? [], d.message ?? 'Files already exist')
    }
    throw new StaleImageError(describe(detail))
  }
  throw new ApiError(res.status, describe(detail), detail, payload.code)
}

const get = <T>(url: string) => request<T>('GET', url)
const post = <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {})
const put = <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {})
const patch = <T>(url: string, body?: unknown) => request<T>('PATCH', url, body ?? {})
const del = <T>(url: string) => request<T>('DELETE', url)
const q = (params: Record<string, string | number | boolean | undefined>) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v))
  const out = s.toString()
  return out ? `?${out}` : ''
}

// ---------- workspace ----------

export const fetchSettings = () => get<Settings>('/api/settings')
export const updateSettings = (patchBody: DeepPartial<Settings>) => put<Settings>('/api/settings', patchBody)
export const fetchSystem = () => get<SystemStatus>('/api/system')
export const fetchSamples = (refresh = false) => get<SamplesResponse>(`/api/samples${q({ refresh })}`)
export const listFolder = (path = '', showHidden = false) => get<FsListing>(`/api/fs/list${q({ path, showHidden })}`)
export const makeFolder = (path: string, name: string) => post<{ path: string }>('/api/fs/mkdir', { path, name })

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

// ---------- setup / install ----------

export type InstallAction = 'install_torch' | 'install_sam2' | 'download_model' | 'setup_all'
export const startInstall = (action: InstallAction, opts: { torchTag?: string; model?: SamModel } = {}) =>
  post<SetupJob>('/api/setup/install', { action, ...opts })
export const fetchJob = (since: number) => get<{ job: SetupJob | null }>(`/api/setup/job${q({ since })}`)
export const restartApp = () => post<{ restarting: boolean }>('/api/setup/restart')

// ---------- session ----------

export const rgbUrl = (sampleKey: string, cacheKey: number) =>
  `/api/session/rgb${q({ sampleKey, t: cacheKey })}`

export const loadSample = (sampleKey: string) => post<SessionInfo>('/api/session/load', { sampleKey })

export const addObject = (sampleKey: string, points: Point[], box: Box | null) =>
  post<{ object: ObjectPayload }>('/api/session/objects', { sampleKey, points, box })

export const updatePrompts = (sampleKey: string, id: number, points: Point[], box: Box | null) =>
  put<{ object: ObjectPayload }>(`/api/session/objects/${id}/prompts`, { sampleKey, points, box })

export const patchObject = (sampleKey: string, id: number, body: { label?: string; shrink?: number }) =>
  patch<{ id: number; label: string; shrink: number }>(`/api/session/objects/${id}`, { sampleKey, ...body })

export const deleteObject = (sampleKey: string, id: number) =>
  del<{ deletedId: number }>(`/api/session/objects/${id}${q({ sampleKey })}`)

export const suggestBorders = (sampleKey: string) =>
  post<{ shrinks: Record<string, number> }>(`/api/session/suggest-borders${q({ sampleKey })}`)

export const resetObjectMask = (sampleKey: string, id: number) =>
  post<{ object: ObjectPayload }>(`/api/session/objects/${id}/reset-mask${q({ sampleKey })}`)

export const syncMasks = (sampleKey: string, masks: MaskUpload[]) =>
  post<{ ok: boolean; count: number }>('/api/session/masks', { sampleKey, masks })

export const saveSession = (
  sampleKey: string,
  opts: { complete: boolean; forceOverwrite?: boolean; masks?: MaskUpload[] },
) => post<SaveResult>('/api/session/save', { sampleKey, ...opts })

export const skipSession = () => post<{ nextSampleKey: string | null }>('/api/session/skip')

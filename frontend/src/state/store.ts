/**
 * Zustand store — single source of truth for the curation UI.
 *
 * Ownership split
 * ---------------
 * Server: sample load, SAM, OCR, shrink metadata, ENVI export, progress.json
 * Client: brush painting (`localMasks`), undo stacks, tool/brush UI state
 *
 * Flow: `init` → load session → edit seeds/masks locally → sync or save.
 * `masksDirty` means local brush edits are ahead of the server; sync before
 * operations that re-run SAM or before Save.
 *
 * `displayIndex` vs `maskIndex`: see `api/client.ts` and backend Session docs.
 */
import { create } from 'zustand'
import type { LeafInfo, Point, SessionPayload, VineInfo } from '../api/client'
import * as api from '../api/client'
import { OverwriteConflictError, StaleSampleError } from '../api/client'
import {
  MaskUndoStack,
  maskToPngBase64,
  pngBase64ToMask,
  type BrushMode,
} from '../canvas/brush'

export type ToolMode = 'seeds' | 'select' | 'brush'

/** Monotonic id so stale load/init responses cannot overwrite a newer folder. */
let loadRequestId = 0
/** Prevents React StrictMode / HMR remounts from re-running catalog bootstrap. */
let catalogBooted = false

const OVERLAY_COLOR_KEY = 'hsi.maskOverlayColor'
const OVERLAY_OPACITY_KEY = 'hsi.maskOverlayOpacity'
const DEFAULT_MASK_COLOR = '#3d9a6a'
const DEFAULT_MASK_OPACITY = 0.45

function readStoredColor(): string {
  try {
    const v = localStorage.getItem(OVERLAY_COLOR_KEY)
    if (v && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) return v
  } catch {
    /* ignore */
  }
  return DEFAULT_MASK_COLOR
}

function readStoredOpacity(): number {
  try {
    const v = Number(localStorage.getItem(OVERLAY_OPACITY_KEY))
    if (Number.isFinite(v)) return Math.min(1, Math.max(0.05, v))
  } catch {
    /* ignore */
  }
  return DEFAULT_MASK_OPACITY
}

type AppState = {
  vines: VineInfo[]
  vineType: string
  folder: string
  /** Latest server snapshot (labels, seeds, leaf meta). Null until first load. */
  session: SessionPayload | null
  /** Bumped when RGB should reload (new sample). */
  rgbCacheKey: number
  loading: boolean
  busy: boolean
  error: string | null
  /** Canvas interaction mode from the top-bar toggle. */
  toolMode: ToolMode
  brushMode: BrushMode
  brushSize: number
  selectedDisplayIndex: number | null
  /** Local editable masks keyed by maskIndex (not displayIndex). */
  localMasks: Record<number, Uint8Array>
  /** Original SAM masks keyed by maskIndex — border preview preserves brush additions. */
  samMasks: Record<number, Uint8Array>
  /**
   * Pixels explicitly painted by the brush (add). Border never fringes these.
   * Erase clears ownership. Keyed by maskIndex.
   */
  brushKeeps: Record<number, Uint8Array>
  /**
   * Bumped when mask bytes change in place so selectors on `localMasks[i]`
   * (e.g. LeafThumb) re-render even though the Uint8Array reference is reused.
   */
  maskRevisions: Record<number, number>
  undoStacks: Record<number, MaskUndoStack>
  /** True when brush strokes have not been POSTed to `/api/session/masks`. */
  masksDirty: boolean
  /**
   * Durable main folder label for the current vine. Survives sample advances,
   * session nulling during reload, and unrelated session snapshots. Cleared
   * only when the vine type changes (or the user clears the field).
   */
  mainFolderLabel: string
  /** In-progress leaf label drafts (flushed into Save even if debounce has not fired). */
  draftLeafLabels: Record<number, string>
  showPreview: boolean
  ndviThresh: number
  minDistance: number
  /** Suppresses main-canvas keybinds while LeafFullscreen is open. */
  leafEditorOpen: boolean
  /** Global mask overlay tint (hex). Applies to canvas, thumbs, fullscreen. */
  maskOverlayColor: string
  /** Global mask overlay opacity 0–1. */
  maskOverlayOpacity: number

  init: () => Promise<void>
  setVineType: (name: string) => Promise<void>
  setFolder: (folder: string) => Promise<void>
  reloadSession: () => Promise<void>
  /** Decode leaf PNGs into localMasks and reset undo (full session replace). */
  applySession: (s: SessionPayload) => Promise<boolean>
  setToolMode: (m: ToolMode) => void
  setBrushMode: (m: BrushMode) => void
  setBrushSize: (n: number) => void
  selectLeaf: (displayIndex: number | null) => void
  setSeeds: (seeds: Point[]) => Promise<void>
  resetSeeds: () => Promise<void>
  setLabels: (mainLabel: string, sublabels: string[]) => Promise<void>
  /** Patch one leaf label by displayIndex (rebuilds sublabels array for API). */
  setLeafLabel: (displayIndex: number, label: string) => Promise<void>
  setDraftLeafLabel: (displayIndex: number, label: string) => void
  setMainFolderLabel: (label: string) => void
  redetectOcr: () => Promise<void>
  setShrink: (displayIndex: number, shrink: number) => Promise<void>
  resuggestBorders: () => Promise<void>
  /** Snapshot mask for undo before the first stamp of a drag stroke. */
  beginStroke: (maskIndex: number) => void
  getMask: (maskIndex: number) => Uint8Array | null
  getSamMask: (maskIndex: number) => Uint8Array | null
  getBrushKeep: (maskIndex: number) => Uint8Array | null
  touchMask: (maskIndex: number) => void
  /** Undo last stroke on the selected leaf, or on ``maskIndex`` if given. */
  undo: (maskIndex?: number) => void
  redo: (maskIndex?: number) => void
  resetActiveMask: () => Promise<void>
  syncMasksToServer: () => Promise<void>
  /**
   * Export leaf crops.
   * ``complete`` true (default): mark Completed and advance to next pending.
   * ``complete`` false: mark Incomplete and stay on this sample.
   * ``forceOverwrite`` skips the overwrite confirm (used after the user accepts).
   */
  save: (opts?: { complete?: boolean; forceOverwrite?: boolean }) => Promise<void>
  /** Same as ``save({ complete: false })``. */
  saveIncomplete: () => Promise<void>
  skip: () => Promise<void>
  setShowPreview: (v: boolean) => void
  setNdvi: (v: number) => void
  setMinDistance: (v: number) => void
  setError: (e: string | null) => void
  setLeafEditorOpen: (v: boolean) => void
  setMaskOverlayColor: (hex: string) => void
  setMaskOverlayOpacity: (opacity: number) => void
}

/** Bumped on every brush edit so sync can tell if newer strokes arrived mid-upload. */
let maskEditEpoch = 0

async function hydrateMasks(
  leaves: LeafInfo[],
  width: number,
  height: number,
): Promise<{
  localMasks: Record<number, Uint8Array>
  samMasks: Record<number, Uint8Array>
  brushKeeps: Record<number, Uint8Array>
  undoStacks: Record<number, MaskUndoStack>
}> {
  const localMasks: Record<number, Uint8Array> = {}
  const samMasks: Record<number, Uint8Array> = {}
  const brushKeeps: Record<number, Uint8Array> = {}
  const undoStacks: Record<number, MaskUndoStack> = {}
  const n = width * height
  await Promise.all(
    leaves.map(async (leaf) => {
      localMasks[leaf.maskIndex] = await pngBase64ToMask(
        leaf.maskPngBase64,
        width,
        height,
      )
      // Fall back to edited mask if an older server omitted the SAM baseline.
      const samSrc = leaf.samMaskPngBase64 || leaf.maskPngBase64
      samMasks[leaf.maskIndex] = await pngBase64ToMask(samSrc, width, height)
      if (leaf.brushKeepPngBase64) {
        brushKeeps[leaf.maskIndex] = await pngBase64ToMask(
          leaf.brushKeepPngBase64,
          width,
          height,
        )
      } else {
        brushKeeps[leaf.maskIndex] = new Uint8Array(n)
      }
      undoStacks[leaf.maskIndex] = new MaskUndoStack()
    }),
  )
  return { localMasks, samMasks, brushKeeps, undoStacks }
}

export const useAppStore = create<AppState>((set, get) => ({
  vines: [],
  vineType: '',
  folder: '',
  session: null,
  rgbCacheKey: 0,
  loading: false,
  busy: false,
  error: null,
  toolMode: 'seeds',
  brushMode: 'add',
  brushSize: 14,
  selectedDisplayIndex: null,
  localMasks: {},
  samMasks: {},
  brushKeeps: {},
  maskRevisions: {},
  undoStacks: {},
  masksDirty: false,
  mainFolderLabel: '',
  draftLeafLabels: {},
  showPreview: false,
  ndviThresh: 0.4,
  minDistance: 30,
  leafEditorOpen: false,
  maskOverlayColor: readStoredColor(),
  maskOverlayOpacity: readStoredOpacity(),

  setError: (e) => set({ error: e }),
  setLeafEditorOpen: (v) => set({ leafEditorOpen: v }),

  setMaskOverlayColor: (hex) => {
    const next = hex.startsWith('#') ? hex : `#${hex}`
    try {
      localStorage.setItem(OVERLAY_COLOR_KEY, next)
    } catch {
      /* ignore */
    }
    set({ maskOverlayColor: next })
  },

  setMaskOverlayOpacity: (opacity) => {
    const next = Math.min(1, Math.max(0.05, opacity))
    try {
      localStorage.setItem(OVERLAY_OPACITY_KEY, String(next))
    } catch {
      /* ignore */
    }
    set({ maskOverlayOpacity: next })
  },

  init: async () => {
    // StrictMode mounts effects twice in dev; HMR remounts App when store.ts
    // changes. Do not bump loadRequestId here — that cancels an in-flight
    // Save→reload and can leave busy/loading stuck forever.
    if (catalogBooted) return
    catalogBooted = true
    // Another path (Save / folder change) already hydrated — only refresh catalog.
    if (get().session) {
      try {
        const vines = await api.fetchVines()
        set({ vines, loading: false, busy: false })
      } catch {
        set({ loading: false, busy: false })
      }
      return
    }
    set({ loading: true, error: null })
    try {
      const vines = await api.fetchVines()
      // Save may have loaded a sample while vines were in flight.
      if (get().session) {
        set({ vines, loading: false, busy: false })
        return
      }
      const first: VineInfo = vines.find((v) => v.folderCount > 0) ?? vines[0]
      if (!first) {
        set({ vines, loading: false, busy: false, error: 'No vine datasets configured' })
        return
      }
      // Prefer a folder Save already advanced to; otherwise first pending.
      const vineType = get().vineType || first.name
      const folder =
        get().folder || first.firstPending || first.folders[0]?.folder || ''
      set({ vines, vineType, folder })
      if (folder) await get().reloadSession()
      else set({ loading: false, busy: false })
    } catch (e) {
      if (get().session) {
        set({ loading: false, busy: false })
        return
      }
      set({ loading: false, busy: false, error: String(e) })
    }
  },

  applySession: async (s) => {
    // Capture generation before async hydrate so a newer folder load can cancel us.
    const gen = loadRequestId
    const folderAtStart = get().folder
    const vineAtStart = get().vineType
    const prevKey = get().session?.sampleKey ?? null
    const { localMasks, samMasks, brushKeeps, undoStacks } = await hydrateMasks(
      s.leaves,
      s.width,
      s.height,
    )
    if (gen !== loadRequestId) return false
    if (get().folder !== folderAtStart || get().vineType !== vineAtStart) return false

    const prevSel = get().selectedDisplayIndex
    const sampleChanged = prevKey !== s.sampleKey
    const nextSel =
      s.leaves.length === 0
        ? null
        : sampleChanged
          ? 0
          : prevSel != null && prevSel < s.leaves.length
            ? prevSel
            : 0
    maskEditEpoch = 0
    // Keep an established main folder label across sample advances; fill from
    // OCR/server only when we do not already have one (first sample / vine).
    const prevMain = get().mainFolderLabel.trim()
    const nextMain = prevMain || (s.mainLabel ?? '').trim()
    set({
      session: s,
      localMasks,
      samMasks,
      brushKeeps,
      undoStacks,
      maskRevisions: {},
      masksDirty: false,
      mainFolderLabel: nextMain,
      draftLeafLabels: {},
      rgbCacheKey: Date.now(),
      loading: false,
      busy: false,
      selectedDisplayIndex: nextSel,
      // New sample → start in Seeds mode (Complete ▶ / Skip / folder change).
      ...(sampleChanged ? { toolMode: 'seeds' as const } : {}),
    })
    return true
  },

  reloadSession: async () => {
    const { vineType, folder, ndviThresh, minDistance, mainFolderLabel } = get()
    if (!vineType || !folder) {
      set({ loading: false, busy: false })
      return
    }
    const requestId = ++loadRequestId
    const carryMain = mainFolderLabel.trim()
    // Block UI for the whole load+hydrate; clear session so we don't paint the old sample.
    // Do NOT clear mainFolderLabel — it is carried into the load request and kept for the UI.
    set({
      loading: true,
      busy: true,
      error: null,
      session: null,
      localMasks: {},
      samMasks: {},
      brushKeeps: {},
      maskRevisions: {},
      undoStacks: {},
      masksDirty: false,
      draftLeafLabels: {},
      selectedDisplayIndex: null,
    })
    try {
      const s = await api.loadSession(
        vineType,
        folder,
        ndviThresh,
        minDistance,
        carryMain || undefined,
      )
      // Superseded by a newer load/folder change — that request owns busy/loading.
      if (requestId !== loadRequestId) return
      const ok = await get().applySession(s)
      if (requestId !== loadRequestId) return
      if (!ok) {
        set({
          loading: false,
          busy: false,
          error: 'Failed to hydrate sample (load was interrupted)',
        })
      }
    } catch (e) {
      if (requestId !== loadRequestId) return
      set({ loading: false, busy: false, error: String(e) })
    } finally {
      // Always drop the overlay when this generation finishes. Superseded loads
      // leave flags alone so the newer reloadSession owns them.
      if (requestId === loadRequestId && (get().loading || get().busy)) {
        set({ loading: false, busy: false })
      }
    }
  },

  setVineType: async (name) => {
    const vine = get().vines.find((v) => v.name === name)
    const folder = vine?.firstPending ?? vine?.folders[0]?.folder ?? ''
    // Do not bump loadRequestId here — reloadSession owns the generation so a
    // pre-increment cannot cancel hydrate without clearing the overlay.
    set({
      vineType: name,
      folder,
      session: null,
      localMasks: {},
      samMasks: {},
      brushKeeps: {},
      maskRevisions: {},
      undoStacks: {},
      masksDirty: false,
      mainFolderLabel: '',
      draftLeafLabels: {},
      selectedDisplayIndex: null,
      loading: true,
      busy: true,
      error: null,
    })
    if (folder) await get().reloadSession()
    else set({ loading: false, busy: false })
  },

  setFolder: async (folder) => {
    set({
      folder,
      session: null,
      localMasks: {},
      samMasks: {},
      brushKeeps: {},
      maskRevisions: {},
      undoStacks: {},
      masksDirty: false,
      draftLeafLabels: {},
      selectedDisplayIndex: null,
      loading: true,
      busy: true,
      error: null,
    })
    await get().reloadSession()
  },

  setToolMode: (m) => set({ toolMode: m }),
  setBrushMode: (m) => set({ brushMode: m }),
  setBrushSize: (n) => set({ brushSize: Math.max(2, Math.min(60, n)) }),
  selectLeaf: (displayIndex) => set({ selectedDisplayIndex: displayIndex }),
  setNdvi: (v) => set({ ndviThresh: v }),
  setMinDistance: (v) => set({ minDistance: v }),
  setShowPreview: (v) => set({ showPreview: v }),

  setSeeds: async (seeds) => {
    const gen = loadRequestId
    const sampleKey = get().session?.sampleKey
    set({ busy: true, error: null })
    try {
      if (get().masksDirty) await get().syncMasksToServer()
      if (gen !== loadRequestId) return
      const s = await api.updateSeeds(seeds, true, sampleKey)
      if (gen !== loadRequestId) return
      await get().applySession(s)
    } catch (e) {
      if (gen !== loadRequestId) return
      set({
        error: e instanceof StaleSampleError ? null : String(e),
      })
    } finally {
      // Never leave busy stuck after a cancelled/stale seed update.
      if (gen === loadRequestId && !get().loading && get().busy) {
        set({ busy: false })
      }
    }
  },

  resetSeeds: async () => {
    const gen = loadRequestId
    const sampleKey = get().session?.sampleKey
    set({ busy: true, error: null })
    try {
      const { ndviThresh, minDistance } = get()
      const s = await api.resetSeeds(ndviThresh, minDistance, sampleKey)
      if (gen !== loadRequestId) return
      await get().applySession(s)
    } catch (e) {
      if (gen !== loadRequestId) return
      set({
        error: e instanceof StaleSampleError ? null : String(e),
      })
    } finally {
      if (gen === loadRequestId && !get().loading && get().busy) {
        set({ busy: false })
      }
    }
  },

  setLabels: async (mainLabel, sublabels) => {
    const gen = loadRequestId
    const sampleKey = get().session?.sampleKey
    const trimmed = mainLabel.trim()
    set({ mainFolderLabel: trimmed })
    try {
      const s = await api.updateOcr({ mainLabel: trimmed, sublabels, sampleKey })
      if (gen !== loadRequestId) return
      if (get().session?.sampleKey !== sampleKey) return
      const prev = get().localMasks
      set({
        session: s,
        // Keep in-memory brush edits; only metadata (labels) changed.
        localMasks: prev,
        mainFolderLabel: trimmed || get().mainFolderLabel,
      })
    } catch (e) {
      if (gen !== loadRequestId || e instanceof StaleSampleError) return
      set({ error: String(e) })
    }
  },

  setLeafLabel: async (displayIndex, label) => {
    const session = get().session
    if (!session) return
    const n = session.leaves.length
    const drafts = get().draftLeafLabels
    const sublabels = Array.from({ length: n }, (_, i) => {
      if (i === displayIndex) return label.trim()
      if (drafts[i] != null) return drafts[i]
      return session.sublabels[i] ?? session.leaves[i]?.label ?? ''
    })
    const main = get().mainFolderLabel.trim() || session.mainLabel
    await get().setLabels(main, sublabels)
  },

  setMainFolderLabel: (label) => set({ mainFolderLabel: label }),
  setDraftLeafLabel: (displayIndex, label) =>
    set({
      draftLeafLabels: { ...get().draftLeafLabels, [displayIndex]: label },
    }),

  redetectOcr: async () => {
    const gen = loadRequestId
    const sampleKey = get().session?.sampleKey
    set({ busy: true })
    try {
      const s = await api.updateOcr({ redetect: true, sampleKey })
      if (gen !== loadRequestId) return
      await get().applySession(s)
      if (gen === loadRequestId) {
        set({ mainFolderLabel: (s.mainLabel ?? '').trim() })
      }
    } catch (e) {
      if (gen !== loadRequestId) return
      set({
        error: e instanceof StaleSampleError ? null : String(e),
      })
    } finally {
      if (gen === loadRequestId && !get().loading && get().busy) {
        set({ busy: false })
      }
    }
  },

  setShrink: async (displayIndex, shrink) => {
    const gen = loadRequestId
    const sampleKey = get().session?.sampleKey
    const nextShrink = Math.max(0, Math.min(50, Math.round(shrink)))
    // Optimistic: keep main canvas / rail in sync while the API round-trip runs.
    const cur = get().session
    if (cur?.leaves[displayIndex]) {
      const leaves = cur.leaves.map((l) =>
        l.displayIndex === displayIndex ? { ...l, shrink: nextShrink } : l,
      )
      set({ session: { ...cur, leaves } })
    }
    try {
      if (get().masksDirty) await get().syncMasksToServer()
      if (gen !== loadRequestId) return
      const s = await api.updateShrink({
        displayIndex,
        shrink: nextShrink,
        sampleKey,
      })
      if (gen !== loadRequestId) return
      if (get().session?.sampleKey !== sampleKey) return
      // Keep local masks; only update leaf metadata from server
      const { localMasks } = get()
      const leaves = s.leaves.map((leaf) =>
        leaf.displayIndex === displayIndex
          ? { ...leaf, shrink: nextShrink }
          : leaf,
      )
      set({
        session: { ...s, leaves },
        localMasks,
      })
      // Refresh mask png from server only if we don't have local
      const missing = leaves.filter((l) => !localMasks[l.maskIndex])
      if (missing.length) {
        const { width, height } = s
        const next = { ...localMasks }
        for (const leaf of missing) {
          next[leaf.maskIndex] = await pngBase64ToMask(
            leaf.maskPngBase64,
            width,
            height,
          )
        }
        if (gen !== loadRequestId) return
        if (get().session?.sampleKey !== sampleKey) return
        set({ localMasks: next })
      }
    } catch (e) {
      if (gen !== loadRequestId || e instanceof StaleSampleError) return
      set({ error: String(e) })
    }
  },

  resuggestBorders: async () => {
    const gen = loadRequestId
    const sampleKey = get().session?.sampleKey
    set({ busy: true })
    try {
      if (get().masksDirty) await get().syncMasksToServer()
      if (gen !== loadRequestId) return
      const s = await api.updateShrink({ resuggest: true, sampleKey })
      if (gen !== loadRequestId) return
      await get().applySession(s)
    } catch (e) {
      if (gen !== loadRequestId) return
      set({
        error: e instanceof StaleSampleError ? null : String(e),
      })
    } finally {
      if (gen === loadRequestId && !get().loading && get().busy) {
        set({ busy: false })
      }
    }
  },

  beginStroke: (maskIndex) => {
    // Snapshot for undo before the first stamp of a drag.
    const mask = get().localMasks[maskIndex]
    if (!mask) return
    const keep = get().brushKeeps[maskIndex] ?? new Uint8Array(mask.length)
    const stacks = get().undoStacks
    const stack = stacks[maskIndex] ?? new MaskUndoStack()
    stack.push(mask, keep)
    maskEditEpoch += 1
    set({
      undoStacks: { ...stacks, [maskIndex]: stack },
      brushKeeps: { ...get().brushKeeps, [maskIndex]: keep },
      masksDirty: true,
    })
  },

  getMask: (maskIndex) => get().localMasks[maskIndex] ?? null,
  getSamMask: (maskIndex) => get().samMasks[maskIndex] ?? null,
  getBrushKeep: (maskIndex) => get().brushKeeps[maskIndex] ?? null,

  touchMask: (maskIndex) => {
    // Mask / brushKeep bytes mutate in place; bump revision so selectors re-render.
    maskEditEpoch += 1
    const rev = (get().maskRevisions[maskIndex] ?? 0) + 1
    set({
      localMasks: { ...get().localMasks, [maskIndex]: get().localMasks[maskIndex] },
      brushKeeps: { ...get().brushKeeps, [maskIndex]: get().brushKeeps[maskIndex] },
      maskRevisions: { ...get().maskRevisions, [maskIndex]: rev },
      masksDirty: true,
    })
  },

  undo: (maskIndex) => {
    const { session, selectedDisplayIndex, localMasks, brushKeeps, undoStacks } =
      get()
    if (!session) return
    const leaf =
      maskIndex != null
        ? session.leaves.find((l) => l.maskIndex === maskIndex)
        : selectedDisplayIndex != null
          ? session.leaves[selectedDisplayIndex]
          : undefined
    if (!leaf) return
    const stack = undoStacks[leaf.maskIndex]
    const cur = localMasks[leaf.maskIndex]
    const curKeep = brushKeeps[leaf.maskIndex] ?? new Uint8Array(cur?.length ?? 0)
    if (!stack || !cur) return
    const prev = stack.undoOnce(cur, curKeep)
    if (!prev) return
    maskEditEpoch += 1
    const rev = (get().maskRevisions[leaf.maskIndex] ?? 0) + 1
    set({
      localMasks: { ...localMasks, [leaf.maskIndex]: prev.mask },
      brushKeeps: { ...brushKeeps, [leaf.maskIndex]: prev.brushKeep },
      maskRevisions: { ...get().maskRevisions, [leaf.maskIndex]: rev },
      undoStacks: { ...undoStacks },
      masksDirty: true,
    })
  },

  redo: (maskIndex) => {
    const { session, selectedDisplayIndex, localMasks, brushKeeps, undoStacks } =
      get()
    if (!session) return
    const leaf =
      maskIndex != null
        ? session.leaves.find((l) => l.maskIndex === maskIndex)
        : selectedDisplayIndex != null
          ? session.leaves[selectedDisplayIndex]
          : undefined
    if (!leaf) return
    const stack = undoStacks[leaf.maskIndex]
    const cur = localMasks[leaf.maskIndex]
    const curKeep = brushKeeps[leaf.maskIndex] ?? new Uint8Array(cur?.length ?? 0)
    if (!stack || !cur) return
    const next = stack.redoOnce(cur, curKeep)
    if (!next) return
    maskEditEpoch += 1
    const rev = (get().maskRevisions[leaf.maskIndex] ?? 0) + 1
    set({
      localMasks: { ...localMasks, [leaf.maskIndex]: next.mask },
      brushKeeps: { ...brushKeeps, [leaf.maskIndex]: next.brushKeep },
      maskRevisions: { ...get().maskRevisions, [leaf.maskIndex]: rev },
      undoStacks: { ...undoStacks },
      masksDirty: true,
    })
  },

  resetActiveMask: async () => {
    const { session, selectedDisplayIndex } = get()
    if (!session || selectedDisplayIndex == null) return
    const leaf = session.leaves[selectedDisplayIndex]
    if (!leaf) return
    const gen = loadRequestId
    const sampleKey = session.sampleKey
    const maskIndex = leaf.maskIndex
    set({ busy: true })
    try {
      const s = await api.resetMask(maskIndex, sampleKey)
      if (gen !== loadRequestId) return
      if (get().session?.sampleKey !== sampleKey) return
      const leafResp = s.leaves.find((l) => l.maskIndex === maskIndex)
      if (!leafResp) {
        set({ error: 'Reset mask: leaf missing from server response' })
        return
      }
      const mask = await pngBase64ToMask(
        leafResp.maskPngBase64,
        s.width,
        s.height,
      )
      const samSrc = leafResp.samMaskPngBase64 || leafResp.maskPngBase64
      const sam = await pngBase64ToMask(samSrc, s.width, s.height)
      if (gen !== loadRequestId) return
      if (get().session?.sampleKey !== sampleKey) return
      const stacks = { ...get().undoStacks }
      stacks[maskIndex]?.clear()
      const rev = (get().maskRevisions[maskIndex] ?? 0) + 1
      // Keep masksDirty if other leaves still have unsynced brush edits.
      set({
        session: s,
        localMasks: { ...get().localMasks, [maskIndex]: mask },
        samMasks: { ...get().samMasks, [maskIndex]: sam },
        brushKeeps: {
          ...get().brushKeeps,
          [maskIndex]: new Uint8Array(s.width * s.height),
        },
        maskRevisions: { ...get().maskRevisions, [maskIndex]: rev },
        undoStacks: stacks,
      })
    } catch (e) {
      if (gen !== loadRequestId) return
      set({
        error: e instanceof StaleSampleError ? null : String(e),
      })
    } finally {
      if (gen === loadRequestId && !get().loading && get().busy) {
        set({ busy: false })
      }
    }
  },

  syncMasksToServer: async () => {
    const { session, localMasks, brushKeeps, masksDirty } = get()
    if (!session || !masksDirty) return
    const gen = loadRequestId
    const sampleKey = session.sampleKey
    const epochAtStart = maskEditEpoch
    const payload = []
    for (const leaf of session.leaves) {
      const m = localMasks[leaf.maskIndex]
      if (!m) continue
      const b64 = await maskToPngBase64(m, session.width, session.height)
      const keep = brushKeeps[leaf.maskIndex]
      const keepB64 = keep
        ? await maskToPngBase64(keep, session.width, session.height)
        : undefined
      payload.push({
        maskIndex: leaf.maskIndex,
        maskPngBase64: b64,
        ...(keepB64 ? { brushKeepPngBase64: keepB64 } : {}),
      })
    }
    if (!payload.length) return
    if (gen !== loadRequestId) return
    if (get().session?.sampleKey !== sampleKey) return
    try {
      const s = await api.pushMasks(payload, sampleKey)
      if (gen !== loadRequestId) return
      if (get().session?.sampleKey !== sampleKey) return
      // Only clear dirty if no newer strokes arrived while we were uploading.
      set({
        session: s,
        masksDirty: maskEditEpoch !== epochAtStart,
      })
    } catch (e) {
      if (e instanceof StaleSampleError) return
      throw e
    }
  },

  save: async (opts) => {
    const complete = opts?.complete !== false
    let forceOverwrite = opts?.forceOverwrite === true
    const { session, localMasks, brushKeeps, vineType, mainFolderLabel, draftLeafLabels } =
      get()
    if (!session) return
    const sampleKey = session.sampleKey
    const mainLabel = mainFolderLabel.trim()
    set({ busy: true, error: null, mainFolderLabel: mainLabel })
    try {
      const masks = []
      for (const leaf of session.leaves) {
        const m = localMasks[leaf.maskIndex]
        if (!m) continue
        const keep = brushKeeps[leaf.maskIndex]
        masks.push({
          maskIndex: leaf.maskIndex,
          maskPngBase64: await maskToPngBase64(m, session.width, session.height),
          ...(keep
            ? {
                brushKeepPngBase64: await maskToPngBase64(
                  keep,
                  session.width,
                  session.height,
                ),
              }
            : {}),
        })
      }
      const sublabels = session.leaves.map(
        (l, i) => draftLeafLabels[i] ?? l.label ?? session.sublabels[i] ?? '',
      )
      const body = {
        mainLabel,
        sublabels,
        shrinks: session.leaves.map((l) => l.shrink),
        masks,
        sampleKey,
        complete,
        forceOverwrite,
      }

      let result: Awaited<ReturnType<typeof api.saveSession>>
      try {
        result = await api.saveSession(body)
      } catch (e) {
        if (!(e instanceof OverwriteConflictError)) throw e
        const listed =
          e.labels.length > 0
            ? `\n\n${e.labels.slice(0, 12).join(', ')}${
                e.labels.length > 12 ? `, … (+${e.labels.length - 12} more)` : ''
              }`
            : ''
        const ok = window.confirm(
          `Export folders already exist for this sample.${listed}\n\nOverwrite the existing image files?`,
        )
        if (!ok) {
          set({ busy: false, loading: false })
          return
        }
        forceOverwrite = true
        result = await api.saveSession({ ...body, forceOverwrite: true })
      }

      const vines = await api.fetchVines()
      if (!complete || !result.nextFolder) {
        const cur = get().session
        set({
          vines,
          masksDirty: false,
          mainFolderLabel: mainLabel,
          draftLeafLabels: {},
          busy: false,
          loading: false,
          ...(cur?.sampleKey === sampleKey
            ? {
                session: {
                  ...cur,
                  status: result.status,
                  mainLabel,
                  sublabels,
                },
              }
            : {}),
        })
        return
      }
      set({
        vines,
        masksDirty: false,
        mainFolderLabel: mainLabel,
        draftLeafLabels: {},
        vineType: result.vineType || vineType,
        folder: result.nextFolder,
        toolMode: 'seeds',
      })
      // reloadSession owns busy/loading until the next sample is hydrated.
      await get().reloadSession()
    } catch (e) {
      if (e instanceof StaleSampleError) {
        set({ error: 'Sample changed — reloading…' })
        await get().reloadSession()
        return
      }
      set({
        busy: false,
        loading: false,
        error: String(e),
      })
    } finally {
      const st = get()
      if (st.session || !st.loading) {
        if (st.busy || st.loading) set({ busy: false, loading: false })
      }
    }
  },

  saveIncomplete: async () => {
    await get().save({ complete: false })
  },

  skip: async () => {
    const { vineType } = get()
    set({ busy: true, error: null })
    try {
      const result = await api.skipSession()
      const vines = await api.fetchVines()
      if (!result.nextFolder) {
        set({ vines, busy: false, loading: false })
        return
      }
      set({
        vines,
        vineType: result.vineType || vineType,
        folder: result.nextFolder,
        toolMode: 'seeds',
      })
      await get().reloadSession()
    } catch (e) {
      set({ busy: false, loading: false, error: String(e) })
    } finally {
      const st = get()
      if (st.session || !st.loading) {
        if (st.busy || st.loading) set({ busy: false, loading: false })
      }
    }
  },
}))
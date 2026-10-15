/**
 * State of the image being segmented: its objects, the active tool, brush
 * edits and undo, and the save/skip flow.
 *
 * Masks are full-resolution `Uint8Array`s (0/255) owned by the browser while
 * you paint. They are sent to the server only when saving (or when it needs
 * them), and the server only ever sends back the object that changed.
 *
 * `activeId` is the object that new points/boxes refine. With no active object,
 * the next point or box creates a new one.
 */
import { create } from 'zustand'
import {
  OverwriteConflictError,
  StaleImageError,
  addObject,
  deleteObject,
  loadSample,
  patchObject,
  resetObjectMask,
  saveSession,
  skipSession,
  suggestBorders,
  syncMasks,
  updatePrompts,
  type Box,
  type ObjectPayload,
  type Point,
  type SessionInfo,
} from '../api/client'
import {
  MaskUndoStack,
  cloneMask,
  createMask,
  maskToPngBase64,
  pngBase64ToMask,
  type BrushMode,
} from '../canvas/brush'
import { useWorkspace } from './workspace'

export type Tool = 'point' | 'box' | 'select' | 'brush'

export type EditObject = {
  id: number
  label: string
  shrink: number
  points: Point[]
  box: Box | null
  centroid: { x: number; y: number } | null
  mask: Uint8Array
  sam: Uint8Array
  keep: Uint8Array
  undo: MaskUndoStack
  /** Brush edits not yet sent to the server. */
  needsSync: boolean
  /** Mask differs from the SAM result (brush used). */
  edited: boolean
}

type ImageMeta = Omit<SessionInfo, 'objects'>

type EditorState = {
  image: ImageMeta | null
  objects: EditObject[]
  revs: Record<number, number>
  activeId: number | null
  tool: Tool
  brushMode: BrushMode
  brushSize: number
  emphasize: boolean
  rgbKey: number
  loading: boolean
  busy: boolean
  saving: boolean
  dirty: boolean

  openSample: (key: string, opts?: { force?: boolean }) => Promise<boolean>
  closeImage: () => void
  setTool: (t: Tool) => void
  setBrushMode: (m: BrushMode) => void
  setBrushSize: (n: number) => void
  setEmphasize: (v: boolean) => void
  select: (id: number | null) => void
  newObject: () => void

  placePrompt: (p: { point?: Point; box?: Box }) => Promise<void>
  removeLastPrompt: () => Promise<void>
  removePoint: (index: number) => Promise<void>
  removeObject: (id: number) => Promise<void>
  setLabel: (id: number, label: string) => void
  setShrink: (id: number, shrink: number) => void
  suggestBorders: () => Promise<void>
  resetMask: (id: number) => Promise<void>

  beginStroke: (id: number) => void
  touchMask: (id: number) => void
  undoBrush: (id?: number) => void
  redoBrush: (id?: number) => void

  flushPending: () => Promise<void>
  save: (complete: boolean) => Promise<void>
  skip: () => Promise<void>
}

let loadSeq = 0
const labelTimers = new Map<number, ReturnType<typeof setTimeout>>()
const shrinkTimers = new Map<number, ReturnType<typeof setTimeout>>()
const inflight = new Set<Promise<unknown>>()

const ws = () => useWorkspace.getState()
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function track<T>(p: Promise<T>): Promise<T> {
  inflight.add(p)
  const done = () => inflight.delete(p)
  p.then(done, done)
  return p
}

async function hydrate(p: ObjectPayload, w: number, h: number, prev?: EditObject): Promise<EditObject> {
  const [mask, sam, keep] = await Promise.all([
    p.maskPngBase64 ? pngBase64ToMask(p.maskPngBase64, w, h) : createMask(w, h),
    p.samMaskPngBase64 ? pngBase64ToMask(p.samMaskPngBase64, w, h) : createMask(w, h),
    p.brushKeepPngBase64 ? pngBase64ToMask(p.brushKeepPngBase64, w, h) : createMask(w, h),
  ])
  const undo = prev?.undo ?? new MaskUndoStack()
  undo.clear()
  return {
    id: p.id,
    label: prev ? prev.label : p.label,
    shrink: p.shrink,
    points: p.points,
    box: p.box,
    centroid: p.centroid,
    mask,
    sam,
    keep,
    undo,
    needsSync: false,
    edited: false,
  }
}

export const useEditor = create<EditorState>((set, get) => {
  const bump = (id: number) => set((s) => ({ revs: { ...s.revs, [id]: (s.revs[id] ?? 0) + 1 } }))
  const replace = (obj: EditObject) =>
    set((s) => ({
      objects: s.objects.map((o) => (o.id === obj.id ? obj : o)),
      revs: { ...s.revs, [obj.id]: (s.revs[obj.id] ?? 0) + 1 },
    }))
  const patchLocal = (id: number, fields: Partial<EditObject>) =>
    set((s) => ({ objects: s.objects.map((o) => (o.id === id ? { ...o, ...fields } : o)) }))
  const key = () => get().image?.sampleKey ?? ''

  /** Run a server call and drop the result if another image was opened meanwhile. */
  async function guarded<T>(fn: (sampleKey: string) => Promise<T>): Promise<T | undefined> {
    const k = key()
    const seq = loadSeq
    try {
      const result = await track(fn(k))
      return seq === loadSeq ? result : undefined
    } catch (e) {
      if (seq !== loadSeq) return undefined
      if (e instanceof StaleImageError) return undefined
      throw e
    }
  }

  return {
    image: null,
    objects: [],
    revs: {},
    activeId: null,
    tool: 'point',
    brushMode: 'add',
    brushSize: 12,
    emphasize: false,
    rgbKey: 0,
    loading: false,
    busy: false,
    saving: false,
    dirty: false,

    openSample: async (sampleKey, opts) => {
      const st = get()
      if (!opts?.force && st.dirty && st.objects.length > 0) {
        const ok = await ws().confirm({
          title: 'Leave this image?',
          body: 'You have objects on this image that have not been saved. They will be lost.',
          okLabel: 'Discard and open',
          danger: true,
        })
        if (!ok) return false
      }
      const seq = ++loadSeq
      labelTimers.forEach(clearTimeout)
      shrinkTimers.forEach(clearTimeout)
      labelTimers.clear()
      shrinkTimers.clear()
      set({ loading: true })
      try {
        const info = await loadSample(sampleKey)
        if (seq !== loadSeq) return false
        const { objects: payloads, ...meta } = info
        const objects = await Promise.all(payloads.map((p) => hydrate(p, meta.width, meta.height)))
        if (seq !== loadSeq) return false
        set({
          image: meta,
          objects,
          revs: {},
          activeId: null,
          dirty: false,
          rgbKey: Date.now(),
          loading: false,
        })
        return true
      } catch (e) {
        if (seq === loadSeq) {
          set({ loading: false })
          ws().toast('error', errText(e))
        }
        return false
      }
    },

    closeImage: () => {
      loadSeq++
      set({ image: null, objects: [], revs: {}, activeId: null, dirty: false, loading: false })
    },

    setTool: (tool) => set({ tool }),
    setBrushMode: (brushMode) => set({ brushMode, tool: 'brush' }),
    setBrushSize: (n) => set({ brushSize: Math.max(2, Math.min(60, Math.round(n))) }),
    setEmphasize: (emphasize) => set({ emphasize }),
    select: (activeId) => set({ activeId }),
    newObject: () => set({ activeId: null, tool: get().tool === 'brush' || get().tool === 'select' ? 'point' : get().tool }),

    placePrompt: async ({ point, box }) => {
      const st = get()
      if (!st.image || st.busy || st.loading) return
      const active = st.objects.find((o) => o.id === st.activeId) ?? null

      if (!active && point && point.label === 0) {
        ws().toast('info', 'Click on the object first (a green include point), then use right-click to exclude areas.')
        return
      }
      if (active?.edited) {
        const ok = await ws().confirm({
          title: 'Redo this object?',
          body: 'Changing the points will re-run the segmentation and discard your brush edits on this object.',
          okLabel: 'Redo object',
          danger: true,
        })
        if (!ok) return
      }

      set({ busy: true })
      try {
        if (active) {
          const points = point ? [...active.points, point] : active.points
          const nextBox = box ?? active.box
          const r = await guarded((k) => updatePrompts(k, active.id, points, nextBox))
          if (r) {
            const obj = await hydrate(r.object, st.image.width, st.image.height, active)
            replace(obj)
            set({ dirty: true })
          }
        } else {
          const r = await guarded((k) => addObject(k, point ? [point] : [], box ?? null))
          if (r) {
            const obj = await hydrate(r.object, st.image.width, st.image.height)
            set((s) => ({ objects: [...s.objects, obj], activeId: obj.id, dirty: true }))
          }
        }
      } catch (e) {
        ws().toast('error', errText(e))
      } finally {
        set({ busy: false })
      }
    },

    removeLastPrompt: async () => {
      const active = get().objects.find((o) => o.id === get().activeId)
      if (!active) return
      if (active.points.length) await get().removePoint(active.points.length - 1)
      else await get().removeObject(active.id)
    },

    removePoint: async (index) => {
      const st = get()
      const active = st.objects.find((o) => o.id === st.activeId)
      if (!active || st.busy || !st.image) return
      const points = active.points.filter((_, i) => i !== index)
      if (!points.length && !active.box) {
        await get().removeObject(active.id)
        return
      }
      if (points.length && !points.some((p) => p.label === 1) && !active.box) {
        ws().toast('info', 'An object needs at least one include point (or a box).')
        return
      }
      set({ busy: true })
      try {
        const r = await guarded((k) => updatePrompts(k, active.id, points, active.box))
        if (r) replace(await hydrate(r.object, st.image.width, st.image.height, active))
      } catch (e) {
        ws().toast('error', errText(e))
      } finally {
        set({ busy: false })
      }
    },

    removeObject: async (id) => {
      try {
        await guarded((k) => deleteObject(k, id))
        labelTimers.delete(id)
        set((s) => ({
          objects: s.objects.filter((o) => o.id !== id),
          activeId: s.activeId === id ? null : s.activeId,
          dirty: true,
        }))
      } catch (e) {
        ws().toast('error', errText(e))
      }
    },

    setLabel: (id, label) => {
      patchLocal(id, { label })
      set({ dirty: true })
      clearTimeout(labelTimers.get(id))
      labelTimers.set(
        id,
        setTimeout(() => {
          labelTimers.delete(id)
          void guarded((k) => patchObject(k, id, { label })).catch((e) => ws().toast('error', errText(e)))
        }, 300),
      )
    },

    setShrink: (id, shrink) => {
      patchLocal(id, { shrink })
      set({ dirty: true })
      bump(id)
      clearTimeout(shrinkTimers.get(id))
      shrinkTimers.set(
        id,
        setTimeout(() => {
          shrinkTimers.delete(id)
          void guarded((k) => patchObject(k, id, { shrink })).catch((e) => ws().toast('error', errText(e)))
        }, 150),
      )
    },

    suggestBorders: async () => {
      try {
        // Pending edits must reach the server first: it measures the *edited* masks.
        await get().flushPending()
        const r = await guarded((k) => suggestBorders(k))
        if (!r) return
        set((s) => ({
          objects: s.objects.map((o) => ({ ...o, shrink: r.shrinks[String(o.id)] ?? o.shrink })),
          revs: Object.fromEntries(s.objects.map((o) => [o.id, (s.revs[o.id] ?? 0) + 1])),
          dirty: true,
        }))
      } catch (e) {
        ws().toast('error', errText(e))
      }
    },

    resetMask: async (id) => {
      const o = get().objects.find((x) => x.id === id)
      if (!o) return
      patchLocal(id, { mask: cloneMask(o.sam), keep: createMask(o.sam.length, 1), needsSync: false, edited: false })
      o.undo.clear()
      bump(id)
      try {
        await guarded((k) => resetObjectMask(k, id))
      } catch (e) {
        ws().toast('error', errText(e))
      }
    },

    beginStroke: (id) => {
      const o = get().objects.find((x) => x.id === id)
      if (!o) return
      o.undo.push(o.mask, o.keep)
    },

    touchMask: (id) => {
      const o = get().objects.find((x) => x.id === id)
      if (o && (!o.needsSync || !o.edited)) patchLocal(id, { needsSync: true, edited: true })
      if (!get().dirty) set({ dirty: true })
      bump(id)
    },

    undoBrush: (idArg) => {
      const id = idArg ?? get().activeId
      const o = get().objects.find((x) => x.id === id)
      if (!o) return
      const snap = o.undo.undoOnce(o.mask, o.keep)
      if (!snap) return
      o.mask.set(snap.mask)
      o.keep.set(snap.brushKeep)
      patchLocal(o.id, { needsSync: true })
      bump(o.id)
    },

    redoBrush: (idArg) => {
      const id = idArg ?? get().activeId
      const o = get().objects.find((x) => x.id === id)
      if (!o) return
      const snap = o.undo.redoOnce(o.mask, o.keep)
      if (!snap) return
      o.mask.set(snap.mask)
      o.keep.set(snap.brushKeep)
      patchLocal(o.id, { needsSync: true })
      bump(o.id)
    },

    flushPending: async () => {
      // Fire any debounced label/shrink writes now, then wait for everything in flight.
      for (const [id, t] of labelTimers) {
        clearTimeout(t)
        labelTimers.delete(id)
        const label = get().objects.find((o) => o.id === id)?.label ?? ''
        void guarded((k) => patchObject(k, id, { label })).catch(() => undefined)
      }
      for (const [id, t] of shrinkTimers) {
        clearTimeout(t)
        shrinkTimers.delete(id)
        const shrink = get().objects.find((o) => o.id === id)?.shrink ?? 0
        void guarded((k) => patchObject(k, id, { shrink })).catch(() => undefined)
      }
      await Promise.allSettled([...inflight])
      const st = get()
      const dirtyObjs = st.objects.filter((o) => o.needsSync)
      if (!dirtyObjs.length || !st.image) return
      const w = st.image.width
      const h = st.image.height
      const masks = await Promise.all(
        dirtyObjs.map(async (o) => ({
          objectId: o.id,
          maskPngBase64: await maskToPngBase64(o.mask, w, h),
          brushKeepPngBase64: await maskToPngBase64(o.keep, w, h),
        })),
      )
      await guarded((k) => syncMasks(k, masks))
      const sent = new Set(dirtyObjs.map((o) => o.id))
      set((s) => ({ objects: s.objects.map((o) => (sent.has(o.id) ? { ...o, needsSync: false } : o)) }))
    },

    save: async (complete) => {
      const st = get()
      if (!st.image || st.saving) return
      if (!st.objects.length) {
        ws().toast('info', 'Add at least one object before saving.')
        return
      }
      set({ saving: true })
      try {
        await get().flushPending()
        const run = (force: boolean) => guarded((k) => saveSession(k, { complete, forceOverwrite: force }))
        let result
        try {
          result = await run(false)
        } catch (e) {
          if (!(e instanceof OverwriteConflictError)) throw e
          const ok = await ws().confirm({
            title: 'Replace existing files?',
            body: `These files already exist in the output folder and will be replaced: ${e.names.slice(0, 6).join(', ')}${e.names.length > 6 ? '…' : ''}`,
            okLabel: 'Replace',
            danger: true,
          })
          if (!ok) return
          result = await run(true)
        }
        if (!result) return
        set({ dirty: false })
        await ws().refreshSamples()
        ws().toast('success', `Saved ${result.savedCount} object${result.savedCount === 1 ? '' : 's'} to ${result.outputDir}`)
        if (complete) {
          if (result.nextSampleKey) await get().openSample(result.nextSampleKey, { force: true })
          else {
            ws().toast('success', 'All images are done. 🎉')
            get().closeImage()
          }
        } else {
          set((s) => (s.image ? { image: { ...s.image, status: result.status } } : {}))
        }
      } catch (e) {
        ws().toast('error', errText(e))
      } finally {
        set({ saving: false })
      }
    },

    skip: async () => {
      const st = get()
      if (!st.image || st.saving) return
      if (st.dirty && st.objects.length) {
        const ok = await ws().confirm({
          title: 'Skip this image?',
          body: 'Your unsaved objects on this image will be discarded.',
          okLabel: 'Skip image',
          danger: true,
        })
        if (!ok) return
      }
      try {
        const r = await track(skipSession())
        await ws().refreshSamples()
        if (r.nextSampleKey) await get().openSample(r.nextSampleKey, { force: true })
        else {
          ws().toast('info', 'No more images to do.')
          get().closeImage()
        }
      } catch (e) {
        ws().toast('error', errText(e))
      }
    },
  }
})


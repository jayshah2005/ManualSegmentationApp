/**
 * App-wide state that is not about the image being edited: saved settings, the
 * list of images, system/GPU status, which dialogs are open, toasts, confirms,
 * and the per-browser appearance preferences.
 */
import { create } from 'zustand'
import {
  fetchSamples,
  fetchSettings,
  fetchSystem,
  updateSettings,
  type DeepPartial,
  type SampleRow,
  type SampleStatus,
  type Settings,
  type SystemStatus,
} from '../api/client'

export type SettingsTab = 'folders' | 'engine' | 'display' | 'export' | 'appearance' | 'shortcuts'

export type Toast = { id: number; kind: 'error' | 'info' | 'success'; text: string }

export type ConfirmRequest = {
  title: string
  body: string
  okLabel: string
  cancelLabel?: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

// ---------- per-browser appearance (not part of the exported data) ----------

type Appearance = { maskColor: string; maskOpacity: number; exposure: number }
const APPEARANCE_KEY = 'segtool.appearance'
const DEFAULT_APPEARANCE: Appearance = { maskColor: '#3d9a6a', maskOpacity: 0.45, exposure: 1 }

function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY)
    if (raw) return { ...DEFAULT_APPEARANCE, ...JSON.parse(raw) }
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_APPEARANCE
}

function saveAppearance(a: Appearance) {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(a))
  } catch {
    /* ignore */
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// ---------- store ----------

type WorkspaceState = {
  booted: boolean
  bootError: string
  settings: Settings | null
  system: SystemStatus | null
  systemLoading: boolean
  samples: SampleRow[]
  counts: Partial<Record<SampleStatus, number>>
  firstPendingKey: string | null

  wizardOpen: boolean
  settingsOpen: boolean
  settingsTab: SettingsTab
  helpOpen: boolean
  imagesOpen: boolean

  toasts: Toast[]
  confirmRequest: ConfirmRequest | null
  appearance: Appearance

  boot: () => Promise<void>
  refreshSystem: () => Promise<SystemStatus | null>
  refreshSamples: (rescan?: boolean) => Promise<void>
  saveSettings: (patch: DeepPartial<Settings>) => Promise<Settings>

  openWizard: () => void
  closeWizard: () => void
  openSettings: (tab?: SettingsTab) => void
  closeSettings: () => void
  setHelpOpen: (open: boolean) => void
  setImagesOpen: (open: boolean) => void

  toast: (kind: Toast['kind'], text: string) => void
  dismissToast: (id: number) => void
  confirm: (req: Omit<ConfirmRequest, 'resolve'>) => Promise<boolean>
  answerConfirm: (ok: boolean) => void

  setMaskColor: (hex: string) => void
  setMaskOpacity: (v: number) => void
  setExposure: (v: number) => void
}

let toastSeq = 1

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  booted: false,
  bootError: '',
  settings: null,
  system: null,
  systemLoading: false,
  samples: [],
  counts: {},
  firstPendingKey: null,

  wizardOpen: false,
  settingsOpen: false,
  settingsTab: 'folders',
  helpOpen: false,
  imagesOpen: false,

  toasts: [],
  confirmRequest: null,
  appearance: loadAppearance(),

  boot: async () => {
    set({ bootError: '' })
    try {
      const settings = await fetchSettings()
      set({ settings, systemLoading: true })
      const system = await fetchSystem()
      set({ system, systemLoading: false })
      if (settings.inputDir) await get().refreshSamples()
      const needsSetup = !settings.inputDir || !settings.outputDir || !system.ready
      set({ booted: true, wizardOpen: needsSetup })
    } catch (e) {
      set({ bootError: e instanceof Error ? e.message : String(e), systemLoading: false })
    }
  },

  refreshSystem: async () => {
    set({ systemLoading: true })
    try {
      const system = await fetchSystem()
      set({ system, systemLoading: false })
      return system
    } catch (e) {
      set({ systemLoading: false })
      get().toast('error', e instanceof Error ? e.message : String(e))
      return null
    }
  },

  refreshSamples: async (rescan = false) => {
    try {
      const r = await fetchSamples(rescan)
      set({
        samples: r.samples,
        counts: r.counts,
        firstPendingKey: r.firstPendingKey ?? null,
      })
    } catch (e) {
      set({ samples: [], counts: {}, firstPendingKey: null })
      get().toast('error', e instanceof Error ? e.message : String(e))
    }
  },

  saveSettings: async (patch) => {
    const settings = await updateSettings(patch)
    set({ settings })
    if (patch.inputDir !== undefined || patch.outputDir !== undefined || patch.recursive !== undefined) {
      await get().refreshSamples(true)
    }
    if (patch.samModel !== undefined || patch.device !== undefined) {
      void get().refreshSystem()
    }
    return settings
  },

  openWizard: () => set({ wizardOpen: true, settingsOpen: false }),
  closeWizard: () => set({ wizardOpen: false }),
  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab ?? get().settingsTab }),
  closeSettings: () => set({ settingsOpen: false }),
  setHelpOpen: (open) => set({ helpOpen: open }),
  setImagesOpen: (open) => set({ imagesOpen: open }),

  toast: (kind, text) => {
    const id = toastSeq++
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }))
    if (kind !== 'error') setTimeout(() => get().dismissToast(id), 5000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  confirm: (req) =>
    new Promise<boolean>((resolve) => {
      get().confirmRequest?.resolve(false)
      set({ confirmRequest: { ...req, resolve } })
    }),
  answerConfirm: (ok) => {
    const req = get().confirmRequest
    set({ confirmRequest: null })
    req?.resolve(ok)
  },

  setMaskColor: (hex) => {
    const appearance = { ...get().appearance, maskColor: hex }
    saveAppearance(appearance)
    set({ appearance })
  },
  setMaskOpacity: (v) => {
    const appearance = { ...get().appearance, maskOpacity: clamp(v, 0.05, 1) }
    saveAppearance(appearance)
    set({ appearance })
  },
  setExposure: (v) => {
    const appearance = { ...get().appearance, exposure: clamp(Math.round(v * 20) / 20, 0.5, 3) }
    saveAppearance(appearance)
    set({ appearance })
  },
}))

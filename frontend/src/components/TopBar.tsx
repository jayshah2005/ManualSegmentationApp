/**
 * Top controls: vine/sample, main label, NDVI, tool radios (Seeds / Select /
 * Brush Add·Remove), and mask color. Per-leaf labels live on the right rail.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../state/store'

const LABEL_DEBOUNCE_MS = 300

export function TopBar() {
  const vines = useAppStore((s) => s.vines)
  const vineType = useAppStore((s) => s.vineType)
  const folder = useAppStore((s) => s.folder)
  const session = useAppStore((s) => s.session)
  const ndviThresh = useAppStore((s) => s.ndviThresh)
  const minDistance = useAppStore((s) => s.minDistance)
  const viewExposure = useAppStore((s) => s.viewExposure)
  const setViewExposure = useAppStore((s) => s.setViewExposure)
  const busy = useAppStore((s) => s.busy)
  const loading = useAppStore((s) => s.loading)
  const setVineType = useAppStore((s) => s.setVineType)
  const setFolder = useAppStore((s) => s.setFolder)
  const setNdvi = useAppStore((s) => s.setNdvi)
  const setMinDistance = useAppStore((s) => s.setMinDistance)
  const resetSeeds = useAppStore((s) => s.resetSeeds)
  const redetectOcr = useAppStore((s) => s.redetectOcr)
  const setLabels = useAppStore((s) => s.setLabels)
  const mainFolderLabel = useAppStore((s) => s.mainFolderLabel)
  const setMainFolderLabel = useAppStore((s) => s.setMainFolderLabel)
  const toolMode = useAppStore((s) => s.toolMode)
  const setToolMode = useAppStore((s) => s.setToolMode)
  const brushMode = useAppStore((s) => s.brushMode)
  const setBrushMode = useAppStore((s) => s.setBrushMode)
  const maskOverlayColor = useAppStore((s) => s.maskOverlayColor)
  const setMaskOverlayColor = useAppStore((s) => s.setMaskOverlayColor)
  const maskOverlayOpacity = useAppStore((s) => s.maskOverlayOpacity)
  const setMaskOverlayOpacity = useAppStore((s) => s.setMaskOverlayOpacity)

  const [maskPickerOpen, setMaskPickerOpen] = useState(false)
  const [maskPopoverPos, setMaskPopoverPos] = useState<{ top: number; left: number } | null>(
    null,
  )
  const maskSwatchRef = useRef<HTMLButtonElement | null>(null)
  const maskPopoverRef = useRef<HTMLDivElement | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingMainRef = useRef<string | null>(null)
  const dirtyRef = useRef(false)

  // Cancel in-flight main-label API flush when the sample changes so Save→next
  // cannot race a stale setLabels call against the new session.
  useEffect(() => {
    dirtyRef.current = false
    pendingMainRef.current = null
    if (debounceRef.current != null) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }, [session?.sampleKey])

  const updateMaskPopoverPos = useCallback(() => {
    const btn = maskSwatchRef.current
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    const width = 176
    const left = Math.min(
      Math.max(8, rect.right - width),
      window.innerWidth - width - 8,
    )
    setMaskPopoverPos({ top: rect.bottom + 6, left })
  }, [])

  useLayoutEffect(() => {
    if (!maskPickerOpen) {
      setMaskPopoverPos(null)
      return
    }
    updateMaskPopoverPos()
    window.addEventListener('resize', updateMaskPopoverPos)
    window.addEventListener('scroll', updateMaskPopoverPos, true)
    return () => {
      window.removeEventListener('resize', updateMaskPopoverPos)
      window.removeEventListener('scroll', updateMaskPopoverPos, true)
    }
  }, [maskPickerOpen, updateMaskPopoverPos])

  useEffect(() => {
    if (!maskPickerOpen) return
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (maskSwatchRef.current?.contains(t)) return
      if (maskPopoverRef.current?.contains(t)) return
      setMaskPickerOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMaskPickerOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [maskPickerOpen])

  const flushMain = useCallback(
    (main: string) => {
      if (debounceRef.current != null) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
      pendingMainRef.current = null
      if (!dirtyRef.current) return
      dirtyRef.current = false
      const sessionNow = useAppStore.getState().session
      const sublabels =
        sessionNow?.leaves.map((l) => l.label) ?? sessionNow?.sublabels ?? []
      void setLabels(main, sublabels)
    },
    [setLabels],
  )

  const scheduleFlush = useCallback(
    (main: string) => {
      dirtyRef.current = true
      pendingMainRef.current = main
      if (debounceRef.current != null) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        const pending = pendingMainRef.current
        if (pending == null) return
        flushMain(pending)
      }, LABEL_DEBOUNCE_MS)
    },
    [flushMain],
  )

  useEffect(() => {
    return () => {
      if (debounceRef.current != null) clearTimeout(debounceRef.current)
    }
  }, [])

  const vine = vines.find((v) => v.name === vineType)
  const progress = vine
    ? `${vine.completedCount}/${vine.folderCount}`
    : '—'
  const status = session?.status ?? '—'

  return (
    <header className="topbar">
      <div className="topbar-brand">HSI Leaf Curation</div>

      <label className="field">
        <span>Vine</span>
        <select
          value={vineType}
          disabled={busy || loading}
          onChange={(e) => void setVineType(e.target.value)}
        >
          {vines.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name}
            </option>
          ))}
        </select>
      </label>

      <label className="field field-grow">
        <span>Sample</span>
        <select
          value={folder}
          disabled={busy || loading || !vine}
          onChange={(e) => void setFolder(e.target.value)}
        >
          {(vine?.folders ?? []).map((f) => (
            <option key={f.folder} value={f.folder}>
              {f.folder} ({f.status})
            </option>
          ))}
        </select>
      </label>

      <div className="pill">
        <span className="pill-label">Progress</span>
        <strong>{progress}</strong>
      </div>
      <div className={`pill status-${status.toLowerCase()}`}>
        <span className="pill-label">Status</span>
        <strong>{status}</strong>
      </div>

      <label className="field">
        <span>Main</span>
        <input
          type="text"
          value={mainFolderLabel}
          placeholder="Main folder label"
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value
            setMainFolderLabel(next)
            scheduleFlush(next)
          }}
          onBlur={() => flushMain(mainFolderLabel)}
        />
      </label>

      <button type="button" className="btn ghost" disabled={busy} onClick={() => void redetectOcr()}>
        Re-OCR
      </button>

      <label
        className="field topbar-brightness"
        title="Display brightness only — does not change ENVI exports or SAM"
      >
        <span>
          Brightness <strong>{viewExposure.toFixed(1)}×</strong>
        </span>
        <input
          type="range"
          min={0.5}
          max={3}
          step={0.1}
          value={viewExposure}
          onChange={(e) => setViewExposure(Number(e.target.value))}
        />
      </label>
      <label className="field compact">
        <span>NDVI</span>
        <input
          type="number"
          min={0.1}
          max={0.8}
          step={0.05}
          value={ndviThresh}
          onChange={(e) => setNdvi(Number(e.target.value))}
        />
      </label>
      <label className="field compact">
        <span>MinDist</span>
        <input
          type="number"
          min={10}
          max={100}
          step={5}
          value={minDistance}
          onChange={(e) => setMinDistance(Number(e.target.value))}
        />
      </label>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => void resetSeeds()}>
        Reset seeds
      </button>

      <div className="tool-radios" role="radiogroup" aria-label="Tool mode">
        <label className={toolMode === 'seeds' ? 'tool-radio active' : 'tool-radio'}>
          <input
            type="radio"
            name="tool-mode"
            checked={toolMode === 'seeds'}
            onChange={() => setToolMode('seeds')}
          />
          <ToolIconSeeds />
          <span>Seeds</span>
        </label>
        <label className={toolMode === 'select' ? 'tool-radio active' : 'tool-radio'}>
          <input
            type="radio"
            name="tool-mode"
            checked={toolMode === 'select'}
            onChange={() => setToolMode('select')}
          />
          <ToolIconSelect />
          <span>Select</span>
        </label>
        <div className="tool-brush-group" role="presentation">
          <span className="tool-brush-label">Brush</span>
          <label
            className={
              toolMode === 'brush' && brushMode === 'add'
                ? 'tool-radio active tool-radio-add'
                : 'tool-radio'
            }
          >
            <input
              type="radio"
              name="tool-mode"
              checked={toolMode === 'brush' && brushMode === 'add'}
              onChange={() => {
                setBrushMode('add')
                setToolMode('brush')
              }}
            />
            <ToolIconAdd />
            <span>Add (A)</span>
          </label>
          <label
            className={
              toolMode === 'brush' && brushMode === 'erase'
                ? 'tool-radio active tool-radio-erase'
                : 'tool-radio'
            }
          >
            <input
              type="radio"
              name="tool-mode"
              checked={toolMode === 'brush' && brushMode === 'erase'}
              onChange={() => {
                setBrushMode('erase')
                setToolMode('brush')
              }}
            />
            <ToolIconErase />
            <span>Remove (D)</span>
          </label>
        </div>
      </div>

      <div className="field topbar-mask-color">
        <span>Mask</span>
        <button
          ref={maskSwatchRef}
          type="button"
          className="mask-swatch"
          title="Mask color & opacity"
          aria-label="Mask color and opacity"
          aria-expanded={maskPickerOpen}
          aria-haspopup="dialog"
          style={{
            backgroundColor: '#fff',
            backgroundImage: `linear-gradient(${hexToRgba(maskOverlayColor, maskOverlayOpacity)}, ${hexToRgba(maskOverlayColor, maskOverlayOpacity)})`,
          }}
          onClick={() => setMaskPickerOpen((o) => !o)}
        />
        {maskPickerOpen &&
          maskPopoverPos &&
          createPortal(
            <div
              ref={maskPopoverRef}
              className="mask-color-popover"
              role="dialog"
              aria-label="Mask color"
              style={{ top: maskPopoverPos.top, left: maskPopoverPos.left }}
            >
              <label className="mask-color-row">
                <span>Color</span>
                <input
                  type="color"
                  value={maskOverlayColor}
                  onChange={(e) => setMaskOverlayColor(e.target.value)}
                />
              </label>
              <label className="mask-color-row">
                <span>Opacity {Math.round(maskOverlayOpacity * 100)}%</span>
                <input
                  type="range"
                  min={5}
                  max={100}
                  value={Math.round(maskOverlayOpacity * 100)}
                  onChange={(e) => setMaskOverlayOpacity(Number(e.target.value) / 100)}
                />
              </label>
            </div>,
            document.body,
          )}
      </div>
    </header>
  )
}

function hexToRgba(hex: string, opacity: number): string {
  const h = hex.replace('#', '').trim()
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h.padEnd(6, '0').slice(0, 6)
  const n = Number.parseInt(full, 16)
  if (Number.isNaN(n)) return `rgba(61, 154, 106, ${opacity})`
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${opacity})`
}

function ToolIconSeeds() {
  return (
    <svg className="tool-icon" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="3.2" fill="currentColor" />
      <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function ToolIconSelect() {
  return (
    <svg className="tool-icon" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M3.2 2.4 L3.2 12.2 L6.1 9.6 L8.2 13.6 L9.8 12.8 L7.7 8.8 L11.4 8.8 Z"
        fill="currentColor"
      />
    </svg>
  )
}

function ToolIconAdd() {
  return (
    <svg className="tool-icon" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 5v6M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function ToolIconErase() {
  return (
    <svg className="tool-icon" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

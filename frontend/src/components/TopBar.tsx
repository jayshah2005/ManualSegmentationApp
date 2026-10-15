import type { ReactNode } from 'react'
import { useEditor, type Tool } from '../state/editor'
import { useWorkspace } from '../state/workspace'
import { IconBox, IconBrush, IconHelp, IconImages, IconPoint, IconSelect, IconSettings } from './Icons'

function ToolButton({ tool, label, keys, icon }: { tool: Tool; label: string; keys: string; icon: ReactNode }) {
  const current = useEditor((s) => s.tool)
  const setTool = useEditor((s) => s.setTool)
  return (
    <button type="button" className={current === tool ? 'tool active' : 'tool'} onClick={() => setTool(tool)} title={`${label} (${keys})`} aria-pressed={current === tool}>
      {icon}
      <span>{label}</span>
    </button>
  )
}

export function TopBar() {
  const image = useEditor((s) => s.image)
  const samples = useWorkspace((s) => s.samples)
  const counts = useWorkspace((s) => s.counts)
  const exposure = useWorkspace((s) => s.appearance.exposure)
  const setExposure = useWorkspace((s) => s.setExposure)
  const openSettings = useWorkspace((s) => s.openSettings)
  const setHelpOpen = useWorkspace((s) => s.setHelpOpen)
  const setImagesOpen = useWorkspace((s) => s.setImagesOpen)

  const total = samples.length
  const done = counts.Completed ?? 0
  const index = image ? samples.findIndex((s) => s.key === image.sampleKey) + 1 : 0

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden />
        Segmentation Tool
      </div>

      <button type="button" className="btn image-switch" onClick={() => setImagesOpen(true)} title="Choose another image">
        <IconImages />
        <span className="image-name">{image ? image.name : 'Choose an image'}</span>
        {image && index > 0 && <span className="muted">{index} / {total}</span>}
      </button>
      <span className="pill" title="Completed images">
        {done} of {total} done
      </span>

      <div className="tools" role="toolbar" aria-label="Tools">
        <ToolButton tool="point" label="Point" keys="P" icon={<IconPoint />} />
        <ToolButton tool="box" label="Box" keys="B" icon={<IconBox />} />
        <ToolButton tool="select" label="Select" keys="V" icon={<IconSelect />} />
        <ToolButton tool="brush" label="Brush" keys="A / D" icon={<IconBrush />} />
      </div>

      <label className="exposure" title="Picture brightness (screen only)">
        <span>Brightness</span>
        <input type="range" min={0.5} max={3} step={0.05} value={exposure} onChange={(e) => setExposure(Number(e.target.value))} />
      </label>

      <button type="button" className="icon-btn" onClick={() => openSettings()} aria-label="Settings" title="Settings">
        <IconSettings />
      </button>
      <button type="button" className="icon-btn" onClick={() => setHelpOpen(true)} aria-label="Help" title="Help">
        <IconHelp />
      </button>
    </header>
  )
}

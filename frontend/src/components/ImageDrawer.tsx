import { useEffect, useMemo, useState } from 'react'
import type { SampleRow, SampleStatus } from '../api/client'
import { useEditor } from '../state/editor'
import { useWorkspace } from '../state/workspace'
import { IconClose } from './Icons'

const STATUS_LABEL: Record<SampleStatus, string> = { Pending: 'To do', Incomplete: 'In progress', Completed: 'Done', Skipped: 'Skipped' }
const FILTERS: (SampleStatus | 'All')[] = ['All', 'Pending', 'Incomplete', 'Completed', 'Skipped']

/** Slide-over list of every image, grouped by folder, with progress status. */
export function ImageDrawer() {
  const samples = useWorkspace((s) => s.samples)
  const counts = useWorkspace((s) => s.counts)
  const close = useWorkspace((s) => s.setImagesOpen)
  const refresh = useWorkspace((s) => s.refreshSamples)
  const currentKey = useEditor((s) => s.image?.sampleKey)
  const openSample = useEditor((s) => s.openSample)
  const [filter, setFilter] = useState<SampleStatus | 'All'>('All')
  const [text, setText] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const groups = useMemo(() => {
    const q = text.trim().toLowerCase()
    const map = new Map<string, SampleRow[]>()
    for (const s of samples) {
      if (filter !== 'All' && s.status !== filter) continue
      if (q && !s.key.toLowerCase().includes(q)) continue
      const list = map.get(s.parent) ?? []
      list.push(s)
      map.set(s.parent, list)
    }
    return [...map.entries()]
  }, [samples, filter, text])

  const pick = async (key: string) => {
    if (await openSample(key)) close(false)
  }

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <aside className="drawer" aria-label="Images">
        <header className="drawer-header">
          <h2>Images</h2>
          <button type="button" className="btn btn-small" onClick={() => void refresh(true)} title="Look for new files">
            Rescan
          </button>
          <button type="button" className="icon-btn" onClick={() => close(false)} aria-label="Close">
            <IconClose />
          </button>
        </header>
        <input className="search" placeholder="Search images…" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="chips">
          {FILTERS.map((f) => (
            <button key={f} type="button" className={filter === f ? 'chip active' : 'chip'} onClick={() => setFilter(f)}>
              {f === 'All' ? `All ${samples.length}` : `${STATUS_LABEL[f]} ${counts[f] ?? 0}`}
            </button>
          ))}
        </div>
        <div className="drawer-list">
          {groups.length === 0 && <p className="muted pad">{samples.length ? 'Nothing matches.' : 'No images found in the input folder.'}</p>}
          {groups.map(([parent, rows]) => (
            <section key={parent || '(root)'}>
              {(groups.length > 1 || parent) && <h3 className="group-title">{parent || 'Top folder'}</h3>}
              <ul>
                {rows.map((r) => (
                  <li key={r.key}>
                    <button type="button" className={r.key === currentKey ? 'image-row current' : 'image-row'} onClick={() => void pick(r.key)}>
                      <span className="row-name">{r.name}</span>
                      <span className={`status status-${r.status}`}>{STATUS_LABEL[r.status]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </aside>
    </div>
  )
}

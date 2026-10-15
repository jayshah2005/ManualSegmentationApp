import { useCallback, useEffect, useRef, useState } from 'react'
import { listFolder, makeFolder, type FsListing } from '../api/client'
import { Modal } from './Modal'
import { IconFolder } from './Icons'

type Props = {
  title: string
  /** 'input' shows how many images are in a folder; 'output' requires a writable folder. */
  purpose: 'input' | 'output'
  initialPath?: string
  onPick: (path: string) => void
  onClose: () => void
}

function crumbsOf(path: string): { name: string; path: string }[] {
  const win = /^[A-Za-z]:[\\/]/.test(path)
  const sep = win ? '\\' : '/'
  const parts = path.split(/[\\/]/).filter(Boolean)
  const out: { name: string; path: string }[] = win ? [] : [{ name: '/', path: '/' }]
  let acc = win ? '' : ''
  parts.forEach((p, i) => {
    acc = win ? (i === 0 ? `${p}${sep}` : `${acc}${acc.endsWith(sep) ? '' : sep}${p}`) : `${acc}/${p}`
    out.push({ name: p, path: acc })
  })
  return out
}

/** Server-side folder browser (browsers cannot reveal real folder paths themselves). */
export function FolderPicker({ title, purpose, initialPath, onPick, onClose }: Props) {
  const [listing, setListing] = useState<FsListing | null>(null)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')
  const [hidden, setHidden] = useState(false)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const seq = useRef(0)
  const edited = useRef(false) // user typed in the path box; the first background listing must not clobber it

  const go = useCallback(
    async (path: string, showHidden = hidden, explicit = true) => {
      setError('')
      const mine = ++seq.current // only the newest request may update the view
      if (explicit) edited.current = false
      setLoading(true)
      try {
        const l = await listFolder(path, showHidden)
        if (mine !== seq.current) return
        setListing(l)
        if (explicit || !edited.current) setTyped(l.path)
      } catch (e) {
        if (mine === seq.current) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (mine === seq.current) setLoading(false)
      }
    },
    [hidden],
  )

  useEffect(() => {
    void go(initialPath ?? '', hidden, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const create = async () => {
    if (!listing || !newName.trim()) return
    try {
      const r = await makeFolder(listing.path, newName.trim())
      setCreating(false)
      setNewName('')
      await go(r.path)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // The typed text must match the folder actually shown (press Go / Enter first).
  const pending = !!listing && typed.trim() !== listing.path
  const canPick = !!listing && !loading && !pending && (purpose === 'input' || listing.writable)

  return (
    <Modal
      title={title}
      subtitle={purpose === 'input' ? 'Pick the folder that contains your images (sub-folders are included).' : 'Pick where the results should be saved.'}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted grow">
            {listing && purpose === 'input' && (listing.imageCount > 0 ? `${listing.imageCount} image${listing.imageCount === 1 ? '' : 's'} directly in this folder` : 'No images directly in this folder (sub-folders are searched too)')}
            {listing && purpose === 'output' && !listing.writable && 'This folder is read-only. Choose another.'}
            {pending && 'Press Enter or Go to open the path you typed.'}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!canPick} onClick={() => listing && onPick(listing.path)}>
            Use this folder
          </button>
        </>
      }
    >
      <form
        className="path-row"
        onSubmit={(e) => {
          e.preventDefault()
          void go(typed)
        }}
      >
        <input value={typed} onChange={(e) => ((edited.current = true), setTyped(e.target.value))} aria-label="Folder path" spellCheck={false} placeholder="Type or paste a folder path, then press Enter" />
        <button type="submit" className="btn">
          Go
        </button>
      </form>

      <div className="picker">
        <nav className="picker-roots" aria-label="Places">
          {listing?.roots.map((r) => (
            <button key={r.path} type="button" className="picker-root" onClick={() => void go(r.path)}>
              <IconFolder /> {r.name}
            </button>
          ))}
        </nav>
        <div className="picker-main">
          {listing && (
            <div className="crumbs">
              {crumbsOf(listing.path).map((c, i, arr) => (
                <button key={c.path} type="button" className="crumb" onClick={() => void go(c.path)} disabled={i === arr.length - 1}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {error && <p className="field-error">{error}</p>}
          <ul className="folder-list">
            {listing?.parent && (
              <li>
                <button type="button" className="folder-item" onClick={() => void go(listing.parent!)}>
                  <IconFolder /> ..
                </button>
              </li>
            )}
            {listing?.folders.map((f) => (
              <li key={f.path}>
                <button type="button" className="folder-item" onDoubleClick={() => onPick(f.path)} onClick={() => void go(f.path)}>
                  <IconFolder /> {f.name}
                </button>
              </li>
            ))}
            {listing && listing.folders.length === 0 && <li className="muted pad">No sub-folders here.</li>}
          </ul>
          <div className="picker-tools">
            {creating ? (
              <form
                className="path-row"
                onSubmit={(e) => {
                  e.preventDefault()
                  void create()
                }}
              >
                <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New folder name" aria-label="New folder name" />
                <button type="submit" className="btn btn-primary" disabled={!newName.trim()}>
                  Create
                </button>
                <button type="button" className="btn" onClick={() => setCreating(false)}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <button type="button" className="btn btn-small" onClick={() => setCreating(true)} disabled={!listing?.writable}>
                  New folder
                </button>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={hidden}
                    onChange={(e) => {
                      setHidden(e.target.checked)
                      if (listing) void go(listing.path, e.target.checked)
                    }}
                  />
                  Show hidden folders
                </label>
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}

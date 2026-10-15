import { useEffect } from 'react'
import { useWorkspace } from '../state/workspace'
import { IconClose } from './Icons'

export function HelpDrawer() {
  const close = useWorkspace((s) => s.setHelpOpen)
  const openSettings = useWorkspace((s) => s.openSettings)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <aside className="drawer drawer-right help" aria-label="Help">
        <header className="drawer-header">
          <h2>Quick guide</h2>
          <button type="button" className="icon-btn" onClick={() => close(false)} aria-label="Close">
            <IconClose />
          </button>
        </header>
        <div className="drawer-list pad">
          <h3>How it works</h3>
          <ol className="steps">
            <li>
              <strong>Pick an image</strong> from the list (top bar).
            </li>
            <li>
              <strong>Click on an object</strong> with the Point tool. The tool outlines it automatically.
            </li>
            <li>
              <strong>Improve it</strong> — click more spots to include them, right-click to leave an area out, or drag a box around the object.
            </li>
            <li>
              Press <kbd>N</kbd> and click the <strong>next object</strong>.
            </li>
            <li>
              <strong>Save & next</strong>. Each object is saved as its own cut-out in your output folder.
            </li>
          </ol>

          <h3>Tools</h3>
          <dl className="defs">
            <dt>Point (P)</dt>
            <dd>Left-click includes, right-click (or Shift+click) excludes. Click an existing dot to remove it.</dd>
            <dt>Box (B)</dt>
            <dd>Drag a rectangle around an object — good for large or oddly shaped things.</dd>
            <dt>Select (V)</dt>
            <dd>Click an object to select it, then use the other tools to change it.</dd>
            <dt>Brush (A / D)</dt>
            <dd>Paint to add (A) or erase (D) pixels. Use <em>Fine-tune</em> on an object for a zoomed-in view.</dd>
            <dt>Trim edge</dt>
            <dd>Shaves a few pixels off an object's border to avoid background fringes.</dd>
          </dl>

          <h3>Tips</h3>
          <ul>
            <li>Scroll to zoom; hold Space and drag to move the picture.</li>
            <li>Hyperspectral and multispectral files are shown as a colour picture. Change which bands are used in Settings → Image display. The exported file still contains all bands.</li>
            <li>Results mirror your input folders. Finished images are remembered, so you can close the app and continue later.</li>
          </ul>

          <h3>Full manual</h3>
          <p>
            The complete guide with screenshots is <code>docs/MANUAL.md</code> in the app folder, or{' '}
            <a href="https://github.com/jayshah2005/ManualSegmentationApp/blob/main/docs/MANUAL.md" target="_blank" rel="noreferrer">read it on GitHub</a>.
          </p>

          <h3>It feels slow?</h3>
          <p>
            Check that your graphics card is used: <button type="button" className="btn-link" onClick={() => (close(false), openSettings('engine'))}>Settings → Model & GPU</button>. A smaller model also helps.
          </p>
        </div>
      </aside>
    </div>
  )
}

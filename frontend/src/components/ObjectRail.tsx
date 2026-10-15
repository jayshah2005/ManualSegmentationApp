import { useEffect, useRef } from 'react'
import { useEditor, type EditObject } from '../state/editor'
import { IconBrush, IconExpand, IconPlus, IconRedo, IconTrash, IconUndo } from './Icons'
import { ObjectThumb } from './ObjectThumb'

type CardProps = { object: EditObject; number: number; active: boolean; onEdit: () => void }

function ObjectCard({ object, number, active, onEdit }: CardProps) {
  const select = useEditor((s) => s.select)
  const setLabel = useEditor((s) => s.setLabel)
  const setShrink = useEditor((s) => s.setShrink)
  const resetMask = useEditor((s) => s.resetMask)
  const removeObject = useEditor((s) => s.removeObject)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div ref={ref} className={active ? 'object-card active' : 'object-card'} onClick={() => select(object.id)}>
      <div className="object-card-top">
        <ObjectThumb object={object} />
        <div className="object-card-fields">
          <div className="object-card-title">
            <span className="object-number">{number}</span>
            <input
              type="text"
              value={object.label}
              placeholder={`object_${String(object.id).padStart(3, '0')}`}
              aria-label={`Name of object ${number}`}
              onChange={(e) => setLabel(object.id, e.target.value)}
              onFocus={() => select(object.id)}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <label className="slider-field" onClick={(e) => e.stopPropagation()}>
            <span>
              Trim edge <strong>{object.shrink}</strong> px
            </span>
            <input type="range" min={0} max={50} value={object.shrink} onChange={(e) => setShrink(object.id, Number(e.target.value))} />
          </label>
          <div className="btn-row">
            <button type="button" className="btn btn-small" onClick={(e) => (e.stopPropagation(), onEdit())} title="Zoom in and fine-tune with the brush">
              <IconExpand /> Fine-tune
            </button>
            {object.edited && (
              <button type="button" className="btn btn-small" onClick={(e) => (e.stopPropagation(), void resetMask(object.id))} title="Undo all brush edits">
                Reset brush
              </button>
            )}
            <button type="button" className="btn btn-small btn-danger-quiet" onClick={(e) => (e.stopPropagation(), void removeObject(object.id))} aria-label={`Delete object ${number}`} title="Delete this object">
              <IconTrash />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ObjectRail({ onEdit }: { onEdit: (id: number) => void }) {
  const objects = useEditor((s) => s.objects)
  const activeId = useEditor((s) => s.activeId)
  const image = useEditor((s) => s.image)
  const tool = useEditor((s) => s.tool)
  const brushMode = useEditor((s) => s.brushMode)
  const brushSize = useEditor((s) => s.brushSize)
  const emphasize = useEditor((s) => s.emphasize)
  const setEmphasize = useEditor((s) => s.setEmphasize)
  const setBrushMode = useEditor((s) => s.setBrushMode)
  const setBrushSize = useEditor((s) => s.setBrushSize)
  const newObject = useEditor((s) => s.newObject)
  const suggest = useEditor((s) => s.suggestBorders)
  const undoBrush = useEditor((s) => s.undoBrush)
  const redoBrush = useEditor((s) => s.redoBrush)
  const active = objects.find((o) => o.id === activeId)

  return (
    <aside className="rail" aria-label="Objects">
      <div className="rail-head">
        <h2>
          Objects <span className="count">{objects.length}</span>
        </h2>
        <div className="btn-row">
          <button type="button" className="btn btn-small btn-primary" onClick={newObject} disabled={!image} title="Next click starts a new object (N)">
            <IconPlus /> New object
          </button>
          <button type="button" className="btn btn-small" onClick={() => void suggest()} disabled={!objects.length} title="Pick a sensible edge trim for every object">
            Suggest trims
          </button>
        </div>
      </div>

      <div className="rail-list">
        {!image && <p className="muted pad">Choose an image to begin.</p>}
        {image && objects.length === 0 && (
          <div className="empty-state">
            <strong>No objects yet</strong>
            <p>
              Click on something in the picture to outline it. Add more clicks to improve it — right-click to leave an area out. Press <kbd>N</kbd> to start the next object.
            </p>
          </div>
        )}
        {objects.map((o, i) => (
          <ObjectCard key={o.id} object={o} number={i + 1} active={o.id === activeId} onEdit={() => onEdit(o.id)} />
        ))}
      </div>

      <div className="rail-foot">
        <div className={tool === 'brush' ? 'brush-panel active' : 'brush-panel'}>
          <div className="mode-toggle" role="group" aria-label="Brush mode">
            <button type="button" className={tool === 'brush' && brushMode === 'add' ? 'btn active' : 'btn'} onClick={() => setBrushMode('add')} title="Add to object (A)">
              <IconBrush /> Add
            </button>
            <button type="button" className={tool === 'brush' && brushMode === 'erase' ? 'btn active' : 'btn'} onClick={() => setBrushMode('erase')} title="Erase from object (D)">
              Erase
            </button>
          </div>
          <label className="slider-field">
            <span>
              Brush size <strong>{brushSize}</strong> px
            </span>
            <input type="range" min={2} max={60} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} />
          </label>
          <div className="btn-row">
            <button type="button" className="btn btn-small" onClick={() => undoBrush()} disabled={!active?.undo.canUndo()}>
              <IconUndo /> Undo
            </button>
            <button type="button" className="btn btn-small" onClick={() => redoBrush()} disabled={!active?.undo.canRedo()}>
              <IconRedo /> Redo
            </button>
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={emphasize} onChange={(e) => setEmphasize(e.target.checked)} />
          Highlight only the selected object
        </label>
      </div>
    </aside>
  )
}

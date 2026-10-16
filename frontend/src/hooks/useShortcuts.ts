import { useEffect } from 'react'
import { useEditor } from '../state/editor'
import { useWorkspace } from '../state/workspace'

function isTyping(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
}

/** App-wide keyboard shortcuts (tools, brush, undo). Disabled while typing or when a dialog is open. */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ws = useWorkspace.getState()
      if (ws.wizardOpen || ws.settingsOpen || ws.confirmRequest || ws.imagesOpen || ws.helpOpen) return
      if (isTyping(e.target)) return
      const ed = useEditor.getState()
      if (!ed.image) return
      const mod = e.ctrlKey || e.metaKey

      if (mod && !e.altKey) {
        const k = e.key.toLowerCase()
        if (k === 'z') {
          e.preventDefault()
          if (e.shiftKey) ed.redoBrush()
          else ed.undoBrush()
        } else if (k === 'y') {
          e.preventDefault()
          ed.redoBrush()
        } else if (k === 'a') {
          e.preventDefault()
          window.getSelection()?.removeAllRanges()
        }
        return
      }
      if (e.altKey) return

      switch (e.key) {
        case 'p':
        case 'P':
          ed.setTool('point')
          break
        case 'b':
        case 'B':
          ed.setTool('box')
          break
        case 'v':
        case 'V':
          ed.setTool('select')
          break
        case 'a':
        case 'A':
          ed.setBrushMode('add')
          break
        case 'd':
        case 'D':
          ed.setBrushMode('erase')
          break
        case 'r':
          void ed.rotate(90)
          break
        case 'R':
          void ed.rotate(270)
          break
        case 'n':
        case 'N':
          ed.newObject()
          break
        case '[':
          ed.setBrushSize(ed.brushSize - 2)
          break
        case ']':
          ed.setBrushSize(ed.brushSize + 2)
          break
        case 'Backspace':
          e.preventDefault()
          void ed.removeLastPrompt()
          break
        case 'Delete':
          if (ed.activeId != null) void ed.removeObject(ed.activeId)
          break
        case 'Escape':
          ed.select(null)
          break
        default:
          return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

import { useWorkspace } from '../state/workspace'
import { EnginePanel } from './EnginePanel'
import { FolderField } from './FolderField'
import { Modal } from './Modal'

type Props = { onFinish: () => void }

const STEPS = ['Folders', 'Engine', 'Ready']

/** First-run flow: pick folders → make sure SAM + GPU are set up → go. */
export function SetupWizard({ onFinish }: Props) {
  const settings = useWorkspace((s) => s.settings)
  const system = useWorkspace((s) => s.system)
  const samples = useWorkspace((s) => s.samples)
  const saveSettings = useWorkspace((s) => s.saveSettings)
  const toast = useWorkspace((s) => s.toast)
  const step = useWorkspace((s) => s.wizardStep)
  const setStep = useWorkspace((s) => s.setWizardStep)

  const set = async (patch: Parameters<typeof saveSettings>[0]) => {
    try {
      await saveSettings(patch)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e))
    }
  }

  const foldersOk = !!settings?.inputDir && !!settings?.outputDir
  const ready = !!system?.ready

  return (
    <Modal
      title="Welcome to Segmentation Tool"
      subtitle="Outline objects in your images with a few clicks. Let's get you set up — it takes a couple of minutes."
      wide
      dismissible={false}
      footer={
        <>
          <ol className="stepper grow" aria-label="Progress">
            {STEPS.map((s, i) => (
              <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''}>
                <span>{i + 1}</span> {s}
              </li>
            ))}
          </ol>
          {step > 0 && (
            <button type="button" className="btn" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          {step === 0 && (
            <button type="button" className="btn btn-primary" disabled={!foldersOk} onClick={() => setStep(1)}>
              Next
            </button>
          )}
          {step === 1 && (
            <>
              <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => setStep(2)}>
                Next
              </button>
            </>
          )}
          {step === 2 && (
            <button type="button" className="btn btn-primary btn-large" onClick={onFinish}>
              Start segmenting
            </button>
          )}
        </>
      }
    >
      {step === 0 && (
        <div className="wizard-step">
          <FolderField
            label="Folder with your images"
            hint="Can be one folder of images, or a folder with sub-folders of images. RGB photos, multispectral and hyperspectral files are supported."
            purpose="input"
            value={settings?.inputDir ?? ''}
            onChange={(p) => void set({ inputDir: p })}
          />
          {settings?.inputDir && (
            <p className={samples.length ? 'field-ok' : 'field-error'}>
              {samples.length ? `Found ${samples.length} image${samples.length === 1 ? '' : 's'}.` : 'No supported images found in that folder yet.'}
            </p>
          )}
          <FolderField
            label="Folder for the results"
            hint="Cut-outs, masks and a progress file are saved here. It will mirror the layout of your input folder."
            purpose="output"
            value={settings?.outputDir ?? ''}
            onChange={(p) => void set({ outputDir: p })}
          />
          <label className="check">
            <input type="checkbox" checked={settings?.recursive ?? true} onChange={(e) => void set({ recursive: e.target.checked })} />
            Also look inside sub-folders
          </label>
        </div>
      )}
      {step === 1 && (
        <div className="wizard-step">
          <EnginePanel />
        </div>
      )}
      {step === 2 && (
        <div className="wizard-step wizard-done">
          <h3>You're all set</h3>
          <ul>
            <li>
              <strong>{samples.length}</strong> image{samples.length === 1 ? '' : 's'} to segment
            </li>
            <li>
              Running on <strong>{system?.device === 'cuda' ? 'your NVIDIA GPU' : system?.device === 'mps' ? 'your Apple GPU' : 'the processor'}</strong>
            </li>
            <li>
              Results go to <code>{settings?.outputDir}</code>
            </li>
          </ul>
          <p className="muted">Tip: click the ? button any time for a quick guide, and the gear for all settings.</p>
        </div>
      )}
    </Modal>
  )
}

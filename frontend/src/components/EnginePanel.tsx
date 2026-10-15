import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchJob, restartApp, startInstall, type DeviceChoice, type InstallAction, type SamModel, type SetupJob, type SystemProblem } from '../api/client'
import { useWorkspace } from '../state/workspace'
import { IconCheck } from './Icons'

const DEVICES: { value: DeviceChoice; label: string }[] = [
  { value: 'auto', label: 'Automatic (recommended)' },
  { value: 'cuda', label: 'NVIDIA GPU' },
  { value: 'mps', label: 'Apple GPU' },
  { value: 'cpu', label: 'Processor only (slow)' },
]

const FIX_LABEL: Record<SystemProblem['fix'], string> = {
  install_torch: 'Install',
  install_sam2: 'Install',
  download_model: 'Download',
}

function Row({ ok, warn, title, detail }: { ok: boolean; warn?: boolean; title: string; detail: string }) {
  return (
    <li className={`status-row ${ok ? 'ok' : warn ? 'warn' : 'bad'}`}>
      <span className="status-dot">{ok ? <IconCheck /> : warn ? '!' : '•'}</span>
      <div>
        <strong>{title}</strong>
        <span className="muted">{detail}</span>
      </div>
    </li>
  )
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      if ((await fetch('/api/health')).ok) return true
    } catch {
      /* still restarting */
    }
  }
  return false
}

/** Explains GPU / PyTorch / SAM status and fixes problems with one click. Used by the wizard and Settings. */
export function EnginePanel() {
  const system = useWorkspace((s) => s.system)
  const loading = useWorkspace((s) => s.systemLoading)
  const settings = useWorkspace((s) => s.settings)
  const refreshSystem = useWorkspace((s) => s.refreshSystem)
  const saveSettings = useWorkspace((s) => s.saveSettings)
  const toast = useWorkspace((s) => s.toast)
  const confirm = useWorkspace((s) => s.confirm)

  const [job, setJob] = useState<SetupJob | null>(null)
  const [log, setLog] = useState<string[]>([])
  const sinceRef = useRef(0)
  const logRef = useRef<HTMLPreElement>(null)

  const running = job?.status === 'running'

  // poll the install job while it runs
  useEffect(() => {
    if (!running) return
    const id = setInterval(async () => {
      try {
        const { job: j } = await fetchJob(sinceRef.current)
        if (!j) return
        sinceRef.current = j.next
        setLog((l) => [...l, ...j.lines].slice(-400))
        setJob(j)
        if (j.status !== 'running') {
          await refreshSystem()
          if (j.status === 'done') toast('success', j.restartRequired ? 'Installed. Restart the app to use the new version.' : 'Setup step finished.')
          else toast('error', j.error || 'Setup failed. See the log for details.')
        }
      } catch {
        /* transient; keep polling */
      }
    }, 1000)
    return () => clearInterval(id)
  }, [running, refreshSystem, toast])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  const run = useCallback(
    async (action: InstallAction, model?: SamModel) => {
      try {
        sinceRef.current = 0
        setLog([])
        setJob(await startInstall(action, { torchTag: system?.recommendedTorch.tag, model }))
      } catch (e) {
        toast('error', e instanceof Error ? e.message : String(e))
      }
    },
    [system, toast],
  )

  const chooseModel = async (name: SamModel) => {
    const m = system?.models.find((x) => x.name === name)
    if (!m) return
    const previous = settings?.samModel
    await saveSettings({ samModel: name })
    if (m.downloaded) return
    const ok = await confirm({
      title: `Download the ${m.label} model?`,
      body: `It is about ${m.sizeMb} MB and is needed before you can segment with this size. It only downloads once.`,
      okLabel: 'Download now',
    })
    if (ok) void run('download_model', name)
    else if (previous && previous !== name) await saveSettings({ samModel: previous })
  }

  const restart = async () => {
    try {
      await restartApp()
    } catch {
      /* the server exits while answering */
    }
    toast('info', 'Restarting… this takes a few seconds.')
    if (await waitForServer()) window.location.reload()
    else toast('error', 'The app did not come back. Close it and start it again.')
  }

  if (!system) {
    return <p className="muted">{loading ? 'Checking your computer… (the first check can take a few seconds)' : 'Could not read the system status.'}</p>
  }

  const blocking = system.problems.filter((p) => p.severity === 'blocking')
  const warnings = system.problems.filter((p) => p.severity === 'warning')
  const gpuName = system.gpu?.name ?? system.nvidiaGpu?.name
  const usingGpu = system.device === 'cuda' || system.device === 'mps'
  const selected = settings?.samModel ?? system.selectedModel

  return (
    <div className="engine">
      <div className={`banner ${system.ready ? (warnings.length ? 'banner-warn' : 'banner-ok') : 'banner-bad'}`}>
        {system.ready
          ? usingGpu
            ? `Ready. Using your ${system.device === 'mps' ? 'Apple GPU' : gpuName ?? 'GPU'}.`
            : 'Ready, but running on the processor only — segmentation will be slow.'
          : 'A few things need to be installed before you can segment images.'}
      </div>

      <ul className="status-list">
        <Row ok title="Computer" detail={`${system.os} · Python ${system.python}`} />
        <Row ok={!!gpuName || system.torch.mpsAvailable === true} warn title="Graphics card" detail={gpuName ? `${gpuName}${system.nvidiaGpu ? ` · driver ${system.nvidiaGpu.driver}` : ''}` : system.torch.mpsAvailable ? 'Apple GPU' : 'No supported GPU found — the processor will be used'} />
        <Row
          ok={system.torch.installed && (usingGpu || !system.nvidiaGpu)}
          warn={system.torch.installed}
          title="PyTorch (AI engine)"
          detail={system.torch.installed ? `${system.torch.version}${usingGpu ? ' · GPU enabled' : ' · CPU only'}` : 'Not installed'}
        />
        <Row ok={system.sam2Installed} title="SAM 2 (segmentation model code)" detail={system.sam2Installed ? 'Installed' : 'Not installed'} />
        <Row ok={system.models.find((m) => m.name === selected)?.downloaded === true} title="Model file" detail={system.models.find((m) => m.name === selected)?.downloaded ? 'Downloaded' : 'Not downloaded yet'} />
      </ul>

      {[...blocking, ...warnings].map((p) => (
        <div key={p.code} className={`problem problem-${p.severity}`}>
          <div>
            <p>{p.message}</p>
            {p.fix === 'install_torch' && <p className="muted">Recommended build: {system.recommendedTorch.label}. {system.recommendedTorch.reason}</p>}
          </div>
          <button type="button" className="btn btn-primary" disabled={running} onClick={() => void run(p.fix, selected)}>
            {p.severity === 'warning' ? 'Switch to GPU version' : FIX_LABEL[p.fix]}
          </button>
        </div>
      ))}

      {blocking.length > 1 && (
        <button type="button" className="btn btn-primary btn-large" disabled={running} onClick={() => void run('setup_all', selected)}>
          Set everything up for me
        </button>
      )}

      {job && (
        <div className="job">
          <div className="job-head">
            <strong>{job.status === 'running' ? job.step || 'Working…' : job.status === 'done' ? 'Finished' : 'Something went wrong'}</strong>
            {job.status === 'error' && <span className="field-error">{job.error}</span>}
          </div>
          {running && (job.kind === 'install_torch' || job.kind === 'setup_all') && (
            <p className="muted">
              The GPU version of PyTorch is a 2–3 GB download and can take 10–20 minutes. Nothing is stuck — open “Show details” to watch the progress.
            </p>
          )}
          <div className={job.progress == null && running ? 'bar bar-indeterminate' : 'bar'}>
            <span style={{ width: `${Math.round((job.progress ?? (job.status === 'done' ? 1 : 0)) * 100)}%` }} />
          </div>
          {job.status === 'done' && job.restartRequired && (
            <button type="button" className="btn btn-primary" onClick={() => void restart()}>
              Restart the app now
            </button>
          )}
          <details>
            <summary>Show details</summary>
            <pre ref={logRef} className="log">{log.join('\n')}</pre>
          </details>
        </div>
      )}

      <h3>Model size</h3>
      <p className="muted">Bigger models outline objects more precisely but need more memory and time. Models download once (about 150–900 MB).</p>
      <div className="model-grid" role="radiogroup" aria-label="Model size">
        {system.models.map((m) => (
          <label key={m.name} className={`model-card ${selected === m.name ? 'selected' : ''}`}>
            <input type="radio" name="sam-model" checked={selected === m.name} onChange={() => void chooseModel(m.name)} />
            <strong>{m.label}</strong>
            <span className="muted">{m.note}</span>
            <span className={m.downloaded ? 'pill pill-ok' : 'pill'}>{m.downloaded ? 'Downloaded' : `${m.sizeMb} MB`}</span>
          </label>
        ))}
      </div>

      <label className="field">
        <span>Use for calculations</span>
        <select value={settings?.device ?? 'auto'} onChange={(e) => void saveSettings({ device: e.target.value as DeviceChoice })}>
          {DEVICES.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="btn btn-small" onClick={() => void refreshSystem()} disabled={loading || running}>
        {loading ? 'Checking…' : 'Check again'}
      </button>
    </div>
  )
}

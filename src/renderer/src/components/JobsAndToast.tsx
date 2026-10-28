import type { JSX } from 'react'
import { useUi } from '@/store/ui'
import { ProgressBar } from './ui/controls'

/** Background job list (transcodes, AI generations, exports) and the toast message. */
export function JobsAndToast(): JSX.Element {
  const jobs = useUi((s) => s.jobs)
  const toast = useUi((s) => s.toast)
  const removeJob = useUi((s) => s.removeJob)
  return (
    <>
      {jobs.length > 0 && (
        <div style={{ position: 'fixed', right: 12, bottom: 12, width: 300, display: 'flex', flexDirection: 'column', gap: 6, zIndex: 150 }}>
          {jobs.map((j) => (
            <div key={j.id} style={{ background: 'var(--bg-3)', border: '1px solid var(--line-strong)', borderRadius: 8, padding: '8px 10px', boxShadow: '0 6px 20px rgba(0,0,0,.35)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.label}</span>
                {j.status === 'running' && j.cancel && <button className="btn small ghost" onClick={j.cancel}>Cancel</button>}
                {j.status !== 'running' && <button className="btn small ghost" onClick={() => removeJob(j.id)}>✕</button>}
              </div>
              {j.status === 'running' && <ProgressBar value={j.progress} />}
              {j.status === 'error' && <div style={{ color: 'var(--danger)', userSelect: 'text' }}>{j.error}</div>}
              {j.status === 'done' && <div style={{ color: 'var(--ok)' }}>Done</div>}
              {j.status === 'cancelled' && <div className="muted">Cancelled</div>}
            </div>
          ))}
        </div>
      )}
      {toast && <div className={`toast ${toast.kind}`}>{toast.message}</div>}
    </>
  )
}

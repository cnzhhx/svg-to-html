import { useEffect, useState } from 'react'
import { loadQueueSettings, saveQueueSettings } from '../../api/settings'
import type { QueueSettings } from '../../api/settings'

export function QueueSettingsPanel() {
  const [saved, setSaved] = useState<QueueSettings | null>(null)
  const [limit, setLimit] = useState(1)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const dirty = saved !== null && saved.maxConcurrentJobs !== limit
  const accept = (value: QueueSettings) => { setSaved(value); setLimit(value.maxConcurrentJobs) }
  useEffect(() => {
    let active = true
    void loadQueueSettings().then(value => { if (active) accept(value) })
      .catch(e => { if (active) setError(e.message) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  const act = async (save: boolean) => {
    setBusy(true); setError(''); setNotice('')
    try {
      accept(save && saved ? await saveQueueSettings({ ...saved, maxConcurrentJobs: limit }) : await loadQueueSettings())
      if (save) setNotice('并发设置已保存并生效。正在执行的任务会继续完成。')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <form onSubmit={event => { event.preventDefault(); void act(true) }}>
    <fieldset className="operating-fields" disabled={busy || !saved}>
      <section className="settings-card">
        <h2>排队与并发</h2><p>设置整个站点同时执行的 session 数，超出的任务按顺序排队。</p>
        <div className="settings-grid"><label>最多同时执行的 session 数<input type="number" min="1" max="32" step="1" required value={Number.isNaN(limit) ? '' : limit} onChange={event => setLimit(event.target.valueAsNumber)} /></label></div>
        <small>保存后立即生效，重启后保留。调高时自动启动更多排队任务；调低时等待正在执行的任务完成，不会中断任务。单个 session 内的模块并发不受影响。</small>
      </section>
    </fieldset>
    {error && <div className="settings-error" role="alert">{error}</div>}
    {notice && <div className="settings-success" role="status">{notice}</div>}
    <div className="settings-savebar"><span role="status">{busy ? '处理中…' : dirty ? '有未保存的修改' : saved ? '设置已保存' : '尚未加载设置'}</span><div>
      <button type="button" disabled={busy} onClick={() => { if (!dirty || window.confirm('放弃未保存的修改并重新加载？')) void act(false) }}>重新加载</button>
      <button type="submit" className="admin-primary" disabled={busy || !dirty}>保存设置</button>
    </div></div>
  </form>
}

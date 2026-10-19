import { useEffect, useRef, useState } from 'react'
import { endAdminSession } from '../../api/admin'
import { ApiError } from '../../api/http'
import { loadJobs } from '../../api/jobs'
import { changePassword, loadAdminStatus, loadSettings, loadSetup, loginAdmin, recoverPassword, saveSettings, setJobShowcase, setupAdmin } from '../../api/settings'
import type { AdminStatus, OperatingSettings, SettingsSnapshot } from '../../api/settings'
import type { Job } from '../../types/job'
import { OperatingFields } from './OperatingFields'
import { QueueSettingsPanel } from './QueueSettingsPanel'
import '../../styles/admin.css'

const go = (page: string) => window.location.assign(`/transformer/${page}`)
export default function AdminPage() {
  const pathname = window.location.pathname.replace(/\/$/, '')
  const page = pathname.endsWith('/setup') ? 'setup' : pathname.endsWith('/login') ? 'login' : 'settings'
  const [status, setStatus] = useState<AdminStatus | null>(null)
  const [saved, setSaved] = useState<SettingsSnapshot | null>(null)
  const [settings, setSettings] = useState<OperatingSettings | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [tab, setTab] = useState('operating')
  const contentRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [token, setToken] = useState('')
  const [legacy, setLegacy] = useState(false)
  const [recovery, setRecovery] = useState(false)
  const dirty = page === 'settings' && saved && settings && JSON.stringify(saved.settings) !== JSON.stringify(settings)

  const refreshSettings = async () => {
    const data = await loadSettings(); setSaved(data); setSettings(data.settings)
  }
  useEffect(() => {
    let active = true
    const load = async () => {
      const data = page === 'setup' ? await loadSetup() : await loadAdminStatus()
      if (!active) return
      setStatus(data)
      if (page === 'setup') {
        if (data.initialized) { go(data.adminMode ? 'admin/settings' : 'login'); return }
        if ('settings' in data && data.settings) setSettings(data.settings as OperatingSettings)
      } else if (page === 'settings') {
        if (!data.adminMode) { go(data.initialized || data.legacyAvailable ? 'login' : 'setup'); return }
        if (!data.initialized) { go('setup'); return }
        await refreshSettings()
      }
    }
    void load().catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [page])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const act = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('')
    try { await operation() }
    catch (e) {
      if (e instanceof ApiError && e.status === 401) setError('登录已过期，请重新登录。未保存的设置仍保留在当前页面。')
      else setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }
  const confirmExposure = () => settings?.accessIsolationEnabled !== false || saved?.settings.accessIsolationEnabled === false || window.confirm('关闭访问隔离后，所有访问者都能查看和下载已有任务。确认保存？')
  const requireMatchingPassword = () => { if (password !== confirmation) throw new Error('两次输入的密码不一致') }
  const submitAuth = (event: React.FormEvent) => {
    event.preventDefault()
    void act(async () => {
      if (page === 'setup') {
        if (!settings) return
        requireMatchingPassword()
        if (!confirmExposure()) return
        await setupAdmin({ username, password, token, settings }); go('admin/settings')
      } else if (recovery) {
        requireMatchingPassword(); await recoverPassword(token, password)
        setRecovery(false); setToken(''); setPassword(''); setConfirmation(''); setNotice('密码已重置，请使用原账号名和新密码登录。')
      } else {
        const next = await loginAdmin(legacy ? { key: token } : { username, password })
        go(next.initialized ? 'admin/settings' : 'setup')
      }
    })
  }
  const changeTab = (value: string) => {
    setTab(value); setError(''); setNotice('')
    contentRef.current?.scrollTo({ top: 0 })
    if (value === 'showcase') void act(async () => { setJobs(await loadJobs()) })
  }

  return <main className={`admin-page ${page !== 'settings' ? 'admin-auth-page' : 'admin-settings-page'}`}>
    <header className="admin-header"><a href="/transformer/" className="admin-brand">SVG <span>→</span> Code</a><a href="/transformer/">返回转换工作区 ↗</a></header>
    {page === 'settings' && <nav className="settings-tabs" aria-label="设置分类">{[['operating', '使用与限制'], ['queue', '排队与并发'], ['showcase', '公开示例'], ['account', '管理员账号']].map(([key, label]) => <button key={key} type="button" aria-current={tab === key ? 'page' : undefined} onClick={() => changeTab(key!)}>{label}</button>)}</nav>}
    <div className="admin-content" ref={contentRef}>
    <div className="admin-heading"><span className="admin-eyebrow">{page === 'settings' ? 'ADMINISTRATION' : 'WELCOME'}</span>
      <h1>{page === 'settings' ? '运营设置' : page === 'setup' ? '初始化管理账号' : recovery ? '恢复管理员密码' : '管理员登录'}</h1>
      <p>{page === 'settings' ? '管理访问范围、上传额度和公开示例，保存后自动生效。' : page === 'setup' ? '创建唯一管理员，并确认站点的初始运营设置。访客无需注册。' : '登录后管理这个站点的运营设置。'}</p>
    </div>
    {error && <div className="settings-error" role="alert">{error}{error.includes('登录已过期') && <a href="/transformer/login"> 重新登录</a>}</div>}
    {notice && <div className="settings-success" role="status">{notice}</div>}
    {!status && !error && <p role="status">正在加载…</p>}
    {status && page !== 'settings' && <form onSubmit={submitAuth}>
      <fieldset disabled={busy} className="settings-card auth-fields">
        {page === 'setup' && !status.adminMode && <label>一次性初始化码<input required autoComplete="off" value={token} onChange={e => setToken(e.target.value)} /><small>在服务器应用目录执行 <code>pnpm admin:setup-token</code> 获取，15 分钟有效。</small></label>}
        {page === 'setup' && status.adminMode && <div className="settings-notice">当前已通过旧管理员密钥验证。创建账号后，旧密钥登录将停用。</div>}
        {page === 'login' && (legacy || recovery) && <label>{recovery ? '一次性密码恢复码' : '原管理员密钥'}<input type="password" required autoComplete="off" value={token} onChange={e => setToken(e.target.value)} />{recovery && <small>在服务器执行 <code>pnpm admin:reset-password</code> 获取恢复码。</small>}</label>}
        {!recovery && !(page === 'login' && legacy) && <label>管理员账号<input required autoComplete="username" pattern="[a-zA-Z0-9_.@\-]{3,80}" value={username} onChange={e => setUsername(e.target.value)} /></label>}
        {!(page === 'login' && legacy) && <label>{recovery ? '新密码' : '密码'}<input type="password" required minLength={12} maxLength={256} autoComplete={page === 'setup' || recovery ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} /></label>}
        {(page === 'setup' || recovery) && <label>再次输入密码<input type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>}
      </fieldset>
      {page === 'setup' && settings && <OperatingFields value={settings} onChange={setSettings} disabled={busy} />}
      <button className="admin-primary auth-submit" type="submit" disabled={busy || (page === 'setup' && !settings)}>{busy ? '处理中…' : page === 'setup' ? '创建账号并启用站点' : recovery ? '重置密码' : '登录'}</button>
      {page === 'login' && <div className="auth-links">
        {status.legacyAvailable && <button type="button" disabled={busy} onClick={() => { setLegacy(!legacy); setRecovery(false) }}>{legacy ? '使用账号密码' : '使用原管理员密钥迁移'}</button>}
        {status.initialized && <button type="button" disabled={busy} onClick={() => { setRecovery(!recovery); setLegacy(false) }}>{recovery ? '返回登录' : '恢复密码'}</button>}
        {!status.initialized && <a href="/transformer/setup">首次初始化</a>}
      </div>}
    </form>}
    {page === 'settings' && status?.adminMode && settings && saved && <>
      <div hidden={tab !== 'queue'}><QueueSettingsPanel /></div>
      {tab === 'operating' && <form onSubmit={event => { event.preventDefault(); if (confirmExposure()) void act(async () => { const next = await saveSettings({ revision: saved.revision, settings }); setSaved(next); setSettings(next.settings); setNotice('设置已保存，后续请求将使用新设置。') }) }}>
        <OperatingFields value={settings} onChange={setSettings} disabled={busy} />
        <div className="settings-savebar"><span role="status">{dirty ? '有未保存的修改' : '设置已保存'}</span><div><button type="button" disabled={busy} onClick={() => { if (!dirty || window.confirm('放弃未保存的修改并重新加载？')) void act(refreshSettings) }}>重新加载</button><button type="submit" className="admin-primary" disabled={busy || !dirty}>{busy ? '保存中…' : '保存设置'}</button></div></div>
      </form>}
      {tab === 'showcase' && <section className="settings-card"><h2>公开示例管理</h2><p>设为示例后所有访客均可查看。普通用户不能删除示例，创建者仍可修改自己的任务。</p>{dirty && <div className="settings-notice">请先保存或撤销“使用与限制”中的修改，再调整示例。</div>}
        {!jobs.length && <p className="settings-empty">暂无任务，或转换服务暂不可用。</p>}
        {jobs.map(job => <div key={job.id} className="showcase-row"><div><strong>{job.designName || job.id}</strong><small>{job.id} · {job.isShowcase ? '公开示例' : '普通任务'}</small></div><button type="button" disabled={busy || Boolean(dirty)} onClick={() => { if (!job.isShowcase && !window.confirm('将此任务的文件和结果公开给所有访问者？')) return; void act(async () => { const next = await setJobShowcase(job.id, !job.isShowcase, saved.revision); setSaved({ ...saved, revision: next.revision }); setJobs(await loadJobs()); setNotice('示例状态已更新。') }) }}>{job.isShowcase ? '取消示例' : '设为示例'}</button></div>)}
      </section>}
      {tab === 'account' && <section className="settings-card"><h2>管理员账号</h2><p>当前账号：{status.username}。修改密码后所有管理会话失效，需要重新登录。</p>
        <form className="auth-fields" onSubmit={e => { e.preventDefault(); void act(async () => { requireMatchingPassword(); await changePassword(currentPassword, password); go('login') }) }}>
          <label>当前密码<input required type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} /></label>
          <label>新密码<input required type="password" minLength={12} maxLength={256} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
          <label>再次输入新密码<input required type="password" minLength={12} maxLength={256} autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>
          <button type="submit" className="admin-primary" disabled={busy}>修改密码并重新登录</button>
        </form><button className="admin-logout" type="button" disabled={busy} onClick={() => void act(async () => { if (dirty && !window.confirm('退出将放弃未保存的设置，是否继续？')) return; await endAdminSession(); go('login') })}>退出管理员</button>
      </section>}
    </>}
    <footer className="admin-footer">SVG to HTML · 在线管理</footer>
    </div>
  </main>
}

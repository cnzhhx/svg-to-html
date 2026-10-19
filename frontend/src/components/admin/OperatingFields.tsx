import type { OperatingSettings } from '../../api/settings'

export function OperatingFields({ value, onChange, disabled = false }: {
  value: OperatingSettings
  onChange: (next: OperatingSettings) => void
  disabled?: boolean
}) {
  const change = <K extends keyof OperatingSettings>(key: K, next: OperatingSettings[K]) => onChange({ ...value, [key]: next })
  return (
    <fieldset className="operating-fields" disabled={disabled}>
      <section className="settings-card">
        <h2>访问控制</h2><p>选择访客可以看到哪些转换任务。</p>
        <label className="setting-toggle"><span><strong>隔离不同浏览器的任务</strong><small>开启后，仅创建者和管理员可见；公开示例除外。</small></span>
          <input type="checkbox" role="switch" checked={value.accessIsolationEnabled} onChange={e => change('accessIsolationEnabled', e.target.checked)} />
        </label>
        {!value.accessIsolationEnabled && <div className="settings-notice">关闭隔离后，所有访客都能查看、预览和下载已有任务。修改和删除仍限创建者或管理员。</div>}
      </section>
      <section className="settings-card">
        <h2>上传额度</h2><p>按浏览器计算每日上传次数，管理员不受此限制。</p>
        <label className="setting-toggle"><span><strong>启用每日额度</strong><small>关闭后不限次数，仍保留用量记录。</small></span>
          <input type="checkbox" role="switch" checked={value.quotaEnabled} onChange={e => change('quotaEnabled', e.target.checked)} />
        </label>
        <div className="settings-grid">
          <label>每日上传次数<input type="number" min="1" max="100000" required value={value.dailyUploadLimit} onChange={e => change('dailyUploadLimit', e.target.valueAsNumber)} /></label>
          <label>额度时区<input list="quota-timezones" required value={value.timeZone} onChange={e => change('timeZone', e.target.value)} /><datalist id="quota-timezones"><option value="Asia/Shanghai" /><option value="Asia/Singapore" /><option value="UTC" /><option value="America/New_York" /></datalist></label>
        </div>
        <small>修改时区会改变每日额度的日期边界；已接受的任务不受影响。</small>
      </section>
      <section className="settings-card">
        <h2>上传与等待时间</h2><p>设置文件大小限制与排队页面的时间估算。</p>
        <div className="settings-grid">
          <label>最大 SVG 文件（MB）<input type="number" min="1" max="50" required value={value.maxSvgUploadMb} onChange={e => change('maxSvgUploadMb', e.target.valueAsNumber)} /></label>
          <label>单任务预计耗时（分钟）<input type="number" min="1" max="1440" required value={value.estimatedTaskMinutes} onChange={e => change('estimatedTaskMinutes', e.target.valueAsNumber)} /></label>
        </div>
        <small>等待时间仅为估算，此设置不会调整转换服务的实际并发。</small>
      </section>
      <section className="settings-card">
        <h2>公开示例</h2><p>允许访客将作品加入公开展示。</p>
        <label className="setting-toggle"><span><strong>允许用户提交公开示例</strong><small>关闭后不接受新的用户示例，已有示例继续保留。</small></span>
          <input type="checkbox" role="switch" checked={value.allowUserShowcase} onChange={e => change('allowUserShowcase', e.target.checked)} />
        </label>
      </section>
    </fieldset>
  )
}

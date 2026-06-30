import { useEffect, useMemo, useState } from 'react'
import type { RuntimeInfo, RuntimeSettingsField } from '../../types/runtime'
import type { ModelChannel, RuntimeSettingValues } from '../../types/settings'
import {
  SETTINGS_SECTIONS,
  createModelChannel,
  getRuntimeFieldBaseline,
  readStoredActiveModelChannelId,
  readStoredModelChannels,
  readStoredRunSettings,
  writeStoredModelChannels,
  writeStoredRunSettings,
} from '../../utils/settings'

const FIELD_TEXT: Record<string, { description: string; label: string }> = {
  'agent.defaultReasoningEffort': { description: '默认推理强度，未单独指定时作为 agent 的兜底值。', label: '默认推理强度' },
  'agent.maxParallelModuleAgents': { description: '单个任务内同时运行的模块 agent 数量。', label: '模块并发数' },
  'agent.moduleTimeoutMs': { description: '单个模块 agent 最长执行时间，单位毫秒。', label: '模块超时时间' },
  'agent.semanticVisionConcurrency': { description: '视觉语义分析的并发上限。', label: '视觉分析并发' },
  'agent.supportReasoningEffort': { description: '规划、辅助和视觉调用使用的推理强度。', label: '辅助推理强度' },
  'agent.unitReasoningEffort': { description: '单个模块 agent 回合使用的推理强度。', label: '模块推理强度' },
  'diff.diffRatioThreshold': { description: '整页视觉差异通过阈值，0.05 表示 5%。数值越低，还原度要求越高。', label: '整页视觉差异阈值' },
  'diff.moduleDiffRatioThreshold': { description: '单模块视觉差异通过阈值。', label: '模块视觉差异阈值' },
  'diff.pngRasterScaleMultiplier': { description: '导出 PNG 局部资产时额外放大的倍率。', label: 'PNG 导出倍率' },
  'logging.maxSessionLogChars': { description: '单条 session 日志最多保留的字符数。', label: '单条日志长度' },
  'runtime.opencodeCliPath': { description: '启动 opencode CLI 的命令或绝对路径。', label: 'opencode 路径' },
  'session.visionTextTimeoutMs': { description: '视觉文字识别最长等待时间，单位毫秒。', label: '视觉文字识别超时' },
  'workflow.archiveFullEveryN': { description: '每隔多少轮保存一次完整工作流归档。', label: '完整归档间隔' },
  'workflow.archiveTextMaxChars': { description: '工作流归档中单段文本最多保留的字符数。', label: '归档文本长度' },
  'workflow.modelPlannerMockResponse': { description: '开发调试用，填写后规划器跳过真实模型调用。', label: '规划器模拟响应' },
  'workflow.modelPlannerTurnTimeoutMs': { description: '模型规划器单轮最长等待时间，单位毫秒。', label: '规划器超时' },
}

const sourceLabel = (source: string) => {
  if (source === 'frontend') return '前端覆盖'
  if (source === 'env') return '后端 env'
  return '默认值'
}

const getFieldText = (field: RuntimeSettingsField) => FIELD_TEXT[field.configKey] || {
  description: field.description,
  label: field.configKey,
}

const parseSettingValue = (field: RuntimeSettingsField, raw: string) => {
  if (raw === '') return undefined
  if (field.type === 'boolean') return raw === 'true'
  if (field.type === 'number') {
    const value = Number(raw)
    return Number.isFinite(value) ? value : undefined
  }
  return raw
}

export function SettingsDialog({
  onClose,
  open,
  runtime,
}: {
  onClose: () => void
  open: boolean
  runtime: RuntimeInfo | null
}) {
  const [activeSection, setActiveSection] = useState('model')
  const [values, setValues] = useState<RuntimeSettingValues>(() => readStoredRunSettings())
  const [channels, setChannels] = useState<ModelChannel[]>(() => readStoredModelChannels())
  const [activeChannelId, setActiveChannelId] = useState(() => readStoredActiveModelChannelId(readStoredModelChannels()))

  const fields = runtime?.frontendSettingsFields || []
  const advancedFields = useMemo(() => fields.filter((field) => field.section !== 'model'), [fields])
  const sections = useMemo(
    () => SETTINGS_SECTIONS.filter((section) => section.id === 'model' || advancedFields.some((field) => field.section === section.id)),
    [advancedFields],
  )
  const sensitiveEnvNames = useMemo(() => new Set(fields.filter((field) => field.sensitive).map((field) => field.envName)), [fields])
  const activeChannel = activeChannelId ? channels.find((channel) => channel.id === activeChannelId) || null : null
  const overrideCount = useMemo(
    () => Object.entries(values).filter(([, value]) => value !== '' && value !== null && value !== undefined).length + (activeChannel ? 1 : 0),
    [activeChannel, values],
  )

  useEffect(() => {
    if (!open) return
    const nextChannels = readStoredModelChannels()
    setValues(readStoredRunSettings())
    setChannels(nextChannels)
    setActiveChannelId(readStoredActiveModelChannelId(nextChannels))
  }, [open])

  useEffect(() => {
    if (sections.length && !sections.some((section) => section.id === activeSection)) {
      setActiveSection(sections[0]?.id || 'model')
    }
  }, [activeSection, sections])

  if (!open) return null

  const defaults = {
    baseURL: getRuntimeFieldBaseline(fields.find((field) => field.envName === 'MODEL_BASE_URL')),
    model: getRuntimeFieldBaseline(fields.find((field) => field.envName === 'MODEL_ID')),
    name: [getRuntimeFieldBaseline(fields.find((field) => field.envName === 'MODEL_PROVIDER_NAME')), getRuntimeFieldBaseline(fields.find((field) => field.envName === 'MODEL_ID'))].filter(Boolean).join(' / '),
    provider: getRuntimeFieldBaseline(fields.find((field) => field.envName === 'MODEL_PROVIDER')),
    reasoningEffort: getRuntimeFieldBaseline(fields.find((field) => field.envName === 'MODEL_REASONING_EFFORT')),
    wireApi: getRuntimeFieldBaseline(fields.find((field) => field.envName === 'MODEL_WIRE_API')) || 'chat-completions',
  }

  const persistChannels = (nextChannels: ModelChannel[], nextActiveId = activeChannelId) => {
    setChannels(nextChannels)
    setActiveChannelId(nextActiveId)
    writeStoredModelChannels(nextChannels, nextActiveId)
  }

  const save = () => {
    writeStoredRunSettings(values, sensitiveEnvNames)
    writeStoredModelChannels(channels, activeChannelId)
    onClose()
  }

  const clear = () => {
    setValues({})
    setChannels([])
    setActiveChannelId('')
    writeStoredRunSettings({}, sensitiveEnvNames)
    writeStoredModelChannels([], '')
  }

  return (
    <div className="dialog-backdrop">
      <div className="settings-dialog open" role="dialog" aria-modal="true">
        <div className="settings-dialog-content">
          <div className="settings-dialog-header">
            <h3 className="settings-dialog-title">执行设置</h3>
            <button className="icon-btn settings-dialog-close" onClick={onClose} title="关闭设置" type="button">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className={`settings-dialog-status${overrideCount ? ' has-overrides' : ''}`}>
            {runtime?.frontendSettingsEnabled
              ? overrideCount ? `已配置 ${overrideCount} 个前端覆盖项，执行时随请求发送` : '未配置前端覆盖项，执行时使用后端 env'
              : '前端设置入口未启用，当前只读。'}
          </div>
          <div className="settings-dialog-fields">
            <nav className="settings-nav" aria-label="设置模块">
              {sections.map((section) => (
                <button className={`settings-nav-item${section.id === activeSection ? ' is-active' : ''}`} key={section.id} onClick={() => setActiveSection(section.id)} type="button">
                  {section.label}
                </button>
              ))}
            </nav>
            <div className="settings-panel">
              {activeSection === 'model' ? (
                <ModelSettingsPanel
                  activeChannel={activeChannel}
                  activeChannelId={activeChannelId}
                  channels={channels}
                  disabled={!runtime?.frontendSettingsEnabled}
                  onAdd={() => {
                    const channel = createModelChannel({}, defaults)
                    persistChannels([...channels, channel], channel.id)
                  }}
                  onChange={(patch) => {
                    if (!activeChannel) return
                    persistChannels(channels.map((channel) => channel.id === activeChannel.id ? { ...channel, ...patch } : channel))
                  }}
                  onDelete={() => {
                    if (!activeChannel) return
                    const nextChannels = channels.filter((channel) => channel.id !== activeChannel.id)
                    persistChannels(nextChannels, nextChannels[0]?.id || '')
                  }}
                  onSelect={(id) => {
                    setActiveChannelId(id)
                    writeStoredModelChannels(channels, id)
                  }}
                />
              ) : (
                <AdvancedSettingsSection
                  disabled={!runtime?.frontendSettingsEnabled}
                  fields={advancedFields.filter((field) => field.section === activeSection)}
                  onChange={(field, raw) => {
                    const value = parseSettingValue(field, raw)
                    setValues((previous) => {
                      const next = { ...previous }
                      if (value === undefined) delete next[field.envName]
                      else next[field.envName] = value
                      return next
                    })
                  }}
                  sectionLabel={sections.find((section) => section.id === activeSection)?.label || activeSection}
                  values={values}
                />
              )}
            </div>
          </div>
          <div className="settings-dialog-actions">
            <button className="upload-dialog-cancel settings-dialog-clear" onClick={clear} type="button">清空覆盖</button>
            <button className="upload-dialog-cancel" onClick={onClose} type="button">取消</button>
            <button className="upload-dialog-submit" disabled={!runtime?.frontendSettingsEnabled} onClick={save} type="button">保存</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ModelSettingsPanel({
  activeChannel,
  activeChannelId,
  channels,
  disabled,
  onAdd,
  onChange,
  onDelete,
  onSelect,
}: {
  activeChannel: ModelChannel | null
  activeChannelId: string
  channels: ModelChannel[]
  disabled: boolean
  onAdd: () => void
  onChange: (patch: Partial<ModelChannel>) => void
  onDelete: () => void
  onSelect: (id: string) => void
}) {
  return (
    <section className="model-settings-panel">
      <div className="model-channel-sidebar">
        <div className="model-channel-head">
          <div className="settings-section-title">大模型渠道</div>
        </div>
        <div className="model-channel-list">
          <button className={`model-channel-item${activeChannelId ? '' : ' is-active'}`} disabled={disabled} onClick={() => onSelect('')} type="button">
            <span>使用后端 env</span>
            <small>不发送前端模型覆盖</small>
          </button>
          {channels.length ? channels.map((channel) => (
            <button className={`model-channel-item${channel.id === activeChannelId ? ' is-active' : ''}`} disabled={disabled} key={channel.id} onClick={() => onSelect(channel.id)} type="button">
              <span>{channel.name || channel.provider || '未命名渠道'}</span>
              <small>{channel.model || '未填写模型'}</small>
            </button>
          )) : <div className="model-channel-empty">还没有大模型渠道</div>}
        </div>
      </div>
      <div className="model-channel-editor">
        {activeChannel ? (
          <>
            <div className="model-editor-head">
              <div>
                <div className="settings-section-title">当前渠道</div>
                <h4 className="model-editor-title">{activeChannel.name || '未命名渠道'}</h4>
              </div>
              <div className="model-editor-actions">
                <button className="upload-dialog-submit" disabled={disabled} onClick={onAdd} type="button">添加渠道</button>
                <button className="upload-dialog-cancel" disabled={disabled} onClick={onDelete} type="button">删除渠道</button>
              </div>
            </div>
            <div className="model-editor-grid">
              <ModelInput disabled={disabled} label="渠道名称" onChange={(name) => onChange({ name })} placeholder="例如：OpenAI 主账号" value={activeChannel.name || ''} />
              <ModelInput disabled={disabled} label="提供商标识" onChange={(provider) => onChange({ provider })} placeholder="例如：openai / anthropic / deepseek" value={activeChannel.provider || ''} />
              <ModelInput disabled={disabled} label="接口地址" onChange={(baseURL) => onChange({ baseURL })} placeholder="例如：https://api.openai.com/v1" value={activeChannel.baseURL || ''} />
              <ModelInput disabled={disabled} label="模型名称" onChange={(model) => onChange({ model })} placeholder="例如：gpt-4.1 / claude-sonnet-4" value={activeChannel.model || ''} />
              <ModelInput disabled={disabled} label="API Key" onChange={(apiKey) => onChange({ apiKey })} placeholder={activeChannel.apiKey ? '已在本页面配置；留空保存会保留' : '执行时发送给后端，不写入本地存储'} type="password" value="" />
              <label className="settings-field model-editor-field">
                <span className="settings-field-main">
                  <span className="settings-field-name">协议格式</span>
                  <span className="settings-field-description">后端调用模型服务时使用的协议。</span>
                </span>
                <span className="settings-field-control">
                  <select className="settings-input" disabled={disabled} onChange={(event) => onChange({ wireApi: event.target.value })} value={activeChannel.wireApi || 'chat-completions'}>
                    {['chat-completions', 'responses', 'anthropic'].map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </span>
              </label>
              <label className="settings-field model-editor-field">
                <span className="settings-field-main">
                  <span className="settings-field-name">推理强度</span>
                  <span className="settings-field-description">留空时使用后端默认推理强度。</span>
                </span>
                <span className="settings-field-control">
                  <select className="settings-input" disabled={disabled} onChange={(event) => onChange({ reasoningEffort: event.target.value })} value={activeChannel.reasoningEffort || ''}>
                    <option value="">后端默认</option>
                    {['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </span>
              </label>
            </div>
            <div className="settings-field-meta">默认支持视觉输入；运行时使用 opencode，其余高级模型属性沿用后端默认值。</div>
          </>
        ) : (
          <div className="model-empty-editor">
            <div>
              <div className="settings-section-title">当前使用后端 env</div>
              <p>不会发送前端大模型覆盖。</p>
            </div>
            <button className="upload-dialog-submit" disabled={disabled} onClick={onAdd} type="button">添加渠道</button>
          </div>
        )}
      </div>
    </section>
  )
}

function ModelInput({ disabled, label, onChange, placeholder, type = 'text', value }: { disabled: boolean; label: string; onChange: (value: string) => void; placeholder: string; type?: string; value: string }) {
  return (
    <label className="settings-field model-editor-field">
      <span className="settings-field-main">
        <span className="settings-field-name">{label}</span>
      </span>
      <span className="settings-field-control">
        <input className="settings-input" disabled={disabled} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} type={type} value={value} />
      </span>
    </label>
  )
}

function AdvancedSettingsSection({ disabled, fields, onChange, sectionLabel, values }: { disabled: boolean; fields: RuntimeSettingsField[]; onChange: (field: RuntimeSettingsField, raw: string) => void; sectionLabel: string; values: RuntimeSettingValues }) {
  return (
    <section className="settings-section">
      <div className="settings-section-title">{sectionLabel}</div>
      {fields.map((field) => {
        const text = getFieldText(field)
        const hasOverride = Object.prototype.hasOwnProperty.call(values, field.envName)
        const value = hasOverride ? values[field.envName] : getRuntimeFieldBaseline(field)
        const meta = hasOverride
          ? field.sensitive ? '已设置前端覆盖值' : `前端覆盖：${String(values[field.envName])}`
          : field.value !== null && field.value !== undefined ? `当前来源：${sourceLabel(field.source)}` : '当前未配置'
        return (
          <label className="settings-field" key={field.envName}>
            <span className="settings-field-main">
              <span className="settings-field-name">{text.label}</span>
              <span className="settings-field-env">{field.envName}</span>
              <span className="settings-field-description">{text.description}</span>
            </span>
            <span className="settings-field-control">
              <SettingControl disabled={disabled} field={field} onChange={(raw) => onChange(field, raw)} value={field.sensitive ? '' : String(value ?? '')} />
              <span className="settings-field-meta">{meta}</span>
            </span>
          </label>
        )
      })}
    </section>
  )
}

function SettingControl({ disabled, field, onChange, value }: { disabled: boolean; field: RuntimeSettingsField; onChange: (value: string) => void; value: string }) {
  if (field.options?.length) {
    return (
      <select className="settings-input" disabled={disabled} onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">使用后端 env</option>
        {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    )
  }
  if (field.type === 'boolean') {
    return (
      <select className="settings-input" disabled={disabled} onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">使用后端 env</option>
        <option value="true">开启</option>
        <option value="false">关闭</option>
      </select>
    )
  }
  return (
    <input
      className="settings-input"
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      placeholder={field.sensitive ? '留空则使用后端 env；填写后仅本页面临时生效' : '留空则使用后端 env'}
      type={field.sensitive ? 'password' : field.type === 'number' ? 'number' : 'text'}
      value={value}
    />
  )
}

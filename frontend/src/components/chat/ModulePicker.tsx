import type { AgentEvent } from '../../types/events'
import type { Session } from '../../types/session'
import { collectSelectableModules } from '../../utils/modules'

type ModuleState = {
  key: 'done' | 'failed' | 'pending' | 'running'
  label: string
}

const terminalStatuses = new Set(['completed', 'failed', 'interrupted'])
const turnEndEvents = new Set(['turn.completed', 'turn.failed'])

function getAgentEventModuleId(event: AgentEvent) {
  const item = event.item
  const direct = String(event.moduleId || item?.moduleId || '').trim()
  if (direct) return direct
  const source = String(event.sourceLabel || item?.server || item?.tool || '').trim()
  return source.match(/module-\d+/i)?.[0] || ''
}

function collectActiveModuleIds(agentEvents: AgentEvent[]) {
  const active = new Set<string>()
  agentEvents.forEach((event) => {
    const moduleId = getAgentEventModuleId(event)
    if (!moduleId) return
    const eventType = String(event.type || '').trim()
    const itemStatus = String(event.item?.status || '').trim().toLowerCase()
    if (eventType === 'turn.started') {
      active.add(moduleId)
      return
    }
    if (turnEndEvents.has(eventType)) {
      active.delete(moduleId)
      return
    }
    if (
      eventType === 'item.started' ||
      eventType === 'item.updated' ||
      eventType === 'item.completed' ||
      itemStatus === 'in_progress' ||
      itemStatus === 'running'
    ) {
      active.add(moduleId)
    }
  })
  return active
}

function deriveModuleState(status: string, active: boolean): ModuleState {
  const normalized = status.trim().toLowerCase()
  if (normalized === 'completed') return { key: 'done', label: '已完成' }
  if (normalized === 'failed') return { key: 'failed', label: '执行失败' }
  if (normalized === 'interrupted') return { key: 'running', label: '调整中' }
  if (active && !terminalStatuses.has(normalized)) return { key: 'running', label: '进行中' }
  return { key: 'pending', label: '等待中' }
}

function formatModuleLabel(id: string) {
  const match = id.match(/^module-(\d+)$/i)
  if (!match) return id
  return `模块${Number(match[1])}`
}

export function ModulePicker({
  agentEvents,
  onSelectModule,
  selectedModuleId,
  session,
}: {
  agentEvents: AgentEvent[]
  onSelectModule: (id: string | null) => void
  selectedModuleId: string | null
  session: Session | null
}) {
  const modules = collectSelectableModules(session)
  const activeModuleIds = collectActiveModuleIds(agentEvents)
  const sessionActiveModuleIds = session?.result?.moduleActiveIds || []
  sessionActiveModuleIds.forEach((moduleId) => {
    const normalized = String(moduleId || '').trim()
    if (normalized) activeModuleIds.add(normalized)
  })
  return (
    <div className={`module-picker${modules.length ? '' : ' is-empty'}`}>
      <div className="module-picker-list">
        {modules.length ? (
          <>
            <button
              className={`module-picker-option${!selectedModuleId ? ' is-selected' : ''}`}
              onClick={() => onSelectModule(null)}
              type="button"
            >
              全部
            </button>
            {modules.map((module) => {
              const state = deriveModuleState(module.status, activeModuleIds.has(module.id))
              const label = formatModuleLabel(module.id)
              return (
                <button
                  className={`module-picker-option state-${state.key}${module.id === selectedModuleId ? ' is-selected' : ''}`}
                  data-module-id={module.id}
                  key={module.id}
                  onClick={() => onSelectModule(module.id)}
                  title={`${label} · ${module.id} · ${state.label}`}
                  type="button"
                >
                  <span className={`module-picker-dot is-${state.key}`} aria-hidden="true" />
                  <span className="module-picker-label">{label}</span>
                  <span className="module-picker-state-text">{state.label}</span>
                </button>
              )
            })}
          </>
        ) : (
          <span className="chat-drawer-meta">生成完成后可选择模块</span>
        )}
      </div>
    </div>
  )
}

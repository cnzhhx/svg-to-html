import type { ModuleAgentRun, ModulePlanModule, Region, Session } from '../types/session'

export type SelectableModule = {
  id: string
  region: Region
  status: string
}

export function sortModuleIds(ids: Iterable<string>) {
  return [...ids].sort((left, right) => {
    const leftNumber = Number(String(left).match(/(\d+)$/)?.[1])
    const rightNumber = Number(String(right).match(/(\d+)$/)?.[1])
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
      return leftNumber - rightNumber
    }
    return String(left).localeCompare(String(right))
  })
}

export function collectSelectableModules(session?: Session | null): SelectableModule[] {
  const planned = Array.isArray(session?.result?.modulePlanModules)
    ? (session?.result?.modulePlanModules as ModulePlanModule[])
    : []
  const runs = Array.isArray(session?.result?.moduleAgentRuns)
    ? (session?.result?.moduleAgentRuns as ModuleAgentRun[])
    : []
  const byId = new Map<string, SelectableModule>()
  planned.forEach((module) => {
    const id = String(module?.id || '').trim()
    const region = module?.region
    if (!id || !region) return
    byId.set(id, {
      id,
      region,
      status: '',
    })
  })
  runs.forEach((run) => {
    const id = String(run?.id || '').trim()
    const region = run?.region
    if (!id || !region) return
    byId.set(id, {
      id,
      region,
      status: run.status || '',
    })
  })
  return [...byId.values()].sort((left, right) => {
    const leftY = Number(left.region?.y || 0)
    const rightY = Number(right.region?.y || 0)
    if (leftY !== rightY) return leftY - rightY
    return String(left.id).localeCompare(String(right.id))
  })
}

export function collectChatFilterModules(session?: Session | null) {
  const ids = new Set<string>()
  collectSelectableModules(session).forEach((module) => {
    if (module.id) ids.add(module.id)
  })
  Object.keys(session?.result?.moduleAgentThreadIds || {}).forEach((id) => {
    if (id) ids.add(id)
  })
  ;(session?.result?.moduleFailedIds || []).forEach((id) => {
    if (id) ids.add(String(id))
  })
  const moduleCount = Number(session?.result?.moduleCount)
  if (Number.isFinite(moduleCount) && moduleCount > 0 && moduleCount <= 99) {
    for (let index = 1; index <= moduleCount; index += 1) {
      ids.add(`module-${String(index).padStart(2, '0')}`)
    }
  }
  ;(session?.messages || []).forEach((message) => {
    const moduleId = String(message?.moduleId || '').trim()
    if (moduleId) ids.add(moduleId)
  })
  return sortModuleIds(ids)
}

export function computeModuleOverlayBoxes({
  designHeight,
  designWidth,
  modules,
}: {
  designHeight: number
  designWidth: number
  modules: SelectableModule[]
}) {
  if (designWidth <= 0 || designHeight <= 0) return []
  return modules.flatMap((module, index) => {
    const region = module.region || {}
    const left = (Number(region.x || 0) / designWidth) * 100
    const top = (Number(region.y || 0) / designHeight) * 100
    const width = (Number(region.width || 0) / designWidth) * 100
    const height = (Number(region.height || 0) / designHeight) * 100
    if (width <= 0 || height <= 0) return []
    return [{ id: module.id, index, left, top, width, height }]
  })
}

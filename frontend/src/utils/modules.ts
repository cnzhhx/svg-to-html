import type { ModuleAgentRun, ModulePlanModule, Region, Session } from '../types/session'

export type SelectableModule = {
  id: string
  region: Region
  status: string
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

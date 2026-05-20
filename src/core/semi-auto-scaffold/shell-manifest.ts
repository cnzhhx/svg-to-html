import type { ContainerLayoutReport } from '../container-layout/types.js'
import type { ShellManifestEntry } from './types.js'

const createShellManifest = async ({
  containerLayout: _containerLayout,
}: {
  containerLayout: ContainerLayoutReport
}): Promise<ShellManifestEntry[]> => []

export { createShellManifest }

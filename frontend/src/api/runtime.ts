import type { RuntimeInfo } from '../types/runtime'
import { apiJson } from './http'

export const loadRuntimeInfo = () => apiJson<RuntimeInfo>('/api/runtime')

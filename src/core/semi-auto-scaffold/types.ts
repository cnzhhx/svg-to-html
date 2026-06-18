import type { Box } from '../geometry.js';

type StructureDraftNode = {
  box: Box
  children: string[]
  containerId: null | string
  id: string
  patternKinds: string[]
  repeatGroupId: null | string
  role:
    | 'container'
    | 'group'
    | 'repeat-item'
    | 'repeat-list'
    | 'token-cell'
    | 'token-row'
  selector: string
  tag: 'article' | 'div' | 'section'
}

type StructureDraft = {
  designName: string
  nodes: StructureDraftNode[]
  pageSelector: string
  topLevelNodeIds: string[]
}

type SemiAutoScaffoldResult = {
  artifactDir: string
  htmlScaffold: string
  scaffoldDecisionsPath: string
  structureDraft: StructureDraft
  structureDraftPath: string
}

export type {
  SemiAutoScaffoldResult,
  StructureDraft,
  StructureDraftNode,
}

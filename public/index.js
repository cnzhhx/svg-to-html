const $ = (sel) => document.querySelector(sel)

const basePath = '/transformer'

const appShell = $('#appShell')
const fileInput = $('#fileInput')
const uploadZone = $('#uploadZone')
const uploadZoneLabel = $('#uploadLabel')
const uploadDialog = $('#uploadDialog')
const uploadDialogFileInput = $('#uploadDialogFileInput')
const uploadDialogFileName = $('#uploadDialogFileName')
const uploadDialogSubmit = $('#uploadDialogSubmit')
const uploadDialogCancel = $('#uploadDialogCancel')
const uploadScaleSelect = $('#uploadScaleSelect')
const uploadFormatReact = $('#uploadFormatReact')
const uploadFormatVue = $('#uploadFormatVue')
const sidebarToggleBtn = $('#sidebarToggleBtn')
const chatToggleBtn = $('#chatToggleBtn')
const chatDrawer = $('#chatDrawer')
const chatCloseBtn = $('#chatCloseBtn')
const sessionList = $('#sessionList')
const sessionTitle = $('#sessionTitle')
const sessionMeta = $('#sessionMeta')
const executionBadge = $('#executionBadge')
const chatStatus = $('#chatStatus')
const modulePicker = $('#modulePicker')
const modulePickerList = $('#modulePickerList')
const selectedModuleLabel = $('#selectedModuleLabel')
const messageList = $('#messageList')
const resultGrid = $('#resultGrid')
const resultUrls = $('#resultUrls')
const resultActions = $('#resultActions')
const resultPanel = $('#resultPanel')
const resultDiffGap = $('#resultDiffGap')
const resultTokenBadge = $('#resultTokenBadge')
const resultCacheStatus = $('#resultCacheStatus')
const previewSizeRange = $('#previewSizeRange')
const previewSizeValue = $('#previewSizeValue')
const pauseBtn = $('#pauseBtn')
const resumeBtn = $('#resumeBtn')
const deleteSessionBtn = $('#deleteSessionBtn')
const sendBtn = $('#sendBtn')
const composer = $('#composer')
const messageInput = $('#messageInput')
const composerHint = $('#composerHint')
const runtimeInfo = $('#runtimeInfo')
const downloadBtn = $('#downloadBtn')
const workflowPanel = $('#workflowPanel')
const workflowCurrent = $('#workflowCurrent')
const workflowDetail = $('#workflowDetail')
const workflowModuleWarning = $('#workflowModuleWarning')
const workflowNodes = $('#workflowNodes')

let sessions = []
let currentSessionId = null
let currentSession = null
let eventSource = null
let uploadInFlight = false
let sidebarCollapsed = readStoredBoolean('svg2html:sidebarCollapsed', true)
let chatDrawerOpen = false
let selectedModuleId = null
const autoArtifactCacheStarted = new Set()
const localArtifactCacheInFlight = new Set()
const localArtifactCacheMetaBySession = new Map()
let syncingResultPreviewScroll = false

const LOCAL_STORAGE_KEY = 'svg2html:sessions'
const LOCAL_SESSION_SNAPSHOT_KEY = 'svg2html:sessionSnapshots'
const LOCAL_SESSION_LIMIT = Number.POSITIVE_INFINITY
const LOCAL_SESSION_MESSAGE_LIMIT = 80
const LOCAL_SESSION_TEXT_LIMIT = 2000
const RESULT_PREVIEW_SIZE_KEY = 'svg2html:resultPreviewWidth'
const RESULT_PREVIEW_WIDTH_MIN = 375
const RESULT_PREVIEW_WIDTH_MAX = 1920
const RESULT_PREVIEW_WIDTH_DEFAULT = 375
const LOCAL_ARTIFACT_DB_NAME = 'svg2html:artifactCache'
const LOCAL_ARTIFACT_DB_VERSION = 1
const LOCAL_ARTIFACT_FILE_STORE = 'files'
const LOCAL_ARTIFACT_SESSION_STORE = 'sessions'
const LOCAL_ARTIFACT_RESULT_KEYS = [
  'localArtifactCacheStatus',
  'localArtifactCacheFileCount',
  'localArtifactCacheByteSize',
  'localArtifactCachePaths',
  'localArtifactCacheAt',
  'localArtifactCacheError',
]
const UPLOAD_SCALE_KEY = 'svg2html:uploadScale'
const DEFAULT_DIFF_RATIO_THRESHOLD = 0.15
const DEFAULT_MODULE_CONCURRENCY_LIMIT = 5
const DEFAULT_AGENT_TIMEOUT_MS = 3600000
const urlParams = new URLSearchParams(location.search)
const isDevMode = urlParams.has('dev')
const urlSessionId = urlParams.get('session')
const WORKFLOW_NODE_ORDER = ['upload', 'analysis', 'agent', 'verify', 'export', 'feedback', 'done']
const LEGACY_ANALYSIS_NODE_KEY = 'pre' + 'process'
const HTML_REFERENCE_PATTERN =
  /(?:src|href|poster)=["']([^"'<>]+)["']|url\((['"]?)([^)"']+)\2\)/g
const SESSION_DURATION_NODE_ORDER = ['analysis', 'agent', 'verify', 'export', 'feedback', 'done']

let diffRatioThreshold = DEFAULT_DIFF_RATIO_THRESHOLD
let runtimeWorkspaceRoot = null
let selectedUploadScale = readStoredUploadScale()

function getLocalSessionIds() {
  try {
    const value = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '[]')
    return Array.isArray(value) ? value.filter(Boolean).map(String) : []
  } catch {
    return []
  }
}

function saveLocalSessionId(id) {
  if (!id) return
  const ids = getLocalSessionIds().filter((item) => item !== id)
  ids.unshift(id)
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(ids.slice(0, LOCAL_SESSION_LIMIT)))
  } catch {
    // ignore storage failures
  }
}

function removeLocalSessionId(id) {
  const ids = getLocalSessionIds().filter((i) => i !== id)
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // ignore storage failures
  }
  removeLocalSessionSnapshot(id)
}

function readLocalSessionSnapshots() {
  try {
    const value = JSON.parse(localStorage.getItem(LOCAL_SESSION_SNAPSHOT_KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function writeLocalSessionSnapshots(snapshots) {
  try {
    localStorage.setItem(LOCAL_SESSION_SNAPSHOT_KEY, JSON.stringify(snapshots))
  } catch (error) {
    console.warn('[sessions] failed to persist local session snapshots', error)
  }
}

function uniqueIds(ids) {
  return [...new Set(ids.filter(Boolean).map(String))]
}

function getLocalSessionSnapshotIds() {
  return Object.values(readLocalSessionSnapshots())
    .sort((a, b) => Number(b.localSavedAt || b.updatedAt || 0) - Number(a.localSavedAt || a.updatedAt || 0))
    .map((snapshot) => snapshot.id)
    .filter(Boolean)
}

function truncateForLocalStorage(value, limit = LOCAL_SESSION_TEXT_LIMIT) {
  const text = String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function compactMessagesForLocalStorage(messages) {
  if (!Array.isArray(messages)) return []
  return messages
    .filter((message) => message && message.codexItemType !== 'reasoning')
    .slice(-LOCAL_SESSION_MESSAGE_LIMIT)
    .map((message) => ({
      id: String(message.id || `local-${Date.now()}`),
      role: message.role || 'assistant',
      kind: message.kind || 'chat',
      text: truncateForLocalStorage(message.text),
      createdAt: Number(message.createdAt) || Date.now(),
      codexEventType: message.codexEventType,
      codexItemType: message.codexItemType,
    }))
}

function compactResultForLocalStorage(result) {
  if (!result || typeof result !== 'object') return {}
  const keys = [
    'agentTimeoutMs',
    'artifactDir',
    'compareHtmlPath',
    'diffPngPath',
    'diffRatio',
    'finalOutputPolicyPath',
    'finalOutputPolicyPassed',
    'finalOutputReady',
    'frameworkExports',
    'htmlPath',
    'htmlPngPath',
    'inputTokens',
    'layoutBoxReportPath',
    'layoutBoxPassed',
    'moduleConcurrencyLimit',
    'moduleCount',
    'outputTokens',
    'qualityStatus',
    'svgPngPath',
    'textBoxReportPath',
    'tokensUsed',
    'verifyMode',
    'verifyReportPath',
    'workflowLintPassed',
    'workflowLintPath',
    ...LOCAL_ARTIFACT_RESULT_KEYS,
  ]
  const compact = {}
  keys.forEach((key) => {
    if (result[key] !== undefined) compact[key] = result[key]
  })
  return compact
}

function mergeLocalArtifactResult(sourceResult, targetResult = {}) {
  const next = { ...targetResult }
  LOCAL_ARTIFACT_RESULT_KEYS.forEach((key) => {
    if (sourceResult?.[key] !== undefined && next[key] === undefined) {
      next[key] = sourceResult[key]
    }
  })
  return next
}

function createLocalSessionSnapshot(session) {
  if (!session?.id) return null
  const result = compactResultForLocalStorage(session.result)
  return {
    id: session.id,
    designName: session.designName || session.id,
    svgPath: session.svgPath || '',
    scale: Number(session.scale || 1),
    htmlPath: session.htmlPath || result.htmlPath || '',
    compareHtmlPath: session.compareHtmlPath || result.compareHtmlPath || '',
    sessionDir: session.sessionDir || '',
    artifactDir: session.artifactDir || result.artifactDir || '',
    outputFormats: Array.isArray(session.outputFormats) ? session.outputFormats : ['html'],
    status: session.status || 'completed',
    activeStep: session.activeStep || null,
    steps: session.steps || {
      agent: { status: 'pending' },
      verify: { status: 'pending' },
    },
    result,
    error: truncateForLocalStorage(session.error, 1000) || undefined,
    logs: [],
    messages: compactMessagesForLocalStorage(session.messages),
    pendingUserMessages: [],
    progress: session.progress,
    createdAt: Number(session.createdAt) || Date.now(),
    updatedAt: Number(session.updatedAt) || Date.now(),
    localSavedAt: Date.now(),
  }
}

function saveLocalSessionSnapshot(session, options = {}) {
  const snapshot = createLocalSessionSnapshot(session)
  if (!snapshot) return
  const ids = getLocalSessionIds()
  if (options.touch === false && ids.includes(snapshot.id)) {
    // Preserve the user's existing sidebar order while refreshing the payload.
  } else {
    saveLocalSessionId(snapshot.id)
  }
  const snapshots = readLocalSessionSnapshots()
  if (snapshots[snapshot.id]?.result) {
    snapshot.result = mergeLocalArtifactResult(snapshots[snapshot.id].result, snapshot.result)
  }
  snapshots[snapshot.id] = snapshot

  const keepIds = new Set(getLocalSessionIds().slice(0, LOCAL_SESSION_LIMIT))
  Object.keys(snapshots).forEach((id) => {
    if (!keepIds.has(id)) delete snapshots[id]
  })
  writeLocalSessionSnapshots(snapshots)
}

function saveServerSessionsToLocal(serverSessions) {
  const validSessions = Array.isArray(serverSessions)
    ? serverSessions.filter((session) => session?.id)
    : []
  if (!validSessions.length) return

  const serverIds = validSessions.map((session) => session.id)
  const serverIdSet = new Set(serverIds)
  const existingIds = uniqueIds([
    ...getLocalSessionIds(),
    ...getLocalSessionSnapshotIds(),
  ])
  const nextIds = uniqueIds([
    ...serverIds,
    ...existingIds.filter((id) => !serverIdSet.has(id)),
  ])
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(nextIds.slice(0, LOCAL_SESSION_LIMIT)))
  } catch {
    // ignore storage failures
  }

  const snapshots = readLocalSessionSnapshots()
  validSessions.forEach((session) => {
    const snapshot = createLocalSessionSnapshot(session)
    if (snapshot) {
      if (snapshots[snapshot.id]?.result) {
        snapshot.result = mergeLocalArtifactResult(snapshots[snapshot.id].result, snapshot.result)
      }
      snapshots[snapshot.id] = snapshot
    }
  })

  const keepIds = new Set(nextIds.slice(0, LOCAL_SESSION_LIMIT))
  Object.keys(snapshots).forEach((id) => {
    if (!keepIds.has(id)) delete snapshots[id]
  })
  writeLocalSessionSnapshots(snapshots)
}

function getLocalSessionSnapshot(id) {
  const snapshot = readLocalSessionSnapshots()[id]
  return snapshot && typeof snapshot === 'object' ? snapshot : null
}

function reviveLocalSessionSnapshot(snapshot, reason = 'server-reset') {
  if (!snapshot?.id) return null
  const staleRunning = snapshot.status === 'queued' || snapshot.status === 'running'
  return {
    ...snapshot,
    status: staleRunning ? 'paused' : snapshot.status,
    activeStep: staleRunning ? null : snapshot.activeStep || null,
    logs: [],
    messages: Array.isArray(snapshot.messages) ? snapshot.messages : [],
    pendingUserMessages: [],
    result: snapshot.result || {},
    __localOnly: true,
    __localRestoreReason: reason,
  }
}

function removeLocalSessionSnapshot(id) {
  const snapshots = readLocalSessionSnapshots()
  if (snapshots[id]) {
    delete snapshots[id]
    writeLocalSessionSnapshots(snapshots)
  }
  localArtifactCacheMetaBySession.delete(id)
  void deleteLocalArtifactCache(id)
}

function isLocalOnlySession(session) {
  return Boolean(session?.__localOnly)
}

function labelForSessionStatus(session) {
  const base = labelForStatus(session?.status)
  return isLocalOnlySession(session) ? `${base} · 本地记录` : base
}

function readStoredBoolean(key, fallback) {
  try {
    const stored = localStorage.getItem(key)
    if (stored === null) return fallback
    return stored === 'true'
  } catch {
    return fallback
  }
}

function readStoredNumber(key, fallback) {
  try {
    const value = Number(localStorage.getItem(key))
    return Number.isFinite(value) ? value : fallback
  } catch {
    return fallback
  }
}

function readStoredUploadScale() {
  const value = readStoredNumber(UPLOAD_SCALE_KEY, 1)
  return value === 2 ? 2 : 1
}

function setUploadScale(scale) {
  selectedUploadScale = scale === 2 ? 2 : 1
  try {
    localStorage.setItem(UPLOAD_SCALE_KEY, String(selectedUploadScale))
  } catch {}
}

function showExpiredNotice(count) {
  const el = document.createElement('div')
  el.className = 'expired-notice'
  el.textContent = `${count} 个 session 资源已过期，已自动清理`
  document.body.appendChild(el)
  setTimeout(() => {
    el.classList.add('fade-out')
    setTimeout(() => el.remove(), 500)
  }, 3000)
}

// ── Theme ──

const THEME_STORAGE_KEY = 'svg2html:theme'
const themeToggleBtn = $('#themeToggleBtn')

function getTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) || 'dark'
  } catch {
    return 'dark'
  }
}

function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light')
  } else {
    document.documentElement.removeAttribute('data-theme')
  }
}

function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark'
  try { localStorage.setItem(THEME_STORAGE_KEY, next) } catch {}
  applyTheme(next)
}

applyTheme(getTheme())

// ── Event Listeners ──

uploadZone.addEventListener('click', (e) => {
  e.preventDefault()
  if (uploadInFlight) return
  openUploadDialog()
})
uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault()
  if (uploadInFlight) return
  uploadZone.classList.add('dragover')
})
uploadZone.addEventListener('dragleave', () => {
  uploadZone.classList.remove('dragover')
})
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault()
  uploadZone.classList.remove('dragover')
  if (uploadInFlight) return
  const file = e.dataTransfer.files[0]
  if (file && file.name.toLowerCase().endsWith('.svg')) {
    openUploadDialog(file)
  }
})
fileInput.addEventListener('change', () => {
  if (!uploadInFlight && fileInput.files[0]) {
    openUploadDialog(fileInput.files[0])
    fileInput.value = ''
  }
})

function openUploadDialog(preselectedFile) {
  if (!uploadDialog) return
  uploadDialogFileInput.value = ''
  uploadDialogSubmit.disabled = true
  uploadDialogFileName.textContent = '点击选择 SVG 文件'
  uploadDialogFileInput.parentElement.classList.remove('has-file')
  if (uploadScaleSelect) uploadScaleSelect.value = '1'
  if (uploadFormatReact) uploadFormatReact.checked = false
  if (uploadFormatVue) uploadFormatVue.checked = false
  if (preselectedFile) {
    setDialogFile(preselectedFile)
  }
  uploadDialog.showModal()
}

function setDialogFile(file) {
  if (!file) return
  uploadDialogFileName.textContent = file.name
  uploadDialogFileInput.parentElement.classList.add('has-file')
  uploadDialogSubmit.disabled = false
  uploadDialogSubmit._pendingFile = file
}

uploadDialogFileInput.addEventListener('change', () => {
  const file = uploadDialogFileInput.files[0]
  if (file) setDialogFile(file)
})

uploadDialogCancel.addEventListener('click', () => {
  uploadDialog.close()
})

uploadDialogSubmit.addEventListener('click', async () => {
  const file = uploadDialogSubmit._pendingFile || uploadDialogFileInput.files[0]
  if (!file) return
  const scale = uploadScaleSelect ? Number(uploadScaleSelect.value) || 1 : 1
  uploadDialog.close()
  selectedUploadScale = scale
  await uploadFile(file)
})

sidebarToggleBtn.addEventListener('click', () => {
  setSidebarCollapsed(!sidebarCollapsed)
})

themeToggleBtn.addEventListener('click', toggleTheme)

chatToggleBtn.addEventListener('click', () => {
  if (!currentSession) return
  setChatDrawerOpen(!chatDrawerOpen)
})

chatCloseBtn.addEventListener('click', () => {
  setChatDrawerOpen(false)
})

previewSizeRange.addEventListener('input', () => {
  setResultPreviewWidth(Number(previewSizeRange.value))
})

resultGrid.addEventListener('scroll', handleResultPreviewScroll, true)

downloadBtn.addEventListener('click', (event) => {
  event.preventDefault()
  void downloadCurrentSessionZip()
})

pauseBtn.addEventListener('click', async () => {
  if (!currentSessionId) return
  if (isLocalOnlySession(currentSession)) return
  await fetch(`${basePath}/api/sessions/${currentSessionId}/pause`, { method: 'POST' })
})

resumeBtn.addEventListener('click', async () => {
  if (!currentSessionId) return
  if (isLocalOnlySession(currentSession)) return
  await fetch(`${basePath}/api/sessions/${currentSessionId}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
})

deleteSessionBtn.addEventListener('click', async () => {
  await deleteCurrentSession()
})

modulePickerList.addEventListener('click', (e) => {
  const target = e.target instanceof Element ? e.target : null
  const button = target?.closest('[data-module-id]')
  if (!button) return
  selectModule(button.getAttribute('data-module-id'))
})

resultGrid.addEventListener('click', (e) => {
  const target = e.target instanceof Element ? e.target : null
  const button = target?.closest('.module-overlay-box[data-module-id]')
  if (!button) return
  e.preventDefault()
  e.stopPropagation()
  selectModule(button.getAttribute('data-module-id'))
  setChatDrawerOpen(true)
})

composer.addEventListener('submit', async (e) => {
  e.preventDefault()
  if (!currentSessionId) return
  if (isSessionInputLocked(currentSession)) return
  const text = messageInput.value.trim()
  if (!text) return
  if (!selectedModuleId) {
    alert('请先选择要修复的模块')
    return
  }

  const res = await fetch(`${basePath}/api/sessions/${currentSessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ moduleId: selectedModuleId, text }),
  })

  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok) {
    alert(data?.error || '发送失败')
    return
  }

  messageInput.value = ''
  messageInput.style.height = 'auto'
  if (currentSession) {
    currentSession = { ...currentSession, status: 'queued' }
    upsertSession(currentSession)
    renderSessionHeader()
  }
})

messageInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return
  e.preventDefault()
})

// Auto-resize textarea
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto'
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px'
  updateComposerState()
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && chatDrawerOpen) {
    setChatDrawerOpen(false)
  }
})

setSidebarCollapsed(sidebarCollapsed)
setResultPreviewWidth(readStoredNumber(RESULT_PREVIEW_SIZE_KEY, RESULT_PREVIEW_WIDTH_DEFAULT))
setChatDrawerOpen(false)
setInterval(() => {
  const hasBusySession = sessions.some(isSessionBusy)
  const currentBusy = isSessionBusy(currentSession)
  if (!hasBusySession && !currentBusy) return
  if (hasBusySession) renderSessionList()
  if (currentBusy) renderSessionHeader()
}, 1000)

// ── Bootstrap ──

async function bootstrap() {
  if (isDevMode) {
    document.title = '[Dev] ' + document.title
    downloadBtn.style.display = ''
  }
  await Promise.all([loadRuntimeInfo(), loadSessions()])
}

async function loadRuntimeInfo() {
  try {
    const res = await fetch(`${basePath}/api/runtime`)
    const data = await res.json()
    if (Number.isFinite(Number(data.diffRatioThreshold))) {
      diffRatioThreshold = Number(data.diffRatioThreshold)
      renderResultDiffGap(currentSession?.result)
    }
    if (typeof data.workspaceRoot === 'string' && data.workspaceRoot !== runtimeWorkspaceRoot) {
      runtimeWorkspaceRoot = data.workspaceRoot
      renderSessionList()
      renderCurrentSession()
    }
    runtimeInfo.textContent = ''
  } catch {
    runtimeInfo.textContent = ''
  }
}

async function loadSessions() {
  let shouldClearUrlSession = false
  let serverSessions = []
  let serverSessionsLoaded = false

  try {
    const res = await fetch(`${basePath}/api/sessions`)
    if (res.ok) {
      const data = await res.json()
      serverSessions = Array.isArray(data) ? data : []
      serverSessionsLoaded = true
      saveServerSessionsToLocal(serverSessions)
    }
  } catch {
    serverSessionsLoaded = false
  }

  if (isDevMode) {
    sessions = serverSessionsLoaded ? serverSessions : []
  } else {
    const snapshotIds = getLocalSessionSnapshotIds()
    const localIds = getLocalSessionIds()
    const serverIds = serverSessions.map((session) => session.id).filter(Boolean)
    const idsToLoad = uniqueIds([
      ...serverIds,
      ...localIds,
      ...snapshotIds,
    ])

    if (serverSessionsLoaded) {
      const serverSessionById = new Map(serverSessions.map((session) => [session.id, session]))
      let localOnlyCount = 0
      let expiredCount = 0
      sessions = []

      for (const id of idsToLoad) {
        const serverSession = serverSessionById.get(id)
        if (serverSession) {
          sessions.push(serverSession)
          continue
        }

        const localSession = reviveLocalSessionSnapshot(
          getLocalSessionSnapshot(id),
          'server-reset',
        )
        if (localSession) {
          localOnlyCount++
          sessions.push(localSession)
        } else {
          removeLocalSessionId(id)
          expiredCount++
        }
      }

      if (expiredCount > 0) showExpiredNotice(expiredCount)
      if (localOnlyCount > 0) {
        console.info(`[sessions] restored ${localOnlyCount} session(s) from local snapshots`)
      }
    } else if (idsToLoad.length) {
      const results = await Promise.all(
        idsToLoad.map(async (id) => {
          const localSnapshot = getLocalSessionSnapshot(id)
          try {
            const res = await fetch(`${basePath}/api/sessions/${id}`)
            if (res.status === 404) {
              const localSession = reviveLocalSessionSnapshot(localSnapshot, 'server-reset')
              return localSession
                ? { id, session: localSession, status: 'local' }
                : { id, status: 'expired' }
            }
            if (!res.ok) {
              const localSession = reviveLocalSessionSnapshot(localSnapshot, 'server-unavailable')
              return localSession
                ? { id, session: localSession, status: 'local' }
                : { id, status: 'unavailable' }
            }
            return { id, session: await res.json() }
          } catch {
            const localSession = reviveLocalSessionSnapshot(localSnapshot, 'network-error')
            return localSession
              ? { id, session: localSession, status: 'local' }
              : { id, status: 'unavailable' }
          }
        }),
      )

      let expiredCount = 0
      let unavailableCount = 0
      let localOnlyCount = 0
      sessions = []
      for (const r of results) {
        if (r.status === 'expired') {
          removeLocalSessionId(r.id)
          expiredCount++
        } else if (r.status === 'unavailable') {
          unavailableCount++
        } else {
          if (r.status === 'local') localOnlyCount++
          sessions.push(r.session)
        }
      }
      if (expiredCount > 0) showExpiredNotice(expiredCount)
      if (unavailableCount > 0) {
        console.warn(`[sessions] ${unavailableCount} cached session(s) temporarily unavailable`)
      }
      if (localOnlyCount > 0) {
        console.info(`[sessions] restored ${localOnlyCount} session(s) from local snapshots`)
      }
    } else {
      sessions = []
    }
  }

  await hydrateLocalArtifactCacheMetadataForSessions(sessions)

  sessions
    .filter((session) => !isLocalOnlySession(session))
    .forEach((session) => saveLocalSessionSnapshot(session, { touch: false }))

  if (urlSessionId && !sessions.find((s) => s.id === urlSessionId)) {
    try {
      const res = await fetch(`${basePath}/api/sessions/${urlSessionId}`)
      if (res.ok) {
        const session = await res.json()
        sessions.unshift(session)
        saveLocalSessionSnapshot(session)
      }
      else if (res.status === 404) {
        const localSession = reviveLocalSessionSnapshot(
          getLocalSessionSnapshot(urlSessionId),
          'server-reset',
        )
        if (localSession) sessions.unshift(localSession)
        else shouldClearUrlSession = true
      }
    } catch { /* ignore */ }
  }

  if (currentSessionId && !sessions.find((s) => s.id === currentSessionId)) {
    currentSessionId = null
    currentSession = null
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
  }

  if (shouldClearUrlSession && !sessions.length) {
    const url = new URL(location)
    if (url.searchParams.has('session')) {
      url.searchParams.delete('session')
      history.replaceState(null, '', url)
    }
  }

  renderSessionList()
  if (urlSessionId && sessions.find((s) => s.id === urlSessionId)) {
    selectSession(urlSessionId)
  } else if (!currentSessionId && sessions[0]) {
    selectSession(sessions[0].id)
  } else if (!currentSessionId) {
    renderCurrentSession()
  }
}

async function uploadFile(file) {
  if (uploadInFlight) return
  if (!file.name.toLowerCase().endsWith('.svg')) {
    alert('只能上传 SVG 文件')
    return
  }
  setUploadBusy(true)
  try {
    const form = new FormData()
    form.append('svg', file)
    form.append('scale', String(selectedUploadScale))
    form.append('outputFormats', getSelectedOutputFormats().join(','))

    const res = await fetch(`${basePath}/api/upload`, { method: 'POST', body: form })
    const data = await readJsonResponse(res)
    if (!res.ok) {
      throw new Error(data.error || `上传失败：HTTP ${res.status}`)
    }
    if (!data.sessionId || !data.session) {
      throw new Error('上传成功但响应缺少 session 信息，请刷新页面查看')
    }

    saveLocalSessionId(data.sessionId)
    upsertSession(data.session)
    selectSession(data.sessionId)
    await startUploadedSessionIfNeeded(data.sessionId, data.session)
  } catch (error) {
    console.error('[upload] failed', error)
    if (!currentSessionId) {
      await loadSessions().catch(() => {})
    }
    alert(error instanceof Error ? error.message : '上传失败')
  } finally {
    fileInput.value = ''
    setUploadBusy(false)
  }
}

function getSelectedOutputFormats() {
  const formats = ['html']
  if (uploadFormatReact?.checked) formats.push('react')
  if (uploadFormatVue?.checked) formats.push('vue')
  return formats
}

function setUploadBusy(busy) {
  uploadInFlight = Boolean(busy)
  uploadZone.classList.toggle('is-uploading', uploadInFlight)
  fileInput.disabled = uploadInFlight
  if (uploadZoneLabel) {
    uploadZoneLabel.textContent = uploadInFlight ? '上传中…' : '上传 SVG'
  }
}

async function readJsonResponse(res) {
  try {
    return await res.json()
  } catch {
    return {}
  }
}

async function fetchSessionDetails(sessionId) {
  if (!sessionId) return
  try {
    const res = await fetch(`${basePath}/api/sessions/${sessionId}`)
    if (!res.ok) return
    const session = await readJsonResponse(res)
    if (!session?.id || currentSessionId !== sessionId) return
    await hydrateLocalArtifactCacheMetadataForSessions([session])
    upsertSession(session)
    currentSession = sessions.find((item) => item.id === sessionId) || session
    renderCurrentSession()
  } catch {
    // Keep the summary row usable if the detail request is temporarily unavailable.
  }
}

async function startUploadedSessionIfNeeded(sessionId, session) {
  if (session.status === 'queued' || session.status === 'running') return

  const res = await fetch(`${basePath}/api/sessions/${sessionId}/start`, {
    method: 'POST',
  })
  const data = await readJsonResponse(res)
  if (!res.ok) {
    throw new Error(data.error || `启动失败：HTTP ${res.status}`)
  }

  const sessionRes = await fetch(`${basePath}/api/sessions/${sessionId}`)
  if (sessionRes.ok) {
    const freshSession = await readJsonResponse(sessionRes)
    if (freshSession?.id) {
      upsertSession(freshSession)
      if (currentSessionId === sessionId) {
        currentSession = freshSession
        renderCurrentSession()
      }
      return
    }
  }

  const nextSession = {
    ...session,
    progress: {
      ...session.progress,
      detail: '已进入队列，等待执行',
    },
    status: data.status || 'queued',
  }
  upsertSession(nextSession)
  if (currentSessionId === sessionId) {
    currentSession = nextSession
    renderCurrentSession()
  }
}

// ── SSE ──

function connectSSE(sessionId) {
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }

  eventSource = new EventSource(`${basePath}/api/sessions/${sessionId}/events`)
  eventSource.onmessage = (e) => {
    const event = JSON.parse(e.data)
    handleSessionEvent(event)
  }
}

function closeSSE() {
  if (!eventSource) return
  eventSource.close()
  eventSource = null
}

function handleSessionEvent(event) {
  if (event.type === 'init') {
    currentSession = event.session
    currentSessionId = event.session.id
    upsertSession(event.session)
    renderCurrentSession()
    return
  }

  if (event.type === 'session:deleted') {
    removeSessionFromUi(event.sessionId)
    return
  }

  if (!currentSession || event.sessionId !== currentSession.id) {
    updateSessionListStatus(event)
    return
  }

  switch (event.type) {
    case 'session:updated':
      currentSession = { ...currentSession, ...event.data }
      break
    case 'message':
      currentSession = {
        ...currentSession,
        updatedAt: event.timestamp || Date.now(),
        messages: upsertMessage(currentSession.messages, event.message),
      }
      renderMessages(currentSession.messages)
      upsertSession(currentSession)
      renderSessionHeader()
      renderResults(currentSession.result)
      return
    case 'codex:event':
      appendAgentEvent(event.event)
      return
    case 'step:start':
      currentSession = {
        ...currentSession,
        activeStep: event.step,
        status: 'running',
        steps: {
          ...currentSession.steps,
          [event.step]: { ...currentSession.steps[event.step], status: 'running' },
        },
      }
      break
    case 'step:complete':
      currentSession = {
        ...currentSession,
        activeStep: null,
        result: { ...currentSession.result, ...(event.data || {}) },
        steps: {
          ...currentSession.steps,
          [event.step]: { ...currentSession.steps[event.step], status: 'completed' },
        },
      }
      break
    case 'step:error':
      currentSession = {
        ...currentSession,
        activeStep: null,
        steps: {
          ...currentSession.steps,
          [event.step]: { ...currentSession.steps[event.step], status: 'failed', error: event.message },
        },
      }
      break
    case 'pipeline:complete':
      currentSession = {
        ...currentSession,
        status: 'completed',
      }
      void maybeAutoCacheCurrentSessionArtifacts()
      break
    case 'pipeline:error':
      currentSession = {
        ...currentSession,
        status: 'failed',
        error: event.message,
      }
      break
  }

  currentSession = { ...currentSession, updatedAt: event.timestamp || Date.now() }
  upsertSession(currentSession)
  renderSessionHeader()
  renderResults(currentSession.result)
}

function updateSessionListStatus(event) {
  const target = sessions.find((item) => item.id === event.sessionId)
  if (!target) return
  if (event.type === 'session:updated') Object.assign(target, event.data)
  if (event.type === 'pipeline:complete') {
    target.status = 'completed'
  }
  if (event.type === 'pipeline:error') {
    target.status = 'failed'
    target.error = event.message
  }
  target.updatedAt = event.timestamp || Date.now()
  renderSessionList()
}

function upsertSession(session) {
  const index = sessions.findIndex((item) => item.id === session.id)
  const isSummary = Boolean(session.__summary)
  if (index === -1) {
    sessions.unshift(session)
  } else {
    const existing = sessions[index]
    const merged = {
      ...existing,
      ...session,
      logs:
        isSummary && Array.isArray(existing.logs) && existing.logs.length
          ? existing.logs
          : session.logs,
      messages:
        isSummary && Array.isArray(existing.messages) && existing.messages.length
          ? existing.messages
          : session.messages,
      result: {
        ...(existing.result || {}),
        ...(session.result || {}),
      },
    }
    if (isSummary) merged.__summary = true
    else delete merged.__summary
    sessions[index] = merged
  }
  saveLocalSessionSnapshot(sessions.find((item) => item.id === session.id) || session)
  renderSessionList()
}

async function deleteCurrentSession() {
  if (!currentSessionId || !currentSession) return

  const sessionId = currentSessionId
  const sessionName = currentSession.designName || sessionId
  const localOnly = isLocalOnlySession(currentSession)
  const confirmed = window.confirm(
    localOnly
      ? `确认从本地列表移除 session「${sessionName}」？`
      : `确认删除 session「${sessionName}」？删除后无法恢复。`,
  )
  if (!confirmed) return

  if (localOnly) {
    removeSessionFromUi(sessionId)
    return
  }

  deleteSessionBtn.disabled = true
  try {
    const res = await fetch(`${basePath}/api/sessions/${sessionId}`, {
      method: 'DELETE',
    })
    const data = await readJsonResponse(res)
    if (!res.ok) {
      throw new Error(data.error || `删除失败：HTTP ${res.status}`)
    }
    removeSessionFromUi(sessionId)
  } catch (error) {
    alert(error instanceof Error ? error.message : '删除失败')
    renderSessionHeader()
  }
}

function removeSessionFromUi(sessionId) {
  removeLocalSessionId(sessionId)
  sessions = sessions.filter((session) => session.id !== sessionId)

  if (currentSessionId !== sessionId) {
    renderSessionList()
    return
  }

  if (eventSource) {
    eventSource.close()
    eventSource = null
  }

  currentSessionId = null
  currentSession = null

  const url = new URL(location)
  url.searchParams.delete('session')
  history.replaceState(null, '', url)

  renderSessionList()
  const nextSession = sessions[0]
  if (nextSession) {
    selectSession(nextSession.id)
    return
  }
  renderCurrentSession()
}

function selectSession(sessionId) {
  currentSessionId = sessionId
  selectedModuleId = null
  const cached = sessions.find((item) => item.id === sessionId)
  if (cached) currentSession = cached
  if (isLocalOnlySession(currentSession)) {
    closeSSE()
    downloadBtn.removeAttribute('href')
  } else {
    downloadBtn.href = `${basePath}/api/sessions/${sessionId}/download`
  }
  const url = new URL(location)
  url.searchParams.set('session', sessionId)
  history.replaceState(null, '', url)
  if (!isLocalOnlySession(currentSession)) connectSSE(sessionId)
  renderCurrentSession()
  if (!isLocalOnlySession(currentSession)) {
    void fetchSessionDetails(sessionId)
  }
}

// ── Rendering ──

function renderSessionList() {
  if (!sessions.length) {
    sessionList.innerHTML = '<div class="empty-list">还没有 session</div>'
    return
  }

  sessionList.innerHTML = sessions
    .map((session) => {
      const active = session.id === currentSessionId ? 'active' : ''
      const progress = getWorkflowProgress(session)
      const currentNodeLabel = progress.currentNode
        ? labelForWorkflowNode(progress.currentNode)
        : '等待开始'
      const statusLabel = session.status === 'queued' && progress.detail
        ? escapeHtml(progress.detail)
        : labelForSessionStatus(session)
      const durationLabel = formatSessionDuration(session)
      const tooltip = `${session.designName} · ${statusLabel} · ${currentNodeLabel} · ${durationLabel}`
      return `
        <button class="session-item ${active}" data-session-id="${session.id}" title="${escapeHtml(tooltip)}">
          <span class="session-status-dot status-${session.status}"></span>
          <span class="session-item-body">
            <span class="session-item-title-row">
              <span class="session-item-title">${escapeHtml(session.designName)}</span>
              <span class="session-duration-badge">${escapeHtml(durationLabel)}</span>
            </span>
            <span class="session-item-meta">${session.id} · ${statusLabel} · ${escapeHtml(currentNodeLabel)}</span>
          </span>
        </button>
      `
    })
    .join('')

  sessionList.querySelectorAll('[data-session-id]').forEach((node) => {
    node.addEventListener('click', () => {
      selectSession(node.getAttribute('data-session-id'))
    })
  })
}

function renderCurrentSession() {
  if (!currentSession) {
    selectedModuleId = null
    sessionTitle.textContent = '选择一个 session'
    sessionMeta.textContent = '上传 SVG 开始'
    renderWorkflow(null)
    messageList.innerHTML = `
      <div class="empty-state">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.3"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span>上传 SVG 开始对话</span>
      </div>
    `
    resultGrid.innerHTML = ''
    resultUrls.innerHTML = ''
    resultActions.innerHTML = ''
    pauseBtn.disabled = true
    resumeBtn.disabled = true
    deleteSessionBtn.disabled = true
    messageInput.value = ''
    messageInput.style.height = 'auto'
    setChatDrawerOpen(false)
    renderResults(null)
    syncComposerState(null)
    updateComposerState()
    renderLayoutState()
    return
  }

  renderSessionHeader()
  renderMessages(currentSession.messages)
  renderResults(currentSession.result)
  renderLayoutState()
  maybeAutoCacheCurrentSessionArtifacts()
}

function renderSessionHeader() {
  if (!currentSession) return
  const progress = getWorkflowProgress(currentSession)
  const durationLabel = formatSessionDuration(currentSession)
  const scaleLabel = `${Number(currentSession.scale || 1)}x`
  const formatLabel = Array.isArray(currentSession.outputFormats)
    ? currentSession.outputFormats.join('+')
    : 'html'
  const statusLabel = labelForSessionStatus(currentSession)
  const localOnly = isLocalOnlySession(currentSession)
  sessionTitle.textContent = currentSession.designName
  sessionMeta.textContent = `${currentSession.id} · ${statusLabel} · ${scaleLabel} · ${formatLabel} · ${durationLabel} · ${progress.detail || labelForWorkflowNode(progress.currentNode || 'upload')}`
  pauseBtn.disabled = localOnly || (currentSession.status !== 'running' && currentSession.status !== 'queued')
  resumeBtn.disabled =
    localOnly ||
    currentSession.status !== 'paused' &&
    currentSession.status !== 'failed' &&
    !isCompletedStatus(currentSession.status)
  deleteSessionBtn.disabled = false
  chatStatus.textContent = `${statusLabel} · ${progress.detail || '可查看聊天记录'}`
  renderModulePicker()
  syncComposerState(currentSession)
  renderWorkflow(currentSession)
  updateComposerState()
  renderLayoutState()
}

function collectSelectableModules(session = currentSession) {
  const runs = Array.isArray(session?.result?.moduleAgentRuns)
    ? session.result.moduleAgentRuns
    : []
  const byId = new Map()
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

function selectModule(moduleId) {
  const modules = collectSelectableModules()
  const next = modules.some((module) => module.id === moduleId) ? moduleId : null
  selectedModuleId = next
  renderModulePicker()
  renderModuleOverlays()
  updateComposerState()
}

function renderModulePicker() {
  const modules = collectSelectableModules()
  const selected = modules.find((module) => module.id === selectedModuleId)
  if (selectedModuleId && !selected) selectedModuleId = null
  if (!selectedModuleId && modules.length === 1) selectedModuleId = modules[0].id

  modulePicker.classList.toggle('is-empty', modules.length === 0)
  selectedModuleLabel.textContent = selectedModuleId || (modules.length ? '请选择' : '暂无模块')
  modulePickerList.innerHTML = modules.length
    ? modules
        .map((module, index) => {
          const active = module.id === selectedModuleId ? ' is-selected' : ''
          return `<button class="module-picker-option${active}" type="button" data-module-id="${escapeHtml(module.id)}">${index + 1}. ${escapeHtml(module.id)}</button>`
        })
        .join('')
    : '<span class="chat-drawer-meta">生成完成后可选择模块</span>'
}

function renderMessages(messages) {
  const visibleMessages = Array.isArray(messages)
    ? messages.filter((message) => message?.codexItemType !== 'reasoning')
    : []
  if (!visibleMessages.length) {
    messageList.innerHTML = '<div class="empty-state"><span>等待对话…</span></div>'
    return
  }

  messageList.innerHTML = visibleMessages
    .map((message) => {
      const idAttr = message.id ? ` id="codex-${message.id}"` : ''
      if (message.codexItemType === 'error') {
        return `<div${idAttr} class="codex-event codex-error">${escapeHtml(message.text || '未知错误')}</div>`
      }
      if (message.kind === 'event') {
        return `
          <div${idAttr} class="codex-event codex-status">
            <span class="status-dot"></span>${escapeHtml(message.text)}
          </div>
        `
      }
      const moduleBadge =
        message.role === 'user' && message.moduleId
          ? `<div class="bubble-module">模块 ${escapeHtml(message.moduleId)}</div>`
          : ''
      return `
        <article${idAttr} class="bubble bubble-${message.role} bubble-${message.kind}">
          <div class="bubble-role">${labelForRole(message.role)}</div>
          ${moduleBadge}
          <div class="bubble-text">${escapeHtml(message.text).replace(/\n/g, '<br>')}</div>
        </article>
      `
    })
    .join('')
  messageList.scrollTop = messageList.scrollHeight
}

function appendStatusEvent(text) {
  const empty = messageList.querySelector('.empty-state')
  if (empty) empty.remove()
  const el = document.createElement('div')
  el.className = 'codex-event codex-status'
  el.innerHTML = `<span class="status-dot"></span>${escapeHtml(text)}`
  messageList.appendChild(el)
  messageList.scrollTop = messageList.scrollHeight
}

function appendAgentEvent(evt) {
  const empty = messageList.querySelector('.empty-state')
  if (empty) empty.remove()

  if (
    evt.type === 'turn.started' ||
    evt.type === 'turn.completed' ||
    evt.type === 'turn.failed' ||
    evt.type === 'thread.started'
  ) {
    if (evt.type === 'turn.started') {
      removeTurnIndicator()
      const el = document.createElement('div')
      el.className = 'turn-indicator'
      el.id = 'turnIndicator'
      el.innerHTML = '<div class="dot-pulse"><span></span><span></span><span></span></div> 大模型正在执行…'
      messageList.appendChild(el)
      messageList.scrollTop = messageList.scrollHeight
    }
    if (evt.type === 'turn.completed' || evt.type === 'turn.failed') {
      removeTurnIndicator()
    }
    return
  }

  if (
    evt.type === 'item.started' ||
    evt.type === 'item.updated' ||
    evt.type === 'item.completed'
  ) {
    const item = evt.item
    if (!item) return
    if (item.type === 'reasoning') return
    // Skip if this item is already persisted in messages (avoids duplicates)
    if (
      currentSession &&
      currentSession.messages.some((m) => m.id === item.id)
    ) {
      return
    }
    renderItemEvent(item, evt.type)
  }
}

function upsertMessage(messages, message) {
  const index = messages.findIndex((entry) => entry.id === message.id)
  if (index >= 0) {
    return [...messages.slice(0, index), message, ...messages.slice(index + 1)]
  }
  return [...messages, message]
}

function removeTurnIndicator() {
  const el = document.getElementById('turnIndicator')
  if (el) el.remove()
}

function renderItemEvent(item, eventType) {
  if (item.type === 'reasoning') {
    return
  }
  if (item.type === 'agent_message') {
    renderAgentMessage(item, eventType)
    return
  }
  if (item.type === 'error') {
    renderItemError(item)
    return
  }
}

function renderAgentMessage(item, eventType) {
  let el = document.getElementById(`codex-${item.id}`)
  if (!el) {
    el = document.createElement('article')
    el.className = 'bubble bubble-assistant bubble-chat'
    el.id = `codex-${item.id}`
    el.innerHTML = `<div class="bubble-role">大模型</div><div class="bubble-text"></div>`
    messageList.appendChild(el)
  }
  el.querySelector('.bubble-text').innerHTML = escapeHtml(item.text || '').replace(/\n/g, '<br>')
  messageList.scrollTop = messageList.scrollHeight
}

function renderItemError(item) {
  const el = document.createElement('div')
  el.className = 'codex-event codex-error'
  el.textContent = item.message || '未知错误'
  messageList.appendChild(el)
  messageList.scrollTop = messageList.scrollHeight
}

// ── Results (inline panel, no modal) ──

function renderResults(result) {
  const showResults = hasPrimaryResults(result)
  const localFilesAvailable = !isLocalOnlySession(currentSession)
  const localCacheReady = isLocalArtifactCacheReady(currentSession)
  const localCacheMeta = getLocalArtifactCacheMetaForSession(currentSession)
  const localCacheBusy = currentSessionId ? localArtifactCacheInFlight.has(currentSessionId) : false
  resultPanel.classList.toggle('visible', showResults)
  renderResultDiffGap(showResults ? result : null)
  renderResultTokens(currentSession)
  renderResultCacheStatus(showResults ? { busy: localCacheBusy, meta: localCacheMeta } : null)

  if (!showResults) {
    resultGrid.innerHTML = ''
    resultUrls.innerHTML = ''
    resultActions.innerHTML = ''
    return
  }

  // Image cards
  const cards = [
    ['SVG 渲染', result?.svgPngPath, 'svg'],
    ['HTML 渲染', result?.htmlPngPath, 'html'],
  ].filter(([, value]) => localFilesAvailable && value)

  resultGrid.innerHTML = cards
    .map(
      ([title, filePath, kind]) => `
        <div class="result-card">
          <div class="result-card-title">${title}</div>
          <div class="result-card-frame" data-result-scroll-frame>
            <div class="result-card-preview">
              <img src="${workspaceFileUrl(filePath)}" alt="${title}" data-result-kind="${kind}" onclick="openLightbox(this.src)" />
              ${kind === 'html' ? '<div class="module-overlay" data-module-overlay></div>' : ''}
            </div>
          </div>
        </div>
      `,
    )
    .join('')
  renderModuleOverlays()

  const urlBlocks = []
  if (localCacheMeta?.status === 'error') {
    urlBlocks.push(`<div class="url-error">本地缓存失败：${escapeHtml(localCacheMeta.error || '未知错误')}</div>`)
  }

  const frameworkExports = result?.frameworkExports && typeof result.frameworkExports === 'object'
    ? Object.entries(result.frameworkExports)
    : []

  if (isLocalOnlySession(currentSession) && !localCacheReady) {
    urlBlocks.push(
      '<div class="url-error">该记录没有可打开的浏览器本地缓存。</div>',
    )
  }
  resultUrls.innerHTML = urlBlocks.join('')

  // Action links
  const links = []
  if ((localFilesAvailable || localCacheReady) && result?.compareHtmlPath) {
    links.push(
      '<button class="link-btn" type="button" onclick="openSessionArtifact(\'compare\')">打开对照页</button>',
    )
  }
  if ((localFilesAvailable || localCacheReady) && result?.htmlPath) {
    links.push(
      '<button class="link-btn" type="button" onclick="openSessionArtifact(\'html\')">打开 HTML</button>',
    )
  }
  if (localFilesAvailable && currentSessionId) {
    links.push(
      '<button class="link-btn download-btn" type="button" onclick="downloadCurrentSessionZip()">下载 ZIP</button>',
    )
  } else if (localCacheReady) {
    links.push(
      '<button class="link-btn download-btn" type="button" onclick="downloadCurrentSessionZip()">下载 ZIP</button>',
    )
  }
  for (const [target, record] of frameworkExports) {
    if (!localFilesAvailable || !record || record.status !== 'completed') continue
    const safeTarget = String(target || '').toLowerCase()
    if ((safeTarget === 'react' || safeTarget === 'vue') && currentSessionId) {
      const downloadHref = `${basePath}/api/sessions/${encodeURIComponent(currentSessionId)}/exports/${encodeURIComponent(safeTarget)}/download`
      links.push(
        `<a class="link-btn download-btn" href="${escapeHtml(downloadHref)}">${escapeHtml(target)} 组件包</a>`,
      )
    }
  }
  if (localFilesAvailable && currentSessionId && currentSession?.result?.htmlPath) {
    const cacheLabel = localCacheBusy
      ? '缓存中…'
      : localCacheReady
        ? '重新缓存本地'
        : '缓存到本地'
    links.push(
      `<button class="link-btn" type="button" onclick="cacheCurrentSessionArtifacts()" ${localCacheBusy ? 'disabled' : ''}>${cacheLabel}</button>`,
    )
  }
  resultActions.innerHTML = links.join('')
}

function renderModuleOverlays() {
  const overlay = resultGrid.querySelector('[data-module-overlay]')
  if (!overlay) return
  const image = overlay.parentElement?.querySelector('img')
  const modules = collectSelectableModules()
  const imageWidth = Number(image?.naturalWidth || image?.clientWidth || 0)
  const imageHeight = Number(image?.naturalHeight || image?.clientHeight || 0)
  if (!modules.length || imageWidth <= 0 || imageHeight <= 0) {
    overlay.innerHTML = ''
    if (image && !image.dataset.moduleOverlayBound) {
      image.dataset.moduleOverlayBound = 'true'
      image.addEventListener('load', renderModuleOverlays, { once: true })
    }
    return
  }
  overlay.innerHTML = modules
    .map((module, index) => {
      const region = module.region || {}
      const left = (Number(region.x || 0) / imageWidth) * 100
      const top = (Number(region.y || 0) / imageHeight) * 100
      const width = (Number(region.width || 0) / imageWidth) * 100
      const height = (Number(region.height || 0) / imageHeight) * 100
      if (width <= 0 || height <= 0) return ''
      const active = module.id === selectedModuleId ? ' is-selected' : ''
      return `
        <button class="module-overlay-box${active}" type="button" data-module-id="${escapeHtml(module.id)}" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%;" title="${escapeHtml(module.id)}">
          <span class="module-overlay-label">${index + 1}</span>
        </button>
      `
    })
    .join('')
}

function renderResultDiffGap(result) {
  const diffRatio = Number(result?.diffRatio)
  if (!resultDiffGap || !Number.isFinite(diffRatio)) {
    if (resultDiffGap) {
      resultDiffGap.hidden = true
      resultDiffGap.textContent = ''
      resultDiffGap.classList.remove('is-passed')
    }
    return
  }

  const remainingRatio = Math.max(0, diffRatio - diffRatioThreshold)
  const passed = remainingRatio <= 0
  const currentPercent = `${(diffRatio * 100).toFixed(2)}%`

  resultDiffGap.hidden = false
  resultDiffGap.classList.toggle('is-passed', passed)
  resultDiffGap.textContent = currentPercent
}

function renderResultCacheStatus(state) {
  if (!resultCacheStatus) return
  const meta = state?.meta
  const busy = Boolean(state?.busy || meta?.status === 'caching')
  resultCacheStatus.classList.remove('is-error', 'is-busy')

  if (busy) {
    resultCacheStatus.textContent = '本地缓存中'
    resultCacheStatus.title = '正在缓存 HTML 和关联静态资源'
    resultCacheStatus.classList.add('is-busy')
    resultCacheStatus.hidden = false
    return
  }

  if (meta?.status === 'cached') {
    const count = Number.isFinite(Number(meta.fileCount)) ? `${meta.fileCount} 文件` : '已缓存'
    const size = Number.isFinite(Number(meta.byteSize)) ? formatBytes(Number(meta.byteSize)) : ''
    const text = ['本地', count, size].filter(Boolean).join(' · ')
    resultCacheStatus.textContent = text
    resultCacheStatus.title = [
      '浏览器本地缓存',
      count,
      size,
      meta.cachedAt ? formatCacheTimestamp(meta.cachedAt) : '',
    ].filter(Boolean).join(' · ')
    resultCacheStatus.hidden = false
    return
  }

  if (meta?.status === 'error') {
    resultCacheStatus.textContent = '缓存失败'
    resultCacheStatus.title = meta.error || '本地缓存失败'
    resultCacheStatus.classList.add('is-error')
    resultCacheStatus.hidden = false
    return
  }

  resultCacheStatus.textContent = ''
  resultCacheStatus.title = ''
  resultCacheStatus.hidden = true
}

function formatTokenCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatDuration(ms) {
  const totalMinutes = Math.max(1, Math.round(ms / 60000))
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
  }
  return `${totalMinutes} 分钟`
}

function toTimestamp(value) {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined
}

function normalizeWorkflowNodeKey(node) {
  if (node === LEGACY_ANALYSIS_NODE_KEY) return 'analysis'
  return WORKFLOW_NODE_ORDER.includes(node) ? node : null
}

function getProgressNode(session, key) {
  const nodes = session?.progress?.nodes || {}
  if (key === 'analysis') return nodes.analysis || nodes[LEGACY_ANALYSIS_NODE_KEY]
  return nodes[key]
}

function getSessionExecutionStartAt(session) {
  if (!session) return undefined
  return (
    toTimestamp(session.queuedAt) ??
    SESSION_DURATION_NODE_ORDER
      .map((key) => toTimestamp(getProgressNode(session, key)?.startedAt))
      .find((timestamp) => timestamp !== undefined) ??
    toTimestamp(session.createdAt)
  )
}

function getSessionCompletedAt(session) {
  const doneCompletedAt = toTimestamp(getProgressNode(session, 'done')?.completedAt)
  if (doneCompletedAt) return doneCompletedAt
  const completedAtList = SESSION_DURATION_NODE_ORDER
    .map((key) => toTimestamp(getProgressNode(session, key)?.completedAt))
    .filter((timestamp) => timestamp !== undefined)
  if (completedAtList.length) return Math.max(...completedAtList)
  return toTimestamp(session?.updatedAt)
}

function getSessionExecutionEndAt(session, now = Date.now()) {
  if (!session) return undefined
  if (session.status === 'queued' || session.status === 'running') return now
  if (session.status === 'paused') {
    return toTimestamp(session.updatedAt) ?? getSessionCompletedAt(session) ?? now
  }
  return getSessionCompletedAt(session) ?? now
}

function formatElapsedDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

function formatSessionDuration(session, now = Date.now()) {
  const startedAt = getSessionExecutionStartAt(session)
  const endedAt = getSessionExecutionEndAt(session, now)
  if (!startedAt || !endedAt) return '耗时 --'
  return `耗时 ${formatElapsedDuration(Math.max(0, endedAt - startedAt))}`
}

function renderResultTokens(session) {
  if (!resultTokenBadge) return
  const result = session?.result
  const inputTokens = Number(result?.inputTokens ?? 0)
  const outputTokens = Number(result?.outputTokens ?? 0)
  const tokensUsed = Number(result?.tokensUsed ?? 0)

  if (inputTokens > 0 && outputTokens > 0) {
    resultTokenBadge.hidden = false
    resultTokenBadge.textContent = `input:${formatTokenCount(inputTokens)} output:${formatTokenCount(outputTokens)}`
    return
  }

  if (tokensUsed > 0) {
    resultTokenBadge.hidden = false
    resultTokenBadge.textContent = `${formatTokenCount(tokensUsed)} tokens`
    return
  }

  resultTokenBadge.hidden = true
  resultTokenBadge.textContent = ''
}

function renderWorkflow(session) {
  const progress = getWorkflowProgress(session)
  workflowCurrent.textContent = progress.currentNode
    ? labelForWorkflowNode(progress.currentNode)
    : '等待开始'

  workflowDetail.textContent = progress.detail || '上传 SVG 后会显示实时进度'
  renderWorkflowModuleWarning(session?.result)

  workflowNodes.innerHTML = WORKFLOW_NODE_ORDER.map((key, index) => {
    const node = progress.nodes[key]
    const isActive = key === progress.currentNode
    const classes = [
      'workflow-node',
      `status-${node.status}`,
      isActive ? 'active' : '',
    ]
      .filter(Boolean)
      .join(' ')

    return `
      <div class="${classes}">
        <span class="workflow-node-icon" aria-hidden="true"></span>
        <span class="workflow-node-label">${escapeHtml(node.label)}</span>
      </div>
    `
  }).join('')
}

function renderWorkflowModuleWarning(result) {
  if (!workflowModuleWarning) return
  const moduleCount = Number(result?.moduleCount)
  const concurrencyLimit = Number(
    result?.moduleConcurrencyLimit ?? DEFAULT_MODULE_CONCURRENCY_LIMIT,
  )
  if (
    !Number.isFinite(moduleCount) ||
    !Number.isFinite(concurrencyLimit) ||
    moduleCount <= concurrencyLimit
  ) {
    workflowModuleWarning.hidden = true
    workflowModuleWarning.textContent = ''
    return
  }

  workflowModuleWarning.hidden = false
  workflowModuleWarning.textContent = `模块数量 ${moduleCount} 个，超过当前并发 ${concurrencyLimit} 个，模块会分批执行，整体执行时间将会延长；agent 总超时时间保持 ${formatDuration(Number(result?.agentTimeoutMs) || DEFAULT_AGENT_TIMEOUT_MS)}。`
}

// ── Lightbox ──

function openLightbox(src) {
  const overlay = document.createElement('div')
  overlay.className = 'lightbox'
  overlay.innerHTML = `<img src="${src}" />`
  overlay.addEventListener('click', () => overlay.remove())
  document.body.appendChild(overlay)
}
window.openLightbox = openLightbox

// ── Browser artifact cache ──

let localArtifactDbPromise = null

function openLocalArtifactDb() {
  if (!('indexedDB' in window)) {
    return Promise.reject(new Error('当前浏览器不支持 IndexedDB，无法缓存大文件'))
  }
  if (localArtifactDbPromise) return localArtifactDbPromise

  localArtifactDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_ARTIFACT_DB_NAME, LOCAL_ARTIFACT_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(LOCAL_ARTIFACT_FILE_STORE)) {
        const store = db.createObjectStore(LOCAL_ARTIFACT_FILE_STORE, { keyPath: 'key' })
        store.createIndex('sessionId', 'sessionId', { unique: false })
      }
      if (!db.objectStoreNames.contains(LOCAL_ARTIFACT_SESSION_STORE)) {
        db.createObjectStore(LOCAL_ARTIFACT_SESSION_STORE, { keyPath: 'sessionId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('打开浏览器本地缓存失败'))
    request.onblocked = () => reject(new Error('浏览器本地缓存被其他页面占用，请关闭旧页面后重试'))
  })

  return localArtifactDbPromise
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('浏览器本地缓存读写失败'))
  })
}

function idbTransactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('浏览器本地缓存事务失败'))
    transaction.onabort = () => reject(transaction.error || new Error('浏览器本地缓存事务已中止'))
  })
}

function localArtifactFileKey(sessionId, filePath) {
  return `${sessionId}\n${normalizeFsPath(filePath)}`
}

async function deleteLocalArtifactCache(sessionId) {
  if (!sessionId) return
  try {
    await deleteLocalArtifactCacheStrict(sessionId)
  } catch (error) {
    console.warn('[artifact-cache] delete failed', error)
  }
}

async function deleteLocalArtifactCacheStrict(sessionId) {
  const db = await openLocalArtifactDb()
  const transaction = db.transaction(
    [LOCAL_ARTIFACT_FILE_STORE, LOCAL_ARTIFACT_SESSION_STORE],
    'readwrite',
  )
  const done = idbTransactionDone(transaction)
  transaction.objectStore(LOCAL_ARTIFACT_SESSION_STORE).delete(sessionId)
  const fileStore = transaction.objectStore(LOCAL_ARTIFACT_FILE_STORE)
  const index = fileStore.index('sessionId')
  const cursorDone = new Promise((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only(sessionId))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve()
        return
      }
      cursor.delete()
      cursor.continue()
    }
    request.onerror = () => reject(request.error || new Error('删除浏览器本地缓存失败'))
  })
  await Promise.all([cursorDone, done])
}

async function putLocalArtifactBundle(sessionId, records, meta) {
  const db = await openLocalArtifactDb()
  const transaction = db.transaction(
    [LOCAL_ARTIFACT_FILE_STORE, LOCAL_ARTIFACT_SESSION_STORE],
    'readwrite',
  )
  const done = idbTransactionDone(transaction)
  const fileStore = transaction.objectStore(LOCAL_ARTIFACT_FILE_STORE)
  records.forEach((record) => fileStore.put(record))
  transaction.objectStore(LOCAL_ARTIFACT_SESSION_STORE).put(meta)
  await done
}

async function putLocalArtifactBundleWithEviction(sessionId, records, meta) {
  try {
    await putLocalArtifactBundle(sessionId, records, meta)
    return
  } catch (error) {
    if (!isQuotaExceededError(error)) throw error
  }

  const candidates = (await getCachedArtifactSessionMetas())
    .filter((item) => item?.sessionId && item.sessionId !== sessionId)
    .sort((a, b) => Number(a.cachedAt || 0) - Number(b.cachedAt || 0))

  for (const candidate of candidates) {
    await deleteLocalArtifactCacheStrict(candidate.sessionId)
    clearLocalArtifactCacheState(candidate.sessionId)
    try {
      await putLocalArtifactBundle(sessionId, records, meta)
      return
    } catch (error) {
      if (!isQuotaExceededError(error)) throw error
    }
  }

  throw new Error('浏览器本地缓存空间不足，已清理旧缓存但仍无法写入当前 session')
}

function clearLocalArtifactCacheState(sessionId) {
  localArtifactCacheMetaBySession.delete(sessionId)
  const session = sessions.find((item) => item.id === sessionId)
  if (session?.result) {
    LOCAL_ARTIFACT_RESULT_KEYS.forEach((key) => {
      delete session.result[key]
    })
    saveLocalSessionSnapshot(session, { touch: false })
  }
  const snapshots = readLocalSessionSnapshots()
  if (snapshots[sessionId]?.result) {
    LOCAL_ARTIFACT_RESULT_KEYS.forEach((key) => {
      delete snapshots[sessionId].result[key]
    })
    writeLocalSessionSnapshots(snapshots)
  }
}

async function getCachedArtifactSessionMeta(sessionId) {
  if (!sessionId) return null
  const db = await openLocalArtifactDb()
  const transaction = db.transaction(LOCAL_ARTIFACT_SESSION_STORE, 'readonly')
  return idbRequest(transaction.objectStore(LOCAL_ARTIFACT_SESSION_STORE).get(sessionId))
}

async function getCachedArtifactSessionMetas() {
  const db = await openLocalArtifactDb()
  const transaction = db.transaction(LOCAL_ARTIFACT_SESSION_STORE, 'readonly')
  return idbRequest(transaction.objectStore(LOCAL_ARTIFACT_SESSION_STORE).getAll())
}

async function getCachedArtifactFiles(sessionId) {
  if (!sessionId) return []
  const db = await openLocalArtifactDb()
  const transaction = db.transaction(LOCAL_ARTIFACT_FILE_STORE, 'readonly')
  const index = transaction.objectStore(LOCAL_ARTIFACT_FILE_STORE).index('sessionId')
  return idbRequest(index.getAll(IDBKeyRange.only(sessionId)))
}

async function hydrateLocalArtifactCacheMetadataForSessions(sessionList) {
  if (!Array.isArray(sessionList) || !sessionList.length) return
  await Promise.all(
    sessionList.map(async (session) => {
      if (!session?.id) return
      try {
        const meta = await getCachedArtifactSessionMeta(session.id)
        if (meta?.status === 'cached') {
          applyLocalArtifactCacheMetaToSession(session, meta)
        }
      } catch {
        // IndexedDB may be unavailable; the rest of the app should stay usable.
      }
    }),
  )
}

function normalizeLocalArtifactMeta(meta) {
  if (!meta || typeof meta !== 'object') return null
  return {
    sessionId: meta.sessionId,
    status: meta.status || 'cached',
    htmlPath: meta.htmlPath || '',
    compareHtmlPath: meta.compareHtmlPath || '',
    paths: Array.isArray(meta.paths) ? meta.paths.map(normalizeFsPath) : [],
    fileCount: Number(meta.fileCount) || 0,
    byteSize: Number(meta.byteSize) || 0,
    cachedAt: Number(meta.cachedAt) || Date.now(),
    error: meta.error || '',
  }
}

function isQuotaExceededError(error) {
  const name = String(error?.name || '')
  const message = String(error?.message || error || '')
  return /quota|storage/i.test(name) || /quota|storage/i.test(message)
}

function resultMetaFromLocalArtifactCache(result, sessionId) {
  if (!result?.localArtifactCacheStatus) return null
  return normalizeLocalArtifactMeta({
    sessionId,
    status: result.localArtifactCacheStatus,
    htmlPath: result.htmlPath,
    compareHtmlPath: result.compareHtmlPath,
    paths: result.localArtifactCachePaths,
    fileCount: result.localArtifactCacheFileCount,
    byteSize: result.localArtifactCacheByteSize,
    cachedAt: result.localArtifactCacheAt,
    error: result.localArtifactCacheError,
  })
}

function getLocalArtifactCacheMetaForSession(session) {
  if (!session?.id) return null
  return (
    localArtifactCacheMetaBySession.get(session.id) ||
    resultMetaFromLocalArtifactCache(session.result, session.id)
  )
}

function isLocalArtifactCacheReady(session) {
  return getLocalArtifactCacheMetaForSession(session)?.status === 'cached'
}

function applyLocalArtifactCacheMetaToSession(session, metaInput) {
  if (!session?.id) return null
  const meta = normalizeLocalArtifactMeta({ ...metaInput, sessionId: session.id })
  if (!meta) return null
  localArtifactCacheMetaBySession.set(session.id, meta)
  session.result = {
    ...(session.result || {}),
    localArtifactCacheStatus: meta.status,
    localArtifactCacheFileCount: meta.fileCount,
    localArtifactCacheByteSize: meta.byteSize,
    localArtifactCachePaths: meta.paths,
    localArtifactCacheAt: meta.cachedAt,
    localArtifactCacheError: meta.error || undefined,
  }
  return meta
}

function setSessionLocalArtifactCacheStatus(sessionId, status, error = '') {
  const session = sessions.find((item) => item.id === sessionId)
  if (!session) return
  const previousMeta = localArtifactCacheMetaBySession.get(sessionId)
  localArtifactCacheMetaBySession.set(sessionId, {
    ...(previousMeta || { sessionId, paths: [], fileCount: 0, byteSize: 0, cachedAt: Date.now() }),
    status,
    error,
  })
  const result = {
    ...(session.result || {}),
    localArtifactCacheStatus: status,
    localArtifactCacheError: error || undefined,
  }
  session.result = result
  if (currentSessionId === sessionId) currentSession = session
  saveLocalSessionSnapshot(session, { touch: false })
}

async function maybeAutoCacheCurrentSessionArtifacts() {
  if (
    !currentSession ||
    isLocalOnlySession(currentSession) ||
    !isCompletedStatus(currentSession.status) ||
    !currentSession.result?.htmlPath
  ) return
  if (currentSession.result?.localArtifactCacheStatus === 'error') return
  if (isLocalArtifactCacheReady(currentSession)) return
  if (localArtifactCacheInFlight.has(currentSession.id) || autoArtifactCacheStarted.has(currentSession.id)) return
  autoArtifactCacheStarted.add(currentSession.id)
  try {
    await cacheCurrentSessionArtifacts({ silent: true, automatic: true })
  } catch {
    autoArtifactCacheStarted.delete(currentSession.id)
  }
}

async function cacheCurrentSessionArtifacts(options = {}) {
  if (!currentSessionId || !currentSession) return null
  if (isLocalOnlySession(currentSession)) {
    if (!options.silent) alert('本地归档记录不能重新从后端缓存文件')
    return null
  }
  const sessionId = currentSessionId
  if (localArtifactCacheInFlight.has(sessionId)) return getLocalArtifactCacheMetaForSession(currentSession)

  localArtifactCacheInFlight.add(sessionId)
  setSessionLocalArtifactCacheStatus(sessionId, 'caching')
  renderResults(currentSession?.result)

  try {
    if (!options.automatic) appendStatusEvent('开始缓存 HTML 和关联静态资源到浏览器本地')
    const meta = await cacheSessionArtifacts(currentSession)
    const session = sessions.find((item) => item.id === sessionId)
    if (session) {
      applyLocalArtifactCacheMetaToSession(session, meta)
      if (currentSessionId === sessionId) currentSession = session
      upsertSession(session)
    }
    if (!options.automatic) {
      appendStatusEvent(`本地缓存完成：${meta.fileCount} 个文件，${formatBytes(meta.byteSize)}`)
    }
    return meta
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setSessionLocalArtifactCacheStatus(sessionId, 'error', message)
    appendStatusEvent(`本地缓存失败：${message}`)
    if (!options.silent) alert(message)
    if (options.silent || options.automatic) throw error
    return null
  } finally {
    localArtifactCacheInFlight.delete(sessionId)
    renderResults(currentSession?.result)
  }
}

async function cacheSessionArtifacts(session) {
  const sessionId = session?.id
  const result = session?.result || {}
  const htmlPath = result.htmlPath || session?.htmlPath
  if (!sessionId || !htmlPath) {
    throw new Error('当前 session 没有可缓存的 HTML')
  }

  const queue = []
  const queued = new Set()
  const recordsByPath = new Map()
  const failures = []
  const enqueue = (filePath, critical = false) => {
    if (!filePath) return
    const normalized = normalizeFsPath(filePath)
    if (queued.has(normalized)) return
    queued.add(normalized)
    queue.push({ critical, filePath: normalized })
  }

  collectSessionRootArtifactPaths(session).forEach((filePath) => {
    enqueue(filePath, normalizeFsPath(filePath) === normalizeFsPath(htmlPath))
  })

  while (queue.length) {
    const item = queue.shift()
    try {
      const blob = await fetchLocalFileBlob(item.filePath, session)
      const contentType = blob.type || guessContentType(item.filePath)
      const record = {
        key: localArtifactFileKey(sessionId, item.filePath),
        sessionId,
        path: item.filePath,
        blob,
        contentType,
        size: blob.size,
        updatedAt: Date.now(),
      }
      recordsByPath.set(item.filePath, record)

      if (isHtmlArtifactFile(item.filePath) || isCssArtifactFile(item.filePath)) {
        const source = await blob.text()
        collectLocalHtmlReferences(source).forEach((ref) => {
          if (isExternalReference(ref)) return
          const cleanRef = stripQueryAndHash(ref)
          if (!cleanRef) return
          enqueue(resolveFsPath(dirnameFsPath(item.filePath), cleanRef))
        })
      }
    } catch (error) {
      failures.push({
        path: item.filePath,
        message: error instanceof Error ? error.message : String(error),
      })
      if (item.critical) throw error
    }
  }

  const records = Array.from(recordsByPath.values())
  if (!records.some((record) => record.path === normalizeFsPath(htmlPath))) {
    throw new Error('最终 HTML 未能写入浏览器本地缓存')
  }

  const meta = {
    sessionId,
    designName: session.designName || sessionId,
    status: 'cached',
    htmlPath: normalizeFsPath(htmlPath),
    compareHtmlPath: normalizeFsPath(result.compareHtmlPath || session.compareHtmlPath || ''),
    paths: records.map((record) => record.path),
    fileCount: records.length,
    byteSize: records.reduce((sum, record) => sum + Number(record.size || 0), 0),
    cachedAt: Date.now(),
    failures: failures.slice(0, 20),
  }
  await putLocalArtifactBundleWithEviction(sessionId, records, meta)
  return meta
}

function collectSessionRootArtifactPaths(session) {
  const result = session?.result || {}
  const paths = [
    result.htmlPath || session?.htmlPath,
    result.compareHtmlPath || session?.compareHtmlPath,
    session?.svgPath,
    result.svgPngPath,
    result.htmlPngPath,
    result.diffPngPath,
  ]
  return uniqueIds(paths.map((item) => (item ? normalizeFsPath(item) : '')))
}

async function openSessionArtifact(kind) {
  const session = currentSession
  if (!session?.id) return
  const result = session.result || {}
  const targetPath = kind === 'compare'
    ? result.compareHtmlPath || session.compareHtmlPath
    : result.htmlPath || session.htmlPath
  if (!targetPath) {
    alert('没有可打开的文件')
    return
  }

  if (isLocalArtifactCacheReady(session)) {
    let records = await getCachedArtifactFiles(session.id)
    if (records.length) {
      try {
        const url = await createCachedArtifactObjectUrl(targetPath, records)
        openUrl(url)
        return
      } catch (error) {
        console.warn('[artifact-cache] open cached artifact failed', error)
      }
    }
  }

  if (isLocalOnlySession(session)) {
    alert('本地归档记录没有可打开的浏览器缓存文件')
    return
  }

  openUrl(workspaceFileUrl(targetPath, session))
}

function openUrl(url) {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.target = '_blank'
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

async function createCachedArtifactObjectUrl(targetPath, records) {
  const recordsByPath = new Map(
    records
      .filter((record) => record?.path && record?.blob)
      .map((record) => [normalizeFsPath(record.path), record]),
  )
  const objectUrls = new Map()
  const building = new Set()

  const makeUrl = async (filePath) => {
    const normalized = normalizeFsPath(filePath)
    if (objectUrls.has(normalized)) return objectUrls.get(normalized)
    const record = recordsByPath.get(normalized)
    if (!record) {
      return workspaceFileUrl(normalized)
    }
    if (building.has(normalized)) {
      return workspaceFileUrl(normalized)
    }
    building.add(normalized)

    let blob = record.blob
    const contentType = record.contentType || guessContentType(normalized)
    if (isHtmlArtifactFile(normalized) || isCssArtifactFile(normalized)) {
      const source = await blob.text()
      const rewritten = await rewriteCachedArtifactReferences(source, normalized, makeUrl)
      blob = new Blob([rewritten], { type: contentType || guessContentType(normalized) })
    }

    const url = URL.createObjectURL(blob)
    objectUrls.set(normalized, url)
    building.delete(normalized)
    return url
  }

  const url = await makeUrl(targetPath)
  if (!url.startsWith('blob:')) {
    throw new Error(`缓存中缺少文件：${targetPath}`)
  }
  return url
}

async function rewriteCachedArtifactReferences(source, sourcePath, makeUrl) {
  let next = source
  const refs = collectLocalHtmlReferences(source)
  for (const ref of refs) {
    if (isExternalReference(ref)) continue
    const cleanRef = stripQueryAndHash(ref)
    if (!cleanRef) continue
    const targetPath = resolveFsPath(dirnameFsPath(sourcePath), cleanRef)
    const replacement = await makeUrl(targetPath)
    const hashIndex = ref.indexOf('#')
    const suffix = hashIndex >= 0 ? ref.slice(hashIndex) : ''
    next = next.split(ref).join(`${replacement}${suffix}`)
  }
  return next
}

function isHtmlArtifactFile(filePath) {
  const clean = stripQueryAndHash(filePath).toLowerCase()
  return clean.endsWith('.html') || clean.endsWith('.htm')
}

function isCssArtifactFile(filePath) {
  return stripQueryAndHash(filePath).toLowerCase().endsWith('.css')
}

function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let size = bytes / 1024
  let unit = units[0]
  for (let i = 1; i < units.length && size >= 1024; i += 1) {
    size /= 1024
    unit = units[i]
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`
}

function formatCacheTimestamp(value) {
  const date = new Date(Number(value) || Date.now())
  return date.toLocaleString('zh-CN', { hour12: false })
}

async function downloadCurrentSessionZip() {
  const session = currentSession
  if (!session?.id) return

  if (isLocalArtifactCacheReady(session)) {
    try {
      const records = await getCachedArtifactFiles(session.id)
      if (records.length) {
        appendStatusEvent('正在从浏览器本地缓存打包 ZIP')
        const zipBlob = await createZipBlobForCachedSession(session, records)
        downloadBlob(zipBlob, `${sanitizeFileName(session.designName || session.id)}.zip`)
        appendStatusEvent(`本地 ZIP 已生成：${formatBytes(zipBlob.size)}`)
        return
      }
    } catch (error) {
      console.warn('[artifact-cache] local zip download failed', error)
      if (isLocalOnlySession(session)) {
        alert(error instanceof Error ? error.message : '本地 ZIP 打包失败')
        return
      }
    }
  }

  if (isLocalOnlySession(session)) {
    alert('本地归档记录没有可下载的浏览器缓存 ZIP')
    return
  }
  window.location.href = `${basePath}/api/sessions/${session.id}/download`
}

async function createZipBlobForCachedSession(session, records) {
  const entries = []
  const usedNames = new Set()
  const sortedRecords = records
    .filter((record) => record?.path && record?.blob)
    .sort((a, b) => normalizeFsPath(a.path).localeCompare(normalizeFsPath(b.path)))

  for (const record of sortedRecords) {
    let name = zipEntryNameForCachedRecord(session, record.path)
    if (usedNames.has(name)) {
      const dotIndex = name.lastIndexOf('.')
      const prefix = dotIndex > 0 ? name.slice(0, dotIndex) : name
      const suffix = dotIndex > 0 ? name.slice(dotIndex) : ''
      let index = 2
      while (usedNames.has(`${prefix}-${index}${suffix}`)) index += 1
      name = `${prefix}-${index}${suffix}`
    }
    usedNames.add(name)
    entries.push({
      blob: record.blob,
      date: Number(record.updatedAt) || Date.now(),
      name,
    })
  }

  if (!entries.length) throw new Error('浏览器本地缓存为空，无法生成 ZIP')
  return createZipBlob(entries)
}

function zipEntryNameForCachedRecord(session, filePath) {
  const result = session?.result || {}
  const normalizedPath = normalizeFsPath(filePath)
  const baseDir = normalizeFsPath(
    session?.sessionDir ||
      dirnameFsPath(result.htmlPath || session?.htmlPath || normalizedPath),
  ).replace(/\/+$/, '')
  const root = sanitizeFileName(session?.designName || session?.id || 'session')
  let relative = normalizedPath
  if (baseDir && normalizedPath.startsWith(`${baseDir}/`)) {
    relative = normalizedPath.slice(baseDir.length + 1)
  } else if (normalizedPath === baseDir) {
    relative = basenameFsPath(normalizedPath)
  } else {
    relative = basenameFsPath(normalizedPath)
  }
  return normalizeZipEntryPath(`${root}/${relative}`)
}

function basenameFsPath(filePath) {
  return normalizeFsPath(filePath).split('/').filter(Boolean).pop() || 'file'
}

function sanitizeFileName(value) {
  const text = String(value || 'file')
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return text || 'file'
}

function normalizeZipEntryPath(value) {
  const parts = normalizeFsPath(value)
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map(sanitizeFileName)
  return parts.join('/') || 'file'
}

async function createZipBlob(entries) {
  const encoder = new TextEncoder()
  const chunks = []
  const centralChunks = []
  let offset = 0

  for (const entry of entries) {
    const arrayBuffer = await entry.blob.arrayBuffer()
    const size = arrayBuffer.byteLength
    if (size > 0xffffffff || offset > 0xffffffff) {
      throw new Error('ZIP 文件过大，当前浏览器端打包不支持超过 4GB')
    }
    const nameBytes = encoder.encode(entry.name)
    const crc = crc32(arrayBuffer)
    const { date, time } = zipDosDateTime(entry.date)
    const localHeader = createZipLocalFileHeader({ crc, date, nameBytes, size, time })
    const centralHeader = createZipCentralDirectoryHeader({
      crc,
      date,
      localHeaderOffset: offset,
      nameBytes,
      size,
      time,
    })

    chunks.push(localHeader, nameBytes, arrayBuffer)
    centralChunks.push(centralHeader, nameBytes)
    offset += localHeader.byteLength + nameBytes.byteLength + size
  }

  const centralDirectoryOffset = offset
  let centralDirectorySize = 0
  centralChunks.forEach((chunk) => {
    centralDirectorySize += chunk.byteLength
  })
  if (centralDirectoryOffset > 0xffffffff || centralDirectorySize > 0xffffffff) {
    throw new Error('ZIP 文件过大，当前浏览器端打包不支持超过 4GB')
  }

  const endRecord = createZipEndOfCentralDirectory({
    centralDirectoryOffset,
    centralDirectorySize,
    entryCount: entries.length,
  })
  return new Blob([...chunks, ...centralChunks, endRecord], { type: 'application/zip' })
}

function createZipLocalFileHeader({ crc, date, nameBytes, size, time }) {
  const header = new Uint8Array(30)
  const view = new DataView(header.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, 0x0800, true)
  view.setUint16(8, 0, true)
  view.setUint16(10, time, true)
  view.setUint16(12, date, true)
  view.setUint32(14, crc, true)
  view.setUint32(18, size, true)
  view.setUint32(22, size, true)
  view.setUint16(26, nameBytes.byteLength, true)
  view.setUint16(28, 0, true)
  return header
}

function createZipCentralDirectoryHeader({
  crc,
  date,
  localHeaderOffset,
  nameBytes,
  size,
  time,
}) {
  const header = new Uint8Array(46)
  const view = new DataView(header.buffer)
  view.setUint32(0, 0x02014b50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, 20, true)
  view.setUint16(8, 0x0800, true)
  view.setUint16(10, 0, true)
  view.setUint16(12, time, true)
  view.setUint16(14, date, true)
  view.setUint32(16, crc, true)
  view.setUint32(20, size, true)
  view.setUint32(24, size, true)
  view.setUint16(28, nameBytes.byteLength, true)
  view.setUint16(30, 0, true)
  view.setUint16(32, 0, true)
  view.setUint16(34, 0, true)
  view.setUint16(36, 0, true)
  view.setUint32(38, 0, true)
  view.setUint32(42, localHeaderOffset, true)
  return header
}

function createZipEndOfCentralDirectory({
  centralDirectoryOffset,
  centralDirectorySize,
  entryCount,
}) {
  if (entryCount > 0xffff) {
    throw new Error('ZIP 文件数量过多，当前浏览器端打包不支持超过 65535 个文件')
  }
  const header = new Uint8Array(22)
  const view = new DataView(header.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(4, 0, true)
  view.setUint16(6, 0, true)
  view.setUint16(8, entryCount, true)
  view.setUint16(10, entryCount, true)
  view.setUint32(12, centralDirectorySize, true)
  view.setUint32(16, centralDirectoryOffset, true)
  view.setUint16(20, 0, true)
  return header
}

function zipDosDateTime(value) {
  const date = new Date(Number(value) || Date.now())
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  }
}

let crc32Table = null

function getCrc32Table() {
  if (crc32Table) return crc32Table
  crc32Table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    crc32Table[i] = c >>> 0
  }
  return crc32Table
}

function crc32(arrayBuffer) {
  const table = getCrc32Table()
  const bytes = new Uint8Array(arrayBuffer)
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

window.cacheCurrentSessionArtifacts = cacheCurrentSessionArtifacts
window.openSessionArtifact = openSessionArtifact
window.downloadCurrentSessionZip = downloadCurrentSessionZip

// ── Utilities ──

function hasPrimaryResults(result) {
  return Boolean(
    result &&
    result.finalOutputReady !== false &&
    (
      (result.svgPngPath && result.htmlPngPath) ||
      result.localArtifactCacheStatus === 'cached'
    ),
  )
}

function isSessionBusy(session) {
  if (isLocalOnlySession(session)) return false
  return session?.status === 'running' || session?.status === 'queued'
}

function setSidebarCollapsed(next) {
  sidebarCollapsed = Boolean(next)
  appShell.classList.toggle('sidebar-collapsed', sidebarCollapsed)
  sidebarToggleBtn.title = sidebarCollapsed ? '展开 Session' : '收起 Session'
  try {
    localStorage.setItem('svg2html:sidebarCollapsed', String(sidebarCollapsed))
  } catch {
    // ignore storage failures
  }
}

function setChatDrawerOpen(next) {
  chatDrawerOpen = Boolean(next && currentSession)
  chatDrawer.classList.toggle('open', chatDrawerOpen)
  chatToggleBtn.classList.toggle('active', chatDrawerOpen)
  chatToggleBtn.textContent = chatDrawerOpen ? '收起聊天' : '打开聊天'
  document.body.classList.toggle('chat-open', chatDrawerOpen)
  renderModulePicker()
  renderModuleOverlays()
  updateComposerState()
}

function setResultPreviewWidth(value) {
  const width = Math.min(
    RESULT_PREVIEW_WIDTH_MAX,
    Math.max(RESULT_PREVIEW_WIDTH_MIN, Number(value) || RESULT_PREVIEW_WIDTH_DEFAULT),
  )
  document.documentElement.style.setProperty('--result-preview-width', `${width}px`)
  previewSizeRange.value = String(width)
  previewSizeValue.textContent = `${width}px`
  try {
    localStorage.setItem(RESULT_PREVIEW_SIZE_KEY, String(width))
  } catch {
    // ignore storage failures
  }
  syncResultPreviewFrames(resultGrid.querySelector('[data-result-scroll-frame]'))
}

function handleResultPreviewScroll(event) {
  if (syncingResultPreviewScroll) return
  const source = event.target
  if (!(source instanceof HTMLElement) || !source.matches('[data-result-scroll-frame]')) return
  syncResultPreviewFrames(source)
}

function syncResultPreviewFrames(source) {
  if (!(source instanceof HTMLElement)) return
  const frames = Array.from(resultGrid.querySelectorAll('[data-result-scroll-frame]'))
  if (frames.length < 2) return

  const topMax = Math.max(0, source.scrollHeight - source.clientHeight)
  const leftMax = Math.max(0, source.scrollWidth - source.clientWidth)
  const topRatio = topMax > 0 ? source.scrollTop / topMax : 0
  const leftRatio = leftMax > 0 ? source.scrollLeft / leftMax : 0

  syncingResultPreviewScroll = true
  frames.forEach((frame) => {
    if (frame === source) return
    const targetTopMax = Math.max(0, frame.scrollHeight - frame.clientHeight)
    const targetLeftMax = Math.max(0, frame.scrollWidth - frame.clientWidth)
    frame.scrollTop = topRatio * targetTopMax
    frame.scrollLeft = leftRatio * targetLeftMax
  })
  requestAnimationFrame(() => {
    syncingResultPreviewScroll = false
  })
}

function renderLayoutState() {
  const hasSession = Boolean(currentSession)
  const showResults = hasPrimaryResults(currentSession?.result)
  const busy = isSessionBusy(currentSession)
  let badgeText = ''
  if (hasSession) {
    if (isLocalOnlySession(currentSession)) {
      badgeText = '本地记录'
    } else if (currentSession.status === 'queued') {
      badgeText = '排队中'
    } else if (busy) {
      badgeText = '执行中'
    } else if (currentSession.status === 'paused') {
      badgeText = '已暂停'
    } else if (currentSession.status === 'failed') {
      badgeText = '失败'
    }
  }

  workflowPanel.classList.toggle('visible', !showResults)
  resultPanel.classList.toggle('visible', showResults)
  executionBadge.classList.toggle('visible', Boolean(badgeText))
  executionBadge.textContent = badgeText
  chatToggleBtn.disabled = !hasSession

  if (!hasSession) {
    chatStatus.textContent = '选择 session 后可查看聊天'
  }

  if (!hasSession) {
    setChatDrawerOpen(false)
  }
}

function updateComposerState() {
  const hasSession = Boolean(currentSession)
  const locked = !hasSession || isSessionInputLocked(currentSession)
  const hasText = Boolean(messageInput.value.trim())
  const modules = collectSelectableModules()
  const needsModule = hasSession && !isLocalOnlySession(currentSession)
  const hasSelectedModule = !needsModule || Boolean(selectedModuleId)

  messageInput.disabled = locked
  messageInput.readOnly = locked
  sendBtn.disabled = locked || !hasText || !hasSelectedModule
  composer.classList.toggle('is-disabled', locked)

  if (!hasSession) {
    composerHint.textContent = '选择 session 后可发送调整要求'
    return
  }
  if (isLocalOnlySession(currentSession)) {
    composerHint.textContent = '这是本地归档记录，云端实例已重置，不能继续执行'
    return
  }
  if (isCompletedStatus(currentSession.status)) {
    composerHint.textContent = hasSelectedModule
      ? `将发送给模块 ${selectedModuleId} agent`
      : modules.length ? '先选择要修复的模块' : '生成完成后才可选择模块'
    return
  }
  if (currentSession.status === 'queued' || currentSession.status === 'running') {
    composerHint.textContent = '当前正在执行，聊天输入已锁定'
    return
  }
  composerHint.textContent = hasSelectedModule
    ? `将发送给模块 ${selectedModuleId} agent`
    : modules.length ? '先选择要修复的模块' : '生成完成后才可选择模块'
}

function normalizeFsPathForUrl(value) {
  return String(value || '').replace(/\\/g, '/')
}

function encodePathForUrl(absPath) {
  const normalizedPath = normalizeFsPathForUrl(absPath)
  const normalizedWorkspaceRoot = normalizeFsPathForUrl(runtimeWorkspaceRoot).replace(/\/+$/, '')
  if (normalizedWorkspaceRoot) {
    if (normalizedPath === normalizedWorkspaceRoot) return ''
    if (normalizedPath.startsWith(`${normalizedWorkspaceRoot}/`)) {
      return normalizedPath
        .slice(normalizedWorkspaceRoot.length + 1)
        .split('/')
        .map(encodeURIComponent)
        .join('/')
    }
  }
  const parts = absPath.split('workspace/')
  const relative = parts.length > 1 ? parts[parts.length - 1] : absPath
  return relative.split('/').map(encodeURIComponent).join('/')
}

function workspaceFileVersion(session = currentSession) {
  return (
    toTimestamp(session?.updatedAt) ??
    toTimestamp(getProgressNode(session, 'done')?.completedAt) ??
    toTimestamp(session?.createdAt) ??
    ''
  )
}

function workspaceFileUrl(absPath, session = currentSession) {
  const url = `${basePath}/files/${encodePathForUrl(absPath)}`
  const version = workspaceFileVersion(session)
  return version ? `${url}?v=${encodeURIComponent(String(version))}` : url
}

function labelForRole(role) {
  return role === 'assistant' ? '大模型' : role === 'user' ? '你' : '系统'
}

function labelForStep(step) {
  return step === 'agent' ? '模型执行' : '视觉校验'
}

function labelForWorkflowNode(node) {
  const map = {
    upload: '已上传',
    analysis: '结构解析',
    agent: '大模型生成',
    verify: '视觉校验',
    export: '框架导出',
    feedback: '迭代修正',
    done: '完成',
  }
  return map[node] || node
}

function labelForStatus(status) {
  const map = {
    draft: '草稿',
    queued: '排队中',
    running: '执行中',
    paused: '已暂停',
    completed: '已完成',
    'best-effort': '已完成',
    'failed-gate': '已完成',
    failed: '失败',
  }
  return map[status] || status
}

function labelForNodeState(status, active) {
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'running') return active ? '当前执行' : '执行中'
  return '待执行'
}

function isCompletedStatus(status) {
  return status === 'completed' || status === 'best-effort' || status === 'failed-gate'
}

function isSessionInputLocked(session) {
  if (!session) return true
  if (isLocalOnlySession(session)) return true
  return session.status === 'queued' || session.status === 'running'
}

function composerPlaceholderFor(session) {
  if (!session) return '输入调整要求…'
  if (isLocalOnlySession(session)) return '本地归档记录不能继续执行'
  if (isSessionInputLocked(session)) return '生成中，完成后才能输入调整要求'
  return '输入调整要求…'
}

function syncComposerState(session) {
  const locked = isSessionInputLocked(session)
  messageInput.disabled = locked
  messageInput.readOnly = locked
  messageInput.placeholder = composerPlaceholderFor(session)
  sendBtn.disabled = locked

  if (locked) {
    messageInput.blur()
  }
}

function deriveFallbackCurrentNode(session) {
  if (!session) return null
  if (isCompletedStatus(session.status)) return 'done'
  if (session.activeStep === 'verify') return 'verify'
  if (session.activeStep === 'agent') return 'agent'
  return 'upload'
}

function deriveFallbackNodeStatus(session, key, currentNode) {
  if (!session) return key === 'upload' ? 'completed' : 'pending'
  if (isCompletedStatus(session.status) && key === 'done') return 'completed'
  if (session.status === 'failed' && key === currentNode) return 'failed'
  if ((session.status === 'running' || session.status === 'queued') && key === currentNode) {
    return 'running'
  }

  const currentIndex = WORKFLOW_NODE_ORDER.indexOf(currentNode || 'upload')
  const keyIndex = WORKFLOW_NODE_ORDER.indexOf(key)
  if (key === 'upload') return 'completed'
  if (keyIndex >= 0 && currentIndex > keyIndex) return 'completed'
  return 'pending'
}

function getWorkflowProgress(session) {
  const fallbackNode = deriveFallbackCurrentNode(session)
  const progress = session?.progress || {}
  const sourceNodes = progress.nodes || {}
  const nodes = {}

  for (const key of WORKFLOW_NODE_ORDER) {
    const source = key === 'analysis'
      ? sourceNodes.analysis || sourceNodes[LEGACY_ANALYSIS_NODE_KEY] || {}
      : sourceNodes[key] || {}
    nodes[key] = {
      ...source,
      label: source.label || labelForWorkflowNode(key),
      status: source.status || deriveFallbackNodeStatus(session, key, fallbackNode),
    }
  }

  return {
    currentNode: normalizeWorkflowNodeKey(progress.currentNode) || fallbackNode,
    detail:
      (isLocalOnlySession(session)
        ? '云端实例已重置，已从本地快照恢复历史结果'
        : '') ||
      progress.detail ||
      (session
        ? session.status === 'queued'
          ? '已进入队列，等待执行'
          : isCompletedStatus(session.status)
            ? '所有阶段已完成，可查看结果和报告'
            : session.status === 'failed'
              ? session.error || '执行失败'
              : '等待执行'
        : ''),
    iteration: session ? progress.iteration || 1 : 0,
    maxIterations: progress.maxIterations,
    nodes,
  }
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function normalizeFsPath(input) {
  const isAbsolute = input.startsWith('/')
  const parts = []

  input.split('/').forEach((segment) => {
    if (!segment || segment === '.') return
    if (segment === '..') {
      if (parts.length) parts.pop()
      return
    }
    parts.push(segment)
  })

  return `${isAbsolute ? '/' : ''}${parts.join('/')}`
}

function dirnameFsPath(filePath) {
  const normalized = normalizeFsPath(filePath)
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return '/'
  return normalized.slice(0, index)
}

function resolveFsPath(baseDir, ref) {
  if (ref.startsWith('/')) return normalizeFsPath(ref)
  return normalizeFsPath(`${baseDir}/${ref}`)
}

function stripQueryAndHash(value) {
  return value.split('#')[0].split('?')[0]
}

function isExternalReference(value) {
  const normalized = value.trim().toLowerCase()
  return (
    !normalized ||
    normalized.startsWith('http://') ||
    normalized.startsWith('https://') ||
    normalized.startsWith('//') ||
    normalized.startsWith('data:') ||
    normalized.startsWith('blob:') ||
    normalized.startsWith('javascript:') ||
    normalized.startsWith('#') ||
    normalized.startsWith('/')
  )
}

function collectLocalHtmlReferences(html) {
  const refs = []
  const seen = new Set()

  for (const match of html.matchAll(HTML_REFERENCE_PATTERN)) {
    const ref = (match[1] || match[3] || '').trim()
    if (!ref || isExternalReference(ref) || seen.has(ref)) continue
    seen.add(ref)
    refs.push(ref)
  }

  return refs
}

function guessContentType(fileName) {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html'
  if (lower.endsWith('.css')) return 'text/css'
  if (lower.endsWith('.js')) return 'application/javascript'
  if (lower.endsWith('.svga')) return 'application/svga'
  return ''
}

async function fetchLocalFileBlob(filePath, session = currentSession) {
  const res = await fetch(workspaceFileUrl(filePath, session), { cache: 'no-store' })
  if (!res.ok) {
    throw new Error(`读取本地文件失败：${filePath}`)
  }
  return res.blob()
}

setUploadScale(selectedUploadScale)
bootstrap()

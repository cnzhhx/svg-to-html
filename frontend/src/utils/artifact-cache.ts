import type { Session } from '../types/session'
import {
  getSessionCompareEntryPath,
  getSessionRenderEntryPath,
  getSessionRenderPngPath,
  getSessionSourceEntryPath,
  getSessionSourceStylePath,
  getSessionSvgPngPath,
  normalizeFsPath,
  workspaceFileUrl,
} from './artifacts'
import { STORAGE_KEYS } from './storage'

export type ArtifactCacheMeta = {
  byteSize: number
  cachedAt: number
  compareEntryPath?: string
  designName?: string
  error?: string
  failures?: Array<{ message: string; path: string }>
  fileCount: number
  paths: string[]
  renderEntryPath: string
  sessionId: string
  sourceEntryPath?: string
  status: 'cached' | 'caching' | 'error'
}

export type ArtifactRecord = {
  blob: Blob
  contentType: string
  key: string
  path: string
  sessionId: string
  size: number
  updatedAt: number
}

const DB_VERSION = 2
const FILE_STORE = 'files'
const SESSION_STORE = 'sessions'
const HTML_REFERENCE_PATTERN = /(?:src|href|poster)=["']([^"'<>]+)["']|url\((['"]?)([^)"']+)\2\)/g

let dbPromise: Promise<IDBDatabase> | null = null
let crc32Table: Uint32Array | null = null

export function openArtifactDb() {
  if (!('indexedDB' in window)) {
    return Promise.reject(new Error('当前浏览器不支持 IndexedDB，无法缓存大文件'))
  }
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(STORAGE_KEYS.localArtifactDb, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        const store = db.createObjectStore(FILE_STORE, { keyPath: 'key' })
        store.createIndex('sessionId', 'sessionId', { unique: false })
      }
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'sessionId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('打开浏览器本地缓存失败'))
    request.onblocked = () => reject(new Error('浏览器本地缓存被其他页面占用，请关闭旧页面后重试'))
  })
  return dbPromise
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('浏览器本地缓存读写失败'))
  })
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('浏览器本地缓存事务失败'))
    transaction.onabort = () => reject(transaction.error || new Error('浏览器本地缓存事务已中止'))
  })
}

const fileKey = (sessionId: string, filePath: string) => `${sessionId}\n${normalizeFsPath(filePath)}`

export async function getCachedArtifactSessionMeta(sessionId: string): Promise<ArtifactCacheMeta | null> {
  if (!sessionId) return null
  const db = await openArtifactDb()
  const transaction = db.transaction(SESSION_STORE, 'readonly')
  const meta = await requestResult<ArtifactCacheMeta | undefined>(transaction.objectStore(SESSION_STORE).get(sessionId))
  return meta || null
}

export async function getCachedArtifactSessionMetas(): Promise<ArtifactCacheMeta[]> {
  const db = await openArtifactDb()
  const transaction = db.transaction(SESSION_STORE, 'readonly')
  return requestResult<ArtifactCacheMeta[]>(transaction.objectStore(SESSION_STORE).getAll())
}

export async function getCachedArtifactFiles(sessionId: string): Promise<ArtifactRecord[]> {
  if (!sessionId) return []
  const db = await openArtifactDb()
  const transaction = db.transaction(FILE_STORE, 'readonly')
  const index = transaction.objectStore(FILE_STORE).index('sessionId')
  return requestResult<ArtifactRecord[]>(index.getAll(IDBKeyRange.only(sessionId)))
}

export async function deleteLocalArtifactCache(sessionId: string) {
  if (!sessionId) return
  const db = await openArtifactDb()
  const transaction = db.transaction([FILE_STORE, SESSION_STORE], 'readwrite')
  const done = transactionDone(transaction)
  transaction.objectStore(SESSION_STORE).delete(sessionId)
  const fileStore = transaction.objectStore(FILE_STORE)
  const index = fileStore.index('sessionId')
  await new Promise<void>((resolve, reject) => {
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
  await done
}

async function putBundle(sessionId: string, records: ArtifactRecord[], meta: ArtifactCacheMeta) {
  const db = await openArtifactDb()
  const transaction = db.transaction([FILE_STORE, SESSION_STORE], 'readwrite')
  const done = transactionDone(transaction)
  const fileStore = transaction.objectStore(FILE_STORE)
  records.forEach((record) => fileStore.put(record))
  transaction.objectStore(SESSION_STORE).put(meta)
  await done
}

async function putBundleWithEviction(sessionId: string, records: ArtifactRecord[], meta: ArtifactCacheMeta) {
  try {
    await putBundle(sessionId, records, meta)
    return
  } catch (error) {
    if (!isQuotaExceededError(error)) throw error
  }
  const candidates = (await getCachedArtifactSessionMetas())
    .filter((item) => item.sessionId && item.sessionId !== sessionId)
    .sort((left, right) => Number(left.cachedAt || 0) - Number(right.cachedAt || 0))
  for (const candidate of candidates) {
    await deleteLocalArtifactCache(candidate.sessionId)
    try {
      await putBundle(sessionId, records, meta)
      return
    } catch (error) {
      if (!isQuotaExceededError(error)) throw error
    }
  }
  throw new Error('浏览器本地缓存空间不足，已清理旧缓存但仍无法写入当前 session')
}

export async function cacheSessionArtifacts(session: Session): Promise<ArtifactCacheMeta> {
  const sessionId = session.id
  const sourceEntryPath = getSessionSourceEntryPath(session)
  const renderEntryPath = getSessionRenderEntryPath(session)
  const compareEntryPath = getSessionCompareEntryPath(session)
  if (!sessionId || !renderEntryPath) throw new Error('当前 session 没有可缓存的渲染预览')

  const queue: Array<{ critical?: boolean; filePath: string }> = []
  const queued = new Set<string>()
  const recordsByPath = new Map<string, ArtifactRecord>()
  const failures: Array<{ message: string; path: string }> = []
  const enqueue = (filePath: unknown, critical = false) => {
    const normalized = normalizeFsPath(filePath)
    if (!normalized || queued.has(normalized)) return
    queued.add(normalized)
    queue.push({ critical, filePath: normalized })
  }

  collectSessionRootArtifactPaths(session).forEach((filePath) => {
    enqueue(filePath, normalizeFsPath(filePath) === normalizeFsPath(renderEntryPath))
  })

  while (queue.length) {
    const item = queue.shift()!
    try {
      const blob = await fetchLocalFileBlob(item.filePath, session)
      const contentType = blob.type || guessContentType(item.filePath)
      recordsByPath.set(item.filePath, {
        blob,
        contentType,
        key: fileKey(sessionId, item.filePath),
        path: item.filePath,
        sessionId,
        size: blob.size,
        updatedAt: Date.now(),
      })
      if (isReferenceScannableArtifactFile(item.filePath)) {
        const source = await blob.text()
        collectLocalHtmlReferences(source).forEach((ref) => {
          if (isExternalReference(ref)) return
          const cleanRef = stripQueryAndHash(ref)
          if (!cleanRef) return
          enqueue(resolveFsPath(dirnameFsPath(item.filePath), cleanRef))
        })
      }
    } catch (error) {
      failures.push({ message: error instanceof Error ? error.message : String(error), path: item.filePath })
      if (item.critical) throw error
    }
  }

  const records = Array.from(recordsByPath.values())
  if (!records.some((record) => record.path === normalizeFsPath(renderEntryPath))) {
    throw new Error('渲染预览入口未能写入浏览器本地缓存')
  }
  const meta: ArtifactCacheMeta = {
    byteSize: records.reduce((sum, record) => sum + Number(record.size || 0), 0),
    cachedAt: Date.now(),
    compareEntryPath: normalizeFsPath(compareEntryPath),
    designName: session.designName || sessionId,
    failures: failures.slice(0, 20),
    fileCount: records.length,
    paths: records.map((record) => record.path),
    renderEntryPath: normalizeFsPath(renderEntryPath),
    sessionId,
    sourceEntryPath: normalizeFsPath(sourceEntryPath),
    status: 'cached',
  }
  await putBundleWithEviction(sessionId, records, meta)
  return meta
}

export function collectSessionRootArtifactPaths(session: Session) {
  const result = session.result || {}
  return unique([
    getSessionSourceEntryPath(session),
    getSessionSourceStylePath(session),
    getSessionRenderEntryPath(session),
    getSessionCompareEntryPath(session),
    session.svgPath,
    result.svgPngPath,
    result.renderPngPath,
    result.diffPngPath,
  ].map((item) => item ? normalizeFsPath(item) : ''))
}

export async function createCachedArtifactObjectUrl(targetPath: string, records: ArtifactRecord[]) {
  const recordsByPath = new Map(records.filter((record) => record.path && record.blob).map((record) => [normalizeFsPath(record.path), record]))
  const objectUrls = new Map<string, string>()
  const building = new Set<string>()
  const makeUrl = async (filePath: string): Promise<string> => {
    const normalized = normalizeFsPath(filePath)
    const existing = objectUrls.get(normalized)
    if (existing) return existing
    const record = recordsByPath.get(normalized)
    if (!record || building.has(normalized)) return workspaceFileUrl(normalized)
    building.add(normalized)
    let blob = record.blob
    const contentType = record.contentType || guessContentType(normalized)
    if (isHtmlArtifactFile(normalized) || isCssArtifactFile(normalized)) {
      const source = await blob.text()
      const rewritten = await rewriteCachedArtifactReferences(source, normalized, makeUrl)
      blob = new Blob([rewritten], { type: contentType })
    }
    const url = URL.createObjectURL(blob)
    objectUrls.set(normalized, url)
    building.delete(normalized)
    return url
  }
  const url = await makeUrl(targetPath)
  if (!url.startsWith('blob:')) throw new Error(`缓存中缺少文件：${targetPath}`)
  return url
}

export async function createZipBlobForCachedSession(session: Session, records: ArtifactRecord[]) {
  const entries = []
  const usedNames = new Set<string>()
  const sortedRecords = records
    .filter((record) => record.path && record.blob)
    .sort((left, right) => normalizeFsPath(left.path).localeCompare(normalizeFsPath(right.path)))
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
    entries.push({ blob: record.blob, date: Number(record.updatedAt) || Date.now(), name })
  }
  if (!entries.length) throw new Error('浏览器本地缓存为空，无法生成 ZIP')
  return createZipBlob(entries)
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function fetchLocalFileBlob(filePath: string, session: Session) {
  return fetch(workspaceFileUrl(filePath, session)).then((response) => {
    if (!response.ok) throw new Error(`读取文件失败 ${response.status}: ${filePath}`)
    return response.blob()
  })
}

async function rewriteCachedArtifactReferences(source: string, sourcePath: string, makeUrl: (path: string) => Promise<string>) {
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

function collectLocalHtmlReferences(source: string) {
  const refs = new Set<string>()
  for (const match of source.matchAll(HTML_REFERENCE_PATTERN)) {
    const value = match[1] || match[3]
    if (value) refs.add(value)
  }
  return [...refs]
}

function isExternalReference(value: string) {
  return /^(?:[a-z][a-z0-9+.-]*:|#|data:|blob:|mailto:|tel:|\/\/)/i.test(String(value || '').trim())
}

function stripQueryAndHash(value: string) {
  return String(value || '').split('#')[0]!.split('?')[0]!
}

function dirnameFsPath(filePath: string) {
  const parts = normalizeFsPath(filePath).split('/')
  parts.pop()
  return parts.join('/') || '/'
}

function basenameFsPath(filePath: string) {
  return normalizeFsPath(filePath).split('/').filter(Boolean).pop() || 'file'
}

function resolveFsPath(baseDir: string, ref: string) {
  const cleanRef = normalizeFsPath(ref)
  if (cleanRef.startsWith('/')) return cleanRef
  const parts = normalizeFsPath(`${baseDir}/${cleanRef}`).split('/')
  const resolved: string[] = []
  parts.forEach((part) => {
    if (!part || part === '.') return
    if (part === '..') resolved.pop()
    else resolved.push(part)
  })
  return `${normalizeFsPath(baseDir).startsWith('/') ? '/' : ''}${resolved.join('/')}`
}

function isHtmlArtifactFile(filePath: string) {
  const clean = stripQueryAndHash(filePath).toLowerCase()
  return clean.endsWith('.html') || clean.endsWith('.htm')
}

function isCssArtifactFile(filePath: string) {
  return stripQueryAndHash(filePath).toLowerCase().endsWith('.css')
}

function isReferenceScannableArtifactFile(filePath: string) {
  const clean = stripQueryAndHash(filePath).toLowerCase()
  return isHtmlArtifactFile(clean) || isCssArtifactFile(clean) || clean.endsWith('.vue') || clean.endsWith('.tsx') || clean.endsWith('.jsx') || clean.endsWith('.ts') || clean.endsWith('.js')
}

function guessContentType(filePath: string) {
  const clean = stripQueryAndHash(filePath).toLowerCase()
  if (clean.endsWith('.html') || clean.endsWith('.htm')) return 'text/html;charset=utf-8'
  if (clean.endsWith('.css')) return 'text/css;charset=utf-8'
  if (clean.endsWith('.js') || clean.endsWith('.mjs') || clean.endsWith('.jsx') || clean.endsWith('.ts') || clean.endsWith('.tsx')) return 'text/javascript;charset=utf-8'
  if (clean.endsWith('.json')) return 'application/json;charset=utf-8'
  if (clean.endsWith('.svg')) return 'image/svg+xml'
  if (clean.endsWith('.png')) return 'image/png'
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg'
  if (clean.endsWith('.webp')) return 'image/webp'
  if (clean.endsWith('.gif')) return 'image/gif'
  return 'application/octet-stream'
}

function isQuotaExceededError(error: unknown) {
  const name = String((error as { name?: unknown })?.name || '')
  const message = String((error as Error)?.message || error || '')
  return /quota|storage/i.test(name) || /quota|storage/i.test(message)
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}

function zipEntryNameForCachedRecord(session: Session, filePath: string) {
  const normalizedPath = normalizeFsPath(filePath)
  const baseDir = normalizeFsPath(session.sessionDir || dirnameFsPath(getSessionRenderEntryPath(session) || getSessionSourceEntryPath(session) || normalizedPath)).replace(/\/+$/, '')
  const root = sanitizeFileName(session.designName || session.id || 'session')
  let relative = normalizedPath
  if (baseDir && normalizedPath.startsWith(`${baseDir}/`)) relative = normalizedPath.slice(baseDir.length + 1)
  else relative = basenameFsPath(normalizedPath)
  return normalizeZipEntryPath(`${root}/${relative}`)
}

function sanitizeFileName(value: unknown) {
  const text = String(value || 'file').replace(/[<>:"\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim()
  return text || 'file'
}

function normalizeZipEntryPath(value: string) {
  const parts = normalizeFsPath(value).split('/').filter((part) => part && part !== '.' && part !== '..').map(sanitizeFileName)
  return parts.join('/') || 'file'
}

async function createZipBlob(entries: Array<{ blob: Blob; date: number; name: string }>) {
  const encoder = new TextEncoder()
  const chunks: BlobPart[] = []
  const centralChunks: Array<{ byteLength: number; part: BlobPart }> = []
  let offset = 0
  for (const entry of entries) {
    const arrayBuffer = await entry.blob.arrayBuffer()
    const size = arrayBuffer.byteLength
    if (size > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP 文件过大，当前浏览器端打包不支持超过 4GB')
    const nameBytes = encoder.encode(entry.name)
    const crc = crc32(arrayBuffer)
    const { date, time } = zipDosDateTime(entry.date)
    const localHeader = createZipLocalFileHeader({ crc, date, nameBytes, size, time })
    const centralHeader = createZipCentralDirectoryHeader({ crc, date, localHeaderOffset: offset, nameBytes, size, time })
    chunks.push(bytesToBlobPart(localHeader), bytesToBlobPart(nameBytes), arrayBuffer)
    centralChunks.push({ byteLength: centralHeader.byteLength, part: bytesToBlobPart(centralHeader) })
    centralChunks.push({ byteLength: nameBytes.byteLength, part: bytesToBlobPart(nameBytes) })
    offset += localHeader.byteLength + nameBytes.byteLength + size
  }
  const centralDirectoryOffset = offset
  const centralDirectorySize = centralChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  if (centralDirectoryOffset > 0xffffffff || centralDirectorySize > 0xffffffff) throw new Error('ZIP 文件过大，当前浏览器端打包不支持超过 4GB')
  const endRecord = createZipEndOfCentralDirectory({ centralDirectoryOffset, centralDirectorySize, entryCount: entries.length })
  return new Blob([...chunks, ...centralChunks.map((chunk) => chunk.part), bytesToBlobPart(endRecord)], { type: 'application/zip' })
}

function bytesToBlobPart(bytes: Uint8Array): BlobPart {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function createZipLocalFileHeader({ crc, date, nameBytes, size, time }: { crc: number; date: number; nameBytes: Uint8Array; size: number; time: number }) {
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

function createZipCentralDirectoryHeader({ crc, date, localHeaderOffset, nameBytes, size, time }: { crc: number; date: number; localHeaderOffset: number; nameBytes: Uint8Array; size: number; time: number }) {
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

function createZipEndOfCentralDirectory({ centralDirectoryOffset, centralDirectorySize, entryCount }: { centralDirectoryOffset: number; centralDirectorySize: number; entryCount: number }) {
  if (entryCount > 0xffff) throw new Error('ZIP 文件数量过多，当前浏览器端打包不支持超过 65535 个文件')
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

function zipDosDateTime(value: number) {
  const date = new Date(Number(value) || Date.now())
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  }
}

function getCrc32Table() {
  if (crc32Table) return crc32Table
  crc32Table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let j = 0; j < 8; j += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc32Table[i] = c >>> 0
  }
  return crc32Table
}

function crc32(arrayBuffer: ArrayBuffer) {
  const table = getCrc32Table()
  const bytes = new Uint8Array(arrayBuffer)
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) crc = table[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

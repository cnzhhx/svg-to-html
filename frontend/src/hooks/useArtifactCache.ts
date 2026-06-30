import { useCallback, useMemo, useState } from 'react'
import type { Session } from '../types/session'
import { sessionDownloadUrl } from '../api/sessions'
import {
  cacheSessionArtifacts as cacheSessionArtifactsToIdb,
  createCachedArtifactObjectUrl,
  createZipBlobForCachedSession,
  downloadBlob,
  getCachedArtifactFiles,
  getCachedArtifactSessionMeta,
} from '../utils/artifact-cache'
import { getSessionCompareEntryPath, getSessionRenderEntryPath, getSessionSourceEntryPath, workspaceFileUrl } from '../utils/artifacts'
import { formatBytes } from '../utils/format'
import type { ArtifactCacheMeta } from '../utils/artifact-cache'

export type ArtifactCacheStatus = {
  busy: boolean
  error: string | null
  meta?: ArtifactCacheMeta | null
}

const isCached = (meta?: ArtifactCacheMeta | null) => meta?.status === 'cached'

const openUrl = (url: string) => {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.target = '_blank'
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

const sanitizeFileName = (value: unknown) => {
  const text = String(value || 'file').replace(/[<>:"\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim()
  return text || 'file'
}

export function useArtifactCache(onSessionCached?: (session: Session, meta: ArtifactCacheMeta) => void) {
  const [busySessionIds, setBusySessionIds] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const [metaBySession, setMetaBySession] = useState<Map<string, ArtifactCacheMeta>>(() => new Map())

  const rememberMeta = useCallback((sessionId: string, meta: ArtifactCacheMeta) => {
    setMetaBySession((previous) => new Map(previous).set(sessionId, meta))
  }, [])

  const cacheSessionArtifacts = useCallback(async (session: Session | null) => {
    if (!session?.id) return
    setError(null)
    setBusySessionIds((previous) => new Set(previous).add(session.id))
    try {
      const meta = await cacheSessionArtifactsToIdb(session)
      rememberMeta(session.id, meta)
      onSessionCached?.(session, meta)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusySessionIds((previous) => {
        const next = new Set(previous)
        next.delete(session.id)
        return next
      })
    }
  }, [onSessionCached, rememberMeta])

  const openSessionArtifact = useCallback(async (session: Session | null, kind: 'compare' | 'render' | 'source') => {
    if (!session?.id) return
    const targetPath =
      kind === 'compare'
        ? getSessionCompareEntryPath(session)
        : kind === 'source'
          ? getSessionSourceEntryPath(session)
          : getSessionRenderEntryPath(session)
    if (!targetPath) {
      setError('没有可打开的文件')
      return
    }
    const meta = metaBySession.get(session.id) || await getCachedArtifactSessionMeta(session.id).catch(() => null)
    if (isCached(meta)) {
      try {
        const records = await getCachedArtifactFiles(session.id)
        if (records.length) {
          openUrl(await createCachedArtifactObjectUrl(targetPath, records))
          rememberMeta(session.id, meta!)
          return
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    }
    if (session.__localOnly) {
      setError('本地归档记录没有可打开的浏览器缓存文件')
      return
    }
    openUrl(workspaceFileUrl(targetPath, session))
  }, [metaBySession, rememberMeta])

  const downloadSessionZip = useCallback(async (session: Session | null) => {
    if (!session?.id) return
    const meta = metaBySession.get(session.id) || await getCachedArtifactSessionMeta(session.id).catch(() => null)
    if (isCached(meta)) {
      try {
        const records = await getCachedArtifactFiles(session.id)
        if (records.length) {
          const zip = await createZipBlobForCachedSession(session, records)
          downloadBlob(zip, `${sanitizeFileName(session.designName || session.id)}.zip`)
          setError(`本地 ZIP 已生成：${formatBytes(zip.size)}`)
          rememberMeta(session.id, meta!)
          return
        }
      } catch (caught) {
        if (session.__localOnly) {
          setError(caught instanceof Error ? caught.message : '本地 ZIP 打包失败')
          return
        }
      }
    }
    if (session.__localOnly) {
      setError('本地归档记录没有可下载的浏览器缓存 ZIP')
      return
    }
    window.location.href = sessionDownloadUrl(session.id)
  }, [metaBySession, rememberMeta])

  const statusFor = useCallback(
    (session?: Session | null): ArtifactCacheStatus => {
      const meta = session?.id ? metaBySession.get(session.id) : null
      if (session?.id && !meta) {
        void getCachedArtifactSessionMeta(session.id)
          .then((stored) => {
            if (!stored) return
            rememberMeta(session.id, stored)
          })
          .catch(() => {})
      }
      return {
        busy: Boolean(session?.id && busySessionIds.has(session.id)),
        error,
        meta,
      }
    },
    [busySessionIds, error, metaBySession, rememberMeta],
  )

  return useMemo(
    () => ({ cacheSessionArtifacts, downloadSessionZip, openSessionArtifact, statusFor }),
    [cacheSessionArtifacts, downloadSessionZip, openSessionArtifact, statusFor],
  )
}

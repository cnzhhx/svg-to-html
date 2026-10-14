import { useCallback, useMemo, useState } from 'react'
import type { Job } from '../types/job'
import { jobDownloadUrl } from '../api/jobs'
import {
  artifactCacheKeyForJob,
  cacheJobArtifacts as cacheJobArtifactsToIdb,
  createCachedArtifactObjectUrl,
  createZipBlobForCachedJob,
  downloadBlob,
  getCachedArtifactFiles,
  getCachedArtifactJobMeta,
} from '../utils/artifact-cache'
import { getJobCompareEntryPath, getJobRenderEntryPath, getJobSourceEntryPath, artifactFileUrl } from '../utils/artifacts'
import { formatBytes } from '../utils/format'
import { createIsolatedArtifactUrl } from '../utils/artifact-preview'
import type { ArtifactCacheMeta } from '../utils/artifact-cache'

export type ArtifactCacheStatus = {
  busy: boolean
  error: string | null
  meta?: ArtifactCacheMeta | null
}

const isCached = (meta?: ArtifactCacheMeta | null) => meta?.status === 'cached'
const isUsableCache = (job: Job, meta?: ArtifactCacheMeta | null) =>
  (job.__localOnly || job.accessMode === 'owner') && isCached(meta) && (job.__localOnly || meta?.cacheKey === artifactCacheKeyForJob(job))

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

export function useArtifactCache(onJobCached?: (job: Job, meta: ArtifactCacheMeta) => void) {
  const [busyJobIds, setBusyJobIds] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const [metaByJob, setMetaByJob] = useState<Map<string, ArtifactCacheMeta>>(() => new Map())

  const rememberMeta = useCallback((jobId: string, meta: ArtifactCacheMeta) => {
    setMetaByJob((previous) => new Map(previous).set(jobId, meta))
  }, [])

  const cacheJobArtifacts = useCallback(async (job: Job | null) => {
    if (!job?.id) return
    if (job.accessMode !== 'owner') return
    setError(null)
    setBusyJobIds((previous) => new Set(previous).add(job.id))
    try {
      const meta = await cacheJobArtifactsToIdb(job)
      rememberMeta(job.id, meta)
      onJobCached?.(job, meta)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyJobIds((previous) => {
        const next = new Set(previous)
        next.delete(job.id)
        return next
      })
    }
  }, [onJobCached, rememberMeta])

  const openJobArtifact = useCallback(async (job: Job | null, kind: 'compare' | 'render' | 'source') => {
    if (!job?.id) return
    const targetPath =
      kind === 'compare'
        ? getJobCompareEntryPath(job)
        : kind === 'source'
          ? getJobSourceEntryPath(job)
          : getJobRenderEntryPath(job)
    if (!targetPath) {
      setError('没有可打开的文件')
      return
    }
    const meta = metaByJob.get(job.id) || await getCachedArtifactJobMeta(job.id).catch(() => null)
    if (isUsableCache(job, meta)) {
      try {
        const records = await getCachedArtifactFiles(job.id)
        if (records.length) {
          openUrl(createIsolatedArtifactUrl(await createCachedArtifactObjectUrl(targetPath, records)))
          rememberMeta(job.id, meta!)
          return
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    }
    if (job.__localOnly) {
      setError('本地归档记录没有可打开的浏览器缓存文件')
      return
    }
    openUrl(artifactFileUrl(targetPath, job))
  }, [metaByJob, rememberMeta])

  const downloadJobZip = useCallback(async (job: Job | null) => {
    if (!job?.id) return
    const meta = metaByJob.get(job.id) || await getCachedArtifactJobMeta(job.id).catch(() => null)
    if (isUsableCache(job, meta)) {
      try {
        const records = await getCachedArtifactFiles(job.id)
        if (records.length) {
          const zip = await createZipBlobForCachedJob(job, records)
          downloadBlob(zip, `${sanitizeFileName(job.designName || job.id)}.zip`)
          setError(`本地 ZIP 已生成：${formatBytes(zip.size)}`)
          rememberMeta(job.id, meta!)
          return
        }
      } catch (caught) {
        if (job.__localOnly) {
          setError(caught instanceof Error ? caught.message : '本地 ZIP 打包失败')
          return
        }
      }
    }
    if (job.__localOnly) {
      setError('本地归档记录没有可下载的浏览器缓存 ZIP')
      return
    }
    window.location.href = jobDownloadUrl(job.id)
  }, [metaByJob, rememberMeta])

  const statusFor = useCallback(
    (job?: Job | null): ArtifactCacheStatus => {
      const meta = job?.id ? metaByJob.get(job.id) : null
      if (job?.id && !meta) {
        void getCachedArtifactJobMeta(job.id)
          .then((stored) => {
            if (!stored) return
            rememberMeta(job.id, stored)
          })
          .catch(() => {})
      }
      return {
        busy: Boolean(job?.id && busyJobIds.has(job.id)),
        error,
        meta,
      }
    },
    [busyJobIds, error, metaByJob, rememberMeta],
  )

  return useMemo(
    () => ({ cacheJobArtifacts, downloadJobZip, openJobArtifact, statusFor }),
    [cacheJobArtifacts, downloadJobZip, openJobArtifact, statusFor],
  )
}

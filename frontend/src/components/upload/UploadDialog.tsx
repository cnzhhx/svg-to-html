import { useEffect, useMemo, useState } from 'react'
import { uploadSvg } from '../../api/job-upload'
import type { UploadProgress, UploadResponse } from '../../api/job-upload'
import { ApiError } from '../../api/http'
import type { UploadQuota } from '../../types/runtime'
import type { OutputFormat } from '../../types/job'
import { labelForOutputFormat } from '../../utils/format'
import { STORAGE_KEYS, readNumberStorage, readStringStorage, writeStringStorage } from '../../utils/storage'

const DEFAULT_OUTPUT_FORMATS: OutputFormat[] = ['html', 'vue', 'react']

export function UploadDialog({
  adminMode,
  quotaEnabled,
  allowUserShowcase,
  onClose,
  initialFile,
  modelOptions,
  outputFormats = DEFAULT_OUTPUT_FORMATS,
  maxSvgUploadBytes,
  onUploaded,
  onQuotaChanged,
  open,
  uploadQuota,
}: {
  adminMode: boolean
  quotaEnabled: boolean
  allowUserShowcase: boolean
  onClose: () => void
  initialFile: File | null
  modelOptions: string[]
  outputFormats?: OutputFormat[]
  maxSvgUploadBytes: number
  onUploaded: (response: UploadResponse) => void
  onQuotaChanged: (quota: UploadQuota) => void
  open: boolean
  uploadQuota: UploadQuota | null
}) {
  const [file, setFile] = useState<File | null>(null)
  const [format, setFormat] = useState(readStringStorage(STORAGE_KEYS.uploadFormat, 'html') || 'html')
  const [model, setModel] = useState(readStringStorage(STORAGE_KEYS.uploadModel, ''))
  const [scale, setScale] = useState(() => (readNumberStorage(STORAGE_KEYS.uploadScale, 1) === 2 ? 2 : 1))
  const [showcase, setShowcase] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null)
  const maxSvgUploadLabel = `${Math.round(maxSvgUploadBytes / 1024 / 1024)} MB`
  const selectedFormat = outputFormats.find(item => item === format) || outputFormats[0]

  const selectFile = (nextFile: File | null) => {
    if (nextFile && nextFile.size > maxSvgUploadBytes) {
      setFile(null)
      setError(`SVG 文件不能超过 ${maxSvgUploadLabel}`)
      return
    }
    setFile(nextFile)
    setError(null)
  }

  useEffect(() => {
    if (selectedFormat) writeStringStorage(STORAGE_KEYS.uploadFormat, selectedFormat)
  }, [selectedFormat])

  useEffect(() => {
    writeStringStorage(STORAGE_KEYS.uploadModel, model)
  }, [model])

  useEffect(() => {
    const firstModel = modelOptions[0] || ''
    if (modelOptions.length > 0 && (!model || !modelOptions.includes(model))) {
      setModel(firstModel)
    }
  }, [model, modelOptions])

  useEffect(() => {
    writeStringStorage(STORAGE_KEYS.uploadScale, String(scale))
  }, [scale])

  useEffect(() => {
    if (!open) return
    setShowcase(false)
    setError(null)
    if (initialFile) selectFile(initialFile)
  }, [initialFile, open])

  const quotaAvailable = adminMode || !quotaEnabled || Number(uploadQuota?.remaining ?? 0) > 0
  const canSubmit = useMemo(
    () => Boolean(file && selectedFormat && !busy && quotaAvailable),
    [busy, file, quotaAvailable, selectedFormat],
  )
  if (!open) return null

  const submit = async () => {
    if (!file || !selectedFormat) return
    if (file.size > maxSvgUploadBytes) {
      setError(`SVG 文件不能超过 ${maxSvgUploadLabel}`)
      return
    }
    setBusy(true)
    setError(null)
    setUploadProgress({ loaded: 0, percent: 0, phase: 'uploading', total: file.size })
    try {
      const response = await uploadSvg(file, {
        model: model.trim(),
        outputFormat: selectedFormat,
        scale,
        showcase: (adminMode || allowUserShowcase) && showcase,
      }, setUploadProgress)
      onUploaded(response)
      setFile(null)
      onClose()
    } catch (caught) {
      const quota = caught instanceof ApiError ? caught.payload.quota : null
      if (quota && typeof quota === 'object') onQuotaChanged(quota as UploadQuota)
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
      setUploadProgress(null)
    }
  }

  return (
    <div className="dialog-backdrop">
      <div className="upload-dialog open" role="dialog" aria-modal="true">
        <div className="upload-dialog-content">
          <h3 className="upload-dialog-title">上传设计稿</h3>
          <div className="upload-dialog-field">
            <label className="upload-dialog-label" htmlFor="uploadScaleSelect">渲染预览倍率</label>
            <select className="upload-dialog-select" disabled={busy} id="uploadScaleSelect" value={scale} onChange={(event) => setScale(Number(event.target.value))}>
              <option value={1}>1x — 按设计稿原始像素产出</option>
              <option value={2}>2x — 按设计稿 2x 像素产出</option>
            </select>
          </div>
          <div className="upload-dialog-field">
            <span className="upload-dialog-label">源码格式</span>
            <div className="upload-format-options">
              {outputFormats.map((item) => (
                <label className="upload-format-option" key={item}>
                  <input checked={selectedFormat === item} disabled={busy} name="uploadFormat" onChange={() => setFormat(item)} type="radio" value={item} />
                  <span>{labelForOutputFormat(item)}</span>
                </label>
              ))}
            </div>
            {selectedFormat === 'flutter' ? <div className="upload-dialog-hint">Flutter 提供源码和效果截图，完整应用请下载 ZIP 后运行。</div> : null}
          </div>
          <div className="upload-dialog-field">
            <label className="upload-dialog-label" htmlFor="uploadModelSelect">模型配置 ID</label>
            <select
              className="upload-dialog-select"
              disabled={busy}
              id="uploadModelSelect"
              onChange={(event) => setModel(event.target.value)}
              value={model}
            >
              {modelOptions.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </div>
          <div className="upload-dialog-field">
            <label className="upload-dialog-label">选择文件</label>
            <label className={`upload-dialog-file${file ? ' has-file' : ''}${busy ? ' is-disabled' : ''}`}>
              <input accept=".svg" disabled={busy} onChange={(event) => selectFile(event.target.files?.[0] || null)} type="file" />
              <span>{file?.name || '点击选择 SVG 文件'}</span>
            </label>
            <div className="upload-dialog-hint">
              {adminMode
                ? `单个 SVG 不超过 ${maxSvgUploadLabel} · 管理员上传不限次数`
                : quotaEnabled ? `单个 SVG 不超过 ${maxSvgUploadLabel} · 今日剩余 ${uploadQuota?.remaining ?? 0} / ${uploadQuota?.limit ?? 5} 次`
                  : `单个 SVG 不超过 ${maxSvgUploadLabel} · 不限上传次数`}
            </div>
          </div>
          {(adminMode || allowUserShowcase) && <div className="upload-dialog-field">
            <label className="upload-dialog-check">
              <input checked={showcase} disabled={busy} onChange={(event) => setShowcase(event.target.checked)} type="checkbox" />
              <span>加入公开示例</span>
            </label>
          </div>}
          {busy && uploadProgress ? (
            <div className="upload-progress" aria-live="polite" role="status">
              <div className="upload-progress-heading">
                <span>{uploadProgress.phase === 'uploading' ? '正在上传 SVG' : '上传完成，正在创建任务'}</span>
                <strong>{uploadProgress.percent}%</strong>
              </div>
              <div className="upload-progress-track" aria-hidden="true">
                <span style={{ width: `${uploadProgress.percent}%` }} />
              </div>
              <div className="upload-progress-detail">
                {uploadProgress.phase === 'uploading' ? '请保持当前页面打开' : '服务器正在保存文件并加入队列'}
              </div>
            </div>
          ) : null}
          {error ? <div className="url-error">{error}</div> : null}
          <div className="upload-dialog-actions">
            <button className="upload-dialog-cancel" disabled={busy} onClick={onClose} type="button">取消</button>
            <button className="upload-dialog-submit" disabled={!canSubmit} onClick={submit} type="button">
              {busy ? (uploadProgress?.phase === 'processing' ? '处理中…' : `上传 ${uploadProgress?.percent ?? 0}%`) : '上传'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

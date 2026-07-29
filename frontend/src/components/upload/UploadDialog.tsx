import { useEffect, useMemo, useState } from 'react'
import { uploadSvg } from '../../api/job-upload'
import type { UploadResponse } from '../../api/job-upload'
import { STORAGE_KEYS, readNumberStorage, readStringStorage, writeStringStorage } from '../../utils/storage'

export function UploadDialog({
  onClose,
  initialFile,
  modelOptions,
  onUploaded,
  open,
}: {
  onClose: () => void
  initialFile: File | null
  modelOptions: string[]
  onUploaded: (response: UploadResponse) => void
  open: boolean
}) {
  const [file, setFile] = useState<File | null>(null)
  const [format, setFormat] = useState(readStringStorage(STORAGE_KEYS.uploadFormat, 'html') || 'html')
  const [model, setModel] = useState(readStringStorage(STORAGE_KEYS.uploadModel, ''))
  const [scale, setScale] = useState(() => (readNumberStorage(STORAGE_KEYS.uploadScale, 1) === 2 ? 2 : 1))
  const [jobCountInput, setJobCountInput] = useState('1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    writeStringStorage(STORAGE_KEYS.uploadFormat, format)
  }, [format])

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
    if (open && initialFile) setFile(initialFile)
  }, [initialFile, open])

  const canSubmit = useMemo(() => Boolean(file && !busy), [busy, file])
  if (!open) return null

  const submit = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const parsedJobCount = Number(jobCountInput)
      const jobCount = Number.isFinite(parsedJobCount) && parsedJobCount > 0
        ? Math.max(1, Math.min(20, Math.floor(parsedJobCount)))
        : 1
      const response = await uploadSvg(file, {
        model: model.trim(),
        outputFormat: format,
        scale,
        jobCount,
      })
      onUploaded(response)
      setFile(null)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop">
      <div className="upload-dialog open" role="dialog" aria-modal="true">
        <div className="upload-dialog-content">
          <h3 className="upload-dialog-title">上传设计稿</h3>
          <div className="upload-dialog-field">
            <label className="upload-dialog-label" htmlFor="uploadScaleSelect">渲染预览倍率</label>
            <select className="upload-dialog-select" id="uploadScaleSelect" value={scale} onChange={(event) => setScale(Number(event.target.value))}>
              <option value={1}>1x — 按设计稿原始像素产出</option>
              <option value={2}>2x — 按设计稿 2x 像素产出</option>
            </select>
          </div>
          <div className="upload-dialog-field">
            <span className="upload-dialog-label">源码格式</span>
            <div className="upload-format-options">
              {['html', 'vue', 'react'].map((item) => (
                <label className="upload-format-option" key={item}>
                  <input checked={format === item} name="uploadFormat" onChange={() => setFormat(item)} type="radio" value={item} />
                  <span>{item === 'html' ? 'HTML' : item === 'vue' ? 'Vue' : 'React'}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="upload-dialog-field">
            <label className="upload-dialog-label" htmlFor="uploadModelSelect">模型配置 ID</label>
            <select
              className="upload-dialog-select"
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
            <label className="upload-dialog-label" htmlFor="uploadJobCount">并发 Job 数</label>
            <input
              className="upload-dialog-input"
              id="uploadJobCount"
              max={20}
              min={1}
              onChange={(event) => setJobCountInput(event.target.value)}
              type="number"
              value={jobCountInput}
            />
          </div>
          <div className="upload-dialog-field">
            <label className="upload-dialog-label">选择文件</label>
            <label className={`upload-dialog-file${file ? ' has-file' : ''}`}>
              <input accept=".svg" onChange={(event) => setFile(event.target.files?.[0] || null)} type="file" />
              <span>{file?.name || '点击选择 SVG 文件'}</span>
            </label>
          </div>
          {error ? <div className="url-error">{error}</div> : null}
          <div className="upload-dialog-actions">
            <button className="upload-dialog-cancel" onClick={onClose} type="button">取消</button>
            <button className="upload-dialog-submit" disabled={!canSubmit} onClick={submit} type="button">{busy ? '上传中…' : '上传'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { uploadSvg } from '../../api/upload'
import type { UploadResponse } from '../../api/upload'
import { getRunSettingsPayload } from '../../utils/settings'
import { STORAGE_KEYS, readNumberStorage, readStringStorage, writeStringStorage } from '../../utils/storage'

export function UploadDialog({
  onClose,
  initialFile,
  onUploaded,
  open,
}: {
  onClose: () => void
  initialFile: File | null
  onUploaded: (response: UploadResponse) => void
  open: boolean
}) {
  const [file, setFile] = useState<File | null>(null)
  const [format, setFormat] = useState(readStringStorage(STORAGE_KEYS.uploadFormat, 'html') || 'html')
  const [scale, setScale] = useState(readNumberStorage(STORAGE_KEYS.uploadScale, 1))
  const [sessionCountInput, setSessionCountInput] = useState('1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    writeStringStorage(STORAGE_KEYS.uploadFormat, format)
  }, [format])

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
      const parsedSessionCount = Number(sessionCountInput)
      const sessionCount = Number.isFinite(parsedSessionCount) && parsedSessionCount > 0
        ? Math.max(1, Math.min(20, Math.floor(parsedSessionCount)))
        : 1
      const response = await uploadSvg(file, {
        outputFormat: format,
        scale,
        sessionCount,
        settings: getRunSettingsPayload(),
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
            <label className="upload-dialog-label" htmlFor="uploadSessionCount">并发 Session 数</label>
            <input
              className="upload-dialog-input"
              id="uploadSessionCount"
              max={20}
              min={1}
              onChange={(event) => setSessionCountInput(event.target.value)}
              type="number"
              value={sessionCountInput}
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

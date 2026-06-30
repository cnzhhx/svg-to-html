export function Lightbox({ src, onClose }: { src: string | null; onClose: () => void }) {
  if (!src) return null
  return (
    <div className="lightbox" onClick={onClose} role="presentation">
      <img src={src} alt="" />
    </div>
  )
}

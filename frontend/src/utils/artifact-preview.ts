// A blob URL otherwise inherits the application's origin. Only this fixed
// wrapper may open as a top-level page; untrusted cached content stays inside a
// script-disabled iframe. CSP also applies to blob documents nested in the frame.
export function createIsolatedArtifactUrl(artifactUrl: string) {
  if (!artifactUrl.startsWith('blob:')) throw new Error('Expected a cached artifact URL')
  const escaped = artifactUrl.replace(/[&"<>]/g, char => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[char]!)
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="script-src 'none'; connect-src 'none'; form-action 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'">
<title>Artifact preview</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}iframe{display:block}</style>
</head><body><iframe title="Artifact preview" sandbox="allow-same-origin" referrerpolicy="no-referrer" src="${escaped}"></iframe></body></html>`
  return URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
}

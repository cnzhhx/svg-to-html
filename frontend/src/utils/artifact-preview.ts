// Keep cached documents in a fixed wrapper while allowing bundled framework
// scripts. Blob previews share the application's origin; this is not an origin
// isolation boundary. CSP also applies to nested blob documents.
export function createIsolatedArtifactUrl(artifactUrl: string) {
  if (!artifactUrl.startsWith('blob:')) throw new Error('Expected a cached artifact URL')
  const escaped = artifactUrl.replace(/[&"<>]/g, char => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[char]!)
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' blob:; connect-src 'none'; form-action 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'">
<title>Artifact preview</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}iframe{display:block}</style>
</head><body><iframe title="Artifact preview" sandbox="allow-same-origin allow-scripts" referrerpolicy="no-referrer" src="${escaped}"></iframe></body></html>`
  return URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
}

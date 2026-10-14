#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function isSourceFile(file) {
  const parts = file.split('/')
  if (path.isAbsolute(file) || parts.some(p => !p || p === '.' || p === '..')) return false
  if (parts.some(p => ['.git', 'node_modules', 'workspace', 'docs', '.runtime', '.runtime-traces', 'dist', 'coverage'].includes(p))) return false
  if (parts.some(p => p === '.DS_Store' || p.startsWith('._') || (p.startsWith('.env') && p !== '.env.example'))) return false
  if (/(^|\/)model-provider\.json$|\.state$|\.log$/.test(file)) return false
  if (parts.some(p => /^(gateway-state|access-state|queue-settings)\.json(?:\.|$)/.test(p))) return false
  return !file.startsWith('frontend/public/') && !['LOCAL_ADMIN.md', '.toc-deploy-manifest.json'].includes(file)
}

export const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'"

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error?.message})`)
  return result.stdout
}

export function createSnapshot(root, destination) {
  const listed = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  const candidates = [...new Set(listed.split('\0').filter(p => p && isSourceFile(p)))]
  const files = []
  for (const file of candidates) {
    const source = path.join(root, file)
    if (!fs.existsSync(source)) continue // Include uncommitted deletions in the release.
    const stat = fs.lstatSync(source)
    if (!stat.isFile()) throw new Error(`Only regular source files can be published: ${file}`)
    const target = path.join(destination, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
    fs.chmodSync(target, stat.mode & 0o777)
    files.push({ path: file, sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex') })
  }
  const roots = [...new Set(candidates.map(p => p.split('/')[0]))].sort()
  for (const required of ['package.json', 'pnpm-lock.yaml', 'backend/package.json', 'frontend/package.json', 'scripts/publish-remote.mjs']) {
    if (!files.some(f => f.path === required)) throw new Error(`Missing release file: ${required}`)
  }
  const manifest = { roots, files }
  fs.writeFileSync(path.join(destination, '.toc-deploy-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: pnpm publish:app (alias: pnpm publish:toc)\nPublishes the current working copy over SSH, including uncommitted files.\nRequired environment: TOC_DEPLOY_HOST, TOC_DEPLOY_DIR, TOC_DEPLOY_URL.\nRequires SSH key authentication and passwordless sudo on the server.')
    return
  }
  if (process.argv.length > 2) throw new Error('Unknown argument; use --help')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const host = process.env.TOC_DEPLOY_HOST
  const project = process.env.TOC_DEPLOY_DIR
  const publicUrl = process.env.TOC_DEPLOY_URL
  if (!host || !project || !publicUrl) throw new Error('Set TOC_DEPLOY_HOST, TOC_DEPLOY_DIR and TOC_DEPLOY_URL before publishing')
  if (!/^[\w.-]+@[\w.-]+$/.test(host)) throw new Error('Invalid TOC_DEPLOY_HOST; expected user@host')
  if (!/^\/[\w./-]+$/.test(project) || path.resolve(project) !== project || project.split('/').length < 4) throw new Error('Invalid deployment directory')
  if (!/^https?:$/.test(new URL(publicUrl).protocol)) throw new Error('Invalid public URL')
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'toc-publish-'))
  const manifest = createSnapshot(root, snapshot)
  console.log(`[publish] Snapshot: ${snapshot} (${manifest.files.length} source files)`)
  const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', host]
  const capture = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  run('ssh', [...ssh, 'sudo -n true'])
  const release = run('ssh', [...ssh, `mktemp -d ${shellQuote(path.join(path.dirname(project), '.toc-release-XXXXXXXX'))}`], capture).trim()
  if (path.dirname(release) !== path.dirname(project) || !path.basename(release).startsWith('.toc-release-')) throw new Error('Unexpected remote staging path')
  run('rsync', ['-az', '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=12', snapshot + '/', `${host}:${release}/`])
  const command = ['node', path.join(release, 'scripts/publish-remote.mjs'), project, release, publicUrl].map(shellQuote).join(' ')
  run('ssh', [...ssh, command])
  console.log(`[publish] Complete: ${publicUrl}/`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[publish] ${error.message}`); process.exitCode = 1 })
}

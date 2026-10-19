#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isSourceFile } from './publish.mjs'

function run(command, args, { cwd, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, env: { ...process.env, CI: 'true' },
    stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'], encoding: 'utf8',
  })
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0]} failed (${result.status ?? result.error?.message})`)
  return result.stdout?.trim()
}

// Move only manifest-owned code entries. Runtime directories and Git stay in place.
export function swapRelease(project, release, backup, roots, moves = []) {
  for (const name of roots) {
    if (name.includes('/') || !isSourceFile(name) || ['backend', 'frontend'].includes(name) && !fs.existsSync(path.join(release, name))) throw new Error(`Invalid release root: ${name}`)
    const live = path.join(project, name)
    const next = path.join(release, name)
    const saved = path.join(backup, name)
    const move = { name, old: false, next: false }
    moves.push(move)
    if (fs.existsSync(live)) { fs.renameSync(live, saved); move.old = true }
    if (fs.existsSync(next)) { fs.renameSync(next, live); move.next = true }
  }
  return moves
}

export function restoreRelease(project, release, backup, moves) {
  for (const move of [...moves].reverse()) {
    if (move.next) fs.renameSync(path.join(project, move.name), path.join(release, move.name))
    if (move.old) fs.renameSync(path.join(backup, move.name), path.join(project, move.name))
  }
}

export function preservePrivateFiles(project, release) {
  for (const dir of ['backend', 'frontend', '.local']) {
    const existing = path.join(project, dir)
    if (!fs.existsSync(existing)) continue
    for (const name of fs.readdirSync(existing)) {
      if ((name.startsWith('.env') && name !== '.env.example') || (dir === '.local' && name.endsWith('.state'))) {
        const target = path.join(release, dir, name)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.cpSync(path.join(existing, name), target, { preserveTimestamps: true })
      }
    }
  }
  const model = 'backend/config/model-provider.json'
  if (fs.existsSync(path.join(project, model))) {
    fs.mkdirSync(path.dirname(path.join(release, model)), { recursive: true })
    fs.copyFileSync(path.join(project, model), path.join(release, model))
    fs.chmodSync(path.join(release, model), fs.statSync(path.join(project, model)).mode & 0o777)
  }
}

async function health(url) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(url + '/health', { signal: AbortSignal.timeout(2000) })
      if (response.ok && (await response.text()).trim() === 'ok') return
    } catch { /* Wait for the gateway to listen. */ }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`Health check failed: ${url}`)
}

async function main() {
  const [project, release, publicUrl] = process.argv.slice(2)
  if (!project || !release || !publicUrl || path.resolve(project) !== project || path.dirname(project) !== path.dirname(release) || !path.basename(release).startsWith('.toc-release-')) throw new Error('Invalid deployment paths')
  if (fs.realpathSync(project) !== project || fs.realpathSync(release) !== release) throw new Error('Deployment directories must not be symlinks')
  const workingDirectory = run('sudo', ['-n', 'systemctl', 'show', 'svg-to-html', '-p', 'WorkingDirectory', '--value'], { capture: true })
  if (workingDirectory !== path.join(project, 'backend')) throw new Error('Service does not belong to the requested project')
  const lock = path.join(path.dirname(project), '.toc-publish.lock')
  fs.mkdirSync(lock, { mode: 0o700 })
  let stopped = false
  const moves = []
  let backup
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(release, '.toc-deploy-manifest.json'), 'utf8'))
    for (const file of manifest.files) {
      if (!isSourceFile(file.path) || !fs.lstatSync(path.join(release, file.path)).isFile()) throw new Error('Invalid source manifest')
      const digest = createHash('sha256').update(fs.readFileSync(path.join(release, file.path))).digest('hex')
      if (digest !== file.sha256) throw new Error(`Upload checksum mismatch: ${file.path}`)
    }
    console.log(`[publish] Verified ${manifest.files.length} uploaded files; installing and testing in staging`)
    run('pnpm', ['install', '--frozen-lockfile'], { cwd: release })
    const scripts = JSON.parse(fs.readFileSync(path.join(release, 'package.json'))).scripts
    for (const name of scripts.verify ? ['verify'] : ['check', 'lint:frontend', 'test', 'build']) {
      if (scripts[name]) run('pnpm', ['run', name], { cwd: release })
    }
    if (!fs.existsSync(path.join(release, 'frontend/public/index.html'))) throw new Error('Missing frontend build')
    const jobsResponse = await fetch('http://127.0.0.1:4310/api/jobs', { signal: AbortSignal.timeout(10000) })
    if (!jobsResponse.ok) throw new Error('Cannot check active jobs')
    const jobsPayload = await jobsResponse.json()
    const jobs = Array.isArray(jobsPayload) ? jobsPayload : jobsPayload.jobs
    if (!Array.isArray(jobs)) throw new Error('Unexpected job list')
    if (jobs.some(j => !['completed', 'failed', 'cancelled', 'best-effort', 'failed-gate'].includes(j.status))) throw new Error('Active jobs exist; publish after they finish')
    const oldRuntime = await (await fetch(publicUrl + '/api/runtime', { signal: AbortSignal.timeout(10000) })).json()
    preservePrivateFiles(project, release)
    const roots = [...new Set([...manifest.roots, 'node_modules'])].sort()
    // Dependencies are generated on Linux, never uploaded from the developer machine.
    const codeRoots = roots.filter(name => name !== 'node_modules')
    for (const name of codeRoots) if (name.includes('/') || !isSourceFile(name)) throw new Error(`Unsafe deployment entry: ${name}`)
    const backupParent = path.join(path.dirname(project), 'svg-to-html-backups')
    fs.mkdirSync(backupParent, { recursive: true, mode: 0o700 })
    backup = fs.mkdtempSync(path.join(backupParent, 'publish-'))
    fs.writeFileSync(path.join(backup, 'deployment.json'), JSON.stringify({ project, release, roots, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
    const codeBackup = path.join(backup, 'code')
    fs.mkdirSync(codeBackup, { mode: 0o700 })
    console.log(`[publish] Switching code; previous version: ${codeBackup}`)
    run('sudo', ['-n', 'systemctl', 'stop', 'svg-to-html'])
    stopped = true
    swapRelease(project, release, codeBackup, codeRoots, moves)
    // The node_modules root is handled explicitly, outside the source allowlist.
    const dependencyMove = { name: 'node_modules', old: false, next: false }
    moves.push(dependencyMove)
    if (fs.existsSync(path.join(project, 'node_modules'))) { fs.renameSync(path.join(project, 'node_modules'), path.join(codeBackup, 'node_modules')); dependencyMove.old = true }
    fs.renameSync(path.join(release, 'node_modules'), path.join(project, 'node_modules'))
    dependencyMove.next = true
    // Refresh pnpm launchers for their final absolute location, without network access.
    run('pnpm', ['install', '--offline', '--frozen-lockfile'], { cwd: project })
    run('sudo', ['-n', 'systemctl', 'restart', 'svg-to-html'])
    await health(publicUrl)
    const runtime = await (await fetch(publicUrl + '/api/runtime', { signal: AbortSignal.timeout(10000) })).json()
    if (JSON.stringify(runtime.modelOptions) !== JSON.stringify(oldRuntime.modelOptions)) throw new Error('Model configuration changed unexpectedly')
    const htmlResponse = await fetch(publicUrl + '/', { signal: AbortSignal.timeout(10000) })
    if (!htmlResponse.ok) throw new Error('Public page unavailable')
    const html = await htmlResponse.text()
    const assets = [...html.matchAll(/(?:src|href)="([^"\s]+\.(?:js|css))"/g)].map(m => m[1])
    if (assets.length < 2) throw new Error('Missing public JS/CSS')
    for (const asset of assets) {
      const response = await fetch(new URL(asset, publicUrl), { signal: AbortSignal.timeout(10000) })
      const local = path.join(project, 'frontend/public', path.basename(path.dirname(asset)), path.basename(asset))
      if (!response.ok || !Buffer.from(await response.arrayBuffer()).equals(fs.readFileSync(local))) throw new Error(`Public build mismatch: ${asset}`)
    }
    fs.writeFileSync(path.join(backup, 'moves.json'), JSON.stringify(moves), { mode: 0o600 })
    stopped = false
    console.log(`[publish] Healthy. Models preserved: ${runtime.modelOptions.join(', ')}. Backup: ${backup}`)
  } catch (error) {
    if (stopped) {
      console.error('[publish] Activation failed; restoring previous code and dependencies')
      run('sudo', ['-n', 'systemctl', 'stop', 'svg-to-html'])
      restoreRelease(project, release, path.join(backup, 'code'), moves)
      run('sudo', ['-n', 'systemctl', 'start', 'svg-to-html'])
      await health(publicUrl)
      console.error('[publish] Previous version restored and healthy')
    }
    throw error
  } finally {
    fs.rmdirSync(lock)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[publish] ${error.message}`); process.exitCode = 1 })
}

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { isSourceFile, createSnapshot, shellQuote } from '../publish.mjs'
import { swapRelease, restoreRelease, preservePrivateFiles } from '../publish-remote.mjs'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toc-publish-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function write(root, name, content) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
  fs.writeFileSync(path.join(root, name), content)
}

test('credential and runtime paths are never published, even if tracked', () => {
  for (const file of ['queue-settings.json', 'backend/queue-settings.json', 'queue-settings.json.pending.tmp']) assert.equal(isSourceFile(file), false, file)
  for (const file of ['.', '.env', '.env.production', '.env.deploy', 'backend/.env', 'backend/config/model-provider.json', '.local/core-mode.state', 'workspace/jobs/a.json', 'node_modules/a.js', '.git/config', 'frontend/public/assets/a.js', '../secret', '/tmp/secret', '._.env', 'gateway-state.json', 'backend/access-state.json', 'gateway-state.json.lock']) assert.equal(isSourceFile(file), false, file)
  for (const file of ['.env.example', 'backend/config/model-provider.example.json', '.github/workflows/ci.yml', 'frontend/src/App.tsx']) assert.equal(isSourceFile(file), true, file)
})

test('snapshot captures uncommitted content, new files and deleted roots without credentials', t => {
  const root = fixture(t)
  const snapshot = fixture(t)
  for (const file of ['package.json', 'pnpm-lock.yaml', 'backend/package.json', 'frontend/package.json', 'scripts/publish-remote.mjs', 'removed.ts', '.env', 'backend/config/model-provider.json']) write(root, file, 'before')
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0)
  assert.equal(spawnSync('git', ['add', '.'], { cwd: root }).status, 0)
  write(root, 'package.json', 'uncommitted')
  write(root, 'new.ts', 'new file')
  fs.unlinkSync(path.join(root, 'removed.ts'))
  const manifest = createSnapshot(root, snapshot)
  assert.equal(fs.readFileSync(path.join(snapshot, 'package.json'), 'utf8'), 'uncommitted')
  assert.ok(manifest.files.some(f => f.path === 'new.ts'))
  assert.ok(manifest.roots.includes('removed.ts'))
  assert.ok(!manifest.files.some(f => f.path === 'removed.ts' || f.path === '.env' || f.path.endsWith('/model-provider.json')))
})

test('source symlinks cannot copy secrets outside the repository', t => {
  const root = fixture(t)
  const snapshot = fixture(t)
  write(root, '.env', 'private')
  fs.symlinkSync('.env', path.join(root, 'leak.txt'))
  spawnSync('git', ['init', '-q', root])
  assert.throws(() => createSnapshot(root, snapshot), /regular source files/)
})

test('code swap removes obsolete entries and rollback restores exact old directories', t => {
  const project = fixture(t), release = fixture(t), backup = fixture(t)
  write(project, 'frontend/src/old.ts', 'old')
  write(project, 'obsolete.json', 'keep in backup')
  write(project, 'workspace/jobs/job.json', 'job data')
  write(project, 'workspace/gateway/gateway-state.json', 'settings and admin credentials')
  write(project, 'workspace/gateway/access-state.json', 'ownership and quota')
  write(project, '.env', 'private')
  write(release, 'frontend/src/new.ts', 'new')
  write(release, 'added.json', 'new root')
  const moves = swapRelease(project, release, backup, ['frontend', 'obsolete.json', 'added.json'])
  assert.equal(fs.existsSync(path.join(project, 'frontend/src/old.ts')), false)
  assert.equal(fs.existsSync(path.join(project, 'obsolete.json')), false)
  assert.equal(fs.readFileSync(path.join(project, 'workspace/jobs/job.json'), 'utf8'), 'job data')
  assert.equal(fs.readFileSync(path.join(project, 'workspace/gateway/gateway-state.json'), 'utf8'), 'settings and admin credentials')
  assert.equal(fs.readFileSync(path.join(project, 'workspace/gateway/access-state.json'), 'utf8'), 'ownership and quota')
  assert.equal(fs.readFileSync(path.join(project, '.env'), 'utf8'), 'private')
  restoreRelease(project, release, backup, moves)
  assert.equal(fs.readFileSync(path.join(project, 'frontend/src/old.ts'), 'utf8'), 'old')
  assert.equal(fs.readFileSync(path.join(project, 'obsolete.json'), 'utf8'), 'keep in backup')
  assert.equal(fs.existsSync(path.join(project, 'added.json')), false)
})

test('partial activation can roll back after a later root is rejected', t => {
  const project = fixture(t), release = fixture(t), backup = fixture(t)
  write(project, 'frontend/a', 'old')
  write(release, 'frontend/a', 'new')
  const moves = []
  assert.throws(() => swapRelease(project, release, backup, ['frontend', '../outside'], moves), /Invalid release root/)
  restoreRelease(project, release, backup, moves)
  assert.equal(fs.readFileSync(path.join(project, 'frontend/a'), 'utf8'), 'old')
})

test('SSH arguments retain literal shell metacharacters', () => {
  const value = "spaces ' quote $HOME `pwd` $(id)"
  const result = spawnSync('sh', ['-c', 'printf %s ' + shellQuote(value)], { encoding: 'utf8' })
  assert.equal(result.stdout, value)
})

test('release preparation retains private model and environment files', t => {
  const project = fixture(t), release = fixture(t)
  write(project, 'backend/config/model-provider.json', 'private-model')
  write(project, 'backend/.env', 'private-environment')
  write(project, '.local/core-mode.state', 'private-local-state')
  write(release, 'backend/src/new.ts', 'new-code')
  preservePrivateFiles(project, release)
  for (const file of ['backend/config/model-provider.json', 'backend/.env', '.local/core-mode.state']) {
    assert.equal(fs.readFileSync(path.join(project, file), 'utf8'), fs.readFileSync(path.join(release, file), 'utf8'))
  }
})

test('publishing requires an explicit target before any SSH side effects', () => {
  const result = spawnSync(process.execPath, ['scripts/publish.mjs'], {
    encoding: 'utf8', env: { ...process.env, TOC_DEPLOY_HOST: '', TOC_DEPLOY_DIR: '', TOC_DEPLOY_URL: '' },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Set TOC_DEPLOY_HOST/)
})

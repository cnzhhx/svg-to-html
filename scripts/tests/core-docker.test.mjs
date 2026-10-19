import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const script = fileURLToPath(new URL('../core-docker.sh', import.meta.url))
const image = 'ghcr.io/cnzhhx/svg-transform-core:0.2.2'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-docker-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  const log = path.join(root, 'docker.jsonl')
  const model = path.join(root, 'model.json')
  fs.writeFileSync(model, '{"models":{}}')
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'container' && args[1] === 'inspect') process.exit(process.env.MOCK_CONTAINER_EXISTS === '1' ? 0 : 1);
if (args[0] === 'inspect') {
  const format = args[2];
  if (format.includes('.State.Running')) console.log('true');
  if (format.includes('.Config.Image')) console.log('ghcr.io/cnzhhx/svg-transform-core:0.2.1');
}
if (args[0] === 'run' && args.includes('--rm') && process.env.MOCK_RUNTIME_ACCESS === '0') process.exit(1);
`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return (command, extra = {}) => {
    const result = spawnSync('bash', [script, command], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ENV_FILE: '/dev/null',
        SVG_TRANSFORM_CORE_IMAGE: '', SVG_TRANSFORM_CORE_CONTAINER: 'test-core',
        SVG_TRANSFORM_CORE_URL: 'http://127.0.0.1:4310', SVG_TRANSFORM_CORE_PORT: '',
        SVG_TRANSFORM_CORE_WORKSPACE: path.join(root, 'workspace'), SVG_TRANSFORM_CORE_MODEL_CONFIG: model,
        SVG_TRANSFORM_CORE_ENV_FILE: '', MOCK_DOCKER_LOG: log, MOCK_CONTAINER_EXISTS: '0', MOCK_RUNTIME_ACCESS: '1', ...extra },
    })
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    return { ...result, calls }
  }
}

test('new Core uses the pinned image, model group and a graceful shutdown deadline', t => {
  const result = fixture(t)('start')
  assert.equal(result.status, 0, result.stderr)
  const run = result.calls.find(args => args[0] === 'run' && args.includes('-d'))
  assert.equal(run.at(-1), image)
  assert.equal(run[run.indexOf('--stop-timeout') + 1], '35')
  assert.match(run[run.indexOf('--group-add') + 1], /^\d+$/)
  const preflight = result.calls.find(args => args[0] === 'run' && args.includes('--rm'))
  assert.equal(preflight[preflight.indexOf('--network') + 1], 'none')
  assert.ok(preflight.includes(image))
})

test('unreadable bind mounts fail before stopping or removing an existing Core', t => {
  const result = fixture(t)('start', { MOCK_CONTAINER_EXISTS: '1', MOCK_RUNTIME_ACCESS: '0' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Existing runtime permissions and containers were left intact/)
  assert.equal(result.calls.some(args => ['stop', 'rm', 'start'].includes(args[0])), false)
})

test('recreation stops gracefully before removal and respects an explicit image', t => {
  const customImage = 'example.test/core:custom'
  const result = fixture(t)('recreate', { MOCK_CONTAINER_EXISTS: '1', SVG_TRANSFORM_CORE_IMAGE: customImage })
  assert.equal(result.status, 0, result.stderr)
  const stop = result.calls.findIndex(args => args[0] === 'stop')
  const remove = result.calls.findIndex(args => args[0] === 'rm')
  assert.ok(stop >= 0 && remove > stop)
  assert.deepEqual(result.calls[stop], ['stop', '--time', '35', 'test-core'])
  assert.deepEqual(result.calls[remove], ['rm', 'test-core'])
  assert.equal(result.calls.find(args => args[0] === 'run' && args.includes('-d')).at(-1), customImage)
})

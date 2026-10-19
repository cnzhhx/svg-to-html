import assert from 'node:assert/strict';
import test from 'node:test';
import { JobSummaryCache, summarizeJob } from '../src/core-service/job-summaries.js';

test('list summaries omit heavy execution data while retaining preview and queue metadata', () => {
  const summary = summarizeJob({ id: 'a', status: 'queued', queuedAt: 12,
    messages: [{ text: 'large transcript' }], logs: ['log'], svg: 'large SVG',
    result: { renderEntryPath: 'a.html', livePreviewVersion: 3, moduleAgentRuns: ['large run'], html: 'source' },
  });
  assert.equal(summary.__summary, true);
  assert.equal(summary.queuedAt, 12);
  assert.deepEqual(summary.messages, []);
  assert.deepEqual(summary.logs, []);
  assert.equal(summary.svg, undefined);
  assert.deepEqual(summary.result, { renderEntryPath: 'a.html', livePreviewVersion: 3 });
});

test('concurrent list reads share a fetch; mutation invalidates cached and in-flight data', async () => {
  const resolvers: ((jobs: Record<string, unknown>[]) => void)[] = [];
  const cache = new JobSummaryCache(() => new Promise(resolve => resolvers.push(resolve)));
  const first = cache.read();
  const second = cache.read();
  assert.equal(resolvers.length, 1);
  cache.invalidate();
  const fresh = cache.read();
  assert.equal(resolvers.length, 2);
  resolvers[1]!([{ id: 'new' }]);
  await fresh;
  resolvers[0]!([{ id: 'old' }]);
  assert.equal((await first)[0]!.id, 'old');
  await second;
  assert.equal((await cache.read())[0]!.id, 'new');
  assert.equal(resolvers.length, 2);
});

test('failed reads can retry and expired snapshots are refreshed', async () => {
  let calls = 0;
  const cache = new JobSummaryCache(async () => {
    if (++calls === 1) throw Error('offline');
    return [{ id: String(calls) }];
  }, 0);
  await assert.rejects(cache.read(), /offline/);
  assert.equal((await cache.read())[0]!.id, '2');
  assert.equal((await cache.read())[0]!.id, '3');
});

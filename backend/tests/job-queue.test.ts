import assert from "node:assert/strict";
import test from "node:test";

import { buildJobQueueDetails } from "../src/queue/job-queue.js";

test("lowered concurrency drains excess sessions before reusing slots", () => {
  const now = Date.now();
  const details = buildJobQueueDetails([
    { id: 'r1', status: 'running', executionStartedAt: now - 15 * 60_000 },
    { id: 'r2', status: 'running', executionStartedAt: now - 10 * 60_000 },
    { id: 'r3', status: 'running', executionStartedAt: now - 5 * 60_000 },
    { id: 'q1', status: 'queued', queuedAt: now - 2 },
    { id: 'q2', status: 'queued', queuedAt: now - 1 },
  ], { now, maxConcurrentJobs: 1, estimatedTaskMinutes: 20 });
  assert.equal(details.get('q1')?.maxConcurrentJobs, 1);
  assert.equal(details.get('q1')?.runningJobs, 3);
  assert.equal(details.get('q1')?.estimatedWaitMinutes, 15);
  assert.equal(details.get('q2')?.estimatedWaitMinutes, 35);
});

test("calculates global queue positions and 20-minute waits with one worker", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");
  const details = buildJobQueueDetails(
    [
      {
        executionStartedAt: now - 5 * 60_000,
        id: "other-running",
        status: "running",
      },
      { id: "other-queued", queuedAt: now - 3_000, status: "queued" },
      { id: "owner-first", queuedAt: now - 2_000, status: "queued" },
      { id: "owner-second", queuedAt: now - 1_000, status: "queued" },
    ],
    { estimatedTaskMinutes: 20, maxConcurrentJobs: 1, now },
  );

  assert.deepEqual(details.get("owner-first"), {
    estimatedStartAt: now + 35 * 60_000,
    estimatedTaskMinutes: 20,
    estimatedWaitMinutes: 35,
    maxConcurrentJobs: 1,
    queuePosition: 2,
    queuedAhead: 2,
    runningJobs: 1,
    totalQueued: 3,
  });
  assert.equal(details.get("owner-second")?.estimatedWaitMinutes, 55);
});

test("uses available concurrent slots when estimating queue waits", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");
  const details = buildJobQueueDetails(
    [
      {
        executionStartedAt: now - 10 * 60_000,
        id: "running",
        status: "running",
      },
      { id: "first", queuedAt: now - 2_000, status: "queued" },
      { id: "second", queuedAt: now - 1_000, status: "queued" },
    ],
    { estimatedTaskMinutes: 20, maxConcurrentJobs: 2, now },
  );

  assert.equal(details.get("first")?.estimatedWaitMinutes, 0);
  assert.equal(details.get("second")?.estimatedWaitMinutes, 10);
  assert.equal(details.get("second")?.maxConcurrentJobs, 2);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DailyQuotaExceededError,
  JobAccessStore,
  normalizeClientIp,
  ownerKeyForIp,
} from "../src/access/job-access.js";

test("normalizes mapped addresses before deriving an owner key", () => {
  assert.equal(normalizeClientIp("::ffff:203.0.113.8"), "203.0.113.8");
  assert.equal(normalizeClientIp("FE80::1%lo0"), "fe80::1");
  assert.equal(
    ownerKeyForIp("::ffff:203.0.113.8"),
    ownerKeyForIp("203.0.113.8"),
  );
});

test("enforces browser quota atomically and persists ownership without plaintext identifiers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "svg-access-"));
  const statePath = path.join(directory, "access-state.json");
  let now = new Date("2026-07-30T08:00:00.000Z");
  const options = {
    dailyUploadLimit: 2,
    now: () => now,
    showcaseJobIds: ["configured-showcase"],
    statePath,
    timeZone: "Asia/Shanghai",
  };

  try {
    const store = new JobAccessStore(options);
    const quotaKey = "c".repeat(64);
    const attempts = await Promise.allSettled([
      store.reserveUpload(quotaKey),
      store.reserveUpload(quotaKey),
      store.reserveUpload(quotaKey),
    ]);
    assert.equal(
      attempts.filter((attempt) => attempt.status === "fulfilled").length,
      2,
    );
    const rejected = attempts.find(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    assert.ok(rejected?.reason instanceof DailyQuotaExceededError);
    assert.deepEqual(await store.getQuota(quotaKey), {
      date: "2026-07-30",
      limit: 2,
      remaining: 0,
      used: 2,
    });

    await store.registerJob("203.0.113.8", "private-job", false);
    await store.registerJob(
      "203.0.113.8",
      "browser-job",
      false,
      "a".repeat(64),
    );
    await store.registerJob("203.0.113.10", "uploaded-showcase", true);
    assert.deepEqual(await store.getJobAccess("203.0.113.8", "private-job"), {
      accessMode: "owner",
      isShowcase: false,
    });
    assert.equal(
      await store.getJobAccess("198.51.100.2", "private-job"),
      null,
    );
    assert.deepEqual(
      await store.getJobAccess("198.51.100.2", "browser-job", "a".repeat(64)),
      { accessMode: "owner", isShowcase: false },
    );
    assert.equal(
      await store.getJobAccess("203.0.113.8", "browser-job"),
      null,
    );
    await store.bindClientToOwnerJobs("203.0.113.8", "b".repeat(64));
    assert.deepEqual(
      await store.getJobAccess("198.51.100.2", "private-job", "b".repeat(64)),
      { accessMode: "owner", isShowcase: false },
    );
    assert.equal(
      await store.getJobAccess("203.0.113.8", "private-job"),
      null,
    );
    assert.deepEqual(
      await store.getJobAccess("198.51.100.2", "uploaded-showcase"),
      { accessMode: "showcase", isShowcase: true },
    );
    assert.deepEqual(
      await store.getJobAccess("198.51.100.2", "configured-showcase"),
      { accessMode: "showcase", isShowcase: true },
    );
    const persisted = await readFile(statePath, "utf8");
    assert.equal(persisted.includes("203.0.113.8"), false);
    assert.equal(persisted.includes("203.0.113.10"), false);

    const restarted = new JobAccessStore(options);
    assert.deepEqual(await restarted.getQuota(quotaKey), {
      date: "2026-07-30",
      limit: 2,
      remaining: 0,
      used: 2,
    });
    assert.equal(
      await restarted.getJobAccess("203.0.113.8", "private-job"),
      null,
    );
    assert.deepEqual(
      await restarted.getJobAccess("203.0.113.8", "private-job", "b".repeat(64)),
      { accessMode: "owner", isShowcase: false },
    );

    now = new Date("2026-07-31T08:00:00.000Z");
    assert.deepEqual(await restarted.getQuota(quotaKey), {
      date: "2026-07-31",
      limit: 2,
      remaining: 2,
      used: 0,
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("refunds a reserved upload when Core rejects the request", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "svg-access-refund-"));
  try {
    const store = new JobAccessStore({
      dailyUploadLimit: 2,
      now: () => new Date("2026-07-30T08:00:00.000Z"),
      statePath: path.join(directory, "access-state.json"),
      timeZone: "Asia/Shanghai",
    });
    const quotaKey = "d".repeat(64);
    await store.reserveUpload(quotaKey);
    assert.equal((await store.getQuota(quotaKey)).used, 1);
    await store.refundUpload(quotaKey);
    assert.equal((await store.getQuota(quotaKey)).used, 0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

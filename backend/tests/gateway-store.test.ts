import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GatewayStore, defaultGatewayState, GatewayError } from "../src/settings/gateway-store.js";
import { JobAccessStore } from "../src/access/job-access.js";

test("settings persist, reject stale saves, and remain intact after failed writes or corrupt files", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gateway-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "gateway-state.json");
  const defaults = () => ({ ...defaultGatewayState(), settings: { ...defaultGatewayState().settings, dailyUploadLimit: 5 } });
  const store = new GatewayStore(statePath, defaults);
  const original = await store.read();
  const settings = { ...original.settings, dailyUploadLimit: 9, quotaEnabled: false };
  const parallel = await Promise.allSettled([store.saveSettings(settings, 1), new GatewayStore(statePath, defaults).saveSettings({ ...settings, dailyUploadLimit: 8 }, 1)]);
  assert.equal(parallel.filter(x => x.status === "fulfilled").length, 1);
  const rejected = parallel.find(x => x.status === "rejected") as PromiseRejectedResult;
  assert.equal((rejected.reason as GatewayError).status, 409);
  const before = await readFile(statePath, "utf8");
  const restarted = new GatewayStore(statePath, () => { throw Error("must not import env twice"); });
  assert.equal((await restarted.read()).revision, 2);
  const brokenWriter = new GatewayStore(statePath, defaults, async () => { throw Error("disk full"); });
  await assert.rejects(brokenWriter.saveSettings({ ...settings, dailyUploadLimit: 10 }, 2), /disk full/);
  assert.equal(await readFile(statePath, "utf8"), before);
  for (const invalid of [{ ...settings, maxSvgUploadMb: 51 }, { ...settings, timeZone: "bad/zone" }, { ...settings, quotaEnabled: "false" }, { ...settings, model: "not-in-scope" }]) {
    await assert.rejects(store.saveSettings(invalid, 2), (e: unknown) => e instanceof GatewayError && e.status === 400);
  }
  await writeFile(statePath, "broken");
  await assert.rejects(restarted.read());
  await assert.rejects(new GatewayStore(statePath, defaults).initialize());
  assert.equal(await readFile(statePath, "utf8"), "broken");
});

test("quota toggles preserve usage, reserve atomically, and refund the original date across timezone changes", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gateway-quota-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = new Date("2026-10-13T15:59:59Z");
  const store = new JobAccessStore({ dailyUploadLimit: 1, timeZone: "Asia/Shanghai", statePath: path.join(dir, "access.json"), now: () => now });
  const enabled = { dailyUploadLimit: 1, timeZone: "Asia/Shanghai", quotaEnabled: true };
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => store.reserveUpload("browser", enabled)));
  assert.equal(attempts.filter(x => x.status === "fulfilled").length, 1);
  const freeReservation = await store.reserveUpload("browser", { ...enabled, quotaEnabled: false });
  assert.equal(freeReservation.used, 2);
  await assert.rejects(store.reserveUpload("browser", enabled));
  assert.equal((await store.getQuota("browser", { ...enabled, dailyUploadLimit: 3 })).remaining, 1);
  now = new Date("2026-10-13T16:00:01Z");
  await store.reserveUpload("browser", enabled);
  await store.refundUpload("browser", freeReservation.date, { ...enabled, timeZone: "UTC" });
  assert.equal((await store.getQuota("browser", enabled)).used, 1);
  assert.equal((await store.getQuota("browser", { ...enabled, timeZone: "UTC" })).used, 1);
});

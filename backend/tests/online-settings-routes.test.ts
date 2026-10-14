import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createMockCore, mockJob, listen, closeServer } from "./helpers/mock-core.js";

test("online settings enforce live permissions, quota policies, admin writes and stream revocation", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "online-settings-"));
  const core = await createMockCore();
  process.env.ENV_FILE = "/dev/null";
  process.env.SVG_TRANSFORM_CORE_URL = core.url;
  process.env.SVG_TO_HTML_ACCESS_STATE_PATH = path.join(dir, "access-state.json");
  process.env.SVG_TO_HTML_DAILY_UPLOAD_LIMIT = "2";
  process.env.SVG_TO_HTML_SHOWCASE_JOB_IDS = "";
  delete process.env.SVG_TO_HTML_ADMIN_KEY;
  const { default: routes } = await import("../src/routes/jobs.js");
  const { getGatewayStore } = await import("../src/settings/gateway-store.js");
  const store = getGatewayStore();
  const app = express(); app.use(express.json()); app.use("/transformer/api", routes);
  const server = createServer(app);
  const origin = `http://127.0.0.1:${await listen(server)}`;
  t.after(async () => { await closeServer(server); await closeServer(core.server); await rm(dir, { recursive: true, force: true }); });
  const call = (endpoint: string, cookie = "", method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/transformer/api${endpoint}`, {
    method, headers: { Cookie: cookie, "Content-Type": "application/json", "X-Requested-With": "svg-to-html", Origin: origin, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const browser = async () => (await call("/runtime")).headers.getSetCookie().find(x => x.startsWith("svg_to_html_client="))!.split(";")[0]!;
  const a = await browser(), b = await browser();
  const initial = await (await call("/setup")).json();
  assert.equal((await call("/admin/settings")).status, 401);
  const setup = await call("/setup", "", "POST", { username: "admin", password: "test-password-123", token: await store.issueToken("setup"), settings: initial.settings });
  assert.equal(setup.status, 201);
  let admin = setup.headers.getSetCookie().find(x => x.startsWith("svg_to_html_admin="))!.split(";")[0]!;
  let snapshot = await (await call("/admin/settings", admin)).json();
  await t.test("queue settings require admin and same origin, reject stale/invalid writes, and expose actual limits", async () => {
    assert.equal((await call('/admin/queue-settings')).status, 401);
    assert.equal((await call('/admin/queue-settings', '', 'PUT', { revision: 1, maxConcurrentJobs: 3 })).status, 401);
    const initialQueue = await (await call('/admin/queue-settings', admin)).json();
    assert.equal((await call('/admin/queue-settings', admin, 'PUT', { ...initialQueue, maxConcurrentJobs: 3 }, { Origin: 'https://untrusted.example' })).status, 403);
    for (const maxConcurrentJobs of [0, 33, 1.5, '2', null]) {
      assert.equal((await call('/admin/queue-settings', admin, 'PUT', { ...initialQueue, maxConcurrentJobs })).status, 400);
    }
    const savedQueue = await call('/admin/queue-settings', admin, 'PUT', { ...initialQueue, maxConcurrentJobs: 3 });
    assert.equal(savedQueue.status, 200);
    const next = await savedQueue.json();
    assert.equal(next.maxConcurrentJobs, 3);
    assert.equal((await call('/admin/queue-settings', admin, 'PUT', initialQueue)).status, 409);
    const queued = { ...mockJob('queue-check'), status: 'queued' };
    core.jobs.set(queued.id, queued);
    const detail = await (await call('/jobs/queue-check', admin)).json();
    assert.equal(detail.queue.maxConcurrentJobs, 3);
    core.jobs.delete(queued.id);
    core.control.queueSettingsStatus = 404;
    assert.equal((await call('/admin/queue-settings', admin)).status, 501);
    core.control.queueSettingsStatus = 503;
    assert.equal((await call('/admin/queue-settings', admin, 'PUT', next)).status, 503);
    core.control.queueSettingsStatus = 200;
    assert.deepEqual(await (await call('/admin/queue-settings', admin)).json(), next);
  });
  const save = async (patch: Record<string, unknown>) => {
    const response = await call("/admin/settings", admin, "PUT", { revision: snapshot.revision, settings: { ...snapshot.settings, ...patch } });
    assert.equal(response.status, 200, await response.clone().text()); snapshot = await response.json();
  };
  const upload = (cookie: string, showcase = false, size = 11) => {
    const form = new FormData(); form.append("svg", new Blob([new Uint8Array(size)]), "test.svg"); form.append("showcase", String(showcase));
    return fetch(`${origin}/transformer/api/jobs`, { method: "POST", headers: { Cookie: cookie, "X-Requested-With": "svg-to-html" }, body: form });
  };
  const first = await upload(a); assert.equal(first.status, 202);
  const id = (await first.json()).jobId as string;
  core.jobs.set("historical", mockJob("historical"));
  const readPaths = [`/jobs/${id}`, `/jobs/${id}/preview`, `/jobs/${id}/download`, `/jobs/${id}/files/result.html?v=1`];

  await t.test("isolation applies to every endpoint; shared jobs are read-only", async () => {
    for (const endpoint of [...readPaths, `/jobs/${id}/events`]) assert.equal((await call(endpoint, b)).status, 404);
    assert.equal((await call(`/jobs/${id}/messages`, a, "POST", { text: "ok" })).status, 202);
    assert.equal((await call("/jobs", b)).status, 200);
    await save({ accessIsolationEnabled: false });
    for (const endpoint of readPaths) {
      const response = await call(endpoint, b); assert.equal(response.status, 200); assert.match(response.headers.get("cache-control")!, /no-store/);
    }
    const shared = await (await call(`/jobs/${id}`, b)).json();
    assert.equal(shared.accessMode, "shared"); assert.deepEqual(shared.capabilities, { canWrite: false, canDelete: false });
    assert.equal((await call("/jobs/historical", b)).status, 200);
    for (const [suffix, method] of [["", "DELETE"], ["/start", "POST"], ["/messages", "POST"]]) assert.equal((await call(`/jobs/${id}${suffix}`, b, method, method === "POST" ? {} : undefined)).status, 403);
  });
  await t.test("turning isolation on revokes already-open SSE and file streams", async () => {
    const readers = await Promise.all([`/jobs/${id}/events`, `/jobs/${id}/files/slow.bin`].map(async endpoint => {
      const response = await call(endpoint, b); assert.equal(response.status, 200);
      const reader = response.body!.getReader(); await reader.read(); return reader;
    }));
    await save({ accessIsolationEnabled: true });
    for (const reader of readers) {
      const drained = (async () => { try { while (!(await reader.read()).done) { /* drain until revoked */ } } catch { /* socket revoked */ } })();
      let timer: NodeJS.Timeout;
      try { await Promise.race([drained, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("stream was not revoked")), 2500); })]); }
      finally { clearTimeout(timer!); await reader.cancel().catch(() => {}); }
    }
    assert.equal((await call("/jobs/historical", b)).status, 404);
    assert.equal((await call(`/jobs/${id}`, a)).status, 200);
    assert.equal((await call(`/jobs/${id}`, admin)).status, 200);
  });
  await t.test("all four quota/isolation combinations, size changes, refunds and admin exemption", async () => {
    for (const isolation of [true, false]) {
      await save({ accessIsolationEnabled: isolation, quotaEnabled: true, dailyUploadLimit: 1 });
      assert.equal((await upload(a)).status, 429);
      await save({ quotaEnabled: false });
      assert.equal((await upload(a)).status, 202);
    }
    let runtime = await (await call("/runtime", a)).json(); assert.equal(runtime.uploadQuota.used, 3);
    assert.equal(runtime.quotaEnabled, false);
    await save({ quotaEnabled: true, dailyUploadLimit: 3, maxSvgUploadMb: 1, estimatedTaskMinutes: 7 });
    assert.equal((await upload(a)).status, 429);
    const beforeAdmin = await (await call("/runtime", admin)).json();
    for (let i = 0; i < 4; i++) assert.equal((await upload(admin)).status, 202);
    assert.equal((await (await call("/runtime", admin)).json()).uploadQuota.used, beforeAdmin.uploadQuota.used);
    assert.equal((await upload(b, false, 1024 * 1024 + 1)).status, 413);
    core.control.rejectUploads = true; assert.equal((await upload(b)).status, 503); core.control.rejectUploads = false;
    runtime = await (await call("/runtime", b)).json(); assert.equal(runtime.uploadQuota.used, 0);
    assert.equal(runtime.maxSvgUploadBytes, 1024 * 1024);
    assert.equal("nodeVersion" in runtime, false); assert.equal("admin" in runtime, false); assert.equal("showcaseOverrides" in runtime, false);
  });
  await t.test("showcase moderation, read-only policy, and disabling user submissions", async () => {
    await save({ accessIsolationEnabled: true, allowUserShowcase: false });
    assert.equal((await upload(b, true)).status, 403);
    let response = await call(`/admin/jobs/${id}/showcase`, admin, "PUT", { showcase: true, revision: snapshot.revision });
    assert.equal(response.status, 200); snapshot.revision = (await response.json()).revision;
    assert.equal((await (await call(`/jobs/${id}`, b)).json()).accessMode, "showcase");
    assert.equal((await call(`/jobs/${id}`, a, "DELETE")).status, 403);
    assert.equal((await call(`/jobs/${id}/messages`, a, "POST", {})).status, 202);
    response = await call(`/admin/jobs/${id}/showcase`, admin, "PUT", { showcase: false, revision: snapshot.revision });
    snapshot.revision = (await response.json()).revision;
    assert.equal((await call(`/jobs/${id}`, b)).status, 404);
    assert.equal((await call(`/jobs/${id}`, a, "DELETE")).status, 200);
  });
  await t.test("admin writes reject unauthorized, cross-origin, invalid and stale requests", async () => {
    assert.equal((await call("/admin/settings", b, "PUT", snapshot)).status, 401);
    assert.equal((await call("/admin/settings", admin, "PUT", snapshot, { Origin: "https://attacker.example" })).status, 403);
    assert.equal((await call("/admin/settings", admin, "PUT", snapshot, { "X-Requested-With": "" })).status, 403);
    assert.equal((await call("/admin/settings", admin, "PUT", { ...snapshot, settings: { ...snapshot.settings, maxSvgUploadMb: 99 } })).status, 400);
    assert.equal((await call("/admin/settings", admin, "PUT", { ...snapshot, revision: 1 })).status, 409);
    assert.equal((await call("/admin/session", "", "POST", { username: "admin", password: "test-password-123" }, { Origin: "https://attacker.example" })).status, 403);
    assert.equal((await call("/admin/session", admin, "DELETE")).status, 200);
    assert.equal((await call("/admin/settings", admin)).status, 401);
    const login = await call("/admin/session", "", "POST", { username: "admin", password: "test-password-123" });
    admin = login.headers.getSetCookie()[0]!.split(";")[0]!;
    assert.equal((await call("/admin/settings", admin)).status, 200);
    for (let i = 0; i < 11; i++) {
      const response = await call("/admin/session", "", "POST", { username: "admin", password: "wrong" });
      if (i === 10) assert.equal(response.status, 429);
    }
  });
});

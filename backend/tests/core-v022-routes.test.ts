import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { listen, closeServer, mockJob } from "./helpers/mock-core.js";
import { getJobDownloadKind } from "../../frontend/src/utils/artifacts.js";
import { labelForJobStatus } from "../../frontend/src/utils/format.js";
import type { Job } from "../../frontend/src/types/job.js";

test("Core 0.2.2 capabilities, deliverables and diagnostic files retain gateway access boundaries", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "core-v022-"));
  const requests: string[] = [];
  let readiness = { status: 200, body: { ready: true, capabilities: { html: true, vue: true, react: true, flutter: false } } as unknown };
  const job = {
    ...mockJob("owned"), outputFormat: "flutter",
    result: { ...mockJob("owned").result,
      outputTarget: { format: "flutter", frameworkProjectDir: "design.flutter", sourceEntryPath: "design.flutter/lib/main.dart" },
      quality: { status: "partial", softIssues: ["visual difference"], blockingIssues: [], gateSummary: { globalDiffPassed: false } },
      deliverable: { version: "v1", manifestPath: "exports/v1/manifest.json" },
      downloadUrl: "/api/jobs/owned/download", diagnosticDownloadUrl: "/api/jobs/owned/download?kind=diagnostic",
    },
  };
  const core = createServer((req, res) => {
    requests.push(req.url!);
    const url = new URL(req.url!, "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/ready") { res.statusCode = readiness.status; res.end(JSON.stringify(readiness.body)); }
    else if (url.pathname === "/api/jobs") res.end(JSON.stringify([job]));
    else if (url.pathname === "/api/jobs/owned") res.end(JSON.stringify(job));
    else if (url.pathname === "/api/jobs/owned/download") {
      const kind = url.searchParams.get("kind") || "deliverable";
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${kind}.zip"`);
      res.end(kind);
    } else if (url.pathname.startsWith("/api/jobs/owned/files/")) {
      res.setHeader("Content-Type", "text/javascript"); res.end("/* bundled asset */");
    } else { res.statusCode = 404; res.end('{"error":"not found"}'); }
  });
  process.env.ENV_FILE = "/dev/null";
  process.env.SVG_TRANSFORM_CORE_URL = `http://127.0.0.1:${await listen(core)}`;
  process.env.SVG_TRANSFORM_CORE_MODEL_CONFIG = path.join(dir, "unused-model.json");
  process.env.SVG_TO_HTML_ACCESS_STATE_PATH = path.join(dir, "access-state.json");
  process.env.SVG_TO_HTML_SHOWCASE_JOB_IDS = "";
  delete process.env.SVG_TO_HTML_ADMIN_KEY;
  t.after(async () => { await closeServer(core); await rm(dir, { recursive: true, force: true }); });
  const { default: routes } = await import("../src/routes/jobs.js");
  const { getJobAccessStore } = await import("../src/access/job-access.js");
  const { clientKeyForToken } = await import("../src/access/client-session.js");
  const token = "a".repeat(64);
  await getJobAccessStore().registerJob("127.0.0.1", "owned", false, clientKeyForToken(token));
  const app = express(); app.use("/transformer/api", routes);
  const server = createServer(app);
  const origin = `http://127.0.0.1:${await listen(server)}/transformer/api`;
  t.after(() => closeServer(server));
  const call = (endpoint: string, owner = true) => fetch(`${origin}${endpoint}`, {
    headers: { Cookie: `svg_to_html_client=${owner ? token : "b".repeat(64)}` },
  });

  await t.test("Flutter appears only when Core reports the SDK, including a 503 readiness response", async () => {
    const runtime = async () => (await call("/runtime")).json();
    assert.deepEqual((await runtime()).outputFormats, ["html", "vue", "react"]);
    for (const status of [200, 503]) {
      readiness = { status, body: { ready: status === 200, capabilities: { flutter: true }, checks: { model: false }, privateField: "do not forward" } };
      const result = await runtime();
      assert.deepEqual(result.outputFormats, ["html", "vue", "react", "flutter"]);
      assert.equal("checks" in result, false);
      assert.equal("privateField" in result, false);
    }
    for (const body of [null, {}, { capabilities: { flutter: "true" } }]) {
      readiness = { status: 200, body };
      assert.deepEqual((await runtime()).outputFormats, ["html", "vue", "react"]);
    }
    readiness = { status: 404, body: { error: "old Core" } };
    assert.deepEqual((await runtime()).outputFormats, ["html", "vue", "react"]);
  });

  await t.test("details and list summaries retain quality and export metadata with rewritten URLs", async () => {
    const detail = await (await call("/jobs/owned")).json() as Job;
    assert.equal(detail.result.outputTarget?.frameworkProjectDir, "design.flutter");
    assert.equal(detail.result.diagnosticDownloadUrl, "/transformer/api/jobs/owned/download?kind=diagnostic");
    assert.equal(labelForJobStatus(detail), "已完成 · 部分达标");
    assert.equal(getJobDownloadKind(detail), "deliverable");
    const summary = (await (await call("/jobs")).json())[0];
    assert.deepEqual(summary.result.quality, detail.result.quality);
    assert.deepEqual(summary.result.deliverable, detail.result.deliverable);
    assert.equal(summary.result.diagnosticDownloadUrl, detail.result.diagnosticDownloadUrl);
    const historical = { ...detail, result: { ...detail.result, deliverable: undefined } };
    assert.equal(getJobDownloadKind(historical), "diagnostic");
    assert.equal(getJobDownloadKind({ ...historical, result: {} }), "deliverable");
  });

  await t.test("download kinds reach Core and unauthorized readers cannot download either package", async () => {
    for (const query of ["", "?kind=deliverable", "?kind=diagnostic"]) {
      const endpoint = `/jobs/owned/download${query}`;
      const before = requests.length;
      assert.equal((await call(endpoint, false)).status, 404);
      assert.equal(requests.length, before);
      const response = await call(endpoint);
      assert.equal(response.status, 200);
      assert.equal(requests.at(-1), `/api/jobs/owned/download${query}`);
      assert.equal(await response.text(), query.includes("diagnostic") ? "diagnostic" : "deliverable");
      assert.match(response.headers.get("content-disposition")!, /attachment/);
      assert.match(response.headers.get("cache-control")!, /private, no-store/);
    }
    const before = requests.length;
    for (const query of ["?kind=other", "?kind[]=diagnostic", "?kind=diagnostic&kind=deliverable"]) {
      assert.equal((await call(`/jobs/owned/download${query}`)).status, 400);
    }
    assert.equal(requests.length, before);
  });

  await t.test("relative preview artifact routes enforce the same path and read permissions as files", async () => {
    const endpoint = "/jobs/owned/artifacts/framework-render/assets/main.js";
    assert.equal((await call(endpoint, false)).status, 404);
    const response = await call(endpoint);
    assert.equal(response.status, 200);
    assert.equal(requests.at(-1), "/api/jobs/owned/files/artifacts/framework-render/assets/main.js");
    const before = requests.length;
    assert.equal((await call("/jobs/owned/artifacts/nested/..%2fprivate.json")).status, 400);
    assert.equal(requests.length, before);
  });
});

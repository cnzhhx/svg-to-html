import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

type MockJob = {
  createdAt: number;
  designName: string;
  executionStartedAt?: number;
  id: string;
  jobId: string;
  outputFormat: "html";
  queuedAt?: number;
  status: string;
  updatedAt: number;
};

type QueueDetails = {
  estimatedTaskMinutes: number;
  estimatedWaitMinutes: number;
  maxConcurrentJobs: number;
  queuePosition: number;
  queuedAhead: number;
  runningJobs: number;
  totalQueued: number;
};

const listen = (server: Server) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Server did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });

const close = (server: Server | null) =>
  new Promise<void>((resolve, reject) => {
    if (!server?.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });

const sendJson = (
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
};

test("job routes enforce per-browser quota, isolation, and read-only showcases", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "svg-routes-"));
  const adminKey = "test-admin-key-0123456789abcdef0123456789abcdef";
  const jobs = new Map<string, MockJob>();
  let sequence = 0;
  let coreServer: Server | null = null;
  let gatewayServer: Server | null = null;

  try {
    coreServer = createServer(async (request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(.*))?$/);

      if (request.method === "POST" && url.pathname === "/api/jobs") {
        for await (const _chunk of request) {
          // Drain the multipart upload before responding.
        }
        sequence += 1;
        const now = Date.now();
        const job: MockJob = {
          createdAt: now,
          designName: `design-${sequence}`,
          id: `job-${sequence}`,
          jobId: `job-${sequence}`,
          outputFormat: "html",
          status: "draft",
          updatedAt: now,
        };
        jobs.set(job.id, job);
        sendJson(response, 202, job);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/jobs") {
        sendJson(response, 200, [...jobs.values()]);
        return;
      }

      if (!jobMatch) {
        sendJson(response, 404, { error: "not found" });
        return;
      }

      const jobId = decodeURIComponent(jobMatch[1] || "");
      const suffix = jobMatch[2] || "";
      const job = jobs.get(jobId);
      if (!job) {
        sendJson(response, 404, { error: "not found" });
        return;
      }

      if (request.method === "GET" && !suffix) {
        sendJson(response, 200, job);
        return;
      }
      if (request.method === "POST" && suffix === "start") {
        job.status = "queued";
        sendJson(response, 200, { jobId, status: job.status });
        return;
      }
      if (request.method === "POST" && suffix === "messages") {
        sendJson(response, 202, { jobId, status: job.status });
        return;
      }
      if (request.method === "DELETE" && !suffix) {
        jobs.delete(jobId);
        sendJson(response, 200, { deleted: true, jobId });
        return;
      }
      if (request.method === "GET" && suffix === "events") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ job, type: "init" })}\n\n`);
        return;
      }
      if (
        request.method === "GET" &&
        suffix.startsWith("files/") &&
        decodeURIComponent(suffix).endsWith(".compare.html")
      ) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!DOCTYPE html><html><head></head><body>
          <div class="compare-stage"><img src="./design.svg?v=123" /></div>
          <div class="compare-stage"><iframe src="./design.html?v=123"></iframe></div>
        </body></html>`);
        return;
      }
      if (
        request.method === "GET" &&
        (suffix === "preview" || suffix === "download" || suffix.startsWith("files/"))
      ) {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end(jobId);
        return;
      }

      sendJson(response, 404, { error: "not found" });
    });
    const corePort = await listen(coreServer);

    process.env.SVG_TRANSFORM_CORE_URL = `http://127.0.0.1:${corePort}`;
    process.env.SVG_TO_HTML_ACCESS_STATE_PATH = path.join(
      directory,
      "access-state.json",
    );
    process.env.SVG_TO_HTML_DAILY_UPLOAD_LIMIT = "2";
    process.env.SVG_TO_HTML_DAILY_QUOTA_TIME_ZONE = "Asia/Shanghai";
    process.env.SVG_TO_HTML_ESTIMATED_TASK_MINUTES = "20";
    process.env.SVG_TO_HTML_SHOWCASE_JOB_IDS = "";
    process.env.SVG_TO_HTML_ADMIN_KEY = adminKey;
    process.env.MAX_CONCURRENT_AGENTS = "1";

    const { default: jobsRouter } = await import("../src/routes/jobs.js");
    const app = express();
    app.set("trust proxy", "loopback");
    app.use(express.json());
    app.use("/api", jobsRouter);
    gatewayServer = createServer(app);
    const gatewayPort = await listen(gatewayServer);
    const baseUrl = `http://127.0.0.1:${gatewayPort}/api`;

    const requestFrom = (ip: string, endpoint: string, init: RequestInit = {}) =>
      fetch(`${baseUrl}${endpoint}`, {
        ...init,
        headers: { "X-Forwarded-For": ip, "X-Requested-With": "svg-to-html", ...init.headers },
      });
    const uploadFrom = (
      ip: string,
      options: {
        adminCookie?: string;
        clientCookie?: string;
        jobCount?: number;
        showcase?: boolean;
      } = {},
    ) => {
      const form = new FormData();
      form.append("svg", new Blob(["<svg></svg>"], { type: "image/svg+xml" }), "sample.svg");
      form.append("outputFormat", "html");
      form.append("scale", "1");
      if (options.jobCount !== undefined) {
        form.append("jobCount", String(options.jobCount));
      }
      if (options.showcase) form.append("showcase", "true");
      const cookie = [options.adminCookie, options.clientCookie]
        .filter(Boolean)
        .join("; ");
      return requestFrom(ip, "/jobs", {
        body: form,
        headers: cookie ? { Cookie: cookie } : {},
        method: "POST",
      });
    };

    assert.equal((await uploadFrom("198.51.100.3", { jobCount: 2 })).status, 400);
    const invalidAdminSession = await requestFrom("192.0.2.10", "/admin/session", {
      body: JSON.stringify({ key: "invalid-admin-key" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(invalidAdminSession.status, 403);
    assert.equal(invalidAdminSession.headers.get("set-cookie"), null);

    const adminSession = await requestFrom("192.0.2.10", "/admin/session", {
      body: JSON.stringify({ key: adminKey }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(adminSession.status, 200);
    const adminSetCookie = adminSession.headers.get("set-cookie") ?? "";
    const adminCookie = adminSetCookie.split(";", 1)[0] ?? "";
    assert.match(adminCookie, /^svg_to_html_admin=/);
    assert.equal(adminSetCookie.includes(adminKey), false);
    assert.match(adminSetCookie, /HttpOnly/);
    assert.match(adminSetCookie, /SameSite=Strict/);

    const untouchedRuntime = await requestFrom("198.51.100.3", "/runtime");
    const untouchedRuntimePayload = await untouchedRuntime.json() as {
      adminMode: boolean;
      maxSvgUploadBytes: number;
      uploadQuota: { remaining: number };
    };
    assert.equal(untouchedRuntimePayload.adminMode, false);
    assert.equal(untouchedRuntimePayload.maxSvgUploadBytes, 50 * 1024 * 1024);
    assert.equal(untouchedRuntimePayload.uploadQuota.remaining, 2);
    const clientSetCookie = untouchedRuntime.headers.get("set-cookie") ?? "";
    assert.match(clientSetCookie, /^svg_to_html_client=[a-f0-9]{64};/);
    assert.match(clientSetCookie, /Max-Age=31536000/);
    assert.match(clientSetCookie, /HttpOnly/);
    assert.match(clientSetCookie, /SameSite=Strict/);
    assert.equal(untouchedRuntime.headers.get("cache-control"), "private, no-store");
    assert.match(untouchedRuntime.headers.get("vary") ?? "", /Cookie/);
    const adminRuntime = await requestFrom("192.0.2.10", "/runtime", {
      headers: { Cookie: adminCookie },
    });
    assert.equal((await adminRuntime.json() as { adminMode: boolean }).adminMode, true);

    const oversizedForm = new FormData();
    oversizedForm.append(
      "svg",
      new Blob([new Uint8Array(50 * 1024 * 1024 + 1)], { type: "image/svg+xml" }),
      "oversized.svg",
    );
    const oversizedUpload = await requestFrom("198.51.100.3", "/jobs", {
      body: oversizedForm,
      method: "POST",
    });
    assert.equal(oversizedUpload.status, 413);
    assert.equal(
      (await oversizedUpload.json() as { error: string }).error,
      "SVG 文件不能超过 50 MB",
    );
    const runtimeAfterOversized = await requestFrom("198.51.100.3", "/runtime");
    assert.equal(
      (await runtimeAfterOversized.json() as { uploadQuota: { remaining: number } })
        .uploadQuota.remaining,
      2,
    );

    const ownerRuntime = await requestFrom("203.0.113.8", "/runtime");
    const ownerSetCookie = ownerRuntime.headers.get("set-cookie") ?? "";
    const ownerClientCookie = ownerSetCookie.split(";", 1)[0] ?? "";
    const ownerClientToken = ownerClientCookie.split("=", 2)[1] ?? "";
    assert.match(ownerClientCookie, /^svg_to_html_client=[a-f0-9]{64}$/);

    const firstUpload = await uploadFrom("203.0.113.8", {
      clientCookie: ownerClientCookie,
    });
    const secondUpload = await uploadFrom("203.0.113.8", {
      clientCookie: ownerClientCookie,
    });
    const blockedUpload = await uploadFrom("203.0.113.8", {
      clientCookie: ownerClientCookie,
    });
    assert.equal(firstUpload.status, 202);
    assert.equal(secondUpload.status, 202);
    assert.equal(blockedUpload.status, 429);
    const blockedPayload = await blockedUpload.json() as {
      quota: { date: string; limit: number; remaining: number; used: number };
    };
    assert.match(blockedPayload.quota.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(
      {
        limit: blockedPayload.quota.limit,
        remaining: blockedPayload.quota.remaining,
        used: blockedPayload.quota.used,
      },
      { limit: 2, remaining: 0, used: 2 },
    );

    const privateJobId = (await firstUpload.json() as { jobId: string }).jobId;
    const sameIpOtherBrowserList = await requestFrom("203.0.113.8", "/jobs");
    assert.equal(sameIpOtherBrowserList.status, 200);
    assert.deepEqual(await sameIpOtherBrowserList.json(), []);
    assert.equal(
      (await requestFrom("203.0.113.8", `/jobs/${privateJobId}`)).status,
      404,
    );
    const sameIpOtherBrowserRuntime = await requestFrom("203.0.113.8", "/runtime");
    assert.equal(
      (await sameIpOtherBrowserRuntime.json() as { uploadQuota: { remaining: number } })
        .uploadQuota.remaining,
      2,
    );

    const ownerList = await requestFrom("203.0.113.8", "/jobs", {
      headers: { Cookie: ownerClientCookie },
    });
    assert.equal(ownerList.status, 200);
    assert.equal((await ownerList.json() as MockJob[]).length, 2);
    assert.equal(ownerList.headers.get("cache-control"), "private, no-store");
    assert.match(ownerList.headers.get("vary") ?? "", /Cookie/);

    const roamingList = await requestFrom("192.0.2.44", "/jobs", {
      headers: { Cookie: ownerClientCookie },
    });
    const roamingJobs = await roamingList.json() as MockJob[];
    assert.deepEqual(
      roamingJobs.map((job) => job.id).sort(),
      ["job-1", "job-2"],
    );
    assert.equal(
      (await requestFrom("192.0.2.44", `/jobs/${privateJobId}`, {
        headers: { Cookie: ownerClientCookie },
      })).status,
      200,
    );
    const roamingRuntime = await requestFrom("192.0.2.44", "/runtime", {
      headers: { Cookie: ownerClientCookie },
    });
    assert.equal(
      (await roamingRuntime.json() as { uploadQuota: { remaining: number } })
        .uploadQuota.remaining,
      0,
    );
    assert.equal(
      (await readFile(path.join(directory, "access-state.json"), "utf8"))
        .includes(ownerClientToken),
      false,
    );

    const otherRuntime = await requestFrom("198.51.100.4", "/runtime");
    const otherClientCookie = (otherRuntime.headers.get("set-cookie") ?? "")
      .split(";", 1)[0] ?? "";
    const otherFirstUpload = await uploadFrom("198.51.100.4", {
      clientCookie: otherClientCookie,
    });
    const otherSecondUpload = await uploadFrom("198.51.100.4", {
      clientCookie: otherClientCookie,
    });
    const otherFirstJobId = (await otherFirstUpload.json() as { jobId: string }).jobId;
    const otherSecondJobId = (await otherSecondUpload.json() as { jobId: string }).jobId;
    const privateJobIds = [...jobs.keys()].filter((jobId) =>
      jobId !== otherFirstJobId && jobId !== otherSecondJobId,
    );
    const queueNow = Date.now();
    Object.assign(jobs.get(otherFirstJobId)!, {
      executionStartedAt: queueNow - 5 * 60_000,
      status: "running",
    });
    Object.assign(jobs.get(otherSecondJobId)!, {
      queuedAt: queueNow - 3_000,
      status: "queued",
    });
    Object.assign(jobs.get(privateJobIds[0]!)!, {
      queuedAt: queueNow - 2_000,
      status: "queued",
    });
    Object.assign(jobs.get(privateJobIds[1]!)!, {
      queuedAt: queueNow - 1_000,
      status: "queued",
    });

    const ownerQueueList = await requestFrom("203.0.113.8", "/jobs", {
      headers: { Cookie: ownerClientCookie },
    });
    const ownerQueuedJobs = await ownerQueueList.json() as Array<MockJob & { queue: QueueDetails }>;
    assert.equal(ownerQueuedJobs.length, 2);
    assert.deepEqual(
      ownerQueuedJobs.map((job) => ({
        estimatedTaskMinutes: job.queue.estimatedTaskMinutes,
        maxConcurrentJobs: job.queue.maxConcurrentJobs,
        queuePosition: job.queue.queuePosition,
        queuedAhead: job.queue.queuedAhead,
        runningJobs: job.queue.runningJobs,
        totalQueued: job.queue.totalQueued,
      })),
      [
        {
          estimatedTaskMinutes: 20,
          maxConcurrentJobs: 1,
          queuePosition: 2,
          queuedAhead: 2,
          runningJobs: 1,
          totalQueued: 3,
        },
        {
          estimatedTaskMinutes: 20,
          maxConcurrentJobs: 1,
          queuePosition: 3,
          queuedAhead: 3,
          runningJobs: 1,
          totalQueued: 3,
        },
      ],
    );
    assert.equal(ownerQueuedJobs[0]!.queue.estimatedWaitMinutes, 35);
    assert.equal(ownerQueuedJobs[1]!.queue.estimatedWaitMinutes, 55);

    const adminList = await requestFrom("192.0.2.10", "/jobs", {
      headers: { Cookie: adminCookie },
    });
    const adminJobs = await adminList.json() as Array<MockJob & { accessMode: string }>;
    assert.equal(adminJobs.length, jobs.size);
    assert.equal(adminJobs.every((job) => job.accessMode === "admin"), true);

    const ownerQueueDetail = await requestFrom(
      "203.0.113.8",
      `/jobs/${privateJobIds[0]}`,
      { headers: { Cookie: ownerClientCookie } },
    );
    assert.equal(ownerQueueDetail.headers.get("cache-control"), "private, no-store");
    assert.match(ownerQueueDetail.headers.get("vary") ?? "", /Cookie/);
    assert.equal(
      (await ownerQueueDetail.json() as { queue: QueueDetails }).queue.queuePosition,
      2,
    );

    const otherList = await requestFrom("198.51.100.2", "/jobs");
    assert.deepEqual(await otherList.json(), []);
    assert.equal(
      (await requestFrom("198.51.100.2", `/jobs/${privateJobId}`)).status,
      404,
    );
    for (const endpoint of [
      `/jobs/${privateJobId}/preview`,
      `/jobs/${privateJobId}/download`,
      `/jobs/${privateJobId}/files/result.html`,
      `/jobs/${privateJobId}/events`,
    ]) {
      assert.equal((await requestFrom("198.51.100.2", endpoint)).status, 404);
    }
    const unauthorizedVersionedFile = await requestFrom(
      "198.51.100.2",
      `/jobs/${privateJobId}/files/result.html?v=123`,
    );
    assert.equal(unauthorizedVersionedFile.status, 404);
    assert.equal(
      unauthorizedVersionedFile.headers.get("cache-control"),
      "private, no-store",
    );
    const ownerVersionedFile = await requestFrom(
      "203.0.113.8",
      `/jobs/${privateJobId}/files/result.html?v=123`,
      { headers: { Cookie: ownerClientCookie } },
    );
    assert.equal(ownerVersionedFile.status, 200);
    assert.equal(
      ownerVersionedFile.headers.get("cache-control"),
      "private, no-store",
    );
    const ownerCompareFile = await requestFrom(
      "203.0.113.8",
      `/jobs/${privateJobId}/files/design.compare.html?v=123`,
      { headers: { Cookie: ownerClientCookie } },
    );
    assert.equal(ownerCompareFile.status, 200);
    assert.equal(ownerCompareFile.headers.get("cache-control"), "private, no-store");
    const optimizedCompareHtml = await ownerCompareFile.text();
    assert.match(optimizedCompareHtml, /src="\.\/artifacts\/svg\.png\?v=123"/);
    assert.match(optimizedCompareHtml, /data-fallback-src="\.\/design\.svg\?v=123"/);
    assert.match(optimizedCompareHtml, /高保真稿加载中/);
    assert.equal(
      (
        await requestFrom("198.51.100.2", `/jobs/${privateJobId}/start`, {
          body: "{}",
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await requestFrom("198.51.100.2", `/jobs/${privateJobId}/messages`, {
          body: JSON.stringify({ moduleId: "main", text: "hello" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
      ).status,
      404,
    );

    const deletablePrivateJobId = privateJobIds[1]!;
    const ownerPrivateDelete = await requestFrom(
      "203.0.113.8",
      `/jobs/${deletablePrivateJobId}`,
      { headers: { Cookie: ownerClientCookie }, method: "DELETE" },
    );
    assert.equal(ownerPrivateDelete.status, 200);
    assert.deepEqual(await ownerPrivateDelete.json(), {
      deleted: true,
      jobId: deletablePrivateJobId,
    });
    assert.equal(jobs.has(deletablePrivateJobId), false);

    const showcaseRuntime = await requestFrom("203.0.113.10", "/runtime");
    const showcaseClientCookie = (showcaseRuntime.headers.get("set-cookie") ?? "")
      .split(";", 1)[0] ?? "";
    const showcaseUpload = await uploadFrom("203.0.113.10", {
      clientCookie: showcaseClientCookie,
      showcase: true,
    });
    assert.equal(showcaseUpload.status, 202);
    const showcasePayload = await showcaseUpload.json() as {
      job: { accessMode: string; isShowcase: boolean };
      jobId: string;
      quota: { remaining: number; used: number };
    };
    assert.equal(showcasePayload.job.accessMode, "owner");
    assert.equal(showcasePayload.job.isShowcase, true);
    assert.equal(showcasePayload.quota.used, 1);
    assert.equal(showcasePayload.quota.remaining, 1);
    const ownerShowcaseDelete = await requestFrom(
      "203.0.113.10",
      `/jobs/${showcasePayload.jobId}`,
      { method: "DELETE" },
    );
    assert.equal(ownerShowcaseDelete.status, 403);
    assert.equal(
      (await ownerShowcaseDelete.json() as { error: string }).error,
      "示例任务不能删除",
    );
    assert.equal(jobs.has(showcasePayload.jobId), true);

    const showcaseList = await requestFrom("198.51.100.2", "/jobs");
    const visible = await showcaseList.json() as Array<{
      accessMode: string;
      id: string;
      isShowcase: boolean;
    }>;
    assert.deepEqual(
      visible.map(({ accessMode, id, isShowcase }) => ({ accessMode, id, isShowcase })),
      [{ accessMode: "showcase", id: showcasePayload.jobId, isShowcase: true }],
    );
    assert.equal(
      (await requestFrom("198.51.100.2", `/jobs/${showcasePayload.jobId}`)).status,
      200,
    );
    assert.equal(
      (
        await requestFrom("198.51.100.2", `/jobs/${showcasePayload.jobId}/start`, {
          body: "{}",
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await requestFrom("198.51.100.2", `/jobs/${showcasePayload.jobId}/messages`, {
          body: JSON.stringify({ moduleId: "main", text: "hello" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
      ).status,
      403,
    );
    const viewerShowcaseDelete = await requestFrom(
      "198.51.100.2",
      `/jobs/${showcasePayload.jobId}`,
      { method: "DELETE" },
    );
    assert.equal(viewerShowcaseDelete.status, 403);
    assert.equal(
      (await viewerShowcaseDelete.json() as { error: string }).error,
      "示例任务不能删除",
    );

    const secondShowcaseUpload = await uploadFrom("203.0.113.10", {
      clientCookie: showcaseClientCookie,
      showcase: true,
    });
    assert.equal(secondShowcaseUpload.status, 202);
    const blockedShowcaseUpload = await uploadFrom("203.0.113.10", {
      clientCookie: showcaseClientCookie,
      showcase: true,
    });
    assert.equal(blockedShowcaseUpload.status, 429);
    const blockedShowcaseQuota = (await blockedShowcaseUpload.json() as {
      quota: { date: string; limit: number; remaining: number; used: number };
    }).quota;
    assert.match(blockedShowcaseQuota.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(
      {
        limit: blockedShowcaseQuota.limit,
        remaining: blockedShowcaseQuota.remaining,
        used: blockedShowcaseQuota.used,
      },
      { limit: 2, remaining: 0, used: 2 },
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const adminUpload = await uploadFrom("192.0.2.10", { adminCookie });
      assert.equal(adminUpload.status, 202);
      const adminUploadPayload = await adminUpload.json() as {
        job: { accessMode: string };
        quota: { remaining: number; used: number };
      };
      assert.equal(adminUploadPayload.job.accessMode, "admin");
      assert.equal(adminUploadPayload.quota.remaining, 2);
      assert.equal(adminUploadPayload.quota.used, 0);
    }

    const adminPrivateDelete = await requestFrom(
      "192.0.2.10",
      `/jobs/${privateJobId}`,
      { headers: { Cookie: adminCookie }, method: "DELETE" },
    );
    assert.equal(adminPrivateDelete.status, 200);
    assert.equal(jobs.has(privateJobId), false);

    const adminShowcaseDelete = await requestFrom(
      "192.0.2.10",
      `/jobs/${showcasePayload.jobId}`,
      { headers: { Cookie: adminCookie }, method: "DELETE" },
    );
    assert.equal(adminShowcaseDelete.status, 200);
    assert.equal(jobs.has(showcasePayload.jobId), false);

    const endAdminSession = await requestFrom("192.0.2.10", "/admin/session", {
      headers: { Cookie: adminCookie },
      method: "DELETE",
    });
    assert.equal(endAdminSession.status, 200);
    assert.match(endAdminSession.headers.get("set-cookie") ?? "", /Max-Age=0/);
  } finally {
    await close(gatewayServer);
    await close(coreServer);
    await rm(directory, { force: true, recursive: true });
  }
});

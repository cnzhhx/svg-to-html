import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFile } from "node:fs/promises";

export const mockJob = (id: string, designName = id) => ({
  id, jobId: id, designName, createdAt: Date.now(), updatedAt: Date.now(),
  outputFormat: "html", status: "completed", activeStep: null,
  steps: { agent: { status: "completed" }, verify: { status: "completed" } },
  result: { diffRatio: 0.0433, renderPngPath: "artifacts/render.png", svgPngPath: "artifacts/svg.png", sourceEntryPath: "result.html", renderEntryPath: "result.html" },
  messages: [], logs: [],
});
export const listen = (server: Server) => new Promise<number>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    const address = server.address();
    if (!address || typeof address === "string") reject(Error("No listening address"));
    else resolve(address.port);
  });
});
export const closeServer = (server: Server) => new Promise<void>((resolve, reject) => {
  server.closeAllConnections();
  server.close(error => error ? reject(error) : resolve());
});

export async function createMockCore() {
  const jobs = new Map<string, ReturnType<typeof mockJob>>();
  const control = { rejectUploads: false, sequence: 0, streamCount: 0, listRequests: 0, queueSettingsStatus: 200 };
  let queueSettings = { revision: 1, maxConcurrentJobs: 1 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/health") { res.end("ok"); return; }
    if (url.pathname === "/api/queue/settings") {
      if (control.queueSettingsStatus !== 200) { json({ error: "queue settings unavailable" }, control.queueSettingsStatus); return; }
      if (req.method === "PUT") {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const next = JSON.parse(Buffer.concat(chunks).toString());
        if (next.revision !== queueSettings.revision) { json({ error: "stale settings" }, 409); return; }
        queueSettings = { revision: next.revision + 1, maxConcurrentJobs: next.maxConcurrentJobs };
      }
      json(queueSettings); return;
    }
    if (url.pathname === "/api/jobs") {
      if (req.method === "POST") {
        for await (const _ of req) { /* drain upload */ }
        if (control.rejectUploads) { json({ error: "mock unavailable" }, 503); return; }
        const job = mockJob(`job-${++control.sequence}`, `设计稿 ${control.sequence}`);
        jobs.set(job.id, job); json(job, 202); return;
      }
      control.listRequests++;
      json([...jobs.values()]); return;
    }
    const match = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(.*))?$/);
    const job = match ? jobs.get(decodeURIComponent(match[1]!)) : null;
    if (!match || !job) { json({ error: "Not found" }, 404); return; }
    const suffix = match[2] ?? "";
    if (!suffix) {
      if (req.method === "DELETE") { jobs.delete(job.id); json({ deleted: true, jobId: job.id }); }
      else json(job);
    } else if (suffix === "events" || suffix === "files/slow.bin") {
      control.streamCount++;
      res.writeHead(200, { "Content-Type": suffix === "events" ? "text/event-stream" : "application/octet-stream" });
      const chunk = suffix === "events" ? `data: ${JSON.stringify({ type: "init", job })}\n\n` : "chunk\n";
      res.write(chunk);
      const timer = setInterval(() => res.write(suffix === "events" ? ": heartbeat\n\n" : chunk), 100);
      res.once("close", () => { clearInterval(timer); control.streamCount--; });
    } else if (suffix === "start" || suffix === "messages") {
      json({ jobId: job.id, status: job.status }, suffix === "messages" ? 202 : 200);
    } else if (suffix.endsWith(".png")) {
      try {
        const source = suffix.includes("svg") ? "comparison-4.33-source.png" : "comparison-4.33-html.png";
        const bytes = await readFile(new URL(`../../../example/assets/${source}`, import.meta.url));
        res.writeHead(200, { "Content-Type": "image/png" }); res.end(bytes);
      } catch { json({ error: "Missing sample image" }, 404); }
    } else if (suffix === "download") {
      res.writeHead(200, { "Content-Type": "application/zip" }); res.end("mock zip");
    } else {
      res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><h1>Mock conversion preview</h1>");
    }
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}`, jobs, control };
}

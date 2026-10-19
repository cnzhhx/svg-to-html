import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import express from "express";
import { listen, closeServer } from "./helpers/mock-core.js";
import { ARTIFACT_CSP } from "../src/access/artifact-security.js";
import { createIsolatedArtifactUrl } from "../../frontend/src/utils/artifact-preview.js";

test("artifact boundaries reject traversal and allow preview scripts with connection restrictions", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "artifact-security-"));
  const coreRequests: string[] = [];
  const attack = `<!doctype html><html><body><h1>Preview</h1>
    <img id="sample" src="./pixel.svg"><script>
    window.probe = { ran: true };
    try { window.probe.cookie = document.cookie; } catch { window.probe.cookieBlocked = true; }
    try { window.probe.storage = parent.localStorage.length; } catch { window.probe.storageBlocked = true; }
    Promise.all([
      fetch('/transformer/api/admin/settings', {credentials:'include'})
        .then(r=>r.text()).then(v=>window.probe.read=v).catch(()=>window.probe.readBlocked=true),
      fetch('/transformer/api/jobs/owned/start', {method:'POST', credentials:'include', mode:'no-cors'})
        .then(()=>window.probe.write=true).catch(()=>window.probe.writeBlocked=true)
    ]).finally(()=>window.probe.done=true);
    </script>
    <div id="design" style="width:750px;height:1624px;transform-origin:0 0"></div>
    <script type="module">
      document.body.dataset.moduleReady = 'true';
      const fit = () => document.querySelector('#design').style.transform = 'scale(' + innerWidth / 750 + ')';
      addEventListener('resize', fit); fit();
    </script></body></html>`;
  const core = createServer((req, res) => {
    coreRequests.push(req.url!);
    if (req.url!.endsWith("pixel.svg")) {
      res.setHeader("Content-Type", "image/svg+xml");
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>');
    } else {
      res.setHeader("Content-Type", "text/html"); res.end(attack);
    }
  });
  process.env.ENV_FILE = "/dev/null";
  process.env.SVG_TRANSFORM_CORE_URL = `http://127.0.0.1:${await listen(core)}`;
  process.env.SVG_TO_HTML_ACCESS_STATE_PATH = path.join(dir, "access-state.json");
  process.env.SVG_TO_HTML_SHOWCASE_JOB_IDS = "";
  process.env.SVG_TO_HTML_ADMIN_KEY = "security-test-legacy-key-0123456789012345";
  const { default: routes } = await import("../src/routes/jobs.js");
  const { getJobAccessStore } = await import("../src/access/job-access.js");
  const { clientKeyForToken } = await import("../src/access/client-session.js");
  const token = "a".repeat(64);
  const cookie = `svg_to_html_client=${token}`;
  await getJobAccessStore().registerJob("127.0.0.1", "owned", false, clientKeyForToken(token));
  await getJobAccessStore().registerJob("127.0.0.2", "victim", false, clientKeyForToken("b".repeat(64)));
  const app = express(); app.use(express.json()); app.use("/transformer/api", routes);
  app.get("/transformer/test-host", (_req, res) => res.type("html").send("<!doctype html><title>Test host</title>"));
  const server = createServer(app);
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => { await closeServer(server); await closeServer(core); await rm(dir, { recursive: true, force: true }); });
  // Raw HTTP paths prevent the test client from normalizing the attack away.
  const get = (suffix: string) => new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
    request({ hostname: "127.0.0.1", port, path: `/transformer/api${suffix}`, headers: { Cookie: cookie } }, res => {
      let body = ""; res.on("data", chunk => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on("error", reject).end();
  });

  await t.test("encoded traversal never reaches Core; valid nested and Unicode paths still work", async () => {
    assert.equal((await get("/jobs/victim/files/result.html")).status, 404);
    const before = coreRequests.length;
    for (const suffix of [
      "../result.html", "..%2f..%2fvictim%2ffiles%2fresult.html",
      "%2e%2e/%2e%2e/victim/files/result.html", "..%5c..%5cvictim/result.html",
      "%252e%252e%252fresult.html", "nested//result.html", "bad%00.html",
    ]) assert.equal((await get(`/jobs/owned/files/${suffix}`)).status, 400, suffix);
    for (const id of ["..", "%2e%2e", "owned%2f..%2fvictim", "%252e%252e", "owned%5cvictim"]) {
      assert.equal((await get(`/jobs/${id}/preview`)).status, 400, id);
    }
    assert.equal(coreRequests.length, before);
    assert.equal((await get("/jobs/owned/files/nested/%E8%AE%BE%E8%AE%A1%20%E7%A8%BF.html")).status, 200);
    assert.equal(coreRequests.at(-1), "/api/jobs/owned/files/nested/%E8%AE%BE%E8%AE%A1%20%E7%A8%BF.html");
  });
  await t.test("HTML and SVG responses carry sandbox policy, including direct previews", async () => {
    for (const suffix of ["preview", "files/result.html", "files/result.compare.html", "files/pixel.svg"]) {
      const res = await get(`/jobs/owned/${suffix}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-security-policy"], ARTIFACT_CSP);
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["referrer-policy"], "no-referrer");
    }
  });
  await t.test("opaque-origin and cross-site job writes are rejected before Core", async () => {
    const before = coreRequests.length;
    for (const [suffix, method] of [["", "POST"], ["/owned/start", "POST"], ["/owned/messages", "POST"], ["/owned", "DELETE"]]) {
      for (const headers of [{ Origin: "null", "X-Requested-With": "svg-to-html" }, { Origin: "https://untrusted.example", "X-Requested-With": "svg-to-html" }, {}]) {
        const res = await fetch(`${origin}/transformer/api/jobs${suffix}`, { method, headers: { Cookie: cookie, ...headers } });
        assert.equal(res.status, 403);
      }
    }
    assert.equal(coreRequests.length, before);
  });
  await t.test("cached previews use a fixed sandbox wrapper without injecting document content", async () => {
    const url = createIsolatedArtifactUrl("blob:https://example.com/test");
    try {
      const html = await (await fetch(url)).text();
      assert.match(html, /sandbox="allow-same-origin allow-scripts"/);
      assert.match(html, /script-src 'self' 'unsafe-inline' blob:/);
      assert.match(html, /connect-src 'none'/);
      assert.throws(() => createIsolatedArtifactUrl("javascript:alert(1)"));
    } finally { URL.revokeObjectURL(url); }
  });
  await t.test("online and cached preview scripts run and resize while direct API fetches stay blocked", {
    skip: !process.env.ARTIFACT_TEST_PLAYWRIGHT_PATH,
  }, async () => {
    const { chromium } = await import(pathToFileURL(process.env.ARTIFACT_TEST_PLAYWRIGHT_PATH!).href);
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const context = await browser.newContext();
      await context.addCookies([{ name: "svg_to_html_client", value: token, url: origin + "/transformer/", httpOnly: true, sameSite: "Strict" }]);
      const login = await context.request.post(origin + "/transformer/api/admin/session", {
        headers: { "X-Requested-With": "svg-to-html", Origin: origin }, data: { key: process.env.SVG_TO_HTML_ADMIN_KEY },
      });
      assert.equal(login.status(), 200);
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const assertProbe = async (frame: any) => {
        assert.equal(await frame.locator("h1").textContent(), "Preview");
        await frame.waitForFunction(() => (window as any).probe?.done && document.body.dataset.moduleReady === 'true');
        const probe = await frame.evaluate(() => (window as any).probe);
        assert.equal(probe.ran, true);
        assert.equal(probe.readBlocked, true);
        assert.equal(probe.writeBlocked, true);
        assert.equal(probe.read, undefined);
        assert.equal(probe.write, undefined);
        await frame.waitForFunction(() => Math.abs(document.querySelector('#design')!.getBoundingClientRect().width - innerWidth) < 1);
      };
      await page.goto(origin + "/transformer/api/jobs/owned/files/result.html");
      await assertProbe(page);
      await page.setViewportSize({ width: 388, height: 840 });
      await assertProbe(page);
      await page.waitForFunction(() => (document.querySelector("#sample") as HTMLImageElement)?.naturalWidth === 20);
      await page.goto(origin + "/transformer/test-host");
      const artifact = await page.evaluate((source: string) => URL.createObjectURL(new Blob([source], { type: "text/html" })), attack);
      const wrapper = createIsolatedArtifactUrl(artifact);
      const html = await (await fetch(wrapper)).text(); URL.revokeObjectURL(wrapper);
      const url = await page.evaluate((source: string) => URL.createObjectURL(new Blob([source], { type: "text/html" })), html);
      // Production opens a new tab; the creator must remain alive so its blob
      // URLs (including image/style assets) are not revoked on document unload.
      const cachedPage = await context.newPage();
      cachedPage.setDefaultTimeout(10_000);
      await cachedPage.goto(url);
      await cachedPage.waitForSelector("iframe");
      const frame = cachedPage.frames().find((f: any) => f !== cachedPage.mainFrame());
      assert.ok(frame); await assertProbe(frame);
      await cachedPage.setViewportSize({ width: 388, height: 840 });
      await assertProbe(frame);
      assert.equal(coreRequests.some(p => p.endsWith("/start")), false);
      await context.close();
    } finally { await browser.close(); }
  });
});

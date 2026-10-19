import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listen, closeServer } from "./helpers/mock-core.js";

test("real gateway starts without Core, persists admin settings across restart, and supports local recovery", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gateway-startup-"));
  const backend = fileURLToPath(new URL("..", import.meta.url));
  const probe = createServer(); const port = await listen(probe); await closeServer(probe);
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, ENV_FILE: "/dev/null", PORT: String(port), SVG_TRANSFORM_CORE_URL: "http://127.0.0.1:1", SVG_TO_HTML_ACCESS_STATE_PATH: path.join(dir, "access-state.json"), SVG_TO_HTML_ADMIN_KEY: "", SVG_TRANSFORM_CORE_MODEL_CONFIG: path.join(dir, "no-model.json"), SVG_TO_HTML_DAILY_UPLOAD_LIMIT: "5", SVG_TO_HTML_SHOWCASE_JOB_IDS: "" };
  let child: ReturnType<typeof spawn> | undefined;
  let output = "";
  const start = async () => {
    child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: backend, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", data => { output += data; }); child.stderr?.on("data", data => { output += data; });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw Error(output);
      try { const health = await fetch(origin + "/transformer/health"); if (health.ok) return; } catch { /* wait for listener */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error("Gateway did not start: " + output);
  };
  const stop = async () => {
    if (child && child.exitCode === null) await new Promise<void>(resolve => { child!.once("exit", () => resolve()); child!.kill("SIGTERM"); });
  };
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  const request = (endpoint: string, cookie = "", method = "GET", body?: unknown) => fetch(origin + "/transformer/api" + endpoint, {
    method, headers: { Cookie: cookie, Origin: origin, "X-Requested-With": "svg-to-html", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const localToken = (mode: string) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/admin.ts", mode], { cwd: backend, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.match(/\b[a-f0-9]{48}\b/)![0];
  };
  const token = localToken("setup");
  await start();
  assert.equal((await request("/jobs")).status, 503);
  const initial = await (await request("/setup")).json();
  const setup = await request("/setup", "", "POST", { token, username: "serveradmin", password: "first-password-123", settings: initial.settings });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.getSetCookie()[0]!.split(";")[0]!;
  const settings = await (await request("/admin/settings", cookie)).json();
  assert.equal((await request("/admin/settings", cookie, "PUT", { ...settings, settings: { ...settings.settings, dailyUploadLimit: 11 } })).status, 200);
  await stop(); await start();
  assert.equal((await request("/admin/settings", cookie)).status, 401);
  assert.equal((await (await request("/runtime")).json()).uploadQuota.limit, 11);
  const login = await request("/admin/session", "", "POST", { username: "serveradmin", password: "first-password-123" });
  assert.equal(login.status, 200);
  const recoveryToken = localToken("recovery");
  assert.equal((await request("/admin/recovery", "", "POST", { token: recoveryToken, password: "recovered-password-123" })).status, 200);
  assert.equal((await request("/admin/settings", login.headers.getSetCookie()[0]!.split(";")[0]!)).status, 401);
  assert.equal((await request("/admin/session", "", "POST", { username: "serveradmin", password: "recovered-password-123" })).status, 200);
});

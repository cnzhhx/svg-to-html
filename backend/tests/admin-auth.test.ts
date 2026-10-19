import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Request, Response } from "express";
import { AdminAuth, verifyPassword } from "../src/access/admin-auth.js";
import { GatewayStore, defaultGatewayState } from "../src/settings/gateway-store.js";

function client(body: Record<string, unknown> = {}, cookie = "") {
  const cookies: string[] = [];
  return {
    req: { body, headers: { cookie }, secure: false } as Request,
    res: { append: (_name: string, value: string) => cookies.push(value) } as unknown as Response,
    cookies,
  };
}

test("one-time setup, password sessions, recovery, migration, restart and logout invalidate credentials correctly", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gateway-auth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new GatewayStore(path.join(dir, "state.json"), defaultGatewayState);
  const auth = new AdminAuth(store, () => undefined);
  const token = await store.issueToken("setup");
  const settings = (await store.read()).settings;
  const data = { username: "admin", password: "correct-password-123", settings, token };
  const bad = client({ ...data, token: "wrong" });
  await assert.rejects(auth.setup(bad.req, bad.res), /初始化码/);
  await store.mutate(s => { s.bootstrap!.expiresAt = 0; });
  const expired = client(data);
  await assert.rejects(auth.setup(expired.req, expired.res), /初始化码/);
  data.token = await store.issueToken("setup");
  const setup = client(data);
  await auth.setup(setup.req, setup.res);
  assert.equal((await auth.status(setup.req)).adminMode, true);
  await assert.rejects(auth.setup(setup.req, setup.res), /已创建/);
  await assert.rejects(store.issueToken("setup"));
  assert.equal(await verifyPassword(data.password, (await store.read()).admin!.passwordHash), true);
  const persisted = await readFile(store.statePath, "utf8");
  assert.equal(persisted.includes(data.password), false);
  assert.equal(persisted.includes(data.token), false);
  assert.equal(persisted.includes(setup.cookies[0]!.split(";")[0]!.split("=")[1]!), false);
  assert.equal((await new AdminAuth(store, () => undefined).status(setup.req)).adminMode, false);
  const second = client({ username: "admin", password: data.password });
  await auth.login(second.req, second.res);
  setup.req.body = { currentPassword: data.password, password: "new-password-123" };
  await auth.changePassword(setup.req, setup.res);
  assert.equal((await auth.status(second.req)).adminMode, false);
  await assert.rejects(auth.login(second.req, second.res), /账号或密码/);
  const recovered = client({ token: await store.issueToken("recovery"), password: "recovered-password" });
  await auth.recover(recovered.req, recovered.res);
  await assert.rejects(auth.recover(recovered.req, recovered.res), /恢复码/);
  const login = client({ username: "admin", password: "recovered-password" });
  await auth.login(login.req, login.res);
  assert.equal((await auth.status(login.req)).adminMode, true);
  auth.logout(login.req, login.res);
  assert.equal((await auth.status(login.req)).adminMode, false);

  const legacyStore = new GatewayStore(path.join(dir, "legacy.json"), defaultGatewayState);
  const legacy = new AdminAuth(legacyStore, () => "old-key");
  const owner = client({ key: "old-key" });
  const oldSession = client({ key: "old-key" });
  await legacy.login(owner.req, owner.res); await legacy.login(oldSession.req, oldSession.res);
  owner.req.body = { ...data, token: "" };
  await legacy.setup(owner.req, owner.res);
  assert.equal((await legacy.status(oldSession.req)).adminMode, false);
  await assert.rejects(legacy.login(oldSession.req, oldSession.res));
  assert.equal((await legacy.status(owner.req)).legacyAvailable, false);
});

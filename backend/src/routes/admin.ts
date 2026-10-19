import { Router } from "express";
import { getAdminAuth, rateLimit, requireSameOrigin } from "../access/admin-auth.js";
import { GatewayError, getGatewayStore } from "../settings/gateway-store.js";
import { sendCoreError } from "../core-service/client.js";
import { requestQueueSettings } from "../core-service/queue-settings.js";
import type { Request, Response } from "express";

const router = Router();
router.use((_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); res.vary("Cookie"); next(); });
export const handleAdminError = (res: Response, error: unknown) => {
  if (error instanceof GatewayError) res.status(error.status).json({ error: error.message });
  else sendCoreError(res, new Error("管理数据读取或保存失败，请检查服务器运行数据与权限"));
};
const wrap = (handler: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "private, no-store");
  try { await handler(req, res); } catch (error) { handleAdminError(res, error); }
};
const auth = () => getAdminAuth();
const loginLimit = rateLimit(10, 15 * 60_000);
router.get("/admin/session", wrap(async (req, res) => { res.json(await auth().status(req)); }));
router.post("/admin/session", requireSameOrigin, loginLimit, wrap(async (req, res) => {
  await auth().login(req, res); res.json(await auth().status(req));
}));
router.delete("/admin/session", requireSameOrigin, wrap(async (req, res) => { auth().logout(req, res); res.json({ adminMode: false }); }));
router.get("/setup", wrap(async (req, res) => {
  const status = await auth().status(req);
  const state = await getGatewayStore().read();
  res.json({ ...status, ...(!status.initialized ? { settings: state.settings } : {}) });
}));
router.post("/setup", requireSameOrigin, loginLimit, wrap(async (req, res) => {
  await auth().setup(req, res); res.status(201).json(await auth().status(req));
}));
router.post("/admin/recovery", requireSameOrigin, loginLimit, wrap(async (req, res) => {
  await auth().recover(req, res); res.json({ ok: true });
}));
router.use("/admin", async (req, res, next) => {
  try {
    if (!(await auth().status(req)).adminMode) { res.status(401).json({ error: "请先登录管理员账号" }); return; }
    next();
  } catch (error) { handleAdminError(res, error); }
});
router.get("/admin/settings", wrap(async (_req, res) => {
  const state = await getGatewayStore().read(); res.json({ revision: state.revision, settings: state.settings });
}));
const writeLimit = rateLimit(60, 60_000);
router.get("/admin/queue-settings", wrap(async (_req, res) => {
  res.json(await requestQueueSettings());
}));
router.put("/admin/queue-settings", requireSameOrigin, writeLimit, wrap(async (req, res) => {
  const { revision, maxConcurrentJobs } = req.body ?? {};
  if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isInteger(maxConcurrentJobs) || maxConcurrentJobs < 1 || maxConcurrentJobs > 32) {
    throw new GatewayError(400, "同时执行的 session 数必须是 1–32 的整数，且需提供有效的设置版本");
  }
  res.json(await requestQueueSettings({ revision, maxConcurrentJobs }));
}));
router.put("/admin/settings", requireSameOrigin, writeLimit, wrap(async (req, res) => {
  if (!Number.isSafeInteger(req.body?.revision)) throw new GatewayError(400, "缺少设置版本号");
  const state = await getGatewayStore().saveSettings(req.body.settings, req.body.revision);
  res.json({ revision: state.revision, settings: state.settings });
}));
router.put("/admin/password", requireSameOrigin, writeLimit, wrap(async (req, res) => {
  await auth().changePassword(req, res); res.json({ ok: true });
}));
export default router;

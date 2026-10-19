import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response, RequestHandler } from "express";
import { getBackendConfig } from "../config/index.js";
import { GatewayError, getGatewayStore, tokenHash, validateSettings } from "../settings/gateway-store.js";
import type { GatewayStore } from "../settings/gateway-store.js";

const scrypt = promisify(scryptCallback);
const COOKIE = "svg_to_html_admin";
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(tokenHash(a), "hex"), Buffer.from(tokenHash(b), "hex"));
export function readAdminCookie(req: Request) {
  return req.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? "";
}
function cookie(req: Request, res: Response, value: string, clear = false) {
  res.append("Set-Cookie", `${COOKIE}=${value}; Path=/transformer; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : MAX_AGE / 1000}${req.secure ? "; Secure" : ""}`);
}
export async function hashPassword(password: string) {
  if (typeof password !== "string" || password.length < 12 || password.length > 256) throw new GatewayError(400, "密码长度须为 12–256 个字符");
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${hash.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  if (typeof password !== "string" || password.length > 256) return false;
  const [, salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  return timingSafeEqual(await scrypt(password, salt, 64) as Buffer, Buffer.from(hash, "hex"));
}
export class AdminAuth {
  private sessions = new Map<string, { generation: string; expiresAt: number }>();
  constructor(readonly store: GatewayStore, private legacyKey = () => getBackendConfig().admin.key) {}
  async status(req: Request) {
    const state = await this.store.read();
    const session = this.sessions.get(tokenHash(readAdminCookie(req)));
    const generation = state.admin?.generation ?? "legacy";
    const authenticated = Boolean(session && session.generation === generation && session.expiresAt > Date.now() && (state.admin || this.legacyKey()));
    return { initialized: Boolean(state.admin), adminMode: authenticated, legacyAvailable: !state.admin && Boolean(this.legacyKey()), username: authenticated ? state.admin?.username ?? "legacy-admin" : undefined };
  }
  private start(req: Request, res: Response, generation: string) {
    for (const [key, session] of this.sessions) if (session.expiresAt <= Date.now()) this.sessions.delete(key);
    const token = randomBytes(32).toString("hex");
    this.sessions.set(tokenHash(token), { generation, expiresAt: Date.now() + MAX_AGE });
    cookie(req, res, token);
    req.headers.cookie = [...(req.headers.cookie?.split(";").filter(v => !v.trim().startsWith(`${COOKIE}=`)) ?? []), `${COOKIE}=${token}`].join("; ");
  }
  async login(req: Request, res: Response) {
    const state = await this.store.read();
    if (state.admin) {
      const valid = await verifyPassword(req.body?.password, state.admin.passwordHash);
      if (req.body?.username !== state.admin.username || !valid) throw new GatewayError(403, "账号或密码错误");
      this.start(req, res, state.admin.generation);
    } else {
      const key = this.legacyKey();
      if (!key || typeof req.body?.key !== "string" || !equal(req.body.key, key)) throw new GatewayError(403, "管理员密钥无效");
      this.start(req, res, "legacy");
    }
  }
  logout(req: Request, res: Response) {
    this.sessions.delete(tokenHash(readAdminCookie(req)));
    cookie(req, res, "", true);
    this.store.changes.emit("change");
  }
  async setup(req: Request, res: Response) {
    const username = String(req.body?.username ?? "").trim();
    if (!/^[a-zA-Z0-9_.@-]{3,80}$/.test(username)) throw new GatewayError(400, "账号须为 3–80 位字母、数字或 _.@- 字符");
    const passwordHash = await hashPassword(req.body?.password);
    const legacyAdmin = (await this.status(req)).adminMode;
    const settings = validateSettings(req.body?.settings);
    const generation = randomUUID();
    await this.store.mutate(state => {
      if (state.admin) throw new GatewayError(409, "管理员已创建，请登录");
      const bootstrap = state.bootstrap;
      if (!legacyAdmin && (!bootstrap || bootstrap.purpose !== "setup" || bootstrap.expiresAt <= Date.now() || !equal(tokenHash(String(req.body?.token ?? "")), bootstrap.hash))) throw new GatewayError(403, "初始化码无效或已过期");
      state.admin = { username, passwordHash, generation };
      state.settings = settings;
      state.bootstrap = null;
    });
    this.sessions.clear();
    this.start(req, res, generation);
  }
  async changePassword(req: Request, res: Response) {
    if (!(await this.status(req)).adminMode) throw new GatewayError(401, "请先登录管理员账号");
    const before = (await this.store.read()).admin;
    if (!before || !await verifyPassword(req.body?.currentPassword, before.passwordHash)) throw new GatewayError(403, "当前密码错误");
    const passwordHash = await hashPassword(req.body?.password);
    await this.store.mutate(state => {
      if (state.admin?.generation !== before.generation) throw new GatewayError(409, "账号已更新，请重新登录");
      state.admin = { ...before, passwordHash, generation: randomUUID() };
    });
    this.sessions.clear();
    cookie(req, res, "", true);
  }
  async recover(req: Request, res: Response) {
    const passwordHash = await hashPassword(req.body?.password);
    await this.store.mutate(state => {
      const bootstrap = state.bootstrap;
      if (!state.admin || !bootstrap || bootstrap.purpose !== "recovery" || bootstrap.expiresAt <= Date.now() || !equal(tokenHash(String(req.body?.token ?? "")), bootstrap.hash)) throw new GatewayError(403, "恢复码无效或已过期");
      state.admin = { ...state.admin, passwordHash, generation: randomUUID() };
      state.bootstrap = null;
    });
    this.sessions.clear();
    cookie(req, res, "", true);
  }
}
let sharedAuth: AdminAuth | undefined;
export const getAdminAuth = () => sharedAuth ??= new AdminAuth(getGatewayStore());
export const isAdminRequest = async (req: Request) => (await getAdminAuth().status(req)).adminMode;

// Custom header plus no CORS support prevents cookie-authenticated cross-site
// writes; compare Origin whenever a browser supplies it (including login).
export const requireSameOrigin: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin;
  const expected = `${req.protocol}://${req.get("host")}`;
  if (req.get("x-requested-with") !== "svg-to-html" || (origin && origin !== expected) || req.get("sec-fetch-site") === "cross-site") {
    res.status(403).json({ error: "请从本站管理页面提交操作" }); return;
  }
  next();
};
export function rateLimit(limit: number, windowMs: number): RequestHandler {
  const attempts = new Map<string, { count: number; until: number }>();
  return (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const entry = attempts.get(key) ?? { count: 0, until: now + windowMs };
    entry.count += 1; attempts.set(key, entry);
    if (entry.count > limit) {
      res.setHeader("Retry-After", Math.ceil((entry.until - now) / 1000));
      res.status(429).json({ error: "操作过于频繁，请稍后重试" }); return;
    }
    next();
  };
}

import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { getBackendConfig } from "../config/index.js";

export type OperatingSettings = {
  accessIsolationEnabled: boolean;
  quotaEnabled: boolean;
  dailyUploadLimit: number;
  timeZone: string;
  maxSvgUploadMb: number;
  estimatedTaskMinutes: number;
  allowUserShowcase: boolean;
};
export type AdminAccount = { username: string; passwordHash: string; generation: string };
export type GatewayState = {
  version: 1;
  revision: number;
  settings: OperatingSettings;
  showcaseOverrides: Record<string, boolean>;
  admin: AdminAccount | null;
  bootstrap: { hash: string; expiresAt: number; purpose: "setup" | "recovery" } | null;
};
export class GatewayError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
const settingKeys = ["accessIsolationEnabled", "quotaEnabled", "dailyUploadLimit", "timeZone", "maxSvgUploadMb", "estimatedTaskMinutes", "allowUserShowcase"] as const;
export function validateSettings(raw: unknown): OperatingSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new GatewayError(400, "设置格式无效");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !(settingKeys as readonly string[]).includes(key))) throw new GatewayError(400, "包含不支持的设置");
  for (const key of ["accessIsolationEnabled", "quotaEnabled", "allowUserShowcase"] as const) {
    if (typeof value[key] !== "boolean") throw new GatewayError(400, `${key} 必须是布尔值`);
  }
  for (const [key, max] of [["dailyUploadLimit", 100000], ["maxSvgUploadMb", 50], ["estimatedTaskMinutes", 1440]] as const) {
    if (!Number.isInteger(value[key]) || Number(value[key]) < 1 || Number(value[key]) > max) throw new GatewayError(400, `${key} 必须是 1–${max} 的整数`);
  }
  if (typeof value.timeZone !== "string" || !value.timeZone.trim()) throw new GatewayError(400, "请选择有效的额度时区");
  try { new Intl.DateTimeFormat("en-US", { timeZone: value.timeZone }).format(); }
  catch { throw new GatewayError(400, "请选择有效的 IANA 时区"); }
  return Object.fromEntries(settingKeys.map(key => [key, value[key]])) as OperatingSettings;
}
function parseState(raw: string): GatewayState {
  const value = JSON.parse(raw) as GatewayState;
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Invalid gateway state version/revision");
  validateSettings(value.settings);
  if (!value.showcaseOverrides || typeof value.showcaseOverrides !== "object" || Array.isArray(value.showcaseOverrides) || Object.values(value.showcaseOverrides).some(v => typeof v !== "boolean")) throw new Error("Invalid showcase state");
  if (value.admin !== null && (!value.admin || typeof value.admin.username !== "string" || !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(value.admin.passwordHash) || typeof value.admin.generation !== "string")) throw new Error("Invalid administrator state");
  if (value.bootstrap !== null && (!value.bootstrap || !/^[a-f0-9]{64}$/.test(value.bootstrap.hash) || !Number.isFinite(value.bootstrap.expiresAt) || !["setup", "recovery"].includes(value.bootstrap.purpose))) throw new Error("Invalid initialization state");
  return value;
}
export class GatewayStore {
  readonly changes = new EventEmitter();
  private initialized: Promise<void> | null = null;
  constructor(readonly statePath: string, private readonly defaults: () => GatewayState, private readonly write: typeof writeFile = writeFile) {
    this.changes.setMaxListeners(0);
  }
  initialize() {
    if (!this.initialized) this.initialized = this.withLock(async () => {
      try { parseState(await readFile(this.statePath, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.persist(parseState(JSON.stringify(this.defaults())));
      }
    });
    return this.initialized;
  }
  async read(): Promise<GatewayState> {
    await this.initialize();
    return parseState(await readFile(this.statePath, "utf8"));
  }
  async mutate<T>(operation: (state: GatewayState) => T | Promise<T>, revision?: number): Promise<T> {
    await this.initialize();
    const result = await this.withLock(async () => {
      const state = parseState(await readFile(this.statePath, "utf8"));
      if (revision !== undefined && revision !== state.revision) throw new GatewayError(409, "设置已被其他管理员更新，请重新加载后再保存");
      const result = await operation(state);
      state.revision += 1;
      await this.persist(state);
      return result;
    });
    this.changes.emit("change");
    return result;
  }
  async saveSettings(settings: unknown, revision: number) {
    const validated = validateSettings(settings);
    await this.mutate(state => { state.settings = validated; }, revision);
    return this.read();
  }
  async issueToken(purpose: "setup" | "recovery") {
    const token = randomBytes(24).toString("hex");
    await this.mutate(state => {
      if (purpose === "setup" && state.admin) throw new GatewayError(409, "管理员已创建，请使用密码恢复命令");
      if (purpose === "recovery" && !state.admin) throw new GatewayError(409, "管理员尚未创建，请使用初始化命令");
      state.bootstrap = { hash: tokenHash(token), expiresAt: Date.now() + 15 * 60_000, purpose };
    });
    return token;
  }
  private async persist(state: GatewayState) {
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.write(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, this.statePath);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  // The local recovery command and gateway can write concurrently. Re-read
  // under a file lock instead of overwriting new credentials from a cache.
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const lockPath = `${this.statePath}.lock`;
    const deadline = Date.now() + 5000;
    let lock;
    while (!lock) {
      try { lock = await open(lockPath, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new GatewayError(503, "设置文件正在被占用；若进程异常退出，请确认服务停止后清理 .lock 文件");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try { return await operation(); }
    finally { await lock.close(); await unlink(lockPath); }
  }
}
export function defaultGatewayState(): GatewayState {
  const config = getBackendConfig();
  return {
    version: 1, revision: 1,
    settings: {
      accessIsolationEnabled: true, quotaEnabled: true,
      dailyUploadLimit: config.access.dailyUploadLimit, timeZone: config.access.timeZone,
      maxSvgUploadMb: 50, estimatedTaskMinutes: config.queue.estimatedTaskMinutes,
      allowUserShowcase: true,
    },
    showcaseOverrides: Object.fromEntries(config.access.showcaseJobIds.map(id => [id, true])),
    admin: null, bootstrap: null,
  };
}
let sharedStore: GatewayStore | undefined;
export function getGatewayStore() {
  return sharedStore ??= new GatewayStore(
    path.join(path.dirname(getBackendConfig().access.statePath), "gateway-state.json"), defaultGatewayState,
  );
}

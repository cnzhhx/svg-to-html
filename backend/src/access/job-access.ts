import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { getBackendConfig } from "../config/index.js";

type DailyQuota = {
  date: string;
  limit: number;
  remaining: number;
  used: number;
};

type JobAccess = {
  accessMode: "admin" | "owner" | "showcase" | "shared";
  isShowcase: boolean;
};

type StoredJobAccess = {
  clientKeys?: string[];
  createdAt: number;
  ownerKey: string;
  showcase?: boolean;
};

type AccessState = {
  dailyUsage: Record<string, Record<string, number>>;
  jobs: Record<string, StoredJobAccess>;
  version: 1;
};

type JobAccessStoreOptions = {
  dailyUploadLimit: number;
  now?: () => Date;
  showcaseJobIds?: string[];
  statePath: string;
  timeZone: string;
};

type QuotaPolicy = { dailyUploadLimit: number; timeZone: string; quotaEnabled?: boolean };
type VisibilityPolicy = { accessIsolationEnabled: boolean; showcaseOverrides: Record<string, boolean> };

const createEmptyState = (): AccessState => ({
  dailyUsage: {},
  jobs: {},
  version: 1,
});

const MAX_CLIENT_KEYS_PER_JOB = 8;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeClientIp = (value: string | undefined) => {
  let normalized = String(value ?? "").trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);
  if (normalized.startsWith("::ffff:")) normalized = normalized.slice(7);
  return normalized;
};

const ownerKeyForIp = (ip: string) => {
  const normalized = normalizeClientIp(ip);
  if (!normalized) throw new Error("Client IP is unavailable");
  return createHash("sha256").update(normalized).digest("hex");
};

const dateKeyForTimeZone = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const readPart = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${readPart("year")}-${readPart("month")}-${readPart("day")}`;
};

const parseState = (value: unknown): AccessState => {
  if (!isRecord(value) || value["version"] !== 1) {
    throw new Error("Unsupported access state format");
  }

  const dailyUsage: AccessState["dailyUsage"] = {};
  const rawDailyUsage = value["dailyUsage"];
  if (!isRecord(rawDailyUsage)) throw new Error("Invalid access state dailyUsage");
  for (const [date, entries] of Object.entries(rawDailyUsage)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRecord(entries)) {
      throw new Error("Invalid access state dailyUsage entry");
    }
    dailyUsage[date] = {};
    for (const [ownerKey, count] of Object.entries(entries)) {
      if (!ownerKey || !Number.isInteger(count) || Number(count) < 0) {
        throw new Error("Invalid access state usage count");
      }
      dailyUsage[date][ownerKey] = Number(count);
    }
  }

  const jobs: AccessState["jobs"] = {};
  const rawJobs = value["jobs"];
  if (!isRecord(rawJobs)) throw new Error("Invalid access state jobs");
  for (const [jobId, entry] of Object.entries(rawJobs)) {
    if (!jobId || !isRecord(entry)) throw new Error("Invalid access state job entry");
    const ownerKey = entry["ownerKey"];
    const legacyClientKey = entry["clientKey"];
    const rawClientKeys = entry["clientKeys"];
    const createdAt = entry["createdAt"];
    const showcase = entry["showcase"];
    if (
      typeof ownerKey !== "string" ||
      !ownerKey ||
      (legacyClientKey !== undefined &&
        (typeof legacyClientKey !== "string" || !legacyClientKey)) ||
      (rawClientKeys !== undefined &&
        (!Array.isArray(rawClientKeys) ||
          rawClientKeys.some((value) => typeof value !== "string" || !value))) ||
      !Number.isFinite(createdAt) ||
      (showcase !== undefined && typeof showcase !== "boolean")
    ) {
      throw new Error("Invalid access state job fields");
    }
    const clientKeys = [
      ...(typeof legacyClientKey === "string" ? [legacyClientKey] : []),
      ...(Array.isArray(rawClientKeys) ? rawClientKeys : []),
    ].filter((value, index, values) => values.indexOf(value) === index)
      .slice(-MAX_CLIENT_KEYS_PER_JOB);
    jobs[jobId] = {
      ...(clientKeys.length ? { clientKeys } : {}),
      createdAt: Number(createdAt),
      ownerKey,
      ...(showcase ? { showcase: true } : {}),
    };
  }

  return { dailyUsage, jobs, version: 1 };
};

class DailyQuotaExceededError extends Error {
  quota: DailyQuota;

  constructor(quota: DailyQuota) {
    super("今日 SVG 转换次数已用完，请明天再试");
    this.name = "DailyQuotaExceededError";
    this.quota = quota;
  }
}

class JobAccessStore {
  private readonly dailyUploadLimit: number;
  private readonly now: () => Date;
  private readonly showcaseJobIds: Set<string>;
  private readonly statePath: string;
  private readonly timeZone: string;
  private initializePromise: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private state: AccessState = createEmptyState();

  constructor(options: JobAccessStoreOptions) {
    this.dailyUploadLimit = options.dailyUploadLimit;
    this.now = options.now ?? (() => new Date());
    this.showcaseJobIds = new Set(
      (options.showcaseJobIds ?? []).map((value) => value.trim()).filter(Boolean),
    );
    this.statePath = options.statePath;
    this.timeZone = options.timeZone;
  }

  initialize() {
    if (!this.initializePromise) {
      this.initializePromise = this.loadOrCreate();
    }
    return this.initializePromise;
  }

  async getQuota(clientKey: string, policy?: QuotaPolicy): Promise<DailyQuota> {
    await this.initialize();
    await this.mutationQueue;
    return this.readQuota(clientKey, this.state, policy);
  }

  async reserveUpload(clientKey: string, policy?: QuotaPolicy): Promise<DailyQuota> {
    return this.mutate((state) => {
      const quota = this.readQuota(clientKey, state, policy);
      if (policy?.quotaEnabled !== false && quota.remaining < 1) throw new DailyQuotaExceededError(quota);
      const usage = state.dailyUsage[quota.date] ?? {};
      usage[clientKey] = quota.used + 1;
      state.dailyUsage[quota.date] = usage;
      this.pruneDailyUsage(state);
      return this.readQuota(clientKey, state, policy);
    });
  }

  async refundUpload(clientKey: string, reservedDate?: string, policy?: QuotaPolicy): Promise<DailyQuota> {
    return this.mutate((state) => {
      const date = reservedDate ?? this.readQuota(clientKey, state, policy).date;
      const usage = state.dailyUsage[date];
      if (usage && (usage[clientKey] ?? 0) > 0) {
        usage[clientKey] = usage[clientKey]! - 1;
      }
      return this.readQuota(clientKey, state, policy);
    });
  }

  async registerJob(
    ip: string,
    jobId: string,
    showcase: boolean,
    clientKey?: string,
  ) {
    const ownerKey = ownerKeyForIp(ip);
    await this.mutate((state) => {
      state.jobs[jobId] = {
        ...(clientKey ? { clientKeys: [clientKey] } : {}),
        createdAt: this.now().getTime(),
        ownerKey,
        ...(showcase ? { showcase: true } : {}),
      };
    });
  }

  async forgetJob(jobId: string) {
    await this.mutate((state) => {
      delete state.jobs[jobId];
    });
  }

  async bindClientToOwnerJobs(ip: string, clientKey: string) {
    await this.initialize();
    await this.mutationQueue;
    const ownerKey = ownerKeyForIp(ip);
    const needsBinding = Object.values(this.state.jobs).some(
      (entry) =>
        entry.ownerKey === ownerKey && !entry.clientKeys?.length,
    );
    if (!needsBinding) return;
    await this.mutate((state) => {
      for (const entry of Object.values(state.jobs)) {
        if (entry.ownerKey === ownerKey && !entry.clientKeys?.length) {
          entry.clientKeys = [clientKey];
        }
      }
    });
  }

  async getJobAccess(
    ip: string,
    jobId: string,
    clientKey?: string,
    policy?: VisibilityPolicy,
  ): Promise<JobAccess | null> {
    await this.initialize();
    await this.mutationQueue;
    const ownerKey = ownerKeyForIp(ip);
    const stored = this.state.jobs[jobId];
    const isShowcase = Object.hasOwn(policy?.showcaseOverrides ?? {}, jobId)
      ? policy!.showcaseOverrides[jobId]!
      : Boolean(stored?.showcase || (!policy && this.showcaseJobIds.has(jobId)));
    const hasClientBinding = Boolean(stored?.clientKeys?.length);
    if (
      Boolean(clientKey && stored?.clientKeys?.includes(clientKey)) ||
      Boolean(stored && !hasClientBinding && stored.ownerKey === ownerKey)
    ) {
      return { accessMode: "owner", isShowcase };
    }
    return isShowcase ? { accessMode: "showcase", isShowcase: true }
      : policy?.accessIsolationEnabled === false ? { accessMode: "shared", isShowcase: false } : null;
  }

  async getAdminJobAccess(jobId: string, policy?: VisibilityPolicy): Promise<JobAccess> {
    await this.initialize();
    await this.mutationQueue;
    const stored = this.state.jobs[jobId];
    return {
      accessMode: "admin",
      isShowcase: Object.hasOwn(policy?.showcaseOverrides ?? {}, jobId)
        ? policy!.showcaseOverrides[jobId]!
        : Boolean(stored?.showcase || (!policy && this.showcaseJobIds.has(jobId))),
    };
  }

  private async loadOrCreate() {
    try {
      this.state = parseState(JSON.parse(await readFile(this.statePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = createEmptyState();
      await this.persist();
    }
  }

  private readQuota(ownerKey: string, state = this.state, policy?: QuotaPolicy): DailyQuota {
    const date = dateKeyForTimeZone(this.now(), policy?.timeZone ?? this.timeZone);
    const limit = policy?.dailyUploadLimit ?? this.dailyUploadLimit;
    const used = state.dailyUsage[date]?.[ownerKey] ?? 0;
    return {
      date,
      limit,
      remaining: Math.max(0, limit - used),
      used,
    };
  }

  private pruneDailyUsage(state: AccessState) {
    const dates = Object.keys(state.dailyUsage).sort();
    for (const date of dates.slice(0, -14)) delete state.dailyUsage[date];
  }

  private async mutate<T>(mutator: (state: AccessState) => T | Promise<T>) {
    const operation = this.mutationQueue.then(async () => {
      await this.initialize();
      const candidate = structuredClone(this.state);
      const result = await mutator(candidate);
      await this.persist(candidate);
      this.state = candidate;
      return result;
    });
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async persist(state = this.state) {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.statePath);
  }
}

let sharedStore: JobAccessStore | null = null;

const getJobAccessStore = () => {
  if (!sharedStore) {
    const config = getBackendConfig().access;
    sharedStore = new JobAccessStore(config);
  }
  return sharedStore;
};

const initializeJobAccessStore = () => getJobAccessStore().initialize();

export {
  DailyQuotaExceededError,
  JobAccessStore,
  dateKeyForTimeZone,
  getJobAccessStore,
  initializeJobAccessStore,
  normalizeClientIp,
  ownerKeyForIp,
};
export type { DailyQuota, JobAccess, JobAccessStoreOptions };

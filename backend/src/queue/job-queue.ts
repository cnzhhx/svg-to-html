type QueueJob = {
  createdAt?: number;
  executionStartedAt?: number;
  id?: string;
  jobId?: string;
  queuedAt?: number;
  status?: string;
};

type JobQueueDetails = {
  estimatedStartAt: number;
  estimatedTaskMinutes: number;
  estimatedWaitMinutes: number;
  maxConcurrentJobs: number;
  queuePosition: number;
  queuedAhead: number;
  runningJobs: number;
  totalQueued: number;
};

type BuildQueueDetailsOptions = {
  estimatedTaskMinutes: number;
  maxConcurrentJobs: number;
  now?: number;
};

const getJobId = (job: QueueJob) => String(job.jobId || job.id || "").trim();

const readTimestamp = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const compareQueuedJobs = (left: QueueJob, right: QueueJob) => {
  const leftTime = readTimestamp(left.queuedAt, readTimestamp(left.createdAt, 0));
  const rightTime = readTimestamp(right.queuedAt, readTimestamp(right.createdAt, 0));
  if (leftTime !== rightTime) return leftTime - rightTime;
  const createdAtDifference =
    readTimestamp(left.createdAt, 0) - readTimestamp(right.createdAt, 0);
  if (createdAtDifference !== 0) return createdAtDifference;
  return getJobId(left).localeCompare(getJobId(right));
};

const buildJobQueueDetails = (
  jobs: QueueJob[],
  options: BuildQueueDetailsOptions,
) => {
  const now = options.now ?? Date.now();
  const taskMinutes = Math.max(1, Math.floor(options.estimatedTaskMinutes));
  const taskDurationMs = taskMinutes * 60_000;
  const configuredConcurrency = Math.max(1, Math.floor(options.maxConcurrentJobs));
  const running = jobs.filter((job) => job.status === "running");
  const queued = jobs
    .filter((job) => job.status === "queued" && getJobId(job))
    .sort(compareQueuedJobs);
  // When lowering the limit, excess active sessions drain first. Only the
  // last N completions release slots that may accept new work.
  const remaining = running.map(job => {
      const startedAt = readTimestamp(job.executionStartedAt, now);
      return Math.max(0, taskDurationMs - Math.max(0, now - startedAt));
  }).sort((a, b) => a - b);
  const slotAvailableAt = remaining.slice(-configuredConcurrency);
  while (slotAvailableAt.length < configuredConcurrency) slotAvailableAt.push(0);

  const details = new Map<string, JobQueueDetails>();
  queued.forEach((job, index) => {
    let nextSlotIndex = 0;
    for (let slotIndex = 1; slotIndex < slotAvailableAt.length; slotIndex += 1) {
      if (slotAvailableAt[slotIndex]! < slotAvailableAt[nextSlotIndex]!) {
        nextSlotIndex = slotIndex;
      }
    }

    const waitMs = slotAvailableAt[nextSlotIndex] ?? 0;
    slotAvailableAt[nextSlotIndex] = waitMs + taskDurationMs;
    details.set(getJobId(job), {
      estimatedStartAt: now + waitMs,
      estimatedTaskMinutes: taskMinutes,
      estimatedWaitMinutes: Math.ceil(waitMs / 60_000),
      maxConcurrentJobs: configuredConcurrency,
      queuePosition: index + 1,
      queuedAhead: running.length + index,
      runningJobs: running.length,
      totalQueued: queued.length,
    });
  });

  return details;
};

export { buildJobQueueDetails };
export type { BuildQueueDetailsOptions, JobQueueDetails, QueueJob };

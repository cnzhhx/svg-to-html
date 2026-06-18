import { nanoid } from "nanoid";

import {
  compileComponentLibrary,
  type CompileComponentLibraryInput,
  type CompileComponentLibraryResult,
} from "./compiler.js";

type ComponentLibraryCompileJobStatus =
  | "completed"
  | "failed"
  | "queued"
  | "running";

type ComponentLibraryCompileJob = {
  completedAt?: number;
  createdAt: number;
  error?: string;
  id: string;
  input: {
    framework: CompileComponentLibraryInput["framework"];
    sourceType: "local" | "url";
  };
  result?: CompileComponentLibraryResult;
  startedAt?: number;
  status: ComponentLibraryCompileJobStatus;
  updatedAt: number;
};

const jobs = new Map<string, ComponentLibraryCompileJob>();

const serializeJob = (job: ComponentLibraryCompileJob) => ({
  completedAt: job.completedAt,
  createdAt: job.createdAt,
  error: job.error,
  id: job.id,
  input: job.input,
  result: job.result,
  startedAt: job.startedAt,
  status: job.status,
  updatedAt: job.updatedAt,
});

const updateJob = (
  id: string,
  patch: Partial<Omit<ComponentLibraryCompileJob, "id">>,
) => {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: Date.now() });
};

const startComponentLibraryCompileJob = (
  input: CompileComponentLibraryInput,
) => {
  const now = Date.now();
  const job: ComponentLibraryCompileJob = {
    createdAt: now,
    id: nanoid(10),
    input: {
      framework: input.framework,
      sourceType: input.sourceDir ? "local" : "url",
    },
    status: "queued",
    updatedAt: now,
  };
  jobs.set(job.id, job);

  void (async () => {
    updateJob(job.id, {
      startedAt: Date.now(),
      status: "running",
    });
    try {
      const result = await compileComponentLibrary(input);
      updateJob(job.id, {
        completedAt: Date.now(),
        result,
        status: "completed",
      });
    } catch (error) {
      updateJob(job.id, {
        completedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
        status: "failed",
      });
    }
  })();

  return serializeJob(job);
};

const getComponentLibraryCompileJob = (id: string) => {
  const job = jobs.get(id);
  return job ? serializeJob(job) : null;
};

const listComponentLibraryCompileJobs = () =>
  [...jobs.values()]
    .sort((left, right) => right.createdAt - left.createdAt)
    .map(serializeJob);

export {
  getComponentLibraryCompileJob,
  listComponentLibraryCompileJobs,
  startComponentLibraryCompileJob,
};

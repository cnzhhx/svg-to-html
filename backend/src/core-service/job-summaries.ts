type CoreJob = Record<string, unknown>;

const pick = (value: CoreJob, keys: string[]) => Object.fromEntries(
  keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]),
);

// Never carry execution transcripts, module plans or generated source in the list.
export const summarizeJob = (job: CoreJob): CoreJob => ({
  ...pick(job, ['id', 'jobId', 'designName', 'model', 'scale', 'outputFormat',
    'status', 'activeStep', 'steps', 'progress', 'error', 'createdAt', 'updatedAt',
    'queuedAt', 'executionStartedAt']),
  result: pick((job.result || {}) as CoreJob, ['outputTarget', 'artifactUpdatedAt',
    'compareEntryPath', 'renderEntryPath', 'sourceEntryPath', 'sourceStylePath',
    'renderPngPath', 'svgPngPath', 'livePreviewEntryPath', 'livePreviewUpdatedAt',
    'livePreviewVersion', 'designWidth', 'designHeight', 'diffRatio', 'quality',
    'deliverable', 'downloadUrl', 'diagnosticDownloadUrl']),
  messages: [],
  logs: [],
  __summary: true,
});

// Cache only Core summaries, never caller-specific permissions or policy decisions.
export class JobSummaryCache {
  private cached?: { jobs: CoreJob[]; expires: number };
  private pending?: Promise<CoreJob[]>;
  private generation = 0;
  constructor(private readonly fetchJobs: () => Promise<CoreJob[]>, private readonly ttl = 1000) {}

  invalidate() {
    this.generation++;
    this.cached = undefined;
    this.pending = undefined;
  }

  async read(): Promise<CoreJob[]> {
    if (this.cached && this.cached.expires > Date.now()) return this.cached.jobs;
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = this.fetchJobs().then(jobs => {
      const summaries = jobs.map(summarizeJob);
      if (generation === this.generation) this.cached = { jobs: summaries, expires: Date.now() + this.ttl };
      return summaries;
    });
    this.pending = pending;
    try { return await pending; }
    finally { if (this.pending === pending) this.pending = undefined; }
  }
}

// Express has already decoded route parameters. Reject traversal before fetch
// normalizes dot segments, including separators hidden in one wildcard segment.
export function isSafeArtifactPath(value: string) {
  return Boolean(value) && !/[\\\x00-\x1f\x7f]/.test(value)
    && !/%(?:2e|2f|5c|00|25)/i.test(value)
    && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

export function isSafeJobId(value: string) {
  return isSafeArtifactPath(value) && !value.includes("/");
}

// Allow bundled framework code and live-preview fitting to run. Same-origin
// scripts are trusted here; this policy is not an isolation boundary from the
// application. Keep direct network connections, forms, workers and plugins off.
export const ARTIFACT_CSP = "sandbox allow-same-origin allow-scripts; script-src 'self' 'unsafe-inline' blob:; connect-src 'none'; form-action 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'";

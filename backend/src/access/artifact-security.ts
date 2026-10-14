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

// Preserve the origin only for authenticated image/style subresources. Never
// allow scripts: generated HTML/SVG is untrusted, including the admin's output.
// Downloads retain their original bytes for running full interactions locally.
export const ARTIFACT_CSP = "sandbox allow-same-origin; script-src 'none'; connect-src 'none'; form-action 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'";

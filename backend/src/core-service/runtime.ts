import { CoreServiceError, requestCoreJson } from "./client.js";

const LEGACY_OUTPUT_FORMATS = ["html", "vue", "react"];

// /ready reports optional SDKs without calling a model. A 503 may still carry
// capabilities when another runtime prerequisite is unavailable.
export async function requestCoreOutputFormats(): Promise<string[]> {
  let readiness: unknown;
  try {
    readiness = await requestCoreJson("/ready", { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    if (error instanceof CoreServiceError && error.status === 503) readiness = error.payload;
  }
  const capabilities = (readiness as { capabilities?: Record<string, unknown> } | null)?.capabilities;
  return capabilities?.flutter === true
    ? [...LEGACY_OUTPUT_FORMATS, "flutter"]
    : [...LEGACY_OUTPUT_FORMATS];
}

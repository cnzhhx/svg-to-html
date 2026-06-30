export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isString = (value: unknown): value is string =>
  typeof value === "string";

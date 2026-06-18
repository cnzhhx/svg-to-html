export const truncate = (
  value: string,
  maxChars: number,
  suffix: string | ((value: string, maxChars: number) => string) = "...",
): string => {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  const suffixText = typeof suffix === "function" ? suffix(value, maxChars) : suffix;
  return `${value.slice(0, maxChars)}${suffixText}`;
};

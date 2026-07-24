const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const ELLIPSIS = "…";

export interface PresenceTextBudget {
  maxBytes: number;
  maxCodePoints: number;
  fallback?: string;
}

function wellFormed(value: string): string {
  let result = "";
  for (const codePoint of value) {
    const numericValue = codePoint.codePointAt(0);
    const isLoneSurrogate = numericValue !== undefined
      && numericValue >= 0xd800
      && numericValue <= 0xdfff;
    result += isLoneSurrogate ? "�" : codePoint;
  }
  return result;
}

export function normalizePresenceText(value: string): string {
  return wellFormed(value)
    .replace(CONTROL_OR_BIDI, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize and truncate text without splitting Unicode code points.
 * The returned value fits both the display code-point limit and UTF-8 byte limit.
 */
export function boundedPresenceText(value: string, budget: PresenceTextBudget): string {
  const maxBytes = Number.isSafeInteger(budget.maxBytes) ? Math.max(0, budget.maxBytes) : 0;
  const maxCodePoints = Number.isSafeInteger(budget.maxCodePoints) ? Math.max(0, budget.maxCodePoints) : 0;
  const fallback = normalizePresenceText(budget.fallback ?? "presence") || "presence";
  const normalized = normalizePresenceText(value) || fallback;
  const codePoints = [...normalized];

  if (codePoints.length <= maxCodePoints && Buffer.byteLength(normalized, "utf8") <= maxBytes) {
    return normalized;
  }
  if (maxBytes === 0 || maxCodePoints === 0) return "";

  const ellipsisBytes = Buffer.byteLength(ELLIPSIS, "utf8");
  if (maxBytes < ellipsisBytes) return "";

  const retained: string[] = [];
  let retainedBytes = 0;
  const contentPointLimit = Math.max(0, maxCodePoints - 1);
  const contentByteLimit = maxBytes - ellipsisBytes;

  for (const codePoint of codePoints) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (retained.length >= contentPointLimit || retainedBytes + codePointBytes > contentByteLimit) break;
    retained.push(codePoint);
    retainedBytes += codePointBytes;
  }

  return `${retained.join("")}${ELLIPSIS}`;
}

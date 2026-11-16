// Small shared helpers: errors, time, numbers, comments.

export const SCHEMA_VERSION = "1.0";
export const MAX_COMMENTS = 50;

/**
 * Error classes drive fallback and retries (design doc, Operations):
 *   transient  timeout, 429, 5xx          retry the same provider with backoff
 *   blocked    401, login wall, no credit  move on; counts toward the breaker
 *   permanent  404, private, removed       stop; no provider will do better
 *   config     bad or missing token        fix the setup
 */
export class ProviderError extends Error {
  constructor(message, errorClass = "blocked") {
    super(message);
    this.errorClass = errorClass;
  }
}
export const transient = (m) => new ProviderError(m, "transient");
export const blocked = (m) => new ProviderError(m, "blocked");
export const permanent = (m) => new ProviderError(m, "permanent");
export const configError = (m) => new ProviderError(m, "config");

export function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Epoch seconds, Date or ISO string to ISO 8601 UTC with "Z"; null if unparseable. */
export function isoUtc(value) {
  if (value === null || value === undefined || value === "") return null;
  let d;
  if (typeof value === "number") d = new Date(value * 1000);
  else if (value instanceof Date) d = value;
  else if (/^\d+$/.test(String(value).trim())) d = new Date(Number(value) * 1000);
  else {
    const s = String(value).trim();
    d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) || !/T/.test(s) ? s : s + "Z");
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function toInt(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}
export const nonNeg = (v) => { const n = toInt(v); return n !== null && n >= 0 ? n : null; }; // -1 = hidden
export function toFloat(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

export const normalizeTag = (t, prefix) => { const s = String(t).trim(); return s.startsWith(prefix) ? s : prefix + s; };

/** Most-liked first, newest first on ties, deduplicated by text, at most `limit`. */
export function topComments(comments, limit = MAX_COMMENTS) {
  const seen = new Set();
  const uniq = [];
  for (const c of comments) {
    const key = (c.text || "").trim();
    if (key && !seen.has(key)) { seen.add(key); uniq.push(c); }
  }
  uniq.sort((a, b) => (b.like_count ?? 0) - (a.like_count ?? 0) || String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  return uniq.slice(0, limit);
}

export const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

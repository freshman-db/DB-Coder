export interface RetryDelayOptions {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random?: () => number;
}

export function calculateRetryDelay(options: RetryDelayOptions): number {
  const attempt = Math.max(0, Math.floor(options.attempt));
  const baseDelayMs = Math.max(0, options.baseDelayMs);
  const maxDelayMs = Math.max(0, options.maxDelayMs);
  const random = options.random ?? Math.random;
  const jitterFactor = clamp(random(), 0, 1);
  const jitter = baseDelayMs * jitterFactor;
  const delay = baseDelayMs * 2 ** attempt + jitter;
  return Math.round(Math.min(delay, maxDelayMs));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export function createRateLimiter(windowMs: number, maxRequests: number): (ip: string) => boolean {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError('windowMs must be a positive number.');
  }
  if (!Number.isInteger(maxRequests) || maxRequests <= 0) {
    throw new RangeError('maxRequests must be a positive integer.');
  }

  const requestsByIp = new Map<string, RateLimitEntry>();

  const cleanupExpiredEntries = (): void => {
    const now = Date.now();
    for (const [ip, entry] of requestsByIp) {
      if (now - entry.windowStart >= windowMs) {
        requestsByIp.delete(ip);
      }
    }
  };

  const cleanupTimer = setInterval(cleanupExpiredEntries, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  return (ip: string): boolean => {
    const normalizedIp = ip.trim().length > 0 ? ip : 'unknown';
    const now = Date.now();
    const entry = requestsByIp.get(normalizedIp);

    if (!entry || now - entry.windowStart >= windowMs) {
      requestsByIp.set(normalizedIp, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= maxRequests) {
      return false;
    }

    entry.count += 1;
    return true;
  };
}

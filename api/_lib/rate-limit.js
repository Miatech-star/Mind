// Per-IP rate limit, in-memory. v1 only.
//
// Caveats:
// - Memory does not survive cold starts or scale across regions.
// - Good enough to deflect casual hammering; not a real abuse defence.
// - For production-grade limits, replace with Vercel KV or Upstash Redis.

const buckets = new Map();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;

function getIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    return xff.split(',')[0].trim();
  }
  if (typeof req.headers?.['x-real-ip'] === 'string') {
    return req.headers['x-real-ip'];
  }
  return req.socket?.remoteAddress || 'unknown';
}

export function checkRateLimit(req) {
  const ip = getIp(req);
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
  }
  bucket.count += 1;
  buckets.set(ip, bucket);

  // Cheap GC so the map can't grow without bound.
  if (buckets.size > 1000) {
    for (const [k, v] of buckets) {
      if (v.resetAt < now) buckets.delete(k);
    }
  }

  if (bucket.count > MAX_REQUESTS) {
    return { ok: false, retryAfterMs: Math.max(0, bucket.resetAt - now) };
  }
  return { ok: true };
}

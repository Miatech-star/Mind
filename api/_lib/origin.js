// Origin allowlist check for the addiction API endpoints.
//
// Why this exists: the API is meant to be called only from our
// frontend pages. A scripted attacker can call our API directly
// (no browser involved) to burn through Azure budget. This check
// rejects requests whose Origin header doesn't match an explicit
// allowlist before any rate limit, validation, or upstream call
// happens.
//
// Configuration (in priority order):
//   1. ALLOWED_ORIGINS env var: comma-separated exact origins
//      (e.g. "https://mind.app,https://mind-eight-rose.vercel.app").
//      Use "*" to allow any origin — only use this for Preview /
//      testing scopes, never for Production.
//   2. If ALLOWED_ORIGINS is unset:
//        - In production (NODE_ENV === 'production'):
//            DEFAULT_PROD_ORIGINS only.
//        - Otherwise (local dev):
//            DEFAULT_PROD_ORIGINS + DEV_ORIGINS so the dev frontend
//            and curl smoke tests both work.
//
// Caveat: an attacker can spoof the Origin header from a non-browser
// client. This deflects 99% of casual abuse but is not a hard wall.
// Real defense against scripted abuse is the Azure spend cap +
// per-IP rate limit + (eventually) Cloudflare Turnstile on the
// consent step.

export const DEFAULT_PROD_ORIGINS = [
  'https://mind-eight-rose.vercel.app',
];

export const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
];

export function checkOrigin(req) {
  const origin = ((req.headers && (req.headers.origin || req.headers.Origin)) || '').trim();
  const isProd = process.env.NODE_ENV === 'production';

  // Build the effective allowlist.
  let allowlist;
  if (process.env.ALLOWED_ORIGINS) {
    allowlist = process.env.ALLOWED_ORIGINS
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (isProd) {
    allowlist = DEFAULT_PROD_ORIGINS;
  } else {
    allowlist = [...DEFAULT_PROD_ORIGINS, ...DEV_ORIGINS];
  }

  // Wildcard escape hatch — useful for Vercel preview scope.
  if (allowlist.includes('*')) return { ok: true };

  // Origin header missing.
  // - In production: reject. Browser POSTs always include Origin;
  //   missing Origin means a non-browser client.
  // - In dev: allow, so curl-based smoke tests work.
  if (!origin) {
    return {
      ok: !isProd,
      reason: isProd ? 'origin_missing' : null,
    };
  }

  // Exact match against allowlist.
  if (allowlist.includes(origin)) return { ok: true };

  return { ok: false, reason: 'origin_not_allowed' };
}

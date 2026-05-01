// POST /api/addiction/analyze
//
// Returns snapshot + dashboard + plan in a single call so the three
// surfaces stay internally consistent. Severity is computed
// deterministically server-side (DSM-5-style symptom count); the model
// only writes narrative consistent with that level.

import { chatJSON, AzureError } from '../_lib/azure.js';
import { analyzePrompt } from '../_lib/prompts.js';
import {
  validateBaseInput,
  validateAnalyzeOutput,
  computeRisk,
  detectCrisisInHistory,
  ValidationError,
} from '../_lib/safety.js';
import { checkRateLimit } from '../_lib/rate-limit.js';
import { checkOrigin } from '../_lib/origin.js';

function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, error: { code, message } });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'METHOD_NOT_ALLOWED', 'POST only');
  }

  // Origin allowlist check — before rate limit so we don't waste
  // any per-IP slots on rejected calls.
  const oc = checkOrigin(req);
  if (!oc.ok) {
    return fail(res, 403, 'FORBIDDEN', 'Origin not allowed');
  }

  const rl = checkRateLimit(req);
  if (!rl.ok) {
    res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    return fail(res, 429, 'RATE_LIMITED', 'Too many requests');
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return fail(res, 400, 'BAD_INPUT', 'Body is not valid JSON');
    }
  }

  try {
    validateBaseInput(body);
  } catch (err) {
    if (err instanceof ValidationError) return fail(res, 400, err.code, err.message);
    return fail(res, 500, 'INTERNAL', 'Validation error');
  }

  if (!body.history.length) {
    return fail(res, 400, 'BAD_INPUT', 'history must contain at least one answer');
  }

  // Deterministic severity. Hybrid scoring: count of criteria endorsed at
  // "Sometimes" or higher (answer_value >= 2). Mirrors DSM-5 SUD bands.
  const risk = computeRisk(body.history);
  const crisis_signal = detectCrisisInHistory(body.history);

  const { system, user } = analyzePrompt(body, {
    level: risk.level,
    score: risk.score,
    crisis_signal,
  });

  let raw;
  try {
    raw = await chatJSON({ system, user, temperature: 0.6, maxTokens: 1500, timeoutMs: 26000 });
  } catch (err) {
    if (err instanceof AzureError) {
      const code =
        err.code === 'TIMEOUT' ? 'TIMEOUT' : err.code === 'CONFIG' ? 'INTERNAL' : 'UPSTREAM_ERROR';
      return fail(res, err.status || 502, code, err.message);
    }
    return fail(res, 502, 'UPSTREAM_ERROR', 'Upstream error');
  }

  const validated = validateAnalyzeOutput(raw, risk.level, risk.score);
  if (!validated) {
    return fail(res, 502, 'UPSTREAM_ERROR', 'Model returned invalid shape');
  }

  // Surface a top-level crisis flag so the client can show resources without
  // walking insights[]. Always present, defaults from deterministic state.
  validated.crisis_resources_recommended = !!(crisis_signal || risk.level === 'severe');

  return res.status(200).json({ ok: true, data: validated });
}

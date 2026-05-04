// POST /api/addiction/next-question
//
// Adaptive question endpoint. Given the conversation so far, returns the
// next question to ask, or { done: true } when there is enough signal.
//
// Hard caps: max 12 questions. Min 5 before the model is allowed to
// terminate. Self-harm never reaches this endpoint (client routes to
// crisis screen; safety.validateBaseInput rejects substance=selfharm).

import { chatJSON, AzureError } from '../_lib/azure.js';
import { nextQuestionPrompt, SCALE_OPTIONS } from '../_lib/prompts.js';
import {
  validateBaseInput,
  validateNextQuestionOutput,
  detectCrisisInHistory,
  ValidationError,
} from '../_lib/safety.js';
import { checkRateLimit } from '../_lib/rate-limit.js';
import { checkOrigin } from '../_lib/origin.js';

const MAX_QUESTIONS = 12;
const MIN_QUESTIONS_BEFORE_DONE = 5;

// TEMP DEBUG — remove once we've confirmed the prod path is hitting Azure.
// Tag every line so it's easy to grep in Vercel logs.
const DBG = '[debug:next-question]';
const sidShort = (s) => (typeof s === 'string' && s.length >= 8 ? s.slice(0, 8) : 'unknown');

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
    console.log(`${DBG} origin-denied origin=${req.headers?.origin || 'none'}`);
    return fail(res, 403, 'FORBIDDEN', 'Origin not allowed');
  }

  const rl = checkRateLimit(req);
  if (!rl.ok) {
    console.log(`${DBG} rate-limited`);
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
    console.log(`${DBG} validation-fail code=${err?.code || 'unknown'}`);
    if (err instanceof ValidationError) return fail(res, 400, err.code, err.message);
    return fail(res, 500, 'INTERNAL', 'Validation error');
  }

  const history = body.history;
  const sid = sidShort(body.session_id);
  const qNum = history.length + 1;
  const substance = typeof body.substance === 'string' ? body.substance : 'unknown';
  console.log(`${DBG} start sid=${sid} q=${qNum} substance=${substance} historyLen=${history.length}`);

  // Hard cap — server-enforced regardless of what the model says.
  if (history.length >= MAX_QUESTIONS) {
    console.log(`${DBG} short-circuit reason=max_reached sid=${sid} q=${qNum}`);
    return res
      .status(200)
      .json({ ok: true, data: { done: true, completion_reason: 'max_reached' } });
  }

  // Crisis short-circuit. We don't keep probing if the user surfaced crisis
  // signals in earlier free-text fields. The client should route to a
  // crisis screen on this signal.
  if (detectCrisisInHistory(history)) {
    console.log(`${DBG} short-circuit reason=safety_redirect sid=${sid} q=${qNum}`);
    return res
      .status(200)
      .json({ ok: true, data: { done: true, completion_reason: 'safety_redirect' } });
  }

  const { system, user } = nextQuestionPrompt(body);

  console.log(`${DBG} azure-call-start sid=${sid} q=${qNum}`);
  const azureStartedAt = Date.now();

  let raw;
  try {
    raw = await chatJSON({ system, user, temperature: 0.7, maxTokens: 500, timeoutMs: 18000 });
  } catch (err) {
    const ms = Date.now() - azureStartedAt;
    if (err instanceof AzureError) {
      console.log(`${DBG} azure-error sid=${sid} q=${qNum} code=${err.code} status=${err.status || 'n/a'} ms=${ms}`);
      const code =
        err.code === 'TIMEOUT' ? 'TIMEOUT' : err.code === 'CONFIG' ? 'INTERNAL' : 'UPSTREAM_ERROR';
      return fail(res, err.status || 502, code, err.message);
    }
    console.log(`${DBG} azure-error sid=${sid} q=${qNum} code=UNKNOWN ms=${ms}`);
    return fail(res, 502, 'UPSTREAM_ERROR', 'Upstream error');
  }

  const azureMs = Date.now() - azureStartedAt;
  console.log(`${DBG} azure-ok sid=${sid} q=${qNum} ms=${azureMs}`);

  const validated = validateNextQuestionOutput(raw);
  if (!validated) {
    console.log(`${DBG} validation-fail-output sid=${sid} q=${qNum}`);
    return fail(res, 502, 'UPSTREAM_ERROR', 'Model returned invalid shape');
  }

  // Enforce minimum: model cannot terminate before MIN_QUESTIONS_BEFORE_DONE
  // unless it's a safety redirect. If it tried to, substitute a fallback question.
  if (
    validated.done &&
    validated.completion_reason === 'sufficient_signal' &&
    history.length < MIN_QUESTIONS_BEFORE_DONE
  ) {
    console.log(`${DBG} in-route-fallback reason=min_questions_guard sid=${sid} q=${qNum}`);
    return res.status(200).json({
      ok: true,
      data: {
        done: false,
        question: {
          id: `q-${history.length + 1}`,
          text: 'How often does this take up more space in your day than you would like?',
          options: SCALE_OPTIONS,
        },
        signal_being_checked: 'loss_of_control',
        why_this_question: 'fallback minimum-questions guard',
        confidence_so_far: 0.4,
      },
    });
  }

  console.log(`${DBG} success sid=${sid} q=${qNum} done=${!!validated.done} signal=${validated.signal_being_checked || 'n/a'}`);
  return res.status(200).json({ ok: true, data: validated });
}

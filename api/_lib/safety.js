// Input validation, output validation, deterministic scoring, and crisis detection.
//
// Self-harm is intentionally NOT in ALLOWED_SUBSTANCES — the client routes
// that case to a crisis screen and never POSTs it here. If it arrives anyway,
// validation rejects it.

export const ALLOWED_SUBSTANCES = [
  'alcohol',
  'nicotine',
  'cannabis',
  'gambling',
  'cocaine',
  'opioids',
  'meth',
  'mdma',
  'sex',
  'pornography',
  'other',
];

const VALID_SIGNALS = new Set([
  'loss_of_control',
  'cravings',
  'emotional_triggers',
  'social_impact',
  'financial_impact',
  'relapse_risk',
  'avoidance_patterns',
  'motivation_to_change',
]);

const MAX_NAME_LEN = 60;
const MAX_HISTORY = 12;
const MAX_QUESTION_TEXT = 400;

const CRISIS_PATTERNS = [
  /\bsuicid/i,
  /\bkill (myself|me)\b/i,
  /\bend (my )?life\b/i,
  /\bself[-\s]?harm/i,
  /\bcutting myself\b/i,
  /\bwant to die\b/i,
  /\bharm myself\b/i,
];

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'BAD_INPUT';
    this.status = 400;
  }
}

export function validateBaseInput(body) {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('Body must be a JSON object');
  }
  if (typeof body.session_id !== 'string' || body.session_id.length < 8 || body.session_id.length > 64) {
    throw new ValidationError('session_id required (8–64 chars)');
  }
  if (typeof body.name !== 'string' || body.name.length > MAX_NAME_LEN) {
    throw new ValidationError(`name must be a string up to ${MAX_NAME_LEN} chars`);
  }
  if (!ALLOWED_SUBSTANCES.includes(body.substance)) {
    throw new ValidationError('substance not allowed');
  }
  if (typeof body.weekly_cost !== 'number' || !Number.isFinite(body.weekly_cost) || body.weekly_cost < 0 || body.weekly_cost > 100000) {
    throw new ValidationError('weekly_cost must be a number 0–100000');
  }
  if (typeof body.havent_started !== 'boolean') {
    throw new ValidationError('havent_started must be a boolean');
  }
  if (body.started_at !== null && typeof body.started_at !== 'string') {
    throw new ValidationError('started_at must be a string or null');
  }
  if (typeof body.started_at === 'string' && body.started_at.length > 40) {
    throw new ValidationError('started_at too long');
  }
  if (!Array.isArray(body.history)) {
    throw new ValidationError('history must be an array');
  }
  if (body.history.length > MAX_HISTORY) {
    throw new ValidationError(`history exceeds max ${MAX_HISTORY}`);
  }
  for (const item of body.history) {
    if (!item || typeof item !== 'object') {
      throw new ValidationError('history item invalid');
    }
    if (typeof item.id !== 'string' || item.id.length > 16) {
      throw new ValidationError('history item id invalid');
    }
    if (typeof item.text !== 'string' || item.text.length > MAX_QUESTION_TEXT) {
      throw new ValidationError('history item text invalid');
    }
    if (
      typeof item.answer_value !== 'number' ||
      !Number.isInteger(item.answer_value) ||
      item.answer_value < 0 ||
      item.answer_value > 4
    ) {
      throw new ValidationError('history item answer_value must be integer 0–4');
    }
    if (typeof item.answer_label !== 'string' || item.answer_label.length > 40) {
      throw new ValidationError('history item answer_label invalid');
    }
    // signal_being_checked is optional but if present must be a recognized category
    if (item.signal_being_checked !== undefined && item.signal_being_checked !== null) {
      if (typeof item.signal_being_checked !== 'string' || !VALID_SIGNALS.has(item.signal_being_checked)) {
        throw new ValidationError('history item signal_being_checked invalid');
      }
    }
    // time_ms is optional. When present it must be a non-negative number
    // ≤ 600 000 (10 minutes). Hesitation outliers are useful signal;
    // anything beyond 10 minutes is more likely AFK and should be ignored.
    if (item.time_ms !== undefined && item.time_ms !== null) {
      if (typeof item.time_ms !== 'number' || !Number.isFinite(item.time_ms) || item.time_ms < 0 || item.time_ms > 600000) {
        throw new ValidationError('history item time_ms invalid');
      }
    }
  }
  return true;
}

export function detectCrisisInHistory(history) {
  if (!Array.isArray(history)) return false;
  for (const item of history) {
    if (CRISIS_PATTERNS.some((p) => p.test(item.text || ''))) return true;
  }
  return false;
}

// Hybrid scoring — DSM-5-style raw symptom count, plus a 0–100 score.
// Counts criteria where the answer is "Sometimes" or higher (value >= 2).
// 0–1 minimal, 2–3 mild, 4–5 moderate, 6+ severe — DSM-5 SUD severity bands.
export function computeRisk(history) {
  const symptoms = history.filter((h) => h.answer_value >= 2).length;
  let level;
  if (symptoms >= 6) level = 'severe';
  else if (symptoms >= 4) level = 'moderate';
  else if (symptoms >= 2) level = 'mild';
  else level = 'minimal';
  const max = 11; // DSM-5 SUD has 11 criteria
  const pct = Math.min(1, symptoms / max);
  const score = Math.round(pct * 100);
  return { level, symptoms, pct, score };
}

// Validate the next-question model output.
export function validateNextQuestionOutput(out) {
  if (!out || typeof out !== 'object') return null;

  if (out.done === true) {
    const reason = ['sufficient_signal', 'safety_redirect', 'max_reached'].includes(out.completion_reason)
      ? out.completion_reason
      : ['sufficient_signal', 'safety_redirect', 'max_reached'].includes(out.reason)
        ? out.reason
        : 'sufficient_signal';
    const confidence = clampNum(out.confidence_so_far, 0, 1, 0.8);
    return { done: true, completion_reason: reason, confidence_so_far: confidence };
  }
  if (out.done !== false) return null;

  const q = out.question;
  if (!q || typeof q !== 'object') return null;
  if (typeof q.id !== 'string' || q.id.length > 16) return null;
  if (typeof q.text !== 'string' || q.text.length < 5 || q.text.length > MAX_QUESTION_TEXT) return null;
  if (!Array.isArray(q.options) || q.options.length !== 5) return null;
  for (let i = 0; i < 5; i++) {
    const o = q.options[i];
    if (!o || o.value !== i || typeof o.label !== 'string' || o.label.length > 40) return null;
  }

  // Optional adaptive metadata
  let signal = null;
  if (typeof out.signal_being_checked === 'string' && VALID_SIGNALS.has(out.signal_being_checked)) {
    signal = out.signal_being_checked;
  }
  const why = (typeof out.why_this_question === 'string' && out.why_this_question.length <= 240)
    ? out.why_this_question
    : null;
  const confidence = clampNum(out.confidence_so_far, 0, 1, null);

  return {
    done: false,
    question: { id: q.id, text: q.text, options: q.options },
    signal_being_checked: signal,
    why_this_question: why,
    confidence_so_far: confidence,
  };
}

// Validate the analyze model output. Forces deterministic risk fields.
export function validateAnalyzeOutput(out, deterministicLevel, deterministicScore) {
  if (!out || typeof out !== 'object') return null;

  // risk
  const r = out.risk;
  if (!r || typeof r !== 'object') return null;
  r.level = deterministicLevel;
  r.score = deterministicScore;
  if (typeof r.label !== 'string' || r.label.length > 40) return null;
  if (typeof r.summary !== 'string' || r.summary.length > 280) return null;

  // primaryPattern
  const pp = out.primaryPattern;
  if (!pp || typeof pp !== 'object') return null;
  if (typeof pp.title !== 'string' || pp.title.length > 80) return null;
  if (typeof pp.description !== 'string' || pp.description.length > 280) return null;
  if (typeof pp.signal !== 'string' || !VALID_SIGNALS.has(pp.signal)) return null;

  // metrics — exactly 3
  if (!Array.isArray(out.metrics) || out.metrics.length !== 3) return null;
  for (const m of out.metrics) {
    if (!m || typeof m !== 'object') return null;
    if (typeof m.label !== 'string' || m.label.length > 32) return null;
    if (typeof m.value !== 'number' || m.value < 0 || m.value > 100) return null;
    if (typeof m.unit !== 'string' || m.unit.length > 6) return null;
    if (typeof m.insight !== 'string' || m.insight.length > 160) return null;
  }

  // triggerMap — 4–7 items
  if (!Array.isArray(out.triggerMap) || out.triggerMap.length < 4 || out.triggerMap.length > 7) return null;
  for (const t of out.triggerMap) {
    if (!t || typeof t !== 'object') return null;
    if (typeof t.label !== 'string' || t.label.length > 30) return null;
    if (typeof t.value !== 'number' || t.value < 0 || t.value > 100) return null;
  }

  // projection — exactly 4 items, days 1, 7, 30, 90
  if (!Array.isArray(out.projection) || out.projection.length !== 4) return null;
  const expectedDays = [1, 7, 30, 90];
  for (let i = 0; i < 4; i++) {
    const p = out.projection[i];
    if (!p || typeof p !== 'object') return null;
    if (p.day !== expectedDays[i]) return null;
    if (typeof p.stability !== 'number' || p.stability < 0 || p.stability > 100) return null;
    if (typeof p.pressure !== 'number' || p.pressure < 0 || p.pressure > 100) return null;
  }

  // insights — 1–2 items
  if (!Array.isArray(out.insights) || out.insights.length < 1 || out.insights.length > 2) return null;
  for (const i of out.insights) {
    if (!i || typeof i !== 'object') return null;
    if (typeof i.title !== 'string' || i.title.length > 60) return null;
    if (typeof i.body !== 'string' || i.body.length > 280) return null;
  }

  // plan — title + 3 steps
  const pl = out.plan;
  if (!pl || typeof pl !== 'object') return null;
  if (typeof pl.title !== 'string' || pl.title.length > 80) return null;
  if (!Array.isArray(pl.steps) || pl.steps.length !== 3) return null;
  for (const s of pl.steps) {
    if (!s || typeof s !== 'object') return null;
    if (typeof s.title !== 'string' || s.title.length > 60) return null;
    if (typeof s.body !== 'string' || s.body.length > 280) return null;
  }

  return out;
}

function clampNum(v, lo, hi, fallback) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

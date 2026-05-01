// Azure AI Foundry / Azure OpenAI — Responses API wrapper.
//
// - Reads config from process.env at call time (never at import time).
// - Uses native fetch (Node 20+).
// - Targets the Responses API: POST {endpoint}/openai/responses?api-version=...
// - Forces JSON output via text.format.
// - Throws AzureError with a code the caller maps to a user-facing envelope.
//
// AZURE_OPENAI_ENDPOINT may be either:
//   1. Resource base URL only:
//        https://my-resource.cognitiveservices.azure.com
//      → wrapper appends /openai/responses?api-version=<env api version>
//   2. Full endpoint URL:
//        https://my-resource.cognitiveservices.azure.com/openai/responses?api-version=2025-04-01-preview
//      → wrapper uses it as-is, only ensuring api-version is present.
//
// Never logs the prompt or the response body — only metadata.

const REQUIRED_ENV = [
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_MODEL',
];

export class AzureError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'AzureError';
    this.code = code;
    this.status = status;
  }
}

function readConfig() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new AzureError('CONFIG', `Missing env vars: ${missing.join(', ')}`, 500);
  }
  return {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION,
    deployment: process.env.AZURE_OPENAI_MODEL,
  };
}

// Build the final Responses API URL.
//   - Accepts either resource base or full endpoint with /openai/responses.
//   - Strips trailing slashes safely.
//   - Never duplicates /openai/responses.
//   - Preserves an api-version already present in the URL; otherwise appends from arg.
//   - Throws AzureError('CONFIG', ...) on invalid input — never returns a bad URL.
export function buildResponsesUrl(rawEndpoint, apiVersion) {
  if (typeof rawEndpoint !== 'string' || !rawEndpoint.trim()) {
    throw new AzureError('CONFIG', 'AZURE_OPENAI_ENDPOINT missing or empty', 500);
  }
  let url;
  try {
    url = new URL(rawEndpoint.trim());
  } catch {
    throw new AzureError('CONFIG', 'AZURE_OPENAI_ENDPOINT is not a valid URL', 500);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AzureError('CONFIG', 'AZURE_OPENAI_ENDPOINT must be http(s)', 500);
  }

  // Normalize the path: strip trailing slashes, then conditionally append.
  let path = url.pathname.replace(/\/+$/, '');
  if (!path.toLowerCase().includes('/openai/responses')) {
    path = `${path}/openai/responses`;
  }
  url.pathname = path;

  // Ensure api-version is present.
  if (!url.searchParams.has('api-version')) {
    if (typeof apiVersion === 'string' && apiVersion.trim()) {
      url.searchParams.set('api-version', apiVersion.trim());
    } else {
      throw new AzureError(
        'CONFIG',
        'api-version is missing in both AZURE_OPENAI_API_VERSION and AZURE_OPENAI_ENDPOINT',
        500
      );
    }
  }

  return url.toString();
}

// Returns a sanitized preview of the URL — host + path only, no query string,
// no key, no other env values. Safe to log / print.
export function sanitizedUrlPreview(rawEndpoint, apiVersion) {
  let final;
  try {
    final = new URL(buildResponsesUrl(rawEndpoint, apiVersion));
  } catch (err) {
    return `<invalid endpoint: ${err.code || 'unknown'}>`;
  }
  return `${final.protocol}//${final.host}${final.pathname}`;
}

export async function chatJSON({
  system,
  user,
  temperature = 0.6,
  maxTokens = 900,
  timeoutMs = 22000,
}) {
  const cfg = readConfig();
  const url = buildResponsesUrl(cfg.endpoint, cfg.apiVersion);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-key': cfg.apiKey,
      },
      body: JSON.stringify({
        model: cfg.deployment,
        input: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature,
        max_output_tokens: maxTokens,
        text: { format: { type: 'json_object' } },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new AzureError('TIMEOUT', 'Upstream timeout', 504);
    }
    throw new AzureError('NETWORK', `Network error: ${err.message}`, 502);
  }
  clearTimeout(timer);

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 240);
    } catch {
      // ignore
    }
    throw new AzureError('UPSTREAM', `Azure ${res.status}: ${detail || res.statusText}`, 502);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new AzureError('UPSTREAM', 'Invalid JSON envelope from Azure', 502);
  }

  // Extract assistant text. Prefer the convenience field; otherwise walk the
  // output[].content[] array. Defensive fallback to Chat Completions shape in
  // case a deployment returns the old structure.
  let content = null;
  if (typeof body?.output_text === 'string' && body.output_text.length) {
    content = body.output_text;
  } else if (Array.isArray(body?.output)) {
    outer: for (const item of body.output) {
      if (Array.isArray(item?.content)) {
        for (const c of item.content) {
          if (typeof c?.text === 'string' && c.text.length) {
            content = c.text;
            break outer;
          }
        }
      }
    }
  }
  if (!content && body?.choices?.[0]?.message?.content) {
    content = body.choices[0].message.content;
  }
  if (!content || typeof content !== 'string') {
    throw new AzureError('UPSTREAM', 'No content in Azure response', 502);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new AzureError('UPSTREAM', 'Model returned non-JSON content', 502);
  }
  return parsed;
}

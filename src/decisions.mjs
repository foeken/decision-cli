/** @typedef {{type:'predicate', name:string, instructions:string}} PredicateQuestion
 * @typedef {{type:'choice', name:string, instructions:string, choices:Array<{value:string|boolean, description?:string}>}} ChoiceQuestion
 * @typedef {{type:'score', name:string, instructions:string, levels:Array<{label:string, description?:string}>}} ScoreQuestion
 * @typedef {PredicateQuestion|ChoiceQuestion|ScoreQuestion} Question
 * @typedef {{id?:string, input:string, questions:Question[]}} RecordInput
 * @typedef {{type:'predicate', name:string, probability:number}|{type:'choice', name:string, choice:string|boolean, confidence:number, probabilities:Array<{value:string|boolean, probability:number}>}|{type:'score', name:string, score:number, confidence:number, probabilities:Array<{value:number, label:string, probability:number}>}|{type:'refusal', name:string}} Answer
 */

export const ENDPOINT = 'https://api.openai.com/v1/decisions';
export const MODEL = 'gpt-6-luna';
export const DEFAULTS = Object.freeze({ concurrency: 2, rps: 2, timeout: 20000, retries: 0,
  maxRequests: 100, maxInputBytes: 65536, maxTotalBytes: 1048576 });

export class DecisionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DecisionError';
    this.code = code;
    Object.assign(this, details);
  }
  toJSON() {
    return { code: this.code, message: this.message,
      ...(this.status ? { status: this.status } : {}),
      ...(this.requestId ? { request_id: this.requestId } : {}),
      ...(this.retryAfterMs !== undefined ? { retry_after_ms: this.retryAfterMs } : {}) };
  }
}
const fail = (message) => { throw new DecisionError('invalid_input', message); };
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const string = (x, max = 8192) => typeof x === 'string' && x.length > 0 && x.length <= max;
const typedKey = (x) => JSON.stringify([typeof x, x]);
const number = (x, lo, hi) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
const probability = (x) => number(x, 0, 1);
const fields = (x, allowed) => Object.keys(x).every((k) => allowed.includes(k));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function options(overrides = {}) {
  const out = { ...DEFAULTS, ...overrides };
  for (const [name, lo, hi, integer] of [
    ['concurrency', 1, 8, true], ['rps', 0.1, 10, false], ['timeout', 100, 60000, true],
    ['retries', 0, 3, true], ['maxRequests', 1, 10000, true],
    ['maxInputBytes', 1, 1048576, true], ['maxTotalBytes', 1, 67108864, true],
  ]) {
    if (!number(out[name], lo, hi) || (integer && !Number.isInteger(out[name]))) fail(`Invalid ${name}; expected ${integer ? 'integer ' : ''}${lo}..${hi}.`);
  }
  return out;
}

/** Text-only subset of the API; require named questions for stable machine output. */
export function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 32) fail('questions must contain 1..32 entries.');
  const names = new Set();
  for (const q of questions) {
    if (!object(q) || !string(q.name, 128) || !/^[A-Za-z0-9_.-]+$/.test(q.name) || names.has(q.name)) fail('Each question needs a unique name (1..128 letters, digits, _, ., -).');
    names.add(q.name);
    if (!string(q.instructions)) fail('Question instructions must contain 1..8192 characters.');
    const extra = q.type === 'choice' ? ['choices'] : q.type === 'score' ? ['levels'] : [];
    if (!['predicate', 'choice', 'score'].includes(q.type) || !fields(q, ['name', 'type', 'instructions', ...extra])) fail('Unknown question type or field.');
    if (q.type === 'predicate') continue;
    const items = q.type === 'choice' ? q.choices : q.levels;
    if (!Array.isArray(items) || items.length < 2 || items.length > 128) fail('choices/levels must contain 2..128 entries.');
    const seen = new Set();
    for (const item of items) {
      if (!object(item) || !fields(item, [q.type === 'choice' ? 'value' : 'label', 'description'])) fail('Invalid choice/level fields.');
      const value = q.type === 'choice' ? item.value : item.label;
      if (!(string(value, 256) || (q.type === 'choice' && typeof value === 'boolean')) || seen.has(typedKey(value))) fail('Choice values / level labels must be valid and distinct.');
      if (item.description !== undefined && !string(item.description, 4096)) fail('Invalid choice/level description.');
      seen.add(typedKey(value));
    }
  }
  return questions;
}

/** Validate the entire batch before sending anything. IDs remain local. */
export function prepareRecords(records, sharedQuestions, opts = DEFAULTS) {
  opts = options(opts);
  if (!Array.isArray(records) || records.length < 1 || records.length > opts.maxRequests) fail(`Expected 1..${opts.maxRequests} records.`);
  if (sharedQuestions !== undefined) validateQuestions(sharedQuestions);
  const ids = new Set();
  let totalBytes = 0;
  const prepared = records.map((row, index) => {
    if (!object(row) || !fields(row, ['id', 'input', 'questions'])) fail(`Record ${index}: allowed fields are id, input, questions.`);
    if (typeof row.input !== 'string' || !row.input.length) fail(`Record ${index}: input must be a nonempty text string.`);
    const id = row.id ?? String(index);
    if (!string(id, 128) || ids.has(id)) fail(`Record ${index}: id must be a unique string of 1..128 characters.`);
    ids.add(id);
    const questions = validateQuestions(row.questions ?? sharedQuestions);
    const body = JSON.stringify({ model: MODEL, input: row.input, questions });
    const bytes = Buffer.byteLength(body);
    totalBytes += bytes;
    if (bytes > opts.maxInputBytes) fail(`Record ${index}: request exceeds max-input-bytes.`);
    return { id, index, body, questions, bytes };
  });
  if (totalBytes > opts.maxTotalBytes) fail('Batch exceeds max-total-bytes.');
  return { records: prepared, totalBytes };
}

/** Validate answers against the submitted schema; unknown response fields are discarded. */
export function validateResponse(data, questions) {
  const bad = () => { throw new DecisionError('invalid_response', 'API response did not match the submitted question schema.'); };
  if (!object(data) || data.model !== MODEL || !Array.isArray(data.answers) || data.answers.length !== questions.length) bad();
  const answers = data.answers.map((a, i) => {
    const q = questions[i];
    if (!object(a) || a.name !== q.name) bad();
    if (a.type === 'refusal') return { type: 'refusal', name: a.name };
    if (a.type !== q.type) bad();
    if (a.type === 'predicate') {
      if (!probability(a.probability)) bad();
      return { type: a.type, name: a.name, probability: a.probability };
    }
    const values = q.type === 'choice' ? q.choices.map((c) => c.value) : q.levels.map((_, j) => j);
    if (!probability(a.confidence) || !Array.isArray(a.probabilities) || a.probabilities.length !== values.length) bad();
    const seen = new Set();
    const probabilities = a.probabilities.map((p) => {
      if (!object(p) || !probability(p.probability) || !values.some((v) => typedKey(v) === typedKey(p.value)) || seen.has(typedKey(p.value))) bad();
      seen.add(typedKey(p.value));
      if (q.type === 'score' && p.label !== q.levels[p.value].label) bad();
      return { value: p.value, ...(q.type === 'score' ? { label: p.label } : {}), probability: p.probability };
    });
    if (Math.abs(probabilities.reduce((sum, p) => sum + p.probability, 0) - 1) > 0.01) bad();
    if (q.type === 'choice' && !values.some((v) => typedKey(v) === typedKey(a.choice))) bad();
    if (q.type === 'score' && (!number(a.score, 0, values.length - 1) || Math.abs(a.score - probabilities.reduce((sum, p) => sum + p.value * p.probability, 0)) > 0.02)) bad();
    return { type: a.type, name: a.name, ...(q.type === 'choice' ? { choice: a.choice } : { score: a.score }), confidence: a.confidence, probabilities };
  });
  const u = data.usage;
  if (!object(u) || !['input_tokens', 'output_tokens', 'total_tokens'].every((k) => Number.isSafeInteger(u[k]) && u[k] >= 0) || u.total_tokens !== u.input_tokens + u.output_tokens) bad();
  return { model: data.model, answers, usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, total_tokens: u.total_tokens } };
}

export function retryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms)) : undefined;
}

function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
function httpError(response) {
  const status = response.status;
  const code = ({ 400: 'invalid_request', 401: 'authentication_failed', 403: 'access_denied',
    404: 'endpoint_or_model_unavailable', 429: 'rate_limited' })[status] ?? (status >= 500 ? 'server_error' : 'http_error');
  const message = ({ 401: 'API authentication failed; check the injected key.',
    403: 'This key/project cannot use the requested API.',
    429: 'Rate or quota limit reached; inspect project limits before retrying.' })[status] ?? `API returned HTTP ${status}; response body omitted.`;
  return new DecisionError(code, message, { status, requestId: safeId(response.headers.get('x-request-id')), retryAfterMs: retryAfter(response.headers.get('retry-after')) });
}

/** A fresh limiter per invocation; shared by initial attempts and retries. */
export function rateLimiter(rps, wait = sleep, now = Date.now) {
  let next = 0;
  return async () => {
    const current = now();
    const slot = Math.max(current, next);
    next = slot + 1000 / rps;
    if (slot > current) await wait(slot - current);
  };
}

export function credentials(env = process.env) {
  if (!env.OPENAI_API_KEY) throw new DecisionError('missing_api_key', 'Inject OPENAI_API_KEY through your existing secret manager or process environment.');
  const headers = { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' };
  for (const [key, header] of [['OPENAI_PROJECT_ID', 'OpenAI-Project'], ['OPENAI_ORG_ID', 'OpenAI-Organization']]) {
    if (env[key]) headers[header] = env[key];
  }
  if (Object.values(headers).some((value) => /[\r\n]/.test(value))) throw new DecisionError('invalid_auth_configuration', 'Authentication environment contains an invalid header value.');
  return headers;
}

/** Dependencies are injectable for offline tests; CLI always uses the fixed HTTPS endpoint. */
export async function runBatch(prepared, opts, headers, deps = {}) {
  opts = options(opts);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const wait = deps.sleep ?? sleep;
  const now = deps.now ?? Date.now;
  const limit = rateLimiter(opts.rps, wait, now);
  let cursor = 0, stopped = null, attempts = 0;
  const results = new Array(prepared.records.length);
  async function run(row) {
    const started = now();
    let rowAttempts = 0;
    for (let attempt = 0; ; attempt++) {
      if (stopped) return { id: row.id, index: row.index, ok: false, attempts: rowAttempts, error: { code: 'batch_stopped', message: `No further requests after ${stopped}.` } };
      await limit();
      if (stopped) return { id: row.id, index: row.index, ok: false, attempts: rowAttempts, error: { code: 'batch_stopped', message: `No further requests after ${stopped}.` } };
      rowAttempts++; attempts++;
      let result, requestId, httpStatus;
      try {
        const response = await fetchImpl(ENDPOINT, { method: 'POST', headers, body: row.body,
          redirect: 'error', signal: AbortSignal.timeout(opts.timeout) });
        httpStatus = response.status;
        requestId = safeId(response.headers.get('x-request-id'));
        if (!response.ok) { await response.body?.cancel(); throw httpError(response); }
        // Bound response memory; timeout remains active through body consumption.
        const reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 1048576) { await reader.cancel(); throw new DecisionError('invalid_response', 'API response exceeds 1 MiB.'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new DecisionError('invalid_response', 'API returned invalid JSON.'); }
        result = validateResponse(parsed, row.questions);
      } catch (cause) {
        const error = cause instanceof DecisionError ? cause : new DecisionError(
          cause?.name === 'TimeoutError' || cause?.name === 'AbortError' ? 'timeout' : 'network_error',
          'Request did not complete; no automatic retry for ambiguous network failures.');
        const canRetry = error.status === 429 || error.status >= 500;
        const delay = error.retryAfterMs ?? Math.min(1000 * 2 ** attempt, 10000);
        if (canRetry && attempt < opts.retries && delay <= 30000 && !stopped) { await wait(delay); continue; }
        if ([401, 403, 404, 429].includes(error.status)) stopped = error.code;
        return { id: row.id, index: row.index, ok: false, attempts: rowAttempts, elapsed_ms: Math.max(0, now() - started), error: error.toJSON() };
      }
      return { id: row.id, index: row.index, ok: true, http_status: httpStatus, attempts: rowAttempts, elapsed_ms: Math.max(0, now() - started),
        ...(requestId ? { request_id: requestId } : {}), ...result,
        needs_review: result.answers.some((a) => a.type === 'refusal') };
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, prepared.records.length) }, async () => {
    while (cursor < prepared.records.length) {
      const index = cursor++;
      results[index] = await run(prepared.records[index]);
      deps.onResult?.(results[index]);
    }
  }));
  return { results, summary: { records: results.length, succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length, attempts,
    input_tokens: results.reduce((sum, r) => sum + (r.usage?.input_tokens ?? 0), 0),
    request_bytes: prepared.totalBytes,
    // Lower bound: error/timeout/retried attempts can be billed without reported usage.
    estimated_reported_input_cost_usd: results.reduce((sum, r) => sum + (r.usage?.input_tokens ?? 0), 0) * 0.1 / 1000000 } };
}

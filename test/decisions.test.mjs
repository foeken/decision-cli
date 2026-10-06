import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DecisionError, ENDPOINT, MODEL, options, prepareRecords, validateQuestions, validateResponse,
  credentials, retryAfter, rateLimiter, runBatch } from '../src/decisions.mjs';

const predicate = { type: 'predicate', name: 'red', instructions: 'Is the apple red?' };
const choice = { type: 'choice', name: 'route', instructions: 'Choose.', choices: [{ value: true }, { value: 'true' }] };
const score = { type: 'score', name: 'severity', instructions: 'Score.', levels: [{ label: 'low' }, { label: 'high' }] };
const row = { id: 'a', input: 'A red apple.', questions: [predicate] };
const usage = { input_tokens: 20, output_tokens: 0, total_tokens: 20 };
const good = { model: MODEL, answers: [{ type: 'predicate', name: 'red', probability: 0.99 }], usage };
const clone = (value) => structuredClone(value);
const prepared = (rows = [row]) => prepareRecords(rows);
const noWait = async () => {};
const response = (data = good, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const run = (fetch, opts = {}, rows = [row], more = {}) => runBatch(prepared(rows), options({ concurrency: 1, ...opts }), { authorization: 'Bearer synthetic-placeholder' }, { fetch, sleep: noWait, ...more });

test('builds exact contract, keeps IDs local, applies shared questions', () => {
  const p = prepareRecords([{ id: 'local', input: 'abc' }], [predicate]);
  assert.deepEqual(JSON.parse(p.records[0].body), { model: MODEL, input: 'abc', questions: [predicate] });
  assert.equal(p.totalBytes, Buffer.byteLength(p.records[0].body));
});

test('validates all question types including distinct boolean/string choices', () => {
  assert.equal(validateQuestions([predicate, choice, score]).length, 3);
  for (const bad of [[], [predicate, predicate], [{ ...predicate, name: '' }], [{ ...predicate, type: 'tool' }],
    [{ ...predicate, execute: 'something' }], [{ ...choice, choices: [{ value: true }, { value: true }] }],
    [{ ...choice, choices: [{ value: 1 }, { value: 2 }] }], [{ ...score, levels: [{ label: 'x' }, { label: 'x' }] }]]) {
    assert.throws(() => validateQuestions(bad), { code: 'invalid_input' });
  }
});

test('rejects malformed records and enforces request/byte bounds before network', () => {
  for (const rows of [[], [null], [{ ...row, input: [] }], [{ ...row, input: '' }], [row, row],
    [{ ...row, model: 'other' }], [{ ...row, id: 12 }]]) assert.throws(() => prepared(rows), { code: 'invalid_input' });
  assert.throws(() => prepareRecords([row, { ...row, id: 'b' }], undefined, options({ maxRequests: 1 })), { code: 'invalid_input' });
  assert.throws(() => prepareRecords([row], undefined, options({ maxInputBytes: 10 })), { code: 'invalid_input' });
  assert.throws(() => prepareRecords([row], undefined, options({ maxTotalBytes: 10 })), { code: 'invalid_input' });
  for (const opts of [{ rps: 0 }, { retries: 4 }, { concurrency: 1.5 }, { maxRequests: Infinity }, { timeout: NaN }]) assert.throws(() => options(opts), { code: 'invalid_input' });
});

test('validates typed response and strips unrecognized server fields', () => {
  const data = { model: MODEL, answers: [
    { type: 'choice', name: 'route', choice: true, confidence: 0.8, probabilities: [{ value: true, probability: 0.9 }, { value: 'true', probability: 0.1 }] },
    { type: 'score', name: 'severity', score: 0.2, confidence: 0.5, probabilities: [{ value: 0, label: 'low', probability: 0.8 }, { value: 1, label: 'high', probability: 0.2 }] },
  ], usage, ignored: 'do not echo' };
  assert.deepEqual(validateResponse(data, [choice, score]).answers, data.answers);
  assert.equal(validateResponse(data, [choice, score]).ignored, undefined);
  const bad = clone(data); bad.answers[0].choice = false;
  assert.throws(() => validateResponse(bad, [choice, score]), { code: 'invalid_response' });
  const dup = clone(data); dup.answers[0].probabilities[1].value = true;
  assert.throws(() => validateResponse(dup, [choice, score]), { code: 'invalid_response' });
  const wrongScore = clone(data); wrongScore.answers[1].score = 0.9;
  assert.throws(() => validateResponse(wrongScore, [choice, score]), { code: 'invalid_response' });
});

test('refusal remains explicit and does not turn into a score', async () => {
  const result = await run(async () => response({ model: MODEL, answers: [{ type: 'refusal', name: 'red' }], usage }));
  assert.equal(result.results[0].needs_review, true);
  assert.deepEqual(result.results[0].answers, [{ type: 'refusal', name: 'red' }]);
});

test('rejects bad probabilities, names, usage, model and count', () => {
  for (const mutate of [
    (x) => { x.answers[0].probability = NaN; }, (x) => { x.answers[0].probability = 1.1; },
    (x) => { x.answers[0].name = 'wrong'; }, (x) => { x.answers = []; },
    (x) => { x.usage.total_tokens = 19; }, (x) => { x.usage.input_tokens = -1; },
    (x) => { x.model = 'wrong'; },
  ]) { const bad = clone(good); mutate(bad); assert.throws(() => validateResponse(bad, [predicate]), { code: 'invalid_response' }); }
});

test('uses fixed endpoint, disables redirects, applies timeout, reports usage', async () => {
  const result = await run(async (url, init) => {
    assert.equal(url, ENDPOINT); assert.equal(init.redirect, 'error'); assert.equal(init.method, 'POST');
    assert.ok(init.signal instanceof AbortSignal); assert.equal(JSON.parse(init.body).input, row.input);
    return response(good, 200, { 'x-request-id': 'req_abc' });
  });
  assert.equal(result.results[0].request_id, 'req_abc');
  assert.equal(result.summary.input_tokens, 20);
  assert.equal(result.summary.estimated_reported_input_cost_usd, 0.000002);
});

test('401/403/404 halt unsent records, never echo API errors or headers', async () => {
  for (const status of [401, 403, 404]) {
    let calls = 0;
    const r = await run(async () => { calls++; return response({ secret: 'SENSITIVE_ERROR_BODY' }, status, { 'x-request-id': 'bad id containing text' }); }, { retries: 3 }, [row, { ...row, id: 'b' }]);
    assert.equal(calls, 1); assert.equal(r.results[1].error.code, 'batch_stopped');
    assert.equal(r.results[0].error.status, status);
    assert.ok(!JSON.stringify(r).includes('SENSITIVE_ERROR_BODY'));
    assert.equal(r.results[0].error.request_id, undefined);
  }
});

test('429 respects retry-after and opt-in retry budget; no default retry', async () => {
  let calls = 0; const delays = [];
  const fetch = async () => ++calls === 1 ? response({}, 429, { 'retry-after': '2' }) : response();
  const r = await run(fetch, { retries: 1 }, [row], { sleep: async (ms) => delays.push(ms) });
  assert.equal(calls, 2); assert.ok(delays.includes(2000)); assert.equal(r.summary.attempts, 2);
  const exhausted = await run(async () => response({}, 429), {}, [row, { ...row, id: 'b' }]);
  assert.equal(exhausted.summary.attempts, 1);
  assert.equal(exhausted.results[0].error.code, 'rate_limited');
  calls = 0;
  await run(async () => { calls++; return response({}, 429, { 'retry-after': '120' }); }, { retries: 3 });
  assert.equal(calls, 1); // Never retry earlier than a long server backoff.
});

test('5xx retries are bounded and ambiguous network/timeout failures are not retried', async () => {
  let calls = 0;
  await run(async () => { calls++; return response({}, 503); }, { retries: 2 });
  assert.equal(calls, 3);
  for (const name of ['TypeError', 'TimeoutError']) {
    calls = 0;
    const r = await run(async () => { calls++; const e = new Error('SENSITIVE_NETWORK_DETAILS'); e.name = name; throw e; }, { retries: 3 });
    assert.equal(calls, 1); assert.ok(!JSON.stringify(r).includes('SENSITIVE_NETWORK_DETAILS'));
    assert.equal(r.results[0].error.code, name === 'TimeoutError' ? 'timeout' : 'network_error');
  }
});

test('rate limiter spaces every attempt and parses numeric/date Retry-After', async () => {
  const delays = [];
  const take = rateLimiter(2, async (ms) => delays.push(ms), () => 10000);
  await Promise.all([take(), take(), take()]);
  assert.deepEqual(delays, [500, 1000]);
  assert.equal(retryAfter('3'), 3000);
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:00:02 GMT', 1000), 1000);
  assert.equal(retryAfter('invalid'), undefined);
});

test('concurrency stays bounded and IDs correlate completion-order results', async () => {
  let active = 0, peak = 0; const completed = [];
  const rows = Array.from({ length: 5 }, (_, i) => ({ ...row, id: String(i) }));
  const r = await run(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5)); active--;
    return response();
  }, { concurrency: 2 }, rows, { onResult: (x) => completed.push(x.id) });
  assert.equal(peak, 2); assert.equal(r.summary.succeeded, 5);
  assert.deepEqual(completed.sort(), rows.map((x) => x.id));
});

test('malformed and oversized responses yield structured errors', async () => {
  const r = await run(async () => new Response('not JSON'));
  assert.equal(r.results[0].error.code, 'invalid_response');
  const huge = await run(async () => new Response('x'.repeat(1048577)));
  assert.equal(huge.results[0].error.code, 'invalid_response');
});

test('credentials use only conventional env and prevent header injection', () => {
  assert.throws(() => credentials({}), { code: 'missing_api_key' });
  assert.throws(() => credentials({ OPENAI_API_KEY: 'synthetic\ninjection' }), { code: 'invalid_auth_configuration' });
  assert.deepEqual(credentials({ OPENAI_API_KEY: 'placeholder', OPENAI_PROJECT_ID: 'proj_test' }), {
    authorization: 'Bearer placeholder', 'content-type': 'application/json', 'OpenAI-Project': 'proj_test',
  });
});

const cli = (args, input = '') => spawnSync(process.execPath, ['bin/decision-cli.mjs', ...args], {
  cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH }, input, encoding: 'utf8',
});
test('CLI dry-run is offline, batch-cap aware, and does not echo text', () => {
  const r = cli(['--dry-run', '--jsonl', '--questions', 'examples/questions.json', '--input', 'examples/records.jsonl']);
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).records, 3);
  assert.ok(!r.stdout.includes('charged'));
  const invalid = cli(['--dry-run', '--jsonl', '--max-requests', '1'], JSON.stringify(row) + '\n' + JSON.stringify({ ...row, id: 'b' }));
  assert.equal(invalid.status, 2);
});
test('CLI setup/input failures are structured and sanitized', () => {
  for (const [args, input, expected] of [
    [[], JSON.stringify(row), 'missing_api_key'],
    [[], '{"SENSITIVE_INPUT":broken}', 'invalid_input'],
    [['--api-key', 'SENSITIVE_ARGUMENT'], '', 'invalid_arguments'],
    [['--input', '/definitely/missing/SENSITIVE_PATH'], '', 'input_io'],
  ]) {
    const r = cli(args, input); assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stderr).error.code, expected);
    assert.ok(!r.stderr.includes('SENSITIVE_')); assert.equal(r.stdout, '');
  }
});

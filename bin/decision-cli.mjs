#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { DecisionError, MODEL, ENDPOINT, options, prepareRecords, credentials, runBatch } from '../src/decisions.mjs';

const HELP = `decision-cli — bounded text classification using OpenAI Decisions

Usage: decision-cli [--input FILE] [--jsonl] [--questions FILE] [--dry-run]
Input defaults to stdin. JSON: one record; JSONL: one record per nonempty line.
Record: {"id":"optional-local-id","input":"text","questions":[...]}
Shared questions file: an array of named predicate, choice or score questions.

--dry-run                 Validate all records, print plan, make no requests
--concurrency N           Parallel requests (default 2; 1..8)
--rps N                   Maximum request starts/sec (default 2; 0.1..10)
--timeout-ms N            Timeout per attempt (default 20000; 100..60000)
--retries N               429/5xx retries only (default 0; 0..3)
--max-requests N          Record limit (default 100; 1..10000)
--max-input-bytes N       Serialized request byte limit (default 65536; <=1 MiB)
--max-total-bytes N       All serialized requests (default 1048576; <=64 MiB)
--help                   Show help
--version                Show version

Authentication: OPENAI_API_KEY; optional OPENAI_PROJECT_ID / OPENAI_ORG_ID.
No key flags, credential files, redirects, tools, or action execution.
Batch stdout: JSONL results in completion order; use index/id to join records.
Summary/errors: JSON on stderr. Exit 0 success, 1 request failures, 2 input/setup.
Refusals are successful API responses marked needs_review, never decisions.
`;
const numeric = { concurrency: 'concurrency', rps: 'rps', 'timeout-ms': 'timeout', retries: 'retries',
  'max-requests': 'maxRequests', 'max-input-bytes': 'maxInputBytes', 'max-total-bytes': 'maxTotalBytes' };

async function boundedText(path, maxBytes) {
  if (path) {
    const info = await stat(path).catch(() => { throw new DecisionError('input_io', 'Cannot read input/questions file.'); });
    if (!info.isFile() || info.size > maxBytes) throw new DecisionError('invalid_input', 'Input/questions must be a regular file within the byte limit.');
    const data = await readFile(path);
    if (data.length > maxBytes) throw new DecisionError('invalid_input', 'Input/questions file exceeds the byte limit.');
    return data.toString('utf8');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) throw new DecisionError('invalid_input', 'stdin exceeds max-total-bytes.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function parse(text) {
  try { return JSON.parse(text); }
  catch { throw new DecisionError('invalid_input', 'Invalid JSON; contents omitted.'); }
}
const emit = (value, stream = process.stdout) => stream.write(JSON.stringify(value) + '\n');

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ allowPositionals: false, options: {
      input: { type: 'string' }, questions: { type: 'string' }, jsonl: { type: 'boolean' },
      'dry-run': { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' },
      ...Object.fromEntries(Object.keys(numeric).map((name) => [name, { type: 'string' }])),
    } }));
  } catch { throw new DecisionError('invalid_arguments', 'Invalid arguments. See --help; argument values omitted.'); }
  if (values.help) { process.stdout.write(HELP); return; }
  if (values.version) { process.stdout.write('0.1.0\n'); return; }
  const overrides = Object.fromEntries(Object.entries(numeric).filter(([name]) => values[name] !== undefined).map(([name, key]) => [key, Number(values[name])]));
  const opts = options(overrides);
  // Input envelope bytes and API-body bytes are capped independently by the same bound.
  const shared = values.questions ? parse(await boundedText(values.questions, Math.min(opts.maxInputBytes, opts.maxTotalBytes))) : undefined;
  const raw = await boundedText(values.input, opts.maxTotalBytes);
  const rows = values.jsonl ? raw.split(/\r?\n/).filter((line) => line.trim()).map(parse) : [parse(raw)];
  const prepared = prepareRecords(rows, shared, opts);
  if (values['dry-run']) {
    emit({ dry_run: true, endpoint: ENDPOINT, model: MODEL, records: prepared.records.length,
      request_bytes: prepared.totalBytes, max_attempts: prepared.records.length * (opts.retries + 1), limits: opts });
    return;
  }
  const headers = credentials();
  const { summary } = await runBatch(prepared, opts, headers, { onResult: emit });
  emit({ summary }, process.stderr);
  if (summary.failed) process.exitCode = 1;
}

process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(1);
  process.exit(2);
});
try { await main(); }
catch (cause) {
  const error = cause instanceof DecisionError ? cause : new DecisionError('local_error', 'Local operation failed; sensitive details omitted.');
  emit({ ok: false, error: error.toJSON() }, process.stderr);
  process.exitCode = 2;
}

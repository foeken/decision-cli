# Working on decision-cli

Keep this a small Node.js 22+ CLI with no runtime dependencies. `src/decisions.mjs` owns validation and bounded HTTP calls; `bin/decision-cli.mjs` owns stdin/files, arguments, and JSON/JSONL output.

Run `npm test` and `npm run check` after code changes. Offline tests must never access credentials or the network. Keep examples synthetic. Scan staged files and packaged content before publishing; no local paths, private records, secret files, or credentials belong in this repository.

Preserve environment-only authentication, the fixed OpenAI HTTPS destination, disabled redirects, input/response validation, bounds, safe errors, and explicit refusal handling. Do not add tools/action execution. Consult the official Decisions API contract before changing request or response shapes.

Use the CLI within the user's authorized data-sharing and spending scope. Outputs can assist classification and routing; consequential human decisions require independent human judgment. Publication of a package, new integration, or scheduled job needs its own scope.

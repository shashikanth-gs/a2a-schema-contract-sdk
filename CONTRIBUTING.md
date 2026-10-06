# Contributing

Start with the authoritative PLAN.md, docs/requirements.md, docs/support-matrix.md
and docs/architecture.md. Do not modify research inputs or change the normative
draft to fit implementation behavior. Node work precedes Python.

Use Node 22 >=22.23.3 or 24 >=24.21.0. In `js/`, run `npm ci` and `npm run check`.
Use `npm run format` for formatting and the committed npm lockfile for reproducible
resolution. Strict type checking includes library declarations. There is one
behavioral runner (Vitest), one formatter (Prettier) and one linter (ESLint).
The research directory uses executable compatibility assertions rather than a
second package test framework.

Build artifacts are isolated-consumer tested through public exports. Never make
an accepted path pass by swallowing errors, changing expected outcomes or adding
source imports to consumers. Cover side-effect timing and invalid-output
publication when boundary implementation arrives; keep contract-critical
coverage thresholds explicit. The hosted Node/Linux matrix and macOS/Windows
smokes are configured but need real CI runs before portability is claimed.

Update owning task status/evidence and downstream support decisions. Store exact
commands, runtime versions, artifact hashes, sanitized reports and limitations.
Keep publishing disabled; remote repository setup and publication require a
separate request. The local package scope remains provisional.

Run shared `tests/inline-core-cases.json` expectations independently when adding a language implementation. Preserve 100% core coverage and prior evidence. SDK-003 adds fixed preflight budgets; synchronous validator deadlines/isolation remain SDK-007.

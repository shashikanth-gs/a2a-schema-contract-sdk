# Superseded SDK-003 preliminary evidence

These reports and matching `artifacts/core-review-pre-proto-guard-node22/24`
tarballs record the preliminary 188-test / 13-consumer-check run. Final review
reproduced Ajv 8.20.0 silently ignoring the exact `__proto__` schema-map key in
`properties`/`patternProperties`. That acceptance gap invalidates completion
claims for this artifact. The final core refuses those schema entries explicitly
and preserves/validates special instance names with anchored patterns. Final
192-test / 14-consumer-check evidence is in the parent core-* reports; these
files are retained as history and must not be used as the completed SDK-003 gate.

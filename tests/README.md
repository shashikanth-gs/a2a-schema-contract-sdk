# Shared implementation semantics

`inline-core-cases.json` is a language-neutral SDK behavior suite, not a second
normative specification. The original draft fixtures remain byte-for-byte in
`vendor/contract/`. These 32 cases record independently specified acceptance and
stable local diagnostics for the supported offline profile.

Format version 1 contains a profile, test contract ID and cases with stable IDs.
`operation` is `validate`, `encode` or `decode`. Cases provide an inline JSON
Schema/value, or presence/Parts/representation selection. Optional `mediaType`
and `carrier` choose the text or official adapter restriction. `expected` records
`accepted` and the rejection `diagnostic`; no validator-specific wording or member
order is compared. A missing schema is schemaless; JSON null is an actual value.

`js/test/core.test.ts` runs every case through core APIs. That file adds values
JSON cannot encode (undefined, BigInt, accessors, proxies, cycles, sparse arrays),
immutable caller/schema checks, schema/reference budgets and exhaustive profile
rejections. Installed consumers separately run public examples and declaration
checks. The Python implementation must consume the same cases independently in
SDK-010; no Python/parity evidence is claimed yet. Profile changes must review
these expectations and preserve prior task evidence.

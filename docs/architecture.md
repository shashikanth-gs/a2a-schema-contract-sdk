# Architecture decisions (SDK-001; SDK-003 clarification)

Accepted locally on 2026-10-06 against contract commit `a5c007510faa3fce85190f2e76e402faf0e897ad`. Decisions define the implementation target; they do not claim implementation. Revisit them when a carrier/dependency changes and rerun the probes. Package, protocol, extension URI, contract ID and schema dialect are independent identifiers.

## ADR-001: Public boundaries and adapter ownership

Expose ESM entrypoints `.` / `core`, `client`, `server`, and `adapters/a2a-js`. Core owns parsed immutable catalogs, explicit selection, presence, codecs, schema validation and sanitized diagnostics. No official A2A, Express, provider, network or environment dependency is loaded by a core import. Data arriving through discovery or transport is `unknown`; validating a dynamic schema does not produce a domain-specific TypeScript generic. Return validated JSON values rather than asserting a caller's invented type.

Client integration accepts a configured official `Client` (preserving authentication, fetch, interceptors, service parameters and abort signal); URL discovery uses an explicitly JSON-RPC-only factory. Copy caller options before adding activation with the official service-parameter helper. Reject mismatched protocol/extension versions without fallback. Never retry invocation automatically.

Server integration has three public seams: a raw JSON-RPC guard **before** official codecs, an `A2ARequestHandler` decorator **before** `DefaultRequestHandler`, and an `AgentExecutor`/event-bus decorator for outgoing validation. The raw guard enforces Part content exclusivity/types and rejects unsupported root null before decoding can erase it. The request-handler seam validates before SDK task-history writes; validating only in `execute` is too late to prevent that side effect. Preserve the same application `ServerCallContext`, tenant/user/state and existing `TaskStore`. Validate a complete outgoing primary payload before forwarding any contracted event. Companion/status events may pass only under the lifecycle policy (SDK-005).

The official executor bus is synchronous (`publish(): void`); it cannot await schema resolution. Resolve/compile a bounded contract before business execution and use a validation worker/queue with bounded event staging for output. SDK-005 must settle ordering, backpressure and cancellation before claiming streaming. Require the initial Task/Message event, including continuations. No replacement orchestration store or monkey-patching private SDK APIs.

## ADR-002: Published artifact and transport

Pin optional peer `@a2a-js/sdk` to **exactly 1.3.0** initially, with the same exact development baseline. A single version is both the lower and upper supported peer boundary; expand only after the full transport suite passes for each boundary. Published package gitHead is `29417a5bb4038f804f310ce4fffd267a9375aa90`; npm integrity is `sha512-OpK4nygUnLKlpTFZlM2IrYu7f3c/B7c4u4Z14+vgMq24lEINTVCxH/BqZx+GL92rNf7CoBL5oTP5UhNsl75yyg==` (also pinned by the probe lockfile).

Target A2A **1.0 JSON-RPC/HTTP**, camelCase ProtoJSON wire fields, `A2A-Version: 1.0`, and `A2A-Extensions`. Internal Parts have `content: {$case, value}` and numeric Role/TaskState enums; on the wire, Parts use `data`/`text` and enums use A2A names. `SendMessage` results wrap `task` or `message`. Do not copy legacy `kind` shapes or legacy headers.

Node support target: `^22.23.3 || ^24.21.0`; these are the patched versions actually probed. Node 26 is incidental host evidence, not an advertised line. CI targets latest patches in the two supported majors. ESM with NodeNext declarations only; no browser, CommonJS, REST, gRPC or v0.3 compatibility claim. Express belongs to the host application, not core; the adapter can expose a framework-independent raw guard plus a documented Express mounting recipe.

## ADR-003: JSON and text carriers

Core JSON semantics include objects, arrays, strings, booleans, numbers and null. Official 1.3.0 `Part.fromJSON` drops **root** `data:null`; even HTTP delivers a content-less Part to the executor. Reject root-null input and output in this adapter with local `UNSUPPORTED_CARRIER` and, when a known contract is selected, draft `REPRESENTATION_NOT_SUPPORTED` / A2A content-type error. Do not wrap it in an object or stringify it into a text Part. Nested null survives. Reopen this limitation after an upstream fix; a future raw-byte JSON codec is separate accepted scope requiring transport evidence.

Initial representations: exact `application/json` with a data Part, and `text/plain` with a text Part. Accept text charset absent or UTF-8 (case-insensitive, including quoted spelling); reject other/duplicate/unknown parameters. Type/subtype and parameter names compare case-insensitively, parameter order is immaterial. Absent text charset and explicit UTF-8 are compatible in the Unicode-text carrier. JSON has no supported media parameters. No wildcard, suffix inference or vendor `+json` codec assumption. Binary/raw/URL content is detected but unsupported in this checkpoint. A future explicit registered codec may expand supported exact media types without altering a contract.

Require exactly one content member on **all** raw Parts; nonempty Messages/Artifacts; an empty string is present. Select only URI-namespaced primary metadata, independently of media type. Companion Parts are not extension payloads. Required input/output has one primary, optional zero/one, none zero. No-input invocations send a real companion trigger; no-output success is a completed Task with no Artifact. A Message-only peer cannot fulfill no-output contracts.

## ADR-004: Validator profile and immutable validation

Use Ajv 8 Draft 2020-12 for Node, independently implemented `jsonschema` semantics for Python later. Support object/Boolean schemas; core, applicator (including supported native local/dynamic refs), validation, unevaluated, metadata, format-annotation and content-annotation vocabularies of the standard 2020-12 dialect. Only the exact dialect URI is initially recognized. A declared `$schema`, when present in a resource, must agree. `$vocabulary` is not a mechanism to silently redefine a standard dialect: reject custom/required unknown vocabularies, required format-assertion or a conflicting declaration. Unknown optional vocabularies may be ignored only if no unsupported assertion is used; unknown assertion keywords fail with a local diagnostic.

Use separate validator configurations for extension-owned structure and application schemas. The upstream structural runner asserts `uri` format; retain that runner behavior as structural evidence and enforce absolute/versioned identifiers separately. Application `format` and `content*` are **annotations**, including unknown format names. Set application `validateFormats:false`; never install formats as assertions implicitly. Required format-assertion/custom dialects fail `SCHEMA_INVALID` with `UNSUPPORTED_VOCABULARY` locally. Upstream `examples/metadata/error.json` is an error-shape example, not proof that `email` must be asserted by the standard dialect. Propose clarification rather than modifying the pinned inputs.

Do not enable `useDefaults`, `coerceTypes` or `removeAdditional`; clone/freeze compiled configuration and schemas, preserve caller instances, validate schema validity before any instance. No Ajv async fetching: external dependencies are unavailable in the inline checkpoint; SDK-006 supplies explicitly resolved resources before compilation.

For JS/Python parity, use finite IEEE-754 binary64 numbers, reject unsafe integers (including numeric constants/limits in schemas), reject nonfinite values, BigInt, undefined, sparse arrays, cycles, accessors and non-JSON objects. No arbitrary decimal fidelity claim. Python must parse/validate against this same binary64 profile; bool is not an integer. Initially restrict `multipleOf` to positive safe integers to avoid validator-specific decimal rounding. Negative zero has JSON zero semantics. Document this as a supported restriction, never change a number to satisfy it.

Portable regex profile: ASCII literals, ASCII character classes/ranges, anchors, concatenation and simple quantifiers; no grouping, alternation, shorthand classes, backreferences, lookarounds, Unicode property escapes or engine-specific flags. Reject patterns outside that profile rather than evaluating a smaller meaning. Exact grammar and adversarial vectors belong to SDK-003/010; bound pattern length (128 code points) and instance string size (8192 code points), isolate compile/evaluation with an enforceable worker deadline (SDK-007). All string lengths follow Unicode code points. Limits and native-recursion behavior must be checked before claiming a profile.

## ADR-005: Metadata placement and error mapping

Use the extension URI as the metadata key: invocation in `SendMessageRequest.metadata` (operation scope), primary in `Part.metadata`, result in `Task.metadata` or standalone response `Message.metadata`. For streaming, echo in final `TaskStatusUpdateEvent.metadata`; official `ResultManager` merges event metadata into Task storage. Do not search history for a result or choose another scope silently. Task artifacts may mirror the result echo; conflicting echoes fail. The supplied Message-fragment example suggests invocation in `Message.metadata`; the draft does not mandate the scope. The adapter uses operation metadata and rejects ambiguous/conflicting duplicate placements. Record this binding choice for upstream clarification and interoperability tests.

Errors before a usable contract ID exists are local diagnostics or existing A2A malformed-request/extension errors. Do not invent a placeholder contract URI just to satisfy the error-detail schema. With an identified contract/direction, draft detail remains exactly the published schema. Map representation failures to `ContentTypeNotSupportedError` (-32005), malformed input/presence/schema failures to `RequestMalformedError` (-32602). Local unsupported features map to the closest valid draft code (unsupported representation → REPRESENTATION_NOT_SUPPORTED; unsupported dialect → SCHEMA_INVALID; unavailable external delivery → SCHEMA_UNAVAILABLE). No new extension codes.

The SDK's standard error serializer preserves `ErrorInfo.metadata` string values but does not serialize arbitrary user error `data` as custom details. Put the sanitized draft detail serialized as JSON under the extension URI in existing `google.rpc.ErrorInfo.metadata`. No invented `@type`/protobuf message. Generated-output failure is a **failed Task**, with `OUTPUT_CONTRACT_VIOLATION` under URI-namespaced Task/status metadata, and no contracted Artifact. Never let executor exceptions reach the SDK: it logs and echoes their message. Catch all boundary and business failures; publish a sanitized failed Task/status according to the documented lifecycle. No values, protected schemas, raw causes, credentials, paths or keyword diagnostics by default; opt-in disclosure is explicit application policy.

## ADR-006: Resolver and resource ownership

Inline core is offline. External catalogs/schemas fail visibly until SDK-006 completes. First candidate resolver is explicit and opt-in, HTTPS-only, rejects credentials, validates DNS/IP after every redirect and binds the approved address to the connection. Administrator allowlisting is configuration, never public Agent Card data. Bound bytes, deadline, graph size/depth/nesting, redirects and cache; verify SHA-256/SHA-512 of exact fetched bytes before parsing; require identity encoding initially to remove compression ambiguity. Cache keys include policy/security principal and immutable/integrity identity, not just URL; caches cannot cross disclosure boundaries.

Native local schema recursion is distinct from network retrieval cycles; allow supported bounded evaluation, reject cyclic resource retrieval. Fragment resolution uses native schema base/resource semantics; fetch/hash the document without the fragment. A catalog's version-looking URL alone is not proof of immutability: require declared integrity initially unless an administrator provides a trusted immutable-resource policy. Root integrity does not pin transitives; each external dependency needs independent policy/pins. Bundles/XML disabled until SDK-014/015. Own and close resolver resources explicitly; invocation abort stops retrieval and staging; cancelTask is an explicit application operation, not an automatic consequence of a fetch abort.

## ADR-007: Packaging and dependency strategy

Use npm with a committed fresh lock, TypeScript, ESLint with typescript-eslint, Prettier and Vitest (one behavioral runner). Exact development versions; reviewed Ajv runtime dependency; official SDK is optional exact peer so core installs without server integrations. No provider or database dependency. Package resource schemas under exported resources; include upstream LICENSE/NOTICE/pin/hash manifest. Build verifies the vendored snapshot and never downloads resources. Refresh only using `scripts/snapshot-contract.mjs` from the pinned Git object or a reviewed pin change; inputs are never runtime imports.

Strict source/declaration builds and consumer tests use public paths; do not export functioning client/server APIs until their tasks implement them. Foundation entrypoints may export protocol constants/types only and must state that clearly. Keep the provisional scope/name private and publishing disabled. npm/PyPI ownership is SDK-008/012 work. License/audit evidence, peer-boundary and clean tarball consumers belong to SDK-002; CI configuration is not evidence that hosted jobs ran.

## ADR-008: Implemented offline core limits and discovery

Accepted 2026-10-06 in SDK-003. Public catalogs retain structurally valid
unsupported alternatives, with explicit capability diagnostics. `select` rejects
unsupported media/delivery/dialect/vocabulary and meta-validates/compiles the
private snapshot before returning a validator. Compilation is explicit and
synchronous; the core imports no A2A peer, network resolver or environment/global
configuration. Verified normative structures are embedded during the offline
hash-verified build; installed parsing does not open files.

The portable regex grammar is specified in `js/README.md` and tested with
adversarial vectors. At most one variable quantifier per pattern is accepted;
fixed repetition bounds are <=8192. Dot is an escaped literal only. This narrows
ADR-004 to exclude overlapping repetition as well as nested/grouped repetition.
No unsupported pattern is silently reinterpreted. JSON snapshots reject proxies
without invoking traps, lone surrogates and non-JSON properties. Conservative
byte budgets include escaped strings and keys. Fixed bounds: nesting 32, nodes
4096, bytes 262144, string code points 8192, schema nodes 256, references 128,
pattern ASCII characters 128, Parts 128. Limits are public frozen data, not
per-request overrides.

Contract IDs require an explicit numeric version segment; `latest`, relative
and credential-bearing URI forms are rejected. URI syntax cannot prove
immutability, which remains an advertiser obligation. Relative embedded schema
`$id` values retain native base semantics; matching `$schema` and an absolute
root `$id` remain recommendations/requirements as specified by the draft.
Local pointers, anchors, embedded resources and recursive/dynamic-anchor refs
are tested. External refs are unavailable without fetching; dynamic refs must
be fragment-local in this checkpoint. A direct root-only self-ref is refused at
compile time; evaluation stack exhaustion/non-progressing recursive cycles
become a sanitized `RESOURCE_LIMIT`. Full synchronous-work isolation/deadlines
remain SDK-007 and are not established by these preflight limits.

Core wire-shape APIs preserve root null by default; the explicitly requested
`a2a-js-1.3.0` carrier profile rejects it on encode/decode (also on companion data).
The later adapter must always request this profile. Raw/URL companions are
shape-checked only and never selected by media or fetched. Empty output
collections represent Task output aggregation; container validity, activation,
operation/result placement, negotiation and successful output publication remain
SDK-004/005. Shared semantic expectations live in `tests/inline-core-cases.json`.

SDK-003 final review reproduced Ajv 8.20.0's omission of the exact `__proto__`
key in `properties`/`patternProperties` schema maps. The core now rejects those
entries as `UNSUPPORTED_KEYWORD` before compilation instead of weakening the
advertised assertion. Anchored pattern `^__proto__$` works and tests preserve and
validate special instance property names (`__proto__`, `constructor`, `toString`,
`hasOwnProperty`). This is an explicit validator-profile restriction; upstream
inputs are unchanged. Preliminary evidence before this guard is preserved under
`js/reports/core-review-pre-proto-guard/` and superseded by final core reports.

## ADR-009: Implemented inline HTTP lifecycle (SDK-004/005)

Accepted 2026-10-06. Ship SDK-004 and SDK-005 as one batch because request
selection, publication ordering and task continuation share a boundary. Public
APIs use the released 1.3.0 SDK, its unchanged TaskStore, public request-handler
and executor/event interfaces, and raw-wire guards. Core imports remain peer-free;
client/server/adapter imports now require the optional exact peer. Express is
application/development-only.

A safe initial WORKING Task with no Artifacts/history may publish immediately.
All remaining output/success is staged until business execution settles and the
complete aggregate passes. Staging is bounded to 128 events/262144 bytes; a
synchronous producer cannot await backpressure, so overflow fails closed. The
client exposes async companion/result events and withholds output-bearing events
until aggregate/result-echo validation. This is bounded SSE delivery, with no
continuous-token promise. Atomic artifact updates require append=false,
lastChunk=true, new IDs and one aggregate primary; replacement/append/record
streaming are unsupported. An executor throw after publishing a candidate success
still becomes a sanitized failure before that success can escape.

The server prefers catalog order among supported alternatives satisfying accepted
IDs and nonempty A2A output modes. An absent/empty protobuf media-mode list is
unrestricted; an empty accepted-ID list is invalid under the pinned schema. The
client accepts any peer-selected alternative meeting both mechanisms, validating
that alternative independently. Successful optional omission has no primary and
no representation echo. No-output success is a completed Task without an Artifact.

INPUT_REQUIRED persists contract/negotiated-output association in existing Task
metadata. A continuation reactivates and retains that association; changed IDs,
baseline continuation, concurrent turns and terminal reuse fail before history
writes. Interrupted selection metadata is not a successful payload. Each turn
starts with a Task event, and no live bus is retained after interruption.
AUTH_REQUIRED out-of-band resumption and returnImmediately are unsupported.

Execution composes explicit task cancellation, an application disconnect/shutdown
signal and a maximum 30-second deadline (trusted configuration may shorten it).
Abort never automatically calls CancelTask. Business work must cooperate with the
signal; the boundary owns active selections, event staging and listener cleanup,
and discards late publications. Enforceable synchronous validation worker
isolation/hostile benchmarks remain SDK-007. Application callback/business
exception text never reaches the SDK's disclosure-prone executor error path.

Core coverage thresholds stay at 100%. Integration gates use actual transport,
independent malformed peers and explicit zero-execution/no-publication assertions,
plus separately documented coverage floors. Fresh tarballs exercise the runnable
JS quickstart and strict TS consumer declarations. External retrieval, independent
reference scenarios, Python and hosted portability remain separate gates.

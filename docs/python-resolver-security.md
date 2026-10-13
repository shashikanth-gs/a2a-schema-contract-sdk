# Python resolver and operational profile

SDK-011, community draft `0.1`; implementation package `0.1.0.dev0` remains
unpublished. This document supplements [Python architecture](python-architecture.md),
[Node resolver policy](resolver-security.md) and [Node operations](node-operations.md).
It describes implemented controls and their limits rather than a universal sandbox.

## Responsibilities and ownership

`ContractResolver` acquires and prepares explicit resources. `ContractCatalog`
retains original descriptors and immutable resource views. `ValidationSession`
compiles and validates offline in disposable interpreter processes. A2A client and
server adapters own transport admission and publication; framework/model behavior
stays outside the SDK. No automatic reference loader, application HTTP client,
framework import, global cache, environment credential lookup or telemetry service
is involved in resolution/validation.

Construct one resolver per authentication/security identity. Exact-origin
authorization, origin allowlists, independent resource pins and immutable-resource
promises are copied into private instance configuration. Host/address overrides
are exact pairs, intended for explicitly authorized internal resources. Production
TLS verifies certificates and hostnames; insecure SSL contexts are refused. A
supplied SSL context and custom async DNS callback remain trusted host configuration;
the host must not mutate TLS policy during use and callbacks must cooperate with
cancellation. Defaults do not read proxy or certificate override environment variables.

Clients borrow supplied HTTPX clients and resolvers. Client closure owns its guarded
transports, response streams and validation session, while borrowed services remain
open. Servers own their validation session and official request handler; business
executors and supplied persistence remain host-owned. Resolver/session context managers
close owned operations; resolver closure also clears its private cache. Cancellation
propagates `asyncio.CancelledError` after cleanup. Local abort does not send a remote
CancelTask operation.

## Network threat model

Remote advertisements can attempt SSRF, DNS rebinding, TLS impersonation, redirect
credential theft, body/framing attacks, cache contamination and unbounded retrieval.
Resource URLs admit canonical ASCII HTTPS only. Userinfo, control/whitespace,
backslashes, invalid escapes, trailing-dot hosts, ambiguous numeric host spellings,
IPv6 zones and `latest` path/query tokens are refused. Origin allowlists are exact.
The explicit conservative address table matches Node, independently of changes to
Python's `ipaddress.is_global`: special-use IPv4/Azure wire-server and non-global or
special IPv6 ranges cannot pass without an exact trusted override.

Every DNS answer is checked before connecting. The default DNS lookup owns a child
process; deadlines/cancellation kill and reap it. The actual TLS connection uses only
the first approved numeric address and explicit address family, with no second DNS
lookup, address fallback, pool or proxy. Certificate verification/SNI/Host use the
original host; literal IP certificates are verified as IPs. The connected peer address
is checked. Fresh TLS connections use public asyncio/SSL APIs; h11 `0.16.0` supplies
HTTP/1.1 framing rather than a bespoke parser or an implicit network client.

At most three redirect hops reapply URL, origin, address and TLS policy. Redirect
bodies are discarded without consumption, loops are refused, and HTTPS downgrade
is refused. Exact-origin Authorization survives same-origin redirects. The first
cross-origin hop permanently drops authorization for that redirect chain, including
a bounce back; a different origin's configured credential is not substituted. No
cookies are collected or sent. Response compression is refused and identity encoding
requested. Repeated type/encoding/location headers, conflicting transfer framing, informational
responses and trailers are refused (h11 safely coalesces identical Content-Length values); declared and actual body sizes are bounded.

Integrity is canonical base64 SHA-256 or SHA-512 over representation bytes after
HTTP transfer framing and before UTF-8/JSON parsing. Declared/configured root pins
must agree. Transitive documents require their own pins to be pinned; a root digest
does not cover dependency bytes. Catalog references require a pin or an exact
administrator immutability promise. ETags and version-looking paths are not proof.
Python applies its strict JSON boundary, including duplicate-key rejection, to all
retrieved JSON. Malformed bytes are never normalized through the official SDK.

## Cache and native resource graph

The private LRU admits only pinned/promised bytes. Keys contain requested canonical
fragmentless URI, expected media type and exact integrity identity; credentials,
headers and bytes never enter diagnostics. Bounds are 32 entries/1 MiB, with cache
disablement/lower limits supported. Mutable dependencies are acquired/decoded once for each requested URI/media
in a preparation and never reused across preparations. All declarations verify
their pins against that coherent snapshot, including different digest algorithms. Multiple representations in one
preparation share that acquired snapshot. Clearing the cache does not revoke a
prepared catalog: all required resources remain immutable and usable offline.

Only schema positions are inspected/registered. Unknown keywords/vocabularies,
unsupported assertions/regex/numbers, duplicate resource/anchor identities, references
into annotations and nonlocal dynamic references are refused. Native `$id`, relative
bases, JSON Pointers, anchors and local recursion remain intact. Cross-document
dependency cycles are refused; diamonds reuse resources. Percent-encoded pointer
characters and `~0`/`~1` work; an encoded initial pointer slash is refused as in Node.

Final redirect URI supplies the retrieval base; requested URI remains an alias.
An explicit schema `$id` supplies its native base. Inline schemas receive a private
URN and do not inherit the catalog's retrieval URL. Relative external dependencies
therefore need an absolute inline `$id`. Vendor registration and the private regex
projection normalize identities/aliases without changing public schema documents.
The `referencing.Registry` has no retrieval callback. A compiled validator can never
open another network path. Bundle/archive and XML representations remain unsupported.

`catalog.schema(contract_id, direction, representation_id)` returns an immutable
`PreparedSchema`: `entry`, original `descriptor`, and a tuple of `SchemaResource`
values (`uri`, original `document`/detached `value`, redirect `aliases`). Inspection
performs no I/O, compilation or validation and exposes no authentication configuration,
HTTP client, vendor registry or private regex projection. It remains usable after
cache clear/resolver closure. It supplies schema data to framework adapters; it does
not generate a static Python business type or flatten native reference semantics.

## Budgets, isolation and publication

| Resource | Hard maximum; configuration may lower it |
|---|---|
| One retrieved body | 256 KiB |
| Preparation bytes/documents | 1 MiB / 32 |
| Schemas/references in each graph | 256 / 128 |
| External reference depth | 8 |
| Preparation deadline / concurrency | 10 seconds / 4; excess capacity refused |
| Worker job deadline / concurrency per session | 2 seconds / 4; excess capacity refused |
| Worker IPC in either direction | 4 MiB, bounded incremental pipe reads |
| Portable original JSON | 256 KiB / 4,096 nodes / depth 32 / strings 8,192 |

Worker programs share one immutable resource pool across representations and
check encoded size before materializing documents, preventing amplification of
shared schemas on the parent loop. Each async job starts a fresh interpreter with `-I -S -B`, explicit trusted package
paths and a minimal environment (only Windows system-directory variables when needed).
There is no shell, pickle, user-site/.pth/sitecustomize loading, inherited Python flag
or application-directory import. Input/output is a fixed JSON protocol with no
arbitrary operation callbacks. The worker denies socket/subprocess audit events;
default DNS is a separate permitted operation. This is defense in depth for schemas
as data, not an arbitrary-code sandbox. Trusted dependencies and host process setup
remain within the trust boundary.

Deadlines include worker startup, compile, validation and result processing. Success,
failure, timeout, cancellation, closure and cancellation during process acquisition
all await physical process termination before releasing capacity. Cleanup itself must
finish after a deadline expires; OS process/transport cleanup latency can extend the
observed return time. No worker or DNS executor thread survives SDK-owned cleanup.
No retry or synchronous/thread fallback runs a timed-out job on the async loop.

POSIX workers require a soft stack bound at most 8 MiB, preserving any stricter
inherited limit. Linux similarly applies a soft data-segment bound at most 256 MiB; this is not a portable hard RSS guarantee. macOS rejects that data limit in
the executable probe; CPython 3.14/macOS also refuses stack-limit setters, so its
already stricter inherited stack bound is preserved. A required lowering that the
host refuses fails closed. Windows lacks `resource`; those hosts enforce wall time,
IPC/data/schema budgets and physical process cleanup, but do not claim an OS memory
ceiling. Hosts requiring a strict resident-memory/process policy must supply it via
their deployment/container/job controls. Hosted platform checks remain a separate
evidence claim until executed. These limits are deliberately stated separately from
Node's V8 old-generation limit, which is also not a hard process RSS limit.

Discovery capability compilation, client request/result validation, server input
selection/final event validation and resolver compilation use workers. Capability
inspection reuses immutable decisions returned by discovery. Synchronous `prepare`,
`select`, direct validators and server output helpers remain explicit trusted
calling-thread conveniences: they have bounded preflight but no hard execution
deadline. Async input/publication gates independently recheck before execution or
business output exposure. Application execution is cooperative (30 seconds/4 turns
maximum by default); SDK worker limits do not govern arbitrary model/tool code.

## Diagnostics and repeatable verification

Optional synchronous hooks receive frozen `Diagnostic` values: allowlisted operation,
fresh UUID correlation, duration, outcome and optional code. Ordinary hook exceptions
are ignored. No payload, schema, URL, credential, raw vendor message or logger is sent.
Applications own hook destinations and protected-data logging, including upstream SDK
logs/traceback-local inspection. No global logger configuration or telemetry dependency
is added to the base package.

Tests exercise real TLS/HTTP framing and real processes, including DNS ownership,
rebinding prevention, redirects/bounces, pins/cache partition, schema-position guards,
resource graphs and cleanup during every lifecycle stage. Shared Node expectations
remain unchanged; compare acceptance/presence/identity outcomes, not vendor wording.
The installed wheel runs a deterministic real A2A executor through HTTP/SSE with
external resources; no model credentials are needed. Four Node/Python peer pairings
remain REF-006/SDK-012 acceptance rather than an SDK-011 claim.

`scripts/benchmark_operations.py` uses the Node benchmark's object with one integer
`count` bounded 0..100: 10 cold catalog compile/validate samples, 10 batches of 1,000
warm validations, five fresh process validations, and five cold plus five cache-warm
pinned HTTPS preparations. Cached preparations assert zero retrievals. Installed
artifact checks retain samples and enforce generous 2-second smoke ceilings on worker
and preparation workloads. Investigate medians above 3× a same-host/interpreter/workload
baseline; do not compare unlike hosts or treat samples as a throughput promise.

## Primary implementation references

- [Python asyncio subprocess lifecycle](https://docs.python.org/3.14/library/asyncio-subprocess.html).
- [Python asyncio streams/TLS](https://docs.python.org/3.14/library/asyncio-stream.html).
- [Python SSL verification](https://docs.python.org/3.14/library/ssl.html).
- [POSIX resource limits](https://docs.python.org/3.14/library/resource.html).
- [referencing public resource/registry API](https://referencing.readthedocs.io/en/stable/api/).
- [h11 public protocol API](https://h11.readthedocs.io/en/latest/api.html).

Exact installed dependency artifacts, executable probes and retained receipts take
precedence over unversioned documentation examples.

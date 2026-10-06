# External resolution policy and threat model

SDK-006 implements an opt-in Node HTTPS resolver for the pinned draft. Applications
own a resolver instance per authentication/security identity and prepare catalogs
before starting a server or invoking a client. Ordinary core parsing stays offline.
The resolver never delegates retrieval to Ajv and never changes caller data,
descriptors, instances, or native schema resources.

The assets are application credentials, private catalogs/schemas, local services,
metadata endpoints, validation decisions and bounded process resources. Discovery
metadata, resource bytes, DNS answers, redirect targets and schema references are
untrusted. Administrator callbacks, custom trust roots, pins and immutability
promises are trusted configuration. This is a bounded supported profile; worker
isolation and wider operational evidence remain SDK-007.

| Threat | Enforced boundary | Evidence |
|---|---|---|
| SSRF, numeric/encoded IP hosts, rebinding | Canonical HTTPS URL, no userinfo/backslashes/control characters/trailing-dot hosts; every DNS answer classified; direct connection to the first approved address; no second DNS lookup or fallback | `resolver.test.ts`: host tricks, mixed answers, new redirect answers, real HTTPS Host/TLS checks |
| Private, loopback, link-local, metadata and special-use destinations | Conservative IPv4 special-use exclusions; IPv6 global-unicast allow range with special-use exclusions; mapped/compatible/translation/6to4 addresses refused; Azure wire-server address refused; exact administrator address/host override | Address table tests; local fixture override only |
| Malicious redirects | At most three; every hop rechecks scheme, credentials, origin and DNS/IP policy; loops refused; response bodies destroyed without consumption | Redirect, downgrade, origin, exhaustion and loop tests |
| TLS or environment bypass | Fresh explicit HTTPS Agent, direct approved IP, original Host/SNI/certificate identity, mandatory trust verification; no shared sockets/TLS sessions, environment proxy or global fetch implementation | SAN mismatch, untrusted CA, literal-IP tests; Node 22/24 installed demo |
| Credential theft or cross-tenant disclosure | Authorization from private exact-origin configuration; no cookies; same-origin redirects retain authorization, first cross-origin hop removes it permanently for that redirect chain; distinct caches and agents per instance | Origin bounce, cookies, two identities, configuration snapshot tests |
| Integrity poisoning | Canonical base64 SHA-256/SHA-512 of final identity-encoded response body bytes, after transfer framing and before UTF-8 decoding/JSON parsing; declared and configured pins must agree | Both algorithms; invalid digest, poisoned invalid JSON, independent transitive pins |
| Mutable or overgrown cache | Catalog requires a pin or exact administrator immutability promise; cache only pinned/promised documents; key includes canonical fragmentless requested URI, document media type and pin; 32 entries/1 MiB LRU, private byte storage, explicit clear | Mutable resource, changed pin, LRU/bytes/disable/clear tests |
| Unbounded work or stuck I/O | 256 KiB response, 1 MiB total preparation, 10 s operation deadline, four preparations per resolver, 32 documents, 128 refs, 256 schema nodes, depth eight; existing JSON nesting/string/node bounds apply | Length/chunk bounds, hanging DNS/body, cancellation, graph/depth/nesting/concurrency tests |
| Reference or profile bypass | Inspect every document before registration; schema keywords only; refs must target inspected schema locations; retain resources/$id/anchors/pointers; duplicate identities and dependency back-edges refused; offline Ajv compilation only | Annotation-pointer bypass, nested bases, escaped pointers, DAG, aliases, local recursion tests |
| Error disclosure | Only fixed diagnostic text/codes and existing contextual draft detail; raw TLS/DNS/parser errors, URLs, headers, bytes and abort reasons discarded | Sanitized DNS/error tests and existing core/integration suite |

HTTPS uses Node's direct-IP request options and TLS identity callback, documented
in [Node HTTPS](https://nodejs.org/api/https.html). DNS discovery uses the
system resolver's all-address lookup, documented in [Node DNS](https://nodejs.org/api/dns.html).
The conservative address exclusions were reviewed against the
[IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/) and
[IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/) registries
on 2026-10-06. Classification intentionally refuses some globally reachable
special-use ranges; it is a policy subset, not a generated registry mirror.

Native resource/base semantics follow
[JSON Schema 2020-12 Core](https://json-schema.org/draft/2020-12/json-schema-core),
sections 8–9, within the Ajv/validator profile. Redirects set the fetched
document's base to the final location, with the original retrieval URI registered
as an alias. Inline schemas have a private URN base; relative network dependencies
therefore require an absolute `$id`. Catalog documents do not implicitly set an
inline schema's base. URI identifiers need not be retrieved when an embedded
resource already supplies them. Only schema positions are traversed, so `$ref`
text inside annotations/instance examples is not treated as a dependency.

The draft's cycle wording needs an upstream clarification: this profile detects
and refuses dependency cycles between separately fetched documents, including
logical-ID back-edges, while preserving local recursion that descends through
instance properties/items. A diamond graph reuses its already registered child.
Non-fragment `$dynamicRef` remains unsupported, as in the inline profile. Ajv
refuses pointer fragments whose leading slash is percent-encoded; use a literal
`#/` prefix (ordinary percent-encoded pointer characters and `~0`/`~1` escapes
are supported). Missing/invalid/unsupported targets fail explicitly.

HTTP compression is refused even with a matching digest; `Accept-Encoding:
identity` is sent. Catalog bodies must be `application/json`; schema bodies
must be `application/schema+json`; optional UTF-8 charset is accepted. Shared mutable documents are acquired once within each preparation and are never
reused across preparations. Root pins
never pin transitive resources: configure `resourceIntegrity` independently for
every protected dependency. Immutable promises are administrator assertions;
URL version syntax, ETags and cache-control do not prove immutability.

`AbortSignal` cancellation and deadlines cover DNS wait, connection/TLS, headers,
body and graph acquisition. Timers, listeners, response streams and agents are
cleaned up; late DNS completion checks the aborted signal before opening a socket.
The system DNS operation itself may continue in Node/libuv after caller abort.
Synchronous JSON/schema compilation and instance validation retain finite
preflight budgets but do not have an enforceable worker deadline yet. That
isolation, benchmarks, telemetry and hosted OS conformance are SDK-007 work.

Prepared catalogs retain private compiled validators independently of cache
eviction; applications own their lifetime. The resolver has no global cache,
environment configuration, disk cache, automatic retries, cookie jar, client
certificate authentication, general headers, HTTP proxy configuration or validator
fetch callback. Share an instance only within one identity. Recreate it when
authorization or trust policy changes. Bundle extraction and XML/XSD remain
unsupported; no claim is made for those deferred features.

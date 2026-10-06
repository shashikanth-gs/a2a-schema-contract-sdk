# Node operation and security profile

The release candidate uses Node 22 >=22.23.3 or 24 >=24.21.0, ESM, and the exact
optional official peer `@a2a-js/sdk@1.3.0`. Supported bindings are A2A 1.0
JSON-RPC/HTTP and SSE. The [support matrix](support-matrix.md) defines the JSON/text,
JSON Schema 2020-12, numeric, regex, carrier and lifecycle restrictions.

## Validation ownership

`ContractClient.invoke` and `stream`, server request selection and final output
validation, and resolver schema compilation execute in owned Node workers.
Application execution follows successful server input validation. Contracted
artifacts stay staged until complete output validation succeeds. A worker failure
cannot release staged artifacts or authorize business execution.

Each validation operation starts a fresh worker. The timer includes startup,
compilation, execution and message delivery. The default and hard maximum is
2,000 ms; each client/server/session admits at most four concurrent validation
operations. A full session refuses additional work with `RESOURCE_LIMIT` instead
of maintaining an unbounded queue. The worker has a 64 MiB V8 old-generation
limit and a 4 MiB stack, receives no application environment or command-line
flags, and has no validator network loader. V8 resource limits are not a hard
process RSS cap; bounded JSON snapshots and resolver graph/byte budgets also
limit input allocations. The host should set its own process/container limit.

Successful calls, refusals, timeouts, aborts and `close()` all await worker
termination. Resolver cancellation closes any owned compiler workers before
releasing its operation slot. Application DNS callbacks receive an abort signal;
the application owns cleanup of custom callbacks that ignore it.

`ContractClient.prepare`, catalog selection/validation and `outputPart` /
`outputArtifact` remain synchronous compatibility helpers for trusted application
schemas and values. They do not provide a deadline. Use `invoke`/`stream` and an
isolated session for discovered or otherwise untrusted schemas. The final async
server boundary independently revalidates output even when helpers were used.
Workers isolate schema work; the host still owns its business executor, model,
tools and their side effects. Those components must cooperate with the supplied
execution signal and must keep synchronous CPU work off the application thread.

## Configuration and cleanup

```ts
import { discoverContractClient } from 'a2a-schema-contract/client';
const client = await discoverContractClient('https://agent.example.org', {
  signal: AbortSignal.timeout(5000),
  validation: { deadlineMs: 1000, concurrent: 2 },
});
try {
  // Invoke with an application-owned AbortSignal and the discovered contract.
} finally {
  await client.close();
}
```

`createContractClient(client, discoveryOptions?, resolver?, validationOptions?)`
preserves the configured official client and its authentication/interceptors.
`createContractServer` accepts `validation` with the same limits and a diagnostic
hook. Its execution deadline is independently configurable from 1 to 30,000 ms.
The server's signal callback supplies application disconnect/shutdown signals.
`server.close()` aborts active execution controllers and closes validation work;
the HTTP host must also stop accepting requests and close its connections.
An asynchronous cancellation callback is awaited for at most the execution
deadline; its temporary event bus cannot publish application data to the real bus.

Explicit `CancelTask` is scoped by tenant/task and authorized through the existing
TaskStore lookup. Aborting a client request closes its reader/transport; it does
not imply a remote CancelTask request. End an SSE iterator when no longer needed.
There are no automatic retries of potentially side-effecting A2A invocations.

## Diagnostics and resolver policy

`ValidationOptions.diagnostics` receives an immutable event containing only
`operation`, `correlationId`, `durationMs`, `outcome`, and an optional local
diagnostic `code`. Operations are discovery, negotiation, validation and
resolution. Discovery events measure Agent Card retrieval; representation and
schema decisions have their own events. Correlation IDs are SDK-generated UUIDs.
Hooks must complete synchronously; thrown hook errors do not alter decisions.
Events omit payloads, schemas, URLs, credentials, validator messages and raw
causes. There is no global logger or required telemetry service.

The resolver accepts its own `diagnostics` hook. Keep one resolver per identity
and credential configuration. Configure exact allowed origins and origin-scoped
Authorization values in the application. Network policy, address exceptions and
trust roots never come from an Agent Card. HTTPS-only resolution checks every
redirect, binds approved DNS answers to the actual connection, verifies pins
before parsing, and strips credentials on origin changes. A root integrity pin
does not pin transitive dependencies; configure their pins separately.
The [resolver threat model](resolver-security.md) and package README document
the 10-second preparation budget, graph/byte limits and cache ownership.

## Failure diagnosis

| Diagnostic | Action |
|---|---|
| `VALIDATION_TIMEOUT` | Review schema complexity and chosen deadline; never retry a side-effecting call automatically. The failed worker has been terminated. |
| `VALIDATION_ABORTED` | Check the caller signal or session shutdown; no validation result is accepted. |
| `RESOURCE_LIMIT` | Check session concurrency, JSON depth/size, staging limits, resolver graph/byte bounds, or worker heap limits. |
| `INSTANCE_INVALID` | Compare the candidate with the advertised schema; validation never coerces or supplies defaults. |
| `RESOLUTION_POLICY` / `INTEGRITY_MISMATCH` | Correct trusted configuration or the pinned resource; do not weaken policy to accept an unexpected document. |
| Failed Task with `OUTPUT_CONTRACT_VIOLATION` | Correct the executor result or event sequence; no successful contracted output escaped. |

Local diagnostics are not new extension wire codes. Binding failures continue
to use the existing A2A error carriers and permitted draft details. Payload and
credential values are omitted from default errors.

## Performance and evidence

The installed benchmark uses an object with one bounded integer. It measures ten
cold compilations, ten batches of 1,000 warm synchronous validations, five fresh
isolated workers, and five cold/cache-warm pinned HTTPS preparations. Resolver
warm samples prove zero additional network retrievals; they still recompile in a
fresh worker. Reports retain runtime, OS, sample counts, medians and maxima.

Early development measurements placed worker/preparation medians around 35–50 ms
on macOS arm64. Final Node 22/24 baselines are in `js/reports/rc-package-node*.json`.
The 2,000 ms smoke ceiling matches the enforced hard deadline and leaves room for
shared hosted runners. Investigate a median increase above three times the
accepted baseline on the same runtime, host and workload; comparisons across
different operating systems are informational. The library makes no throughput
or low-latency service guarantee. Starting workers per operation favors bounded,
explicit ownership over retained background workers.

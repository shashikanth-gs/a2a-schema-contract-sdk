# A2A extension ecosystem and SDK review

Reviewed 2026-10-07. This is a source comparison and a targeted local verification, not an interoperability certification or evidence of production adoption. No SDK implementation or framework dependencies were changed.

Planning follow-up: ADR-013 and SDK-016–019 now capture the accepted shared SDK work. Python parity is tracked in SDK-010/011, installed Node acceptance in REF-010 and four-pairing acceptance in REF-006. These decisions and plans are not implementation evidence.

## Assessment

The SDK's extension declaration, explicit activation, namespaced metadata, client/server decorators and reuse of A2A tasks and storage follow established extension patterns. The core is a useful implementation of contract discovery and enforcement. Minimal application integration and useful skill-associated discovery still need improvement.

The [A2A extensions guide](https://github.com/a2aproject/A2A/blob/main/docs/topics/extensions.md) explicitly recommends reusable language packages and minimal integration code. It describes schema-constrained payloads as a profile-extension use case. This supports the architecture, but does not certify this particular implementation.

## Implementations inspected

| Project | Implementation evidence | Relevant precedent and limits |
| --- | --- | --- |
| A2A JavaScript SDK | [Timestamp executor/event-bus decorator](https://github.com/a2aproject/a2a-js/blob/main/src/samples/extensions/extensions.ts), [usage](https://github.com/a2aproject/a2a-js/blob/main/src/samples/extensions/README.md) | Advertises an extension and activates it per request using A2A 1.0 headers. Decorates existing execution events. It does not enforce arbitrary application schemas. |
| A2A sample extensions | [Python timestamp client](https://github.com/a2aproject/a2a-samples/blob/6603ba3f2c31a7ef33e70b9d8b5b5f8be42ac9a3/samples/python/extensions/timestamp/timestamp_ext/client.py), [server](https://github.com/a2aproject/a2a-samples/blob/6603ba3f2c31a7ef33e70b9d8b5b5f8be42ac9a3/samples/python/extensions/timestamp/timestamp_ext/server.py) | Separates extension logic, client interceptors and server/event-queue wrappers. Preserves other requested extensions. These are runnable samples, not evidence of deployed adoption. |
| A2UI | [Extension advertisement and activation helpers](https://github.com/a2ui-project/a2ui/blob/da63ca74491b39fe6ac3fe8aa74ce70658e3bbdb/python/a2ui_agent/src/a2ui/a2a/extension.py), [ADK restaurant sample](https://github.com/a2ui-project/a2ui/blob/main/samples/agent/adk/restaurant_finder/agent.py) | Packages catalog capabilities into AgentExtension params and separates schema-assisted generation, validation and A2A conversion. UI streaming semantics differ from this draft's atomic primary payload; the sample is not proof of our no-publication-before-validation guarantees. |
| Google ADK | [Published v2.11.0 extension interceptor](https://github.com/google/adk-python/blob/v2.11.0/src/google/adk/a2a/agent/interceptors/new_integration_extension.py) | Adds its own extension URI through client call context while retaining existing extension requests. Its extension improves ADK integration; it is not Schema Contract support. |
| AP2 | [Payment A2A client](https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/code/samples/python/src/common/payment_remote_a2a_client.py), [repository](https://github.com/google-agentic-commerce/AP2) | Wraps card discovery, extension requests and task-result handling in domain convenience APIs. Samples use ADK; the protocol also has its own types/schemas. This is not generic dynamic schema discovery. |

Older extension documents sometimes show X-A2A-Extensions and pre-1.0 carriers. Our chosen A2A 1.0 service parameter is A2A-Extensions. Compare versioned behavior rather than copying older examples.

## Advertised skills and contracts

The [Schema Contract draft, section 4](https://github.com/shashikanth-gs/a2a-schema-contract/blob/v0.1.0-draft.1/spec/specification.md) makes skillIds descriptive associations, not protocol routing. A consumer can join AgentCard.skills[].id with contract.skillIds to find candidate contracts, then explicitly choose a contractId and representations for invocation.

The current core preserves skillIds and validates their structure. The existing core test checks the association survives parsing and that a skill ID is not accepted as a contract ID. Public client objects expose both card and catalog, so applications can perform the join. There is no dedicated discovery helper or coverage demonstrating the full skill-to-contract consumer experience.

Recommended discovery behavior:

- Return all candidate contracts for an advertised skill, including unsupported-representation diagnostics.
- Support multiple contracts for a skill and a contract associated with multiple skills.
- Preserve contracts with no skill association; mapping is optional.
- Make ambiguity visible and keep the final wire selection explicit.
- Report stale associations as advertisement diagnostics. The current draft does not require rejecting a contract solely because an associated skill is missing from a particular card.
- Leave application handler registration to the host. Do not invent a skillId invocation field or infer an execution route from descriptive associations.

## Other gaps and clarification needs

1. **Resolved schema access:** external resources are retained internally for validation, but PreparedRepresentation exposes only the original descriptor and validate(). Adapters need a stable immutable schema/resource view to configure generation without separate retrieval.
2. **Advertisement convenience:** advertiseContracts() publishes an inline catalog. The external example replaces its params with the external catalog descriptor manually. A validated advertisement helper supporting both forms would remove repeated application wiring.
3. **Binding clarity:** the current SDK deliberately uses SendMessageRequest.metadata for invocation. The draft's metadata placement is not fully explicit and an example uses Message metadata. Document a common binding before independent peers are assumed compatible.
4. **Scope:** bundles, XML/XSD, unrestricted schema/media support and Python parity remain outside the implemented Node profile. Framework adapters must retain those capability limits and must not silently weaken schemas for a model provider.

These are usability work and specification clarifications, not a finding that the entire contract model is incorrect. Framework adapters should reuse common discovery, resolution, selection, validation and publication behavior.

## Verification

Inspected current core catalog, client discovery/invocation, server advertisement/activation, resolver preparation, public exports, existing requirement mapping and tests.

On Node 24.21.0, ran:

```text
node node_modules/vitest/vitest.mjs run test/core.test.ts test/integration.test.ts
```

Result: 2 test files passed, 252 tests passed, 24.03 seconds. The source suites cover existing contract behavior; they do not demonstrate framework adapters, external project interoperability, resolved-schema public access or a completed skill-discovery helper. This review did not rebuild/repack the candidate or repeat the full release matrix.

## Implementation follow-up

This review retains its research-time findings. Shared Node API implementation
and acceptance are now tracked in [the developer-experience report](developer-experience-report.md),
with usage in [the API guide](developer-experience.md). Python/framework work
remains separately scoped.

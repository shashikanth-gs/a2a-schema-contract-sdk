# A2A 1.0 Schema Contract binding

This SDK's supported binding uses A2A 1.0 JSON-RPC over HTTP/SSE and extension URI
`https://w3id.org/a2a-schema-contract/draft/0.1`. This documents ADR-005/013's
implementation policy; the pinned draft has not been changed. Independent Python
and framework integrations should use these placements and shared fixtures.

| Information | Placement under the extension URI key |
| --- | --- |
| Invocation selection | `SendMessageRequest.metadata` (JSON-RPC `params.metadata`) |
| Primary payload identity | `Part.metadata` |
| Task result selection | `Task.metadata`; final SSE `TaskStatusUpdateEvent.metadata` |
| Standalone Message result selection | Response `Message.metadata` |
| Output failure | Failed Task/status metadata with sanitized `OUTPUT_CONTRACT_VIOLATION` |

The client requests activation through `A2A-Extensions`; `A2A-Version` is `1.0`.
The normal A2A transport manages the activation-response header, which is optional
under the extension guide. A required contract/result identity echo is different:
missing or conflicting contract echoes are refused before exposing a successful
payload. Other extension URIs and caller metadata/service parameters are preserved.

Input `Message.metadata` is not an alternative selection carrier in this binding.
Conflicting or duplicate extension-owned placement is refused, rather than guessed.
Core A2A validity still applies. Text/other data companions are not selected just
because their media type matches a primary payload. Skill IDs describe catalog
associations; wire invocation explicitly selects a versioned contract ID.

Examples: [request](../tests/binding/request.json) and
[response](../tests/binding/response.json), with a sanitized
[failed Task](../tests/binding/failure.json) containing no contracted Artifact.
HTTP requests also carry activation
and protocol-version headers. These fixtures are intentionally constructed
independently of SDK serialization and exercised against the actual transport.
They are a supported binding agreement, not proof that every existing extension
uses these placements.

## Clarification proposal for the specification repository

Draft section 7 requires namespaced invocation metadata without fixing its
container, and an example uses Message metadata. Suggested clarification for the
A2A 1.0 binding: place invocation selection under the extension URI in
SendMessageRequest.metadata; place primary identity in Part.metadata; echo result
selection in Task metadata, standalone response Message metadata and final Task
status-event metadata. Define rejection of conflicting duplicate placements and
distinguish required contract echoes from optional activation-response headers.

This proposal is prepared for review only. It has not been posted upstream or
accepted by A2A maintainers. An approved semantic change must follow the draft's
versioning policy; integrations must not silently fall back between bindings.

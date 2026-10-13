"""Optional contract client using the official A2A 1.0 JSON-RPC transport."""

from collections.abc import AsyncGenerator, Mapping
from dataclasses import dataclass
from typing import cast
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from a2a.client import A2ACardResolver, ClientCallContext
from a2a.client.transports.jsonrpc import JsonRpcTransport
from a2a.types import AgentCard, CancelTaskRequest, GetTaskRequest, SendMessageRequest
from a2a.utils.errors import A2AError
from google.protobuf.json_format import MessageToDict, ParseDict

from .adapters.errors import remote_errors
from .adapters.httpx import BorrowedTransport
from .adapters.wire import admit
from .binding import (
    STOP_STATES,
    ContractSelection,
    guard_artifact,
    guard_container,
    is_primary,
    reject,
    select_request,
)
from .catalog import ContractCatalog, parse_extension
from .core import EXTENSION_URI, MISSING, ContractError, Direction, JsonValue, snapshot
from .core.models import Contract, JsonDocument, Payload
from .discovery import ContractDiscovery, bind_skill, describe_contracts, select_invocation
from .operations import DEFAULT_VALIDATION, DiagnosticHook, ValidationOptions, ValidationSession
from .operations.program import load_payload, load_selection, selection_packet
from .payload import encode_primary
from .resolver import ContractResolver


@dataclass(frozen=True, slots=True)
class PreparedInvocation:
    request: JsonDocument


@dataclass(frozen=True, slots=True)
class ContractResponse:
    response: JsonDocument
    payload: Payload | None


@dataclass(frozen=True, slots=True)
class ClientEvent:
    event: JsonDocument
    result: ContractResponse | None = None


class ContractClient:
    """Owns its guarded transport; a supplied HTTPX client remains application-owned.

    Construct with discover(). Frameworks consume catalog/describe/prepare/invoke
    without the core importing any framework or selecting an LLM.
    """

    def __init__(
        self,
        card: AgentCard,
        catalog: ContractCatalog,
        endpoint: str,
        http: httpx.AsyncClient,
        upstream: httpx.AsyncClient,
        owns_upstream: bool,
        validation: ValidationOptions = DEFAULT_VALIDATION,
        diagnostics: DiagnosticHook | None = None,
    ) -> None:
        self.catalog = catalog
        self.card = JsonDocument(MessageToDict(card))
        self._http, self._upstream, self._owns_upstream = http, upstream, owns_upstream
        self._transport = JsonRpcTransport(http, card, endpoint)
        self._endpoint = endpoint
        self._streams: set[httpx.AsyncClient] = set()
        self._closed = False
        self._headers: dict[str, str] = {}
        self._validation = ValidationSession(catalog, options=validation, diagnostics=diagnostics)

    @classmethod
    async def discover(
        cls,
        base_url: str,
        *,
        http_client: httpx.AsyncClient | None = None,
        endpoint: str | None = None,
        card_path: str = "/.well-known/agent-card.json",
        headers: Mapping[str, str] | None = None,
        resolver: ContractResolver | None = None,
        validation: ValidationOptions = DEFAULT_VALIDATION,
        diagnostics: DiagnosticHook | None = None,
    ) -> "ContractClient":
        _origin(base_url)
        upstream = http_client if http_client is not None else httpx.AsyncClient(timeout=30)
        http = httpx.AsyncClient(transport=BorrowedTransport(upstream), timeout=30, trust_env=False)
        try:
            with remote_errors():
                card = await A2ACardResolver(http, base_url, card_path).get_agent_card(
                    http_kwargs={"headers": dict(headers or {})},
                )
            raw = MessageToDict(card)
            matches = [
                extension
                for extension in raw.get("capabilities", {}).get("extensions", [])
                if extension.get("uri") == EXTENSION_URI
            ]
            if len(matches) != 1:
                reject()
            if resolver is not None:
                catalog = await resolver.resolve_extension(matches[0])
            else:
                catalog = parse_extension(matches[0])
                async with ValidationSession(
                    catalog, options=validation, diagnostics=diagnostics
                ) as worker:
                    support = cast(
                        "list[dict[str, JsonValue]]", await worker.run("capabilities", {})
                    )
                object.__setattr__(
                    catalog,
                    "_support",
                    tuple(
                        (
                            cast("str", item["contractId"]),
                            cast("Direction", item["direction"]),
                            cast("str", item["representationId"]),
                            cast("str | None", item["code"]),
                        )
                        for item in support
                    ),
                )
            describe_contracts(catalog, raw.get("skills", []))
            interfaces = [
                item
                for item in card.supported_interfaces
                if item.protocol_binding == "JSONRPC" and item.protocol_version == "1.0"
            ]
            if not interfaces:
                reject()
            if endpoint is None:
                endpoint = interfaces[0].url
                if _origin(endpoint) != _origin(base_url):
                    reject()
            elif not any(item.url == endpoint for item in interfaces):
                reject()
            _origin(endpoint)
            client = cls(
                card,
                catalog,
                endpoint,
                http,
                upstream,
                http_client is None,
                validation,
                diagnostics,
            )
            client._headers = dict(headers or {})
            return client
        except BaseException:
            await http.aclose()
            if http_client is None:
                await upstream.aclose()
            raise

    def describe(self) -> ContractDiscovery:
        return describe_contracts(
            self.catalog, cast("dict[str, JsonValue]", self.card.value).get("skills", [])
        )

    def bind_skill(self, skill_id: str, contract_id: str | None = None) -> Contract:
        """Resolve an advertised association; refuse missing or ambiguous bindings."""
        return bind_skill(
            self.catalog,
            cast("dict[str, JsonValue]", self.card.value).get("skills", []),
            skill_id,
            contract_id,
        )

    def prepare(
        self,
        contract_id: str,
        *,
        input: object = MISSING,
        input_representation_id: str | None = None,
        accepted_output_representation_ids: list[str] | tuple[str, ...] | None = None,
        companions: object = MISSING,
        metadata: object = MISSING,
        accepted_output_modes: list[str] | None = None,
        message_id: str | None = None,
        context_id: str | None = None,
        task_id: str | None = None,
        tenant: str | None = None,
    ) -> PreparedInvocation:
        self._ensure_open()
        selected = select_invocation(
            self.catalog,
            contract_id,
            input=input,
            input_representation_id=input_representation_id,
            accepted_output_representation_ids=accepted_output_representation_ids,
        )
        parts = snapshot([] if companions is MISSING else companions)
        if not isinstance(parts, list) or any(is_primary(part) for part in parts):
            reject()
        if selected.input is not None:
            assert selected.input_representation_id is not None
            parts.insert(
                0,
                encode_primary(
                    self.catalog.select(contract_id, "input", selected.input_representation_id),
                    selected.input.value,
                ),
            )
        if not parts:
            parts.append({"text": "Execute the selected contract."})
        invocation: dict[str, JsonValue] = {"contractId": contract_id}
        if selected.input_representation_id is not None:
            invocation["inputRepresentationId"] = selected.input_representation_id
        if selected.accepted_output_representation_ids is not None:
            invocation["acceptedOutputRepresentationIds"] = list(
                selected.accepted_output_representation_ids
            )
        copied_metadata = snapshot({} if metadata is MISSING else metadata)
        if not isinstance(copied_metadata, dict) or EXTENSION_URI in copied_metadata:
            reject()
        message: dict[str, JsonValue] = {
            "messageId": message_id if message_id is not None else str(uuid4()),
            "role": "ROLE_USER",
            "parts": parts,
        }
        if context_id is not None:
            message["contextId"] = context_id
        if task_id is not None:
            message["taskId"] = task_id
        request: dict[str, JsonValue] = {
            "message": message,
            "metadata": {**copied_metadata, EXTENSION_URI: invocation},
        }
        if tenant is not None:
            request["tenant"] = tenant
        if accepted_output_modes is not None:
            request["configuration"] = {"acceptedOutputModes": snapshot(accepted_output_modes)}
        select_request(self.catalog, request)
        return PreparedInvocation(JsonDocument(request))

    def _ensure_open(self) -> None:
        if self._closed:
            raise ContractError("VALIDATION_ABORTED")

    def _context(self, context: ClientCallContext | None) -> ClientCallContext:
        headers = dict(self._headers)
        if context is not None and context.service_parameters:
            headers.update(context.service_parameters)
        extensions: list[str] = []
        for name in tuple(headers):
            if name.lower() == "a2a-extensions":
                extensions.extend(
                    item.strip() for item in headers.pop(name).split(",") if item.strip()
                )
        headers["A2A-Extensions"] = ", ".join(dict.fromkeys([*extensions, EXTENSION_URI]))
        for name in tuple(headers):
            if name.lower() == "a2a-version":
                del headers[name]
        headers["A2A-Version"] = "1.0"
        return ClientCallContext(
            state=dict(context.state) if context is not None else {},
            timeout=context.timeout if context is not None else None,
            service_parameters=headers,
        )

    async def _checked(
        self, selection: ContractSelection, response: object, request: dict[str, JsonValue]
    ) -> ContractResponse:
        data = guard_container(response)
        payload = await self._validation.run(
            "result",
            {
                "selection": selection_packet(selection),
                "response": data,
                "request": request,
            },
        )
        return ContractResponse(JsonDocument(data), load_payload(payload))

    async def _select(self, request: dict[str, JsonValue]) -> ContractSelection:
        packet = cast(
            "dict[str, JsonValue]", await self._validation.run("request", {"request": request})
        )
        return load_selection(self.catalog, packet)

    async def invoke(
        self,
        invocation: PreparedInvocation,
        *,
        context: ClientCallContext | None = None,
    ) -> ContractResponse:
        self._ensure_open()
        request = cast("dict[str, JsonValue]", invocation.request.value)
        admit(request, SendMessageRequest)
        selection = await self._select(request)
        with remote_errors(selection.invocation.contract_id):
            response = await self._transport.send_message(
                ParseDict(request, SendMessageRequest()),
                context=self._context(context),
            )
        kind = response.WhichOneof("payload")
        if kind not in ("task", "message"):
            reject()
        return await self._checked(selection, MessageToDict(getattr(response, kind)), request)

    async def stream(
        self,
        invocation: PreparedInvocation,
        *,
        context: ClientCallContext | None = None,
    ) -> AsyncGenerator[ClientEvent, None]:
        """Progress is observable; business artifacts are withheld until the full stream validates.

        Closing this iterator aborts local HTTP consumption. Use cancel_task() for
        an explicit authorized remote task cancellation.
        """
        self._ensure_open()
        request = cast("dict[str, JsonValue]", invocation.request.value)
        admit(request, SendMessageRequest)
        selection = await self._select(request)
        task: dict[str, JsonValue] | None = None
        artifacts: dict[str, dict[str, JsonValue]] = {}
        terminal: dict[str, JsonValue] | None = None
        count = 0
        associations: list[JsonValue] = []
        stream_http = httpx.AsyncClient(
            transport=BorrowedTransport(self._upstream),
            timeout=30,
            trust_env=False,
        )
        self._streams.add(stream_http)
        stream_transport = JsonRpcTransport(
            stream_http,
            ParseDict(cast("dict[str, JsonValue]", self.card.value), AgentCard()),
            self._endpoint,
        )
        stream = stream_transport.send_message_streaming(
            ParseDict(request, SendMessageRequest()),
            context=self._context(context),
        )
        try:
            async for response in stream:
                count += 1
                if count > 128 or terminal is not None:
                    reject()
                kind = response.WhichOneof("payload")
                if kind not in ("message", "task", "status_update", "artifact_update"):
                    reject()
                data = guard_container(MessageToDict(getattr(response, kind)))
                if kind == "message":
                    if count != 1:
                        reject()
                    terminal = data
                    continue
                if kind == "task":
                    if count != 1 or not data.get("id") or not data.get("contextId"):
                        reject()
                    task = data
                    request_message = cast("dict[str, JsonValue]", request["message"])
                    if (
                        "taskId" in request_message and task["id"] != request_message["taskId"]
                    ) or (
                        "contextId" in request_message
                        and task["contextId"] != request_message["contextId"]
                    ):
                        reject()
                    for artifact in cast("list[dict[str, JsonValue]]", task.get("artifacts", [])):
                        artifacts[cast("str", artifact["artifactId"])] = artifact
                else:
                    if (
                        task is None
                        or data.get("taskId") != task["id"]
                        or data.get("contextId") != task["contextId"]
                    ):
                        reject()
                    if kind == "artifact_update":
                        artifact = guard_artifact(data.get("artifact"))
                        identifier = cast("str", artifact["artifactId"])
                        if (
                            data.get("append", False) is not False
                            or data.get("lastChunk") is not True
                            or identifier in artifacts
                        ):
                            reject()
                        artifacts[identifier] = artifact
                        continue
                    task["status"] = data["status"]
                    task["metadata"] = {
                        **cast("dict[str, JsonValue]", task.get("metadata", {})),
                        **cast("dict[str, JsonValue]", data.get("metadata", {})),
                    }
                assert task is not None
                marker = cast("dict[str, JsonValue]", data.get("metadata", {})).get(EXTENSION_URI)
                if marker is not None:
                    associations.append(marker)
                status = cast("dict[str, JsonValue]", task.get("status", {}))
                if status.get("state") in STOP_STATES:
                    task["artifacts"] = list(artifacts.values())
                    terminal = task
                elif not artifacts and not data.get("history"):
                    yield ClientEvent(JsonDocument({"kind": kind, "data": data}))
            if terminal is None:
                reject()
            result = await self._checked(selection, terminal, request)
            state = cast("dict[str, JsonValue]", terminal.get("status", {})).get("state")
            if state in ("TASK_STATE_COMPLETED", "TASK_STATE_INPUT_REQUIRED"):
                final_echo = cast("dict[str, JsonValue]", terminal.get("metadata", {})).get(
                    EXTENSION_URI
                )
                for association in associations:
                    if association == final_echo:
                        continue
                    # Initial progress advertises the selected optional output,
                    # including when that output is ultimately absent.
                    if not (
                        isinstance(association, dict)
                        and isinstance(final_echo, dict)
                        and association.get("contractId") == final_echo.get("contractId")
                        and set(association) <= {"contractId", "outputRepresentationId"}
                        and "outputRepresentationId" not in final_echo
                        and state == "TASK_STATE_COMPLETED"
                    ):
                        reject()
            yield ClientEvent(JsonDocument({"kind": "result", "data": terminal}), result)
        except (A2AError, httpx.HTTPError):
            with remote_errors(selection.invocation.contract_id):
                raise
        finally:
            try:
                await stream.aclose()
            finally:
                await stream_transport.close()
                self._streams.discard(stream_http)

    async def get_task(
        self,
        task_id: str,
        *,
        context: ClientCallContext | None = None,
    ) -> JsonDocument:
        self._ensure_open()
        with remote_errors():
            task = await self._transport.get_task(
                GetTaskRequest(id=task_id), context=self._context(context)
            )
        data = guard_container(MessageToDict(task))
        if data.get("id") != task_id:
            reject()
        return JsonDocument(data)

    async def cancel_task(
        self,
        task_id: str,
        *,
        context: ClientCallContext | None = None,
    ) -> JsonDocument:
        self._ensure_open()
        with remote_errors():
            task = await self._transport.cancel_task(
                CancelTaskRequest(id=task_id), context=self._context(context)
            )
        data = guard_container(MessageToDict(task))
        if data.get("id") != task_id:
            reject()
        return JsonDocument(data)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._validation.close()
        for stream_http in tuple(self._streams):
            await stream_http.aclose()
        self._streams.clear()
        await self._transport.close()
        if self._owns_upstream:
            await self._upstream.aclose()

    async def __aenter__(self) -> "ContractClient":
        self._ensure_open()
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()


def _origin(url: str) -> tuple[str, str | None, int | None]:
    try:
        parsed = urlsplit(url)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.fragment
        ):
            reject()
        return (
            parsed.scheme,
            parsed.hostname,
            parsed.port or (443 if parsed.scheme == "https" else 80),
        )
    except ValueError:
        reject()

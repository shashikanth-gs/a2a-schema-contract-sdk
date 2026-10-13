"""Optional public A2A executor/handler integration with atomic output publication."""

import asyncio
import json
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import cast
from uuid import uuid4

from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.context import ServerCallContext
from a2a.server.events import EventQueue
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import InMemoryTaskStore, TaskStore
from a2a.types import (
    AgentCard,
    Artifact,
    CancelTaskRequest,
    GetTaskRequest,
    Message,
    Part,
    SendMessageRequest,
    Task,
    TaskArtifactUpdateEvent,
    TaskStatusUpdateEvent,
)
from a2a.utils.errors import (
    A2AError,
    ContentTypeNotSupportedError,
    ExtensionSupportRequiredError,
    InvalidParamsError,
    TaskNotCancelableError,
    TaskNotFoundError,
)
from google.protobuf.json_format import MessageToDict, ParseDict

from .binding import (
    ContractSelection,
    check_echo,
    echo,
    guard_artifact,
    guard_container,
    is_primary,
    reject,
)
from .catalog import ContractCatalog, create_contract_extension, parse_catalog
from .core import EXTENSION_URI, ContractError, ErrorContext, JsonValue, snapshot
from .operations import DEFAULT_VALIDATION, DiagnosticHook, ValidationOptions, ValidationSession
from .operations.program import load_selection, selection_packet
from .payload import encode_primary

Event = Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent
TRUSTED_TENANT = "schema_contract.trusted_tenant"


def _wire(event: Event) -> dict[str, JsonValue]:
    return cast("dict[str, JsonValue]", snapshot(MessageToDict(event)))


def _encode(event: Event) -> dict[str, JsonValue]:
    kind = (
        "message"
        if isinstance(event, Message)
        else "task"
        if isinstance(event, Task)
        else "status"
        if isinstance(event, TaskStatusUpdateEvent)
        else "artifact"
    )
    data = _wire(event)
    guard_container(data)
    if kind == "artifact":
        guard_artifact(data.get("artifact"))
    return {"kind": kind, "data": data}


def _decode(event: dict[str, JsonValue]) -> Event:
    kinds = {
        "message": Message,
        "task": Task,
        "status": TaskStatusUpdateEvent,
        "artifact": TaskArtifactUpdateEvent,
    }
    return cast(
        "Event",
        ParseDict(cast("dict[str, JsonValue]", event["data"]), kinds[cast("str", event["kind"])]()),
    )


def _mapped(error: ContractError) -> A2AError:
    detail = error.detail
    data = None
    if detail is not None:
        metadata = {
            "code": detail.code,
            "contractId": detail.contract_id,
            "direction": detail.direction,
        }
        if detail.representation_id is not None:
            metadata["representationId"] = detail.representation_id
        # The public SDK serializes A2AError.data as google.rpc.ErrorInfo.metadata.
        data = {EXTENSION_URI: json.dumps(metadata)}
    cls = (
        ContentTypeNotSupportedError
        if detail and detail.code == "REPRESENTATION_NOT_SUPPORTED"
        else InvalidParamsError
    )
    return cls(message="Schema Contract request rejected.", data=data)


def _scope(context: ServerCallContext) -> tuple[str, str]:
    trusted = context.state.get(TRUSTED_TENANT, context.tenant)
    if not isinstance(trusted, str):
        reject()
    # The official dispatcher overwrites tenant from caller params. Restore the host's value.
    context.tenant = trusted
    return trusted, context.user.user_name


@dataclass(frozen=True, slots=True)
class ExecutionContract:
    catalog: ContractCatalog
    selection: ContractSelection
    task_id: str
    context_id: str
    cancelled: asyncio.Event

    @property
    def input(self) -> JsonValue | None:
        """Use selection.input.present to distinguish absent input from present null."""
        payload = self.selection.input
        return payload.value if payload.present else None


class _StagingQueue(EventQueue):
    def __init__(
        self, context: RequestContext, actual: EventQueue, selection: ContractSelection | None
    ) -> None:
        self.context = context
        self.actual = actual
        self.selection = selection
        self.events: list[dict[str, JsonValue]] = []
        self.bytes = 0
        self.open = True
        self.invalid = False
        self.started = False

    async def enqueue_event(self, event: Event) -> None:
        if not self.open:
            raise ContractError("VALIDATION_ABORTED")
        try:
            candidate = _encode(event)
            self.bytes += len(json.dumps(candidate, ensure_ascii=False).encode())
            if len(self.events) >= 128 or self.bytes > 262144:
                raise ContractError("RESOURCE_LIMIT")
            data = cast("dict[str, JsonValue]", candidate["data"])
            status = data.get("status")
            if (
                not self.events
                and candidate["kind"] == "task"
                and isinstance(status, dict)
                and status.get("state") == "TASK_STATE_WORKING"
                and not data.get("artifacts")
            ):
                if (
                    data.get("id") != self.context.task_id
                    or data.get("contextId") != self.context.context_id
                    or data.get("history")
                ):
                    reject()
                if self.selection is not None:
                    association = echo(self.selection, self.selection.output is not None)
                    check_echo(data.get("metadata", {}), association)
                    data["metadata"] = {
                        **cast("dict[str, JsonValue]", data.get("metadata", {})),
                        EXTENSION_URI: association,
                    }
                await self.actual.enqueue_event(_decode(candidate))
                self.started = True
            self.events.append(candidate)
        except Exception:
            self.invalid = True
            raise


class _DiscardQueue(EventQueue):
    async def enqueue_event(self, event: Event) -> None:
        pass


class _BoundaryExecutor(AgentExecutor):
    def __init__(self, server: "ContractServer") -> None:
        self.server = server

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        server = self.server
        message = context.message
        if message is None or context.task_id is None or context.context_id is None:
            reject()
        scope = _scope(context.call_context)
        selection = server._selections.pop((*scope, message.message_id), None)
        queue = _StagingQueue(context, event_queue, selection)
        current = asyncio.current_task()
        assert current is not None
        key = (*scope, context.task_id)
        cancelled = asyncio.Event()
        admitted = (
            not server._closed
            and len(server._active) < server.concurrent_executions
            and key not in server._active
        )
        if admitted:
            server._active[key] = current
            if selection is not None:
                server._executions[id(context)] = ExecutionContract(
                    server.catalog,
                    selection,
                    context.task_id,
                    context.context_id,
                    cancelled,
                )
        try:
            if not admitted:
                raise ContractError("RESOURCE_LIMIT")
            async with asyncio.timeout(server.deadline):
                await server.executor.execute(context, queue)
            queue.open = False
            if queue.invalid:
                reject()
            approved = cast(
                "list[dict[str, JsonValue]]",
                await server._validation.run(
                    "events",
                    {
                        "selection": selection_packet(selection) if selection is not None else {},
                        "contracted": selection is not None,
                        "events": cast("JsonValue", queue.events),
                        "taskId": context.task_id,
                        "contextId": context.context_id,
                        "started": queue.started,
                    },
                ),
            )
            if key in server._cancel_requests:
                raise asyncio.CancelledError
            # Cancellation admission and this commit point cannot interleave:
            # neither performs an await between observing and reserving the state.
            server._publishing.add(key)
            for event in approved[1 if queue.started else 0 :]:
                await event_queue.enqueue_event(_decode(event))
        except (Exception, asyncio.CancelledError) as error:
            queue.open = False
            canceled = isinstance(error, asyncio.CancelledError)
            state = "TASK_STATE_CANCELED" if canceled else "TASK_STATE_FAILED"
            failure: dict[str, JsonValue] = {"status": {"state": state}}
            if selection is not None and not canceled:
                failure["metadata"] = {
                    EXTENSION_URI: {
                        "code": "OUTPUT_CONTRACT_VIOLATION",
                        "contractId": selection.invocation.contract_id,
                        "direction": "output",
                    }
                }
            if queue.started:
                failure.update({"taskId": context.task_id, "contextId": context.context_id})
                await event_queue.enqueue_event(ParseDict(failure, TaskStatusUpdateEvent()))
            else:
                failure.update({"id": context.task_id, "contextId": context.context_id})
                await event_queue.enqueue_event(ParseDict(failure, Task()))
        finally:
            queue.open = False
            cancelled.set()
            if admitted:
                server._active.pop(key, None)
            server._executions.pop(id(context), None)
            server._publishing.discard(key)

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        # The official handler authorized its TaskStore lookup before cancellation.
        try:
            async with asyncio.timeout(self.server.deadline):
                await self.server.executor.cancel(context, _DiscardQueue())
        except Exception:
            pass


class _Handler(DefaultRequestHandler):
    def __init__(self, server: "ContractServer", store: TaskStore) -> None:
        self.server = server
        super().__init__(
            agent_executor=_BoundaryExecutor(server), task_store=store, agent_card=server.card
        )

    async def _prepare(self, params: SendMessageRequest, context: ServerCallContext) -> None:
        server = self.server
        scope = _scope(context)
        if server._closed or params.tenant not in ("", context.tenant):
            raise InvalidParamsError(message="Schema Contract request rejected.")
        raw = cast("dict[str, JsonValue]", snapshot(MessageToDict(params)))
        message = cast("dict[str, JsonValue]", raw.get("message", {}))
        if EXTENSION_URI not in context.requested_extensions:
            if server.required:
                raise ExtensionSupportRequiredError(message="Schema Contract activation required.")
            if (
                EXTENSION_URI in cast("dict[str, JsonValue]", raw.get("metadata", {}))
                or EXTENSION_URI in cast("dict[str, JsonValue]", message.get("metadata", {}))
                or any(
                    is_primary(part) for part in cast("list[JsonValue]", message.get("parts", []))
                )
            ):
                raise InvalidParamsError(message="Schema Contract activation required.")
            if params.message.task_id:
                task = await super().on_get_task(GetTaskRequest(id=params.message.task_id), context)
                if task is not None and EXTENSION_URI in MessageToDict(task.metadata):
                    raise InvalidParamsError(message="Schema Contract activation required.")
            return
        try:
            packet = cast(
                "dict[str, JsonValue]", await server._validation.run("request", {"request": raw})
            )
            selection = load_selection(server.catalog, packet)
            if params.message.task_id:
                task = await super().on_get_task(GetTaskRequest(id=params.message.task_id), context)
                if task is None:
                    reject()
                wire = _wire(task)
                if cast("dict[str, JsonValue]", wire["status"])[
                    "state"
                ] != "TASK_STATE_INPUT_REQUIRED" or cast(
                    "dict[str, JsonValue]", wire.get("metadata", {})
                ).get(EXTENSION_URI) != echo(selection, selection.output is not None):
                    reject()
            server._selections[(*scope, params.message.message_id)] = selection
        except ContractError as error:
            raise _mapped(error) from None

    async def on_message_send(
        self, params: SendMessageRequest, context: ServerCallContext
    ) -> Message | Task:
        key = (*_scope(context), params.message.task_id or params.message.message_id)
        if key in self.server._turns:
            raise InvalidParamsError(message="Concurrent task continuation rejected.")
        self.server._turns.add(key)
        try:
            await self._prepare(params, context)
            return cast("Message | Task", await super().on_message_send(params, context))
        finally:
            self.server._turns.discard(key)
            self.server._selections.pop((*_scope(context), params.message.message_id), None)

    async def on_message_send_stream(
        self, params: SendMessageRequest, context: ServerCallContext
    ) -> AsyncGenerator[Event, None]:
        key = (*_scope(context), params.message.task_id or params.message.message_id)
        if key in self.server._turns:
            raise InvalidParamsError(message="Concurrent task continuation rejected.")
        self.server._turns.add(key)
        try:
            await self._prepare(params, context)
            async for event in super().on_message_send_stream(params, context):
                yield event
        finally:
            self.server._turns.discard(key)
            self.server._selections.pop((*_scope(context), params.message.message_id), None)

    async def on_get_task(self, params: GetTaskRequest, context: ServerCallContext) -> Task | None:
        _scope(context)
        if params.tenant not in ("", context.tenant):
            raise InvalidParamsError(message="Tenant selection rejected.")
        return cast("Task | None", await super().on_get_task(params, context))

    async def on_cancel_task(
        self, params: CancelTaskRequest, context: ServerCallContext
    ) -> Task | None:
        scope = _scope(context)
        if params.tenant not in ("", context.tenant):
            raise InvalidParamsError(message="Tenant selection rejected.")
        # Authorize before checking or changing the execution's cancellation state.
        task = await super().on_get_task(GetTaskRequest(id=params.id), context)
        if task is None:
            raise TaskNotFoundError
        key = (*scope, params.id)
        if key in self.server._publishing:
            raise TaskNotCancelableError(message="Output publication has already begun.")
        self.server._cancel_requests.add(key)
        try:
            return cast("Task | None", await super().on_cancel_task(params, context))
        finally:
            self.server._cancel_requests.discard(key)


class ContractServer:
    """Owns publication gates, not the application executor or supplied TaskStore."""

    def __init__(
        self,
        *,
        card: AgentCard,
        catalog: object,
        executor: AgentExecutor,
        task_store: TaskStore | None = None,
        required: bool = False,
        deadline: float = 30.0,
        concurrent_executions: int = 4,
        validation: ValidationOptions = DEFAULT_VALIDATION,
        diagnostics: DiagnosticHook | None = None,
    ) -> None:
        if type(deadline) not in (int, float) or not 0 < deadline <= 30:
            raise ValueError("Invalid cooperative execution deadline.")
        if type(concurrent_executions) is not int or not 1 <= concurrent_executions <= 4:
            raise ValueError("Invalid execution concurrency.")
        if type(required) is not bool:
            raise ValueError("Invalid extension requirement.")
        self.catalog = catalog if isinstance(catalog, ContractCatalog) else parse_catalog(catalog)
        raw_card = MessageToDict(card)
        capabilities = raw_card.setdefault("capabilities", {})
        capabilities["extensions"] = [
            item for item in capabilities.get("extensions", []) if item["uri"] != EXTENSION_URI
        ]
        capabilities["extensions"].append(
            create_contract_extension(self.catalog, required=required)
        )
        self.card = ParseDict(raw_card, AgentCard())
        self.executor, self.required, self.deadline = executor, required, deadline
        self.concurrent_executions = concurrent_executions
        self._closed = False
        self._validation = ValidationSession(
            self.catalog, options=validation, diagnostics=diagnostics
        )
        self._selections: dict[tuple[str, str, str], ContractSelection] = {}
        self._executions: dict[int, ExecutionContract] = {}
        self._active: dict[tuple[str, str, str], asyncio.Task[object]] = {}
        self._turns: set[tuple[str, str, str]] = set()
        self._cancel_requests: set[tuple[str, str, str]] = set()
        self._publishing: set[tuple[str, str, str]] = set()
        store = (
            task_store
            if task_store is not None
            else InMemoryTaskStore(
                owner_resolver=lambda context: json.dumps(_scope(context)),
            )
        )
        self.handler = _Handler(self, store)

    def execution(self, context: RequestContext) -> ExecutionContract:
        if id(context) not in self._executions:
            raise RuntimeError("No active contracted execution.")
        return self._executions[id(context)]

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        publishing = []
        for key, task in tuple(self._active.items()):
            if key in self._publishing:
                publishing.append(task)
            else:
                task.cancel()
        if publishing:
            await asyncio.gather(*publishing, return_exceptions=True)
        await self._validation.close()
        await self.handler.aclose()
        self._selections.clear()

    async def __aenter__(self) -> "ContractServer":
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()


def output_part(execution: ExecutionContract, value: object) -> Part:
    if execution.cancelled.is_set():
        raise ContractError("VALIDATION_ABORTED")
    selected = execution.selection.output
    if selected is None:
        raise ContractError(
            "REPRESENTATION_NOT_SUPPORTED",
            ErrorContext(
                contract_id=execution.selection.invocation.contract_id,
                direction="output",
            ),
        )
    return ParseDict(
        encode_primary(
            execution.catalog.select(selected.contract_id, "output", selected.representation.id),
            value,
        ),
        Part(),
    )


def output_artifact(
    execution: ExecutionContract, value: object, artifact_id: str = "result"
) -> Artifact:
    if type(artifact_id) is not str or not artifact_id:
        raise ValueError("Invalid artifact identifier.")
    return Artifact(artifact_id=artifact_id, parts=[output_part(execution, value)])


def output_message(execution: ExecutionContract, value: object) -> Message:
    return ParseDict(
        {
            "messageId": str(uuid4()),
            "contextId": execution.context_id,
            "role": "ROLE_AGENT",
            "parts": [MessageToDict(output_part(execution, value))],
            "metadata": {EXTENSION_URI: echo(execution.selection, True)},
        },
        Message(),
    )

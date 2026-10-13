"""Fixed operation dispatcher for a fresh isolated interpreter. Not a code-execution API."""

import json
import socket
import sys
from typing import cast

from a2a_schema_contract.core import ContractError, Direction, ErrorContext, JsonValue, Origin
from a2a_schema_contract.core.models import JsonDocument, PreparedSchema, SchemaResource

from .process import PACKET_BYTES
from .program import load_catalog, load_selection, payload_packet, selection_packet


def _limits() -> None:
    if sys.platform != "win32":
        import resource

        # Preserve stricter inherited host limits; never raise an existing ceiling.
        def cap(kind: int, maximum: int) -> None:
            soft, hard = resource.getrlimit(kind)
            soft = maximum if soft == resource.RLIM_INFINITY else min(soft, maximum)
            hard = maximum if hard == resource.RLIM_INFINITY else min(hard, maximum)
            resource.setrlimit(kind, (min(soft, hard), hard))

        if sys.platform != "darwin":
            cap(resource.RLIMIT_DATA, 268435456)
        cap(resource.RLIMIT_STACK, 8388608)


def _offline(event: str, args: tuple[object, ...]) -> None:
    if event.startswith(("socket.", "subprocess.")) or event == "os.system":
        raise PermissionError("Offline worker.")


def dispatch(packet: dict[str, JsonValue]) -> JsonValue:
    operation = packet["operation"]
    args = cast("dict[str, JsonValue]", packet["arguments"])
    if operation == "dns":
        host = cast("str", args["hostname"])
        addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        return list(dict.fromkeys(str(item[4][0]) for item in addresses))
    sys.addaudithook(_offline)
    if operation == "compile":
        from a2a_schema_contract.validation import JsonSchemaEngine

        docs = tuple(
            SchemaResource(
                cast("str", doc["uri"]),
                JsonDocument(doc["value"]),
                tuple(cast("list[str]", doc.get("aliases", []))),
            )
            for doc in cast("list[dict[str, JsonValue]]", args["documents"])
        )
        JsonSchemaEngine().compile_prepared(
            PreparedSchema(cast("str", args["entry"]), JsonDocument({}), docs),
            ErrorContext(
                cast(
                    "Origin",
                    cast("dict[str, JsonValue]", packet.get("context", {})).get("origin", "local"),
                ),
                cast(
                    "str | None",
                    cast("dict[str, JsonValue]", packet.get("context", {})).get("contractId"),
                ),
                cast(
                    "Direction | None",
                    cast("dict[str, JsonValue]", packet.get("context", {})).get("direction"),
                ),
                cast(
                    "str | None",
                    cast("dict[str, JsonValue]", packet.get("context", {})).get("representationId"),
                ),
            ),
        )
        return None
    catalog = load_catalog(cast("dict[str, JsonValue]", packet["catalog"]))
    if operation == "validate":
        return catalog.select(
            cast("str", args["contractId"]),
            cast("Direction", args["direction"]),
            cast("str", args["representationId"]),
        ).validate(args["value"])
    if operation == "capabilities":
        return [
            {
                "contractId": contract.id,
                "direction": direction,
                "representationId": capability.representation.id,
                "code": capability.diagnostic,
            }
            for contract in catalog.contracts
            for direction in ("input", "output")
            for capability in catalog.capabilities(contract.id, direction)
        ]
    if operation == "request":
        from a2a_schema_contract.binding import select_request

        return selection_packet(select_request(catalog, args["request"]))
    selection = (
        load_selection(catalog, cast("dict[str, JsonValue]", args["selection"]))
        if args.get("contracted", True)
        else None
    )
    if operation == "result":
        assert selection is not None
        from a2a_schema_contract.binding import check_response

        return payload_packet(check_response(catalog, selection, args["response"], args["request"]))
    if operation == "events":
        from a2a_schema_contract.events import validate_events

        # Reconstruct the negotiated validator inside the process.
        if selection is not None and selection.output is not None:
            from a2a_schema_contract.binding import ContractSelection

            selection = ContractSelection(
                selection.invocation,
                selection.input,
                catalog.select(
                    selection.invocation.contract_id,
                    "output",
                    selection.output.representation.id,
                    "remote",
                ),
            )
        return cast(
            "JsonValue",
            validate_events(
                catalog,
                selection if args.get("contracted", True) else None,
                args["events"],
                cast("str", args["taskId"]),
                cast("str", args["contextId"]),
                started=cast("bool", args["started"]),
            ),
        )
    raise ContractError("INVALID_STRUCTURE")


def main() -> None:
    _limits()
    try:
        raw = sys.stdin.buffer.read(PACKET_BYTES + 1)
        if len(raw) > PACKET_BYTES:
            raise ContractError("RESOURCE_LIMIT")
        packet = cast("dict[str, JsonValue]", json.loads(raw))
        result: JsonValue = {"value": dispatch(packet)}
    except ContractError as error:
        result = {"code": error.code, "origin": error.origin}
        if error.detail is not None:
            result["contractId"] = error.detail.contract_id
            result["direction"] = error.detail.direction
            result["representationId"] = error.detail.representation_id
    except (MemoryError, RecursionError):
        result = {"code": "RESOURCE_LIMIT"}
    except Exception:
        result = {"code": "SCHEMA_INVALID"}
    output = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
    if len(output) > PACKET_BYTES:
        output = b'{"code":"RESOURCE_LIMIT"}'
    sys.stdout.buffer.write(output)

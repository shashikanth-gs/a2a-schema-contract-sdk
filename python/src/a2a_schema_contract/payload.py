"""Contracted payload identity, original-value validation and presence enforcement."""

import base64
import binascii
from typing import Literal, cast

from .catalog import ContractCatalog, PreparedRepresentation
from .core import EXTENSION_URI, LIMITS, ContractError, Direction, ErrorContext, JsonValue, snapshot
from .core.errors import LOCAL_CONTEXT
from .core.json import absolute_uri
from .core.media import match_media_types
from .core.models import (
    AbsentPayload,
    Invocation,
    InvocationSelection,
    JsonDocument,
    Payload,
    PresentPayload,
)
from .validation import validate_structure

CarrierProfile = Literal["json", "a2a-python-1.2.2", "a2a-js-1.3.0"]


def guard_part(
    value: object, context: ErrorContext = LOCAL_CONTEXT, carrier: CarrierProfile = "json"
) -> dict[str, JsonValue]:
    part = snapshot(value, context)
    if not isinstance(part, dict) or len({"data", "text", "raw", "url"} & part.keys()) != 1:
        raise ContractError("INVALID_CARRIER", context)
    if part.keys() - {"data", "text", "raw", "url", "mediaType", "filename", "metadata"}:
        raise ContractError("INVALID_CARRIER", context)
    for key in ("text", "raw", "url", "mediaType", "filename"):
        if key in part and not isinstance(part[key], str):
            raise ContractError("INVALID_CARRIER", context)
    if "metadata" in part and not isinstance(part["metadata"], dict):
        raise ContractError("INVALID_METADATA", context)
    if "raw" in part:
        raw = cast("str", part["raw"])
        try:
            decoded = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError):
            raise ContractError("INVALID_CARRIER", context) from None
        if base64.b64encode(decoded).decode("ascii") != raw:
            raise ContractError("INVALID_CARRIER", context)
    if "url" in part and not absolute_uri(cast("str", part["url"])):
        raise ContractError("INVALID_CARRIER", context)
    if carrier == "a2a-js-1.3.0" and "data" in part and part["data"] is None:
        raise ContractError("UNSUPPORTED_CARRIER", context)
    return part


def namespaced(metadata: object, context: ErrorContext) -> JsonValue:
    data = snapshot(metadata, context)
    if not isinstance(data, dict) or EXTENSION_URI not in data:
        raise ContractError("INVALID_METADATA", context)
    return data[EXTENSION_URI]


def encode_primary(
    selected: PreparedRepresentation, value: object, carrier: CarrierProfile = "json"
) -> dict[str, JsonValue]:
    checked = selected.validate(value)
    context = ErrorContext(
        "local", selected.contract_id, selected.direction, selected.representation.id
    )
    if carrier == "a2a-js-1.3.0" and checked is None:
        raise ContractError("UNSUPPORTED_CARRIER", context)
    return {
        "data" if selected.codec == "json" else "text": checked,
        "mediaType": selected.representation.media_type,
        "metadata": {
            EXTENSION_URI: {
                "contractId": selected.contract_id,
                "direction": selected.direction,
                "representationId": selected.representation.id,
                "role": "primary",
            }
        },
    }


def decode_primary(
    catalog: ContractCatalog,
    contract_id: str,
    direction: Direction,
    parts: object,
    representation_id: str | None = None,
    carrier: CarrierProfile = "json",
) -> Payload:
    if direction not in ("input", "output"):
        raise ContractError("INVALID_STRUCTURE")
    contract = catalog.get_contract(contract_id, "remote")
    context = ErrorContext("remote", contract_id, direction, representation_id)
    copied = snapshot(parts, context)
    if not isinstance(copied, list) or (direction == "input" and not copied):
        raise ContractError("INVALID_CARRIER", context)
    if len(copied) > LIMITS.parts:
        raise ContractError("RESOURCE_LIMIT", context)
    primaries: list[dict[str, JsonValue]] = []
    for value in copied:
        part = guard_part(value, context, carrier)
        metadata = part.get("metadata")
        if isinstance(metadata, dict) and EXTENSION_URI in metadata:
            identity = cast(
                "dict[str, JsonValue]",
                validate_structure(
                    "part-metadata",
                    namespaced(metadata, context),
                    context,
                ),
            )
            if identity["contractId"] != contract_id or identity["direction"] != direction:
                raise ContractError("PRIMARY_IDENTITY_MISMATCH", context)
            primaries.append(part)
    presence = contract.direction(direction).presence
    if (
        len(primaries) > 1
        or (presence == "required" and len(primaries) != 1)
        or (presence == "none" and primaries)
    ):
        raise ContractError("PAYLOAD_PRESENCE_VIOLATION", context)
    if not primaries:
        if representation_id is not None:
            raise ContractError("INVALID_METADATA", context)
        return AbsentPayload()
    part = primaries[0]
    identity = cast("dict[str, JsonValue]", namespaced(part["metadata"], context))
    if representation_id is None or identity["representationId"] != representation_id:
        raise ContractError("PRIMARY_IDENTITY_MISMATCH", context)
    selected = catalog.select(contract_id, direction, representation_id, "remote")
    if not isinstance(part.get("mediaType"), str) or not match_media_types(
        cast("str", part["mediaType"]),
        selected.representation.media_type,
    ):
        raise ContractError("REPRESENTATION_NOT_SUPPORTED", context)
    key = "data" if selected.codec == "json" else "text"
    if key not in part:
        raise ContractError("UNSUPPORTED_CARRIER", context)
    checked = selected.validate(part[key], "remote")
    return PresentPayload(JsonDocument(checked), representation_id, JsonDocument(part))


def validate_invocation(
    catalog: ContractCatalog, metadata: object, parts: object, carrier: CarrierProfile = "json"
) -> InvocationSelection:
    context = ErrorContext("remote")
    data = cast(
        "dict[str, JsonValue]",
        validate_structure(
            "invocation-metadata",
            namespaced(metadata, context),
            context,
        ),
    )
    contract_id = cast("str", data["contractId"])
    contract = catalog.get_contract(contract_id, "remote")
    accepted = (
        tuple(cast("list[str]", data["acceptedOutputRepresentationIds"]))
        if "acceptedOutputRepresentationIds" in data
        else None
    )
    if accepted is not None:
        context = ErrorContext("remote", contract_id, "output")
        if contract.output.presence == "none":
            raise ContractError("INVALID_METADATA", context)
        if any(
            identifier not in {rep.id for rep in contract.output.representations}
            for identifier in accepted
        ):
            raise ContractError("REPRESENTATION_NOT_SUPPORTED", context)
    input_id = cast("str | None", data.get("inputRepresentationId"))
    return InvocationSelection(
        Invocation(contract_id, input_id, accepted),
        decode_primary(catalog, contract_id, "input", parts, input_id, carrier),
    )


def validate_result(
    catalog: ContractCatalog,
    contract_id: str,
    metadata: object,
    parts: object,
    expected_representation_id: str | None = None,
    carrier: CarrierProfile = "json",
) -> Payload:
    context = ErrorContext("remote", contract_id, "output")
    data = cast(
        "dict[str, JsonValue]",
        validate_structure(
            "result-metadata",
            namespaced(metadata, context),
            context,
        ),
    )
    output_id = cast("str | None", data.get("outputRepresentationId"))
    if data["contractId"] != contract_id or (
        output_id is not None
        and expected_representation_id is not None
        and output_id != expected_representation_id
    ):
        raise ContractError("PRIMARY_IDENTITY_MISMATCH", context)
    return decode_primary(catalog, contract_id, "output", parts, output_id, carrier)
